import fs from 'node:fs';
import path from 'node:path';

const RING = 300;

/** 状态板：落盘 status.json，并向面板/SSE 提供只读快照。 */
export class StatusBoard {
  constructor(file) {
    this.file = file;
    this.listeners = new Set();
    this.aux = null;
    this.state = {
      state: 'starting',
      since: new Date().toISOString(),
      onebot: { mode: '', url: '', connected: false, selfId: null },
      dsh: { profile: '', workspace: '', running: 0, maxConcurrent: 1 },
      panel: null,
      counters: { inbound: 0, outbound: 0, denied: 0, errors: 0, actions: 0, injected: 0, sessionForks: 0 },
      chats: {},
      events: [],
      alert: null,
      lastError: null
    };
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') this.state = { ...this.state, ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    if (!Array.isArray(this.state.events)) this.state.events = [];
    if (!this.state.counters) this.state.counters = {};
  }
  start() { this.state.state = 'standby'; this.save(); }
  stop() { this.state.state = 'stopping'; this.save(); }
  update(fn) {
    if (typeof fn === 'function') fn(this.state);
    this.save();
    return this.snapshot();
  }
  count(key, n = 1) {
    this.state.counters[key] = (this.state.counters[key] || 0) + n;
    this.save();
  }
  emitEvent(kind, text) {
    const ev = { kind, text: String(text || ''), at: Date.now() };
    this.state.events.push(ev);
    if (this.state.events.length > RING) this.state.events.splice(0, this.state.events.length - RING);
    for (const fn of this.listeners) { try { fn(ev); } catch {} }
    this.save();
    return ev;
  }
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  provideAux(fn) { this.aux = fn; }
  setAlert(alert) { this.state.alert = alert || null; this.save(); }
  isSuspended() {
    const a = this.state.alert;
    return !!(a && a.suspended && (!a.until || a.until > Date.now()));
  }
  snapshot() {
    let aux = null;
    try { aux = this.aux ? this.aux() : null; } catch {}
    return { ...this.state, aux, state: this.state.state };
  }
  get json() { return JSON.stringify(this.snapshot()); }
  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = this.file + '.tmp-' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {}
  }
}
