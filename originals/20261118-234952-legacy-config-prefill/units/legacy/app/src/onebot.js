import { EventEmitter } from 'node:events';

/**
 * 最小 OneBot 11 客户端：默认正向 WebSocket。
 * 只实现 bridge 需要的 call/sendTo/事件；断线自动重连，不阻塞启动。
 */
export class OneBot extends EventEmitter {
  constructor(cfg = {}) {
    super();
    this.cfg = cfg;
    this.mode = cfg.mode || 'forward-ws';
    this.url = cfg.url || ('ws://127.0.0.1:' + (cfg.listenPort || 3001));
    this.accessToken = cfg.accessToken || '';
    this.reconnectMs = Math.max(500, Number(cfg.reconnectMs) || 3000);
    this.online = false;
    this.selfId = null;
    this.ws = null;
    this.pending = new Map();
    this.echo = 0;
    this.closed = false;
    this.timer = null;
  }

  start() {
    this.closed = false;
    this.connect();
    return this;
  }

  stop() {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    try { this.ws && this.ws.close(); } catch {}
    this.ws = null;
    this.online = false;
  }

  connect() {
    if (this.closed) return;
    if (this.mode !== 'forward-ws') {
      // reverse-ws/http 模式不在最小复原范围内；明确离线，不假装连上。
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

  call(action, params = {}, timeoutMs = 15000) {
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
