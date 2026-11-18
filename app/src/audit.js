/**
 * 目的：记录管理操作审计（谁、做了什么、结果）。
 * 边界：只追加写，不读业务状态；不记录 token。
 * 依赖：node:fs；被 index/admin/panel 调用。
 * 失败：写失败只告警，不阻断主流程。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 本地审计 JSONL：只记 operator/action/target/result/time，不记 token 和消息全文。 */
export function createAuditLog(file) {
  return {
    file,
    write(entry = {}) {
      const row = {
        time: new Date().toISOString(),
        operator: String(entry.operator || 'local-admin').slice(0, 80),
        action: String(entry.action || '').slice(0, 80),
        target: String(entry.target || '').slice(0, 160),
        result: String(entry.result || 'ok').slice(0, 40)
      };
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        fs.appendFileSync(file, JSON.stringify(row) + '\n', { mode: 0o600 });
      } catch {}
      return row;
    }
  };
}
