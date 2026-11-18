import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** 随机可用端口：先 listen(0) 拿到系统分配，再关闭。避免并行测试撞端口。 */
export async function freePort(host = '127.0.0.1') {
  return await new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, host, () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

/** 每个测试独立的临时目录，绝不写生产 state/。 */
export function makeTempDir(prefix = 'napcat-bridge-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function rmrf(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** 测试配置：默认面板关闭、admin 随机口、profile=qq、临时 state。 */
export function baseConfig({ onebotPort, adminPort = 0, stateDir, userId = '20002' }) {
  return {
    onebot: {
      mode: 'forward-ws',
      url: 'ws://127.0.0.1:' + onebotPort,
      accessToken: '',
      reconnectMs: 300
    },
    dsh: {
      command: process.env.TEST_DSH_COMMAND || 'dsh',
      profile: 'qq',
      cwd: '',
      timeoutMs: 240000,
      maxConcurrent: 1,
      extraArgs: []
    },
    admin: { host: '127.0.0.1', port: adminPort },
    panel: { host: '127.0.0.1', port: 0, enabled: false },
    policy: {
      privateChat: 'allowlist',
      groupChat: 'deny',
      allowUsers: [userId],
      allowGroups: [],
      allowAllUsers: false,
      allowAllGroups: false,
      ignoreSelf: true
    },
    behavior: {
      ackAfterMs: 0,
      ackText: '',
      busyText: '',
      maxReplyChars: 4000,
      groupSenderPrefix: true,
      downloadImages: false,
      humanize: { enabled: false }
    },
    stateDir
  };
}

/** 把配置写进临时目录，返回路径。 */
export function writeConfig(dir, name, config) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(config, null, 2));
  return file;
}
