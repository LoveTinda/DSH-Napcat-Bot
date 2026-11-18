/**
 * 目的：首次启动 legacy 时，用当前模块的 bridge-policy/NAPCAT_API 生成一份可用配置。
 * 边界：只读模板和策略，只写 $DATA/etc/legacy.json；不启动进程、不改 NapCat。
 * 依赖：node 内置 fs/path；units/legacy/app/config.example.json。
 * 失败：模板缺失/坏 JSON → 非 0，run-legacy.sh 不启动；策略缺失则保留模板。
 * 副作用：写 0600 的 legacy.json。
 */
import fs from 'node:fs';
import path from 'node:path';

const [, , template, out, policyFile, api] = process.argv;
if (!template || !out) {
  console.error('用法：legacy-config.mjs <template> <out> [policy] [api]');
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync(template, 'utf8'));

// 从当前 bridge 的白名单里取真实 QQ；占位文案/空值不抄。
const qqList = (v) => (Array.isArray(v) ? v.map(String).filter((x) => /^\d{5,12}$/.test(x)) : []);
try {
  const p = JSON.parse(fs.readFileSync(policyFile, 'utf8'));
  if (p && typeof p === 'object') {
    cfg.policy = cfg.policy || {};
    for (const k of ['privateChat', 'groupChat', 'allowAllUsers', 'allowAllGroups', 'ignoreSelf']) {
      if (p[k] !== undefined) cfg.policy[k] = p[k];
    }
    for (const k of ['allowUsers', 'allowGroups', 'ownerUsers', 'adminUsers']) {
      const list = qqList(p[k]);
      if (list.length) cfg.policy[k] = list;
    }
  }
} catch (err) {
  if (err.code !== 'ENOENT') console.error('warn 读取策略失败：' + err.message);
}

if (api) {
  const base = String(api).replace(/\/+$/, '').replace(/^http/i, 'ws');
  cfg.onebot = cfg.onebot || {};
  cfg.onebot.mode = 'forward-ws';
  cfg.onebot.url = base;
}

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
try { fs.chmodSync(out, 0o600); } catch {}
console.log('ok 已生成 ' + out);
