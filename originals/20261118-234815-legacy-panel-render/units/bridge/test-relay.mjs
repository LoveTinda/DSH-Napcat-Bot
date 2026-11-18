/**
 * 目的：给「维护期自动回复」上锁——阈值、冷却、成功后复位、关闭时完全不影响正常失败。
 * 边界：只测纯状态机（relay.mjs），用注入时钟，不真的等 2 分钟。
 * 依赖：node:assert + ./relay.mjs；`node units/bridge/test-relay.mjs` 运行。
 * 失败：任一断言不过 → 退出码 1。
 */

import assert from 'node:assert/strict';
import { createRelay, DEFAULT_RELAY } from './relay.mjs';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log('PASS ', name); }
  catch (e) { console.log('FAIL ', name, '→', e.message); process.exitCode = 1; }
};

/** 可控时钟 */
function clock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

check('失败次数没到阈值不进入维护期', () => {
  const r = createRelay({ afterFailures: 3, now: clock().now });
  r.fail(); r.fail();
  assert.equal(r.shouldRelay().relay, false);
});

check('到阈值就进维护期并给文案', () => {
  const r = createRelay({ afterFailures: 3, now: clock().now });
  r.fail(); r.fail(); r.fail();
  const out = r.shouldRelay();
  assert.equal(out.relay, true);
  assert.ok(out.text.length > 0);
});

check('冷却内不重复发', () => {
  const c = clock();
  const r = createRelay({ afterFailures: 3, cooldownMs: 60000, now: c.now });
  r.fail(); r.fail(); r.fail();
  assert.equal(r.shouldRelay().relay, true);
  c.advance(1000);
  assert.equal(r.shouldRelay().relay, false, '冷却内不该再发');
  c.advance(60000);
  assert.equal(r.shouldRelay().relay, true, '冷却过了可以再发');
});

check('成功后复位，恢复正常失败路径', () => {
  const r = createRelay({ afterFailures: 2, now: clock().now });
  r.fail(); r.fail();
  assert.equal(r.shouldRelay().relay, true);
  r.ok();
  assert.equal(r.shouldRelay().relay, false);
  assert.equal(r.stats().streak, 0);
});

check('关闭后永远不进维护期', () => {
  const r = createRelay({ enabled: false, afterFailures: 1, now: clock().now });
  r.fail(); r.fail(); r.fail();
  assert.equal(r.shouldRelay().relay, false);
  assert.ok(r.describe().includes('关闭'));
});

check('统计能看出压掉了多少次', () => {
  const c = clock();
  const r = createRelay({ afterFailures: 1, cooldownMs: 10000, now: c.now });
  r.fail();
  r.shouldRelay();          // 第一次发
  r.shouldRelay();          // 冷却内 → suppressed
  r.shouldRelay();          // 冷却内 → suppressed
  const st = r.stats();
  assert.equal(st.relayed, 1);
  assert.equal(st.suppressed, 2);
});

check('默认参数合理（3 次 / 2 分钟）', () => {
  assert.equal(DEFAULT_RELAY.afterFailures, 3);
  assert.equal(DEFAULT_RELAY.cooldownMs, 120000);
  assert.equal(DEFAULT_RELAY.enabled, true);
});

check('文案可自定义', () => {
  const r = createRelay({ afterFailures: 1, message: '在修，等会儿', now: clock().now });
  r.fail();
  assert.equal(r.shouldRelay().text, '在修，等会儿');
});

console.log(`\n${pass}/${pass + (process.exitCode ? 1 : 0)} 通过`);
