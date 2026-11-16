(function () {
  'use strict';

  var NP = window.__NP__ || {};
  var page = document.body.getAttribute('data-page') || 'home';
  var boot = NP.boot || { status: {}, events: [] };
  var status = boot.status || {};
  var health = NP.health || null;
  var configData = NP.config || null;
  var writeEnabled = NP.writeEnabled === true;
  var events = (boot.events || []).slice(-500);
  var token = '';
  var es = null;
  var lastEventAt = 0;
  var chatsSig = '';

  function $(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  }
  function pad(n) { return n < 10 ? '0' + n : String(n); }
  function hhmmss(ms) {
    var d = new Date(Number(ms) || Date.now());
    return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  }
  function dur(ms) {
    if (ms === null || ms === undefined || !isFinite(Number(ms)) || Number(ms) < 0) return '—';
    var s = Math.floor(Number(ms) / 1000), d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600), m = Math.floor(s % 3600 / 60);
    if (d) return d + 'd ' + h + 'h';
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + (s % 60) + 's';
    return s + 's';
  }
  function ago(ms) {
    var n = Number(ms);
    if (!isFinite(n) || n <= 0) return '—';
    var s = Math.max(0, Math.floor((Date.now() - n) / 1000));
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }
  function short(s, n) {
    s = String(s === undefined || s === null ? '' : s);
    return s.length > n ? '…' + s.slice(-(n - 1)) : s;
  }
  function stateLabel(s) {
    var m = { starting: '启动中', standby: '待机', idle: '空闲', busy: '处理中', stopping: '退出中', suspended: '熔断' };
    return m[s] || s || '—';
  }
  function kindMeta(kind) {
    var m = {
      in: ['收', 'var(--in)'], out: ['发', 'var(--out)'], turn: ['轮', 'var(--turn)'],
      cmd: ['令', 'var(--action)'], deny: ['拒', 'var(--warn)'],
      action: ['动', 'var(--action)'], alert: ['警', 'var(--alert)'], warn: ['!', 'var(--warn)'],
      error: ['×', 'var(--err)'], state: ['态', 'var(--state)']
    };
    return m[kind] || ['·', 'var(--state)'];
  }
  function toast(msg, ms) {
    var t = $('toast');
    if (!t) return;
    t.classList.add('on');
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.classList.remove('on'); }, ms || 2600);
  }
  function copyText(text, btn) {
    var s = String(text || '');
    if (!s) { toast('没有可复制的内容', 1500); return; }
    var done = function () { toast('已复制', 1200); if (btn) { var old = btn.textContent; btn.textContent = '已复制'; setTimeout(function () { btn.textContent = old; }, 1200); } };
    var fail = function () { toast('复制失败，请长按选择', 1800); };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(s).then(done, fail);
    } else {
      var ta = document.createElement('textarea');
      ta.value = s; ta.style.position = 'fixed'; ta.style.top = '-1000px';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); done(); } catch (e) { fail(); }
      document.body.removeChild(ta);
    }
  }
  function api(path, opts) {
    opts = opts || {};
    var headers = opts.headers || {};
    if (opts.body !== undefined) headers['content-type'] = 'application/json';
    if (opts.auth) headers.authorization = 'Bearer ' + (opts.auth === true ? token : opts.auth);
    return fetch(path, {
      method: opts.method || 'GET',
      headers: headers,
      body: opts.body !== undefined ? opts.body : undefined
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok || d.ok === false) {
          var e = new Error(d.error || d.message || ('HTTP ' + r.status));
          e.data = d; e.status = r.status; throw e;
        }
        return d;
      });
    });
  }
  function setLive(on, text) {
    var chip = $('live'), dot = $('liveDot'), label = $('liveText');
    if (chip) chip.className = 'chip mono ' + (on ? 'on' : 'off');
    if (dot) dot.className = 'dot ' + (on ? 'live' : 'bad');
    if (label) label.textContent = text;
  }
  function updateHeader(s) {
    status = s || status || {};
    var ob = status.onebot || {};
    var acc = $('acc');
    if (acc) acc.textContent = ob.selfId ? (ob.selfId + (ob.nickname ? ' · ' + ob.nickname : '')) : '未登录';
    var st = status.state || 'starting';
    var pill = $('state');
    if (pill) pill.className = 'pill p-' + st;
    var text = $('stateText');
    if (text) text.textContent = stateLabel(st);
    document.title = (st === 'idle' || st === 'busy' ? '● ' : '○ ') + stateLabel(st) + ' · napcat × DSH';
    renderAlert();
  }
  function renderAlert() {
    var box = $('alert');
    if (!box) return;
    var a = status.alert;
    if (!a) { box.classList.remove('on'); return; }
    box.classList.add('on');
    var t = $('alertTitle'), m = $('alertMsg'), meta = $('alertMeta');
    if (t) t.textContent = (a.level === 'fatal' ? '熔断' : '告警') + '：' + (a.code || '');
    if (m) m.textContent = a.message || '';
    if (meta) meta.textContent = hhmmss(a.at) + (a.detail ? ' · ' + short(a.detail, 90) : '');
  }
  function connectSSE(opts) {
    opts = opts || {};
    try { es = new EventSource('/events'); } catch (e) { setLive(false, '不可用'); return; }
    es.addEventListener('bootstrap', function (m) {
      var d = JSON.parse(m.data);
      updateHeader(d.status || {});
      if (typeof opts.onBootstrap === 'function') opts.onBootstrap(d);
      setLive(true, '实时');
    });
    es.addEventListener('status', function (m) {
      var d = JSON.parse(m.data);
      updateHeader(d);
      if (typeof opts.onStatus === 'function') opts.onStatus(d);
    });
    es.addEventListener('event', function (m) {
      var ev = JSON.parse(m.data);
      lastEventAt = ev.at || Date.now();
      if (typeof opts.onEvent === 'function') opts.onEvent(ev);
    });
    es.onopen = function () { setLive(true, '实时'); };
    es.onerror = function () { setLive(false, '重连中'); };
  }
  function eventNode(ev, logMode) {
    var kind = String(ev.kind || 'info').replace(/[^a-z-]/g, '');
    var meta = kindMeta(kind);
    var row = el('div', (logMode ? 'logline' : 'feed-row') + ' k-' + kind);
    row.appendChild(el('span', 'tm', hhmmss(ev.at)));
    var badge = el('span', 'ev', meta[0]);
    badge.style.color = meta[1];
    row.appendChild(badge);
    var msg = el('span', 'ms', ev.text || '');
    if (ev.data) { try { msg.title = JSON.stringify(ev.data); } catch (e) {} }
    row.appendChild(msg);
    return row;
  }
  function renderRecent(list) {
    var box = $('recent');
    if (!box) return;
    box.textContent = '';
    if (!list.length) { box.appendChild(el('div', 'empty', '还没有事件。')); return; }
    var frag = document.createDocumentFragment();
    list.forEach(function (ev) { frag.appendChild(eventNode(ev, false)); });
    box.appendChild(frag);
    box.scrollTop = box.scrollHeight;
  }
  function renderKpis(s) {
// [缺失第 180 行]
// [缺失第 181 行]
// [缺失第 182 行]
// [缺失第 183 行]
// [缺失第 184 行]
// [缺失第 185 行]
// [缺失第 186 行]
// [缺失第 187 行]
// [缺失第 188 行]
// [缺失第 189 行]
// [缺失第 190 行]
// [缺失第 191 行]
// [缺失第 192 行]
// [缺失第 193 行]
// [缺失第 194 行]
// [缺失第 195 行]
// [缺失第 196 行]
// [缺失第 197 行]
// [缺失第 198 行]
// [缺失第 199 行]
// [缺失第 200 行]
// [缺失第 201 行]
// [缺失第 202 行]
// [缺失第 203 行]
// [缺失第 204 行]
// [缺失第 205 行]
// [缺失第 206 行]
// [缺失第 207 行]
// [缺失第 208 行]
// [缺失第 209 行]
// [缺失第 210 行]
// [缺失第 211 行]
// [缺失第 212 行]
// [缺失第 213 行]
// [缺失第 214 行]
// [缺失第 215 行]
// [缺失第 216 行]
// [缺失第 217 行]
// [缺失第 218 行]
// [缺失第 219 行]
// [缺失第 220 行]
// [缺失第 221 行]
// [缺失第 222 行]
// [缺失第 223 行]
// [缺失第 224 行]
// [缺失第 225 行]
// [缺失第 226 行]
// [缺失第 227 行]
// [缺失第 228 行]
// [缺失第 229 行]
// [缺失第 230 行]
// [缺失第 231 行]
// [缺失第 232 行]
// [缺失第 233 行]
// [缺失第 234 行]
// [缺失第 235 行]
// [缺失第 236 行]
// [缺失第 237 行]
// [缺失第 238 行]
// [缺失第 239 行]
// [缺失第 240 行]
// [缺失第 241 行]
// [缺失第 242 行]
// [缺失第 243 行]
// [缺失第 244 行]
// [缺失第 245 行]
// [缺失第 246 行]
// [缺失第 247 行]
// [缺失第 248 行]
// [缺失第 249 行]
// [缺失第 250 行]
// [缺失第 251 行]
// [缺失第 252 行]
// [缺失第 253 行]
// [缺失第 254 行]
// [缺失第 255 行]
// [缺失第 256 行]
// [缺失第 257 行]
// [缺失第 258 行]
// [缺失第 259 行]
// [缺失第 260 行]
// [缺失第 261 行]
// [缺失第 262 行]
// [缺失第 263 行]
// [缺失第 264 行]
// [缺失第 265 行]
// [缺失第 266 行]
// [缺失第 267 行]
// [缺失第 268 行]
// [缺失第 269 行]
// [缺失第 270 行]
// [缺失第 271 行]
// [缺失第 272 行]
// [缺失第 273 行]
// [缺失第 274 行]
// [缺失第 275 行]
// [缺失第 276 行]
// [缺失第 277 行]
// [缺失第 278 行]
// [缺失第 279 行]
// [缺失第 280 行]
// [缺失第 281 行]
// [缺失第 282 行]
// [缺失第 283 行]
// [缺失第 284 行]
// [缺失第 285 行]
// [缺失第 286 行]
// [缺失第 287 行]
// [缺失第 288 行]
// [缺失第 289 行]
// [缺失第 290 行]
// [缺失第 291 行]
// [缺失第 292 行]
// [缺失第 293 行]
// [缺失第 294 行]
// [缺失第 295 行]
// [缺失第 296 行]
// [缺失第 297 行]
// [缺失第 298 行]
// [缺失第 299 行]
// [缺失第 300 行]
// [缺失第 301 行]
// [缺失第 302 行]
// [缺失第 303 行]
// [缺失第 304 行]
// [缺失第 305 行]
// [缺失第 306 行]
// [缺失第 307 行]
// [缺失第 308 行]
// [缺失第 309 行]
// [缺失第 310 行]
// [缺失第 311 行]
// [缺失第 312 行]
// [缺失第 313 行]
// [缺失第 314 行]
// [缺失第 315 行]
// [缺失第 316 行]
// [缺失第 317 行]
// [缺失第 318 行]
// [缺失第 319 行]
// [缺失第 320 行]
// [缺失第 321 行]
// [缺失第 322 行]
// [缺失第 323 行]
// [缺失第 324 行]
// [缺失第 325 行]
// [缺失第 326 行]
// [缺失第 327 行]
// [缺失第 328 行]
// [缺失第 329 行]
// [缺失第 330 行]
// [缺失第 331 行]
// [缺失第 332 行]
// [缺失第 333 行]
// [缺失第 334 行]
// [缺失第 335 行]
// [缺失第 336 行]
// [缺失第 337 行]
// [缺失第 338 行]
// [缺失第 339 行]
// [缺失第 340 行]
// [缺失第 341 行]
// [缺失第 342 行]
// [缺失第 343 行]
// [缺失第 344 行]
// [缺失第 345 行]
// [缺失第 346 行]
// [缺失第 347 行]
// [缺失第 348 行]
// [缺失第 349 行]
// [缺失第 350 行]
// [缺失第 351 行]
// [缺失第 352 行]
// [缺失第 353 行]
// [缺失第 354 行]
// [缺失第 355 行]
// [缺失第 356 行]
// [缺失第 357 行]
// [缺失第 358 行]
// [缺失第 359 行]
// [缺失第 360 行]
// [缺失第 361 行]
// [缺失第 362 行]
// [缺失第 363 行]
// [缺失第 364 行]
// [缺失第 365 行]
// [缺失第 366 行]
// [缺失第 367 行]
// [缺失第 368 行]
// [缺失第 369 行]
// [缺失第 370 行]
// [缺失第 371 行]
// [缺失第 372 行]
// [缺失第 373 行]
// [缺失第 374 行]
// [缺失第 375 行]
// [缺失第 376 行]
// [缺失第 377 行]
// [缺失第 378 行]
// [缺失第 379 行]
// [缺失第 380 行]
// [缺失第 381 行]
// [缺失第 382 行]
// [缺失第 383 行]
// [缺失第 384 行]
// [缺失第 385 行]
// [缺失第 386 行]
// [缺失第 387 行]
// [缺失第 388 行]
// [缺失第 389 行]
// [缺失第 390 行]
// [缺失第 391 行]
// [缺失第 392 行]
// [缺失第 393 行]
// [缺失第 394 行]
// [缺失第 395 行]
// [缺失第 396 行]
// [缺失第 397 行]
// [缺失第 398 行]
// [缺失第 399 行]
// [缺失第 400 行]
// [缺失第 401 行]
// [缺失第 402 行]
// [缺失第 403 行]
// [缺失第 404 行]
// [缺失第 405 行]
// [缺失第 406 行]
// [缺失第 407 行]
// [缺失第 408 行]
// [缺失第 409 行]
// [缺失第 410 行]
// [缺失第 411 行]
// [缺失第 412 行]
// [缺失第 413 行]
// [缺失第 414 行]
// [缺失第 415 行]
// [缺失第 416 行]
// [缺失第 417 行]
// [缺失第 418 行]
// [缺失第 419 行]
// [缺失第 420 行]
// [缺失第 421 行]
// [缺失第 422 行]
// [缺失第 423 行]
// [缺失第 424 行]
// [缺失第 425 行]
// [缺失第 426 行]
// [缺失第 427 行]
// [缺失第 428 行]
// [缺失第 429 行]
// [缺失第 430 行]
// [缺失第 431 行]
// [缺失第 432 行]
// [缺失第 433 行]
// [缺失第 434 行]
// [缺失第 435 行]
// [缺失第 436 行]
// [缺失第 437 行]
// [缺失第 438 行]
// [缺失第 439 行]
// [缺失第 440 行]
// [缺失第 441 行]
// [缺失第 442 行]
// [缺失第 443 行]
// [缺失第 444 行]
// [缺失第 445 行]
// [缺失第 446 行]
// [缺失第 447 行]
// [缺失第 448 行]
// [缺失第 449 行]
// [缺失第 450 行]
// [缺失第 451 行]
// [缺失第 452 行]
// [缺失第 453 行]
// [缺失第 454 行]
// [缺失第 455 行]
// [缺失第 456 行]
// [缺失第 457 行]
// [缺失第 458 行]
// [缺失第 459 行]
// [缺失第 460 行]
// [缺失第 461 行]
// [缺失第 462 行]
// [缺失第 463 行]
// [缺失第 464 行]
// [缺失第 465 行]
// [缺失第 466 行]
// [缺失第 467 行]
// [缺失第 468 行]
// [缺失第 469 行]
// [缺失第 470 行]
// [缺失第 471 行]
// [缺失第 472 行]
// [缺失第 473 行]
// [缺失第 474 行]
// [缺失第 475 行]
// [缺失第 476 行]
// [缺失第 477 行]
// [缺失第 478 行]
// [缺失第 479 行]
// [缺失第 480 行]
// [缺失第 481 行]
// [缺失第 482 行]
// [缺失第 483 行]
// [缺失第 484 行]
// [缺失第 485 行]
// [缺失第 486 行]
// [缺失第 487 行]
// [缺失第 488 行]
// [缺失第 489 行]
// [缺失第 490 行]
// [缺失第 491 行]
// [缺失第 492 行]
        else lines.forEach(function (line) { logBox.appendChild(fileLineNode(line)); });
        var c2 = $('logCount'); if (c2) c2.textContent = lines.length + ' 行';
        var h2 = $('logHint'); if (h2) h2.textContent = fileError || (logSource + '.log');
      }
      if (logFollow || atBottom) logBox.scrollTop = logBox.scrollHeight;
      var jump = $('logJump');
      if (jump) jump.classList.toggle('on', !logFollow && logBox.scrollHeight > logBox.clientHeight + 40);
    }
    function fileLineNode(line) {
      var row = el('div', 'logline');
      var tm = el('span', 'tm', '');
      var body = el('span', 'ms', line);
      if (line.indexOf('ERROR') !== -1 || line.indexOf('错误') !== -1) { row.classList.add('error'); body.style.color = 'var(--err)'; }
      else if (line.indexOf('WARN') !== -1 || line.indexOf('警告') !== -1) { row.classList.add('warn'); body.style.color = 'var(--warn)'; }
      row.appendChild(tm); row.appendChild(el('span', 'ev', '')); row.appendChild(body);
      return row;
    }
    function loadFile() {
      var src = logSource === 'events' ? 'bridge' : logSource;
      return api('/api/logs?source=' + encodeURIComponent(src) + '&lines=800').then(function (d) {
        fileLines = d.lines || (d.text && String(d.text).split('\n')) || [];
        fileError = d.error || '';
// [缺失第 515 行]
// [缺失第 516 行]
// [缺失第 517 行]
// [缺失第 518 行]
// [缺失第 519 行]
// [缺失第 520 行]
// [缺失第 521 行]
// [缺失第 522 行]
// [缺失第 523 行]
// [缺失第 524 行]
// [缺失第 525 行]
// [缺失第 526 行]
// [缺失第 527 行]
// [缺失第 528 行]
// [缺失第 529 行]
// [缺失第 530 行]
// [缺失第 531 行]
// [缺失第 532 行]
// [缺失第 533 行]
// [缺失第 534 行]
// [缺失第 535 行]
// [缺失第 536 行]
// [缺失第 537 行]
// [缺失第 538 行]
// [缺失第 539 行]
// [缺失第 540 行]
// [缺失第 541 行]
// [缺失第 542 行]
// [缺失第 543 行]
// [缺失第 544 行]
// [缺失第 545 行]
// [缺失第 546 行]
// [缺失第 547 行]
// [缺失第 548 行]
// [缺失第 549 行]
// [缺失第 550 行]
// [缺失第 551 行]
// [缺失第 552 行]
// [缺失第 553 行]
// [缺失第 554 行]
// [缺失第 555 行]
// [缺失第 556 行]
// [缺失第 557 行]
// [缺失第 558 行]
// [缺失第 559 行]
        updateHeader(status); if (logSource === 'events') renderLog(false);
      },
      onStatus: function (s) { status = s; updateHeader(s); },
      onEvent: function (ev) {
        events.push(ev); if (events.length > 500) events.splice(0, events.length - 500);
        lastEventAt = ev.at || Date.now();
        if (logSource === 'events' && logVisible(ev)) {
          var empty = logBox.querySelector('.empty'); if (empty) logBox.textContent = '';
          logBox.appendChild(eventNode(ev, true));
          while (logBox.children.length > 500) logBox.removeChild(logBox.firstChild);
          var count = $('logCount'); if (count) count.textContent = logBox.querySelectorAll('.logline').length + ' / ' + events.length + ' 条';
          if (logFollow) logBox.scrollTop = logBox.scrollHeight; else { var j = $('logJump'); if (j) j.classList.add('on'); }
        }
      }
    });
    setInterval(function () {
      if (lastEventAt) { var h = $('logHint'); if (h && logSource === 'events') h.textContent = '最后一条 ' + ago(lastEventAt); }
    }, 1000);
  }

  /* ── 状态页 ───────────────────────────────────────────── */
  if (page === 'status') {
    renderStatus(status);
    renderHealthCards(health);
    renderChecks(health);
    function tickStatus() { loadStatus(); loadHealth(); }
    tickStatus();
    setInterval(tickStatus, 3000);
    if ($('copyStatus')) $('copyStatus').addEventListener('click', function () { copyText($('statusJson').textContent, this); });
  }

  /* ── 配置页 ───────────────────────────────────────────── */
  if (page === 'config') {
    var CONFIG = configData && configData.config ? JSON.parse(JSON.stringify(configData.config)) : {};
    token = (function () { try { return sessionStorage.getItem('np-panel-token') || ''; } catch (e) { return ''; } })();
    var tokenInput = $('panelToken');
    if (tokenInput) tokenInput.value = token;
    function setUnlocked(on) {
      var s = $('tokenState');
      if (s) s.textContent = on ? '已解锁（本标签页）' : (writeEnabled ? '未解锁' : '写入口关闭');
      if (tokenInput) tokenInput.value = on ? token : '';
      document.querySelectorAll('[data-cmd]').forEach(function (b) { if (writeEnabled) b.disabled = !on; });
    }
    function unlock() {
      if (!writeEnabled) { toast('写入口已关闭；先改 config.json 的 panel.writeEnabled 并重启', 3000); return; }
      token = tokenInput && tokenInput.value.trim() || '';
      if (!token) { toast('请填面板 token', 1600); return; }
      api('/api/auth', { method: 'POST', auth: token, body: '{}' }).then(function () {
        try { sessionStorage.setItem('np-panel-token', token); } catch (e) {}
        setUnlocked(true); toast('已解锁；写请求会带 token', 1600);
      }).catch(function (e) {
        token = '';
        toast('解锁失败：' + e.message, 2800);
      });
    }
    if ($('unlock')) $('unlock').addEventListener('click', unlock);
    if ($('lock')) $('lock').addEventListener('click', function () {
      token = ''; try { sessionStorage.removeItem('np-panel-token'); } catch (e) {}
      setUnlocked(false); toast('已锁定', 1200);
    });
    setUnlocked(!!token);
    if (token) {
      api('/api/auth', { method: 'POST', auth: token, body: '{}' }).catch(function () {
        token = '';
        try { sessionStorage.removeItem('np-panel-token'); } catch (e) {}
        setUnlocked(false);
      });
    }

    function getPath(obj, dotted) {
      var cur = obj;
      String(dotted).split('.').forEach(function (k) { cur = cur === null || cur === undefined ? undefined : cur[k]; });
      return cur;
    }
    function setPath(obj, dotted, value) {
      var keys = String(dotted).split('.'), cur = obj;
      for (var i = 0; i < keys.length - 1; i++) {
        if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object' || Array.isArray(cur[keys[i]])) cur[keys[i]] = {};
        cur = cur[keys[i]];
      }
      cur[keys[keys.length - 1]] = value;
    }
    var initialValues = {};
    Array.prototype.forEach.call(document.querySelectorAll('[data-path]'), function (e) {
      initialValues[e.getAttribute('data-path')] = e.type === 'checkbox' ? (e.checked ? '1' : '0') : e.value;
    });
    function collect() {
      var out = JSON.parse(JSON.stringify(CONFIG));
      var fields = document.querySelectorAll('[data-path]');
      for (var i = 0; i < fields.length; i++) {
        var e = fields[i], path = e.getAttribute('data-path'), type = e.getAttribute('data-type');
        var original = getPath(CONFIG, path);
        var present = original !== undefined;
        var current = e.type === 'checkbox' ? (e.checked ? '1' : '0') : e.value;
        // 配置里原本没有的可选项：只有用户真的改了才写回去，避免“点一次保存多出五个默认值”。
        if (!present && current === initialValues[path]) continue;
        if (type === 'boolean') { setPath(out, path, !!e.checked); continue; }
        var v = e.value;
        if (type === 'secret') {
          if (!v || v === '••••••••') continue;
          setPath(out, path, v); continue;
        }
        if (String(v).trim() === '' && original === null) { setPath(out, path, null); continue; }
        if (type === 'number') {
          if (String(v).trim() === '') throw new Error(path + ' 不能为空');
          var n = Number(v); if (!isFinite(n)) throw new Error(path + ' 必须是数字');
          setPath(out, path, n); continue;
        }
        if (type === 'list') {
          setPath(out, path, String(v).split(/[\n,]+/).map(function (x) { return x.trim(); }).filter(Boolean));
          continue;
        }
        if (type === 'json') {
          try { setPath(out, path, v.trim() ? JSON.parse(v) : null); }
          catch (err) { throw new Error(path + ' 不是合法 JSON：' + err.message); }
          continue;
        }
        setPath(out, path, v);
      }
      return out;
    }
    function showSaveResult(d) {
      var old = $('saveResult');
      if (old) old.remove();
      var box = el('div', 'notice ' + (d.restartRequired ? 'warn' : 'ok'));
      box.id = 'saveResult';
      box.textContent = '已保存' + (d.changed && d.changed.length ? '，变更 ' + d.changed.length + ' 项' : '') +
        (d.backup ? ' · 备份 ' + short(d.backup, 54) : '') + (d.restartRequired ? ' · 需要重启才会生效' : '');
      var wrap = document.querySelector('main.wrap');
      if (wrap) wrap.insertBefore(box, wrap.firstChild);
      if (d.restartRequired) {
        box.appendChild(document.createTextNode(' '));
        var rb = el('button', 'btn', '立即重启');
        rb.type = 'button'; rb.style.marginLeft = '10px';
        rb.addEventListener('click', function () { confirmRestart(); });
        box.appendChild(rb);
      }
    }
    function saveConfig(payload, fromRaw) {
      if (!writeEnabled) { toast('写入口已关闭', 2200); return Promise.reject(new Error('write disabled')); }
      if (!token) { toast('先解锁：填面板写 token', 2200); return Promise.reject(new Error('no token')); }
      var btn = $('saveConfig'); if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
      return api('/api/config', { method: 'PUT', auth: true, body: JSON.stringify({ config: payload }) })
        .then(function (d) {
          CONFIG = d.config ? d.config : payload;
          var raw = $('rawJson'); if (raw) raw.value = JSON.stringify(CONFIG, null, 2);
          showSaveResult(d);
          toast('配置已保存' + (d.restartRequired ? '，需重启' : ''), 2400);
          return d;
        })
        .catch(function (e) {
          var box = el('div', 'notice bad'); box.id = 'saveResult';
          box.textContent = '保存失败：' + e.message;
          var wrap = document.querySelector('main.wrap'); if (wrap) wrap.insertBefore(box, wrap.firstChild);
          toast('保存失败：' + e.message, 3200);
          throw e;
        })
        .finally(function () {
          if (btn) { btn.disabled = false; btn.textContent = '保存配置'; }
        });
    }
    if ($('configForm')) $('configForm').addEventListener('submit', function (e) {
      e.preventDefault();
      var payload;
      try { payload = collect(); } catch (err) { toast(err.message, 3200); return; }
      saveConfig(payload, false).catch(function () {});
    });
    if ($('configForm')) $('configForm').addEventListener('input', function () {
      var h = $('dirtyHint'); if (h) h.textContent = '有未保存的修改；保存后写入 config.json。';
    });

    function runCommand(text, label) {
      if (!writeEnabled) { toast('写入口已关闭', 2200); return; }
      if (!token) { toast('先解锁：填面板写 token', 2200); return; }
      var out = $('cmdOut'); if (out) { out.textContent = '执行中…'; out.className = 'cmdout dim'; }
      var lab = $('cmdLabel'); if (lab) lab.textContent = label || text;
      var target = $('rtChat') ? $('rtChat').value : '';
      api('/api/command', { method: 'POST', auth: true, body: JSON.stringify({ text: text, chatKey: target }) })
        .then(function (d) {
          var r = d.result || {};
          var msg = r.reply || r.error || '（没有返回内容）';
          if (out) { out.textContent = msg; out.className = 'cmdout ' + (r.ok === false ? 'errText' : 'okText'); }
          toast(r.ok === false ? '指令失败' : '指令已执行', 2000);
          loadHealth();
        })
        .catch(function (e) {
          if (out) { out.textContent = '失败：' + e.message; out.className = 'cmdout errText'; }
          toast('指令失败：' + e.message, 2600);
        });
    }
    document.querySelectorAll('[data-cmd]').forEach(function (b) {
      b.addEventListener('click', function () {
        var cmd = b.getAttribute('data-cmd');
        var text = '';
        if (cmd === 'ws') { var w = $('rtWs'); text = '/ws ' + (w && w.value.trim() || ''); }
        else if (cmd === 'model') { var m = $('rtModel'); text = '/model' + (m && m.value ? ' ' + m.value : ''); }
        else if (cmd === 'permission') { var p = $('rtPreset'); text = '/permission ' + (p && p.value || ''); }
        else if (cmd === 'session') { var s = $('rtSession'); text = '/ws ' + (s && s.value.trim() || ''); }
        else if (cmd === 'new') text = '/new';
        else if (cmd === 'stop') text = '/stop';
        if (!text || text === '/ws ') { toast('先填写参数', 1600); return; }
        if ((cmd === 'session' || cmd === 'model') && text.split(' ').length < 2) { toast('先填写参数', 1600); return; }
        runCommand(text, text);
      });
    });
    if ($('cmdCopy')) $('cmdCopy').addEventListener('click', function () { copyText($('cmdOut') && $('cmdOut').textContent, this); });

    function confirmRestart() {
      var modal = $('modal');
      if (!modal) { if (confirm('重启桥接器？')) doRestart(); return; }
      $('modalTitle').textContent = '重启桥接器';
      $('modalBody').textContent = '会先等待在跑回合收尾（最长 120s），NapCat 不受影响。当前页面会短暂断开。';
      modal.hidden = false;
      $('modalOk').onclick = function () { modal.hidden = true; doRestart(); };
      $('modalCancel').onclick = function () { modal.hidden = true; };
    }
    function doRestart() {
      if (!token) { toast('先解锁', 1800); return; }
      var b = $('restartBtn'); if (b) { b.disabled = true; b.textContent = '重启中…'; }
      api('/api/restart', { method: 'POST', auth: true, body: JSON.stringify({}) })
