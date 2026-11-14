import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { logger } from './log.js';

const log = logger('event');

export const DEFAULT_EVENT_LOG_MAX_BYTES = 50 * 1024 * 1024;

/**
 * 事件库：把“重要事件”同时写成
 *   1. state/events/events.jsonl  —— 完整结构化记录（含消息/回复全文，供详情页读取）
 *   2. bridge.log                 —— 一行摘要 + 详情链接（通过 logger）
 *
 * 为什么要单独一份事件库：bridge.log 只适合“看一行”，消息全文和结构化字段
 * 塞进去既难读又会把 50MB 很快吃满。面板的 /logs/e/<id> 从事件库读全文，
 * 日志行只保留 trace、方向和链接，做到“有始有终、可点开核对”。
 *
 * 轮转：单文件默认 50MB；写满后 active → .1，再写新的 active（最多保留 2 份）。
 * 详情查询会同时扫 active 和归档，所以轮转不会让刚发生的链接立刻失效。
 */
export function createEventLog(dir, opts = {}) {
  const maxBytes = positiveInt(opts.maxBytes, DEFAULT_EVENT_LOG_MAX_BYTES);
  const maxFiles = Math.max(2, Math.min(5, positiveInt(opts.maxFiles, 2)));
  const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
  const file = path.join(dir, 'events.jsonl');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}

  let seq = 0;
  let traceSeq = 0;
  let size = fileSize(file);
  const recent = new Map();
  const recentIds = [];
  const RECENT_MAX = 5000;

  function urlFor(id) {
    return (baseUrl || '') + '/logs/e/' + encodeURIComponent(id);
  }

  function rotate() {
    try { fs.rmSync(file + '.' + (maxFiles - 1), { force: true }); } catch {}
    for (let i = maxFiles - 2; i >= 1; i--) {
      try { fs.renameSync(file + '.' + i, file + '.' + (i + 1)); } catch {}
    }
    try { fs.renameSync(file, file + '.1'); } catch {}
    size = 0;
    log.info('事件日志轮转：' + file + ' → ' + file + '.1（上限 ' + maxBytes + ' 字节）');
  }

  function record(input = {}) {
    const at = Date.now();
    const kind = String(input.kind || 'info');
    const level = input.level || levelFor(kind);
    const id = 'e-' + at.toString(36) + '-' + (++seq).toString(36);
    const ev = {
      id,
      at,
      iso: new Date(at).toISOString(),
      kind,
      level,
      traceId: input.traceId || null,
      chatKey: input.chatKey || null,
      messageId: input.messageId ?? null,
      senderId: input.senderId ?? null,
      senderName: input.senderName ?? null,
      summary: oneLine(input.summary || ''),
      text: typeof input.text === 'string' ? input.text : (input.text == null ? '' : String(input.text)),
      data: input.data && typeof input.data === 'object' ? input.data : null,
      url: urlFor(id)
    };
    const line = JSON.stringify(ev) + '\n';
    const bytes = Buffer.byteLength(line);
    try {
      if (size + bytes > maxBytes) rotate();
      fs.appendFileSync(file, line, { mode: 0o600 });
      size += bytes;
    } catch (err) {
      log.warn('事件库写入失败：' + (err && err.message));
    }

    recent.set(id, ev);
    recentIds.push(id);
    while (recentIds.length > RECENT_MAX) recent.delete(recentIds.shift());

    const suffix = (ev.traceId ? ' · trace ' + ev.traceId : '') + ' · 详情 ' + ev.url;
    const fn = level === 'error' ? log.error : level === 'warn' ? log.warn : log.info;
    try { fn('[' + ev.kind + '] ' + ev.summary + suffix); } catch {}
    return ev;
  }

  function newTrace() {
    const at = Date.now();
    return 't-' + at.toString(36) + '-' + (++traceSeq).toString(36);
  }

  async function get(id) {
    const wanted = String(id || '');
    if (!wanted) return null;
    if (recent.has(wanted)) return recent.get(wanted);
    let found = null;
    await scan(async (ev) => {
      if (ev.id === wanted) { found = ev; return true; }
      return false;
    });
    return found;
  }

  /**
   * 同一 trace 的所有事件，按时间正序。用于详情页把“收到 → 开始回合 →
   * 回复 → 投递”串成一条链。先查内存，再扫盘（进程重启后也能查）。
   */
  async function byTrace(traceId, limit = 200) {
    const wanted = String(traceId || '');
    if (!wanted) return [];
    const map = new Map();
    for (const ev of recent.values()) {
      if (ev.traceId === wanted) map.set(ev.id, ev);
    }
    await scan(async (ev) => {
      if (ev.traceId === wanted) map.set(ev.id, ev);
      return false;
    });
    return [...map.values()].sort((a, b) => a.at - b.at).slice(-Math.max(1, limit));
  }

  /** 详情页右侧/接口用：最近 N 条，仅仅用于“最近发生了什么”。 */
  function latest(limit = 50) {
    return recentIds.slice(-Math.max(1, limit)).map((id) => recent.get(id)).filter(Boolean);
  }

  function stats() {
    return {
      file,
      size,
      maxBytes,
      maxFiles,
      archived: files().slice(1).map((f) => ({ file: f, size: fileSize(f) })),
      recent: recent.size
    };
  }

  function files() {
    const out = [file];
    for (let i = 1; i < maxFiles; i++) out.push(file + '.' + i);
    return out;
  }

  async function scan(predicate) {
    for (const f of files()) {
      if (!fs.existsSync(f)) continue;
      const stream = fs.createReadStream(f, { encoding: 'utf8' });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
      try {
        for await (const line of rl) {
          if (!line) continue;
          let ev;
          try { ev = JSON.parse(line); } catch { continue; }
          if (await predicate(ev)) return ev;
        }
      } finally {
        rl.close();
        stream.destroy();
      }
    }
    return null;
  }

  return { dir, file, record, newTrace, get, byTrace, latest, stats, urlFor };
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

function levelFor(kind) {
  if (kind === 'error' || kind === 'alert') return 'error';
  if (kind === 'warn' || kind === 'deny') return 'warn';
  return 'info';
}

function oneLine(text) {
  return String(text || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}
