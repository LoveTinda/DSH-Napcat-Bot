#!/usr/bin/env node
/**
 * 目的：端到端验证 ⑤ 的三件事——输出四档渲染、/output 切换、维护期回复、自动压缩。
 *       用「假 dsh」脚本产生 thinking/tool_call/text/final 的 ndjson，不花真模型的钱。
 * 边界：假 NapCat + 假 DSH + 临时端口/临时目录；不连真 QQ、不连真 DSH。
 * 依赖：node:http/fs/os/child_process + ./bridge.mjs。
 * 失败：任一断言不过 → 退出码 1，并打印实际回执。
 * 副作用：占 16706/13006 端口与一个临时目录，结束即删。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(here, 'bridge.mjs');
const PORT = 16706;
const NAPCAT_PORT = 13006;
const USER = '10001';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('PASS ', name); }
  else { fail++; console.log('FAIL ', name, detail); }
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 假 dsh：按输入回答；"压缩" → 摘要；"/fail" → 退出码 1
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tinda-out-'));
const policyFile = path.join(tmp, 'policy.json');
fs.writeFileSync(policyFile, JSON.stringify({
  privateChat: 'allow', allowAllUsers: true, ownerUsers: [USER], groupChat: 'deny',
}));
const fakeDsh = path.join(tmp, 'fake-dsh.mjs');
fs.writeFileSync(fakeDsh, `
let data = '';
process.stdin.on('data', (c) => { data += c; });
process.stdin.on('end', () => {
  const prompt = data;
  if (prompt.includes('FAILME')) {
    process.stderr.write('fake dsh: boom\\n');
    process.exit(1);
  }
  if (prompt.includes('压缩成一段')) {
    console.log(JSON.stringify({ type: 'final', sessionId: 'sess-1', text: '摘要内容XYZ' }));
    process.exit(0);
  }
  const block = String(prompt).replace(/\\[群聊上下文\\][\\s\\S]*?\\n\\n/, '').trim();
  console.log(JSON.stringify({ type: 'session', sessionId: 'sess-1' }));
  console.log(JSON.stringify({ type: 'thinking', text: '我在想这件事怎么答。' }));
  console.log(JSON.stringify({ type: 'tool_call', callId: 'c1', tool: 'bash', input: { command: 'echo hi' } }));
  console.log(JSON.stringify({ type: 'tool_result', callId: 'c1', status: 'completed', result: 'hi' }));
  console.log(JSON.stringify({ type: 'text', text: '执行中的一句话。' }));
  console.log(JSON.stringify({ type: 'final', text: '最终总结：' + block }));
});
`, 'utf8');

const sent = [];
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    sent.push(String(body.message ?? ''));
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
    BRIDGE_BACKEND: 'headless',
    DSH_BIN: fakeDsh,
    DSH_NODE: process.execPath,
    DSH_HOME: tmp,
    NODE_OPTIONS: '',
    BRIDGE_STATE_FILE: path.join(tmp, 'sessions.json'),
    BRIDGE_OUTBOX_FILE: '',
    BRIDGE_SEEN_FILE: '',
    BRIDGE_OUTPUT_FILE: path.join(tmp, 'output.json'),
    BRIDGE_SUMMARY_FILE: path.join(tmp, 'summaries.json'),
    BRIDGE_POLICY_FILE: policyFile,
    BRIDGE_MAX_EVENT_AGE_SEC: '0',
    // 本测试数的是「发了几条消息」，输入状态会多出请求，关掉更干净
    BRIDGE_TYPING: '0',
    BRIDGE_HUMANIZE: '0',
    BRIDGE_SEND_RETRY: '1',
    BRIDGE_RELAY_AFTER: '2',
    BRIDGE_RELAY_COOLDOWN_SEC: '60',
    BRIDGE_AUTO_COMPACT_ROUNDS: '2',
    ALERT_QQ: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let blog = '';
bridge.stdout.on('data', (d) => { blog += d; });
bridge.stderr.on('data', (d) => { blog += d; });

let seq = 1;
const say = (text) => fetch(`http://127.0.0.1:${PORT}/`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    post_type: 'message', message_type: 'private', self_id: 10000, user_id: USER,
    message_id: ++seq, message: [{ type: 'text', data: { text } }],
  }),
});
const state = async () => (await fetch(`http://127.0.0.1:${PORT}/panel/state.json`)).json();

/** 等新的回执（发送条数超过 mark），最多 8 秒。 */
async function nextReply(mark, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (sent.length > mark) return sent.slice(mark);
    await wait(80);
  }
  return null;
}

try {
  await wait(1000);
  check('桥接器起来了', Boolean(await state()), blog.slice(-200));

  // 1) 默认 minimalist：只有最终总结
  let mark = sent.length;
  await say('你好');
  let out = await nextReply(mark);
  check('默认档位有回执', Boolean(out), JSON.stringify(sent.slice(mark)));
  check('minimalist 不含工具行', Boolean(out && !out.join('').includes('[工具]')), JSON.stringify(out));
  check('minimalist 不含思考', Boolean(out && !out.join('').includes('[思考]')));

  // 2) /output detailed → 下一轮带工具行
  mark = sent.length;
  await say('/output detailed');
  out = await nextReply(mark);
  check('/output 切换有回执', Boolean(out && out.join('').includes('输出档位已切到')), JSON.stringify(out));
  mark = sent.length;
  await say('再问一次');
  out = await nextReply(mark);
  check('detailed 带工具行', Boolean(out && out.join('').includes('[工具]')), JSON.stringify(out));
  check('detailed 不带思考', Boolean(out && !out.join('').includes('[思考]')));

  // 3) /output complete → 带思考
  mark = sent.length;
  await say('/output complete');
  await nextReply(mark);
  mark = sent.length;
  await say('再问一次');
  out = await nextReply(mark);
  check('complete 带思考', Boolean(out && out.join('').includes('[思考]')), JSON.stringify(out));
  // 档位是「每个聊天一份」：换个私聊用户，默认档位仍是 minimalist
  const say2 = (text) => fetch(`http://127.0.0.1:${PORT}/`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      post_type: 'message', message_type: 'private', self_id: 10000, user_id: '10002',
      message_id: ++seq, message: [{ type: 'text', data: { text } }],
    }),
  });
  mark = sent.length;
  await say2('另一个人来问');
  out = await nextReply(mark);
  check('档位按聊天隔离：另一个人仍是 minimalist', Boolean(out && !out.join('').includes('[工具]')), JSON.stringify(out));

  // 4) /output 非法档位
  mark = sent.length;
  await say('/output nonsense');
  out = await nextReply(mark);
  check('非法档位有提示', Boolean(out && out.join('').includes('没有这个档位')), JSON.stringify(out));

  // 5) 自动压缩：第 2 轮结束后应产生摘要并清会话映射
  const s1 = await state();
  check('自动压缩产生了摘要', Boolean(s1.output && s1.output.summaries >= 1), JSON.stringify(s1.output));

  // 6) 维护期回复：连续失败到阈值后回维护文案
  const s2 = await state();
  const failCount = s2.relay ? s2.relay.streak : 0;
  let gotMaint = false;
  for (let i = 0; i < 3 && !gotMaint; i++) {
    mark = sent.length;
    await say('请 FAILME');
    out = await nextReply(mark);
    if (out && out.join('').includes('维护')) gotMaint = true;
  }
  check('连续失败后回维护文案', gotMaint, '失败计数 ' + failCount + ' / ' + JSON.stringify(sent.slice(-3)));
  const s3 = await state();
  check('面板记录维护期状态', Boolean(s3.relay && s3.relay.relayed >= 1), JSON.stringify(s3.relay));
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
