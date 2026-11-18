/**
 * End-to-end test: fake NapCat (OneBot 11 WS server) + bridge + real dsh.
 * Isolated: 临时 state、随机端口、panel 关闭，不写生产 state/。
 *
 *   node test/e2e.js
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createWsServer } from '../src/ws-server.js';
import { baseConfig, freePort, makeTempDir, rmrf, writeConfig } from './helpers.js';

const here = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BOT_QQ = '10001';
const USER_QQ = '20002';
const PROMPT = '请只回复四个字：桥接成功';
const TIMEOUT_MS = 300000;

const tmp = makeTempDir('napcat-e2e-');
const stateDir = path.join(tmp, 'state');
fs.mkdirSync(stateDir, { recursive: true });
const port = await freePort();
const cfgPath = writeConfig(tmp, 'config.e2e.json', baseConfig({
  onebotPort: port,
  stateDir,
  userId: USER_QQ
}));

const received = [];
let bridgeLog = '';

const server = createWsServer({ host: '127.0.0.1', port, authorize: () => true }, (socket) => {
  console.log('[mock] 桥接器已连入');
  socket.on('message', (text) => {
    let msg;
    try { msg = JSON.parse(text); } catch { return; }
    if (!msg.action) return;
    console.log('[mock] 收到 API 调用: ' + msg.action);
    received.push(msg);
    if (msg.action === 'send_private_msg' || msg.action === 'send_group_msg') {
      const m = msg.params.message;
      const plain = Array.isArray(m) ? m.map((s) => s.data && s.data.text || '').join('') : String(m);
      console.log('\n===== 机器人回复 =====\n' + plain + '\n======================\n');
    }
    socket.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 1 }, echo: msg.echo }));
  });

  setTimeout(() => {
    console.log('[mock] 注入私聊消息: ' + PROMPT);
