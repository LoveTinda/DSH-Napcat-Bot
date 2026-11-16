import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { logger, setLevel } from './log.js';
import { OneBot } from './onebot.js';
import { Bridge } from './bridge.js';
import { StatusBoard } from './state.js';
import { startAdminServer } from './admin.js';
import { startPanel } from './panel.js';
import { ensureTokenFile, safeEqual } from './auth.js';
import { validatePolicy, describePolicy, maskChatKey } from './policy.js';
import { chatKeyFor } from './session-manager.js';
import { createAuditLog } from './audit.js';
import { loadConfig, resolvePaths, configSummary } from './config.js';
import { configView, prepareConfig, readConfigFile, writeConfigFile, diffConfig } from './panel-config.js';
import { buildHealth } from './health.js';
import { buildPanelSessions, applyPanelSessionAction } from './panel-sessions.js';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const log = logger('main');

const loaded = (() => {
  try { return loadConfig({ argv: process.argv, env: process.env, root: here }); }
  catch (err) {
    // 配置错误在连 OneBot 之前就退出，绝不回退到 config.example.json（headless）。
    console.error('[config] ' + (err && err.message ? err.message : String(err)));
    process.exit(1);
  }
})();
const cfg = loaded.config;
if (process.env.BRIDGE_LOG_LEVEL) setLevel(process.env.BRIDGE_LOG_LEVEL);
log.info('配置来自 ' + loaded.source);
for (const w of loaded.warnings) log.warn('配置警告：' + w);

// 访问策略必须在连 OneBot 之前定死：空白名单宁可拒绝启动，也不能“默认开放”。
const policyCheck = validatePolicy(cfg.policy);
if (!policyCheck.ok) {
  log.error('访问策略配置不安全，拒绝启动：');
  process.exit(1);
}
cfg.policy = policyCheck.policy;
for (const w of policyCheck.warnings) log.warn(w);
cfg.policy = policyCheck.policy;
for (const w of policyCheck.warnings) log.warn(w);
log.info('访问策略：' + describePolicy(cfg.policy));

// 路径：支持 stateDir / BRIDGE_STATE_DIR / BRIDGE_WORKSPACE 注入。
// 测试必须显式用临时目录，不能写生产 state/（P1-08）。
const paths = resolvePaths(cfg, { root: here, env: process.env });
fs.mkdirSync(paths.workspace, { recursive: true });
fs.mkdirSync(paths.stateDir, { recursive: true, mode: 0o700 });
try { fs.chmodSync(paths.stateDir, 0o700); } catch {}
log.info('启动摘要 ' + configSummary(cfg, paths));

const status = new StatusBoard(path.join(paths.stateDir, 'status.json'));
status.update((v) => {
  v.onebot.mode = cfg.onebot.mode;
  v.onebot.url = cfg.onebot.url;
  v.dsh.profile = cfg.dsh.profile;
  v.dsh.workspace = paths.workspace;
  v.dsh.maxConcurrent = cfg.dsh.maxConcurrent ?? 1;
});

const onebot = new OneBot(cfg.onebot);
const bridge = new Bridge(cfg, paths, status);
bridge.attach(onebot);

// /status、面板、SSE 都从这里取策略/权限/守护心跳；只读附加，不落 status.json。
status.provideAux(() => ({
  policy: bridge.policySummary(),
  preset: bridge.presetLabel(),
  guard: bridge.guardHealth()
}));

onebot.on('online', () => {
  status.update((v) => { v.onebot.connected = true; });
  status.emitEvent('state', 'OneBot 已连接，进入待命');
  log.info('OneBot 就绪，进入待命');
});
onebot.on('offline', () => {
  status.update((v) => { v.onebot.connected = false; });
  status.emitEvent('warn', 'OneBot 离线（QQ 未登录 / 掉线），回到待机');
  log.warn('OneBot 离线，回到待机（QQ 未登录时属正常；仍可用 /inject 测输入端）');
});
onebot.on('event', (ev) => {
  if (ev.post_type === 'meta_event' && ev.meta_event_type === 'lifecycle') {
    onebot.selfId = ev.self_id;
    status.update((v) => { v.onebot.selfId = ev.self_id; });
    status.emitEvent('state', '登录账号 self_id=' + ev.self_id);
    log.info('登录账号 self_id=' + ev.self_id);
    // 顺手把昵称也取回来，仪表盘显示用；失败不影响主流程
    onebot.call('get_login_info', {}, 8000)
  }
});

// 自己写 pid 文件。不要用调用方的 $!：setsid 会 fork，$! 拿到的不是 node 的 pid，
// kill 会打空、旧进程继续跑，于是越启越多。这个教训来自本机 tinda 的 entry.js。
const pidFile = path.join(paths.stateDir, 'bridge.pid');

// 单例守卫，且**必须在连 NapCat 之前**。
//
// 为什么不能只靠管理端口的 EADDRINUSE：
//   1. listen 的错误回调是异步的，而 OneBot 连接可能在它之前就建立并开始收事件；
//   2. 配置里把 admin.port 一改，这道锁就整个失效；
//   3. 最要命的是**没有任何征兆**——两个客户端都能从 NapCat 收到同一条事件，
//      各自回复一次，用户看到两条一模一样的消息（2026-10-16 01:40 就是这样）。
// 用 pid 提前拦掉，比事后去 QQ 里数气泡便宜得多。
try {
  const prevRaw = fs.readFileSync(pidFile, 'utf8').trim();
  const prev = Number.parseInt(prevRaw, 10);
  if (Number.isInteger(prev) && prev > 0 && prev !== process.pid) {
    let alive = false;
    try { process.kill(prev, 0); alive = true; }
    catch (err) { alive = err.code === 'EPERM'; }
    if (alive) {
      let cmd = '';
      try { cmd = fs.readFileSync('/proc/' + prev + '/cmdline', 'utf8').replace(/\0/g, ' ').trim(); } catch {}
      // 只在确实是本桥接器时才拦，避免 pid 复用误伤
      if (!cmd || cmd.includes('index.js')) {
        log.error('已有桥接器在运行：pid ' + prev + (cmd ? '（' + cmd + '）' : '') + '，state=' + paths.stateDir);
        log.error('两个客户端会同时消费同一条 NapCat 事件，导致每条消息被回复两次。');
        log.error('先停掉它：tinda qq stop    （确认要强起：BRIDGE_FORCE=1）');
        if (process.env.BRIDGE_FORCE !== '1') {
          try { fs.rmSync(path.join(paths.stateDir, 'bridge.pid.lock'), { force: true }); } catch {}
          process.exit(1);
        }
        log.warn('BRIDGE_FORCE=1，忽略上面这条，继续启动（重复回复的风险由你承担）');
      }
    }
  }
} catch { /* 首次启动 / 文件不存在，正常 */ }
fs.writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
try { fs.chmodSync(pidFile, 0o600); } catch {}

// 管理 token：/inject、/command、/api 都要求它。面板 token 是另一份，互不通用。
// 两份 token 都只落在本地 0600 文件里，不走网络、不进日志。
const adminTokenFile = path.join(paths.stateDir, 'admin.token');
const panelTokenFile = path.join(paths.stateDir, 'panel.token');
const adminToken = ensureTokenFile(adminTokenFile);
const panelToken = ensureTokenFile(panelTokenFile);
const audit = createAuditLog(path.join(paths.stateDir, 'audit.log'));

const panelConfigPath = loaded.source;

/** 配置页读取：只回显脱敏副本，不把 accessToken 带进 HTML。 */
function readPanelConfig() {
  return configView(panelConfigPath);
}

/** 配置页保存：与启动同一套校验，原子写 + 备份；不热加载，统一标记需重启。 */
async function savePanelConfig(submitted, meta = {}) {
  const operator = meta.operator || 'panel-user';
  const current = readConfigFile(panelConfigPath);
  const prepared = prepareConfig(submitted, current.config, { env: process.env });
  const changed = diffConfig(current.config, prepared.config);
  if (!changed.length) {
    return {
      changed: [],
      restartRequired: false,
      warnings: prepared.warnings,
      source: panelConfigPath,
      config: configView(panelConfigPath).config
    };
  }
  const written = writeConfigFile(panelConfigPath, prepared.config);
  audit.write({ operator, action: 'config:save', target: 'config', result: 'ok' });
  status.emitEvent('state', '面板保存配置（' + changed.length + ' 项变更，需重启）');
  const view = configView(panelConfigPath);
  return {
    changed,
    restartRequired: true,
    warnings: prepared.warnings,
    source: written.source,
    backup: written.backup,
    savedAt: written.savedAt,
    config: view.config
  };
}

/** 运行时指令：走和 QQ/admin 完全相同的 handleInbound，只是 deliver=null。 */
async function runPanelCommand(text, meta = {}) {
  const operator = meta.operator || 'panel-user';
  const raw = String(meta.chatKey || 'private:panel').trim();
  const chatKey = /^(private|group):[A-Za-z0-9_-]{1,80}$/.test(raw) ? raw : 'private:panel';
  const kind = chatKey.startsWith('group:') ? 'group' : 'private';
  const id = chatKey.slice(chatKey.indexOf(':') + 1);
  const result = await bridge.handleInbound({
    chatKey, kind, id, userId: id,
    senderName: '控制台', text, images: [], mentioned: true,
    selfId: onebot.selfId || 'panel', trusted: false, operator,
    adminBypass: true, forceCommand: true
  }, { deliver: null });
  audit.write({
    operator,
    action: 'command',
    target: String(text).split(/\s+/)[0].slice(0, 40),
    result: result.ok === false ? 'error' : 'ok'
  });
  return result;
}

/** 日志页只读 bridge/guard；不把 NapCat 的 QR/token 日志暴露出去。 */
function readPanelLog({ source = 'bridge', lines = 500 } = {}) {
  const files = {
    bridge: path.join(paths.stateDir, 'bridge.log'),
    guard: path.join(paths.stateDir, 'guard.log')
  };
  const file = files[source] || files.bridge;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) { return { source: files[source] ? source : 'bridge', lines: [], total: 0, error: err.message }; }
  const all = raw.split('\n');
  if (all.length && all[all.length - 1] === '') all.pop();
  const n = Math.max(1, Math.min(2000, Number(lines) || 500));
  let mtime = null;
  try { mtime = fs.statSync(file).mtime.toISOString(); } catch { /* 刚被轮转/删除 */ }
  return {
    source: files[source] ? source : 'bridge',
    lines: all.slice(-n),
  audit.write({
    operator,
    action: 'command',
    target: String(text).split(/\s+/)[0].slice(0, 40),
    result: result.ok === false ? 'error' : 'ok'
  });
  return result;
}

/** 日志页只读 bridge/guard；不把 NapCat 的 QR/token 日志暴露出去。 */
function readPanelLog({ source = 'bridge', lines = 500 } = {}) {
  const files = {
    bridge: path.join(paths.stateDir, 'bridge.log'),
    guard: path.join(paths.stateDir, 'guard.log')
  };
  const file = files[source] || files.bridge;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) { return { source: files[source] ? source : 'bridge', lines: [], total: 0, error: err.message }; }
  const all = raw.split('\n');
  if (all.length && all[all.length - 1] === '') all.pop();
  const n = Math.max(1, Math.min(2000, Number(lines) || 500));
  let mtime = null;
  try { mtime = fs.statSync(file).mtime.toISOString(); } catch { /* 刚被轮转/删除 */ }
  return {
    source: files[source] ? source : 'bridge',
    lines: all.slice(-n),
    total: all.length,
    mtime
  };
}

/** 重启桥接器：延迟 1s 交给 qq-gateway.sh，避免把响应掐断；NapCat 不动。 */
async function restartBridgeFromPanel(meta = {}) {
  const running = (status.snapshot().dsh && status.snapshot().dsh.running) || 0;
  if (running > 0 && meta.force !== true) {
    throw new Error('还有 ' + running + ' 个回合在跑；等它收尾，或确认强制重启');
  }
  const script = path.join(here, 'qq-gateway.sh');
  if (!fs.existsSync(script)) throw new Error('找不到 ' + script);
  const child = spawn('bash', ['-c', 'sleep 1; exec "$0" restart-bridge', script], {
    cwd: here, detached: true, stdio: 'ignore', env: process.env
  });
  child.unref();
  audit.write({ operator: meta.operator || 'panel-user', action: 'restart', target: 'bridge', result: 'ok' });
  status.emitEvent('state', '面板触发重启桥接器' + (meta.force ? '（强制）' : ''));
  return { restarting: true, running };
}

startAdminServer(
  {
    host: cfg.admin?.host || '127.0.0.1',
    port: cfg.admin?.port ?? 6701,
    token: adminToken,
    allowedOrigins: cfg.admin?.allowedOrigins || [],
    onFatal: () => { try { fs.rmSync(pidFile, { force: true }); } catch {} process.exit(1); }
  },
        chatKey, kind, id, userId: id,
        senderName: body.sender || '本地注入',
        text: body.text, images: body.images || [], mentioned: true,
        selfId: 'local',
        // 不再是匿名 trusted:true：operator 已知，且显式标记 adminBypass（审计在 admin 层）
        trusted: false, operator, adminBypass: true,
        forceCommand: body.forceCommand === true
      }, { deliver: null });
      return result;
    }
  }
);

log.info('管理 token 在 ' + adminTokenFile);

// 仪表盘（`tinda qq web`）。读页面不需要 token；写入口默认关闭，
// 开启后需要 Bearer state/panel.token（与 admin token 完全独立）。
let panel = null;
if (cfg.panel?.enabled !== false) {
      const chatKey = body.chatKey || chatKeyFor({
        isGroup: kind === 'group',
        groupId: kind === 'group' ? id : null,
        userId: body.userId || id,
        groupSessionScope: cfg.behavior?.groupSessionScope
      });
      const operator = meta.operator || 'local-admin';
      status.update((v) => { v.counters.injected += 1; });
      // 事件流不写消息原文；只写脱敏目标与长度。
      status.emitEvent('in', '[注入] ' + maskChatKey(chatKey) + '（' +
        operator + '，' + String(body.text || '').length + ' 字符）');
      // deliver 传 null：注入不给 QQ 推消息（可能压根没登录），回复从 HTTP 响应取
      const result = await bridge.handleInbound({
        chatKey, kind, id, userId: id,
        senderName: body.sender || '本地注入',
        text: body.text, images: body.images || [], mentioned: true,
        selfId: 'local',
        // 不再是匿名 trusted:true：operator 已知，且显式标记 adminBypass（审计在 admin 层）
        trusted: false, operator, adminBypass: true,
        forceCommand: body.forceCommand === true
      }, { deliver: null });
      return result;
    }
  }
);

log.info('管理 token 在 ' + adminTokenFile);

// 仪表盘（`tinda qq web`）。读页面不需要 token；写入口默认关闭，
// 开启后需要 Bearer state/panel.token（与 admin token 完全独立）。
        adminPort: cfg.admin?.port ?? 6701
      }),
      getConfig: () => readPanelConfig(),
      saveConfig: (submitted, meta) => savePanelConfig(submitted, meta),
      command: (text, meta) => runPanelCommand(text, meta),
      readLog: (opts) => readPanelLog(opts),
      restart: (meta) => restartBridgeFromPanel(meta),
      callOneBot: (action, params) => onebot.call(action, params, 20000),
      audit,
      noteAction: (action, params, ok, error) => {
        status.count('actions');
        status.emitEvent('action', (ok ? '面板调用 ' : '面板调用失败 ') + action +
          (ok ? '' : '：' + error));
      }
    }
  );
  const panelUrlFile = path.join(paths.stateDir, 'panel.url');
  // 先删旧 URL：监听失败时绝不能让 tinda qq web 拿到一个已经不可用的地址。
  try { fs.rmSync(panelUrlFile, { force: true }); } catch {}
  panel.ready.then((url) => {
    try {
      fs.writeFileSync(panelUrlFile, url + '\n', { mode: 0o600 });
      fs.chmodSync(panelUrlFile, 0o600);
    } catch (err) { log.warn('写 panel.url 失败: ' + err.message); }
    status.update((v) => { v.panel = url; });
    status.emitEvent('state', '仪表盘已启动 ' + url);
    if (cfg.panel?.writeEnabled === true) {
      log.info('面板写入口已开启；token 在 ' + panelTokenFile + '（0600，不打印）');
    } else {
      log.info('面板写入口关闭（panel.writeEnabled=false）；只读页面无需 token');
    }
  }).catch((err) => {
    try { fs.rmSync(panelUrlFile, { force: true }); } catch {}
    status.update((v) => { v.panel = null; v.lastError = 'panel: ' + (err && err.message || err); });
    status.emitEvent('error', '仪表盘未启动：' + (panel && panel.error ? panel.error : (err && err.message || err)));
    log.error('仪表盘不可用：' + (panel && panel.error ? panel.error : (err && err.message || err)));
  });
}

// P0-01：不再启动时跑 probe（它会通过 API 建真实会话/调模型）。
// 桥接器只走 headless spawn；会话不进侧边栏是确定事实，不靠自检猜测。
log.info('会话模式：headless spawn（会话不会出现在 DSH 侧边栏）');

onebot.start();

log.info('工作目录 ' + paths.workspace);
log.info('DSH profile ' + cfg.dsh.profile);

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
          });
          throw err;
        }
      },
      readLog: (opts) => readPanelLog(opts),
      restart: (meta) => restartBridgeFromPanel(meta),
      callOneBot: (action, params) => onebot.call(action, params, 20000),
      audit,
      noteAction: (action, params, ok, error) => {
        status.count('actions');
        status.emitEvent('action', (ok ? '面板调用 ' : '面板调用失败 ') + action +
          (ok ? '' : '：' + error));
      }
    }
  );
  const panelUrlFile = path.join(paths.stateDir, 'panel.url');
  // 先删旧 URL：监听失败时绝不能让 tinda qq web 拿到一个已经不可用的地址。
  try { fs.rmSync(panelUrlFile, { force: true }); } catch {}
  panel.ready.then((url) => {
    try {
      fs.writeFileSync(panelUrlFile, url + '\n', { mode: 0o600 });
      fs.chmodSync(panelUrlFile, 0o600);
    } catch (err) { log.warn('写 panel.url 失败: ' + err.message); }
    status.update((v) => { v.panel = url; });
    status.emitEvent('state', '仪表盘已启动 ' + url);
    if (cfg.panel?.writeEnabled === true) {
      log.info('面板写入口已开启；token 在 ' + panelTokenFile + '（0600，不打印）');
    } else {
      log.info('面板写入口关闭（panel.writeEnabled=false）；只读页面无需 token');
    }
