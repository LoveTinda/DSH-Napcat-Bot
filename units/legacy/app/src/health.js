import fs from 'node:fs';
import path from 'node:path';

/**
 * 分层健康检查。目标不是“进程还在”，而是回答“现在到底能不能用”。
 *
 * checks:
 *   process  桥接器进程自身
 *   admin    管理端口（能响应 /health 本身就说明活着）
 *   panel    仪表盘（关闭时不算故障）
 *   onebot   OneBot/QQ 是否在线
 *   dsh      dsh 命令与 qq profile 是否存在（headless 主链路）
 *   guard    外部守护心跳（有 pid/心跳文件时变关键项）
 *   job      Termux 定时任务是否注册（显式要求时才关键）
 *
 * 关键项失败 → ok:false；guard/job 未配置时只报 warn，不冒充“健康”。
 */

function fileJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try { process.kill(n, 0); return true; }
  catch (err) { return err.code === 'EPERM'; }
}

function commandPath(command, env = process.env) {
  const cmd = String(command || '').trim();
  if (!cmd) return null;
  if (cmd.includes('/')) return fs.existsSync(cmd) ? cmd : null;
  const pathVar = env.PATH || '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

function ageMs(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? Math.max(0, Date.now() - t) : null;
}

/**
 * @param {object} opts
 * @param {object} opts.snapshot StatusBoard.snapshot()
 * @param {object} opts.cfg
 * @param {{stateDir:string}} opts.paths
 * @param {object} [opts.panel] startPanel 返回值
 * @param {object} [opts.bridge]
 * @param {number} [opts.adminPort]
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
export function buildHealth({ snapshot, cfg, paths, panel = null, bridge = null, adminPort = 6701, env = process.env } = {}) {
  const s = snapshot || {};
  const checks = {};

  checks.process = {
    ok: true,
    critical: true,
    pid: process.pid,
    uptimeMs: s.uptimeMs ?? null,
    state: s.state || null
  };

  checks.admin = {
    ok: true,
    critical: true,
    host: cfg?.admin?.host || '127.0.0.1',
    port: adminPort
  };

  const panelEnabled = cfg?.panel?.enabled !== false;
  const panelError = panel && panel.error ? String(panel.error) : null;
  checks.panel = {
    ok: !panelEnabled || (!panelError && !!(panel && panel.url)),
    critical: panelEnabled,
    enabled: panelEnabled,
    url: panel && panel.url ? panel.url : null,
    error: panelError
  };

  checks.onebot = {
    ok: !!(s.onebot && s.onebot.connected),
    critical: true,
    mode: s.onebot?.mode || cfg?.onebot?.mode || null,
    url: s.onebot?.url || cfg?.onebot?.url || null,
    selfId: s.onebot?.selfId || null
  };

  const dshCommand = commandPath(cfg?.dsh?.command || 'dsh', env);
  const dshHome = env.DSH_HOME || path.join(env.HOME || '/root', '.dsh');
  const profileDir = path.join(dshHome, 'profiles', String(cfg?.dsh?.profile || 'qq'));
  const profileOk = fs.existsSync(profileDir);
  checks.dsh = {
    ok: !!dshCommand && profileOk,
    critical: true,
    command: cfg?.dsh?.command || 'dsh',
    commandPath: dshCommand,
    profile: cfg?.dsh?.profile || null,
    profileExists: profileOk,
    webApi: bridge?.dshApi ? { enabled: !!bridge.dshApi.enabled, base: bridge.dshApi.base || null } : null
  };

  const guardPidFile = path.join(paths.stateDir, 'guard.pid');
  const guardHealthFile = path.join(paths.stateDir, 'guard.health.json');
  let guardPid = null;
  try { guardPid = fs.readFileSync(guardPidFile, 'utf8').trim(); } catch { /* absent */ }
  const guardRequired = !!guardPid || env.BRIDGE_REQUIRE_GUARD === '1';
  const heartbeat = fileJson(guardHealthFile);
  const hbAge = heartbeat ? ageMs(heartbeat.updated_at || heartbeat.last_tick) : null;
  const hbFresh = hbAge !== null && hbAge <= Math.max(60000, Number(env.BRIDGE_GUARD_FRESH_MS) || 180000);
  checks.guard = {
    ok: guardRequired ? (pidAlive(guardPid) && (!heartbeat || hbFresh)) : !guardRequired,
    critical: guardRequired,
    required: guardRequired,
    pid: guardPid || null,
    pidAlive: pidAlive(guardPid),
    heartbeat: heartbeat || null,
    heartbeatAgeMs: hbAge,
    heartbeatFresh: hbFresh
  };

  const guardState = (() => {
    try {
      const raw = fs.readFileSync(path.join(paths.stateDir, 'guard.state'), 'utf8');
      const out = {};
      for (const line of raw.split('\n')) {
        const i = line.indexOf('=');
        if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
      }
      return out;
    } catch { return {}; }
  })();
  const jobRegistered = heartbeat?.job_registered === true || guardState.job_registered === '1';
  const jobRequired = env.BRIDGE_REQUIRE_JOB === '1';
  checks.job = {
    ok: jobRegistered,
    critical: jobRequired,
    required: jobRequired,
    registered: jobRegistered,
    jobId: heartbeat?.job_id || guardState.job_id || null,
    note: jobRegistered ? null : 'Termux 定时任务未注册（外部自愈可能不会按时唤醒）'
  };

  const critical = Object.entries(checks).filter(([, c]) => c.critical);
  const failed = critical.filter(([, c]) => !c.ok).map(([name]) => name);
  return {
    ok: failed.length === 0,
    state: s.state || null,
    checkedAt: new Date().toISOString(),
    failed,
    checks
  };
}
