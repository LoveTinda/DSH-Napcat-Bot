import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { once } from 'node:events';

import { createPersona } from '../src/persona.js';
import { parseActions } from '../src/interactions.js';
import { runBridgeCommand } from '../src/commands.js';
import { loadConfig, resolvePaths, ConfigError } from '../src/config.js';
import { normalizePolicy, commandRole, roleAtLeast } from '../src/policy.js';
import {
  sessionSlug, listLocalSessions, findSessionRef, validateSessionForResume
} from '../src/session-meta.js';
import { buildSessionZip } from '../src/export.js';
import { buildHealth } from '../src/health.js';
import { killChildTree } from '../src/dsh.js';
import { spawn } from 'node:child_process';
import { Bridge, isPrivateAddress } from '../src/bridge.js';
import { StatusBoard } from '../src/state.js';
import { startPanel } from '../src/panel.js';
import { startAdminServer } from '../src/admin.js';
import { baseConfig, freePort, makeTempDir, rmrf } from './helpers.js';

test('P1-02 persona: hardSplit 每段不超限、代码围栏完整、emoji 不切半', () => {
  const p = createPersona({ burst: { hardLimit: 4000 } }, { maxReplyChars: 4000 });
  for (const n of [4500, 10000]) {
    const text = '句子。'.repeat(Math.ceil(n / 3)).slice(0, n);
    const parts = p.hardSplit(text, 4000);
    assert.ok(parts.length >= 1);
    assert.ok(parts.every((x) => x.length <= 4000), 'part > 4000');
  }
  const lines = Array.from({ length: 600 }, (_, i) => 'line' + i + ' ' + 'x'.repeat(20)).join('\n');
  const code = '\`\`\`js\n' + lines + '\n\`\`\`';
  const codeParts = p.hardSplit(code, 1000);
  assert.ok(codeParts.length > 1);
  assert.ok(codeParts.every((x) => x.length <= 1000));
  assert.ok(codeParts.every((x) => x.startsWith('\`\`\`js') && x.endsWith('\`\`\`')), 'fence broken');
  const emoji = '👨‍👩‍👧‍👦'.repeat(3000);
  const emojiParts = p.hardSplit(emoji, 4000);
  assert.equal(emojiParts.join(''), emoji, 'emoji grapheme split');
  assert.ok(emojiParts.every((x) => x.length <= 4000));
});

test('P1-02 actions: 代码块内标记不执行、纯动作不发原文、最多 2 个', () => {
  const code = '\`\`\`js\nconst x = [[react:赞]];\n\`\`\`';
  const a = parseActions(code);
  assert.equal(a.actions.length, 0);
  assert.equal(a.text, code);
  const pure = parseActions('[[react:赞]]');
  assert.equal(pure.text, '');
  assert.equal(pure.actions.length, 1);
  const many = parseActions('[[react:赞]][[recall]][[poke]]正文');
  assert.equal(many.actions.length, 2);
  assert.equal(many.ignoredActions.length, 1);
  assert.equal(many.text, '正文');
});

test('P1-03 dsh: 超时/中断清理整个进程组，不留孙进程', async () => {
  if (process.platform === 'win32') return;
  const dir = makeTempDir('napcat-pg-');
  const pidFile = path.join(dir, 'grand.pid');
  const child = spawn('/bin/bash', ['-c', 'sleep 30 & echo $! > "$1"; wait', 'x', pidFile], {
    detached: true, stdio: 'ignore'
  });
  try {
    for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await new Promise((r) => setTimeout(r, 20));
    assert.ok(fs.existsSync(pidFile));
    const grand = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(grand > 0);
    killChildTree(child, 'SIGKILL');
    await once(child, 'exit');
    let alive = true;
    for (let i = 0; i < 20; i++) {
      try { process.kill(grand, 0); await new Promise((r) => setTimeout(r, 20)); }
      catch { alive = false; break; }
    }
    assert.equal(alive, false, 'grandchild survived process-group kill');
  } finally {
    try { killChildTree(child, 'SIGKILL'); } catch {}
    rmrf(dir);
  }
});

test('P1-21 commands: 普通 user 不能 /sessions /ws /model', async () => {
  const replies = [];
  const ctx = { role: 'user', reply: async (t) => replies.push(t), bridge: {}, chat: {}, chatKey: 'private:2***2' };
  await runBridgeCommand(ctx, 'sessions', '');
  await runBridgeCommand(ctx, 'ws', 'abc');
  await runBridgeCommand(ctx, 'model', 'flash');
  assert.equal(replies.length, 3);
  assert.ok(replies.every((t) => /没有权限/.test(t)));
});

test('P1-21 policy: owner/admin 分级，不再所有白名单用户都是管理员', () => {
  const p = normalizePolicy({
    privateChat: 'allowlist', groupChat: 'deny',
    allowUsers: ['10001', '10002', '10003'], allowAllUsers: false, allowAllGroups: false
  });
  assert.deepEqual(p.ownerUsers, ['10001']);
  assert.deepEqual(p.adminUsers, ['10002', '10003']);
  assert.equal(commandRole(p, { userId: '10001' }), 'owner');
  assert.equal(commandRole(p, { userId: '10002' }), 'admin');
  assert.equal(commandRole(p, { userId: '19999' }), 'none');
  assert.equal(roleAtLeast('admin', 'admin'), true);
  assert.equal(roleAtLeast('user', 'admin'), false);
  assert.equal(commandRole(p, { userId: '19999', adminBypass: true }), 'owner');
});

test('P1-04 config: 缺文件/headless fail fast；stateDir 可注入', () => {
  const root = makeTempDir('napcat-config-');
  try {
    assert.throws(() => loadConfig({ argv: ['node', 'x'], env: {}, root }),
      (e) => e instanceof ConfigError && e.code === 'config/missing');
    const cfg = baseConfig({ onebotPort: 12345, stateDir: path.join(root, 'state') });
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(cfg));
    const loaded = loadConfig({ argv: ['node', 'x'], env: {}, root });
    assert.equal(loaded.config.dsh.profile, 'qq');
    const paths = resolvePaths(loaded.config, { root, env: { BRIDGE_STATE_DIR: 'tmp-state' } });
    assert.equal(paths.stateDir, path.join(root, 'tmp-state'));

    const headless = JSON.parse(JSON.stringify(cfg));
    headless.dsh.profile = 'headless';
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify(headless));
    assert.throws(() => loadConfig({ argv: ['node', 'x'], env: {}, root }),
      (e) => e instanceof ConfigError && e.code === 'config/profile');
  } finally { rmrf(root); }
});

test('P1-01 session-meta: 只列同 cwd 会话；preset/subagent/running 拒绝', () => {
  const home = makeTempDir('napcat-dsh-home-');
  const ws = path.join(home, 'ws');
  fs.mkdirSync(ws, { recursive: true });
  const env = { DSH_HOME: path.join(home, '.dsh'), HOME: home };
  const slug = sessionSlug(ws);
  const wsDir = path.join(env.DSH_HOME, 'sessions', slug);
  const mk = (id, header, extra = '') => {
    const dir = path.join(wsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl'),
      JSON.stringify({ type: 'session', version: 4, id, cwd: ws, isSeeded: false, ...header }) + '\n' + extra);
    return dir;
  };
  try {
    const good = 'session-11111111-1111-4111-8111-111111111111';
    const preset = 'session-22222222-2222-4222-8222-222222222222';
    const sub = 'session-33333333-3333-4333-8333-333333333333';
    mk(good, {});
    mk(preset, { agentPreset: 'standard' });
    mk(sub, { origin: 'subagent' });
    // 别的 cwd 不应混进来
    const otherDir = path.join(env.DSH_HOME, 'sessions', '--tmp-other--', 'session-44444444-4444-4444-8444-444444444444');
    fs.mkdirSync(otherDir, { recursive: true });
    fs.writeFileSync(path.join(otherDir, 'session.v4.jsonl'),
      JSON.stringify({ type: 'session', version: 4, id: 'session-44444444-4444-4444-8444-444444444444', cwd: '/tmp/other', isSeeded: false }) + '\n');

    const entries = listLocalSessions(ws, { env, runningIds: new Set([good]) });
    assert.equal(entries.length, 3);
    const g = entries.find((e) => e.id === good);
    assert.ok(g);
    assert.equal(g.running, true);
    assert.equal(validateSessionForResume(g, { workspace: ws }).ok, false, 'running must reject');
    const p = entries.find((e) => e.id === preset);
    assert.equal(p.resumable, false);
    assert.match(validateSessionForResume(p, { workspace: ws }).reason, /preset/);
    const s = entries.find((e) => e.id === sub);
    assert.equal(s.resumable, false);
    const hit = findSessionRef(entries, good.slice(0, 20));
    assert.equal(hit.entry.id, good);
  } finally { rmrf(home); }
});

test('P1-05 export: 生成可解压 ZIP，且过大时明确失败', () => {
  const dir = makeTempDir('napcat-export-');
  try {
    const id = 'session-55555555-5555-4555-8555-555555555555';
    fs.writeFileSync(path.join(dir, 'session.v4.jsonl'),
      JSON.stringify({ type: 'session', version: 4, id, cwd: '/tmp', isSeeded: false, createdAt: Date.now() }) + '\n' +
      JSON.stringify({ type: 'user/message', text: 'hi' }) + '\n');
    const zip = buildSessionZip(dir, { maxBytes: 1024 * 1024 });
// [MISSING LINE 181]
// [MISSING LINE 182]
// [MISSING LINE 183]
// [MISSING LINE 184]
// [MISSING LINE 185]
// [MISSING LINE 186]
// [MISSING LINE 187]
// [MISSING LINE 188]
// [MISSING LINE 189]
// [MISSING LINE 190]
// [MISSING LINE 191]
// [MISSING LINE 192]
// [MISSING LINE 193]
// [MISSING LINE 194]
// [MISSING LINE 195]
// [MISSING LINE 196]
// [MISSING LINE 197]
// [MISSING LINE 198]
// [MISSING LINE 199]
// [MISSING LINE 200]
// [MISSING LINE 201]
// [MISSING LINE 202]
// [MISSING LINE 203]
// [MISSING LINE 204]
// [MISSING LINE 205]
// [MISSING LINE 206]
// [MISSING LINE 207]
// [MISSING LINE 208]
// [MISSING LINE 209]
// [MISSING LINE 210]
// [MISSING LINE 211]
// [MISSING LINE 212]
// [MISSING LINE 213]
// [MISSING LINE 214]
// [MISSING LINE 215]
// [MISSING LINE 216]
// [MISSING LINE 217]
// [MISSING LINE 218]
// [MISSING LINE 219]
// [MISSING LINE 220]
// [MISSING LINE 221]
// [MISSING LINE 222]
// [MISSING LINE 223]
// [MISSING LINE 224]
// [MISSING LINE 225]
// [MISSING LINE 226]
// [MISSING LINE 227]
// [MISSING LINE 228]
// [MISSING LINE 229]
// [MISSING LINE 230]
// [MISSING LINE 231]
// [MISSING LINE 232]
// [MISSING LINE 233]
// [MISSING LINE 234]
// [MISSING LINE 235]
// [MISSING LINE 236]
// [MISSING LINE 237]
// [MISSING LINE 238]
// [MISSING LINE 239]
// [MISSING LINE 240]
// [MISSING LINE 241]
// [MISSING LINE 242]
// [MISSING LINE 243]
// [MISSING LINE 244]
// [MISSING LINE 245]
// [MISSING LINE 246]
// [MISSING LINE 247]
// [MISSING LINE 248]
// [MISSING LINE 249]

test('P1-06 group: @ 提问者用消息段，永不 @全体；引用机器人可确认 self', async () => {
  const root = makeTempDir('napcat-group-');
  try {
    const stateDir = path.join(root, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    const cfg = baseConfig({ onebotPort: 1, stateDir, userId: '20002' });
    const status = new StatusBoard(path.join(stateDir, 'status.json'));
    const bridge = new Bridge(cfg, {
      workspace: root, stateDir, stateFile: path.join(stateDir, 'sessions.json')
    }, status);
    const sent = [];
    bridge.onebot = {
      online: true, selfId: '10001',
      sendTo: async (target, segs) => { sent.push(segs); return { message_id: 1 }; },
      call: async () => ({
        message: [{ type: 'text', data: { text: 'bot reply' } }],
        sender: { user_id: 10001, nickname: 'bot' }
      })
    };
    await bridge.push({ kind: 'group', id: '30003' }, 'hi', { atUserId: '20002' });
    await bridge.push({ kind: 'group', id: '30003' }, 'all', { atUserId: 'all' });
    assert.deepEqual(sent[0][0], { type: 'at', data: { qq: '20002' } });
    assert.equal(sent[0][1].data.text, 'hi');
    assert.equal(sent[1].some((s) => s.type === 'at'), false);
    const reply = await bridge.fetchReplyContext('m1');
    assert.equal(reply.ok, true);
    assert.equal(reply.isSelf, true);
  } finally { rmrf(root); }
});

test('P1-07 panel: 44px/aria/复制 id/仅本页；端口占用不返回可用 URL', async () => {
  const port = await freePort();
  const handlers = {
    title: 't', status: () => ({ state: 'idle' }), bootstrap: () => ({ status: { state: 'idle' }, events: [] }),
    subscribe: () => () => {}, callOneBot: async () => ({})
  };
  const panel = startPanel({ host: '127.0.0.1', port, token: 'x', writeEnabled: false }, handlers);
  const second = startPanel({ host: '127.0.0.1', port, token: 'x' }, handlers);
  try {
    await panel.ready;
    assert.ok(panel.url);
    const html = await (await fetch(panel.url)).text();
    assert.match(html, /\/panel\.css/);
    assert.match(html, /data-page="home"/);
    assert.match(html, /aria-label="主导航"/);
    assert.match(html, /href="\/config"/);
    assert.match(html, /href="\/logs"/);
    assert.match(html, /href="\/status"/);
    assert.doesNotMatch(html, /font-size:11px/);

    const css = await (await fetch(new URL('/panel.css', panel.url))).text();
    assert.match(css, /width:44px/);
    assert.match(css, /\.dot\.live/);

    for (const route of ['/config', '/logs', '/status']) {
      const page = await (await fetch(new URL(route, panel.url))).text();
      assert.match(page, new RegExp('data-page="' + route.slice(1) + '"'));
    }

    await assert.rejects(second.ready);
    assert.equal(second.url, null);
    assert.match(second.error, /占用/);
  } finally {
    panel.close();
    second.close();
  }
});

test('P1-04 admin: /health 关键项失败返回 503', async () => {
  );
  await once(server, 'listening');
  try {
    let res = await fetch('http://127.0.0.1:' + port + '/health');
    assert.equal(res.status, 503);
    healthy = true;
    res = await fetch('http://127.0.0.1:' + port + '/health');
    assert.equal(res.status, 200);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('P1-22 session-meta: API 模式下 preset/running 可续，subagent/fork 仍拒绝', () => {
  const ws = '/tmp/ws';
  const base = { id: 'session-x', dir: null, cwd: ws, running: false, preset: null, origin: 'user', parentSession: null, headerError: null };
  assert.equal(validateSessionForResume({ ...base, preset: 'standard' }, { workspace: ws }).ok, false);
  const api = validateSessionForResume({ ...base, preset: 'standard', running: true }, { workspace: ws, apiMode: true });
  assert.equal(api.ok, true);
  assert.ok(api.warnings.length >= 1);
  assert.equal(validateSessionForResume({ ...base, origin: 'subagent' }, { workspace: ws, apiMode: true }).ok, false);
  assert.equal(validateSessionForResume({ ...base, parentSession: 'p' }, { workspace: ws, apiMode: true }).ok, false);
});

test('P1-22 commands: /help <命令> 有用法；/sessions 编号后 /ws 2 可切换', async () => {
  const replies = [];
  const entries = [
    { id: 'session-aaaa1111', cwd: '/w', resumable: true, running: false, updatedAt: Date.now(), title: '甲' },
    { id: 'session-bbbb2222', cwd: '/w', resumable: true, running: false, updatedAt: Date.now() - 1, title: '乙' }
  ];
  const chat = { workspace: '/w', sessions: { '/w': { sessionId: null, turns: 0 } } };
  let bound = null;
  const bridge = {
    sessionIndex: new Map(), transportMode: 'api', ensureTransport: async () => 'api',
    transportLabel: () => 'api', sessionCatalog: async () => entries,
    isChatBusy: () => false, recordSessionTurns: () => {},
    bindChatContext: (key, target) => {
      bound = target;
      chat.sessions[target.workspace] = { sessionId: target.sessionId, turns: target.turns ?? null };
      return target;
    }
  };
  const ctx = { bridge, chat, chatKey: 'private:t', role: 'owner', reply: async (t) => replies.push(t), dshCommands: null };
  await runBridgeCommand(ctx, 'help', 'ws');
  assert.match(replies.at(-1), /用法：\/ws \[编号\|会话 id\|路径\]/);
  assert.match(replies.at(-1), /\/ws 3/);
  await runBridgeCommand(ctx, 'sessions', '');
  assert.match(replies.at(-1), /#1\s+aaaa1111/);
  assert.match(replies.at(-1), /《甲》/);
  await runBridgeCommand(ctx, 'ws', '2');
  assert.equal(bound.sessionId, 'session-bbbb2222');
  assert.match(replies.at(-1), /乙/);
});

test('P1-22 bridge: 交互提示每个会话只拼一次', () => {
  const b = new Bridge(baseConfig({ onebotPort: 1, stateDir: makeTempDir('hint-') }), {
    workspace: '/tmp/w', stateDir: '/tmp/hint-state', stateFile: '/tmp/hint-state/sessions.json'
  }, new StatusBoard('/tmp/hint-state/status.json'));
  b.interactionHint = 'HINT-ONCE';
  const chat = { hintSessions: {} };
  const one = b.withSessionHint(chat, 'session-a', '问题一');
  assert.match(one, /HINT-ONCE/);
  b.markSessionHint(chat, 'session-a');
  const two = b.withSessionHint(chat, 'session-a', '问题二');
  assert.equal(two, '问题二');
  assert.match(b.withSessionHint(chat, 'session-b', '问题三'), /HINT-ONCE/);
});

test('P1-22 bridge: 旧 headless 会话继续 headless；新会话走 api', async () => {
  const dir = makeTempDir('route-');
  const cfg = baseConfig({ onebotPort: 1, stateDir: path.join(dir, 'state') });
  cfg.dsh.transport = 'api';
  const b = new Bridge(cfg, { workspace: path.join(dir, 'ws'), stateDir: path.join(dir, 'state'), stateFile: path.join(dir, 'state', 'sessions.json') }, new StatusBoard(path.join(dir, 'state', 'status.json')));
  b.transportMode = 'api';
  const called = [];
  b.invokeDshHeadless = async () => { called.push('headless'); return { sessionId: 'session-old', text: 'h' }; };
  b.invokeDshHost = async () => { called.push('api'); return { sessionId: 'session-new', text: 'a' }; };
  const chat = { sessionTransports: { 'session-old': 'headless', 'session-new': 'api' }, hintSessions: {} };
  await b.invokeDsh({ chat, chatKey: 'private:t', workspace: path.join(dir, 'ws'), task: 'x', sessionId: 'session-old', toolCalls: [] });
  await b.invokeDsh({ chat, chatKey: 'private:t', workspace: path.join(dir, 'ws'), task: 'x', sessionId: 'session-new', toolCalls: [] });
  assert.deepEqual(called, ['headless', 'api']);
  fs.rmSync(dir, { recursive: true, force: true });
});
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
// [MISSING LINE 440]
// [MISSING LINE 441]
// [MISSING LINE 442]
// [MISSING LINE 443]
// [MISSING LINE 444]
// [MISSING LINE 445]
// [MISSING LINE 446]
// [MISSING LINE 447]
// [MISSING LINE 448]
// [MISSING LINE 449]
// [MISSING LINE 450]
// [MISSING LINE 451]
// [MISSING LINE 452]
// [MISSING LINE 453]
// [MISSING LINE 454]
// [MISSING LINE 455]
// [MISSING LINE 456]
// [MISSING LINE 457]
// [MISSING LINE 458]
// [MISSING LINE 459]
// [MISSING LINE 460]
// [MISSING LINE 461]
// [MISSING LINE 462]
// [MISSING LINE 463]
// [MISSING LINE 464]
// [MISSING LINE 465]
    }
  };
  await runBridgeCommand(ctx, 'session', 'list');
  assert.match(replies.at(-1), /《甲》/);
  assert.doesNotMatch(replies.at(-1), /《乙》/);
  await runBridgeCommand(ctx, 'session', 'use', 'session-bbbb2222');
  assert.match(replies.at(-1), /不在本聊天名下/);
  await runBridgeCommand(ctx, 'session', 'release');
  assert.match(replies.at(-1), /已解除/);
  assert.equal(reg.ownerOf('session-aaaa1111'), null);
  assert.equal(chats['private:1'].sessions['/w'].sessionId, null);
});
