import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';

const log = logger('dshapi');

/**
 * DSH Host API 的**只读/命令**客户端。
 *
 * P0-01 之后这里不再建会话、不再注册工作区、不再做 probe：
 * API 建的会话必带 agentPreset，而 headless 一次性运行器拒绝带 preset 的会话；
 * 两者互斥，所以桥接器只走 headless spawn。保留 API 的唯一原因是
 * DSH 原生命令（/compact、/goal…）必须由 commands/execute 的真处理器执行，
 * 不能让模型“自己看着办”。
 *
 * token 来自 DSH web 的启动 URL 文件；进程重启会换 token，所以每次 ensureCookie
 * 都重新读，401 时自动重换一次。
 */
export function createDshApi(cfg = {}) {
  const enabled = cfg.registerWorkspace !== false;
  const configuredTransport = cfg.transport || 'auto';
  const port = Number(cfg.webPort) || 3080;
  const host = cfg.webHost || '127.0.0.1';
  const base = `http://${host}:${port}`;
  const tokenFile = cfg.tokenFile || path.join(process.env.HOME || '/root', '.local/state/tinda/dsh', port + '.url');

  let cookie = null;
  let tokenUsed = null;
  let lastProbe = null;

  function launchToken() {
    try { return fs.readFileSync(tokenFile, 'utf8').trim().replace(/^.*token=/, ''); }
    catch { return null; }
  }

  async function ensureCookie(force = false) {
    const token = launchToken();
    if (!token) throw new Error('读不到 DSH 启动 token（' + tokenFile + '）');
    if (!force && cookie && tokenUsed === token) return cookie;
    const res = await fetch(`${base}/?token=${encodeURIComponent(token)}`, { redirect: 'manual' });
    const setCookie = res.headers.get('set-cookie') || '';
    const m = /(dsh-auth-[^=]+=[^;]+)/.exec(setCookie);
    if (!m) throw new Error('换取 cookie 失败（HTTP ' + res.status + '）');
    cookie = m[1];
    tokenUsed = token;
    log.debug('已用启动 token 换取 DSH cookie');
    return cookie;
  }

  async function rpc(endpoint, args, { timeoutMs = 20000, retryAuth = true } = {}) {
    const c = await ensureCookie();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base}/api/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: c },
        body: JSON.stringify({ type: 'client-request', rpcId: 'b' + Date.now(), method: endpoint, payload: { args } }),
        signal: ctrl.signal
      });
      if (res.status === 401 && retryAuth) {
        await ensureCookie(true);
        return rpc(endpoint, args, { timeoutMs, retryAuth: false });
      }
      const body = await res.json();
      const result = body.result;
      if (!result || result.ok !== true) {
        const err = new Error((result && result.error && result.error.message) || ('HTTP ' + res.status));
        err.code = result && result.error && result.error.code;
        throw err;
      }
      return result.value;
    } finally {
      clearTimeout(timer);
    }
  }

  /** 解析真实路径——DSH 用 realpath 做工作区身份。 */
  function canon(p) {
    try { return fs.realpathSync(p); } catch { return path.resolve(p); }
  }

  async function executeCommand(sessionId, line) {
    const v = await rpc('commands/execute', {
      agentId: sessionId,
      line,
      submittedAttachments: []
    }, { timeoutMs: 120000 });
    if (v === undefined || v === null) return null;
    const res = v.result || {};
    return { kind: res.kind || 'success', text: res.text || '', commandId: v.commandId };
  }

  async function listCommands(sessionId) {
    const v = await rpc('commands/list', { agentId: sessionId }, { timeoutMs: 15000 });
    return Array.isArray(v) ? v : [];
  }

  async function probe() {
    if (!enabled) return { ok: false, reason: '未启用' };
    try {
      await rpc('session/list', { _request: {} }, { timeoutMs: 8000 });
      return { ok: true, base };
    } catch (err) {
      return { ok: false, reason: err.message, base };
    }
  }

  function findWorkspaceId(cwd) {
    // 复原版不主动注册工作区；headless 模式也不需要 workspaceId。
    return null;
  }

  async function listSessions({ timeoutMs = 8000 } = {}) {
    const v = await rpc('session/list', { _request: {} }, { timeoutMs });
    if (Array.isArray(v)) return v;
    if (v && Array.isArray(v.sessions)) return v.sessions;
    if (v && Array.isArray(v.items)) return v.items;
    return [];
  }

  /**
   * 建会话。传 sessionId = 恢复已存在的会话（Host 会校验 cwd）；
   * 不传 = 新建。**绝不拿一个不存在的 id 去 create**——DSH 会把它当成新 id，
   * 那正是“莫名其妙多出一条空会话”的来源；调用方必须先确认 id 存在。
   */
  async function createSession({ cwd, sessionId, agentPreset } = {}, { timeoutMs = 20000 } = {}) {
    const request = {};
    if (sessionId) request.sessionId = sessionId;
    if (agentPreset) request.agentPreset = agentPreset;
    // 已注册的工作区用 workspaceId（Host 会把会话 attach 进去，侧边栏可见）；
    // 未注册的目录只能用 cwd（会话可续，但不属于任何侧边栏工作区）。
    const workspaceId = !sessionId ? findWorkspaceId(cwd) : null;
    if (workspaceId) request.workspaceId = workspaceId;
    else if (cwd) request.cwd = canon(cwd);
    return await rpc('session/create', { request }, { timeoutMs });
  }

  async function projections(sessionId, { timeoutMs = 10000 } = {}) {
    return await rpc('session/projections', { request: { sessionId } }, { timeoutMs });
  }

  async function page(sessionId, throughSeq, { maxMessages = 500, timeoutMs = 15000 } = {}) {
    const v = await rpc('session/page', {
      request: {
        address: { kind: 'session', sessionId },
        throughSeq,
        maxMessages
      }
    }, { timeoutMs });
    return v && Array.isArray(v.records) ? v.records : [];
  }

  async function prompt(sessionId, text, requestId, { mode = 'queue', timeoutMs = 15000 } = {}) {
    return await rpc('session/prompt', {
      request: {
        sessionId,
        mode,
        requestId,
        content: [{ type: 'text', text: String(text ?? '') }]
      }
    }, { timeoutMs });
  }

  async function cancel(sessionId, { timeoutMs = 8000 } = {}) {
    return await rpc('session/cancel', { request: { sessionId } }, { timeoutMs });
  }

  async function updateQueue(sessionId, itemId, action, { timeoutMs = 10000 } = {}) {
    return await rpc('session/updateQueue', { request: { sessionId, itemId, action } }, { timeoutMs });
  }

  /**
   * 还没轮到执行的排队消息：按 requestId 找到并撤回。
   * 已经开始的回合撤不回来（调用方再走 session/cancel）。
   */
  async function removeQueuedPrompt(sessionId, requestId, { timeoutMs = 10000 } = {}) {
    let proj;
    try { proj = await projections(sessionId, { timeoutMs }); } catch { return false; }
    const inbox = (proj && proj.values && proj.values.inbox) || {};
    const items = [...(inbox['next-turn'] || []), ...(inbox['next-step'] || [])];
    const hit = items.find((item) => item && item.source && item.source.rpcId === requestId);
    if (!hit || !hit.id) return false;
    await updateQueue(sessionId, hit.id, { kind: 'remove' }, { timeoutMs });
    return true;
  }

  async function rename(sessionId, title, { timeoutMs = 10000 } = {}) {
    return await rpc('session/rename', { request: { sessionId, title } }, { timeoutMs });
  }

  async function selectModel(sessionId, { provider, model, reasoningEffort } = {}, { timeoutMs = 15000 } = {}) {
    const request = { sessionId, provider, model };
    if (reasoningEffort) request.reasoningEffort = reasoningEffort;
    return await rpc('session/selectModel', { request }, { timeoutMs });
  }

  async function modelCatalog({ timeoutMs = 10000 } = {}) {
    return await rpc('session/modelCatalog', {}, { timeoutMs });
  }

  async function executeCommand(sessionId, line) {
    const v = await rpc('commands/execute', {
      agentId: sessionId,
      line,
      submittedAttachments: []
    }, { timeoutMs: 120000 });
    if (v === undefined || v === null) return null;
    const res = v.result || {};
    return { kind: res.kind || 'success', text: res.text || '', commandId: v.commandId };
  }

  async function listCommands(sessionId) {
    const v = await rpc('commands/list', { agentId: sessionId }, { timeoutMs: 15000 });
    return Array.isArray(v) ? v : [];
  }

  async function probe() {
    if (!enabled) {
      lastProbe = { ok: false, reason: 'transport=headless', base };
      return lastProbe;
    }
    try {
      await ensureCookie();
      await rpc('session/list', { _request: {} }, { timeoutMs: 5000 });
      lastProbe = { ok: true, base };
      return lastProbe;
    } catch (err) {
      lastProbe = { ok: false, reason: err.message, base };
      return lastProbe;
    }
  }

  return {
    configuredTransport,
    enabled,
    base,
    port,
    tokenFile,
    canon,
    findWorkspaceId,
    rpc,
    probe,
    listSessions,
    createSession,
    projections,
    page,
    prompt,
    cancel,
    updateQueue,
    removeQueuedPrompt,
    rename,
    selectModel,
    modelCatalog,
    executeCommand,
    listCommands,
    get lastProbe() { return lastProbe; }
  };
}

/** 在投影记录里找某个 requestId 的 seq；找不到返回 null。 */
export function findRequestSeq(records, requestId, { afterSeq = 0 } = {}) {
  const want = String(requestId || '');
  if (!want) return null;
  for (const rec of records || []) {
    const ev = rec && rec.type === 'event' ? rec.event : (rec && rec.event ? rec.event : rec);
    if (!ev || !Number.isFinite(ev.seq) || ev.seq < afterSeq) continue;
    if (JSON.stringify(ev).includes(want)) return ev.seq;
  }
  return null;
}

/** 折叠一轮投影：收集 assistant 文本/工具调用，识别 turn 结束。 */
export function foldTurnRecords(records, { afterSeq = 0, afterTurn = 0 } = {}) {
  let text = '';
  const toolCalls = [];
  let sawTurn = false;
  let ended = false;
  let reason = null;
  for (const rec of records || []) {
    const ev = rec && rec.type === 'event' ? rec.event : (rec && rec.event ? rec.event : rec);
    if (!ev || !Number.isFinite(ev.seq) || ev.seq < afterSeq) continue;
    if (ev.turn !== undefined && ev.turn > afterTurn) sawTurn = true;
    if (ev.type === 'assistant/message') {
      for (const part of (ev.data && ev.data.message && ev.data.message.content) || []) {
        if (part && part.type === 'text' && part.text) text += part.text;
        if (part && part.type === 'tool-call' && part.name) toolCalls.push(part.name);
      }
    }
    if (ev.type === 'turn/end' || ev.type === 'turn-end') {
      ended = true;
      reason = (ev.data && ev.data.reason) || { kind: 'completed' };
    }
  }
  return { text, toolCalls, sawTurn, ended, reason };
}
