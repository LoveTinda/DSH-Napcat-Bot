/**
 * 目的：判断 DSH 会话是否存在、读取会话文件信息。
 * 边界：只读，不创建/删除会话。
 * 依赖：node:fs；被 bridge/session-meta 调用。
 * 失败：读不到返回 false/空。
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * DSH 会话元数据读取（只读）。
 *
 * P0-01 的目标不是“让 API 会话可用”，而是“不要把不可用会话绑进来”：
 * 绑定前必须确认 preset 为空、不是 subagent/fork、cwd 与工作区 realpath 一致。
 *
 * 元数据来自 DSH 的投影缓存：
 *   <DSH_HOME>/storages/session_projcache/sessions/<id>.json
 * 会话正文是 zstd jsonl，这里不需要读它。
 */

export function dshHome() {
  return process.env.DSH_HOME || path.join(process.env.HOME || '/root', '.dsh');
}

export function sessionsRoot() {
  return path.join(dshHome(), 'sessions');
}

function realOrResolve(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

export function sessionDirFor(workspace) {
  const slug = '--' + realOrResolve(workspace).replace(/^\//, '').replace(/\//g, '-') + '--';
  return path.join(sessionsRoot(), slug);
}

export function sessionExists(sessionId, workspace) {
  if (!sessionId) return false;
  return fs.existsSync(path.join(sessionDirFor(workspace), String(sessionId)));
}

function cacheNames(sessionId) {
  const id = String(sessionId);
  const bare = id.replace(/^session-/, '');
  return [...new Set([id, bare, 'session-' + bare])].filter(Boolean);
}

function readCache(sessionId) {
  const dir = path.join(dshHome(), 'storages', 'session_projcache', 'sessions');
  for (const name of cacheNames(sessionId)) {
    const file = path.join(dir, name + '.json');
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { file, record: j.record || {} };
    } catch { /* 尝试下一个命名 */ }
  }
  return null;
}

/**
 * @returns {{ok:true, info:object}|{ok:false, reason:string}}
 */
export function readSessionInfo(sessionId, workspace) {
  const id = String(sessionId || '').trim();
  if (!id) return { ok: false, reason: '会话 id 为空' };

  const dir = path.join(sessionDirFor(workspace), id);
  if (!fs.existsSync(dir)) {
    return { ok: false, reason: '当前工作区找不到这条会话的目录：' + id };
  }

  const cache = readCache(id);
  if (!cache) {
    return { ok: false, reason: '找不到会话元数据，无法确认它是 headless 会话（preset 未知）' };
  }

  const rec = cache.record || {};
  const rows = rec.rows || {};
  const preset = rows.agentPreset && rows.agentPreset.val;
  const subagent = rows.subagent && rows.subagent.val;
  const identity = rec.identity || {};
  const seeded = identity.isSeeded === true || Number(identity.inheritedEventCount || 0) > 0;
  const cwd = identity.cwd;

  if (preset) {
    return { ok: false, reason: '会话带 agentPreset=' + preset + '，headless 一次性运行器无法沿用（会每轮分叉）' };
  }
  if (subagent) {
    return { ok: false, reason: '这是 subagent/fork 会话，不能当普通聊天绑定' };
  }
  if (seeded) {
    return { ok: false, reason: '这是 seeded/fork 会话，不能当普通聊天绑定' };
  }
  if (!cwd) {
    return { ok: false, reason: '会话元数据没有工作目录，无法验证工作区' };
  }
  const want = realOrResolve(workspace);
  const got = realOrResolve(cwd);
  if (want !== got) {
    return { ok: false, reason: '会话工作目录 ' + got + ' 与当前工作区 ' + want + ' 不一致' };
  }

  return {
    ok: true,
    info: {
      id,
      workspace: got,
      preset: null,
      cwd: got,
      seeded: false,
      subagent: false,
      turns: null // DSH 投影里没有可靠轮数；显示“未知”，不要伪造 0
    }
  };
}

/** /ws 绑定前的统一校验。running=true 时直接拒绝，避免切走正在跑的回合。 */
export function validateBindableSession(sessionId, workspace, { running = false } = {}) {
  if (running) return { ok: false, reason: '当前聊天还有回合在跑，先 /stop 或等它收尾再切换' };
  return readSessionInfo(sessionId, workspace);
}
