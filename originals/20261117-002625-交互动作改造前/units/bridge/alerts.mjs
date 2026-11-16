// 目的：把「连续失败」「磁盘将满」变成有节流的告警判定，供桥接器在合适的时候给号主发一条 QQ。
// 边界：只做判定（该不该告警、要不要压掉），不负责发消息、不写文件、不认识 DSH/OneBot；
//       不持久化节流状态——重启后最多多告一次，不会漏告。
// 依赖：node:fs 的 statfsSync（node ≥ 18.15）；被 units/bridge/bridge.mjs 引用，被 test-alert.mjs 单测。
// 失败：statfs 失败返回 null（调用方跳过本轮），不抛错；参数非法时退到默认值，不阻断桥接器启动。

import fs from 'node:fs';

// 这三个数是「为什么是它」而不是拍脑袋：
// - 连续 3 次失败：一次失败常是单条消息/单轮 DSH 的问题，连着 3 次才像上游整体坏了；
// - 默认 30 分钟冷却：告警是给手机看的一条 QQ，不是日志，宁可晚一点也不能刷屏；
// - 磁盘 90%：日志和会话表还要留出写盘空间，超过 90% 通常一两小时内就会满。
const DEFAULT_FAIL_STREAK = 3;
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * 目的：维护「连续失败次数」与「某类告警上次发送时间」，决定这一轮要不要真的发告警。
 * 输入：{ failStreak?: number, cooldownMs?: number, now?: () => number }；
 *       now 可注入，单测用来跳过真实时间。
 * 输出：{ recordFailure(), recordSuccess(), allowDisk(), markSent(kind), stats() }。
 * 失败：不抛错；非法数字退到默认值。
 * 副作用：只改内存里的计数与时间戳。
 */
export function createAlertGate(opts = {}) {
  const failStreak = Number.isFinite(opts.failStreak) && opts.failStreak > 0
    ? Math.floor(opts.failStreak) : DEFAULT_FAIL_STREAK;
  const cooldownMs = Number.isFinite(opts.cooldownMs) && opts.cooldownMs > 0
    ? Math.floor(opts.cooldownMs) : DEFAULT_COOLDOWN_MS;
  const now = typeof opts.now === 'function' ? opts.now : Date.now;

  let failures = 0;
  const lastSent = new Map();   // kind → 毫秒时间戳
  const stats = { sent: 0, suppressed: 0, lastKind: '', lastAt: 0 };

  /** 目的：某类告警是否已过冷却；未过冷却时把 suppressed +1，便于面板看出被压了几次。 */
  function cooled(kind) {
    // 从没发过 = 不冷却；不能用「时间戳 0」当哨兵，否则注入的假时钟从 0 开始时永远判成冷却中。
    if (!lastSent.has(kind)) return true;
    if (now() - lastSent.get(kind) < cooldownMs) { stats.suppressed++; return false; }
    return true;
  }

  return {
    /** 目的：记一次失败；返回 true 表示「连续失败达阈值且不在冷却中」，调用方应发告警。 */
    recordFailure() {
      failures++;
      return failures >= failStreak && cooled('fail');
    },
    /** 目的：记一次成功，把连续失败清零；调用方在每轮成功回发后调用。 */
    recordSuccess() { failures = 0; },
    /** 目的：磁盘告警是否可发（受同一个冷却窗口约束）。 */
    allowDisk() { return cooled('disk'); },
    /** 目的：真正发出后登记，用于冷却与统计；kind 为 'fail' 或 'disk'。 */
    markSent(kind) {
      lastSent.set(kind, now());
      stats.sent++;
      stats.lastKind = kind;
      stats.lastAt = now();
    },
    /** 目的：给面板/状态接口的一份只读快照。 */
    stats() { return { ...stats, streak: failures, failStreak, cooldownMs }; },
  };
}

/**
 * 目的：算某个目录所在文件系统的已用百分比，用来判断要不要报「磁盘将满」。
 * 输入：任意已存在目录；不存在时也能算它最近的父目录。
 * 输出：0–100 的整数；拿不到（老 node、路径不存在、权限不足）返回 null。
 * 失败：不抛错；调用方把 null 当「本轮不判断」。
 * 副作用：无（只读 statfs）。
 */
export function diskUsedPercent(dir) {
  if (!dir) return null;
  try {
    const s = fs.statfsSync(dir);
    const total = Number(s.blocks) * Number(s.bsize);
    const free = Number(s.bavail) * Number(s.bsize);
    if (!Number.isFinite(total) || total <= 0) return null;
    const used = total - free;
    return Math.min(100, Math.max(0, Math.round((used / total) * 100)));
  } catch {
    return null;
  }
}

/**
 * 目的：把号主的 QQ 打码后再放进面板/日志，避免截图外发时顺带泄露。
 * 输入：字符串或数字；输出：≤4 位时原样，否则保留前 2 位与后 2 位。
 * 失败：不抛错；空值返回空串。
 * 副作用：无。
 */
export function maskQq(qq) {
  const s = String(qq == null ? '' : qq).trim();
  if (s.length <= 4) return s;
  return s.slice(0, 2) + '*'.repeat(s.length - 4) + s.slice(-2);
}
