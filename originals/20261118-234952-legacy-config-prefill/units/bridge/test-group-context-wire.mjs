#!/usr/bin/env node
/**
 * 目的：验证「群上下文」在真桥接器里生效——没 @ 的群消息也进缓冲、被 @ 时注入、
 *       注入块进的是给模型的那句话（echo 后端能把 prompt 原样回显，正好用来断言）。
 * 边界：假 NapCat + echo 后端 + 临时端口；不连真 QQ / 真 DSH。
 * 依赖：node:http/child_process + ./bridge.mjs。
 * 失败：任一断言不过 → 退出码 1，并打印实际回执。
 * 副作用：占 16705/13005 端口，结束全部关闭。
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(here, 'bridge.mjs');
const PORT = 16705;
const NAPCAT_PORT = 13005;
const GROUP = '30001';
const U1 = '10001';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('PASS ', name); }
  else { fail++; console.log('FAIL ', name, detail); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const sent = [];
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    sent.push({ message: String(body.message ?? ''), groupId: body.group_id });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
  });
});
await new Promise((r) => mock.listen(NAPCAT_PORT, '127.0.0.1', r));

const bridge = spawn(process.execPath, [BRIDGE], {
  env: {
    ...process.env,
    BRIDGE_LISTEN: `127.0.0.1:${PORT}`,
    NAPCAT_API: `http://127.0.0.1:${NAPCAT_PORT}`,
    BRIDGE_BACKEND: 'echo',
    NODE_OPTIONS: '',
    BRIDGE_STATE_FILE: '',
    BRIDGE_OUTBOX_FILE: '',
    BRIDGE_SEEN_FILE: '',
    BRIDGE_POLICY_FILE: '',
    BRIDGE_MAX_EVENT_AGE_SEC: '0',
    BRIDGE_HUMANIZE: '0',
    ALERT_QQ: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let blog = '';
bridge.stdout.on('data', (d) => { blog += d; });
bridge.stderr.on('data', (d) => { blog += d; });

let seq = 1;
const post = (text, { mention = true, group = GROUP, from = U1 } = {}) => fetch(`http://127.0.0.1:${PORT}/`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    post_type: 'message', message_type: 'group', self_id: 10000, user_id: from, group_id: group,
    message_id: ++seq,
    message: mention
      ? [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text } }]
      : [{ type: 'text', data: { text } }],
  }),
});
const state = async () => (await fetch(`http://127.0.0.1:${PORT}/panel/state.json`)).json();

async function until(cond, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const s = await state().catch(() => null);
    if (s && cond(s)) return s;
    await wait(100);
  }
  return null;
}

try {
  await wait(1000);
  const boot = await state().catch(() => null);
  check('桥接器起来了', Boolean(boot), blog.slice(-300));

  // 1) 没 @ 的闲聊也要进缓冲
  await post('前面这句没人 @ 我', { mention: false });
  const s1 = await until((s) => s.groupContext && s.groupContext.messages >= 1);
  check('没 @ 的群消息进缓冲', Boolean(s1), JSON.stringify(s1 && s1.groupContext));
  check('缓冲不落回执（没 @ 就不回）', sent.length === 0, JSON.stringify(sent));

  // 2) 再记一条，然后 @ 我：注入块应带上前面两条历史
  await post('第二句闲聊', { mention: false });
  await until((s) => s.groupContext.messages >= 2);
  const mark = sent.length;
  await post('那这个报错怎么看');
  const reply = await until(() => sent.length > mark) && sent[sent.length - 1];
  check('被 @ 后有回执', Boolean(reply), JSON.stringify(sent));
  check('echo 出来的 prompt 里有上下文标题', Boolean(reply && reply.message.includes('[群聊上下文]')), reply && reply.message.slice(0, 200));
  check('注入块含前面的闲聊内容', Boolean(reply && reply.message.includes('前面这句没人 @ 我') && reply.message.includes('第二句闲聊')), reply && reply.message.slice(0, 300));
  // 当前这句会作为正文追加在注入块后面，只能出现一次（不能既在上下文里又在正文里）
  const occurrences = reply ? reply.message.split('那这个报错怎么看').length - 1 : 0;
  check('当前这句不重复出现', occurrences === 1, '出现 ' + occurrences + ' 次');

  // 3) /context 能看到缓冲
  const m2 = sent.length;
  await post('/context');
  const ctxReply = await until(() => sent.length > m2) && sent[sent.length - 1];
  check('/context 有回执', Boolean(ctxReply), JSON.stringify(sent.slice(m2)));
  check('/context 报告条数并给预览', Boolean(ctxReply && /本群缓冲：/.test(ctxReply.message)), ctxReply && ctxReply.message.slice(0, 200));

  // 4) 面板统计只有数量没有正文
  const s2 = await state();
  const dump = JSON.stringify(s2.groupContext);
  check('面板群上下文只有数量', Boolean(s2.groupContext && s2.groupContext.messages >= 2));
  check('面板不含聊天正文', !dump.includes('闲聊') && !dump.includes('报错'), dump);
} catch (e) {
  fail++;
  console.log('FAIL  异常：' + e.message);
} finally {
  bridge.kill('SIGKILL');
  mock.close();
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
