/**
 * 目的：在一轮回复期间发出「正在输入」状态（NapCat 的 set_input_status），
 *       让对面看到"对方正在输入…"，而不是发完才突然出现一大段字。
 * 边界：只决定「什么时候发、发开始还是停止」；真正的网络请求由调用方注入（send）。
 *       只对私聊有意义——NapCat 只实现了 C2C 的输入状态，群聊发了没效果。
 * 依赖：无（计时器与发送函数都可注入）；被 bridge.mjs 与 test-typing.mjs 引用。
 * 失败：注入的 send 抛错/拒绝只走 onError，绝不冒泡打断这一轮回复。
 * 副作用：占一个 setInterval；stop() 之后不再有任何计时器残留。
 */

/**
 * 默认参数。数值不是随手写的：
 * - keepaliveMs=8000：NapCat 侧的输入状态会被客户端丢掉，8 秒续一次刚好在消失前刷新
 *   （旧版 persona 的默认值就是 8000，见 docs/拟人化-复原对照.md）。
 * - eventStart=0 / eventStop=1：OneBot 11 的 set_input_status 约定（0 开始、1 停止）。
 *   若某个 NapCat 版本反过来，改配置即可，不用改代码。
 */
export const DEFAULT_TYPING = Object.freeze({
  enabled: true,
  keepaliveMs: 8000,
  eventStart: 0,
  eventStop: 1,
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 目的：造一个输入状态开关，start() 亮起、stop() 关闭。
 * 输入：opts.enabled 总开关；opts.keepaliveMs 续期间隔（0=只亮一次）；
 *       opts.eventStart/eventStop 事件类型；opts.send(type) 真正发包；
 *       opts.setTimer/clearTimer 可注入（单测用假定时器）；opts.onError 出错回调。
 * 输出：{ start, stop, stats }；stats() 返回 { running, sent, lastType }。
 * 失败：不抛错；send 抛错只调 onError 并记一次 failed。
 * 副作用：start 之后按 keepaliveMs 周期调用 send；stop 清掉计时器并只发一次停止。
 */
export function createTyping(opts = {}) {
  const o = { ...DEFAULT_TYPING, ...opts };
  const keepaliveMs = clamp(Number(o.keepaliveMs ?? DEFAULT_TYPING.keepaliveMs), 0, 120000);
  const setT = typeof o.setTimer === 'function' ? o.setTimer : setInterval;
  const clearT = typeof o.clearTimer === 'function' ? o.clearTimer : clearInterval;
  const onError = typeof o.onError === 'function' ? o.onError : () => {};

  let running = false;
  let sent = 0;
  let failed = 0;
  let lastType = null;
  let timer = null;

  function fire(type, why) {
    lastType = type;
    sent++;
    try {
      const r = o.send ? o.send(type) : null;
      // 发送是异步的：拒绝不能变成 unhandledRejection，否则整个桥接器会被带走。
      if (r && typeof r.catch === 'function') {
        r.catch((e) => { failed++; onError(e, why); });
      }
    } catch (e) {
      failed++;
      onError(e, why);
    }
  }

  function start() {
    if (!o.enabled || running) return false;
    running = true;
    fire(o.eventStart, 'start');
    if (keepaliveMs > 0) {
      timer = setT(() => { if (running) fire(o.eventStart, 'keepalive'); }, keepaliveMs);
      // node 里别让一个心跳把进程钉住（浏览器/测试环境没有 unref）
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
    return true;
  }

  function stop() {
    if (!running) return false;
    running = false;
    if (timer != null) { clearT(timer); timer = null; }
    fire(o.eventStop, 'stop');
    return true;
  }

  return {
    start,
    stop,
    stats: () => ({ running, sent, failed, lastType, keepaliveMs }),
  };
}

/** 目的：给面板/doctor 一句话说明当前输入状态的设置。 */
export function describeTyping(opts = {}) {
  const o = { ...DEFAULT_TYPING, ...opts };
  if (o.enabled === false) return '关（不发「正在输入」）';
  const k = clamp(Number(o.keepaliveMs ?? DEFAULT_TYPING.keepaliveMs), 0, 120000);
  return `私聊开启${k > 0 ? ` · 每 ${Math.round(k / 1000)}s 续一次` : ' · 不续期'}`;
}
