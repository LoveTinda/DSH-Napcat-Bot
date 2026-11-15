// 目的：验证桥接器面板——统计、会话表、事件流、页面本身；不起真实 NapCat、不连 DSH。
// 边界：只拉起一个 echo 后端的桥接器子进程和一个假的 OneBot API；用临时端口，不碰生产实例。
// 失败：任一断言不过 → 退出码 1，并打印哪一项失败。

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';

const BRIDGE_PORT = 6791;
const FAKE_PORT = 3991;
const here = import.meta.dirname;
const base = `http://127.0.0.1:${BRIDGE_PORT}`;

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log('PASS ', name); }
  else { fail++; console.log('FAIL ', name, extra); }
}

// 假 OneBot：只认 send_private_msg / send_group_msg，原样回 ok
const sent = [];
const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  let n = 0;
  req.on('data', (c) => { n += c.length; });
  req.on('end', () => {
    sent.push({ path: url.pathname, bytes: n });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 } }));
  });
});
await new Promise((r) => fake.listen(FAKE_PORT, '127.0.0.1', r));

const child = spawn(process.execPath, [path.join(here, 'bridge.mjs')], {
  env: {
    ...process.env,
    BRIDGE_LISTEN: `127.0.0.1:${BRIDGE_PORT}`,
    NAPCAT_API: `http://127.0.0.1:${FAKE_PORT}`,
    BRIDGE_BACKEND: 'echo',
    BRIDGE_STATE_FILE: '',
    NODE_OPTIONS: '',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childLog = '';
child.stdout.on('data', (d) => { childLog += d; });
child.stderr.on('data', (d) => { childLog += d; });

/** 等到桥接器能回 /healthz，最多 8 秒。 */
async function waitUp() {
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(base + '/healthz'); if (r.ok) return true; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

/** 轮询状态直到条件成立，最多 6 秒。 */
async function until(cond) {
  for (let i = 0; i < 60; i++) {
    const s = await (await fetch(base + '/panel/state.json')).json();
    if (cond(s)) return s;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

try {
  const up = await waitUp();
  check('桥接器起来了', up);
  if (!up) throw new Error('未起来：' + childLog.slice(-300));

  const empty = await (await fetch(base + '/panel/state.json')).json();
  check('初始计数为 0', empty.counts.incoming === 0 && empty.counts.ok === 0);
  check('初始会话表为空', Array.isArray(empty.sessions) && empty.sessions.length === 0);
  check('配置里不出现真实 token', empty.config.NAPCAT_TOKEN === '(未设置)');

  const html = await (await fetch(base + '/panel/', { headers: { accept: 'text/html' } })).text();
  check('面板页可打开', html.includes('id="cards"') && html.includes('桥接器'));
  check('面板用相对路径取状态', html.includes('panel/state.json'));
  check('面板不内联聊天内容', !html.includes('__secret_text__'));

  // 私聊一条
  const post = await fetch(base + '/', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      post_type: 'message', message_type: 'private', self_id: 1, user_id: 20001,
      message_id: 10, message: [{ type: 'text', data: { text: '你好' } }],
    }),
  });
  check('事件推送秒回 204', post.status === 204);

  const after = await until((s) => s.counts.ok === 1);
  check('成功计数 +1', !!after);
  if (after) {
    check('会话表出现该聊天', after.sessions.some((x) => x.key === 'private:20001'));
    check('事件流记了一条成功', after.events[0]?.status === 'ok');
    check('事件里没有聊天正文', !JSON.stringify(after.events).includes('你好'));
    check('排队数归零', after.counts.busy === 0);
  }
  check('回发打到了假 OneBot', sent.some((x) => x.path === '/send_private_msg'));

  // 空消息应被跳过，不触发回发
  const before = sent.length;
  await fetch(base + '/', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ post_type: 'message', message_type: 'private', self_id: 1, user_id: 20002, message: [] }),
  });
  await new Promise((r) => setTimeout(r, 300));
  const skipped = await (await fetch(base + '/panel/state.json')).json();
  check('空消息计入跳过', skipped.counts.skipped === 1);
  check('空消息不回发', sent.length === before);
} catch (e) {
  fail++;
  console.log('FAIL  异常：' + e.message);
} finally {
  child.kill('SIGKILL');
  fake.close();
}

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail === 0 ? 0 : 1);
