/**
 * 目的：把 OneBot 11 的消息段归一成桥接器能用的纯文本/引用/类型信息，并提供消息层
 *       需要的几段纯文案（引用上下文、暂不支持提示、群身份披露、群 @ 前缀）。
 * 边界：只做解析与文案，不发网络请求、不读配置、不碰会话状态；引用正文的抓取在 bridge.mjs。
 * 依赖：无（纯函数）；被 units/bridge/bridge.mjs 与 test-message.mjs 引用。
 * 失败：不抛错；结构不认识就跳过，缺字段按空值处理。
 */

/** OneBot 段类型 → 给用户看的中文名。未知类型原样返回，便于排查。 */
const TYPE_NAMES = {
  record: '语音',
  video: '视频',
  file: '文件',
  forward: '合并转发',
  json: '卡片',
  xml: '卡片',
  markdown: '富文本',
};

/**
 * 目的：把一条 OneBot 消息（段数组或纯文本）拼成文本，并抽出 @、引用、图片与不支持的类型。
 * 输入：message（字符串或段数组）、selfId（机器人 QQ，用来判断是否 @ 了我）。
 * 输出：{ text, mentioned, repliedTo, unsupported, images }；
 *       text 里保留 [图片]/[表情]/[戳一戳] 这类占位，@ 自己的段被剔除。
 * 失败：不抛错；message 不是数组/字符串时返回空结构。
 * 副作用：无。
 */
export function normalizeMessage(message, selfId = '') {
  if (typeof message === 'string') {
    return { text: message.trim(), mentioned: false, repliedTo: null, unsupported: [], images: 0 };
  }
  if (!Array.isArray(message)) {
    return { text: '', mentioned: false, repliedTo: null, unsupported: [], images: 0 };
  }
  const out = [];
  const unsupported = [];
  let mentioned = false;
  let repliedTo = null;
  let images = 0;
  for (const seg of message) {
    if (!seg || typeof seg !== 'object') continue;
    const data = seg.data && typeof seg.data === 'object' ? seg.data : {};
    switch (seg.type) {
      case 'text':
        if (typeof data.text === 'string') out.push(data.text);
        break;
      case 'image':
        images++;
        out.push('[图片]');
        break;
      case 'face':
      case 'mface':
        out.push('[表情]');
        break;
      case 'poke':
        out.push('[戳一戳]');
        break;
      case 'reply':
        if (data.id != null && data.id !== '') repliedTo = String(data.id);
        break;
      case 'at':
        if (data.qq != null && data.qq !== '') {
          const qq = String(data.qq);
          if (selfId && qq === String(selfId)) mentioned = true; // @ 我：只记标志，不进正文
          else out.push('@' + qq);
        }
        break;
      case 'record':
      case 'video':
      case 'file':
      case 'forward':
      case 'json':
      case 'xml':
      case 'markdown':
        unsupported.push(seg.type);
        break;
      default:
        // 未知段不猜测内容；也不放进 unsupported，避免把普通扩展段当成“用户发了东西”。
        break;
    }
  }
  return {
    text: out.join('').trim(),
    mentioned,
    repliedTo,
    unsupported: [...new Set(unsupported)],
    images,
  };
}

/**
 * 目的：决定一个聊天在会话表里的 key——私聊按人，群默认按群，开启成员级后按“群+人”。
 * 输入：kind（private|group）、groupId、userId、groupSessionScope（group|member）。
 * 输出：字符串 key；字段缺失时仍返回稳定字符串，不抛错。
 * 失败：不抛错。副作用：无。
 */
export function chatKeyFor({ kind, groupId, userId, groupSessionScope } = {}) {
  if (kind === 'group') {
    return groupSessionScope === 'member'
      ? 'group:' + String(groupId ?? '') + ':' + String(userId ?? '')
      : 'group:' + String(groupId ?? '');
  }
  return 'private:' + String(userId ?? '');
}

/**
 * 目的：把被引用消息格式化成给模型看的一小段上下文；读不到时明确说“不可读”，不让模型猜。
 * 输入：quote = { ok, text, images, senderName, error } 或 null。
 * 输出：带换行的上下文块；没有引用时返回空串。
 * 失败：不抛错；字段缺失按“无文字/对方”处理。
 * 副作用：无。
 */
export function formatQuoteContext(quote) {
  if (!quote) return '';
  if (quote.ok) {
    const who = quote.senderName || '对方';
    let body;
    const onlyImage = /^(\[图片\])+$/.test(String(quote.text || ''));
    if (quote.text && !onlyImage) body = '「' + String(quote.text).replace(/\s+/g, ' ').slice(0, 500) + '」';
    else if (quote.images) body = '（无文字，含 ' + quote.images + ' 张图片）';
    else body = '（无文字）';
    return '（引用回复 ' + who + ' 的消息 ' + body + '）\n\n';
  }
  return '（引用消息不可读：' + (quote.error || '取不到被引用消息') +
    '。不要猜测引用内容，必要时请用户重发。）\n\n';
}

/** 目的：把 OneBot 类型数组转成中文名列表，给提示文案用。失败：不抛错。副作用：无。 */
export function typeNames(types) {
  const list = Array.isArray(types) ? types : [];
  return [...new Set(list.map((t) => TYPE_NAMES[t] || String(t)))];
}

/**
 * 目的：用户只发了不支持的消息（语音/文件等）时，回一句明确的“暂不支持”，
 *       而不是像旧版 default 分支那样静默吞掉。
 * 输入：types（OneBot 段类型数组）。输出：可直接发到 QQ 的一句话。
 * 失败：不抛错；空数组返回空串。副作用：无。
 */
export function unsupportedReply(types) {
  const names = typeNames(types);
  if (!names.length) return '';
  return '暂不支持' + names.join('、') + '消息。请改发文字或图片；语音/文件/合并转发目前拿不到内容。';
}

/**
 * 目的：本轮既有文字又有不支持的消息时，把“还有一部分没读到”告诉模型，避免它假装看过。
 * 输入：types；输出：拼在任务后面的说明块；空数组返回空串。
 * 失败：不抛错。副作用：无。
 */
export function unsupportedTaskNote(types) {
  const names = typeNames(types);
  if (!names.length) return '';
  return '（本轮还包含暂不支持的消息类型：' + names.join('、') +
    '，没有可读取的内容；如需处理请让用户改发文字/图片。）';
}

/**
 * 目的：群聊首次触发时披露“这是 AI + 本群会话怎么隔离”，只做一次，避免每轮噪音。
 * 输入：memberScoped（是否成员级会话）、groupReplyAt（回复是否已 @ 提问者）。
 * 输出：一段括号提示；调用方负责只发一次。
 * 失败：不抛错。副作用：无。
 */
export function disclosureText({ memberScoped = false, groupReplyAt = true } = {}) {
  const scope = memberScoped
    ? '本群每个成员各自一条会话，互相看不到对方的上下文。'
    : '本群共用一条会话，群成员都能看到这段上下文。';
  return '（提示：我是接入 DSH 的机器人，不是真人；' + scope +
    (groupReplyAt ? '' : '需要我时请 @ 我。') + '）';
}

/**
 * 目的：群回复要 @ 提问者时，生成 OneBot 的 CQ 前缀；号码不合法就返回空串，绝不拼坏消息。
 * 输入：QQ 号（数字或字符串）。输出：'[CQ:at,qq=123] ' 或 ''。
 * 失败：不抛错。副作用：无。
 */
export function atPrefix(qq) {
  const s = String(qq ?? '').trim();
  if (!/^\d{1,20}$/.test(s)) return '';
  return '[CQ:at,qq=' + s + '] ';
}
