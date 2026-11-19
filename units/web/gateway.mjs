/**
 * 目的：把三个下游（DSH 3080 / 桥接面板 6700 / NapCat WebUI 6099）收在一个入口后面，
 *       带统一鉴权，避免逐个开端口；并给前端写死绝对路径的下游各开一个根路径端口。
 * 边界：只做 HTTP 转发与鉴权；不解析业务；不缓存正文；不代签 DSH 的启动授权。
 * 依赖：node 内置 http/https；下游均为本机 HTTP；证书与 token 由 bin/run-web.sh 准备。
 * 失败：下游不可达返回 502 + 可读原因；token 为空且未显式允许时拒绝启动（失败关闭）。
 * 安全：默认只监听 127.0.0.1；设 WEB_BIND=0.0.0.0 才对外，且必须有 WEB_TOKEN。
 *       网关 cookie 为 HttpOnly，不写进 URL/HTML；转发给下游前会去掉这枚 cookie。
 *       NapCat 面板由网关代登录：Credential 只写进引导页正文，不落在地址栏和浏览器历史里。
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { URL } from 'node:url';

const BIND = process.env.WEB_BIND || '127.0.0.1';
const PORT = Number(process.env.WEB_PORT || 8088);
const TOKEN = String(process.env.WEB_TOKEN || '').trim();
const ALLOW_NO_TOKEN = process.env.WEB_ALLOW_NO_TOKEN === '1';
const COOKIE = 'tinda';

// token 是控制台唯一的门；为空时默认拒绝启动，避免 0.0.0.0 + 无鉴权把 DSH/NapCat 暴露到局域网。
if (!TOKEN && !ALLOW_NO_TOKEN) {
  console.error('[web] 拒绝启动：WEB_TOKEN 为空。先跑 bin/run-web.sh 生成 secrets/web.token；');
  console.error('[web] 仅本机调试可显式设 WEB_ALLOW_NO_TOKEN=1（不要用于对外监听）。');
  process.exit(78);
}

// NapCat WebUI 自己的 token（与网关 token 无关）。没有就留空，面板会要求手输。
const NAPCAT_TOKEN = process.env.NAPCAT_WEBUI_TOKEN || '';
const UPSTREAMS = {
  '/dsh/': { host: '127.0.0.1', port: Number(process.env.DSH_PORT || 3080), health: '/' },
  '/bridge/': { host: '127.0.0.1', port: Number(process.env.BRIDGE_PANEL_PORT || 6700), health: '/healthz' },
  '/napcat/': { host: '127.0.0.1', port: Number(process.env.NAPCAT_WEBUI_PORT || 6099), health: '/' },
};

// 每个下游再单开一个「根路径」端口：DSH 和 NapCat 的前端都用绝对路径
// （NapCat: /webui/assets、/api/…；DSH: /assets、/api/…），挤在同一个端口的前缀下面
// 必然互相踩，改了前缀也改不动它们编译好的前端。给各自一个端口，路径原样透传就都通了。
// 桥接面板不用独立端口：它没有绝对路径资源，挂在 /bridge/ 下即可。
const ORIGIN_PORTS = {
  dsh: Number(process.env.WEB_DSH_ORIGIN_PORT || 0),
  napcat: Number(process.env.WEB_NAPCAT_ORIGIN_PORT || 0),
};
const ORIGIN_PREFIX = { dsh: '/dsh/', napcat: '/napcat/' };

const TLS_CERT = process.env.WEB_TLS_CERT || '';
const TLS_KEY = process.env.WEB_TLS_KEY || '';
const useTls = !!(TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY));

/** 目的：给导航页返回下游存活状态；超时也算离线，绝不抛未捕获异常。 */
function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 900 }, (r) => { r.resume(); resolve(r.statusCode < 500); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/** 目的：并发探活三个下游，回一个 { bridge, dsh, napcat } 的布尔表。 */
async function probeAll(res) {
  const out = {};
  await Promise.all(Object.entries(UPSTREAMS).map(async ([k, v]) => {
    const key = k.replace(/\//g, '');
    out[key] = await probe(`http://${v.host}:${v.port}${v.health}`);
  }));
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(out));
}

const DSH_401_HTML = `<!doctype html><meta charset="utf-8"><title>DSH 需要自己的授权链接</title>
<style>body{font:15px/1.7 system-ui;margin:0;padding:2rem 1.2rem;background:#0f1115;color:#e6e6e6}
h2{font-size:17px;margin:0 0 .8rem}p{color:#a7b0bd;margin:.6rem 0}code{background:#1a2029;padding:.1rem .35rem;border-radius:4px;font-size:13px}
.tip{border-left:3px solid #7cc4ff;padding:.5rem .8rem;background:#141b24;border-radius:0 8px 8px 0;margin:1rem 0}</style>
<h2>DSH 面板不让代理代签</h2>
<p>DSH 的网页端有一把<strong>每次启动随机生成、只放在内存里</strong>的授权串，只接受它自己打印出来的那条链接。网关替它签不了，所以这里进不去。</p>
<div class="tip">这不是坏了，是它的设计：谁能连 127.0.0.1:3080 谁就能用，不认代理带过来的身份。</div>
<p>要用 DSH 的网页界面，请用手机上 App 自带的对话界面，或者让 App 重新打印一次带授权串的地址再打开。</p>
<p>其它两个面板不受影响：NapCat 和桥接器都已经能从这里直接看。</p>`;

const LANDING = `<!doctype html><meta charset="utf-8"><title>Tinda</title>
<style>body{font:16px system-ui;margin:2rem;background:#0f1115;color:#ddd}a{color:#7cc4ff;display:block;margin:.6rem 0}</style>
<h2>Tinda 入口</h2>
<a href="/dsh/">DSH 控制台</a>
<a href="/bridge/">桥接器面板</a>
<a href="/napcat/">NapCat WebUI</a>
<a href="/module/">模块信息（版本 / 单元 / 证书 / 日志）</a>`;

/** 目的：常量时间比较 token，避免按字符提前返回带来的时序差异。 */
function tokenEquals(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

/** 目的：从 Cookie 头里取指定名字的值；没有返回空串。 */
function cookieValue(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      const raw = part.slice(i + 1).trim();
      try { return decodeURIComponent(raw); } catch (e) { console.warn('[web] cookie 解码失败', e.message); return raw; }
    }
  }
  return '';
}

/** 目的：去掉网关自己的 cookie，保留下游自己的 cookie（NapCat 登录态）。 */
function withoutGatewayCookie(header) {
  return String(header || '').split(';').map((c) => c.trim()).filter((c) => c && !c.startsWith(COOKIE + '=')).join('; ');
}

/** 目的：给浏览器种 HttpOnly 的网关 cookie；页面脚本读不到 token。 */
function setTokenCookie(res) {
  if (!TOKEN) return;
  const secure = useTls ? '; Secure' : '';
  res.setHeader('set-cookie', `${COOKIE}=${encodeURIComponent(TOKEN)}; Path=/; HttpOnly; SameSite=Lax${secure}`);
}

/** 目的：清掉网关 cookie（退出登录）。 */
function clearTokenCookie(res) {
  const secure = useTls ? '; Secure' : '';
  res.setHeader('set-cookie', `${COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax${secure}`);
}

/** 目的：判断请求是否已通过网关鉴权；query 里的 k 只用于首次进入，cookie 是常态。 */
function authed(req, url) {
  if (ALLOW_NO_TOKEN && !TOKEN) return true;
  const q = url.searchParams.get('k');
  if (q && tokenEquals(q, TOKEN)) return true;
  const c = cookieValue(req.headers.cookie, COOKIE);
  return Boolean(c) && tokenEquals(c, TOKEN);
}

const RESET_HTML = `<!doctype html><meta charset="utf-8"><title>重置面板登录</title>
<style>body{font:15px/1.7 system-ui;margin:0;padding:2rem 1.2rem;background:#0f1115;color:#e6e6e6}
a{color:#7cc4ff}code{background:#1a2029;padding:.1rem .35rem;border-radius:4px}p{color:#a7b0bd}</style>
<h3 style="margin:0 0 .6rem;color:#e6e6e6">正在清掉这个面板的本地登录态…</h3>
<p>会清掉 <code>localStorage</code> / <code>sessionStorage</code> 和网关 cookie，然后回到首页。</p>
<p id="st">正在清理…</p>
<p><a href="/">如果没有自动跳转，点这里</a></p>
<script>
try { localStorage.clear(); sessionStorage.clear(); } catch (e) {}
try { document.cookie = 'tinda=; Path=/; Max-Age=0'; } catch (e) {}
document.getElementById('st').textContent = '已清空，正在跳转…';
setTimeout(function () { location.replace('/'); }, 500);
</script>`;

/** 目的：返回浏览器可读的 401 页面，说明 token 从哪来。 */
function unauthorized(res) {
  const body = '<!doctype html><meta charset="utf-8"><title>需要 token</title>' +
    '<style>body{font:15px/1.7 system-ui;margin:0;padding:2rem 1.2rem;background:#0f1115;color:#e6e6e6}' +
    'p{color:#a7b0bd}code{background:#1a2029;padding:.1rem .35rem;border-radius:4px}</style>' +
    '<h2>需要 token</h2><p>从 <code>https://&lt;局域网IP&gt;:8443/?k=&lt;WEB_TOKEN&gt;</code> 进入，' +
    '或先在本页输入 token。token 在 <code>$DATA/secrets/web.token</code>。</p>';
  res.writeHead(401, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

/** 目的：把导航页 HTML 发出去，并注入两个独立面板的端口号。 */
function serveUi(res) {
  const ui = path.join(import.meta.dirname, 'ui', 'index.html');
  if (fs.existsSync(ui)) {
    const body = fs.readFileSync(ui, 'utf8')
      .replace('__P_DSH__', String(ORIGIN_PORTS.dsh || 0))
      .replace('__P_NAPCAT__', String(ORIGIN_PORTS.napcat || 0));
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
    return res.end(body);
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(LANDING);
}

// ---- 模块信息页（/module/）----
// 目的：把模块与 web 的运行态集中成一页：版本、路径、开机自启、各单元 pid、
//       监听/证书/token/上游/内存/请求数，以及两份日志尾部；数据实时读盘。
const TINDA_DATA = process.env.TINDA_DATA || '/data/adb/tinda-bot';
const TINDA_MODDIR = process.env.TINDA_MODDIR || '/opt/tinda-bot';
const STARTED_AT = Date.now();
let REQ_COUNT = 0;

function readText(file, max) {
  try { return fs.readFileSync(file, 'utf8').slice(0, max || 65536); } catch { return ''; }
}

function moduleProp() {
  const out = {};
  for (const line of readText(path.join(TINDA_MODDIR, 'module.prop'), 8192).split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

function confValue(key, dflt) {
  const text = readText(path.join(TINDA_DATA, 'etc', 'tinda.conf'), 65536);
  if (!text.includes(key + '=')) return dflt;
  for (const line of text.split('\n')) {
    if (line.startsWith(key + '=')) return line.slice(key.length + 1).trim();
  }
  return dflt;
}

function unitState(name) {
  const pid = Number(readText(path.join(TINDA_DATA, 'run', name + '.pid'), 64).trim());
  let alive = false;
  if (Number.isInteger(pid) && pid > 0) {
    try { process.kill(pid, 0); alive = true; } catch (err) { alive = err.code === 'EPERM'; }
  }
  return { pid: pid || null, alive };
}

function certInfo() {
  if (!useTls) return null;
  try {
    const c = new crypto.X509Certificate(fs.readFileSync(TLS_CERT));
    return { san: String(c.subjectAltName || '').split(',').join(', '), validTo: c.validTo };
  } catch (err) {
    return { error: err.message };
  }
}

function tailLog(name, lines) {
  const text = readText(path.join(TINDA_DATA, 'logs', name), 262144);
  if (!text) return [];
  return text.trimEnd().split('\n').slice(-(lines || 12));
}

async function moduleData() {
  const prop = moduleProp();
  const tok = readText(path.join(TINDA_DATA, 'secrets', 'web.token'), 128).trim();
  const ups = await Promise.all(Object.entries(UPSTREAMS).map(async (pair) => {
    const p = pair[0], v = pair[1];
    return { path: p, port: v.port, up: await probe('http://' + v.host + ':' + v.port + v.health) };
  }));
  const confFile = path.join(TINDA_DATA, 'etc', 'tinda.conf');
  return {
    module: {
      id: prop.id || 'tinda-bot', name: prop.name || 'Tinda Bot',
      version: prop.version || '?', code: prop.versionCode || '?',
      desc: prop.description || '', dir: TINDA_MODDIR, data: TINDA_DATA, conf: confFile,
      autoStart: readText(confFile, 65536).includes('AUTO_START=') ? (confValue('AUTO_START', '') || '（空 = 不自启）') : 'web（缺省）'
    },
    web: {
      bind: BIND, port: PORT, tls: useTls, cert: certInfo(),
      tokenMask: tok ? tok.slice(0, 4) + '…' + tok.slice(-4) : '（还没有）',
      tokenFile: path.join(TINDA_DATA, 'secrets', 'web.token'),
      uptime: Math.round((Date.now() - STARTED_AT) / 1000),
      node: process.version, rssMB: Math.round(process.memoryUsage().rss / 1048576),
      requests: REQ_COUNT, upstreams: ups,
      originDsh: ORIGIN_PORTS.dsh, originNapcat: ORIGIN_PORTS.napcat,
      redirect: Number(process.env.WEB_REDIRECT_PORT || 0),
      plain: Number(process.env.WEB_HTTP_PORT || 0)
    },
    units: { web: unitState('web'), bridge: unitState('bridge'), napcat: unitState('napcat') },
    logs: { web: tailLog('web.log'), supervisor: tailLog('supervisor.log') }
  };
}

function serveModulePage(res) {
  const body = readText(path.join(import.meta.dirname, 'ui', 'module.html'), 262144);
  res.writeHead(body ? 200 : 500, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' });
  res.end(body || 'module.html 缺失');
}

async function serveModuleData(res) {
  const data = await moduleData();
  res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

// ---- NapCat 面板免登录 ----
// NapCat 的 WebUI 登录流程（读它的前端 bundle 得到，不是猜的）：
//   hash = SHA256(token + '.napcat')  →  POST /api/auth/login {hash}  →  {code:0,data:{Credential}}
//   前端把 Credential 以 JSON 字符串写进 localStorage['token']，之后每个请求带 Authorization: Bearer <Credential>。
// Credential 只认 1 小时；过期后前端会清掉 localStorage 并刷新 —— 正好由下面的引导页重新发一份。
// 缓存 45 分钟：一次登录够用，避免每开一次面板都要打一次 /api/auth/login。
const NAPCAT_CRED_TTL_MS = 45 * 60 * 1000;
const NAPCAT_DOC_PATHS = new Set(['/', '/webui', '/webui/']);
let napcatCred = { value: '', at: 0 };

/** 目的：判断这个路径是不是 NapCat 的页面入口（只有页面才需要引导登录，静态资源不碰）。 */
function isNapcatDocument(subPath) {
  return NAPCAT_DOC_PATHS.has(subPath);
}

/** 目的：去掉只给网关看的 __login 标记，别让下游 SPA 的地址栏里多一个陌生参数。 */
function stripLoginMarker(search) {
  const p = new URLSearchParams(String(search).replace(/^\?/, ''));
  p.delete('__login');
  const s = p.toString();
  return s ? '?' + s : '';
}

/**
 * 目的：用网关手里的 token 向 NapCat 换一张 Credential。
 * 输入：无（token 来自 NAPCAT_WEBUI_TOKEN，端口来自 UPSTREAMS）。
 * 输出：成功返回 Credential 字符串；没配 token、连不上、返回错误码都返回空串。
 * 失败：不抛错、不重试；返回空串，调用方降级成「显示它自己的登录页」。
 * 副作用：一次本机 POST。
 */
function loginNapcat() {
  return new Promise((resolve) => {
    const up = UPSTREAMS['/napcat/'];
    const body = JSON.stringify({
      hash: crypto.createHash('sha256').update(NAPCAT_TOKEN + '.napcat').digest('hex'),
    });
    const req = http.request({
      host: up.host,
      port: up.port,
      path: '/api/auth/login',
      method: 'POST',
      timeout: 5000,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const cred = data && data.code === 0 && data.data && data.data.Credential;
          resolve(cred ? String(cred) : '');
        } catch (e) {
          console.error('[web] NapCat 登录响应不是 JSON：' + e.message);
          resolve('');
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.on('error', (e) => { console.error('[web] NapCat 登录失败：' + (e.code || e.message)); resolve(''); });
    req.end(body);
  });
}

/** 目的：拿到当前有效的 Credential（优先用缓存）。 */
async function napcatCredential() {
  if (napcatCred.value && Date.now() - napcatCred.at < NAPCAT_CRED_TTL_MS) return napcatCred.value;
  const value = await loginNapcat();
  napcatCred = { value, at: value ? Date.now() : 0 };
  return value;
}

/** 目的：拼一张「写 localStorage 然后跳回面板」的引导页；Credential 只进页面正文，不进地址栏。 */
function napcatBootstrapHtml(cred, target) {
  const stored = JSON.stringify(JSON.stringify(cred)).replace(/</g, '\\u003c');
  const url = JSON.stringify(target).replace(/</g, '\\u003c');
  const href = target.replace(/&/g, '&amp;');
  return '<!doctype html><meta charset="utf-8"><title>正在进入 NapCat</title>' +
    '<style>body{font:15px/1.7 system-ui;margin:0;padding:2rem 1.2rem;background:#0f1115;color:#e6e6e6}' +
    'a{color:#6cf}p{color:#a7b0bd}</style>' +
    '<h2>正在进入 NapCat</h2><p>网关已经替你登录，不需要输入 token。</p>' +
    '<script>try{localStorage.setItem("token", ' + stored + ');}catch(e){}' +
    'location.replace(' + url + ');<\/script>' +
    '<p>没反应？<a href="' + href + '">点这里</a>。</p>';
}

/**
 * 目的：给 NapCat 页面入口返回引导页，替浏览器把登录做完。
 * 输入：subPath 页面路径、search 查询串（可能带 __login 标记）。
 * 输出：true 表示已经自己回了响应；false 表示这次不该接管，交回反代。
 * 失败：换不到 Credential 就返回 false，退回 NapCat 自带登录页（不阻塞、不报错页）。
 * 副作用：可能写一次响应；可能触发一次登录请求（有缓存）。
 */
async function napcatBootstrap(res, subPath, search) {
  // 带标记说明已经在引导页转过一圈，别再套娃。
  if (new URLSearchParams(String(search).replace(/^\?/, '')).get('__login') === '1') return false;
  const cred = await napcatCredential();
  if (!cred) return false;
  const rest = stripLoginMarker(search);
  const target = subPath + (rest ? rest + '&__login=1' : '?__login=1');
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(napcatBootstrapHtml(cred, target));
  return true;
}

/**
 * 目的：把一次请求转发给某个下游，并处理重定向前缀、NapCat token 自动补齐、错误兜底。
 * 输入：prefix 是下游键（如 '/napcat/'），subPath 是发给下游的路径，search 是查询串。
 * 输出：无；直接把下游响应写回 res。
 * 失败：下游错误返回 502；不重试。
 * 副作用：发网络请求；不改正文。
 */
async function forward(prefix, subPath, search, req, res, mappedRoot = false) {
  // NapCat 面板的凭据只存在浏览器 localStorage 里，网关读不到。
  // 把 token 塞进「转发给下游」的查询串是没用的：SPA 读的是浏览器地址栏。
  // 改成网关用它自己替浏览器登录一次，把拿到的 Credential 写进一个小页面，再跳回面板。
  // 好处：地址栏里不出现任何 token，凭据 1 小时过期后刷新一次就自愈。
  if (prefix === '/napcat/' && NAPCAT_TOKEN && req.method === 'GET' && isNapcatDocument(subPath)) {
    if (await napcatBootstrap(res, subPath, search)) return;
  }
  return proxyForward(prefix, subPath, search, req, res, mappedRoot);
}

function proxyForward(prefix, subPath, search, req, res, mappedRoot = false) {
  const up = UPSTREAMS[prefix];
  // NapCat 的 WebUI 自带一套 token，和网关的 token 是两回事。
  // 这里自动补上，免得用户打开面板还要手输一次。
  // 只给「页面」请求补：/api/* 是它的接口，多带一个 token 参数会被判成非法登录请求
  // （实测 /api/auth/login?token=… 直接返回 Unauthorized）。
  const isApi = /^\/api(\/|$)/.test(subPath);
  let qs = search;
  // 只给网关自己看的标记，不能透给下游的 SPA。
  if (prefix === '/napcat/' && qs.includes('__login=')) qs = stripLoginMarker(qs);
  if (prefix === '/napcat/' && NAPCAT_TOKEN && !isApi && !/[?&]token=/.test(qs)) {
    qs += (qs ? '&' : '?') + 'token=' + encodeURIComponent(NAPCAT_TOKEN);
  }
  const headers = { ...req.headers, host: `${up.host}:${up.port}` };
  const cookies = withoutGatewayCookie(headers.cookie);
  if (cookies) headers.cookie = cookies; else delete headers.cookie;
  headers['x-forwarded-proto'] = useTls ? 'https' : 'http';
  const target = { host: up.host, port: up.port, path: subPath + qs, method: req.method, headers };

  const proxy = http.request(target, (upRes) => {
    // DSH 的 401 是纯文本，放进 iframe 就是一片空白。换成一页能看懂的说明。
    const wantsHtml = String(req.headers.accept || '').includes('text/html');
    if (prefix === '/dsh/' && upRes.statusCode === 401 && wantsHtml) {
      upRes.resume();
      res.writeHead(401, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(DSH_401_HTML),
      });
      return res.end(DSH_401_HTML);
    }
    // 下游可能用绝对路径重定向（例如 NapCat 的 / → /webui），要补回本网关的前缀，
    // 否则浏览器会跑到网关根下去，落到 404。根路径端口不需要补。
    const responseHeaders = { ...upRes.headers };
    const loc = responseHeaders.location;
    if (!mappedRoot && typeof loc === 'string' && loc.startsWith('/') && !loc.startsWith(prefix)) {
      responseHeaders.location = prefix.replace(/\/$/, '') + loc;
    }
    res.writeHead(upRes.statusCode || 502, responseHeaders);
    upRes.pipe(res);
  });
  proxy.on('error', (e) => {
    if (res.headersSent) return res.end();
    const reason = String(e.code || e.message || 'unknown');
    if (String(req.headers.accept || '').includes('text/html')) {
      const body = '<!doctype html><meta charset="utf-8"><title>下游未就绪</title>' +
        '<style>body{font:15px/1.7 system-ui;margin:0;padding:2rem;background:#0f1115;color:#e6e6e6}' +
        'p{color:#a7b0bd}code{background:#1a2029;padding:.1rem .35rem;border-radius:4px}</style>' +
        `<h2>下游未就绪</h2><p><code>${prefix}</code> → ${up.host}:${up.port}</p><p>${reason}</p>` +
        '<p>看单元状态：<code>bin/unit.sh status bridge</code>；看日志：<code>bin/unit.sh logs bridge 20</code>。</p>';
      res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(body);
    }
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`下游未就绪：${prefix} → ${up.host}:${up.port}\n${reason}`);
  });
  req.on('aborted', () => proxy.destroy());
  req.pipe(proxy);
}

/** 目的：给某个下游开一个「根路径即下游根」的端口，供其前端用绝对路径正常取资源。 */
function originHandler(prefix) {
  return function handle(req, res) {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    if (TOKEN && url.searchParams.get('k') === TOKEN) setTokenCookie(res);
    if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (url.pathname === '/logout') { clearTokenCookie(res); res.writeHead(302, { location: '/' }); return res.end(); }
    // 重置面板登录：NapCat 的凭据只存在浏览器里，换过 token 或凭据过期就只能清掉重来。
    // 给一个能点的入口，别让用户去翻 devtools。它不返回任何数据，所以不鉴权。
    if (url.pathname === '/reset' || url.pathname === '/__reset') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(RESET_HTML);
    }
    if (!authed(req, url)) return unauthorized(res);
    return forward(prefix, url.pathname, url.search, req, res, true);
  };
}

const servers = [];

/** 目的：按协议创建 server 并统一挂错误处理；端口冲突时打印清楚原因。 */
function listen(server, port, name, fatal) {
  servers.push(server);
  server.on('error', (e) => {
    console.error(`[web] ${name} 启动失败 :${port} ${e.code || e.message}`);
    if (fatal) process.exit(1);
  });
  server.listen(port, BIND, () => console.log(`[web] ${name} → ${useTls ? 'https' : 'http'}://${BIND}:${port}/`));
}

function createServer(handler) {
  return useTls
    ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, handler)
    : http.createServer(handler);
}

// 进程级异常必须落日志：真机上出现过「听过端口、然后既不响应也不退出」，
// 没有堆栈就只能看到一片沉默。
process.on('uncaughtException', (e) => {
  console.error('[web] 未捕获异常：' + ((e && e.stack) || e));
});
process.on('unhandledRejection', (e) => {
  console.error('[web] 未处理的 Promise 拒绝：' + ((e && e.stack) || e));
});
process.on('exit', (code) => {
  console.error('[web] 进程退出 code=' + code + ' pid=' + process.pid);
});

// 心跳：事件循环活着就每 30 秒写一次。业务卡死（进程在、但不处理请求）时心跳会停，
// unit.sh 的心跳看门狗据此重启整棵树——比「进程还在就算好」可靠。
const HEARTBEAT = process.env.TINDA_DATA ? path.join(process.env.TINDA_DATA, 'logs', 'web.hb') : '';
if (HEARTBEAT) {
  let beatWarned = false;
  const beat = () => {
    try {
      fs.writeFileSync(HEARTBEAT, String(Date.now()));
    } catch (e) {
      if (!beatWarned) {
        beatWarned = true;
        console.error('[web] 心跳写不进去：' + (e.code || e.message));
      }
    }
  };
  beat();
  setInterval(beat, 30000).unref();
}

// 控制台输出双写一份到共享存储：网关的启动/崩溃信息原本只进 $DATA/logs/web.log，
// 那目录只有 root 能读，于是外面看到的永远是「启动网关…」之后再无一行。
const MIRROR_LOG = process.env.TINDA_MIRROR_LOG || '';
if (MIRROR_LOG) {
  let mirrorWarned = false;
  const tee = (fn) => (...args) => {
    fn(...args);
    try {
      fs.appendFileSync(MIRROR_LOG, new Date().toISOString() + ' ' + args.map(String).join(' ') + '\n');
    } catch (e) {
      if (!mirrorWarned) {
        mirrorWarned = true;
        fn('[web] 控制台镜像写不进去：' + (e.code || e.message));
      }
    }
  };
  console.log = tee(console.log.bind(console));
  console.error = tee(console.error.bind(console));
}

const handler = (req, res) => {
  REQ_COUNT += 1;
  const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

  // 用 ?k=<token> 首次进入时种 cookie；之后 iframe/子端口都靠 cookie。
  // token 不再写进页面 HTML 或 iframe 地址，避免出现在历史记录与 Referer 里。
  if (TOKEN && url.searchParams.get('k') === TOKEN) setTokenCookie(res);

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (url.pathname === '/logout') {
    clearTokenCookie(res);
    res.writeHead(302, { location: '/' });
    return res.end();
  }
  // 控制台登录重置：清 cookie + localStorage，回到首页重新输 token。
  if (url.pathname === '/reset' || url.pathname === '/__reset') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(RESET_HTML);
  }
  // 带前缀的面板入口统一补斜杠，避免 iframe 里的相对路径解析到网关根。
  if (url.pathname === '/bridge' || url.pathname === '/dsh' || url.pathname === '/napcat') {
    res.writeHead(308, { location: url.pathname + '/' + url.search });
    return res.end();
  }

  // 导航页本身不鉴权（它不含任何下游数据）；没有 token 时页面会显示输入框。
  if (url.pathname === '/' || url.pathname === '/index.html') return serveUi(res);

  if (!authed(req, url)) return unauthorized(res);

  // 状态接口：导航页的点亮/熄灭靠它
  if (url.pathname === '/_/status') return probeAll(res);

  // 模块信息页：版本、路径、AUTO_START、单元 pid、web 证书/token、日志尾部
  if (url.pathname === '/module') { res.writeHead(308, { location: '/module/' }); return res.end(); }
  if (url.pathname === '/module/') return serveModulePage(res);
  if (url.pathname === '/module/data.json') {
    return serveModuleData(res).catch((err) => {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
    });
  }
  if (url.pathname === '/module/token') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ token: TOKEN }));
  }

  // 反代
  // NapCat 的 WebUI 是 SPA，前端资源用绝对路径 /webui/assets/…（不带 /napcat 前缀）。
  // 在 iframe 里这些请求会落到网关根下，必须单独认领，否则面板一片空白。
  let prefix = Object.keys(UPSTREAMS).find((p) => url.pathname.startsWith(p));
  let upstreamPath = null;
  if (!prefix && (url.pathname === '/webui' || url.pathname.startsWith('/webui/'))) {
    prefix = '/napcat/';
    upstreamPath = url.pathname;
  }
  if (!prefix) { res.writeHead(404); return res.end('not found'); }

  const subPath = upstreamPath ?? (url.pathname.slice(prefix.length - 1) || '/');
  return forward(prefix, subPath, url.search, req, res);
};

listen(createServer(handler), PORT, 'listening', true);

// 各面板的根路径端口：前端用绝对路径，靠这些端口才能正常取资源和调自己的 /api
for (const [key, port] of Object.entries(ORIGIN_PORTS)) {
  if (!port || port === PORT) continue;
  listen(createServer(originHandler(ORIGIN_PREFIX[key])), port, `origin ${key}`, false);
}

// 可选：明文直连端口（调试/证书装不上时用；默认不开）
const PLAIN_PORT = Number(process.env.WEB_HTTP_PORT || 0);
if (PLAIN_PORT && PLAIN_PORT !== PORT) {
  listen(http.createServer(handler), PLAIN_PORT, 'plain http', false);
}

// 可选：明文端口只做 301 跳转（不承载任何内容）
const REDIRECT_PORT = Number(process.env.WEB_REDIRECT_PORT || 0);
if (useTls && REDIRECT_PORT) {
  listen(http.createServer((req, res) => {
    const host = (req.headers.host || '').replace(/[^A-Za-z0-9.:\[\]-]/g, '') || BIND;
    // Host 头带端口（192.168.1.3:8088），直接拼会变成 https://192.168.1.3:8088:8443/ ——
    // 浏览器打不开，看起来就像「跳转后卡住」。这里只取主机部分。
    const m = /^(\[[0-9a-fA-F:]+\]|[^:]+)(?::\d+)?$/.exec(host);
    const hostOnly = m ? m[1] : host;
    res.writeHead(301, { location: `https://${hostOnly}:${PORT}${req.url}` });
    res.end();
  }), REDIRECT_PORT, 'redirect', false);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log('[web] 收到', sig, '，退出');
    for (const s of servers) s.close();
    setTimeout(() => process.exit(0), 3000);
  });
}
