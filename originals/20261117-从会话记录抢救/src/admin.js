import http from 'node:http';
import { logger } from './log.js';
import {
  headerToken, hasJsonContentType, hostAllowed, localHosts, originAllowed, originsFor, safeEqual
} from './auth.js';
import { maskChatKey } from './policy.js';

const log = logger('admin');

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, code, payload) {
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function auditOf(handlers) {
  return (entry) => {
    try { handlers.audit && handlers.audit(entry); } catch (err) { log.warn('审计回调失败: ' + err.message); }
  };
}

/**
 * 本地管理接口（默认只监听 127.0.0.1）。
 *
 *   GET  /status            当前状态快照

/**
 * 本地管理接口（默认只监听 127.0.0.1）。
 *
 *   GET  /status            当前状态快照
 *   GET  /health            存活探测
 *   POST /inject            反向注入一条消息（需要管理 token）
 *   POST /command           直接执行一条斜杠指令（需要管理 token）
 *   POST /api               **直通 OneBot 调用**（需要同一个管理 token）
 *
 * 所有 POST 都要求：
 *   · Authorization: Bearer <admin-token> 或 x-admin-token: <admin-token>（header，不接受 query）；
 *   · content-type: application/json（否则 415）；
 *   · Host/Origin 命中本机白名单（否则 403）。
 * token 由桥接器启动时生成到 state/admin.token（0600），不经网络传递。
 */
export function startAdminServer(options, handlers) {
  const host = options.host || '127.0.0.1';
  const port = options.port || 6701;
  const token = String(options.token || '');
  const allowedHosts = options.allowedHosts
    ? new Set([...options.allowedHosts].map((h) => String(h).toLowerCase()))
    : localHosts(port, host === '0.0.0.0' || host === '::' ? [] : [host + ':' + port]);
  const allowedOrigins = options.allowedOrigins
    ? new Set([...options.allowedOrigins].map((o) => String(o).toLowerCase()))
    : originsFor(allowedHosts);
  const audit = auditOf(handlers);

  const authorized = (req) => token.length > 0 && safeEqual(headerToken(req), token);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/status') {
        send(res, 200, handlers.status());
        return;
      }
      if (req.method === 'GET' && url.pathname === '/health') {
        // P1-04：分层检查；关键项失败返回 503，监控不能再看“恒 true”。
        if (typeof handlers.health === 'function') {
          const health = await handlers.health();
          send(res, health && health.ok ? 200 : 503, health);
          return;
        }
        send(res, 200, { ok: true, state: handlers.status().state });
        return;
      }

      if (req.method === 'POST') {
        if (!hasJsonContentType(req)) {
          send(res, 415, { ok: false, error: 'POST 需要 content-type: application/json' });
          return;
        }
        if (!hostAllowed(req, allowedHosts)) {
          send(res, 403, { ok: false, error: 'Host 不在本机白名单' });
          return;
        }
        if (!originAllowed(req, allowedOrigins)) {
          send(res, 403, { ok: false, error: 'Origin 不在本机白名单' });
          return;
        }
      }

      if (req.method === 'POST' && url.pathname === '/inject') {
        if (!authorized(req)) { send(res, 401, { ok: false, error: '需要管理 token（state/admin.token），放在 header 里' }); return; }
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        if (!body.text || typeof body.text !== 'string') {
          send(res, 400, { ok: false, error: '需要 {"text": "..."}' });
          return;
        }
        const operator = operatorOf(req);
        const result = await handlers.inject(body, { operator });
        audit({ operator, action: 'inject', target: maskChatKey(chatKeyOf(body)), result: result.ok ? 'ok' : 'error' });
        send(res, result.ok ? 200 : 500, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/command') {
        if (!authorized(req)) { send(res, 401, { ok: false, error: '需要管理 token（state/admin.token），放在 header 里' }); return; }
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        if (!body.text || typeof body.text !== 'string') {
          send(res, 400, { ok: false, error: '需要 {"text": "/help"}' });
          return;
        }
        // 非 / 开头不是指令：不 spawn、不建会话，直接 400。
        if (!body.text.startsWith('/')) {
          send(res, 400, { ok: false, error: '/command 只接受 / 开头的指令；普通文本请用 /inject' });
          return;
        }
        const operator = operatorOf(req);
        const result = await handlers.inject({ ...body, forceCommand: true }, { operator });
        audit({ operator, action: 'command', target: String(body.text).split(/\s+/)[0].slice(0, 40), result: result.ok ? 'ok' : 'error' });
        send(res, result.ok ? 200 : 500, result);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api') {
        if (!authorized(req)) {
          send(res, 401, {
            ok: false,
            error: '需要管理 token（state/admin.token）。用法：-H "x-admin-token: $(cat state/admin.token)"'
          });
          return;
        }
        const raw = await readBody(req);
        const body = raw ? JSON.parse(raw) : {};
        if (!body.action || typeof body.action !== 'string') {
          send(res, 400, { ok: false, error: '需要 {"action": "...", "params": {...}}' });
          return;
        }
        const operator = operatorOf(req);
        try {
          const data = await handlers.callOneBot(body.action, body.params || {}, body.timeoutMs);
          audit({ operator, action: 'onebot:' + body.action, target: 'onebot', result: 'ok' });
          send(res, 200, { ok: true, action: body.action, data });
        } catch (err) {
          audit({ operator, action: 'onebot:' + body.action, target: 'onebot', result: 'error' });
          send(res, 500, { ok: false, action: body.action, error: err && err.message ? err.message : String(err) });
        }
        return;
      }

      send(res, 404, { ok: false, error: '未知路径，可用：GET /status, GET /health, POST /inject, POST /command, POST /api' });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const code = /JSON|请求体/.test(message) ? 400 : 500;
      log.warn('管理接口出错: ' + message);
      send(res, code, { ok: false, error: message });
    }
  });
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // 管理端口就是单例锁：抢不到说明已经有桥接器在跑。
      log.error('管理端口 ' + host + ':' + port + ' 已被占用，说明已有桥接器在运行。');
      log.error('先停掉它（bash qq-gateway.sh stop）再启动本实例。');
      if (options.onFatal) options.onFatal();
      else process.exit(1);
      return;
    }
    log.error('管理接口监听失败: ' + err.message);
  });
  server.listen(port, host, () => {
    log.info('管理接口 http://' + host + ':' + server.address().port + '  （/status, /inject；写请求需要 token）');
  });
  return server;
}

function operatorOf(req) {
  return raw.slice(0, 80) || 'local-admin';
}

function chatKeyOf(body) {
  const kind = body.kind === 'group' ? 'group' : 'private';
  const id = String(body.id || body.userId || 'local');
  return body.chatKey || (kind + ':' + id);
}
}
