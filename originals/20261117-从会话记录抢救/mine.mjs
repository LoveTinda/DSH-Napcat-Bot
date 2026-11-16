import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || '.';
const out = { files: [], users: [], commands: {}, configKeys: {}, actions: {}, modules: {}, codeBlocks: [] };
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort();

function texts(v, acc) {
  if (typeof v === 'string') { acc.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) texts(x, acc); return; }
  if (v && typeof v === 'object') for (const k of Object.keys(v)) texts(v[k], acc);
}

for (const f of files) {
  const raw = fs.readFileSync(path.join(dir, f), 'utf8');
  const lines = raw.split('\n');
  out.files.push({ f, kb: Math.round(raw.length / 1024), lines: lines.filter(Boolean).length });

  for (const line of lines) {
    if (!line) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    // 用户消息
    if (o.type === 'user/message' && o.data && Array.isArray(o.data.content)) {
      const t = o.data.content.filter((c) => c && c.type === 'text').map((c) => c.text).join('\n').trim();
      if (t && t.length < 4000) out.users.push({ f, t });
    }
    // 所有字符串里找命令/配置键/动作/模块
    const acc = []; texts(o, acc);
    const all = acc.join('\n');
    for (const mm of all.matchAll(/(?:^|[\s`'"(（【[])(\/[a-z][a-z0-9-]{1,14})(?=[\s`'")）】\]，。,:：]|$)/gm)) {
      out.commands[mm[1]] = (out.commands[mm[1]] || 0) + 1;
    }
    for (const mm of all.matchAll(/\b((?:behavior|panel|policy|dsh|guard|napcat|bridge|session|humanize|interactions|admin|onebot)\.[a-zA-Z][a-zA-Z0-9]{2,30})\b/g)) {
      out.configKeys[mm[1]] = (out.configKeys[mm[1]] || 0) + 1;
    }
    for (const mm of all.matchAll(/\b((?:send|set|get|delete|friend|group|upload|download)_[a-z_]{3,30})\b/g)) {
      out.actions[mm[1]] = (out.actions[mm[1]] || 0) + 1;
    }
    for (const mm of all.matchAll(/\b(src\/[a-z][a-z0-9-]{1,24}\.js)\b/g)) {
      out.modules[mm[1]] = (out.modules[mm[1]] || 0) + 1;
    }
    // 可恢复源码：含 export function 的大块
    if (all.includes('export function') || all.includes('export const')) {
      for (const s of acc) {
        if (s.length > 2000 && (s.includes('export function') || s.includes('export const'))) {
          const fns = [...s.matchAll(/export (?:async )?(?:function|const) ([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((x) => x[1]);
          out.codeBlocks.push({ f, len: s.length, fns: [...new Set(fns)] });
        }
      }
    }
  }
}

// 用户消息去重
const seen = new Set();
out.users = out.users.filter((u) => { const k = u.t.slice(0, 80); if (seen.has(k)) return false; seen.add(k); return true; });

const sortObj = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]));
out.commands = sortObj(out.commands);
out.configKeys = sortObj(out.configKeys);
out.actions = sortObj(out.actions);
out.modules = sortObj(out.modules);
out.codeBlocks.sort((a, b) => b.len - a.len);
fs.writeFileSync('/tmp/audit/report.json', JSON.stringify(out, null, 1));
console.log('文件', out.files.length, '行', out.files.reduce((a, b) => a + b.lines, 0));
console.log('用户消息', out.users.length, '| 命令', Object.keys(out.commands).length,
  '| 配置键', Object.keys(out.configKeys).length, '| 动作', Object.keys(out.actions).length,
  '| 模块', Object.keys(out.modules).length, '| 代码块', out.codeBlocks.length);
