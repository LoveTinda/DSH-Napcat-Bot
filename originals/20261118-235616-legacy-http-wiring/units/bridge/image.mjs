/**
 * 目的：图片落盘的安全边界与文案——私网/回环判定、URL 校验、content-type 白名单、
 *       提示模型“图片在哪”的上下文、失败时给用户的说明。
 * 边界：只做纯判定与文案；真正的 HTTP 下载、写文件在 bridge.mjs（要读配置、计时、落盘）。
 * 依赖：node:net、node:dns/promises；被 units/bridge/bridge.mjs 与 test-image.mjs 引用。
 * 失败：校验函数抛错（调用方捕获并记 errors）；纯文案函数不抛错。
 */

import net from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';

/** 图片默认上限：10MB / 8 张 / 8 秒；与旧 bridge.js 的 behavior 默认值一致。 */
export const DEFAULT_IMAGE = {
  maxBytes: 10 * 1024 * 1024,
  maxCount: 8,
  timeoutMs: 8000,
  allowPrivateHosts: false,
};

/** content-type → 落盘扩展名；不在表里的一律拒绝，避免把 HTML/脚本当图片存下来。 */
const EXT_BY_TYPE = new Map([
  ['image/png', '.png'],
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/gif', '.gif'],
  ['image/webp', '.webp'],
]);

/**
 * 目的：判断一个 IP 是否属于私网/回环/链路本地/多播，图片下载默认拒绝这些地址（SSRF 防线）。
 * 输入：IPv4/IPv6 字符串；空值按私网处理。
 * 输出：true = 不应访问；false = 公网地址。
 * 失败：不抛错。副作用：无。
 */
/** 目的：把 IPv6 字符串展开成 16 字节；非法返回 null。用于判定私网/映射地址。失败：不抛错。 */
function ipv6ToBytes(input) {
  let host = String(input || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (!host.includes(':')) return null;
  // 末尾的 IPv4（::ffff:127.0.0.1）先换成两个十六进制组，后面统一按 8 组处理。
  if (host.includes('.')) {
    const idx = host.lastIndexOf(':');
    if (idx < 0) return null;
    const v4 = host.slice(idx + 1).split('.').map(Number);
    if (v4.length !== 4 || v4.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    host = host.slice(0, idx + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = host.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  if (halves.length === 1 && left.length !== 8) return null;
  if (left.length + right.length > 8) return null;
  const groups = halves.length === 2
    ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (groups.length !== 8) return null;
  const bytes = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push((n >> 8) & 255, n & 255);
  }
  return bytes;
}

export function isPrivateAddress(ip) {
  const s = String(ip || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!s) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const p = v4.slice(1).map(Number);
    if (p.some((n) => n < 0 || n > 255)) return true;
    return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      p[0] >= 224;
  }
  if (s.includes(':')) {
    const b = ipv6ToBytes(s);
    if (!b) return true;
    if (b.every((n) => n === 0) || (b.slice(0, 15).every((n) => n === 0) && b[15] === 1)) return true;
    if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return true;   // fe80::/10
    if ((b[0] & 0xfe) === 0xfc) return true;                    // fc00::/7
    if (b[0] === 0xff) return true;                             // ff00::/8
    // IPv4-mapped：::ffff:a.b.c.d
    if (b.slice(0, 10).every((n) => n === 0) && b[10] === 0xff && b[11] === 0xff) {
      return isPrivateAddress([b[12], b[13], b[14], b[15]].join('.'));
    }
    return false;
  }
  return false;
}

/**
 * 目的：图片 URL 的 SSRF 防线——只允许 http/https，默认拒绝 localhost/私网；
 *       域名先解析，再逐个地址检查，降低“域名指向 127.0.0.1”的绕过。
 * 输入：raw URL、allowPrivate（测试/内网 NapCat 才开）、lookupFn（可注入，便于单测）。
 * 输出：校验通过的 URL 对象。
 * 失败：抛带原因的错误；调用方捕获后记一条 errors，不中断整轮。
 * 副作用：域名会走一次 DNS 查询（lookupFn）。
 */
export async function assertPublicHttpUrl(raw, { allowPrivate = false, lookupFn = dnsLookup } = {}) {
  let url;
  try { url = new URL(String(raw)); } catch { throw new Error('不是合法图片 URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只支持 http/https 图片链接');
  }
  if (allowPrivate) return url;
  const host = String(url.hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('不允许访问本机/内网图片地址');
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('不允许访问私网图片地址');
    return url;
  }
  let rows;
  try { rows = await lookupFn(host, { all: true, verbatim: true }); }
  catch (err) { throw new Error('图片域名解析失败：' + ((err && err.message) || err)); }
  if (!Array.isArray(rows) || !rows.length) throw new Error('图片域名没有解析结果');
  for (const row of rows) {
    if (isPrivateAddress(row.address)) throw new Error('图片域名解析到私网地址，已拒绝');
  }
  return url;
}

/** 目的：把 content-type 映射成落盘扩展名；不支持的类型返回 ''。失败：不抛错。副作用：无。 */
export function imageExtension(contentType) {
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  return EXT_BY_TYPE.get(type) || '';
}

/**
 * 目的：把已保存的图片路径拼成给模型的上下文，让模型用文件工具查看，而不是“看图说话”。
 * 输入：paths（绝对路径数组）。输出：一段括号说明；空数组返回空串。
 * 失败：不抛错。副作用：无。
 */
export function imageContext(paths) {
  const list = Array.isArray(paths) ? paths.filter(Boolean) : [];
  if (!list.length) return '';
  return '（本轮附带 ' + list.length + ' 张图片，已保存到：' + list.join(' 、 ') +
    '。需要时用文件工具查看。）';
}

/**
 * 目的：图片读取失败时给模型/用户的明确说明，避免模型假装看过图片。
 * 输入：errors（{reason} 数组）。输出：一段括号说明；空数组返回空串。
 * 失败：不抛错。副作用：无。
 */
export function imageErrorNote(errors) {
  const list = Array.isArray(errors) ? errors : [];
  if (!list.length) return '';
  const first = String((list[0] && list[0].reason) || '未知原因').slice(0, 120);
  return '（有 ' + list.length + ' 张图片没能读取，已按文字处理；可以重发图片或改发文字。原因：' + first + '）';
}
