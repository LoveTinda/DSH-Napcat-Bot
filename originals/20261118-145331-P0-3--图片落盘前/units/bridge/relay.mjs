/**
 * 目的：DSH 连续失败时别再一条条回「出错了」——进入维护期，用一句维护文案统一回应，
 *       并在冷却时间内不再重复刷。旧机器人叫 relay（维护期自动回复）。
 * 边界：只决定「这轮该不该用维护文案、用什么」；不发消息、不改会话。
 * 依赖：无（纯状态机 + 可注入时钟）；被 bridge.mjs 与 test-relay.mjs 引用。
 * 失败：不抛错；任何异常输入按「不进维护期」处理，避免把正常失败盖掉。
 */

/** 默认参数：连续 3 次失败算「挂了」；维护文案 2 分钟内只发一次。 */
export const DEFAULT_RELAY = Object.freeze({
  enabled: true,
  /** 连续失败几次算进入维护期 */
  afterFailures: 3,
  /** 维护文案冷却（毫秒）：冷却内只回一次，避免刷屏 */
  cooldownMs: 2 * 60 * 1000,
  /** 维护文案；{error} 会被替换成一句脱敏后的原因 */
  message: '机器人正在维护，稍后再试。',
});

/**
 * 目的：创建一个维护期判定器。
 * 输入：参数（覆盖 DEFAULT_RELAY），opts.now 可注入时钟（测试用）。
 * 输出：{ fail, ok, shouldRelay, text, stats, describe }
 * 失败：不抛错。副作用：只改自己的计数。
 */
export function createRelay(opts = {}) {
  const o = { ...DEFAULT_RELAY, ...opts };
  const now = typeof o.now === 'function' ? o.now : Date.now;
  let streak = 0;        // 连续失败次数
  let lastRelayAt = 0;   // 上次发维护文案的时间
  let relayed = 0;       // 累计发过几次维护文案
  let suppressed = 0;    // 冷却期内被压掉的次数

  return {
    /** 目的：记一次成功——退出维护期。输入：无；输出：无。 */
    ok() {
      streak = 0;
    },

    /** 目的：记一次失败。输入：可选原因；输出：无。 */
    fail() {
      streak += 1;
    },

    /**
     * 目的：这一轮该不该用维护文案。
     * 输入：无；输出：{ relay: boolean, text: string }；relay=false 时 text 为空串。
     * 失败：不抛错。副作用：relay=true 时更新冷却时间与计数。
     */
    shouldRelay() {
      if (!o.enabled) return { relay: false, text: '' };
      if (streak < Math.max(1, Number(o.afterFailures) || 1)) return { relay: false, text: '' };
      const t = now();
      if (lastRelayAt && t - lastRelayAt < Number(o.cooldownMs)) {
        suppressed += 1;
        return { relay: false, text: '' };
      }
      lastRelayAt = t;
      relayed += 1;
      return { relay: true, text: String(o.message) };
    },

    /** 目的：给面板用的统计。输入：无；输出：{ enabled, streak, relayed, suppressed, lastRelayAt, afterFailures }。 */
    stats() {
      return {
        enabled: !!o.enabled,
        streak,
        relayed,
        suppressed,
        lastRelayAt,
        afterFailures: Number(o.afterFailures) || 1,
      };
    },

    /** 目的：一句话摘要，给面板/日志用。 */
    describe() {
      if (!o.enabled) return '关闭';
      return '开 · 连续失败 ' + (Number(o.afterFailures) || 1) + ' 次进入维护期 · 冷却 ' + Math.round(Number(o.cooldownMs) / 1000) + ' 秒';
    },
  };
}
