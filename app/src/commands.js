/**
 * 目的：解析 / 指令并维护桥接器命令表。
 * 边界：只解析/文案/本地命令，不启动 DSH。
 * 依赖：policy.js；被 bridge.js 调用。
 * 失败：未知指令明确拒绝，不落入模型。
 */
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './log.js';
import { findSessionRef, validateSessionForResume, timeLabel } from './session-meta.js';
import { maskChatKey, roleAtLeast } from './policy.js';
import { describeChat, SessionOwnershipError } from './session-manager.js';

const log = logger('command');

/**
 *
 * 规则只有一条，但它必须严格成立：
 *
 *   - 以 `/` 开头  → **指令**：只有两种归宿，要么透传给 DSH 的真命令，
 *                     要么由桥接器自己处理；**绝不允许变成模型消息**。
 *   - 其他任何输入  → **文本**：整段当作对话内容交给 DSH。
 *
 * 历史教训：早期实现里 `parseCommand()` 只认自己的别名表，而 `bridge.js` 对
 * 「不认识」和「不是指令」没有区分——`/` 开头但没匹配上的输入会掉进模型分支，
 * 于是每敲一次 `/` 就多出一条全新会话（侧边栏里那堆 `okok` / `中文` 就是这么来的）。
 * 现在把「未知指令」做成一个显式结果，桥接器直接拒绝并提示，不再偷偷当文本。
 *
 * 另外，DSH 的真命令**不在桥接器里维护清单**：它由 `commands/list` 从 DSH 现场取。
 * 这里只维护桥接器自己的那几条，避免 DSH 升级后清单漂移。
 */

/** 透传给 DSH 的真命令（权威清单来自 commands/list，这里只作离线兜底）。 */
export const DSH_COMMANDS = [
  { name: 'compact',   desc: '压缩更早的对话历史',        hint: '' },
  { name: 'goal',      desc: '设置/查看长任务目标',        hint: '<目标>|clear|edit <目标>|pause|resume' },
  { name: 'plan',      desc: '进入/退出计划模式',          hint: '[off|消息]' },
  { name: 'permission',desc: '切换权限预设（沙箱+审批）',   hint: '<预设>' },
  { name: 'export',    desc: '导出本会话日志（ZIP）',       hint: '' },
  { name: 'feedback',  desc: '记录对本次会话的反馈',        hint: '<文字>' }
];

/** 桥接器自己的命令：这些是「传输层」能力，DSH 侧没有对应物。 */
export const BRIDGE_COMMANDS = [
  { name: 'help',   aliases: ['?', '帮助'],                       desc: '显示这份帮助',              hint: '' },
  { name: 'status', aliases: ['状态'],                            desc: '连接 / 会话 / 工作区 / 模型', hint: '' },
  { name: 'new',    aliases: ['reset', '新会话', '重置'],          desc: '开一段新会话（旧会话保留）', hint: '' },
  { name: 'sessions', aliases: ['history', '会话', '历史', '列表'],
                                                                  desc: '列出当前工作区会话',        hint: '' },
  { name: 'ws',     aliases: ['workspace', '工作区', 'use', 'switch', '切换'],
                                                                  desc: '查看或切换上下文',          hint: '[路径|会话 id]' },
  { name: 'ls',     aliases: ['列目录'],                           desc: '列工作区里的文件',          hint: '[子路径]' },
  { name: 'context',aliases: ['上下文', '最近消息'],                 desc: '群上下文缓冲里有什么',      hint: '[clear]' },
  { name: 'model',  aliases: ['模型'],                            desc: '查看或切换模型',            hint: '[别名]' },
  { name: 'stop',   aliases: ['中断'],                            desc: '中断当前任务',              hint: '' },
  { name: 'ping',   aliases: [],                                  desc: '存活探测',                  hint: '' }
];

/** 旧实现里自己发明、现已废除的指令：给出明确指引，而不是静默扔掉。 */
const RETIRED = new Map([
  ['压缩',    '改名为 DSH 的原生命令：/compact'],
  ['停止',    '改名为 /stop']
]);

const BRIDGE_BY_ALIAS = new Map();
for (const c of BRIDGE_COMMANDS) {
  BRIDGE_BY_ALIAS.set(c.name, c.name);
  for (const a of c.aliases) BRIDGE_BY_ALIAS.set(a.toLowerCase(), c.name);
}

const DSH_NAMES = new Set(DSH_COMMANDS.map((c) => c.name));

/** 是不是 `/` 开头的输入（两态判定的唯一入口）。 */
export function looksLikeCommand(text) {
  return typeof text === 'string' && text.startsWith('/');
}

/**
 * 解析一条 `/` 输入。
 * @returns {null}                       不是 `/` 输入
 * @returns {{kind:'bridge', name:string, args:string}}    桥接器自己的命令
 * @returns {{kind:'dsh', name:string, args:string}}       透传给 DSH 的命令
 * @returns {{kind:'retired', name:string, note:string}}   已废除的旧指令
 * @returns {{kind:'unknown', name:string}}                未知指令（拒绝，不落成文本）
 */
export function parseCommand(text) {
  if (!looksLikeCommand(text)) return null;
  const m = /^\/(\S+)\s*([\s\S]*)$/.exec(text);
  if (!m) return { kind: 'unknown', name: '' };
  const raw = m[1];
  const key = raw.toLowerCase();
  const args = (m[2] || '').trim();

  if (RETIRED.has(key)) return { kind: 'retired', name: raw, note: RETIRED.get(key) };

  const local = BRIDGE_BY_ALIAS.get(key);
  if (local) return { kind: 'bridge', name: local, args };

  if (DSH_NAMES.has(key)) return { kind: 'dsh', name: key, args };

  return { kind: 'unknown', name: raw };
}

/**
 * 帮助文本。`dshCommands` 由调用方从 DSH 现场取（commands/list），
 * 取不到时退回 DSH_COMMANDS 兜底表。
 */
export function helpText(dshCommands) {
  const dsh = (dshCommands && dshCommands.length ? dshCommands : DSH_COMMANDS);
  const lines = [];
  lines.push('两种输入：', '');
  lines.push('  · 以 / 开头  → 指令（下表的命令，不会变成对话内容）');
  lines.push('  · 其他内容    → 直接和 DSH 对话', '');

  lines.push('DSH 原生指令（直接透传，和 WebUI 里敲的是同一条命令）：');
  const w1 = Math.max(...dsh.map((c) => ('/' + c.name).length), 8);
  for (const c of dsh) {
    const head = ('/' + c.name).padEnd(w1 + 2);
    lines.push('  ' + head + (c.desc || '') + (c.hint ? '   ' + c.hint : ''));
  }

  lines.push('', '连接指令（桥接器自己处理）：');
  const w2 = Math.max(...BRIDGE_COMMANDS.map((c) => ('/' + c.name).length));
  for (const c of BRIDGE_COMMANDS) {
    const head = ('/' + c.name).padEnd(w2 + 2);
    lines.push('  ' + head + c.desc + (c.hint ? '   ' + c.hint : ''));
    if (c.aliases.length) lines.push('  ' + ''.padEnd(w2 + 2) + '别名：' + c.aliases.map((a) => '/' + a).join(' '));
  }

  lines.push('', '群里需要 @我，或回复我的消息；文件引用沿用 DSH 的 @ 语法：@src/index.js 或 @"带 空格 的路径"。');
  lines.push('我是接入 DSH 的机器人，不是真人。群聊默认共享一条会话，群成员都能看到上下文；' +
    '日志/状态保存在本机，面板默认只监听 127.0.0.1。');
  lines.push('会话：/sessions 列出当前工作区会话；/new 新开一段（旧会话保留，可 /ws 切回）。');
  lines.push('权限：/ws /sessions /model 需要 admin；/permission 需要 owner（见 config.policy.ownerUsers/adminUsers）。');
  lines.push('说明：桥接器走 headless 一次性运行器，会话不会出现在 DSH 侧边栏；/ws 只绑定 preset 为空、同 cwd 的会话。');
  return lines.join('\n');
}

/** 未知指令的拒绝话术。 */
export function unknownCommandText(name) {
  const known = [...DSH_COMMANDS.map((c) => '/' + c.name), ...BRIDGE_COMMANDS.map((c) => '/' + c.name)];
  return '没有这个指令：/' + name + '\n' +
    '（以 / 开头的输入不会当对话内容，所以它不会触发模型）\n' +
    '可用：' + known.join(' ') + '\n' +
    '只想聊天就直接发文字，不要带 /。';
}

/** 已废除指令的提示话术。 */
export function retiredCommandText(name, note) {
  return '/' + name + ' 已经不用了。\n' + note;
}

/**
 * DSH 的 @file 引用语法（来自 dsh-file-reference 文档）：
 * "@path 出现在输入开头或空白之后才触发；邮箱里的 @ 不算。
 *  @"带空格的路径" 用引号包起来。"
 * 这里只做解析与存在性校验，不读取内容——DSH 自己的语义就是
 * 「选中候选不会读取文件内容，模型必须自己调文件工具去看」。
 */
export function extractReferences(text) {
  const refs = [];
  const re = /(^|\s)@(?:"([^"]+)"|([^\s@]+))/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    refs.push({ target: m[2] !== undefined ? m[2] : m[3] });
  }
  return refs;
}

/** 把 @ 引用解析成绝对路径并标注是否存在，拼成给模型看的一小段提示。 */
export function describeReferences(text, workspace) {
  const refs = extractReferences(text);
  if (!refs.length) return '';
  const parts = [];
  for (const r of refs) {
    const abs = path.isAbsolute(r.target) ? r.target : path.resolve(workspace, r.target);
    let mark;
    try {
      const st = fs.statSync(abs);
      mark = st.isDirectory() ? '目录' : '文件';
      parts.push('@' + r.target + ' -> ' + abs + '（' + mark + '，存在）');
    } catch {
      parts.push('@' + r.target + ' -> ' + abs + '（未找到，需要先确认路径）');
    }
  }
  return '（@ 引用解析，当前工作区 ' + workspace + '：\n  ' + parts.join('\n  ') + '\n）';
}

function shortId(id) {
  return id ? id.replace(/^session-/, '').slice(0, 8) : '（无）';
}

function turnsLabel(turns) {
  return turns === null || turns === undefined ? '未知' : String(turns);
}

// 会话目录 slug 与元数据校验统一放在 session-info.js（与 bridge 共用）。

/** 这串东西像不像会话 id（uuid、带横线的 uuid，或裸前缀），而不是路径。 */
function looksLikeSessionRef(arg) {
  const s = String(arg || '').trim();
  return /^session-[0-9a-f-]{6,}$/i.test(s) || /^[0-9a-f][0-9a-f-]{5,}$/i.test(s);
}

/* ── 命令处理器 ──────────────────────────────────────────────────────────────
 * 与 BRIDGE_COMMANDS 一一对应，模块加载时校验（缺一个直接抛错）。
 *
 * 为什么不用一个大的 switch：那样每加一条命令都要改分发器，核心代码永远在动。
 * 现在加命令 = 元数据表加一行 + 这里加一个 handler，分发器不用改。
 */

/**
 * 唯一的上下文切换入口：切工作区、切会话都走它。
 * 两条分支最后都落到 ctx.bridge.bindChatContext()——命令层不直接改 chat/sessions。
 */
async function switchContext(ctx, args) {
  const c = ctx.chat;
  const slot = c.sessions[c.workspace] || { sessionId: null, turns: 0 };
  if (!args) {
    await ctx.reply([
      '当前工作区：' + c.workspace,
      '当前会话：' + (slot.sessionId || '（还没建；下一条消息会新开一条）'),
      '轮数：' + turnsLabel(slot.turns),
      '',
      '切换：/ws <路径>       换工作区（按 realpath 归一；会话按工作区记）',
      '      /ws <会话 id>    换会话（校验 preset/origin/cwd/运行态；支持唯一前缀）',
      '列出：/sessions        当前工作区会话、是否可续、完整 id',
      '新开：/new             旧会话保留，可随时 /ws 切回',
      '',
      '说明：桥接器用 headless 一次性运行器，会话不会出现在 DSH 侧边栏。'
    ].join('\n'));
    return;
  }

  // 像会话 id 就按会话处理；找不到再退回"当路径"（避免把名叫 a965f282 的目录判死）
  if (looksLikeSessionRef(args)) {
    const entries = await ctx.bridge.sessionCatalog(c.workspace);
    const r = findSessionRef(entries, args);
    if (r.entry) {
      const e = r.entry;
      const same = slot.sessionId && String(slot.sessionId).toLowerCase() === String(e.id).toLowerCase();
      if (same && ctx.bridge.isChatBusy && ctx.bridge.isChatBusy(ctx.chatKey)) {
        await ctx.reply('当前会话正在跑这一轮，不能重绑；等它结束或先 /stop。');
        return;
      }
      // P0-01/P1-01：preset/origin/cwd/running 不满足就拒绝，绝不给“切过去了”的假象。
      const check = validateSessionForResume(e, { workspace: c.workspace, activeSessionId: null });
      if (!check.ok) {
        await ctx.reply('不能绑定会话 ' + shortId(e.id) + '：\n' + check.reason +
          '\n（用 /sessions 看哪些会话可续）');
        return;
      }
      // 同一会话重绑保留已知轮数；换会话时由 bindChatContext 查 sessionTurns，
      // 查不到就是“未知”（null），不伪造 0。
      const bound = ctx.bridge.bindChatContext(ctx.chatKey, { workspace: c.workspace, sessionId: e.id });
      log.info('切换会话 ' + bound.sessionId + ' @ ' + maskChatKey(ctx.chatKey));
      await ctx.reply('已切到会话 ' + shortId(bound.sessionId) + '\n' + bound.sessionId +
        '\n（headless 会话不进 DSH 侧边栏；下一条消息就发进这条会话，轮数：' + turnsLabel(bound.turns) + '）');
      return;
    }
    if (!fs.existsSync(path.resolve(c.workspace, args))) {
      await ctx.reply(r.error);
      return;
    }
  }
  return switchWorkspace(ctx, args);
}

/**
 * 切工作区：只做本地绑定，不再通过 API 注册工作区。
 * 该工作区原来绑的会话也要过同一套校验；不满足就明确告知并新开，不偷偷沿用。
 */
async function switchWorkspace(ctx, target) {
  const c = ctx.chat;
  const raw = path.isAbsolute(target) ? target : path.resolve(c.workspace, target);
  let st;
  try { st = fs.statSync(raw); } catch { await ctx.reply('路径不存在：' + raw); return; }
  if (!st.isDirectory()) { await ctx.reply('不是目录：' + raw); return; }

  // P1-11：以 realpath 作为工作区身份。符号链接不再“警告但按两个工作区记”，
  // 而是直接归一到 DSH 实际使用的 cwd；会话反查也按这个路径。
  const next = ctx.bridge.dshApi?.canon ? ctx.bridge.dshApi.canon(raw) : (() => {
    try { return fs.realpathSync(raw); } catch { return raw; }
  })();

  let note = '\n（headless 会话不进 DSH 侧边栏；这是确定行为，不是故障）';
  if (next !== raw) note += '\n（已按 realpath 归一：' + raw + ' → ' + next + '）';

  const slot = c.sessions[next] || c.sessions[raw] || { sessionId: null, turns: 0 };
  let kept = slot.sessionId || null;
  let keptTurns = slot.turns;
  if (kept) {
    // 用同一套会话目录校验原绑定；不满足就明确说，不偷偷沿用会分叉的会话。
    const entries = await ctx.bridge.sessionCatalog(next);
    const found = findSessionRef(entries, kept);
    const check = found.entry
      ? validateSessionForResume(found.entry, { workspace: next, activeSessionId: null })
      : { ok: false, reason: '当前工作区找不到这条会话的元数据' };
    if (!check.ok) {
      note += '\n（原会话 ' + shortId(kept) + ' 没有沿用：' + check.reason + '；将新开一段。）';
      kept = null;
      keptTurns = 0;
    }
  }
  const bound = ctx.bridge.bindChatContext(ctx.chatKey, {
    workspace: next,
    sessionId: kept,
    turns: kept ? keptTurns : 0
  });
  log.info('切换工作区 ' + maskChatKey(ctx.chatKey) + ' -> ' + next);
  await ctx.reply('工作区已切到 ' + bound.workspace + '\n' +
    '（这个工作区' + (bound.sessionId
      ? '已有会话 ' + shortId(bound.sessionId) + '，下一条消息接着原来的聊，轮数：' + turnsLabel(bound.turns) + '。'
      : '还没有会话，下一条消息会新开一段。') + '）' + note);
}

const BRIDGE_HANDLERS = {
  async help(ctx) {
    await ctx.reply(helpText(ctx.dshCommands));
  },

  async ping(ctx) {
    await ctx.reply('pong · ' + new Date().toISOString());
  },

  async status(ctx) {
    const c = ctx.chat;
    const s = ctx.bridge.status.snapshot();
    const slot = c.sessions[c.workspace] || {};
    const pol = s.policy || (ctx.bridge.policySummary ? ctx.bridge.policySummary() : {});
    const denied = Array.isArray(pol.recentDenied) && pol.recentDenied.length
      ? pol.recentDenied.map((d) => d.chat + ' ' + d.why).join('；')
      : '无';
    const lf = c.lastFork;
    await ctx.reply([
      '状态：' + s.state,
      '通道：' + (s.onebot.connected
        ? '已连接 OneBot' + (s.onebot.selfId ? '（已登录）' : '')
        : '待机（OneBot 未连接）'),
      '会话：' + maskChatKey(ctx.chatKey),
      '工作区：' + c.workspace,
      'DSH 会话：' + shortId(slot.sessionId),
      '已对话轮数：' + turnsLabel(slot.turns),
      '模型：' + ctx.bridge.currentModelLabel(c),
      '策略：私聊=' + (pol.privateChat || '?') + ' 群聊=' + (pol.groupChat || '?') +
        '，用户白名单 ' + (pol.allowUsers ?? '?') + ' 个 / 群白名单 ' + (pol.allowGroups ?? '?') + ' 个',
      '权限预设：' + (pol.preset || 'danger-full-access') + '（' + (pol.presetSource || 'profile') + '）',
      '最近拒绝：' + denied,
      '最近分叉：' + (lf
        ? (shortId(lf.from) + ' → ' + shortId(lf.to) + '（' + String(lf.reason || '').slice(0, 80) +
          '；' + (lf.recoverable ? '旧会话保留' : '旧会话不可恢复') + '）')
        : '无'),
      '拟人化：' + (ctx.bridge.persona ? ctx.bridge.persona.describe() : '（未启用）'),
      '小动作：' + (ctx.bridge.interactions ? ctx.bridge.interactions.describe() : '（未启用）'),
      '待接续摘要：' + (c.seed ? '有（下一条消息会带上）' : '无')
    ].join('\n'));
  },

  async new(ctx) {
    const c = ctx.chat;
    const slot = c.sessions[c.workspace] || { sessionId: null, turns: 0 };
    const old = slot.sessionId;
    if (old) {
      if (slot.turns !== null && slot.turns !== undefined) ctx.bridge.recordSessionTurns(c, old, slot.turns);
      c.previousSessions = Array.isArray(c.previousSessions) ? c.previousSessions : [];
      c.previousSessions.push({ sessionId: old, at: new Date().toISOString(), reason: '/new' });
      if (c.previousSessions.length > 10) c.previousSessions.splice(0, c.previousSessions.length - 10);
    }
    // 新会话不继承旧 seed/turns；旧 sessionId 不删除，仍可用 /ws 切回。
    delete c.seed;
    const bound = ctx.bridge.bindChatContext(ctx.chatKey, {
      workspace: c.workspace, sessionId: null, turns: 0
    });
    log.info('新会话 @ ' + maskChatKey(ctx.chatKey) + (old ? '（旧会话保留 ' + shortId(old) + '）' : ''));
    await ctx.reply('已开新会话，下一条消息从 0 轮开始。' +
      (old ? '\n旧会话仍然保留：' + old + '\n需要接回时用 /ws ' + old : ''));
    return bound;
  },

  async sessions(ctx) {
    const c = ctx.chat;
    const slot = c.sessions[c.workspace] || {};
    const entries = await ctx.bridge.sessionCatalog(c.workspace);
    if (!entries.length) {
      await ctx.reply('当前工作区还没有可列出的会话：' + c.workspace + '\n下一条消息会新开一条；可用 /new 显式新开。');
      return;
    }
    const current = slot.sessionId;
    const lines = ['当前工作区：' + c.workspace,
      '会话（* = 当前；共 ' + entries.length + ' 条，最多列 15 条）：'];
    let shown = 0;
    let resumable = 0;
    for (const e of entries) {
      if (e.resumable) resumable += 1;
      if (shown >= 15) continue;
      shown += 1;
      const same = current && String(current).toLowerCase() === String(e.id).toLowerCase();
      const known = c.sessionTurns && Object.prototype.hasOwnProperty.call(c.sessionTurns, e.id)
        ? c.sessionTurns[e.id]
        : (same ? slot.turns : null);
      const state = e.running ? '运行中（现在不能切）'
        : e.resumable ? '可续'
          : ('不可续：' + (e.reason || '原因未知'));
      lines.push((same ? '* ' : '  ') + shortId(e.id) + '  ' + timeLabel(e.updatedAt) +
        '  ' + state + '  轮数=' + turnsLabel(known));
      lines.push('    ' + e.id);
    }
    if (entries.length > shown) lines.push('…还有 ' + (entries.length - shown) + ' 条未显示。');
    lines.push('', '可续 ' + resumable + ' / ' + entries.length + '；用 /ws <完整 id 或唯一前缀> 切换，/new 新开。');
    await ctx.reply(lines.join('\n'));
  },

  async ws(ctx, args) {
    return switchContext(ctx, args);
  },

  async ls(ctx, args) {
    const c = ctx.chat;
    // /ls 是 user 级命令，只允许看当前工作区内部；绝对路径和 ..
    // 以前能列整个宿主文件系统，属于原版的糟粕，这里收紧。
    const root = (() => { try { return fs.realpathSync(c.workspace); } catch { return c.workspace; } })();
    const dir = path.resolve(root, args || '.');
    let real = dir;
    try { real = fs.realpathSync(dir); } catch { /* 不存在时交给 readdir 报错 */ }
    const rel = path.relative(root, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      await ctx.reply('只能列当前工作区内的路径：' + root);
      return;
    }
    try {
      const entries = fs.readdirSync(real, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.'))
        .sort((a, b) => (Number(b.isDirectory()) - Number(a.isDirectory())) || a.name.localeCompare(b.name))
        .slice(0, 60);
      const lines = entries.map((e) => (e.isDirectory() ? '📁 ' : '📄 ') + e.name);
      await ctx.reply(dir + '\n' + (lines.length ? lines.join('\n') : '（空目录）'));
    } catch (err) {
      await ctx.reply('列目录失败：' + err.message);
    }
  },

  async context(ctx, args) {
    if (!String(ctx.chatKey).startsWith('group:')) {
      await ctx.reply('只有群聊才有上下文缓冲；私聊本来就能看到整段对话。');
      return;
    }
    const gid = String(ctx.chatKey).split(':')[1];
    if (String(args || '').trim().toLowerCase() === 'clear') {
      if (!roleAtLeast(ctx.role || 'none', 'admin')) {
        await ctx.reply('没有权限：/context clear 需要 admin。');
        return;
      }
      ctx.bridge.groupContext.clear(gid);
      await ctx.reply('已清掉本群上下文缓冲。');
      return;
    }
    const st = ctx.bridge.groupContext.stats();
    const recent = ctx.bridge.groupContext.recent(gid, 6);
    const lines = [
      '群上下文：' + ctx.bridge.groupContext.describe(),
      '缓冲：' + st.groups + ' 个群 / ' + st.messages + ' 条',
      '本群最近：' + (recent.length ? '' : '（空）')
    ];
    for (const m of recent) lines.push('  ' + new Date(m.at).toLocaleTimeString('zh-CN', { hour12: false }) + ' ' + (m.name || m.userId) + '：' + m.text.slice(0, 60));
    lines.push('', '下一条被 @ 时会带上这些（不含当前这句）；/context clear 清空。');
    await ctx.reply(lines.join('\n'));
  },

  async model(ctx, args) {
    const c = ctx.chat;
    const models = ctx.bridge.config.dsh.models || {};
    if (!args) {
      await ctx.reply('当前模型：' + ctx.bridge.currentModelLabel(c) +
        '\n（模型选择对后面每一轮 dsh 调用生效）');
      return;
    }
    if (!models[args]) {
      await ctx.reply('没有这个模型别名：' + args + '\n可用：' +
        (Object.keys(models).join(', ') || '（config.json 的 dsh.models 为空）'));
      return;
    }
    c.model = args;
    ctx.bridge.saveChats();
    const m = models[args];
    await ctx.reply('模型已切到 ' + m.provider + '/' + m.model);
  },

  async stop(ctx) {
    const killed = ctx.bridge.cancelChat(ctx.chatKey);
    await ctx.reply(killed ? '已中断当前任务。' : '当前没有在跑的任务。');
  }
};

// 元数据与处理器必须一一对应：缺了在加载时就炸，而不是运行时静默变成"未知命令"
for (const c of BRIDGE_COMMANDS) {
  if (typeof BRIDGE_HANDLERS[c.name] !== 'function') {
    throw new Error('BRIDGE_COMMANDS 里的 /' + c.name + ' 没有对应的 handler');
  }
}

/**
 * 只处理桥接器自己的命令。返回 true 表示已处理。
 * DSH 命令不在这里——它们由 bridge 走 DSH 的 commands/execute 转发。
 */
export async function runBridgeCommand(ctx, name, args) {
  // P1-21：命令级授权。只读/影响本聊天的命令（help/status/new/ls/stop/ping）允许 user；
  // /ws /sessions /model 会看到/改变工作区范围，要求 admin；/permission 在 bridge 里要求 owner。
  const MIN_ROLE = { ws: 'admin', sessions: 'admin', model: 'admin' };
  const need = MIN_ROLE[name];
  if (need && !roleAtLeast(ctx.role || 'none', need)) {
    await ctx.reply('没有权限：/' + name + ' 需要 ' + need +
      ' 角色（由 policy.ownerUsers / policy.adminUsers 配置）。');
    return true;
  }
  const handler = BRIDGE_HANDLERS[name];
  if (!handler) { await ctx.reply(unknownCommandText(name)); return true; }
  await handler(ctx, args);
  return true;
}

export { helpText as defaultHelpText };
