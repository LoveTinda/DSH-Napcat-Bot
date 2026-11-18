import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { logger, setLevel } from './log.js';
import { OneBot } from './onebot.js';
import { Bridge } from './bridge.js';
import { StatusBoard } from './state.js';
import { createAuditLog } from './audit.js';
import { loadConfig, resolvePaths, configSummary } from './config.js';
import { validatePolicy, describePolicy } from './policy.js';
import { ensureTokenFile } from './auth.js';
import { startAdminServer } from './admin.js';
import { startPanel } from './panel.js';
import { buildHealth } from './health.js';
import { buildPanelSessions } from './panel-sessions.js';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const log = logger('main');

const loaded = (() => {
  try { return loadConfig({ argv: process.argv, env: process.env, root: here }); }
  catch (err) {
    console.error('[config] ' + (err && err.message ? err.message : String(err)));
    process.exit(1);
  }
})();
const cfg = loaded.config;
if (process.env.BRIDGE_LOG_LEVEL) setLevel(process.env.BRIDGE_LOG_LEVEL);
log.info('配置来自 ' + loaded.source);

const policyCheck = validatePolicy(cfg.policy);
if (!policyCheck.ok) {
  log.error('访问策略配置不安全，拒绝启动：');
  for (const e of policyCheck.errors || []) log.error('- ' + e);
  process.exit(1);
}
cfg.policy = policyCheck.policy;
for (const w of policyCheck.warnings || []) log.warn('配置警告：' + w);
log.info('访问策略：' + describePolicy(cfg.policy));

const paths = resolvePaths(cfg, { root: here, env: process.env });
fs.mkdirSync(paths.workspace, { recursive: true });
fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
try { fs.chmodSync(paths.stateDir, 0o700); } catch {}
log.info('启动摘要 ' + configSummary(cfg, paths));

const status = new StatusBoard(path.join(paths.stateDir, 'status.json'));
status.start();
status.update((v) => {
  v.onebot.mode = cfg.onebot.mode;
  v.onebot.url = cfg.onebot.url;
  v.dsh.profile = cfg.dsh.profile;
  v.dsh.workspace = paths.workspace;
  v.dsh.maxConcurrent = cfg.dsh.maxConcurrent ?? 1;
});

const audit = createAuditLog(path.join(paths.stateDir, 'audit.log'));
const adminToken = ensureTokenFile(path.join(paths.stateDir, 'admin.token'));
const panelToken = ensureTokenFile(path.join(paths.stateDir, 'panel.token'));
const onebot = new OneBot(cfg.onebot);
const bridge = new Bridge(cfg, paths, status);
bridge.attach(onebot);

onebot.on('online', () => {
  status.update((v) => { v.onebot.connected = true; });
  status.emitEvent('state', 'OneBot 已连接，进入待命');
  log.info('OneBot 就绪，进入待命');
});
onebot.on('offline', () => {
  status.update((v) => { v.onebot.connected = false; });
  status.emitEvent('warn', 'OneBot 离线（QQ 未登录 / 掉线），回到待机');
  log.warn('OneBot 离线，回到待机');
});
onebot.on('event', (ev) => {
  if (ev && ev.self_id) {
    onebot.selfId = ev.self_id;
    status.update((v) => { v.onebot.selfId = ev.self_id; });
  }
  bridge.handleEvent(ev).catch((err) => log.error('处理事件失败: ' + (err && err.stack || err)));
});

const inject = async (body = {}, meta = {}) => {
  const kind = body.kind === 'group' ? 'group' : 'private';
  const id = String(body.id || body.userId || 'local');
  const chatKey = body.chatKey || (kind + ':' + id);
  return bridge.handleInbound({
    chatKey, kind, id, userId: id,
    senderName: body.sender || '本地注入', text: body.text || '', images: body.images || [],
    mentioned: true, selfId: 'local', trusted: false,
    operator: meta.operator || 'local-admin', adminBypass: true, forceCommand: body.forceCommand === true
  }, { deliver: null });
};
const command = (text, meta = {}) => inject({ text, kind: 'private', id: 'local', forceCommand: true }, meta);
const readLog = ({ source = 'bridge', lines = 300 } = {}) => {
  const file = path.join(paths.stateDir, source === 'guard' ? 'guard.log' : 'bridge.log');
  try {
    const all = fs.readFileSync(file, 'utf8').split('\n');
    if (all.length && all[all.length - 1] === '') all.pop();
    return { source, lines: all.slice(-Math.max(1, Math.min(2000, Number(lines) || 300))), total: all.length };
  } catch (err) { return { source, lines: [], total: 0, error: err.message }; }
};

const admin = startAdminServer({
  host: cfg.admin?.host || '127.0.0.1',
  port: cfg.admin?.port ?? 6701,
  token: adminToken,
  allowedOrigins: cfg.admin?.allowedOrigins || [],
  onFatal: () => process.exit(1)
}, {
  status: () => status.snapshot(),
  health: async () => buildHealth({ snapshot: status.snapshot(), cfg, paths, bridge, adminPort: cfg.admin?.port ?? 6701 }),
  inject,
  command,
  callOneBot: (action, params) => onebot.call(action, params, 20000),
  audit: (entry) => audit.write(entry)
});

let panel = null;
if (cfg.panel?.enabled !== false) {
  panel = startPanel({
    host: cfg.panel?.host || '127.0.0.1',
    port: cfg.panel?.port ?? 6702,
    token: panelToken,
    writeEnabled: cfg.panel?.writeEnabled === true,
    allowedOrigins: cfg.panel?.allowedOrigins || []
  }, {
    getStatus: () => status.snapshot(),
    getEvents: () => status.snapshot().events || [],
    getSessions: () => buildPanelSessions(bridge),
    getConfig: () => ({ source: loaded.source, config: cfg }),
    readLog,
    command,
    saveConfig: async () => { throw new Error('面板写配置尚未接回'); },
    restart: async () => { throw new Error('面板重启尚未接回'); },
    callOneBot: (action, params) => onebot.call(action, params, 20000),
    audit
  });
  panel.ready.then((url) => {
    status.update((v) => { v.panel = url; });
    log.info('仪表盘 ' + url);
  }).catch((err) => log.error('仪表盘未启动：' + (err && err.message)));
}

onebot.start();
log.info('工作目录 ' + paths.workspace);
log.info('DSH profile ' + cfg.dsh.profile);
log.info('桥接器已启动（复原入口：admin/panel 已接回）');

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info('收到 ' + signal + '，退出中');
  status.stop();
  onebot.stop();
  try { admin && admin.close && admin.close(); } catch {}
  try { panel && panel.close && panel.close(); } catch {}
  try { await bridge.shutdown(); } catch (err) { log.warn('退出收尾失败: ' + (err && err.message)); }
  audit.write({ operator: 'system', action: 'shutdown', target: 'bridge', result: 'ok' });
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => log.error('unhandledRejection: ' + (err && err.stack || err)));