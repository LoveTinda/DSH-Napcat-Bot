#!/usr/bin/env node
// 目的：桥接器的最小回路自测——用假 NapCat 验证「收事件 → 处理后端 → 回消息」整条链路。
// 边界：只测 HTTP 收发与路由，不测真实 DSH（后端用 echo），不测 QQ 登录。
// 依赖：node 内置 http/child_process；bridge.mjs；临时端口 16700/13001。
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

const sent = [];        // 所有收到的回发请求（含失败尝试）
const delivered = [];   // 真正返回 ok 的请求
const failPlan = new Map(); // userId/groupId → 还要失败几次
const blocked = new Set();  // userId/groupId → 一直失败（模拟断网）
const mock = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch {}
    const id = String(body.user_id ?? body.group_id ?? '');
    sent.push({ path: req.url, body });
    let fail = blocked.has(id);
    const left = failPlan.get(id) || 0;
    if (!fail && left > 0) { failPlan.set(id, left - 1); fail = true; }
    if (fail) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'failed', retcode: 1, message: 'mock down' }));
      return;
    }
    delivered.push({ path: req.url, body, id });
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
    BRIDGE_OUTBOX_FILE: '',      // 自测不落盘
    BRIDGE_SEND_RETRY: '3',
    BRIDGE_SEND_DRAIN_MS: '500', // 补发轮询加快，测试不用等 15 秒
    ALERT_QQ: '',
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

// 7) 回发失败自动重试（T-8）：前两次 500，第三次成功
failPlan.set('20005', 2);
await post({
  post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20005,
  message_id: 21, message: [{ type: 'text', data: { text: '重试' } }],
});
const retried = await waitFor(() => (delivered.some((d) => d.id === '20005') ? true : null), 12000);
check('回发失败会自动重试并最终送达', Boolean(retried), JSON.stringify(sent.filter((s) => String(s.body.user_id) === '20005')));
check('重试用满 3 次（2 失败 + 1 成功）', sent.filter((s) => String(s.body.user_id) === '20005').length === 3,
  '实际 ' + sent.filter((s) => String(s.body.user_id) === '20005').length + ' 次');
await wait(600);
check('重试成功只产生一条回复', delivered.filter((d) => d.id === '20005').length === 1,
  '实际 ' + delivered.filter((d) => d.id === '20005').length + ' 条');

// 8) NapCat 重推同一个 message_id 只回答一次
const dupEvent = {
  post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20006,
  message_id: 31, message: [{ type: 'text', data: { text: '重复' } }],
};
await post(dupEvent);
await post(dupEvent);
await waitFor(() => (delivered.some((d) => d.id === '20006') ? true : null));
await wait(500);
check('同一 message_id 只回答一次', delivered.filter((d) => d.id === '20006').length === 1,
  '实际 ' + delivered.filter((d) => d.id === '20006').length + ' 条');

// 9) 断网时回复进补发队列，恢复后补发且不重复
blocked.add('20007');
await post({
  post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20007,
  message_id: 41, message: [{ type: 'text', data: { text: '补发' } }],
});
const queued = await waitFor(async () => {
  try {
    const s = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/state.json`).then((r) => r.json());
    return s.counts && s.counts.outbox > 0 ? s : null;
  } catch { return null; }
}, 15000);
check('发不出去的回复进入补发队列', Boolean(queued), JSON.stringify(blog.slice(-400)));
blocked.delete('20007');
const replayed = await waitFor(() => (delivered.some((d) => d.id === '20007') ? true : null), 12000);
check('恢复后补发队列送达', Boolean(replayed), JSON.stringify(blog.slice(-400)));
await wait(1200);
check('补发只送达一次', delivered.filter((d) => d.id === '20007').length === 1,
  '实际 ' + delivered.filter((d) => d.id === '20007').length + ' 条');

bridge.kill('SIGTERM');
mock.close();
await wait(300);

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} 通过`);
process.exit(failed.length ? 1 : 0);
