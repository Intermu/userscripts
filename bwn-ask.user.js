// ==UserScript==
// @name         BWN Ask (Coordinator Copilot)
// @namespace    https://broadwaynational.com/bwn
// @version      0.2.0
// @description  Ask questions about the work order you're viewing. Reads the WO live from Umbrava via same-origin GraphQL (details + full note / site-visit history) plus the team knowledge doc, and answers through the Broadway AI proxy with dates and note references. Phase 1 = page-scoped (Path A); no data leaves the trusted Broadway path.
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

/* eslint-disable */
(function () {
  'use strict';

  // ---- Config ---------------------------------------------------------------
  var SWA_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
  var ASK_URL = SWA_BASE + '/api/ask';
  var ROLE_TTL_MS = 6 * 3600 * 1000;

  // Context budget. The server caps at ~120k chars; stay under it so the notes
  // history can't get truncated mid-record.
  var CTX_TOTAL_MAX = 100000;

  // ---- Umbrava token (content-picked, mirrors bwn-suite-ai authToken) --------
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
  function woNumberFromUrl() { var m = location.pathname.match(/work-orders\/(\d+)/); return m ? parseInt(m[1], 10) : null; }

  // Proven selectors. CORE + notes are CONFIRMED against live Umbrava (bwn-wo-audit
  // v0.3.0 / bwn-suite-ai woToJob). Notes come from the ROOT jobNotes(workOrderNumber)
  // field - the older workOrderNotes(workOrderId) does NOT exist. Each augment group is
  // isolated so an unproven selector nulls only its own group, never the whole read.
  var CORE_Q =
    'query($n:Int!){ workOrder(workOrderNumber:$n){ ' +
    '  number trackingNumber scopeOfWork serviceInstructions locationId locationName workOrderTypeId ' +
    '  address{ addressLine1 city state postalCode } trades{ id name } priority{ label } doNotExceed{ amount } ' +
    '} }';
  var AUG_Q =
    'query($n:Int!){ workOrder(workOrderNumber:$n){ statusName creationDate workOrderDate priority{ expectedCompletionDate firstTripDate } } }';
  var COORD_Q =
    'query($n:Int!){ workOrder(workOrderNumber:$n){ assignedToMemberName vendorNames } }';
  var NOTES_Q =
    'query($n:Int!){ jobNotes(workOrderNumber:$n, includeDeleted:false){ id type content contentHtml createdDate isPinned isCompletion workOrderNoteSource createdBy { firstName lastName } } }';

  // Gather the RECORDS block by ACTIVELY querying the WO in view. Returns
  // { text, records, error? }. records = note count (0 = nothing found / not a WO page).
  function gatherContext() {
    var n = woNumberFromUrl();
    if (!n) return Promise.resolve({ text: '', records: 0, error: 'Open a specific work order (a /work-orders/<number> page) so I can read it, then ask.' });

    var coreP = gql(CORE_Q, { n: n }).then(function (d) { return (d && d.workOrder) || null; }).catch(function () { return null; });
    var augP = gql(AUG_Q, { n: n }).then(function (d) { return (d && d.workOrder) || {}; }).catch(function () { return {}; });
    var coordP = gql(COORD_Q, { n: n }).then(function (d) { return (d && d.workOrder) || {}; }).catch(function () { return {}; });
    var notesP = gql(NOTES_Q, { n: n }).then(function (d) { return (d && d.jobNotes) || []; }).catch(function () { return []; });

    return Promise.all([coreP, augP, coordP, notesP]).then(function (res) {
      var wo = res[0], aug = res[1] || {}, coord = res[2] || {}, notes = res[3] || [];
      if (!wo && !notes.length) return { text: '', records: 0, error: 'I could not read work order ' + n + ' from Umbrava (the query returned nothing). Reload the page and try again.' };
      wo = wo || {};

      var L = [];
      L.push('WORK ORDER #' + (wo.number || n) + (wo.trackingNumber ? ' (Tracking #' + wo.trackingNumber + ')' : ''));
      if (aug.statusName) L.push('Status: ' + aug.statusName);
      var wtype = wo.workOrderTypeId != null ? String(wo.workOrderTypeId) : '';
      if (wo.locationName || wo.locationId != null) L.push('Location: ' + (wo.locationName || '') + (wo.locationId != null ? ' (id ' + wo.locationId + ')' : ''));
      var addr = wo.address || null;
      if (addr) L.push('Address: ' + [addr.addressLine1, [addr.city, addr.state].filter(Boolean).join(', '), addr.postalCode].filter(Boolean).join(' '));
      if (wo.trades && wo.trades.length) L.push('Trade(s): ' + wo.trades.map(function (t) { return t && t.name; }).filter(Boolean).join(', '));
      if (wo.priority && wo.priority.label) L.push('Priority: ' + wo.priority.label);
      if (wo.doNotExceed && wo.doNotExceed.amount != null) L.push('NTE: $' + wo.doNotExceed.amount);
      if (coord.assignedToMemberName) L.push('Coordinator: ' + coord.assignedToMemberName);
      if (coord.vendorNames && coord.vendorNames.length) L.push('Vendor(s): ' + coord.vendorNames.join(', '));
      if (aug.workOrderDate || aug.creationDate) L.push('Created: ' + fmtDate(aug.workOrderDate || aug.creationDate));
      var pr = aug.priority || {};
      if (pr.firstTripDate) L.push('First trip: ' + fmtDate(pr.firstTripDate));
      if (pr.expectedCompletionDate) L.push('Expected completion: ' + fmtDate(pr.expectedCompletionDate));
      if (wo.scopeOfWork) L.push('Scope of work: ' + stripHtml(wo.scopeOfWork));
      if (wo.serviceInstructions) L.push('Service instructions: ' + stripHtml(wo.serviceInstructions));

      var head = L.join('\n');
      var parts = [head, '', 'NOTES / SITE-VISIT HISTORY (newest first, ' + notes.length + ' total):'];
      var sorted = notes.slice().sort(function (a, b) { return ts(b && b.createdDate) - ts(a && a.createdDate); });
      var used = parts.join('\n').length;
      var shown = 0;
      for (var i = 0; i < sorted.length; i++) {
        var nt = sorted[i];
        var body = stripHtml(nt.content || nt.contentHtml || '');
        if (!body) continue;
        var who = nt.createdBy ? [nt.createdBy.firstName, nt.createdBy.lastName].filter(Boolean).join(' ') : '';
        var tags = [nt.type, nt.workOrderNoteSource, nt.isPinned ? 'pinned' : '', nt.isCompletion ? 'completion' : ''].filter(Boolean).join(', ');
        var block = '\n[' + fmtDate(nt.createdDate) + ']' + (who ? ' ' + who : '') + (tags ? ' (' + tags + ')' : '') + '\n' + body + '\n';
        if (used + block.length > CTX_TOTAL_MAX) { parts.push('\n(...older notes omitted to stay within size limits...)'); break; }
        parts.push(block);
        used += block.length;
        shown++;
      }
      if (!notes.length) parts.push('\n(no notes on this work order)');
      return { text: parts.join('\n'), records: notes.length, shown: shown, wo: wo.number || n };
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

  function askServer(question, model) {
    var key = GM_getValue('ingest_key', '');
    if (!key) return Promise.resolve({ clientError: 'Set the SWA ingest key first (Tampermonkey menu -> "BWN Ask: set ingest key"). Same key as the rest of the suite.' });
    var userToken = authToken();
    if (!userToken) return Promise.resolve({ clientError: 'No usable Umbrava session token right now. Reload the Umbrava page and try again.' });
    return gatherContext().then(function (ctx) {
      if (ctx.error && !ctx.records) return { clientError: ctx.error };
      var payload = { userToken: userToken, question: question, context: ctx.text, model: model || 'claude-haiku-4-5' };
      return gmPost(ASK_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, payload, 60000)
        .then(function (r) { r._records = ctx.records; r._wo = ctx.wo; return r; });
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
    return (j && (j.error || j.detail)) ? ('Server error: ' + (j.error || j.detail)) : ('Server error (' + r.status + ').');
  }

  // ---- Panel UI -------------------------------------------------------------
  var panelEl = null, msgsEl = null, inputEl = null, sendBtn = null, modelSel = null, busy = false;

  function pillCss() {
    return 'all:unset;cursor:pointer;font:600 13px/1.2 -apple-system,Segoe UI,Roboto,sans-serif;' +
      'color:#fff;background:#1A5F3E;padding:10px 14px;border-radius:22px;' +
      'box-shadow:0 2px 10px rgba(0,0,0,.25);display:inline-flex;align-items:center;gap:6px;';
  }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function addMsg(role, text) {
    if (!msgsEl) return null;
    var wrap = document.createElement('div');
    wrap.style.cssText = 'margin:8px 0;display:flex;' + (role === 'user' ? 'justify-content:flex-end;' : 'justify-content:flex-start;');
    var b = document.createElement('div');
    b.style.cssText = 'max-width:85%;padding:8px 11px;border-radius:12px;font:13px/1.45 -apple-system,Segoe UI,Roboto,sans-serif;white-space:pre-wrap;word-wrap:break-word;' +
      (role === 'user' ? 'background:#1A5F3E;color:#fff;border-bottom-right-radius:3px;'
        : role === 'error' ? 'background:#fdecea;color:#8a1c12;border:1px solid #f5c2bd;'
          : 'background:#eef2f0;color:#1c2b24;border-bottom-left-radius:3px;');
    b.innerHTML = esc(text);
    wrap.appendChild(b);
    msgsEl.appendChild(wrap);
    msgsEl.scrollTop = msgsEl.scrollHeight;
    return b;
  }

  function doAsk() {
    if (busy) return;
    var q = (inputEl.value || '').trim();
    if (!q) return;
    addMsg('user', q);
    inputEl.value = '';
    busy = true; sendBtn.disabled = true; sendBtn.textContent = '...';
    var thinking = addMsg('assistant', 'Thinking...');
    askServer(q, modelSel ? modelSel.value : 'claude-haiku-4-5').then(function (r) {
      var err = errorFor(r);
      if (thinking && thinking.parentNode) thinking.parentNode.remove();
      if (err) { addMsg('error', err); }
      else {
        var ans = (r.json && r.json.answer) || '(no answer returned)';
        addMsg('assistant', ans);
      }
    }).catch(function (e) {
      if (thinking && thinking.parentNode) thinking.parentNode.remove();
      addMsg('error', 'Request failed: ' + (e && e.message ? e.message : 'unknown error'));
    }).then(function () {
      busy = false; sendBtn.disabled = false; sendBtn.textContent = 'Send';
      inputEl.focus();
    });
  }

  function buildPanel() {
    if (panelEl) { panelEl.style.display = 'flex'; inputEl && inputEl.focus(); return; }
    panelEl = document.createElement('div');
    panelEl.style.cssText = 'position:fixed;left:18px;bottom:120px;z-index:2147483646;width:390px;max-width:calc(100vw - 36px);' +
      'height:540px;max-height:calc(100vh - 110px);background:#fff;border:1px solid #d5ddd8;border-radius:14px;' +
      'box-shadow:0 8px 30px rgba(0,0,0,.28);display:flex;flex-direction:column;overflow:hidden;';

    var head = document.createElement('div');
    head.style.cssText = 'background:#1A5F3E;color:#fff;padding:10px 12px;display:flex;align-items:center;gap:8px;font:600 14px -apple-system,Segoe UI,Roboto,sans-serif;';
    head.innerHTML = '<span style="flex:1">Ask BWN</span>';

    modelSel = document.createElement('select');
    modelSel.style.cssText = 'all:unset;cursor:pointer;font:12px -apple-system,Segoe UI,Roboto,sans-serif;color:#fff;background:rgba(255,255,255,.15);padding:3px 6px;border-radius:6px;';
    modelSel.innerHTML = '<option value="claude-haiku-4-5" style="color:#000">Fast</option><option value="claude-sonnet-5" style="color:#000">Deep</option>';
    modelSel.title = 'Fast = Haiku (cheap). Deep = Sonnet (harder synthesis).';
    head.appendChild(modelSel);

    var x = document.createElement('button');
    x.textContent = '×';
    x.style.cssText = 'all:unset;cursor:pointer;font-size:20px;line-height:1;color:#fff;padding:0 4px;';
    x.addEventListener('click', function () { panelEl.style.display = 'none'; });
    head.appendChild(x);
    panelEl.appendChild(head);

    msgsEl = document.createElement('div');
    msgsEl.style.cssText = 'flex:1;overflow-y:auto;padding:10px 12px;background:#fafbfa;';
    panelEl.appendChild(msgsEl);

    var foot = document.createElement('div');
    foot.style.cssText = 'border-top:1px solid #e3e9e6;padding:8px;display:flex;gap:6px;align-items:flex-end;background:#fff;';
    inputEl = document.createElement('textarea');
    inputEl.rows = 2;
    inputEl.placeholder = 'Ask about the location/WO you\'re viewing...';
    inputEl.style.cssText = 'flex:1;resize:none;font:13px -apple-system,Segoe UI,Roboto,sans-serif;padding:7px 9px;border:1px solid #cdd6d1;border-radius:9px;outline:none;';
    inputEl.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doAsk(); } });
    sendBtn = document.createElement('button');
    sendBtn.textContent = 'Send';
    sendBtn.style.cssText = 'all:unset;cursor:pointer;font:600 13px -apple-system,Segoe UI,Roboto,sans-serif;color:#fff;background:#1A5F3E;padding:9px 14px;border-radius:9px;';
    sendBtn.addEventListener('click', doAsk);
    foot.appendChild(inputEl);
    foot.appendChild(sendBtn);
    panelEl.appendChild(foot);

    document.body.appendChild(panelEl);
    addMsg('assistant', 'Hi. Open a work order, then ask - I read that WO live from Umbrava (details + full note / site-visit history) plus Broadway\'s knowledge doc, and answer with dates and note references. I never guess; if it\'s not in the record I\'ll say so.');
    inputEl.focus();
  }

  // ---- Launcher -------------------------------------------------------------
  function renderLauncher() {
    if (document.getElementById('bwn-ask-launch')) return;
    var wrap = document.createElement('div');
    wrap.id = 'bwn-ask-launch';
    // Left column, above the WO Audit button. The right corner (bottom:18/66) is the CC
    // Purchase / CC Request stack - Ask BWN sat exactly on top of CC and was hidden behind it.
    wrap.style.cssText = 'position:fixed;left:18px;bottom:70px;z-index:2147483646;';
    var btn = document.createElement('button');
    btn.style.cssText = pillCss();
    btn.innerHTML = '💬 Ask BWN';
    btn.title = 'Ask about the location/WO you are viewing';
    btn.addEventListener('click', buildPanel);
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
  }

  // ---- Menu: set the shared ingest key (same key as the rest of the suite) ---
  try {
    GM_registerMenuCommand('BWN Ask: set ingest key', function () {
      var cur = GM_getValue('ingest_key', '');
      var v = window.prompt('Shared SWA ingest key (same key the rest of the BWN suite uses):', cur);
      if (v != null) { GM_setValue('ingest_key', v.trim()); }
    });
  } catch (e) { }

  // ---- Boot -----------------------------------------------------------------
  // Render as soon as the body is ready, then re-check on an interval: Umbrava's SPA can
  // remount its root and wipe the launcher, so a one-shot render isn't enough. renderLauncher
  // is a no-op when the button already exists, so the interval is cheap and self-healing.
  function ensureLauncher() { try { renderLauncher(); } catch (e) { } }
  setTimeout(ensureLauncher, 1200);
  setInterval(ensureLauncher, 2500);
})();
