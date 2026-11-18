/**
 * 目的：给策略判定上锁——谁能触发、群里要不要 @、owner/admin 怎么分级、危险配置会不会被拒。
 * 边界：只测纯函数（policy.mjs），不起进程、不连网络、不读写文件。
 * 依赖：node:assert + ./policy.mjs；由 `node units/bridge/test-policy.mjs` 跑。
 * 失败：任一断言不过 → 退出码 1，并打印是哪一条。
 */

import assert from 'node:assert/strict';
import {
  DEFAULT_POLICY, normalizePolicy, validatePolicy, decidePolicy,
  commandRole, roleAtLeast, describePolicy, explainWhy, maskId, maskChatKey,
} from './policy.mjs';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log('PASS ', name); }
  catch (e) { console.log('FAIL ', name, '→', e.message); process.exitCode = 1; }
};

// ---------- 规整 ----------
check('白名单去重、去空、转字符串', () => {
  const p = normalizePolicy({ allowUsers: ['1', '2', '1', ' ', 3] });
  assert.deepEqual(p.allowUsers, ['1', '2', '3']);
});

check('没写 owner 时第一个白名单用户是 owner，其余是 admin', () => {
  const p = normalizePolicy({ allowUsers: ['111', '222', '333'] });
  assert.deepEqual(p.ownerUsers, ['111']);
  assert.deepEqual(p.adminUsers, ['222', '333']);
});

check('owner 不会同时出现在 admin 里', () => {
  const p = normalizePolicy({ allowUsers: ['1', '2'], ownerUsers: ['2'] });
  assert.deepEqual(p.ownerUsers, ['2']);
  assert.deepEqual(p.adminUsers, []);
});

check('默认私有模式是 allowlist（不是 allow）', () => {
  const p = normalizePolicy({});
  assert.equal(p.privateChat, 'allowlist');
  assert.equal(p.groupChat, 'mention');
  assert.equal(p.hardened, false);
});

// ---------- 校验 ----------
check('私聊 allowlist 且白名单为空 → 拒绝启动', () => {
  const r = validatePolicy({ privateChat: 'allowlist' });
  assert.equal(r.ok, false);
  assert.match(r.errors.join(), /allowUsers 为空/);
});

check('私聊 allow 但没开 allowAllUsers → 拒绝启动', () => {
  const r = validatePolicy({ privateChat: 'allow' });
  assert.equal(r.ok, false);
});

check('非法模式名 → 拒绝启动', () => {
  const r = validatePolicy({ privateChat: 'whatever', groupChat: 'nope' });
  assert.equal(r.ok, false);
  assert.equal(r.errors.length, 2);
});

check('群 allow 但没有群白名单也没开 allowAllGroups → 拒绝启动', () => {
  const r = validatePolicy({ privateChat: 'allow', allowAllUsers: true, groupChat: 'allow' });
  assert.equal(r.ok, false);
});

check('默认策略能过校验，但带告警', () => {
  const r = validatePolicy(DEFAULT_POLICY);
  assert.equal(r.ok, true);
  assert.ok(r.warnings.length >= 2);
  assert.ok(r.warnings.some((w) => w.includes('未加固')));
});

// ---------- 判定：私聊 ----------
const priv = normalizePolicy({ privateChat: 'allowlist', allowUsers: ['10001'] });

check('私聊：白名单内 → 放行', () => {
  assert.equal(decidePolicy(priv, { isGroup: false, userId: '10001' }).ok, true);
});

check('私聊：白名单外 → 拒绝且原因是 user-not-allowed', () => {
  const d = decidePolicy(priv, { isGroup: false, userId: '99999' });
  assert.equal(d.ok, false);
  assert.equal(d.why, 'user-not-allowed');
});

check('私聊：deny 模式一律拒绝', () => {
  const p = normalizePolicy({ privateChat: 'deny' });
  assert.equal(decidePolicy(p, { isGroup: false, userId: '10001' }).why, 'private-denied');
});

check('自己发的消息一律不处理', () => {
  assert.equal(decidePolicy(priv, { isGroup: false, userId: '10001', selfId: '10001' }).why, 'self');
});

check('ignoreSelf:false 时自己发的也放行（显式选择）', () => {
  const p = normalizePolicy({ privateChat: 'allowlist', allowUsers: ['10001'], ignoreSelf: false });
  assert.equal(decidePolicy(p, { isGroup: false, userId: '10001', selfId: '10001' }).ok, true);
});

// ---------- 判定：群 ----------
const grp = normalizePolicy({ privateChat: 'allowlist', allowUsers: ['10001'], groupChat: 'mention', allowAllGroups: true });

check('群：没 @ 就不回', () => {
  assert.equal(decidePolicy(grp, { isGroup: true, userId: '10001', groupId: '555', mentioned: false }).why, 'not-mentioned');
});

check('群：@ 了才回', () => {
  assert.equal(decidePolicy(grp, { isGroup: true, userId: '10001', groupId: '555', mentioned: true }).ok, true);
});

check('群：不在群白名单 → 拒绝', () => {
  const p = normalizePolicy({ privateChat: 'allowlist', allowUsers: ['10001'], groupChat: 'mention', allowGroups: ['777'] });
  assert.equal(decidePolicy(p, { isGroup: true, userId: '10001', groupId: '555', mentioned: true }).why, 'group-not-allowed');
});

check('群：白名单为空且没开 allowAllGroups → 全部拒绝，不静默开放', () => {
  const p = normalizePolicy({ privateChat: 'allowlist', allowUsers: ['10001'], groupChat: 'mention' });
  assert.equal(decidePolicy(p, { isGroup: true, userId: '10001', groupId: '555', mentioned: true }).why, 'group-not-allowed');
});

check('群：groupChat=deny → 一律拒绝', () => {
  const p = normalizePolicy({ privateChat: 'allowlist', allowUsers: ['10001'], groupChat: 'deny' });
  assert.equal(decidePolicy(p, { isGroup: true, userId: '10001', groupId: '555', mentioned: true }).why, 'group-denied');
});

// ---------- 角色 ----------
check('角色梯度：owner > admin > user > none', () => {
  const p = normalizePolicy({ allowUsers: ['1', '2', '3'], ownerUsers: ['1'], adminUsers: ['2'] });
  assert.equal(commandRole(p, { userId: '1' }), 'owner');
  assert.equal(commandRole(p, { userId: '2' }), 'admin');
  assert.equal(commandRole(p, { userId: '3' }), 'user');
  assert.equal(commandRole(p, { userId: '9' }), 'none');
  assert.equal(commandRole(p, { userId: '9', adminBypass: true }), 'owner');
});

check('roleAtLeast 边界', () => {
  assert.equal(roleAtLeast('admin', 'user'), true);
  assert.equal(roleAtLeast('user', 'admin'), false);
  assert.equal(roleAtLeast('none', 'none'), true);
  assert.equal(roleAtLeast(undefined, 'owner'), false);
});

// ---------- 展示 ----------
check('摘要不含号码，只出数量和模式', () => {
  const p = normalizePolicy({ allowUsers: ['123456789', '987654321'], allowGroups: ['555666'] });
  const text = describePolicy(p);
  assert.ok(!text.includes('123456789'));
  assert.ok(text.includes('用户白名单=2'));
  assert.ok(text.includes('allowAllGroups=false'));
});

check('why 能翻成人话', () => {
  assert.equal(explainWhy('not-mentioned'), '群里没 @ 我');
  assert.equal(explainWhy('unknown-code'), 'unknown-code');
});

check('脱敏：短号与长号都不整段暴露', () => {
  assert.equal(maskId('123'), '1***3');
  assert.equal(maskId('123456789'), '12***89');
  assert.equal(maskChatKey('group:555666'), 'group:5***6');   // 6 位及以下只留首尾
});

console.log(`\n${pass}/${pass + (process.exitCode ? 1 : 0)} 通过`);
