/**
 * 目的：决定「这条消息该不该回」——白名单、群必须 @、owner/admin 分级，全部在这里。
 *       移植自旧桥接器的 src/policy.js（2026-10-25 备份里完整救回的那份），保留原语义。
 * 边界：纯判定，不读文件、不发消息、不写状态；配置由调用方读好后传进来。
 * 依赖：无（纯函数，只用语言本身）；被 bridge.mjs 与 test-policy.mjs 引用。
 * 失败：不抛错；非法输入按「拒绝」处理，宁可少回一条，不能多回一条。
 * 输入：normalizePolicy(raw) → 规整后的策略对象；decidePolicy(policy, ctx) → { ok, why }。
 * 副作用：无。
 */

const PRIVATE_MODES = new Set(['allowlist', 'allow', 'deny']);
const GROUP_MODES = new Set(['mention', 'allow', 'deny']);

/**
 * 目的：没有配置文件时的默认策略——保持「能用」，但把危险的地方显式写出来。
 *       私聊开放（allowAllUsers）、群聊必须 @（mention）、不限群号（allowAllGroups）。
 * 说明：hardened=false 表示这不是加固过的配置，面板和 doctor 都会提示。
 */
export const DEFAULT_POLICY = Object.freeze({
  privateChat: 'allow',
  groupChat: 'mention',
  allowUsers: [],
  allowGroups: [],
  ownerUsers: [],
  adminUsers: [],
  allowAllUsers: true,
  allowAllGroups: true,
  ignoreSelf: true,
  hardened: false,
});

/**
 * 目的：把任意来源（JSON 文件、环境变量、测试用对象）的策略配置规整成一份确定的形状。
 * 输入：原始对象，字段可能缺失、类型可能不对。
 * 输出：全部字段有值、去重、owner/admin 互斥的对象。
 * 失败：不抛错，坏值按默认。
 */
export function normalizePolicy(raw = {}) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const list = (v) => (Array.isArray(v) ? [...new Set(v.map((x) => String(x).trim()).filter(Boolean))] : []);
  const allowUsers = list(p.allowUsers);
  const allowGroups = list(p.allowGroups);
  const ownerUsers = list(p.ownerUsers);
  const adminUsers = list(p.adminUsers);
  // 迁移默认：没有显式 owner 时，第一个白名单用户是 owner，其余是 admin；
  // 绝不把「所有白名单用户」都当管理员（旧 P1-21）。
  const resolvedOwners = ownerUsers.length ? ownerUsers : (allowUsers.length ? [allowUsers[0]] : []);
  const resolvedAdmins = adminUsers.length ? adminUsers : allowUsers.slice(1);
  const privateChat = String(p.privateChat ?? 'allowlist').toLowerCase();
  const groupChat = String(p.groupChat ?? 'mention').toLowerCase();
  return {
    privateChat,
    groupChat,
    allowUsers,
    allowGroups,
    ownerUsers: [...new Set(resolvedOwners)],
    adminUsers: [...new Set(resolvedAdmins.filter((id) => !resolvedOwners.includes(id)))],
    allowAllUsers: p.allowAllUsers === true,
    allowAllGroups: p.allowAllGroups === true,
    ignoreSelf: p.ignoreSelf !== false,
    // 是否「加固过」：由 loadPolicy 判定，normalize 不猜。
    hardened: p.hardened === true,
  };
}

/**
 * 目的：启动时校验策略，危险默认直接拒绝启动（旧 P0 教训：privateChat:allow + 空白名单 = 陌生人全权限）。
 * 输出：{ ok, policy, errors[], warnings[] }；errors 非空时调用方必须拒绝启动。
 * 失败：不抛错。
 */
export function validatePolicy(raw = {}) {
  const policy = normalizePolicy(raw);
  const errors = [];
  const warnings = [];

  if (!PRIVATE_MODES.has(policy.privateChat)) {
    errors.push('privateChat 只能是 allowlist | allow | deny，当前：' + policy.privateChat);
  }
  if (!GROUP_MODES.has(policy.groupChat)) {
    errors.push('groupChat 只能是 mention | allow | deny，当前：' + policy.groupChat);
  }

  if (policy.privateChat === 'allowlist' && !policy.allowUsers.length && !policy.allowAllUsers) {
    errors.push('allowUsers 为空：私聊默认拒绝。请填至少一个允许的 QQ 号，或显式 allowAllUsers:true。');
  }
  if (policy.privateChat === 'allow' && !policy.allowAllUsers) {
    errors.push('privateChat="allow" 必须显式配合 allowAllUsers:true；不要把它当调试默认。');
  }
  if (policy.allowAllUsers) warnings.push('allowAllUsers:true：私聊对所有陌生人开放');
  if (policy.groupChat === 'allow' && !policy.allowGroups.length && !policy.allowAllGroups) {
    errors.push('groupChat="allow" 必须配合 allowGroups 白名单或显式 allowAllGroups:true。');
  }
  if (policy.groupChat !== 'deny' && !policy.allowGroups.length && !policy.allowAllGroups) {
    warnings.push('群白名单为空：所有群消息都会被拒绝（不会静默开放）');
  }
  if (policy.allowAllGroups) warnings.push('allowAllGroups:true：群聊不限制群号');
  if (policy.allowGroups.length) warnings.push('群白名单 ' + policy.allowGroups.length + ' 个（不打印群号）');
  if (policy.allowUsers.length) {
    warnings.push('用户白名单 ' + policy.allowUsers.length + ' 个（不打印号码）');
    warnings.push('命令角色：owner ' + policy.ownerUsers.length + ' 个，admin ' + policy.adminUsers.length + ' 个');
  }
  if (!policy.hardened) warnings.push('策略未加固（没有配置文件或仍是默认值），面板会标出来');

  return { ok: errors.length === 0, policy, errors, warnings };
}

/**
 * 目的：纯判定「这条消息回不回」。不读写状态，方便单测。
 * 入参：policy 来自 normalizePolicy；ctx = { isGroup, userId, groupId, mentioned, selfId }。
 * 输出：{ ok, why }；why 是给日志/面板看的短码，不含号码。
 */
export function decidePolicy(policy, { isGroup, userId, groupId, mentioned, selfId } = {}) {
  const p = policy || DEFAULT_POLICY;
  if (p.ignoreSelf && selfId !== undefined && selfId !== null && String(selfId) === String(userId)) {
    return { ok: false, why: 'self' };
  }

  const users = p.allowUsers || [];
  const groups = p.allowGroups || [];
  if (users.length && !users.includes(String(userId))) {
    return { ok: false, why: 'user-not-allowed' };
  }

  if (isGroup) {
    if (p.groupChat === 'deny') return { ok: false, why: 'group-denied' };
    if (groups.length && !groups.includes(String(groupId))) return { ok: false, why: 'group-not-allowed' };
    // 空白名单 = 全部拒绝，而不是「没配置就当公开」
    if (!groups.length && !p.allowAllGroups) return { ok: false, why: 'group-not-allowed' };
    if (p.groupChat === 'mention' && !mentioned) return { ok: false, why: 'not-mentioned' };
    return { ok: true };
  }

  if (p.privateChat === 'deny') return { ok: false, why: 'private-denied' };
  if (p.privateChat === 'allow') {
    return p.allowAllUsers ? { ok: true } : { ok: false, why: 'policy-misconfigured' };
  }
  if (p.allowAllUsers) return { ok: true };
  if (!users.length) return { ok: false, why: 'user-not-allowed' };
  return users.includes(String(userId)) ? { ok: true } : { ok: false, why: 'user-not-allowed' };
}

/** 命令级角色：owner > admin > user > none。 */
export function commandRole(policy, { userId, adminBypass = false } = {}) {
  if (adminBypass) return 'owner';
  const p = policy || {};
  const id = String(userId ?? '');
  if (id && (p.ownerUsers || []).includes(id)) return 'owner';
  if (id && (p.adminUsers || []).includes(id)) return 'admin';
  if (id && (p.allowUsers || []).includes(id)) return 'user';
  if (p.allowAllUsers) return 'user';
  return 'none';
}

/** 目的：角色够不够。rank 固定，越界按 none。 */
export function roleAtLeast(role, required) {
  const rank = { none: 0, user: 1, admin: 2, owner: 3 };
  return (rank[role] || 0) >= (rank[required] || 0);
}

/** 目的：给启动日志/面板用的摘要；只出数量和模式，不出号码。 */
export function describePolicy(policy) {
  const p = policy || DEFAULT_POLICY;
  return [
    '私聊=' + p.privateChat,
    '群聊=' + p.groupChat,
    '用户白名单=' + p.allowUsers.length,
    'owner=' + p.ownerUsers.length,
    'admin=' + p.adminUsers.length,
    '群白名单=' + p.allowGroups.length,
    'allowAllUsers=' + (p.allowAllUsers ? 'true' : 'false'),
    'allowAllGroups=' + (p.allowAllGroups ? 'true' : 'false'),
  ].join(' ');
}

/** 目的：号码脱敏，日志和面板里只留首尾。 */
export function maskId(id) {
  const s = String(id ?? '');
  if (!s) return '（空）';
  if (s.length <= 6) return s[0] + '***' + s[s.length - 1];
  return s.slice(0, 2) + '***' + s.slice(-2);
}

/** 目的：把 chatKey 逐段脱敏（group:<群号> 之类）。 */
export function maskChatKey(chatKey) {
  const s = String(chatKey ?? '');
  const parts = s.split(':');
  if (parts.length < 2) return maskId(s);
  return parts[0] + ':' + parts.slice(1).map((p) => maskId(p)).join(':');
}

/**
 * 目的：把 why 短码翻成人话，给面板和日志用。
 * 输入：decidePolicy 返回的 why；输出：中文短语；未知码原样返回。
 */
export function explainWhy(why) {
  const map = {
    self: '自己发的',
    'user-not-allowed': '不在用户白名单',
    'group-not-allowed': '群不在白名单',
    'group-denied': '群聊已关闭',
    'not-mentioned': '群里没 @ 我',
    'private-denied': '私聊已关闭',
    'policy-misconfigured': '策略配置不完整（私聊 allow 但没开 allowAllUsers）',
  };
  return map[why] || String(why || '');
}
