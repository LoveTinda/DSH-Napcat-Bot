/**
 * 目的：给命令表上锁——解析、别名、角色门槛、帮助文案、未实现命令不假装能跑。
 * 边界：只测纯函数（commands.mjs），不起进程、不连网络。
 * 依赖：node:assert + ./commands.mjs；`node units/bridge/test-commands.mjs` 运行。
 * 失败：任一断言不过 → 退出码 1。
 */

import assert from 'node:assert/strict';
import { COMMANDS, parseCommand, helpText, helpFor, unknownCommandText, pendingCommandText } from './commands.mjs';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log('PASS ', name); }
  catch (e) { console.log('FAIL ', name, '→', e.message); process.exitCode = 1; }
};

// ---------- 解析 ----------
check('普通文本不是命令', () => {
  assert.equal(parseCommand('你好'), null);
  assert.equal(parseCommand(' 你好'), null);
});

check('单独的斜杠不算命令', () => {
  assert.equal(parseCommand('/'), null);
  assert.equal(parseCommand('/   '), null);
});

check('带参数的命令能拆开', () => {
  const r = parseCommand('/help output');
  assert.equal(r.cmd.name, 'help');
  assert.equal(r.args, 'output');
});

check('别名解析到同一条命令', () => {
  for (const a of ['?', '帮助']) assert.equal(parseCommand('/' + a).cmd.name, 'help');
  for (const a of ['reset', '新会话', '重置']) assert.equal(parseCommand('/' + a).cmd.name, 'new');
  for (const a of ['history', '会话', '历史', '列表']) assert.equal(parseCommand('/' + a).cmd.name, 'sessions');
  for (const a of ['acl', '策略']) assert.equal(parseCommand('/' + a).cmd.name, 'policy');
});

check('大小写不敏感（/HELP）', () => {
  assert.equal(parseCommand('/HELP').cmd.name, 'help');
});

check('不认识的命令：cmd 为 null，但名字留着给回执用', () => {
  const r = parseCommand('/nonsense');
  assert.equal(r.cmd, null);
  assert.equal(r.name, 'nonsense');
});

// ---------- 表本身 ----------
check('规格里的命令都在表里', () => {
  const names = new Set(COMMANDS.map((c) => c.name));
  for (const n of ['help', 'status', 'ping', 'new', 'stop', 'sessions', 'session', 'context', 'ws', 'ls',
    'model', 'effort', 'output', 'persona', 'balance', 'policy', 'notice',
    'compact', 'export', 'feedback', 'goal', 'permission', 'plan']) {
    assert.ok(names.has(n), '缺命令 ' + n);
  }
});

check('每条命令都有 role / kind / desc / detail', () => {
  for (const c of COMMANDS) {
    assert.ok(['user', 'admin', 'owner'].includes(c.role), c.name + ' role');
    assert.ok(['local', 'passthrough', 'pending'].includes(c.kind), c.name + ' kind');
    assert.ok(c.desc && c.desc.length > 2, c.name + ' desc');
    assert.ok(c.detail && c.detail.length > 4, c.name + ' detail');
  }
});

check('别名不重复（两个命令不能抢同一个别名）', () => {
  const seen = new Map();
  for (const c of COMMANDS) {
    for (const a of [c.name, ...c.alias]) {
      assert.ok(!seen.has(a), '别名冲突：/' + a + ' 同时属于 ' + seen.get(a) + ' 和 ' + c.name);
      seen.set(a, c.name);
    }
  }
});

check('/permission 只有 owner 能用', () => {
  assert.equal(COMMANDS.find((c) => c.name === 'permission').role, 'owner');
});

check('管理类命令至少 admin（model/effort/output/balance/ws）', () => {
  for (const n of ['model', 'effort', 'output', 'balance', 'ws']) {
    assert.ok(['admin', 'owner'].includes(COMMANDS.find((c) => c.name === n).role), n);
  }
});

// ---------- 文案 ----------
check('帮助列出所有命令名', () => {
  const text = helpText();
  for (const c of COMMANDS) assert.ok(text.includes('/' + c.name), '缺少 /' + c.name);
  assert.ok(text.includes('两种输入'));
});

check('帮助标出未实现与透传', () => {
  const text = helpText();
  assert.ok(text.includes('（未实现）'));
  assert.ok(text.includes('（透传 DSH）'));
});

check('帮助里不含号码类敏感内容', () => {
  const text = helpText();
  assert.ok(!/\d{6,}/.test(text), '帮助里出现了长数字');
});

check('/help <命令> 给详细用法；支持带斜杠', () => {
  assert.ok(helpFor('output').includes('/output'));
  assert.ok(helpFor('/output').includes('/output'));
  assert.ok(helpFor('new').includes('新会话'));
});

check('/help <不存在> 给出可用提示', () => {
  const t = helpFor('nope');
  assert.ok(t.includes('没有这条命令'));
  assert.ok(t.includes('/help'));
});

check('未实现命令会明说没实现', () => {
  const c = COMMANDS.find((x) => x.name === 'output');
  assert.ok(pendingCommandText(c).includes('还没实现'));
});

check('未知命令回执带命令名', () => {
  assert.ok(unknownCommandText('foo').includes('/foo'));
});

console.log(`\n${pass}/${pass + (process.exitCode ? 1 : 0)} 通过`);
