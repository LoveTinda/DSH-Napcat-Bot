/**
 * 目的：OneBot 11 客户端：forward-ws / http 事件与动作调用。
 * 边界：不解析业务消息，只收发原始事件。
 * 依赖：node:http/ws；被 index/bridge 调用。
 * 失败：断线自动重连；调用失败 reject。
 */
import http from 'node:http';
import { EventEmitter } from 'node:events';

/**
 * 最小 OneBot 11 客户端：forward-ws（默认）或 http（NapCat httpClients 推事件）。
 * 只实现 bridge 需要的 call/sendTo/事件；断线自动重连，不阻塞启动。
 */
export class OneBot extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.cfg = cfg;
    this.mode = cfg.mode || 'forward-ws';
    // HTTP 模式：url 是 NapCat 的动作地址（默认 3001），listenPort 是本桥接收事件的端口
    // （默认 3002，不能和 NapCat 的 HTTP 服务抢同一个端口）。
    this.url = cfg.url || (this.mode === 'http'
      ? 'http://127.0.0.1:3001'
      : 'ws://127.0.0.1:' + (cfg.listenPort || 3001));
    this.accessToken = cfg.accessToken || '';
    this.reconnectMs = Math.max(500, Number(cfg.reconnectMs) || 3000);
    this.online = false;
    this.selfId = null;
    this.ws = null;
    this.httpServer = null;
    this.pending = new Map();
    this.echo = 0;
    this.closed = false;
    this.timer = null;
  }

  start() {
    this.closed = false;
    if (this.mode === 'http') return this.startHttp();
    this.connect();
    return this;
  }

  startHttp() {
    const host = this.cfg.listenHost || '127.0.0.1';
    // 3001 是 NapCat 自己的 HTTP 服务；桥接收事件默认用 3002，避免端口冲突。
    const port = Number(this.cfg.listenPort) || 3002;
    this.httpServer = http.createServer((req, res) => {
      if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c) => { if (body.length < 4 * 1024 * 1024) body += c; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body || '{}');
          if (data.self_id) this.selfId = data.self_id;
          if (data.post_type) this.emit('event', data);
        } catch {}
        res.writeHead(204); res.end();
      });
    });
    this.httpServer.on('error', () => {
      this.online = false;
      this.emit('offline');
    });
    this.httpServer.listen(port, host, () => {
      this.online = true;
      this.emit('online');
    });
    return this;
  }

  stop() {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.ws && this.ws.close(); } catch {}
    try { this.httpServer && this.httpServer.close(); } catch {}
    this.ws = null;
    this.httpServer = null;
    this.online = false;
  }

  connect() {
    if (this.closed) return;
    if (this.mode !== 'forward-ws') {
      this.online = false;
      this.emit('offline');
      return;
    }
    const WS = globalThis.WebSocket;
    if (!WS) {
      this.emit('offline');
      return;
    }
    const headers = this.accessToken ? { authorization: 'Bearer ' + this.accessToken } : {};
    let ws;
    try { ws = new WS(this.url, { headers }); } catch { this.schedule(); return; }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.online = true;
      this.emit('online');
    });
    ws.addEventListener('message', (ev) => {
      let data;
      try { data = JSON.parse(String(ev.data)); } catch { return; }
      if (data.echo !== undefined && this.pending.has(data.echo)) {
        const p = this.pending.get(data.echo);
        this.pending.delete(data.echo);
        if (data.status === 'failed' || data.retcode !== 0) {
          p.reject(new Error(data.message || data.wording || ('OneBot ' + data.retcode)));
        } else {
          p.resolve(data.data);
        }
        return;
      }
      if (data.post_type) {
        if (data.self_id) this.selfId = data.self_id;
        this.emit('event', data);
      }
    });
    const down = () => {
      const was = this.online;
      this.online = false;
      this.ws = null;
      for (const p of this.pending.values()) p.reject(new Error('OneBot 连接已断开'));
      this.pending.clear();
      if (was) this.emit('offline');
      this.schedule();
    };
    ws.addEventListener('close', down);
    ws.addEventListener('error', down);
  }

  schedule() {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, this.reconnectMs);
  }

  async callHttp(action, params, timeoutMs) {
    const base = String(this.url || '').replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json' };
    if (this.accessToken) headers.authorization = 'Bearer ' + this.accessToken;
    const res = await fetch(base + '/' + action, {
      method: 'POST', headers, body: JSON.stringify(params),
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 15000))
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status === 'failed' || (data.retcode !== undefined && data.retcode !== 0)) {
      throw new Error(data.message || data.wording || ('OneBot HTTP ' + res.status));
    }
    return data.data !== undefined ? data.data : data;
  }

  call(action, params = {}, timeoutMs = 15000) {
    if (this.mode === 'http') {
      if (!this.online) return Promise.reject(new Error('OneBot 不在线'));
      return this.callHttp(action, params, timeoutMs);
    }
    if (!this.online || !this.ws) return Promise.reject(new Error('OneBot 不在线'));
    const echo = 'c' + (++this.echo);
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(echo);
        reject(new Error('OneBot 调用超时：' + action));
      }, Math.max(1000, Number(timeoutMs) || 15000));
      this.pending.set(echo, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); }
      });
      try {
        this.ws.send(JSON.stringify({ action, params, echo }));
      } catch (err) {
        clearTimeout(t);
        this.pending.delete(echo);
        reject(err);
      }
    });
  }

  sendTo(target, segments) {
    const t = target || {};
    if (t.kind === 'group') {
      return this.call('send_group_msg', { group_id: String(t.id), message: segments }, 20000);
    }
    return this.call('send_private_msg', { user_id: String(t.id), message: segments }, 20000);
  }
}
