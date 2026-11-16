import fs from 'node:fs';
import path from 'node:path';
const dir = '.', outDir = '/tmp/audit/merged';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
const RE = /<path>([^<]+)<\/path>\s*<type>file<\/type>\s*<content>\s*([\s\S]*?)<\/content>\s*(?:\(([^)]*)\))?/g;
const store = new Map(); // name -> { total, chunks: [{start, lines: []}] }

function walk(v, sink) {
  if (typeof v === 'string') { if (v.includes('<content>')) sink.push(v); return; }
  if (Array.isArray(v)) { for (const x of v) walk(x, sink); return; }
  if (v && typeof v === 'object') for (const k of Object.keys(v)) walk(v[k], sink);
}

for (const f of files) {
  for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line.includes('<content>')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const sink = []; walk(o, sink);
    for (const s of sink) {
      for (const m of s.matchAll(RE)) {
        const p = m[1].trim();
        if (!/\/src\/[a-z][a-z0-9-]*\.js$/.test(p)) continue;
        const name = path.basename(p);
        const raw = m[2].replace(/\r/g, '');
        const ls = raw.split('\n').map((l) => l.replace(/^(\s*)(\d+):\s?/, '$2\t'));
        // 解析起始行：每行都带 "N\t"，取第一行的 N
        const first = ls.find((l) => /^\d+\t/.test(l));
        const start = first ? Number(first.split('\t')[0]) : 1;
        const body = ls.filter((l) => /^\d+\t/.test(l)).map((l) => l.slice(l.indexOf('\t') + 1));
        const note = (m[3] || '') + ' ' + (s.slice(0, 0));
        const totalM = /of (\d+)/.exec(s.slice(Math.max(0, s.indexOf('<content>') - 300), s.indexOf('<content>'))) || null;
        const rec = store.get(name) || { total: 0, chunks: [] };
        if (totalM) rec.total = Number(totalM[1]);
        const tot2 = /total (\d+) lines/.exec(s);
        if (tot2) rec.total = Number(tot2[1]);
        if (body.length) rec.chunks.push({ start, body });
        store.set(name, rec);
      }
    }
  }
}

fs.mkdirSync(outDir, { recursive: true });
const rows = [];
for (const [name, rec] of [...store].sort()) {
  const map = new Map();
  for (const c of rec.chunks) c.body.forEach((l, i) => { const n = c.start + i; if (!map.has(n)) map.set(n, l); });
  const nums = [...map.keys()].sort((a, b) => a - b);
  const max = nums.length ? nums[nums.length - 1] : 0;
  const total = rec.total || max;
  let text = '';
  for (let n = 1; n <= total; n++) text += (map.has(n) ? map.get(n) : `// [缺失第 ${n} 行]`) + '\n';
  fs.writeFileSync(path.join(outDir, name), text);
  const cov = map.size;
  rows.push({ name, total, have: cov, pct: total ? Math.round((cov / total) * 100) : 0, chunks: rec.chunks.length });
}
rows.sort((a, b) => b.pct - a.pct);
for (const r of rows) console.log(`${String(r.pct).padStart(3)}%  ${String(r.have).padStart(4)}/${String(r.total).padEnd(5)} 行  ${r.name}  (${r.chunks} 次读取)`);
console.log('模块数', rows.length);
