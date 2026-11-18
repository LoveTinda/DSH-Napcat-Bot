import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-turn-'));
const fake = path.join(tmp, 'dsh');
fs.writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\n' +
  'echo \'{"type":"session","sessionId":"session-fake-0001"}\'\n' +
  'echo \'{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}\'\n' +
  'echo \'{"type":"final","text":"假 DSH 回复：收到"}\'\n', { mode: 0o700 });
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.smoke.panel.json'), 'utf8'));
cfg.dsh.command = fake;
cfg.admin.port = 16711;
cfg.panel.port = 16712;
cfg.panel.enabled = false;
const cfgFile = path.join(tmp, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));
const stateDir = path.join(tmp, 'state');
const child = spawn(process.execPath, ['src/index.js', cfgFile], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BRIDGE_STATE_DIR: stateDir, BRIDGE_WORKSPACE: path.join(tmp, 'workspace') }
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
    const r = await fetch('http://127.0.0.1:16711/status');
    assert.equal(r.status, 200);
  });
  const token = fs.readFileSync(path.join(stateDir, 'admin.token'), 'utf8').trim();
  const r = await fetch('http://127.0.0.1:16711/inject', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ kind: 'private', id: '1', username: 'tester', text: '你好' })
  });
  assert.equal(r.status, 200);
  const body = await r.json();
  assert.equal(body.ok, true);
  assert.equal(body.reply, '假 DSH 回复：收到');
  assert.equal(body.sessionId, 'session-fake-0001');
  assert.equal(body.turns, 1);
  console.log('legacy-turn: ok');
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise((r) => child.once('exit', r)), sleep(3000)]);
  child.kill('SIGKILL');
  fs.rmSync(tmp, { recursive: true, force: true });
}