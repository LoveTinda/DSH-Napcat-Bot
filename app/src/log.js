import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let threshold = LEVELS[process.env.BRIDGE_LOG_LEVEL] ?? LEVELS.info;

export const DEFAULT_LOG_MAX_BYTES = 50 * 1024 * 1024;

let sink = null;

/**
 * bridge.log 的文件写入（带 50MB 轮转）。
 *
 * 以前日志是启动脚本 `>> bridge.log` 直接重定向的：进程写得多满都没人管，
 * 也无法在进程内轮转（fd 已指向旧 inode）。现在由 Node 自己写：
 *   · 单文件默认 50MB；写满后 active → .1（默认保留 1 份归档）；
 *   · 终端仍照常输出，前台跑 `node src/index.js` 时体验不变；
 *   · 启动脚本把 stdout/stderr 指到 /dev/null，避免同一条写两遍。
 */
export function initFileLog(options = {}) {
  const file = String(options.file || '').trim();
  if (!file) { sink = null; return null; }
  const maxBytes = positiveInt(options.maxBytes, DEFAULT_LOG_MAX_BYTES);
  const maxFiles = Math.max(2, Math.min(5, positiveInt(options.maxFiles, 2)));
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    sink = {
      file,
      maxBytes,
      maxFiles,
      size: fileSize(file),
      disabled: false
    };
    try { fs.chmodSync(file, 0o600); } catch {}
  } catch (err) {
    sink = { disabled: true, error: err && err.message };
    process.stderr.write('[' + new Date().toISOString() + '] WARN  [log] bridge.log 初始化失败：' +
      (err && err.message ? err.message : err) + '\n');
  }
  return sink;
}

if (process.env.BRIDGE_LOG_FILE) {
  initFileLog({
    file: process.env.BRIDGE_LOG_FILE,
    maxBytes: process.env.BRIDGE_LOG_MAX_BYTES,
    maxFiles: process.env.BRIDGE_LOG_MAX_FILES
  });
}

export function setLevel(name) {
  if (name in LEVELS) threshold = LEVELS[name];
}

function fmt(v) {
  if (typeof v === "string") return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

function emit(level, scope, args) {
  if (LEVELS[level] > threshold) return;
  // 每条都带 PID：一旦出现两个实例交错写同一个日志，这是唯一能立刻看出来的线索
  // （排查「一条消息被回复两次」时，就是因为缺这个而绕了很久）
  const line = `[${new Date().toISOString()}] ${level.toUpperCase().padEnd(5)} [pid ${process.pid}] [${scope}] ${args.map(fmt).join(" ")}\n`;
  writeFile(line);
  (level === "error" ? process.stderr : process.stdout).write(line);
}

function writeFile(line) {
  if (!sink || sink.disabled) return;
  try {
    const bytes = Buffer.byteLength(line);
    if (sink.size + bytes > sink.maxBytes) rotate();
    fs.appendFileSync(sink.file, line, { mode: 0o600 });
    sink.size += bytes;
  } catch (err) {
    // 日志写失败不能反过来把业务打崩；只禁用 sink，交给 stderr 留一条。
    sink.disabled = true;
    try {
      process.stderr.write('[' + new Date().toISOString() + '] WARN  [log] bridge.log 写入失败，已停用文件日志：' +
        (err && err.message ? err.message : err) + '\n');
    } catch {}
  }
}

function rotate() {
  const file = sink.file;
  const maxFiles = sink.maxFiles;
  try { fs.rmSync(file + '.' + (maxFiles - 1), { force: true }); } catch {}
  for (let i = maxFiles - 2; i >= 1; i--) {
    try { fs.renameSync(file + '.' + i, file + '.' + (i + 1)); } catch {}
  }
  try { fs.renameSync(file, file + '.1'); } catch {}
  sink.size = 0;
  const marker = '[' + new Date().toISOString() + '] INFO  [pid ' + process.pid + '] [log] 日志轮转：' +
    file + ' → ' + file + '.1（单文件上限 ' + sink.maxBytes + ' 字节）\n';
  try {
    fs.appendFileSync(file, marker, { mode: 0o600 });
    sink.size = Buffer.byteLength(marker);
  } catch {}
}

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function fileSize(file) {
  try { return fs.statSync(file).size; } catch { return 0; }
}

export function logger(scope) {
  return {
    error: (...a) => emit("error", scope, a),
    warn: (...a) => emit("warn", scope, a),
    info: (...a) => emit("info", scope, a),
    debug: (...a) => emit("debug", scope, a)
  };
}
