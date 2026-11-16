import fs from 'node:fs';
import path from 'node:path';
import { describeChat, SessionOwnershipError } from './session-manager.js';
import { findSessionRef, validateSessionForResume } from './session-meta.js';

/**
 * 仪表盘的会话管理后端。
 *
 * 面板不是另一套会话系统：这里的每一行仍是一条真实 DSH sessionId。
 * 页面只负责展示归属、切绑定、新建、改名、解绑、接管；所有校验复用
 * 桥接器的 SessionRegistry / bindChatContext，避免面板绕过 1:1 规则。
 */

const CHAT_KEY_RE = /^(private|group):[A-Za-z0-9_:-]{1,120}$/;

function fail(message, code = 'session/bad-request') {
  const err = new Error(message);
  err.code = code;
  throw err;
}

export function shortSession(id) {
  return String(id || '').replace(/^session-/, '').slice(0, 8);
}

function cleanTitle(value) {
  return String(value || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function infoOf(raw) {
  const v = (raw && raw.projections && raw.projections.values) || {};
  return {
    sessionId: String(raw.sessionId || raw.id || ''),
    title: v.title || null,
    workspace: raw.cwd || v.workingDirectory || '',
    updatedAt: Number(raw.updatedAt) || null,
    running: raw.running === true,
    blank: raw.blank === true,
    available: raw.agentAvailable !== false
  };
}

/**
 * 面板首屏/刷新用的快照。只读；不触发会话创建，不调模型。
 * 会话列表来自一次 session/list；归属来自 SessionRegistry。
 */
export async function buildPanelSessions(bridge) {
  const registry = bridge.sessionRegistry;
  let apiItems = [];
  try {
    if (bridge.dshApi && bridge.dshApi.enabled) {
      apiItems = await bridge.dshApi.listSessions({ timeoutMs: 5000 });
    }
  } catch {
    // DSH web 暂时不可用时，仍返回归属表里的记录。
  }
  const byId = new Map();
  for (const raw of apiItems) {
    const info = infoOf(raw);
    if (info.sessionId) byId.set(info.sessionId, info);
