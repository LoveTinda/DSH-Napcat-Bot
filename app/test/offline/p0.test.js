import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import { validatePolicy, decidePolicy, maskChatKey, normalizePolicy } from '../../src/policy.js';
import { ensureTokenFile, safeEqual } from '../../src/auth.js';
import { OneBot } from '../../src/onebot.js';
import { Bridge } from '../../src/bridge.js';
import { StatusBoard } from '../../src/state.js';
import { startAdminServer } from '../../src/admin.js';
import { startPanel } from '../../src/panel.js';
import { sessionDirFor, readSessionInfo, sessionExists } from '../../src/session-info.js';
import { validateSessionForResume } from '../../src/session-meta.js';

function tmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}

async function waitListening(server) {
  if (server.listening) return;
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}

function bridgeFor(overrides = {}) {
function bridgeFor(overrides = {}) {
  const dir = tmp('p0-bridge');
  const stateDir = path.join(dir, 'state');
  const ws = path.join(dir, 'workspace');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  const status = new StatusBoard(path.join(stateDir, 'status.json'));
  const cfg = {
    onebot: { mode: 'forward-ws', url: 'ws://127.0.0.1:1' },
    dsh: { command: 'dsh', profile: 'headless', transport: 'headless', maxConcurrent: 1 },
    policy: { privateChat: 'allowlist', groupChat: 'deny', allowUsers: ['20002'], allowGroups: [] },
    behavior: {
      humanize: { enabled: false },
      ackAfterMs: 0,
      maxReplyChars: 4000,
      downloadImages: false,
      sessionResumeRetryMs: [1, 1],
      outboundFailThreshold: 5
    },
    ...overrides
  };
  const b = new Bridge(cfg, { workspace: ws, stateDir, stateFile: path.join(stateDir, 'sessions.json') }, status);
  b.interactions = null;
  return { b, dir, stateDir, ws, status, cfg };
}

test('policy: 空白私聊白名单拒绝启动', () => {
  const r = validatePolicy({ privateChat: 'allowlist', allowUsers: [] });
  assert.equal(r.ok, false);
  assert.match(r.errors.join('\n'), /allowUsers/);
});

test('policy: allowAllUsers 必须显式并产生告警', () => {
  const r = validatePolicy({ privateChat: 'allowlist', allowUsers: [], allowAllUsers: true });
  assert.equal(r.ok, true);
  assert.ok(r.warnings.some((w) => /allowAllUsers/.test(w)));
});

test('policy: 空白群名单不是开放，而是全拒', () => {
  const p = normalizePolicy({ privateChat: 'allowlist', allowUsers: ['1'], groupChat: 'mention', allowGroups: [] });
  const d = decidePolicy(p, { isGroup: true, userId: '1', groupId: '30003', mentioned: true });
  assert.equal(d.ok, false);
  assert.equal(d.why, 'group-not-allowed');
});

test('policy: 白名单内私聊通过，白名单外拒绝；号码脱敏', () => {
  const p = normalizePolicy({ privateChat: 'allowlist', allowUsers: ['20002'] });
  assert.equal(decidePolicy(p, { isGroup: false, userId: '20002' }).ok, true);
  assert.equal(decidePolicy(p, { isGroup: false, userId: '99999' }).why, 'user-not-allowed');
  assert.equal(maskChatKey('private:20002'), 'private:2***2');
  assert.ok(!maskChatKey('private:20002').includes('000'));
});

test('auth: token 文件 0600，常数时间比较', () => {
  const dir = tmp('p0-auth');
  const file = path.join(dir, 'admin.token');
  const token = ensureTokenFile(file);
  assert.ok(token.length > 20);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(safeEqual(token, token), true);
  assert.equal(safeEqual(token, token + 'x'), false);
  assert.equal(safeEqual('', ''), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('onebot: 字符串也被包成 text 段，CQ 字面量不再作为 string message', async () => {
  const ob = new OneBot({ mode: 'http', url: 'http://127.0.0.1:1' });
  let captured = null;
  ob.call = async (action, params) => { captured = { action, params }; return {}; };
  await ob.sendPrivate('20002', '[CQ:at,qq=all]');
  assert.equal(captured.action, 'send_private_msg');
  assert.deepEqual(captured.params.message, [{ type: 'text', data: { text: '[CQ:at,qq=all]' } }]);
  const segs = [{ type: 'text', data: { text: '原样' } }];
  await ob.sendGroup('30003', segs);
  assert.deepEqual(captured.params.message, segs);
});

test('session-info: 只接受 preset 为空、同 cwd、非 subagent/fork 的会话', () => {
  const oldHome = process.env.DSH_HOME;
  const home = tmp('p0-dsh');
// [MISSING LINE 121]
// [MISSING LINE 122]
// [MISSING LINE 123]
// [MISSING LINE 124]
// [MISSING LINE 125]
// [MISSING LINE 126]
// [MISSING LINE 127]
// [MISSING LINE 128]
// [MISSING LINE 129]
// [MISSING LINE 130]
// [MISSING LINE 131]
// [MISSING LINE 132]
// [MISSING LINE 133]
// [MISSING LINE 134]
// [MISSING LINE 135]
// [MISSING LINE 136]
// [MISSING LINE 137]
// [MISSING LINE 138]
// [MISSING LINE 139]
// [MISSING LINE 140]
// [MISSING LINE 141]
// [MISSING LINE 142]
// [MISSING LINE 143]
// [MISSING LINE 144]
// [MISSING LINE 145]
// [MISSING LINE 146]
// [MISSING LINE 147]
// [MISSING LINE 148]
// [MISSING LINE 149]
  assert.match(readSessionInfo('session-preset', ws).reason, /agentPreset/);
  assert.match(readSessionInfo('session-sub', ws).reason, /subagent|fork/);
  assert.match(readSessionInfo('session-wrong', ws).reason, /不一致/);
  assert.match(readSessionInfo('session-nocache', ws).reason, /元数据/);
  assert.equal(sessionExists('session-ok', ws), true);
  assert.equal(sessionExists('session-missing', ws), false);

  process.env.DSH_HOME = oldHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test('P0-01: 启动不再 probe，dsh-api 不再建会话/注册工作区', () => {
  const index = fs.readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
  const dshApi = fs.readFileSync(new URL('../../src/dsh-api.js', import.meta.url), 'utf8');
  assert.ok(!/probeDshApi/.test(index));
  assert.ok(!/createSession|ensureWorkspace|probeCompatibility/.test(dshApi));
});

test('bridge: 出站是段数组；失败落 outbox，重启后可补发', async () => {
  const { b, stateDir } = bridgeFor();
  const sent = [];
  b.onebot = { online: true, selfId: '10001', sendTo: async (target, segs) => { sent.push({ target, segs }); return { message_id: 7 }; } };
  await b.push({ kind: 'private', id: '20002' }, '字面 [CQ:image,file=x]');
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].segs, [{ type: 'text', data: { text: '字面 [CQ:image,file=x]' } }]);
  assert.equal(b.outboxEntries.length, 0);

  b.onebot = { online: true, selfId: '10001', sendTo: async () => { throw new Error('network down'); } };
  await assert.rejects(
    () => b.push({ kind: 'private', id: '20002' }, '第二句'),
    (err) => err.code === 'DELIVERY_FAILED' && err.partial.total === 1
  );
  assert.equal(b.outboxEntries.length, 1);
  assert.ok(fs.existsSync(path.join(stateDir, 'outbox.json')));

  // 模拟重启：同一 stateDir 新建 Bridge，online 后补发。
  const status2 = new StatusBoard(path.join(stateDir, 'status2.json'));
  const b2 = new Bridge(b.config, { workspace: b.paths.workspace, stateDir, stateFile: path.join(stateDir, 'sessions2.json') }, status2);
  b2.interactions = null;
  let retried = 0;
  b2.onebot = { online: true, selfId: '10001', sendTo: async () => { retried += 1; return { message_id: 8 }; } };
  const r = await b2.retryOutbox();
  assert.equal(retried, 1);
  assert.equal(r.sent, 1);
  assert.equal(b2.outboxEntries.length, 0);
});

test('bridge: 多段部分失败中止剩余段，熔断不按单段累加', async () => {
  const { b } = bridgeFor({ behavior: {
    humanize: { enabled: false }, ackAfterMs: 0, maxReplyChars: 5,
    downloadImages: false, sessionResumeRetryMs: [1, 1], outboundFailThreshold: 2
  } });
  let calls = 0;
  b.onebot = {
    online: true, selfId: '10001',
    sendTo: async () => {
      calls += 1;
      if (calls === 2) throw new Error('second segment failed');
      return { message_id: calls };
    }
  };
  await assert.rejects(
    () => b.push({ kind: 'private', id: '20002' }, 'abcdefghij'),
    (err) => err.code === 'DELIVERY_FAILED' && err.partial.sent === 1 && err.partial.total >= 2
  );
  assert.equal(calls, 2);
  assert.ok(b.outboxEntries.length >= 1);
  assert.equal(b.outFailStreak, 1);
  assert.equal(b.status.isSuspended(), false);
});

test('bridge: ack 使用 io.deliver，不再读不存在的 inbound.deliver', async () => {
  const { b, ws } = bridgeFor({ behavior: {
    humanize: { enabled: false }, ackAfterMs: 20, ackText: '收到', maxReplyChars: 4000,
    downloadImages: false, sessionResumeRetryMs: [1, 1], outboundFailThreshold: 5
  } });
  b.invokeDsh = async () => { await sleep(80); return { sessionId: 'session-ack', text: '答案', ms: 80 }; };
  const delivered = [];
  const chatKey = 'private:20002';
  const ticket = b.beginTurn(chatKey);
  try {
    const r = await b.runTurn({
      chat: b.chat(chatKey), chatKey,
      inbound: { kind: 'private', id: '20002', text: '你好' },
      say: async (t) => { delivered.push(t); },
      io: { deliver: async (t) => { delivered.push(t); } },
      interrupted: null, ticket
    });
    assert.equal(r.error, undefined);
  } finally {
    b.endTurn(ticket);
  }
  assert.deepEqual(delivered, ['收到', '答案']);
  assert.equal(b.chat(chatKey).sessions[ws].turns, 1);
});

test('bridge: 分叉保留旧会话、落 lastFork、turns 从 0 重新计', async () => {
  const oldHome = process.env.DSH_HOME;
  const { b, ws } = bridgeFor();
  const home = tmp('p0-fork-home');
  process.env.DSH_HOME = home;
  const chatKey = 'private:20002';
  const chat = b.chat(chatKey);
  chat.sessions[ws] = { sessionId: 'session-old', turns: 5 };
  fs.mkdirSync(path.join(sessionDirFor(ws), 'session-old'), { recursive: true });

  b.invokeDsh = async ({ sessionId }) => {
    if (sessionId === 'session-old') {
      throw new Error('session "session-old" is already owned by an active write handle');
    }
    return { sessionId: 'session-new', text: '新答案', ms: 5 };
  };
  const delivered = [];
  const ticket = b.beginTurn(chatKey);
  try {
    const r = await b.runTurn({
      chat, chatKey,
      inbound: { kind: 'private', id: '20002', text: '在吗' },
      say: async (t) => { delivered.push(t); },
      io: { deliver: async (t) => { delivered.push(t); } },
      interrupted: null, ticket
    });
    assert.equal(r.error, undefined);
  } finally {
    b.endTurn(ticket);
  }
  assert.equal(chat.lastFork.from, 'session-old');
  assert.equal(chat.lastFork.to, 'session-new');
  assert.equal(chat.lastFork.recoverable, true);
  assert.equal(chat.sessions[ws].sessionId, 'session-new');
  assert.equal(chat.sessions[ws].turns, 1);
  assert.equal(fs.existsSync(path.join(sessionDirFor(ws), 'session-old')), true);
  assert.ok(delivered.some((x) => x.includes('/ws session-old')));
  assert.ok(delivered.some((x) => x.includes('旧会话没有被删除')));
  process.env.DSH_HOME = oldHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test('session-meta: /ws 的 preset/subagent/running/cwd 四道门', () => {
  const ws = '/tmp/ws';
  const base = { id: 'session-x', dir: '/tmp/ws/session-x', cwd: ws, running: false, preset: null, origin: 'user', parentSession: null, reason: null };
  assert.equal(validateSessionForResume(base, { workspace: ws }).ok, true);
  assert.match(validateSessionForResume({ ...base, preset: 'standard' }, { workspace: ws }).reason, /preset/);
  assert.match(validateSessionForResume({ ...base, origin: 'subagent' }, { workspace: ws }).reason, /subagent|fork/);
  assert.match(validateSessionForResume({ ...base, parentSession: 'session-parent' }, { workspace: ws }).reason, /subagent|fork/);
  assert.match(validateSessionForResume({ ...base, running: true }, { workspace: ws }).reason, /运行/);
  assert.match(validateSessionForResume({ ...base, cwd: '/tmp/other' }, { workspace: ws }).reason, /工作区|目录|不一致/);
});

test('bridge: /ws 绑定保留已知 turns，未知会话显示 null 而不是 0', () => {
  const { b, ws } = bridgeFor();
  const chatKey = 'private:20002';
  const c = b.chat(chatKey);
  c.sessionTurns = { 'session-known': 4 };
  const known = b.bindChatContext(chatKey, { workspace: ws, sessionId: 'session-known' });
  assert.equal(known.turns, 4);
  assert.equal(c.sessions[ws].turns, 4);
  const unknown = b.bindChatContext(chatKey, { workspace: ws, sessionId: 'session-unknown' });
  assert.equal(unknown.turns, null);
  assert.equal(c.sessions[ws].turns, null);
  const fresh = b.bindChatContext(chatKey, { workspace: ws, sessionId: null, turns: 0 });
  assert.equal(fresh.turns, 0);
});

test('bridge: 投递失败不增加 turns，并返回 error', async () => {
  const { b, ws } = bridgeFor();
  b.invokeDsh = async () => ({ sessionId: 'session-delivery', text: '答案', ms: 1 });
  const chatKey = 'private:20002';
  const chat = b.chat(chatKey);
  const ticket = b.beginTurn(chatKey);
// [MISSING LINE 320]
// [MISSING LINE 321]
// [MISSING LINE 322]
// [MISSING LINE 323]
// [MISSING LINE 324]
// [MISSING LINE 325]
// [MISSING LINE 326]
// [MISSING LINE 327]
// [MISSING LINE 328]
// [MISSING LINE 329]
    });
    assert.equal(r.error, undefined);
  } finally {
    b.endTurn(ticket);
  }
  assert.equal(chat.lastFork.from, 'session-old');
  assert.equal(chat.lastFork.to, 'session-new');
  assert.equal(chat.lastFork.recoverable, true);
  assert.equal(chat.sessions[ws].sessionId, 'session-new');
  assert.equal(chat.sessions[ws].turns, 1);
  assert.equal(fs.existsSync(path.join(sessionDirFor(ws), 'session-old')), true);
  assert.ok(delivered.some((x) => x.includes('/ws session-old')));
  assert.ok(delivered.some((x) => x.includes('旧会话没有被删除')));
  process.env.DSH_HOME = oldHome;
  fs.rmSync(home, { recursive: true, force: true });
});

test('session-meta: /ws 的 preset/subagent/running/cwd 四道门', () => {
  const ws = '/tmp/ws';
  const base = { id: 'session-x', dir: '/tmp/ws/session-x', cwd: ws, running: false, preset: null, origin: 'user', parentSession: null, reason: null };
  assert.equal(validateSessionForResume(base, { workspace: ws }).ok, true);
  assert.match(validateSessionForResume({ ...base, preset: 'standard' }, { workspace: ws }).reason, /preset/);
  assert.match(validateSessionForResume({ ...base, origin: 'subagent' }, { workspace: ws }).reason, /subagent|fork/);
  assert.match(validateSessionForResume({ ...base, parentSession: 'session-parent' }, { workspace: ws }).reason, /subagent|fork/);
  assert.match(validateSessionForResume({ ...base, running: true }, { workspace: ws }).reason, /运行/);
  assert.match(validateSessionForResume({ ...base, cwd: '/tmp/other' }, { workspace: ws }).reason, /工作区|目录|不一致/);
});

test('bridge: /ws 绑定保留已知 turns，未知会话显示 null 而不是 0', () => {
  const { b, ws } = bridgeFor();
  const chatKey = 'private:20002';
  const c = b.chat(chatKey);
  c.sessionTurns = { 'session-known': 4 };
  const known = b.bindChatContext(chatKey, { workspace: ws, sessionId: 'session-known' });
  assert.equal(known.turns, 4);
  assert.equal(c.sessions[ws].turns, 4);
  const unknown = b.bindChatContext(chatKey, { workspace: ws, sessionId: 'session-unknown' });
  assert.equal(unknown.turns, null);
  assert.equal(c.sessions[ws].turns, null);
  const fresh = b.bindChatContext(chatKey, { workspace: ws, sessionId: null, turns: 0 });
  assert.equal(fresh.turns, 0);
});

test('bridge: 投递失败不增加 turns，并返回 error', async () => {
  const { b, ws } = bridgeFor();
  b.invokeDsh = async () => ({ sessionId: 'session-delivery', text: '答案', ms: 1 });
  const chatKey = 'private:20002';
  const chat = b.chat(chatKey);
  const ticket = b.beginTurn(chatKey);
  let r;
  try {
    r = await b.runTurn({
      chat, chatKey,
      inbound: { kind: 'private', id: '20002', text: '你好' },
      say: async () => { const e = new Error('send failed'); e.code = 'DELIVERY_FAILED'; throw e; },
      io: { deliver: async () => {} },
      interrupted: null, ticket
    });
  } finally {
    b.endTurn(ticket);
// [MISSING LINE 390]
// [MISSING LINE 391]
// [MISSING LINE 392]
// [MISSING LINE 393]
// [MISSING LINE 394]
// [MISSING LINE 395]
// [MISSING LINE 396]
// [MISSING LINE 397]
// [MISSING LINE 398]
// [MISSING LINE 399]
// [MISSING LINE 400]
// [MISSING LINE 401]
// [MISSING LINE 402]
// [MISSING LINE 403]
// [MISSING LINE 404]
// [MISSING LINE 405]
// [MISSING LINE 406]
// [MISSING LINE 407]
// [MISSING LINE 408]
// [MISSING LINE 409]
// [MISSING LINE 410]
// [MISSING LINE 411]
// [MISSING LINE 412]
// [MISSING LINE 413]
// [MISSING LINE 414]
// [MISSING LINE 415]
// [MISSING LINE 416]
// [MISSING LINE 417]
// [MISSING LINE 418]
// [MISSING LINE 419]
// [MISSING LINE 420]
// [MISSING LINE 421]
// [MISSING LINE 422]
// [MISSING LINE 423]
// [MISSING LINE 424]
// [MISSING LINE 425]
// [MISSING LINE 426]
// [MISSING LINE 427]
// [MISSING LINE 428]
// [MISSING LINE 429]
// [MISSING LINE 430]
// [MISSING LINE 431]
// [MISSING LINE 432]
// [MISSING LINE 433]
// [MISSING LINE 434]
// [MISSING LINE 435]
// [MISSING LINE 436]
// [MISSING LINE 437]
// [MISSING LINE 438]
// [MISSING LINE 439]
  res = await fetch(base + '/inject', { method: 'POST', headers: { authorization: 'Bearer admin-secret', 'content-type': 'text/plain' }, body: '{}' });
  assert.equal(res.status, 415);
  res = await fetch(base + '/inject', { method: 'POST', headers: { ...AUTH, origin: 'http://evil.example' }, body: JSON.stringify({ text: 'hi' }) });
  assert.equal(res.status, 403);
  res = await fetch(base + '/inject', { method: 'POST', headers: AUTH, body: JSON.stringify({ text: 'hi' }) });
  assert.equal(res.status, 200);
  res = await fetch(base + '/inject', { method: 'POST', headers: AUTH, body: JSON.stringify({ text: 'fail' }) });
  assert.equal(res.status, 500);
  res = await fetch(base + '/command', { method: 'POST', headers: AUTH, body: JSON.stringify({ text: 'status' }) });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 2); // 非 / 开头没有进入 inject
  res = await fetch(base + '/command', { method: 'POST', headers: AUTH, body: JSON.stringify({ text: '/status' }) });
  assert.equal(res.status, 200);
  assert.equal(calls[2].forceCommand, true);
  res = await fetch(base + '/api', { method: 'POST', headers: AUTH, body: JSON.stringify({ action: 'get_status' }) });
  assert.equal(res.status, 200);
  assert.ok(audit.length >= 3);
  assert.ok(audit.every((a) => !JSON.stringify(a).includes('hi')));
  assert.ok(audit.some((a) => a.action === 'inject' && a.target.includes('***')));
  await new Promise((r) => server.close(r));
});

test('panel: 写入口默认关闭；开启后 token/Origin/Content-Type 全部独立校验', async () => {
  const portOff = await freePort();
  const baseOff = 'http://127.0.0.1:' + portOff;
  const off = startPanel({
    host: '127.0.0.1', port: portOff, token: 'p', writeEnabled: false,
    allowedHosts: ['127.0.0.1:' + portOff]
  }, {
    title: 't', status: () => ({ state: 'idle' }), bootstrap: () => ({ status: { state: 'idle' }, events: [] }),
    subscribe: () => () => {}, callOneBot: async () => ({})
  });
  await waitListening(off.server);
  let res = await fetch(baseOff + '/api/onebot', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer p' },
    body: JSON.stringify({ action: 'get_status' })
  });
  assert.equal(res.status, 403);
  off.close();

  const port = await freePort();
  const base = 'http://127.0.0.1:' + port;
  const audit = [];
  let called = 0;
  const panel = startPanel({
    host: '127.0.0.1', port, token: 'panel-secret', writeEnabled: true,
    allowedHosts: ['127.0.0.1:' + port],
    allowedOrigins: ['http://127.0.0.1:' + port]
  }, {
    title: 't', status: () => ({ state: 'idle' }), bootstrap: () => ({ status: { state: 'idle' }, events: [] }),
    subscribe: () => () => {},
    callOneBot: async () => { called += 1; return { ok: 1 }; },
    audit: (e) => audit.push(e)
  });
  await waitListening(panel.server);
  const H = { 'content-type': 'application/json' };
  res = await fetch(base + '/api/onebot', { method: 'POST', headers: H, body: JSON.stringify({ action: 'get_status' }) });
  assert.equal(res.status, 401);
  res = await fetch(base + '/api/onebot?token=panel-secret', { method: 'POST', headers: H, body: JSON.stringify({ action: 'get_status' }) });
  assert.equal(res.status, 401);
  res = await fetch(base + '/api/onebot', { method: 'POST', headers: { 'content-type': 'text/plain', authorization: 'Bearer panel-secret' }, body: '{}' });
  assert.equal(res.status, 415);
  res = await fetch(base + '/api/onebot', { method: 'POST', headers: { ...H, authorization: 'Bearer panel-secret', origin: 'http://evil.example' }, body: JSON.stringify({ action: 'get_status' }) });
  assert.equal(res.status, 403);
  res = await fetch(base + '/api/onebot', { method: 'POST', headers: { ...H, authorization: 'Bearer panel-secret' }, body: JSON.stringify({ action: 'get_status' }) });
  assert.equal(res.status, 200);
  assert.equal(called, 1);
  assert.ok(audit.some((a) => a.target === 'panel'));
  panel.close();
});

test('dsh-api: 从 workspace 注册表按 realpath 找 workspaceId', () => {
  const old = process.env.DSH_HOME;
  const home = tmp('p0-ws-registry');
  const ws = path.join(home, 'ws');
  fs.mkdirSync(path.join(home, '.dsh', 'storages'), { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(home, '.dsh', 'storages', 'workspace.json'), JSON.stringify({
    tables: { workspaces: { 'ws-id-1': { id: 'ws-id-1', path: ws, sessionIds: [] } } }
  }));
  process.env.DSH_HOME = path.join(home, '.dsh');
  try {
