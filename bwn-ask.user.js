// ==UserScript==
// @name         BWN Ask (Coordinator Copilot)
// @namespace    https://broadwaynational.com/bwn
// @version      0.7.6
// @description  Ask questions about the work order you're viewing. Reads the WO live from Umbrava via same-origin GraphQL (details + full note / site-visit history) AND a summary roster of the other work orders at the same location, plus the team knowledge doc, and answers through the Broadway AI proxy with dates and references. Phase 1.5 = page-scoped + location roster (Path A); no data leaves the trusted Broadway path.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      green-stone-0717dab0f.7.azurestaticapps.net
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-ask.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-ask.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---- Config ---------------------------------------------------------------
  var SWA_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
  // /api/ai, not /api/ask. The older route runs ONE plain Messages call with no tools by design
  // ("Cross-location search (tools/MCP) is Phase 2" in its own header), so it can never read the
  // screen. /api/ai already owns the tested tool loop, so this UI moved rather than growing a
  // second one. ASK_URL is kept only so a rollback is a one-line change.
  var ASK_URL = SWA_BASE + '/api/ask';
  var AI_URL = SWA_BASE + '/api/ai';
  var ROLE_TTL_MS = 6 * 3600 * 1000;

  // Context budget. The server caps at ~120k chars; stay under it so the notes
  // history can't get truncated mid-record.
  var CTX_TOTAL_MAX = 100000;

  // ---- Umbrava token (content-picked, mirrors bwn-suite-ai authToken) --------
  // ===== BWN-SHARED START v1 (paste-identical; pinned by scripts/test-shared-block-ledger.js) =====
  function isUmbravaToken(tok) {
    try {
      var p = JSON.parse(atob(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      var iss = String(p.iss || '').replace(/\/+$/, '');
      if (iss !== 'https://login.umbrava.com' && iss !== 'https://umbrava.us.auth0.com') return false;
      return !(typeof p.exp === 'number' && (Date.now() / 1000) > p.exp);
    } catch (e) { return false; }
  }
  function authToken() {
    try {
      var keys = Object.keys(localStorage).filter(function (x) {
        return /@@auth0spajs@@::.*::https:\/\/app\.umbrava\.com\/api::/.test(x);
      });
      for (var i = 0; i < keys.length; i++) {
        var body = (JSON.parse(localStorage.getItem(keys[i])) || {}).body;
        var tok = (body && body.access_token) || '';
        if (tok && isUmbravaToken(tok)) return tok;
      }
      return '';
    } catch (e) { return ''; }
  }
  // ===== BWN-SHARED END v1 =====

  // ---- Rank read (grant-none-safe, mirrors bwnEscRank) -----------------------
  // UX only - the server is the real gate. Default floor is staff, so the panel
  // shows for everyone; kept here in case BWN_ASK_MIN_RANK is ever raised.
  var _liveRank = null;
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:role' && typeof d.rank === 'number') _liveRank = d.rank;
    });
  } catch (e) { }
  function rank() {
    if (typeof _liveRank === 'number') return _liveRank;
    try {
      var r = JSON.parse(localStorage.getItem('bwn:role:last') || 'null');
      if (r && r.ok && typeof r.rank === 'number' && r.ts && (Date.now() - r.ts) < ROLE_TTL_MS) return r.rank;
    } catch (e2) { }
    return null;
  }

  // ---- Same-origin GraphQL (mirrors bwn-suite-ai / bwn-wo-audit gql) ----------
  // The page's own Umbrava bearer, passed explicitly, so this works from the grant
  // sandbox (a passive fetch/XHR hook does NOT - the sandbox's window.fetch is not the
  // page's, which is why capture was pulling nothing). app.umbrava.com is same-origin,
  // so no @connect is needed for these reads.
  function gql(query, variables) {
    var tok = authToken();
    return fetch('/api/graphql', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
        return j && j.data;
      });
  }

  function stripHtml(s) {
    var t = String(s == null ? '' : s);
    if (/[<&]/.test(t)) {
      t = t.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '');
      t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
    }
    return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function ts(d) { var n = Date.parse(d); return isNaN(n) ? 0 : n; }
  function fmtDate(d) { var n = Date.parse(d); if (isNaN(n)) return String(d || ''); try { return new Date(n).toLocaleString(); } catch (e) { return String(d); } }
  // Anchored to a path segment so a substring route (e.g. /client-work-orders/<id> or a
  // nested /work-orders/<year>/<n>) can't capture the wrong number.
  function woNumberFromUrl() { var m = location.pathname.match(/(?:^|\/)work-orders\/(\d+)(?:\/|$|\?|#)/); return m ? parseInt(m[1], 10) : null; }

  // Proven selectors. CORE + notes are CONFIRMED against live Umbrava (bwn-wo-audit
  // v0.3.0 / bwn-suite-ai woToJob). Notes come from the ROOT jobNotes(workOrderNumber)
  // field - the older workOrderNotes(workOrderId) does NOT exist. Each group is its OWN
  // query so one drifted/unproven selector nulls only that group (GraphQL fails the WHOLE
  // operation on any bad selection). statusName is isolated from the unproven priority-date
  // fields ON PURPOSE - it is the most load-bearing field for a "what next" answer, so a
  // drifted date selector must not be able to take it down with it.
  var CORE_Q =
    'query($n:Int!){ workOrder(workOrderNumber:$n){ ' +
    '  number trackingNumber scopeOfWork serviceInstructions locationId locationName ' +
    '  address{ addressLine1 city state postalCode } trades{ id name } priority{ label } doNotExceed{ amount } ' +
    '} }';
  var STATUS_Q = 'query($n:Int!){ workOrder(workOrderNumber:$n){ statusName } }';
  var DATES_Q = 'query($n:Int!){ workOrder(workOrderNumber:$n){ creationDate workOrderDate priority{ expectedCompletionDate firstTripDate } } }';
  var COORD_Q = 'query($n:Int!){ workOrder(workOrderNumber:$n){ assignedToMemberName vendorNames } }';
  var NOTES_Q =
    'query($n:Int!){ jobNotes(workOrderNumber:$n, includeDeleted:false){ id type content contentHtml createdDate isPinned isCompletion workOrderNoteSource createdBy { firstName lastName } } }';

  // ---- Location-wide WO roster (Phase 1.5) ----------------------------------
  /* ===== BWN-ASK-ROSTER:START ===== */
  // Fetch a compact roster of the OTHER work orders at this WO's location so the copilot can
  // answer "any other open WOs at this site?" without guessing. Uses the PINNED board op
  // PagedWorkOrders / listWorkOrdersPaginated, captured off the wire 2026-08-13 and already
  // replayed by Core's List-Heat scan (wiki/umbrava-graphql-operations.md). TWO args are REQUIRED
  // and non-null - page:PageInput! and sortBy:[SortInput!]! - and dropping EITHER 400s. That 400 is
  // exactly why the previous roster (introspection-discovered field, location arg ONLY, no page /
  // sortBy) came back "unavailable: site-roster" in production. locationId:ID is the server-side
  // filter; page + sortBy are sent as VARIABLES with the same proven shapes Core replays, never
  // inlined (direction may be an enum, unsafe as a quoted literal). Best-effort and isolated: any
  // miss leaves the per-WO answer intact and the roster simply marked unavailable, never
  // fabricated. Cached per location for the session so it runs at most once/location.
  var _locRoster = {};       // locationId -> { ok, wos:[...], total } | { ok:false }
  var ROSTER_MAX = 40, ROSTER_TAKE = 200;
  // Only fields PROVEN on the LIST item type (which is NOT WorkOrder - see the wiki unit traps):
  // number, statusName, priority.label, trades.name, workOrderDate. There is NO creationDate on
  // this type, so the old selection that asked for it would have 400'd even had discovery run.
  var ROSTER_Q =
    'query($page:PageInput!, $sortBy:[SortInput!]!, $loc:ID){' +
    ' listWorkOrdersPaginated(page:$page, sortBy:$sortBy, locationId:$loc){' +
    ' rowCount items{ number statusName priority{ label } trades{ name } workOrderDate } } }';
  // page is the OBJECT {skip,take}, never a scalar; sortBy is non-empty (dropping it 400s). Both
  // shapes are the ones Core's proven replay sends.
  var ROSTER_VARS = { page: { skip: 0, take: ROSTER_TAKE }, sortBy: [{ columnName: 'formattedJobNumber', direction: 'DESC' }] };

  function fetchLocationRoster(locationId) {
    if (locationId == null) return Promise.resolve({ ok: false });
    var key = String(locationId);
    if (_locRoster[key]) return Promise.resolve(_locRoster[key]);
    var vars = { page: ROSTER_VARS.page, sortBy: ROSTER_VARS.sortBy, loc: locationId };
    return gql(ROSTER_Q, vars).then(function (d) {
      var root = d && d.listWorkOrdersPaginated;
      var arr = (root && Array.isArray(root.items)) ? root.items.filter(Boolean) : [];
      _locRoster[key] = { ok: true, wos: arr, total: (root && typeof root.rowCount === 'number') ? root.rowCount : arr.length };
      return _locRoster[key];
    }, function () { _locRoster[key] = { ok: false }; return _locRoster[key]; });
  }
  /* ===== BWN-ASK-ROSTER:END ===== */

  // Run a query and DISTINGUISH failure from empty: { ok:true, wo } or { ok:false }.
  // A silent []/{} on error is how the copilot could turn a fetch failure into a confident
  // "this WO has no history" - the worst failure mode for a grounded tool, so never do it.
  function qWO(query, n) {
    return gql(query, { n: n }).then(function (d) { return { ok: true, wo: (d && d.workOrder) || null }; }, function () { return { ok: false }; });
  }
  function qNotes(n) {
    return gql(NOTES_Q, { n: n }).then(function (d) { return { ok: true, notes: (d && d.jobNotes) || [] }; }, function () { return { ok: false }; });
  }

  // Gather the RECORDS block by ACTIVELY querying the WO in view. Returns
  // { text, records, shown, omitted, wo, degraded, notesFailed, error? }.
  function gatherContext() {
    var n = woNumberFromUrl();
    if (!n) return Promise.resolve({ text: '', records: 0, error: 'Open a specific work order (a /work-orders/<number> page) so I can read it, then ask.' });

    return Promise.all([qWO(CORE_Q, n), qWO(STATUS_Q, n), qWO(DATES_Q, n), qWO(COORD_Q, n), qNotes(n)]).then(function (res) {
      var coreR = res[0], statusR = res[1], datesR = res[2], coordR = res[3], notesR = res[4];
      var wo = coreR.ok ? (coreR.wo || {}) : {};
      var stat = (statusR.ok && statusR.wo) ? statusR.wo : {};
      var dts = (datesR.ok && datesR.wo) ? datesR.wo : {};
      var coord = (coordR.ok && coordR.wo) ? coordR.wo : {};

      // Hard failures: don't answer blind.
      if (!coreR.ok && !notesR.ok) return { text: '', records: 0, error: 'I could not read work order ' + n + ' from Umbrava (the queries failed). Reload the page and try again.' };
      if (coreR.ok && !coreR.wo && !notesR.ok) return { text: '', records: 0, error: 'Work order ' + n + ' was not found in Umbrava. Check the number and try again.' };

      var degraded = [];
      var L = [];
      L.push('WORK ORDER #' + (wo.number || n) + (wo.trackingNumber ? ' (Tracking #' + wo.trackingNumber + ')' : ''));
      if (stat.statusName) L.push('Status: ' + stat.statusName); else if (!statusR.ok) degraded.push('status');
      if (wo.locationName || wo.locationId != null) L.push('Location: ' + (wo.locationName || '') + (wo.locationId != null ? ' (id ' + wo.locationId + ')' : ''));
      var addr = wo.address || null;
      if (addr) L.push('Address: ' + [addr.addressLine1, [addr.city, addr.state].filter(Boolean).join(', '), addr.postalCode].filter(Boolean).join(' '));
      if (wo.trades && wo.trades.length) L.push('Trade(s): ' + wo.trades.map(function (t) { return t && t.name; }).filter(Boolean).join(', '));
      if (wo.priority && wo.priority.label) L.push('Priority: ' + wo.priority.label);
      if (wo.doNotExceed && wo.doNotExceed.amount != null) L.push('NTE: $' + wo.doNotExceed.amount);
      if (coord.assignedToMemberName) L.push('Coordinator: ' + coord.assignedToMemberName);
      if (coord.vendorNames && coord.vendorNames.length) L.push('Vendor(s): ' + coord.vendorNames.join(', '));
      if (dts.workOrderDate || dts.creationDate) L.push('Created: ' + fmtDate(dts.workOrderDate || dts.creationDate));
      var pr = dts.priority || {};
      if (pr.firstTripDate) L.push('First trip: ' + fmtDate(pr.firstTripDate));
      if (pr.expectedCompletionDate) L.push('Expected completion: ' + fmtDate(pr.expectedCompletionDate));
      if (wo.scopeOfWork) L.push('Scope of work: ' + stripHtml(wo.scopeOfWork));
      if (wo.serviceInstructions) L.push('Service instructions: ' + stripHtml(wo.serviceInstructions));

      var parts = [];
      if (!coreR.ok) { parts.push('(WORK ORDER DETAILS UNAVAILABLE - the details query failed; only note history was read.)'); degraded.push('details'); }
      parts.push(L.join('\n'), '');

      // Fetch the location roster, prepend a roster-aware SCOPE line so the model knows
      // exactly what it has (full notes for THIS WO + a summary of sibling WOs, or single-WO
      // only when the roster is unavailable), append the "other WOs at this location" block,
      // and return. Roster is best-effort - a miss just marks the site read unavailable.
      function finalize(extra) {
        return fetchLocationRoster(wo.locationId).then(function (roster) {
          var body = parts.slice();
          var siteWOs = 0;
          if (roster && roster.ok) {
            var cur = String(wo.number || n);
            var list = (roster.wos || []).filter(function (w) { return w && String(w.number) !== cur; })
              .sort(function (a, b) { return ts(b && (b.workOrderDate || b.creationDate)) - ts(a && (a.workOrderDate || a.creationDate)); });
            siteWOs = list.length;
            if (!siteWOs) { body.push('', 'OTHER WORK ORDERS AT THIS LOCATION: none - this appears to be the only work order at this location.'); }
            else {
              var cap = Math.min(siteWOs, ROSTER_MAX);
              body.push('', 'OTHER WORK ORDERS AT THIS LOCATION (' + siteWOs + (siteWOs > ROSTER_MAX ? ', showing ' + ROSTER_MAX + ' most recent' : '') + ') - summary rows only, NOT full notes; open a WO for its notes:');
              for (var i = 0; i < cap; i++) {
                var w = list[i], tr = (w.trades || []).map(function (t) { return t && t.name; }).filter(Boolean).join('/');
                body.push('- WO #' + (w.number || '?') + ' | ' + (w.statusName || '?') + (w.priority && w.priority.label ? ' | ' + w.priority.label : '') + (tr ? ' | ' + tr : '') + ((w.workOrderDate || w.creationDate) ? ' | ' + fmtDate(w.workOrderDate || w.creationDate) : ''));
              }
            }
          } else {
            body.push('', 'OTHER WORK ORDERS AT THIS LOCATION: could not be read. Answer only about WO #' + (wo.number || n) + ' and say other work orders at the site could not be loaded.');
            degraded.push('site-roster');
          }
          var scope = (roster && roster.ok && siteWOs)
            ? 'SCOPE: You have the FULL notes/history for WO #' + (wo.number || n) + (wo.locationName ? ' at ' + wo.locationName : '') + ', PLUS a summary roster of ' + siteWOs + ' other work order(s) at this location (roster = status/trade/date only, NOT their notes). For detail on another WO the coordinator must open it. Do not invent notes for roster WOs.'
            : 'SCOPE: This is ONE work order (#' + (wo.number || n) + ')' + (wo.locationName ? ' at ' + wo.locationName : '') + '. ' + ((roster && roster.ok) ? 'It is the only work order at this location.' : 'Other work orders at this location could NOT be loaded - do not claim completeness across the site.');
          var text = scope + '\n\n' + body.join('\n');
          return Object.assign({ text: text, wo: wo.number || n, degraded: degraded, siteWOs: siteWOs, siteOk: !!(roster && roster.ok) }, extra);
        });
      }

      // Notes query FAILED (not merely empty): tell the model so it never denies history.
      if (!notesR.ok) {
        parts.push('NOTE / SITE-VISIT HISTORY for this WO: UNAVAILABLE - the notes query failed. Do NOT state whether this work order has notes or history; tell the user the history could not be read and to retry.');
        degraded.push('notes');
        return finalize({ records: 0, shown: 0, omitted: 0, notesFailed: true });
      }

      var notes = notesR.notes || [];
      var sorted = notes.slice().sort(function (a, b) { return ts(b && b.createdDate) - ts(a && a.createdDate); });
      var noteLines = [], shown = 0, omitted = 0;
      var used = parts.join('\n').length;
      for (var i = 0; i < sorted.length; i++) {
        var nt = sorted[i];
        var nbody = stripHtml(nt.content || nt.contentHtml || '');
        if (!nbody) continue;
        var who = nt.createdBy ? [nt.createdBy.firstName, nt.createdBy.lastName].filter(Boolean).join(' ') : '';
        var tags = [nt.type, nt.workOrderNoteSource, nt.isPinned ? 'pinned' : '', nt.isCompletion ? 'completion' : ''].filter(Boolean).join(', ');
        var block = '\n[' + fmtDate(nt.createdDate) + ']' + (who ? ' ' + who : '') + (tags ? ' (' + tags + ')' : '') + '\n' + nbody + '\n';
        if (used + block.length > CTX_TOTAL_MAX) { omitted = sorted.length - i; break; }
        noteLines.push(block); used += block.length; shown++;
      }
      parts.push('NOTES for THIS work order (newest first, ' + notes.length + ' total' +
        (omitted ? '; ' + shown + ' shown, ' + omitted + ' OLDEST omitted for size - say so if asked for the complete history' : '') + '):');
      if (!notes.length) parts.push('\n(no notes on this work order)');
      else parts = parts.concat(noteLines);
      return finalize({ records: notes.length, shown: shown, omitted: omitted });
    });
  }

  // ---- SWA call (mirrors cc-auth gmPost) ------------------------------------
  function gmPost(url, headers, bodyObj, timeoutMs) {
    return new Promise(function (resolve, reject) {
      try {
        GM_xmlhttpRequest({
          method: 'POST', url: url, headers: headers, data: JSON.stringify(bodyObj), timeout: timeoutMs || 60000,
          onload: function (r) { var j = null; try { j = JSON.parse(r.responseText); } catch (e) { } resolve({ status: r.status, json: j }); },
          onerror: function () { reject(new Error('network error')); },
          ontimeout: function () { reject(new Error('timed out')); }
        });
      } catch (e) { reject(e); }
    });
  }

  /* ===== BWN-ASK-DOMP:START =================================================================
   * The page tools, reached over the same bwn:cmd/bwn:evt bus bwn-suite-ai uses. This is a
   * SECOND copy of that client, and scripts/test-ask-tools.js asserts the three tool
   * DEFINITIONS stay byte-identical to suite-ai's - two copies whose descriptions drift teach
   * one model two different things about the same verbs ([[store-key-two-writers-drift]]).
   *
   * Why a copy at all: each userscript is its own Tampermonkey sandbox, so bwn-ask cannot call
   * a function inside bwn-suite-ai. document-level CustomEvents are the only channel that
   * crosses, which is exactly what the phase-4 bus is.
   * ======================================================================================== */

  var DOMP_TIMEOUT_MS = 4000;
  var dompRid = 0;

  // One request/response round over the bus. Never hangs: a matching rid, a bounded timeout, or
  // a named failure. An absent Core is reported BY NAME off its own status stamp rather than as
  // a mystery timeout, because "Core is not running" and "the page is slow" need different fixes.
  function dompSend(detail) {
    return new Promise(function (resolve) {
      var core = null;
      try { core = JSON.parse(localStorage.getItem('bwn:status:core') || 'null'); } catch (e) { }
      if (!core) {
        resolve({ ok: false, code: 'CORE_ABSENT', content: 'BWN Suite Core is not running on this page, so the screen cannot be read.' });
        return;
      }
      dompRid += 1;
      var rid = 'ask-' + dompRid + '-' + Date.now();
      var done = false, timer = null;
      function finish(res) {
        if (done) return;
        done = true;
        if (timer) clearTimeout(timer);
        document.removeEventListener('bwn:evt', onEvt);
        resolve(res);
      }
      function onEvt(e) {
        var d = e && e.detail;
        if (!d || d.id !== 'domp:result' || d.rid !== rid) return;   // someone else's round-trip
        finish(d.result || { ok: false, code: 'EMPTY_RESULT', content: 'the responder replied with nothing' });
      }
      // Listener BEFORE dispatch, always. The reply can arrive synchronously.
      document.addEventListener('bwn:evt', onEvt);
      timer = setTimeout(function () {
        finish({ ok: false, code: 'TIMEOUT', content: 'the page did not answer within ' + DOMP_TIMEOUT_MS + 'ms; it may be mid-navigation. Try page_snapshot once more.' });
      }, DOMP_TIMEOUT_MS);
      try {
        var out = { rid: rid };
        for (var k in detail) out[k] = detail[k];
        document.dispatchEvent(new CustomEvent('bwn:cmd', { detail: out }));
      } catch (err) {
        finish({ ok: false, code: 'DISPATCH_FAILED', content: String((err && err.message) || err) });
      }
    });
  }

  var pageToolCalls = 0;   // surfaced in the footer so the coordinator knows the screen was read

  var ASK_TOOLS = {
    page_snapshot: function (input) {
      pageToolCalls += 1;
      return dompSend({ id: 'domp:snapshot', since: (input && input.since) || null, includeInert: !!(input && input.includeInert) });
    },
    page_inspect: function (input) {
      if (!input || !input.handle) return Promise.resolve({ ok: false, content: 'page_inspect needs a handle from a page_snapshot, e.g. "@b3"' });
      pageToolCalls += 1;
      return dompSend({ id: 'domp:act', verb: 'inspect', handle: String(input.handle), revision: input.revision || null });
    },
    page_extract: function (input) {
      if (!input || !input.handle) return Promise.resolve({ ok: false, content: 'page_extract needs a handle from a page_snapshot, e.g. "@t1"' });
      pageToolCalls += 1;
      return dompSend({ id: 'domp:act', verb: 'extract', handle: String(input.handle), revision: input.revision || null });
    }
  };

  // ONLY the tools this script can actually execute. bwn-ask has no GraphQL tool executors -
  // it gathers the work-order context itself, up front - so advertising getWorkOrder here would
  // promise the model something that comes back "unknown tool" every time.
  var ASK_TOOL_DEFS = [
    { name: 'page_snapshot',
      description:
        'Read the page the coordinator is currently looking at, as a compact list of labelled handles ' +
        '(@b1 a button, @i2 a textbox, @a3 a link, @t4 a table, @m5 a message). Use this when the answer ' +
        'is on screen and no data tool covers it. READ-ONLY: there is no way to click, type, or submit ' +
        'anything - do not promise the coordinator you will. Handles are valid only for the `revision` ' +
        'they came from; re-snapshot after the page changes. If the reply carries `truncated` or ' +
        '`unexplored`, part of the page was NOT included - say so rather than concluding a control is absent.',
      input_schema: { type: 'object', properties: {
        since: { type: 'string', description: 'The revision from your previous page_snapshot, to get only what changed. Omit for a full snapshot.' },
        includeInert: { type: 'boolean', description: 'Also include controls that are present but not currently clickable. Default false.' }
      }, required: [] } },
    { name: 'page_inspect',
      description: 'Look at one handle from a page_snapshot in more detail: its accessible name, whether it is enabled, visible and clickable, and its value. A field the snapshot marked as masked stays masked here.',
      input_schema: { type: 'object', properties: {
        handle: { type: 'string', description: 'A handle from a page_snapshot, e.g. "@b3".' },
        revision: { type: 'string', description: 'The revision that handle came from.' }
      }, required: ['handle'] } },
    { name: 'page_extract',
      description: 'Read the full text behind one handle, or the rows of a table the snapshot only summarized as a shape. Use this after page_snapshot shows a table (@t1) whose contents you need.',
      input_schema: { type: 'object', properties: {
        handle: { type: 'string', description: 'A handle from a page_snapshot, e.g. "@t1".' },
        revision: { type: 'string', description: 'The revision that handle came from.' }
      }, required: ['handle'] } }
  ];
  /* ===== BWN-ASK-DOMP:END ================================================================== */

  var ASK_MIN_TOOL_ROUNDS = 6;
  var ASK_MAX_CALLS_PER_ROUND = 8;

  function askExecTool(call) {
    var id = (call && call.id) || '';
    var name = call && call.name;
    var input = (call && call.input) || {};
    var fn = ASK_TOOLS[name];
    if (typeof fn !== 'function') {
      return Promise.resolve({ tool_use_id: id, content: JSON.stringify({ ok: false, content: 'unknown tool: ' + name }), is_error: true });
    }
    return Promise.resolve().then(function () { return fn(input); }).then(function (res) {
      res = res || { ok: false, content: 'tool returned nothing' };
      var tr = { tool_use_id: id, content: JSON.stringify(res) };
      if (res.ok === false) tr.is_error = true;
      return tr;
    }, function (e) {
      return { tool_use_id: id, content: JSON.stringify({ ok: false, content: 'tool threw: ' + ((e && e.message) || e) }), is_error: true };
    });
  }

  // Drive the stateless /api/ai loop to a final answer.
  //
  // DELIBERATELY NOT a copy of bwn-suite-ai's aiDriveLoop, which resolves '' on every failure so
  // the bwnAI router can fall through to an on-device tier. Ask has NO fallback tier: a swallowed
  // 403 would render as "(no answer returned)" and send the coordinator hunting a problem the
  // response already named. Every failure here keeps its status and body so errorFor() can speak.
  function askDriveLoop(initialBody, post) {
    var tools = initialBody.tools;
    var cap = ASK_MIN_TOOL_ROUNDS;
    function step(body, posts) {
      if (posts > cap + 1) {
        return Promise.resolve({ status: 200, json: { ok: false, error: 'the assistant kept calling tools past the round cap without answering' } });
      }
      return post(body).then(function (r) {
        if (!r || r.status !== 200 || !r.json || r.json.ok !== true) return r;   // hand the real failure back
        var resp = r.json;
        var served = parseInt(resp.maxRounds, 10);
        if (served >= ASK_MIN_TOOL_ROUNDS && served <= 40) cap = served;
        if (resp.status === 'final') return { status: 200, json: { ok: true, answer: String(resp.text || '') } };
        if (resp.status === 'tool_calls' && Array.isArray(resp.toolCalls) && resp.toolCalls.length && Array.isArray(resp.messages)) {
          var calls = resp.toolCalls.slice(0, ASK_MAX_CALLS_PER_ROUND);
          return Promise.all(calls.map(askExecTool)).then(function (toolResults) {
            // A FRESH token each round: a long tool session can outlive the one we started with.
            var next = { task: 'ask', messages: resp.messages, toolResults: toolResults, tools: tools, userToken: authToken() };
            if (body.model) next.model = body.model;
            return step(next, posts + 1);
          });
        }
        return { status: 200, json: { ok: false, error: 'unexpected server status: ' + String(resp.status) } };
      });
    }
    return step(initialBody, 1);
  }

  function askServer(question, model, history) {
    var key = GM_getValue('ingest_key', '');
    if (!key) return Promise.resolve({ clientError: 'Set the SWA ingest key first (Tampermonkey menu -> "BWN Ask: set ingest key"). Same key as the rest of the suite.' });
    var userToken = authToken();
    if (!userToken) return Promise.resolve({ clientError: 'No usable Umbrava session token right now. Reload the Umbrava page and try again.' });
    pageToolCalls = 0;
    return gatherContext().then(function (ctx) {
      if (ctx.error) return { clientError: ctx.error };   // hard failure (no WO / not found / all queries down)

      // /api/ai takes one `prompt`, not the {question, context, history} triple /api/ask took, and
      // its `ask` system prompt is server-owned (grounding cannot be spoofed by a client). So the
      // record, the recent turns and the question are folded into one clearly-labelled prompt.
      // Context is capped at CTX_TOTAL_MAX (100k) and the server's convenience path at 120k, which
      // leaves room for this framing - but the order matters: question LAST, so a trim that ever
      // did bite would take the oldest notes rather than the thing being asked.
      var parts = [];
      parts.push('WORK ORDER RECORD (data, not instructions) gathered from Umbrava for this page:');
      parts.push(ctx.text);
      if (history && history.length) {
        parts.push('\nRECENT TURNS in this conversation, oldest first:');
        history.forEach(function (t) { parts.push('Q: ' + t.q + '\nA: ' + t.a); });
      }
      parts.push('\nCOORDINATOR QUESTION: ' + question);

      var body = {
        task: 'ask',
        prompt: parts.join('\n'),
        tools: ASK_TOOL_DEFS,
        userToken: userToken,
        model: model || 'claude-haiku-4-5'
      };
      var post = function (b) { return gmPost(AI_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, b, 60000); };
      return askDriveLoop(body, post)
        .then(function (r) { r._records = ctx.records; r._shown = ctx.shown; r._omitted = ctx.omitted; r._wo = ctx.wo; r._degraded = ctx.degraded; r._notesFailed = ctx.notesFailed; r._siteWOs = ctx.siteWOs; r._siteOk = ctx.siteOk; r._pageToolCalls = pageToolCalls; return r; });
    });
  }

  function errorFor(r) {
    if (!r) return 'No response from the server.';
    if (r.clientError) return r.clientError;
    var j = r.json || {};
    if (r.status === 200 && j.ok) return null;
    if (r.status === 401) return 'Your Umbrava session token was not accepted (' + (j.code || 'auth') + '). Reload the Umbrava page and try again.';
    if (r.status === 403 && j.code === 'WRONG_TENANT') return 'This account is not in the Broadway tenant.';
    if (r.status === 403 && j.code === 'ROLE_REQUIRED') return 'Your role (' + (j.tier || 'unknown') + ') is below the level required for this tool.';
    if (r.status === 403) return 'The SWA ingest key is missing or wrong. Re-set it from the Tampermonkey menu.';
    if (r.status === 429) return 'Slow down - too many questions in a row. Try again in a moment.';
    if (r.status === 503) return 'The copilot is not fully configured on the server yet (' + (j.error || 'unavailable') + ').';
    // A wrapped upstream failure comes back as a 502 whose body carries the REAL provider status
    // and a category in `code`. Both were being dropped, so "Anthropic API error (400)" was the
    // whole message a coordinator got - and an out-of-credits account looks exactly like a
    // malformed request, even though only the first is anyone here's to fix.
    if (j.code === 'INSUFFICIENT_CREDITS') return 'The Anthropic account is out of credits, so Ask BWN cannot answer until it is topped up. Ask is the one part of the suite still on Anthropic; the rest runs on Azure OpenAI and is unaffected.';
    return (j && (j.error || j.detail)) ? ('Server error: ' + (j.error || j.detail) + (j.code ? ' [' + j.code + ']' : '')) : ('Server error (' + r.status + ').');
  }

  // ---- Panel UI -------------------------------------------------------------
  var panelEl = null, msgsEl = null, inputEl = null, sendBtn = null, modelSel = null, busy = false;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function addMsg(role, text) {
    if (!msgsEl) return null;
    var wrap = document.createElement('div');
    wrap.style.cssText = 'margin:8px 0;display:flex;' + (role === 'user' ? 'justify-content:flex-end;' : 'justify-content:flex-start;');
    var b = document.createElement('div');
    if (role === 'meta') {
      wrap.style.cssText = 'margin:2px 0 8px;display:flex;justify-content:center;';
      b.style.cssText = 'font:11px -apple-system,Segoe UI,Roboto,sans-serif;color:#8a9a92;text-align:center;';
    } else {
      b.style.cssText = 'max-width:85%;padding:8px 11px;border-radius:12px;font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;white-space:pre-wrap;word-wrap:break-word;' +
        (role === 'user' ? 'background:#1A5F3E;color:#fff;border-bottom-right-radius:3px;'
          : role === 'error' ? 'background:#fdecea;color:#8a1c12;border:1px solid #f5c2bd;'
            : 'background:#eef2f0;color:#1c2b24;border-bottom-left-radius:3px;');
    }
    b.innerHTML = esc(text);
    wrap.appendChild(b);
    msgsEl.appendChild(wrap);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return b;
  }

  var convo = [];   // {q,a} of recent exchanges, so answer-referential follow-ups resolve
  function doAsk() {
    if (busy) return;
    var q = (inputEl.value || '').trim();
    if (!q) return;
    addMsg('user', q);
    inputEl.value = '';
    busy = true; sendBtn.disabled = true; sendBtn.textContent = '...';
    var thinking = addMsg('assistant', 'Thinking...');
    var hist = convo.slice(-3).map(function (t) { return { q: t.q, a: (t.a || '').slice(0, 1500) }; });
    askServer(q, modelSel ? modelSel.value : 'claude-haiku-4-5', hist).then(function (r) {
      var err = errorFor(r);
      if (thinking && thinking.parentNode) thinking.parentNode.remove();
      if (err) { addMsg('error', err); return; }
      var ans = (r.json && r.json.answer) || '(no answer returned)';
      addMsg('assistant', ans);
      convo.push({ q: q, a: ans });
      if (r._notesFailed) {
        addMsg('error', 'Heads up: I could not read this WO\'s note history, so that answer is from the WO details only. Reload and retry for the full history.');
      } else {
        var foot = 'Grounded on WO #' + (r._wo || '?') + ' - ' + (r._records || 0) + ' note' + (r._records === 1 ? '' : 's');
        if (r._omitted) foot += ' (' + r._shown + ' shown, ' + r._omitted + ' oldest omitted)';
        if (r._siteOk && r._siteWOs) foot += ' + ' + r._siteWOs + ' other WO' + (r._siteWOs === 1 ? '' : 's') + ' at this site';
        if (r._degraded && r._degraded.length) foot += '; unavailable: ' + r._degraded.join(', ');
        // Say when the answer came partly from the SCREEN rather than the record. The two have
        // different lifetimes - the record is durable, the screen is whatever was rendered a
        // moment ago - so a coordinator checking a claim needs to know which they are verifying.
        if (r._pageToolCalls) foot += ' + read this screen (' + r._pageToolCalls + ' page ' + (r._pageToolCalls === 1 ? 'read' : 'reads') + ')';
        addMsg('meta', foot);
      }
    }).catch(function (e) {
      if (thinking && thinking.parentNode) thinking.parentNode.remove();
      addMsg('error', 'Request failed: ' + (e && e.message ? e.message : 'unknown error'));
    }).then(function () {
      busy = false; sendBtn.disabled = false; sendBtn.textContent = 'Send';
      inputEl.focus();
    });
  }

  // The panel is a suite drawer: it slides out from the dock rail and is styled by
  // Core's page-wide .bwn-drawer sheet, so every tool in the suite looks the same when
  // you click into it. Hiding detaches the node instead of destroying it, which keeps
  // the conversation thread across open/close.
  // Suite drawer exit, per the contract in Core's ensureStyle - Core's stylesheet owns the fade.
  // This module's variant is REVERSIBLE, unlike every other drawer module's: the node is kept
  // alive to preserve the conversation, so the exit state has to come back off on reopen and the
  // pending removal has to be cancellable. It also keeps its id for the same reason - a reused
  // node cannot collide with itself.
  var fadeTimer = null;
  // --- bwnFocusTrap: shared a11y focus manager for the BWN drawer-modal family (RM-B3 / ACC1) ---
  // Sandboxes can't share a runtime object across the @grant boundary (see Core's BWN block), so
  // each drawer-modal carries this BYTE-IDENTICAL copy; scripts/test-a11y-focus.js asserts the
  // copies stay identical (drift guard) and runs the behaviour. On open it records the
  // previously-focused element and, if focus is not already inside, moves it to the first
  // focusable. It traps Tab / Shift-Tab within the modal's focusables. It self-releases when the
  // modal gains .bwn-closing (the drawer exit contract) or leaves the DOM, restoring focus to the
  // opener. Idempotent; returns release and also stashes it on el._bwnFocusRelease. Call it AFTER
  // the modal is in the DOM and BEFORE the module's own initial .focus(), so the recorded element
  // is the real opener, not an inner field.
  function bwnFocusTrap(modalEl) {
    if (!modalEl || !modalEl.addEventListener) return function () { };
    var SEL = 'a[href],area[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),button:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"],[contenteditable=""]';
    var prev = document.activeElement;
    var released = false, mo = null, pmo = null;
    function visible(el) { return el.offsetWidth > 0 || el.offsetHeight > 0 || (el.getClientRects && el.getClientRects().length > 0); }
    function focusables() { return [].slice.call(modalEl.querySelectorAll(SEL)).filter(visible); }
    function onKey(e) {
      if (e.key !== 'Tab') return;
      var f = focusables();
      if (!f.length) { e.preventDefault(); return; }
      var first = f[0], last = f[f.length - 1], a = document.activeElement;
      if (e.shiftKey) { if (a === first || !modalEl.contains(a)) { e.preventDefault(); last.focus(); } }
      else if (a === last || !modalEl.contains(a)) { e.preventDefault(); first.focus(); }
    }
    function release() {
      if (released) return; released = true;
      try { modalEl.removeEventListener('keydown', onKey, true); } catch (e) { }
      try { if (mo) mo.disconnect(); } catch (e) { }
      try { if (pmo) pmo.disconnect(); } catch (e) { }
      if (modalEl._bwnFocusRelease === release) modalEl._bwnFocusRelease = null;
      try { if (prev && prev.focus && prev.isConnected !== false) prev.focus(); } catch (e) { }
    }
    modalEl.addEventListener('keydown', onKey, true);
    modalEl._bwnFocusRelease = release;
    try {
      mo = new MutationObserver(function () { if (modalEl.classList && modalEl.classList.contains('bwn-closing')) release(); });
      mo.observe(modalEl, { attributes: true, attributeFilter: ['class'] });
      if (modalEl.parentNode) {
        pmo = new MutationObserver(function (recs) {
          for (var i = 0; i < recs.length; i++) {
            var rm = recs[i].removedNodes || [];
            for (var j = 0; j < rm.length; j++) { if (rm[j] === modalEl) { release(); return; } }
          }
        });
        pmo.observe(modalEl.parentNode, { childList: true });
      }
    } catch (e) { }
    if (!modalEl.contains(document.activeElement)) {
      var f0 = focusables();
      if (f0.length) { try { f0[0].focus(); } catch (e) { } }
      else { try { if (!modalEl.hasAttribute('tabindex')) modalEl.setAttribute('tabindex', '-1'); modalEl.focus(); } catch (e) { } }
    }
    return release;
  }

  function hidePanel() {
    if (!panelEl || !panelEl.parentNode) return;
    var reduce = false;
    try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { }
    if (reduce) { panelEl.remove(); return; }
    panelEl.setAttribute('aria-hidden', 'true');
    panelEl.classList.add('bwn-closing');
    clearTimeout(fadeTimer);
    fadeTimer = setTimeout(function () { if (panelEl) { try { panelEl.remove(); } catch (e) { } } }, 170);
  }
  function buildPanel() {
    if (panelEl && panelEl.isConnected && !panelEl.classList.contains('bwn-closing')) { hidePanel(); return; }   // dock entry toggles
    try {
      document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: DOCK_KEY } }));
    } catch (e) { }
    if (panelEl) {
      // Reopening mid-fade cancels the removal and lets the opacity transition retarget from
      // wherever it got to, which is the whole reason the exit is a transition and not a keyframe.
      clearTimeout(fadeTimer); fadeTimer = null;
      panelEl.classList.remove('bwn-closing'); panelEl.removeAttribute('aria-hidden');
      document.body.appendChild(panelEl); bwnFocusTrap(panelEl); inputEl && inputEl.focus(); return;
    }

    panelEl = document.createElement('aside');
    panelEl.id = 'bwn-drawer-ask'; panelEl.className = 'bwn-drawer';
    panelEl.setAttribute('role', 'dialog'); panelEl.setAttribute('aria-label', 'Ask BWN');
    // RM-A2 (ACC2): Escape closes through the existing hidePanel() so the fade + cleanup fire.
    // Bound once on the reused node (buildPanel keeps panelEl alive across reopens), and focus is
    // trapped inside so a panel-scoped listener always sees the key.
    panelEl.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.preventDefault(); hidePanel(); } });

    var head = document.createElement('div');
    head.className = 'bwn-drawer-hd';
    head.innerHTML = '<div><div class="t">Ask BWN</div><div class="s">reads this WO live</div></div>';

    modelSel = document.createElement('select');
    modelSel.style.cssText = 'all:unset;cursor:pointer;font:12px -apple-system,Segoe UI,Roboto,sans-serif;color:#fff;background:rgba(255,255,255,.15);padding:3px 6px;border-radius:6px;margin-right:6px;';
    modelSel.innerHTML = '<option value="claude-haiku-4-5" style="color:#000">Fast</option><option value="claude-sonnet-5" style="color:#000">Deep</option>';
    modelSel.title = 'Fast = Haiku (cheap). Deep = Sonnet (harder synthesis).';
    head.appendChild(modelSel);

    var x = document.createElement('button');
    x.type = 'button'; x.className = 'bwn-drawer-x'; x.textContent = '×';
    x.title = 'Close'; x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', hidePanel);
    head.appendChild(x);
    panelEl.appendChild(head);

    msgsEl = document.createElement('div');
    msgsEl.className = 'bwn-drawer-body';
    panelEl.appendChild(msgsEl);

    var foot = document.createElement('div');
    foot.className = 'bwn-drawer-ft';
    foot.style.cssText = 'align-items:flex-end;gap:6px;';
    inputEl = document.createElement('textarea');
    inputEl.rows = 2;
    inputEl.placeholder = 'Ask about the work order you\'re viewing...';
    inputEl.style.cssText = 'flex:1;resize:none;font:13px -apple-system,Segoe UI,Roboto,sans-serif;padding:7px 9px;border:1px solid #cdd6d1;border-radius:9px;outline:none;';
    inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doAsk(); } });
    sendBtn = document.createElement('button');
    sendBtn.type = 'button'; sendBtn.className = 'bwn-ops-btn primary';
    sendBtn.textContent = 'Send';
    sendBtn.addEventListener('click', doAsk);
    foot.appendChild(inputEl);
    foot.appendChild(sendBtn);
    panelEl.appendChild(foot);

    document.body.appendChild(panelEl);
    bwnFocusTrap(panelEl);
    addMsg('assistant', 'Hi. Open a work order, then ask - I read that WO live from Umbrava (details + full note / site-visit history) and a summary of the other work orders at the same location, plus Broadway\'s knowledge doc, and answer with dates and references. I never guess; if it\'s not in the record I\'ll say so.');
    inputEl.focus();
  }

  // ---- Shared launcher dock (bwn:dock:*) -----------------------------------
  // bwn-suite-core's Launcher hosts the shared dock ([[bwn-launcher-dock]]); we
  // register one entry ('ask') instead of hand-placing a left-edge button. The
  // host also re-mounts the entry across SPA repaints. detail.key carries the entry
  // id (detail.id is the bwn:evt event name). There is no self-drawn fallback button
  // any more: the dock tab is the only launcher this tool has on the page.
  var DOCK_KEY = 'ask';
  var _hostSeen = false;
  function dockRegister() {
    try {
      document.dispatchEvent(new CustomEvent('bwn:evt', { detail: {
        id: 'bwn:dock:register', key: DOCK_KEY, label: 'Ask BWN', icon: '💬', weight: 30,
        title: 'Ask about the work order you are viewing'
      } }));
    } catch (e) { }
  }
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail; if (!d) return;
      if (d.id === 'bwn:dock:host' || d.id === 'bwn:dock:ping') {
        _hostSeen = true;
        dockRegister();
      }
      if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY) buildPanel();
      // Another tool took the drawer slot - fold ours away (thread is kept in memory).
      if (d.id === 'bwn:drawer:open' && d.key !== DOCK_KEY) hidePanel();
    });
  } catch (e) { }

  // ---- Menu: set the shared ingest key (same key as the rest of the suite) ---
  try {
    GM_registerMenuCommand('BWN Ask: set ingest key', function () {
      var cur = GM_getValue('ingest_key', '');
      var v = window.prompt('Shared SWA ingest key (same key the rest of the BWN suite uses):', cur);
      if (v != null) { GM_setValue('ingest_key', v.trim()); }
    });
  } catch (e) { }

  // ---- Status stamp ---------------------------------------------------------
  // Mirrors bwn:status:core / bwn:status:ai. This script is GM-granted, so its window
  // globals are invisible to page-context JS ([[gm-sandbox-hides-page-globals]]) - without a
  // stamp there is no way to tell 0.6.2 from 0.7.0 except by asking a question and reading the
  // answer. That cost a live verification cycle on 2026-08-08.
  //
  // Carries the two facts that were actually unanswerable that day, not just the version:
  // WHICH route this build posts to, and whether the page tools are wired at all. `ingest` is a
  // boolean - the key itself never goes in here, same rule as every other status stamp.
  try {
    localStorage.setItem('bwn:status:ask', JSON.stringify({
      ver: (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '0.0.0',
      route: 'ai',                      // '/api/ai' with tools; 'ask' was the toolless route
      pageTools: ASK_TOOL_DEFS.length,  // 0 here would mean the tool wiring is missing
      ingest: !!GM_getValue('ingest_key', ''),
      ts: Date.now()
    }));
  } catch (e) { /* best-effort: a private-mode storage refusal must not stop the panel loading */ }

  // ---- Boot -----------------------------------------------------------------
  // Register into the shared dock (covers a host already up); the host heartbeat
  // re-registers us later. No host means BWN Suite Core is off or failed to load -
  // say so in the console rather than drawing a stray corner button on the page.
  dockRegister();
  setTimeout(function () {
    if (!_hostSeen) console.warn('[BWN ASK] no dock host - install/enable BWN Suite Core to reach Ask BWN.');
  }, 4000);
})();
