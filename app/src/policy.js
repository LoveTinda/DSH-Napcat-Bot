/**
 * 目的：访问策略：白名单、群 @、owner/admin 角色。
 * 边界：纯判定，不读写状态。
 * 依赖：无；被 bridge/commands 调用。
 * 失败：非法输入按拒绝处理，不抛错。
 */
/**
 * 访问策略：默认拒绝，白名单可验证。
 *
 * 旧配置里 privateChat:"allow" + allowUsers:[] 等于“陌生人 + 全权限”，
 * 这是 P0；这里把它拆成三个显式模式，并在启动时对危险默认直接报错。
 */
const PRIVATE_MODES = new Set(['allowlist', 'allow', 'deny']);
const GROUP_MODES = new Set(['mention', 'allow', 'deny']);

export function normalizePolicy(raw = {}) {
  const p = raw || {};
  const allowUsers = Array.isArray(p.allowUsers)
    ? [...new Set(p.allowUsers.map((v) => String(v).trim()).filter(Boolean))]
    : [];
  const allowGroups = Array.isArray(p.allowGroups)
    ? [...new Set(p.allowGroups.map((v) => String(v).trim()).filter(Boolean))]
    : [];
  const ownerUsers = Array.isArray(p.ownerUsers)
    ? [...new Set(p.ownerUsers.map((v) => String(v).trim()).filter(Boolean))]
    : [];
  const adminUsers = Array.isArray(p.adminUsers)
    ? [...new Set(p.adminUsers.map((v) => String(v).trim()).filter(Boolean))]
    : [];
  // 迁移默认：没有显式 owner 时，**第一个白名单用户**是 owner，其余是 admin；
  // 绝不把“所有白名单用户”都当管理员（P1-21）。空白名单仍由 validatePolicy 拒绝。
  const resolvedOwners = ownerUsers.length ? ownerUsers : (allowUsers.length ? [allowUsers[0]] : []);
  const resolvedAdmins = adminUsers.length ? adminUsers : allowUsers.slice(1);
  return {
    privateChat: p.privateChat === undefined ? 'allowlist' : String(p.privateChat).toLowerCase(),
    groupChat: p.groupChat === undefined ? 'mention' : String(p.groupChat).toLowerCase(),
    allowUsers,
    allowGroups,
    ownerUsers: [...new Set(resolvedOwners)],
    adminUsers: [...new Set(resolvedAdmins.filter((id) => !resolvedOwners.includes(id)))],
    allowAllUsers: p.allowAllUsers === true,
    allowAllGroups: p.allowAllGroups === true,
    ignoreSelf: p.ignoreSelf !== false
  };
}

/** 命令级角色：owner > admin > user > none。本地 adminBypass 恒 owner。 */
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

export function roleAtLeast(role, required) {
  const rank = { none: 0, user: 1, admin: 2, owner: 3 };
  return (rank[role] || 0) >= (rank[required] || 0);
}

/**
 * 启动时校验。返回 errors 时调用方必须拒绝启动（索引进程 exit 1）。
 * 注意：群白名单为空不是启动错误——它表示“所有群都拒绝”，不是静默开放。
 */
export function validatePolicy(raw = {}) {
  const policy = normalizePolicy(raw);
  const errors = [];
  const warnings = [];

  if (!PRIVATE_MODES.has(policy.privateChat)) {
    errors.push('policy.privateChat 只能是 allowlist | allow | deny，当前：' + policy.privateChat);
  }
  if (!GROUP_MODES.has(policy.groupChat)) {
    errors.push('policy.groupChat 只能是 mention | allow | deny，当前：' + policy.groupChat);
  }

  if (policy.privateChat === 'allowlist' && !policy.allowUsers.length && !policy.allowAllUsers) {
    errors.push('policy.allowUsers 为空：私聊默认拒绝。请填至少一个允许的 QQ 号，' +
      '或显式写 allowAllUsers:true（会对所有陌生人开放，启动会告警）。');
  }
  if (policy.privateChat === 'allow' && !policy.allowAllUsers) {
    errors.push('policy.privateChat="allow" 必须显式配合 allowAllUsers:true；不要把它当调试默认。');
  }
  if (policy.allowAllUsers) {
    warnings.push('⚠️ allowAllUsers:true：私聊对所有陌生人开放');
  }

  if (policy.groupChat === 'allow' && !policy.allowGroups.length && !policy.allowAllGroups) {
    errors.push('policy.groupChat="allow" 必须配合 allowGroups 白名单或显式 allowAllGroups:true。');
  }
  if (policy.groupChat !== 'deny' && !policy.allowGroups.length && !policy.allowAllGroups) {
    warnings.push('群白名单为空：所有群消息都会被拒绝（不会静默开放）');
  }
  if (policy.allowAllGroups) {
    warnings.push('⚠️ allowAllGroups:true：群聊不限制群号');
  }
  if (policy.allowUsers.length) {
    warnings.push('用户白名单 ' + policy.allowUsers.length + ' 个（不打印号码）');
    warnings.push('命令角色：owner ' + policy.ownerUsers.length + ' 个，admin ' + policy.adminUsers.length +
      ' 个（owner/admin 可 /ws /model、/sessions all、/session bind；/permission 仅 owner）');
  }
  if (policy.allowGroups.length) {
    warnings.push('群白名单 ' + policy.allowGroups.length + ' 个（不打印群号）');
  }

  return { ok: errors.length === 0, policy, errors, warnings };
}

/**
 * 纯判定函数；不读写状态，方便单测。
 * @returns {{ok:boolean, why?:string}}
 */
export function decidePolicy(policy, { isGroup, userId, groupId, mentioned, selfId } = {}) {
  const p = policy;
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
    if (groups.length && !groups.includes(String(groupId))) {
      return { ok: false, why: 'group-not-allowed' };
    }
    if (!groups.length && !p.allowAllGroups) {
      // 空白名单 = 全部拒绝，而不是“没配置就当公开”
      return { ok: false, why: 'group-not-allowed' };
    }
    if (p.groupChat === 'mention' && !mentioned) {
      return { ok: false, why: 'not-mentioned' };
    }
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

/** 给启动日志/状态页用的摘要；只出数量和模式，不出号码。 */
export function describePolicy(policy) {
  const p = policy;
  return [
    '私聊=' + p.privateChat,
    '群聊=' + p.groupChat,
    '用户白名单=' + p.allowUsers.length,
    'owner=' + (p.ownerUsers || []).length,
    'admin=' + (p.adminUsers || []).length,
    '群白名单=' + p.allowGroups.length,
    'allowAllUsers=' + (p.allowAllUsers ? 'true' : 'false'),
    'allowAllGroups=' + (p.allowAllGroups ? 'true' : 'false')
  ].join(' ');
}

export function maskId(id) {
  const s = String(id ?? '');
  if (!s) return '（空）';
  if (s.length <= 6) return s[0] + '***' + s[s.length - 1];
  return s.slice(0, 2) + '***' + s.slice(-2);
}

export function maskChatKey(chatKey) {
  const s = String(chatKey ?? '');
  const parts = s.split(':');
  if (parts.length < 2) return maskId(s);
  // group:<群号>:<成员号> 要逐段脱敏；旧写法会把 "123:456" 当成一个号码。
  return parts[0] + ':' + parts.slice(1).map((p) => maskId(p)).join(':');
}
