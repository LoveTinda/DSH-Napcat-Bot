/**
 * 目的：给「拟人化投递」上锁——切条不切坏代码、句子不被腰斩、条数与总等待有上限、开关能关。
 * 边界：只测纯函数（humanize.mjs），不真的等待、不发消息。
 * 依赖：node:assert + ./humanize.mjs；`node units/bridge/test-humanize.mjs` 运行。
 * 失败：任一断言不过 → 退出码 1。
 */

import assert from 'node:assert/strict';
import { splitBubbles, planDelivery, sentencesOf, describeHumanize, DEFAULT_HUMANIZE } from './humanize.mjs';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log('PASS ', name); }
  catch (e) { console.log('FAIL ', name, '→', e.message); process.exitCode = 1; }
};

// 每条 20 字，配合 maxChars=40 使用（maxChars 有 40 的下限，见 splitBubbles 的 clamp）
const longSentences = (n) => Array.from({ length: n }, (_, i) => '第' + i + '句' + '啊'.repeat(15) + '。').join('');

// 固定随机源，保证计划可复现
const rng = () => 0.5;

// ---------- 切分 ----------
check('短回复只有一条', () => {
  assert.deepEqual(splitBubbles('好的，我在。').length, 1);
});

check('空输入退化成一个空条', () => {
  assert.deepEqual(splitBubbles(''), ['']);
  assert.deepEqual(splitBubbles(null), ['']);
});

check('长文本按上限切成多条', () => {
  const text = Array.from({ length: 12 }, (_, i) => '这是第' + (i + 1) + '句，用来把长度撑开一点。').join('');
  const bubbles = splitBubbles(text, { maxChars: 60, maxBubbles: 5 });
  assert.ok(bubbles.length > 1, '应该切成多条');
  assert.ok(bubbles.every((b) => b.length <= 120), JSON.stringify(bubbles.map((b) => b.length)));
});

check('句子不会被切在标点中间（每条以标点或换行结尾，或本身超短）', () => {
  const text = '第一句。第二句！第三句？第四句。';
  const bubbles = splitBubbles(text, { maxChars: 40, maxBubbles: 4 });
  for (const b of bubbles) {
    assert.ok(/[。！？]$/.test(b) || b.length < 40, '被切坏了：' + b);
  }
});

check('代码块整块不拆', () => {
  const text = '看这个：\n```js\nconst a = 1;\nconst b = 2;\n```\n就是这样。';
  const bubbles = splitBubbles(text, { maxChars: 20, maxBubbles: 4 });
  const joined = bubbles.join('\n');
  assert.ok(joined.includes('const a = 1;') && joined.includes('const b = 2;'));
  const codeBubble = bubbles.find((b) => b.startsWith('```'));
  assert.ok(codeBubble && codeBubble.includes('```js') && codeBubble.trim().endsWith('```'), '代码围栏被切断了：' + JSON.stringify(bubbles));
});

check('条数超上限时并进最后一条，不刷屏', () => {
  const text = longSentences(24);
  const bubbles = splitBubbles(text, { maxChars: 40, maxBubbles: 3 });
  assert.equal(bubbles.length, 3, JSON.stringify(bubbles.map((b) => b.length)));
  assert.ok(bubbles[2].length > bubbles[0].length, '最后一条应更长：' + JSON.stringify(bubbles.map((b) => b.length)));
});

check('断句保留标点', () => {
  assert.deepEqual(sentencesOf('甲。乙！丙？'), ['甲。', '乙！', '丙？']);
  assert.deepEqual(sentencesOf('没有标点'), ['没有标点']);
});

// ---------- 计划 ----------
check('第一条不等待', () => {
  const plan = planDelivery(longSentences(3), { maxChars: 40, maxBubbles: 3, rng });
  assert.equal(plan[0].delayMs, 0);
});

check('后面的条有等待，且在 min/max 之间', () => {
  const plan = planDelivery(longSentences(4), { maxChars: 40, maxBubbles: 4, minDelayMs: 300, maxDelayMs: 900, perCharMs: 50, jitter: 0, rng });
  assert.ok(plan.length > 1, '应分成多条：' + plan.length);
  for (const item of plan.slice(1)) {
    assert.ok(item.delayMs >= 300 && item.delayMs <= 900, '越界：' + item.delayMs);
  }
});

check('总等待有上限', () => {
  const plan = planDelivery(longSentences(8), { maxChars: 40, maxBubbles: 6, minDelayMs: 1000, maxDelayMs: 2000, totalDelayCapMs: 1500, jitter: 0, rng });
  const total = plan.reduce((a, b) => a + b.delayMs, 0);
  assert.ok(plan.length > 1, '应分成多条');
  assert.ok(total <= 1500, '总等待 ' + total);
});

check('enabled=false 时只发一条且不等待', () => {
  const plan = planDelivery('很长'.repeat(500), { enabled: false });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].delayMs, 0);
});

check('计划里的文本拼起来覆盖原文要点（不丢内容）', () => {
  const text = longSentences(3);
  const plan = planDelivery(text, { maxChars: 40, maxBubbles: 4, rng });
  const joined = plan.map((p) => p.text).join('\n').replace(/\s+/g, '');
  assert.equal(joined, text.replace(/\s+/g, ''));
});

check('jitter 不会让等待变成负数', () => {
  const plan = planDelivery(longSentences(3), { maxChars: 40, maxBubbles: 3, minDelayMs: 10, maxDelayMs: 20, jitter: 1, rng: () => 0 });
  for (const p of plan) assert.ok(p.delayMs >= 0);
});

check('默认参数是保守的（条数 ≤3、总等待 ≤4s）', () => {
  assert.ok(DEFAULT_HUMANIZE.maxBubbles <= 3);
  assert.ok(DEFAULT_HUMANIZE.totalDelayCapMs <= 4000);
  assert.equal(DEFAULT_HUMANIZE.enabled, true);
});

check('摘要能读出开关与参数', () => {
  assert.ok(describeHumanize({ enabled: false }).includes('关闭'));
  const on = describeHumanize({ enabled: true, maxBubbles: 3, maxChars: 240, totalDelayCapMs: 4000 });
  assert.ok(on.includes('最多 3 条'));
  assert.ok(on.includes('240'));
});

check('注入 rng 决定抖动方向（可复现）', () => {
  const a = planDelivery(longSentences(3), { maxChars: 40, maxBubbles: 3, perCharMs: 100, minDelayMs: 100, maxDelayMs: 1000, jitter: 0.5, rng: () => 1 });
  const b = planDelivery(longSentences(3), { maxChars: 40, maxBubbles: 3, perCharMs: 100, minDelayMs: 100, maxDelayMs: 1000, jitter: 0.5, rng: () => 0 });
  assert.ok(a.length > 1 && b.length > 1, '应分成多条');
  assert.ok(a[1].delayMs > b[1].delayMs, a[1].delayMs + ' vs ' + b[1].delayMs);
});

console.log(`\n${pass}/${pass + (process.exitCode ? 1 : 0)} 通过`);
