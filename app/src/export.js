/**
 * 目的：把一条 DSH 会话打包成 ZIP。
 * 边界：只读会话文件，不删除源文件。
 * 依赖：node:fs/zlib；被 bridge/panel 调用。
 * 失败：读不到文件抛错，由调用方回执。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** 把会话目录打成最小 zip。只用于 /export；超过上限抛 export/too-large。 */
export function buildSessionZip(dir, { maxBytes = 20 * 1024 * 1024 } = {}) {
  const files = [];
  const walk = (d) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.isFile()) files.push(p);
    }
  };
  walk(dir);
  let total = 0;
  for (const f of files) total += fs.statSync(f).size;
  if (total > maxBytes) {
    const err = new Error('会话日志超过导出上限');
    err.code = 'export/too-large';
    throw err;
  }
  const buffer = execFileSync('zip', ['-q', '-r', '-', '.'], {
    cwd: dir,
    maxBuffer: Math.max(maxBytes * 2, 4 * 1024 * 1024)
  });
  return { id: path.basename(dir), buffer, entries: files };
}
