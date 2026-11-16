import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './log.js';
import {
  bearerToken, hasJsonContentType, hostAllowed, localHosts, originAllowed, originsFor, safeEqual
} from './auth.js';

const log = logger('panel');
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_FILE = path.join(HERE, 'panel-client.js');
const CSS_FILE = path.join(HERE, 'panel.css');

/**
 * 综合控制台（tinda qq web）。
 *
 * 页面：/ 主页、/sessions 会话、/config 配置、/logs 日志、/status 状态。
 * 数据：SSE /events 提供状态 + 事件增量；/api/* 提供按需查询和写操作。
 *
 * 读页面不需要 token；所有写操作（配置、运行时指令、重启、直通 OneBot）
 * 默认关闭，开启 panel.writeEnabled 后需要独立的 state/panel.token。
 */
export function startPanel(options, handlers) {
  const { host = '127.0.0.1', port = 6702, token = '', writeEnabled = false } = options || {};
  const clients = new Set();
  const configuredHosts = options.allowedHosts ? [...options.allowedHosts] : [];
  const allowedHosts = configuredHosts.length
    ? new Set(configuredHosts.map((h) => String(h).toLowerCase()))
    : localHosts(port, host === '0.0.0.0' || host === '::' ? [] : [host + ':' + port]);
  const configuredOrigins = options.allowedOrigins ? [...options.allowedOrigins] : [];
  const allowedOrigins = configuredOrigins.length
    ? new Set(configuredOrigins.map((o) => String(o).toLowerCase()))
    : originsFor(allowedHosts);
  const authorized = (req) => writeEnabled && token.length > 0 && safeEqual(bearerToken(req), token);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    try {
      if (req.method === 'GET' && url.pathname === '/panel-client.js') {
        let js;
        try { js = fs.readFileSync(CLIENT_FILE, 'utf8'); }
        catch (err) { json(res, 500, { ok: false, error: '客户端脚本缺失：' + err.message }); return; }
        res.writeHead(200, {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff'
        });
        res.end(js);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/panel.css') {
        let css;
        try { css = fs.readFileSync(CSS_FILE, 'utf8'); }
        catch (err) { json(res, 500, { ok: false, error: '样式缺失：' + err.message }); return; }
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' });
        res.end(css);
        return;
      }

      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' ||
          url.pathname === '/config' || url.pathname === '/logs' || url.pathname === '/status' ||
          url.pathname === '/sessions')) {
        if (url.pathname === '/index.html') {
          res.writeHead(302, { location: '/' });
          res.end();
          return;
        }
        const html = await buildPage(url.pathname, handlers, { writeEnabled, title: options.title || 'napcat × DSH' });
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-frame-options': 'DENY',
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        });
        res.end(html);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
          'x-accel-buffering': 'no'
        });
        res.write('retry: 3000\n\n');
        res.write('event: bootstrap\ndata: ' + JSON.stringify(handlers.bootstrap()) + '\n\n');
        const send = (ev) => {
          try { res.write('event: event\ndata: ' + JSON.stringify(ev) + '\n\n'); }
          catch { /* 连接已经断了，下面 close 会清理 */ }
        };
        const unsubscribe = handlers.subscribe(send);
        const statusTimer = setInterval(() => {
          try { res.write('event: status\ndata: ' + JSON.stringify(handlers.status()) + '\n\n'); }
          catch { /* ignore */ }
        }, 2000);
        if (statusTimer.unref) statusTimer.unref();
        const bye = () => {
          clearInterval(statusTimer);
          unsubscribe();
          clients.delete(res);
        };
        req.on('close', bye);
        res.on('error', bye);
        clients.add(res);
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        json(res, 200, { ...handlers.status(), serverTime: new Date().toISOString() });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        if (!handlers.sessions) { json(res, 501, { ok: false, error: '会话管理未接线' }); return; }
        const snapshot = await handlers.sessions();
        json(res, 200, { ok: true, snapshot });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/sessions') {
        const blocked = writeBlocked(req, { writeEnabled, authorized, allowedHosts, allowedOrigins });
        if (blocked) { json(res, blocked.code, { ok: false, error: blocked.error }); return; }
        if (!handlers.sessionAction) { json(res, 501, { ok: false, error: '会话管理未接线' }); return; }
        const body = await readJson(req, 64 * 1024);
        const action = String(body.action || '').trim();
        if (!action) { json(res, 400, { ok: false, error: '需要 {"action":"use|new|rename|release|bind", ...}' }); return; }
        try {
          const result = await handlers.sessionAction(action, body, { operator: operatorOf(req) });
          json(res, 200, { ok: true, ...result });
        } catch (err) {
          const code = err && String(err.code || '').startsWith('session/') ? 400 : 500;
          json(res, code, { ok: false, error: err && err.message ? err.message : String(err), code: err && err.code });
        }
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/health') {
        if (!handlers.health) { json(res, 501, { ok: false, error: '健康检查未接线' }); return; }
        json(res, 200, { ok: true, health: handlers.health(), serverTime: new Date().toISOString() });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/config') {
        if (!handlers.getConfig) { json(res, 501, { ok: false, error: '配置读取未接线' }); return; }
        json(res, 200, { ok: true, writeEnabled, ...handlers.getConfig() });
        return;
      }

      if (req.method === 'GET' && url.pathname === '/api/logs') {
        if (!handlers.readLog) { json(res, 501, { ok: false, error: '日志读取未接线' }); return; }
        const source = String(url.searchParams.get('source') || 'bridge');
        const lines = clampInt(url.searchParams.get('lines'), 50, 2000, 500);
        json(res, 200, { ok: true, ...handlers.readLog({ source, lines }) });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/auth') {
        const blocked = writeBlocked(req, { writeEnabled, authorized, allowedHosts, allowedOrigins });
        if (blocked) { json(res, blocked.code, { ok: false, error: blocked.error }); return; }
        json(res, 200, { ok: true, writeEnabled: true });
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/command') {
        const blocked = writeBlocked(req, { writeEnabled, authorized, allowedHosts, allowedOrigins });
        if (blocked) { json(res, blocked.code, { ok: false, error: blocked.error }); return; }
        const body = await readJson(req);
        const text = String(body.text || '').trim();
        if (!text.startsWith('/')) { json(res, 400, { ok: false, error: '只接受 / 开头的运行时指令' }); return; }
        if (text.length > 4000) { json(res, 400, { ok: false, error: '指令过长' }); return; }
        if (!handlers.command) { json(res, 501, { ok: false, error: '运行时指令未接线' }); return; }
        const operator = operatorOf(req);
        try {
          const chatKey = String(body.chatKey || '').trim();
          const result = await handlers.command(text, { operator, chatKey });
          json(res, 200, { ok: true, result });
        } catch (err) {
          json(res, 400, { ok: false, error: err && err.message ? err.message : String(err) });
        }
        return;
      }

      if ((req.method === 'POST' || req.method === 'PUT') && url.pathname === '/api/config') {
        const blocked = writeBlocked(req, { writeEnabled, authorized, allowedHosts, allowedOrigins });
        if (blocked) { json(res, blocked.code, { ok: false, error: blocked.error }); return; }
        const body = await readJson(req, 1024 * 1024);
        const submitted = body && body.config && typeof body.config === 'object' ? body.config : body;
        if (!submitted || typeof submitted !== 'object' || Array.isArray(submitted)) {
          json(res, 400, { ok: false, error: '需要 JSON 对象（可直接提交配置，或 {"config": {...}}）' });
          return;
        }
        if (!handlers.saveConfig) { json(res, 501, { ok: false, error: '配置写入未接线' }); return; }
        try {
          const result = await handlers.saveConfig(submitted, { operator: operatorOf(req) });
          json(res, 200, { ok: true, ...result });
        } catch (err) {
          const code = err && (err.name === 'ConfigError' || String(err.code || '').startsWith('config/')) ? 400 : 500;
          json(res, code, { ok: false, error: err && err.message ? err.message : String(err), code: err && err.code });
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/restart') {
        const blocked = writeBlocked(req, { writeEnabled, authorized, allowedHosts, allowedOrigins });
        if (blocked) { json(res, blocked.code, { ok: false, error: blocked.error }); return; }
        if (!handlers.restart) { json(res, 501, { ok: false, error: '重启未接线' }); return; }
        const body = await readJson(req);
        try {
          const result = await handlers.restart({ force: body.force === true, operator: operatorOf(req) });
          json(res, 200, { ok: true, ...result });
        } catch (err) {
          json(res, 409, { ok: false, error: err && err.message ? err.message : String(err) });
        }
        return;
      }

      if (req.method === 'POST' && url.pathname === '/api/onebot') {
        const blocked = writeBlocked(req, { writeEnabled, authorized, allowedHosts, allowedOrigins });
        if (blocked) { json(res, blocked.code, { ok: false, error: blocked.error }); return; }
        const body = await readJson(req);
        if (!body.action) { json(res, 400, { ok: false, error: '需要 {"action": "...", "params": {...}}' }); return; }
        const operator = operatorOf(req);
        try {
          const data = await handlers.callOneBot(body.action, body.params || {});
          handlers.noteAction && handlers.noteAction(body.action, body.params || {}, true);
          noteAudit(handlers, { operator, action: 'onebot:' + body.action, target: 'panel', result: 'ok' });
          json(res, 200, { ok: true, action: body.action, data });
        } catch (err) {
          handlers.noteAction && handlers.noteAction(body.action, body.params || {}, false, err.message);
          noteAudit(handlers, { operator, action: 'onebot:' + body.action, target: 'panel', result: 'error' });
          json(res, 502, { ok: false, action: body.action, error: err.message });
        }
        return;
      }

      json(res, 404, {
        ok: false,
        error: '可用：GET /, /config, /logs, /status, /sessions, /events, /api/status, /api/health, ' +
          '/api/config, /api/logs, /api/sessions；POST /api/command, /api/config, /api/restart, ' +
          '/api/onebot, /api/sessions（写操作需 token）'
      });
    } catch (err) {
      log.warn('面板请求出错: ' + (err && err.message));
      if (!res.headersSent) json(res, 500, { ok: false, error: err && err.message ? err.message : String(err) });
    }
  });

  let url = null;
  let listenError = null;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});

  server.on('error', (err) => {
      clients.clear();
      try { server.close(); } catch {}
    }
  };
}

function writeBlocked(req, { writeEnabled, authorized, allowedHosts, allowedOrigins }) {
  if (!writeEnabled) return { code: 403, error: '面板写入口已关闭（panel.writeEnabled=false）' };
  if (!hasJsonContentType(req)) return { code: 415, error: '写请求需要 content-type: application/json' };
  if (!hostAllowed(req, allowedHosts)) return { code: 403, error: 'Host 不在本机白名单' };
  if (!originAllowed(req, allowedOrigins)) return { code: 403, error: 'Origin 不在本机白名单' };
  if (!authorized(req)) return { code: 401, error: '需要面板 token（Authorization: Bearer <state/panel.token>）' };
  return null;
}

function noteAudit(handlers, entry) {
  if (!handlers || !handlers.audit) return;
  if (typeof handlers.audit === 'function') handlers.audit(entry);
  else if (typeof handlers.audit.write === 'function') handlers.audit.write(entry);
}

function operatorOf(req) {
  return String(req.headers['x-operator'] || 'panel-user').replace(/[^\w .:@-]/g, '').trim().slice(0, 80) || 'panel-user';
}

function json(res, code, payload) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(payload, null, 2));
}

function readJson(req, limit = 1024 * 256) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('body 不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

/* ── 页面 ───────────────────────────────────────────────── */

function buildPage(route, handlers, opts) {
  const boot = safe(() => handlers.bootstrap(), { status: {}, events: [] });
  const health = safe(() => (handlers.health ? handlers.health() : null), null);
  const config = route === '/config' ? safe(() => (handlers.getConfig ? handlers.getConfig() : null), null) : null;
  const page = route === '/' ? 'home' : route.slice(1);
  const data = {
    page,
    boot,
    health,
    config,
    writeEnabled: opts.writeEnabled === true,
    serverTime: new Date().toISOString()
  };
  const body = page === 'home' ? homeBody(data)
    : page === 'config' ? configBody(data)
    : page === 'logs' ? logsBody(data)
    : statusBody(data);
  return layout({ page, title: opts.title, writeEnabled: opts.writeEnabled, body, data });
}

function layout({ page, title, writeEnabled, body, data }) {
  const status = data.boot && data.boot.status ? data.boot.status : {};
  const ob = status.onebot || {};
  const account = ob.selfId ? (ob.selfId + (ob.nickname ? ' · ' + ob.nickname : '')) : '未登录';
  const nav = [
    ['home', '/', '主页'],
    ['config', '/config', '配置'],
    ['logs', '/logs', '日志'],
    ['status', '/status', '状态']
  ].map(([key, href, label]) =>
    '<a href="' + href + '"' + (page === key ? ' class="on" aria-current="page"' : '') + '>' + label + '</a>'
  ).join('');
  return '<!doctype html>\n' +
    '<html lang="zh-CN" data-theme="dark">\n<head>\n' +
    '<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">\n' +
    '<meta name="color-scheme" content="dark light">\n' +
    '<meta name="theme-color" content="#0d1117" media="(prefers-color-scheme: dark)">\n' +
    '<meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">\n' +
    '<meta name="apple-mobile-web-app-capable" content="yes">\n' +
    '<title>' + esc(title) + '</title>\n' +
    '<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 32 32\'%3E%3Crect width=\'32\' height=\'32\' rx=\'6\' fill=\'%230d1117\'/%3E%3Cpath d=\'M16 7l8 4.6v9.2L16 25.4 8 20.8v-9.2z\' fill=\'none\' stroke=\'%238b949e\' stroke-width=\'2\' stroke-linejoin=\'round\'/%3E%3C/svg%3E">\n' +
    '<script>try{var t=localStorage.getItem("np-theme");if(t!=="light"&&t!=="dark")t=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";document.documentElement.dataset.theme=t}catch(e){}</script>\n' +
    '<link rel="stylesheet" href="/panel.css">\n' +
    '</head>\n<body data-page="' + page + '">\n' +
    '<header class="topbar">\n' +
    '  <div class="brand"><h1>napcat × DSH</h1><span class="sub mono" id="acc">' + esc(account) + '</span></div>\n' +
    '  <div class="top-actions">\n' +
    '    <span class="pill p-starting" id="state" role="status" aria-live="polite"><span class="dot"></span><span id="stateText">…</span></span>\n' +
    '    <span class="chip mono" id="live" title="与服务端的实时连接"><span class="dot" id="liveDot"></span><span id="liveText">连接中</span></span>\n' +
    '    <span class="mode ' + (writeEnabled ? 'writable' : '') + '" id="writeMode">' + (writeEnabled ? '可写' : '只读') + '</span>\n' +
    '    <button class="iconbtn" id="theme" type="button" title="切换浅色/深色" aria-label="切换浅色或深色主题">' +
    '<svg class="i-sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4"/></svg>' +
    '<svg class="i-moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M20 14.5A8.5 8.5 0 019.5 4a8.5 8.5 0 1010.5 10.5z"/></svg></button>\n' +
    '  </div>\n</header>\n' +
    '<nav class="tabs" aria-label="主导航">' + nav + '</nav>\n' +
    body + '\n' +
    '<footer class="foot"><span>napcat × DSH 控制台</span><span class="sep">·</span><span class="mono" id="foot"></span>' +
    '<span class="sep">·</span><span>数据：SSE /events</span></footer>\n' +
    '<div id="toast" role="status" aria-live="polite"></div>\n' +
    '<div id="modal" class="modal" hidden><div class="modal-card"><h2 id="modalTitle"></h2><p id="modalBody"></p>' +
    '<div class="modal-actions"><button class="btn ghost" type="button" id="modalCancel">取消</button>' +
    '<button class="btn" type="button" id="modalOk">确认</button></div></div></div>\n' +
    '<script>window.__NP__ = ' + jsonForScript(data) + ';</script>\n' +
    '<script src="/panel-client.js" defer></script>\n' +
    '</body></html>';
}

function homeBody(data) {
  const s = data.boot.status || {};
  const events = (data.boot.events || []).slice(-18);
  return '<main class="wrap">\n' +
    '<div id="alert" class="alert" role="alert"><span class="ai">!</span><span><span class="at" id="alertTitle"></span>' +
    '<div class="am" id="alertMsg"></div><div class="ac" id="alertMeta"></div></span></div>\n' +
    healthStrip(data.health) +
    '<section class="kpis" id="kpis" aria-label="概览">' +
      kpi('OneBot', s.onebot && s.onebot.connected ? '已连接' : '待机', onebotSub(s), s.onebot && s.onebot.connected ? 'ok' : '') +
      kpi('模型进程', (s.dsh && s.dsh.running || 0) + ' / ' + (s.dsh && s.dsh.maxConcurrent || 0), 'profile ' + ((s.dsh && s.dsh.profile) || '—')) +
      kpi('完成回合', (s.counters && s.counters.turns || 0), '失败 ' + (s.counters && s.counters.errors || 0) + ' · 注入 ' + (s.counters && s.counters.injected || 0) + ' · 拒绝 ' + (s.counters && s.counters.denied || 0)) +
      kpi('收到消息', (s.counters && s.counters.inbound || 0), '最后回复 ' + (s.lastReplyAt ? ago(Date.parse(s.lastReplyAt)) : '—')) +
      kpi('发出消息', (s.counters && s.counters.outbound || 0), '小动作 ' + (s.counters && s.counters.actions || 0) + ' · 会话分叉 ' + (s.counters && s.counters.sessionForks || 0)) +
      kpi('运行时长', dur(s.uptimeMs), '当前状态 ' + ago(Date.parse(s.since || s.startedAt)) + ' 起') +
    '</section>\n' +
    '<div class="grid home">\n' +
      '<section class="card">\n<div class="hd"><h2>最近事件</h2><span class="hint" id="evHint">' +
        (events.length ? '最后一条 ' + ago(events[events.length - 1].at) : '等待数据…') + '</span>' +
        '<span class="spacer"></span><a class="hint" href="/logs">全部日志 →</a></div>' +
        '<div class="feed" id="recent">' + (events.length ? events.map(eventRow).join('') : '<div class="empty">还没有事件。</div>') + '</div>' +
      '</section>\n' +
      '<div class="stack">\n' +
        '<section class="card"><div class="hd"><h2>会话</h2><span class="hint">每条 QQ 聊天 → 一条 DSH 会话</span></div>' +
          '<div class="chats" id="chats">' + chatRows(s.chats || {}) + '</div></section>\n' +
        '<section class="card"><div class="hd"><h2>运行摘要</h2><span class="hint">策略与配置</span></div><div class="bd summary" id="summary">' +
          summaryRows(s) + '</div></section>\n' +
      '</div>\n' +
    '</div>\n' +
    '<section class="quick"><a class="quicklink" href="/config"><b>配置</b><span>工作区、模型、权限、OneBot、拟人化</span></a>' +
    '<a class="quicklink" href="/logs"><b>日志</b><span>实时事件、bridge.log、guard.log</span></a>' +
    '<a class="quicklink" href="/status"><b>状态</b><span>健康检查、状态快照、会话表</span></a></section>\n' +
    '</main>';
}

function configBody(data) {
  const c = (data.config && data.config.config) || {};
  const write = data.writeEnabled;
  const source = data.config && data.config.source ? data.config.source : 'config.json';
  const models = Object.keys((c.dsh && c.dsh.models) || {});
  const modelOpts = models.map((m) => '<option value="' + esc(m) + '">' + esc(m) + '</option>').join('');
  const presetOpts = ['danger-full-access', 'workspace-write', 'read-only'].map((p) =>
    '<option value="' + p + '">' + p + '</option>').join('');
  return '<main class="wrap">\n' +
    '<section class="card">\n<div class="hd"><h2>配置</h2><span class="hint mono">' + esc(source) + '</span>' +
      '<span class="spacer"></span><span class="badge ' + (write ? 'ok' : 'warn') + '">' + (write ? '写入口已启用' : '只读') + '</span></div>' +
      '<div class="bd config-intro">' +
        (write
          ? '<p>保存会先经过与启动相同的校验，然后写 <span class="mono">config.json</span>（自动备份）。大多数改动需要重启桥接器才会生效；工作区、模型、权限、会话属于运行中设置，不需要重启。</p>'
          : '<p class="warnText">面板写入口当前关闭（<span class="mono">panel.writeEnabled=false</span>）。可以先在 <span class="mono">config.json</span> 打开它并重启，再回来保存配置。页面仍可查看当前值。</p>') +
      '</div>\n</section>\n' +
    writeBar(write) +
    runtimeCard(models, modelOpts, presetOpts, write, (data.boot.status && data.boot.status.chats) || {}) +
    '<form id="configForm" autocomplete="off">' + configSections(c) + saveBar(write) + '</form>\n' +
    rawCard(c, source, write) +
    dangerCard(write) +
    '</main>';
}

function writeBar(write) {
  return '<section class="card" id="writebar">\n<div class="hd"><h2>写权限</h2><span id="tokenState" class="hint">' +
    (write ? '未解锁' : '写入口关闭') + '</span></div><div class="bd">' +
    '<div class="row-inline"><label for="panelToken">面板写 token</label>' +
    '<input id="panelToken" type="password" class="mono" autocomplete="off" placeholder="cat state/panel.token" ' + (write ? '' : 'disabled') + '>' +
    '<button class="btn" type="button" id="unlock"' + (write ? '' : ' disabled') + '>解锁</button>' +
    '<button class="btn ghost" type="button" id="lock">锁定</button></div>' +
    '<p class="dim">token 只保存在当前标签页的 sessionStorage；每次写请求走 <span class="mono">Authorization: Bearer</span>。' +
    '它与 <span class="mono">admin.token</span> 完全不同。</p></div></section>\n';
}

function runtimeCard(models, modelOpts, presetOpts, write, chats) {
  const dis = write ? '' : ' disabled';
  const keys = Object.keys(chats || {}).sort();
  const chatOpts = keys.map((k) => '<option value="' + esc(k) + '">' + esc(k) + '</option>').join('') +
    '<option value="private:panel"' + (keys.length ? '' : ' selected') + '>private:panel（控制会话）</option>';
  return '<section class="card" id="runtime">\n<div class="hd"><h2>运行中设置</h2><span class="hint">改完立即生效，不重启；只作用于选中的聊天</span></div><div class="bd runtime-grid">' +
    '<div class="field span2"><label for="rtChat">目标聊天</label><select id="rtChat"' + dis + '>' + chatOpts + '</select><span class="hint">工作区 / 模型 / 会话都是按聊天绑定的；这里选哪条聊天就改哪条</span></div>' +
    '<div class="field"><label for="rtWs">工作区</label><div class="row-inline"><input id="rtWs" class="mono" placeholder="/path/to/workspace"' + dis + '>' +
      '<button class="btn" type="button" data-cmd="ws"' + dis + '>切换</button></div><span class="hint">对应 /ws &lt;路径&gt;</span></div>' +
    '<div class="field"><label for="rtModel">模型</label><div class="row-inline"><select id="rtModel"' + dis + '><option value="">（查看当前）</option>' + modelOpts + '</select>' +
      '<button class="btn" type="button" data-cmd="model"' + dis + '>切换</button></div><span class="hint">别名来自 dsh.models</span></div>' +
    '<div class="field"><label for="rtPreset">权限预设</label><div class="row-inline"><select id="rtPreset"' + dis + '>' + presetOpts + '</select>' +
      '<button class="btn" type="button" data-cmd="permission"' + dis + '>应用</button></div><span class="hint">对应 /permission &lt;预设&gt;</span></div>' +
    '<div class="field"><label for="rtSession">会话</label><div class="row-inline"><input id="rtSession" class="mono" placeholder="session id 或唯一前缀"' + dis + '>' +
      '<button class="btn" type="button" data-cmd="session"' + dis + '>切换</button>' +
      '<button class="btn ghost" type="button" data-cmd="new"' + dis + '>新会话</button></div><span class="hint">对应 /ws &lt;id&gt;、/new</span></div>' +
    '<div class="field"><label>中断</label><div class="row-inline"><button class="btn ghost" type="button" data-cmd="stop"' + dis + '>中断当前任务</button></div><span class="hint">对应 /stop</span></div>' +
    '<div class="cmdwrap"><div class="bar"><span id="cmdLabel">指令输出</span><span class="spacer"></span><button class="tbtn" type="button" id="cmdCopy">复制</button></div><pre id="cmdOut" class="cmdout dim">（还没有执行指令）</pre></div>' +
    '</div></section>\n';
}

function configSections(c) {
  const d = (v, fallback) => (v === undefined || v === null ? fallback : v);
  const h = c.behavior && c.behavior.humanize ? c.behavior.humanize : {};
  const b = h.burst || {}, ist = h.inputStatus || {}, it = (c.behavior && c.behavior.interactions) || {};
  return '<div class="config-grid">' +
    '<details class="card section" open><summary><h2>OneBot</h2><span class="hint">连接方式与令牌</span></summary><div class="bd form-grid">' +
      field('连接方式', 'onebot.mode', { type: 'select', options: [['forward-ws','forward-ws'],['reverse-ws','reverse-ws'],['http','http']], value: d(c.onebot && c.onebot.mode, 'forward-ws') }) +
      field('地址', 'onebot.url', { value: d(c.onebot && c.onebot.url, ''), placeholder: 'ws://127.0.0.1:3001' }) +
      secretField('Access Token', 'onebot.accessToken', c.onebot && c.onebot.accessToken) +
      field('监听地址（reverse-ws）', 'onebot.listenHost', { value: d(c.onebot && c.onebot.listenHost, ''), placeholder: '127.0.0.1' }) +
      field('监听端口（reverse-ws）', 'onebot.listenPort', { type: 'number', value: d(c.onebot && c.onebot.listenPort, '') }) +
      field('重连间隔（ms）', 'onebot.reconnectMs', { type: 'number', value: d(c.onebot && c.onebot.reconnectMs, 3000) }) +
    '</div></details>' +
    '<details class="card section"><summary><h2>DSH</h2><span class="hint">命令、并发、模型别名</span></summary><div class="bd form-grid">' +
      field('命令', 'dsh.command', { value: d(c.dsh && c.dsh.command, 'dsh') }) +
      field('Profile', 'dsh.profile', { value: d(c.dsh && c.dsh.profile, 'qq'), readonly: true, hint: '当前硬边界：必须是 qq' }) +
      field('工作目录 cwd', 'dsh.cwd', { value: d(c.dsh && c.dsh.cwd, ''), placeholder: '留空使用默认 workspace' }) +
      field('超时（ms）', 'dsh.timeoutMs', { type: 'number', value: d(c.dsh && c.dsh.timeoutMs, 900000) }) +
      field('最大并发', 'dsh.maxConcurrent', { type: 'number', value: d(c.dsh && c.dsh.maxConcurrent, 1) }) +
      field('默认模型', 'dsh.defaultModel', { value: d(c.dsh && c.dsh.defaultModel, ''), placeholder: '别名，可留空' }) +
      field('Web 端口', 'dsh.webPort', { type: 'number', value: d(c.dsh && c.dsh.webPort, 3080) }) +
      checkbox('注册工作区', 'dsh.registerWorkspace', d(c.dsh && c.dsh.registerWorkspace, true)) +
      jsonField('模型别名 dsh.models', 'dsh.models', d(c.dsh && c.dsh.models, {}), 8) +
      jsonField('额外参数 dsh.extraArgs', 'dsh.extraArgs', d(c.dsh && c.dsh.extraArgs, []), 4) +
    '</div></details>' +
    '<details class="card section"><summary><h2>访问策略</h2><span class="hint">白名单与命令角色</span></summary><div class="bd form-grid">' +
      field('私聊模式', 'policy.privateChat', { type: 'select', options: [['allowlist','allowlist'],['allow','allow'],['deny','deny']], value: d(c.policy && c.policy.privateChat, 'allowlist') }) +
      field('群聊模式', 'policy.groupChat', { type: 'select', options: [['mention','mention'],['allow','allow'],['deny','deny']], value: d(c.policy && c.policy.groupChat, 'mention') }) +
      listField('私聊白名单', 'policy.allowUsers', d(c.policy && c.policy.allowUsers, []), '每行一个 QQ 号') +
      listField('群白名单', 'policy.allowGroups', d(c.policy && c.policy.allowGroups, []), '每行一个群号') +
      listField('Owner', 'policy.ownerUsers', d(c.policy && c.policy.ownerUsers, []), '每行一个 QQ 号') +
      listField('Admin', 'policy.adminUsers', d(c.policy && c.policy.adminUsers, []), '每行一个 QQ 号') +
      checkbox('允许所有私聊用户（危险）', 'policy.allowAllUsers', d(c.policy && c.policy.allowAllUsers, false)) +
      checkbox('允许所有群（危险）', 'policy.allowAllGroups', d(c.policy && c.policy.allowAllGroups, false)) +
      checkbox('忽略自己', 'policy.ignoreSelf', d(c.policy && c.policy.ignoreSelf, true)) +
    '</div></details>' +
    '<details class="card section"><summary><h2>行为</h2><span class="hint">忙碌策略、回复上限、出站止损</span></summary><div class="bd form-grid">' +
      field('ackAfterMs', 'behavior.ackAfterMs', { type: 'number', value: d(c.behavior && c.behavior.ackAfterMs, 0) }) +
      field('ackText', 'behavior.ackText', { value: d(c.behavior && c.behavior.ackText, '') }) +
      field('忙碌策略', 'behavior.onBusy', { type: 'select', options: [['interrupt','interrupt'],['queue','queue']], value: d(c.behavior && c.behavior.onBusy, 'interrupt') }) +
      field('ackText', 'behavior.ackText', { value: d(c.behavior && c.behavior.ackText, '') }) +
      field('忙碌策略', 'behavior.onBusy', { type: 'select', options: [['interrupt','interrupt'],['queue','queue']], value: d(c.behavior && c.behavior.onBusy, 'interrupt') }) +
      field('会话冲突', 'behavior.sessionConflict', { type: 'select', options: [['error','error（不自动开新会话）'],['fork','fork（显式允许分叉）']], value: d(c.behavior && c.behavior.sessionConflict, 'error') }) +
      field('忙碌提示', 'behavior.busyText', { value: d(c.behavior && c.behavior.busyText, '') }) +
      field('最大回复字符', 'behavior.maxReplyChars', { type: 'number', value: d(c.behavior && c.behavior.maxReplyChars, 4000) }) +
      field('出站失败阈值', 'behavior.outboundFailThreshold', { type: 'number', value: d(c.behavior && c.behavior.outboundFailThreshold, 5) }) +
      field('熔断冷却（ms）', 'behavior.outboundFailCooldownMs', { type: 'number', value: d(c.behavior && c.behavior.outboundFailCooldownMs, 600000) }) +
      jsonField('会话恢复重试数组', 'behavior.sessionResumeRetryMs', d(c.behavior && c.behavior.sessionResumeRetryMs, [1500, 4000]), 4) +
      checkbox('群消息加发送者前缀', 'behavior.groupSenderPrefix', d(c.behavior && c.behavior.groupSenderPrefix, true)) +
      checkbox('群回复 @ 发送者', 'behavior.groupReplyAtSender', d(c.behavior && c.behavior.groupReplyAtSender, false)) +
      checkbox('下载图片', 'behavior.downloadImages', d(c.behavior && c.behavior.downloadImages, true)) +
      field('图片目录', 'behavior.imageDir', { value: d(c.behavior && c.behavior.imageDir, ''), placeholder: '留空使用默认' }) +
    '</div></details>' +
    '<details class="card section"><summary><h2>拟人化</h2><span class="hint">分段、打字、输入状态</span></summary><div class="bd form-grid">' +
      checkbox('启用拟人化', 'behavior.humanize.enabled', d(h.enabled, false)) +
      field('每分钟字符', 'behavior.humanize.charsPerMinute', { type: 'number', value: d(h.charsPerMinute, 220) }) +
      field('最小延迟（ms）', 'behavior.humanize.minDelayMs', { type: 'number', value: d(h.minDelayMs, 700) }) +
      field('最大延迟（ms）', 'behavior.humanize.maxDelayMs', { type: 'number', value: d(h.maxDelayMs, 5200) }) +
      field('抖动 jitter', 'behavior.humanize.jitter', { type: 'number', step: '0.05', value: d(h.jitter, 0.35) }) +
      checkbox('爆发分段', 'behavior.humanize.burst.enabled', d(b.enabled, true)) +
// [缺失第 535 行]
// [缺失第 536 行]
// [缺失第 537 行]
// [缺失第 538 行]
// [缺失第 539 行]
// [缺失第 540 行]
// [缺失第 541 行]
// [缺失第 542 行]
// [缺失第 543 行]
// [缺失第 544 行]
// [缺失第 545 行]
// [缺失第 546 行]
// [缺失第 547 行]
// [缺失第 548 行]
// [缺失第 549 行]
// [缺失第 550 行]
// [缺失第 551 行]
// [缺失第 552 行]
// [缺失第 553 行]
// [缺失第 554 行]
// [缺失第 555 行]
// [缺失第 556 行]
// [缺失第 557 行]
// [缺失第 558 行]
// [缺失第 559 行]
// [缺失第 560 行]
// [缺失第 561 行]
// [缺失第 562 行]
// [缺失第 563 行]
// [缺失第 564 行]
// [缺失第 565 行]
// [缺失第 566 行]
// [缺失第 567 行]
// [缺失第 568 行]
// [缺失第 569 行]
// [缺失第 570 行]
// [缺失第 571 行]
// [缺失第 572 行]
// [缺失第 573 行]
// [缺失第 574 行]
// [缺失第 575 行]
// [缺失第 576 行]
// [缺失第 577 行]
// [缺失第 578 行]
// [缺失第 579 行]
// [缺失第 580 行]
// [缺失第 581 行]
// [缺失第 582 行]
// [缺失第 583 行]
// [缺失第 584 行]
// [缺失第 585 行]
// [缺失第 586 行]
// [缺失第 587 行]
// [缺失第 588 行]
// [缺失第 589 行]
// [缺失第 590 行]
// [缺失第 591 行]
// [缺失第 592 行]
// [缺失第 593 行]
// [缺失第 594 行]
// [缺失第 595 行]
// [缺失第 596 行]
// [缺失第 597 行]
// [缺失第 598 行]
// [缺失第 599 行]
// [缺失第 600 行]
// [缺失第 601 行]
// [缺失第 602 行]
// [缺失第 603 行]
// [缺失第 604 行]
// [缺失第 605 行]
// [缺失第 606 行]
// [缺失第 607 行]
// [缺失第 608 行]
// [缺失第 609 行]
// [缺失第 610 行]
// [缺失第 611 行]
// [缺失第 612 行]
// [缺失第 613 行]
// [缺失第 614 行]
// [缺失第 615 行]
// [缺失第 616 行]
// [缺失第 617 行]
// [缺失第 618 行]
// [缺失第 619 行]
// [缺失第 620 行]
// [缺失第 621 行]
// [缺失第 622 行]
// [缺失第 623 行]
// [缺失第 624 行]
// [缺失第 625 行]
// [缺失第 626 行]
// [缺失第 627 行]
// [缺失第 628 行]
// [缺失第 629 行]
// [缺失第 630 行]
// [缺失第 631 行]
// [缺失第 632 行]
// [缺失第 633 行]
// [缺失第 634 行]
// [缺失第 635 行]
// [缺失第 636 行]
// [缺失第 637 行]
// [缺失第 638 行]
// [缺失第 639 行]
// [缺失第 640 行]
// [缺失第 641 行]
// [缺失第 642 行]
// [缺失第 643 行]
// [缺失第 644 行]
// [缺失第 645 行]
// [缺失第 646 行]
// [缺失第 647 行]
// [缺失第 648 行]
// [缺失第 649 行]
// [缺失第 650 行]
// [缺失第 651 行]
// [缺失第 652 行]
// [缺失第 653 行]
// [缺失第 654 行]
// [缺失第 655 行]
// [缺失第 656 行]
// [缺失第 657 行]
// [缺失第 658 行]
// [缺失第 659 行]
// [缺失第 660 行]
// [缺失第 661 行]
// [缺失第 662 行]
// [缺失第 663 行]
// [缺失第 664 行]
// [缺失第 665 行]
// [缺失第 666 行]
// [缺失第 667 行]
// [缺失第 668 行]
// [缺失第 669 行]
// [缺失第 670 行]
// [缺失第 671 行]
// [缺失第 672 行]
// [缺失第 673 行]
// [缺失第 674 行]
// [缺失第 675 行]
// [缺失第 676 行]
// [缺失第 677 行]
// [缺失第 678 行]
// [缺失第 679 行]
// [缺失第 680 行]
// [缺失第 681 行]
// [缺失第 682 行]
// [缺失第 683 行]
// [缺失第 684 行]
// [缺失第 685 行]
// [缺失第 686 行]
// [缺失第 687 行]
// [缺失第 688 行]
// [缺失第 689 行]
// [缺失第 690 行]
// [缺失第 691 行]
// [缺失第 692 行]
// [缺失第 693 行]
// [缺失第 694 行]
// [缺失第 695 行]
// [缺失第 696 行]
// [缺失第 697 行]
// [缺失第 698 行]
// [缺失第 699 行]
// [缺失第 700 行]
// [缺失第 701 行]
// [缺失第 702 行]
// [缺失第 703 行]
// [缺失第 704 行]
// [缺失第 705 行]
// [缺失第 706 行]
// [缺失第 707 行]
// [缺失第 708 行]
// [缺失第 709 行]
// [缺失第 710 行]
// [缺失第 711 行]
// [缺失第 712 行]
// [缺失第 713 行]
// [缺失第 714 行]
// [缺失第 715 行]
// [缺失第 716 行]
// [缺失第 717 行]
// [缺失第 718 行]
// [缺失第 719 行]
// [缺失第 720 行]
// [缺失第 721 行]
// [缺失第 722 行]
// [缺失第 723 行]
// [缺失第 724 行]
// [缺失第 725 行]
// [缺失第 726 行]
// [缺失第 727 行]
// [缺失第 728 行]
// [缺失第 729 行]
// [缺失第 730 行]
// [缺失第 731 行]
// [缺失第 732 行]
// [缺失第 733 行]
// [缺失第 734 行]
// [缺失第 735 行]
// [缺失第 736 行]
// [缺失第 737 行]
// [缺失第 738 行]
// [缺失第 739 行]
function saveBar(write) {
  return '<div class="savebar"><span class="hint" id="dirtyHint">修改后点保存；保存成功会写入 config.json 并提示是否重启。</span>' +
    '<span class="spacer"></span><button class="btn ghost" type="reset">重置表单</button>' +
    '<button class="btn" type="submit" id="saveConfig"' + (write ? '' : ' disabled') + '>保存配置</button></div>';
}

function logsBody(data) {
  const events = (data.boot.events || []).slice(-100);
  return '<main class="wrap">\n' +
    '<section class="card">\n<div class="hd"><h2>日志</h2><span class="hint" id="logHint">实时事件 / 运行日志</span>' +
      '<span class="spacer"></span><span class="mono hint" id="logCount"></span></div>' +
    '<div class="toolbar">' +
      '<div class="seg" id="logSrc" role="group" aria-label="日志来源">' +
        '<button type="button" data-src="events" aria-pressed="true">实时事件</button>' +
        '<button type="button" data-src="bridge" aria-pressed="false">bridge.log</button>' +
        '<button type="button" data-src="guard" aria-pressed="false">guard.log</button>' +
      '</div>' +
      '<select id="logKind" aria-label="事件类型"><option value="">全部类型</option><option value="in">收到</option><option value="out">发出</option>' +
        '<option value="turn">回合</option><option value="action">小动作</option><option value="alert">告警</option><option value="warn">警告</option><option value="error">错误</option><option value="state">状态</option></select>' +
      '<label class="search"><span class="sr">搜索日志</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/></svg>' +
        '<input id="logQ" type="text" placeholder="搜索…" autocomplete="off" enterkeyhint="search"></label>' +
      '<button class="tbtn" type="button" id="logFollow" aria-pressed="true">跟随</button>' +
      '<button class="tbtn" type="button" id="logRefresh">刷新</button>' +
      '<button class="tbtn" type="button" id="logDownload">下载</button>' +
      '<button class="tbtn" type="button" id="logClear">清空本页</button>' +
    '</div>' +
    '<div class="logwrap"><div id="log" class="logbox" role="log" aria-live="polite">' +
      (events.length ? events.map(logRow).join('') : '<div class="empty">还没有事件。</div>') +
    '</div><button class="jump" type="button" id="logJump">↓ 最新</button></div>' +
    '</section>\n</main>';
}

function statusBody(data) {
  const s = data.boot.status || {};
  return '<main class="wrap">\n' +
    '<div id="healthGrid" class="healthgrid">' + healthCards(data.health) + '</div>\n' +
    '<div class="grid status">' +
      '<section class="card"><div class="hd"><h2>状态快照</h2><span class="hint">GET /api/status</span><span class="spacer"></span>' +
        '<button class="tbtn" type="button" id="copyStatus">复制 JSON</button></div>' +
        '<pre id="statusJson" class="jsonbox">' + esc(JSON.stringify(s, null, 2)) + '</pre></section>' +
      '<section class="card"><div class="hd"><h2>健康检查</h2><span class="hint">/api/health</span></div>' +
        '<div id="checks" class="checks">' + checksRows(data.health) + '</div></section>' +
    '</div>\n' +
    '<section class="card"><div class="hd"><h2>会话</h2><span class="hint">QQ 聊天 → DSH 会话</span></div>' +
      '<div id="sessionTable" class="tablewrap">' + sessionTable(s.chats || {}) + '</div></section>\n' +
    '</main>';
}

function kpi(label, value, sub, cls) {
  return '<div class="kpi"><span class="lb">' + esc(label) + '</span><span class="vl ' + (cls || '') + '">' + esc(value) + '</span>' +
    '<span class="sb">' + esc(sub) + '</span></div>';
}

function onebotSub(s) {
  const ob = s.onebot || {};
// [缺失第 795 行]
// [缺失第 796 行]
// [缺失第 797 行]
// [缺失第 798 行]
// [缺失第 799 行]
// [缺失第 800 行]
// [缺失第 801 行]
// [缺失第 802 行]
// [缺失第 803 行]
// [缺失第 804 行]
// [缺失第 805 行]
// [缺失第 806 行]
// [缺失第 807 行]
// [缺失第 808 行]
// [缺失第 809 行]
// [缺失第 810 行]
// [缺失第 811 行]
// [缺失第 812 行]
// [缺失第 813 行]
// [缺失第 814 行]
// [缺失第 815 行]
// [缺失第 816 行]
// [缺失第 817 行]
// [缺失第 818 行]
// [缺失第 819 行]
// [缺失第 820 行]
// [缺失第 821 行]
// [缺失第 822 行]
// [缺失第 823 行]
// [缺失第 824 行]
// [缺失第 825 行]
// [缺失第 826 行]
// [缺失第 827 行]
// [缺失第 828 行]
// [缺失第 829 行]
// [缺失第 830 行]
// [缺失第 831 行]
// [缺失第 832 行]
// [缺失第 833 行]
// [缺失第 834 行]
// [缺失第 835 行]
// [缺失第 836 行]
// [缺失第 837 行]
// [缺失第 838 行]
// [缺失第 839 行]
// [缺失第 840 行]
// [缺失第 841 行]
// [缺失第 842 行]
// [缺失第 843 行]
// [缺失第 844 行]
// [缺失第 845 行]
// [缺失第 846 行]
// [缺失第 847 行]
// [缺失第 848 行]
// [缺失第 849 行]
// [缺失第 850 行]
// [缺失第 851 行]
// [缺失第 852 行]
// [缺失第 853 行]
// [缺失第 854 行]
// [缺失第 855 行]
// [缺失第 856 行]
// [缺失第 857 行]
// [缺失第 858 行]
// [缺失第 859 行]
// [缺失第 860 行]
// [缺失第 861 行]
// [缺失第 862 行]
// [缺失第 863 行]
// [缺失第 864 行]
// [缺失第 865 行]
// [缺失第 866 行]
// [缺失第 867 行]
// [缺失第 868 行]
// [缺失第 869 行]
// [缺失第 870 行]
// [缺失第 871 行]
// [缺失第 872 行]
// [缺失第 873 行]

function guardLabel(g) {
  if (!g) return '—';
  if (g.available === false) return '无心跳';
  if (!g.last_tick) return '—';
  return 'tick ' + ago(Date.parse(g.last_tick)) + ' · job ' + (g.job_registered ? '已注册' : '未注册');
}

function eventRow(ev) {
  const kind = String(ev.kind || 'info').replace(/[^a-z-]/g, '');
  const meta = kindMeta(kind);
  return '<div class="feed-row k-' + kind + '"><span class="tm">' + hhmmss(ev.at) + '</span>' +
    '<span class="ev" style="color:' + meta.color + '">' + esc(meta.tag) + '</span>' +
    '<span class="ms" title="' + esc(dataTitle(ev)) + '">' + esc(ev.text || '') + '</span></div>';
}

function logRow(ev) {
  const kind = String(ev.kind || 'info').replace(/[^a-z-]/g, '');
  const meta = kindMeta(kind);
  return '<div class="logline k-' + kind + '"><span class="tm">' + hhmmss(ev.at) + '</span>' +
    '<span class="ev" style="color:' + meta.color + '">' + esc(meta.tag) + '</span>' +
    '<span class="ms">' + esc(ev.text || '') + '</span></div>';
}

function kindMeta(kind) {
  const map = {
    in: { tag: '收', color: 'var(--in)' }, out: { tag: '发', color: 'var(--out)' },
    turn: { tag: '轮', color: 'var(--turn)' }, action: { tag: '动', color: 'var(--action)' },
    alert: { tag: '警', color: 'var(--alert)' }, warn: { tag: '!', color: 'var(--warn)' },
    error: { tag: '×', color: 'var(--err)' }, state: { tag: '态', color: 'var(--state)' }
  };
  return map[kind] || { tag: '·', color: 'var(--state)' };
}

function dataTitle(ev) {
  if (!ev.data) return '';
  try { return JSON.stringify(ev.data); } catch { return ''; }
}

function chatRows(chats) {
  const keys = Object.keys(chats || {}).sort();
  if (!keys.length) return '<div class="empty">暂无会话，等第一条 QQ 消息。</div>';
  return keys.map((k) => {
    const ch = chats[k] || {};
    const isGroup = k.indexOf('group:') === 0;
    const sid = ch.sessionId ? short(String(ch.sessionId).replace(/^session-/, ''), 14) : '未建会话';
    return '<div class="chat"><span class="av">' + (isGroup ? '群' : '友') + '</span>' +
      '<div class="info"><div class="nm mono">' + esc(k) + '</div><div class="sub">' + esc(sid + ' · ' + (ch.workspace || '—')) +
      (ch.turns === null || ch.turns === undefined ? ' · 轮数未知' : ' · ' + ch.turns + ' 轮') + '</div></div>' +
      (ch.sessionId ? '<button class="tbtn copy" type="button" data-copy="' + esc(ch.sessionId) + '">复制 id</button>' : '') +
      '</div>';
  }).join('');
}

function sessionTable(chats) {
  const keys = Object.keys(chats || {}).sort();
  if (!keys.length) return '<div class="empty">暂无会话。</div>';
  return '<table class="table"><thead><tr><th>聊天</th><th>工作区</th><th>会话 id</th><th>轮数</th><th></th></tr></thead><tbody>' +
    keys.map((k) => {
      const ch = chats[k] || {};
      return '<tr><td class="mono">' + esc(k) + '</td><td class="mono ellipsis" title="' + esc(ch.workspace || '') + '">' + esc(ch.workspace || '—') +
        '</td><td class="mono">' + esc(ch.sessionId || '未建会话') + '</td><td class="num">' + esc(ch.turns === null || ch.turns === undefined ? '未知' : ch.turns) +
        '</td><td>' + (ch.sessionId ? '<button class="tbtn copy" type="button" data-copy="' + esc(ch.sessionId) + '">复制</button>' : '') + '</td></tr>';
    }).join('') + '</tbody></table>';
}

/* ── 表单 ───────────────────────────────────────────────── */

function field(label, path, opts = {}) {
  const type = opts.type || 'text';
  const id = 'f-' + String(path).replace(/[^a-zA-Z0-9_-]/g, '-');
  const value = opts.value === undefined || opts.value === null ? '' : String(opts.value);
  const common = ' id="' + id + '" data-path="' + esc(path) + '" data-type="' + type + '"' +
    (opts.readonly ? ' readonly' : '') + (opts.step ? ' step="' + esc(opts.step) + '"' : '') +
    (opts.placeholder ? ' placeholder="' + esc(opts.placeholder) + '"' : '');
  let control;
  if (type === 'select') {
    control = '<select' + common + '>' + (opts.options || []).map(([v, l]) =>
      '<option value="' + esc(v) + '"' + (String(v) === value ? ' selected' : '') + '>' + esc(l) + '</option>').join('') + '</select>';
  } else {
    control = '<input' + common + ' type="' + (type === 'number' ? 'number' : 'text') + '" value="' + esc(value) + '"' +
      (type === 'number' ? ' inputmode="decimal"' : '') + '>';
  }
  return '<div class="field"><label for="' + id + '">' + esc(label) + '</label>' + control +
    (opts.hint ? '<span class="hint">' + esc(opts.hint) + '</span>' : '') + '</div>';
}

function secretField(label, path, value) {
  const id = 'f-' + path.replace(/[^a-zA-Z0-9_-]/g, '-');
  return '<div class="field"><label for="' + id + '">' + esc(label) + '</label>' +
    '<input id="' + id + '" data-path="' + esc(path) + '" data-type="secret" type="password" class="mono" autocomplete="off" ' +
    'placeholder="' + (value ? '已设置（留空保持不变）' : '未设置') + '">' +
    '<span class="hint">不会回显；留空保持当前值</span></div>';
}

function checkbox(label, path, checked) {
}

function ago(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const s = Math.max(0, Math.floor((Date.now() - n) / 1000));
  if (s < 60) return s + ' 秒前';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  return Math.floor(s / 86400) + ' 天前';
}

function dur(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '—';
  const s = Math.floor(n / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
  if (d) return d + 'd ' + h + 'h';
  if (h) return h + 'h ' + m + 'm';
  if (m) return m + 'm ' + (s % 60) + 's';
  return s + 's';
