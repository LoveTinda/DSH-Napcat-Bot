import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const root = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const child = spawn(process.execPath, ['src/index.js', 'config.smoke.panel.json'], {
  cwd: root, stdio: ['ignore', 'pipe', 'pipe']
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
  throw new Error('timeout; log=' + out.slice(-1000));
}
try {
  const status = await waitFor(async () => {
    const r = await fetch('http://127.0.0.1:16701/status');
    assert.equal(r.status, 200);
    return r.json();
  });
  assert.ok(status.state);
  const page = await fetch('http://127.0.0.1:16702/');
  assert.equal(page.status, 200);
  assert.ok((await page.text()).includes('桥接器面板'));
  const token = fs.readFileSync(path.join(root, 'state/admin.token'), 'utf8').trim();
  const cmd = await fetch('http://127.0.0.1:16701/command', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ text: '/help' })
  });
  assert.equal(cmd.status, 200);
  const body = await cmd.json();
  assert.equal(body.ok, true);
  assert.ok(String(body.reply).includes('DSH'));
  console.log('legacy-http: ok');
} finally {
  child.kill('SIGTERM');
  await Promise.race([new Promise((r) => child.once('exit', r)), sleep(3000)]);
  child.kill('SIGKILL');
}
