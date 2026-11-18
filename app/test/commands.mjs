import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

/**
 * 单应用命令层：/status、/ls、/ws 的端到端行为。
 * 重点钉住两件事：/ls 不能逃出当前工作区；/ws 切目录后 /status 真的变了。
 */
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'app-commands-'));
const workspace = path.join(tmp, 'workspace');
fs.mkdirSync(path.join(workspace, 'sub'), { recursive: true });
fs.writeFileSync(path.join(workspace, 'root.txt'), 'root');
fs.writeFileSync(path.join(workspace, 'sub', 'hello.txt'), 'hello');
const fake = path.join(tmp, 'dsh');
fs.writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\n' +
  'echo \'{"type":"session","sessionId":"session-cmd-0001"}\'\n' +
  'echo \'{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}\'\n' +
  'echo \'{"type":"final","text":"ok"}\'\n', { mode: 0o700 });
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.smoke.panel.json'), 'utf8'));
cfg.dsh.command = fake;
cfg.policy.allowUsers = ['2'];
cfg.policy.ownerUsers = ['2'];
cfg.admin.port = 16731;
cfg.panel.enabled = false;
const cfgFile = path.join(tmp, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
const stateDir = path.join(tmp, 'state');
const child = spawn(process.execPath, ['src/index.js', cfgFile], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BRIDGE_STATE_DIR: stateDir, BRIDGE_WORKSPACE: workspace }
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { return await fn(); } catch { await sleep(150); }
  }
  throw new Error('timeout; log=' + out.slice(-1500));
}
try {
  await waitFor(async () => {
    const r = await fetch('http://127.0.0.1:16731/status');
    assert.equal(r.status, 200);
  });
  const token = fs.readFileSync(path.join(stateDir, 'admin.token'), 'utf8').trim();
  const command = async (text) => {
    const r = await fetch('http://127.0.0.1:16731/command', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
      body: JSON.stringify({ text })
    });
    assert.equal(r.status, 200);
    const body = await r.json();
    assert.equal(body.ok, true, text + ' -> ' + JSON.stringify(body));
    return String(body.reply || '');
  };

  const status = await command('/status');
  assert.ok(status.includes('工作区：' + workspace), status);

  const ls = await command('/ls');
  assert.ok(ls.includes('root.txt'), ls);
  assert.ok(ls.includes('sub'), ls);

  const escape = await command('/ls /etc');
  assert.ok(escape.includes('只能列当前工作区'), escape);

  const ws = await command('/ws sub');
  assert.ok(ws.includes('工作区已切到'), ws);
  const status2 = await command('/status');
  assert.ok(status2.includes('工作区：' + path.join(workspace, 'sub')), status2);
  const ls2 = await command('/ls');
  assert.ok(ls2.includes('hello.txt'), ls2);
  console.log('commands: ok');
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise((r) => child.once('exit', r)), sleep(3000)]);
  child.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
}
