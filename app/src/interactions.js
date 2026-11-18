/**
 * 目的：执行 QQ 小动作：表情回应、撤回、戳一戳、已读、名片赞。
 * 边界：只做动作，不改对话内容；失败不阻断正文。
 * 依赖：OneBot 客户端；被 bridge 调用。
 * 失败：动作失败记日志，正文继续发。
 */
/**
 * QQ 侧小动作：解析 [[react:...]] / [[recall]] / [[poke]]，并在有 OneBot 时执行。
 * 复原版默认只做解析和记录；没有 OneBot 时全部 no-op，不影响主流程。
 */
const ACTION_RE = /\[\[(react|recall|poke|face)(?::([^\]]*))?\]\]/gi;

export function parseActions(text, { maxActions = 2 } = {}) {
  const src = String(text ?? '');
  // 代码块里的 [[react:...]] 是示例代码的一部分，不能真的去点表情；先整体遮住再还原。
  const blocks = [];
  const masked = src.replace(/```[^\n]*\n[\s\S]*?\n```/g, (block) => {
    blocks.push(block);
    return '\u0000' + (blocks.length - 1) + '\u0000';
  });
  const found = [];
  const body = masked.replace(ACTION_RE, (m, kind, value) => {
    found.push({ kind: String(kind).toLowerCase(), value: String(value || '').trim() });
    return '';
  }).replace(/\u0000(\d+)\u0000/g, (m, i) => blocks[Number(i)] ?? '');
  return {
    text: body.replace(/\n{3,}/g, '\n\n').trim(),
    actions: found.slice(0, Math.max(0, Number(maxActions) || 0)),
    ignoredActions: found.slice(Math.max(0, Number(maxActions) || 0))
  };
}

export function systemHint(cfg = {}, burst = {}) {
  const parts = [];
  if (cfg && cfg.enabled !== false) {
    parts.push('可选标记：[[react:表情]]、[[recall]]、[[poke]] 会被执行并从正文删除。');
  }
  if (burst && burst.enabled) parts.push('长回答可以分条，用空行分段。');
  return parts.join('\n');
}

export function createInteractions(onebot, rawCfg = {}, deps = {}) {
  const cfg = { enabled: rawCfg?.enabled !== false, read: rawCfg?.read === true, ...(rawCfg || {}) };
  const lastInbound = new Map();
  const selfMessages = new Map();

  const call = async (action, params) => {
    if (!onebot || !onebot.online) return null;
    try { return await onebot.call(action, params, 8000); }
    catch (err) { deps.onAction && deps.onAction(null, err, params.chatKey || ''); return null; }
  };

  return {
    cfg,
    describe() { return cfg.enabled ? '已启用（表情/撤回/戳一戳）' : '关闭'; },
    noteInbound(chatKey, info = {}) {
      if (!cfg.enabled) return;
      lastInbound.set(chatKey, { ...info, at: Date.now() });
    },
    noteSelfMessage(chatKey, id) {
      if (!cfg.enabled || id === undefined || id === null) return;
      if (!selfMessages.has(chatKey)) selfMessages.set(chatKey, []);
      selfMessages.get(chatKey).push(String(id));
    },
    async markRead(chatKey) {
      if (!cfg.enabled || !cfg.read) return null;
      const info = lastInbound.get(chatKey);
      if (!info || !info.messageId) return null;
      return call('mark_msg_as_read', { message_id: String(info.messageId) });
    },
    async poke(chatKey) {
      if (!cfg.enabled) return null;
      const info = lastInbound.get(chatKey);
      if (!info || !info.targetId) return null;
      return call('friend_poke', { user_id: String(info.targetId) });
    },
    async run(chatKey, actions = []) {
      if (!cfg.enabled || !onebot || !onebot.online) return [];
      const out = [];
      for (const a of actions.slice(0, 2)) {
        if (a.kind === 'react') {
          const info = lastInbound.get(chatKey);
          if (info && info.messageId) out.push(await call('set_msg_emoji_like', { message_id: String(info.messageId), emoji_id: a.value || '128077' }));
        } else if (a.kind === 'recall') {
          const ids = selfMessages.get(chatKey) || [];
          for (const id of ids.splice(0)) out.push(await call('delete_msg', { message_id: id }));
        } else if (a.kind === 'poke') {
          out.push(await this.poke(chatKey));
        }
      }
      return out;
    }
  };
}
