#!/usr/bin/env node
/**
 * 目的：把「回复策略」接进真桥接器后做一次端到端验证——谁能触发、谁被拒、面板能不能看见。
 * 边界：用假 NapCat + echo 后端 + 临时端口；不起真 QQ、不连 DSH。
 * 依赖：node:http/fs/os/child_process + ./bridge.mjs；临时目录放策略文件。
 * 失败：任一断言不过 → 退出码 1，并打印实际回发内容与面板状态。
 * 副作用：占 16701/13002 端口与一个临时目录，结束即删。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(here, 'bridge.mjs');
const BRIDGE_PORT = 16701;
const NAPCAT_PORT = 13002;
const ALLOWED = '10001';
const STRANGER = '99999';
const GROUP_OK = '30001';
const GROUP_NO = '40000';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('PASS ', name); }
  else { fail++; console.log('FAIL ', name, detail); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 假 NapCat：只记录回发请求
const sent = [];
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    try { sent.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch { sent.push({ path: req.url, body: {} }); }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
  });
});
await new Promise((r) => mock.listen(NAPCAT_PORT, '127.0.0.1', r));

// 策略：私聊只有 ALLOWED 能触发；群必须 @，且只认 GROUP_OK
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tinda-policy-wire-'));
const policyFile = path.join(tmp, 'policy.json');
fs.writeFileSync(policyFile, JSON.stringify({
  privateChat: 'allowlist',
  allowUsers: [ALLOWED],
  groupChat: 'mention',
  allowGroups: [GROUP_OK],
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
    ALERT_QQ: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let blog = '';
bridge.stdout.on('data', (d) => { blog += d; });
bridge.stderr.on('data', (d) => { blog += d; });

const post = (ev) => fetch(`http://127.0.0.1:${BRIDGE_PORT}/`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(ev),
});
const state = async () => (await fetch(`http://127.0.0.1:${BRIDGE_PORT}/panel/state.json`)).json();

/** 等到条件成立，最多 6 秒。 */
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
  const up = await until(() => true, 8000);
  check('桥接器起来了', Boolean(up), blog.slice(-300));

  const boot = await state();
  check('面板显示策略已加固', boot.policy && boot.policy.hardened === true, JSON.stringify(boot.policy));
  check('策略摘要含私聊=allowlist', /私聊=allowlist/.test(boot.policy.summary), boot.policy.summary);
  check('摘要不含真实号码', !boot.policy.summary.includes(ALLOWED), boot.policy.summary);

  // 1) 白名单私聊 → 回
  await post({ post_type: 'message', message_type: 'private', self_id: 10000, user_id: ALLOWED, message_id: 1, message: [{ type: 'text', data: { text: '你好' } }] });
  const ok1 = await until((s) => s.counts.ok === 1);
  check('白名单私聊放行', Boolean(ok1), JSON.stringify(ok1 && ok1.counts));
  check('回发打到 send_private_msg', sent.some((x) => x.path === '/send_private_msg'));

  // 2) 陌生人私聊 → 不回
  const mark = sent.length;
  await post({ post_type: 'message', message_type: 'private', self_id: 10000, user_id: STRANGER, message_id: 2, message: [{ type: 'text', data: { text: '你好' } }] });
  const ok2 = await until((s) => s.counts.denied === 1);
  check('陌生人私聊被拒且有计数', Boolean(ok2), JSON.stringify(ok2 && ok2.counts));
  check('被拒后没有回发', sent.length === mark, JSON.stringify(sent.slice(mark)));
  check('面板记到 user-not-allowed', Boolean(ok2 && ok2.policy.denied['user-not-allowed'] === 1), JSON.stringify(ok2 && ok2.policy.denied));

  // 3) 群 + @ → 回
  await post({
    post_type: 'message', message_type: 'group', self_id: 10000, user_id: ALLOWED, group_id: GROUP_OK, message_id: 3,
    message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '在吗' } }],
  });
  const ok3 = await until((s) => s.counts.ok === 2);
  check('群 @ 了才回', Boolean(ok3), JSON.stringify(ok3 && ok3.counts));
  check('回发打到 send_group_msg', sent.some((x) => x.path === '/send_group_msg'));

  // 4) 群没 @ → 不回
  const mark4 = sent.length;
  await post({ post_type: 'message', message_type: 'group', self_id: 10000, user_id: ALLOWED, group_id: GROUP_OK, message_id: 4, message: [{ type: 'text', data: { text: '路过' } }] });
  const ok4 = await until((s) => s.counts.denied === 2);
  check('群里没 @ 被拒（not-mentioned）', Boolean(ok4 && ok4.policy.denied['not-mentioned'] === 1), JSON.stringify(ok4 && ok4.policy.denied));
  check('没 @ 时没有回发', sent.length === mark4);

  // 5) 群不在白名单 → 不回
  const mark5 = sent.length;
  await post({
    post_type: 'message', message_type: 'group', self_id: 10000, user_id: ALLOWED, group_id: GROUP_NO, message_id: 5,
    message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: '在吗' } }],
  });
  const ok5 = await until((s) => s.counts.denied === 3);
  check('群不在白名单被拒', Boolean(ok5 && ok5.policy.denied['group-not-allowed'] === 1), JSON.stringify(ok5 && ok5.policy.denied));
  check('被拒的群不回发', sent.length === mark5);

  // 6) 只 @ 不带正文：仍然要回（不然「@ 了没反应」）
  await post({
    post_type: 'message', message_type: 'group', self_id: 10000, user_id: ALLOWED, group_id: GROUP_OK, message_id: 6,
    message: [{ type: 'at', data: { qq: '10000' } }],
  });
  const ok6 = await until((s) => s.counts.ok === 3);
  check('只 @ 不写字也能触发', Boolean(ok6), JSON.stringify(ok6 && ok6.counts));

  // 7) 事件流里只有元信息，不含聊天正文
  const st = await state();
  const dump = JSON.stringify(st.events);
  check('事件流不含聊天正文', !dump.includes('在吗') && !dump.includes('路过'), dump.slice(0, 200));
  check('事件流写明策略拒绝', dump.includes('策略拒绝'), dump.slice(0, 200));
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
