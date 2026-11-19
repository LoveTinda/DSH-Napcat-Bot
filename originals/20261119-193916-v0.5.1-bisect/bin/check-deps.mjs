#!/usr/bin/env node
/**
 * 目的：把「零第三方依赖」变成可执行门禁 —— 本仓库源码只允许 import node: 内置模块或相对路径，
 *       任何人加了一个 npm 依赖（node_modules / package.json dependencies）都会在这里失败。
 * 边界：只做静态扫描（import/export from/require/动态 import 的字面量）；不解析动态拼接的模块名、
 *       不联网、不替代 npm audit；只扫 app/、units/ 与 bin/ 下的 .mjs/.js。
 * 依赖：node:fs、node:path；被 bin/check-deps.sh 与 pre-commit 钩子调用。
 * 失败：发现外部依赖 / node_modules / 非空的 dependencies 时，逐个打印 文件:行 并退出 1。
 * 副作用：只读，不写任何文件。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.env.MODDIR || path.join(here, '..'));
const SCAN_DIRS = ['app', 'units', 'bin'];
const EXTS = new Set(['.mjs', '.js']);

// 只认「字面量」导入：from 'x'、import 'x'、import('x')、require('x')。
// 动态拼接（import(name)）扫描不到，这是本检查的已知边界，写在头注释里。
const SPEC_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"]+)\1/g;

/** 目的：递归收集待扫描的源码文件；跳过 node_modules（万一有人装了）。 */
function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(e.name))) out.push(p);
  }
  return out;
}

const violations = [];
const files = [];
for (const d of SCAN_DIRS) files.push(...walk(path.join(root, d)));

for (const file of files) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    // 跳过行注释，避免把注释里的示例 import 当成真依赖。
    const code = line.replace(/\/\/.*$/, '');
    SPEC_RE.lastIndex = 0;
    let m;
    while ((m = SPEC_RE.exec(code))) {
      const spec = m[2];
      if (spec.startsWith('node:') || spec.startsWith('.') || spec.startsWith('/')) continue;
      violations.push(path.relative(root, file) + ':' + (i + 1) + '  非内置依赖 "' + spec + '"');
    }
  });
}

/** 目的：node_modules 与 package.json 的 dependencies 是「真的装了第三方」的直接证据。 */
for (const d of SCAN_DIRS) {
  const nm = path.join(root, d, 'node_modules');
  if (fs.existsSync(nm)) violations.push(path.relative(root, nm) + '/ 存在第三方依赖目录');
}
for (const pkg of ['package.json', 'app/package.json', 'units/package.json', 'bin/package.json']) {
  const p = path.join(root, pkg);
  if (!fs.existsSync(p)) continue;
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const deps = Object.keys(j.dependencies || {}).concat(Object.keys(j.devDependencies || {}));
    if (deps.length) violations.push(pkg + ' 声明了依赖：' + deps.join(', '));
  } catch (e) {
    violations.push(pkg + ' 不是合法 JSON：' + e.message);
  }
}

if (violations.length) {
  console.log('FAIL 依赖锁定：本仓库约定零第三方依赖');
  for (const v of violations) console.log('  ' + v);
  console.log('处理：改成 node: 内置实现，或把特化代码放 local/（不入库）；确实要加依赖必须先写 ADR。');
  process.exit(1);
}
console.log('ok 依赖锁定：扫描 ' + files.length + ' 个源码文件，第三方依赖 0，node_modules 0（node ' + process.version + '）');
