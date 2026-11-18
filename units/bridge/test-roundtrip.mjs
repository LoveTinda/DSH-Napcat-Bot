#!/usr/bin/env node
// 目的：桥接器的最小回路自测——用假 NapCat 验证「收事件 → 处理后端 → 回消息」整条链路。
// 边界：只测 HTTP 收发与路由，不测真实 DSH（后端用 echo），不测 QQ 登录。
// 依赖：node 内置 http/child_process；bridge.mjs；临时端口 16700/13001。
// 输入：无（自己起假 NapCat 和桥接器）。
// 失败：任一断言不成立 → 退出码 1，并打印实际收到的内容。
// 副作用：占用本机 16700/13001 端口，结束后全部关闭。

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
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
    // 引用回复会先调 get_msg；这里按 id 返回固定消息，且不计入 sent（它不是回发）。
    if (req.url === '/get_msg') {
      const qid = String(body.message_id ?? '');
      if (qid === '777') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok', retcode: 0,
          data: {
            message: [{ type: 'text', data: { text: '被引用的原话' } }],
            sender: { user_id: 10000, nickname: '机器人' },
          },
        }));
      } else if (qid === '888') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          status: 'ok', retcode: 0,
          data: {
            message: [{ type: 'text', data: { text: '别人的话' } }],
            sender: { user_id: 20002, nickname: '群友' },
          },
        }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'failed', retcode: 1, message: 'not found' }));
      }
      return;
    }
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

// 策略文件：自测要覆盖「私聊放行 + 群必须 @」这条真实默认，所以显式给一份。
const policyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tinda-policy-'));
const policyFile = path.join(policyDir, 'policy.json');
fs.writeFileSync(policyFile, JSON.stringify({
  privateChat: 'allow', allowAllUsers: true, groupChat: 'mention', allowAllGroups: true,
}));

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
    BRIDGE_MAX_EVENT_AGE_SEC: '120',
    // 本测试数的是「发了几条消息」，输入状态会多出请求，关掉更干净
    BRIDGE_TYPING: '0',
    BRIDGE_SEEN_FILE: '',
    BRIDGE_POLICY_FILE: policyFile,
    // 非法值必须回退到 group，而不是把 key 拼坏。
    BRIDGE_GROUP_SESSION_SCOPE: 'bogus',
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
const st0 = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/state.json`).then((r) => r.json()).catch(() => ({}));
check('非法群会话范围回退 group', Boolean(st0.messageLayer && st0.messageLayer.groupSessionScope === 'group'),
  JSON.stringify(st0.messageLayer));

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
  message_id: 12,
  message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '群里好' } }],
});
const grp = await waitFor(() => sent.slice(before).find((s) => s.path === '/send_group_msg'));
check('群聊事件触发 send_group_msg', Boolean(grp), JSON.stringify(sent.slice(before)));
check('群号正确', Boolean(grp && String(grp.body.group_id) === '30001'), JSON.stringify(grp && grp.body));
check('群回复 @ 提问者', Boolean(grp && String(grp.body.message).startsWith('[CQ:at,qq=20002] ')),
  JSON.stringify(grp && grp.body));
check('群首次回复披露 AI 身份', Boolean(grp && String(grp.body.message).includes('我是接入 DSH 的机器人')),
  JSON.stringify(grp && grp.body));

// 2.1) 同一群第二条：不再披露，但仍 @ 新的提问者
const g2Mark = sent.length;
await post({
  post_type: 'message', message_type: 'group', self_id: 10000, user_id: 20003, group_id: 30001,
  message_id: 14,
  message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '第二句' } }],
});
const grp2 = await waitFor(() => sent.slice(g2Mark).find((s) => s.path === '/send_group_msg'));
check('同群第二次不再披露', Boolean(grp2) && !String(grp2.body.message).includes('我是接入 DSH 的机器人'),
  JSON.stringify(grp2 && grp2.body));
check('同群第二次 @ 新提问者', Boolean(grp2) && String(grp2.body.message).startsWith('[CQ:at,qq=20003] '),
  JSON.stringify(grp2 && grp2.body));

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

// 5.1) 表情 / 戳一戳：占位符要进提示词，不能静默
const faceMark = sent.length;
await post({
  post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20020,
  message_id: 71, message: [{ type: 'text', data: { text: '前面' } }, { type: 'face', data: { id: '1' } }],
});
const faceReply = await waitFor(() => sent.slice(faceMark).find((s) => s.path === '/send_private_msg'));
check('表情进入提示词', Boolean(faceReply) && String(faceReply.body.message).includes('[表情]'),
  JSON.stringify(faceReply && faceReply.body));

const pokeMark = sent.length;
await post({
  post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20021,
  message_id: 72, message: [{ type: 'poke', data: {} }],
});
const pokeReply = await waitFor(() => sent.slice(pokeMark).find((s) => s.path === '/send_private_msg'));
check('戳一戳进入提示词', Boolean(pokeReply) && String(pokeReply.body.message).includes('[戳一戳]'),
  JSON.stringify(pokeReply && pokeReply.body));

// 5.2) 只发语音：明确回“暂不支持”，不烧 DSH 回合
const unsupMark = sent.length;
await post({
  post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20022,
  message_id: 73, message: [{ type: 'record', data: { file: 'a.amr' } }],
});
const unsupReply = await waitFor(() => sent.slice(unsupMark).find((s) => s.path === '/send_private_msg'));
check('语音-only 明确提示暂不支持', Boolean(unsupReply) && String(unsupReply.body.message).includes('暂不支持语音'),
  JSON.stringify(unsupReply && unsupReply.body));
check('语音-only 不触发 DSH 回显', Boolean(unsupReply) && !String(unsupReply.body.message).includes('[echo]'),
  JSON.stringify(unsupReply && unsupReply.body));

// 5.3) 引用回复：get_msg 可读时把原话拼进提示词
const quoteMark = sent.length;
await post({
  post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20023,
  message_id: 74,
  message: [{ type: 'reply', data: { id: 777 } }, { type: 'text', data: { text: '你看这个' } }],
});
const quoteReply = await waitFor(() => sent.slice(quoteMark).find((s) => s.path === '/send_private_msg'));
check('引用内容进入提示词', Boolean(quoteReply) && String(quoteReply.body.message).includes('被引用的原话'),
  JSON.stringify(quoteReply && quoteReply.body));
check('引用内容标明发送者', Boolean(quoteReply) && String(quoteReply.body.message).includes('引用回复 机器人'),
  JSON.stringify(quoteReply && quoteReply.body));

// 5.3b) 引用取不到：明确说不可读，不让模型猜
const quoteBadMark = sent.length;
await post({
  post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20025,
  message_id: 76,
  message: [{ type: 'reply', data: { id: 999 } }, { type: 'text', data: { text: '这啥' } }],
});
const quoteBadReply = await waitFor(() => sent.slice(quoteBadMark).find((s) => s.path === '/send_private_msg'));
check('引用不可读时明确提示', Boolean(quoteBadReply) && String(quoteBadReply.body.message).includes('引用消息不可读'),
  JSON.stringify(quoteBadReply && quoteBadReply.body));

// 5.4) 群里“回复机器人那条”没有 @ 也算 mention
const quoteGroupMark = sent.length;
await post({
  post_type: 'message', message_type: 'group', self_id: 10000, user_id: 20024, group_id: 30003,
  message_id: 75,
  message: [{ type: 'reply', data: { id: 777 } }, { type: 'text', data: { text: '这是什么' } }],
});
const quoteGroupReply = await waitFor(() => sent.slice(quoteGroupMark).find((s) => s.path === '/send_group_msg'));
check('回复机器人算 @：群里不 @ 也回', Boolean(quoteGroupReply), JSON.stringify(sent.slice(quoteGroupMark)));
check('回复机器人：引用原话进提示词', Boolean(quoteGroupReply) && String(quoteGroupReply.body.message).includes('被引用的原话'),
  JSON.stringify(quoteGroupReply && quoteGroupReply.body));

// 6) 坏 JSON 返回 400 且不崩
const bad = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json',
});
check('坏 JSON 返回 400', bad.status === 400, String(bad.status));
const alive = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/healthz`).then((r) => r.ok).catch(() => false);
check('坏 JSON 后进程仍在线', alive);

// 6.4) 控制命令：/reset 与 /session（只走私聊）
const cmdMark = sent.length;
await post({
  post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20010,
  message_id: 61, message: [{ type: 'text', data: { text: '/reset' } }],
});
const resetReply = await waitFor(() => sent.slice(cmdMark).find((s) => s.path === '/send_private_msg'));
check('/reset 有回复', Boolean(resetReply) && /新会话/.test(String(resetReply.body.message)),
  JSON.stringify(resetReply && resetReply.body));
await post({
  post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20010,
  message_id: 62, message: [{ type: 'text', data: { text: '/session' } }],
});
const sessReply = await waitFor(() => sent.slice(cmdMark).filter((s) => s.path === '/send_private_msg').length >= 2
  ? sent.slice(cmdMark).filter((s) => s.path === '/send_private_msg')[1] : null);
check('/session 有回复', Boolean(sessReply) && /会话/.test(String(sessReply.body.message)),
  JSON.stringify(sessReply && sessReply.body));

// 群里的 /reset 不生效（要当普通问题交给 DSH）
const gMark = sent.length;
await post({
  post_type: 'message', message_type: 'group', self_id: 10000, user_id: 20011, group_id: 30002,
  message_id: 63,
  message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '/reset' } }],
});
const groupReply = await waitFor(() => sent.slice(gMark).find((s) => s.path === '/send_group_msg'));
check('群里的 /reset 不当作控制命令', Boolean(groupReply) && !String(groupReply.body.message).includes('已重置'),
  JSON.stringify(groupReply && groupReply.body));

// 6.5) 重连补推的旧事件：带 10 分钟前的 time，必须被忽略
const staleMark = sent.length;
await post({
  post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20009,
  message_id: 51, time: Math.floor(Date.now() / 1000) - 600,
  message: [{ type: 'text', data: { text: '十分钟前的旧消息' } }],
});
await wait(600);
check('过期事件不触发回发', sent.length === staleMark, JSON.stringify(sent.slice(staleMark)));

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
