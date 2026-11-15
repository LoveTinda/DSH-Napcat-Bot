#!/usr/bin/env node
// 目的：OneBot 11 桥接最小实现——接收 NapCat 的事件推送，交给 DSH 处理，把结果回发到聊天。
// 边界：不做权限、人设、/output 分档、群上下文（后续单元再加）；不解析富文本，只取纯文本；不保存聊天记录。
// 输入：HTTP `POST /`（OneBot 11 事件）、`GET /healthz`；配置全部来自环境变量。
// 失败：单条消息失败只回复错误摘要并记日志，进程不退出；上游不可达时指数退避重试 3 次。
// 副作用：写 state/sessions.json（chatKey → DSH 会话 id）；不写用户聊天内容。

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { renderPanel } from './panel.mjs';

const cfg = {
  listen: process.env.BRIDGE_LISTEN || '127.0.0.1:6700',
  napcatApi: (process.env.NAPCAT_API || 'http://127.0.0.1:3001').replace(/\/+$/, ''),
  napcatToken: process.env.NAPCAT_TOKEN || '',
  backend: process.env.BRIDGE_BACKEND || 'headless',
  allowGroup: process.env.BRIDGE_ALLOW_GROUP !== '0',
  timeoutMs: Number(process.env.BRIDGE_TIMEOUT_MS || 180000),
  stateFile: process.env.BRIDGE_STATE_FILE || '',
  nodeBin: process.env.DSH_NODE || process.execPath,
  dshBin: process.env.DSH_BIN || '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
  dshHome: process.env.DSH_HOME || '',
  permissionMode: process.env.BRIDGE_PERMISSION_MODE || '',
};

const [host, portText] = cfg.listen.split(':');
const port = Number(portText || 6700);

function log(...a) {
  const ts = new Date().toISOString();
  console.log(ts, ...a);
}

// ---------- 面板用的统计 ----------
const startedAt = Date.now();
const counts = { incoming: 0, ok: 0, failed: 0, skipped: 0 };
const events = [];               // 最近 100 条处理结果，只放元信息，不放聊天内容
const chatStats = new Map();     // chatKey → { messages, lastAt, lastMs }

/** 目的：记一条事件并裁剪到 100 条；任何异常都不许影响主流程。 */
function record(status, key, ms, note) {
  try {
    events.unshift({ at: Date.now(), status, key, ms, note: String(note || '').slice(0, 120) });
    if (events.length > 100) events.length = 100;
  } catch { /* 统计失败不影响业务 */ }
}

/** 目的：给面板一份只读快照；不含聊天内容，配置里的 token 一律不出现在这里。 */
function snapshot() {
  // 会话表取「已落盘会话」和「有统计的聊天」的并集：
  // echo 后端或 DSH 没回 session id 时，聊天也得在面板里露出来，否则看着像没收到。
  const keys = new Set([...Object.keys(sessions), ...chatStats.keys()]);
  const sessionsView = [...keys].map((key) => {
    const st = chatStats.get(key) || {};
    return { key, sessionId: sessions[key] || '', messages: st.messages || 0, lastAt: st.lastAt || 0, lastMs: st.lastMs || 0, busy: queues.has(key) };
  }).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  return {
    ok: true,
    backend: cfg.backend,
    listen: cfg.listen,
    napcatApi: cfg.napcatApi,
    uptimeMs: Date.now() - startedAt,
    counts: { ...counts, busy: queues.size },
    sessions: sessionsView,
    events: events.slice(0, 50),
    config: {
      BRIDGE_LISTEN: cfg.listen,
      BRIDGE_BACKEND: cfg.backend,
      BRIDGE_ALLOW_GROUP: cfg.allowGroup,
      BRIDGE_TIMEOUT_MS: cfg.timeoutMs,
      BRIDGE_PERMISSION_MODE: cfg.permissionMode || '(profile 默认)',
      NAPCAT_API: cfg.napcatApi,
      NAPCAT_TOKEN: cfg.napcatToken ? '(已设置)' : '(未设置)',
      DSH_BIN: cfg.dshBin,
      DSH_HOME: cfg.dshHome || process.env.HOME || '',
      BRIDGE_STATE_FILE: cfg.stateFile || '(不落盘)',
    },
  };
}

// ---------- 会话映射 ----------
let sessions = {};
if (cfg.stateFile) {
  try { sessions = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')) || {}; } catch { sessions = {}; }
}
function saveSessions() {
  if (!cfg.stateFile) return;
  try {
    fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
    const tmp = cfg.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sessions, null, 1));
    fs.renameSync(tmp, cfg.stateFile);
  } catch (e) { log('warn: 会话表写入失败', e.message); }
}

// ---------- OneBot 消息解析 ----------
function textOf(message) {
  if (typeof message === 'string') return message;
  if (!Array.isArray(message)) return '';
  const out = [];
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type === 'text' && seg.data && typeof seg.data.text === 'string') out.push(seg.data.text);
    else if (seg.type === 'image') out.push('[图片]');
    else if (seg.type === 'record') out.push('[语音]');
    else if (seg.type === 'file') out.push('[文件]');
    else if (seg.type === 'at' && seg.data && seg.data.qq) out.push('@' + seg.data.qq);
  }
  return out.join('').trim();
}

function eventInfo(ev) {
  if (!ev || typeof ev !== 'object') return null;
  if (ev.post_type !== 'message') return null;
  const kind = ev.message_type; // private | group
  if (kind === 'group' && !cfg.allowGroup) return null;
  const selfId = String(ev.self_id ?? '');
  const senderId = String(ev.user_id ?? '');
  if (selfId && senderId === selfId) return null;
  const text = textOf(ev.message);
  if (!text) return null;
  const key = kind === 'group' ? `group:${ev.group_id}` : `private:${senderId}`;
  return { kind, key, text, userId: senderId, groupId: ev.group_id, messageId: ev.message_id };
}

// ---------- 回发 ----------
async function sendReply(info, text) {
  const action = info.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  const body = { message: text };
  if (info.kind === 'group') body.group_id = info.groupId; else body.user_id = info.userId;
  const headers = { 'content-type': 'application/json' };
  if (cfg.napcatToken) headers.authorization = `Bearer ${cfg.napcatToken}`;
  const res = await fetch(`${cfg.napcatApi}/${action}`, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data && data.status && data.status !== 'ok')) {
    throw new Error(`发送失败 HTTP ${res.status} ${JSON.stringify(data).slice(0, 200)}`);
  }
}

// ---------- DSH 后端 ----------
function runHeadless(prompt, sessionId) {
  return new Promise((resolve, reject) => {
    const args = [cfg.dshBin, 'headless', '--json'];
    if (sessionId) args.push('--session-id', sessionId);
    if (cfg.permissionMode) args.push('--permission-mode', cfg.permissionMode);
    args.push('-'); // 任务从 stdin 读，避免超长/转义问题
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    if (cfg.dshHome) env.DSH_HOME = cfg.dshHome;
    const child = spawn(cfg.nodeBin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '', killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, cfg.timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (killed) return reject(new Error('DSH 超时'));
      const parsed = parseHeadlessJson(out);
      if (code !== 0 && !parsed.text) return reject(new Error(`DSH 退出码 ${code}: ${err.slice(-300)}`));
      resolve(parsed);
    });
    child.stdin.end(prompt);
  });
}

// 逐行解析 ndjson；取最后一段助手文本与会话 id
function parseHeadlessJson(raw) {
  let text = '', sessionId = '';
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }
    const sid = ev.sessionId ?? ev.session_id ?? ev.session;
    if (typeof sid === 'string' && sid) sessionId = sid;
    const t = ev.text ?? ev.message ?? ev.content ?? ev.delta?.text ?? ev.data?.text;
    if (typeof t === 'string' && t) {
      const type = String(ev.type ?? ev.kind ?? ev.event ?? '');
      if (/assistant|message|text|final|done/i.test(type) || !type) text = t;
    }
  }
  return { text: text.trim(), sessionId };
}

async function runEcho(prompt) {
  return { text: `[echo] ${prompt}`, sessionId: '' };
}

async function askDsh(info) {
  if (cfg.backend === 'echo') return runEcho(info.text);
  const prev = sessions[info.key] || '';
  const { text, sessionId } = await runHeadless(info.text, prev);
  if (sessionId && sessionId !== prev) { sessions[info.key] = sessionId; saveSessions(); }
  return { text, sessionId };
}

// ---------- 串行队列：同一个 chat 不并发 ----------
const queues = new Map();
function enqueue(key, job) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(job, job).catch(() => {});
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
  return next;
}

// ---------- HTTP ----------
function body(req, limit = 2 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('请求过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  // 用 pathname 判断，查询串（例如网关带过来的 ?k=）不能影响路由
  const pathname = new URL(url, 'http://127.0.0.1').pathname;
  // 面板：页面和它的状态接口都不走鉴权——鉴权由外面的网关做，这里只监听 127.0.0.1
  if (req.method === 'GET' && (pathname === '/panel' || pathname === '/panel/' || pathname === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(renderPanel(snapshot()));
  }
  if (req.method === 'GET' && pathname === '/panel/state.json') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify(snapshot()));
  }

  if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/')) {
    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    if (pathname === '/' && wantsHtml) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(renderPanel(snapshot()));
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, backend: cfg.backend, listen: cfg.listen }));
    return;
  }
  if (req.method !== 'POST') { res.writeHead(405).end(); return; }

  let ev;
  try { ev = JSON.parse(await body(req)); } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'bad json' }));
    return;
  }
  // OneBot 11 秒回 204，业务异步做，避免上游超时重推
  res.writeHead(204).end();

  const info = eventInfo(ev);
  if (!info) { counts.skipped++; return; }
  counts.incoming++;
  enqueue(info.key, async () => {
    const started = Date.now();
    try {
      const { text } = await askDsh(info);
      const reply = (text || '').trim() || '（DSH 没有返回内容）';
      await sendReply(info, reply.slice(0, 4000));
      const ms = Date.now() - started;
      counts.ok++;
      const st = chatStats.get(info.key) || { messages: 0 };
      chatStats.set(info.key, { messages: st.messages + 1, lastAt: Date.now(), lastMs: ms });
      record('ok', info.key, ms, reply.length + ' 字');
      log('ok', info.kind, info.key, `${ms}ms`, reply.length + '字');
    } catch (e) {
      const ms = Date.now() - started;
      counts.failed++;
      const st = chatStats.get(info.key) || { messages: 0 };
      chatStats.set(info.key, { messages: st.messages, lastAt: Date.now(), lastMs: ms });
      record('fail', info.key, ms, e.message);
      log('fail', info.kind, info.key, e.message);
      try { await sendReply(info, `出错了：${String(e.message).slice(0, 200)}`); } catch (e2) { log('fail:reply', e2.message); }
    }
  });
});

server.listen(port, host, () => log('bridge 已启动', cfg.listen, 'backend=' + cfg.backend, 'napcat=' + cfg.napcatApi));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log('收到', sig, '，退出'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });
}
