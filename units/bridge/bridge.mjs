#!/usr/bin/env node
/**
 * 目的：OneBot 11 桥接最小实现——接收 NapCat 的事件推送，交给 DSH 处理，把结果回发到聊天；
 *       同时提供只读面板与状态接口，供网关 /bridge/ 反代。
 * 边界：不做权限、人设、/output 分档、群上下文（后续单元再加）；不解析富文本，只取纯文本；
 *       不保存聊天记录；面板不接受写操作。
 * 依赖：NapCat 的 OneBot HTTP API（默认 127.0.0.1:3001）、DSH 的 `headless` 子命令、本机 node。
 * 失败：单条消息失败只回复错误摘要并记日志，进程不退出；上游不可达时由 DSH 自身报错；
 *       端口被占用会打印原因并以非 0 退出，由 unit.sh 退避重启。
 * 副作用：写 state/sessions.json（chatKey → DSH 会话 id）；不写用户聊天内容。
 */

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

// 这些上限不是拍脑袋：
// - 2MB 是 OneBot 事件体的硬上限，超过通常是异常/攻击，不是正常消息；
// - 4MB 是单轮 DSH ndjson 的保留上限，防止异常输出把进程内存吃光；
// - 4000 字是单条 QQ 消息的安全长度，超过由 NapCat/QQ 截断或拒绝。
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_DSH_OUTPUT_CHARS = 4 * 1024 * 1024;
const MAX_DSH_STDERR_CHARS = 4000;
const MAX_REPLY_CHARS = 4000;
const MAX_EVENTS = 100;

function log(...a) {
  const ts = new Date().toISOString();
  console.log(ts, ...a);
}

/**
 * 目的：把错误摘要/日志里的 token、Bearer、长数字串打码，避免面板和日志泄露秘密。
 * 输入：任意值；输出：脱敏后的字符串。
 * 失败：不抛错；非字符串按 String() 处理。
 * 副作用：无。
 */
function redactText(value) {
  return String(value == null ? '' : value)
    .replace(/(token|accessToken|apiKey|api_key|secret|password)(\s*[:=]\s*)[^\s,;"}]+/gi, '$1$2***')
    .replace(/(Bearer)\s+[A-Za-z0-9._~+\/-]+/gi, '$1 ***')
    .replace(/[0-9]{11,}/g, '***');
}

// ---------- 面板用的统计 ----------
const startedAt = Date.now();
const counts = { incoming: 0, ok: 0, failed: 0, skipped: 0 };
const events = [];               // 最近 100 条处理结果，只放元信息，不放聊天内容
const chatStats = new Map();     // chatKey → { messages, lastAt, lastMs }

/** 目的：记一条事件并裁剪到 100 条；任何异常都不许影响主流程。 */
function record(status, key, ms, note) {
  try {
    events.unshift({
      at: Date.now(), status, key: String(key || '').slice(0, 120), ms,
      note: redactText(note).replace(/\s+/g, ' ').trim().slice(0, 120),
    });
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  } catch (e) {
    // 统计失败不能影响消息处理，但也不能静默；只打一条 warn。
    log('warn: 事件记录失败', e.message);
  }
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
  // chatStats 不落盘也不清理会随聊天数无限增长；面板只看最近活跃的 500 个。
  if (chatStats.size > 500) {
    const stale = [...chatStats.entries()].sort((a, b) => (a[1].lastAt || 0) - (b[1].lastAt || 0)).slice(0, chatStats.size - 500);
    for (const [k] of stale) chatStats.delete(k);
  }
  return {
    ok: true,
    backend: cfg.backend,
    listen: cfg.listen,
    napcatApi: cfg.napcatApi,
    uptimeMs: Date.now() - startedAt,
    counts: { ...counts, busy: queues.size },
    sessions: sessionsView,
    events: events.slice(0, MAX_EVENTS),
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

/**
 * 目的：把一条 OneBot 事件分类成「要处理」或「跳过 + 原因」，跳过原因只记元信息。
 * 输入：原始 OneBot 事件对象，来源不可信。
 * 输出：{ info } 或 { skip }；info 含 kind/key/text/userId/groupId/messageId。
 * 失败：不抛错；缺字段按空值处理。
 * 副作用：无。
 */
function classifyEvent(ev) {
  if (!ev || typeof ev !== 'object') return { skip: '不是对象' };
  if (ev.post_type !== 'message') return { skip: '非消息事件' };
  const kind = ev.message_type; // private | group
  if (kind !== 'private' && kind !== 'group') return { skip: '未知消息类型' };
  if (kind === 'group' && !cfg.allowGroup) return { skip: '群消息已关闭' };
  const selfId = String(ev.self_id ?? '');
  const senderId = String(ev.user_id ?? '');
  if (selfId && senderId === selfId) return { skip: '自己发的消息' };
  const text = textOf(ev.message);
  if (!text) return { skip: '空消息或不支持的消息类型' };
  const key = kind === 'group' ? `group:${ev.group_id}` : `private:${senderId}`;
  return { info: { kind, key, text, userId: senderId, groupId: ev.group_id, messageId: ev.message_id } };
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
    throw new Error(`发送失败 HTTP ${res.status} ${redactText(JSON.stringify(data)).slice(0, 200)}`);
  }
}

// ---------- DSH 后端 ----------
// 正在跑的 dsh 子进程；收到 SIGTERM 时要一起收掉，否则 unit.sh stop 会留下孤儿进程。
const activeChildren = new Set();

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
    activeChildren.add(child);
    child.on('close', () => activeChildren.delete(child));
    let out = '', err = '', killed = false, settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, cfg.timeoutMs);
    // 只保留尾部：异常程序可能无限输出，保留全量会 OOM。
    child.stdout.on('data', (d) => { out = (out + d).slice(-MAX_DSH_OUTPUT_CHARS); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-MAX_DSH_STDERR_CHARS); });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      if (killed) return finish(reject, new Error('DSH 超时'));
      const parsed = parseHeadlessJson(out);
      if (code !== 0 && !parsed.text) return finish(reject, new Error(`DSH 退出码 ${code}: ${redactText(err)}`));
      finish(resolve, parsed);
    });
    // 子进程提前退出时 stdin 会 EPIPE；不接住会变成未捕获异常，整个桥接器退出。
    child.stdin.on('error', (e) => { log('warn: DSH stdin 写入失败', redactText(e.message)); });
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

/**
 * 目的：让一个聊天的一轮消息走 DSH；持久会话失效时清掉映射并重开，避免永久卡死。
 * 输入：info 为 classifyEvent 的结果；不直接信任聊天内容。
 * 输出：{ text, sessionId }，text 可能为空。
 * 失败：DSH 非零退出/超时抛错，由调用方回发错误摘要；只对「未知会话」重试一次。
 * 副作用：更新 sessions 并落盘。
 */
async function askDsh(info) {
  if (cfg.backend === 'echo') return runEcho(info.text);
  const prev = sessions[info.key] || '';
  try {
    const { text, sessionId } = await runHeadless(info.text, prev);
    if (sessionId && sessionId !== prev) { sessions[info.key] = sessionId; saveSessions(); }
    return { text, sessionId };
  } catch (e) {
    // DSH 的会话文件被删/回滚后，--session-id 会报 unknown；保留映射会让该聊天以后每条都失败。
    if (!prev || !/unknown|not found|no such|不存在|未知/i.test(String(e.message))) throw e;
    log('warn: 会话失效，重开', info.key, redactText(e.message));
    delete sessions[info.key];
    saveSessions();
    const { text, sessionId } = await runHeadless(info.text, '');
    if (sessionId) { sessions[info.key] = sessionId; saveSessions(); }
    record('skip', info.key, 0, 'DSH 会话失效，已重开');
    return { text, sessionId };
  }
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
function body(req, limit = MAX_EVENT_BYTES) {
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
  const isGet = req.method === 'GET' || req.method === 'HEAD';

  // 面板：页面和状态接口都不走鉴权——鉴权由外面的网关做，这里默认只监听 127.0.0.1。
  // 路径固定为 /panel、/panel/、/、/index.html；状态同时提供 /panel/state.json 和 /state.json，
  // 后者让页面可以用相对路径 state.json，从而同时兼容 /panel/ 与 /bridge/ 两种挂载点。
  if (isGet && (pathname === '/' || pathname === '/panel' || pathname === '/panel/' || pathname === '/index.html')) {
    const html = renderPanel(snapshot());
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(req.method === 'HEAD' ? undefined : html);
  }
  if (isGet && (pathname === '/panel/state.json' || pathname === '/state.json')) {
    const json = JSON.stringify(snapshot());
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(req.method === 'HEAD' ? undefined : json);
  }
  if (isGet && pathname === '/healthz') {
    const json = JSON.stringify({ ok: true, backend: cfg.backend, listen: cfg.listen });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : json);
  }
  if (isGet && pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
  if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' }).end(); return; }

  let ev;
  try { ev = JSON.parse(await body(req)); } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'bad json' }));
    return;
  }
  // OneBot 11 秒回 204，业务异步做，避免上游超时重推
  res.writeHead(204).end();

  const classified = classifyEvent(ev);
  if (!classified.info) {
    counts.skipped++;
    // meta_event/heartbeat 很频繁，只计数不写事件流；消息类被跳过才值得露出来。
    if (ev && ev.post_type === 'message') record('skip', '', 0, classified.skip);
    return;
  }
  const info = classified.info;
  counts.incoming++;
  enqueue(info.key, async () => {
    const started = Date.now();
    try {
      const { text } = await askDsh(info);
      const reply = (text || '').trim() || '（DSH 没有返回内容）';
      await sendReply(info, reply.slice(0, MAX_REPLY_CHARS));
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
      log('fail', info.kind, info.key, redactText(e.message));
      try { await sendReply(info, `出错了：${redactText(e.message).slice(0, 200)}`); } catch (e2) { log('fail:reply', redactText(e2.message)); }
    }
  });
});

server.on('error', (e) => {
  // EADDRINUSE 最常见：旧实例没停干净。打印清楚原因后退出，交给 unit.sh 退避重启/人来看。
  log('fatal: 监听失败', cfg.listen, e.code || e.message);
  process.exit(1);
});
server.listen(port, host, () => log('bridge 已启动', cfg.listen, 'backend=' + cfg.backend, 'napcat=' + cfg.napcatApi));

process.on('unhandledRejection', (e) => {
  log('fatal: 未处理的 Promise rejection', redactText(e && e.stack ? e.stack : e));
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('收到', sig, '，退出');
    // 先让正在跑的 DSH 子进程收到 TERM；1.5 秒后还在的强制杀掉，避免成为孤儿。
    for (const child of activeChildren) { try { child.kill('SIGTERM'); } catch (e) { log('warn: 停止 DSH 子进程失败', e.code || e.message); } }
    setTimeout(() => { for (const child of activeChildren) { try { child.kill('SIGKILL'); } catch (e) { log('warn: 强制停止 DSH 子进程失败', e.code || e.message); } } }, 1500).unref();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
