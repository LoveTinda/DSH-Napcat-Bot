import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

/**
 * HTTP 模式端到端：NapCat 把事件 POST 到桥接监听端口，桥接把回复
 * POST 回 NapCat 的 OneBot HTTP 动作地址（/send_private_msg）。
 */
const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-onebot-http-'));
const fake = path.join(tmp, 'dsh');
fs.writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\n' +
  'echo \'{"type":"session","sessionId":"session-http-0001"}\'\n' +
  'echo \'{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}\'\n' +
  'echo \'{"type":"final","text":"HTTP 回合回复"}\'\n', { mode: 0o700 });
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.smoke.panel.json'), 'utf8'));
cfg.onebot = {
  mode: 'http', url: 'http://127.0.0.1:16911', accessToken: '',
  listenHost: '127.0.0.1', listenPort: 16912, reconnectMs: 300
};
cfg.dsh.command = fake;
cfg.policy.allowUsers = ['2'];
cfg.policy.ownerUsers = ['2'];
cfg.admin.port = 16722;
cfg.panel.enabled = false;
const cfgFile = path.join(tmp, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

const received = [];
const actionServer = http.createServer((req, res) => {
  let body = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    let parsed = {};
    try { parsed = JSON.parse(body || '{}'); } catch {}
    received.push({ action: req.url.replace(/^\/+/, ''), params: parsed });
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 12 } }));
  });
});
await new Promise((r) => actionServer.listen(16911, '127.0.0.1', r));

function postEvent(payload) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: 16912, path: '/', method: 'POST',
      headers: { 'content-type': 'application/json' }
    }, (res) => { res.resume(); res.on('end', resolve); });
    req.on('error', reject);
    req.end(JSON.stringify(payload));
  });
}

const stateDir = path.join(tmp, 'state');
const child = spawn(process.execPath, ['src/index.js', cfgFile], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, BRIDGE_STATE_DIR: stateDir, BRIDGE_WORKSPACE: path.join(tmp, 'workspace') }
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  // 等监听端口就绪
  const ready = Date.now() + 5000;
  let up = false;
  while (Date.now() < ready) {
    try { await postEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat', self_id: 1 }); up = true; break; }
    catch { await sleep(100); }
  }
  assert.ok(up, 'HTTP 监听端口未就绪; log=' + out.slice(-1500));
  await postEvent({
    post_type: 'message', message_type: 'private', self_id: 1,
    user_id: 2, message_id: 21, raw_message: '你好',
    sender: { user_id: 2, nickname: 'tester' },
    message: [{ type: 'text', data: { text: '你好' } }]
  });
  const end = Date.now() + 10000;
  while (Date.now() < end && !received.some((m) => m.action === 'send_private_msg')) await sleep(100);
  const sent = received.find((m) => m.action === 'send_private_msg');
  assert.ok(sent, '没有收到 send_private_msg; log=' + out.slice(-1500));
  assert.equal(sent.params.user_id, '2');
  const text = Array.isArray(sent.params.message)
    ? sent.params.message.map((p) => p.data?.text || '').join('')
    : String(sent.params.message);
  assert.ok(text.includes('HTTP 回合回复'), '回复内容不对: ' + text);
  console.log('legacy-onebot-http: ok');
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise((r) => child.once('exit', r)), sleep(3000)]);
  child.kill('SIGKILL');
  actionServer.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
