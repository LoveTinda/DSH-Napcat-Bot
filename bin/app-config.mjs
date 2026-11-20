/**
 * 目的：首次启动单应用时，用模块的 bridge-policy/NAPCAT_API 生成一份可用配置。
 * 边界：只读模板和策略，只写 $DATA/etc/app.json；不启动进程、不改 NapCat。
 * 依赖：node 内置 fs/path；app/config.example.json。
 * 失败：模板缺失/坏 JSON → 非 0，run-app.sh 不启动；策略缺失则保留模板。
 * 副作用：写 0600 的 app.json。
 */
import fs from 'node:fs';
import path from 'node:path';

const [, , template, out, policyFile, api] = process.argv;
if (!template || !out) {
  console.error('用法：app-config.mjs <template> <out> [policy] [api]');
  process.exit(2);
}

const cfg = JSON.parse(fs.readFileSync(template, 'utf8'));

// 从当前 bridge 的白名单里取真实 QQ；占位文案/空值不抄。
const qqList = (v) => (Array.isArray(v) ? v.map(String).filter((x) => /^\d{5,12}$/.test(x)) : []);
/** 目的：读策略——先读文件，读不到再用 TINDA_POLICY_JSON（宿主随环境传进来的那份）。 */
function loadPolicy(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err && err.code !== 'ENOENT') console.error('warn 读取策略失败：' + err.message);
  }
  const inline = process.env.TINDA_POLICY_JSON;
  if (inline) {
    try {
      const p = JSON.parse(inline);
      console.error('warn 策略文件不可读，改用环境变量里的策略');
      return p;
    } catch (err) {
      console.error('warn 环境变量里的策略不是合法 JSON：' + err.message);
    }
  }
  return null;
}

try {
  const p = loadPolicy(policyFile);
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

// 兜底：策略文件没读到、或里面白名单为空时，用宿主传进来的 owner QQ 顶上。
// 没有这一步，桥接器就会按设计 fail-closed，整个单元起不来（真机踩过两次）。
{
  const owner = String(process.env.TINDA_OWNER_QQ || '').trim();
  const list = cfg.policy && Array.isArray(cfg.policy.allowUsers) ? cfg.policy.allowUsers : [];
  const empty = list.length === 0 || list.every((x) => !/^\d{5,12}$/.test(String(x)));
  if (empty && /^\d{5,12}$/.test(owner)) {
    cfg.policy = cfg.policy || {};
    cfg.policy.allowUsers = [owner];
    cfg.policy.ownerUsers = cfg.policy.ownerUsers && cfg.policy.ownerUsers.length ? cfg.policy.ownerUsers : [owner];
    console.error('warn 策略里没有可用 QQ，已用 TINDA_OWNER_QQ=' + owner + ' 兜底');
  }
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
