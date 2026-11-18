import fs from 'node:fs';
import path from 'node:path';

/** 事件 JSONL 环形日志；面板详情页用 baseUrl 拼链接。 */
export function createEventLog(dir, { baseUrl = '', maxBytes = 5 * 1024 * 1024, maxFiles = 5 } = {}) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, 'events.jsonl');
  function rotate() {
    try {
      if (!fs.existsSync(file) || fs.statSync(file).size < maxBytes) return;
      for (let i = maxFiles - 1; i >= 1; i--) {
        const a = file + '.' + i;
        const b = file + '.' + (i + 1);
        if (fs.existsSync(a)) fs.renameSync(a, b);
      }
      fs.renameSync(file, file + '.1');
    } catch {}
  }
  return {
    dir,
    baseUrl,
    write(ev = {}) {
      rotate();
      const row = { at: Date.now(), ...ev };
      try { fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 }); } catch {}
      return row;
    },
    recent(n = 100) {
      try {
        return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).slice(-n).map((s) => JSON.parse(s));
      } catch { return []; }
    },
    close() {}
  };
}
