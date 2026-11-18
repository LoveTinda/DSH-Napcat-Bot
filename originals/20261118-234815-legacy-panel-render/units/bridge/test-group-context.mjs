/**
 * 目的：给「群上下文」上锁——只留最近 N 条、超长截断、过期清理、注入块有字数上限、
 *       统计里不出现正文。
 * 边界：只测纯内存结构（group-context.mjs），不起进程、不睡觉（用假时钟）。
 * 依赖：node:assert + ./group-context.mjs；`node units/bridge/test-group-context.mjs` 运行。
 * 失败：任一断言不过 → 退出码 1。
 */

import assert from 'node:assert/strict';
import { createGroupContext, formatLine, DEFAULT_GROUP_CONTEXT } from './group-context.mjs';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log('PASS ', name); }
  catch (e) { console.log('FAIL ', name, '→', e.message); process.exitCode = 1; }
};

const msg = (over = {}) => ({ groupId: 'G1', userId: '12345678', name: '小明', text: '在吗', at: Date.now(), ...over });

check('记一条能取回来', () => {
  const ctx = createGroupContext();
  assert.equal(ctx.record(msg()), true);
  const list = ctx.recent('G1');
  assert.equal(list.length, 1);
  assert.equal(list[0].text, '在吗');
});

check('空文本/没群号不记', () => {
  const ctx = createGroupContext();
  assert.equal(ctx.record(msg({ text: '   ' })), false);
  assert.equal(ctx.record(msg({ groupId: '' })), false);
});

check('只留最近 N 条（默认 8）', () => {
  const ctx = createGroupContext({ maxMessages: 3 });
  for (let i = 0; i < 6; i++) ctx.record(msg({ text: '第' + i + '条' }));
  const list = ctx.recent('G1');
  assert.deepEqual(list.map((x) => x.text), ['第3条', '第4条', '第5条']);
});

check('单条超长会截断（默认 300 字）', () => {
  const ctx = createGroupContext({ maxMessageChars: 10 });
  ctx.record(msg({ text: '啊'.repeat(50) }));
  assert.equal(ctx.recent('G1')[0].text.length, 10);
});

check('注入块排除最后一条（当前这句）', () => {
  const ctx = createGroupContext();
  ctx.record(msg({ text: '第一句' }));
  ctx.record(msg({ text: '第二句' }));
  ctx.record(msg({ text: '当前这句' }));
  const block = ctx.buildBlock('G1');
  assert.ok(block.includes('第一句'));
  assert.ok(block.includes('第二句'));
  assert.ok(!block.includes('当前这句'), block);
});

check('只有一条时不注入（没有历史可说）', () => {
  const ctx = createGroupContext();
  ctx.record(msg({ text: '只有这句' }));
  assert.equal(ctx.buildBlock('G1'), '');
});

check('注入块有字数上限，超了从最旧开始丢', () => {
  const ctx = createGroupContext({ maxChars: 120 });
  for (let i = 0; i < 20; i++) ctx.record(msg({ text: '第' + i + '条要长一点才能撑爆上限啊' }));
  const block = ctx.buildBlock('G1');
  assert.ok(block.length <= 200, '块长度 ' + block.length);
  assert.ok(block.includes('第18条'), '次新的应该在（第19条是当前这句，被排除）');
  assert.ok(!block.includes('第0条'), '最旧的应该被丢掉');
});

check('过期的消息会被清掉', () => {
  const ctx = createGroupContext({ ttlMinutes: 1 });
  const old = Date.now() - 5 * 60 * 1000;
  ctx.record(msg({ text: '很久以前', at: old }));
  assert.equal(ctx.recent('G1').length, 0);
});

check('群太多时丢最久没动静的', () => {
  const ctx = createGroupContext({ maxGroups: 2 });
  const now = Date.now();
  ctx.record(msg({ groupId: 'A', text: 'a', at: now - 3000 }));
  ctx.record(msg({ groupId: 'B', text: 'b', at: now - 2000 }));
  ctx.record(msg({ groupId: 'C', text: 'c', at: now - 1000 }));
  const st = ctx.stats();
  assert.equal(st.groups, 2);
  assert.equal(ctx.recent('A').length, 0, 'A 应被丢掉');
  assert.equal(ctx.recent('C').length, 1);
});

check('开关关闭后不记也不注入', () => {
  const ctx = createGroupContext({ enabled: false });
  assert.equal(ctx.record(msg()), false);
  assert.equal(ctx.buildBlock('G1'), '');
  assert.ok(ctx.describe().includes('关闭'));
});

check('统计只给数量和时间，不含正文', () => {
  const ctx = createGroupContext();
  ctx.record(msg({ text: '这句话不该出现在统计里' }));
  const st = ctx.stats();
  assert.equal(st.messages, 1);
  assert.equal(st.groups, 1);
  assert.ok(st.newestAt > 0);
  const text = JSON.stringify(st);
  assert.ok(!text.includes('不该出现'), text);
});

check('清空单个群 / 全部', () => {
  const ctx = createGroupContext();
  ctx.record(msg({ groupId: 'A' }));
  ctx.record(msg({ groupId: 'B' }));
  ctx.clear('A');
  assert.equal(ctx.recent('A').length, 0);
  assert.equal(ctx.recent('B').length, 1);
  ctx.clear();
  assert.equal(ctx.stats().messages, 0);
});

check('行格式带昵称与号码尾号，不带完整号码', () => {
  const line = formatLine({ name: '小明', userId: '123456789', text: '你好' });
  assert.ok(line.includes('小明'));
  assert.ok(line.includes('6789'));
  assert.ok(!line.includes('123456789'), line);
});

check('没昵称时用「群友」', () => {
  assert.ok(formatLine({ userId: '12345678', text: 'x' }).startsWith('群友'));
});

check('默认参数保守：每群 ≤8 条、注入 ≤1200 字', () => {
  assert.ok(DEFAULT_GROUP_CONTEXT.maxMessages <= 8);
  assert.ok(DEFAULT_GROUP_CONTEXT.maxChars <= 1200);
  assert.equal(DEFAULT_GROUP_CONTEXT.enabled, true);
});

console.log(`\n${pass}/${pass + (process.exitCode ? 1 : 0)} 通过`);
