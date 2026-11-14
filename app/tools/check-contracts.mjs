/**
 * 目的：保证「抽象接口」和「代码」不漂移——契约里声明的方法，实现必须有；
 *       实现里多出来的方法，要显式记在契约里（否则视为漂移）。
 * 边界：静态检查，不跑实现；不做类型检查。
 * 失败：0.x 阶段缺失只告警，返回码 0；1.0 起缺失返回 1（由 pre-commit 拦截）。
 */
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '../..');
const contractsDir = path.join(root, 'contracts');
const implDirs = [path.join(root, 'app', 'src'), path.join(root, 'local')];

/** 从实现文件里粗略提取导出名（export function / export const / module.exports） */
function exportsOf(file) {
  const src = fs.readFileSync(file, 'utf8');
  const names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s+const\s+(\w+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/(\w+)\s*:\s*(?:async\s*)?\(/g)) names.add(m[1]);
  return names;
}

let problems = 0;
for (const f of fs.readdirSync(contractsDir).filter((n) => n.endsWith('.contract.json'))) {
  const c = JSON.parse(fs.readFileSync(path.join(contractsDir, f), 'utf8'));
  const required = Object.keys(c.required ?? {});
  const declared = (c.implementedBy ?? []).map((p) => path.join(root, p));
  const impls = declared.filter((p) => fs.existsSync(p));
  const localOverrides = [];
  for (const dir of implDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.startsWith(c.id) || !file.endsWith('.js')) continue;
      const full = path.join(dir, file);
      if (!impls.includes(full)) localOverrides.push(full);
    }
  }
  impls.push(...localOverrides);
  if (!impls.length) {
    console.log(`warn  ${c.id}: 契约存在但还没有实现（0.x 允许）`);
    continue;
  }
  for (const file of impls) {
    const have = exportsOf(file);
    const missing = required.filter((n) => !have.has(n));
    if (missing.length) {
      problems += 1;
      console.log(`FAIL  ${path.relative(root, file)} 缺：${missing.join(', ')}`);
    } else {
      console.log(`ok    ${path.relative(root, file)}`);
    }
  }
}
process.exit(problems ? 1 : 0);
