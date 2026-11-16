/**
 * 目的：解析并执行模型写在回复正文里的交互动作标记（[[react:…]] / [[recall]] / [[poke]]），
 *       让桥接器能给用户消息加表情、撤回本轮气泡、戳一戳对方；解析时把标记从可见正文里删掉。
 * 边界：只做解析与 OneBot 动作调用，不负责发正文、不保存聊天记录、不判断谁能触发；
 *       代码围栏内的标记一律不解析；每轮动作上限与总时限由调用方传入，模块自己不做重试。
 * 依赖：无第三方依赖；运行时用全局 fetch / AbortSignal（桥接器注入 api、token 与超时）。
 *       被 units/bridge/bridge.mjs 依赖，test-interactions.mjs 直接调用。
 * 失败：parseActions 不抛错（坏输入按空/原样文本处理）；runActions 逐动作捕获异常，
 *       永不向调用方抛错，返回 { executed, failed, skipped, errors }，由调用方记 warn。
 *       动作失败/超时不能影响正文，正文由 bridge.mjs 先发、再执行动作。
 */

/**
 * 配置默认值。名字与 bridge.mjs 的环境变量一一对应，范围校验也在这里集中写一次。
 * 为什么是这些数：2 个动作是旧版 P1-02 的结论（再多会刷屏）；2500ms 是旧版 emit() 的
 * 总时限，够本机 NapCat 跑完 2 个请求，又不会让一轮回复明显变慢。
 */
export const DEFAULT_INTERACTIONS = Object.freeze({
  enabled: true,
  groupPoke: false,
  maxActions: 2,
  timeoutMs: 2500,
});

/** 动作数量上限：配置键允许 1–5；超过 5 个动作在 QQ 里已经像刷屏，不是正常回复。 */
export const MAX_ACTIONS_CAP = 5;

/** 动作总时限的合法区间：低于 100ms 连一次本机 HTTP 都跑不完；高于 10s 会明显拖慢一轮。 */
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 10000;

/**
 * 中文表情名 → QQ 系统表情 ID（字符串，OneBot set_msg_emoji_like 的 emoji_id）。
 * 来源：本机 QQ 的 face_config.json（QSid 字段），不是猜的：
 * 赞=76、爱心=66、笑哭=182、鼓掌=99、疑问=32、捂脸=264。
 * 没有列出的名字按「表情 ID 原样传」处理，比如 [[react:123]] 就是 emoji_id="123"。
 */
export const EMOJI_IDS = Object.freeze({
  赞: '76',
  爱心: '66',
  笑哭: '182',
  鼓掌: '99',
  疑问: '32',
  捂脸: '264',
});

// 只认三种动作；名字大小写不敏感，react 必须带冒号和非空参数。
// recall/poke 带参数（如 [[recall:now]]）不匹配，避免把未知写法误当动作执行。
const ACTION_RE = /\[\[\s*(react|recall|poke)\s*(?::([^\]]*))?\]\]/gi;

/** 目的：把纯数字 ID 转成 number，其余原样返回；OneBot 实现里 user_id/group_id 更常要 number。 */
function toOneBotId(raw) {
  const s = String(raw == null ? '' : raw);
  return /^\d+$/.test(s) ? Number(s) : raw;
}

/** 目的：把配置值夹进合法整数区间；非法值退回默认值。失败：不抛错。副作用：无。 */
function clampInt(raw, fallback, min, max) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

/**
 * 目的：把一行里匹配到的动作文本转成动作对象；不合法时返回 null，让调用方原样保留。
 * 输入：正则捕获的动作名与参数（参数 undefined = 没有冒号）。
 * 输出：{ kind:'react', name, emojiId } / { kind:'recall' } / { kind:'poke' } / null。
 * 失败：不抛错。副作用：无。
 */
function toAction(kindRaw, payload) {
  const kind = String(kindRaw || '').toLowerCase();
  if (kind === 'react') {
    if (payload === undefined) return null;
    const name = String(payload).trim();
    if (!name) return null;
    return { kind: 'react', name, emojiId: EMOJI_IDS[name] || name };
  }
  if (kind === 'recall' || kind === 'poke') {
    // 有冒号就算带了参数：[[recall:]] / [[poke:x]] 都不是合法动作，原样留在正文里。
    if (payload !== undefined) return null;
    return { kind };
  }
  return null;
}

/**
 * 目的：从一条回复里解析动作标记，并返回删掉标记后的可见正文。
 * 输入：text 原始回复；options.maxActions 每轮最多保留几个（1–5，缺省 2）。
 * 输出：{ text, actions, ignoredActions }。actions 按正文出现顺序取前 N 个；
 *       ignoredActions 是超出上限、已从正文删掉但不执行的动作（供调用方记日志）。
 * 失败：不抛错；非字符串按 String() 处理。
 * 副作用：无。
 * 规则：
 * - 先按行扫描，``` 围栏内的行完全不动（跨多行/未闭合围栏都按「围栏内」处理）；
 * - 标记独占一行时整行删掉，避免留下空行；连续 3 个以上换行压成 1 个空行；
 * - 只做整体首尾 trim，不 trim 每行开头，段落缩进原样保留。
 */
export function parseActions(text, options = {}) {
  const maxActions = clampInt(options.maxActions, DEFAULT_INTERACTIONS.maxActions, 1, MAX_ACTIONS_CAP);
  const source = String(text == null ? '' : text);
  const actions = [];
  const ignoredActions = [];
  let inFence = false;
  const kept = [];

  for (const line of source.split('\n')) {
    // 围栏行本身不解析：``` 后面可能跟语言名，里面也可能恰好有标记。
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      kept.push(line);
      continue;
    }
    if (inFence) {
      kept.push(line);
      continue;
    }
    let hadAction = false;
    const cleaned = line.replace(ACTION_RE, (whole, kind, payload) => {
      const action = toAction(kind, payload);
      if (!action) return whole;
      hadAction = true;
      if (actions.length < maxActions) actions.push(action);
      else ignoredActions.push(action);
      return '';
    });
    // 整行只有标记：删掉整行，避免正文里多出一个空行。
    if (hadAction && cleaned.trim() === '') continue;
    kept.push(cleaned.replace(/[ \t]+$/, ''));
  }

  const visible = kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { text: visible, actions, ignoredActions };
}

/**
 * 目的：生成「本会话有这些标记」的提示词；只在每个 DSH 会话第一次拼 prompt 时用。
 * 输入：options.enabled / maxActions / groupPoke（缺省取 DEFAULT_INTERACTIONS）。
 * 输出：一段短文本；enabled=false 时返回空字符串（关闭时不要浪费 token）。
 * 失败：不抛错。副作用：无。
 */
export function interactionHint(options = {}) {
  if (options.enabled === false) return '';
  const maxActions = clampInt(options.maxActions, DEFAULT_INTERACTIONS.maxActions, 1, MAX_ACTIONS_CAP);
  return [
    '[小动作] 需要时可在正文里写标记，桥接器会执行并从正文里删掉，不会显示给用户：',
    '[[react:赞]] 给用户这条消息加表情（可用：赞/爱心/笑哭/鼓掌/疑问/捂脸，或数字表情 ID）；',
    '[[recall]] 撤回本轮已发出的所有气泡；[[poke]] 戳一戳发消息的人（群里默认关闭）。',
    '每轮最多 ' + maxActions + ' 个；代码围栏里的标记不执行。',
  ].join('\n');
}

/**
 * 目的：给日志/面板一句话说明当前交互动作配置。
 * 输入：enabled / groupPoke / maxActions / timeoutMs（缺省取 DEFAULT_INTERACTIONS）。
 * 输出：短字符串；关闭时明确说「标记原样保留」。
 * 失败：不抛错。副作用：无。
 */
export function describeInteractions(options = {}) {
  const enabled = options.enabled !== false;
  if (!enabled) return '关（正文里的标记原样保留）';
  const maxActions = clampInt(options.maxActions, DEFAULT_INTERACTIONS.maxActions, 1, MAX_ACTIONS_CAP);
  const timeoutMs = clampInt(options.timeoutMs, DEFAULT_INTERACTIONS.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  return '开 · 每轮最多 ' + maxActions + ' 个 · 总时限 ' + timeoutMs + 'ms · 群 poke ' +
    (options.groupPoke ? '开' : '关');
}

/**
 * 目的：按顺序执行动作，给用户消息加表情、撤回本轮气泡、戳一戳。
 * 输入：
 *   actions   parseActions 的 actions；
 *   context   { info: { kind, userId, groupId, messageId }, messageIds: 本轮已发出的 message_id[] }；
 *   options   { api, token, groupPoke, maxActions, timeoutMs, fetchImpl }。
 * 输出：{ executed, failed, skipped, errors }；executed/failed 按「动作」计数（不是 HTTP 请求数）。
 * 失败：从不抛错；每个动作单独 try/catch，错误只进 errors（调用方记 warn）。总时限到后不再发请求。
 * 副作用：向 OneBot HTTP API 发请求；不写文件、不改全局状态。
 */
export async function runActions(actions, context, options = {}) {
  const list = Array.isArray(actions) ? actions : [];
  const maxActions = clampInt(options.maxActions, DEFAULT_INTERACTIONS.maxActions, 1, MAX_ACTIONS_CAP);
  const timeoutMs = clampInt(options.timeoutMs, DEFAULT_INTERACTIONS.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const api = String(options.api || '').replace(/\/+$/, '');
  const info = context && context.info ? context.info : {};
  const messageIds = context && Array.isArray(context.messageIds) ? context.messageIds : [];
  const headers = { 'content-type': 'application/json' };
  if (options.token) headers.authorization = 'Bearer ' + options.token;

  const result = { executed: 0, failed: 0, skipped: 0, errors: [] };
  const deadline = Date.now() + timeoutMs;

  /** 目的：发一个 OneBot 动作请求并校验 status；失败抛错。副作用：一次本机 HTTP。 */
  const call = async (action, body) => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('动作总时限已到');
    const res = await fetchImpl(api + '/' + action, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(left),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || (data && data.status && data.status !== 'ok')) {
      throw new Error(action + ' 失败 HTTP ' + res.status + ' ' + JSON.stringify(data).slice(0, 120));
    }
  };

  for (const action of list.slice(0, maxActions)) {
    if (!action || typeof action !== 'object') { result.skipped++; continue; }
    try {
      if (action.kind === 'react') {
        if (info.messageId == null || info.messageId === '') throw new Error('没有用户消息 id，无法加表情');
        await call('set_msg_emoji_like', { message_id: info.messageId, emoji_id: String(action.emojiId) });
        result.executed++;
      } else if (action.kind === 'recall') {
        const ids = [...new Set(messageIds.filter((id) => id != null && id !== ''))];
        if (!ids.length) { result.skipped++; continue; }
        for (const id of ids) await call('delete_msg', { message_id: id });
        result.executed++;
      } else if (action.kind === 'poke') {
        // 群 poke 默认关：群聊的触发权由 mention 策略决定，不能让模型用一个标记绕过去。
        if (info.kind === 'group' && !options.groupPoke) { result.skipped++; continue; }
        if (info.kind === 'group') {
          if (info.groupId == null || info.groupId === '') throw new Error('没有群号，无法群戳');
          if (info.userId == null || info.userId === '') throw new Error('没有用户 QQ，无法群戳');
          await call('group_poke', { group_id: toOneBotId(info.groupId), user_id: toOneBotId(info.userId) });
        } else {
          if (info.userId == null || info.userId === '') throw new Error('没有用户 QQ，无法戳一戳');
          await call('friend_poke', { user_id: toOneBotId(info.userId) });
        }
        result.executed++;
      } else {
        result.skipped++;
      }
    } catch (e) {
      result.failed++;
      result.errors.push({
        kind: String(action.kind || '?'),
        message: String((e && e.message) || e).slice(0, 160),
      });
    }
  }
  return result;
}
