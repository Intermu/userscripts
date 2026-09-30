// ==UserScript==
// @name         BWN Note Report (Broadway National)
// @namespace    broadwaynational.bwn
// @version      1.2.0
// @description  Read-only note activity report for one coordinator over an Eastern-Time date range, with a four-tab Excel export - it replaces pulling each work order's notes by hand. Opens from the shared dock (bwn:dock:*, hosted by bwn-suite-core); without Core a floating "Note Report" button appears bottom-right instead. Pick a user (member-search typeahead, teams filtered out) and a date range: it scopes work orders by that user's tasks (created or completed in the range, or still open with a target start on or before its end), optionally adds WOs they coordinate whose LastNoteDate falls in the range, de-duplicates them, batch-resolves WO details, pulls every note on each WO and keeps the user's own by author id. The preview shows totals, notes per day and a sortable table; Export writes Summary, Notes, Tasks and Flags tabs (past expected completion, open task past target, task activity with no notes, gaps of 2+ business days with no note on an open WO). Read-only by construction: one guarded request path can send only five fixed, named GraphQL queries, POST to same-origin /api/graphql, with the page's own Umbrava session token used transiently and never stored; at most 4 requests in flight, retries only on 429/502/503/504, and UNAUTHENTICATED (which Umbrava returns as HTTP 500) stops the run. No @connect, no keys, nothing is written to storage, nothing leaves the browser except the downloaded workbook.
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-note-report.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-note-report.user.js
// @match        https://app.umbrava.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/exceljs/4.4.0/exceljs.min.js#sha384=3eaa79d4550ddbfab37f1671042b45d2cb6973d38d23a31866956a9a8f26db44a86900b37fe6ab66f00290b922ae53f3
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var TZ = 'America/New_York';
  var ORIGIN = 'https://app.umbrava.com';
  var ENDPOINT = ORIGIN + '/api/graphql';
  var WO_URL = ORIGIN + '/work-orders/';            // + <number> + '/details' (route seen in Umbrava's own links)
  var MAX_IN_FLIGHT = 4;
  var MAX_RETRIES = 2;
  var RETRY_AFTER_CAP_MS = 30000;
  var TASK_PAGE = 100;
  var WO_PAGE = 100;
  var XL_FONT = 'DM Sans';
  var XL_CELL_MAX = 32767;                          // Excel's hard per-cell character limit

  // ---- GraphQL: the ONLY documents this script can send ------------------------------------
  // Work-order list variables are deliberately NOT named page/skip/take: the BWN Suite's List Heat
  // hook latches any work-order query whose variables look like paging, and would then replay ours
  // as the board query. Neutral names (nrSkip, nrOrder...) keep this report invisible to it.
  var WO_FIELDS = 'number formattedJobNumber lastNoteDate assignedTo assignedToMemberName statusName ' +
    'systemStatusName phase locationNumber locationName clientName priority { expectedCompletionDate }';
  var QUERIES = Object.freeze({
    NrMemberSearch:
      'query NrMemberSearch($s: String, $n: Int) { searchMembers(search: $s, searchType: BOTH, skip: 0, take: $n) ' +
      '{ rowCount items { id displayName firstName lastName memberType isInactive } } }',
    NrTasksByAssignee:
      'query NrTasksByAssignee($a: [ID], $skip: Int, $take: Int) { tasks(assignedTo: $a, includeComplete: true, skip: $skip, take: $take) ' +
      '{ total tasks { id entityType entityId description createdDate completionDate targetStartDate isComplete formattedJobNumber assignedTo } } }',
    NrWorkOrderNotes:
      'query NrWorkOrderNotes($n: Int!) { workOrderNotes(workOrderNumber: $n, includeDeleted: false) ' +
      '{ id type content createdDate createdBy_UserProfileId isPinned isDeleted } }',
    NrCoordinatorWOs:
      'query NrCoordinatorWOs($nrSkip: Int!, $nrOrder: [SortInput!]!, $nrCoord: [ID]) { listWorkOrdersPaginated(page: { skip: $nrSkip, take: ' + WO_PAGE + ' }, sortBy: $nrOrder, assignedTo: $nrCoord) ' +
      '{ rowCount items { ' + WO_FIELDS + ' } } }',
    NrWorkOrderDetails:
      'query NrWorkOrderDetails($nrOrder: [SortInput!]!, $nrNums: [Int]) { listWorkOrdersPaginated(page: { skip: 0, take: ' + WO_PAGE + ' }, sortBy: $nrOrder, WorkOrderNumbers: $nrNums) ' +
      '{ rowCount items { ' + WO_FIELDS + ' } } }'
  });
  var ALLOWED_OPS = Object.freeze(Object.keys(QUERIES));

  function nrError(category, message) {
    var e = new Error(message);
    e.nrCategory = category;
    return e;
  }

  // One read-only `query` named exactly `op`; no mutation/subscription anywhere in the document.
  function checkDocument(op, doc) {
    if (ALLOWED_OPS.indexOf(op) === -1) throw nrError('BLOCKED', 'Operation not allowed');
    var defs = String(doc).match(/(^|\})\s*(query|mutation|subscription|fragment)\b/g) || [];
    if (defs.length !== 1) throw nrError('BLOCKED', 'Exactly one operation is allowed');
    if (!new RegExp('^query ' + op + '\\(').test(doc)) throw nrError('BLOCKED', 'Only a named read-only query is allowed');
    if (/\b(mutation|subscription)\b/i.test(doc)) throw nrError('BLOCKED', 'Write operations are not allowed');
  }
  ALLOWED_OPS.forEach(function (op) { checkDocument(op, QUERIES[op]); });   // fail closed at load

  // The active Umbrava page session's access token is used transiently for same-origin,
  // read-only API calls. It is read per request and never stored, logged, displayed or exported.
  function sessionAccessToken() {
    try {
      var keys = Object.keys(localStorage).filter(function (k) {
        return /@@auth0spajs@@::.*::https:\/\/app\.umbrava\.com\/api::/.test(k);
      });
      for (var i = 0; i < keys.length; i++) {
        var body = (JSON.parse(localStorage.getItem(keys[i])) || {}).body;
        var tok = body && body.access_token;
        if (tok && tokenUsable(tok)) return tok;
      }
    } catch (e) { /* fall through */ }
    return '';
  }
  function tokenUsable(tok) {
    try {
      var p = JSON.parse(atob(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      var iss = String(p.iss || '').replace(/\/+$/, '');
      if (iss !== 'https://login.umbrava.com' && iss !== 'https://umbrava.us.auth0.com') return false;
      return !(typeof p.exp === 'number' && Date.now() / 1000 > p.exp);
    } catch (e) { return false; }
  }

  var AUTH_CODES = ['UNAUTHENTICATED', 'UNAUTHORIZED', 'AUTH_NOT_AUTHENTICATED', 'AUTH_NOT_AUTHORIZED'];
  var TRANSIENT_CODES = ['RATE_LIMITED', 'TOO_MANY_REQUESTS', 'SERVICE_UNAVAILABLE', 'TIMEOUT'];

  // -> null on success, else { cat, retry }. A 5xx is only retried after the GraphQL body is
  // checked: Umbrava answers an unauthenticated call with HTTP 500 + UNAUTHENTICATED.
  function classify(status, json) {
    var codes = ((json && json.errors) || []).map(function (e) {
      return String((e && e.extensions && e.extensions.code) || '').toUpperCase();
    });
    var has = function (list) { return codes.some(function (c) { return list.indexOf(c) !== -1; }); };
    if (has(AUTH_CODES)) return { cat: 'AUTH', retry: false };
    if (status === 429 || has(TRANSIENT_CODES)) return { cat: 'RATE_LIMIT', retry: true };
    var permanent = codes.filter(function (c) { return TRANSIENT_CODES.indexOf(c) === -1; });
    if ((status === 502 || status === 503 || status === 504) && !permanent.some(Boolean)) return { cat: 'SERVER_BUSY', retry: true };
    if (codes.length) return { cat: codes.some(function (c) { return /FORBID|PERMISSION/.test(c); }) ? 'PERMISSION' : 'QUERY_ERROR', retry: false };
    if (status < 200 || status >= 300) return { cat: 'HTTP_' + status, retry: false };
    if (!json || !json.data) return { cat: 'BAD_RESPONSE', retry: false };
    return null;
  }

  function retryDelay(attempt, retryAfter) {
    var s = Number(retryAfter);
    if (retryAfter != null && isFinite(s) && s >= 0) return Math.min(s * 1000, RETRY_AFTER_CAP_MS);
    return Math.min(1000 * Math.pow(2, attempt) + Math.floor(Math.random() * 400), RETRY_AFTER_CAP_MS);
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Global 4-slot pool: every request of every kind waits here.
  var inFlight = 0, waiters = [];
  function acquire() {
    if (inFlight < MAX_IN_FLIGHT) { inFlight++; return Promise.resolve(); }
    return new Promise(function (r) { waiters.push(r); });
  }
  function release() {
    var next = waiters.shift();
    if (next) next(); else inFlight--;
  }

  // The single request path. Nothing else in this file calls fetch.
  async function gql(run, op, variables) {
    if (!Object.prototype.hasOwnProperty.call(QUERIES, op)) throw nrError('BLOCKED', 'Operation not allowed');
    var doc = QUERIES[op];
    checkDocument(op, doc);
    if (location.origin !== ORIGIN) throw nrError('BLOCKED', 'Wrong origin');
    var body = JSON.stringify({ operationName: op, query: doc, variables: variables || {} });
    await acquire();
    try {
      for (var attempt = 0; ; attempt++) {
        if (run.cancelled) throw nrError('CANCELLED', 'Cancelled');
        var res, json = null;
        var tok = sessionAccessToken();
        if (!tok) { run.cancelled = true; run.authFailed = true; throw nrError('AUTH', 'Not signed in'); }
        try {
          res = await fetch(ENDPOINT, {
            method: 'POST',
            credentials: 'same-origin',
            cache: 'no-store',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
            body: body
          });
        } catch (e) {
          throw nrError('NETWORK', 'Network error');
        } finally {
          tok = null;
        }
        try { json = await res.json(); } catch (e) { json = null; }
        var c = classify(res.status, json);
        if (!c) return json.data;
        if (c.cat === 'AUTH') { run.cancelled = true; run.authFailed = true; throw nrError('AUTH', 'Session expired'); }
        if (!c.retry || attempt >= MAX_RETRIES) throw nrError(c.cat, 'Request failed (' + c.cat + ')');
        await sleep(retryDelay(attempt, res.headers.get('Retry-After')));
      }
    } finally {
      release();
    }
  }

  // ---- Dates: everything is compared as America/New_York calendar-day keys (YYYY-MM-DD) -----
  var etDateFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  var etTimeFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  var etStampFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

  // Umbrava sends ISO with an offset and 7 fractional digits; bare date-times are UTC.
  function parseTs(s) {
    if (!s) return null;
    var t = String(s).replace(/(\.\d{3})\d+/, '$1');
    if (/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) t += 'Z';
    var ms = Date.parse(t);
    return isNaN(ms) ? null : ms;
  }
  function etKey(ms) {
    if (ms == null) return null;
    var p = {};
    etDateFmt.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return p.year + '-' + p.month + '-' + p.day;
  }
  var etHmFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  function etMinutes(ms) {
    var p = {};
    etHmFmt.formatToParts(new Date(ms)).forEach(function (x) { p[x.type] = x.value; });
    return (Number(p.hour) % 24) * 60 + Number(p.minute);
  }
  function tsKey(s) { return etKey(parseTs(s)); }
  // Date-only fields (task target, expected completion): a bare date or a UTC-midnight stamp is
  // the calendar date itself, not an instant to shift into ET.
  // ponytail: midnight-UTC heuristic; switch to the field's declared type if Umbrava documents one.
  function calendarKey(s) {
    if (!s) return null;
    var m = /^(\d{4}-\d{2}-\d{2})(T00:00:00(\.0+)?(Z|[+-]00:00)?)?$/.exec(String(s));
    return m ? m[1] : tsKey(s);
  }
  function addDays(key, n) {
    var d = new Date(key + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function dayOfWeek(key) { return new Date(key + 'T12:00:00Z').getUTCDay(); }
  function daysBetween(a, b) { return Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5); }
  function todayKey() { return etKey(Date.now()); }
  function defaultRange() { var t = todayKey(); return { start: addDays(t, -6), end: t }; }
  function inRange(key, r) { return !!key && key >= r.start && key <= r.end; }
  function prettyDate(key) { return key ? Number(key.slice(5, 7)) + '/' + Number(key.slice(8, 10)) : ''; }

  // ---- Scope + flags (pure) -------------------------------------------------------------------
  function taskInScope(t, r) {
    if (Number(t.entityType) !== 1) return false;
    if (inRange(tsKey(t.createdDate), r)) return true;
    if (inRange(tsKey(t.completionDate), r)) return true;
    var target = calendarKey(t.targetStartDate);
    return !t.isComplete && !!target && target <= r.end;
  }

  // Runs of >= 2 consecutive business days (Mon-Fri, no holiday calendar) with no note.
  function noteGaps(start, end, noteKeys) {
    var gaps = [], run = [];
    function flush() {
      if (run.length >= 2) gaps.push({ from: run[0], to: run[run.length - 1], days: run.length });
      run = [];
    }
    for (var k = start; k <= end; k = addDays(k, 1)) {
      var w = dayOfWeek(k);
      if (w === 0 || w === 6) continue;
      if (noteKeys.has(k)) flush(); else run.push(k);
    }
    flush();
    return gaps;
  }

  // Open state of a work order: true (open), false (closed), null (unknown). The WO fields carry
  // no completed/closed boolean, so any terminal word in phase / system status / status closes
  // it; a non-terminal value means open. No usable value = unknown, and an unknown WO never gets
  // an overdue or note-gap flag.
  // ponytail: word list, not a verified Umbrava taxonomy; swap for a status-id map if one is confirmed.
  var TERMINAL_STATE = /\b(complete|completed|closed|cancell?ed|void|voided|archived)\b/i;
  function woOpenState(meta) {
    if (!meta) return null;
    var vals = [meta.phase, meta.systemStatusName, meta.statusName].filter(function (v) {
      return typeof v === 'string' && v.trim();
    });
    if (!vals.length) return null;
    return !vals.some(function (v) { return TERMINAL_STATE.test(v); });
  }

  function buildFlags(res) {
    var flags = [], today = todayKey(), gapEnd = res.range.end < today ? res.range.end : today;
    var stateOf = new Map(res.wos.map(function (w) { return [w.number, woOpenState(w.meta)]; }));
    res.wos.forEach(function (w) {
      var label = woLabel(w), open = stateOf.get(w.number);
      if (w.error) flags.push({ kind: 'Fetch failed', wo: label, number: w.number, detail: 'Notes not retrieved (' + w.error + ')', dates: '' });
      if (w.detailError) flags.push({ kind: 'Details missing', wo: label, number: w.number, detail: 'Work-order details not returned (' + w.detailError + ')', dates: '' });
      var exp = w.meta && w.meta.priority && calendarKey(w.meta.priority.expectedCompletionDate);
      if (open === true && exp && exp < today) flags.push({ kind: 'Past expected completion', wo: label, number: w.number, detail: 'Expected ' + exp, dates: exp });
      if (w.viaTasks && !w.error && w.userNoteCount === 0) flags.push({ kind: 'Task activity, no notes', wo: label, number: w.number, detail: 'No notes by the user in range', dates: res.range.start + ' to ' + res.range.end });
      if (open === true && !w.error && res.range.start <= gapEnd) {
        noteGaps(res.range.start, gapEnd, w.userNoteKeys).forEach(function (g) {
          flags.push({ kind: 'Note gap', wo: label, number: w.number, detail: g.days + ' business days without a note', dates: g.from + ' to ' + g.to });
        });
      }
    });
    res.tasks.forEach(function (t) {
      var target = calendarKey(t.targetStartDate);
      if (!t.isComplete && target && target < today && stateOf.get(Number(t.entityId)) !== false) {
        flags.push({ kind: 'Open task past target', wo: t.formattedJobNumber || ('W-' + t.entityId), number: Number(t.entityId), detail: t.description || '', dates: target });
      }
    });
    return flags;
  }

  function woLabel(w) { return (w.meta && w.meta.formattedJobNumber) || ('W-' + w.number); }
  function sameId(a, b) { return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase(); }

  // ---- Run ------------------------------------------------------------------------------------
  async function runReport(run, opts, progress) {
    var r = opts.range, uid = opts.user.id;
    var wos = new Map();
    function wo(n) {
      if (!wos.has(n)) wos.set(n, { number: n, tasks: [], viaTasks: false, viaCoord: false, meta: null, notes: null, error: null, detailError: null });
      return wos.get(n);
    }

    progress('Loading tasks…');
    var tasks = [];
    for (var skip = 0; ; skip += TASK_PAGE) {
      var page = (await gql(run, 'NrTasksByAssignee', { a: [uid], skip: skip, take: TASK_PAGE })).tasks || {};
      var got = page.tasks || [];
      tasks = tasks.concat(got);
      progress('Loading tasks… ' + tasks.length + '/' + (page.total || tasks.length));
      if (got.length < TASK_PAGE || tasks.length >= Number(page.total || 0)) break;
    }
    var scoped = tasks.filter(function (t) { return taskInScope(t, r); });
    scoped.forEach(function (t) {
      var n = parseInt(t.entityId, 10);
      if (!n) return;
      var w = wo(n);
      w.tasks.push(t);
      w.viaTasks = true;
    });

    if (opts.coord && !run.cancelled) {
      progress('Loading coordinator WOs…');
      var order = [{ columnName: 'lastNoteDate', direction: 'DESC' }];
      for (var s = 0; ; s += WO_PAGE) {
        var list = (await gql(run, 'NrCoordinatorWOs', { nrSkip: s, nrOrder: order, nrCoord: [uid] })).listWorkOrdersPaginated || {};
        var items = list.items || [], older = false;
        items.forEach(function (it) {
          var k = tsKey(it.lastNoteDate);
          if (inRange(k, r)) { var w = wo(Number(it.number)); w.viaCoord = true; w.meta = it; }
          else if (k && k < r.start) older = true;   // sorted DESC: nothing later can be in range
        });
        if (older || items.length < WO_PAGE || s + items.length >= Number(list.rowCount || 0)) break;
      }
    }

    var all = Array.from(wos.values());
    var need = all.filter(function (w) { return !w.meta; }).map(function (w) { return w.number; });
    var resolved = all.length - need.length;
    progress('Resolving WOs ' + resolved + '/' + all.length + '…');
    var chunks = [];
    for (var i = 0; i < need.length; i += WO_PAGE) chunks.push(need.slice(i, i + WO_PAGE));
    await Promise.allSettled(chunks.map(async function (chunk) {
      try {
        var d = (await gql(run, 'NrWorkOrderDetails', { nrOrder: [{ columnName: 'formattedJobNumber', direction: 'ASC' }], nrNums: chunk })).listWorkOrdersPaginated || {};
        var byNum = new Map((d.items || []).map(function (it) { return [Number(it.number), it]; }));
        chunk.forEach(function (n) { var w = wos.get(n); w.meta = byNum.get(n) || null; if (!w.meta) w.detailError = 'NOT_RETURNED'; });
      } catch (e) {
        chunk.forEach(function (n) { wos.get(n).detailError = e.nrCategory || 'ERROR'; });
      }
      resolved += chunk.length;
      progress('Resolving WOs ' + resolved + '/' + all.length + '…');
    }));
    if (run.authFailed) throw nrError('AUTH', 'Session expired');

    var pulled = 0;
    progress('Pulling notes 0/' + all.length + '…');
    await Promise.allSettled(all.map(async function (w) {
      try {
        w.notes = (await gql(run, 'NrWorkOrderNotes', { n: w.number })).workOrderNotes || [];
      } catch (e) {
        w.error = e.nrCategory || 'ERROR';
      }
      pulled++;
      progress('Pulling notes ' + pulled + '/' + all.length + '…');
    }));
    if (run.authFailed) throw nrError('AUTH', 'Session expired');

    var rows = [];
    all.forEach(function (w) {
      w.userNoteCount = 0;
      w.userNoteKeys = new Set();
      (w.notes || []).forEach(function (n) {
        if (n.isDeleted) return;
        var ms = parseTs(n.createdDate), k = etKey(ms);
        if (!inRange(k, r)) return;
        var mine = sameId(n.createdBy_UserProfileId, uid);
        if (mine) { w.userNoteCount++; w.userNoteKeys.add(k); }
        if (!mine && !opts.others) return;
        var author = mine ? opts.user.displayName
          : (w.meta && sameId(n.createdBy_UserProfileId, w.meta.assignedTo) && w.meta.assignedToMemberName)
            || ('Other user (' + String(n.createdBy_UserProfileId || '?').slice(0, 8) + ')');
        rows.push({ number: w.number, wo: woLabel(w), meta: w.meta, ms: ms, key: k, time: etTimeFmt.format(new Date(ms)), minutes: etMinutes(ms),
          type: n.type, content: String(n.content || ''), author: author, mine: mine, pinned: !!n.isPinned });
      });
    });
    rows.sort(function (a, b) { return a.number - b.number || a.ms - b.ms; });

    var res = { user: opts.user, range: r, generated: Date.now(), cancelled: !!run.cancelled, taskTotal: tasks.length,
      tasks: scoped, wos: all.sort(function (a, b) { return a.number - b.number; }), rows: rows };
    res.flags = buildFlags(res);
    return res;
  }

  function summarize(res) {
    var mine = res.rows.filter(function (x) { return x.mine; });
    var perDay = [];
    for (var k = res.range.start; k <= res.range.end; k = addDays(k, 1)) {
      perDay.push({ key: k, n: mine.filter(function (x) { return x.key === k; }).length });
    }
    return {
      userNotes: mine.length,
      contextNotes: res.rows.length - mine.length,
      wosInScope: res.wos.length,
      wosTouched: res.wos.filter(function (w) { return w.userNoteCount > 0; }).length,
      wosOpenTasks: res.wos.filter(function (w) {
        return woOpenState(w.meta) !== false && w.tasks.some(function (t) { return !t.isComplete; });
      }).length,
      failed: res.wos.filter(function (w) { return w.error; }).length,
      perDay: perDay,
      perWO: res.wos.map(function (w) { return { wo: woLabel(w), number: w.number, n: w.userNoteCount || 0 }; })
    };
  }

  // ---- Excel ----------------------------------------------------------------------------------
  function fileName(res) {
    var last = String(res.user.lastName || String(res.user.displayName || '').trim().split(/\s+/).pop() || '').replace(/[^A-Za-z0-9-]/g, '');
    return 'NoteReport_' + (last || 'User') + '_' + res.range.start + '_to_' + res.range.end + '.xlsx';
  }
  function styleHeader(row) {
    row.eachCell(function (c) {
      c.font = { name: XL_FONT, bold: true, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1A5F3E' } };
      c.alignment = { vertical: 'middle' };
    });
  }
  function addTable(ws, columns, rows) {
    ws.columns = columns.map(function (c) { return { header: c[0], key: c[1], width: c[2] }; });
    styleHeader(ws.getRow(1));
    rows.forEach(function (r) { ws.addRow(r).font = { name: XL_FONT }; });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  }
  function woLink(label, number) { return { text: label, hyperlink: WO_URL + number + '/details' }; }
  function cellText(s) { return s.length > XL_CELL_MAX ? s.slice(0, XL_CELL_MAX - 40) + ' [truncated at Excel cell limit]' : s; }

  async function exportXlsx(res) {
    var ExcelJS = window.ExcelJS;
    if (!ExcelJS) throw new Error('ExcelJS did not load');
    var sum = summarize(res), today = todayKey();
    var wb = new ExcelJS.Workbook();
    wb.creator = 'BWN Coordinator Note Report';
    wb.created = new Date();

    var ws = wb.addWorksheet('Summary');
    ws.columns = [{ width: 34 }, { width: 60 }];
    var kv = function (k, v) { var row = ws.addRow([k, v]); row.font = { name: XL_FONT }; row.getCell(1).font = { name: XL_FONT, bold: true }; };
    var section = function (a, b) { ws.addRow([]); styleHeader(ws.addRow([a, b])); };
    styleHeader(ws.addRow(['Coordinator Note Report', '']));
    kv('User', res.user.displayName);
    kv('Range (ET)', res.range.start + ' to ' + res.range.end);
    kv('Generated (ET)', etStampFmt.format(new Date(res.generated)));
    if (res.cancelled) kv('Status', 'Cancelled before completion - partial results');
    kv('Notes by user', sum.userNotes);
    if (sum.contextNotes) kv('Context notes by others', sum.contextNotes);
    kv('Work orders in scope', sum.wosInScope);
    kv('Work orders touched (user notes)', sum.wosTouched);
    kv('Work orders with open tasks', sum.wosOpenTasks);
    kv('Tasks assigned (all time)', res.taskTotal);
    kv('Tasks in scope', res.tasks.length);
    kv('Work orders failed', sum.failed);
    section('Notes per day', 'Count');
    sum.perDay.forEach(function (d) { kv(d.key, d.n); });
    section('Notes per work order', 'Count');
    sum.perWO.forEach(function (w) { var row = ws.addRow([woLink(w.wo, w.number), w.n]); row.font = { name: XL_FONT }; });
    section('Flags', 'Detail');
    if (!res.flags.length) kv('None', '');
    res.flags.forEach(function (f) { kv(f.kind, f.wo + ' - ' + f.detail + (f.dates ? ' (' + f.dates + ')' : '')); });

    var wn = wb.addWorksheet('Notes');
    addTable(wn, [['WO #', 'wo', 14], ['Location #', 'loc', 12], ['Client', 'client', 24], ['WO Status', 'status', 18],
      ['Assigned Coordinator', 'coord', 22], ['Date (ET)', 'date', 12], ['Time (ET)', 'time', 10], ['Note Type', 'type', 10],
      ['Note', 'note', 90], ['Author', 'author', 22]], []);
    res.rows.forEach(function (x) {
      var m = x.meta || {};
      var row = wn.addRow({ wo: woLink(x.wo, x.number), loc: m.locationNumber || '', client: m.clientName || '', status: m.statusName || '',
        coord: m.assignedToMemberName || '', date: x.key, time: x.time, type: x.type, note: cellText(x.content), author: x.author });
      row.font = x.mine ? { name: XL_FONT } : { name: XL_FONT, italic: true, color: { argb: 'FF808080' } };
      if (!x.mine) row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF2F2F2' } };
      row.alignment = { vertical: 'top' };
      row.getCell('note').alignment = { wrapText: true, vertical: 'top' };
    });

    var wt = wb.addWorksheet('Tasks');
    addTable(wt, [['WO #', 'wo', 14], ['Description', 'desc', 60], ['Created', 'created', 12], ['Target', 'target', 12],
      ['Completed', 'completed', 12], ['Status', 'status', 10], ['Days Open', 'days', 10]],
      res.tasks.slice().sort(function (a, b) { return Number(a.entityId) - Number(b.entityId); }).map(function (t) {
        var c = tsKey(t.createdDate), d = tsKey(t.completionDate);
        return { wo: woLink(t.formattedJobNumber || ('W-' + t.entityId), Number(t.entityId)), desc: t.description || '', created: c || '',
          target: calendarKey(t.targetStartDate) || '', completed: d || '', status: t.isComplete ? 'Done' : 'Open',
          days: c ? daysBetween(c, (t.isComplete && d) || today) : '' };
      }));
    wt.getColumn('desc').alignment = { wrapText: true, vertical: 'top' };

    var wf = wb.addWorksheet('Flags');
    addTable(wf, [['Flag', 'kind', 26], ['WO #', 'wo', 14], ['Detail', 'detail', 60], ['Date(s)', 'dates', 26]],
      res.flags.map(function (f) { return { kind: f.kind, wo: f.number ? woLink(f.wo, f.number) : f.wo, detail: f.detail, dates: f.dates }; }));

    var buf = await wb.xlsx.writeBuffer();
    var url = URL.createObjectURL(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    var a = document.createElement('a');
    a.href = url;
    a.download = fileName(res);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
  }

  // Test hook for offline checks (Tampermonkey has no `module`, so this never fires in the browser).
  if (typeof module === 'object' && module && module.exports) {
    module.exports = { QUERIES: QUERIES, ALLOWED_OPS: ALLOWED_OPS, checkDocument: checkDocument, classify: classify, parseTs: parseTs,
      etKey: etKey, calendarKey: calendarKey, addDays: addDays, taskInScope: taskInScope, noteGaps: noteGaps, fileName: fileName,
      retryDelay: retryDelay, woOpenState: woOpenState, buildFlags: buildFlags, summarize: summarize };
    return;
  }

  // ---- UI -------------------------------------------------------------------------------------
  var CSS = [
    '#bwn-nr-launch{position:fixed;right:24px;bottom:24px;z-index:2147483000;font:600 13px "DM Sans",system-ui,sans-serif;color:#fff;',
    'background:linear-gradient(135deg,#1a5f3e,#0d3d26);border:0;border-radius:22px;padding:10px 16px;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer}',
    '#bwn-nr-launch:hover{box-shadow:0 0 0 2px #2ECC71,0 4px 14px rgba(0,0,0,.25)}',
    '.bwn-nr-overlay{position:fixed;inset:0;z-index:2147483001;background:rgba(13,61,38,.35);display:flex;align-items:flex-start;justify-content:center;padding:4vh 16px}',
    // `display:` above beats the [hidden] attribute, so hiding must be restated or Close/Esc do nothing.
    '.bwn-nr-overlay[hidden],.bwn-nr-modal [hidden],#bwn-nr-launch[hidden]{display:none!important}',
    '.bwn-nr-modal{box-sizing:border-box;width:min(1100px,100%);max-height:92vh;overflow:auto;background:#f0f4f8;border-radius:10px;',
    'box-shadow:0 12px 40px rgba(0,0,0,.3);font:14px/1.45 "DM Sans",system-ui,sans-serif;color:#1d2b24;text-align:left}',
    '.bwn-nr-modal *,.bwn-nr-modal *::before,.bwn-nr-modal *::after{box-sizing:border-box;font-family:inherit}',
    '.bwn-nr-head{position:sticky;top:0;z-index:2;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 18px;',
    'background:linear-gradient(135deg,#1a5f3e,#0d3d26);color:#fff;border-bottom:3px solid #2ECC71}',
    '.bwn-nr-title{margin:0;font-size:17px;font-weight:700;text-align:right;color:#fff}',
    '.bwn-nr-body{padding:16px 18px}',
    '.bwn-nr-form{display:grid;grid-template-columns:2fr 1fr 1fr;gap:12px;align-items:end}',
    '.bwn-nr-field{display:flex;flex-direction:column;gap:4px;position:relative}',
    '.bwn-nr-label{font-size:12px;font-weight:600;color:#1a5f3e}',
    '.bwn-nr-input{height:36px;padding:6px 10px;border:1px solid #b9c6bf;border-radius:6px;background:#fff;color:#1d2b24;font-size:14px}',
    '.bwn-nr-list{position:absolute;top:100%;left:0;right:0;z-index:3;margin:2px 0 0;padding:4px 0;list-style:none;background:#fff;border:1px solid #b9c6bf;',
    'border-radius:6px;box-shadow:0 6px 18px rgba(0,0,0,.15);max-height:240px;overflow:auto}',
    '.bwn-nr-opt{padding:6px 10px;cursor:pointer}',
    '.bwn-nr-opt[aria-selected="true"],.bwn-nr-opt:hover{background:#e3f6ec}',
    '.bwn-nr-checks{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:8px 24px}',
    '.bwn-nr-check{display:flex;gap:8px;align-items:center;font-size:13px}',
    '.bwn-nr-actions{grid-column:1/-1;display:flex;gap:10px}',
    '.bwn-nr-btn{height:36px;padding:0 16px;border-radius:6px;border:1px solid #1a5f3e;background:#fff;color:#1a5f3e;font-weight:600;font-size:14px;cursor:pointer}',
    '.bwn-nr-btn-primary{background:#1a5f3e;color:#fff}',
    '.bwn-nr-btn-ghost{border-color:rgba(255,255,255,.6);background:transparent;color:#fff}',
    '.bwn-nr-btn:disabled{opacity:.45;cursor:not-allowed}',
    '.bwn-nr-modal :focus-visible,#bwn-nr-launch:focus-visible{outline:3px solid #2ECC71;outline-offset:2px}',
    '.bwn-nr-status{margin:12px 0 0;min-height:20px;font-family:"DM Mono",ui-monospace,monospace;font-size:13px;color:#1a5f3e}',
    '.bwn-nr-error{margin:10px 0 0;padding:8px 12px;border-radius:6px;background:#fdecea;color:#8a1c12;border:1px solid #f3b8b1}',
    '.bwn-nr-summary{margin:14px 0 6px;padding:10px 12px;border-radius:6px;background:#fff;border-left:4px solid #2ECC71}',
    '.bwn-nr-fails{margin:8px 0;padding:8px 12px;border-radius:6px;background:#fff7e6;border:1px solid #f0d19a;font-size:13px}',
    '.bwn-nr-table{width:100%;border-collapse:collapse;background:#fff;font-size:13px}',
    '.bwn-nr-table th{position:sticky;top:0;background:#e3ebe7;text-align:left;padding:0;border-bottom:2px solid #1a5f3e}',
    '.bwn-nr-sort{width:100%;padding:8px;border:0;background:transparent;text-align:left;font-weight:700;color:#1a5f3e;cursor:pointer;font-size:13px}',
    '.bwn-nr-table td{padding:6px 8px;border-bottom:1px solid #e3e8e5;vertical-align:top}',
    '.bwn-nr-mono{font-family:"DM Mono",ui-monospace,monospace;white-space:nowrap}',
    '.bwn-nr-muted td{color:#7b8781;font-style:italic;background:#f7f8f8}',
    '.bwn-nr-note{max-width:520px;white-space:pre-wrap;word-break:break-word}',
    '.bwn-nr-wo{color:#1a5f3e;font-weight:600}',
    '@media (max-width:720px){.bwn-nr-form{grid-template-columns:1fr}}'
  ].join('');

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (k === 'text') el.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] === true) el.setAttribute(k, '');
      else if (attrs[k] !== false && attrs[k] != null) el.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }

  var state = { user: null, result: null, run: null, sortKey: 'wo', sortDir: 1, lastFocus: null };
  var ui = {};

  // ---- Launcher: a row in the BWN Suite dock (bwn:dock:* host in bwn-suite-core) -------------
  // Same handshake as bwn-inventory / bwn-dispatch. The floating button is only a fallback for a
  // browser without Core: it appears if no dock host announces within DOCK_WAIT_MS, and goes away
  // as soon as one does.
  var DOCK_KEY = 'note-report';
  var DOCK_WAIT_MS = 4000;
  var dockHostSeen = false;
  function bus(detail) {
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: detail })); } catch (e) { /* no bus */ }
  }
  function dockRegister() {
    bus({ id: 'bwn:dock:register', key: DOCK_KEY, label: 'Note Report', icon: '📝', weight: 40,
      title: "A coordinator's note activity over a date range, with Excel export" });
  }

  function buildUI() {
    if (document.getElementById('bwn-nr-launch')) return;
    document.head.appendChild(h('style', { id: 'bwn-nr-style', text: CSS }));
    ui.launch = h('button', { id: 'bwn-nr-launch', type: 'button', 'aria-haspopup': 'dialog', text: 'Note Report', hidden: true, onclick: openModal });
    document.body.appendChild(ui.launch);
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (!d) return;
      if (d.id === 'bwn:dock:host' || d.id === 'bwn:dock:ping') { dockHostSeen = true; ui.launch.hidden = true; dockRegister(); }
      if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY) openModal();
      if (d.id === 'bwn:drawer:open' && d.key !== DOCK_KEY) closeModal();   // another tool took the slot
    });
    dockRegister();                                  // a host already up picks this up immediately
    setTimeout(function () { if (!dockHostSeen) ui.launch.hidden = false; }, DOCK_WAIT_MS);
    document.addEventListener('keydown', function (e) {  // Esc works even when focus left the modal
      if (e.key === 'Escape' && ui.overlay && !ui.overlay.hidden && !ui.modal.contains(e.target)) closeModal();
    });
  }

  function openModal() {
    bus({ id: 'bwn:drawer:open', key: DOCK_KEY });
    if (ui.overlay) { ui.overlay.hidden = false; state.lastFocus = document.activeElement; ui.userInput.focus(); return; }
    state.lastFocus = document.activeElement;
    var r = defaultRange();
    ui.userInput = h('input', { id: 'bwn-nr-user', class: 'bwn-nr-input', type: 'text', autocomplete: 'off', role: 'combobox',
      'aria-autocomplete': 'list', 'aria-expanded': 'false', 'aria-controls': 'bwn-nr-userlist', placeholder: 'Type 2+ letters of a name' });
    ui.userList = h('ul', { id: 'bwn-nr-userlist', class: 'bwn-nr-list', role: 'listbox', hidden: true });
    ui.start = h('input', { id: 'bwn-nr-start', class: 'bwn-nr-input bwn-nr-mono', type: 'date', value: r.start });
    ui.end = h('input', { id: 'bwn-nr-end', class: 'bwn-nr-input bwn-nr-mono', type: 'date', value: r.end });
    ui.coord = h('input', { id: 'bwn-nr-coord', type: 'checkbox', checked: true });
    ui.others = h('input', { id: 'bwn-nr-others', type: 'checkbox' });
    ui.runBtn = h('button', { type: 'button', class: 'bwn-nr-btn bwn-nr-btn-primary', text: 'Run', onclick: onRun });
    ui.cancelBtn = h('button', { type: 'button', class: 'bwn-nr-btn', text: 'Cancel run', disabled: true, onclick: onCancel });
    ui.exportBtn = h('button', { type: 'button', class: 'bwn-nr-btn', text: 'Export', disabled: true, onclick: onExport });
    ui.status = h('p', { class: 'bwn-nr-status', role: 'status', 'aria-live': 'polite' });
    ui.error = h('div', { class: 'bwn-nr-error', role: 'alert', hidden: true });
    ui.results = h('div', { class: 'bwn-nr-results' });
    ui.closeBtn = h('button', { type: 'button', class: 'bwn-nr-btn bwn-nr-btn-ghost', text: 'Close', 'aria-label': 'Close note report', onclick: closeModal });

    ui.modal = h('div', { class: 'bwn-nr-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'bwn-nr-title' }, [
      h('div', { class: 'bwn-nr-head' }, [ui.closeBtn, h('h2', { id: 'bwn-nr-title', class: 'bwn-nr-title', text: 'Coordinator Note Report' })]),
      h('div', { class: 'bwn-nr-body' }, [
        h('div', { class: 'bwn-nr-form' }, [
          h('div', { class: 'bwn-nr-field' }, [h('label', { class: 'bwn-nr-label', for: 'bwn-nr-user', text: 'User' }), ui.userInput, ui.userList]),
          h('div', { class: 'bwn-nr-field' }, [h('label', { class: 'bwn-nr-label', for: 'bwn-nr-start', text: 'Start date (ET)' }), ui.start]),
          h('div', { class: 'bwn-nr-field' }, [h('label', { class: 'bwn-nr-label', for: 'bwn-nr-end', text: 'End date (ET)' }), ui.end]),
          h('div', { class: 'bwn-nr-checks' }, [
            h('label', { class: 'bwn-nr-check', for: 'bwn-nr-coord' }, [ui.coord, 'Also include WOs where the user is the assigned coordinator and LastNoteDate is in range.']),
            h('label', { class: 'bwn-nr-check', for: 'bwn-nr-others' }, [ui.others, 'Include notes by others.'])
          ]),
          h('div', { class: 'bwn-nr-actions' }, [ui.runBtn, ui.cancelBtn, ui.exportBtn])
        ]),
        ui.status, ui.error, ui.results
      ])
    ]);
    ui.overlay = h('div', { class: 'bwn-nr-overlay', onmousedown: function (e) { if (e.target === ui.overlay) closeModal(); } }, [ui.modal]);
    ui.modal.addEventListener('keydown', onModalKey);
    wireTypeahead();
    document.body.appendChild(ui.overlay);
    ui.userInput.focus();
  }

  function closeModal() {
    if (!ui.overlay) return;
    ui.overlay.hidden = true;
    if (state.lastFocus && state.lastFocus.focus) state.lastFocus.focus();
  }

  function onModalKey(e) {
    if (e.key === 'Escape') {
      if (!ui.userList.hidden) { hideList(); e.stopPropagation(); return; }
      closeModal();
      return;
    }
    if (e.key !== 'Tab') return;
    var f = Array.prototype.filter.call(ui.modal.querySelectorAll('button,input,[tabindex]:not([tabindex="-1"])'), function (el) {
      return !el.disabled && !el.hidden && el.offsetParent !== null;
    });
    if (!f.length) return;
    if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length - 1].focus(); }
    else if (!e.shiftKey && document.activeElement === f[f.length - 1]) { e.preventDefault(); f[0].focus(); }
  }

  // ---- Typeahead ------------------------------------------------------------------------------
  var ta = { timer: null, seq: 0, items: [], active: -1, run: { cancelled: false } };
  function wireTypeahead() {
    ui.userInput.addEventListener('input', function () {
      state.user = null;
      clearTimeout(ta.timer);
      var q = ui.userInput.value.trim();
      if (q.length < 2) { hideList(); return; }
      ta.timer = setTimeout(function () { searchUsers(q); }, 300);
    });
    ui.userInput.addEventListener('keydown', function (e) {
      if (ui.userList.hidden || !ta.items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        ta.active = (ta.active + (e.key === 'ArrowDown' ? 1 : -1) + ta.items.length) % ta.items.length;
        paintList();
      } else if (e.key === 'Enter' && ta.active >= 0) {
        e.preventDefault();
        pickUser(ta.items[ta.active]);
      }
    });
    ui.userInput.addEventListener('blur', function () { setTimeout(hideList, 150); });
  }
  async function searchUsers(q) {
    var seq = ++ta.seq;
    try {
      var d = (await gql(ta.run, 'NrMemberSearch', { s: q, n: 15 })).searchMembers || {};
      if (seq !== ta.seq) return;
      ta.items = (d.items || []).filter(function (m) { return m.memberType === 'User'; });
      ta.active = ta.items.length ? 0 : -1;
      paintList();
    } catch (e) {
      if (seq !== ta.seq) return;
      ta.run = { cancelled: false };
      showError(e.nrCategory === 'AUTH' ? authMessage() : 'User search failed (' + (e.nrCategory || 'ERROR') + ').');
    }
  }
  function paintList() {
    ui.userList.textContent = '';
    if (!ta.items.length) {
      ui.userList.appendChild(h('li', { class: 'bwn-nr-opt', role: 'option', 'aria-disabled': 'true', text: 'No matching users' }));
    }
    ta.items.forEach(function (m, i) {
      ui.userList.appendChild(h('li', { id: 'bwn-nr-opt-' + i, class: 'bwn-nr-opt', role: 'option', 'aria-selected': String(i === ta.active),
        text: m.displayName + (m.isInactive ? ' (inactive)' : ''), onmousedown: function (e) { e.preventDefault(); pickUser(m); } }));
    });
    ui.userList.hidden = false;
    ui.userInput.setAttribute('aria-expanded', 'true');
    if (ta.active >= 0) ui.userInput.setAttribute('aria-activedescendant', 'bwn-nr-opt-' + ta.active);
    else ui.userInput.removeAttribute('aria-activedescendant');
  }
  function hideList() {
    ui.userList.hidden = true;
    ui.userInput.setAttribute('aria-expanded', 'false');
    ui.userInput.removeAttribute('aria-activedescendant');
  }
  function pickUser(m) {
    state.user = { id: m.id, displayName: m.displayName, lastName: m.lastName || '' };
    ui.userInput.value = m.displayName;
    hideList();
  }

  // ---- Run / cancel / export ------------------------------------------------------------------
  function authMessage() { return 'Your Umbrava session has expired or you are signed out. Refresh the page or sign in to Umbrava, then run again.'; }
  function showError(msg) { ui.error.textContent = msg; ui.error.hidden = !msg; }
  function setRunning(on) {
    [ui.runBtn, ui.exportBtn, ui.userInput, ui.start, ui.end, ui.coord, ui.others].forEach(function (el) { el.disabled = on; });
    ui.cancelBtn.disabled = !on;
    if (!on) ui.exportBtn.disabled = !state.result;
  }

  async function onRun() {
    showError('');
    if (!state.user) { showError('Pick a user from the search list first.'); ui.userInput.focus(); return; }
    var range = { start: ui.start.value, end: ui.end.value };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(range.start) || !/^\d{4}-\d{2}-\d{2}$/.test(range.end) || range.start > range.end) {
      showError('Enter a valid start and end date (start on or before end).');
      return;
    }
    state.result = null;
    ui.results.textContent = '';
    state.run = { cancelled: false };
    setRunning(true);
    try {
      state.result = await runReport(state.run, { user: state.user, range: range, coord: ui.coord.checked, others: ui.others.checked },
        function (msg) { ui.status.textContent = msg; });
      ui.status.textContent = state.result.cancelled ? 'Cancelled - showing partial results.' : 'Done.';
      renderResults();
    } catch (e) {
      state.result = null;
      ui.status.textContent = '';
      if (e.nrCategory === 'AUTH') showError(authMessage());
      else if (e.nrCategory === 'CANCELLED') ui.status.textContent = 'Cancelled.';
      else showError('Run failed (' + (e.nrCategory || 'ERROR') + '). ' + (e.nrCategory === 'QUERY_ERROR' ? 'Umbrava rejected a request shape; nothing was changed.' : ''));
    } finally {
      state.run = null;
      setRunning(false);
    }
  }
  function onCancel() { if (state.run) { state.run.cancelled = true; ui.status.textContent = 'Cancelling - finishing requests already in flight…'; } }
  async function onExport() {
    if (!state.result) return;
    ui.exportBtn.disabled = true;
    try { await exportXlsx(state.result); ui.status.textContent = 'Exported ' + fileName(state.result) + '.'; }
    catch (e) { showError('Export failed: ' + (e && e.message === 'ExcelJS did not load' ? 'the Excel library did not load.' : 'unexpected error.')); }
    finally { ui.exportBtn.disabled = !state.result; }
  }

  var COLS = [
    ['wo', 'WO #', function (x) { return x.number; }],
    ['date', 'Date (ET)', function (x) { return x.ms; }],
    ['time', 'Time (ET)', function (x) { return x.minutes; }],
    ['author', 'Author', function (x) { return x.author.toLowerCase(); }],
    ['type', 'Type', function (x) { return Number(x.type) || 0; }],
    ['client', 'Client', function (x) { return String((x.meta && x.meta.clientName) || '').toLowerCase(); }],
    ['note', 'Note', function (x) { return x.content.toLowerCase(); }]
  ];

  function renderResults() {
    var res = state.result, sum = summarize(res);
    ui.results.textContent = '';
    var perDay = sum.perDay.map(function (d) { return prettyDate(d.key) + ': ' + d.n; }).join(' · ');
    ui.results.appendChild(h('div', { class: 'bwn-nr-summary' }, [
      h('strong', { text: sum.userNotes + ' notes' }), ' by ' + res.user.displayName + ' · ' + sum.wosTouched + ' of ' + sum.wosInScope +
        ' WOs touched · ' + res.tasks.length + ' tasks in scope · ' + res.flags.length + ' flags',
      h('div', { class: 'bwn-nr-mono', text: 'Per day: ' + perDay })
    ]));
    var failed = res.wos.filter(function (w) { return w.error || w.detailError; });
    if (failed.length) {
      ui.results.appendChild(h('div', { class: 'bwn-nr-fails', role: 'note' }, [
        h('strong', { text: failed.length + ' work order(s) incomplete: ' }),
        failed.map(function (w) { return woLabel(w) + ' (' + (w.error ? 'notes ' + w.error : 'details ' + w.detailError) + ')'; }).join(', ')
      ]));
    }
    var col = COLS.filter(function (c) { return c[0] === state.sortKey; })[0] || COLS[0];
    var rows = res.rows.slice().sort(function (a, b) {
      var x = col[2](a), y = col[2](b);
      return (x < y ? -1 : x > y ? 1 : a.number - b.number || a.ms - b.ms) * state.sortDir;
    });
    var head = h('tr', {}, COLS.map(function (c) {
      var sorted = c[0] === state.sortKey;
      return h('th', { scope: 'col', 'aria-sort': sorted ? (state.sortDir > 0 ? 'ascending' : 'descending') : 'none' }, [
        h('button', { type: 'button', class: 'bwn-nr-sort', text: c[1] + (sorted ? (state.sortDir > 0 ? ' ▲' : ' ▼') : ''),
          onclick: function () { state.sortDir = sorted ? -state.sortDir : 1; state.sortKey = c[0]; renderResults(); } })
      ]);
    }));
    var body = h('tbody', {}, rows.map(function (x) {
      var note = x.content.length > 400 ? x.content.slice(0, 400) + '…' : x.content;
      return h('tr', { class: x.mine ? '' : 'bwn-nr-muted' }, [
        h('td', { class: 'bwn-nr-mono' }, [h('a', { class: 'bwn-nr-wo', href: WO_URL + x.number + '/details', target: '_blank', rel: 'noopener', text: x.wo })]),
        h('td', { class: 'bwn-nr-mono', text: x.key }),
        h('td', { class: 'bwn-nr-mono', text: x.time }),
        h('td', { text: x.author }),
        h('td', { class: 'bwn-nr-mono', text: String(x.type == null ? '' : x.type) }),
        h('td', { text: (x.meta && x.meta.clientName) || '' }),
        h('td', { class: 'bwn-nr-note', title: x.content.length > 400 ? 'Full text is in the export' : null, text: note })
      ]);
    }));
    ui.results.appendChild(rows.length
      ? h('table', { class: 'bwn-nr-table' }, [h('caption', { class: 'bwn-nr-label', text: 'Notes in range (select a column header to sort)' }), h('thead', {}, [head]), body])
      : h('p', { text: 'No notes in range for the selected options.' }));
  }

  if (document.body) buildUI();
  else document.addEventListener('DOMContentLoaded', buildUI);
})();
