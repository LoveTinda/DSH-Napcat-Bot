/**
 * 目的：极简 JSON 状态存储（原子写）。
 * 边界：只存桥接器自己的状态，不存聊天正文。
 * 依赖：node:fs；被 bridge/session-manager 调用。
 * 失败：写失败抛错，由调用方决定是否退出。
 */
import fs from 'node:fs';
import path from 'node:path';

/** JSON 文件存储：只用于 state 下的小配置/会话映射。写入走临时文件+rename，避免半截 JSON。 */
export class JsonStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.data = { ...defaults };
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.data = parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
  }
  get(key, fallback) {
    return Object.prototype.hasOwnProperty.call(this.data, key) ? this.data[key] : fallback;
  }
  set(key, value) {
    this.data[key] = value;
    this.save();
    return value;
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    const tmp = this.file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }
}
