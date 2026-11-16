#!/usr/bin/env node
/**
 * 目的：OneBot 11 桥接最小实现——接收 NapCat 的事件推送，交给 DSH 处理，把结果回发到聊天；
 *       同时提供只读面板与状态接口，供网关 /bridge/ 反代。
 * 边界：不做权限、人设、/output 分档、群上下文（后续单元再加）；不解析富文本，只取纯文本；
 *       不保存聊天记录；面板不接受写操作；补发队列只存「待发出的回复」和最短路由信息，过期即删。
 * 依赖：NapCat 的 OneBot HTTP API（默认 127.0.0.1:3001）、DSH 的 `headless` 子命令、本机 node、
 *       ./alerts.mjs（连续失败/磁盘告警的判定）。
 * 失败：单条消息失败只回复错误摘要并记日志，进程不退出；上游不可达时由 DSH 自身报错；
 *       端口被占用会打印原因并以非 0 退出，由 unit.sh 退避重启。
 * 副作用：写 state/sessions.json（chatKey → DSH 会话 id）、state/outbox.json（待补发回复）；
 *       不写用户聊天内容到日志或面板。
 */

import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { renderPanel } from './panel.mjs';
import { createAlertGate, diskUsedPercent, maskQq } from './alerts.mjs';
import {
  DEFAULT_POLICY, normalizePolicy, validatePolicy, decidePolicy,
  commandRole, describePolicy, explainWhy, maskChatKey,
} from './policy.mjs';

const cfg = {
  listen: process.env.BRIDGE_LISTEN || '127.0.0.1:6700',
  napcatApi: (process.env.NAPCAT_API || 'http://127.0.0.1:3001').replace(/\/+$/, ''),
  napcatToken: process.env.NAPCAT_TOKEN || '',
  backend: process.env.BRIDGE_BACKEND || 'headless',
  allowGroup: process.env.BRIDGE_ALLOW_GROUP !== '0',
  timeoutMs: Number(process.env.BRIDGE_TIMEOUT_MS || 180000),
  stateFile: process.env.BRIDGE_STATE_FILE || '',
  nodeBin: process.env.DSH_NODE || process.execPath,
  dshBin: process.env.DSH_BIN || '/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js',
  dshHome: process.env.DSH_HOME || '',
  permissionMode: process.env.BRIDGE_PERMISSION_MODE || '',
  // 回发失败的重试与补发（T-8）：先原地退避重试，仍失败就进 outbox，由定时器继续补。
  sendRetry: clampInt(process.env.BRIDGE_SEND_RETRY, 3, 1, 10),
  drainMs: clampInt(process.env.BRIDGE_SEND_DRAIN_MS, 15000, 500, 600000),
  outboxTtlMs: clampInt(process.env.BRIDGE_OUTBOX_TTL_MS, 6 * 60 * 60 * 1000, 60000, 7 * 24 * 60 * 60 * 1000),
  outboxFile: process.env.BRIDGE_OUTBOX_FILE || '',
  // 重连后 NapCat 会把断线期间的旧事件补推上来；不设上限就会出现「刚重启就回答十几分钟前的消息」，
  // 看着像答非所问。0 = 不限制（不推荐）。
  maxEventAgeSec: clampInt(process.env.BRIDGE_MAX_EVENT_AGE_SEC, 120, 0, 86400),
  seenFile: process.env.BRIDGE_SEEN_FILE || '',
  // 告警（O-4）：空 ALERT_QQ = 关；阈值与冷却见 alerts.mjs 的常量说明。
  alertQq: String(process.env.ALERT_QQ || '').trim(),
  alertStreak: clampInt(process.env.ALERT_FAIL_STREAK, 3, 1, 100),
  alertCooldownMs: clampInt(process.env.ALERT_COOLDOWN_SEC, 1800, 60, 86400) * 1000,
  diskAlertPercent: clampInt(process.env.DISK_ALERT_PERCENT, 90, 50, 99),
  // 回复策略（①）：谁能触发、群里要不要 @。文件不存在就用 DEFAULT_POLICY（开放但标"未加固"）。
  policyFile: process.env.BRIDGE_POLICY_FILE || '',
};

/**
 * 目的：读环境变量里的整数并夹在合法区间内，避免手改配置时把桥接器弄崩。
 * 输入：原始值、缺省值、最小/最大；输出：区间内的整数；非法输入用缺省值。
 * 失败：不抛错。副作用：无。
 */
function clampInt(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

const [host, portText] = cfg.listen.split(':');
const port = Number(portText || 6700);

// 这些上限不是拍脑袋：
// - 2MB 是 OneBot 事件体的硬上限，超过通常是异常/攻击，不是正常消息；
// - 4MB 是单轮 DSH ndjson 的保留上限，防止异常输出把进程内存吃光；
// - 4000 字是单条 QQ 消息的安全长度，超过由 NapCat/QQ 截断或拒绝。
const MAX_EVENT_BYTES = 2 * 1024 * 1024;
const MAX_DSH_OUTPUT_CHARS = 4 * 1024 * 1024;
const MAX_DSH_STDERR_CHARS = 4000;
const MAX_REPLY_CHARS = 4000;
const MAX_EVENTS = 100;

// 重试/补发/去重的上限，同样是「按现象定」而不是拍脑袋：
// - 去重窗口 500 条：NapCat 重推通常发生在几秒内，500 条足够覆盖，再多只是占内存；
// - outbox 100 条：真断网久了补发也没意义，超出丢最旧并记一条 fail，避免无限增长；
// - 退避基数 800ms：比 NapCat 的 30s 超时快得多，又不会在它重启时把连接打满；
// - 磁盘每 5 分钟看一次：写盘增长是分钟级现象，更密只是浪费。
const MAX_SEEN_IDS = 500;
const OUTBOX_MAX = 100;
const RETRY_BASE_MS = 800;
const DISK_CHECK_MS = 5 * 60 * 1000;

function log(...a) {
  const ts = new Date().toISOString();
  console.log(ts, ...a);
}

/**
 * 目的：把错误摘要/日志里的 token、Bearer、长数字串打码，避免面板和日志泄露秘密。
 * 输入：任意值；输出：脱敏后的字符串。
 * 失败：不抛错；非字符串按 String() 处理。
 * 副作用：无。
 */
function redactText(value) {
  return String(value == null ? '' : value)
    .replace(/(token|accessToken|apiKey|api_key|secret|password)(\s*[:=]\s*)[^\s,;"}]+/gi, '$1$2***')
    .replace(/(Bearer)\s+[A-Za-z0-9._~+\/-]+/gi, '$1 ***')
    .replace(/[0-9]{11,}/g, '***');
}

// ---------- 面板用的统计 ----------
const startedAt = Date.now();
const counts = { incoming: 0, ok: 0, failed: 0, skipped: 0, requeued: 0, denied: 0 };
const events = [];               // 最近 100 条处理结果，只放元信息，不放聊天内容
const chatStats = new Map();     // chatKey → { messages, lastAt, lastMs }
const seenIds = new Set();       // self_id:message_id，防 NapCat 重推导致同一条被回答两次
const seenOrder = [];
// 去重窗口要跨重启：否则 bridge 一重启，NapCat 补推的旧消息会被当成新消息再答一遍。
const seenFile = cfg.seenFile || (cfg.outboxFile ? path.join(path.dirname(cfg.outboxFile), 'seen.json') : '');
const outbox = [];               // 待补发回复：{ id, kind, userId, groupId, key, text, at, tries, lastError }
const alertGate = createAlertGate({ failStreak: cfg.alertStreak, cooldownMs: cfg.alertCooldownMs });

// ---------- 回复策略 ----------
/**
 * 目的：读策略文件并校验；文件缺失/坏掉就用默认策略，并明确标出「未加固」。
 * 输入：无（读 cfg.policyFile）。
 * 输出：{ policy, errors, warnings, source }；errors 非空不阻止启动——桥接器是前台业务，
 *       为了一个配置笔误整机不干活更糟；错误会进日志、面板和 doctor。
 * 失败：读/解析失败只 warn。副作用：无。
 */
function loadPolicy() {
  if (!cfg.policyFile) return { policy: normalizePolicy(DEFAULT_POLICY), errors: [], warnings: ['没有 policyFile，用默认策略（未加固）'], source: '(默认)' };
  // 文件不存在是常态（还没配过策略），不是错误：用默认策略 + 一条 warn 就够。
  if (!fs.existsSync(cfg.policyFile)) {
    return {
      policy: normalizePolicy(DEFAULT_POLICY),
      errors: [],
      warnings: ['没有策略文件（' + cfg.policyFile + '），用默认策略：私聊全接、群必须 @，未加固'],
      source: '(默认)',
    };
  }
  let raw = null;
  try { raw = JSON.parse(fs.readFileSync(cfg.policyFile, 'utf8')); }
  catch (e) {
    return { policy: normalizePolicy(DEFAULT_POLICY), errors: ['策略文件读不了：' + redactText(e.message)], warnings: [], source: cfg.policyFile };
  }
  const checked = validatePolicy({ ...raw, hardened: true });
  return { ...checked, source: cfg.policyFile };
}
const policyState = loadPolicy();
const policy = policyState.policy;
const policyDenied = Object.create(null);   // why → 次数，面板用
for (const line of policyState.warnings) log('warn: 策略', line);
for (const line of policyState.errors) log('error: 策略', line);
log('策略：' + describePolicy(policy) + ' ← ' + policyState.source);
let lastDiskPercent = null;
// 告警/补发都要写盘，目录从 stateFile 推；两个都为空（自测）时不落盘。
const dataDir = cfg.outboxFile
  ? path.dirname(path.dirname(cfg.outboxFile))
  : (cfg.stateFile ? path.dirname(path.dirname(cfg.stateFile)) : '');
if (!cfg.alertQq) log('warn: 未配置 ALERT_QQ，连续失败/磁盘告警不会发 QQ');

/** 目的：记一条事件并裁剪到 100 条；任何异常都不许影响主流程。 */
function record(status, key, ms, note) {
  try {
    events.unshift({
      at: Date.now(), status, key: String(key || '').slice(0, 120), ms,
      note: redactText(note).replace(/\s+/g, ' ').trim().slice(0, 120),
    });
    if (events.length > MAX_EVENTS) events.length = MAX_EVENTS;
  } catch (e) {
    // 统计失败不能影响消息处理，但也不能静默；只打一条 warn。
    log('warn: 事件记录失败', e.message);
  }
}

/** 目的：给面板一份只读快照；不含聊天内容，配置里的 token 一律不出现在这里。 */
function snapshot() {
  // 会话表取「已落盘会话」和「有统计的聊天」的并集：
  // echo 后端或 DSH 没回 session id 时，聊天也得在面板里露出来，否则看着像没收到。
  const keys = new Set([...Object.keys(sessions), ...chatStats.keys()]);
  const sessionsView = [...keys].map((key) => {
    const st = chatStats.get(key) || {};
    return { key, sessionId: sessions[key] || '', messages: st.messages || 0, lastAt: st.lastAt || 0, lastMs: st.lastMs || 0, busy: queues.has(key) };
  }).sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  // chatStats 不落盘也不清理会随聊天数无限增长；面板只看最近活跃的 500 个。
  if (chatStats.size > 500) {
    const stale = [...chatStats.entries()].sort((a, b) => (a[1].lastAt || 0) - (b[1].lastAt || 0)).slice(0, chatStats.size - 500);
    for (const [k] of stale) chatStats.delete(k);
  }
  return {
    ok: true,
    backend: cfg.backend,
    listen: cfg.listen,
    napcatApi: cfg.napcatApi,
    uptimeMs: Date.now() - startedAt,
    counts: { ...counts, busy: queues.size, outbox: outbox.length },
    alerts: {
      qq: cfg.alertQq ? maskQq(cfg.alertQq) : '(未设置)',
      ...alertGate.stats(),
      diskPercent: lastDiskPercent,
      diskAlertPercent: cfg.diskAlertPercent,
    },
    policy: {
      summary: describePolicy(policy),
      source: policyState.source,
      hardened: policy.hardened,
      errors: policyState.errors,
      warnings: policyState.warnings,
      denied: { ...policyDenied },
      deniedTotal: counts.denied,
    },
    sessions: sessionsView,
    events: events.slice(0, MAX_EVENTS),
    config: {
      BRIDGE_LISTEN: cfg.listen,
      BRIDGE_BACKEND: cfg.backend,
      BRIDGE_ALLOW_GROUP: cfg.allowGroup,
      BRIDGE_TIMEOUT_MS: cfg.timeoutMs,
      BRIDGE_PERMISSION_MODE: cfg.permissionMode || '(profile 默认)',
      BRIDGE_MAX_EVENT_AGE_SEC: cfg.maxEventAgeSec,
      BRIDGE_SEEN_FILE: seenFile || '(不落盘)',
      BRIDGE_SEND_RETRY: cfg.sendRetry,
      BRIDGE_SEND_DRAIN_MS: cfg.drainMs,
      BRIDGE_OUTBOX_TTL_MS: cfg.outboxTtlMs,
      BRIDGE_OUTBOX_FILE: cfg.outboxFile || '(不落盘)',
      ALERT_QQ: cfg.alertQq ? maskQq(cfg.alertQq) : '(未设置)',
      ALERT_FAIL_STREAK: cfg.alertStreak,
      ALERT_COOLDOWN_SEC: Math.round(cfg.alertCooldownMs / 1000),
      DISK_ALERT_PERCENT: cfg.diskAlertPercent,
      BRIDGE_POLICY_FILE: cfg.policyFile || '(未设置，用默认策略)',
      NAPCAT_API: cfg.napcatApi,
      NAPCAT_TOKEN: cfg.napcatToken ? '(已设置)' : '(未设置)',
      DSH_BIN: cfg.dshBin,
      DSH_HOME: cfg.dshHome || process.env.HOME || '',
      BRIDGE_STATE_FILE: cfg.stateFile || '(不落盘)',
    },
  };
}

// ---------- 会话映射 ----------
let sessions = {};
if (cfg.stateFile) {
  try { sessions = JSON.parse(fs.readFileSync(cfg.stateFile, 'utf8')) || {}; } catch { sessions = {}; }
}
function saveSessions() {
  if (!cfg.stateFile) return;
  try {
    fs.mkdirSync(path.dirname(cfg.stateFile), { recursive: true });
    const tmp = cfg.stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(sessions, null, 1));
    fs.renameSync(tmp, cfg.stateFile);
  } catch (e) { log('warn: 会话表写入失败', e.message); }
}

// ---------- OneBot 消息解析 ----------
/**
 * 目的：把 OneBot 消息段拼成纯文本，并识别「有没有 @ 我」。
 * 输入：message（字符串或段数组）、selfId（机器人自己的 QQ 号）。
 * 输出：{ text, mentioned }；@ 自己的段从正文里去掉（否则会变成「@12345 你好」这种噪声）。
 * 失败：不抛错；结构不认识就当空消息。副作用：无。
 */
function textOf(message, selfId = '') {
  if (typeof message === 'string') return { text: message.trim(), mentioned: false };
  if (!Array.isArray(message)) return { text: '', mentioned: false };
  const out = [];
  let mentioned = false;
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue;
    if (seg.type === 'text' && seg.data && typeof seg.data.text === 'string') out.push(seg.data.text);
    else if (seg.type === 'image') out.push('[图片]');
    else if (seg.type === 'record') out.push('[语音]');
    else if (seg.type === 'file') out.push('[文件]');
    else if (seg.type === 'at' && seg.data && seg.data.qq) {
      const qq = String(seg.data.qq);
      if (selfId && qq === String(selfId)) mentioned = true;      // @ 我：只记标志，不进正文
      else out.push('@' + qq);
    }
  }
  return { text: out.join('').trim(), mentioned };
}

/**
 * 目的：把一条 OneBot 事件分类成「要处理」或「跳过 + 原因」，跳过原因只记元信息。
 * 输入：原始 OneBot 事件对象，来源不可信。
 * 输出：{ info } 或 { skip }；info 含 kind/key/text/userId/groupId/messageId。
 * 失败：不抛错；缺字段按空值处理。
 * 副作用：无。
 */
function classifyEvent(ev) {
  if (!ev || typeof ev !== 'object') return { skip: '不是对象' };
  if (ev.post_type !== 'message') return { skip: '非消息事件' };
  const kind = ev.message_type; // private | group
  if (kind !== 'private' && kind !== 'group') return { skip: '未知消息类型' };
  if (kind === 'group' && !cfg.allowGroup) return { skip: '群消息已关闭' };
  const selfId = String(ev.self_id ?? '');
  const senderId = String(ev.user_id ?? '');
  if (selfId && senderId === selfId) return { skip: '自己发的消息' };
  const { text, mentioned } = textOf(ev.message, selfId);
  // 群里只 @ 一下、不带正文时，@ 段被剔除后正文是空的；这种消息要留着，
  // 交给策略判定（mention 模式本来就要求 @），否则用户 @ 了却没反应。
  if (!text && !mentioned) return { skip: '空消息或不支持的消息类型' };
  const key = kind === 'group' ? `group:${ev.group_id}` : `private:${senderId}`;
  return { info: { kind, key, text: text || '(只是 @ 了我，没有正文)', userId: senderId, groupId: ev.group_id, messageId: ev.message_id, mentioned, selfId } };
}

/**
 * 目的：把去重窗口落盘，重启后仍然认得「这条已经答过」。
 * 输入：无；输出：无。失败：写失败只 warn（下次重启可能多答一条，不影响当前）。
 * 副作用：写 seenFile（0600，最多 500 条）。
 */
function saveSeen() {
  if (!seenFile) return;
  try {
    fs.mkdirSync(path.dirname(seenFile), { recursive: true });
    const tmp = seenFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(seenOrder), { mode: 0o600 });
    fs.renameSync(tmp, seenFile);
  } catch (e) { log('warn: 去重窗口写入失败', redactText(e.message)); }
}

/** 目的：启动时恢复去重窗口；文件不存在/坏掉就当空的。副作用：只读文件。 */
function loadSeen() {
  if (!seenFile) return;
  try {
    const raw = JSON.parse(fs.readFileSync(seenFile, 'utf8'));
    if (!Array.isArray(raw)) return;
    for (const key of raw) {
      if (typeof key !== 'string' || !key || seenIds.has(key)) continue;
      seenIds.add(key);
      seenOrder.push(key);
    }
    if (seenOrder.length) log('info: 载入去重窗口', seenOrder.length, '条');
  } catch (e) {
    if (e.code !== 'ENOENT') log('warn: 去重窗口读取失败', redactText(e.message));
  }
}

/**
 * 目的：识别 NapCat 重推的同一条消息（同一个 self_id + message_id），避免重复回答。
 * 输入：原始 OneBot 事件；message_id 缺失时一律当作不重复。
 * 输出：true = 本进程已经处理过这个 id。
 * 失败：不抛错。副作用：把新 id 记进窗口，窗口满 500 条时淘汰最旧的。
 */
function isDuplicateEvent(ev) {
  const id = ev && ev.message_id;
  if (id == null || id === '') return false;
  const key = String(ev.self_id ?? '') + ':' + String(id);
  if (seenIds.has(key)) return true;
  seenIds.add(key);
  seenOrder.push(key);
  if (seenOrder.length > MAX_SEEN_IDS) seenIds.delete(seenOrder.shift());
  saveSeen();
  return false;
}

// ---------- 回发 ----------
async function sendReply(info, text) {
  const action = info.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  const body = { message: text };
  if (info.kind === 'group') body.group_id = info.groupId; else body.user_id = info.userId;
  const headers = { 'content-type': 'application/json' };
  if (cfg.napcatToken) headers.authorization = `Bearer ${cfg.napcatToken}`;
  const res = await fetch(`${cfg.napcatApi}/${action}`, {
    method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data && data.status && data.status !== 'ok')) {
    throw new Error(`发送失败 HTTP ${res.status} ${redactText(JSON.stringify(data)).slice(0, 200)}`);
  }
}

// ---------- 补发队列：发不出去的回复不丢 ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 目的：从盘上恢复上次进程留下的待补发回复，重启不丢。
 * 输入：$BRIDGE_OUTBOX_FILE（缺失/坏 JSON 当作空）。
 * 输出：无；填 outbox 数组并打一行日志。
 * 失败：读失败只 warn（ENOENT 静默），不清空内存里的队列。
 * 副作用：只读文件。
 */
function loadOutbox() {
  if (!cfg.outboxFile) return;
  try {
    const raw = JSON.parse(fs.readFileSync(cfg.outboxFile, 'utf8'));
    if (!Array.isArray(raw)) return;
    for (const it of raw) {
      if (!it || typeof it !== 'object' || typeof it.text !== 'string' || !it.text) continue;
      outbox.push({
        id: String(it.id || Date.now().toString(36) + '-' + outbox.length),
        kind: it.kind === 'group' ? 'group' : 'private',
        userId: String(it.userId || ''),
        groupId: it.groupId == null ? '' : String(it.groupId),
        key: String(it.key || ''),
        text: it.text.slice(0, MAX_REPLY_CHARS),
        at: Number(it.at) || Date.now(),
        tries: Number(it.tries) || 0,
        lastError: redactText(it.lastError || '').slice(0, 120),
      });
    }
    if (outbox.length) log('info: 载入待补发', outbox.length, '条');
  } catch (e) {
    if (e.code !== 'ENOENT') log('warn: 补发队列读取失败', redactText(e.message));
  }
}

/**
 * 目的：把补发队列原子落盘（tmp + rename），断电/被杀不会留半截 JSON。
 * 输入：无；输出：无。
 * 失败：写失败只 warn，内存队列继续用，下一轮再试。
 * 副作用：写 $BRIDGE_OUTBOX_FILE（0600）。
 */
function saveOutbox() {
  if (!cfg.outboxFile) return;
  try {
    fs.mkdirSync(path.dirname(cfg.outboxFile), { recursive: true });
    const tmp = cfg.outboxFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(outbox, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, cfg.outboxFile);
  } catch (e) {
    log('warn: 补发队列写入失败', redactText(e.message));
  }
}

/**
 * 目的：把一条「已生成但发不出去」的回复放进补发队列。
 * 输入：info（路由）、text（已截断的回复）、err（最后一次发送错误，仅用于面板）。
 * 输出：无。队列超过 OUTBOX_MAX 时丢最旧的并记一条 fail，避免无限增长。
 * 失败：不抛错；写盘失败由 saveOutbox 自己 warn。
 * 副作用：改 outbox、counts.requeued，可能写盘。
 */
function enqueueOutbox(info, text, err) {
  counts.requeued++;
  outbox.push({
    id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    kind: info.kind,
    userId: String(info.userId || ''),
    groupId: info.groupId == null ? '' : String(info.groupId),
    key: String(info.key || ''),
    text: text.slice(0, MAX_REPLY_CHARS),
    at: Date.now(),
    tries: 0,
    lastError: redactText(err && err.message).slice(0, 120),
  });
  while (outbox.length > OUTBOX_MAX) {
    const dropped = outbox.shift();
    record('fail', dropped.key, 0, '补发队列已满，丢弃最旧一条');
  }
  saveOutbox();
}

/**
 * 目的：带退避地把一条回复发出去，覆盖 NapCat 短暂重启/抖动。
 * 输入：info 路由、text 回复；尝试次数来自 BRIDGE_SEND_RETRY。
 * 输出：成功返回；全部失败时抛最后一次错误，由调用方决定入队。
 * 失败：抛错（调用方处理），单次等待 0.8s/1.6s/3.2s…
 * 副作用：发网络请求。
 */
async function deliver(info, text) {
  let last = null;
  for (let i = 0; i < cfg.sendRetry; i++) {
    try {
      await sendReply(info, text);
      return;
    } catch (e) {
      last = e;
      if (i + 1 < cfg.sendRetry) {
        log('warn: 回发失败，准备重试', i + 1, redactText(e.message));
        await sleep(RETRY_BASE_MS * 2 ** i);
      }
    }
  }
  throw last;
}

let draining = false;
/**
 * 目的：定时/启动时把队列里的回复补发出去；过期的直接丢弃，避免断网一天后刷屏。
 * 输入：无；输出：无。
 * 失败：单条失败只累加 tries/lastError，不中断整轮；异常由调用方 catch。
 * 副作用：发网络请求、改 outbox、写盘；成功时 counts.ok++。
 */
async function drainOutbox() {
  if (draining || !outbox.length) return;
  draining = true;
  let changed = false;
  try {
    for (const item of [...outbox]) {
      const idx = outbox.indexOf(item);
      if (idx < 0) continue;
      if (Date.now() - item.at > cfg.outboxTtlMs) {
        outbox.splice(idx, 1);
        changed = true;
        record('fail', item.key, 0, '补发超时丢弃（' + item.tries + ' 次尝试）');
        log('warn: 补发超时丢弃', item.key, redactText(item.lastError));
        continue;
      }
      try {
        await sendReply({ kind: item.kind, userId: item.userId, groupId: item.groupId }, item.text);
        outbox.splice(idx, 1);
        changed = true;
        counts.ok++;
        record('ok', item.key, 0, '补发成功');
        log('ok 补发', item.kind, item.key);
      } catch (e) {
        item.tries++;
        changed = true;
        item.lastError = redactText(e.message).slice(0, 120);
      }
    }
  } finally {
    draining = false;
    if (changed) saveOutbox();
  }
}

/**
 * 目的：给号主发一条告警（私聊），并且不让告警失败影响业务。
 * 输入：文本；ALERT_QQ 为空时直接返回。
 * 输出：无。
 * 失败：发送失败只记事件+日志，不抛错、不进补发队列（避免告警自身把队列塞满）。
 * 副作用：发网络请求、写事件。
 */
async function notifyOwner(text) {
  if (!cfg.alertQq) return;
  try {
    await sendReply({ kind: 'private', userId: cfg.alertQq }, text.slice(0, MAX_REPLY_CHARS));
    record('ok', 'alert', 0, '已发告警');
    log('warn: 已向号主发告警', redactText(text).slice(0, 80));
  } catch (e) {
    record('fail', 'alert', 0, '告警发送失败 ' + redactText(e.message));
    log('warn: 告警发送失败', redactText(e.message));
  }
}

/**
 * 目的：把一次处理失败折算成「要不要告警」，并负责节流。
 * 输入：原因摘要（已脱敏前的原文）。
 * 输出：无。
 * 失败：不抛错。
 * 副作用：可能发一条私聊告警。
 */
function noteFailure(reason) {
  if (!alertGate.recordFailure()) return;
  alertGate.markSent('fail');
  const st = alertGate.stats();
  notifyOwner('桥接器连续失败 ' + st.streak + ' 次（阈值 ' + cfg.alertStreak + '）。最近原因：' +
    redactText(reason).slice(0, 200) + '。看日志：bin/unit.sh logs bridge 40')
    .catch((e) => log('warn: 告警流程异常', redactText(e.message)));
}

// ---------- DSH 后端 ----------
// 正在跑的 dsh 子进程；收到 SIGTERM 时要一起收掉，否则 unit.sh stop 会留下孤儿进程。
const activeChildren = new Set();

function runHeadless(prompt, sessionId) {
  return new Promise((resolve, reject) => {
    const args = [cfg.dshBin, 'headless', '--json'];
    if (sessionId) args.push('--session-id', sessionId);
    if (cfg.permissionMode) args.push('--permission-mode', cfg.permissionMode);
    args.push('-'); // 任务从 stdin 读，避免超长/转义问题
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    if (cfg.dshHome) env.DSH_HOME = cfg.dshHome;
    const child = spawn(cfg.nodeBin, args, { env, stdio: ['pipe', 'pipe', 'pipe'] });
    activeChildren.add(child);
    child.on('close', () => activeChildren.delete(child));
    let out = '', err = '', killed = false, settled = false;
    const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); fn(value); };
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, cfg.timeoutMs);
    // 只保留尾部：异常程序可能无限输出，保留全量会 OOM。
    child.stdout.on('data', (d) => { out = (out + d).slice(-MAX_DSH_OUTPUT_CHARS); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-MAX_DSH_STDERR_CHARS); });
    child.on('error', (e) => finish(reject, e));
    child.on('close', (code) => {
      if (killed) return finish(reject, new Error('DSH 超时'));
      const parsed = parseHeadlessJson(out);
      if (code !== 0 && !parsed.text) return finish(reject, new Error(`DSH 退出码 ${code}: ${redactText(err)}`));
      finish(resolve, parsed);
    });
    // 子进程提前退出时 stdin 会 EPIPE；不接住会变成未捕获异常，整个桥接器退出。
    child.stdin.on('error', (e) => { log('warn: DSH stdin 写入失败', redactText(e.message)); });
    child.stdin.end(prompt);
  });
}

// 逐行解析 ndjson；取最后一段助手文本与会话 id
function parseHeadlessJson(raw) {
  let text = '', sessionId = '';
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }
    const sid = ev.sessionId ?? ev.session_id ?? ev.session;
    if (typeof sid === 'string' && sid) sessionId = sid;
    const t = ev.text ?? ev.message ?? ev.content ?? ev.delta?.text ?? ev.data?.text;
    if (typeof t === 'string' && t) {
      const type = String(ev.type ?? ev.kind ?? ev.event ?? '');
      if (/assistant|message|text|final|done/i.test(type) || !type) text = t;
    }
  }
  return { text: text.trim(), sessionId };
}

async function runEcho(prompt) {
  return { text: `[echo] ${prompt}`, sessionId: '' };
}

/**
 * 目的：让一个聊天的一轮消息走 DSH；持久会话失效时清掉映射并重开，避免永久卡死。
 * 输入：info 为 classifyEvent 的结果；不直接信任聊天内容。
 * 输出：{ text, sessionId }，text 可能为空。
 * 失败：DSH 非零退出/超时抛错，由调用方回发错误摘要；只对「未知会话」重试一次。
 * 副作用：更新 sessions 并落盘。
 */
async function askDsh(info) {
  if (cfg.backend === 'echo') return runEcho(info.text);
  const prev = sessions[info.key] || '';
  try {
    const { text, sessionId } = await runHeadless(info.text, prev);
    if (sessionId && sessionId !== prev) { sessions[info.key] = sessionId; saveSessions(); }
    return { text, sessionId };
  } catch (e) {
    // DSH 的会话文件被删/回滚后，--session-id 会报 unknown；保留映射会让该聊天以后每条都失败。
    if (!prev || !/unknown|not found|no such|不存在|未知/i.test(String(e.message))) throw e;
    log('warn: 会话失效，重开', info.key, redactText(e.message));
    delete sessions[info.key];
    saveSessions();
    const { text, sessionId } = await runHeadless(info.text, '');
    if (sessionId) { sessions[info.key] = sessionId; saveSessions(); }
    record('skip', info.key, 0, 'DSH 会话失效，已重开');
    return { text, sessionId };
  }
}

// ---------- 串行队列：同一个 chat 不并发 ----------
const queues = new Map();
function enqueue(key, job) {
  const prev = queues.get(key) || Promise.resolve();
  const next = prev.then(job, job).catch(() => {});
  queues.set(key, next);
  next.finally(() => { if (queues.get(key) === next) queues.delete(key); });
  return next;
}

// ---------- HTTP ----------
function body(req, limit = MAX_EVENT_BYTES) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('请求过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url || '/';
  // 用 pathname 判断，查询串（例如网关带过来的 ?k=）不能影响路由
  const pathname = new URL(url, 'http://127.0.0.1').pathname;
  const isGet = req.method === 'GET' || req.method === 'HEAD';

  // 面板：页面和状态接口都不走鉴权——鉴权由外面的网关做，这里默认只监听 127.0.0.1。
  // 路径固定为 /panel、/panel/、/、/index.html；状态同时提供 /panel/state.json 和 /state.json，
  // 后者让页面可以用相对路径 state.json，从而同时兼容 /panel/ 与 /bridge/ 两种挂载点。
  if (isGet && (pathname === '/' || pathname === '/panel' || pathname === '/panel/' || pathname === '/index.html')) {
    const html = renderPanel(snapshot());
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(req.method === 'HEAD' ? undefined : html);
  }
  if (isGet && (pathname === '/panel/state.json' || pathname === '/state.json')) {
    const json = JSON.stringify(snapshot());
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    return res.end(req.method === 'HEAD' ? undefined : json);
  }
  if (isGet && pathname === '/healthz') {
    const json = JSON.stringify({ ok: true, backend: cfg.backend, listen: cfg.listen });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : json);
  }
  if (isGet && pathname === '/favicon.ico') { res.writeHead(204).end(); return; }
  if (req.method !== 'POST') { res.writeHead(405, { 'content-type': 'text/plain; charset=utf-8' }).end(); return; }

  let ev;
  try { ev = JSON.parse(await body(req)); } catch (e) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: 'bad json' }));
    return;
  }
  // OneBot 11 秒回 204，业务异步做，避免上游超时重推
  res.writeHead(204).end();

  const classified = classifyEvent(ev);
  if (!classified.info) {
    counts.skipped++;
    // meta_event/heartbeat 很频繁，只计数不写事件流；消息类被跳过才值得露出来。
    if (ev && ev.post_type === 'message') record('skip', '', 0, classified.skip);
    return;
  }
  const info = classified.info;
  // 重连补推的旧事件：跳过，不回答。时间戳是秒；缺字段时按「新消息」处理，避免误杀。
  const evTime = Number(ev && ev.time);
  if (cfg.maxEventAgeSec > 0 && Number.isFinite(evTime) && evTime > 0) {
    const age = Math.floor(Date.now() / 1000) - evTime;
    if (age > cfg.maxEventAgeSec) {
      counts.skipped++;
      record('skip', info.key, 0, '过期事件（' + age + ' 秒前，重连补推），已忽略');
      log('skip', info.kind, info.key, '过期事件', age + 's');
      return;
    }
  }
  // NapCat 在超时/重连时会重推同一个 message_id；不拦会导致同一个问题回答两次。
  if (isDuplicateEvent(ev)) {
    counts.skipped++;
    record('skip', info.key, 0, '重复推送（同一 message_id），已忽略');
    return;
  }
  // 回复策略（①）：白名单 / 群里必须 @ / 自己发的。拒绝只记元信息，不回任何内容。
  const verdict = decidePolicy(policy, {
    isGroup: info.kind === 'group',
    userId: info.userId,
    groupId: info.groupId,
    mentioned: info.mentioned,
    selfId: info.selfId,
  });
  if (!verdict.ok) {
    counts.denied++;
    policyDenied[verdict.why] = (policyDenied[verdict.why] || 0) + 1;
    record('skip', info.key, 0, '策略拒绝：' + explainWhy(verdict.why));
    if (verdict.why !== 'self') log('deny', info.kind, info.key, explainWhy(verdict.why));
    return;
  }

  counts.incoming++;
  enqueue(info.key, async () => {
    const started = Date.now();
    try {
      // 两个最小的控制命令：会话乱了能自己救，不用去翻 state 文件。只对私聊开放，
      // 避免群里任何人一句话就把大家的会话重置掉。
      const cmd = info.text.trim().toLowerCase();
      if (info.kind === 'private' && (cmd === '/reset' || cmd === '/session')) {
        if (cmd === '/reset') {
          delete sessions[info.key];
          saveSessions();
          await deliver(info, '已重置这个聊天的 DSH 会话，下一条消息会开新会话');
          record('ok', info.key, Date.now() - started, '手动重置会话');
        } else {
          const sid = sessions[info.key] || '';
          await deliver(info, sid ? '当前会话：' + sid : '还没有建立 DSH 会话（下一条消息会新建）');
          record('ok', info.key, Date.now() - started, '查询会话');
        }
        alertGate.recordSuccess();
        return;
      }
      const { text } = await askDsh(info);
      const reply = (text || '').trim() || '（DSH 没有返回内容）';
      try {
        await deliver(info, reply.slice(0, MAX_REPLY_CHARS));
      } catch (sendErr) {
        // DSH 已经算出了答案，只是发不出去：进补发队列，别把答案丢了，也别再发一条「出错了」。
        enqueueOutbox(info, reply, sendErr);
        const ms = Date.now() - started;
        counts.failed++;
        record('fail', info.key, ms, '回复已入补发队列（回发失败）');
        log('fail:send', info.kind, info.key, redactText(sendErr.message));
        noteFailure('回发失败：' + sendErr.message);
        return;
      }
      const ms = Date.now() - started;
      counts.ok++;
      alertGate.recordSuccess();
      const st = chatStats.get(info.key) || { messages: 0 };
      chatStats.set(info.key, { messages: st.messages + 1, lastAt: Date.now(), lastMs: ms });
      record('ok', info.key, ms, reply.length + ' 字');
      log('ok', info.kind, info.key, `${ms}ms`, reply.length + '字');
    } catch (e) {
      const ms = Date.now() - started;
      counts.failed++;
      const st = chatStats.get(info.key) || { messages: 0 };
      chatStats.set(info.key, { messages: st.messages, lastAt: Date.now(), lastMs: ms });
      record('fail', info.key, ms, e.message);
      log('fail', info.kind, info.key, redactText(e.message));
      noteFailure(e.message);
      try { await sendReply(info, `出错了：${redactText(e.message).slice(0, 200)}`); } catch (e2) { log('fail:reply', redactText(e2.message)); }
    }
  });
});

server.on('error', (e) => {
  // EADDRINUSE 最常见：旧实例没停干净。打印清楚原因后退出，交给 unit.sh 退避重启/人来看。
  log('fatal: 监听失败', cfg.listen, e.code || e.message);
  process.exit(1);
});
// 补发：启动时先恢复上次的队列并试一轮，之后按 BRIDGE_SEND_DRAIN_MS 轮询。
loadOutbox();
loadSeen();
// 面板/doctor 一打开就该看到磁盘占用，别等 5 分钟后的第一次定时检查。
lastDiskPercent = diskUsedPercent(dataDir);
setTimeout(() => { drainOutbox().catch((e) => log('warn: 补发轮询异常', redactText(e.message))); }, 1000).unref();
setInterval(() => { drainOutbox().catch((e) => log('warn: 补发轮询异常', redactText(e.message))); }, cfg.drainMs).unref();

// 磁盘告警：每 5 分钟看一次数据目录所在分区；只有「超过阈值且过了冷却」才发。
setInterval(() => {
  lastDiskPercent = diskUsedPercent(dataDir);
  if (lastDiskPercent == null || !cfg.alertQq) return;
  if (lastDiskPercent < cfg.diskAlertPercent || !alertGate.allowDisk()) return;
  alertGate.markSent('disk');
  notifyOwner('磁盘将满：' + lastDiskPercent + '%（阈值 ' + cfg.diskAlertPercent + '%）。数据目录 ' +
    (dataDir || '(未知)') + '；先清 logs/ 或把备份挪走，再跑 bin/doctor.sh 复核。')
    .catch((e) => log('warn: 磁盘告警异常', redactText(e.message)));
}, DISK_CHECK_MS).unref();

server.listen(port, host, () => log('bridge 已启动', cfg.listen, 'backend=' + cfg.backend, 'napcat=' + cfg.napcatApi,
  '补发队列=' + outbox.length + ' 告警=' + (cfg.alertQq ? maskQq(cfg.alertQq) : '关')));

process.on('unhandledRejection', (e) => {
  log('fatal: 未处理的 Promise rejection', redactText(e && e.stack ? e.stack : e));
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    log('收到', sig, '，退出');
    // 先让正在跑的 DSH 子进程收到 TERM；1.5 秒后还在的强制杀掉，避免成为孤儿。
    for (const child of activeChildren) { try { child.kill('SIGTERM'); } catch (e) { log('warn: 停止 DSH 子进程失败', e.code || e.message); } }
    setTimeout(() => { for (const child of activeChildren) { try { child.kill('SIGKILL'); } catch (e) { log('warn: 强制停止 DSH 子进程失败', e.code || e.message); } } }, 1500).unref();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
