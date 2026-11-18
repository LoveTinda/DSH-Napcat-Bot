/**
 * 目的：只读体检：配置、端口、权限、依赖、日志。
 * 边界：不修改任何文件/服务。
 * 依赖：node:fs/net；被 bin/doctor.sh 调用。
 * 失败：检查失败输出 FAIL，退出码非 0。
 */
// [MISSING LINE 1]
// [MISSING LINE 2]
// [MISSING LINE 3]
// [MISSING LINE 4]
// [MISSING LINE 5]
// [MISSING LINE 6]
// [MISSING LINE 7]
// [MISSING LINE 8]
// [MISSING LINE 9]
// [MISSING LINE 10]
// [MISSING LINE 11]
// [MISSING LINE 12]
// [MISSING LINE 13]
// [MISSING LINE 14]
// [MISSING LINE 15]
// [MISSING LINE 16]
// [MISSING LINE 17]
// [MISSING LINE 18]
// [MISSING LINE 19]
// [MISSING LINE 20]
// [MISSING LINE 21]
// [MISSING LINE 22]
// [MISSING LINE 23]
// [MISSING LINE 24]
// [MISSING LINE 25]
// [MISSING LINE 26]
// [MISSING LINE 27]
// [MISSING LINE 28]
// [MISSING LINE 29]
// [MISSING LINE 30]
// [MISSING LINE 31]
// [MISSING LINE 32]
// [MISSING LINE 33]
// [MISSING LINE 34]
// [MISSING LINE 35]
// [MISSING LINE 36]
// [MISSING LINE 37]
// [MISSING LINE 38]
// [MISSING LINE 39]
// [MISSING LINE 40]
// [MISSING LINE 41]
// [MISSING LINE 42]
// [MISSING LINE 43]
// [MISSING LINE 44]
// [MISSING LINE 45]
// [MISSING LINE 46]
// [MISSING LINE 47]
// [MISSING LINE 48]
// [MISSING LINE 49]
// [MISSING LINE 50]
// [MISSING LINE 51]
// [MISSING LINE 52]
// [MISSING LINE 53]
// [MISSING LINE 54]
// [MISSING LINE 55]
// [MISSING LINE 56]
// [MISSING LINE 57]
// [MISSING LINE 58]
// [MISSING LINE 59]
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return null;
}

// 1) 配置
const cfg = json(configPath);
if (!cfg) {
  fail('config', '读不到或不是合法 JSON：' + configPath);
} else {
  ok('config', configPath);
  if (cfg.dsh?.profile === 'qq') ok('dsh.profile', 'qq');
  else fail('dsh.profile', '必须是 qq（当前 ' + String(cfg.dsh?.profile) + '）');
  const p = cfg.policy || {};
  if (p.privateChat === 'allowlist' && !(p.allowUsers || []).length && p.allowAllUsers !== true) {
    fail('policy.privateChat', 'allowlist 但 allowUsers 为空：桥接器会拒绝启动');
  } else if (p.privateChat === 'allow' && p.allowAllUsers !== true) {
    fail('policy.privateChat', 'allow 必须显式 allowAllUsers:true');
  } else {
    ok('policy.privateChat', String(p.privateChat || '—'));
  }
  if (p.groupChat !== 'deny' && !(p.allowGroups || []).length && p.allowAllGroups !== true) {
    warn('policy.groupChat', '群白名单为空：群消息会被拒绝');
  }
  const behavior = cfg.behavior || {};
  if (Number(behavior.maxReplyChars || 4000) > 0) ok('maxReplyChars', String(behavior.maxReplyChars || 4000));
  else fail('maxReplyChars', '必须是正数');
}

// 2) state 权限
