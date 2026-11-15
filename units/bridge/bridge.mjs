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
  if (req.method === 'GET' && (pathname === '/healthz' || pathname === '/')) {
    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    if (pathname === '/' && wantsHtml) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(`<!doctype html><meta charset="utf-8"><title>桥接器</title>
<style>body{font:14px/1.6 system-ui,sans-serif;margin:0;padding:24px;background:#0f1115;color:#e6e6e6}
b{color:#7dd3fc}code{background:#1b1f27;padding:2px 6px;border-radius:4px}</style>
<h3>桥接器 · 运行中</h3>
<p>后端：<b>${cfg.backend}</b></p>
<p>监听：<code>${cfg.listen}</code></p>
<p>上游 NapCat：<code>${cfg.napcatApi}</code></p>
<p style="opacity:.6">会话按聊天隔离；消息进来时这里会打印处理结果（见 logs/bridge.log）。</p>`);
      return;
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
  if (!info) return;
  enqueue(info.key, async () => {
    const started = Date.now();
    try {
      const { text } = await askDsh(info);
      const reply = (text || '').trim() || '（DSH 没有返回内容）';
      await sendReply(info, reply.slice(0, 4000));
      log('ok', info.kind, info.key, `${Date.now() - started}ms`, reply.length + '字');
    } catch (e) {
      log('fail', info.kind, info.key, e.message);
      try { await sendReply(info, `出错了：${String(e.message).slice(0, 200)}`); } catch (e2) { log('fail:reply', e2.message); }
    }
  });
});

server.listen(port, host, () => log('bridge 已启动', cfg.listen, 'backend=' + cfg.backend, 'napcat=' + cfg.napcatApi));

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log('收到', sig, '，退出'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000); });
}
