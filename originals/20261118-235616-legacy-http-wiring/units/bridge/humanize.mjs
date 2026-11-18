/**
 * 目的：把一条模型回复拆成「像人发的」几条——按段落/句子切、每条有长度上限、
 *       条与条之间停顿一会儿再发；同时保证不拆坏代码块、总等待有上限。
 * 边界：只算「发几条、每条发什么、每条之前等多久」，不发消息、不睡觉；
 *       发送与等待由 bridge.mjs 执行（这样计划可单测，不用真的等）。
 * 依赖：无（纯函数 + 可注入的 rng）；被 bridge.mjs 与 test-humanize.mjs 引用。
 * 失败：不抛错；所有异常输入都退化成「一条、不等待」。
 */

/** 默认参数；数值不是随手写的，见每项后面的理由。 */
export const DEFAULT_HUMANIZE = Object.freeze({
  enabled: true,
  /** 单条字符上限：QQ 单条能发 4000+，但人不会一口气发 3000 字，240 左右更像聊天 */
  maxChars: 240,
  /** 最多分几条：超过 3 条就变成刷屏，剩下的并进最后一条 */
  maxBubbles: 3,
  /** 每字符对应的"打字"时间（毫秒）：25ms/字 ≈ 每秒 40 字，接近打字速度 */
  perCharMs: 25,
  /** 单条之前至少等这么久：太快像是先准备好的 */
  minDelayMs: 350,
  /** 单条之前最多等这么久：等太久像卡住了 */
  maxDelayMs: 1800,
  /** 整轮总等待上限：超过就压缩，别让用户等到以为挂了 */
  totalDelayCapMs: 4000,
  /** 抖动比例（0–1）：±25%，避免每次都一模一样的节奏 */
  jitter: 0.25,
});

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * 目的：把文本切成若干"消息块"，保证不切在代码围栏里、不乱切标点。
 * 输入：text 原文；opts.maxChars 单块上限（>=40），maxBubbles 最多几块。
 * 输出：字符串数组（至少 1 项，已 trim，已丢掉空块）。
 * 失败：不抛错；异常输入返回 ['']。
 * 副作用：无。
 */
export function splitBubbles(text, opts = {}) {
  const maxChars = clamp(Number(opts.maxChars ?? DEFAULT_HUMANIZE.maxChars), 40, 4000);
  const maxBubbles = clamp(Number(opts.maxBubbles ?? DEFAULT_HUMANIZE.maxBubbles), 1, 10);
  const raw = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (!raw) return [''];

  // 先按「代码围栏」切块：围栏内一律不切，整块当成一个单元。
  const units = [];
  let buf = [];
  let inFence = false;
  const flush = () => {
    if (!buf.length) return;
    const joined = buf.join('\n').trim();
    if (joined) units.push({ text: joined, code: false });
    buf = [];
  };
  for (const line of raw.split('\n')) {
    if (/^\s*```/.test(line)) {
      if (!inFence) { flush(); inFence = true; buf.push(line); }
      else { buf.push(line); const t = buf.join('\n').trim(); if (t) units.push({ text: t, code: true }); buf = []; inFence = false; }
      continue;
    }
    buf.push(line);
  }
  if (buf.length) {
    if (inFence) { const t = buf.join('\n').trim(); if (t) units.push({ text: t, code: true }); }
    else flush();
  }

  // 代码块太长的，单独成条（超长就硬切，总比发不出去强）；普通段落按句子装。
  const bubbles = [];
  for (const u of units) {
    if (u.code) {
      bubbles.push(u.text.length > maxChars * 4 ? u.text.slice(0, maxChars * 4) : u.text);
      continue;
    }
    for (const piece of sentencesOf(u.text)) {
      const last = bubbles.length ? bubbles[bubbles.length - 1] : null;
      const canAppend = last != null && !last.startsWith('```') && !last.includes('\n```') && last.length + 1 + piece.length <= maxChars;
      if (canAppend) bubbles[bubbles.length - 1] = last + '\n' + piece;
      else if (piece.length <= maxChars) bubbles.push(piece);
      else {
        // 单句本身超长：按标点/空格软切，切成不超过 maxChars 的片段
        let rest = piece;
        while (rest.length > maxChars) {
          const cut = softCut(rest, maxChars);
          bubbles.push(rest.slice(0, cut).trim());
          rest = rest.slice(cut).trim();
        }
        if (rest) bubbles.push(rest);
      }
    }
  }

  const cleaned = bubbles.map((b) => b.trim()).filter(Boolean);
  if (!cleaned.length) return [''];
  if (cleaned.length <= maxBubbles) return cleaned;
  // 超过条数上限：把多出来的并进最后一条，宁可最后一条长一点，也不要刷屏
  const head = cleaned.slice(0, maxBubbles - 1);
  const tail = cleaned.slice(maxBubbles - 1).join('\n').trim();
  return [...head, tail].slice(0, maxBubbles);
}

/**
 * 目的：按中文/英文标点断句，同时保留标点；只做保守切分，不动句子内部。
 * 输入：一段文本；输出：句子数组（已 trim、去空）。
 * 失败：不抛错。副作用：无。
 */
export function sentencesOf(text) {
  const s = String(text ?? '').trim();
  if (!s) return [];
  const out = [];
  let cur = '';
  for (const ch of s) {
    cur += ch;
    if ('。！？!?；;'.includes(ch)) { out.push(cur.trim()); cur = ''; }
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/**
 * 目的：在不超过 max 的位置找一个"不破坏语义"的切点（优先换行，其次标点，最后空格）。
 * 输入：文本与上限；输出：切点下标（1..max）。
 * 失败：找不到就返回 max。副作用：无。
 */
function softCut(text, max) {
  const window = text.slice(0, max);
  const prefer = ['\n', '。', '！', '？', '；', '，', '、', ' ', ','];
  for (const ch of prefer) {
    const at = window.lastIndexOf(ch);
    if (at > max * 0.5) return at + 1;
  }
  return max;
}

/**
 * 目的：把文本变成「发什么 + 每条前等多久」的投递计划。
 * 输入：text 原文；opts 覆盖 DEFAULT_HUMANIZE；opts.rng 可注入 [0,1) 随机源（测试用）。
 * 输出：[{ text, delayMs }…]；第 1 条 delayMs 恒为 0（不能让用户先干等）。
 * 失败：不抛错；enabled=false 时退化成单条零延迟。
 * 副作用：无（不等待、不发消息）。
 */
export function planDelivery(text, opts = {}) {
  const o = { ...DEFAULT_HUMANIZE, ...opts };
  if (!o.enabled) return [{ text: String(text ?? ''), delayMs: 0 }];
  const bubbles = splitBubbles(text, o);
  const rng = typeof o.rng === 'function' ? o.rng : Math.random;
  const perChar = clamp(Number(o.perCharMs), 0, 500);
  const minD = clamp(Number(o.minDelayMs), 0, 60000);
  const maxD = clamp(Number(o.maxDelayMs), minD, 60000);
  const jitter = clamp(Number(o.jitter), 0, 1);
  const plan = [];
  let total = 0;
  for (let i = 0; i < bubbles.length; i++) {
    let delay = 0;
    if (i > 0) {
      const base = clamp(bubbles[i].length * perChar, minD, maxD);
      const j = 1 + (rng() * 2 - 1) * jitter;
      delay = Math.round(clamp(base * j, minD, maxD));
    }
    // 总等待封顶：超了就砍这一条的等待，而不是放弃分条
    const cap = clamp(Number(o.totalDelayCapMs), 0, 600000);
    if (total + delay > cap) delay = Math.max(0, cap - total);
    total += delay;
    plan.push({ text: bubbles[i], delayMs: delay });
  }
  return plan;
}

/**
 * 目的：给面板/日志用的一句话摘要。
 * 输入：opts；输出：字符串（含开关、条数上限、单条字数、总等待上限）。
 * 失败：无。副作用：无。
 */
export function describeHumanize(opts = {}) {
  const o = { ...DEFAULT_HUMANIZE, ...opts };
  if (!o.enabled) return '关闭（整条一次发完）';
  return '开 · 最多 ' + o.maxBubbles + ' 条 · 单条 ≤' + o.maxChars + ' 字 · 条间停顿 ≤' + o.totalDelayCapMs + 'ms';
}
