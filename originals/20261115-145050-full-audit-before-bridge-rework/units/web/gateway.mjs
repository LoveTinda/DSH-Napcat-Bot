/**
 * 目的：把三个下游（DSH 3080 / 桥接面板 6702 / NapCat WebUI 6099）收在一个入口后面，
 *       带统一鉴权，避免逐个开端口。
 * 边界：只做 HTTP 转发与鉴权；不解析业务；不缓存正文。
 * 安全：默认只监听 127.0.0.1；设 WEB_BIND=0.0.0.0 才对外，且必须给 WEB_TOKEN。
 * 失败：下游不可达返回 502 + 可读原因，不抛未捕获异常。
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { URL } from 'node:url';

const BIND = process.env.WEB_BIND || '127.0.0.1';
const PORT = Number(process.env.WEB_PORT || 8088);
const TOKEN = process.env.WEB_TOKEN || '';
// NapCat WebUI 自己的 token（与网关 token 无关）。没有就留空，面板会要求手输。
const NAPCAT_TOKEN = process.env.NAPCAT_WEBUI_TOKEN || '';
const UPSTREAMS = {
  '/dsh/': { host: '127.0.0.1', port: Number(process.env.DSH_PORT || 3080) },
  '/bridge/': { host: '127.0.0.1', port: Number(process.env.BRIDGE_PANEL_PORT || 6702) },
  '/napcat/': { host: '127.0.0.1', port: Number(process.env.NAPCAT_WEBUI_PORT || 6099) },
};

// 每个下游再单开一个「根路径」端口：DSH 和 NapCat 的前端都用绝对路径
// （NapCat: /webui/assets、/api/…；DSH: /assets、/api/…），挤在同一个端口的前缀下面
// 必然互相踩，改了前缀也改不动它们编译好的前端。给各自一个端口，路径原样透传就都通了。
const ORIGIN_PORTS = {
  dsh: Number(process.env.WEB_DSH_ORIGIN_PORT || 0),
  napcat: Number(process.env.WEB_NAPCAT_ORIGIN_PORT || 0),
  bridge: Number(process.env.WEB_BRIDGE_ORIGIN_PORT || 0),
};
const ORIGIN_PREFIX = { dsh: '/dsh/', napcat: '/napcat/', bridge: '/bridge/' };

/** 目的：给导航页返回三个下游的存活状态；超时也算离线，绝不抛未捕获异常。 */
function probe(url) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: 900 }, (r) => { r.resume(); resolve(r.statusCode < 500); });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function probeAll(res) {
  const out = {};
  await Promise.all(Object.entries(UPSTREAMS).map(async ([k, v]) => {
    const key = k.replace(/\//g, '');
    out[key] = await probe(`http://${v.host}:${v.port}/`);
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
<p id=st style="opacity:.6"></p>
<script>for(const p of ['/dsh/','/bridge/','/napcat/'])fetch(p+'healthz',{method:'HEAD'}).then(r=>{}).catch(()=>{});</script>`;

function authed(req, url) {
  if (!TOKEN) return true;
  if (url.searchParams.get('k') === TOKEN) return true;
  const cookie = req.headers.cookie || '';
  return cookie.split(';').some((c) => c.trim() === `tinda=${TOKEN}`);
}

const TLS_CERT = process.env.WEB_TLS_CERT || '';
const TLS_KEY = process.env.WEB_TLS_KEY || '';
const useTls = !!(TLS_CERT && TLS_KEY && fs.existsSync(TLS_CERT) && fs.existsSync(TLS_KEY));

function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  // 用 ?k=<token> 进来时立刻种一个 cookie：
  // 导航页里的 iframe 是独立请求，不带查询串，没有这条会全部 401，
  // 表现就是「控制台里点哪个标签都打不开」。
  if (TOKEN && url.searchParams.get('k') === TOKEN) {
    const secure = useTls ? '; Secure' : '';
    res.setHeader('set-cookie', `tinda=${TOKEN}; Path=/; SameSite=Lax${secure}`);
  }

  // 1) 健康检查：不鉴权，只回 ok
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }

  // 2) 导航页本身不鉴权（它内含 token 引导）；不鉴权意味着不能泄露任何下游数据
  if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/ui/')) {
    const ui = path.join(import.meta.dirname, 'ui', 'index.html');
    if (fs.existsSync(ui)) {
      // 把各面板独立端口的端口号注进页面，导航页据此拼 iframe 地址
      const body = fs.readFileSync(ui, 'utf8')
        .replace('__P_DSH__', String(ORIGIN_PORTS.dsh))
        .replace('__P_NAPCAT__', String(ORIGIN_PORTS.napcat));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(body);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(LANDING);
  }

  // 3) 其余一律要 token
  if (!authed(req, url)) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('需要 token：首次打开在页面里输入，或地址后加 ?k=<WEB_TOKEN>');
  }

  // 4) 状态接口：导航页的点亮/熄灭靠它
  if (url.pathname === '/_/status') {
    return probeAll(res);
  }

  // 5) 反代
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
}

/**
 * 目的：把一次请求转发给某个下游，并处理重定向前缀、NapCat token 自动补齐、错误兜底。
 * 入参：prefix 是下游键（如 '/napcat/'），subPath 是发给下游的路径，search 是查询串。
 * 边界：只搬运字节，不改正文；不重试。
 */
function forward(prefix, subPath, search, req, res, mappedRoot = false) {
  const up = UPSTREAMS[prefix];
  // NapCat 的 WebUI 自带一套 token，和网关的 token 是两回事。
  // 这里自动补上，免得用户打开面板还要手输一次。
  // 只给「页面」请求补：/api/* 是它的接口，多带一个 token 参数会被判成非法登录请求
  // （实测 /api/auth/login?token=… 直接返回 Unauthorized）。
  const isApi = /^\/api(\/|$)/.test(subPath);
  if (prefix === '/napcat/' && NAPCAT_TOKEN && !isApi && !/[?&]token=/.test(search)) {
    search += (search ? '&' : '?') + 'token=' + encodeURIComponent(NAPCAT_TOKEN);
  }
  const target = { host: up.host, port: up.port, path: subPath + search, method: req.method, headers: { ...req.headers, host: `${up.host}:${up.port}` } };

  const proxy = http.request(target, (upRes) => {
    // DSH 的 401 是纯文本，放进 iframe 就是一片空白。换成一页能看懂的说明。
    if (prefix === '/dsh/' && upRes.statusCode === 401) {
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
    const headers = { ...upRes.headers };
    const loc = headers.location;
    if (!mappedRoot && typeof loc === 'string' && loc.startsWith('/') && !loc.startsWith(prefix)) {
      headers.location = prefix.replace(/\/$/, '') + loc;
    }
    res.writeHead(upRes.statusCode || 502, headers);
    upRes.pipe(res);
  });
  proxy.on('error', (e) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`下游未就绪：${prefix} → ${up.host}:${up.port}\n${e.code || e.message}`);
  });
  req.pipe(proxy);
}

/** 目的：给某个下游开一个「根路径即下游根」的端口，供其前端用绝对路径正常取资源。 */
function originHandler(prefix) {
  return function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (TOKEN && url.searchParams.get('k') === TOKEN) {
      const secure = useTls ? '; Secure' : '';
      res.setHeader('set-cookie', `tinda=${TOKEN}; Path=/; SameSite=Lax${secure}`);
    }
    if (url.pathname === '/healthz') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('ok'); }
    if (!authed(req, url)) {
      res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end('需要 token：请从 8443 控制台进入（cookie 会带过来），或本地址后加 ?k=<WEB_TOKEN>');
    }
    return forward(prefix, url.pathname, url.search, req, res, true);
  };
}


const server = useTls
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, handler)
  : http.createServer(handler);

server.listen(PORT, BIND, () => {
  console.log(`[web] listening ${useTls ? 'https' : 'http'}://${BIND}:${PORT} token=${TOKEN ? 'on' : 'off'} upstreams=${Object.keys(UPSTREAMS).join(',')}`);
});

// 各面板的根路径端口：前端用绝对路径，靠这些端口才能正常取资源和调自己的 /api
for (const [key, port] of Object.entries(ORIGIN_PORTS)) {
  if (!port || port === PORT) continue;
  const h = originHandler(ORIGIN_PREFIX[key]);
  const srv = useTls
    ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, h)
    : http.createServer(h);
  srv.on('error', (e) => console.error(`[web] origin ${key} :${port} 启动失败 ${e.code || e.message}`));
  srv.listen(port, BIND, () => console.log(`[web] origin ${key} → ${useTls ? 'https' : 'http'}://${BIND}:${port}/ (root → ${ORIGIN_PREFIX[key]})`));
}

// 可选：明文直连端口（调试/证书装不上时用；默认不开）
const PLAIN_PORT = Number(process.env.WEB_HTTP_PORT || 0);
if (PLAIN_PORT && PLAIN_PORT !== PORT) {
  http.createServer(handler).listen(PLAIN_PORT, BIND, () => {
    console.log(`[web] plain http:${PLAIN_PORT} (未加密，仅调试用)`);
  });
}

// 可选：明文端口只做 301 跳转（不承载任何内容）
const REDIRECT_PORT = Number(process.env.WEB_REDIRECT_PORT || 0);
if (useTls && REDIRECT_PORT) {
  http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    res.writeHead(301, { location: `https://${host}:${PORT}${req.url}` });
    res.end();
  }).listen(REDIRECT_PORT, BIND, () => console.log(`[web] redirect http:${REDIRECT_PORT} -> https:${PORT}`));
}
