// ==UserScript==
// @name         BWN WO Context (Operations Assist)
// @namespace    broadwaynational.bwn
// @version      0.1.0
// @description  Read-only Operations Assist. Normalizes the work order you are viewing from BWN Suite Core's already-published context via Broadway's extract endpoint and shows the result in a non-modal dock panel. It issues no Umbrava query of its own, fetches no page content, and never writes anything upstream.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      green-stone-0717dab0f.7.azurestaticapps.net
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-wo-extract.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-wo-extract.user.js
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.1.0';

  // ---- Config ---------------------------------------------------------------
  var SWA_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
  var EXTRACT_URL = SWA_BASE + '/api/extract-work-order';
  var DOCK_KEY = 'wo-extract';
  var BUS_MAX_AGE_MS = 10 * 60 * 1000;   // treat Core context older than this as stale
  console.info('[BWN WO Context] v' + VER + ' - read-only Operations Assist (dock panel; Core-context normalizer). No Umbrava query, no writes.');

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

  // ---- Work-order route identity (URL only; NOT a query) --------------------
  // Anchored to a path segment so a substring route can't capture the wrong number. This is the
  // integer workOrderNumber the route carries; it is the authoritative id we normalize.
  function routeWoId() {
    var m = location.pathname.match(/(?:^|\/)work-orders\/(\d+)(?:\/|$|\?|#)/);
    return m ? m[1] : null;
  }

  // ---- Core published context (sessionStorage bus v1; read-only consumer) ----
  // Core (WO Assist) is the PRODUCER of bwn:wo:{id}. We consume the documented contract directly -
  // never call a Core private function - and reject anything stale, malformed, or version-mismatched.
  function coreContext(id) {
    if (!id) return null;
    var raw;
    try { raw = sessionStorage.getItem('bwn:wo:' + id); } catch (e) { return null; }
    if (!raw) return null;
    var d;
    try { d = JSON.parse(raw); } catch (e) { return null; }
    if (!d || typeof d !== 'object' || d.v !== 1) return null;
    if (typeof d.ts === 'number' && (Date.now() - d.ts) > BUS_MAX_AGE_MS) return null;   // stale
    return d;
  }

  // ---- Bounded payload builder (explicit allowlist; never spreads the bus) ---
  // Reads ONLY the specific keys below out of Core's context; a client-DNE / authorization amount
  // (amount / doNotExceed / clientDneAmount) is never read and can never become vendorNte.
  function pick(bus, cands) {
    for (var i = 0; i < cands.length; i++) {
      var v = bus[cands[i]];
      if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
    }
    return null;
  }
  function vendorNteOf(bus) {
    // Explicit vendor-NTE only. Accept a scalar or a { amount } shape under a vendor-NTE key.
    var v = (bus.vendorNte !== undefined && bus.vendorNte !== null) ? bus.vendorNte
      : (bus.totalNTE !== undefined && bus.totalNTE !== null) ? bus.totalNTE : null;
    if (v && typeof v === 'object') v = v.amount;
    if (v === undefined || v === null || v === '') return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function buildContext(bus, id) {
    var ctx = { woNumber: String(id) };
    var client = pick(bus, ['clientName', 'client']);
    if (client) ctx.clientName = client;
    var status = pick(bus, ['statusName', 'status']);
    if (status) ctx.statusName = status;
    var loc = pick(bus, ['locationName', 'location']);
    if (loc) ctx.locationName = loc;
    var priority = pick(bus, ['priority', 'priorityLabel']);
    if (priority) ctx.priority = priority;
    var vn = vendorNteOf(bus);
    if (vn !== null) ctx.vendorNte = vn;
    return ctx;
    // NOTE: assetType/assetManufacturer/assetModel are not in the Core contract -> omitted on purpose.
  }

  // Does the Core context's own WO identity, if it carries one, agree with the route id? The bus is
  // keyed by the route id, but if it also carries an integer WO number we cross-check it.
  function idAgrees(bus, id) {
    var busId = (bus.woNumber != null) ? bus.woNumber : (bus.number != null ? bus.number : null);
    if (busId == null) return true;                 // keyed agreement is sufficient
    return String(busId).replace(/\D/g, '') === String(id).replace(/\D/g, '');
  }

  function correlationId() {
    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (e) { /* fall through */ }
    return 'woext-' + Date.now().toString(16) + '-' + Math.random().toString(16).slice(2, 10);
  }

  // ---- SWA POST (GM_xmlhttpRequest bypasses same-origin; @connect authorizes) ----
  function gmPost(url, headers, body, timeoutMs) {
    return new Promise(function (resolve) {
      try {
        GM_xmlhttpRequest({
          method: 'POST', url: url, headers: headers, data: JSON.stringify(body), timeout: timeoutMs || 30000,
          onload: function (r) { resolve({ status: r.status, text: r.responseText || '' }); },
          onerror: function () { resolve({ status: 0, text: '', neterr: true }); },
          ontimeout: function () { resolve({ status: 0, text: '', timeout: true }); }
        });
      } catch (e) { resolve({ status: 0, text: '', neterr: true }); }
    });
  }

  // ---- Refusal gate: what must hold before we call the endpoint --------------
  // Returns { ok:true, id, token, key, ctx } or { ok:false, state, detail } naming the panel state.
  function preflight() {
    var id = routeWoId();
    if (!id) return { ok: false, state: 'unavailable', detail: 'not-a-wo-route' };
    var key = '';
    try { key = GM_getValue('ingest_key', '') || ''; } catch (e) { key = ''; }
    if (!key) return { ok: false, state: 'setup', detail: 'no-ingest-key' };
    var token = authToken();
    if (!token) return { ok: false, state: 'setup', detail: 'no-umbrava-token' };
    var bus = coreContext(id);
    if (!bus) return { ok: false, state: 'unavailable', detail: 'no-core-context' };
    if (!idAgrees(bus, id)) return { ok: false, state: 'unavailable', detail: 'context-id-mismatch' };
    return { ok: true, id: id, token: token, key: key, ctx: buildContext(bus, id) };
  }

  // ---- Panel (non-modal, informational; textContent-only rendering) ----------
  var panelEl = null, bodyEl = null, actionBtn = null, inFlight = false;

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function clear(node) { while (node && node.firstChild) node.removeChild(node.firstChild); }

  function ensurePanel() {
    if (panelEl && panelEl.isConnected) return;
    // Reuse a detached node if we have one; otherwise build once.
    if (!panelEl) {
      panelEl = document.createElement('aside');
      panelEl.id = 'bwn-woext-panel';
      panelEl.className = 'bwn-woext';
      panelEl.setAttribute('role', 'region');
      panelEl.setAttribute('aria-label', 'Operations Assist - work order context');
      panelEl.style.cssText = 'position:fixed;right:16px;bottom:16px;width:320px;max-width:calc(100vw - 32px);max-height:70vh;overflow:auto;z-index:2147483000;background:#fff;color:#12211a;border:1px solid #cdd6d1;border-radius:12px;box-shadow:0 8px 30px rgba(0,0,0,.18);font:13px -apple-system,Segoe UI,Roboto,sans-serif;';

      var head = el('div', null);
      head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e6ece9;background:#12604a;color:#fff;border-radius:12px 12px 0 0;';
      var title = el('div', null, 'Operations Assist');
      title.style.cssText = 'font-weight:600;flex:1;';
      var sub = el('div', null, 'read-only WO context');
      sub.style.cssText = 'font-size:11px;opacity:.85;';
      var x = el('button', null, '×');
      x.type = 'button';
      x.setAttribute('aria-label', 'Close');
      x.style.cssText = 'all:unset;cursor:pointer;font-size:18px;line-height:1;color:#fff;padding:0 4px;';
      x.addEventListener('click', hidePanel);
      head.appendChild(title); head.appendChild(sub); head.appendChild(x);

      bodyEl = el('div', null);
      bodyEl.style.cssText = 'padding:12px;';

      var foot = el('div', null);
      foot.style.cssText = 'padding:10px 12px;border-top:1px solid #e6ece9;display:flex;justify-content:flex-end;';
      actionBtn = el('button', null, 'Check work-order context');
      actionBtn.type = 'button';
      actionBtn.style.cssText = 'all:unset;cursor:pointer;background:#12604a;color:#fff;font-weight:600;padding:7px 12px;border-radius:9px;';
      actionBtn.addEventListener('click', onAction);
      foot.appendChild(actionBtn);

      panelEl.appendChild(head);
      panelEl.appendChild(bodyEl);
      panelEl.appendChild(foot);
    }
    document.body.appendChild(panelEl);
  }

  function setAction(label, disabled) {
    if (!actionBtn) return;
    actionBtn.textContent = label;
    actionBtn.disabled = !!disabled;
    actionBtn.style.opacity = disabled ? '.55' : '1';
    actionBtn.style.pointerEvents = disabled ? 'none' : 'auto';
  }

  // The one renderer. `state` selects the message; `data` carries a contract or a detail string.
  function render(state, data) {
    ensurePanel();
    clear(bodyEl);

    if (state === 'ready') {
      bodyEl.appendChild(el('div', null, 'Read-only context is available for the work order you are viewing. Nothing is sent until you choose to check it.'));
      setAction('Check work-order context', false);
      return;
    }
    if (state === 'loading') {
      bodyEl.appendChild(el('div', null, 'Checking work-order context…'));
      setAction('Checking…', true);
      return;
    }
    if (state === 'unavailable') {
      var u = el('div', null);
      u.appendChild(el('div', null, 'Work-order context is not available.'));
      var why = { 'not-a-wo-route': 'Open a specific work order (a /work-orders/<number> page).', 'no-core-context': 'BWN Suite Core has not published this work order yet. Open or reload the work order and make sure Core is running.', 'context-id-mismatch': 'The available context does not match the work order in the address bar. Reload the work order.' };
      u.appendChild(el('div', null, why[data] || 'Open or reload a specific work order and ensure BWN Suite Core is running.'));
      bodyEl.appendChild(u);
      setAction('Re-check', false);
      return;
    }
    if (state === 'setup') {
      var s = el('div', null);
      if (data === 'no-ingest-key') {
        s.appendChild(el('div', null, 'This tool needs its ingest key set once.'));
        s.appendChild(el('div', null, 'Open the Tampermonkey menu for this script and choose "set ingest key" (it is scoped to this script only).'));
      } else {
        s.appendChild(el('div', null, 'No live Umbrava session was found.'));
        s.appendChild(el('div', null, 'Reload Umbrava / sign in again, then re-check.'));
      }
      bodyEl.appendChild(s);
      setAction('Re-check', false);
      return;
    }
    if (state === 'unauthorized') {
      var a = el('div', null);
      a.appendChild(el('div', null, 'The request was not authorized.'));
      a.appendChild(el('div', null, 'Check that this script’s ingest key matches the connector key, and that your Umbrava session is current, then re-check.'));
      bodyEl.appendChild(a);
      setAction('Re-check', false);
      return;
    }
    if (state === 'failure') {
      var f = el('div', null);
      f.appendChild(el('div', null, 'Could not reach the extractor (' + (data || 'network error') + ').'));
      f.appendChild(el('div', null, 'This is retryable; nothing was changed.'));
      bodyEl.appendChild(f);
      setAction('Retry', false);
      return;
    }
    if (state === 'validation') {
      var v = el('div', null);
      v.appendChild(el('div', null, 'The available page context is incomplete or invalid, so no normalized result could be produced.'));
      bodyEl.appendChild(v);
      setAction('Re-check', false);
      return;
    }
    if (state === 'success') {
      renderContract(data);
      setAction('Re-check', false);
      return;
    }
  }

  // Render the normalized contract as plain text rows. Values are set via textContent only.
  function renderContract(c) {
    c = c || {};
    if (c.reviewRequired) {
      var banner = el('div', null, 'Manual review recommended');
      banner.style.cssText = 'background:#fdf0d5;border:1px solid #e3b341;color:#7a5b00;padding:6px 8px;border-radius:8px;font-weight:600;margin-bottom:8px;';
      bodyEl.appendChild(banner);
    }
    var rows = [
      ['WO #', c.workOrderNumber], ['Client', c.client], ['Location', c.location],
      ['Priority', c.priority], ['Status', c.status],
      ['Vendor NTE', (c.nteAmount != null ? c.nteAmount : null)],
      ['Asset', [c.assetType, c.assetManufacturer, c.assetModel].filter(Boolean).join(' ') || null],
      ['Confidence', (typeof c.confidence === 'number' ? c.confidence : null)]
    ];
    var table = el('div', null);
    table.style.cssText = 'display:grid;grid-template-columns:auto 1fr;gap:3px 10px;';
    for (var i = 0; i < rows.length; i++) {
      var k = el('div', null, rows[i][0]); k.style.cssText = 'color:#5b6b63;';
      var val = rows[i][1];
      var vEl = el('div', null, (val === null || val === undefined || val === '') ? '—' : String(val));
      table.appendChild(k); table.appendChild(vEl);
    }
    bodyEl.appendChild(table);

    var warns = Array.isArray(c.warnings) ? c.warnings : [];
    if (warns.length) {
      var wt = el('div', null, 'Warnings'); wt.style.cssText = 'margin-top:10px;color:#5b6b63;font-weight:600;';
      bodyEl.appendChild(wt);
      var ul = el('ul', null); ul.style.cssText = 'margin:4px 0 0;padding-left:18px;';
      for (var j = 0; j < warns.length; j++) ul.appendChild(el('li', null, String(warns[j])));
      bodyEl.appendChild(ul);
    }
  }

  // Parse a backend response body to a contract object, or null.
  function parseContract(text) {
    try { var o = JSON.parse(text); return (o && typeof o === 'object') ? o : null; } catch (e) { return null; }
  }

  // ---- The one user-initiated action: check context, one bounded request -----
  function onAction() {
    if (inFlight) return;                 // no duplicate endpoint request
    var pf = preflight();
    if (!pf.ok) { render(pf.state, pf.detail); return; }

    inFlight = true;
    render('loading');
    var headers = { 'Content-Type': 'application/json', 'x-bwn-key': pf.key };
    var payload = {
      userToken: pf.token,
      source: 'umbrava',
      sourceUrl: location.origin + '/work-orders/' + pf.id,   // canonical WO route, metadata only, never fetched
      correlationId: correlationId(),
      context: pf.ctx
    };
    gmPost(EXTRACT_URL, headers, payload, 30000).then(function (r) {
      inFlight = false;
      if (r.status === 401 || r.status === 403) { render('unauthorized'); return; }
      if (r.status === 400) { render('validation'); return; }
      if (r.status !== 200) { render('failure', r.timeout ? 'timeout' : (r.status ? ('HTTP ' + r.status) : 'network error')); return; }
      var c = parseContract(r.text);
      if (!c) { render('failure', 'unreadable response'); return; }
      render('success', c);
    });
  }

  // ---- Panel open/close + shared dock registration --------------------------
  function showPanel() {
    ensurePanel();
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: DOCK_KEY } })); } catch (e) { /* best-effort */ }
    // Open on the current context so the operator sees state before acting; no request yet.
    var pf = preflight();
    render(pf.ok ? 'ready' : pf.state, pf.detail);
  }
  function hidePanel() {
    if (panelEl && panelEl.parentNode) { try { panelEl.parentNode.removeChild(panelEl); } catch (e) { /* ignore */ } }
  }
  function togglePanel() {
    if (panelEl && panelEl.isConnected) hidePanel(); else showPanel();
  }

  function dockRegister() {
    try {
      document.dispatchEvent(new CustomEvent('bwn:evt', { detail: {
        id: 'bwn:dock:register', key: DOCK_KEY, label: 'Ops Assist', icon: '🧭', weight: 32,
        title: 'Read-only work-order context for the WO you are viewing'
      } }));
    } catch (e) { /* best-effort */ }
  }
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail; if (!d) return;
      if (d.id === 'bwn:dock:host' || d.id === 'bwn:dock:ping') dockRegister();
      if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY) togglePanel();
      // Another tool took the drawer slot - fold ours away.
      if (d.id === 'bwn:drawer:open' && d.key !== DOCK_KEY) hidePanel();
    });
  } catch (e) { /* bus unavailable */ }
  dockRegister();

  // ---- SWA ingest key presence beacon ---------------------------------------
  // Boolean only, never the key. GM storage is PER SCRIPT, so a blank key here is invisible to every
  // sibling; Core's Ops panel reads these beacons to name the blank ones. ts is the LOAD time.
  var INGEST_BEACON_TS = Date.now();
  function publishIngestPresence() {
    try {
      localStorage.setItem('bwn:ingest:wo-extract', JSON.stringify({ k: GM_getValue('ingest_key', '') ? 1 : 0, ts: INGEST_BEACON_TS }));
    } catch (e) { /* best-effort */ }
  }
  publishIngestPresence();

  // ---- Menu: set THIS script's ingest key -----------------------------------
  // Not shared: Tampermonkey scopes GM storage per script, so this sets Ops Assist's own copy only.
  try {
    GM_registerMenuCommand('BWN Ops Assist: set ingest key', function () {
      var cur = GM_getValue('ingest_key', '');
      var v = window.prompt('SWA ingest key (same value as the connector WO_INGEST_KEY). Tampermonkey scopes this PER SCRIPT, so setting it here sets it for Ops Assist only - every other suite script needs its own copy:', cur);
      if (v != null) { GM_setValue('ingest_key', v.trim()); publishIngestPresence(); }
    });
  } catch (e) { /* menu unavailable */ }
})();
