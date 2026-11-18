import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { JsonStore } from '../src/store.js';
import { ensureTokenFile, safeEqual, localHosts, hostAllowed } from '../src/auth.js';
import { createPersona } from '../src/persona.js';
import { parseActions, createInteractions } from '../src/interactions.js';
import { buildSessionZip } from '../src/export.js';
import { OneBot } from '../src/onebot.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-smoke-'));
try {
  const store = new JsonStore(path.join(dir, 'state.json'));
  store.set('chats', { a: 1 });
  assert.deepEqual(new JsonStore(path.join(dir, 'state.json')).get('chats'), { a: 1 });

  const tokenFile = path.join(dir, 'token');
  const token = ensureTokenFile(tokenFile);
  assert.equal(token.length, 48);
  assert.equal(ensureTokenFile(tokenFile), token);
  assert.equal(safeEqual(token, token), true);
  assert.equal(safeEqual(token, token + 'x'), false);
  const hosts = localHosts(6702);
  assert.equal(hostAllowed({ headers: { host: '127.0.0.1:6702' } }, hosts), true);
  assert.equal(hostAllowed({ headers: { host: 'evil.example' } }, hosts), false);

  const persona = createPersona({ enabled: false, hardLimit: 20 });
  assert.deepEqual(persona.hardSplit('x'.repeat(130), 60).length, 3);
  const sent = [];
  const r = await persona.deliverBurst('a\n\nb', async (p) => sent.push(p));
  assert.ok(r.parts >= 1 && sent.length === r.parts);

  const parsed = parseActions('hi [[react:赞]] [[recall]]');
  assert.deepEqual(parsed.actions.map((a) => a.kind), ['react', 'recall']);
  assert.equal(parsed.text, 'hi');
  const inter = createInteractions(null, { enabled: true });
  assert.equal(inter.describe().includes('启用'), true);
  await inter.noteInbound('private:1', { messageId: 1 });

  fs.writeFileSync(path.join(dir, 'session.jsonl'), '{"x":1}\n');
  const zip = buildSessionZip(dir);
  assert.ok(zip.buffer.length > 0 && zip.entries.length >= 1);

  const ob = new OneBot({ mode: 'forward-ws', url: 'ws://127.0.0.1:1' });
  assert.equal(ob.online, false);
  await assert.rejects(() => ob.call('get_login_info'), /不在线/);
  ob.stop();

  console.log('legacy-smoke: ok');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
