// 目的：桥接器的网页面板——状态、会话表、事件流，一屏看清桥接器在干什么。
// 边界：只渲染桥接器自己内存里的计数与会话表；不读聊天内容，不代理 DSH，不写任何文件。
// 输入：bridge.mjs 传入的 state 快照 + 页面自己轮询 `panel/state.json`。
// 失败：取不到状态只把角标标红，页面本身不报错、不白屏。

/**
 * 目的：生成整张面板页（含内联样式与脚本，避免额外的静态资源请求，
 *       也避免被直接挂在 /bridge/ 前缀下时相对路径失效）。
 * 返回：完整 HTML 字符串。
 */
export function renderPanel(initial) {
  const boot = JSON.stringify(initial).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>桥接器面板</title>
<style>
  :root{--bg:#0f1115;--panel:#161a21;--line:#242a34;--fg:#e6e6e6;--dim:#8b95a5;--ok:#4ade80;--bad:#f87171;--warn:#fbbf24;--accent:#7cc4ff}
  *{box-sizing:border-box}
  html,body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
  body{padding:0 0 2rem}
  header{display:flex;align-items:center;gap:.6rem;padding:.7rem .9rem;background:var(--panel);border-bottom:1px solid var(--line);position:sticky;top:0;z-index:2}
  header h1{font-size:15px;margin:0;font-weight:600}
  .live{margin-left:auto;font-size:12px;color:var(--dim)}
  .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#3a4150;margin-right:.35rem;vertical-align:middle}
  .dot.on{background:var(--ok)} .dot.off{background:var(--bad)}
  nav{display:flex;gap:.25rem;padding:.45rem .6rem;background:var(--panel);border-bottom:1px solid var(--line);overflow-x:auto}
  nav button{background:transparent;border:1px solid transparent;color:var(--dim);padding:.3rem .75rem;border-radius:7px;font:inherit;cursor:pointer;white-space:nowrap}
  nav button.active{color:var(--fg);background:#1e242e;border-color:var(--line)}
  main{padding:.8rem}
  .cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:.6rem}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:.65rem .75rem}
  .card .k{font-size:12px;color:var(--dim)}
  .card .v{font-size:18px;font-weight:600;margin-top:.15rem;word-break:break-all}
  .card .v.sm{font-size:13px;font-weight:500}
  table{width:100%;border-collapse:collapse;margin-top:.6rem;font-size:13px}
  th,td{text-align:left;padding:.4rem .45rem;border-bottom:1px solid var(--line);white-space:nowrap}
  th{color:var(--dim);font-weight:500;font-size:12px}
  td.k{font-family:ui-monospace,monospace;font-size:12px}
  tbody tr:hover{background:#1a1f28}
  .tag{display:inline-block;padding:0 .35rem;border-radius:5px;font-size:11px;border:1px solid var(--line)}
  .tag.ok{color:var(--ok);border-color:#1f4d31} .tag.bad{color:var(--bad);border-color:#552a2a}
  .tag.skip{color:var(--warn);border-color:#55431a}
  .empty{color:var(--dim);padding:1.2rem 0;text-align:center}
  .hint{color:var(--dim);font-size:12px;margin-top:.5rem}
  pre{background:#12161d;border:1px solid var(--line);border-radius:8px;padding:.7rem;overflow:auto;font-size:12px;line-height:1.5}
  .hide{display:none!important}
</style>
</head>
<body>
<header>
  <h1>桥接器</h1>
  <span class="live"><i id="dot" class="dot"></i><span id="live">连接中…</span></span>
</header>
<nav>
  <button data-t="overview" class="active">概览</button>
  <button data-t="sessions">会话</button>
  <button data-t="events">事件</button>
  <button data-t="config">配置</button>
</nav>
<main>
  <section id="p-overview">
    <div class="cards" id="cards"></div>
    <div class="hint">消息进来时记一条事件；这里不显示聊天内容，只显示"哪个聊天、用了多久、成没成"。</div>
  </section>
  <section id="p-sessions" class="hide">
    <table><thead><tr><th>聊天</th><th>会话 id</th><th>条数</th><th>最近</th><th>耗时</th><th>状态</th></tr></thead>
    <tbody id="sessions"></tbody></table>
    <div class="hint">会话 id 是 DSH 的；同一个聊天始终续接同一个会话。</div>
  </section>
  <section id="p-events" class="hide">
    <table><thead><tr><th>时间</th><th>结果</th><th>聊天</th><th>耗时</th><th>备注</th></tr></thead>
    <tbody id="events"></tbody></table>
    <div class="hint">最多保留最近 100 条，重启即清空。</div>
  </section>
  <section id="p-config" class="hide">
    <pre id="config">载入中…</pre>
  </section>
</main>
<script>
const BOOT = ${boot};
let base = location.pathname.replace(/[^/]*$/, '');
if (!base.endsWith('/')) base += '/';
const $ = (id) => document.getElementById(id);
const fmtMs = (ms) => ms == null ? '-' : (ms < 1000 ? ms + 'ms' : (ms / 1000).toFixed(1) + 's');
const fmtAgo = (ts) => {
  if (!ts) return '-';
  const d = Math.max(0, Date.now() - ts);
  if (d < 60000) return Math.floor(d / 1000) + '秒前';
  if (d < 3600000) return Math.floor(d / 60000) + '分前';
  return Math.floor(d / 3600000) + '小时前';
};
const fmtUptime = (ms) => {
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + ' 分钟';
  const h = Math.floor(m / 60);
  return h + ' 小时 ' + (m % 60) + ' 分';
};
const el = (tag, text, cls) => { const n = document.createElement(tag); if (text != null) n.textContent = text; if (cls) n.className = cls; return n; };

document.querySelectorAll('nav button').forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll('nav button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    for (const t of ['overview', 'sessions', 'events', 'config']) $('p-' + t).classList.toggle('hide', t !== b.dataset.t);
  };
});

function render(s) {
  const cards = $('cards');
  cards.replaceChildren();
  const add = (k, v, sm) => {
    const c = el('div', null, 'card');
    c.append(el('div', k, 'k'), el('div', v, 'v' + (sm ? ' sm' : '')));
    cards.append(c);
  };
  add('后端', s.backend || '-', true);
  add('运行时长', fmtUptime(s.uptimeMs || 0));
  add('收到消息', String(s.counts?.incoming ?? 0));
  add('成功回复', String(s.counts?.ok ?? 0));
  add('失败', String(s.counts?.failed ?? 0));
  add('排队中', String(s.counts?.busy ?? 0));
  add('监听', s.listen || '-', true);
  add('上游 NapCat', s.napcatApi || '-', true);

  const st = $('sessions');
  st.replaceChildren();
  const rows = s.sessions || [];
  if (!rows.length) {
    const tr = el('tr'); const td = el('td', '还没有任何聊天发起过对话', 'empty'); td.colSpan = 6; tr.append(td); st.append(tr);
  }
  for (const r of rows) {
    const tr = el('tr');
    tr.append(el('td', r.key, 'k'), el('td', (r.sessionId || '-').slice(0, 8), 'k'),
      el('td', String(r.messages ?? 0)), el('td', fmtAgo(r.lastAt)), el('td', fmtMs(r.lastMs)),
      el('td', r.busy ? '处理中' : '空闲', 'tag ' + (r.busy ? 'skip' : 'ok')));
    st.append(tr);
  }

  const ev = $('events');
  ev.replaceChildren();
  const list = s.events || [];
  if (!list.length) {
    const tr = el('tr'); const td = el('td', '还没有事件', 'empty'); td.colSpan = 5; tr.append(td); ev.append(tr);
  }
  for (const e of list) {
    const tr = el('tr');
    const tag = e.status === 'ok' ? 'ok' : e.status === 'skip' ? 'skip' : 'bad';
    const tdTag = el('td'); tdTag.append(el('span', e.status === 'ok' ? '成功' : e.status === 'skip' ? '跳过' : '失败', 'tag ' + tag));
    tr.append(el('td', new Date(e.at).toLocaleTimeString()), tdTag, el('td', e.key || '-', 'k'),
      el('td', fmtMs(e.ms)), el('td', e.note || ''));
    ev.append(tr);
  }

  $('config').textContent = JSON.stringify(s.config || {}, null, 2);
  const ok = s.ok !== false;
  $('dot').className = 'dot ' + (ok ? 'on' : 'off');
  $('live').textContent = ok ? '在线 · ' + fmtAgo(Date.now()) : '离线';
}

async function pull() {
  try {
    const r = await fetch(base + 'panel/state.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    render(await r.json());
    $('dot').className = 'dot on';
    $('live').textContent = '在线 · 刚刚';
  } catch (e) {
    $('dot').className = 'dot off';
    $('live').textContent = '连接不上桥接器';
  }
}
render(BOOT);
pull();
setInterval(pull, 2000);
</script>
</body>
</html>`;
}
