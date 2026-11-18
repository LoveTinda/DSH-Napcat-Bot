/**
 * 目的：把会话注册表整理成面板可读的列表与详情。
 * 边界：只读，不切换/删除会话。
 * 依赖：session-manager/session-meta；被 panel 调用。
 * 失败：读不到返回空列表。
 */
import { describeChat, SessionOwnershipError } from './session-manager.js';

/** 面板会话列表：只读汇总，不触发 DSH 建会话。 */
export function shortSession(id) {
  return String(id || '').replace(/^session-/, '').slice(0, 8);
}

export async function buildPanelSessions(bridge) {
  const rows = [];
  try {
    for (const rec of bridge.sessionRegistry?.all?.() || []) {
      rows.push({
        chatKey: rec.chatKey,
        chat: describeChat(rec.chatKey, { mask: true }),
        sessionId: rec.sessionId,
        short: shortSession(rec.sessionId),
        workspace: rec.workspace || '',
        title: rec.title || null,
        legacy: rec.legacy === true
      });
    }
  } catch {}
  return { rows, total: rows.length };
}

export async function applyPanelSessionAction(bridge, body = {}) {
  const action = String(body.action || '');
  if (!action || action === 'noop') return { ok: true, changed: false };
  if (action === 'bind') {
    if (!bridge.sessionRegistry || typeof bridge.bindChatContext !== 'function') {
      throw new SessionOwnershipError('当前桥接器不支持面板绑定');
    }
    bridge.bindChatContext(body.chatKey, { workspace: body.workspace, sessionId: body.sessionId, turns: 0 });
    return { ok: true, changed: true };
  }
  throw new Error('不支持的会话操作：' + action);
}
