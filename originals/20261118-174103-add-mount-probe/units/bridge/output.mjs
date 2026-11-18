/**
 * 目的：实现旧机器人的 `/output` 四档——同一轮回答，按档位决定发多少：
 *       只要最终总结 / 正文+总结 / 带工具调用 / 再带思维链简要。
 * 边界：只做「把已解析好的事件渲染成文本」；不管发送、不管分条（那是 humanize 的事）。
 * 依赖：无（纯函数）；被 bridge.mjs 与 test-output.mjs 引用。
 * 失败：不抛错；未知档位按 minimalist 处理，字段缺失就跳过对应段。
 */

/** 四档，顺序即「从少到多」；文案沿用旧机器人 /output 的原文。 */
export const TIERS = [
  { id: 'minimalist', label: '极简', desc: '只发最终总结' },
  { id: 'concise', label: '简洁', desc: '执行中的正文 + 最终总结' },
  { id: 'detailed', label: '详细', desc: '工具调用 + 正文 + 总结' },
  { id: 'complete', label: '完整', desc: '工具调用 + 思维链简要 + 正文 + 总结' },
];

export const DEFAULT_TIER = 'minimalist';

/** 目的：档位 id 是否合法。输入：字符串；输出：布尔。 */
export function isTier(id) {
  return TIERS.some((t) => t.id === String(id || '').toLowerCase());
}

/** 目的：把 id 规整成合法档位；非法或空就回默认。输入：任意；输出：tier id。 */
export function normalizeTier(id) {
  const s = String(id || '').toLowerCase();
  return isTier(s) ? s : DEFAULT_TIER;
}

/** 目的：档位的中文名 + 组成说明，用于切换回执。输入：id；输出：'完整（complete）／…'。 */
export function describeTier(id) {
  const t = TIERS.find((x) => x.id === normalizeTier(id));
  return t.label + '（' + t.id + '）／' + t.desc;
}

/**
 * 目的：`/output` 无参数时打印的那段（旧机器人原文格式，当前档位打 ▸）。
 * 输入：当前档位；输出：多行字符串。
 * 失败：无。副作用：无。
 */
export function tierListText(current) {
  const cur = normalizeTier(current);
  const lines = ['当前输出档位：' + describeTier(cur), ''];
  for (const t of TIERS) {
    const mark = t.id === cur ? '▸' : ' ';
    lines.push('  ' + mark + ' ' + t.id.padEnd(11) + ' ' + t.label + ' — ' + t.desc);
  }
  lines.push('');
  lines.push('用法：/output <档位>　　例如 /output detailed');
  lines.push('只影响本聊天，下一轮生效；默认 ' + DEFAULT_TIER + '。');
  return lines.join('\n');
}

/** 目的：工具调用压成一行『工具名: 关键参数』，别把整份 input 贴出来。 */
export function summarizeTool(tool, input) {
  const name = String(tool || 'tool');
  let arg = '';
  if (input && typeof input === 'object') {
    const pick = input.command || input.description || input.path || input.query || input.pattern
      || input.file_path || input.task || '';
    arg = String(pick || '').replace(/\s+/g, ' ').slice(0, 80);
  } else if (typeof input === 'string') {
    arg = input.replace(/\s+/g, ' ').slice(0, 80);
  }
  return arg ? name + ': ' + arg : name;
}

/**
 * 目的：按档位把一轮事件渲染成要发出去的文字。
 * 输入：events = { final, texts[], tools[{tool,input,status}], thinking[] }，tier 档位；
 *       opts = { maxThinkingChars 思维链最多多少字, maxTools 最多列几条工具 }。
 * 输出：字符串（可能为空串，表示这一档什么都不发）。
 * 失败：不抛错；缺字段跳过。
 * 副作用：无。
 */
export function renderByTier(events, tier, opts = {}) {
  const t = normalizeTier(tier);
  const maxThinking = Number(opts.maxThinkingChars ?? 300);
  const maxTools = Number(opts.maxTools ?? 6);
  const final = String(events?.final ?? '').trim();
  const texts = Array.isArray(events?.texts) ? events.texts.filter(Boolean) : [];
  const tools = Array.isArray(events?.tools) ? events.tools.filter(Boolean) : [];
  const thinking = Array.isArray(events?.thinking) ? events.thinking.filter(Boolean) : [];

  if (t === 'minimalist') return final;

  const parts = [];
  if (t === 'detailed' || t === 'complete') {
    if (tools.length) {
      const lines = tools.slice(0, maxTools).map((x) => {
        const bad = x.status && x.status !== 'completed' && x.status !== 'ok' ? '（' + x.status + '）' : '';
        return '· ' + summarizeTool(x.tool, x.input) + bad;
      });
      if (tools.length > maxTools) lines.push('· …还有 ' + (tools.length - maxTools) + ' 次调用');
      parts.push('[工具] ' + tools.length + ' 次\n' + lines.join('\n'));
    }
  }
  if (t === 'complete' && thinking.length) {
    const joined = thinking.join('\n').replace(/\s+/g, ' ').trim();
    const brief = joined.length > maxThinking ? joined.slice(0, maxThinking) + '…' : joined;
    parts.push('[思考] ' + brief);
  }
  // 正文：concise 及以上都要；如果 final 与最后一段 text 重复，去掉重复
  const body = texts.filter((x) => x.trim() && x.trim() !== final);
  if (body.length) parts.push(body.join('\n'));
  if (final) parts.push(final);
  return parts.join('\n\n');
}

/** 目的：会话轮数到阈值时给用户的一句提示。输入：阈值/轮数；输出：字符串。 */
export function compactNotice(rounds) {
  return '已经聊了 ' + rounds + ' 轮，我把前面的要点压缩成一段摘要，接下来的对话接着这段摘要走（旧会话仍留在 DSH 里，/sessions 可查）。';
}
