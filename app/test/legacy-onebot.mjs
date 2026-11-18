import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-onebot-'));
const fake = path.join(tmp, 'dsh');
fs.writeFileSync(fake, '#!/bin/sh\ncat >/dev/null\n' +
  'echo \'{"type":"session","sessionId":"session-ws-0001"}\'\n' +
  'echo \'{"type":"status","phase":"turn_end","reason":{"kind":"completed"}}\'\n' +
  'echo \'{"type":"final","text":"WS 回合回复"}\'\n', { mode: 0o700 });
const cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.smoke.panel.json'), 'utf8'));
cfg.onebot = { mode: 'forward-ws', url: 'ws://127.0.0.1:16901', accessToken: '', reconnectMs: 300 };
cfg.dsh.command = fake;
cfg.policy.allowUsers = ['2'];
cfg.policy.ownerUsers = ['2'];
cfg.admin.port = 16721;
cfg.panel.enabled = false;
const cfgFile = path.join(tmp, 'config.json');
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2));

const received = [];
function frame(text) {
  const b = Buffer.from(text);
  if (b.length < 126) return Buffer.concat([Buffer.from([0x81, b.length]), b]);
  if (b.length < 65536) { const h = Buffer.alloc(4); h[0] = 0x81; h[1] = 126; h.writeUInt16BE(b.length, 2); return Buffer.concat([h, b]); }
  const h = Buffer.alloc(10); h[0] = 0x81; h[1] = 127; h.writeBigUInt64BE(BigInt(b.length), 2); return Buffer.concat([h, b]);
}
const server = http.createServer();
server.on('upgrade', (req, socket) => {
  const key = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  setTimeout(() => {
    const ev = {
      post_type: 'message', message_type: 'private', self_id: 1,
      user_id: 2, message_id: 11, raw_message: '你好', sender: { user_id: 2, nickname: 'tester' }, message: [{ type: 'text', data: { text: '你好' } }]
    };
    socket.write(frame(JSON.stringify(ev)));
  }, 300);
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const op = buf[0] & 0xf;
      let len = buf[1] & 0x7f;
      let off = 2;
      if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (buf.length < off + 4 + len) return;
      const mask = buf.subarray(off, off + 4); off += 4;
      const payload = Buffer.from(buf.subarray(off, off + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      buf = buf.subarray(off + len);
      if (op === 8) { socket.end(); return; }
      if (op !== 1) continue;
      let msg; try { msg = JSON.parse(payload.toString('utf8')); } catch { continue; }
      if (msg.action) {
        received.push(msg);
        socket.write(frame(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 12 }, echo: msg.echo })));
      }
    }
  });
});
await new Promise((r) => server.listen(16901, '127.0.0.1', r));

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
  const end = Date.now() + 10000;
  while (Date.now() < end && !received.some((m) => m.action === 'send_private_msg')) await sleep(150);
  const sent = received.find((m) => m.action === 'send_private_msg');
  assert.ok(sent, '没有收到 send_private_msg; log=' + out.slice(-1500));
  assert.equal(sent.params.user_id, '2');
  const text = Array.isArray(sent.params.message) ? sent.params.message.map((p) => p.data?.text || '').join('') : String(sent.params.message);
  assert.ok(text.includes('WS 回合回复'), '回复内容不对: ' + text);
  console.log('legacy-onebot: ok');
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise((r) => child.once('exit', r)), sleep(3000)]);
  child.kill('SIGKILL');
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}