/**
 * 目的：把三个下游（DSH 3080 / 桥接面板 6700 / NapCat WebUI 6099）收在一个入口后面，
 *       带统一鉴权，避免逐个开端口；并给前端写死绝对路径的下游各开一个根路径端口。
 * 边界：只做 HTTP 转发与鉴权；不解析业务；不缓存正文；不代签 DSH 的启动授权。
 * 依赖：node 内置 http/https；下游均为本机 HTTP；证书与 token 由 bin/run-web.sh 准备。
 * 失败：下游不可达返回 502 + 可读原因；token 为空且未显式允许时拒绝启动（失败关闭）。
 * 安全：默认只监听 127.0.0.1；设 WEB_BIND=0.0.0.0 才对外，且必须有 WEB_TOKEN。
 *       网关 cookie 为 HttpOnly，不写进 URL/HTML；转发给下游前会去掉这枚 cookie。
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
<a href="/napcat/">NapCat WebUI</a>`;

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

/**
 * 目的：把一次请求转发给某个下游，并处理重定向前缀、NapCat token 自动补齐、错误兜底。
 * 输入：prefix 是下游键（如 '/napcat/'），subPath 是发给下游的路径，search 是查询串。
 * 输出：无；直接把下游响应写回 res。
 * 失败：下游错误返回 502；不重试。
 * 副作用：发网络请求；不改正文。
 */
function forward(prefix, subPath, search, req, res, mappedRoot = false) {
  const up = UPSTREAMS[prefix];
  // NapCat 的 WebUI 自带一套 token，和网关的 token 是两回事。
  // 这里自动补上，免得用户打开面板还要手输一次。
  // 只给「页面」请求补：/api/* 是它的接口，多带一个 token 参数会被判成非法登录请求
  // （实测 /api/auth/login?token=… 直接返回 Unauthorized）。
  const isApi = /^\/api(\/|$)/.test(subPath);
  let qs = search;
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

const handler = (req, res) => {
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
    res.writeHead(301, { location: `https://${host}:${PORT}${req.url}` });
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
