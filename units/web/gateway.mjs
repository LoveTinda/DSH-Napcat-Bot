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
import { URL } from 'node:url';

const BIND = process.env.WEB_BIND || '127.0.0.1';
const PORT = Number(process.env.WEB_PORT || 8088);
const TOKEN = process.env.WEB_TOKEN || '';
const UPSTREAMS = {
  '/dsh/': { host: '127.0.0.1', port: Number(process.env.DSH_PORT || 3080) },
  '/bridge/': { host: '127.0.0.1', port: Number(process.env.BRIDGE_PANEL_PORT || 6702) },
  '/napcat/': { host: '127.0.0.1', port: Number(process.env.NAPCAT_WEBUI_PORT || 6099) },
};

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

  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'text/plain' });
    return res.end('ok');
  }
  if (!authed(req, url)) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end('需要 token：在地址后加 ?k=<WEB_TOKEN>');
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'set-cookie': `tinda=${TOKEN}; Path=/; HttpOnly; SameSite=Strict` });
    return res.end(LANDING);
  }

  const prefix = Object.keys(UPSTREAMS).find((p) => url.pathname.startsWith(p));
  if (!prefix) { res.writeHead(404); return res.end('not found'); }

  const up = UPSTREAMS[prefix];
  const subPath = url.pathname.slice(prefix.length - 1) || '/';
  const target = { host: up.host, port: up.port, path: subPath + url.search, method: req.method, headers: { ...req.headers, host: `${up.host}:${up.port}` } };

  const proxy = http.request(target, (upRes) => {
    res.writeHead(upRes.statusCode || 502, upRes.headers);
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

// 可选：明文端口只做 301 跳转（不承载任何内容）
const REDIRECT_PORT = Number(process.env.WEB_REDIRECT_PORT || 0);
if (useTls && REDIRECT_PORT) {
  http.createServer((req, res) => {
    const host = (req.headers.host || '').split(':')[0];
    res.writeHead(301, { location: `https://${host}:${PORT}${req.url}` });
    res.end();
  }).listen(REDIRECT_PORT, BIND, () => console.log(`[web] redirect http:${REDIRECT_PORT} -> https:${PORT}`));
}
