/**
 * 目的：拟人化投递：分条、停顿、输入状态。
 * 边界：不生成内容，只决定怎么发。
 * 依赖：setTimeout；被 bridge 调用。
 * 失败：发送失败抛给 bridge，由补发队列处理。
 */
const DEFAULT_HUMANIZE = { enabled: false, charsPerMinute: 220, maxBursts: 6, hardLimit: 4000 };

/** 拟人化输出的最小实现：分气泡、硬切分、输入状态。默认关闭，避免复原版一上来就刷屏。 */
export function createPersona(humanize = {}, behavior = {}) {
  const cfg = { ...DEFAULT_HUMANIZE, ...(humanize || {}) };
  const burst = cfg.burst || {};
  const target = { burst: { enabled: cfg.enabled !== false && burst.enabled !== false, ...burst } };

  // 按「用户感知的字符」切：emoji 的 ZWJ 组合、肤色、旗帜不能被切开，否则 QQ 上就是乱码方块。
  let segCache;
  function segmenter() {
    if (segCache !== undefined) return segCache;
    try { segCache = new Intl.Segmenter('zh', { granularity: 'grapheme' }); }
    catch { segCache = null; }
    return segCache;
  }

  function sliceGraphemes(str, size) {
    const out = [];
    const seg = segmenter();
    const iter = seg ? seg.segment(str) : Array.from(str, (ch) => ({ segment: ch }));
    let cur = '';
    for (const { segment } of iter) {
      if (cur && cur.length + segment.length > size) { out.push(cur); cur = ''; }
      cur += segment;
    }
    if (cur) out.push(cur);
    return out;
  }

  /**
   * 目的：把超长回复切成不超过 limit 的若干段，且不切坏代码围栏与 emoji。
   * 输入：text 任意文本；limit 每段上限（字符数，最小 50）。
   * 输出：段数组；空输入返回 ['']。
   * 失败：无；单段永远 <= limit（单个 grapheme 本身超限时除外）。
   * 副作用：无。
   */
  function hardSplit(text, limit = cfg.hardLimit || 4000) {
    const s = String(text ?? '');
    const max = Math.max(50, Number(limit) || 4000);
    if (!s) return [''];
    const parts = [];
    const push = (chunk, wrap) => {
      if (!chunk) return;
      const overhead = wrap ? wrap.header.length + wrap.footer.length + 2 : 0;
      const bodyMax = Math.max(1, max - overhead);
      for (const piece of sliceGraphemes(chunk, bodyMax)) {
        parts.push(wrap ? wrap.header + '\n' + piece + '\n' + wrap.footer : piece);
      }
    };
    // 围栏内的内容整块处理：超过上限时每段都补回围栏，否则代码在 QQ 里会糊成一片。
    const fence = /```([^```\n]*)\n([\s\S]*?)\n```/g;
    let last = 0;
    let m;
    while ((m = fence.exec(s))) {
      push(s.slice(last, m.index), null);
      if (m[0].length <= max) parts.push(m[0]);
      else push(m[2], { header: '```' + m[1], footer: '```' });
      last = fence.lastIndex;
    }
    push(s.slice(last), null);
    return parts.length ? parts : [''];
  }

  function partsOf(text) {
    const s = String(text ?? '').replace(/\r\n/g, '\n').trim();
    if (!s) return [''];
    const hard = hardSplit(s, cfg.hardLimit || 4000);
    if (!target.burst.enabled) return hard;
    const out = [];
    for (const block of hard) {
      const pieces = block.split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
      if (!pieces.length) out.push(block);
      else out.push(...pieces);
    }
    return out.slice(0, Math.max(1, Number(burst.maxBursts) || 6));
  }

  return {
    target,
    cfg,
    describe() {
      return target.burst.enabled ? '已在分气泡（' + (cfg.charsPerMinute || 220) + ' 字/分）' : '关闭';
    },
    hardSplit,
    async deliverBurst(body, sendPart, shouldStop = () => false) {
      const parts = partsOf(body);
      let sent = 0;
      let waitedMs = 0;
      for (const part of parts) {
        if (shouldStop()) break;
        await sendPart(part);
        sent += 1;
        if (target.burst.enabled && sent < parts.length) {
          const delay = Math.min(Number(cfg.maxDelayMs) || 5200, Math.max(Number(cfg.minDelayMs) || 700,
            Math.round(part.length / Math.max(60, Number(cfg.charsPerMinute) || 220) * 60000)));
          waitedMs += delay;
          await new Promise((r) => setTimeout(r, delay));
        }
      }
      return { parts: sent, waitedMs };
    },
    createInputStatus(cb) {
      let timer = null;
      let stopped = false;
      return {
        start() {
          if (stopped) return;
          try { cb(0); } catch {}
          const keep = Math.max(1000, Number(cfg.inputStatus?.keepaliveMs) || 8000);
          timer = setInterval(() => { if (!stopped) { try { cb(0); } catch {} } }, keep);
          if (timer.unref) timer.unref();
        },
        stop() {
          stopped = true;
          if (timer) clearInterval(timer);
          timer = null;
          try { cb(1); } catch {}
        }
      };
    },
    inputStatusPayload(eventType) {
      return { event_type: Number(eventType) ? 1 : 0 };
    }
  };
}
