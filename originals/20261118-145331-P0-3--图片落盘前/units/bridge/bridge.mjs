#!/usr/bin/env node
/**
 * 目的：OneBot 11 桥接最小实现——接收 NapCat 的事件推送，交给 DSH 处理，把结果回发到聊天；
 *       同时提供只读面板与状态接口，供网关 /bridge/ 反代。
 * 边界：不做图片下载/上传、流式分段、插话打断、会话工作区（后续任务再做）；不解析富文本，
 *       只取文本/表情/戳一戳/引用摘要；不保存聊天记录；面板不接受写操作；
 *       补发队列只存「待发出的回复」和最短路由信息，过期即删。
 *       lastBubbles（chatKey → 上一轮气泡 id）只存内存、不落盘：气泡 id 只在 NapCat 会话有效期内
 *       可删，重启后陈旧 id 反而会报错；重启后第一次 recall 按「没有上一轮」跳过即可。
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
  commandRole, describePolicy, explainWhy, maskChatKey, roleAtLeast,
} from './policy.mjs';
import {
  parseCommand, helpText, helpFor, unknownCommandText, pendingCommandText,
} from './commands.mjs';
import { planDelivery, describeHumanize, DEFAULT_HUMANIZE } from './humanize.mjs';
import { createTyping, describeTyping, DEFAULT_TYPING } from './typing.mjs';
import { createGroupContext, DEFAULT_GROUP_CONTEXT } from './group-context.mjs';
import { renderByTier, tierListText, normalizeTier, isTier, describeTier, compactNotice, DEFAULT_TIER } from './output.mjs';
import { createRelay, DEFAULT_RELAY } from './relay.mjs';
import {
  parseActions, runActions, interactionHint, describeInteractions, DEFAULT_INTERACTIONS,
} from './interactions.mjs';
import {
  normalizeMessage, chatKeyFor, formatQuoteContext, unsupportedReply, unsupportedTaskNote,
  disclosureText, atPrefix,
} from './message.mjs';

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
  // 拟人化投递（③）：分条与停顿。0 = 一条发完（回到最朴素的行为）。
  humanizeEnabled: process.env.BRIDGE_HUMANIZE !== '0',
  humanizeMaxBubbles: clampInt(process.env.BRIDGE_HUMANIZE_MAX_BUBBLES, DEFAULT_HUMANIZE.maxBubbles, 1, 10),
  humanizeMaxChars: clampInt(process.env.BRIDGE_HUMANIZE_MAX_CHARS, DEFAULT_HUMANIZE.maxChars, 40, 2000),
  humanizeTotalDelayMs: clampInt(process.env.BRIDGE_HUMANIZE_TOTAL_DELAY_MS, DEFAULT_HUMANIZE.totalDelayCapMs, 0, 60000),
  // 输入状态（③的漏项）：私聊里发「正在输入…」。NapCat 只实现了 C2C，群里发不出去。
  typingEnabled: process.env.BRIDGE_TYPING !== '0',
  typingKeepaliveMs: clampInt(process.env.BRIDGE_TYPING_KEEPALIVE_SEC, Math.round(DEFAULT_TYPING.keepaliveMs / 1000), 0, 120) * 1000,
  // 群上下文（④）：把「刚才在聊什么」带进提示词。0 = 关。
  groupContextEnabled: process.env.BRIDGE_GROUP_CONTEXT !== '0',
  groupContextMax: clampInt(process.env.BRIDGE_GROUP_CONTEXT_MAX, DEFAULT_GROUP_CONTEXT.maxMessages, 1, 50),
  groupContextChars: clampInt(process.env.BRIDGE_GROUP_CONTEXT_CHARS, DEFAULT_GROUP_CONTEXT.maxChars, 100, 8000),
  // 交互动作（P0-1）：模型在正文里写 [[react:赞]] / [[recall]] / [[poke]]，桥接器执行后删标记。
  // 关闭时标记原样保留（不解析、不注入提示），避免用户以为开关坏了。
  interactionsEnabled: process.env.BRIDGE_INTERACTIONS !== '0',
  interactionsGroupPoke: process.env.BRIDGE_INTERACTIONS_GROUP_POKE === '1',
  interactionsMax: clampInt(process.env.BRIDGE_INTERACTIONS_MAX, DEFAULT_INTERACTIONS.maxActions, 1, 5),
  interactionsTimeoutMs: clampInt(process.env.BRIDGE_INTERACTIONS_TIMEOUT_MS, DEFAULT_INTERACTIONS.timeoutMs, 100, 10000),
  // 输出档位（⑤）：每个聊天一份，默认极简。
  outputDefault: normalizeTier(process.env.BRIDGE_OUTPUT_DEFAULT || DEFAULT_TIER),
  outputFile: process.env.BRIDGE_OUTPUT_FILE || '',
  // 自动压缩（⑤）：同一聊天聊满 N 轮就把前文压成摘要、换新会话；0 = 关。
  autoCompactRounds: clampInt(process.env.BRIDGE_AUTO_COMPACT_ROUNDS, 15, 0, 1000),
  summaryFile: process.env.BRIDGE_SUMMARY_FILE || '',
  // 维护期自动回复（⑤）
  relayEnabled: process.env.BRIDGE_RELAY !== '0',
  relayAfter: clampInt(process.env.BRIDGE_RELAY_AFTER, DEFAULT_RELAY.afterFailures, 1, 50),
  relayCooldownMs: clampInt(process.env.BRIDGE_RELAY_COOLDOWN_SEC, Math.round(DEFAULT_RELAY.cooldownMs / 1000), 10, 86400) * 1000,
  relayMessage: process.env.BRIDGE_RELAY_MESSAGE || DEFAULT_RELAY.message,
  // 消息层（P0-2）：群回复是否 @ 提问者、群首次是否披露 AI 身份、群会话按群还是按成员。
  groupReplyAt: process.env.BRIDGE_GROUP_REPLY_AT !== '0',
  aiDisclosure: process.env.BRIDGE_AI_DISCLOSURE !== '0',
  groupSessionScope: process.env.BRIDGE_GROUP_SESSION_SCOPE === 'member' ? 'member' : 'group',
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
const counts = { incoming: 0, ok: 0, failed: 0, skipped: 0, requeued: 0, denied: 0, bubbles: 0, typingMsgs: 0 };
let lastPlan = null;   // 最近一次分条投递：{ bubbles, chars, at }
let lastInteractions = null;   // 最近一轮动作：{ at, executed, failed, skipped, kinds }
const interactionTotals = { turns: 0, executed: 0, failed: 0, skipped: 0 };
// 每个聊天「上一轮」发出的气泡 id；[[recall]] 删这份，不删本轮（P0-1b）。
// 只存内存：NapCat 会话结束后旧 id 无效，重启后重来比删错安全。
const lastBubbles = new Map();
const hintedSessions = new Set();   // 已经拼过交互提示的 DSH 会话 id（进程重启后重注一次无害）
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
const runningChild = new Map();  // chatKey → 正在跑的 DSH 子进程（/stop 用）
const notices = new Map();       // chatKey → false 表示关掉「使用提示」（内存态，重启复位）
const disclosedChats = new Set();     // chatKey → 已经披露过 AI 身份（内存态，重启后重披露一次）
const cmdHits = Object.create(null);  // 命令名 → 次数，面板用
// 输出档位（⑤）：chatKey → tier；落盘，重启后用户的选择还在。
let tiers = {};
if (cfg.outputFile) {
  try { tiers = JSON.parse(fs.readFileSync(cfg.outputFile, 'utf8')) || {}; } catch { tiers = {}; }
}
function saveTiers() {
  if (!cfg.outputFile) return;
  try {
    fs.mkdirSync(path.dirname(cfg.outputFile), { recursive: true });
    const tmp = cfg.outputFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(tiers, null, 1));
    fs.renameSync(tmp, cfg.outputFile);
  } catch (e) { log('warn: 档位表写入失败', e.message); }
}
/** 目的：取某个聊天当前档位（没设过用默认）。 */
function tierOf(key) { return normalizeTier(tiers[key] || cfg.outputDefault); }

// 自动压缩（⑤）：chatKey → 之前会话的摘要；下一条消息会把它放在最前面。
let summaries = {};
if (cfg.summaryFile) {
  try { summaries = JSON.parse(fs.readFileSync(cfg.summaryFile, 'utf8')) || {}; } catch { summaries = {}; }
}
function saveSummaries() {
  if (!cfg.summaryFile) return;
  try {
    fs.mkdirSync(path.dirname(cfg.summaryFile), { recursive: true });
    const tmp = cfg.summaryFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(summaries, null, 1));
    fs.renameSync(tmp, cfg.summaryFile);
  } catch (e) { log('warn: 摘要写入失败', e.message); }
}

const relay = createRelay({
  enabled: cfg.relayEnabled,
  afterFailures: cfg.relayAfter,
  cooldownMs: cfg.relayCooldownMs,
  message: cfg.relayMessage,
});

const groupCtx = createGroupContext({
  enabled: cfg.groupContextEnabled,
  maxMessages: cfg.groupContextMax,
  maxChars: cfg.groupContextChars,
});
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
    output: {
      defaultTier: cfg.outputDefault,
      tiers: Object.keys(tiers).length,
      autoCompactRounds: cfg.autoCompactRounds,
      summaries: Object.keys(summaries).length,
      list: Object.entries(tiers).slice(0, 20).map(([k, v]) => ({ key: k, tier: v })),
    },
    relay: {
      summary: relay.describe(),
      ...relay.stats(),
    },
    groupContext: {
      summary: groupCtx.describe(),
      ...groupCtx.stats(),
    },
    typing: {
      summary: describeTyping({ enabled: cfg.typingEnabled, keepaliveMs: cfg.typingKeepaliveMs }),
      messages: counts.typingMsgs || 0,
    },
    interactions: {
      summary: describeInteractions({
        enabled: cfg.interactionsEnabled,
        groupPoke: cfg.interactionsGroupPoke,
        maxActions: cfg.interactionsMax,
        timeoutMs: cfg.interactionsTimeoutMs,
      }),
      enabled: cfg.interactionsEnabled,
      last: lastInteractions,
      totals: { ...interactionTotals },
    },
    messageLayer: {
      summary: (cfg.groupReplyAt ? '群回复 @ 提问者' : '群回复不带 @') +
        (cfg.aiDisclosure ? ' · 首次披露' : ' · 不披露') +
        (cfg.groupSessionScope === 'member' ? ' · 成员级会话' : ' · 每群一条会话'),
      groupReplyAt: cfg.groupReplyAt,
      aiDisclosure: cfg.aiDisclosure,
      groupSessionScope: cfg.groupSessionScope,
    },
    humanize: {
      summary: describeHumanize({
        enabled: cfg.humanizeEnabled,
        maxBubbles: cfg.humanizeMaxBubbles,
        maxChars: cfg.humanizeMaxChars,
        totalDelayCapMs: cfg.humanizeTotalDelayMs,
      }),
      last: lastPlan,
      bubbles: counts.bubbles,
    },
    commands: {
      total: Object.values(cmdHits).reduce((a, b) => a + b, 0),
      top: Object.entries(cmdHits).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ name: k, hits: v })),
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
      BRIDGE_HUMANIZE: cfg.humanizeEnabled ? 1 : 0,
      BRIDGE_HUMANIZE_MAX_BUBBLES: cfg.humanizeMaxBubbles,
      BRIDGE_HUMANIZE_MAX_CHARS: cfg.humanizeMaxChars,
      BRIDGE_HUMANIZE_TOTAL_DELAY_MS: cfg.humanizeTotalDelayMs,
      BRIDGE_GROUP_CONTEXT: cfg.groupContextEnabled ? 1 : 0,
      BRIDGE_GROUP_CONTEXT_MAX: cfg.groupContextMax,
      BRIDGE_GROUP_CONTEXT_CHARS: cfg.groupContextChars,
      BRIDGE_INTERACTIONS: cfg.interactionsEnabled ? 1 : 0,
      BRIDGE_INTERACTIONS_GROUP_POKE: cfg.interactionsGroupPoke ? 1 : 0,
      BRIDGE_INTERACTIONS_MAX: cfg.interactionsMax,
      BRIDGE_INTERACTIONS_TIMEOUT_MS: cfg.interactionsTimeoutMs,
      BRIDGE_GROUP_REPLY_AT: cfg.groupReplyAt ? 1 : 0,
      BRIDGE_AI_DISCLOSURE: cfg.aiDisclosure ? 1 : 0,
      BRIDGE_GROUP_SESSION_SCOPE: cfg.groupSessionScope,
      BRIDGE_OUTPUT_DEFAULT: cfg.outputDefault,
      BRIDGE_OUTPUT_FILE: cfg.outputFile || '(不落盘)',
      BRIDGE_AUTO_COMPACT_ROUNDS: cfg.autoCompactRounds,
      BRIDGE_SUMMARY_FILE: cfg.summaryFile || '(不落盘)',
      BRIDGE_RELAY: cfg.relayEnabled ? 1 : 0,
      BRIDGE_RELAY_AFTER: cfg.relayAfter,
      BRIDGE_RELAY_COOLDOWN_SEC: Math.round(cfg.relayCooldownMs / 1000),
      BRIDGE_RELAY_MESSAGE: cfg.relayMessage,
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
 * 目的：取被引用消息的文本/图片数与发送者，用来判断“回复机器人”算不算 @，并给模型一点上下文。
 * 输入：message_id（引用段里的 id）；timeoutMs 默认 4s。
 * 输出：{ ok, text, images, senderId, senderName } 或 { ok:false, error }。
 * 失败：网络/接口失败只返回 ok:false，由调用方在提示里明确“引用不可读”，不抛错。
 * 副作用：一次本机 OneBot HTTP 请求，不发消息。
 */
async function fetchReplyContext(messageId, timeoutMs = 4000) {
  const headers = { 'content-type': 'application/json' };
  if (cfg.napcatToken) headers.authorization = `Bearer ${cfg.napcatToken}`;
  try {
    const res = await fetch(`${cfg.napcatApi}/get_msg`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ message_id: messageId }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data && data.status && data.status !== 'ok')) {
      return { ok: false, error: `get_msg 失败 HTTP ${res.status}` };
    }
    const d = data && data.data && typeof data.data === 'object' ? data.data : null;
    if (!d || (!d.message && !d.raw_message)) return { ok: false, error: 'get_msg 没有返回消息正文' };
    const n = normalizeMessage(d.message ?? d.raw_message, '');
    const sender = d.sender && typeof d.sender === 'object' ? d.sender : {};
    return {
      ok: true,
      text: n.text,
      images: n.images,
      senderId: sender.user_id == null ? null : String(sender.user_id),
      senderName: String(sender.card || sender.nickname || sender.user_id || '').slice(0, 32),
    };
  } catch (e) {
    return { ok: false, error: redactText((e && e.message) || String(e)).slice(0, 120) };
  }
}

/**
 * 目的：把一条 OneBot 事件分类成「要处理」或「跳过 + 原因」，并取好引用上下文。
 * 输入：原始 OneBot 事件对象，来源不可信。
 * 输出：{ info } 或 { skip }；info 含 kind/key/text/userId/groupId/messageId/unsupported/quote。
 * 失败：不抛错；缺字段按空值处理。取引用失败只让 quote.ok=false，不丢消息。
 * 副作用：可能发一次 get_msg 请求。
 */
async function classifyEvent(ev) {
  if (!ev || typeof ev !== 'object') return { skip: '不是对象' };
  if (ev.post_type !== 'message') return { skip: '非消息事件' };
  const kind = ev.message_type; // private | group
  if (kind !== 'private' && kind !== 'group') return { skip: '未知消息类型' };
  if (kind === 'group' && !cfg.allowGroup) return { skip: '群消息已关闭' };
  const selfId = String(ev.self_id ?? '');
  const senderId = String(ev.user_id ?? '');
  if (selfId && senderId === selfId) return { skip: '自己发的消息' };

  const norm = normalizeMessage(ev.message, selfId);
  let quote = null;
  if (norm.repliedTo) quote = await fetchReplyContext(norm.repliedTo);
  let mentioned = norm.mentioned;
  // 群里“回复机器人那条”要算 @：必须确认被引用消息的 sender 是 selfId，不能靠猜。
  if (kind === 'group' && quote && quote.ok && quote.senderId != null && String(quote.senderId) === selfId) {
    mentioned = true;
  }
  // 群里只 @ 一下、不带正文时，@ 段被剔除后正文是空的；这种消息要留着，
  // 交给策略判定（mention 模式本来就要求 @），否则用户 @ 了却没反应。
  // 只发不支持类型（语音/文件）时也留着，由入站层回一句“暂不支持”，而不是静默吞掉。
  if (!norm.text && !norm.unsupported.length && !mentioned) return { skip: '空消息或不支持的消息类型' };
  const key = chatKeyFor({ kind, groupId: ev.group_id, userId: senderId, groupSessionScope: cfg.groupSessionScope });
  const sender = ev.sender && typeof ev.sender === 'object' ? ev.sender : {};
  const name = String(sender.card || sender.nickname || '').slice(0, 32);
  const text = norm.text || (mentioned && !norm.unsupported.length && !norm.repliedTo ? '(只是 @ 了我，没有正文)' : '');
  return {
    info: {
      kind, key, text, userId: senderId, name, groupId: ev.group_id, messageId: ev.message_id,
      mentioned, selfId, unsupported: norm.unsupported, repliedTo: norm.repliedTo, quote, images: norm.images,
    },
  };
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
async function sendReply(info, text, opts = {}) {
  const action = info.kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  // 群回复 @ 提问者：用 CQ 字符串而不是消息段数组，补发队列/旧测试都按字符串走。
  const prefix = info.kind === 'group' && opts.atUserId ? atPrefix(opts.atUserId) : '';
  const body = { message: prefix ? prefix + text : text };
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
  // 撤回上一轮需要 message_id；旧实现没返回，导致「删气泡」无从下手（P0-1）。
  return data && data.data ? data.data.message_id : undefined;
}

/**
 * 目的：给私聊发「正在输入」状态（NapCat 的 set_input_status）。
 * 输入：info 聊天信息；eventType 0=开始、1=停止。
 * 输出：无。
 * 失败：HTTP 非 2xx 或 OneBot status!=ok 时抛错——由 createTyping 吞掉并记一行 warn，不影响回复。
 * 副作用：一次本机 HTTP 请求。
 */
async function sendInputStatus(info, eventType) {
  // 群聊没有这个能力（NapCat 只实现了 C2C），发了也是白发，直接跳过。
  if (info.kind !== 'private') return;
  const headers = { 'content-type': 'application/json' };
  if (cfg.napcatToken) headers.authorization = `Bearer ${cfg.napcatToken}`;
  // QQ 号是纯数字时按数字发：OneBot 实现里 user_id 要 number 的比要 string 的多。
  const raw = String(info.userId ?? '');
  const uid = /^\d+$/.test(raw) ? Number(raw) : raw;
  const res = await fetch(`${cfg.napcatApi}/set_input_status`, {
    method: 'POST',
    headers,
    signal: AbortSignal.timeout(5000),
    body: JSON.stringify({ user_id: uid, event_type: eventType }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || (data && data.status && data.status !== 'ok')) {
    throw new Error(`set_input_status 失败 HTTP ${res.status} ${redactText(JSON.stringify(data)).slice(0, 120)}`);
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
async function deliver(info, text, opts = {}) {
  let last = null;
  for (let i = 0; i < cfg.sendRetry; i++) {
    try {
      return await sendReply(info, text, opts);
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

/**
 * 目的：按拟人化计划把一条回复拆成几段发出去（段间停顿），并收集每段的 message_id。
 * 输入：info 路由、text 原文；计划参数来自 cfg.humanize*。
 * 输出：成功时返回 { bubbles, messageIds }；messageId 缺失时只计段数。
 * 失败：任一段重试用尽即抛，错误里带已发出的段数（remaining）与已发出的 id（messageIds），
 *       由调用方把剩下的进补发队列。
 * 副作用：发网络请求、sleep。
 */
async function deliverHuman(info, text, sendOpts = {}) {
  const opts = {
    enabled: cfg.humanizeEnabled,
    maxBubbles: cfg.humanizeMaxBubbles,
    maxChars: cfg.humanizeMaxChars,
    totalDelayCapMs: cfg.humanizeTotalDelayMs,
  };
  const plan = planDelivery(String(text ?? '').slice(0, MAX_REPLY_CHARS), opts);
  const messageIds = [];
  for (let i = 0; i < plan.length; i++) {
    const item = plan[i];
    if (item.delayMs > 0) await sleep(item.delayMs);
    try {
      // 只有第一条带 @；后续气泡再 @ 一次会变成骚扰。
      const id = await deliver(info, item.text, i === 0 ? sendOpts : undefined);
      if (id != null && id !== '') messageIds.push(id);
    } catch (e) {
      const err = new Error(e.message);
      err.remaining = plan.slice(i).map((x) => x.text).join('\n');
      err.sentBubbles = i;
      err.messageIds = messageIds.slice();
      throw err;
    }
  }
  return { bubbles: plan.length, messageIds };
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

function runHeadless(prompt, sessionId, chatKey = '') {
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
    if (chatKey) runningChild.set(chatKey, child);
    child.on('close', () => {
      activeChildren.delete(child);
      if (chatKey && runningChild.get(chatKey) === child) runningChild.delete(chatKey);
    });
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
  let final = '', sessionId = '';
  const texts = [];       // 执行中的正文段（concise 及以上用）
  const tools = [];       // 工具调用（detailed 及以上用）
  const thinking = [];    // 思维链（complete 用）
  const toolIndex = new Map();  // callId → tools 下标，用于回填状态
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s || s[0] !== '{') continue;
    let ev;
    try { ev = JSON.parse(s); } catch { continue; }
    const sid = ev.sessionId ?? ev.session_id ?? ev.session;
    if (typeof sid === 'string' && sid) sessionId = sid;
    const type = String(ev.type ?? ev.kind ?? ev.event ?? '');
    // thinking：思维链文本
    if (type === 'thinking' && typeof ev.text === 'string' && ev.text.trim()) { thinking.push(ev.text.trim()); continue; }
    // tool_call / tool_result：工具调用与结果状态
    if (type === 'tool_call' || type === 'tool_result') {
      const callId = ev.callId ?? ev.call_id ?? ev.id;
      if (type === 'tool_call') {
        toolIndex.set(callId, tools.length);
        tools.push({ tool: ev.tool ?? ev.name, input: ev.input, status: 'running' });
      } else if (callId != null && toolIndex.has(callId)) {
        tools[toolIndex.get(callId)].status = ev.status ?? 'completed';
      }
      continue;
    }
    // text：执行中的正文；final：最终总结
    const t = ev.text ?? ev.message ?? ev.content ?? ev.delta?.text ?? ev.data?.text;
    if (typeof t === 'string' && t) {
      if (type === 'final') final = t;
      else if (/text|message|assistant|done/i.test(type) || !type) {
        final = t;                       // 兼容旧格式：最后一条 text 当最终回答
        texts.push(t);
      }
    }
  }
  const text = (final || (texts.length ? texts[texts.length - 1] : '')).trim();
  return { text, final: text, texts, tools, thinking, sessionId };
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
  // 群上下文（④）：只有群聊、且被 @ 时才注入；私聊没有「群」可注入。
  // 自动压缩后的摘要（⑤）要放在最前面：新会话没有前文，靠它接上。
  const ctxBlock = info.kind === 'group' ? groupCtx.buildBlock(info.groupId) : '';
  const summary = summaries[info.key] ? '[之前会话的摘要]\n' + summaries[info.key] + '\n\n' : '';
  const prev = sessions[info.key] || '';
  // 交互提示只给真 DSH 注入：echo 是自测后端，没有会话，拼进去只会污染已有回归测试的输出。
  // 判断依据是「这个 DSH 会话是否已经拼过」；进程重启后 Set 清空，重注一次无害。
  const hint = cfg.backend !== 'echo' && cfg.interactionsEnabled
    ? interactionHint({ maxActions: cfg.interactionsMax, groupPoke: cfg.interactionsGroupPoke })
    : '';
  const needHint = !!hint && (!prev || !hintedSessions.has(prev));
  // 引用回复：能读到就带上原话；读不到就明确说不可读，不让模型猜。
  let task = info.text;
  if (info.repliedTo) task = formatQuoteContext(info.quote || { ok: false }) + task;
  // 文字 + 语音/文件：告诉模型“还有一部分没读到”，避免它假装看过。
  if (info.unsupported && info.unsupported.length) {
    task += (task ? '\n\n' : '') + unsupportedTaskNote(info.unsupported);
  }
  const prompt = summary + ctxBlock + task + (needHint ? '\n\n' + hint : '');
  /** 目的：标记某个会话已拼过提示；新区块要等 DSH 返回 sessionId 才知道。副作用：改内存 Set、写日志。 */
  const markHint = (sessionId) => {
    const id = sessionId || prev;
    if (!needHint || !id || hintedSessions.has(id)) return;
    hintedSessions.add(id);
    log('info: 交互提示已注入', info.key, 'session=' + String(id).slice(0, 8));
  };
  if (cfg.backend === 'echo') {
    const out = await runEcho(prompt);
    return { ...out, final: out.text, texts: [out.text], tools: [], thinking: [] };
  }
  try {
    const events = await runHeadless(prompt, prev, info.key);
    if (events.sessionId && events.sessionId !== prev) { sessions[info.key] = events.sessionId; saveSessions(); }
    markHint(events.sessionId);
    return events;
  } catch (e) {
    // DSH 的会话文件被删/回滚后，--session-id 会报 unknown；保留映射会让该聊天以后每条都失败。
    if (!prev || !/unknown|not found|no such|不存在|未知/i.test(String(e.message))) throw e;
    log('warn: 会话失效，重开', info.key, redactText(e.message));
    delete sessions[info.key];
    saveSessions();
    const events = await runHeadless(prompt, '', info.key);
    if (events.sessionId) { sessions[info.key] = events.sessionId; saveSessions(); }
    markHint(events.sessionId);
    record('skip', info.key, 0, 'DSH 会话失效，已重开');
    return events;
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

// ---------- 自动压缩 ----------
/**
 * 目的：同一聊天聊满 N 轮后，先让 DSH 把前文压成摘要，再丢掉会话映射——
 *       下一轮开新会话并把摘要放在最前面，靠它接上（headless 没有 /compact，只能这么做）。
 * 输入：info（当前消息）；轮数取 chatStats.messages，阈值取 cfg.autoCompactRounds。
 * 输出：无（fire-and-forget）。
 * 失败：抛错由调用方 catch 并记 warn，不影响已经发出去的回答。
 * 副作用：spawn 一次 DSH、写 summaries 与 sessions、清掉会话映射。
 */
async function maybeAutoCompact(info) {
  const n = cfg.autoCompactRounds;
  if (!n) return;
  const st = chatStats.get(info.key) || { messages: 0 };
  if (!st.messages || st.messages % n !== 0) return;
  const sid = sessions[info.key];
  if (!sid) return;
  const started = Date.now();
  const prompt = '请把这次会话到目前为止的要点压缩成一段不超过 400 字的摘要，直接输出摘要正文，不要客套、不要列清单以外的内容。';
  const ev = await runHeadless(prompt, sid, '');
  const sum = String(ev.final || '').trim();
  if (!sum) { record('skip', info.key, Date.now() - started, '自动压缩：DSH 没给出摘要'); return; }
  summaries[info.key] = sum.slice(0, 800);
  saveSummaries();
  delete sessions[info.key];
  saveSessions();
  record('ok', info.key, Date.now() - started, '自动压缩：已换新会话（摘要 ' + sum.length + ' 字）');
  log('compact', info.kind, info.key, '摘要 ' + sum.length + ' 字');
}

// ---------- 命令 ----------
/**
 * 目的：执行桥接器本地命令（不经过 DSH、不进队列），并把回执发回聊天。
 * 输入：info（来自 classifyEvent）、parsed（parseCommand 的结果）、role（user/admin/owner）。
 * 输出：'handled' 表示已处理；'passthrough' 表示要交给 DSH。
 * 失败：回发失败进补发队列；命令本身不抛错。
 * 副作用：改 sessions/notices/cmdHits/counts，发网络请求。
 */
async function handleCommand(info, parsed, role) {
  const started = Date.now();
  const c = parsed.cmd;
  const say = async (text, note) => {
    const body = String(text || '').slice(0, MAX_REPLY_CHARS);
    try {
      await deliver(info, body);
      counts.ok++;
      record('ok', info.key, Date.now() - started, note || ('命令 /' + (c ? c.name : parsed.name)));
    } catch (e) {
      counts.failed++;
      enqueueOutbox(info, body, e);
      record('fail', info.key, Date.now() - started, '命令回执入补发队列');
      log('fail:cmd', info.kind, info.key, redactText(e.message));
    }
  };

  if (!c) {
    cmdHits['?unknown'] = (cmdHits['?unknown'] || 0) + 1;
    await say(unknownCommandText(parsed.name));
    return 'handled';
  }
  cmdHits[c.name] = (cmdHits[c.name] || 0) + 1;
  if (c.kind === 'passthrough') return 'passthrough';
  if (!roleAtLeast(role, c.role)) {
    await say('没有权限：/' + c.name + ' 需要 ' + c.role + '。当前角色：' + role);
    return 'handled';
  }
  if (c.kind === 'pending') { await say(pendingCommandText(c)); return 'handled'; }

  switch (c.name) {
    case 'help':
      await say(parsed.args ? helpFor(parsed.args) : helpText());
      return 'handled';
    case 'ping':
      await say('pong · 已运行 ' + Math.round((Date.now() - startedAt) / 1000) + ' 秒 · 后端 ' + cfg.backend);
      return 'handled';
    case 'status': {
      const sid = sessions[info.key] || '';
      const st = chatStats.get(info.key) || {};
      const lines = [
        '后端：' + cfg.backend,
        '监听：' + cfg.listen,
        '会话：' + (sid ? maskChatKey(sid) : '还没有（下一条消息会新建）'),
        '本聊天：' + (st.messages || 0) + ' 条 · 最近 ' + (st.lastMs ? st.lastMs + 'ms' : '-'),
        '策略：' + describePolicy(policy) + (policy.hardened ? '' : '（未加固）'),
        '你的角色：' + role,
        '计数：收到 ' + counts.incoming + ' · 成功 ' + counts.ok + ' · 失败 ' + counts.failed
          + ' · 跳过 ' + counts.skipped + ' · 策略拒 ' + counts.denied,
      ];
      await say(lines.join('\n'));
      return 'handled';
    }
    case 'new':
      delete sessions[info.key];
      saveSessions();
      await say('已开新会话' + (parsed.args ? '（' + parsed.args + '）' : '') + '，下一条消息生效；旧会话仍在 DSH 里');
      return 'handled';
    case 'stop': {
      const child = runningChild.get(info.key);
      if (!child) { await say('现在没有在跑的回合'); return 'handled'; }
      try { child.kill('SIGTERM'); } catch (e) { log('warn: /stop kill 失败', e.code || e.message); }
      setTimeout(() => { try { if (!child.killed) child.kill('SIGKILL'); } catch {} }, 1200).unref();
      await say('已中断当前回合');
      return 'handled';
    }
    case 'sessions': {
      if (parsed.args === 'all' && !roleAtLeast(role, 'admin')) { await say('没有权限：/sessions all 需要 admin'); return 'handled'; }
      const keys = parsed.args === 'all' ? [...new Set([...Object.keys(sessions), ...chatStats.keys()])] : [info.key];
      if (!keys.length) { await say('还没有任何会话'); return 'handled'; }
      const rows = keys.slice(0, 20).map((k) => {
        const sid = sessions[k] || '(未建立)';
        const st = chatStats.get(k) || {};
        return '· ' + maskChatKey(k) + ' → ' + maskChatKey(sid) + ' · ' + (st.messages || 0) + ' 条';
      });
      await say('会话（' + keys.length + ' 个）：\n' + rows.join('\n'));
      return 'handled';
    }
    case 'session': {
      const sub = (parsed.args.split(/\s+/)[0] || 'info').toLowerCase();
      if (sub === 'new') {
        delete sessions[info.key];
        saveSessions();
        await say('已开新会话，下一条消息生效');
        return 'handled';
      }
      if (sub === 'use') {
        if (!roleAtLeast(role, 'admin')) { await say('没有权限：/session use 需要 admin'); return 'handled'; }
        const id = parsed.args.split(/\s+/)[1] || '';
        if (!/^[A-Za-z0-9._:-]{6,}$/.test(id)) { await say('用法：/session use <DSH 会话 id>'); return 'handled'; }
        sessions[info.key] = id;
        saveSessions();
        await say('已切到会话 ' + maskChatKey(id) + '（如果 DSH 那边不存在，下一条会收到它的报错）');
        return 'handled';
      }
      const sid = sessions[info.key] || '';
      const st = chatStats.get(info.key) || {};
      await say('会话：' + (sid ? maskChatKey(sid) : '还没有') +
        '\n本聊天：' + (st.messages || 0) + ' 条 · 最近 ' + (st.lastMs ? st.lastMs + 'ms' : '-') +
        '\n用法：/session info | new | use <id>');
      return 'handled';
    }
    case 'output': {
      const arg = parsed.args.trim().toLowerCase();
      if (!arg || arg === '--help') { await say(tierListText(tierOf(info.key))); return 'handled'; }
      if (!isTier(arg)) {
        await say('没有这个档位：' + arg + '\n可选：' + ['minimalist', 'concise', 'detailed', 'complete'].join(' / ') + '\n用 /output 看当前档位');
        return 'handled';
      }
      tiers[info.key] = arg;
      saveTiers();
      await say('输出档位已切到：' + describeTier(arg) + '\n下一轮生效。');
      return 'handled';
    }
    case 'context': {
      if (info.kind !== 'group') { await say('这个聊天没有群上下文（只有群聊才有）'); return 'handled'; }
      if (parsed.args.toLowerCase() === 'clear') {
        if (!roleAtLeast(role, 'admin')) { await say('没有权限：/context clear 需要 admin'); return 'handled'; }
        groupCtx.clear(info.groupId);
        await say('已清掉本群的上下文缓冲');
        return 'handled';
      }
      const st = groupCtx.stats();
      const mine = groupCtx.recent(info.groupId, cfg.groupContextMax);
      if (!mine.length) { await say('本群还没有上下文缓冲（' + groupCtx.describe() + '）'); return 'handled'; }
      const block = groupCtx.buildBlock(info.groupId);
      const span = mine.length ? Math.round((mine[mine.length - 1].at - mine[0].at) / 1000) + ' 秒' : '-';
      const preview = block ? block.split('\n').slice(0, 5).join('\n') : '(下一条不会注入：历史不足或已关闭)';
      await say('本群缓冲：' + mine.length + ' 条 · 跨度 ' + span + '\n全局：' + st.groups + ' 个群 / ' + st.messages + ' 条\n' +
        groupCtx.describe() + '\n\n下一条会注入：\n' + preview.slice(0, 600));
      return 'handled';
    }
    case 'policy': {
      const head = '策略：' + describePolicy(policy) + (policy.hardened ? '' : '（未加固）') +
        '\n来源：' + policyState.source + '\n你的角色：' + role;
      if (!parsed.args) { await say(head); return 'handled'; }
      // 拿用户给的文本当一条假消息，告诉他会不会回、为什么
      const verdict = decidePolicy(policy, {
        isGroup: info.kind === 'group', userId: info.userId, groupId: info.groupId,
        mentioned: true, selfId: info.selfId,
      });
      await say(head + '\n\n对「' + parsed.args.slice(0, 60) + '」这类消息：' +
        (verdict.ok ? '会回' : '不会回（' + explainWhy(verdict.why) + '）'));
      return 'handled';
    }
    case 'notice': {
      const arg = parsed.args.toLowerCase();
      if (!arg) {
        await say('本聊天的使用提示：' + (notices.get(info.key) === false ? '已关' : '开着') + '\n用法：/notice off | on');
        return 'handled';
      }
      if (arg !== 'off' && arg !== 'on') { await say('用法：/notice off | on'); return 'handled'; }
      notices.set(info.key, arg === 'on');
      await say('本聊天的使用提示已' + (arg === 'on' ? '打开' : '关掉'));
      return 'handled';
    }
    default:
      await say(pendingCommandText(c));
      return 'handled';
  }
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

  const classified = await classifyEvent(ev);
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
  // 群上下文（④）：先记下来，再判策略——群里没 @ 的闲聊也要进缓冲，
  // 否则被 @ 的时候上下文是空的，等于没有上下文。
  if (info.kind === 'group') {
    groupCtx.record({ groupId: info.groupId, userId: info.userId, name: info.name, text: info.text, at: Date.now(), messageId: info.messageId });
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

  // 空正文：只发了语音/文件，或只“回复机器人”没写字。直接回一句说明，不进模型、不烧回合。
  // 旧版 default 分支会把这类消息静默吞掉，用户发了语音机器人什么都不回；这里明确回。
  if (!info.text) {
    const note = info.unsupported && info.unsupported.length
      ? unsupportedReply(info.unsupported)
      : '（空消息）';
    counts.incoming++;
    try {
      await deliver(info, note);
      counts.ok++;
      record('skip', info.key, 0, info.unsupported && info.unsupported.length
        ? '不支持的消息类型：' + info.unsupported.join(',')
        : '空消息');
    } catch (e) {
      counts.failed++;
      enqueueOutbox(info, note, e);
      record('fail', info.key, 0, '不支持/空消息提示入补发队列');
      log('fail:note', info.kind, info.key, redactText(e.message));
    }
    return;
  }

  // 命令（②）：本地命令当场处理、不进队列——否则 /stop 会排在自己要停的那一轮后面，
  // 永远等不到执行。只有 DSH 原生命令（/compact 等）才落到队列里透传。
  const parsed = parseCommand(info.text);
  if (parsed) {
    const role = commandRole(policy, { userId: info.userId });
    const outcome = parsed.cmd && parsed.cmd.kind === 'passthrough'
      ? 'passthrough'
      : await handleCommand(info, parsed, role).catch((e) => {
        log('fail:cmd', info.kind, info.key, redactText(e.message));
        return 'handled';
      });
    if (outcome === 'handled') { counts.incoming++; alertGate.recordSuccess(); return; }
  }

  counts.incoming++;
  enqueue(info.key, async () => {
    const started = Date.now();
    // 输入状态（③ 的漏项）：私聊里先亮「正在输入…」；群里 NapCat 不支持，直接关。
    const typing = createTyping({
      enabled: cfg.typingEnabled && info.kind === 'private',
      keepaliveMs: cfg.typingKeepaliveMs,
      send: (type) => sendInputStatus(info, type),
      onError: (e) => log('warn: 输入状态失败', redactText((e && e.message) || String(e))),
    });
    typing.start();
    try {
      const events = await askDsh(info);
      // 输出档位（⑤）：同一轮事件，按当前聊天选的档位渲染成要发的文字
      const tier = tierOf(info.key);
      const rendered = renderByTier(events, tier).trim();
      const rawReply = rendered || events.final || '';
      // 交互动作（P0-1）：先从正文里摘出动作，再发正文；关闭时标记原样保留。
      // 先发正文、后执行动作，保证「动作慢/失败」不会挡在正文前面；撤回才需要等气泡都发完。
      const parsed = cfg.interactionsEnabled
        ? parseActions(rawReply, { maxActions: cfg.interactionsMax })
        : { text: rawReply, actions: [], ignoredActions: [] };
      if (parsed.ignoredActions.length) {
        log('warn: 忽略多余动作', info.key, parsed.ignoredActions.map((a) => a.kind).join(','));
      }
      let reply = parsed.text;
      const actionOnly = !reply && parsed.actions.length > 0;
      // 纯动作回复不发空消息；只有「模型真没内容且没有动作」时才保留旧的兜底文案。
      if (!reply && !actionOnly) reply = '（DSH 没有返回内容）';
      // 群首次触发：披露 AI 身份与本群会话隔离；只发一次，纯动作轮不发。
      if (reply && info.kind === 'group' && cfg.aiDisclosure && !disclosedChats.has(info.key)) {
        disclosedChats.add(info.key);
        reply += '\n\n' + disclosureText({
          memberScoped: cfg.groupSessionScope === 'member',
          groupReplyAt: cfg.groupReplyAt,
        });
      }
      // 群回复 @ 提问者：只给第一条气泡，后续不重复 @。
      const sendOpts = info.kind === 'group' && cfg.groupReplyAt ? { atUserId: info.userId } : undefined;
      // recall 只删这份；先取快照，避免本轮发完正文后被覆盖成 currentIds。
      const prevIds = lastBubbles.get(info.key) || [];
      let messageIds = [];
      try {
        if (reply) {
          const sent = await deliverHuman(info, reply, sendOpts);
          if (sent.bubbles > 1) { counts.bubbles += sent.bubbles; lastPlan = { bubbles: sent.bubbles, chars: reply.length, at: Date.now() }; }
          messageIds = sent.messageIds || [];
        }
      } catch (sendErr) {
        // DSH 已经算出了答案，只是发不出去：进补发队列，别把答案丢了，也别再发一条「出错了」。
        enqueueOutbox(info, sendErr.remaining || reply, sendErr);
        const ms = Date.now() - started;
        counts.failed++;
        record('fail', info.key, ms, '回复已入补发队列（回发失败）');
        log('fail:send', info.kind, info.key, redactText(sendErr.message));
        noteFailure('回发失败：' + sendErr.message);
        return;
      }
      // 正文已送达（或本轮是纯动作），本轮的 id 变成下一轮的「上一轮」。
      // 纯动作轮存空数组：下一轮 recall 会按「没有上一轮气泡」skipped，而不是删更早的一轮。
      lastBubbles.set(info.key, messageIds);

      // 正文已送达（或本轮是纯动作）再执行动作；总时限/失败只记 warn，不影响上面的正文。
      let act = { executed: 0, failed: 0, skipped: 0, errors: [] };
      if (parsed.actions.length) {
        try {
          act = await runActions(parsed.actions, { info, currentIds: messageIds, prevIds }, {
            api: cfg.napcatApi,
            token: cfg.napcatToken,
            groupPoke: cfg.interactionsGroupPoke,
            maxActions: cfg.interactionsMax,
            timeoutMs: cfg.interactionsTimeoutMs,
          });
        } catch (e) {
          // runActions 约定不抛错；这里只是最后一道保险，别让动作把整轮打成失败。
          act = { executed: 0, failed: parsed.actions.length, skipped: 0, errors: [{ kind: '?', message: String((e && e.message) || e) }], warnings: [] };
        }
        interactionTotals.turns++;
        interactionTotals.executed += act.executed;
        interactionTotals.failed += act.failed;
        interactionTotals.skipped += act.skipped;
        for (const w of act.warnings || []) log('warn: ' + w);
        for (const err of act.errors) log('warn: 动作执行异常', err.kind, redactText(err.message));
      }
      // 面板的「本轮」要每轮刷新：这一轮没有动作时也显示 0 个，而不是停在上一轮的数字上。
      lastInteractions = {
        at: Date.now(),
        executed: act.executed,
        failed: act.failed,
        skipped: act.skipped,
        kinds: parsed.actions.map((a) => a.kind),
      };

      const ms = Date.now() - started;
      counts.ok++;
      alertGate.recordSuccess();
      // 自动压缩（⑤）：聊满 N 轮就把前文压成摘要、换新会话；后台做，不拖慢这一轮。
      maybeAutoCompact(info).catch((e) => log('warn: 自动压缩失败', redactText(e.message)));
      relay.ok();
      const st = chatStats.get(info.key) || { messages: 0 };
      chatStats.set(info.key, { messages: st.messages + 1, lastAt: Date.now(), lastMs: ms });
      const note = actionOnly
        ? '纯动作 ' + act.executed + '/' + parsed.actions.length
        : reply.length + ' 字' + (parsed.actions.length ? ' · 动作 ' + act.executed + '/' + parsed.actions.length : '');
      record('ok', info.key, ms, note);
      log('ok', info.kind, info.key, `${ms}ms`, reply.length + '字');
    } catch (e) {
      const ms = Date.now() - started;
      counts.failed++;
      const st = chatStats.get(info.key) || { messages: 0 };
      chatStats.set(info.key, { messages: st.messages, lastAt: Date.now(), lastMs: ms });
      record('fail', info.key, ms, e.message);
      log('fail', info.kind, info.key, redactText(e.message));
      noteFailure(e.message);
      // 维护期自动回复（⑤）：连续失败到阈值就统一回维护文案，冷却内不再重复。
      relay.fail();
      const r = relay.shouldRelay();
      const errText = r.relay ? r.text : `出错了：${redactText(e.message).slice(0, 200)}`;
      if (r.relay) record('skip', info.key, ms, '进入维护期，已回维护文案');
      try { await deliver(info, errText); } catch (e2) { log('fail:reply', redactText(e2.message)); }
    } finally {
      // 成功、失败、提前 return 都要关：否则对面会一直看到「正在输入…」。
      typing.stop();
      counts.typingMsgs += typing.stats().sent > 0 ? 1 : 0;
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
