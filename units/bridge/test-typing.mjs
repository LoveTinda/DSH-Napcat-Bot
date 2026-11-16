// 目的：验证输入状态开关的时序、续期、停止与失败不影响主流程。
// 边界：只用注入的假定时器与假发送函数，不连 NapCat、不真的等 8 秒。
// 依赖：node 内置 assert；被 `node units/bridge/test-typing.mjs` 直接跑。
// 失败：任一断言不成立 → 退出码 1。

import assert from 'node:assert/strict';
import { createTyping, describeTyping, DEFAULT_TYPING } from './typing.mjs';

let pass = 0;
function check(name, fn) {
  try { fn(); pass++; console.log('PASS ', name); }
  catch (e) { console.log('FAIL ', name, '—', e.message); process.exitCode = 1; }
}

/** 假定时器：手动推进，别让测试真的等。 */
function fakeTimer() {
  const jobs = new Map();
  let seq = 0;
  return {
    set: (fn) => { const id = ++seq; jobs.set(id, fn); return id; },
    clear: (id) => { jobs.delete(id); },
    // 行为对齐 setInterval：到点就调，不自动删除（只有 clear 才删）。
    tick: (n = 1) => { for (let i = 0; i < n; i++) for (const fn of [...jobs.values()]) fn(); },
    size: () => jobs.size,
  };
}

function make(opts = {}) {
  const sent = [];
  const t = fakeTimer();
  const typing = createTyping({
    keepaliveMs: 8000,
    send: (type) => { sent.push(type); },
    setTimer: (fn) => t.set(fn),
    clearTimer: (id) => t.clear(id),
    ...opts,
  });
  return { typing, sent, t };
}

check('默认值：开启、8 秒续期、0/1 事件', () => {
  assert.equal(DEFAULT_TYPING.enabled, true);
  assert.equal(DEFAULT_TYPING.keepaliveMs, 8000);
  assert.equal(DEFAULT_TYPING.eventStart, 0);
  assert.equal(DEFAULT_TYPING.eventStop, 1);
});

check('start 立刻发「开始」', () => {
  const { typing, sent } = make();
  typing.start();
  assert.deepEqual(sent, [0]);
});

check('续期：每 8 秒重发一次「开始」', () => {
  const { typing, sent, t } = make();
  typing.start();
  t.tick(2);
  assert.deepEqual(sent, [0, 0, 0]);
});

check('stop 发「停止」并清掉计时器', () => {
  const { typing, sent, t } = make();
  typing.start();
  typing.stop();
  assert.deepEqual(sent, [0, 1]);
  assert.equal(t.size(), 0);
});

check('stop 之后再 tick 也不会再发', () => {
  const { typing, sent, t } = make();
  typing.start();
  typing.stop();
  t.tick(3);
  assert.deepEqual(sent, [0, 1]);
});

check('重复 start 不会叠加计时器', () => {
  const { typing, sent, t } = make();
  typing.start();
  typing.start();
  assert.deepEqual(sent, [0]);
  assert.equal(t.size(), 1);
});

check('重复 stop 只发一次停止', () => {
  const { typing, sent } = make();
  typing.start();
  typing.stop();
  typing.stop();
  assert.deepEqual(sent, [0, 1]);
});

check('未 start 就 stop 什么都不发', () => {
  const { typing, sent } = make();
  typing.stop();
  assert.deepEqual(sent, []);
});

check('enabled=false 时完全不动', () => {
  const { typing, sent, t } = make({ enabled: false });
  typing.start();
  typing.stop();
  assert.deepEqual(sent, []);
  assert.equal(t.size(), 0);
});

check('keepaliveMs=0 时只亮一次', () => {
  const { typing, sent, t } = make({ keepaliveMs: 0 });
  typing.start();
  t.tick(3);
  assert.deepEqual(sent, [0]);
  assert.equal(t.size(), 0);
});

check('send 抛错不影响 start/stop', () => {
  const errors = [];
  const { typing } = make({ send: () => { throw new Error('3001 没开'); }, onError: (e) => errors.push(e.message) });
  typing.start();
  typing.stop();
  assert.equal(errors.length, 2);
  assert.equal(errors[0], '3001 没开');
});

check('send 返回 rejected Promise 也被接住', async () => {
  const errors = [];
  const { typing } = make({ send: () => Promise.reject(new Error('断线')), onError: (e) => errors.push(e.message) });
  typing.start();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(errors.length, 1);
});

check('stats 反映状态', () => {
  const { typing } = make();
  assert.equal(typing.stats().running, false);
  typing.start();
  assert.equal(typing.stats().running, true);
  assert.equal(typing.stats().sent, 1);
  typing.stop();
  assert.equal(typing.stats().running, false);
  assert.equal(typing.stats().lastType, 1);
});

check('describeTyping 说人话', () => {
  assert.match(describeTyping({ enabled: true, keepaliveMs: 8000 }), /私聊开启/);
  assert.match(describeTyping({ enabled: false }), /^关/);
});

check('非法 keepalive 被夹住', () => {
  const { typing } = make({ keepaliveMs: -5 });
  assert.equal(typing.stats().keepaliveMs, 0);
  const { typing: t2 } = make({ keepaliveMs: 9e9 });
  assert.equal(t2.stats().keepaliveMs, 120000);
});

console.log(`\n${pass} 项通过${process.exitCode ? '，有失败' : ''}`);
