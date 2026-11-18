#!/usr/bin/env node
// 目的：验证消息层纯函数——段解析、会话 key、引用文案、暂不支持提示、身份披露、群 @ 前缀。
// 边界：只测纯函数；get_msg 网络请求与真实回发在 test-roundtrip.mjs 里测。
// 依赖：node:assert 不引入，自带 check/eq；被改的是 message.mjs。
// 失败：任一断言不成立 → 退出码 1。
// 副作用：无。

import {
  normalizeMessage, chatKeyFor, formatQuoteContext, unsupportedReply,
  unsupportedTaskNote, disclosureText, atPrefix,
} from './message.mjs';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), '实际=' + JSON.stringify(actual));
}

// --- 段解析 ---
const atMe = normalizeMessage([
  { type: 'at', data: { qq: '10000' } },
  { type: 'text', data: { text: '你好' } },
], '10000');
eq('@ 自己从正文剔除、mentioned=true', [atMe.text, atMe.mentioned], ['你好', true]);

const atOther = normalizeMessage([{ type: 'at', data: { qq: '20002' } }], '10000');
eq('@ 别人保留成 @号码', [atOther.text, atOther.mentioned], ['@20002', false]);

eq('face → [表情]', normalizeMessage([{ type: 'face', data: { id: '1' } }]).text, '[表情]');
eq('poke → [戳一戳]', normalizeMessage([{ type: 'poke', data: {} }]).text, '[戳一戳]');

const withImage = normalizeMessage([{ type: 'image', data: { file: 'a.jpg' } }]);
eq('图片占位与计数', [withImage.text, withImage.images], ['[图片]', 1]);

const reply = normalizeMessage([
  { type: 'reply', data: { id: 777 } },
  { type: 'text', data: { text: '你看这个' } },
]);
eq('引用段 id 提取', [reply.repliedTo, reply.text], ['777', '你看这个']);

const voiceOnly = normalizeMessage([{ type: 'record', data: { file: 'a.amr' } }]);
eq('语音只进 unsupported，不拼占位', [voiceOnly.text, voiceOnly.unsupported], ['', ['record']]);

const mixed = normalizeMessage([
  { type: 'text', data: { text: '看这个' } },
  { type: 'record', data: { file: 'a.amr' } },
  { type: 'file', data: { file: 'b.zip' } },
]);
eq('文字 + 语音 + 文件：文字保留、类型去重', [mixed.text, mixed.unsupported], ['看这个', ['record', 'file']]);

eq('重复类型去重', normalizeMessage([
  { type: 'record' }, { type: 'record' },
]).unsupported, ['record']);

eq('纯字符串消息', normalizeMessage('  你好  ').text, '你好');
eq('非数组非字符串返回空结构', normalizeMessage(null), {
  text: '', mentioned: false, repliedTo: null, unsupported: [], images: 0,
});

// --- 会话 key ---
eq('群默认每群一条', chatKeyFor({ kind: 'group', groupId: 30001, userId: 20002 }), 'group:30001');
eq('群成员级每条一人', chatKeyFor({ kind: 'group', groupId: 30001, userId: 20002, groupSessionScope: 'member' }), 'group:30001:20002');
eq('私聊按人', chatKeyFor({ kind: 'private', userId: 20002, groupSessionScope: 'member' }), 'private:20002');

// --- 引用文案 ---
check('引用有文字：带发送者与原话', formatQuoteContext({
  ok: true, text: '原来的话', senderName: '小明', images: 0,
}).includes('引用回复 小明 的消息 「原来的话」'));
check('引用只有图片：说明张数', formatQuoteContext({
  ok: true, text: '', images: 2, senderName: '小明',
}).includes('含 2 张图片'));
check('引用只有 [图片] 占位：仍按图片张数说', formatQuoteContext({
  ok: true, text: '[图片]', images: 1, senderName: '小明',
}).includes('含 1 张图片'));
check('引用不可读：明确说不可读', formatQuoteContext({
  ok: false, error: 'get_msg 超时',
}).includes('引用消息不可读：get_msg 超时'));
eq('没有引用返回空串', formatQuoteContext(null), '');

// --- 暂不支持 / 披露 / @ ---
eq('暂不支持提示用中文名', unsupportedReply(['record', 'file']),
  '暂不支持语音、文件消息。请改发文字或图片；语音/文件/合并转发目前拿不到内容。');
eq('暂不支持空数组返回空串', unsupportedReply([]), '');
check('任务里的不支持说明', unsupportedTaskNote(['record']).includes('还包含暂不支持的消息类型：语音'));

check('群披露：每群一条会话', disclosureText({ memberScoped: false, groupReplyAt: true })
  .includes('本群共用一条会话'));
check('群披露：成员级会话', disclosureText({ memberScoped: true, groupReplyAt: true })
  .includes('本群每个成员各自一条会话'));
check('群披露：不 @ 时提示需要 @', disclosureText({ memberScoped: false, groupReplyAt: false })
  .includes('需要我时请 @ 我'));

eq('@ 前缀：数字 QQ', atPrefix(20002), '[CQ:at,qq=20002] ');
eq('@ 前缀：非法号码返回空串', atPrefix('abc'), '');
eq('@ 前缀：空值返回空串', atPrefix(null), '');

console.log('\n' + pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
