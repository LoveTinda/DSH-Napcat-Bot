#!/usr/bin/env node
/**
 * 目的：把「命令表」接进真桥接器后走一遍端到端——/help、/status、/ping、未知命令、
 *       /new 重置、未实现命令的诚实回执、admin 门槛、/stop 空闲时的回执。
 * 边界：假 NapCat + echo 后端 + 临时端口；真起桥接器，但不起 QQ、不连 DSH。
 * 依赖：node:http/fs/os/child_process + ./bridge.mjs。
 * 失败：任一断言不过 → 退出码 1，并打印实际回执。
 * 副作用：占 16702/13003 端口与一个临时目录，结束即删。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(here, 'bridge.mjs');
const BRIDGE_PORT = 16702;
const NAPCAT_PORT = 13003;
const OWNER = '10001';
const USER2 = '10002';
const USER3 = '10003';
const GROUP_OK = '30001';

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
    try { sent.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { sent.push({}); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
  });
});
await new Promise((r) => mock.listen(NAPCAT_PORT, '127.0.0.1', r));

// OWNER 是 owner，USER2 是普通白名单成员
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tinda-cmd-'));
const policyFile = path.join(tmp, 'policy.json');
fs.writeFileSync(policyFile, JSON.stringify({
  privateChat: 'allowlist', allowUsers: [OWNER, USER2, USER3],
  ownerUsers: [OWNER], adminUsers: [USER2],
  groupChat: 'mention', allowGroups: [GROUP_OK],
}));

const bridge = spawn(process.execPath, [BRIDGE], {
  env: {
    ...process.env,
    BRIDGE_LISTEN: `127.0.0.1:${BRIDGE_PORT}`,
    NAPCAT_API: `http://127.0.0.1:${NAPCAT_PORT}`,
    BRIDGE_BACKEND: 'echo',
    NODE_OPTIONS: '',
    BRIDGE_STATE_FILE: '',
    BRIDGE_OUTBOX_FILE: '',
    BRIDGE_SEEN_FILE: '',
    BRIDGE_POLICY_FILE: policyFile,
    BRIDGE_MAX_EVENT_AGE_SEC: '0',
    // 本测试数的是「发了几条消息」，输入状态会多出请求，关掉更干净
    BRIDGE_TYPING: '0',
    ALERT_QQ: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let blog = '';
bridge.stdout.on('data', (d) => { blog += d; });
bridge.stderr.on('data', (d) => { blog += d; });

let seq = 100;
const say = (text, { from = OWNER, group = null, mention = true } = {}) => {
  const ev = group
    ? {
      post_type: 'message', message_type: 'group', self_id: 10000, user_id: from, group_id: group,
      message_id: ++seq,
      message: mention
        ? [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text } }]
        : [{ type: 'text', data: { text } }],
    }
    : {
      post_type: 'message', message_type: 'private', self_id: 10000, user_id: from,
      message_id: ++seq, message: [{ type: 'text', data: { text } }],
    };
  return fetch(`http://127.0.0.1:${BRIDGE_PORT}/`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev),
  });
};
const state = async () => (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/panel/state.json`)).json();

/** 等到出现一条包含 needle 的回执，返回它；超时返回 null。 */
async function reply(needle, mark, ms = 6000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const hit = sent.slice(mark).find((m) => String(m.message || '').includes(needle));
    if (hit) return hit;
    await wait(80);
  }
  return null;
}

try {
  const up = await wait(1200);
  const boot = await state().catch(() => null);
  check('桥接器起来了', Boolean(boot), blog.slice(-300));

  // /ping
  let mark = sent.length;
  await say('/ping');
  const pong = await reply('pong', mark);
  check('/ping 回 pong', Boolean(pong), JSON.stringify(sent.slice(mark)));

  // /help
  mark = sent.length;
  await say('/help');
  const help = await reply('两种输入', mark);
  check('/help 回命令表', Boolean(help), JSON.stringify(sent.slice(mark)).slice(0, 300));
  check('/help 里有 /output 且标明未实现', Boolean(help && /\/output/.test(help.message) && /未实现/.test(help.message)));
  check('/help 不进模型（echo 后端没有 [echo]）', Boolean(help && !String(help.message).includes('[echo]')));

  // /help <命令>
  mark = sent.length;
  await say('/help new');
  const one = await reply('新会话', mark);
  check('/help new 给单条用法', Boolean(one));

  // 未知命令
  mark = sent.length;
  await say('/nonsense');
  const unk = await reply('不认识', mark);
  check('未知命令有回执', Boolean(unk), JSON.stringify(sent.slice(mark)));

  // /output 已转正（v0.2.28）：无参打印档位表，不再回「还没实现」
  mark = sent.length;
  await say('/output');
  const tiers = await reply('当前输出档位', mark);
  check('/output 打印档位表', Boolean(tiers), JSON.stringify(sent.slice(mark)));
  check('/output 列出四档', ['minimalist', 'concise', 'detailed', 'complete'].every((t) => String(tiers && tiers.message).includes(t)), String(tiers && tiers.message).slice(0, 120));

  // 仍未实现的命令：诚实回执
  mark = sent.length;
  await say('/persona');
  const pend = await reply('还没实现', mark);
  check('/persona 明说还没实现', Boolean(pend), JSON.stringify(sent.slice(mark)));

  // admin 门槛：普通用户 /sessions all 被拒
  // allowUsers[0]=owner，其余=admin；所以只有 USER3（第三个）是普通 user
  mark = sent.length;
  await say('/sessions all', { from: USER3 });
  const denied = await reply('没有权限', mark);
  check('普通用户 /sessions all 被拒', Boolean(denied), JSON.stringify(sent.slice(mark)));

  // owner 可以
  mark = sent.length;
  await say('/sessions all', { from: OWNER });
  const okAll = await reply('会话', mark);
  check('owner /sessions all 有回执', Boolean(okAll) && !String(okAll.message).includes('没有权限'));

  // /status 带策略与角色
  mark = sent.length;
  await say('/status');
  const st = await reply('你的角色', mark);
  check('/status 显示角色', Boolean(st), JSON.stringify(sent.slice(mark)));
  check('/status 显示策略且未加固=false', Boolean(st && /策略：/.test(st.message) && !/未加固/.test(st.message)), st && st.message);

  // /policy <文本>
  mark = sent.length;
  await say('/policy 帮我看下这个报错');
  const pol = await reply('会回', mark);
  check('/policy 能给出命中结论', Boolean(pol), JSON.stringify(sent.slice(mark)));

  // /new 之后状态里没有这个聊天的会话映射
  mark = sent.length;
  await say('/new');
  const newReply = await reply('新会话', mark);
  const afterNew = await state();
  check('/new 有回执', Boolean(newReply), JSON.stringify(sent.slice(mark)));
  check('/new 之后映射被清掉', !(afterNew.sessions || []).some((x) => x.key === 'private:' + OWNER));

  // /stop 空闲时
  mark = sent.length;
  await say('/stop');
  check('/stop 空闲时给回执', Boolean(await reply('没有在跑', mark)), JSON.stringify(sent.slice(mark)));

  // 普通对话仍然走 DSH（echo 后端）
  mark = sent.length;
  await say('你好');
  const echo = await reply('[echo]', mark);
  check('普通消息仍走模型后端', Boolean(echo));

  // 命令统计进面板
  const s2 = await state();
  check('面板统计到命令次数', Boolean(s2.commands && s2.commands.total >= 5), JSON.stringify(s2.commands));
  check('面板统计到未知命令', (s2.commands.top || []).some((x) => x.name === '?unknown'));
} catch (e) {
  fail++;
  console.log('FAIL  异常：' + e.message);
} finally {
  bridge.kill('SIGKILL');
  mock.close();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
