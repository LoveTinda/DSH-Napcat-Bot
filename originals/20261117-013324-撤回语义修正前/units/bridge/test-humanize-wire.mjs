#!/usr/bin/env node
/**
 * 目的：验证「拟人化投递」在真桥接器里生效——长回复被拆成多条、每条不超长、总等待有上限、
 *       关掉开关后回到一条发完。
 * 边界：假 NapCat + echo 后端 + 临时端口；不连真 QQ / 真 DSH。
 * 依赖：node:http/child_process + ./bridge.mjs。
 * 失败：任一断言不过 → 退出码 1，并打印实际发送序列。
 * 副作用：占 16703/13004 端口；两轮各起一次桥接器，结束全部关闭。
 */

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.join(here, 'bridge.mjs');
const NAPCAT_PORT = 13004;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('PASS ', name); }
  else { fail++; console.log('FAIL ', name, detail); }
};

// 假 NapCat：记录每次回发（含到达时间）
let sends = [];
const mock = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
    sends.push({ at: Date.now(), path: req.url, message: String(body.message ?? '') });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
  });
});
await new Promise((r) => mock.listen(NAPCAT_PORT, '127.0.0.1', r));

const LONG = Array.from({ length: 12 }, (_, i) => '这是第' + (i + 1) + '句话，用来把回复撑到需要分条的长度。').join('');

/**
 * 目的：起一个桥接器，发一条长消息，收回它发出去的所有分段。
 * 输入：端口与额外环境变量；输出：{ sends, elapsed, blog }。
 * 失败：起不来时 throws。
 */
async function runOnce(port, extraEnv) {
  sends = [];
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
      BRIDGE_POLICY_FILE: '',
      BRIDGE_MAX_EVENT_AGE_SEC: '0',
      // 本测试数的是「发了几条消息」，输入状态会多出请求，关掉更干净
      BRIDGE_TYPING: '0',
      ALERT_QQ: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let blog = '';
  bridge.stdout.on('data', (d) => { blog += d; });
  bridge.stderr.on('data', (d) => { blog += d; });

  // 等 healthz
  const end = Date.now() + 8000;
  let up = false;
  while (Date.now() < end) {
    try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) { up = true; break; } } catch {}
    await wait(100);
  }
  if (!up) { bridge.kill('SIGKILL'); throw new Error('桥接器没起来：' + blog.slice(-200)); }

  const started = Date.now();
  await fetch(`http://127.0.0.1:${port}/`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      post_type: 'message', message_type: 'private', self_id: 10000, user_id: 20001,
      message_id: Date.now() % 100000, message: [{ type: 'text', data: { text: LONG } }],
    }),
  });
  // 等到不再有新分段（连续 1.2 秒没有新发送）
  let last = sends.length;
  while (Date.now() - started < 20000) {
    await wait(300);
    if (sends.length === last) { if (last > 0) break; } else last = sends.length;
  }
  const elapsed = Date.now() - started;
  bridge.kill('SIGKILL');
  await wait(200);
  return { sends: sends.slice(), elapsed, blog };
}

try {
  // 第 1 轮：开启拟人化，上限 3 条 / 40 字 / 总等待 300ms
  const r1 = await runOnce(16703, {
    BRIDGE_HUMANIZE: '1',
    BRIDGE_HUMANIZE_MAX_BUBBLES: '3',
    BRIDGE_HUMANIZE_MAX_CHARS: '40',
    BRIDGE_HUMANIZE_TOTAL_DELAY_MS: '300',
  });
  check('长回复被拆成多条', r1.sends.length > 1, JSON.stringify(r1.sends.map((x) => x.message.length)));
  check('条数不超过配置上限（3）', r1.sends.length <= 3, String(r1.sends.length));
  // 规则：除最后一条外都要 ≤ min(2×maxChars, 80)，最后一条是「合并剩余」允许长一些（≤4000）
  const body = r1.sends.slice(0, -1);
  check('前面的分段都受字数上限约束', body.every((x) => x.message.length <= 80), JSON.stringify(r1.sends.map((x) => x.message.length)));
  check('最后一条不超过 QQ 单条上限', !r1.sends.length || r1.sends[r1.sends.length - 1].message.length <= 4000);
  check('分段之间确实有等待', r1.sends.length < 2 || r1.sends[1].at - r1.sends[0].at >= 100, String(r1.sends[1] ? r1.sends[1].at - r1.sends[0].at : 0));
  check('总耗时受总等待上限约束（< 5s）', r1.elapsed < 5000, String(r1.elapsed));
  check('内容没丢：拼起来等于 echo 结果', r1.sends.map((x) => x.message).join('').includes('第12句话'), r1.sends.map((x) => x.message).join('').slice(0, 120));
  check('面板记录到分条数', Boolean(r1.sends.length), '');

  // 第 2 轮：关掉拟人化
  const r2 = await runOnce(16704, { BRIDGE_HUMANIZE: '0' });
  check('关闭后只发一条', r2.sends.length === 1, JSON.stringify(r2.sends.map((x) => x.message.length)));
  check('关闭后不分条、内容完整', r2.sends.length === 1 && r2.sends[0].message.includes('第12句话'));
} catch (e) {
  fail++;
  console.log('FAIL  异常：' + e.message);
} finally {
  mock.close();
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
