/**
 * 目的：桥接核心：OneBot 事件 → 策略/指令 → DSH 回合 → QQ 回复。
 * 边界：不做网络监听和进程启动；这些由 index/onebot 负责。
 * 依赖：onebot、dsh、persona、interactions、policy、session-*、export。
 * 失败：单条失败回错误摘要；进程级错误由 index 退出。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { logger } from './log.js';
import { JsonStore } from './store.js';
import { runDsh, killChildTree } from './dsh.js';
import {
  runBridgeCommand, parseCommand, describeReferences,
  helpText, unknownCommandText, retiredCommandText, looksLikeCommand
} from './commands.js';
import { createPersona } from './persona.js';
import { createGroupContext } from './group-context.js';
import { createInteractions, parseActions, systemHint } from './interactions.js';
import { createDshApi, foldTurnRecords, findRequestSeq } from './dsh-api.js';
import { decidePolicy, describePolicy, normalizePolicy, commandRole, roleAtLeast, maskChatKey } from './policy.js';
import { sessionExists } from './session-info.js';
import {
  listLocalSessions, mergeSessionSummaries, findSessionRef,
  validateSessionForResume, timeLabel
} from './session-meta.js';
import { buildSessionZip } from './export.js';
import { SessionRegistry, chatKeyFor } from './session-manager.js';

const log = logger('bridge');

class Semaphore {
  constructor(n) {
    this.free = Math.max(1, n | 0);
    this.total = this.free;
    this.waiting = [];
    this.draining = false;
  }
  acquire() {
    if (this.draining) return Promise.reject(new Error('正在重启，暂不接新任务'));
    if (this.free > 0) { this.free--; return Promise.resolve(); }
    return new Promise((resolve, reject) => this.waiting.push({ resolve, reject }));
  }
  release() {
    const next = this.waiting.shift();
    if (next) next.resolve();
    else this.free++;
  }
  /** 进入排空：拒绝新任务，等在跑的任务收尾。 */
  drain() { this.draining = true; }
  /** 当前在跑的数量（总数 - 空闲）。 */
  get busy() { return this.total - this.free; }
  /** 等待所有在跑任务结束。 */
  async settle(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (this.busy > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    return this.busy === 0;
  }
}

/** 把 CQ 码字符串还原成消息段。 */
function fromCqString(s) {
  const segments = [];
  const re = /\[CQ:([a-zA-Z_]+)((?:,[^\]]*)?)\]/g;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) segments.push({ type: 'text', data: { text: s.slice(last, m.index) } });
    const data = {};
    for (const kv of (m[2] || '').replace(/^,/, '').split(',')) {
      if (!kv) continue;
      const i = kv.indexOf('=');
      if (i > 0) data[kv.slice(0, i)] = kv.slice(i + 1);
    }
    segments.push({ type: m[1].toLowerCase(), data });
    last = re.lastIndex;
  }
  if (last < s.length) segments.push({ type: 'text', data: { text: s.slice(last) } });
  return segments;
}

function normalize(msg, selfId) {
  const raw = msg.message ?? msg.raw_message ?? '';
  const segments = Array.isArray(raw) ? raw : fromCqString(String(raw));
  let text = '';
  const images = [];
  const unsupported = [];
  let mentioned = false;
  let repliedTo = null;
  for (const seg of segments) {
    const data = seg.data || {};
    switch (seg.type) {
      case 'text': text += data.text || ''; break;
      case 'at': if (String(data.qq) === String(selfId)) mentioned = true; break;
      case 'image': { const src = data.url || data.file || ''; if (src) images.push(src); break; }
      case 'face': text += '[表情]'; break;
      case 'reply': repliedTo = data.id || null; break;
      case 'poke': text += '[戳一戳]'; break;
      // 这些类型以前被 default 静默吞掉：用户发了语音/文件，机器人什么都不回。
      // 现在记下来，由入站层给一句“暂不支持”的明确提示。
      case 'record':
      case 'video':
      case 'file':
      case 'forward':
      case 'json':
      case 'xml':
      case 'markdown':
        unsupported.push(seg.type);
        break;
      default: break;
    }
  }
  return { text: text.trim(), images, mentioned, repliedTo, unsupported: [...new Set(unsupported)] };
}

/** session-xxxx → xxxx（日志/事件里短一点更好读） */
function short(id) {
  return String(id || '').replace(/^session-/, '').slice(0, 8);
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, Number(ms) || 0)));
}

/** 私网/回环/链路本地/多播地址；图片下载默认不允许。导出便于单测。 */
export function isPrivateAddress(ip) {
  const s = String(ip || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
  if (!s) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4) {
    const p = v4.slice(1).map(Number);
    if (p.some((n) => n < 0 || n > 255)) return true;
    return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      p[0] >= 224;
  }
  if (s.includes(':')) {
    if (s === '::' || s === '::1') return true;
    if (s.startsWith('fe80:') || s.startsWith('fc') || s.startsWith('fd')) return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
    if (mapped) return isPrivateAddress(mapped[1]);
    return false;
  }
  return false;
}

/**
 * 图片 URL 的 SSRF 防线：只允许 http/https；默认拒绝 localhost/私网。
 * DNS 解析后逐个地址检查，降低“域名指向 127.0.0.1”这类绕过。
 */
async function assertPublicImageUrl(url, { allowPrivate = false } = {}) {
  if (allowPrivate) return;
  const host = String(url.hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new Error('不允许访问本机/内网图片地址');
  }
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) throw new Error('不允许访问私网图片地址');
    return;
  }
  let rows;
  try { rows = await lookup(host, { all: true, verbatim: true }); }
  catch (err) { throw new Error('图片域名解析失败：' + (err && err.message)); }
  if (!rows.length) throw new Error('图片域名没有解析结果');
  for (const row of rows) {
    if (isPrivateAddress(row.address)) throw new Error('图片域名解析到私网地址，已拒绝');
  }
}

/** 把一个已完成的动作翻译成一行事件文案。 */
function describeAction(res) {
  if (!res) return '小动作';
  switch (res.action) {
    case 'react': return '表情回应 emoji=' + res.emojiId + '（消息 ' + res.messageId + '）';
    case 'recall': return '撤回消息 ' + (Array.isArray(res.messageIds) ? res.messageIds.length + ' 条' : res.messageId);
    case 'poke': return '戳一戳 ' + res.userId;
    case 'read': return '标记已读';
    case 'like': return '名片赞 ×' + res.times;
    default: return String(res.action || '小动作');
  }
}

function chunk(text, limit) {  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n+/, '');
  }
  if (rest.length) parts.push(rest);
  return parts;
}

export class Bridge {
  constructor(config, paths, status) {
    this.config = config;
    this.paths = paths;
    this.status = status;
    this.store = new JsonStore(paths.stateFile);
    this.chats = this.store.get('chats', {});
    // 会话归属表：chatKey -> DSH sessionId。每条记录就是一条真实 DSH 会话，
    // 不另造本地会话 id；它负责 1:1 归属和跨聊天隔离。
    this.sessionRegistry = new SessionRegistry(this.chats, {
      save: () => this.saveChats(),
      // 强制转移/解绑时让原聊天的在跑回合立刻 stale，避免它把 sessionId 写回来。
      onDetach: (key) => {
        if (!this.bindingGen) return;
        this.bindingGen.set(key, (this.bindingGen.get(key) ?? 0) + 1);
      }
    });
    this.locks = new Map();
    this.active = new Map();
    // 插话（打断）相关：
    //   turnGen     chatKey -> 代数。每轮开跑 +1；被打断时也 +1，于是旧回合的
    //               isCurrent() 立刻为假——它之后不再投递、不再改计数（内容另作上下文转交）。
    //   currentTurn chatKey -> { gen, text, startedAt }，用于知道"被打断的是哪句话"，
    //               好把这句话作为上下文交给新的一轮。
    this.turnGen = new Map();
    this.currentTurn = new Map();
    this.running = new Map();   // chatKey -> ChildProcess，供 /stop 用
    // P1-01：绑定代数。切会话/切工作区/new 时 +1；回合写回前对比，不一致就丢弃，
    // 避免“回合中 /ws 切走、回合结束又写回旧会话”把用户的选择覆盖掉。
    this.bindingGen = new Map();
    // 命令改 chat 状态用短锁；它不等整轮 dsh，和 turn 的串行锁分开。
    this.stateLocks = new Map();
    // 群首次触发披露 AI 身份用（每个群一次，进程内）。
    this.disclosedChats = new Set();
    this.semaphore = new Semaphore(config.dsh.maxConcurrent ?? 1);
    this.persona = createPersona(config.behavior?.humanize, config.behavior);
    // 群聊缓冲：没 @ 我的消息也记，被 @ 时把最近几条拼进提示词（纯内存，不落盘）。
    this.groupContext = createGroupContext(config.behavior?.groupContext || {});
    // QQ 侧小动作（表情回应/撤回/戳一戳/已读/名片赞）。需要 onebot 实例，
    // 所以在 attach() 里真正构造；这里先占位，保证 /status 早调用也不炸。
    this.interactions = createInteractions(null, config.behavior?.interactions, {});
    this.interactionHint = systemHint(this.interactions.cfg, this.persona.target.burst);
    // 会话传输层：api = 常驻 dsh web（Host 持写句柄、会话进侧边栏、不 spawn）；
    // headless = 旧的一次性 spawn（兼容/逃生舱）；auto = 能连上 web 就用 api。
    this.dshApi = createDshApi({ ...(config.dsh || {}) });
    this.transportMode = 'unknown';
    this.transportError = null;
    // chatKey -> { sessionId, requestId, aborted, started }，供 /stop 与插话打断。
    this.hostRunning = new Map();
    // /sessions 的编号缓存：chatKey -> { workspace, ids, at }，让 /ws 2 这类用法可用。
    this.sessionIndex = new Map();
    // 访问策略在 index 启动时已校验；这里再 normalize 一次，方便单测直接 new Bridge。
    this.policy = normalizePolicy(config.policy);
    this.recentDenied = [];
    this.shuttingDown = false;
    // turn 级 in-flight：排队、dsh、投递、落盘都算；semaphore 只表示 dsh 槽位。
    this.inflight = new Map();
    this.turnSeq = 0;
    this.deliveryStats = { delivered: 0, failed: 0 };
    // 最小 outbox：发送失败/退出时未发内容落盘，启动后有限次重试。
    this.outboxStore = new JsonStore(path.join(paths.stateDir, 'outbox.json'));
    const savedOutbox = this.outboxStore.get('entries', []);
    this.outboxEntries = Array.isArray(savedOutbox) ? savedOutbox : [];
    this.outboxRetrying = false;
    // DSH 现场命令表：/help 与未知指令提示都用它，避免桥接器维护会漂移的清单
    this.dshCommands = null;
    this.loadDshCommands();
    this.#migrate();
  }

  /** 兼容早期只有 { sessionId, turns } 的结构。 */
  #migrate() {
    let changed = false;
    for (const [key, value] of Object.entries(this.chats)) {
      if (!value || !value.sessions) {
        const ws = this.paths.workspace;
        this.chats[key] = {
          workspace: ws,
          sessions: value && value.sessionId ? { [ws]: { sessionId: value.sessionId, turns: value.turns || 0 } } : {},
          seed: null,
          model: null
        };
        changed = true;
      }
      const chat = this.chats[key];
      // 旧版本把交互提示拼进每一条用户消息，所以这些历史会话一定已经“提示过”。
      // 升级时把它们标记掉，避免新版本再补一份（用户抱怨的“prompt 重复注入”）。
      const ids = new Set();
      for (const slot of Object.values(chat.sessions || {})) {
        if (slot && slot.sessionId) ids.add(String(slot.sessionId));
      }
      for (const prev of Array.isArray(chat.previousSessions) ? chat.previousSessions : []) {
        if (prev && prev.sessionId) ids.add(String(prev.sessionId));
      }
      for (const id of Object.keys(chat.sessionTurns || {})) ids.add(String(id));
      if (chat.sessionTransports) {
        // 旧版本的“按会话选传输”已废弃：所有会话都对应 DSH 会话。
        delete chat.sessionTransports;
        changed = true;
      }
      if (ids.size) {
        if (!chat.hintSessions || typeof chat.hintSessions !== 'object') chat.hintSessions = {};
        for (const id of ids) {
          if (!chat.hintSessions[id]) { chat.hintSessions[id] = 'pre-upgrade'; changed = true; }
        }
      }
    }
    if (changed) this.saveChats();
    // 旧状态没有 ownedSessions：把当前绑定/历史绑定补登记成 1:1 归属。
    this.sessionRegistry.migrate();
  }

  chat(chatKey) {
    let c = this.chats[chatKey];
    if (!c || !c.sessions) {
      c = {
        workspace: this.paths.workspace, sessions: {}, ownedSessions: {},
        hintSessions: {}, seed: null, model: null
      };
      this.chats[chatKey] = c;
    }
    if (!c.ownedSessions || typeof c.ownedSessions !== 'object') c.ownedSessions = {};
    if (!c.hintSessions || typeof c.hintSessions !== 'object') c.hintSessions = {};
    if (!c.sessions[c.workspace]) c.sessions[c.workspace] = { sessionId: null, turns: 0 };
    return c;
  }

  saveChats() { this.store.set('chats', this.chats); }

  /**
   * 启动时探测会话传输层。探测失败不阻止桥接器启动：
   *   transport=api      → 保持 api，消息会明确失败（绝不静默 spawn 新会话）
   *   transport=auto     → 退回 headless，并在日志/状态里标明“降级”
   *   transport=headless → 直接用一次性 spawn
   */
  async initTransport() {
    const configured = String(this.config.dsh?.transport || 'auto').toLowerCase();
    if (configured === 'headless') {
      this.transportMode = 'headless';
      this.transportError = null;
      this.updateTransportStatus({ ok: false, base: this.dshApi.base, reason: 'transport=headless' });
      log.info('会话传输层：headless（一次性 spawn；会话不进 DSH 侧边栏）');
      return this.transportMode;
    }
    const probe = await this.dshApi.probe();
    if (probe.ok) {
      this.transportMode = 'api';
      this.transportError = null;
      log.info('会话传输层：api ' + probe.base + '（会话由 DSH Host 持有，不再 spawn）');
    } else if (configured === 'api') {
      this.transportMode = 'api';
      this.transportError = probe.reason;
      log.error('会话传输层：api 不可用（' + probe.reason + '）。消息会明确失败，不会偷偷换 headless/新会话。');
    } else {
      this.transportMode = 'headless';
      this.transportError = probe.reason;
      log.warn('会话传输层：DSH web 不可用（' + probe.reason + '），已降级为 headless。' +
        ' 会话不会出现在侧边栏；写锁冲突时会明确报错，不再自动开新会话。');
    }
    this.updateTransportStatus(probe);
    return this.transportMode;
  }

  updateTransportStatus(probe = {}) {
    try {
      this.status.update((v) => {
        v.dsh.transport = this.transportMode;
        v.dsh.web = {
          base: this.dshApi.base,
          ok: probe.ok === true,
          error: probe.ok === true ? null : (probe.reason || this.transportError || null)
        };
      });
    } catch { /* 状态板在极早期可能还没准备好 */ }
  }

  async ensureTransport() {
    if (this.transportMode === 'unknown') await this.initTransport();
    return this.transportMode;
  }

  transportLabel() {
    if (this.transportMode === 'api') return 'api（' + this.dshApi.base + '）';
    if (this.transportMode === 'headless') return 'headless（一次性 spawn）';
    return '未知';
  }

  /** 这个会话是否已经注入过 QQ 交互提示。只在第一次进会话时注入。 */
  sessionHasHint(chat, sessionId) {
    return !!(chat && sessionId && chat.hintSessions && chat.hintSessions[sessionId]);
  }

  markSessionHint(chat, sessionId) {
    if (!chat || !sessionId) return;
    if (!chat.hintSessions || typeof chat.hintSessions !== 'object') chat.hintSessions = {};
    if (chat.hintSessions[sessionId]) return;
    chat.hintSessions[sessionId] = new Date().toISOString();
    this.saveChats();
  }



  /**
   * 把交互提示（[[br]] / [[react]] 等）拼进任务——**每个会话只拼一次**。
   * 以前每轮都拼，导致同一段提示词在会话历史里堆 N 份，既烧 token 又干扰模型。
   */
  withSessionHint(chat, sessionId, task) {
    if (!this.interactionHint) return task;
    if (this.sessionHasHint(chat, sessionId)) return task;
    return task + (task ? '\n\n' : '') + this.interactionHint;
  }

  /**
   * 把某个聊天的上下文绑定到 (工作区, 会话)——**唯一入口**。
   *
   * 切工作区、切会话、初始化都必须走这里：chat.workspace / chat.sessions /
   * saveChats / status 面板，四件事永远成套发生。以前每个调用点各写一遍，
   * 就会有人忘了 saveChats、或 status 里还挂着旧会话；命令层也因此被迫知道
   * 桥接器的内部结构（耦合）。
   *
   * @param {string} chatKey
   * @param {{workspace?:string, sessionId?:string|null, turns?:number, title?:string, force?:boolean}} target
   *        省略 workspace = 保持当前工作区；force 仅供管理命令显式转移归属
   * @returns {{workspace:string, sessionId:string|null}}
   */
  bindChatContext(chatKey, { workspace, sessionId = null, turns, title, force = false } = {}) {
    const chat = this.chat(chatKey);
    const ws = workspace || chat.workspace;
    // 先确认归属：一条 DSH 会话只能属于一个 QQ 聊天。冲突时抛
    // SessionOwnershipError，由命令层给出“它属于谁”的明确提示。
    if (sessionId) this.sessionRegistry.claim(chatKey, sessionId, { workspace: ws, title, force });
    chat.workspace = ws;
    if (!chat.sessions[ws]) chat.sessions[ws] = { sessionId: null, turns: 0 };
    const slot = chat.sessions[ws];
    // 先记下旧绑定，再写新 sessionId；否则“同会话才保留轮数”的判断永远为真，
    // 换到未知会话时会把上一条会话的 turns 误带过去。
    const prevSessionId = slot.sessionId;
    const prevTurns = slot.turns;
    slot.sessionId = sessionId;
    // undefined = 尽量恢复已知轮数（/ws 换会话）；null = 明确未知（不要伪造 0）。
    if (turns === undefined) {
      if (sessionId) {
        let known = null;
        if (chat.sessionTurns && Object.prototype.hasOwnProperty.call(chat.sessionTurns, sessionId)) {
          known = chat.sessionTurns[sessionId];
        } else if (prevSessionId && String(prevSessionId) === String(sessionId) &&
                   prevTurns !== null && prevTurns !== undefined) {
          // 兼容旧状态文件：没有 sessionTurns 映射时，至少保留同会话的已知轮数。
          known = prevTurns;
        }
        turns = known;
      } else {
        turns = 0;
      }
    }
    chat.sessions[ws].turns = turns;
    chat.sessions[ws].updatedAt = new Date().toISOString();
    if (sessionId && turns !== null && turns !== undefined) this.recordSessionTurns(chat, sessionId, turns);
    this.bindingGen.set(chatKey, (this.bindingGen.get(chatKey) ?? 0) + 1);
    this.saveChats();
    this.status.update((v) => {
      v.chats[chatKey] = { workspace: ws, sessionId, turns: chat.sessions[ws].turns ?? null };
    });
    this.status.emitEvent('action', (sessionId ? '绑定会话 ' + String(sessionId).replace(/^session-/, '').slice(0, 8)
      : '绑定工作区') + ' @ ' + maskChatKey(chatKey) + ' → ' + ws);
    return { workspace: ws, sessionId, turns };
  }

  bindingGeneration(chatKey) {
    return this.bindingGen.get(chatKey) ?? 0;
  }

  /** 每个会话的已知轮数：换回来时不能把 turns 归零，也不能假装 0。 */
  recordSessionTurns(chat, sessionId, turns) {
    if (!chat || !sessionId) return;
    if (!chat.sessionTurns || typeof chat.sessionTurns !== 'object') chat.sessionTurns = {};
    chat.sessionTurns[sessionId] = turns;
  }

  /** 命令改 chat 状态的短锁；不覆盖整轮 dsh，/ws 不必等回合结束。 */
  withStateLock(key, fn) {
    const prev = this.stateLocks.get(key) || Promise.resolve();
    const run = prev.then(() => fn(), () => fn());
    this.stateLocks.set(key, run.catch(() => {}));
    return run;
  }

  /**
   * 当前工作区的可续会话目录（本地文件头 + DSH session/list 合并）。
   * DSH web 不在时退回本地；查询失败不伪造“可续”。
   */
  async sessionCatalog(workspace, { chatKey = null } = {}) {
    const mode = await this.ensureTransport();
    const local = listLocalSessions(workspace);
    let apiItems = null;
    try {
      if (this.dshApi && this.dshApi.enabled && this.dshApi.listSessions) {
        apiItems = await this.dshApi.listSessions({ timeoutMs: 4000 });
      }
    } catch (err) {
      log.debug('session/list 失败，使用本地会话元数据: ' + (err && err.message));
    }
    const merged = mergeSessionSummaries(local, apiItems || [], workspace);
    if (mode === 'api') {
      const real = this.dshApi.canon ? this.dshApi.canon(workspace) : workspace;
      for (const e of merged) {
        const cwdOk = !e.cwd || (this.dshApi.canon ? this.dshApi.canon(e.cwd) : e.cwd) === real;
        const reasons = [];
        if (e.headerError) reasons.push('元数据不可读');
        if (e.origin === 'subagent') reasons.push('subagent 会话');
        if (e.parentSession) reasons.push('fork 出来的会话');
        if (!cwdOk) reasons.push('cwd 不匹配');
        e.reason = reasons.join('；') || null;
        e.resumable = reasons.length === 0;
        e.apiResumable = e.resumable;
        if (e.resumable && e.running) e.reason = '运行中（新消息会排队）';
      }
    }
    // 归属信息给 /session 用：owner 是 chatKey，ownedByMe 只看当前聊天。
    for (const e of merged) {
      const owner = this.sessionRegistry.ownerOf(e.id);
      e.owner = owner;
      e.ownedByMe = !!chatKey && owner === chatKey;
    }
    return merged;
  }

  /**
   * 显式新建一条 DSH 会话（/new 用）。
   * API 模式立刻建，并把 id 返回；headless 模式返回 null（下一条消息再 spawn）。
   * 这样 /new 是“真的多了一条 DSH 会话”，而不是桥接器自己记一个空位。
   */
  async createHostSession(cwd, { chatKey = null, title = null } = {}) {
    const mode = await this.ensureTransport();
    if (mode !== 'api') return null;
    const created = await this.dshApi.createSession({ cwd });
    if (!created || !created.sessionId) throw new Error('DSH 没有返回新会话 id');
    const sid = created.sessionId;
    // 建出来就登记归属，避免“会话建好了，但下一条消息又建一条”的空窗。
    if (chatKey) this.sessionRegistry.claim(chatKey, sid, { workspace: cwd, title });
    // 标题只是侧边栏可读性，失败不影响会话使用。
    if (title) await this.renameHostSession(sid, title);
    this.status.emitEvent('info', '显式新建 DSH 会话 ' + short(sid) + '（' + cwd + '）');
    return sid;
  }

  /** 给 DSH 会话改名；权限/网络失败都只记日志。 */
  async renameHostSession(sessionId, title) {
    if (!sessionId || !title) return null;
    try {
      const r = await this.dshApi.rename(sessionId, title);
      this.status.emitEvent('action', '重命名会话 ' + short(sessionId) + ' → ' + String(title).slice(0, 60));
      return r;
    } catch (err) {
      log.warn('重命名会话 ' + short(sessionId) + ' 失败: ' + (err && err.message));
      return null;
    }
  }

  currentModelLabel(chat) {
    const key = chat.model || this.config.dsh.defaultModel;
    const m = (this.config.dsh.models || {})[key];
    if (!m) return key || '（profile 默认）';
    return key + ' (' + m.provider + '/' + m.model + ')';
  }

  /** 当前聊天是否还有回合在排队/在跑（/ws 切换前用）。 */
  isChatBusy(chatKey) {
    if ((this.active.get(chatKey) ?? 0) > 0) return true;
    for (const t of this.inflight.values()) if (t.chatKey === chatKey) return true;
    return false;
  }

  /** 命令级角色（P1-21）：owner/admin/user；不打印号码。 */
  roleFor(userId, adminBypass = false) {
    return commandRole(this.policy, { userId, adminBypass });
  }

  /** /status、面板用的策略摘要；不打印完整号码。 */
  policySummary() {
    const p = this.policy;
    return {
      privateChat: p.privateChat,
      groupChat: p.groupChat,
      allowUsers: p.allowUsers.length,
      allowGroups: p.allowGroups.length,
      allowAllUsers: p.allowAllUsers,
      allowAllGroups: p.allowAllGroups,
      describe: describePolicy(p),
      preset: this.config.dsh?.permissionPreset || 'danger-full-access',
      presetSource: 'profile ' + (this.config.dsh?.profile || '—'),
      denied: this.status?.value?.counters?.denied || 0,
      recentDenied: this.recentDenied.slice(-5)
    };
  }

  presetLabel() {
    return {
      preset: this.config.dsh?.permissionPreset || 'danger-full-access',
      presetSource: 'profile ' + (this.config.dsh?.profile || '—')
    };
  }

  /** 守护心跳只读展示；文件不存在 = 外部自愈未运行。 */
  guardHealth() {
    const file = path.join(this.paths.stateDir, 'guard.health.json');
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { available: true, ...j };
    } catch {
      return { available: false, note: '没有 guard.health.json；外部自愈可能未运行' };
    }
  }

  /** 记录一次被策略拒绝的事件；只记脱敏目标与原因。 */
  noteDenied(why, chatKey) {
    if (why === 'self' || why === 'not-mentioned') return;
    const chat = maskChatKey(chatKey);
    const row = { at: new Date().toISOString(), chat, why };
    this.recentDenied.push(row);
    if (this.recentDenied.length > 20) this.recentDenied.splice(0, this.recentDenied.length - 20);
    try { this.status.count('denied'); } catch {}
    try { this.status.emitEvent('warn', '拒绝消息 ' + chat + '：' + why); } catch {}
  }

  cancelChat(chatKey) {
    // API 传输：先撤回还没轮到的排队消息；已经开始才 cancel。
    const host = this.hostRunning.get(chatKey);
    if (host) {
      host.aborted = true;
      if (host.started) {
        this.dshApi.cancel(host.sessionId).then(() => {
          log.info('已请求 DSH 中断会话 ' + short(host.sessionId));
        }).catch((err) => log.warn('DSH 中断失败: ' + (err && err.message)));
        return true;
      }
      // 还没开始：撤掉队列里的这条，避免它以后跑出来污染下一轮。
      this.dshApi.removeQueuedPrompt(host.sessionId, host.requestId).then((removed) => {
        if (removed) {
          // 这条消息没进历史：只有本轮真的拼过提示，才撤掉“已提示”标记。
          const chat = this.chat(chatKey);
          if (host.wantHint && chat && chat.hintSessions && chat.hintSessions[host.sessionId]) {
            delete chat.hintSessions[host.sessionId];
            this.saveChats();
          }
          log.info('已撤回排队中的消息（会话 ' + short(host.sessionId) + '）');
        } else {
          // 竞态：可能刚好开始，补一刀 cancel。
          this.dshApi.cancel(host.sessionId).catch(() => {});
        }
      }).catch((err) => log.warn('撤回排队消息失败: ' + (err && err.message)));
      return true;
    }
    const child = this.running.get(chatKey);
    if (!child) return false;
    // 先 SIGINT：让 dsh **优雅收尾**（把这一轮已经产生的东西落进会话），1.5s 还不走再 SIGKILL。
    // 早期直接 SIGKILL，被打断的那一轮在会话里等于没发生过——用户的原话是
    // "怎么能说作废呢"，对，打断不等于抹掉。
    try { killChildTree(child, 'SIGINT'); } catch (err) { log.debug('SIGINT 失败: ' + err.message); }
    const hard = setTimeout(() => {
      try { if (child.exitCode === null && child.signalCode === null) killChildTree(child, 'SIGKILL'); } catch {}
    }, 1500);
    if (hard.unref) hard.unref();
    try { child.once('exit', () => clearTimeout(hard)); } catch {}
    return true;
  }

  /**
   * 打断该会话当前这一轮（用户插话）。
   *
   * 两件事，顺序不能反：
   *   1. 先换代（turnGen+1）——从这一刻起旧回合**不再投递**（它已经发出去的气泡留着），
   *      也不会再改计数/状态。注意这是"停止投递"，不是"当作没发生"：被打断那一轮
   *      做过什么，会作为上下文交给下一轮（见 runTurn 里的 interrupted）。
   *   2. 再优雅打断 dsh 子进程（SIGINT，超时才 SIGKILL）。
   * 反过来的话，进程退出那一瞬间可能还有一条 `final` 被投递出去，
   * 用户会看到"插话之后机器人又把旧答案发了一遍"。
   *
   * @returns {{text:string, toolCalls:string[], startedAt:number}|null}
   *          被打断那一轮的信息（原话 + 已经调用过的工具），给下一轮当上下文
   */
  interruptTurn(chatKey) {
    const cur = this.currentTurn.get(chatKey);
    this.turnGen.set(chatKey, (this.turnGen.get(chatKey) ?? 0) + 1);
    const killed = this.cancelChat(chatKey);
    this.currentTurn.delete(chatKey);
    log.info('打断 ' + maskChatKey(chatKey) + ' 当前回合' + (killed ? '（已中断 dsh）' : '（没有活跃子进程）') +
      (cur && cur.text ? '，被打断的用户消息：' + String(cur.text).slice(0, 60) : ''));
    if (!cur) return killed ? { text: '（上一条消息）', toolCalls: [], startedAt: Date.now() } : null;
    return {
      text: cur.text || '（上一条消息）',
      toolCalls: Array.isArray(cur.toolCalls) ? [...cur.toolCalls] : [],
      startedAt: cur.startedAt || Date.now()
    };
  }

  attach(onebot) {
    this.onebot = onebot;
    // interactions 需要 onebot 才能发动作；状态（上一条自身消息 id 等）在这里新起一份
    this.interactions = createInteractions(onebot, this.config.behavior?.interactions, {
      // 动作结果进事件流：仪表盘上能看到"表情回应/撤回/戳一戳"真的发生了
      onAction: (res, err, chatKey) => {
        if (err) this.status.emitEvent('warn', '小动作失败 @ ' + chatKey + '：' + err.message);
        else {
          this.status.count('actions');
          this.status.emitEvent('action', describeAction(res) + ' @ ' + chatKey);
        }
      }
    });
    this.interactionHint = systemHint(this.interactions.cfg, this.persona.target.burst);
    onebot.on('event', (ev) => {
      this.handleEvent(ev).catch((err) => log.error('处理事件失败: ' + (err && err.stack || err)));
    });
    // 上线后补发上次退出/断网时落盘的 outbox；失败有上限与退避，不无限重试。
    onebot.on('online', () => {
      this.retryOutbox().catch((err) => log.warn('outbox 重试出错: ' + (err && err.message)));
    });
  }

  async handleEvent(msg) {
    if (this.shuttingDown) { log.debug('正在退出，忽略新事件'); return; }
    if (msg.post_type === 'notice') { await this.handleNotice(msg); return; }
    if (msg.post_type !== 'message') return;
    if (!msg.message_type) return;

    // 同一实物消息的事件去重。
    //
    // 为什么需要：重连抖动、NapCat 重推、或多开一个 WS 客户端，都可能把同一个
    // message_id 送两次。**同一个进程内**去重能直接挡掉这类重复；但它挡不住
    // 「两个桥接器进程」那种情况——那得靠 index.js 的 pid 单例守卫。
    // 键里带上 self_id：不同账号的 message_id 是各自的序列，不能混。
    if (msg.message_id !== undefined && msg.message_id !== null) {
      if (!this.seenMessages) this.seenMessages = new Set();
      const dedupKey = String(msg.self_id) + ':' + String(msg.message_id);
      if (this.seenMessages.has(dedupKey)) {
        log.warn('忽略重复事件 ' + dedupKey + '（同一条消息重复送达，不再回复）');
        this.status?.emitEvent?.('warn', '忽略重复事件 ' + dedupKey);
        return;
      }
      this.seenMessages.add(dedupKey);
      if (this.seenMessages.size > 1000) {
        this.seenMessages.delete(this.seenMessages.values().next().value);
      }
    }

    const selfId = msg.self_id;
    const isGroup = msg.message_type === 'group';
    const userId = String(msg.user_id ?? '');
    const groupId = isGroup ? String(msg.group_id ?? '') : null;
    // 会话键就是 QQ 会话的身份：私聊按人，群默认按群（groupSessionScope=member 时按人）。
    // 每个键在 DSH 里各有一条会话，互不共享上下文。
    const chatKey = chatKeyFor({
      isGroup, groupId, userId,
      groupSessionScope: this.config.behavior?.groupSessionScope
    });

    const norm = normalize(msg, selfId);
    // 引用回复：先取被引用消息。群里“回复机器人那条”要算 mention（必须确认
    // 目标 sender 是 selfId，不能靠猜）；同时把引用摘要交给模型当上下文。
    let replyCtx = null;
    if (norm.repliedTo) {
      replyCtx = await this.fetchReplyContext(norm.repliedTo);
      if (isGroup && replyCtx && replyCtx.ok && replyCtx.senderId && String(replyCtx.senderId) === String(selfId)) {
        norm.mentioned = true;
      }
    }
    const senderName = (msg.sender && (msg.sender.card || msg.sender.nickname)) || userId;
    // 群上下文要在策略判定之前记：没 @ 我的消息正是“前面在聊什么”的来源。
    if (isGroup && this.groupContext && String(userId) !== String(selfId)) {
      const preview = norm.text || (norm.images.length ? '[图片×' + norm.images.length + ']'
        : norm.unsupported.length ? '[' + norm.unsupported.join('+') + ']' : '');
      if (preview) this.groupContext.record({ groupId, userId, name: senderName, text: preview, at: Date.now(), messageId: msg.message_id });
    }
    const decision = this.decide({ isGroup, userId, groupId, mentioned: norm.mentioned });
    if (!decision.ok) { log.debug('忽略消息 (' + decision.why + ') from ' + maskChatKey(chatKey)); return; }
    log.info('收到 ' + maskChatKey(chatKey) + ' 来自 ' + senderName + ': ' + norm.text.slice(0, 80));
    this.status.count('inbound');
    this.status.emitEvent('in', maskChatKey(chatKey) + ' · ' + senderName + '：' +
      (norm.text ? norm.text.slice(0, 120)
        : norm.images.length ? '[图片×' + norm.images.length + ']'
          : norm.unsupported.length ? '[' + norm.unsupported.join('+') + ']' : '[非文本消息]'));

    const target = { kind: isGroup ? 'group' : 'private', id: isGroup ? groupId : userId };
    // 记住"是谁的哪条消息"：表情回应打在这条上，戳一戳打给这个人
    if (this.interactions) {
      this.interactions.noteInbound(chatKey, { messageId: msg.message_id, targetId: userId });
      // 已读（可选）：收到即标记，属于"看过消息"的基本礼貌
      if (this.interactions.cfg.read) {
        this.interactions.markRead(chatKey).catch((err) => log.debug('标记已读失败: ' + err.message));
      }
    }
    await this.handleInbound({
      chatKey, kind: target.kind, id: target.id, userId, senderName,
      text: norm.text, images: norm.images, unsupported: norm.unsupported,
      mentioned: norm.mentioned, messageId: msg.message_id, repliedTo: norm.repliedTo,
      replied: replyCtx, selfId, trusted: false
    }, {
      deliver: (text, opts) => this.push(target, text, opts)
    });
  }

  /**
   * 取被引用消息的摘要。拿不到就返回 {ok:false}，由调用方明确告诉模型/用户
   * “引用不可读”，绝不假装有上下文。只读文本，不下载引用里的图片。
   */
  async fetchReplyContext(messageId, timeoutMs = 4000) {
    if (!messageId) return { ok: false, error: '没有 message_id' };
    if (!this.onebot || !this.onebot.online) return { ok: false, error: 'OneBot 不在线' };
    try {
      const data = await this.onebot.call('get_msg', { message_id: messageId }, timeoutMs);
      if (!data) return { ok: false, error: 'get_msg 没有返回数据' };
      const payload = { message: data.message, raw_message: data.raw_message, self_id: this.onebot.selfId };
      const n = normalize(payload, this.onebot.selfId);
      const sender = data.sender || {};
      const senderId = sender.user_id !== undefined ? String(sender.user_id) : null;
      return {
        ok: true,
        messageId,
        text: n.text.slice(0, 500),
        images: n.images.length,
        senderId,
        senderName: String(sender.card || sender.nickname || senderId || '未知'),
        isSelf: senderId !== null && String(senderId) === String(this.onebot.selfId)
      };
    } catch (err) {
      log.debug('取引用消息失败 ' + messageId + ': ' + (err && err.message));
      return { ok: false, error: String((err && err.message) || err).slice(0, 120) };
    }
  }

  /**
   * notice 事件：目前只处理戳一戳。
   * OneBot：{ post_type:'notice', notice_type:'notify', sub_type:'poke', user_id, target_id, group_id? }
   * 只有"戳的是我自己"才有反应，避免误插话。
   */
  async handleNotice(msg) {
    if (this.shuttingDown) return;
    if (msg.notice_type !== 'notify' || msg.sub_type !== 'poke') return;
    const selfId = String(msg.self_id ?? '');
    if (msg.target_id !== undefined && String(msg.target_id) !== selfId) return;
    const userId = String(msg.user_id ?? '');
    if (!userId || userId === selfId) return;
    const isGroup = msg.group_id !== undefined && msg.group_id !== null;
    const chatKey = chatKeyFor({
      isGroup,
      groupId: isGroup ? String(msg.group_id) : null,
      userId,
      groupSessionScope: this.config.behavior?.groupSessionScope
    });
    const decision = this.decide({
      isGroup, userId,
      groupId: isGroup ? String(msg.group_id) : null,
      mentioned: true
    });
    if (!decision.ok) { log.debug('忽略戳一戳 (' + decision.why + ') from ' + chatKey); return; }

    log.info('收到戳一戳 ' + maskChatKey(chatKey) + ' 来自 ' + maskChatKey('private:' + userId));
    const t = { kind: isGroup ? 'group' : 'private', id: isGroup ? String(msg.group_id) : userId };
    if (!this.config.behavior?.interactions?.pokeBack) return;
    try {
      this.interactions.noteInbound(chatKey, { targetId: userId });
      await this.interactions.poke(chatKey);
      await this.push(t, '别戳了，痒。');
    } catch (err) {
      log.warn('戳回去失败: ' + (err && err.message));
    }
  }

  decide({ isGroup, userId, groupId, mentioned }) {
    const d = decidePolicy(this.policy, {
      isGroup, userId, groupId, mentioned,
      selfId: this.onebot && this.onebot.selfId
    });
    if (!d.ok) {
      const chatKey = chatKeyFor({
        isGroup, groupId, userId,
        groupSessionScope: this.config.behavior?.groupSessionScope
      });
      this.noteDenied(d.why, chatKey);
    }
    return d;
  }

  /**
   * 入站主流程：策略 → 指令 → dsh 回合。QQ 事件与本地 /inject 走的是同一条路，
   * 区别只在 deliver（推 QQ 还是塞进 HTTP 响应）。
   *
   * 两态输入在这里分叉，且**严格互斥**：
   *   `/` 开头 → 指令（DSH 真命令 / 桥接器命令 / 已废除 / 未知），四种归宿都不进模型；
   *   其他     → 文本，交给 dsh。
   */
  async handleInbound(inbound, io) {
    const started = Date.now();
    const outputs = [];
    // 投递失败必须向上抛：由 runTurn 归类为 DELIVERY_FAILED，不能悄悄当成功。
    const say = async (text, opts) => {
      if (!text) return;
      outputs.push(text);
      if (io && io.deliver) await io.deliver(text, opts);
    };

    const { chatKey, text } = inbound;
    const chat = this.chat(chatKey);
    const result = { ok: true, chatKey, command: null, reply: '', sessionId: null, turns: 0, ms: 0, toolCalls: [] };

    if (this.shuttingDown) {
      return { ...result, ok: false, error: '正在退出，不再接新任务' };
    }
    if (inbound.forceCommand && !looksLikeCommand(text)) {
      return { ...result, ok: false, error: 'forceCommand 只接受 / 开头的指令' };
    }
    if (inbound.adminBypass) {
      this.status.emitEvent('action', '管理员注入 ' + (inbound.operator || 'local-admin') +
        ' @ ' + maskChatKey(chatKey) + '（显式 adminBypass）');
    }

    this.status.update((v) => {
      v.chats[chatKey] = {
        workspace: chat.workspace,
        sessionId: chat.sessions[chat.workspace].sessionId || null,
        turns: chat.sessions[chat.workspace].turns ?? null
      };
    });

    const parsed = parseCommand(text);
    if (parsed) {
      const role = this.roleFor(inbound.userId, inbound.adminBypass === true);
      // 命令审计：只记脱敏 chatKey、命令名、来源角色；不记参数原文里的隐私。
      this.status.emitEvent(parsed.kind === 'unknown' || parsed.kind === 'retired' ? 'warn' : 'action',
        '指令 /' + parsed.name + '（' + parsed.kind + '，role=' + (role || 'none') + '）@ ' +
        maskChatKey(chatKey) + (parsed.args ? ' args=' + parsed.args.slice(0, 40) : ''));
      const ctx = {
        bridge: this, status: this.status, chat, chatKey, target: { kind: inbound.kind, id: inbound.id },
        reply: say, role, userId: inbound.userId, operator: inbound.operator,
        senderName: inbound.senderName,
        groupSessionScope: this.config.behavior?.groupSessionScope,
        dshCommands: this.dshCommands || undefined,
        runDshCommand: (name, args) => this.runDshCommand({ chatKey, chat, name, args })
      };
      const exec = async () => {
        if (parsed.kind === 'dsh' && parsed.name === 'permission' && !roleAtLeast(role, 'owner')) {
          await say('没有权限：/permission 只允许 owner（policy.ownerUsers）执行。');
          return;
        }
        if (parsed.kind === 'bridge') {
          await runBridgeCommand(ctx, parsed.name, parsed.args);
        } else if (parsed.kind === 'dsh') {
          const r = await ctx.runDshCommand(parsed.name, parsed.args);
          await say(r.text || '（DSH 没有返回内容）');
        } else if (parsed.kind === 'retired') {
          await say(retiredCommandText(parsed.name, parsed.note));
        } else {
          await say(unknownCommandText(parsed.name));
        }
      };
      try {
        if (parsed.kind === 'dsh' && parsed.name === 'export') {
          // /export 不能走 DSH 的 Web-only 下载链路；要么真的发文件，要么明确不可用。
          const r = await this.exportSession({ chatKey, chat, inbound, io });
          await say(r.text || '（没有可导出的会话）');
        } else {
          // 改 chat 状态的命令（/ws /new /model 和 DSH 命令）进入短状态锁；
          // /stop、只读命令不排队，否则 /stop 会等整轮结束而失效。
          const mutating = parsed.kind === 'dsh' ||
            (parsed.kind === 'bridge' && ['ws', 'new', 'model', 'session'].includes(parsed.name));
          if (mutating) await this.withStateLock(chatKey, exec);
          else await exec();
        }
      } catch (err) {
        const message = err && err.message ? err.message : String(err);
        log.warn('指令执行失败 /' + parsed.name + ': ' + message);
        result.ok = false;
        result.error = message;
        try { await say('指令 /' + parsed.name + ' 执行失败：' + message); }
        catch (deliverErr) { log.warn('错误提示也没发出去: ' + deliverErr.message); }
      }
      // 指令一律不进模型，也一律不分气泡（指令回复要短、要确定）
      result.command = parsed.name || '(unknown)';
      result.commandKind = parsed.kind;
      result.reply = outputs.join('\n\n');
      result.ms = Date.now() - started;
      return result;
    }

    if (!text && !(inbound.images || []).length) {
      const kinds = (inbound.unsupported || []).join('、');
      const note = kinds
        ? '暂不支持' + kinds + '消息。请改发文字或图片；语音/文件/合并转发目前拿不到内容。'
        : '（空消息）';
      await say(note);
      result.reply = outputs.join('\n\n');
      result.ms = Date.now() - started;
      return result;
    }

    // 忙的时候怎么办。
    //
    // 默认 `interrupt`：**打断上一轮**，把新消息直接接进上下文。人在对方说话途中插话，
    // 要的是"你先听我说"，不是收到一句"已排队"。排队还有个实际问题：模型已经在按旧
    // 问题组织答案，等你排到了再回，答的往往已经不是你现在问的事了。
    // 想退回排队：behavior.onBusy = 'queue'。
    const busy = (this.active.get(chatKey) ?? 0) > 0;
    const onBusy = this.config.behavior.onBusy === 'queue' ? 'queue' : 'interrupt';
    let interrupted = null;
    if (busy) {
      if (onBusy === 'interrupt') {
        interrupted = this.interruptTurn(chatKey);
        this.status.emitEvent('action', '用户插话，打断上一轮 @ ' + maskChatKey(chatKey));
      } else if (this.config.behavior.busyText && io && io.deliver) {
        await say(this.config.behavior.busyText);
      }
    }

    // 输入状态：只对私聊有意义（NapCat 的 set_input_status 只实现了 C2C）
    const status = (io && io.deliver && inbound.kind === 'private')
      ? this.persona.createInputStatus((ev) => this.setInputStatus(inbound.id, ev))
      : null;
    if (status) status.start();

    // 注册 turn 级 in-flight：从**排队**开始算，而不只是 dsh 子进程在跑的时候。
    const ticket = this.beginTurn(chatKey);
    try {
      await this.withChatLock(chatKey, async () => {
        const turn = await this.runTurn({ chat, chatKey, inbound, say, io, interrupted, ticket });
        Object.assign(result, turn);
        if (turn && turn.error) { result.ok = false; result.error = turn.error; }
        if (turn && turn.aborted) result.aborted = true;
      });
    } finally {
      this.endTurn(ticket);
      if (status) status.stop();
    }
    result.reply = outputs.join('\n\n');
    result.ms = Date.now() - started;
    return result;
  }

  beginTurn(chatKey) {
    const id = ++this.turnSeq;
    this.inflight.set(id, {
      chatKey,
      phase: 'queued',
      startedAt: Date.now()
    });
    return id;
  }

  setTurnPhase(ticket, phase) {
    const t = this.inflight.get(ticket);
    if (t) t.phase = phase;
  }

  endTurn(ticket) {
    this.inflight.delete(ticket);
  }

  withChatLock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    const run = prev.then(() => fn(), () => fn());
    this.locks.set(key, run.catch(() => {}));
    return run;
  }

  async runTurn({ chat, chatKey, inbound, say, io, interrupted = null, ticket = null }) {
    this.active.set(chatKey, (this.active.get(chatKey) ?? 0) + 1);
    this.setTurnPhase(ticket, 'running');
    // 本轮的"代数"。被打断时 interruptTurn 会把它 +1，于是 isCurrent() 变假，
    // 本轮不再投递、不再改计数（内容不丢：被打断时的进度会作为上下文交给下一轮）。
    const gen = (this.turnGen.get(chatKey) ?? 0) + 1;
    this.turnGen.set(chatKey, gen);
    // 本轮开始时的绑定代数。命令/新消息把会话切走后，本轮即使跑完也不能再写回。
    const bindGen = this.bindingGeneration(chatKey);
    const toolCalls = [];
    // toolCalls 是同一个数组引用：故意共享，这样 interruptTurn 读到的是"此刻已经调用了几个工具"
    this.currentTurn.set(chatKey, { gen, text: inbound.text, startedAt: Date.now(), toolCalls });
    const isTurnCurrent = () => this.turnGen.get(chatKey) === gen;
    const isBindingCurrent = () => this.bindingGeneration(chatKey) === bindGen;
    const isCurrent = () => isTurnCurrent() && isBindingCurrent();
    /** 只有"本轮还是当前轮"时才真的投递（被打断后的残余输出就地停下）。 */
    const sayCurrent = async (text, opts) => { if (isCurrent()) await say(text, opts); };
    let ackTimer = null;
    let acked = false;
    const workspace = chat.workspace;
    let lastResumeError = null;
    let forkedThisTurn = null;
    let deliveryFailed = false;

    // emit = 最终回答的出口。走 QQ（有 deliver）时：
    //   1. 先执行回复里的小动作标记（表情回应/撤回/戳一戳），并从可见文本里删掉；
    //   2. 再按"人打字"的节奏分气泡发出去。
    // 本地 /inject（deliver=null）时保持一次成型，但**仍然剥离标记**，
    // 否则脚本会拿到一堆 `[[react:赞]]` 噪音。
    const emit = async (text) => {
      if (!text) return;
      if (!isCurrent()) { log.debug(chatKey + ' 回合已失效（打断/切会话），本条输出不再投递'); return; }
      let body = text;
      let actions = [];
      if (this.interactions) {
        // P1-02：代码块内的标记不执行；纯动作回复不把原文发出去；最多 2 个动作。
        const parsed = parseActions(text, { maxActions: 2 });
        body = parsed.text;
        actions = parsed.actions;
        if (parsed.ignoredActions && parsed.ignoredActions.length) {
          log.info(chatKey + ' 忽略多余动作 ' + parsed.ignoredActions.map((a) => a.kind).join(','));
        }
      }
      if (!io || !io.deliver) {
        if (body) await sayCurrent(body);
        return;
      }
      if (actions.length) {
        // 动作有总时限；失败/超时都不阻塞正文（P1-02）。
        try { await this.interactions.run(chatKey, actions, { maxActions: 2, timeoutMs: 2500 }); }
        catch (err) { log.warn('动作执行异常（继续发正文）: ' + (err && err.message)); }
      }
      if (!body) {
        log.debug(chatKey + ' 回复只包含动作标记，没有可见正文，不发送');
        return;
      }
      // 群首次触发披露 AI 身份与“本群共享一条会话”；只披露一次，不做成每轮噪音。
      if (inbound.kind === 'group' && this.config.behavior?.aiDisclosure !== false && !this.disclosedChats.has(chatKey)) {
        this.disclosedChats.add(chatKey);
        const memberScoped = this.config.behavior?.groupSessionScope === 'member';
        body += '\n\n（提示：我是接入 DSH 的机器人，不是真人；' +
          (memberScoped ? '本群每个成员各自一条会话，互相看不到对方的上下文。' : '本群共用一条会话，群成员都能看到这段上下文。') +
          (this.config.behavior?.groupReplyAtSender ? '' : '需要我时请 @ 我。') + '）';
      }
      let first = true;
      const sendPart = (part) => {
        const opts = first && inbound.kind === 'group' && this.config.behavior?.groupReplyAtSender
          ? { atUserId: inbound.userId }
          : undefined;
        first = false;
        return sayCurrent(part, opts);
      };
      // shouldStop：一旦被打断/切会话，分气泡的循环就地停下，别把剩下几条继续刷出去
      const r = await this.persona.deliverBurst(body, sendPart, () => !isCurrent());
      if (r.parts > 1) log.debug(chatKey + ' 分 ' + r.parts + ' 条气泡，间隔合计 ' + r.waitedMs + 'ms');
    };

    try {
      const imageResult = await this.collectImages(inbound.images || [], chatKey, workspace);
      const imagePaths = imageResult.paths || [];

      // 群里被 @ 时带上最近几条没 @ 我的消息；只在当前这句之前，且不含自己。
      const ctxBlock = inbound.kind === 'group' && this.groupContext
        ? this.groupContext.buildBlock(inbound.id) : '';
      let task = (ctxBlock + (inbound.text || '')).trim();
      // 插话：把"上一轮被打断时在做什么"作为上下文交给模型。
      // 不是把上一轮抹掉——而是告诉它：那件事做到一半，别从零开始，也别重复已经说过的。
      if (interrupted) {
        const prev = String(interrupted.text || '').replace(/\s+/g, ' ').slice(0, 300);
        const tools = (interrupted.toolCalls || []).length;
        const secs = Math.max(0, Math.round((Date.now() - (interrupted.startedAt || Date.now())) / 1000));
        task = '（用户在你回答的过程中插话，上一轮被打断了。' +
          '那一轮在处理：「' + prev + '」' +
          (tools ? '，已经调用过 ' + tools + ' 次工具' : '') +
          (secs ? '，跑了约 ' + secs + ' 秒' : '') + '。\n' +
          '不要重新开始，也不要把被打断的那段再发一遍；接着这条新消息说。' +
          '如果那一轮有没说完的结论，直接并进这次回答。）\n\n' + task;
      }
      // 引用回复：内容可读就拼进 task；不可读就明确说“不可读”，让模型别猜。
      if (inbound.replied && inbound.replied.ok) {
        const quote = inbound.replied.text
          ? '「' + inbound.replied.text + '」'
          : '（无文字' + (inbound.replied.images ? '，含 ' + inbound.replied.images + ' 张图片' : '') + '）';
        task = '（引用回复 ' + (inbound.replied.senderName || '对方') + ' 的消息 ' + quote + '）\n\n' + task;
      } else if (inbound.repliedTo) {
        const why = inbound.replied && inbound.replied.error ? inbound.replied.error : '取不到被引用消息';
        task = '（引用消息不可读：' + why + '。不要猜测引用内容，必要时请用户重发。）\n\n' + task;
      }
      if ((inbound.unsupported || []).length) {
        task += (task ? '\n\n' : '') + '（本轮还包含暂不支持的消息类型：' +
          inbound.unsupported.join('、') + '，没有可读取的内容；如需处理请让用户改发文字/图片。）';
      }
      if (inbound.kind === 'group' && this.config.behavior.groupSenderPrefix !== false) {
        task = '[' + inbound.senderName + '] ' + task;
      }
      const refs = describeReferences(inbound.text, workspace);
      if (refs) task += (task ? '\n\n' : '') + refs;
      // QQ 侧小动作提示不在每轮拼：downstream 的 invokeDsh 会按“会话是否已提示过”
      // 只注入一次（见 withSessionHint）。每轮拼会在历史里堆 N 份提示词。
      if (imagePaths.length) {
        task += (task ? '\n\n' : '') + '（本轮附带 ' + imagePaths.length + ' 张图片，已保存到：' +
          imagePaths.join(' 、 ') + '。需要时用文件工具查看。）';
      }
      if (imageResult.errors && imageResult.errors.length) {
        if (!imagePaths.length) {
          await sayCurrent('（有 ' + imageResult.errors.length + ' 张图片没能读取，已按文字处理；可以重发图片或改发文字。）');
        } else {
          task += (task ? '\n\n' : '') + '（另有 ' + imageResult.errors.length +
            ' 张图片读取失败，未附上；如果回答依赖它们，请让用户重发。）';
        }
        this.status.emitEvent('warn', maskChatKey(chatKey) + ' 图片读取失败 ' +
          imageResult.errors.length + ' 张：' + imageResult.errors[0].reason.slice(0, 120));
      }
      if (chat.seed) {
        task = '以下是我们之前对话的摘要，请把它当作已发生的上下文，不要复述它：\n' +
          '<摘要>\n' + chat.seed + '\n</摘要>\n\n' + task;
        delete chat.seed;
      }

      const ackMs = this.config.behavior.ackAfterMs ?? 6000;
      // P0-05：真实入站只有 io.deliver，inbound 上没有 deliver 字段。
      // 以前写 inbound.deliver，ack 永远不会发出去。
      if (ackMs > 0 && io && io.deliver) {
        ackTimer = setTimeout(() => {
          if (!isCurrent()) return;
          acked = true;
          sayCurrent(this.config.behavior.ackText || '收到，正在处理…')
            .catch((err) => log.warn('ack 投递失败: ' + (err && err.message)));
        }, ackMs);
      }

      // P0-01：只走 headless；不再通过 API 建会话（API 会话必带 preset，headless 拒绝）。
      const sessionId = chat.sessions[workspace].sessionId;
      let out;
      try {
        out = await this.invokeDsh({ chatKey, chat, workspace, task, sessionId, toolCalls, ticket, injectHint: true });
        if (sessionId) this.status.emitEvent('info', '沿用会话 ' + short(sessionId) + ' @ ' + maskChatKey(chatKey));
      } catch (err) {
        // 沿用失败：**先重试，再考虑分叉**。
        //
        // 这里曾经直接 `delete sessionId` 然后用全新会话重试——那等于把"写锁冲突 /
        // 会话文件锁"这类**暂时**故障，变成了用户看不见的**永久失忆**：回答照常给出，
        // 但模型已经看不到之前任何一轮。侧边栏里那堆 `okok`/`中文` 碎片就是它的产物。
        //
        // 现在的策略：
        //   1. 只有看起来是"会话不可用"的错误才重试；重试 2 次，因为持锁进程通常很快退出
        //      （典型情形：WebUI 里正开着这条会话、或上一轮 dsh 还没退干净）；
        //   2. 重试仍失败才分叉，而且**把这件事说出来**——事件流里记 error，QQ 里告知用户；
        //   3. 除此之外的错误原样抛出，不吞。
        if (err && err.promptAccepted) throw err; // 已经投递成功，重试会重复提问
        const msg = String((err && err.message) || err);
        // 只有“会话本身不可用”才值得重试/分叉。超时、spawn 失败等非会话错误
        // 必须原样抛出，不能把用户切到一条新会话（那才是真正的静默失忆）。
        const transient = /超时|timeout|无法启动 dsh|ENOENT|EACCES|spawn/i.test(msg);
        // 只把“会话本身拿不到”当可重试冲突；不能因为错误文本里恰好有
        // “session/会话”就把已经投递成功的回合再发一遍（那会重复问模型）。
        const resumeConflict = !!sessionId && !transient &&
          /already owned|writer-held|session\/not-found|session\/conflict|agent preset|one-shot runner|not found|no such|unavailable/i.test(msg);
        if (!resumeConflict) throw err;

        log.warn('沿用会话失败，重试中: ' + msg);
        this.status.emitEvent('warn', '沿用会话 ' + short(sessionId) + ' 失败，重试：' + msg.slice(0, 120));
        let recovered = null;
        const waits = Array.isArray(this.config.behavior?.sessionResumeRetryMs)
          ? this.config.behavior.sessionResumeRetryMs
          : [1500, 4000];
        for (const wait of waits) {
          await sleepMs(wait);
          try {
            recovered = await this.invokeDsh({ chatKey, chat, workspace, task, sessionId, toolCalls, ticket, injectHint: true });
            break;
          } catch (e2) {
            log.warn('沿用会话重试仍失败（等了 ' + wait + 'ms）: ' + ((e2 && e2.message) || e2));
            lastResumeError = (e2 && e2.message) || String(e2);
          }
        }
        if (recovered) {
          out = recovered;
          this.status.emitEvent('info', '沿用会话 ' + short(sessionId) + ' 重试成功 @ ' + maskChatKey(chatKey));
        } else {
          const reason = String(lastResumeError || msg).slice(0, 200);
          // 默认 **不分叉**。旧行为是“换一条新会话继续答”，用户看到的回答是正常的，
          // 但上下文已经悄悄丢了；这正是“莫名其妙新开会话”的来源。
          // 真要分叉必须显式配置 behavior.sessionConflict="fork"。
          const conflictPolicy = this.config.behavior?.sessionConflict === 'fork' ? 'fork' : 'error';
          if (conflictPolicy !== 'fork') {
            log.error('沿用会话失败，拒绝自动分叉（旧会话保留）: ' + reason);
            this.status.emitEvent('error', '会话 ' + short(sessionId) + ' 无法沿用；没有自动开新会话：' +
              reason.slice(0, 140));
            const recoverable = sessionExists(sessionId, workspace);
            throw new Error(
              '当前会话暂时无法沿用：' + reason + '\n' +
              '我没有自动开新会话，以免上下文悄悄丢失。' +
              (recoverable ? '旧会话还在：' + sessionId + '。' : '') +
              '\n可以等占用释放后再发一次；确实要重开请显式发送 /new 或 /ws <id>。'
            );
          }
          // opt-in 的分叉路径：旧会话不删除、不假装“再发一次就能接回”；
          // 把 from/to/reason/recoverable 落盘，提示里给出可执行的 /ws <old-id>。
          const recoverable = sessionExists(sessionId, workspace);
          log.error('沿用会话失败，已按配置分叉到新会话（旧会话保留）: ' + reason);
          this.status.emitEvent('error', '会话 ' + short(sessionId) + ' 无法沿用，已开新会话（' +
            maskChatKey(chatKey) + ' 的上下文中断）：' + reason.slice(0, 140));
          this.status.count('sessionForks');
          forkedThisTurn = {
            chatKey,
            from: sessionId,
            to: null,
            at: new Date().toISOString(),
            reason,
            recoverable
          };
          chat.lastFork = { ...forkedThisTurn };
          chat.previousSessions = Array.isArray(chat.previousSessions) ? chat.previousSessions : [];
          chat.previousSessions.push({ sessionId, at: forkedThisTurn.at, reason });
          if (chat.previousSessions.length > 10) chat.previousSessions.splice(0, chat.previousSessions.length - 10);
          if (!isCurrent()) {
            return { sessionId: null, turns: chat.sessions[workspace].turns ?? 0, toolCalls, aborted: true, stale: true };
          }
          out = await this.invokeDsh({ chatKey, chat, workspace, task, sessionId: null, toolCalls, ticket, injectHint: true });
        }
      }

      // /stop 或 API 侧 cancel：这一轮没有结果，不要发“模型没有返回内容”，也不计数。
      if (out && out.aborted) {
        log.debug(chatKey + ' 回合已中断（' + (out.reason && out.reason.kind ? out.reason.kind : 'aborted') + '），不投递');
        return {
          sessionId: out.sessionId || sessionId || null,
          turns: chat.sessions[workspace]?.turns ?? 0,
          toolCalls,
          aborted: true
        };
      }

      // 被打断/切会话的回合：即便 dsh 还返回了结果，也不再写会话、不计数、不投递。
      if (!isCurrent()) {
        log.debug(chatKey + ' 回合已失效（打断或绑定变更），本轮结果丢弃');
        if (!isBindingCurrent()) {
          this.status.emitEvent('warn', maskChatKey(chatKey) + ' 回合期间会话被切换，旧回合结果已丢弃（stale）');
        }
        return { sessionId: null, turns: chat.sessions[workspace]?.turns ?? 0, toolCalls, aborted: true, stale: !isBindingCurrent() };
      }

      if (ackTimer) { clearTimeout(ackTimer); ackTimer = null; }

      // 会话 id 必须先落盘（否则崩溃后下一轮会丢上下文），但 turns 要等到
      // “投递完成 + 落盘完成”之后才 +1（P0-06）。
      // P1-01：写回前再核对一次绑定代数；不一致就整轮丢弃，绝不覆盖用户刚切到的会话。
      if (!isBindingCurrent()) {
        log.warn(maskChatKey(chatKey) + ' 回合结束时绑定已变更，丢弃写回（stale）');
        this.status.emitEvent('warn', maskChatKey(chatKey) + ' 回合结束时会话已被切换，旧结果不再写回');
        return { sessionId: null, turns: chat.sessions[workspace]?.turns ?? null, toolCalls, aborted: true, stale: true };
      }
      const prevTurns = chat.sessions[workspace]?.turns;
      // null/undefined = 轮数未知（例如 /ws 绑到一条元数据里没有轮数的会话），
      // 不要把它当成 0 再加 1，否则又会伪造出一个“1 轮”。
      const baseTurns = forkedThisTurn ? 0 : (prevTurns === null || prevTurns === undefined ? null : prevTurns);
      if (out.sessionId) {
        // headless 模式新建的会话也要进归属表；API 模式通常已在建会话时登记过。
        this.sessionRegistry.claim(chatKey, out.sessionId, { workspace });
        chat.sessions[workspace] = {
          sessionId: out.sessionId,
          turns: baseTurns,
          updatedAt: new Date().toISOString()
        };
        if (forkedThisTurn) {
          forkedThisTurn.to = out.sessionId;
          chat.lastFork = { ...forkedThisTurn };
        }
        this.recordSessionTurns(chat, out.sessionId, baseTurns);
        this.saveChats();
      }

      this.setTurnPhase(ticket, 'deliver');
      const answer = (out.text || '').trim();
      await emit(answer || '（模型没有返回内容）');

      // 投递期间用户可能已经 /ws 或 /new；此时不能再把 turns 写回旧会话。
      if (!isBindingCurrent()) {
        log.warn(maskChatKey(chatKey) + ' 投递期间绑定已变更，不再写回 turns（stale）');
        this.status.emitEvent('warn', maskChatKey(chatKey) + ' 投递期间会话被切换，旧回合不写回轮数');
        return { sessionId: out.sessionId || null, turns: null, toolCalls, aborted: true, stale: true };
      }

      // 投递成功才计入轮数/最后回复时间。未知轮数继续保持未知。
      const nextTurns = baseTurns === null ? null : baseTurns + 1;
      if (chat.sessions[workspace] && (!out.sessionId || chat.sessions[workspace].sessionId === out.sessionId)) {
        chat.sessions[workspace].turns = nextTurns;
        chat.sessions[workspace].updatedAt = new Date().toISOString();
        if (out.sessionId && nextTurns !== null) this.recordSessionTurns(chat, out.sessionId, nextTurns);
        this.saveChats();
      }
      this.status.update((v) => {
        v.counters.turns += 1;
        v.lastReplyAt = new Date().toISOString();
        v.chats[chatKey] = {
          workspace,
          sessionId: chat.sessions[workspace]?.sessionId || null,
          turns: nextTurns
        };
      });

      // 分叉提示放在主回答成功之后；提示失败不能把已送达的回答判成失败。
      if (forkedThisTurn && io && io.deliver) {
        const oldId = forkedThisTurn.from;
        const newId = forkedThisTurn.to || out.sessionId || '';
        const tip = forkedThisTurn.recoverable
          ? '（提示：原会话 ' + short(oldId) + ' 没能沿用，这一轮开了新会话 ' + short(newId) + '。' +
            '旧会话没有被删除：' + oldId + '。等占用释放后可以 /ws ' + oldId + ' 接回；' +
            '接不回时我会再提示。当前新会话里看不到之前那段上下文。）'
          : '（提示：原会话 ' + short(oldId) + ' 没能沿用，而且旧会话文件已找不到；' +
            '这一轮开了新会话 ' + short(newId) + '，之前那段上下文找不回来了。）';
        try { await say(tip); }
        catch (err) { log.warn('分叉提示投递失败: ' + (err && err.message)); }
      }
      log.info('完成 ' + maskChatKey(chatKey) + '（' + ((out.ms / 1000).toFixed(1)) + 's）');
      this.status.emitEvent('turn', maskChatKey(chatKey) + ' 完成，用时 ' + (out.ms / 1000).toFixed(1) + 's' +
        (toolCalls.length ? '，工具 ' + toolCalls.length + ' 次' : '') +
        (out.sessionId ? '，会话 ' + String(out.sessionId).replace(/^session-/, '').slice(0, 8) : ''));
      return { sessionId: out.sessionId, turns: nextTurns, toolCalls };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      // 被打断的回合：dsh 是我们自己 SIGKILL 掉的，这个"失败"不是故障——不刷错误、不回话
      if (!isCurrent()) {
        log.debug('回合已被打断，忽略其错误 @ ' + maskChatKey(chatKey) + ': ' + message);
        return { sessionId: null, turns: chat.sessions[workspace].turns ?? 0, toolCalls, aborted: true };
      }
      const isDelivery = err && err.code === 'DELIVERY_FAILED';
      if (isDelivery) deliveryFailed = true;
      log.error('回合失败 ' + maskChatKey(chatKey) + ': ' + message);
      this.status.update((v) => { v.counters.errors += 1; v.lastError = message; });
      this.status.emitEvent('error', maskChatKey(chatKey) + ' 回合失败：' + message.slice(0, 200) +
        (isDelivery ? '（投递失败，已写 outbox）' : ''));
      // 投递本身失败时不再尝试回“出错了”：那条也发不出去，只会多一条 outbox。
      if (!deliveryFailed) {
        try { await say('出错了：' + message); }
        catch (e) { log.warn('错误提示投递失败: ' + (e && e.message)); }
      }
      return {
        sessionId: null,
        turns: chat.sessions[workspace].turns ?? 0,
        toolCalls,
        error: message,
        deliveryFailed
      };
    } finally {
      // ackTimer 在成功、失败、打断、异常四条路径都必须清掉（P0-05）。
      if (ackTimer) { clearTimeout(ackTimer); ackTimer = null; }
      // 用 turnGen（而不是绑定代数）判断清理：用户切会话不等于这一轮还能继续跑，
      // 但也不能把新轮登记的 currentTurn/running 删掉。
      if (isTurnCurrent()) this.currentTurn.delete(chatKey);
      const n = (this.active.get(chatKey) ?? 1) - 1;
      if (n <= 0) this.active.delete(chatKey); else this.active.set(chatKey, n);
      // 只有"当前轮"才清 running：被打断的旧轮不能把新轮刚登记的子进程删掉
      if (isTurnCurrent()) this.running.delete(chatKey);
    }
  }

  /**
   * 把一条 DSH 原生命令转发给 DSH 自己执行。
   *
   * 做法：在**当前会话**上跑一轮，任务就是这条命令原文——因为 DSH 的命令面
   * 解析发生在 agent 的输入处，而不是靠桥接器猜语义。桥接器不认识 `/compact`
   * 的实现细节，也不需要认识；命令的定义永远在 DSH 那一侧。
   *
   * @param {string} name 命令名（不含斜杠）
   * @param {string} args 命令原文里命令名之后的部分
   */
  async runDshCommand({ chatKey, chat, name, args }) {
    const workspace = chat.workspace;
    const sessionId = chat.sessions[workspace].sessionId;
    const line = '/' + name + (args ? ' ' + args : '');

    // ① 正路：交给 DSH 的命令注册表执行（真处理器、零模型调用、结果结构化）。
    if (this.dshApi?.enabled && sessionId) {
      try {
        // 命令也会写会话；归属不对时绝不执行。
        this.sessionRegistry.claim(chatKey, sessionId);
        const r = await this.dshApi.executeCommand(sessionId, line);
        log.info('DSH 指令 ' + line + ' @ ' + chatKey + ' -> ' +
          (r ? r.kind : 'unknown'));
        this.status.emitEvent('action', 'DSH 指令 ' + line + ' → ' +
          (r ? r.kind : '未知命令') + (r && r.text ? '：' + r.text.slice(0, 100) : ''));
        if (!r) {
          return { text: 'DSH 不认识这条命令：' + line + '\n（用 /help 看可用命令）', unknown: true };
        }
        return { text: r.text || ('（' + line + ' 执行完成，没有输出）'), kind: r.kind, sessionId };
      } catch (err) {
        log.warn('命令注册表调用失败: ' + err.message);
        return {
          text: '这条命令没能通过 DSH 的命令接口执行：' + err.message +
            '\n（我没有退化成"让模型自己看着办"——那种做法会让模型把命令当成问题来回答）',
          failed: true
        };
      }
    }

    // ② 还没有会话 / web 接口不可用：**不做假执行**。
    // 早期版本是把命令原文当任务丢给模型，结果模型回了一通"这是客户端功能"的胡话
    // （用户 2026-10-16 的截图）。宁可明确说做不到。
    if (!sessionId) {
      return { text: '还没有会话，先随便聊一句，然后再用 ' + line + '。' };
    }
    return {
      text: 'DSH 命令暂时不可用：连不上 DSH web 接口（' + this.dshApi?.base + '）。\n' +
        '命令必须由 DSH 的命令注册表执行，我不会把它当对话内容发给模型。'
    };
  }

  /**
   * 输入状态（"对方正在输入…"）。NapCat 扩展接口 set_input_status。
   *
   * 只实现了 C2C（私聊），所以群聊不调用；失败只记 debug，绝不影响主流程——
   * 它是"锦上添花"，任何异常都不该让回答发不出去。
   * @param {string|number} userId 私聊对端 QQ 号
   * @param {number} eventType 0=起 1=止（见 persona 配置，可对调）
   */
  async setInputStatus(userId, eventType) {
    if (!this.onebot || !this.onebot.online) return false;
    const payload = this.persona.inputStatusPayload(eventType);
    return this.onebot.call('set_input_status', { user_id: String(userId), ...payload }, 8000);
  }

  /**
   * 从 DSH 现场取命令表（供 /help 与未知指令提示使用）。
   * 走 headless 的 `--json` 通道拿不到命令面，所以这里不假装能拿到：
   * 只在配置显式给了 dshCommandList 时用它，否则用 commands.js 的兜底表。
   */
  loadDshCommands() {
    const list = this.config.dsh?.commandList;
    if (Array.isArray(list) && list.length) {
      this.dshCommands = list;
      log.info('命令表来自配置：' + list.map((c) => '/' + c.name).join(' '));
    }
    return this.dshCommands;
  }

  /** /compact 的实现：让当前会话产出一段摘要。 */
  async summarize(chatKey, chat) {
    const workspace = chat.workspace;
    const sessionId = chat.sessions[workspace].sessionId;
    const out = await this.invokeDsh({
      chatKey, chat, workspace, sessionId,
      task: '请把到目前为止的整段对话压缩成一段客观摘要：保留关键结论、决定、涉及的文件路径与未完成事项，' +
            '丢掉寒暄与重复内容。只输出摘要本身，不要任何前言。',
      toolCalls: []
    });
    return (out.text || '').trim();
  }

  async invokeDsh(opts) {
    const mode = await this.ensureTransport();
    if (mode !== 'api') return this.invokeDshHeadless(opts);
    return this.invokeDshHost(opts);
  }

  /** 旧的一次性 spawn（兼容 / 逃生舱）。 */
  async invokeDshHeadless({ chatKey, chat, workspace, task, sessionId, toolCalls, ticket = null, injectHint = false }) {
    this.setTurnPhase(ticket, 'queued');
    await this.semaphore.acquire();
    this.setTurnPhase(ticket, 'dsh');
    const started = Date.now();
    try {
      // 和 Host 路径一样：续聊前先确认这条会话属于本聊天，防止旧状态/手改
      // 让两个 QQ 聊天共写一条会话。
      if (sessionId) this.sessionRegistry.claim(chatKey, sessionId);
      const wantHint = injectHint && !this.sessionHasHint(chat, sessionId);
      const effectiveTask = wantHint ? this.withSessionHint(chat, sessionId, task) : task;
      // 已存在的会话：先记“提示过”，避免同一轮的重试把提示再拼一次。
      if (wantHint && sessionId) this.markSessionHint(chat, sessionId);

      const extraArgs = [];
      const patch = this.modelPatch(chat);
      if (patch) extraArgs.push('--patch', patch);

      this.status.update((v) => { v.dsh.running += 1; v.dsh.workspace = workspace; });

      const result = await runDsh({
        command: this.config.dsh.command,
        profile: this.config.dsh.profile,
        cwd: workspace,
        sessionId,
        task: effectiveTask,
        timeoutMs: this.config.dsh.timeoutMs,
        extraArgs,
        onSpawn: (child) => { this.running.set(chatKey, child); },
        onEvent: (ev) => {
          if (ev.type === 'tool_call') {
            toolCalls.push(ev.tool || 'tool');
            log.debug(chatKey + ' 工具 ' + (ev.tool || ''));
          }
        }
      });
      // 新会话的 id 只有跑完才知道；这时才把“已提示”落到那条 id 上。
      if (wantHint && result.sessionId && !sessionId) this.markSessionHint(chat, result.sessionId);
      result.ms = Date.now() - started;
      return result;
    } finally {
      this.running.delete(chatKey);
      this.status.update((v) => { v.dsh.running = Math.max(0, v.dsh.running - 1); });
      this.semaphore.release();
    }
  }

  /**
   * 常驻 Host 传输：session/create → session/prompt → 轮询 session/page。
   *
   * 关键差异：
   *   - 会话由 dsh web Host 持有写句柄，不会和 WebUI 抢锁；
   *   - 会话出现在侧边栏，QQ 与 Web 是同一批会话；
   *   - 失败时**绝不**自动新建会话（旧会话保留，报错给用户）。
   */
  async invokeDshHost({ chatKey, chat, workspace, task, sessionId, toolCalls, ticket = null, injectHint = false }) {
    this.setTurnPhase(ticket, 'queued');
    await this.semaphore.acquire();
    this.setTurnPhase(ticket, 'dsh');
    const started = Date.now();
    let sid = sessionId || null;
    let hostInfo = null;
    let promptAccepted = false;
    try {
      this.status.update((v) => { v.dsh.running += 1; v.dsh.workspace = workspace; });

      if (!sid) {
        const created = await this.dshApi.createSession({ cwd: workspace });
        sid = created && created.sessionId;
        if (!sid) throw new Error('DSH 没有返回新会话 id');
        // 立刻登记归属并落盘：即使这一轮失败，下一条消息也沿用这条会话，
        // 而不是再建一条；同时保证别的 QQ 聊天不能悄悄绑走它。
        this.sessionRegistry.claim(chatKey, sid, { workspace });
        chat.sessions[workspace] = {
          sessionId: sid,
          turns: 0,
          updatedAt: new Date().toISOString()
        };
        this.saveChats();
        this.status.emitEvent('info', '新建会话 ' + short(sid) + ' @ ' + maskChatKey(chatKey) +
          '（' + workspace + '，首条消息自动创建）');
        log.info('新建会话 ' + short(sid) + ' @ ' + maskChatKey(chatKey) + '（' + workspace + '）');
      }

      // 每轮都过归属表：旧状态/手工改文件后，第一次发消息会补登记；
      // 如果这条会话已经属于别的 QQ 聊天，这里直接抛错，绝不把内容写进去。
      if (sid) this.sessionRegistry.claim(chatKey, sid);

      // 先确认会话存在、cwd 对得上；不拿一个不存在的 id 去 create（那会造出空会话）。
      let proj;
      try {
        proj = await this.dshApi.projections(sid, { timeoutMs: 8000 });
      } catch (err) {
        const msg = String((err && err.message) || err);
        if (/not-found|not found|找不到/i.test(msg)) {
          throw new Error('会话 ' + sid + ' 在 DSH 里不存在了。没有自动新建；请显式 /new。');
        }
        throw new Error('读不到会话 ' + short(sid) + ' 的状态：' + msg);
      }
      if (!proj || proj.kind === 'migration-required') {
        throw new Error('会话 ' + short(sid) + ' 需要迁移或状态不可读；没有自动新建。请显式 /new。');
      }
      const values = (proj && proj.values) || {};
      if (values.workingDirectory) {
        const got = this.dshApi.canon ? this.dshApi.canon(values.workingDirectory) : values.workingDirectory;
        const want = this.dshApi.canon ? this.dshApi.canon(workspace) : workspace;
        if (got !== want) {
          throw new Error('会话 ' + short(sid) + ' 的工作目录是 ' + got + '，与当前工作区 ' + want +
            ' 不一致。没有自动新建；请先 /ws 切到该工作区，或显式 /new。');
        }
      }
      const beforeSeq = Number.isFinite(proj.asOfSeq) ? proj.asOfSeq : -1;
      const stats = values.sessionStats || {};
      const outline = Array.isArray(values.turnOutline) ? values.turnOutline : [];
      const beforeTurn = Number.isFinite(stats.turns) ? stats.turns : outline.length;

      // API 会话的模型选择是会话级的：把 /model 的别名落到这条会话上。
      // 失败不阻断消息（下一轮会再试），但要在事件流里看得见。
      try { await this.applyHostModel(chat, sid); }
      catch (err) {
        log.warn('模型选择落地失败（继续用当前模型）: ' + (err && err.message));
        this.status.emitEvent('warn', '模型选择落地失败（继续用当前模型）：' + String((err && err.message) || err).slice(0, 140));
      }

      const wantHint = injectHint && !this.sessionHasHint(chat, sid);
      const promptText = wantHint ? this.withSessionHint(chat, sid, task) : task;
      const requestId = 'qq-' + crypto.randomBytes(8).toString('hex');
      hostInfo = { sessionId: sid, requestId, aborted: false, started: false, wantHint };
      this.hostRunning.set(chatKey, hostInfo);

      this.setTurnPhase(ticket, 'dsh');
      await this.dshApi.prompt(sid, promptText, requestId, { mode: 'queue' });
      promptAccepted = true;
      if (this.transportError) {
        this.transportError = null;
        this.updateTransportStatus({ ok: true });
      }
      // accepted 之后提示已经在会话里了；从这里开始不能再拼一次。
      if (wantHint) this.markSessionHint(chat, sid);

      const turn = await this.waitHostTurn({ chatKey, chat, sessionId: sid, hostInfo, beforeSeq, beforeTurn, toolCalls });
      const result = {
        sessionId: sid,
        text: turn.text || '',
        ms: Date.now() - started,
        reason: turn.reason,
        aborted: turn.aborted === true
      };
      return result;
    } catch (err) {
      const msg = String((err && err.message) || err);
      // 连接类失败要反映到 /health；否则 dsh web 挂了，健康检查还显示 ok。
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|socket|token|cookie|HTTP 5\d\d/i.test(msg)) {
        this.transportError = msg;
        this.updateTransportStatus({ ok: false, reason: msg });
      }
      // 消息已经被 Host 收下：再重试会把同一条消息发第二遍，绝不允许。
      if (promptAccepted && err && typeof err === 'object') err.promptAccepted = true;
      throw err;
    } finally {
      if (hostInfo && this.hostRunning.get(chatKey) === hostInfo) this.hostRunning.delete(chatKey);
      this.status.update((v) => { v.dsh.running = Math.max(0, v.dsh.running - 1); });
      this.semaphore.release();
    }
  }

  async waitHostTurn({ chatKey, chat, sessionId, hostInfo, beforeSeq, beforeTurn, toolCalls }) {
    const timeoutMs = Math.max(1000, Number(this.config.dsh.timeoutMs) || 900000);
    const started = Date.now();
    let lastSeq = beforeSeq;
    let promptSeq = null;
    let text = '';
    let lastError = null;
    while (Date.now() - started < timeoutMs) {
      if (hostInfo.aborted) return { text, aborted: true, reason: { kind: 'aborted' } };
      const elapsed = Date.now() - started;
      await sleepMs(elapsed < 5000 ? 250 : 500);
      let proj;
      try {
        proj = await this.dshApi.projections(sessionId, { timeoutMs: 8000 });
      } catch (err) {
        lastError = err;
        continue;
      }
      if (!proj || proj.kind === 'migration-required') continue;
      const asOf = Number.isFinite(proj.asOfSeq) ? proj.asOfSeq : -1;
      if (asOf <= lastSeq) continue;
      let records;
      try {
        // 只取“新增事件”够用的窗口：seq 是稠密的，asOf-lastSeq 近似新增条数。
        const window = Math.max(50, Math.min(2000, asOf - lastSeq + 50));
        records = await this.dshApi.page(sessionId, asOf, { maxMessages: window });
      } catch (err) {
        lastError = err;
        continue;
      }
      // 我们的消息可能排在 GUI 正在跑的那一轮后面。没看到自己的 requestId
      // 之前，不能把别人的 turn/end 当成自己的回答。
      if (promptSeq === null) promptSeq = findRequestSeq(records, hostInfo.requestId, { afterSeq: lastSeq });
      if (promptSeq !== null) {
        const folded = foldTurnRecords(records, { afterSeq: Math.max(promptSeq - 1, lastSeq), afterTurn: beforeTurn });
        if (folded.sawTurn) hostInfo.started = true;
        if (folded.text) text = folded.text;
        if (folded.toolCalls.length) toolCalls.push(...folded.toolCalls);
        if (folded.ended) {
          const reason = folded.reason || { kind: 'completed' };
          if (reason.kind === 'completed') return { text, reason };
          if (reason.kind === 'aborted') return { text, aborted: true, reason };
          const detail = reason.message || reason.detail || JSON.stringify(reason);
          throw new Error('DSH 回合失败（' + String(reason.kind || 'error') + '）：' + String(detail).slice(0, 300));
        }
      }
      const maxSeq = records.reduce((m, rec) => {
        const ev = rec && rec.type === 'event' ? rec.event : (rec && rec.event ? rec.event : rec);
        return ev && Number.isFinite(ev.seq) ? Math.max(m, ev.seq) : m;
      }, lastSeq);
      if (maxSeq > lastSeq) lastSeq = maxSeq;
    }
    // 超时：先尝试撤回排队中的消息，已开始才 cancel；绝不新建会话。
    try {
      if (!hostInfo.started) {
        const removed = await this.dshApi.removeQueuedPrompt(sessionId, hostInfo.requestId);
        if (removed && hostInfo.wantHint && chat && chat.hintSessions && chat.hintSessions[sessionId]) {
          delete chat.hintSessions[sessionId];
          this.saveChats();
        }
      } else {
        await this.dshApi.cancel(sessionId);
      }
    } catch { /* 取消失败不掩盖超时 */ }
    const tail = lastError ? '：' + String(lastError.message || lastError).slice(0, 200) : '';
    throw new Error('任务超时（' + Math.round(timeoutMs / 1000) + ' 秒）' + tail);
  }

  /** API 会话：把 /model 的别名落实到 Host 的会话级模型选择。 */
  async applyHostModel(chat, sessionId) {
    const key = chat.model || this.config.dsh.defaultModel;
    if (!key || !sessionId) return null;
    const spec = (this.config.dsh.models || {})[key];
    if (!spec) return null;
    if (!chat.modelSessions || typeof chat.modelSessions !== 'object') chat.modelSessions = {};
    if (chat.modelSessions[sessionId] === key) return null;
    await this.dshApi.selectModel(sessionId, spec);
    chat.modelSessions[sessionId] = key;
    this.saveChats();
    this.status.emitEvent('action', '模型切到 ' + key + '（' + spec.provider + '/' + spec.model + '）@ ' + short(sessionId));
    return key;
  }

  /** 把 /model 的选择落成一个 --patch 覆盖文件（仅 headless 传输用）。 */
  modelPatch(chat) {
    const key = chat.model;
    if (!key) return null;
    const spec = (this.config.dsh.models || {})[key];
    if (!spec) return null;
    const dir = path.join(this.paths.stateDir, 'patches');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'model-' + key.replace(/[^a-zA-Z0-9._-]/g, '_') + '.yml');
    const body = [
      '# 由桥接器的 /model 生成，覆盖 agent-default-model',
      '- id: agent-default-model',
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      '  config:',
      '    provider: ' + JSON.stringify(spec.provider),
      '    model: ' + JSON.stringify(spec.model),
      spec.reasoningEffort ? '    reasoningEffort: ' + JSON.stringify(spec.reasoningEffort) : null,
      ''
    ].filter((l) => l !== null).join('\n');
    try {
      fs.writeFileSync(file, body);
      return file;
    } catch (err) {
      log.warn('写模型补丁失败: ' + err.message);
      return null;
    }
  }

  /**
   * 下载本轮图片到**当前 chat workspace** 的 inbox。
   * 安全边界：拒绝 file:// 和绝对路径（以前会把任意本地文件复制进 workspace），
   * 5-10s 超时、10MB 上限、content-type 白名单、默认拒绝私网/回环地址（SSRF）。
   * @returns {Promise<{paths:string[],errors:Array<{reason:string}>}>}
   */
  async collectImages(sources, chatKey, workspace = this.paths.workspace) {
    const result = { paths: [], errors: [] };
    if (!this.config.behavior.downloadImages) return result;
    const configured = this.config.behavior.imageDir;
    const dir = configured
      ? (path.isAbsolute(configured) ? configured : path.resolve(this.paths.root || process.cwd(), configured))
      : path.join(workspace, 'inbox');
    const timeoutMs = Math.max(1000, Math.min(30000, Number(this.config.behavior.imageDownloadTimeoutMs) || 8000));
    const maxBytes = Math.max(1024, Math.min(50 * 1024 * 1024, Number(this.config.behavior.imageMaxBytes) || 10 * 1024 * 1024));
    const allowPrivate = this.config.behavior.imageAllowPrivateHosts === true;
    const allowedTypes = new Map([
      ['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/jpg', '.jpg'],
      ['image/gif', '.gif'], ['image/webp', '.webp']
    ]);

    for (const raw of (sources || []).slice(0, 8)) {
      const src = String(raw || '');
      try {
        if (/^file:\/\//i.test(src) || src.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(src)) {
          throw new Error('拒绝本地文件路径（安全限制）');
        }
        let url;
        try { url = new URL(src); } catch { throw new Error('不是合法图片 URL'); }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只支持 http/https 图片链接');
        await assertPublicImageUrl(url, { allowPrivate });

        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetch(url, { signal: ctrl.signal, redirect: 'follow' });
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
          const ext = allowedTypes.get(type);
          if (!ext) throw new Error('不是支持的图片类型（' + (type || '无 content-type') + '）');
          const len = Number(res.headers.get('content-length'));
          if (Number.isFinite(len) && len > maxBytes) throw new Error('图片超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB 上限');
          const chunks = [];
          let total = 0;
          if (res.body && typeof res.body.getReader === 'function') {
            const reader = res.body.getReader();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.byteLength;
              if (total > maxBytes) { try { ctrl.abort(); } catch {} throw new Error('图片超过大小上限'); }
              chunks.push(Buffer.from(value));
            }
          } else {
            const buf = Buffer.from(await res.arrayBuffer());
            total = buf.length;
            if (total > maxBytes) throw new Error('图片超过大小上限');
            chunks.push(buf);
          }
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
          const stamp = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
          const file = path.join(dir, stamp + ext);
          fs.writeFileSync(file, Buffer.concat(chunks), { mode: 0o600 });
          result.paths.push(file);
        } finally {
          clearTimeout(timer);
        }
      } catch (err) {
        const reason = err && err.name === 'AbortError'
          ? '下载超时（' + Math.round(timeoutMs / 1000) + 's）'
          : String((err && err.message) || err).slice(0, 160);
        result.errors.push({ reason });
        log.warn('图片处理失败 @ ' + maskChatKey(chatKey) + '：' + reason);
      }
    }
    return result;
  }

  /**
   * /export：生成真实 ZIP 并发回当前聊天。
   *
   * DSH 自己的 /export 只返回 "Session log download requested"（Web UI 下载链路），
   * QQ 侧没有产物。这里要么发文件，要么明确说“仅 Web 可用”，绝不 success 无产物。
   */
  async exportSession({ chatKey, chat, inbound, io }) {
    if (!io || !io.deliver) {
      return { text: '/export 的产物只能发到当前 QQ 聊天；本地注入没有聊天可发。要本地导出请用 DSH Web UI。' };
    }
    const workspace = chat.workspace;
    const sessionId = chat.sessions[workspace]?.sessionId;
    if (!sessionId) return { text: '还没有会话，先聊一句再 /export。' };
    const catalog = await this.sessionCatalog(workspace);
    const entry = catalog.find((e) => String(e.id).toLowerCase() === String(sessionId).toLowerCase());
    if (!entry || !entry.dir) {
      return { text: '找不到当前会话的本地日志文件，/export 暂时不可用（不假装成功）。可以改用 DSH Web UI 导出。' };
    }
    const maxBytes = Math.max(1024, Math.min(100 * 1024 * 1024, Number(this.config.behavior?.exportMaxBytes) || 20 * 1024 * 1024));
    let zip;
    try {
      zip = buildSessionZip(entry.dir, { maxBytes });
    } catch (err) {
      if (err && err.code === 'export/too-large') {
        return { text: '会话日志太大，超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB 导出上限；请用 DSH Web UI 导出。' };
      }
      log.warn('导出会话失败 ' + short(sessionId) + ': ' + (err && err.message));
      return { text: '导出失败：读不到当前会话日志。可以改用 DSH Web UI 导出。' };
    }
    if (zip.buffer.length > maxBytes) {
      return { text: '导出文件超过 ' + Math.round(maxBytes / 1024 / 1024) + 'MB 上限；请用 DSH Web UI 导出。' };
    }
    const exportDir = path.join(this.paths.stateDir, 'exports');
    fs.mkdirSync(exportDir, { recursive: true, mode: 0o700 });
    const name = zip.id.replace(/[^a-zA-Z0-9._-]/g, '_') + '.zip';
    const file = path.join(exportDir, name);
    let wrote = false;
    try {
      if (!this.onebot || !this.onebot.online) {
        return { text: 'OneBot 不在线，暂时无法把导出文件发到 QQ；连上后再 /export。' };
      }
      fs.writeFileSync(file, zip.buffer, { mode: 0o600 });
      wrote = true;
      const isGroup = inbound && inbound.kind === 'group';
      const action = isGroup ? 'upload_group_file' : 'upload_private_file';
      const params = isGroup
        ? { group_id: String(inbound.id), file, name, folder: '' }
        : { user_id: String(inbound.id), file, name };
      const res = await this.onebot.call(action, params, 60000);
      const mid = res && (res.message_id ?? res.messageId);
      if (mid !== undefined && mid !== null && this.interactions) this.interactions.noteSelfMessage(chatKey, mid);
      this.status.count('outbound');
      this.status.emitEvent('out', maskChatKey(chatKey) + '：导出文件 ' + name + '（' + Math.round(zip.buffer.length / 1024) + 'KB）');
      try { fs.rmSync(file, { force: true }); } catch {}
      wrote = false;
      return { text: '已导出当前会话（' + name + '，' + Math.round(zip.buffer.length / 1024) + 'KB，' +
        'JSONL ' + zip.entries.length + ' 个文件）。' };
    } catch (err) {
      log.warn('导出上传失败 ' + short(sessionId) + ': ' + (err && err.message));
      // 错误里可能带本地路径；不要把绝对路径发到 QQ。
      const safe = String((err && err.message) || err).replace(file, '<导出文件>').slice(0, 160);
      return { text: '导出文件已生成，但上传到 QQ 失败：' + safe + '\n可以改用 DSH Web UI 导出。' };
    } finally {
      if (wrote && !this.onebot?.online) {
        // 离线：保留文件供下次/人工取用，但文件权限已是 0600。
      }
    }
  }

  /**
   * 优雅退出：不再接新任务，等 turn 级 in-flight 清零，再尽量把 outbox 补发一次。
   *
   * 关键区别：semaphore.release() 只表示 dsh 槽位释放，不表示 turn 结束。
   * 一个 turn 还可能在拟人化投递、写 state、等 chat lock；这些都必须算进 inflight，
   * 否则会出现“日志说已收尾、QQ 却没收到最后一句话”。
   *
   * @param {number} timeoutMs 最多等多久；超时就放弃剩余任务（进程仍会退出）
   * @returns {Promise<{drained:boolean, waited:number, running:number, pending:Array,
   *                    delivered:number, failed:number, outbox:object}>}
   */
  async shutdown(timeoutMs = 120000) {
    const started = Date.now();
    const delivered0 = this.deliveryStats.delivered;
    const failed0 = this.deliveryStats.failed;
    this.shuttingDown = true;
    const deadline = started + Math.max(0, Number(timeoutMs) || 0);

    if (this.inflight.size > 0) {
      log.warn('退出中：等 ' + this.inflight.size + ' 个回合（含排队/投递）结束（最多 ' +
        Math.round(timeoutMs / 1000) + 's）');
      this.status.emitEvent('state', '退出中：等待 ' + this.inflight.size + ' 个回合收尾');
    }
    while (this.inflight.size > 0 && Date.now() < deadline) {
      await sleepMs(200);
    }

    const pending = [...this.inflight.values()].map((t) => ({
      chatKey: maskChatKey(t.chatKey),
      phase: t.phase,
      ms: Date.now() - t.startedAt
    }));

    // OneBot 此时还连着（index 会在 bridge.shutdown 之后才 stop），先补发一次 outbox。
    let outbox = { sent: 0, failed: 0, pending: this.outboxEntries.length };
    if (this.onebot && this.onebot.online && this.outboxEntries.length) {
      try {
        outbox = await this.retryOutbox({ maxMs: Math.max(0, Math.min(5000, deadline - Date.now())) });
      } catch (err) {
        log.warn('退出前 outbox 补发出错: ' + (err && err.message));
      }
    }

    return {
      drained: pending.length === 0,
      waited: Date.now() - started,
      running: pending.length,
      pending,
      delivered: this.deliveryStats.delivered - delivered0,
      failed: this.deliveryStats.failed - failed0,
      outbox
    };
  }

  #saveOutbox() {
    try {
      this.outboxStore.set('entries', this.outboxEntries);
      try { fs.chmodSync(path.join(this.paths.stateDir, 'outbox.json'), 0o600); } catch {}
    } catch (err) {
      log.warn('outbox 落盘失败: ' + (err && err.message));
    }
  }

  #addOutbox(target, chatKey, part, { atUserId } = {}) {
    const segments = [];
    const at = atUserId === undefined || atUserId === null ? '' : String(atUserId).trim();
    // 只允许真实 QQ 号；永远不接受 all。用消息段而不是 CQ 字符串（P0-07/P1-06）。
    if (/^\d{5,12}$/.test(at) && at !== 'all') {
      segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'text', data: { text: part } });
    const entry = {
      id: crypto.randomUUID(),
      chatKey,
      target: { kind: target.kind, id: String(target.id) },
      segments,
      attempts: 0,
      lastError: null,
      createdAt: new Date().toISOString()
    };
    this.outboxEntries.push(entry);
    this.#saveOutbox();
    return entry;
  }

  #removeOutbox(id) {
    const i = this.outboxEntries.findIndex((e) => e.id === id);
    if (i >= 0) this.outboxEntries.splice(i, 1);
    this.#saveOutbox();
  }

  #failOutbox(entry, err) {
    entry.attempts = Number(entry.attempts || 0) + 1;
    entry.lastError = String((err && err.message) || err).slice(0, 300);
    entry.lastAttemptAt = new Date().toISOString();
    const max = this.config.behavior?.outboxMaxAttempts ?? 5;
    if (entry.attempts >= max) entry.status = 'failed';
    this.#saveOutbox();
  }

  /**
   * 启动/上线/退出时补发 outbox。
   * - 每次只发一条，成功即删；
   * - 有 attempts 上限，失败后指数退避；
   * - 不因补发失败而无限阻塞进程。
   */
  async retryOutbox({ maxMs = 15000 } = {}) {
    if (this.outboxRetrying) return { sent: 0, failed: 0, pending: this.outboxEntries.length };
    if (!this.onebot || !this.onebot.online) {
      return { sent: 0, failed: 0, pending: this.outboxEntries.length };
    }
    if (this.status.isSuspended()) {
      return { sent: 0, failed: 0, pending: this.outboxEntries.length, suspended: true };
    }
    this.outboxRetrying = true;
    const deadline = Date.now() + Math.max(0, Number(maxMs) || 0);
    const max = this.config.behavior?.outboxMaxAttempts ?? 5;
    let sent = 0;
    let failed = 0;
    try {
      for (const entry of [...this.outboxEntries]) {
        if (Date.now() >= deadline) break;
        if (!this.outboxEntries.some((e) => e.id === entry.id)) continue;
        if (entry.status === 'failed' || Number(entry.attempts || 0) >= max) continue;
        try {
          const r = await this.onebot.sendTo(entry.target, entry.segments);
          this.#removeOutbox(entry.id);
          sent += 1;
          this.status.count('outbound');
          const text = entry.segments.map((s) => (s.data && s.data.text) || '').join('');
          this.status.emitEvent('out', '补发 ' + maskChatKey(entry.chatKey) + '：' + text.slice(0, 120));
          const id = r && (r.message_id ?? r.messageId);
          if (id !== undefined && id !== null && this.interactions) {
            this.interactions.noteSelfMessage(entry.chatKey, id);
          }
        } catch (err) {
          failed += 1;
          this.#failOutbox(entry, err);
          log.warn('outbox 补发失败（' + entry.attempts + '/' + max + '）: ' + (err && err.message));
          const backoff = Math.min(5000, 300 * Math.max(1, Number(entry.attempts || 1)));
          if (Date.now() + backoff < deadline) await sleepMs(backoff);
        }
      }
    } finally {
      this.outboxRetrying = false;
    }
    return { sent, failed, pending: this.outboxEntries.length };
  }

  #noteOutboundFailure(err) {
    // 一次 push = 一次失败，不按分片累加（P0-06）。
    this.outFailStreak = (this.outFailStreak || 0) + 1;
    const max = this.config.behavior.outboundFailThreshold || 5;
    this.status.emitEvent('error', '出站失败（连续 ' + this.outFailStreak + '/' + max + '）：' +
      String((err && err.message) || err).slice(0, 200));
    if (this.outFailStreak >= max) {
      this.status.setAlert({
        level: 'fatal',
        code: 'outbound-failing',
        message: '出站连续失败 ' + this.outFailStreak + ' 次（最后：' +
          String((err && err.message) || err).slice(0, 120) + '），已熔断停止发送',
        detail: String((err && err.message) || err).slice(0, 300)
      });
    }
  }

  /**
   * 出站投递。每个分片先写 outbox，再发消息段数组（P0-07：绝不发 string message）。
   * 任何一片失败：停止本轮剩余分片，保留 outbox，抛 DELIVERY_FAILED（带 partial）。
   */
  async push(target, text, opts = {}) {
    if (!text) return;
    const chatKey = (target.kind === 'group' ? 'group:' : 'private:') + target.id;

    // 熔断：连续出站失败后主动停止发送。熔断期间不写 outbox（这是策略性丢弃）。
    if (this.status.isSuspended()) {
      const until = new Date(this.status.alert.at + (this.config.behavior.outboundFailCooldownMs || 600000));
      if (Date.now() < until.getTime()) {
        log.warn('出站已熔断（' + this.status.alert.code + '），本条消息被丢弃');
        this.status.emitEvent('alert', '熔断中，丢弃一条出站消息');
        const err = new Error('出站已熔断，消息未发送');
        err.code = 'DELIVERY_BLOCKED';
        throw err;
      }
      this.status.setAlert(null);
      this.status.emitEvent('state', '熔断窗口结束，恢复出站');
    }

    const limit = this.config.behavior.maxReplyChars || 4000;
    // P1-02：统一走 persona 的代码围栏/字素感知切分，不再用本地 chunk() 二次切。
    // 这样 persona 已经切好的段不会被 4000 再撕一次，代码块围栏始终完整。
    const parts = this.persona.hardSplit(String(text), limit);
    if (!parts.length) return;
    const entries = parts.map((part, i) => this.#addOutbox(target, chatKey, part, {
      atUserId: i === 0 ? opts.atUserId : undefined
    }));
    let sentCount = 0;

    if (!this.onebot || !this.onebot.online) {
      this.deliveryStats.failed += 1;
      this.status.emitEvent('warn', 'OneBot 不在线，消息已写入 outbox（' + entries.length + ' 段）');
      const err = new Error('OneBot 不在线，消息已写入 outbox 待补发');
      err.code = 'DELIVERY_FAILED';
      err.partial = { sent: 0, failed: 0, total: entries.length };
      throw err;
    }

    try {
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        let sent;
        try {
          // P0-07：段数组。文本里的 [CQ:...] 只是普通文本。
          sent = await this.onebot.sendTo(target, entry.segments);
        } catch (err) {
          this.#failOutbox(entry, err);
          throw err;
        }
        this.#removeOutbox(entry.id);
        sentCount += 1;
        this.status.count('outbound');
        const part = entry.segments.map((s) => (s.data && s.data.text) || '').join('');
        this.status.emitEvent('out', maskChatKey(chatKey) + '：' + part.slice(0, 120));
        const id = sent && (sent.message_id ?? sent.messageId);
        if (id !== undefined && id !== null && this.interactions) {
          this.interactions.noteSelfMessage(chatKey, id);
        }
      }
      this.outFailStreak = 0;
      this.deliveryStats.delivered += 1;
    } catch (err) {
      this.deliveryStats.failed += 1;
      this.#noteOutboundFailure(err);
      const e = new Error(String((err && err.message) || err));
      e.code = 'DELIVERY_FAILED';
      e.partial = { sent: sentCount, failed: 1, total: entries.length };
      throw e;
    }
  }
}

export { helpText };
