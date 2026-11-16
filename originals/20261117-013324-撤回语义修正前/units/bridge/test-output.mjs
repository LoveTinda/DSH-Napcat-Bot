/**
 * 目的：给 `/output` 四档上锁——档位合法性、默认值、四档渲染差异（工具行/思维链只在高档出现）、
 *       空内容不硬造内容、/output 文案与旧机器人原文一致。
 * 边界：只测纯函数（output.mjs），不发消息、不读配置。
 * 依赖：node:assert + ./output.mjs；`node units/bridge/test-output.mjs` 运行。
 * 失败：任一断言不过 → 退出码 1。
 */

import assert from 'node:assert/strict';
import {
  TIERS, DEFAULT_TIER, isTier, normalizeTier, describeTier, tierListText,
  renderByTier, summarizeTool, compactNotice,
} from './output.mjs';

let pass = 0;
const check = (name, fn) => {
  try { fn(); pass++; console.log('PASS ', name); }
  catch (e) { console.log('FAIL ', name, '→', e.message); process.exitCode = 1; }
};

const sample = {
  final: '最终总结：有 3 个目录。',
  texts: ['我先数一下。'],
  tools: [{ tool: 'bash', input: { command: 'ls -d */ | wc -l' }, status: 'completed' }],
  thinking: ['用户要目录数，用 ls 或 find 数一下就行。'.repeat(20)],
};

check('四档齐全且顺序对', () => {
  assert.deepEqual(TIERS.map((t) => t.id), ['minimalist', 'concise', 'detailed', 'complete']);
});

check('默认档位是 minimalist', () => {
  assert.equal(DEFAULT_TIER, 'minimalist');
  assert.equal(normalizeTier(''), 'minimalist');
  assert.equal(normalizeTier('乱写'), 'minimalist');
});

check('档位校验大小写不敏感', () => {
  assert.equal(isTier('DETAILED'), true);
  assert.equal(isTier('nope'), false);
  assert.equal(normalizeTier('Complete'), 'complete');
});

check('minimalist 只给最终总结', () => {
  const out = renderByTier(sample, 'minimalist');
  assert.equal(out, sample.final);
  assert.ok(!out.includes('[工具]'));
  assert.ok(!out.includes('[思考]'));
});

check('concise 带正文 + 总结，不带工具/思考', () => {
  const out = renderByTier(sample, 'concise');
  assert.ok(out.includes('我先数一下。'));
  assert.ok(out.includes('最终总结'));
  assert.ok(!out.includes('[工具]'));
  assert.ok(!out.includes('[思考]'));
});

check('detailed 带工具行，不带思考', () => {
  const out = renderByTier(sample, 'detailed');
  assert.ok(out.includes('[工具] 1 次'));
  assert.ok(out.includes('bash: ls -d */ | wc -l'));
  assert.ok(!out.includes('[思考]'));
  assert.ok(out.includes('最终总结'));
});

check('complete 带思考，且思考被截断', () => {
  const out = renderByTier(sample, 'complete', { maxThinkingChars: 40 });
  assert.ok(out.includes('[思考]'));
  const thinkPart = out.split('[思考] ')[1].split('\n')[0];
  assert.ok(thinkPart.length <= 41, '思考长度 ' + thinkPart.length);
});

check('没有工具/思考时不造空段落', () => {
  const out = renderByTier({ final: '就一句', texts: [], tools: [], thinking: [] }, 'complete');
  assert.equal(out, '就一句');
});

check('正文与总结重复时只留一份', () => {
  const out = renderByTier({ final: '同一句', texts: ['同一句'], tools: [], thinking: [] }, 'concise');
  assert.equal(out.split('同一句').length - 1, 1, out);
});

check('工具行带失败标记，最多列 6 条', () => {
  const tools = Array.from({ length: 9 }, (_, i) => ({ tool: 'bash', input: { command: 'cmd' + i }, status: i === 0 ? 'error' : 'completed' }));
  const out = renderByTier({ final: 'x', tools }, 'detailed', { maxTools: 6 });
  assert.ok(out.includes('（error）'));
  assert.ok(out.includes('还有 3 次调用'));
});

check('summarizeTool 优先挑可读参数，且截断', () => {
  assert.equal(summarizeTool('bash', { command: 'ls' }), 'bash: ls');
  assert.equal(summarizeTool('read', { file_path: '/a/b' }), 'read: /a/b');
  assert.equal(summarizeTool('x', {}), 'x');
  assert.ok(summarizeTool('y', { query: 'q'.repeat(200) }).length < 100);
});

check('/output 无参文案与旧机器人一致（含 ▸ 与四档）', () => {
  const text = tierListText('detailed');
  assert.ok(text.includes('当前输出档位：详细（detailed）'));
  assert.ok(text.includes('▸ detailed'));
  for (const t of TIERS) assert.ok(text.includes(t.id));
  assert.ok(text.includes('只影响本聊天，下一轮生效'));
});

check('describeTier 输出「名（id）／组成」', () => {
  assert.equal(describeTier('complete'), '完整（complete）／工具调用 + 思维链简要 + 正文 + 总结');
});

check('压缩提示带轮数', () => {
  assert.ok(compactNotice(15).includes('15 轮'));
});

console.log(`\n${pass}/${pass + (process.exitCode ? 1 : 0)} 通过`);
