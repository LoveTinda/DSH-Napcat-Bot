#!/usr/bin/env node
/**
 * 目的：验证交互动作的纯解析逻辑——标记识别、围栏跳过、上限、表情映射、空白清理、提示词，
 *       以及 runActions 的 recall 参数（只删 prevIds，绝不删 currentIds）。
 * 边界：不连 NapCat / DSH、不发真实网络请求；runActions 用注入的假 fetch。
 * 依赖：node: 无（只用 console）；./interactions.mjs。
 * 失败：任一断言不过 → 退出码 1，并打印失败项与期望/实际值。
 * 副作用：无。
 */

import {
  parseActions, runActions, EMOJI_IDS, interactionHint, describeInteractions,
  DEFAULT_INTERACTIONS, MAX_ACTIONS_CAP,
} from './interactions.mjs';

let pass = 0, fail = 0;
const check = (name, ok, detail = '') => {
  if (ok) { pass++; console.log('PASS ', name); }
  else { fail++; console.log('FAIL ', name, detail); }
};
const eq = (name, actual, expected) => check(name, actual === expected, '实际=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expected));

// 用 ` 拼出围栏，避免本文件自己出现三连反引号影响阅读/复制。
const F = '\u0060'.repeat(3);

// 1. 单个 react：中文名映射成 QQ 表情 ID，并从正文删掉
const one = parseActions('谢谢 [[react:赞]]');
eq('单个 react 删除标记', one.text, '谢谢');
eq('单个 react 解析出 1 个动作', one.actions.length, 1);
eq('赞映射到 76', one.actions[0] && one.actions[0].emojiId, '76');

// 2. 多个动作按正文顺序保留
const two = parseActions('收到[[react:爱心]]\n[[poke]]');
eq('多个动作数量', two.actions.length, 2);
eq('多个动作顺序', two.actions.map((a) => a.kind).join(','), 'react,poke');
eq('多个动作后正文只剩「收到」', two.text, '收到');
eq('爱心映射到 66', two.actions[0] && two.actions[0].emojiId, '66');

// 3. 数字表情 ID 原样传
const num = parseActions('[[react:123]]');
eq('数字表情 ID 原样传', num.actions[0] && num.actions[0].emojiId, '123');

// 4. 未知动作原样保留（不能把用户/模型写的内容悄悄吞掉）
const unknown = parseActions('看 [[dance]] 和 [[react:赞]]');
eq('未知动作不解析', unknown.text, '看 [[dance]] 和');
eq('未知动作不计数', unknown.actions.length, 1);

// 5. 空参数不是合法 react，原样保留
const empty = parseActions('a[[react:]]b');
eq('空 react 原样保留', empty.text, 'a[[react:]]b');
eq('空 react 不产生动作', empty.actions.length, 0);

// 6. 动作名大小写不敏感
const upper = parseActions('A[[RECALL]]B[[Poke]]');
eq('大小写不敏感：删标记', upper.text, 'AB');
eq('大小写不敏感：动作序列', upper.actions.map((a) => a.kind).join(','), 'recall,poke');

// 7. 围栏内不解析（含 [[poke]]）
const fenced = ['前', F, '[[react:赞]]', '[[poke]]', F, '后'].join('\n');
const fenceOut = parseActions(fenced);
eq('围栏内不产生动作', fenceOut.actions.length, 0);
check('围栏内标记原样保留', fenceOut.text.includes('[[react:赞]]') && fenceOut.text.includes('[[poke]]'), fenceOut.text);

// 8. 围栏跨多行 + 围栏外的动作照常解析
const mixed = [F + 'js', '[[react:赞]]', '中间行', F, '[[poke]]'].join('\n');
const mixedOut = parseActions(mixed);
eq('跨行围栏外只解析 poke', mixedOut.actions.map((a) => a.kind).join(','), 'poke');
check('跨行围栏内的 react 保留', mixedOut.text.includes('[[react:赞]]'), mixedOut.text);
check('跨行围栏外的 poke 被删', !mixedOut.text.includes('[[poke]]'), mixedOut.text);

// 9. 未闭合围栏：后面所有行都按围栏内处理
const unclosed = ['前', F, '[[react:赞]]', '后'].join('\n');
const unclosedOut = parseActions(unclosed);
eq('未闭合围栏不产生动作', unclosedOut.actions.length, 0);
check('未闭合围栏内容原样保留', unclosedOut.text.includes('[[react:赞]]'), unclosedOut.text);

// 10. 超过上限只保留前 N 个，多的从正文删掉并记 ignoredActions
const many = parseActions('[[react:赞]][[react:爱心]][[poke]]', { maxActions: 2 });
eq('超限只执行前 2 个', many.actions.map((a) => a.kind).join(','), 'react,react');
eq('超限记录 1 个 ignored', many.ignoredActions.length, 1);
eq('超限的 poke 进了 ignored', many.ignoredActions[0] && many.ignoredActions[0].kind, 'poke');
eq('超限后正文为空（不把动作留给用户看）', many.text, '');

// 11. 六个中文表情名的映射
const expected = { 赞: '76', 爱心: '66', 笑哭: '182', 鼓掌: '99', 疑问: '32', 捂脸: '264' };
for (const [name, id] of Object.entries(expected)) {
  const p = parseActions('[[react:' + name + ']]');
  eq('表情名 ' + name + ' → ' + id, p.actions[0] && p.actions[0].emojiId, id);
}
eq('EMOJI_IDS 恰好覆盖六个名字', Object.keys(EMOJI_IDS).join(','), Object.keys(expected).join(','));

// 12. 未知中文名当 ID 原样传
const unknownName = parseActions('[[react:微笑]]');
eq('未知名字当 ID 原样传', unknownName.actions[0] && unknownName.actions[0].emojiId, '微笑');

// 13. 删除标记后不留双空行
const blank = parseActions(['第一段', '', '[[react:赞]]', '', '', '第二段'].join('\n'));
eq('标记独占行删掉后不留双空行', blank.text, '第一段\n\n第二段');

// 14. 段落缩进不被 trim 掉（只整体去首尾空白）
const indented = parseActions(['第一段', '  缩进行', '[[poke]]'].join('\n'));
eq('段落缩进保留', indented.text, '第一段\n  缩进行');

// 15. 纯动作回复的正文为空（调用方据此不发空消息）
const actionOnly = parseActions('[[recall]]\n[[poke]]');
eq('纯动作正文为空', actionOnly.text, '');
eq('纯动作仍解析出 2 个动作', actionOnly.actions.length, 2);

// 16. recall/poke 带参数不是合法动作
const withArg = parseActions('[[recall:now]] [[poke:x]]');
eq('recall/poke 带参数不解析', withArg.actions.length, 0);
check('带参数写法原样保留', withArg.text.includes('[[recall:now]]') && withArg.text.includes('[[poke:x]]'), withArg.text);

// 17. 行内标记只删标记，保留前后文字
const inline = parseActions('你好 [[react:赞]] 呀');
check('行内标记删除后前后文字还在', inline.text.includes('你好') && inline.text.includes('呀') && !inline.text.includes('[['), inline.text);

// 18. 提示词讲清「会被删、最多几个、代码块不生效」
const hint = interactionHint({ maxActions: 2 });
check('提示词提到 react', hint.includes('[[react:赞]]'), hint);
check('提示词提到 recall/poke', hint.includes('[[recall]]') && hint.includes('[[poke]]'), hint);
check('提示词提到最多 2 个', hint.includes('最多 2 个'), hint);
check('提示词提到代码围栏不执行', hint.includes('代码围栏'), hint);
check('提示词不再说「撤回本轮」', !hint.includes('撤回本轮'), hint);
check('提示词说明撤回上一轮且本轮不撤', hint.includes('撤回你上一轮发出的气泡') && hint.includes('本轮正文不会被撤回'), hint);
eq('关闭时不生成提示词', interactionHint({ enabled: false }), '');

// 19. 默认值与描述
eq('默认动作上限是 2', DEFAULT_INTERACTIONS.maxActions, 2);
eq('配置上限是 5', MAX_ACTIONS_CAP, 5);
check('关闭时描述说明标记原样保留', describeInteractions({ enabled: false }).includes('原样保留'), describeInteractions({ enabled: false }));
check('开启时描述包含群 poke 状态', describeInteractions({ enabled: true, groupPoke: false }).includes('群 poke 关'), describeInteractions({ enabled: true, groupPoke: false }));

// 20. runActions：recall 只删 prevIds，不删 currentIds（P0-1b 的核心契约）
const calls = [];
const fakeFetch = async (url, opts) => {
  calls.push({ url, body: JSON.parse(opts.body) });
  return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: {} }) };
};
const recallCtx = {
  info: { kind: 'private', userId: '20001', messageId: 1 },
  currentIds: [9001],
  prevIds: [8001, 8002],
};
const r1 = await runActions([{ kind: 'recall' }], recallCtx, { api: 'http://fake', fetchImpl: fakeFetch, timeoutMs: 1000 });
eq('runActions recall 只删上一轮（顺序/数量）', calls.map((c) => c.body.message_id).join(','), '8001,8002');
eq('runActions recall 不删本轮', calls.some((c) => c.body.message_id === 9001), false);
eq('runActions recall 记为 1 个执行', r1.executed, 1);

calls.length = 0;
const r2 = await runActions([{ kind: 'recall' }], { ...recallCtx, prevIds: [] }, { api: 'http://fake', fetchImpl: fakeFetch, timeoutMs: 1000 });
eq('没有上一轮时 recall 记 skipped', r2.skipped, 1);
eq('没有上一轮时不发 delete_msg', calls.length, 0);
check('没有上一轮时给出可记日志的 warn', r2.warnings.some((w) => w.includes('没有上一轮气泡可撤回')), JSON.stringify(r2));
check('warn 里带本轮条数（currentIds 只用于日志）', r2.warnings[0] && r2.warnings[0].includes('本轮 1 条不删'), JSON.stringify(r2.warnings));

console.log('\n' + pass + ' 项通过' + (fail ? '，' + fail + ' 项失败' : ''));
process.exit(fail ? 1 : 0);
