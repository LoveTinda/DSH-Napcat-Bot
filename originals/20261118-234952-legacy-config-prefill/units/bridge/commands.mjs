/**
 * 目的：桥接器的命令表——`/help` 的原文规格（docs/命令表-help原文.md）落成代码：
 *       命令名、别名、角色门槛、是否透传给 DSH、以及每条的一句话说明与详细用法。
 * 边界：只做解析与文案，不执行业务；执行在 bridge.mjs（本地命令）或 DSH（透传命令）。
 * 依赖：无（纯数据 + 纯函数）；被 bridge.mjs 与 test-commands.mjs 引用。
 * 失败：不抛错；不认识的一律返回 unknown，由调用方回「不认识这条命令」。
 */

/**
 * 目的：命令总表。字段含义：
 *   name    主名（不带斜杠）
 *   alias   别名（不带斜杠，中英文都算）
 *   role    最低角色：user | admin | owner
 *   kind    local（桥接器自己处理）/ passthrough（原样交给 DSH）/ pending（规格里有、还没实现）
 *   args    用法后缀，help 里显示
 *   desc    一句话说明
 *   detail  详细用法（/help <命令> 时显示）
 *   group   帮助里的分组
 */
export const COMMANDS = [
  // ---- 通用 ----
  { name: 'help', alias: ['?', '帮助'], role: 'user', kind: 'local', group: '通用', args: '[命令]', desc: '这份帮助；给命令名看详细用法', detail: '/help — 列出全部命令\n/help <命令> — 看某条命令的详细用法，例如 /help output' },
  { name: 'status', alias: ['状态'], role: 'user', kind: 'local', group: '通用', args: '', desc: '连接 / 会话 / 策略 / 后端状态', detail: '/status — 打印当前后端、监听地址、会话 id、策略摘要、计数' },
  { name: 'ping', alias: [], role: 'user', kind: 'local', group: '通用', args: '', desc: '存活探测', detail: '/ping — 回一句 pong 和运行时长' },

  // ---- 会话与上下文 ----
  { name: 'new', alias: ['reset', '新会话', '重置'], role: 'user', kind: 'local', group: '会话与上下文', args: '[标题]', desc: '开新会话（旧会话保留在 DSH 里）', detail: '/new — 丢掉当前 chat 的会话映射，下一条消息开新会话\n/new 标题 — 同上，标题只用于回执' },
  { name: 'stop', alias: ['中断'], role: 'user', kind: 'local', group: '会话与上下文', args: '', desc: '中断当前这一轮', detail: '/stop — 杀掉这个聊天正在跑的 DSH 子进程；排队中的下一条不受影响' },
  { name: 'sessions', alias: ['history', '会话', '历史', '列表'], role: 'user', kind: 'local', group: '会话与上下文', args: '[all]', desc: '列出本聊天的会话', detail: '/sessions — 列当前聊天的会话映射\n/sessions all — 需要 admin，列出全部聊天（号码脱敏）' },
  { name: 'session', alias: ['sid', '会话管理'], role: 'user', kind: 'local', group: '会话与上下文', args: '[info|new|use <id>]', desc: '会话详情与管理', detail: '/session — 同 info\n/session info — 当前会话 id、建立时间、轮数\n/session new — 同 /new\n/session use <id> — 切到指定 DSH 会话（需要 admin）' },
  { name: 'context', alias: ['上下文', '最近消息', 'ctx'], role: 'user', kind: 'local', group: '会话与上下文', args: '[clear]', desc: '群上下文缓冲：有哪些、下一条会带什么', detail: '/context — 显示本群缓冲的条数、时间范围，以及下一条会注入的预览\n/context clear — 清掉本群缓冲（admin）' },
  { name: 'ws', alias: ['workspace', '工作区', 'use', 'switch', '切换'], role: 'admin', kind: 'pending', group: '会话与上下文', args: '[编号|id|路径]', desc: '切换会话或工作区（未实现）', detail: '/ws — 切换工作区；当前桥接器每轮用 DSH 的默认工作区，尚未实现切换' },
  { name: 'ls', alias: ['列目录'], role: 'user', kind: 'pending', group: '会话与上下文', args: '[子路径]', desc: '列工作区文件（未实现）', detail: '/ls — 列工作区文件；为了不让 QQ 变成文件浏览器，暂不实现' },

  // ---- 模型与风格 ----
  { name: 'model', alias: ['模型'], role: 'admin', kind: 'pending', group: '模型与风格', args: '[别名]', desc: '查看或切换模型（未实现）', detail: '/model — 切换模型；当前由 headless profile 的默认模型决定，尚未实现运行时切换' },
  { name: 'effort', alias: ['推理强度', '思考强度'], role: 'admin', kind: 'pending', group: '模型与风格', args: '[off|low|high|max|auto]', desc: '推理强度（未实现）', detail: '/effort — 推理强度；同上，由 profile 配置决定' },
  { name: 'output', alias: ['输出'], role: 'admin', kind: 'local', group: '模型与风格', args: '[档位|--help]', desc: '输出详细程度', detail: '/output — 看当前档位与四档说明（minimalist / concise / detailed / complete）\n/output <档位> — 切换本聊天的档位，下一轮生效' },
  { name: 'persona', alias: ['人设'], role: 'user', kind: 'pending', group: '模型与风格', args: '[add <id> <名字>|<提示词>]', desc: '人设 = DSH preset（未实现）', detail: '/persona — 人设；旧实现映射到 DSH 的 agent preset，新桥接器尚未接' },

  // ---- 管理与诊断 ----
  { name: 'balance', alias: ['余额', '查余额'], role: 'admin', kind: 'pending', group: '管理与诊断', args: '', desc: '查 DeepSeek 账户余额（未实现）', detail: '/balance — 查余额；账号登录态下没有公开余额接口，暂不实现' },
  { name: 'policy', alias: ['策略', 'acl'], role: 'user', kind: 'local', group: '管理与诊断', args: '[测试文本]', desc: '策略命中与能力', detail: '/policy — 显示当前策略摘要与角色\n/policy <一段话> — 拿这段话当假消息，告诉你「会回 / 不会回」以及为什么' },
  { name: 'notice', alias: ['提示', '使用说明'], role: 'user', kind: 'local', group: '管理与诊断', args: '[off|on]', desc: '本群使用提示的开关', detail: '/notice — 查看本聊天的提示开关\n/notice off|on — 关掉/打开「第一次被 @ 时的那段使用说明」' },

  // ---- DSH 原生（透传）----
  { name: 'compact', alias: [], role: 'user', kind: 'passthrough', group: 'DSH 原生', args: '', desc: '压缩更早的对话历史', detail: '/compact — 原样交给 DSH；由 DSH 决定是否支持与如何压缩' },
  { name: 'export', alias: [], role: 'user', kind: 'passthrough', group: 'DSH 原生', args: '', desc: '导出本会话日志（ZIP）', detail: '/export — 原样交给 DSH' },
  { name: 'feedback', alias: [], role: 'user', kind: 'passthrough', group: 'DSH 原生', args: '[文字]', desc: '记录对本次会话的反馈', detail: '/feedback <文字> — 原样交给 DSH' },
  { name: 'goal', alias: [], role: 'user', kind: 'passthrough', group: 'DSH 原生', args: '[目标|clear|edit <目标>|pause|resume]', desc: '长任务目标：设置 / 查看 / 清除', detail: '/goal ... — 原样交给 DSH' },
  { name: 'permission', alias: [], role: 'owner', kind: 'passthrough', group: 'DSH 原生', args: '[预设]', desc: '切换权限预设（沙箱 + 审批）', detail: '/permission [预设] — 原样交给 DSH；仅 owner' },
  { name: 'plan', alias: [], role: 'user', kind: 'passthrough', group: 'DSH 原生', args: '[off|消息]', desc: '进入 / 退出计划模式', detail: '/plan ... — 原样交给 DSH' },
];

const byName = new Map();
for (const c of COMMANDS) {
  byName.set(c.name, c);
  for (const a of c.alias) byName.set(a, c);
}

/**
 * 目的：判断一段文本是不是命令，并解析出命令、参数。
 * 输入：原始文本（可能是任意内容的开头）。
 * 输出：{ cmd, name, args, raw } 或 null（不是命令）。
 * 失败：不抛错；`/` 后面是空的按非命令处理（避免把单独的斜杠当指令）。
 */
export function parseCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw.startsWith('/')) return null;
  const body = raw.slice(1).trim();
  if (!body) return null;
  const [head, ...rest] = body.split(/\s+/);
  const cmd = byName.get(head.toLowerCase()) || byName.get(head);
  return { cmd: cmd || null, name: head, args: rest.join(' ').trim(), raw };
}

/**
 * 目的：整份帮助文本，按 group 分组，标出未实现/透传。
 * 输入：无。
 * 输出：可直接发到 QQ 的字符串。
 * 失败：无。副作用：无。
 */
export function helpText() {
  const groups = [...new Set(COMMANDS.map((c) => c.group))];
  const lines = [
    '两种输入：',
    '  · 以 / 开头  → 指令（不会变成对话内容）',
    '  · 其他内容    → 直接和 DSH 对话',
    '',
  ];
  for (const g of groups) {
    lines.push(g + '：');
    for (const c of COMMANDS.filter((x) => x.group === g)) {
      const alias = c.alias.length ? ' · 别名 /' + c.alias.join(' /') : '';
      const mark = c.kind === 'pending' ? '（未实现）' : c.kind === 'passthrough' ? '（透传 DSH）' : '';
      lines.push('  · /' + c.name + (c.args ? ' ' + c.args : '') + ' — ' + c.desc + mark + alias);
    }
    lines.push('');
  }
  lines.push('说明：');
  lines.push('  · 群里需要 @ 我（策略 privateChat/groupChat 见 /policy）。');
  lines.push('  · /help <命令> 看详细用法，例如 /help output。');
  return lines.join('\n').trim();
}

/**
 * 目的：单条命令的详细用法；找不到时回一句可用的提示。
 * 输入：命令名（可带斜杠）。
 * 输出：字符串。
 * 失败：无。副作用：无。
 */
export function helpFor(name) {
  const key = String(name ?? '').trim().replace(/^\//, '');
  const c = byName.get(key) || byName.get(key.toLowerCase());
  if (!c) return '没有这条命令：/' + key + '\n用 /help 看全部命令';
  const alias = c.alias.length ? '\n别名：' + c.alias.map((a) => '/' + a).join(' ') : '';
  const kind = c.kind === 'pending' ? '\n状态：规格里有，当前还没实现（会明确告诉你没实现，不假装能做）'
    : c.kind === 'passthrough' ? '\n状态：原样交给 DSH' : '\n状态：桥接器本地处理';
  return c.detail + alias + kind;
}

/** 目的：不认识命令时的回执，避免沉默。输入：命令名；输出：字符串。 */
export function unknownCommandText(name) {
  return '不认识 /' + name + '\n用 /help 看全部命令';
}

/** 目的：还没实现的命令的回执。输入：命令对象；输出：字符串。 */
export function pendingCommandText(c) {
  return '/' + c.name + ' 还没实现：' + c.desc + '\n用 /help 看现在能用的命令';
}
