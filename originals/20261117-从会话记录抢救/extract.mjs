import fs from 'node:fs';
import path from 'node:path';

const dir = '.';
const outDir = '/tmp/audit/recover';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
const best = new Map();
const RE = /<path>([^<]+)<\/path>\s*<type>file<\/type>\s*<content>\s*([\s\S]*?)<\/content>/g;

function walk(v, sink) {
  if (typeof v === 'string') { if (v.includes('<content>')) sink.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) walk(x, sink); return; }
  if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], sink);
}

for (const f of files) {
  const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n');
  for (const line of lines) {
    if (!line || !line.includes('<content>')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const sink = []; walk(o, sink);
    for (const s of sink) {
      for (const m of s.matchAll(RE)) {
        const p = m[1].trim();
        if (!/\/src\/[a-z][a-z0-9-]*\.js$/.test(p)) continue;
        const raw = m[2].replace(/\r/g, '');
        const ls = raw.split('\n').map((l) => l.replace(/^\s*\d+:\s?/, ''));
        const text = ls.join('\n');
        const name = path.basename(p);
        const prev = best.get(name);
        if (!prev || text.length > prev.len) best.set(name, { len: text.length, text, lines: ls.length, from: f.slice(-16) });
      }
    }
  }
}

fs.mkdirSync(outDir, { recursive: true });
const rows = [];
for (const [name, v] of [...best].sort()) {
  fs.writeFileSync(path.join(outDir, name), v.text);
  const tail = (v.text.trimEnd().split('\n').pop() || '').trim();
  rows.push({ name, kb: +(v.len / 1024).toFixed(1), lines: v.lines, tail: tail.slice(0, 46) });
}
for (const r of rows) console.log(String(r.kb).padStart(6) + 'KB ' + String(r.lines).padStart(5) + ' 行  ' + r.name.padEnd(22) + ' | ' + r.tail);
console.log('恢复文件数', rows.length);
