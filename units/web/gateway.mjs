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
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return fs.createReadStream(ui).pipe(res);
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

  const up = UPSTREAMS[prefix];
  const subPath = upstreamPath ?? (url.pathname.slice(prefix.length - 1) || '/');
  // NapCat 的 WebUI 自带一套 token，和网关的 token 是两回事。
  // 这里自动补上，免得用户打开面板还要手输一次。
  let search = url.search;
  if (prefix === '/napcat/' && NAPCAT_TOKEN && !url.searchParams.has('token')) {
    search += (search ? '&' : '?') + 'token=' + encodeURIComponent(NAPCAT_TOKEN);
  }
  const target = { host: up.host, port: up.port, path: subPath + search, method: req.method, headers: { ...req.headers, host: `${up.host}:${up.port}` } };

  const proxy = http.request(target, (upRes) => {
    // 下游可能用绝对路径重定向（例如 NapCat 的 / → /webui），要补回本网关的前缀，
    // 否则浏览器会跑到网关根下去，落到 404。
    const headers = { ...upRes.headers };
    const loc = headers.location;
    if (typeof loc === 'string' && loc.startsWith('/') && !loc.startsWith(prefix)) {
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

const server = useTls
  ? https.createServer({ cert: fs.readFileSync(TLS_CERT), key: fs.readFileSync(TLS_KEY) }, handler)
  : http.createServer(handler);

server.listen(PORT, BIND, () => {
  console.log(`[web] listening ${useTls ? 'https' : 'http'}://${BIND}:${PORT} token=${TOKEN ? 'on' : 'off'} upstreams=${Object.keys(UPSTREAMS).join(',')}`);
});

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
