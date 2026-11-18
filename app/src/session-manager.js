/**
 * 目的：维护 chatKey → workspace/sessionId 的归属与切换。
 * 边界：不跑回合，不直接调 DSH。
 * 依赖：store.js；被 bridge/panel 调用。
 * 失败：归属冲突抛 SessionOwnershipError。
 */
import { logger } from './log.js';
import { maskId } from './policy.js';

const log = logger('session');

/**
 * 会话归属表：一条 DSH 会话只能属于一个 QQ 聊天。
 *
 * 桥接器不是另一个会话系统——这里保存的每条记录都直接对应 DSH 的 sessionId，
 * 没有本地会话 id，也不复制 DSH 的历史。它只做三件事：
 *   1. 把 QQ 会话键（私聊/群/群成员）稳定地映射到 DSH sessionId；
 *   2. 保证一条 DSH 会话不会同时被两个 QQ 聊天使用；
 *   3. 给 /session 提供同一套“谁拥有、当前用哪条”的读取入口。
 *
 * 记录放在 chat.ownedSessions[sessionId]，随 state/sessions.json 落盘。
 * 旧状态只有 chat.sessions / previousSessions / sessionTurns，migrate() 会补登记。
 */

export class SessionOwnershipError extends Error {
  constructor(sessionId, owner) {
    super('DSH 会话 ' + short(sessionId) + ' 已经属于 ' + describeChat(owner) +
      '，不能再绑定到另一个 QQ 聊天。');
    this.name = 'SessionOwnershipError';
    this.code = 'session-owned';
    this.sessionId = sessionId;
    this.owner = owner;
  }
}

function short(id) {
  return String(id || '').replace(/^session-/, '').slice(0, 8);
}

function clean(text, max = 60) {
  return String(text || '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/**
 * QQ 会话键。默认：
 *   private:<QQ号>          一个私聊一个人一条
 *   group:<群号>            一个群一条（群成员共享上下文）
 * behavior.groupSessionScope="member" 时：
 *   group:<群号>:<QQ号>     群里每个成员各一条
 *
 * 键只用于桥接器找绑定，不会发给 DSH；DSH 只看到 sessionId。
 */
export function chatKeyFor({ isGroup, groupId, userId, groupSessionScope = 'group' } = {}) {
  const uid = String(userId ?? '').trim();
  const gid = String(groupId ?? '').trim();
  if (!isGroup) return 'private:' + uid;
  if (String(groupSessionScope).toLowerCase() === 'member') return 'group:' + gid + ':' + uid;
  return 'group:' + gid;
}

export function parseChatKey(chatKey) {
  const s = String(chatKey ?? '');
  const parts = s.split(':');
  if (parts[0] === 'private') return { kind: 'private', userId: parts.slice(1).join(':') };
  if (parts[0] === 'group') {
    return {
      kind: 'group',
      groupId: parts[1] || '',
      userId: parts.length > 2 ? parts.slice(2).join(':') : null,
      memberScoped: parts.length > 2
    };
  }
  return { kind: 'unknown', raw: s };
}

/** 给人看的归属描述；mask=true 时号码脱敏（管理列表里看别人的聊天）。 */
export function describeChat(chatKey, { mask = false } = {}) {
  const p = parseChatKey(chatKey);
  const id = (v) => (mask ? maskId(v) : String(v || ''));
  if (p.kind === 'private') return 'QQ 私聊 ' + id(p.userId);
  if (p.kind === 'group') {
    return p.memberScoped
      ? 'QQ 群 ' + id(p.groupId) + ' 的成员 ' + id(p.userId)
      : 'QQ 群 ' + id(p.groupId);
  }
  return 'QQ 会话 ' + (mask ? maskId(p.raw) : p.raw);
}

/** 新建会话时写到 DSH 侧边栏的标题，让 QQ 归属一眼可见。 */
export function defaultSessionTitle(chatKey, { senderName } = {}) {
  const p = parseChatKey(chatKey);
  const who = clean(senderName, 40);
  if (p.kind === 'private') return 'QQ私聊 · ' + (who || p.userId || '未知用户');
  if (p.kind === 'group') {
    if (p.memberScoped) return 'QQ群 ' + p.groupId + ' · ' + (who || p.userId || '成员');
    return 'QQ群 ' + p.groupId;
  }
  return 'QQ · ' + clean(chatKey, 40);
}

function norm(id) { return String(id ?? ''); }
function sameId(a, b) { return norm(a).toLowerCase() === norm(b).toLowerCase(); }

export class SessionRegistry {
  /**
   * @param {object} chats  Bridge 持有的 chatKey -> chat 映射（原地修改）
   * @param {{save?:Function}} opts
   */
  constructor(chats, { save = () => {} } = {}) {
    this.chats = chats || {};
    this.save = save;
  }

  ensureChat(chatKey) {
    let chat = this.chats[chatKey];
    if (!chat || typeof chat !== 'object') {
      chat = { workspace: '', sessions: {}, ownedSessions: {}, seed: null, model: null };
      this.chats[chatKey] = chat;
    }
    if (!chat.ownedSessions || typeof chat.ownedSessions !== 'object') chat.ownedSessions = {};
    return chat;
  }

  recordFor(chat, sessionId) {
    if (!chat || !chat.ownedSessions) return null;
    const direct = chat.ownedSessions[sessionId];
    if (direct) return direct;
    for (const [key, rec] of Object.entries(chat.ownedSessions)) {
      if (sameId(key, sessionId)) return rec;
    }
    return null;
  }

  removeRecord(chat, sessionId) {
    if (!chat || !chat.ownedSessions) return false;
    let changed = false;
    for (const key of Object.keys(chat.ownedSessions)) {
      if (sameId(key, sessionId)) { delete chat.ownedSessions[key]; changed = true; }
    }
    return changed;
  }

  /** 这条 DSH 会话属于哪个 QQ 会话；没有归属返回 null。 */
  ownerOf(sessionId) {
    if (!sessionId) return null;
    for (const [chatKey, chat] of Object.entries(this.chats)) {
      if (this.recordFor(chat, sessionId)) return chatKey;
    }
    // 兼容还没迁移的旧状态：当前绑定也算归属。
    for (const [chatKey, chat] of Object.entries(this.chats)) {
      for (const slot of Object.values(chat.sessions || {})) {
        if (slot && slot.sessionId && sameId(slot.sessionId, sessionId)) return chatKey;
      }
    }
    return null;
  }

  isOwnedBy(chatKey, sessionId) {
    const owner = this.ownerOf(sessionId);
    return owner !== null && owner === chatKey;
  }

  /** 登记归属；被别的聊天占用时抛 SessionOwnershipError（除非 force）。 */
  claim(chatKey, sessionId, { workspace, title, force = false } = {}) {
    if (!chatKey) throw new Error('claim 缺少 chatKey');
    if (!sessionId) throw new Error('claim 缺少 sessionId');
    const chat = this.ensureChat(chatKey);
    const owner = this.ownerOf(sessionId);
    if (owner && owner !== chatKey) {
      if (!force) throw new SessionOwnershipError(sessionId, owner);
      this.detach(owner, sessionId, { save: false });
      log.warn('会话 ' + short(sessionId) + ' 从 ' + owner + ' 强制转给 ' + chatKey);
    }
    let rec = this.recordFor(chat, sessionId);
    let created = false;
    if (!rec) {
      rec = { sessionId: norm(sessionId), createdAt: new Date().toISOString() };
      created = true;
    }
    if (workspace) rec.workspace = workspace;
    if (title) rec.title = title;
    rec.lastUsedAt = new Date().toISOString();
    this.removeRecord(chat, sessionId);
    chat.ownedSessions[norm(sessionId)] = rec;
    this.save();
    return { record: rec, created };
  }

  setTitle(chatKey, sessionId, title) {
    const chat = this.ensureChat(chatKey);
    const rec = this.recordFor(chat, sessionId);
    if (!rec) return null;
    rec.title = clean(title);
    rec.titleUpdatedAt = new Date().toISOString();
    this.save();
    return rec;
  }

  /** 解除归属，但**不删除** DSH 会话；当前绑定指向它时一并清空。 */
  detach(chatKey, sessionId, { save = true } = {}) {
    const chat = this.chats[chatKey];
    if (!chat) return false;
    const removed = this.removeRecord(chat, sessionId);
    let cleared = false;
    for (const slot of Object.values(chat.sessions || {})) {
      if (slot && slot.sessionId && sameId(slot.sessionId, sessionId)) {
        slot.sessionId = null;
        slot.turns = 0;
        slot.updatedAt = new Date().toISOString();
        cleared = true;
      }
    }
    // 解绑 = 本聊天不再记得这条会话。如果只删 ownedSessions，启动迁移还会从
    // sessionTurns / previousSessions 把它补回来，release 就白做了。
    if (chat.sessionTurns && typeof chat.sessionTurns === 'object') {
      for (const key of Object.keys(chat.sessionTurns)) {
        if (sameId(key, sessionId)) { delete chat.sessionTurns[key]; cleared = true; }
      }
    }
    if (Array.isArray(chat.previousSessions)) {
      const before = chat.previousSessions.length;
      chat.previousSessions = chat.previousSessions.filter((p) => !(p && sameId(p.sessionId, sessionId)));
      if (chat.previousSessions.length !== before) cleared = true;
    }
    if (save && (removed || cleared)) this.save();
    return removed || cleared;
  }

  /** 本聊天拥有的会话（可按工作区过滤），最近使用的在前。 */
  list(chatKey, { workspace } = {}) {
    const chat = this.chats[chatKey];
    if (!chat || !chat.ownedSessions) return [];
    const active = new Set();
    for (const slot of Object.values(chat.sessions || {})) {
      if (slot && slot.sessionId) active.add(String(slot.sessionId).toLowerCase());
    }
    return Object.values(chat.ownedSessions)
      .filter((rec) => rec && rec.sessionId)
      .filter((rec) => !workspace || !rec.workspace || sameId(rec.workspace, workspace))
      .map((rec) => ({
        ...rec,
        active: active.has(String(rec.sessionId).toLowerCase())
      }))
      .sort((a, b) => {
        const ta = Date.parse(a.lastUsedAt || a.createdAt || 0) || 0;
        const tb = Date.parse(b.lastUsedAt || b.createdAt || 0) || 0;
        return tb - ta || String(a.sessionId).localeCompare(String(b.sessionId));
      });
  }

  /** 所有聊天登记过的会话（管理视角）。 */
  all() {
    const rows = [];
    for (const [chatKey, chat] of Object.entries(this.chats)) {
      for (const rec of Object.values(chat.ownedSessions || {})) {
        if (rec && rec.sessionId) rows.push({ ...rec, chatKey });
      }
    }
    return rows;
  }

  /**
   * 迁移旧状态：把当前绑定、previousSessions、sessionTurns 补登记成归属。
   * 优先级：当前绑定 > /new 留下历史 > /ws 见过的会话；同一条会话只归一个聊天。
   */
  migrate() {
    let changed = false;
    for (const [chatKey, chat] of Object.entries(this.chats)) {
      if (!chat || typeof chat !== 'object') continue;
      if (!chat.ownedSessions || typeof chat.ownedSessions !== 'object') {
        chat.ownedSessions = {};
        changed = true;
      }
    }
    const claimLegacy = (chatKey, chat, sessionId, workspace, kind) => {
      if (!sessionId) return;
      const owner = this.ownerOf(sessionId);
      if (owner && owner !== chatKey) {
        if (kind === 'active') {
          // 两条聊天绑定了同一条会话：这是旧版本 /ws 允许跨聊天切换留下的。
          // 保留先登记的一方，把后来者清空，避免同一条 DSH 会话被两边同时写。
          for (const [ws, slot] of Object.entries(chat.sessions || {})) {
            if (slot && slot.sessionId && sameId(slot.sessionId, sessionId)) {
              slot.sessionId = null;
              slot.turns = 0;
              slot.updatedAt = new Date().toISOString();
              log.warn('旧状态冲突：' + short(sessionId) + ' 同时绑定在 ' + owner + ' 和 ' + chatKey +
                '，保留 ' + owner + '，清空 ' + chatKey + ' 的 ' + ws + ' 绑定。');
              changed = true;
            }
          }
        }
        return;
      }
      if (this.recordFor(chat, sessionId)) {
        if (workspace) {
          const rec = this.recordFor(chat, sessionId);
          if (!rec.workspace) { rec.workspace = workspace; changed = true; }
        }
        return;
      }
      chat.ownedSessions[norm(sessionId)] = {
        sessionId: norm(sessionId),
        workspace: workspace || chat.workspace || '',
        createdAt: new Date().toISOString(),
        legacy: true,
        migratedFrom: kind
      };
      changed = true;
    };

    for (const [chatKey, chat] of Object.entries(this.chats)) {
      for (const [ws, slot] of Object.entries(chat.sessions || {})) {
        if (slot && slot.sessionId) claimLegacy(chatKey, chat, slot.sessionId, ws, 'active');
      }
    }
    for (const [chatKey, chat] of Object.entries(this.chats)) {
      for (const prev of Array.isArray(chat.previousSessions) ? chat.previousSessions : []) {
        if (prev && prev.sessionId) claimLegacy(chatKey, chat, prev.sessionId, chat.workspace, 'previous');
      }
    }
    for (const [chatKey, chat] of Object.entries(this.chats)) {
      for (const id of Object.keys(chat.sessionTurns || {})) {
        claimLegacy(chatKey, chat, id, chat.workspace, 'turns');
      }
    }

    for (const [chatKey, chat] of Object.entries(this.chats)) {
      for (const [ws, slot] of Object.entries(chat.sessions || {})) {
        if (slot && slot.sessionId) claimLegacy(chatKey, chat, slot.sessionId, ws, 'active');
      }
    }
    for (const [chatKey, chat] of Object.entries(this.chats)) {
      for (const prev of Array.isArray(chat.previousSessions) ? chat.previousSessions : []) {
        if (prev && prev.sessionId) claimLegacy(chatKey, chat, prev.sessionId, chat.workspace, 'previous');
      }
    }
    for (const [chatKey, chat] of Object.entries(this.chats)) {
      for (const id of Object.keys(chat.sessionTurns || {})) {
        claimLegacy(chatKey, chat, id, chat.workspace, 'turns');
      }
    }
    if (changed) this.save();
    return changed;
  }
}
