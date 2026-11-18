/**
 * 目的：记住每个群「最近聊了什么」，在机器人被 @ 时把这几条拼进提示词——不然它只会看见
 *       孤零零的一句 @，不知道前面在聊什么。旧机器人的 groupContext 就是这个。
 * 边界：只在内存里留最近若干条纯文本；不落盘、不写日志、不进面板正文；
 *       不做相关度排序/LLM 重排（旧实现有，这里先按时间取最近 N 条）。
 * 依赖：无（纯数据 + 纯函数）；被 bridge.mjs 与 test-group-context.mjs 引用。
 * 失败：不抛错；超出容量/过期就丢最旧的。
 */

/** 默认参数：条数与字符数都刻意留小，别让一句 @ 拖进几千字上下文。 */
export const DEFAULT_GROUP_CONTEXT = Object.freeze({
  enabled: true,
  /** 每个群最多留几条 */
  maxMessages: 8,
  /** 每群最多留多少个群（防止被拉进大量群后内存涨） */
  maxGroups: 50,
  /** 注入块的字符上限 */
  maxChars: 1200,
  /** 多久以前的消息不再注入（分钟） */
  ttlMinutes: 120,
  /** 单条消息最多保留多少字（超长截断，避免一条 4000 字顶满缓冲） */
  maxMessageChars: 300,
});

/**
 * 目的：把「谁说了什么」压成一行，供注入块使用。
 * 输入：{ name, userId, text }；输出：'昵称(a1b2): 内容' 或 '某个群友(a1b2): 内容'。
 * 失败：不抛错。副作用：无。
 */
export function formatLine(item) {
  const id = String(item.userId ?? '');
  const tail = id.length >= 4 ? id.slice(-4) : id;
  const who = item.name ? String(item.name).slice(0, 24) : '群友';
  return who + '(' + tail + '): ' + String(item.text ?? '');
}

/**
 * 目的：创建一个群上下文缓冲（有容量上限与过期清理），供桥接器持有。
 * 输入：参数对象（覆盖 DEFAULT_GROUP_CONTEXT）。
 * 输出：{ record, recent, buildBlock, stats, clear, describe }
 * 失败：不抛错。副作用：只在内存里改自己的结构。
 */
export function createGroupContext(opts = {}) {
  const o = { ...DEFAULT_GROUP_CONTEXT, ...opts };
  /** groupId → [{ userId, name, text, at, messageId }] */
  const groups = new Map();

  /** 目的：丢掉过期消息；输入 now；输出 无。 */
  const prune = (now = Date.now()) => {
    const ttl = o.ttlMinutes * 60 * 1000;
    for (const [gid, list] of groups) {
      const kept = list.filter((m) => now - m.at <= ttl);
      if (kept.length) groups.set(gid, kept);
      else groups.delete(gid);
    }
  };

  return {
    /**
     * 目的：记一条群消息（不管是不是 @ 我——上下文要的是「前面聊了什么」）。
     * 输入：{ groupId, userId, name, text, at, messageId }。
     * 输出：true 表示记下了；false 表示被过滤（空文本/开关关闭）。
     * 失败：不抛错。副作用：改内存缓冲，可能清理最旧的群。
     */
    record(item = {}) {
      if (!o.enabled) return false;
      const gid = String(item.groupId ?? '');
      const text = String(item.text ?? '').trim();
      if (!gid || !text) return false;
      const list = groups.get(gid) || [];
      list.push({
        userId: String(item.userId ?? ''),
        name: String(item.name ?? '').slice(0, 32),
        text: text.slice(0, o.maxMessageChars),
        at: Number(item.at) || Date.now(),
        messageId: item.messageId,
      });
      // 只留最近 N 条
      groups.set(gid, list.slice(-o.maxMessages));
      // 群太多：丢最久没动静的
      if (groups.size > o.maxGroups) {
        const oldest = [...groups.entries()]
          .map(([k, v]) => ({ k, at: v.length ? v[v.length - 1].at : 0 }))
          .sort((a, b) => a.at - b.at)
          .slice(0, groups.size - o.maxGroups);
        for (const x of oldest) groups.delete(x.k);
      }
      return true;
    },

    /**
     * 目的：取某个群最近的若干条（默认 N-1 条，最后一条是当前这句）。
     * 输入：groupId、count。
     * 输出：数组（按时间正序）；没有就空数组。
     * 失败：不抛错。副作用：清理过期消息。
     */
    recent(groupId, count = o.maxMessages) {
      prune();
      const list = groups.get(String(groupId)) || [];
      return list.slice(-count).map((m) => ({ ...m }));
    },

    /**
     * 目的：把上下文拼成一段能塞进提示词的文本；没内容就返回空串。
     * 输入：groupId；输出：字符串（含标题，末尾带空行）。
     * 失败：不抛错。副作用：无。
     */
    buildBlock(groupId) {
      if (!o.enabled) return '';
      const list = this.recent(groupId, o.maxMessages);
      if (!list.length) return '';
      // 最后一条通常是「当前这句」，注入时排除掉，避免重复
      const history = list.slice(0, -1);
      if (!history.length) return '';
      const head = '[群聊上下文] 最近 ' + history.length + ' 条（不含本次这句，仅供理解在聊什么）：';
      const lines = [];
      let used = head.length;
      // 从**最新**往前加：字数不够时丢掉最旧的，留下的才是「刚才在聊什么」
      for (let i = history.length - 1; i >= 0; i--) {
        const line = '- ' + formatLine(history[i]);
        if (used + line.length + 1 > o.maxChars) break;
        lines.unshift(line);
        used += line.length + 1;
      }
      if (!lines.length) return '';
      return head + '\n' + lines.join('\n') + '\n\n';
    },

    /**
     * 目的：给面板/命令看的统计——只有数量和时间，没有正文。
     * 输出：{ enabled, groups, messages, oldestAt, newestAt }
     * 失败：不抛错。副作用：清理过期消息。
     */
    stats() {
      prune();
      let messages = 0, oldestAt = 0, newestAt = 0;
      for (const list of groups.values()) {
        messages += list.length;
        if (list.length) {
          const first = list[0].at, last = list[list.length - 1].at;
          if (!oldestAt || first < oldestAt) oldestAt = first;
          if (last > newestAt) newestAt = last;
        }
      }
      return { enabled: o.enabled, groups: groups.size, messages, oldestAt, newestAt };
    },

    /** 目的：清掉某个群（或全部）的缓冲。输入：groupId 可省；输出：无。 */
    clear(groupId) {
      if (groupId === undefined) groups.clear();
      else groups.delete(String(groupId));
    },

    /** 目的：一句话摘要，给面板用。 */
    describe() {
      if (!o.enabled) return '关闭';
      return '开 · 每群最近 ' + o.maxMessages + ' 条 · 注入 ≤' + o.maxChars + ' 字 · ' + o.ttlMinutes + ' 分钟内有效';
    },
  };
}
