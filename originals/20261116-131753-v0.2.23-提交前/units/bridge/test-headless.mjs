#!/usr/bin/env node
// 目的：验证 headless 后端适配层——参数拼装、ndjson 解析、会话续接、失败兜底，用假 dsh 代替真模型。
// 边界：不调用真实 DSH（没有 API key），只测适配层逻辑；不测 QQ 登录。
// 依赖：node 内置 fs/http/child_process；临时目录与 16701/13002 端口。
// 输入：无（自己生成假 dsh 与假 NapCat）。
// 失败：任一断言不成立 → 退出码 1。
// 副作用：写临时目录；占用本机 16701/13002 端口。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(here, 'bridge.mjs');
const BRIDGE_PORT = 16701;
const NAPCAT_PORT = 13002;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-test-'));
const argvLog = path.join(tmp, 'argv.jsonl');
const stateFile = path.join(tmp, 'sessions.json');

// 假 dsh：读 stdin，按 --json 输出会话事件与最终文本；把 argv 记下来供断言
const fakeDsh = path.join(tmp, 'fake-dsh.mjs');
fs.writeFileSync(fakeDsh, `#!/usr/bin/env node
import fs from 'node:fs';
const argv = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(argv) + '\\n');
let input = '';
process.stdin.on('data', (d) => { input += d; });
process.stdin.on('end', () => {
  if (input.includes('FAILME')) { console.error('boom'); process.exit(3); }
  const hasSid = argv.includes('--session-id');
  if (input.includes('RESETME') && hasSid) { console.error('unknown session: ' + argv[argv.indexOf('--session-id') + 1]); process.exit(1); }
  const sid = hasSid ? argv[argv.indexOf('--session-id') + 1] : (input.includes('RESETME') ? 'sess-2' : 'sess-1');
  process.stdout.write(JSON.stringify({ type: 'session', sessionId: sid }) + '\\n');
  process.stdout.write(JSON.stringify({ type: 'assistant', text: '收到：' + input.trim(), sessionId: sid }) + '\\n');
});
`);

const sent = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    sent.push({ path: req.url, body: JSON.parse(raw || '{}') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
  });
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + detail}`);
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { const h = await pred(); if (h) return h; await wait(100); }
  return null;
}

await new Promise((r) => mock.listen(NAPCAT_PORT, '127.0.0.1', r));

const bridge = spawn(process.execPath, [BRIDGE], {
  env: {
    ...process.env,
    BRIDGE_LISTEN: `127.0.0.1:${BRIDGE_PORT}`,
    NAPCAT_API: `http://127.0.0.1:${NAPCAT_PORT}`,
    BRIDGE_BACKEND: 'headless',
    DSH_NODE: process.execPath,
    DSH_BIN: fakeDsh,
    DSH_HOME: tmp,
    BRIDGE_STATE_FILE: stateFile,
    BRIDGE_TIMEOUT_MS: '20000',
    NODE_OPTIONS: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let blog = '';
bridge.stdout.on('data', (d) => { blog += d; });
bridge.stderr.on('data', (d) => { blog += d; });

const up = await waitFor(async () => {
  try { return (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`)).ok; } catch { return false; }
});
check('桥接器启动', Boolean(up), blog.slice(-300));

const post = (ev) => fetch(`http://127.0.0.1:${BRIDGE_PORT}/`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev),
});

// 第一轮：应拿到假 dsh 的文本
await post({ post_type: 'message', message_type: 'private', self_id: 1, user_id: 90001, message: [{ type: 'text', data: { text: '第一句' } }] });
const first = await waitFor(() => sent.find((s) => s.path === '/send_private_msg'));
check('第一条消息有回复', Boolean(first), JSON.stringify(sent));
check('回复内容来自 dsh 输出', Boolean(first && String(first.body.message).includes('收到：第一句')), JSON.stringify(first && first.body));
check('任务文本走 stdin 而非参数', Boolean(fs.readFileSync(argvLog, 'utf8').includes('"-"')), fs.readFileSync(argvLog, 'utf8'));

// 会话落盘
const saved = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
check('会话 id 已落盘', saved['private:90001'] === 'sess-1', JSON.stringify(saved));

// 第二轮：应带 --session-id 续接
const before = sent.length;
await post({ post_type: 'message', message_type: 'private', self_id: 1, user_id: 90001, message: [{ type: 'text', data: { text: '第二句' } }] });
const second = await waitFor(() => sent.slice(before).find((s) => s.path === '/send_private_msg'));
check('第二轮有回复', Boolean(second), JSON.stringify(sent.slice(before)));
const argv2 = fs.readFileSync(argvLog, 'utf8').trim().split('\n').pop();
check('第二轮带 --session-id sess-1', argv2.includes('--session-id') && argv2.includes('sess-1'), argv2);

// 失败路径：dsh 非零退出也要回一条错误摘要，且进程不崩
const before2 = sent.length;
await post({ post_type: 'message', message_type: 'private', self_id: 1, user_id: 90002, message: [{ type: 'text', data: { text: 'FAILME' } }] });
const errReply = await waitFor(() => sent.slice(before2).find((s) => s.path === '/send_private_msg'));
check('dsh 失败时回发错误摘要', Boolean(errReply && String(errReply.body.message).includes('出错了')), JSON.stringify(errReply && errReply.body));
const alive = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`).then((r) => r.ok).catch(() => false);
check('dsh 失败后进程仍在线', alive);

// 会话失效：DSH 报 unknown session 时应清映射、无 --session-id 重试一次，而不是永久失败。
const before3 = sent.length;
await post({ post_type: 'message', message_type: 'private', self_id: 1, user_id: 90001, message: [{ type: 'text', data: { text: 'RESETME' } }] });
const resetReply = await waitFor(() => sent.slice(before3).find((s) => s.path === '/send_private_msg'));
check('失效会话自动重开', Boolean(resetReply && String(resetReply.body.message).includes('收到：RESETME')), JSON.stringify(resetReply && resetReply.body));
const argv3 = fs.readFileSync(argvLog, 'utf8').trim().split('\n').pop();
check('重开时不再带旧 session id', !argv3.includes('--session-id'), argv3);
const saved2 = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
check('新的会话 id 已落盘', saved2['private:90001'] === 'sess-2', JSON.stringify(saved2));

bridge.kill('SIGTERM');
mock.close();
await wait(300);
fs.rmSync(tmp, { recursive: true, force: true });

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
