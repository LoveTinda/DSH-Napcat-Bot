#!/usr/bin/env node
// 目的：验证图片落盘的安全判定与文案——私网/回环、协议、DNS 解析、content-type、上下文说明。
// 边界：不真下载、不写文件；下载与落盘在 test-roundtrip.mjs 里用假图片服务器测。
// 依赖：node:test 不引入，自带 check/eq；被改的是 image.mjs。
// 失败：任一断言不成立 → 退出码 1。
// 副作用：无。

import {
  isPrivateAddress, assertPublicHttpUrl, imageExtension, imageContext, imageErrorNote,
} from './image.mjs';

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log('PASS  ' + name); }
  else { fail++; console.log('FAIL  ' + name + (detail ? '  → ' + detail : '')); }
}
function eq(name, actual, expected) {
  check(name, JSON.stringify(actual) === JSON.stringify(expected), '实际=' + JSON.stringify(actual));
}
async function rejects(name, fn, needle) {
  try {
    await fn();
    check(name, false, '没有抛错');
  } catch (e) {
    check(name, String(e.message).includes(needle), String(e.message));
  }
}

// --- 私网判定 ---
for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.16.0.1', '169.254.1.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:ffff:7f00:1']) {
  check('私网/回环拒绝 ' + ip, isPrivateAddress(ip) === true);
}
for (const ip of ['8.8.8.8', '1.1.1.1', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
  check('公网放行 ' + ip, isPrivateAddress(ip) === false);
}
eq('空地址按私网处理', isPrivateAddress(''), true);

// --- URL 校验 ---
const publicLookup = async () => [{ address: '8.8.8.8', family: 4 }];
const privateLookup = async () => [{ address: '10.0.0.2', family: 4 }];
check('公网 IP URL 通过', Boolean(await assertPublicHttpUrl('https://8.8.8.8/a.png', { lookupFn: publicLookup })));
await rejects('file:// 拒绝', () => assertPublicHttpUrl('file:///etc/passwd'), 'http/https');
await rejects('绝对路径拒绝', () => assertPublicHttpUrl('/etc/passwd'), '不是合法');
await rejects('localhost 拒绝', () => assertPublicHttpUrl('http://localhost/a.png'), '本机/内网');
await rejects('localhost. 尾点拒绝', () => assertPublicHttpUrl('http://localhost./a.png'), '本机/内网');
await rejects('127.0.0.1 拒绝', () => assertPublicHttpUrl('http://127.0.0.1/a.png'), '私网');
await rejects('域名解析到私网拒绝', () => assertPublicHttpUrl('https://evil.example/a.png', { lookupFn: privateLookup }), '解析到私网');
await rejects('域名无解析结果拒绝', () => assertPublicHttpUrl('https://none.example/a.png', { lookupFn: async () => [] }), '没有解析结果');
check('域名解析到公网通过', Boolean(await assertPublicHttpUrl('https://img.example/a.png', { lookupFn: publicLookup })));
check('allowPrivate 时 127 可用（自测/内网 NapCat）',
  Boolean(await assertPublicHttpUrl('http://127.0.0.1:3001/a.png', { allowPrivate: true })));

// --- content-type / 文案 ---
eq('png 扩展名', imageExtension('image/png'), '.png');
eq('jpeg 带 charset', imageExtension('image/jpeg; charset=binary'), '.jpg');
eq('webp 扩展名', imageExtension('image/webp'), '.webp');
eq('html 拒绝', imageExtension('text/html'), '');
eq('空 content-type 拒绝', imageExtension(''), '');

eq('图片上下文空数组', imageContext([]), '');
check('图片上下文带路径', imageContext(['/a/1.png', '/a/2.jpg']).includes('/a/1.png'));
check('图片失败说明带原因', imageErrorNote([{ reason: 'HTTP 404' }]).includes('HTTP 404'));
eq('图片失败空数组', imageErrorNote([]), '');

console.log('\n' + pass + ' 项通过，' + fail + ' 项失败');
process.exit(fail ? 1 : 0);
