#!/usr/bin/env node
// 目的：桥接器的最小回路自测——用假 NapCat 验证「收事件 → 处理后端 → 回消息」整条链路。
// 边界：只测 HTTP 收发与路由，不测真实 DSH（后端用 echo），不测 QQ 登录。
// 输入：无（自己起假 NapCat 和桥接器）。
// 失败：任一断言不成立 → 退出码 1，并打印实际收到的内容。
// 副作用：占用本机 16700/13001 端口，结束后全部关闭。

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(here, 'bridge.mjs');
const BRIDGE_PORT = 16700;
const NAPCAT_PORT = 13001;

const sent = [];
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}
    sent.push({ path: req.url, body });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
  });
});

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  → ' + detail}`);
}

async function post(event) {
  const res = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(event),
  });
  return res.status;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = await pred();
    if (hit) return hit;
    await wait(100);
  }
  return null;
}

await new Promise((r) => mock.listen(NAPCAT_PORT, '127.0.0.1', r));

const bridge = spawn(process.execPath, [BRIDGE], {
  env: {
    ...process.env,
    BRIDGE_LISTEN: `127.0.0.1:${BRIDGE_PORT}`,
    NAPCAT_API: `http://127.0.0.1:${NAPCAT_PORT}`,
    BRIDGE_BACKEND: 'echo',
    NODE_OPTIONS: '',
    BRIDGE_STATE_FILE: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let blog = '';
bridge.stdout.on('data', (d) => { blog += d; });
bridge.stderr.on('data', (d) => { blog += d; });

const up = await waitFor(async () => {
  try { const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`); return r.ok; } catch { return false; }
}, 8000);
check('桥接器启动 /healthz 可用', Boolean(up), blog.slice(-300));

// 1) 私聊消息 → send_private_msg 且带上 echo 结果
await post({
  post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20001,
  message_id: 11, message: [{ type: 'text', data: { text: '你好' } }],
});
const priv = await waitFor(() => sent.find((s) => s.path === '/send_private_msg'));
check('私聊事件触发 send_private_msg', Boolean(priv), JSON.stringify(sent));
check('回发内容包含处理后端输出', Boolean(priv && String(priv.body.message).includes('[echo]')), JSON.stringify(priv && priv.body));
check('回发 user_id 正确', Boolean(priv && String(priv.body.user_id) === '20001'), JSON.stringify(priv && priv.body));

// 2) 群聊消息 → send_group_msg
const before = sent.length;
await post({
  post_type: 'message', message_type: 'group', self_id: 10000, user_id: 20002, group_id: 30001,
  message_id: 12, message: [{ type: 'text', data: { text: '群里好' } }],
});
const grp = await waitFor(() => sent.slice(before).find((s) => s.path === '/send_group_msg'));
check('群聊事件触发 send_group_msg', Boolean(grp), JSON.stringify(sent.slice(before)));
check('群号正确', Boolean(grp && String(grp.body.group_id) === '30001'), JSON.stringify(grp && grp.body));

// 3) 自己发的消息不回环
const before2 = sent.length;
await post({
  post_type: 'message', message_type: 'private', self_id: 10000, user_id: 10000,
  message_id: 13, message: [{ type: 'text', data: { text: '自己' } }],
});
await wait(600);
check('自己发的消息不触发回发', sent.length === before2, JSON.stringify(sent.slice(before2)));

// 4) 非消息事件忽略
const before3 = sent.length;
await post({ post_type: 'notice', notice_type: 'group_increase', group_id: 30001, user_id: 20003 });
await wait(400);
check('非消息事件被忽略', sent.length === before3, JSON.stringify(sent.slice(before3)));

// 5) 空文本不处理
const before4 = sent.length;
await post({ post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20004, message: [] });
await wait(400);
check('空消息被忽略', sent.length === before4, JSON.stringify(sent.slice(before4)));

// 6) 坏 JSON 返回 400 且不崩
const bad = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
});
check('坏 JSON 返回 400', bad.status === 400, String(bad.status));
const alive = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`).then((r) => r.ok).catch(() => false);
check('坏 JSON 后进程仍在线', alive);

bridge.kill('SIGTERM');
mock.close();
await wait(300);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
