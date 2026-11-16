#!/usr/bin/env node
/**
 * 目的：告警判定的单测——连续失败阈值、冷却窗口、成功清零、磁盘百分比、QQ 打码。
 * 边界：不测真实发消息，不启动桥接器；只测 alerts.mjs 的纯函数。
 * 依赖：node 内置 assert；units/bridge/alerts.mjs。
 * 失败：任一断言不成立 → 退出码 1，并打印实际值。
 * 副作用：无（不写文件、不联网）。
 */

import assert from 'node:assert/strict';
import { createAlertGate, diskUsedPercent, maskQq } from './alerts.mjs';

const results = [];
function check(name, fn) {
  try { fn(); results.push([true, name]); console.log('PASS  ' + name); }
  catch (e) { results.push([false, name]); console.log('FAIL  ' + name + '  → ' + e.message); }
}

function fakeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

check('默认阈值 3：前两次失败不告警', () => {
  const g = createAlertGate();
  assert.equal(g.recordFailure(), false);
  assert.equal(g.recordFailure(), false);
});

check('连续 3 次失败触发告警', () => {
  const g = createAlertGate();
  assert.equal(g.recordFailure(), false);
  assert.equal(g.recordFailure(), false);
  assert.equal(g.recordFailure(), true);
});

check('冷却窗口内不再重复告警，并计入 suppressed', () => {
  const clock = fakeClock();
  const g = createAlertGate({ failStreak: 1, cooldownMs: 60000, now: clock.now });
  assert.equal(g.recordFailure(), true);
  g.markSent('fail');
  assert.equal(g.recordFailure(), false);
  assert.equal(g.stats().suppressed, 1);
});

check('过了冷却窗口可以再告警', () => {
  const clock = fakeClock();
  const g = createAlertGate({ failStreak: 1, cooldownMs: 60000, now: clock.now });
  assert.equal(g.recordFailure(), true);
  g.markSent('fail');
  clock.advance(60001);
  assert.equal(g.recordFailure(), true);
  assert.equal(g.stats().sent, 1);
});

check('成功一次把连续失败清零', () => {
  const g = createAlertGate({ failStreak: 2 });
  g.recordFailure();
  g.recordSuccess();
  assert.equal(g.recordFailure(), false);
  assert.equal(g.recordFailure(), true);
});

check('磁盘与失败告警各自独立冷却', () => {
  const clock = fakeClock();
  const g = createAlertGate({ failStreak: 1, cooldownMs: 60000, now: clock.now });
  g.recordFailure(); g.markSent('fail');
  assert.equal(g.allowDisk(), true);
  g.markSent('disk');
  assert.equal(g.allowDisk(), false);
});

check('统计里保留阈值与冷却，供面板解释', () => {
  const g = createAlertGate({ failStreak: 5, cooldownMs: 120000 });
  const s = g.stats();
  assert.equal(s.failStreak, 5);
  assert.equal(s.cooldownMs, 120000);
  assert.equal(s.streak, 0);
});

check('磁盘百分比在 0–100 之间，空目录返回 null', () => {
  const p = diskUsedPercent('/');
  assert.ok(p === null || (p >= 0 && p <= 100), '实际 ' + p);
  assert.equal(diskUsedPercent(''), null);
  assert.equal(diskUsedPercent('/不存在的路径/xxx'), null);
});

check('QQ 号打码保留首尾各两位', () => {
  assert.equal(maskQq('123456789'), '12*****89');
  assert.equal(maskQq('1234'), '1234');
  assert.equal(maskQq(''), '');
  assert.equal(maskQq(null), '');
});

const failed = results.filter((r) => !r[0]);
console.log('\n' + (results.length - failed.length) + '/' + results.length + ' 通过');
process.exit(failed.length ? 1 : 0);
