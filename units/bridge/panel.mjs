// 目的：桥接器的网页面板——概览、会话、事件、只读配置，一屏看清桥接器在干什么。
// 边界：只渲染桥接器内存里的计数与会话表；不读聊天内容，不代理 DSH，不写任何文件、不接受写操作。
// 依赖：bridge.mjs 传入的 state 快照；页面自己轮询同目录的 state.json（也支持 /panel/state.json）。
// 失败：取不到状态只显示错误条与离线角标，页面本身不白屏、不抛未捕获异常。
//
// 设计约束：
// - 整页内联样式与脚本，不引外部资源，挂在 /bridge/ 前缀下也不会因相对路径失效。
// - 手机优先：不出现需要横向滚动的表格；会话和事件用卡片列表。
// - 只读：配置页只展示桥接器进程实际拿到的环境变量，改配置要编辑 $DATA/etc/tinda.conf 后重启。

/**
 * 目的：生成整张面板页（含内联样式与脚本）。
 * 输入：initial 为 bridge.mjs 的 snapshot() 返回值；必须可 JSON 序列化。
 * 输出：完整 HTML 字符串；数据只通过 textContent 写入 DOM，避免注入。
 * 失败：不抛错；状态结构缺字段时按空值渲染。
 * 副作用：无。
 */
export function renderPanel(initial) {
  const boot = safeJson(initial);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="theme-color" content="#0f1115">
<meta name="color-scheme" content="dark">
<title>桥接器面板</title>
<link rel="icon" href="data:,">
<style>
  :root{--bg:#0f1115;--panel:#161a21;--line:#242a34;--fg:#e6e6e6;--dim:#8b95a5;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24;--accent:#7cc4ff;--chip:#1e242e}
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif}
  body{padding:0 0 calc(1.4rem + env(safe-area-inset-bottom))}
  button,input,select{font:inherit}
  header{display:flex;align-items:center;gap:.55rem;padding:.7rem .9rem;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:3}
  header h1{font-size:15px;margin:0;font-weight:600;letter-spacing:.01em;white-space:nowrap}
  .status{margin-left:auto;display:inline-flex;align-items:center;gap:.35rem;font-size:12px;color:var(--dim);white-space:nowrap}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#3a4150;flex:none}
  .dot.on{background:var(--ok)} .dot.off{background:var(--bad)}
  .iconbtn{background:transparent;border:1px solid var(--line);color:var(--dim);border-radius:8px;padding:.28rem .55rem;cursor:pointer;font-size:12px;white-space:nowrap}
  .iconbtn:hover,.iconbtn:focus-visible{color:var(--fg);border-color:var(--accent);outline:none}
  nav{display:flex;gap:.25rem;padding:.42rem .55rem;background:var(--panel);border-bottom:1px solid var(--line);overflow-x:auto;-webkit-overflow-scrolling:touch}
  nav button{background:transparent;border:1px solid transparent;color:var(--dim);padding:.32rem .8rem;border-radius:7px;cursor:pointer;white-space:nowrap}
  nav button[aria-selected="true"]{color:var(--fg);background:var(--chip);border-color:var(--line)}
  main{padding:.75rem .7rem 0;max-width:1100px;margin:0 auto}
  .notice{display:none;border:1px solid #5a3030;background:#2a1717;color:#fecaca;border-radius:9px;padding:.55rem .7rem;margin-bottom:.7rem;font-size:13px;overflow-wrap:anywhere}
  .notice.show{display:block}
  .notice.info{border-color:#2b4a63;background:#12202b;color:#cbe8ff}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(128px,1fr));gap:.55rem}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:.6rem .7rem;min-width:0}
  .card .k{font-size:12px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .card .v{font-size:20px;font-weight:650;margin-top:.12rem;word-break:break-all;font-variant-numeric:tabular-nums}
  .card .v.sm{font-size:13px;font-weight:500;line-height:1.45}
  .card .v.warn{color:var(--warn)}
  .meta{display:grid;grid-template-columns:1fr;gap:.45rem;margin-top:.7rem}
  .meta .row{display:flex;gap:.6rem;justify-content:space-between;border-bottom:1px solid var(--line);padding:.38rem 0;font-size:13px;min-width:0}
  .meta .row .a{color:var(--dim);flex:none}
  .meta .row .b{text-align:right;word-break:break-all;min-width:0}
  .sectionhead{display:flex;align-items:center;gap:.5rem;margin:.2rem 0 .55rem}
  .sectionhead h2{font-size:14px;margin:0;font-weight:600}
  .sectionhead .spacer{margin-left:auto}
  .hint{color:var(--dim);font-size:12px;line-height:1.5;margin:.55rem 0 0}
  .list{display:flex;flex-direction:column;gap:.5rem}
  .item{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:.6rem .7rem;min-width:0}
  .item .top{display:flex;align-items:center;gap:.45rem;flex-wrap:wrap}
  .item .chat{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}
  .item .time{margin-left:auto;color:var(--dim);font-size:12px;white-space:nowrap}
  .item .sub{display:flex;gap:.7rem;flex-wrap:wrap;color:var(--dim);font-size:12px;margin-top:.3rem}
  .item .sub b{color:var(--fg);font-weight:500}
  .sid{display:flex;align-items:center;gap:.35rem;margin-top:.35rem;min-width:0}
  .sid code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;background:#0c0f14;border:1px solid var(--line);border-radius:6px;padding:.15rem .35rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
  .copy{background:transparent;border:1px solid var(--line);color:var(--dim);border-radius:6px;padding:.12rem .4rem;font-size:11px;cursor:pointer;flex:none}
  .copy:hover,.copy:focus-visible{color:var(--accent);border-color:var(--accent);outline:none}
  .tag{display:inline-block;padding:.05rem .35rem;border-radius:5px;font-size:11px;border:1px solid var(--line);white-space:nowrap}
  .tag.ok{color:var(--ok);border-color:#1f4d31} .tag.bad{color:var(--bad);border-color:#552a2a}
  .tag.skip{color:var(--warn);border-color:#55431a} .tag.run{color:var(--accent);border-color:#2b4a63}
  .empty{color:var(--dim);padding:1.4rem .6rem;text-align:center;border:1px dashed var(--line);border-radius:10px}
  .filters{display:flex;gap:.3rem;overflow-x:auto;padding-bottom:.15rem}
  .filters button{background:transparent;border:1px solid var(--line);color:var(--dim);border-radius:999px;padding:.22rem .65rem;font-size:12px;cursor:pointer;white-space:nowrap}
  .filters button[aria-pressed="true"]{color:var(--fg);background:var(--chip);border-color:var(--accent)}
  .config{display:flex;flex-direction:column;gap:.6rem}
  .group{background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  .group h3{margin:0;padding:.5rem .7rem;font-size:12px;color:var(--dim);font-weight:500;background:#131820;border-bottom:1px solid var(--line)}
  .kv{display:flex;gap:.8rem;justify-content:space-between;align-items:flex-start;padding:.45rem .7rem;border-bottom:1px solid var(--line);min-width:0}
  .kv:last-child{border-bottom:0}
  .kv .key{color:var(--dim);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;overflow-wrap:anywhere;flex:1;min-width:0}
  .kv .val{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;text-align:right;overflow-wrap:anywhere;flex:1;min-width:0;color:var(--fg)}
  .kv .val.empty{color:var(--dim);border:0;padding:0;text-align:right}
  footer{color:var(--dim);font-size:11px;text-align:center;padding:1rem .7rem 0}
  .hide{display:none!important}
  @media (min-width:720px){
    header{padding:.7rem 1.1rem}
    main{padding:1rem 1rem 0}
    nav{padding:.45rem .9rem}
    .meta{grid-template-columns:1fr 1fr;column-gap:1.2rem}
  }
  @media (prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
</style>
</head>
<body>
<header>
  <h1>桥接器</h1>
  <span class="status"><i id="dot" class="dot"></i><span id="live">连接中…</span></span>
  <button class="iconbtn" id="refresh" type="button" title="立即刷新">刷新</button>
  <button class="iconbtn" id="auto" type="button" aria-pressed="true" title="每 2 秒自动刷新">自动</button>
</header>
<nav role="tablist" aria-label="面板">
  <button role="tab" data-t="overview" aria-selected="true" aria-controls="p-overview">概览</button>
  <button role="tab" data-t="sessions" aria-selected="false" aria-controls="p-sessions">会话</button>
  <button role="tab" data-t="events" aria-selected="false" aria-controls="p-events">事件</button>
  <button role="tab" data-t="config" aria-selected="false" aria-controls="p-config">配置</button>
</nav>
<main>
  <div id="notice" class="notice" role="status"></div>

  <section id="p-overview" role="tabpanel">
    <div class="cards" id="cards"></div>
    <div class="meta" id="meta"></div>
    <p class="hint">只显示元信息：哪个聊天、用了多久、成没成、回了几个字。聊天正文永远不会进入这里。</p>
  </section>

  <section id="p-sessions" class="hide" role="tabpanel">
    <div class="sectionhead"><h2>会话</h2><span class="spacer"></span><span class="hint" id="sessionsCount"></span></div>
    <div class="list" id="sessions"></div>
    <p class="hint">chatKey → DSH 会话 id；同一个聊天始终续接同一个会话。会话 id 可点“复制”。</p>
  </section>

  <section id="p-events" class="hide" role="tabpanel">
    <div class="sectionhead"><h2>事件</h2><span class="spacer"></span><span class="hint" id="eventsCount"></span></div>
    <div class="filters" role="group" aria-label="事件筛选">
      <button type="button" data-f="all" aria-pressed="true">全部</button>
      <button type="button" data-f="ok" aria-pressed="false">成功</button>
      <button type="button" data-f="fail" aria-pressed="false">失败</button>
      <button type="button" data-f="skip" aria-pressed="false">跳过</button>
    </div>
    <div class="list" id="events" style="margin-top:.55rem"></div>
    <p class="hint">最多保留最近 100 条；重启即清空。失败备注会脱敏并截断，不包含聊天正文。</p>
  </section>

  <section id="p-config" class="hide" role="tabpanel">
    <div class="config" id="config"></div>
    <p class="hint">这里是桥接器进程实际拿到的只读配置。修改请编辑 <code>$DATA/etc/tinda.conf</code>，然后 <code>bin/unit.sh restart bridge</code>；面板不接受写操作。</p>
  </section>

  <footer id="foot"></footer>
</main>
<script>
const BOOT = ${boot};
const $ = function (id) { return document.getElementById(id); };
const esc = function (s) { return String(s == null ? '' : s); };
const fmtMs = function (ms) { return ms == null || ms === '' ? '-' : (ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's'); };
const fmtAgo = function (ts) {
  if (!ts) return '-';
  const d = Math.max(0, Date.now() - ts);
  if (d < 60000) return Math.floor(d / 1000) + '秒前';
  if (d < 3600000) return Math.floor(d / 60000) + '分前';
  if (d < 86400000) return Math.floor(d / 3600000) + '小时前';
  return Math.floor(d / 86400000) + '天前';
};
const fmtClock = function (ts) {
  if (!ts) return '-';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '-';
  const p = function (n) { return n < 10 ? '0' + n : String(n); };
  const today = new Date();
  const sameDay = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return (sameDay ? '' : (p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ')) + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
};
const fmtUptime = function (ms) {
  const m = Math.max(0, Math.floor((ms || 0) / 60000));
  if (m < 1) return '<1 分钟';
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  return h + ' 小时 ' + (m % 60) + ' 分';
};
const el = function (tag, text, cls) {
  const n = document.createElement(tag);
  if (text != null) n.textContent = text;
  if (cls) n.className = cls;
  return n;
};

let state = BOOT;
let filter = 'all';
let auto = true;
let timer = null;
let seq = 0;
const base = new URL('state.json', location.href).href;

function notice(msg, info) {
  const n = $('notice');
  if (!msg) { n.className = 'notice'; n.textContent = ''; return; }
  n.className = 'notice show' + (info ? ' info' : '');
  n.textContent = msg;
}

function copyText(text) {
  const done = function () { notice('已复制到剪贴板', true); setTimeout(function () { notice(''); }, 1200); };
  const fail = function () { notice('复制失败，请长按选中后复制', true); };
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(done, fail);
    return;
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) done(); else fail();
  } catch (e) { fail(); }
}

function copyBtn(text) {
  const b = el('button', '复制', 'copy');
  b.type = 'button';
  b.onclick = function () { copyText(text); };
  return b;
}

function metric(label, value, opts) {
  const c = el('div', null, 'card');
  c.append(el('div', label, 'k'), el('div', value, 'v' + (opts && opts.small ? ' sm' : '') + (opts && opts.warn ? ' warn' : '')));
  return c;
}

function renderOverview(s) {
  const cards = $('cards');
  cards.replaceChildren();
  const c = s.counts || {};
  cards.append(
    metric('收到消息', String(c.incoming || 0)),
    metric('成功回复', String(c.ok || 0)),
    metric('失败', String(c.failed || 0), { warn: (c.failed || 0) > 0 }),
    metric('跳过', String(c.skipped || 0)),
    metric('策略拒绝', String(c.denied || 0), { warn: (c.denied || 0) > 0 }),
    metric('命令', String((s.commands && s.commands.total) || 0)),
    metric('分条', String((s.humanize && s.humanize.bubbles) || 0)),
    metric('排队中', String(c.busy || 0), { warn: (c.busy || 0) > 0 }),
    metric('待补发', String(c.outbox || 0), { warn: (c.outbox || 0) > 0 }),
    metric('运行时长', fmtUptime(s.uptimeMs), { small: true })
  );
  const meta = $('meta');
  meta.replaceChildren();
  const row = function (a, b, cls) {
    const r = el('div', null, 'row');
    const left = el('span', a, 'a');
    const right = el('span', b == null || b === '' ? '-' : b, 'b' + (cls ? ' ' + cls : ''));
    r.append(left, right);
    meta.append(r);
  };
  row('后端', s.backend || '-');
  row('监听', s.listen || '-');
  row('NapCat API', s.napcatApi || '-');
  row('状态文件', s.config && s.config.BRIDGE_STATE_FILE ? s.config.BRIDGE_STATE_FILE : '(不落盘)');
  const al = s.alerts || {};
  row('补发队列', String(c.outbox || 0) + ' 条' + (al.suppressed ? '（告警已压 ' + al.suppressed + ' 次）' : ''));
  row('告警接收', al.qq ? al.qq + (al.sent ? ' · 已发 ' + al.sent + ' 条，最近 ' + fmtAgo(al.lastAt) : ' · 还没发过') : '未设置（ALERT_QQ）');
  row('磁盘占用', al.diskPercent == null ? '未知' : al.diskPercent + '%（阈值 ' + (al.diskAlertPercent == null ? 90 : al.diskAlertPercent) + '%）');
  // 回复策略（①）：摘要里只有数量没有号码；未加固要显眼，否则「谁都能用」会一直被忽略。
  const pol = s.policy || {};
  const denied = pol.denied && typeof pol.denied === 'object' ? Object.entries(pol.denied) : [];
  const top = denied.sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => k + '×' + v).join(' · ');
  row('回复策略', (pol.summary || '未知') + (pol.hardened ? '' : ' · 未加固'), pol.hardened ? '' : 'warn');
  row('策略来源', pol.source || '-');
  if (top) row('被拒原因', top);
  if (pol.errors && pol.errors.length) row('策略错误', pol.errors.join(' / '), 'warn');
  // 命令（②）：只显示命令名和次数，不显示谁发的。
  const cmdTop = s.commands && Array.isArray(s.commands.top) ? s.commands.top : [];
  if (cmdTop.length) row('常用命令', cmdTop.slice(0, 5).map((x) => '/' + x.name + '×' + x.hits).join(' · '));
  // 输出档位（⑤）：默认是什么、有几个聊天改过、自动压缩阈值。
  const out = s.output || {};
  row('输出档位', (out.defaultTier || '-') + '（默认）' + (out.tiers ? ' · ' + out.tiers + ' 个聊天改过' : ''));
  row('自动压缩', out.autoCompactRounds ? '每 ' + out.autoCompactRounds + ' 轮压一次' + (out.summaries ? ' · 已有 ' + out.summaries + ' 段摘要' : '') : '关闭');

  // 维护期自动回复（⑤）
  const rl = s.relay || {};
  row('维护期回复', (rl.summary || '-') + (rl.streak ? ' · 当前连续失败 ' + rl.streak : ''));

  // 群上下文（④）：只显示数量与时间，不显示聊天正文。
  const gc = s.groupContext || {};
  row('群上下文', (gc.summary || '未知') + (gc.groups ? ' · ' + gc.groups + ' 群 / ' + gc.messages + ' 条' : ''));

  // 拟人化投递（③）：一句话说明当前节奏，外加最近一次分了几条。
  const hu = s.humanize || {};
  const lastHu = hu.last ? ' · 最近 ' + hu.last.bubbles + ' 条 / ' + hu.last.chars + ' 字' : '';
  row('拟人化投递', (hu.summary || '未知') + lastHu);

  // 输入状态：私聊里那三个点。只显示开关与轮数，不含任何聊天内容。
  const ty = s.typing || {};
  row('输入状态', (ty.summary || '未知') + (ty.messages ? ' · 已亮 ' + ty.messages + ' 轮' : ''));

  // 交互动作（P0-1）：开关 + 最近一轮执行/失败数；不显示表情名，更不显示正文。
  const it = s.interactions || {};
  const lastIt = it.last ? ' · 本轮 ' + it.last.executed + ' 个 / 失败 ' + it.last.failed : ' · 还没执行过';
  row('交互动作', (it.summary || '未知') + lastIt, it.last && it.last.failed ? 'warn' : '');

  // 消息层（P0-2）：群回复 @、首次披露、群会话隔离；只显示策略，不含聊天内容。
  const ml = s.messageLayer || {};
  row('消息层', ml.summary || '未知');

  // 图片落盘（P0-3）：只显示目录在不在、上限与累计成功/失败数，不显示图片内容。
  const im = s.images || {};
  const imt = im.totals || {};
  row('图片落盘', (im.summary || '未知') +
    (imt.downloaded || imt.failed ? ' · 成功 ' + imt.downloaded + ' / 失败 ' + imt.failed : ''),
  imt.failed ? 'warn' : '');
}

function renderSessions(s) {
  const box = $('sessions');
  box.replaceChildren();
  const rows = Array.isArray(s.sessions) ? s.sessions : [];
  $('sessionsCount').textContent = rows.length ? rows.length + ' 个聊天' : '';
  if (!rows.length) {
    box.append(el('div', '还没有任何聊天发起过对话。让 QQ 给机器人发一条消息，这里就会出现。', 'empty'));
    return;
  }
  for (const r of rows) {
    const item = el('div', null, 'item');
    const top = el('div', null, 'top');
    top.append(el('span', r.key || '-', 'chat'));
    if (r.busy) top.append(el('span', '处理中', 'tag run'));
    top.append(el('span', fmtAgo(r.lastAt), 'time'));
    item.append(top);
    const sub = el('div', null, 'sub');
    sub.append(el('span', '条数 ' + String(r.messages == null ? 0 : r.messages)), el('span', '最近 ' + fmtClock(r.lastAt)), el('span', '耗时 ' + fmtMs(r.lastMs)));
    item.append(sub);
    const sid = el('div', null, 'sid');
    const code = el('code', r.sessionId ? r.sessionId : '未建立 DSH 会话（下一轮会新建）');
    code.title = r.sessionId || '';
    sid.append(code);
    if (r.sessionId) sid.append(copyBtn(r.sessionId));
    item.append(sid);
    box.append(item);
  }
}

function renderEvents(s) {
  const box = $('events');
  box.replaceChildren();
  const all = Array.isArray(s.events) ? s.events : [];
  const rows = all.filter(function (e) { return filter === 'all' || e.status === filter; });
  $('eventsCount').textContent = all.length ? rows.length + '/' + all.length + ' 条' : '';
  if (!rows.length) {
    box.append(el('div', filter === 'all' ? '还没有事件。' : '没有符合筛选的事件。', 'empty'));
    return;
  }
  for (const e of rows) {
    const item = el('div', null, 'item');
    const top = el('div', null, 'top');
    const tag = e.status === 'ok' ? 'ok' : e.status === 'skip' ? 'skip' : 'bad';
    const label = e.status === 'ok' ? '成功' : e.status === 'skip' ? '跳过' : '失败';
    top.append(el('span', label, 'tag ' + tag));
    if (e.key) top.append(el('span', e.key, 'chat'));
    top.append(el('span', fmtClock(e.at), 'time'));
    item.append(top);
    const sub = el('div', null, 'sub');
    sub.append(el('span', '耗时 ' + fmtMs(e.ms)));
    if (e.note) sub.append(el('span', e.note));
    item.append(sub);
    box.append(item);
  }
}

function renderConfig(s) {
  const box = $('config');
  box.replaceChildren();
  const cfg = s.config && typeof s.config === 'object' ? s.config : {};
  const groups = [
    ['连接', ['BRIDGE_LISTEN', 'NAPCAT_API', 'NAPCAT_TOKEN', 'BRIDGE_STATE_FILE']],
    ['行为', ['BRIDGE_BACKEND', 'BRIDGE_ALLOW_GROUP', 'BRIDGE_TIMEOUT_MS', 'BRIDGE_PERMISSION_MODE']],
    ['交互动作', ['BRIDGE_INTERACTIONS', 'BRIDGE_INTERACTIONS_GROUP_POKE', 'BRIDGE_INTERACTIONS_MAX', 'BRIDGE_INTERACTIONS_TIMEOUT_MS']],
    ['消息层', ['BRIDGE_GROUP_REPLY_AT', 'BRIDGE_AI_DISCLOSURE', 'BRIDGE_GROUP_SESSION_SCOPE']],
    ['图片落盘', ['BRIDGE_DOWNLOAD_IMAGES', 'BRIDGE_IMAGE_DIR', 'BRIDGE_IMAGE_MAX_BYTES', 'BRIDGE_IMAGE_MAX_COUNT', 'BRIDGE_IMAGE_TIMEOUT_MS', 'BRIDGE_IMAGE_ALLOW_PRIVATE_HOSTS']],
    ['DSH', ['DSH_BIN', 'DSH_HOME']],
    ['回发与告警', ['BRIDGE_MAX_EVENT_AGE_SEC', 'BRIDGE_SEEN_FILE', 'BRIDGE_SEND_RETRY', 'BRIDGE_SEND_DRAIN_MS', 'BRIDGE_OUTBOX_TTL_MS', 'BRIDGE_OUTBOX_FILE', 'ALERT_QQ', 'ALERT_FAIL_STREAK', 'ALERT_COOLDOWN_SEC', 'DISK_ALERT_PERCENT']],
  ];
  // 先收集上面已经分组的键，剩下的才进「其它」，避免新键在配置页出现两次。
  const known = new Set();
  for (const g of groups) for (const k of g[1]) known.add(k);
  groups.push(['其它', Object.keys(cfg).filter(function (k) { return !known.has(k); })]);
  for (const g of groups) {
    if (!g[1].length) continue;
    const group = el('div', null, 'group');
    group.append(el('h3', g[0]));
    for (const k of g[1]) {
      const kv = el('div', null, 'kv');
      const key = el('span', k, 'key');
      let v = cfg[k];
      if (typeof v === 'boolean') v = v ? '开 (true)' : '关 (false)';
      if (v == null || v === '') v = '(空)';
      const val = el('span', String(v), 'val' + (v === '(空)' ? ' empty' : ''));
      kv.append(key, val);
      group.append(kv);
    }
    box.append(group);
  }
}

function render(s) {
  state = s || {};
  renderOverview(state);
  renderSessions(state);
  renderEvents(state);
  renderConfig(state);
  $('foot').textContent = '桥接器面板 · 只读 · 数据来自 ' + (state.listen || '本机');
}

function setLive(ok, text) {
  $('dot').className = 'dot ' + (ok ? 'on' : 'off');
  $('live').textContent = text;
}

async function pull() {
  const my = ++seq;
  try {
    const ctl = new AbortController();
    const t = setTimeout(function () { ctl.abort(); }, 5000);
    const r = await fetch(base, { cache: 'no-store', signal: ctl.signal, credentials: 'same-origin' });
    clearTimeout(t);
    if (r.status === 401) {
      notice('需要先登录：从 8443 控制台的入口打开，或在本地址后加 ?k=<WEB_TOKEN>。', true);
      setLive(false, '未授权');
      return;
    }
    if (!r.ok) {
      notice('桥接器状态接口返回 HTTP ' + r.status + '。看 bin/unit.sh logs bridge 20。');
      setLive(false, '异常');
      return;
    }
    const data = await r.json();
    if (my !== seq) return;
    notice('');
    render(data);
    setLive(true, '在线 · ' + fmtClock(Date.now()));
  } catch (e) {
    if (my !== seq) return;
    const msg = e && e.name === 'AbortError' ? '状态请求超时（5 秒）' : '连接不上桥接器';
    notice(msg + '。确认进程还在：bin/unit.sh status bridge；看日志：bin/unit.sh logs bridge 20。');
    setLive(false, '离线');
  }
}

function schedule() {
  if (timer) clearInterval(timer);
  timer = null;
  if (auto && !document.hidden) timer = setInterval(pull, 2000);
}

document.querySelectorAll('nav button').forEach(function (b) {
  b.onclick = function () {
    document.querySelectorAll('nav button').forEach(function (x) { x.setAttribute('aria-selected', 'false'); });
    b.setAttribute('aria-selected', 'true');
    for (const t of ['overview', 'sessions', 'events', 'config']) {
      $('p-' + t).classList.toggle('hide', t !== b.dataset.t);
    }
  };
});

document.querySelectorAll('.filters button').forEach(function (b) {
  b.onclick = function () {
    filter = b.dataset.f;
    document.querySelectorAll('.filters button').forEach(function (x) { x.setAttribute('aria-pressed', 'false'); });
    b.setAttribute('aria-pressed', 'true');
    renderEvents(state);
  };
});

$('refresh').onclick = function () { pull(); };
$('auto').onclick = function () {
  auto = !auto;
  $('auto').setAttribute('aria-pressed', auto ? 'true' : 'false');
  $('auto').textContent = auto ? '自动' : '已暂停';
  schedule();
  if (auto) pull();
};
document.addEventListener('visibilitychange', function () { schedule(); if (!document.hidden) pull(); });

render(BOOT);
pull();
schedule();
</script>
</body>
</html>`;
}

/**
 * 目的：把状态对象安全地嵌进内联 script，避免 </script> 或行分隔符提前截断。
 * 输入：任意可 JSON 序列化的值。
 * 输出：JSON 文本；<、>、&、U+2028、U+2029 都转义。
 * 失败：循环引用会抛 TypeError，调用方传入的 snapshot 不含循环引用。
 * 副作用：无。
 */
function safeJson(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}
