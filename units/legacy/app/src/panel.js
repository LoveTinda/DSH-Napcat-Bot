import http from 'node:http';
import { renderPanel } from './panel-render.js';
import {
  bearerToken, hasJsonContentType, hostAllowed, localHosts, originAllowed, originsFor, safeEqual
} from './auth.js';

/**
 * 最小可用仪表盘：状态卡 + 会话数 + 事件流 + 只读配置/日志。
 * 原版 panel.js 有 284 行缺口，这里先接回可用的只读面板；写操作仍需 token。
 */
export function startPanel(options = {}, handlers = {}) {
  const host = options.host || '127.0.0.1';
  const port = Number(options.port) || 6702;
  const token = options.token || '';
  const writeEnabled = options.writeEnabled === true;
  const allowedHosts = new Set([...(options.allowedHosts || localHosts(port, [host + ':' + port]))].map((h) => String(h).toLowerCase()));
  const allowedOrigins = new Set((options.allowedOrigins || originsFor(host, port)).map((o) => String(o).toLowerCase()));
  const clients = new Set();
  let closed = false;

  const authorized = (req) => writeEnabled && token.length > 0 && safeEqual(bearerToken(req), token);
  const json = (res, code, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 1024 * 1024) { reject(new Error('请求体过大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
  const page = (status, events) => {
    const s = status || {};
    const c = s.counters || {};
    const rows = [
      ['状态', s.state || 'unknown'],
      ['OneBot', s.onebot && s.onebot.connected ? '在线' : '离线'],
      ['DSH', (s.dsh && s.dsh.profile) || ''],
      ['收到', c.inbound || 0],
      ['发出', c.outbound || 0],
      ['拒绝', c.denied || 0],
      ['错误', c.errors || 0]
    ].map(([k, v]) => '<div class="k">' + esc(k) + '</div><div class="v">' + esc(String(v)) + '</div>').join('');
    const feed = (events || []).slice(-30).reverse().map((e) => '<li><b>' + esc(e.kind || '') + '</b> ' + esc(e.text || '') + '</li>').join('');
    return '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Tinda Bridge</title><style>body{background:#0f1115;color:#e6e6e6;font:14px system-ui;margin:0;padding:14px}' +
      '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px}.card{background:#161a21;border:1px solid #242a34;border-radius:10px;padding:8px}' +
      '.k{color:#8b95a5;font-size:12px}.v{font-size:18px;margin-top:2px}li{margin:4px 0;color:#b9c2cf}</style>' +
      '<h3>Tinda Bridge</h3><div class="grid">' + rows + '</div><h4>事件</h4><ul>' + (feed || '<li>暂无</li>') + '</ul>' +
      '<script>setTimeout(()=>location.reload(),3000)</script>';
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://' + (req.headers.host || host));
      if (!hostAllowed(req, allowedHosts)) return json(res, 403, { ok: false, error: 'Host 不在白名单' });
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        const status = handlers.getStatus ? await handlers.getStatus() : {};
        const events = handlers.getEvents ? await handlers.getEvents() : (status.events || []);
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(renderPanel({ ...status, events }));
      }
      if (req.method === 'GET' && url.pathname === '/state.json') {
        const status = handlers.getStatus ? await handlers.getStatus() : {};
        return json(res, 200, { ...status, events: handlers.getEvents ? await handlers.getEvents() : (status.events || []) });
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        return json(res, 200, { ok: true, status: handlers.getStatus ? await handlers.getStatus() : {} });
      }
      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        return json(res, 200, { ok: true, sessions: handlers.getSessions ? await handlers.getSessions() : [] });
      }
      if (req.method === 'GET' && url.pathname === '/api/config') {
        if (!writeEnabled || !authorized(req)) return json(res, 401, { ok: false, error: '需要面板 token' });
        return json(res, 200, { ok: true, config: handlers.getConfig ? await handlers.getConfig() : {} });
      }
      if (req.method === 'GET' && url.pathname === '/api/logs') {
        if (!writeEnabled || !authorized(req)) return json(res, 401, { ok: false, error: '需要面板 token' });
        return json(res, 200, { ok: true, ...(handlers.readLog ? await handlers.readLog({ source: url.searchParams.get('source'), lines: Number(url.searchParams.get('lines')) }) : {}) });
      }
      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        if (!hasJsonContentType(req)) return json(res, 415, { ok: false, error: '需要 application/json' });
        if (!originAllowed(req, allowedOrigins)) return json(res, 403, { ok: false, error: 'Origin 不在白名单' });
        if (!authorized(req)) return json(res, 401, { ok: false, error: '需要面板 token' });
        let body = {};
        try { body = JSON.parse(await readBody(req) || '{}'); } catch { return json(res, 400, { ok: false, error: '坏 JSON' }); }
        const action = url.pathname.slice('/api/'.length);
        if (action === 'command') return json(res, 200, { ok: true, result: await handlers.command(body.text, { operator: 'panel' }) });
        if (action === 'config') return json(res, 200, { ok: true, result: await handlers.saveConfig(body, { operator: 'panel' }) });
        if (action === 'restart') return json(res, 200, { ok: true, result: await handlers.restart({ operator: 'panel' }) });
        if (action === 'onebot') return json(res, 200, { ok: true, result: await handlers.callOneBot(body.action, body.params) });
        return json(res, 404, { ok: false, error: '未知接口' });
      }
      return json(res, 404, { ok: false, error: '未找到' });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { ok: false, error: err && err.message || String(err) });
    }
  });

  let listenError = null;
  const ready = new Promise((resolve, reject) => {
    server.once('error', (err) => {
      listenError = err;
      for (const c of clients) { try { c.end(); } catch {} }
      clients.clear();
      reject(err);
    });
    server.listen(port, host, () => {
      const actual = server.address().port;
      resolve('http://' + (host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host) + ':' + actual);
    });
  });
  ready.catch(() => {});

  const timer = setInterval(async () => {
    if (!clients.size) return;
    try {
      const status = handlers.getStatus ? await handlers.getStatus() : {};
      const payload = 'event: status\ndata: ' + JSON.stringify(status) + '\n\n';
      for (const c of clients) { try { c.write(payload); } catch {} }
    } catch {}
  }, 2000);
  if (timer.unref) timer.unref();

  return {
    ready,
    get error() { return listenError; },
    close() {
      closed = true;
      clearInterval(timer);
      for (const c of clients) { try { c.end(); } catch {} }
      clients.clear();
      try { server.close(); } catch {}
    }
  };
}