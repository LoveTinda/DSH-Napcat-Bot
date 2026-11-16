#!/usr/bin/env node
/**
 * 目的：验证「正在输入」状态在真桥接器里真的发到了 NapCat：私聊亮起、结束必关、群聊不发、开关能关。
 * 边界：假 NapCat + echo 后端 + 临时端口；不连真 QQ / 真 DSH。
 * 依赖：node:http/child_process/fs/os + ./bridge.mjs。
 * 失败：任一断言不过 → 退出码 1，并打印实际收到的 set_input_status 序列。
 * 副作用：占 16721/13006 端口；三轮各起一次桥接器，结束全部关闭。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(here, 'bridge.mjs');
const NAPCAT_PORT = 13006;
const GROUP_OK = 88001;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('PASS ', name); }
  else { fail++; console.log('FAIL ', name, detail); }
};

// 假 NapCat：分别记下「发消息」和「输入状态」
let sends = [];
let status = [];
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    if (req.url === '/set_input_status') status.push({ at: Date.now(), ...body });
    else sends.push({ at: Date.now(), path: req.url, message: String(body.message ?? '') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
  });
});
await new Promise((r) => mock.listen(NAPCAT_PORT, '127.0.0.1', r));

// 群聊放行（不然 @ 检测跑不到闸门后面那步），私聊全放行
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tinda-typing-wire-'));
const policyFile = path.join(tmp, 'policy.json');
fs.writeFileSync(policyFile, JSON.stringify({
  privateChat: 'allow',
  allowAllUsers: true,
  groupChat: 'mention',
  allowGroups: [GROUP_OK],
}));

async function startBridge(port, extraEnv) {
  sends = []; status = [];
  const bridge = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      BRIDGE_LISTEN: `127.0.0.1:${port}`,
      NAPCAT_API: `http://127.0.0.1:${NAPCAT_PORT}`,
      BRIDGE_BACKEND: 'echo',
      NODE_OPTIONS: '',
      BRIDGE_STATE_FILE: '',
      BRIDGE_OUTBOX_FILE: '',
      BRIDGE_SEEN_FILE: '',
      BRIDGE_POLICY_FILE: policyFile,
      BRIDGE_MAX_EVENT_AGE_SEC: '0',
      BRIDGE_HUMANIZE: '0',
      ALERT_QQ: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let blog = '';
  bridge.stdout.on('data', (d) => { blog += d; });
  bridge.stderr.on('data', (d) => { blog += d; });
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return { bridge, blog: () => blog }; } catch {}
    await wait(100);
  }
  bridge.kill('SIGKILL');
  throw new Error('桥接器没起来：' + blog.slice(-200));
}

async function post(port, ev) {
  await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev),
  });
}

/** 等到「发出一条回复」并且「输入状态已停止」为止。 */
async function settle(ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await wait(150);
    if (sends.length && status.some((s) => s.event_type === 1)) break;
  }
}

const priv = (id) => ({
  post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20001,
  message_id: id, message: [{ type: 'text', data: { text: '你好' } }],
});

try {
  // 第 1 轮：私聊 → 先亮、后关
  let r = await startBridge(16721, {});
  await post(16721, priv(Date.now() % 100000));
  await settle();
  r.bridge.kill('SIGKILL');
  await wait(150);
  check('私聊会发 set_input_status', status.length >= 2, JSON.stringify(status));
  check('第一条是「开始」(0)', status[0] && status[0].event_type === 0, JSON.stringify(status[0]));
  check('结尾是「停止」(1)', status[status.length - 1] && status[status.length - 1].event_type === 1, JSON.stringify(status[status.length - 1]));
  check('带的是对话人的 user_id', status[0] && status[0].user_id === 20001, JSON.stringify(status[0]));
  check('状态在回复之前或同时到达', status[0] && sends[0] && status[0].at <= sends[0].at, `${status[0] && status[0].at} vs ${sends[0] && sends[0].at}`);

  // 第 2 轮：群聊（@ 触发）→ 不发输入状态（NapCat 只实现了 C2C）
  r = await startBridge(16722, {});
  await post(16722, {
    post_type: 'message', message_type: 'group', self_id: 10000, group_id: GROUP_OK, user_id: 20002,
    message_id: Date.now() % 100000,
    message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' 在吗' } }],
  });
  await settle();
  r.bridge.kill('SIGKILL');
  await wait(150);
  check('群聊不发输入状态', status.length === 0, JSON.stringify(status));
  check('群聊确实回了（验证不是被闸门拦掉）', sends.length >= 1, JSON.stringify(sends.map((s) => s.path)));

  // 第 3 轮：关掉开关 → 一条都不发
  r = await startBridge(16723, { BRIDGE_TYPING: '0' });
  await post(16723, priv((Date.now() + 7) % 100000));
  await settle();
  r.bridge.kill('SIGKILL');
  await wait(150);
  check('BRIDGE_TYPING=0 时完全不发', status.length === 0, JSON.stringify(status));
  check('关掉输入状态不影响回复', sends.length >= 1, JSON.stringify(sends.map((s) => s.path)));
} catch (e) {
  fail++;
  console.log('FAIL  异常：' + e.message);
} finally {
  mock.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass} 项通过${fail ? '，' + fail + ' 项失败' : ''}`);
process.exit(fail ? 1 : 0);
