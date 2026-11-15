// 目的：验证网关的鉴权、cookie、反代前缀、DSH 401 说明页、独立端口与失败关闭。
// 边界：只起一个真的 gateway.mjs 和三个假下游；不碰生产的 8443/8444/8445。
// 依赖：node 内置 http/fetch；不需要证书（测试走 HTTP）。
// 失败：任一断言不成立 → 退出码 1。
// 副作用：占用本机 16811–16815 端口；结束后全部关闭。

import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';

const here = import.meta.dirname;
const GW_PORT = 16811;
const ORIGIN_PORT = 16812;
const BRIDGE_PORT = 16813;
const DSH_PORT = 16814;
const NAPCAT_PORT = 16815;
const TOKEN = 'test-token-123456';
const base = 'http://127.0.0.1:' + GW_PORT;

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log('PASS ', name); }
  else { fail++; console.log('FAIL ', name, extra); }
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function waitFor(fn, ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) { try { const v = await fn(); if (v) return v; } catch {} await wait(80); }
  return null;
}

const seen = [];
function fake(name, handler) {
  return http.createServer((req, res) => {
    seen.push({ name, url: req.url, cookie: req.headers.cookie || '' });
    handler(req, res);
  });
}
const bridge = fake('bridge', (req, res) => {
  if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  if (req.url.startsWith('/panel/state.json')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true,"backend":"echo"}'); }
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>bridge-panel</html>');
});
const dsh = fake('dsh', (req, res) => {
  res.writeHead(401, { 'content-type': 'text/plain' }); res.end('dsh-unauthorized');
});
const napcat = fake('napcat', (req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>napcat</html>');
});
await Promise.all([
  new Promise((r) => bridge.listen(BRIDGE_PORT, '127.0.0.1', r)),
  new Promise((r) => dsh.listen(DSH_PORT, '127.0.0.1', r)),
  new Promise((r) => napcat.listen(NAPCAT_PORT, '127.0.0.1', r)),
]);

const env = {
  ...process.env,
  WEB_BIND: '127.0.0.1',
  WEB_PORT: String(GW_PORT),
  WEB_TOKEN: TOKEN,
  BRIDGE_PANEL_PORT: String(BRIDGE_PORT),
  DSH_PORT: String(DSH_PORT),
  NAPCAT_WEBUI_PORT: String(NAPCAT_PORT),
  WEB_DSH_ORIGIN_PORT: String(ORIGIN_PORT),
  WEB_NAPCAT_ORIGIN_PORT: '0',
  WEB_REDIRECT_PORT: '0',
  WEB_HTTP_PORT: '0',
  NAPCAT_WEBUI_TOKEN: '',
  NODE_OPTIONS: '',
};
delete env.WEB_TLS_CERT; delete env.WEB_TLS_KEY; delete env.WEB_ALLOW_NO_TOKEN;

const gw = spawn(process.execPath, [path.join(here, 'gateway.mjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let gwLog = '';
gw.stdout.on('data', (d) => { gwLog += d; });
gw.stderr.on('data', (d) => { gwLog += d; });

try {
  const up = await waitFor(async () => (await fetch(base + '/healthz')).ok);
  check('网关启动', Boolean(up), gwLog.slice(-300));
  if (!up) throw new Error('网关未起来');

  const landing = await fetch(base + '/');
  const landingHtml = await landing.text();
  check('/ 不需要 token', landing.status === 200 && landingHtml.includes('Tinda 控制台'));
  check('/ 不含 token', !landingHtml.includes(TOKEN));

  const noAuth = await fetch(base + '/bridge/');
  check('面板未授权返回 401', noAuth.status === 401);

  const status = await fetch(base + '/_/status?k=' + TOKEN);
  const statusText = await status.text();
  const setCookie = status.headers.get('set-cookie') || '';
  check('/_/status 用 ?k 可访问', status.status === 200 && statusText.includes('"bridge":true'), statusText);
  check('cookie 是 HttpOnly', /HttpOnly/i.test(setCookie), setCookie);
  check('cookie 带 SameSite', /SameSite=Lax/i.test(setCookie), setCookie);

  const bridgePage = await fetch(base + '/bridge/', { headers: { cookie: 'tinda=' + TOKEN, accept: 'text/html' } });
  const bridgeHtml = await bridgePage.text();
  check('/bridge/ 反代到 HTML', bridgePage.status === 200 && bridgeHtml.includes('bridge-panel'), bridgeHtml.slice(0, 120));
  const lastBridge = seen.filter((s) => s.name === 'bridge').pop();
  check('转发时去掉网关 cookie', lastBridge && !/tinda=/.test(lastBridge.cookie), lastBridge && lastBridge.cookie);

  const state = await fetch(base + '/bridge/panel/state.json', { headers: { cookie: 'tinda=' + TOKEN } });
  check('/bridge/panel/state.json 可用', state.status === 200 && (await state.text()).includes('"backend":"echo"'));

  const redirect = await fetch(base + '/bridge', { redirect: 'manual', headers: { cookie: 'tinda=' + TOKEN } });
  check('/bridge 补斜杠', redirect.status === 308 && redirect.headers.get('location') === '/bridge/', redirect.status + ' ' + redirect.headers.get('location'));

  const dshHtml = await fetch(base + '/dsh/', { headers: { cookie: 'tinda=' + TOKEN, accept: 'text/html' } });
  const dshBody = await dshHtml.text();
  check('DSH 401 换成说明页', dshHtml.status === 401 && dshBody.includes('DSH 面板不让代理代签'), dshBody.slice(0, 120));

  const dshApi = await fetch(base + '/dsh/api/x', { headers: { cookie: 'tinda=' + TOKEN, accept: 'application/json' } });
  check('非 HTML 的 401 原样透传', dshApi.status === 401 && (await dshApi.text()) === 'dsh-unauthorized');

  const origin = await fetch('http://127.0.0.1:' + ORIGIN_PORT + '/', { headers: { cookie: 'tinda=' + TOKEN, accept: 'text/html' } });
  check('独立根端口可用', origin.status === 401 && (await origin.text()).includes('DSH 面板不让代理代签'));

  const logout = await fetch(base + '/logout', { redirect: 'manual' });
  check('/logout 清 cookie', logout.status === 302 && /Max-Age=0/i.test(logout.headers.get('set-cookie') || ''));

  // 失败关闭：没有 token 且未显式允许时，必须拒绝启动。
  const noToken = spawn(process.execPath, [path.join(here, 'gateway.mjs')], {
    env: { ...env, WEB_PORT: String(GW_PORT + 10), WEB_TOKEN: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let noTokenLog = '';
  noToken.stdout.on('data', (d) => { noTokenLog += d; });
  noToken.stderr.on('data', (d) => { noTokenLog += d; });
  const code = await new Promise((resolve) => noToken.on('close', resolve));
  check('空 token 拒绝启动', code === 78, 'code=' + code + ' ' + noTokenLog.slice(-200));
} catch (e) {
  fail++;
  console.log('FAIL  异常：' + e.message);
} finally {
  gw.kill('SIGKILL');
  bridge.close(); dsh.close(); napcat.close();
}

console.log('\n' + pass + '/' + (pass + fail) + ' 通过');
process.exit(fail === 0 ? 0 : 1);
