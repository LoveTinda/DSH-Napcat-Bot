import fs from 'node:fs';
import path from 'node:path';

/**
 * 配置加载与校验。
 *
 * 历史问题：找不到 config.json 时静默回退到 config.example.json（profile=headless），
 * 结果进程“看起来启动成功”，实际每一轮都会踩 preset/headless 互斥。这里改成
 * fail fast：缺文件、坏 JSON、profile=headless、端口冲突都直接拒绝启动。
 */

export class ConfigError extends Error {
  constructor(message, code = 'config/invalid') {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
  }
}

function fail(message, code) {
  throw new ConfigError(message, code);
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/**
 * @param {{argv?: string[], env?: NodeJS.ProcessEnv, root: string}} opts
 * @returns {{config: object, source: string, warnings: string[]}}
 */
export function loadConfig({ argv = process.argv, env = process.env, root } = {}) {
  if (!root) fail('loadConfig 缺少 root', 'config/root');
  const explicit = argv[2] || env.BRIDGE_CONFIG;
  const candidates = explicit
    ? [path.resolve(root, explicit)]
    : [path.join(root, 'config.json')];

  let source = null;
  for (const file of candidates) {
    if (fs.existsSync(file)) { source = file; break; }
  }
  if (!source) {
    const hint = explicit
      ? '显式指定的配置文件不存在：' + candidates[0]
      : '找不到配置文件：' + candidates[0] + '\n先复制一份模板：cp config.example.json config.json';
    fail(hint, 'config/missing');
  }

  let raw;
  try {
    raw = fs.readFileSync(source, 'utf8');
  } catch (err) {
    fail('读不到配置文件 ' + source + '：' + err.message, 'config/unreadable');
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    fail('配置文件不是合法 JSON（' + source + '）：' + err.message, 'config/json');
  }
  if (!isPlainObject(config)) fail('配置文件顶层必须是对象：' + source, 'config/shape');

  if (env.ONEBOT_ACCESS_TOKEN) config.onebot = { ...(config.onebot || {}), accessToken: env.ONEBOT_ACCESS_TOKEN };

  const warnings = validateConfig(config, { env });
  return { config, source, warnings };
}

/** 校验并返回警告（不改配置）。调用方决定警告是否只打印。 */
export function validateConfig(cfg, { env = process.env } = {}) {
  if (!isPlainObject(cfg)) fail('配置必须是对象', 'config/shape');
  const warnings = [];
  const onebot = cfg.onebot;
  if (!isPlainObject(onebot)) fail('缺少 onebot 配置', 'config/onebot');
  const mode = onebot.mode || 'forward-ws';
  if (!['forward-ws', 'reverse-ws', 'http'].includes(mode)) {
    fail('onebot.mode 只能是 forward-ws / reverse-ws / http（当前 ' + mode + '）', 'config/onebot-mode');
  }
  if (mode !== 'reverse-ws') {
    if (typeof onebot.url !== 'string' || !/^wss?:\/\//.test(onebot.url)) {
      fail('onebot.url 必须是 ws:// 或 wss:// 地址（当前 ' + String(onebot.url) + '）', 'config/onebot-url');
    }
  } else {
    const p = Number(onebot.listenPort);
    if (!Number.isInteger(p) || p < 1 || p > 65535) fail('onebot.listenPort 必须是 1-65535 的整数', 'config/onebot-port');
  }
  if (onebot.accessToken !== undefined && typeof onebot.accessToken !== 'string') {
    fail('onebot.accessToken 必须是字符串', 'config/onebot-token');
  }

  const dsh = cfg.dsh;
  if (!isPlainObject(dsh)) fail('缺少 dsh 配置', 'config/dsh');
  if (typeof dsh.command !== 'string' || !dsh.command.trim()) fail('dsh.command 不能为空', 'config/dsh-command');
  // 这是 P0-01/P1-04 的硬边界：headless 一次运行器拒绝带 agentPreset 的会话。
  // 允许自定义 profile，但明确拒绝 headless 这个已知会“假成功”的取值。
  if (dsh.profile !== 'qq') {
    fail('dsh.profile 必须是 qq（当前 ' + String(dsh.profile) + '）。\n' +
      'headless 一次性运行器会拒绝 API 建出的带 preset 会话，导致每轮分叉/失忆；\n' +
      '如果确实要跑其他 profile，请显式改代码里的边界，而不是让配置静默降级。', 'config/profile');
  }
  if (dsh.cwd !== undefined && typeof dsh.cwd !== 'string') fail('dsh.cwd 必须是字符串', 'config/dsh-cwd');
  const timeout = Number(dsh.timeoutMs ?? 900000);
  if (!Number.isFinite(timeout) || timeout < 1000) fail('dsh.timeoutMs 必须是 >=1000 的数字', 'config/dsh-timeout');
  const maxConcurrent = Number(dsh.maxConcurrent ?? 1);
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 16) {
    fail('dsh.maxConcurrent 必须是 1-16 的整数', 'config/max-concurrent');
  }
  if (dsh.tokenFile !== undefined && typeof dsh.tokenFile !== 'string') {
    fail('dsh.tokenFile 必须是字符串', 'config/token-file');
  }

  const admin = cfg.admin ?? {};
  checkPort(admin.port ?? 6701, 'admin.port');
  const panel = cfg.panel ?? {};
  if (panel.enabled !== false) {
    checkPort(panel.port ?? 6702, 'panel.port');
    if (String(admin.host ?? '127.0.0.1') === String(panel.host ?? '127.0.0.1') &&
        Number(admin.port ?? 6701) === Number(panel.port ?? 6702)) {
      fail('admin.port 与 panel.port 不能相同（' + Number(panel.port ?? 6702) + '）', 'config/port-conflict');
    }
    const host = String(panel.host ?? '127.0.0.1');
    if (!isLoopback(host)) {
      warnings.push('面板没有任何鉴权，却监听在 ' + host + '；请只监听 127.0.0.1 或自己加反代鉴权。');
    }
  }

  const policy = cfg.policy;
  if (!isPlainObject(policy)) fail('缺少 policy 配置', 'config/policy');
  // 与 policy.js 的 P0-04 语义保持一致：私聊 allowlist|allow|deny，群聊 mention|allow|deny。
  if (!['allowlist', 'allow', 'deny'].includes(policy.privateChat)) {
    fail('policy.privateChat 只能是 allowlist / allow / deny（当前 ' + String(policy.privateChat) + '）', 'config/policy-privateChat');
  }
  if (!['mention', 'allow', 'deny'].includes(policy.groupChat)) {
    fail('policy.groupChat 只能是 mention / allow / deny（当前 ' + String(policy.groupChat) + '）', 'config/policy-groupChat');
  }
  if (policy.groupChat === 'deny' && policy.privateChat === 'deny') {
    warnings.push('policy.privateChat 与 groupChat 都是 deny：机器人不会响应任何消息。');
  }
  const allowUsers = policy.allowUsers ?? [];
  const allowGroups = policy.allowGroups ?? [];
  if (!Array.isArray(allowUsers) || !Array.isArray(allowGroups)) {
    fail('policy.allowUsers / allowGroups 必须是数组', 'config/allowlist');
  }
  if (policy.ownerUsers !== undefined && !Array.isArray(policy.ownerUsers)) {
    fail('policy.ownerUsers 必须是数组', 'config/owner-users');
  }
  if (policy.adminUsers !== undefined && !Array.isArray(policy.adminUsers)) {
    fail('policy.adminUsers 必须是数组', 'config/admin-users');
  }
  if (allowUsers.length === 0 && policy.privateChat === 'allowlist' && policy.allowAllUsers !== true) {
    warnings.push('policy.allowUsers 为空且 privateChat=allowlist：policy.js 会拒绝启动（默认拒绝陌生人）。');
  }
  if (allowGroups.length === 0 && policy.groupChat !== 'deny' && policy.allowAllGroups !== true) {
    warnings.push('policy.allowGroups 为空且 allowAllGroups!=true：所有群消息都会被拒绝。');
  }

  const behavior = cfg.behavior;
  if (!isPlainObject(behavior)) fail('缺少 behavior 配置', 'config/behavior');
  const maxReply = Number(behavior.maxReplyChars ?? 4000);
  if (!Number.isInteger(maxReply) || maxReply < 100 || maxReply > 20000) {
    fail('behavior.maxReplyChars 必须是 100-20000 的整数', 'config/max-reply');
  }
  if (behavior.onBusy !== undefined && !['interrupt', 'queue'].includes(behavior.onBusy)) {
    fail('behavior.onBusy 只能是 interrupt / queue', 'config/on-busy');
  }
  if (behavior.ackAfterMs !== undefined && (!Number.isFinite(Number(behavior.ackAfterMs)) || Number(behavior.ackAfterMs) < 0)) {
    fail('behavior.ackAfterMs 必须是非负数字', 'config/ack');
  }
  if (cfg.stateDir !== undefined && typeof cfg.stateDir !== 'string') fail('stateDir 必须是字符串', 'config/state-dir');
  if (cfg.stateFile !== undefined && typeof cfg.stateFile !== 'string') fail('stateFile 必须是字符串', 'config/state-file');
  return warnings;
}

function checkPort(v, name) {
  const p = Number(v);
  if (!Number.isInteger(p) || p < 0 || p > 65535) fail(name + ' 必须是 0-65535 的整数（当前 ' + String(v) + '）', 'config/port');
}

function isLoopback(host) {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** 路径解析：测试用 BRIDGE_STATE_DIR/BRIDGE_WORKSPACE 注入临时目录。 */
export function resolvePaths(cfg, { root, env = process.env } = {}) {
  if (!root) fail('resolvePaths 缺少 root', 'config/root');
  const workspace = path.resolve(
    env.BRIDGE_WORKSPACE
      ? path.resolve(root, env.BRIDGE_WORKSPACE)
      : (cfg.dsh?.cwd ? path.resolve(root, cfg.dsh.cwd) : path.join(root, 'workspace'))
  );
  const stateDir = path.resolve(
    env.BRIDGE_STATE_DIR
      ? path.resolve(root, env.BRIDGE_STATE_DIR)
      : (cfg.stateDir ? path.resolve(root, cfg.stateDir) : path.join(root, 'state'))
  );
  const rawStateFile = cfg.stateFile;
  const stateFile = rawStateFile
    ? (path.isAbsolute(rawStateFile) ? rawStateFile : path.resolve(stateDir, rawStateFile))
    : path.join(stateDir, 'sessions.json');
  return { root, workspace, stateDir, stateFile };
}

/** 启动摘要（绝不包含 token）。 */
export function configSummary(cfg, paths) {
  const p = cfg.policy || {};
  const b = cfg.behavior || {};
  return [
    'profile=' + cfg.dsh?.profile,
    'onebot=' + (cfg.onebot?.mode || 'forward-ws') + ':' + (cfg.onebot?.url || (':' + cfg.onebot?.listenPort)),
    'admin=' + (cfg.admin?.host || '127.0.0.1') + ':' + (cfg.admin?.port ?? 6701),
    'panel=' + (cfg.panel?.enabled === false ? 'off' : (cfg.panel?.host || '127.0.0.1') + ':' + (cfg.panel?.port ?? 6702)),
    'policy=private:' + p.privateChat + ',group:' + p.groupChat +
      ',allowUsers:' + (p.allowUsers || []).length + ',allowGroups:' + (p.allowGroups || []).length,
    'maxReplyChars=' + (b.maxReplyChars ?? 4000),
    'workspace=' + paths.workspace,
    'state=' + paths.stateDir
  ].join(' ');
}
  return [
    'profile=' + cfg.dsh?.profile,
    'transport=' + (cfg.dsh?.transport || 'auto') + ':' + ((cfg.dsh?.webHost || '127.0.0.1') + ':' + (cfg.dsh?.webPort ?? 3080)),
    'onebot=' + (cfg.onebot?.mode || 'forward-ws') + ':' + (cfg.onebot?.url || (':' + cfg.onebot?.listenPort)),
    'admin=' + (cfg.admin?.host || '127.0.0.1') + ':' + (cfg.admin?.port ?? 6701),
    'panel=' + (cfg.panel?.enabled === false ? 'off' : (cfg.panel?.host || '127.0.0.1') + ':' + (cfg.panel?.port ?? 6702)),
    'policy=private:' + p.privateChat + ',group:' + p.groupChat +
      ',allowUsers:' + (p.allowUsers || []).length + ',allowGroups:' + (p.allowGroups || []).length,
    'maxReplyChars=' + (b.maxReplyChars ?? 4000),
    'workspace=' + paths.workspace,
    'state=' + paths.stateDir
  ].join(' ');
}
