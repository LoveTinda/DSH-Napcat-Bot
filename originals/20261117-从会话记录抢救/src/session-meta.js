import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * DSH 会话元数据（只读）。
 *
 * DSH 会话按工作区目录存放：<DSH_HOME>/sessions/--<realpath 的 / 换成 ->--/。
 * 目录名可能是 session-<uuid>，也可能只是 <uuid>；真正的身份以会话文件头里的
 * id / cwd / agentPreset / origin 为准。不能只按目录名前缀判断——那正是
 * “看起来切过去了、下一轮却分叉”的来源。
 */

const HEADER_FILES = ['session.v4.jsonl.zstd', 'session.v4.jsonl', 'session.jsonl.zstd', 'session.jsonl'];

export function sessionsRoot(env = process.env) {
  const home = env.DSH_HOME || path.join(env.HOME || '/root', '.dsh');
  return path.join(home, 'sessions');
}

export function canon(p) {
  try { return fs.realpathSync(p); } catch { return path.resolve(String(p || '')); }
}

/** DSH 的 slug：-- / 换成 -，例如 /root/x -> --root-x--。 */
export function sessionSlug(workspace) {
  const real = canon(workspace);
  return '--' + real.replace(/^\//, '').replace(/\//g, '-') + '--';
}

export function sessionDirFor(workspace, env = process.env) {
  return path.join(sessionsRoot(env), sessionSlug(workspace));
}

/**
 * 读会话文件头。返回 null 表示读不到/损坏；不抛错。
 * zstd 只解出前 64KB，避免为了一个 header 把整段历史读进内存。
 */
export function readSessionHeader(dir) {
  for (const name of HEADER_FILES) {
    const file = path.join(dir, name);
    let buf;
    try { buf = fs.readFileSync(file); }
    catch { continue; }
    try {
      const text = name.endsWith('.zstd')
        ? zlib.zstdDecompressSync(buf, { maxOutputLength: 64 * 1024 }).toString('utf8')
        : buf.toString('utf8');
      const line = text.split('\n').find((l) => l.trim());
      if (!line) continue;
      const header = JSON.parse(line);
      if (header && header.type === 'session' && header.id) return header;
    } catch { /* 损坏的会话：交给调用方标“未知” */ }
  }
  return null;
}

/** 一次性扫描 /proc，找出正在用 --session-id 跑的 dsh（比 flock 可移植）。 */
export function runningSessionIds() {
  const ids = new Set();
  let procs = [];
  try { procs = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return ids; }
  for (const pid of procs) {
    let cmd = '';
    try { cmd = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8').replace(/\0/g, ' '); }
    catch { continue; }
    const re = /--session-id(?:=|\s+)(session-[0-9a-f-]+)/gi;
    let m;
    while ((m = re.exec(cmd)) !== null) ids.add(m[1].toLowerCase());
  }
  return ids;
}

function normalizeId(name, header) {
  if (header && header.id) return String(header.id);
  return /^session-/i.test(name) ? name : 'session-' + name;
}

/**
 * 列出某个工作区的本机会话。
 * @returns {Array<{id,dir,header,cwd,preset,origin,parentSession,mtime,updatedAt,running,resumable,reason,headerError}>}
 */
export function listLocalSessions(workspace, { env = process.env, runningIds = null } = {}) {
  const root = sessionsRoot(env);
  const realWorkspace = canon(workspace);
  const expectedSlug = sessionSlug(workspace);
  let workspaceDirs = [];
  try {
    workspaceDirs = fs.readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^--.*--$/.test(e.name))
      .map((e) => e.name);
  } catch { return []; }
  const running = runningIds || runningSessionIds();
  const out = [];
  for (const wsName of workspaceDirs) {
    const wsDir = path.join(root, wsName);
    let sessionDirs = [];
    try { sessionDirs = fs.readdirSync(wsDir, { withFileTypes: true }).filter((e) => e.isDirectory()); }
    catch { continue; }
    for (const ent of sessionDirs) {
      const dir = path.join(wsDir, ent.name);
      const header = readSessionHeader(dir);
      const id = normalizeId(ent.name, header);
      const cwd = header && header.cwd ? canon(header.cwd) : null;
      // 头里没有 cwd 时，只有目录正好在当前工作区的 slug 下才认领；否则无法证明归属。
      if (!cwd && wsName !== expectedSlug) continue;
      if (cwd && cwd !== realWorkspace) continue;
      let st;
      try { st = fs.statSync(dir); } catch { continue; }
      const preset = header && header.agentPreset ? String(header.agentPreset) : null;
      const origin = (header && header.origin) || null;
      const parentSession = (header && header.parentSession) || null;
      let headerError = null;
      if (!header) headerError = '会话文件头不可读（损坏或版本不兼容）';
      else if (header.type !== 'session') headerError = '不是 DSH 会话文件';
      const reasons = [];
      if (headerError) reasons.push('元数据未知');
      if (preset) reasons.push('DSH preset=' + preset + '（headless 运行器拒绝带 preset 的会话）');
      if (origin === 'subagent') reasons.push('subagent 会话');
      if (parentSession) reasons.push('fork 出来的会话');
      if (cwd && cwd !== realWorkspace) reasons.push('cwd 不匹配');
      const resumable = !headerError && !preset && origin !== 'subagent' && !parentSession && cwd === realWorkspace;
      out.push({
        id,
        dir,
        header,
        cwd: cwd || realWorkspace,
        preset,
        origin,
        parentSession,
        mtime: st.mtimeMs,
        updatedAt: st.mtimeMs,
        running: running.has(String(id).toLowerCase()),
        resumable,
        reason: reasons.join('；') || null,
        headerError,
        source: 'local'
      });
    }
  }
  return dedupeSort(out);
}

/**
 * 把 DSH Host API 的 session/list 结果合并进来：running/updatedAt/preset 以 API 为准。
 * API 不可用时调用方只传 local 即可。
 */
export function mergeSessionSummaries(local, apiItems, workspace) {
  const realWorkspace = canon(workspace);
  const byId = new Map(local.map((e) => [String(e.id).toLowerCase(), e]));
  for (const item of Array.isArray(apiItems) ? apiItems : []) {
    if (!item || !item.sessionId) continue;
    const id = String(item.sessionId);
    const cwd = item.cwd ? canon(item.cwd) : null;
    if (cwd && cwd !== realWorkspace) continue;
    const apiPreset = item.projections && item.projections.values && item.projections.values.agentPreset;
    const preset = apiPreset ? String(apiPreset) : (byId.get(id.toLowerCase())?.preset || null);
    const origin = item.origin || byId.get(id.toLowerCase())?.origin || null;
    const parentSession = item.parentSessionId || byId.get(id.toLowerCase())?.parentSession || null;
    const updatedAt = Number(item.updatedAt) || byId.get(id.toLowerCase())?.updatedAt || Date.now();
    const existing = byId.get(id.toLowerCase());
    const entry = existing || {
      id,
      dir: null,
      header: null,
      cwd: cwd || realWorkspace,
      preset,
      origin,
      parentSession,
      mtime: updatedAt,
      updatedAt,
      running: !!item.running,
      resumable: false,
      reason: null,
      headerError: null,
      source: 'api'
    };
    entry.updatedAt = updatedAt;
    entry.mtime = updatedAt;
    entry.running = !!item.running;
    entry.origin = origin;
    entry.parentSession = parentSession;
    if (preset) entry.preset = preset;
    const reasons = [];
    if (entry.headerError) reasons.push('元数据未知');
    if (entry.preset) reasons.push('DSH preset=' + entry.preset + '（headless 运行器拒绝带 preset 的会话）');
    if (entry.origin === 'subagent') reasons.push('subagent 会话');
    if (entry.parentSession) reasons.push('fork 出来的会话');
    if (entry.cwd && canon(entry.cwd) !== realWorkspace) reasons.push('cwd 不匹配');
    if (!entry.dir) reasons.push('本机找不到会话日志文件');
    entry.resumable = !!entry.dir && !entry.headerError && !entry.preset && entry.origin !== 'subagent' &&
      !entry.parentSession && canon(entry.cwd) === realWorkspace;
    entry.reason = reasons.join('；') || null;
    byId.set(id.toLowerCase(), entry);
  }
  return dedupeSort([...byId.values()]);
}

function dedupeSort(list) {
  const map = new Map();
  for (const e of list) {
    const id = String(e.id).toLowerCase();
    if (!map.has(id) || e.source === 'api') map.set(id, e);
  }
  return [...map.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0) || a.id.localeCompare(b.id));
}

/**
 * 按 session-<uuid> 或唯一前缀查。
 * @returns {{entry?:object,error?:string}}
 */
export function findSessionRef(entries, raw) {
  const arg = String(raw || '').trim().split(/\s+/)[0];
  if (!arg) return { error: '用法：/ws <路径|会话 id>' };
  const want = /^session-/i.test(arg) ? arg : 'session-' + arg;
  const lower = want.toLowerCase();
  const exact = entries.find((e) => String(e.id).toLowerCase() === lower);
  if (exact) return { entry: exact };
  const hits = entries.filter((e) => String(e.id).toLowerCase().startsWith(lower));
  if (hits.length === 1) return { entry: hits[0] };
  if (hits.length > 1) {
    return { error: '前缀匹配到多条会话：\n  ' + hits.slice(0, 8).map((e) => e.id).join('\n  ') + '\n请多给几位。' };
  }
  return { error: '当前工作区里没有以 ' + want + ' 开头的会话。\n' +
    '当前工作区可见 ' + entries.length + ' 条会话；用 /sessions 查看可续会话。' };
}

/** /ws 的可续性判定：不满足就拒绝并说明。 */
export function validateSessionForResume(entry, { workspace, activeSessionId = null } = {}) {
  if (!entry) return { ok: false, reason: '找不到这条会话。' };
  if (entry.running) return { ok: false, reason: '这条会话正在运行（DSH 正在写它），不能同时切进去。等它结束再试。' };
  if (activeSessionId && String(entry.id).toLowerCase() === String(activeSessionId).toLowerCase()) {
    return { ok: false, reason: '这条会话就是当前会话，已经在用了。' };
  }
  if (entry.headerError) return { ok: false, reason: '会话元数据不可读（' + entry.headerError + '），为安全起见不切换。' };
  if (!entry.dir) return { ok: false, reason: 'DSH 能列出这条会话，但本机找不到它的日志文件，无法确认可续。' };
  if (entry.preset) {
    return { ok: false, reason: '这条会话带 DSH preset=' + entry.preset + '；headless 一次性运行器会拒绝带 preset 的会话，切过去下一轮就会分叉。' };
  }
  if (entry.origin === 'subagent' || entry.parentSession) {
    return { ok: false, reason: '这是 subagent/fork 会话，不能作为普通聊天会话续聊。' };
  }
  if (entry.cwd && canon(entry.cwd) !== canon(workspace)) {
    return { ok: false, reason: '会话 cwd=' + entry.cwd + ' 与当前工作区 ' + canon(workspace) + ' 不一致。' };
  }
  return { ok: true, warnings: [] };
}

/** 未知轮数用 null 表示，不要伪造成 0。 */
export function turnsLabel(turns) {
  return turns === null || turns === undefined ? '未知' : String(turns);
}

/** 人类可读时间（避免把毫秒时间戳直接丢给 QQ）。 */
export function timeLabel(ms, now = Date.now()) {
  if (!ms) return '时间未知';
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}
  if (!ms) return '时间未知';
  const diff = Math.max(0, now - ms);
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return Math.floor(diff / 60_000) + ' 分钟前';
  if (diff < 86_400_000) return Math.floor(diff / 3_600_000) + ' 小时前';
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}
