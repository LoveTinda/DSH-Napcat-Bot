#!/usr/bin/env node
/**
 * 目的：用真桥接器 + 假 NapCat + 假 DSH 验证交互动作的线上行为——标记不进正文、动作真的发出、
 *       撤回删本轮气泡、群 poke 默认关、动作报错不影响正文、总开关关闭时原样保留、提示只注入一次。
 * 边界：不连真 QQ / 真 DSH；每个场景起一个临时端口上的桥接器，结束全部杀掉。
 * 依赖：node:http/child_process/fs/os/path/url；./bridge.mjs。
 * 失败：任一断言不过 → 退出码 1，并打印桥接器日志尾部与收到的请求。
 * 副作用：占 16741–16748 与 13007 端口，写临时目录（结束删除）。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(here, 'bridge.mjs');
const NAPCAT_PORT = 13007;
const GROUP_ID = 88002;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('PASS ', name); }
  else { fail++; console.log('FAIL ', name, detail); }
};
const eq = (name, actual, expected) => check(name, actual === expected, '实际=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expected));

// 假 DSH：把 prompt 记到文件，把 prompt 里的 REPLY_B64 解出来当最终回答，并返回固定会话 id。
// 这样既能精确控制回复内容，也能断言「交互提示只在第一轮拼进 prompt」。
const FAKE_DSH = [
  "import fs from 'node:fs';",
  "let raw = '';",
  "process.stdin.setEncoding('utf8');",
  "process.stdin.on('data', (c) => { raw += c; });",
  "process.stdin.on('end', () => {",
  "  const log = process.env.FAKE_DSH_LOG;",
  "  if (log) fs.appendFileSync(log, JSON.stringify({ prompt: raw, argv: process.argv.slice(2) }) + String.fromCharCode(10));",
  "  const m = raw.match(/REPLY_B64:([A-Za-z0-9+/=]+)/);",
  "  const text = m ? Buffer.from(m[1], 'base64').toString('utf8') : '好的';",
  "  process.stdout.write(JSON.stringify({ type: 'final', text, sessionId: process.env.FAKE_DSH_SID || 'sess-wire-1' }) + String.fromCharCode(10));",
  "});",
].join('\n');

// 假 NapCat：发送类请求回递增 message_id，动作类请求单独记录；failActions 可让动作返回 500。
let sends = [];
let actions = [];
let failActions = false;
let nextMessageId = 7000;
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    const p = String(req.url || '').split('?')[0];
    if (p === '/send_private_msg' || p === '/send_group_msg') {
      const id = nextMessageId++;
      sends.push({ path: p, body, id });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: id } }));
      return;
    }
    actions.push({ path: p, body });
    if (failActions) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'failed', retcode: 1200, message: 'mock action failure' }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: {} }));
  });
});
await new Promise((r) => mock.listen(NAPCAT_PORT, '127.0.0.1', r));

// 私聊全放行；群必须 @，只放行测试群。
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tinda-interactions-wire-'));
const policyFile = path.join(tmp, 'policy.json');
fs.writeFileSync(policyFile, JSON.stringify({
  privateChat: 'allow',
  allowAllUsers: true,
  groupChat: 'mention',
  allowGroups: [GROUP_ID],
}));
const fakeDsh = path.join(tmp, 'fake-dsh.mjs');
fs.writeFileSync(fakeDsh, FAKE_DSH);

let current = null;
async function startBridge(port, extraEnv = {}) {
  sends = [];
  actions = [];
  failActions = false;
  nextMessageId = 7000;
  const dshLog = path.join(tmp, 'dsh-' + port + '.log');
  fs.writeFileSync(dshLog, '');
  const bridge = spawn(process.execPath, [BRIDGE], {
    env: {
      ...process.env,
      BRIDGE_LISTEN: '127.0.0.1:' + port,
      NAPCAT_API: 'http://127.0.0.1:' + NAPCAT_PORT,
      BRIDGE_BACKEND: 'headless',
      DSH_NODE: process.execPath,
      DSH_BIN: fakeDsh,
      DSH_HOME: '',
      BRIDGE_STATE_FILE: '',
      BRIDGE_OUTBOX_FILE: '',
      BRIDGE_SEEN_FILE: '',
      BRIDGE_POLICY_FILE: policyFile,
      BRIDGE_MAX_EVENT_AGE_SEC: '0',
      BRIDGE_HUMANIZE: '0',
      BRIDGE_TYPING: '0',
      ALERT_QQ: '',
      FAKE_DSH_LOG: dshLog,
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let blog = '';
  bridge.stdout.on('data', (d) => { blog += d; });
  bridge.stderr.on('data', (d) => { blog += d; });
  const end = Date.now() + 8000;
  while (Date.now() < end) {
    try { if ((await fetch('http://127.0.0.1:' + port + '/healthz')).ok) {
      current = { bridge, port, dshLog, log: () => blog, stop: async () => {
        bridge.kill('SIGKILL');
        await new Promise((r) => bridge.once('close', r));
        await wait(120);
      } };
      return current;
    } } catch {}
    await wait(80);
  }
  bridge.kill('SIGKILL');
  throw new Error('桥接器没起来：' + blog.slice(-300));
}

async function post(port, ev) {
  await fetch('http://127.0.0.1:' + port + '/', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev),
  });
}
async function waitFor(cond, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await wait(60);
  }
  return false;
}
function readDshLog(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
const reply = (text) => 'REPLY_B64:' + Buffer.from(text, 'utf8').toString('base64');
const priv = (id, text) => ({
  post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20001,
  message_id: id, message: [{ type: 'text', data: { text } }],
});
const group = (id, text) => ({
  post_type: 'message', message_type: 'group', self_id: 10000, group_id: GROUP_ID, user_id: 20002,
  message_id: id, message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: ' ' + text } }],
});
const actionPaths = () => actions.map((a) => a.path);

try {
  // 场景 1：私聊 react——动作发出、正文里没有标记、提示只在第一轮注入
  let b = await startBridge(16741);
  await post(16741, priv(101, reply('收到，谢谢[[react:赞]]')));
  await waitFor(() => sends.length === 1 && actions.length === 1);
  check('私聊 react：正文已发出', sends.length === 1, JSON.stringify(sends));
  eq('私聊 react：标记从可见正文删掉', sends[0] && sends[0].body.message, '收到，谢谢');
  eq('私聊 react：调用 set_msg_emoji_like', actionPaths()[0], '/set_msg_emoji_like');
  eq('私聊 react：emoji_id 是字符串 76', actions[0] && actions[0].body.emoji_id, '76');
  eq('私聊 react：回应的是用户那条消息', actions[0] && actions[0].body.message_id, 101);

  await post(16741, priv(102, reply('第二轮')));
  await waitFor(() => sends.length === 2);
  const prompts1 = readDshLog(b.dshLog);
  check('两轮各调用一次 DSH', prompts1.length === 2, JSON.stringify(prompts1.map((x) => x.prompt.slice(0, 30))));
  check('第一轮 prompt 注入交互提示', prompts1[0] && prompts1[0].prompt.includes('[小动作]'), prompts1[0] && prompts1[0].prompt);
  check('第二轮 prompt 不再注入（每会话一次）', prompts1[1] && !prompts1[1].prompt.includes('[小动作]'), prompts1[1] && prompts1[1].prompt);
  check('日志能证明提示只注入一次', b.log().includes('交互提示已注入'), b.log().slice(-300));
  await b.stop();

  // 场景 2：代码围栏里的标记不执行，围栏外照常执行
  b = await startBridge(16742);
  const fencedReply = ['代码里的不算：', '```', '[[react:赞]]', '```', '[[poke]]'].join('\n');
  await post(16742, priv(201, reply(fencedReply)));
  await waitFor(() => sends.length === 1 && actions.length === 1);
  check('围栏场景：正文只发一条', sends.length === 1, JSON.stringify(sends));
  check('围栏内的标记原样显示', sends[0] && sends[0].body.message.includes('[[react:赞]]'), sends[0] && sends[0].body.message);
  check('围栏外的 poke 被删掉', sends[0] && !sends[0].body.message.includes('[[poke]]'), sends[0] && sends[0].body.message);
  eq('围栏内的 react 不执行，只执行 poke', actionPaths().join(','), '/friend_poke');
  await b.stop();

  // 场景 3：撤回——delete_msg 的 id 必须等于发送返回的 message_id
  b = await startBridge(16743);
  await post(16743, priv(301, reply('这条先发再撤回[[recall]]')));
  await waitFor(() => sends.length === 1 && actions.length === 1);
  eq('撤回：正文不含标记', sends[0] && sends[0].body.message, '这条先发再撤回');
  eq('撤回：调用 delete_msg', actionPaths()[0], '/delete_msg');
  eq('撤回：删的是本轮气泡的 message_id', actions[0] && actions[0].body.message_id, sends[0] && sends[0].id);
  await b.stop();

  // 场景 4：纯动作回复不发空消息，但动作执行了
  b = await startBridge(16744);
  await post(16744, priv(401, reply('[[poke]]')));
  await waitFor(() => actions.length === 1);
  eq('纯动作：不发任何正文', sends.length, 0);
  eq('纯动作：仍然戳一戳', actionPaths()[0], '/friend_poke');
  eq('纯动作：戳的是发消息的人', actions[0] && actions[0].body.user_id, 20001);
  await b.stop();

  // 场景 5：群 poke 默认关；打开配置后才发
  b = await startBridge(16745);
  await post(16745, group(501, reply('[[poke]]')));
  await wait(600);
  eq('群 poke 默认关：不发请求', actions.length, 0);
  eq('群 poke 默认关：也不发正文', sends.length, 0);
  await b.stop();

  b = await startBridge(16745, { BRIDGE_INTERACTIONS_GROUP_POKE: '1' });
  await post(16745, group(502, reply('[[poke]]')));
  await waitFor(() => actions.length === 1);
  eq('打开群 poke：调用 group_poke', actionPaths()[0], '/group_poke');
  eq('打开群 poke：带群号', actions[0] && actions[0].body.group_id, GROUP_ID);
  eq('打开群 poke：带成员 QQ', actions[0] && actions[0].body.user_id, 20002);
  eq('打开群 poke：纯动作仍不发正文', sends.length, 0);
  await b.stop();

  // 场景 6：动作 API 报错——正文照样送达，日志有 warn，面板记失败
  b = await startBridge(16746);
  failActions = true;
  await post(16746, priv(601, reply('正文照发[[react:赞]]')));
  await waitFor(() => sends.length === 1 && actions.length === 1);
  eq('动作报错：正文照样送达', sends[0] && sends[0].body.message, '正文照发');
  check('动作报错：日志有「动作执行异常」', await waitFor(() => b.log().includes('动作执行异常')), b.log().slice(-400));
  const panel = await (await fetch('http://127.0.0.1:16746/panel/state.json')).json();
  check('动作报错：面板记录本轮失败 1 个', panel.interactions && panel.interactions.last && panel.interactions.last.failed === 1, JSON.stringify(panel.interactions));
  await b.stop();

  // 场景 7：总开关关闭——标记原样进正文，不发任何动作请求
  b = await startBridge(16747, { BRIDGE_INTERACTIONS: '0' });
  await post(16747, priv(701, reply('原样[[react:赞]]')));
  await waitFor(() => sends.length === 1);
  eq('关闭时：标记原样进正文', sends[0] && sends[0].body.message, '原样[[react:赞]]');
  eq('关闭时：不发动作请求', actions.length, 0);
  await b.stop();

  // 场景 8：撤回本轮所有气泡（分条后逐条删）
  b = await startBridge(16748, { BRIDGE_HUMANIZE: '1', BRIDGE_HUMANIZE_MAX_BUBBLES: '3', BRIDGE_HUMANIZE_MAX_CHARS: '40', BRIDGE_HUMANIZE_TOTAL_DELAY_MS: '0' });
  const longReply = '这是第一句比较长的测试内容用来撑开单条气泡的字数上限。' +
    '这是第二句比较长的测试内容用来撑开单条气泡的字数上限。' +
    '这是第三句比较长的测试内容用来撑开单条气泡的字数上限。[[recall]]';
  await post(16748, priv(801, reply(longReply)));
  await waitFor(() => sends.length >= 2 && actions.length >= sends.length);
  const sentIds = sends.map((s) => s.id);
  const deletedIds = actions.filter((a) => a.path === '/delete_msg').map((a) => a.body.message_id);
  check('多条气泡都发出去了', sends.length >= 2, JSON.stringify(sends.map((s) => s.body.message)));
  eq('每条气泡都删了', deletedIds.join(','), sentIds.join(','));
  check('正文里没有 recall 标记', sends.every((s) => !String(s.body.message).includes('[[recall]]')), JSON.stringify(sends.map((s) => s.body.message)));
  await b.stop();
} catch (e) {
  fail++;
  console.log('FAIL  异常：' + e.message);
  if (current) console.log('桥接器日志尾部：\n' + current.log().slice(-1000));
} finally {
  if (current && current.bridge.exitCode == null) { try { current.bridge.kill('SIGKILL'); } catch {} }
  mock.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log('\n' + pass + ' 项通过' + (fail ? '，' + fail + ' 项失败' : ''));
process.exit(fail ? 1 : 0);
