/**
 * SimpleLog timeline viewer (/protocols/simplelog v1).
 *
 * Two data channels, deliberately separated (the task's readback discipline):
 *   - DISCOVERY: `GET /pin/path/list?path=/protocols/simplelog` — this answers
 *     "which pins exist". Its rolling summary fields are never used and its
 *     `total` is not trusted; the list is walked by cursor.
 *   - BODY: `GET /content/<pinId>` — the only faithful source for a record's
 *     fields. A single 404 is index lag, not absence: the read retries inside a
 *     30–60 s window before the entry is marked unread.
 *
 * Read-only by design: the viewer writes nothing on-chain.
 */
(function () {
  'use strict';

  var API_BASE = 'https://manapi.metaid.io';
  var LOG_PATH = '/protocols/simplelog';
  var PAGE_SIZE = 100;
  var MAX_PAGES = 5;
  var READBACK_RETRY_MS = 5000;
  var READBACK_WINDOW_MS = 60000;
  var CONCURRENCY = 4;

  var core = window.SimpleLogCore;
  var state = { entries: [], timeline: { groups: [], unread: [] }, selected: '', filter: '', loading: true };

  var sidebar = document.getElementById('sidebar');
  var main = document.getElementById('main');
  var meta = document.getElementById('meta');
  var filterInput = document.getElementById('filter');
  var refreshButton = document.getElementById('refresh');

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function shortPin(pin) {
    var text = String(pin || '');
    return text.length > 12 ? text.slice(0, 8) + '…' + text.slice(-4) : text;
  }

  function timeText(unixSeconds) {
    var ts = Number(unixSeconds) || 0;
    if (!ts) return '';
    var date = new Date(ts * 1000);
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate())
      + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes());
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  async function getJson(url) {
    var response = await fetch(url, { headers: { accept: 'application/json' } });
    if (!response.ok) {
      var error = new Error('HTTP ' + response.status);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  /** Discovery only: walk the path list by cursor. */
  async function listLogPins() {
    var pins = [];
    var cursor = '';
    for (var page = 0; page < MAX_PAGES; page += 1) {
      var url = API_BASE + '/pin/path/list?path=' + encodeURIComponent(LOG_PATH) + '&size=' + PAGE_SIZE;
      if (cursor) url += '&cursor=' + encodeURIComponent(cursor);
      var body = await getJson(url);
      var data = body && body.data ? body.data : {};
      var list = Array.isArray(data.list) ? data.list : [];
      for (var i = 0; i < list.length; i += 1) {
        var item = list[i] || {};
        if (item.id) {
          pins.push({
            pinId: item.id,
            timestamp: Number(item.timestamp) || 0,
            author: item.address || item.metaid || '',
            globalMetaId: item.globalMetaId || '',
            record: null,
            readState: 'pending',
          });
        }
      }
      cursor = typeof data.nextCursor === 'string' ? data.nextCursor : '';
      if (!cursor || !list.length) break;
    }
    return pins;
  }

  /**
   * The faithful body: /content/<pinId> with the 30–60 s retry window. Returns
   * the raw text, or null after the window with the last observation attached.
   */
  async function readBody(pinId) {
    var deadline = Date.now() + READBACK_WINDOW_MS;
    var last = 'no attempt';
    for (;;) {
      try {
        var response = await fetch(API_BASE + '/content/' + encodeURIComponent(pinId), { headers: { accept: 'text/plain' } });
        if (response.ok) {
          var text = await response.text();
          if (text && text.trim()) return { text: text, note: '' };
          last = 'empty body';
        } else {
          last = 'HTTP ' + response.status;
        }
      } catch (error) {
        last = error && error.message ? error.message : 'network error';
      }
      if (Date.now() >= deadline) return { text: null, note: last };
      await sleep(READBACK_RETRY_MS);
    }
  }

  function renderMeta() {
    var groups = state.timeline.groups;
    var records = 0;
    for (var i = 0; i < groups.length; i += 1) records += groups[i].records.length;
    var unreadCount = state.timeline.unread.length;
    meta.innerHTML = state.loading
      ? '<span class="pill">读取中…</span>'
      : '<span class="pill">' + groups.length + ' 个任务锚点</span>'
        + '<span class="pill">' + records + ' 条记录</span>'
        + (unreadCount ? '<span class="pill warn">' + unreadCount + ' 条读回失败</span>' : '');
  }

  function renderSidebar() {
    var groups = state.timeline.groups;
    if (!groups.length) {
      sidebar.innerHTML = '<div class="state">没有可显示的任务锚点。</div>';
      return;
    }
    var html = groups.map(function (group) {
      var summary = core.summarizeGroup(group);
      var kinds = Object.keys(summary.byKind).sort().map(function (kind) {
        return '<span class="mini-kind">' + escapeHtml(kind) + ' ' + summary.byKind[kind] + '</span>';
      }).join('');
      var active = group.key === state.selected ? ' active' : '';
      var label = group.taskid
        ? 'pin ' + escapeHtml(shortPin(group.taskid))
        : 'key ' + escapeHtml(group.taskkey);
      return '<a class="task' + active + '" href="#/task/' + encodeURIComponent(group.label) + '">'
        + '<div class="task-label">' + label + '</div>'
        + '<div class="task-meta">' + summary.recordCount + ' records · ' + (timeText(group.lastTimestamp) || '—') + '</div>'
        + '<div class="task-kinds">' + kinds + '</div>'
        + '</a>';
    }).join('');
    sidebar.innerHTML = html;
  }

  function deliverableText(item) {
    return '<a class="uri" href="' + escapeHtml(item.uri) + '">' + escapeHtml(item.uri) + '</a>';
  }

  function recordHtml(entry, index) {
    var record = entry.record || {};
    var kind = String(record.kind || 'note');
    var chips = [];
    if (record.step) chips.push('step: ' + escapeHtml(record.step));
    if (record.status) chips.push('status: ' + escapeHtml(record.status));
    if (record.role) chips.push('role: ' + escapeHtml(record.role));
    if (record.toid) chips.push('to: ' + escapeHtml(String(record.toid).slice(0, 12)) + '…');
    var deliverables = core.uriList(record.deliverables);
    var refs = core.uriList(record.refs);
    var pending = entry.readState === 'pending';
    var author = entry.globalMetaId
      ? '<a class="author" href="metaid://' + escapeHtml(entry.globalMetaId) + '">' + escapeHtml(entry.globalMetaId.slice(0, 12)) + '…</a>'
      : escapeHtml(entry.author || 'unknown');
    return '<article class="record' + (core.isCorrection(record) ? ' correction' : '') + '">'
      + '<header class="record-head">'
      + '<span class="kind kind-' + escapeHtml(kind) + '">' + escapeHtml(kind) + '</span>'
      + (core.isCorrection(record) ? '<span class="badge-correction">更正</span>' : '')
      + '<span class="seq">#' + (index + 1) + '</span>'
      + '<time>' + escapeHtml(timeText(entry.timestamp)) + '</time>'
      + '<span class="by">by ' + author + '</span>'
      + '</header>'
      + (chips.length ? '<div class="chips">' + chips.map(function (chip) { return '<span class="chip">' + chip + '</span>'; }).join('') + '</div>' : '')
      + '<p class="summary">' + escapeHtml(record.summary) + '</p>'
      + (deliverables.length
        ? '<div class="uris"><span class="uri-label">deliverables</span>'
          + deliverables.map(function (uri) {
            return '<a class="uri uri-' + core.chainUriKind(uri) + '" href="' + escapeHtml(uri) + '">' + escapeHtml(uri) + '</a>';
          }).join('') + '</div>'
        : '')
      + (refs.length
        ? '<div class="uris"><span class="uri-label">refs</span>'
          + refs.map(function (uri) { return '<a class="uri ref" href="' + escapeHtml(uri) + '">' + escapeHtml(uri) + '</a>'; }).join('')
          + '</div>'
        : '')
      + '<footer class="record-foot">'
      + (pending
        ? '<span class="pending">读回中（索引延迟窗口 60s 内不算未写入）</span>'
        : '<a class="pinlink" href="pin://' + escapeHtml(entry.pinId) + '">pin://' + escapeHtml(shortPin(entry.pinId)) + '</a>')
      + '</footer>'
      + '</article>';
  }

  function renderTimeline() {
    var group = null;
    for (var i = 0; i < state.timeline.groups.length; i += 1) {
      if (state.timeline.groups[i].key === state.selected) { group = state.timeline.groups[i]; break; }
    }
    if (!group) {
      main.innerHTML = '<div class="state">左侧选择一个任务锚点。</div>';
      return;
    }
    var summary = core.summarizeGroup(group);
    var head = '<div class="group-head">'
      + '<h2>' + (group.taskid
        ? 'pin <a class="anchor" href="pin://' + escapeHtml(group.taskid) + '">' + escapeHtml(shortPin(group.taskid)) + '</a>'
        : 'key ' + escapeHtml(group.taskkey)) + '</h2>'
      + '<div class="group-meta">' + escapeHtml(timeText(summary.firstTimestamp)) + ' → ' + escapeHtml(timeText(summary.lastTimestamp))
      + ' · ' + summary.recordCount + ' records · ' + summary.authorCount + ' 作者</div>'
      + '</div>';

    var deliverablePanel = summary.deliverables.length
      ? '<section class="panel"><h3>交付清单（deliverables 并集，去重后 ' + summary.deliverables.length + ' 项）</h3><ul class="union">'
        + summary.deliverables.map(function (item) {
          return '<li><a class="uri uri-' + escapeHtml(item.kind) + '" href="' + escapeHtml(item.uri) + '">' + escapeHtml(item.uri) + '</a>'
            + '<span class="union-by">by ' + escapeHtml(item.by) + '</span></li>';
        }).join('')
        + '</ul></section>'
      : '';

    var correctionPanel = summary.corrections.length
      ? '<section class="panel warn-panel"><h3>更正条目 ' + summary.corrections.length + ' 条</h3><ul class="union">'
        + summary.corrections.map(function (item) {
          return '<li>' + escapeHtml(item.summary) + '<span class="union-by">' + item.refs.length + ' refs</span></li>';
        }).join('')
        + '</ul><p class="hint">本视图按时间序原样展示日志，不做取代隐藏：被更正条目仍在时间线上，更正条目带「更正」标记。</p></section>'
      : '';

    var filter = state.filter.trim().toLowerCase();
    var records = group.records.filter(function (entry) {
      if (!filter) return true;
      var record = entry.record || {};
      var haystack = [record.kind, record.summary, record.step, record.status, record.role, entry.globalMetaId, entry.pinId]
        .join(' ').toLowerCase();
      return haystack.indexOf(filter) !== -1;
    });

    main.innerHTML = head + deliverablePanel + correctionPanel
      + '<section class="timeline">' + (records.length
        ? records.map(recordHtml).join('')
        : '<div class="state">没有匹配的记录。</div>') + '</section>';
  }

  function renderUnread() {
    var unread = state.timeline.unread;
    if (!unread.length) return;
    var banner = document.createElement('div');
    banner.className = 'unread-banner';
    banner.innerHTML = unread.length + ' 条记录在 60 秒读回窗口内没有取到正文（索引延迟或索引缺失）——它们不计入上面任何统计。'
      + '<ul>' + unread.map(function (entry) {
        return '<li><a href="pin://' + escapeHtml(entry.pinId || '') + '">pin://' + escapeHtml(shortPin(entry.pinId)) + '</a>'
          + (entry.readNote ? ' <span class="hint">' + escapeHtml(entry.readNote) + '</span>' : '') + '</li>';
      }).join('') + '</ul>';
    main.insertBefore(banner, main.firstChild);
  }

  function render() {
    renderMeta();
    renderSidebar();
    renderTimeline();
    renderUnread();
  }

  function rebuild() {
    state.timeline = core.buildTimeline(state.entries);
    var keys = state.timeline.groups.map(function (group) { return group.key; });
    if (keys.indexOf(state.selected) === -1) state.selected = keys.length ? keys[0] : '';
    render();
  }

  function selectFromHash() {
    var match = /^#\/task\/(.+)$/.exec(window.location.hash || '');
    if (match) {
      var label = decodeURIComponent(match[1]);
      for (var i = 0; i < state.timeline.groups.length; i += 1) {
        if (state.timeline.groups[i].label === label) { state.selected = state.timeline.groups[i].key; return; }
      }
    }
  }

  async function load() {
    state.loading = true;
    render();
    try {
      state.entries = await listLogPins();
    } catch (error) {
      state.loading = false;
      main.innerHTML = '<div class="error-box">读取 /protocols/simplelog 列表失败：'
        + escapeHtml(error && error.message ? error.message : String(error)) + '</div>';
      renderMeta();
      return;
    }
    state.loading = false;
    selectFromHash();
    rebuild();

    // Bodies land one by one; the timeline re-renders as each finishes.
    var index = 0;
    async function worker() {
      for (;;) {
        var current = index;
        index += 1;
        if (current >= state.entries.length) return;
        var entry = state.entries[current];
        var result = await readBody(entry.pinId);
        entry.record = result.text ? core.parseRecordBody(result.text) : null;
        entry.readState = result.text ? (entry.record ? 'read' : 'not-a-record') : 'unread';
        entry.readNote = result.note || '';
        if (entry.readState !== 'read') entry.record = null;
        rebuild();
      }
    }
    var workers = [];
    for (var w = 0; w < Math.min(CONCURRENCY, state.entries.length || 1); w += 1) workers.push(worker());
    await Promise.all(workers);
    rebuild();
  }

  filterInput.addEventListener('input', function (event) {
    state.filter = event.target.value || '';
    renderTimeline();
    renderUnread();
  });
  refreshButton.addEventListener('click', function () { load(); });
  window.addEventListener('hashchange', function () { selectFromHash(); renderSidebar(); renderTimeline(); });

  load();
})();
