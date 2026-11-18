import process from "node:process";

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
let threshold = LEVELS[process.env.BRIDGE_LOG_LEVEL] ?? LEVELS.info;

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
  (level === "error" ? process.stderr : process.stdout).write(line);
}

export function logger(scope) {
  return {
    error: (...a) => emit("error", scope, a),
    warn: (...a) => emit("warn", scope, a),
    info: (...a) => emit("info", scope, a),
    debug: (...a) => emit("debug", scope, a)
  };
}
