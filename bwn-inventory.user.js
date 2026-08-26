// ==UserScript==
// @name         BWN Inventory (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.4.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-inventory.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-inventory.user.js
// @description  Logs a stock movement into the Broadway inventory subledger from inside Umbrava. Pick a movement (receive / issue / transfer), a SKU, a quantity and warehouse(s); a receipt also takes a unit cost. Submit POSTs to the broadway-internal-ops SWA (x-bwn-key gated, your Umbrava session token vouched server-side), which appends to an append-only movement ledger on Azure Table Storage - updating live per-warehouse on-hand + moving-average value and posting the double-entry GL. The same modal looks up current on-hand (qty + value) per warehouse for a SKU (the thing the old Excel log could not answer). Item codes and warehouses come from the shared master catalog (curated on the SWA Inventory page): the SKU field suggests known items and the warehouse pickers list active warehouses, so a typo cannot silently fork a bin; if the catalog is unreachable it falls back to a per-user warehouse pick-list. Opened on a work order, it prefills the Work Order # into the movement note. Each submit carries a stable id so a retry after a dropped response never double-posts. A "Ship items" mode issues several SKUs to a job in one go (a multi-line grid, ShipTo prefilled from the work order), then files a single branded packing slip via /api/packing-slip - inventory commits first, the slip covers the lines that moved, and a failed line or slip is retriable without ever double-posting stock. Nothing sensitive lives in this script. Open it from the suite dock (📦 Inventory) or the Tampermonkey menu.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      green-stone-0717dab0f.7.azurestaticapps.net
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.4.0';
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  var SWA_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
  var PROXY_URL = SWA_BASE + '/api/inventory-stock';
  var ONHAND_URL = SWA_BASE + '/api/inventory-onhand';
  var MASTERS_URL = SWA_BASE + '/api/inventory-masters';
  var SLIP_URL = SWA_BASE + '/api/packing-slip';   // Phase-1 slip route (sibling branch; dark/503 until deployed)
  console.info('[BWN INVENTORY] v' + VER + ' - stock movement + Ship-items modal -> SWA -> Table Storage subledger (movement ledger + moving-avg on-hand + double-entry GL). Ship items issues N SKUs to a job then files one packing slip. Item/warehouse dropdowns from the master catalog. Dock: 📦 Inventory.');

  // Movement -> the route's MovementType + which warehouses it needs + whether it takes a unit cost.
  // Mirrors api/inventory-stock: receipt/reconcile need a Rate (dollars); issue/transfer cost out at
  // the current moving average, so no rate. (reconcile - physical count / opening - is deferred here.)
  var MOVEMENTS = {
    receipt: { label: 'Receive into stock', source: false, target: true, rate: true },
    issue: { label: 'Issue from stock', source: true, target: false, rate: false },
    transfer: { label: 'Transfer between warehouses', source: true, target: true, rate: false }
  };

  // A fresh idempotency key per submission intent (see the submit handler). crypto.randomUUID is
  // present in every browser that runs Umbrava; the fallback keeps it working if it ever isn't.
  function newId() {
    try { if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID(); } catch (e) { }
    return 'inv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
  // Integer cents -> a "12.50" dollars string, for display only.
  function money(cents) { return (Number(cents || 0) / 100).toFixed(2); }

  // ===== SHIP-ITEMS ORCHESTRATION START (paste-testable; sliced by scripts/test-ship-items.js) =====
  // Pure, transport-injected orchestration for the "Ship items" mode. NOTHING in this block touches
  // the DOM, GM_*, or module globals - it takes everything through its args + a `deps` object so the
  // node harness can run it in a vm with a stubbed transport and NEVER hit the live write route. The
  // UI below wires the real gmPost + DOM callbacks into it.
  //
  // Transactionality (see wiki/ship-items-packing-slip-flow.md):
  //   A before B: every line's inventory `issue` commits first, THEN one packing-slip POST covers the
  //   committed lines. Per-line non-atomic (each SKU is its own entity-group txn), never rolled back,
  //   both halves separately idempotent (inventory by SourceId, slip by ShipmentId). A committed line
  //   is skipped on a retry - only failed/pending lines do new work - so a re-click can never
  //   double-post inventory. Resend-slip re-POSTs ONLY the slip and never touches inventory.

  function shipFirst6(s) { return String(s || '').replace(/-/g, '').slice(0, 6); }
  // Per-line dedup key = <ShipmentId>-<lineIndex>, stable across retries (index never shifts once
  // submitted). Slip number = PS-<WO#>-<first6(ShipmentId)>: unique, non-sequential, filing-dedup.
  function shipSourceId(shipmentId, i) { return String(shipmentId) + '-' + i; }
  function shipSlipNumber(woNum, shipmentId) { return 'PS-' + (String(woNum || '').trim() || 'NOWO') + '-' + shipFirst6(shipmentId); }
  function shipMintIds(woNum, uuidFn) {
    var shipmentId = uuidFn();
    return { shipmentId: shipmentId, slipNumber: shipSlipNumber(woNum, shipmentId) };
  }

  // Split Core's single "street, city, ST zip" address string (bwn:wo bus `addr`) into ShipTo fields.
  // Best-effort: an unparseable string drops whole into address1 rather than guessing. Never throws.
  function parseShipAddr(s) {
    var out = { address1: '', city: '', state: '', zip: '' };
    s = String(s || '').replace(/\s+/g, ' ').trim();
    if (!s) return out;
    var m = s.match(/^(.*),\s*([A-Za-z .'-]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/);
    if (m) { out.address1 = m[1].trim(); out.city = m[2].trim(); out.state = m[3]; out.zip = m[4]; }
    else { out.address1 = s; }
    return out;
  }

  // Soft pre-submit check for ONE line - WARN, never block (the server 409 is the real gate). Given
  // the line qty, the on-hand rows for its SKU, and the source warehouse, returns 0..n warnings.
  //  - NEGATIVE: qty exceeds recorded on-hand at that warehouse (will 409 NEGATIVE_STOCK).
  //  - ZERO_COST: the bin's moving-average rate is 0 (the $0-cost SKU bug) - the issue SUCCEEDS but
  //    books $0 COGS and the slip line shows $0.
  //  - NO_BIN: no stock on record at that warehouse yet (will 409 NO_BIN).
  function shipPrecheck(qty, onhandRows, warehouse) {
    var warnings = [];
    var q = Number(qty);
    var bin = null;
    (onhandRows || []).forEach(function (b) { if (b && b.warehouse === warehouse) bin = b; });
    if (!bin) { warnings.push({ type: 'NO_BIN', msg: 'no stock on record at ' + (warehouse || 'that warehouse') + ' yet - it may 409 (receive some in first)' }); return warnings; }
    var have = Number(bin.qty);
    var rate = Number(bin.rate);
    if (q > have) warnings.push({ type: 'NEGATIVE', have: have, msg: 'only ' + have + ' on hand at ' + warehouse + ' (asking ' + q + ') - this line will be refused; reduce qty or pick a stocked warehouse' });
    if (rate === 0) warnings.push({ type: 'ZERO_COST', msg: 'no cost on record; the slip line will show $0 and no COGS will post' });
    return warnings;
  }

  // Map an inventory-stock response (or a network/timeout error) to a per-line verdict. Mirrors the
  // single-movement handler's codes; retriable flags whether re-clicking could plausibly succeed.
  function classifyStock(status, json, netErr) {
    var code = (json && json.code) || '';
    if (netErr) { return { code: 'NETWORK', retriable: true, msg: (/tim(e|ed)/i.test(netErr) ? 'timed out - safe to retry (the same line id replays, so it will not double-post)' : (netErr + ' - safe to retry')) }; }
    if (status >= 200 && status < 300) return { code: '', retriable: false, msg: '' };
    if (status === 401) return { code: code || '401', retriable: true, msg: 'session could not be verified - reload the tab, then retry' };
    if (status === 403) return { code: code || '403', retriable: false, msg: 'ingest key missing or wrong - re-set it (Tampermonkey menu)' };
    if (status === 429) return { code: '429', retriable: true, msg: 'too many submissions - wait a moment and retry' };
    if (code === 'NEGATIVE_STOCK') { var have = (json && typeof json.have === 'number') ? json.have : null; return { code: code, retriable: false, msg: 'not enough on hand' + (have != null ? (' (only ' + have + ' available)') : '') + ' - reduce the qty, pick a stocked warehouse, or receive stock in first' }; }
    if (code === 'NO_BIN') return { code: code, retriable: false, msg: 'no stock on record at that warehouse yet - receive some in first' };
    if (code === 'CONTENDED') return { code: code, retriable: true, msg: 'item busy right now - wait a moment and retry' };
    if (status === 503) return { code: '503', retriable: true, msg: 'inventory system unavailable - try again shortly' };
    if (status === 500) return { code: '500', retriable: true, msg: 'server error - try again shortly' };
    return { code: code || String(status), retriable: true, msg: 'failed (' + status + ')' + (json && json.error ? ': ' + json.error : '') };
  }

  function shipSummary(state) {
    var committed = 0, failed = 0;
    state.lines.forEach(function (l) { if (l.status === 'committed') committed++; else if (l.status === 'failed') failed++; });
    return { committed: committed, failed: failed, total: state.lines.length, allCommitted: committed === state.lines.length };
  }

  // Phase A. Issue every line, sequentially so per-line status paints live. A line already `committed`
  // is skipped (idempotent - no re-POST), so a retry only does new work on failed/pending lines. Each
  // line carries its stable SourceId; a timeout/network error is recorded retry-safe, not fatal.
  function shipIssueAll(deps, state) {
    var headers = { 'Content-Type': 'application/json', 'x-bwn-key': deps.key };
    var i = 0;
    function step() {
      if (i >= state.lines.length) return Promise.resolve(shipSummary(state));
      var idx = i++, line = state.lines[idx];
      if (line.status === 'committed') { if (deps.onLine) deps.onLine(idx, line); return step(); }
      line.status = 'sending'; line.error = ''; line.code = '';
      if (deps.onLine) deps.onLine(idx, line);
      var body = {
        userToken: deps.userToken,
        MovementType: 'issue',
        ItemCode: line.sku,
        Quantity: line.qty,
        SourceWarehouse: state.sourceWarehouse,
        SourceId: shipSourceId(state.shipmentId, idx),
        WorkOrderNumber: state.woNum,
        Remarks: 'Ship WO ' + (String(state.woNum || '').trim() || '-') + ' · slip ' + state.slipNumber
      };
      return deps.post(deps.urls.stock, headers, body, 30000).then(function (r) {
        if (r.status >= 200 && r.status < 300 && r.json && r.json.ok) {
          line.status = 'committed';
          line.replay = !!r.json.replay;
          line.valueCents = -Number(r.json.valueDelta || 0);   // issue valueDelta is negative cents = COGS
          line.unitCostCents = (Number(line.qty) > 0) ? Math.round(line.valueCents / Number(line.qty)) : 0;
          line.code = ''; line.error = '';
        } else {
          var c = classifyStock(r.status, r.json, null);
          line.status = 'failed'; line.code = c.code; line.error = c.msg; line.retriable = c.retriable;
        }
        if (deps.onLine) deps.onLine(idx, line);
        return step();
      }, function (err) {
        var c = classifyStock(0, null, (err && err.message) || 'network error');
        line.status = 'failed'; line.code = c.code; line.error = c.msg; line.retriable = true;
        if (deps.onLine) deps.onLine(idx, line);
        return step();
      });
    }
    return step();
  }

  // The H2 packing-slip body - COMMITTED lines only (a failed line never rides the slip). Pure.
  function shipSlipBody(state, userToken) {
    var lines = [];
    state.lines.forEach(function (l) {
      if (l.status !== 'committed') return;
      lines.push({ sku: l.sku, desc: l.desc || '', uom: l.uom || '', qty: Number(l.qty), unitCostCents: l.unitCostCents || 0, lineValueCents: l.valueCents || 0 });
    });
    var st = state.shipTo || {};
    var body = {
      userToken: userToken,
      WorkOrderNumber: state.woNum,
      ShipTo: {
        recipient: st.recipient || '', company: st.company || '', phone: st.phone || '',
        address1: st.address1 || '', address2: st.address2 || '',
        city: st.city || '', state: st.state || '', zip: st.zip || ''
      },
      ShipDate: state.shipDate,
      ShipmentId: state.shipmentId,
      SlipNumber: state.slipNumber,
      lines: lines
    };
    if (state.recipientEmail) body.RecipientEmail = state.recipientEmail;   // OPTIONAL - omitted when blank
    return body;
  }

  // Phase B. POST the slip ONCE. Never posts inventory. Idempotent at the flow by SlipNumber/ShipmentId.
  function shipPostSlip(deps, state) {
    var body = shipSlipBody(state, deps.userToken);
    if (!body.lines.length) return Promise.resolve({ ok: false, status: 0, code: 'NO_LINES', msg: 'no committed lines to put on a slip' });
    var headers = { 'Content-Type': 'application/json', 'x-bwn-key': deps.key };
    return deps.post(deps.urls.slip, headers, body, 30000).then(function (r) {
      if (r.status >= 200 && r.status < 300 && r.json && r.json.ok) return { ok: true, status: r.status, json: r.json };
      var msg;
      if (r.status === 503) msg = 'the packing-slip service is not live yet - the slip was not sent. Stock is already recorded; use Resend slip once it is up.';
      else if (r.status === 401) msg = 'session could not be verified for the slip - reload the tab, then Resend slip.';
      else if (r.status === 403) msg = 'ingest key missing/wrong for the slip - re-set it, then Resend slip.';
      else if (r.status === 429) msg = 'slip send throttled - wait a moment, then Resend slip.';
      else msg = 'slip send failed (' + r.status + ')' + (r.json && r.json.error ? ': ' + r.json.error : '') + '.';
      return { ok: false, status: r.status, code: (r.json && r.json.code) || String(r.status), msg: msg };
    }, function (err) {
      return { ok: false, status: 0, code: 'NETWORK', msg: ((err && err.message) || 'could not reach the slip service') + ' - stock is recorded; use Resend slip.' };
    });
  }

  // A then B. B runs ONLY if at least one line committed (no slip for stock that never moved).
  function shipSubmit(deps, state) {
    return shipIssueAll(deps, state).then(function (sum) {
      if (sum.committed === 0) return { phaseA: sum, slip: null };
      return shipPostSlip(deps, state).then(function (slip) {
        if (deps.onSlip) deps.onSlip(slip);
        return { phaseA: sum, slip: slip };
      });
    });
  }
  // ===== SHIP-ITEMS ORCHESTRATION END =====

  // ---- BWN Ops Suite bus (read-only consumer of the suite data contract v1) ----
  // bwn-suite-core PUBLISHES the current WO's facts to sessionStorage `bwn:wo:{id}`. We only
  // READ it (WO # -> movement remarks). Absent (Core not installed / Job View not opened) -> blank.
  function woIdFromUrl() {
    var m = location.pathname.match(/work-orders\/(\d+)/);
    return m ? m[1] : null;
  }
  // Cheap ShipTo prefill from the suite bus. Core (WO Assist) PUBLISHES the WO header facts to
  // sessionStorage `bwn:wo:{id}` (contract v1): { client, location, addr, ... }. `addr` is a single
  // "street, city, ST zip" string (Core's siteAddr regex) - we parse it into address1/city/state/zip
  // and seed company from the client name. Recipient, phone and address2 are NOT in the bus (the WO
  // header does not carry a ship-to person/phone), so they stay blank for manual entry. Absent bus
  // (Core not installed / WO not scanned yet) -> null -> the block ships blank. Editable regardless.
  function busReadShipTo(id) {
    try {
      var raw = sessionStorage.getItem('bwn:wo:' + id);
      if (!raw) return null;
      var d = JSON.parse(raw);
      if (!d || d.v !== 1) return null;
      var parsed = parseShipAddr(d.addr || '');
      return {
        recipient: '',
        company: (d.client || d.location || '').trim(),
        phone: '',
        address1: parsed.address1,
        address2: '',
        city: parsed.city,
        state: parsed.state,
        zip: parsed.zip
      };
    } catch (e) { return null; }
  }

  // ---- Master catalog (items + warehouses) ------------------------------------
  // Curated on the SWA Inventory page and served by /api/inventory-masters (x-bwn-key + Umbrava vouch,
  // same auth as the on-hand/stock routes). Fetched best-effort on modal open and cached for the
  // session. When present it is the SOURCE for the SKU suggestions + the warehouse pickers, so codes
  // and warehouse names stay consistent (the name KEYS the on-hand bin - "Main" and "main" are two
  // different bins). If it is unreachable or still empty, the modal falls back to the per-user GM
  // warehouse pick-list below, so the tool keeps working before the catalog is populated.
  var masterItems = [];        // [{ code, desc, uom }] active only
  var masterWarehouses = [];   // [name] active only
  function fetchMasters() {
    var key = GM_getValue('ingest_key', ''); var userToken = authToken();
    if (!key || !userToken) return Promise.resolve(null);   // cannot call - keep the GM fallback
    return gmPost(MASTERS_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, { userToken: userToken }, 15000)
      .then(function (r) {
        if (r.status >= 200 && r.status < 300 && r.json && r.json.ok) {
          masterItems = (r.json.items || []).filter(function (i) { return i && i.active !== false; });
          masterWarehouses = (r.json.warehouses || []).filter(function (w) { return w && w.active !== false; })
            .map(function (w) { return w.name; });
          return r.json;
        }
        return null;
      })
      .catch(function () { return null; });   // fail silent -> GM fallback
  }
  function haveMasterWarehouses() { return masterWarehouses && masterWarehouses.length > 0; }

  // ---- Warehouses: per-user GM fallback (used only when the master catalog is empty/unreachable) ----
  // Stored in Tampermonkey (GM), NOT page storage - a per-user preference. Superseded by the shared
  // master catalog above; kept so the modal still works before the catalog is populated.
  function warehouses() {
    try { var a = JSON.parse(GM_getValue('inv_warehouses', '[]')); return Array.isArray(a) ? a.filter(Boolean) : []; }
    catch (e) { return []; }
  }
  function saveWarehouses(list) {
    var clean = [];
    (list || []).forEach(function (s) { s = String(s || '').trim().slice(0, 140); if (s && clean.indexOf(s) === -1) clean.push(s); });
    GM_setValue('inv_warehouses', JSON.stringify(clean));
    return clean;
  }
  function manageWarehouses() {
    var cur = warehouses();
    var v = prompt('Warehouse names (one per line). Each name keys its own on-hand bin, so keep them consistent, e.g. "Main":', cur.join('\n'));
    if (v === null) return null;
    var saved = saveWarehouses(v.split(/\r?\n/));
    toast(saved.length ? 'Saved ' + saved.length + ' warehouse' + (saved.length === 1 ? '' : 's') + '.' : 'Warehouse list cleared.');
    return saved;
  }
  // (Re)build a warehouse <select>: blank, one option per warehouse (from the master catalog when
  // present, else the GM pick-list), then the GM add/manage entry ONLY in fallback mode.
  var ADD_WH = '__add_wh__';
  function warehouseNames() { return haveMasterWarehouses() ? masterWarehouses : warehouses(); }
  function rebuildWarehouseOptions(sel, selected) {
    sel.innerHTML = '';
    sel.appendChild(new Option('- select a warehouse -', ''));
    warehouseNames().forEach(function (w) { sel.appendChild(new Option(w, w)); });
    if (!haveMasterWarehouses()) sel.appendChild(new Option('+ Add / manage warehouses…', ADD_WH));
    sel.value = (selected && Array.prototype.some.call(sel.options, function (o) { return o.value === selected; })) ? selected : '';
  }

  // ---- Toast --------------------------------------------------------------
  function toast(msg, ms, bg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:26px;transform:translate(-50%,10px);opacity:0;background:' + (bg || '#0d3d26') + ';color:#fff;font:400 14px ' + FONT + ';padding:11px 16px;border-radius:9px;max-width:74vw;box-shadow:0 6px 24px rgba(0,0,0,.3);line-height:1.5;';
    document.body.appendChild(t);
    var reduce = false;
    try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { }
    void t.offsetHeight;
    t.style.transition = reduce ? 'opacity .3s ease' : 'opacity .3s ease, transform .3s ease';
    t.style.opacity = '1';
    t.style.transform = 'translate(-50%,0)';
    setTimeout(function () {
      t.style.transition = reduce ? 'opacity .4s ease' : 'opacity .4s ease, transform .4s ease';
      t.style.opacity = '0';
      if (!reduce) t.style.transform = 'translate(-50%,10px)';
      setTimeout(function () { t.remove(); }, 420);
    }, ms || 6000);
  }

  // ---- Umbrava access token (for the server-side vouch) --------------------
  // Picked by CONTENT, not first key: the audience-keyed Auth0 cache slot transiently holds
  // NON-Umbrava tokens. Only an unexpired token whose iss is an Umbrava issuer is usable. The
  // token is sent ONLY to the declared SWA @connect host, in the JSON BODY (the SWA edge
  // overwrites the Authorization header) - never logged or stored.
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

  // ---- SWA POST (GM_xmlhttpRequest bypasses same-origin; @connect authorizes) ----
  function gmPost(url, headers, bodyObj, timeoutMs) {
    return new Promise(function (resolve, reject) {
      try {
        GM_xmlhttpRequest({
          method: 'POST', url: url, headers: headers, data: JSON.stringify(bodyObj), timeout: timeoutMs || 30000,
          onload: function (r) { var j = null; try { j = JSON.parse(r.responseText); } catch (e) { } resolve({ status: r.status, json: j }); },
          onerror: function () { reject(new Error('network error')); },
          ontimeout: function () { reject(new Error('timed out')); }
        });
      } catch (e) { reject(e); }
    });
  }

  // ---- Suite dock launcher (bwn:dock:* host in bwn-suite-core) -----------------
  // Same handshake bwn-dispatch uses: announce with bwn:dock:register, re-register on the host's
  // ping, open our drawer on bwn:dock:open for our key. The Tampermonkey menu is the fallback
  // opener when no host is present (Core not installed).
  var DOCK_KEY = 'inventory';
  function dockRegister() {
    try {
      document.dispatchEvent(new CustomEvent('bwn:evt', { detail: {
        id: 'bwn:dock:register', key: DOCK_KEY, label: 'Inventory', icon: '📦', weight: 16,
        title: 'Log a stock movement / check on-hand'
      } }));
    } catch (e) { }
  }
  document.addEventListener('bwn:evt', function (e) {
    var d = e && e.detail; if (!d) return;
    if (d.id === 'bwn:dock:host' || d.id === 'bwn:dock:ping') dockRegister();
    if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY) buildModal();
    if (d.id === 'bwn:drawer:open' && d.key !== DOCK_KEY) closeModal();   // another tool took the slot
  });

  // ---- Drawer plumbing (Core owns the stylesheet; these lines are duplicated per module) ----
  var openEl = null;
  function drawerDismiss(el) {
    var reduce = false;
    try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { }
    if (reduce) { el.remove(); return; }
    el.removeAttribute('id'); el.setAttribute('aria-hidden', 'true');
    el.classList.add('bwn-closing');
    setTimeout(function () { try { el.remove(); } catch (e) { } }, 170);
  }
  function closeModal() { if (openEl) { document.removeEventListener('keydown', onKey); drawerDismiss(openEl); openEl = null; } }
  function onKey(e) { if (e.key === 'Escape') closeModal(); }

  function buildModal() {
    if (openEl) return;   // one at a time
    var woId = woIdFromUrl();

    var back = document.createElement('aside');
    back.id = 'bwn-drawer-inventory'; back.className = 'bwn-drawer';
    back.setAttribute('role', 'dialog'); back.setAttribute('aria-label', 'Inventory Movement');
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: DOCK_KEY } })); } catch (e) { }

    var card = document.createElement('div');
    card.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;color:#12241b;font:400 14px ' + FONT + ';';

    var head = document.createElement('div');
    head.className = 'bwn-drawer-hd';
    head.innerHTML = '<div><div class="t">Inventory Movement</div><div class="s">Stock ledger + live on-hand</div></div>';
    var x = document.createElement('button');
    x.type = 'button'; x.className = 'bwn-drawer-x'; x.textContent = '×';
    x.title = 'Close'; x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', closeModal);
    head.appendChild(x);

    var form = document.createElement('form');
    form.className = 'bwn-drawer-body';
    form.setAttribute('autocomplete', 'off');

    var lblCss = 'display:block;font-weight:600;font-size:12px;margin:0 0 4px;color:#33473d;';
    var inCss = 'width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #c6d2cc;border-radius:8px;font:400 14px ' + FONT + ';background:#fff;color:#12241b;';

    function fieldWrap(labelText, required) {
      var wrap = document.createElement('div'); wrap.style.cssText = 'margin-bottom:13px;';
      var lbl = document.createElement('label'); lbl.style.cssText = lblCss;
      lbl.textContent = labelText + (required ? ' *' : '');
      wrap.appendChild(lbl);
      return { wrap: wrap, lbl: lbl };
    }

    // Movement type
    var mtF = fieldWrap('Movement', true);
    var movement = document.createElement('select'); movement.style.cssText = inCss;
    Object.keys(MOVEMENTS).forEach(function (k) { movement.appendChild(new Option(MOVEMENTS[k].label, k)); });
    movement.appendChild(new Option('Ship items to a job (+ packing slip)', 'ship'));
    movement.value = 'receipt';
    mtF.lbl.setAttribute('for', 'inv_movement'); movement.id = 'inv_movement';
    mtF.wrap.appendChild(movement); form.appendChild(mtF.wrap);

    // SKU + on-hand lookup
    var skuF = fieldWrap('SKU (Item Code)', true);
    var skuRow = document.createElement('div'); skuRow.style.cssText = 'display:flex;gap:8px;';
    var sku = document.createElement('input'); sku.type = 'text'; sku.placeholder = 'type or pick a SKU (e.g. PFJ-LED-48)'; sku.style.cssText = inCss;
    sku.id = 'inv_sku'; sku.setAttribute('autocomplete', 'off'); sku.setAttribute('list', 'inv_sku_list'); skuF.lbl.setAttribute('for', 'inv_sku');
    // Datalist of catalog items (suggestions only - free text is still accepted so a NEW item can be
    // received before it is added to the master). Populated from masterItems, refreshed when the fetch lands.
    var skuList = document.createElement('datalist'); skuList.id = 'inv_sku_list';
    function fillSkuList() {
      skuList.innerHTML = '';
      masterItems.forEach(function (it) {
        var o = document.createElement('option'); o.value = it.code; if (it.desc) o.label = it.desc; skuList.appendChild(o);
      });
    }
    fillSkuList();
    var onhandBtn = document.createElement('button');
    onhandBtn.type = 'button'; onhandBtn.textContent = 'On hand';
    onhandBtn.style.cssText = 'flex:0 0 auto;padding:9px 12px;border:1px solid #c6d2cc;background:#fff;color:#33473d;border-radius:8px;font:600 13px ' + FONT + ';cursor:pointer;white-space:nowrap;';
    skuRow.appendChild(sku); skuRow.appendChild(onhandBtn);
    skuF.wrap.appendChild(skuRow); skuF.wrap.appendChild(skuList);
    var onhandOut = document.createElement('div');
    onhandOut.style.cssText = 'font-size:12.5px;color:#33473d;margin:6px 0 0;min-height:16px;';
    skuF.wrap.appendChild(onhandOut);
    form.appendChild(skuF.wrap);

    // Quantity
    var qtyF = fieldWrap('Quantity', true);
    var qty = document.createElement('input'); qty.type = 'text'; qty.inputMode = 'numeric'; qty.placeholder = 'e.g. 3 (whole units)'; qty.style.cssText = inCss;
    qty.id = 'inv_qty'; qtyF.lbl.setAttribute('for', 'inv_qty');
    qtyF.wrap.appendChild(qty); form.appendChild(qtyF.wrap);

    // Unit cost (receipts only) - DOLLARS; the route converts to integer cents. Issue/transfer cost
    // out at the current moving average, so this stays hidden for them.
    var rateF = fieldWrap('Unit cost (each)', true);
    var rate = document.createElement('input'); rate.type = 'text'; rate.inputMode = 'decimal'; rate.placeholder = 'e.g. 12.50'; rate.style.cssText = inCss;
    rate.id = 'inv_rate'; rateF.lbl.setAttribute('for', 'inv_rate');
    rateF.wrap.appendChild(rate); form.appendChild(rateF.wrap);

    // Source + Target warehouses (visibility depends on movement)
    var srcF = fieldWrap('Source warehouse', true);
    var srcSel = document.createElement('select'); srcSel.style.cssText = inCss; srcSel.id = 'inv_src';
    srcF.lbl.setAttribute('for', 'inv_src'); rebuildWarehouseOptions(srcSel, '');
    srcF.wrap.appendChild(srcSel); form.appendChild(srcF.wrap);

    var tgtF = fieldWrap('Target warehouse', true);
    var tgtSel = document.createElement('select'); tgtSel.style.cssText = inCss; tgtSel.id = 'inv_tgt';
    tgtF.lbl.setAttribute('for', 'inv_tgt'); rebuildWarehouseOptions(tgtSel, '');
    tgtF.wrap.appendChild(tgtSel); form.appendChild(tgtF.wrap);

    function onWarehouseSelect(sel) {
      return function () {
        if (sel.value === ADD_WH) {
          var list = manageWarehouses();
          var pick = (list && list.length) ? list[list.length - 1] : '';
          rebuildWarehouseOptions(srcSel, srcSel === sel ? pick : (srcSel.value || ''));
          rebuildWarehouseOptions(tgtSel, tgtSel === sel ? pick : (tgtSel.value || ''));
        }
      };
    }
    srcSel.addEventListener('change', onWarehouseSelect(srcSel));
    tgtSel.addEventListener('change', onWarehouseSelect(tgtSel));

    function applyMovementVisibility() {
      var isShip = movement.value === 'ship';
      if (isShip) {
        // Ship items owns its own multi-line grid + ShipTo block, so the single-movement fields step aside.
        skuF.wrap.style.display = 'none'; qtyF.wrap.style.display = 'none';
        srcF.wrap.style.display = 'none'; tgtF.wrap.style.display = 'none';
        rateF.wrap.style.display = 'none'; remF.wrap.style.display = 'none';
        shipWrap.style.display = '';
        submit.textContent = 'Ship items';
        try { head.querySelector('.s').textContent = 'Issue several SKUs + file a packing slip'; } catch (e) { }
      } else {
        var mv = MOVEMENTS[movement.value] || MOVEMENTS.receipt;
        skuF.wrap.style.display = ''; qtyF.wrap.style.display = '';
        srcF.wrap.style.display = mv.source ? '' : 'none';
        tgtF.wrap.style.display = mv.target ? '' : 'none';
        rateF.wrap.style.display = mv.rate ? '' : 'none';
        remF.wrap.style.display = '';
        shipWrap.style.display = 'none';
        submit.textContent = 'Submit movement';
        try { head.querySelector('.s').textContent = 'Stock ledger + live on-hand'; } catch (e) { }
      }
    }
    // (listener + first call are attached at the end of buildModal, once shipWrap + submit exist)

    // Idempotency key for the NEXT submit. Minted on Submit, reused on a no-edit retry (so a dropped
    // response does not double-post), and invalidated the moment ANY field changes - an edited form is
    // a different movement and must get a fresh id, never replay the old one. Cleared on success (the
    // modal closes, so a new movement starts a new closure).
    var pendingSourceId = null;
    form.addEventListener('input', function () { pendingSourceId = null; });
    form.addEventListener('change', function () { pendingSourceId = null; });

    // Work Order # (prefill from the URL - folded into remarks server-side)
    var woF = fieldWrap('Work Order / Job #', false);
    var wo = document.createElement('input'); wo.type = 'text'; wo.placeholder = 'digits only (optional)'; wo.style.cssText = inCss;
    wo.id = 'inv_wo'; woF.lbl.setAttribute('for', 'inv_wo');
    if (woId) wo.value = woId;
    woF.wrap.appendChild(wo); form.appendChild(woF.wrap);

    // Remarks
    var remF = fieldWrap('Remarks', false);
    var rem = document.createElement('textarea'); rem.rows = 2; rem.placeholder = 'optional note'; rem.style.cssText = inCss + 'resize:vertical;';
    rem.id = 'inv_rem'; remF.lbl.setAttribute('for', 'inv_rem');
    remF.wrap.appendChild(rem); form.appendChild(remF.wrap);

    // ================= SHIP ITEMS MODE (multi-line issue + one packing slip) =================
    // Hidden until "Ship items" is picked in the Movement select. Owns its own grid, ShipTo block,
    // source warehouse and status area; the submit + orchestration live in runShip() below and lean on
    // the pure SHIP-ITEMS ORCHESTRATION block at the top of the file (transport-injected, DOM-free).
    var shipRows = [];          // [{ el, sku, qty, hint, statusSpan, removeBtn, onhandRows, desc, uom }]
    var shipState = null;       // frozen at first submit: { shipmentId, slipNumber, lines[], shipTo, ... }
    var shipSubmitted = false;  // once true the line STRUCTURE locks so SourceIds (=<ShipmentId>-<index>) stay stable

    function todayISO() { try { return new Date().toISOString().slice(0, 10); } catch (e) { return ''; } }
    function shipMasterFor(code) {
      code = String(code || '').trim(); if (!code) return null;
      for (var i = 0; i < masterItems.length; i++) { if (masterItems[i].code === code) return masterItems[i]; }
      return null;
    }

    var shipWrap = document.createElement('div');
    shipWrap.style.cssText = 'display:none;';

    var shipIntro = document.createElement('div');
    shipIntro.style.cssText = 'font-size:12.5px;color:#33473d;margin:0 0 12px;line-height:1.5;';
    shipIntro.textContent = 'Issue several SKUs to this work order in one go, then file a single packing slip. Stock is recorded first; the slip covers the lines that shipped. A failed line or slip can be retried without ever double-posting stock.';
    shipWrap.appendChild(shipIntro);

    // Source warehouse (one for the whole shipment)
    var shipSrcF = fieldWrap('Ship from (source warehouse)', true);
    var shipSrcSel = document.createElement('select'); shipSrcSel.style.cssText = inCss; shipSrcSel.id = 'inv_ship_src';
    shipSrcF.lbl.setAttribute('for', 'inv_ship_src'); rebuildWarehouseOptions(shipSrcSel, '');
    shipSrcSel.addEventListener('change', function () {
      if (shipSrcSel.value === ADD_WH) { var list = manageWarehouses(); rebuildWarehouseOptions(shipSrcSel, (list && list.length) ? list[list.length - 1] : ''); }
      shipRows.forEach(shipRenderHint);
    });
    shipSrcF.wrap.appendChild(shipSrcSel); shipWrap.appendChild(shipSrcF.wrap);

    // Lines grid
    var linesF = fieldWrap('Items to ship', true);
    var linesBox = document.createElement('div');
    linesF.wrap.appendChild(linesBox);
    var addBtn = document.createElement('button');
    addBtn.type = 'button'; addBtn.textContent = '+ Add line';
    addBtn.style.cssText = 'padding:7px 12px;border:1px dashed #9bb3a8;background:#fff;color:#33473d;border-radius:8px;font:600 12.5px ' + FONT + ';cursor:pointer;';
    addBtn.addEventListener('click', function () { if (!shipSubmitted) shipAddRow(''); });
    linesF.wrap.appendChild(addBtn);
    shipWrap.appendChild(linesF.wrap);

    function shipAddRow(prefillSku) {
      var row = { onhandRows: null, desc: '', uom: '' };
      var el = document.createElement('div');
      el.style.cssText = 'border:1px solid #e0e8e4;border-radius:8px;padding:8px;margin-bottom:8px;background:#fafcfb;';
      var top = document.createElement('div'); top.style.cssText = 'display:flex;gap:8px;align-items:center;';
      var skuIn = document.createElement('input'); skuIn.type = 'text'; skuIn.placeholder = 'SKU'; skuIn.setAttribute('list', 'inv_sku_list'); skuIn.setAttribute('autocomplete', 'off');
      skuIn.style.cssText = inCss + 'flex:1 1 auto;';
      var qtyIn = document.createElement('input'); qtyIn.type = 'text'; qtyIn.inputMode = 'numeric'; qtyIn.placeholder = 'qty';
      qtyIn.style.cssText = inCss + 'flex:0 0 74px;width:74px;';
      var statusSpan = document.createElement('span'); statusSpan.style.cssText = 'flex:0 0 auto;width:16px;text-align:center;font-weight:700;font-size:15px;';
      var rm = document.createElement('button'); rm.type = 'button'; rm.textContent = '×'; rm.title = 'Remove line'; rm.setAttribute('aria-label', 'Remove line');
      rm.style.cssText = 'flex:0 0 auto;border:1px solid #c6d2cc;background:#fff;color:#8a1f1c;border-radius:6px;width:28px;height:34px;cursor:pointer;font-size:16px;line-height:1;';
      top.appendChild(skuIn); top.appendChild(qtyIn); top.appendChild(statusSpan); top.appendChild(rm);
      var hint = document.createElement('div'); hint.style.cssText = 'font-size:11.5px;color:#5a6b63;margin-top:5px;min-height:14px;line-height:1.4;';
      el.appendChild(top); el.appendChild(hint);
      if (prefillSku) skuIn.value = prefillSku;
      row.el = el; row.sku = skuIn; row.qty = qtyIn; row.hint = hint; row.statusSpan = statusSpan; row.removeBtn = rm;

      rm.addEventListener('click', function () {
        if (shipSubmitted) return;
        var i = shipRows.indexOf(row); if (i >= 0) shipRows.splice(i, 1);
        el.remove();
        if (!shipRows.length) shipAddRow('');
      });
      skuIn.addEventListener('change', function () { var it = shipMasterFor((skuIn.value || '').trim()); row.desc = it ? it.desc : ''; row.uom = it ? it.uom : ''; shipLoadOnhand(row); });
      qtyIn.addEventListener('input', function () { shipRenderHint(row); });

      shipRows.push(row); linesBox.appendChild(el);
      return row;
    }

    // Live on-hand hint per row (best-effort; the same lookup the single-movement "On hand" button uses).
    // Caches the rows on the row object so the pre-submit soft check can reuse them without a second call.
    function shipLoadOnhand(row) {
      var code = (row.sku.value || '').trim();
      if (!code) { row.onhandRows = null; shipRenderHint(row); return; }
      var key = GM_getValue('ingest_key', ''); var userToken = authToken();
      if (!key || !userToken) { shipRenderHint(row); return; }
      row.hint.style.color = '#5a6b63'; row.hint.textContent = 'Checking on hand…';
      gmPost(ONHAND_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, { userToken: userToken, ItemCode: code }, 20000)
        .then(function (r) { row.onhandRows = (r.status >= 200 && r.status < 300 && r.json && r.json.ok) ? (r.json.onhand || []) : null; shipRenderHint(row); })
        .catch(function () { row.onhandRows = null; shipRenderHint(row); });
    }

    function shipRenderHint(row) {
      if (shipSubmitted) return;   // once shipping, the status/render path owns the row hint
      var bits = [];
      if (row.desc) bits.push(row.desc + (row.uom ? (' · ' + row.uom) : ''));
      var wh = (shipSrcSel.value === ADD_WH) ? '' : shipSrcSel.value;
      if (row.onhandRows) {
        var bin = null; row.onhandRows.forEach(function (b) { if (b.warehouse === wh) bin = b; });
        if (wh && bin) bits.push('on hand ' + bin.qty + ' @ $' + money(bin.rate) + ' at ' + wh);
        else if (wh) bits.push('no stock at ' + wh);
        else if (row.onhandRows.length) bits.push('on hand: ' + row.onhandRows.map(function (b) { return b.warehouse + ' ' + b.qty; }).join(', '));
      }
      var q = (row.qty.value || '').trim();
      var warns = (q && row.onhandRows && wh) ? shipPrecheck(q, row.onhandRows, wh) : [];
      row.hint.style.color = warns.length ? '#a15c00' : '#5a6b63';
      if (warns.length) bits.push('⚠ ' + warns.map(function (w) { return w.msg; }).join('; '));
      row.hint.textContent = bits.join('  ·  ');
    }

    shipAddRow('');   // start with one empty line

    // ShipTo block (editable) - prefilled from the suite bus when Core has published the WO facts.
    var toF = fieldWrap('Ship to', false);
    var toGrid = document.createElement('div'); toGrid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;';
    var toIn = {};
    function shipToField(keyName, ph, full) {
      var i = document.createElement('input'); i.type = 'text'; i.placeholder = ph; i.setAttribute('autocomplete', 'off');
      i.style.cssText = inCss + (full ? 'grid-column:1 / -1;' : '');
      toIn[keyName] = i; toGrid.appendChild(i); return i;
    }
    shipToField('recipient', 'Recipient / attn', false);
    shipToField('company', 'Company', false);
    shipToField('phone', 'Phone', false);
    shipToField('address1', 'Address line 1', true);
    shipToField('address2', 'Address line 2 (suite, etc.)', true);
    shipToField('city', 'City', false);
    shipToField('state', 'State', false);
    shipToField('zip', 'ZIP', false);
    toF.wrap.appendChild(toGrid);
    var toNote = document.createElement('div'); toNote.style.cssText = 'font-size:11.5px;color:#5a6b63;margin-top:5px;line-height:1.4;';
    toF.wrap.appendChild(toNote);
    shipWrap.appendChild(toF.wrap);

    // Recipient email - the coordinator TYPES it (Mike's decision). Optional; blank still ships.
    var emailF = fieldWrap('Recipient email (optional)', false);
    var shipEmailIn = document.createElement('input'); shipEmailIn.type = 'email'; shipEmailIn.placeholder = "tech's email - leave blank to file + send to the team only"; shipEmailIn.style.cssText = inCss;
    shipEmailIn.id = 'inv_ship_email'; emailF.lbl.setAttribute('for', 'inv_ship_email');
    emailF.wrap.appendChild(shipEmailIn); shipWrap.appendChild(emailF.wrap);

    // Ship date
    var dateF = fieldWrap('Ship date', false);
    var shipDateIn = document.createElement('input'); shipDateIn.type = 'date'; shipDateIn.value = todayISO(); shipDateIn.style.cssText = inCss;
    shipDateIn.id = 'inv_ship_date'; dateF.lbl.setAttribute('for', 'inv_ship_date');
    dateF.wrap.appendChild(shipDateIn); shipWrap.appendChild(dateF.wrap);

    // Prefill ShipTo from the bus (address + company); recipient/phone/address2 have no cheap source -> manual.
    (function () {
      var pref = woId ? busReadShipTo(woId) : null;
      if (pref) {
        Object.keys(toIn).forEach(function (k) { if (pref[k]) toIn[k].value = pref[k]; });
        toNote.textContent = 'Prefilled the address + company from the work order. Type the recipient name, phone and suite if needed.';
      } else {
        toNote.textContent = 'No work-order address on hand (open the WO with the suite loaded to prefill). Enter the ship-to below.';
      }
    })();

    // Status area + Resend-slip control
    var shipStatusEl = document.createElement('div');
    shipStatusEl.setAttribute('role', 'status'); shipStatusEl.setAttribute('aria-live', 'polite');
    shipStatusEl.style.cssText = 'font-size:12.5px;color:#33473d;margin:10px 0 6px;min-height:18px;line-height:1.5;';
    shipWrap.appendChild(shipStatusEl);
    var resendBtn = document.createElement('button');
    resendBtn.type = 'button'; resendBtn.textContent = 'Resend slip'; resendBtn.style.display = 'none';
    resendBtn.style.cssText += 'display:none;margin-bottom:6px;padding:8px 14px;border:1px solid #0d3d26;background:#fff;color:#0d3d26;border-radius:8px;font:600 13px ' + FONT + ';cursor:pointer;';
    resendBtn.addEventListener('click', shipResend);
    shipWrap.appendChild(resendBtn);

    // Enter inside a ship input must NOT submit the form early (that would mint ids + lock the grid).
    shipWrap.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') e.preventDefault();
    });

    form.appendChild(shipWrap);

    // ---- Ship helpers: read ShipTo, lock structure, render, orchestrate ----
    function shipReadTo() {
      return {
        recipient: (toIn.recipient.value || '').trim(), company: (toIn.company.value || '').trim(), phone: (toIn.phone.value || '').trim(),
        address1: (toIn.address1.value || '').trim(), address2: (toIn.address2.value || '').trim(),
        city: (toIn.city.value || '').trim(), state: (toIn.state.value || '').trim(), zip: (toIn.zip.value || '').trim()
      };
    }
    function shipLockStructure() {
      addBtn.disabled = true; addBtn.style.opacity = '0.5'; addBtn.style.cursor = 'default';
      shipRows.forEach(function (r) { r.removeBtn.disabled = true; r.removeBtn.style.opacity = '0.4'; r.sku.disabled = true; });
    }
    function shipRenderLine(idx, line) {
      var r = shipRows[idx]; if (!r) return;
      var s = r.statusSpan;
      if (line.status === 'committed') {
        s.textContent = '✓'; s.style.color = '#0d7a3f'; r.qty.disabled = true;
        r.hint.style.color = '#0d7a3f';
        r.hint.textContent = 'shipped ' + line.qty + (line.replay ? ' (already recorded)' : '') + ' · $' + money(line.valueCents) + ' COGS';
      } else if (line.status === 'sending') {
        s.textContent = '…'; s.style.color = '#5a6b63';
      } else if (line.status === 'failed') {
        s.textContent = '✗'; s.style.color = '#b4231f'; r.qty.disabled = false;
        r.hint.style.color = '#b4231f'; r.hint.textContent = line.error || 'failed - retriable';
      } else { s.textContent = ''; }
    }
    function shipRenderSummary(res, preWarn) {
      var a = res.phaseA, slip = res.slip;
      var parts = [a.committed + '/' + a.total + ' line(s) shipped'];
      if (a.failed) parts.push(a.failed + ' failed - fix the qty/warehouse then Retry');
      var noEmail = shipState.recipientEmail ? '' : ' (no recipient email - slip filed + sent to the team, not the tech)';
      if (a.committed === 0) {
        submit.textContent = 'Retry'; shipStatusEl.style.color = '#b4231f';
        shipStatusEl.textContent = 'No lines shipped - nothing to slip. ' + parts.join(' · ') + '.';
        return;
      }
      if (slip && slip.ok) {
        if (a.allCommitted) {
          toast('Shipped ✓  ' + a.committed + ' line(s) to WO ' + (shipState.woNum || '-') + ' · slip ' + shipState.slipNumber + ' filed' + noEmail, 8000);
          closeModal(); return;
        }
        submit.textContent = 'Retry failed line(s)'; shipStatusEl.style.color = '#a15c00';
        shipStatusEl.textContent = parts.join(' · ') + ' · packing slip ' + shipState.slipNumber + ' filed for the shipped line(s)' + noEmail + '.';
      } else {
        submit.textContent = a.allCommitted ? 'Retry' : 'Retry failed line(s)';
        shipStatusEl.style.color = '#b4231f';
        shipStatusEl.textContent = parts.join(' · ') + ' · stock is recorded, but the packing slip did not send: ' + ((slip && slip.msg) || 'unknown error') + ' Use Resend slip.';
        resendBtn.style.display = '';
      }
    }
    function shipResend() {
      var key = GM_getValue('ingest_key', ''); var userToken = authToken();
      if (!key || !userToken) { shipStatusEl.style.color = '#b4231f'; shipStatusEl.textContent = 'Set the ingest key and reload the tab, then Resend.'; return; }
      if (!shipState) return;
      shipState.shipTo = shipReadTo(); shipState.recipientEmail = (shipEmailIn.value || '').trim();
      var deps = { post: gmPost, key: key, userToken: userToken, urls: { stock: PROXY_URL, slip: SLIP_URL } };
      resendBtn.disabled = true; resendBtn.textContent = 'Resending…';
      shipPostSlip(deps, shipState).then(function (slip) {   // slip route ONLY - never re-posts inventory
        resendBtn.disabled = false; resendBtn.textContent = 'Resend slip';
        if (slip.ok) { resendBtn.style.display = 'none'; shipStatusEl.style.color = '#0d7a3f'; shipStatusEl.textContent = 'Packing slip ' + shipState.slipNumber + ' filed ✓ for the shipped line(s).'; toast('Packing slip ' + shipState.slipNumber + ' sent ✓', 6000); }
        else { shipStatusEl.style.color = '#b4231f'; shipStatusEl.textContent = 'Slip still did not send: ' + (slip.msg || 'unknown error'); }
      }).catch(function (err) { resendBtn.disabled = false; resendBtn.textContent = 'Resend slip'; shipStatusEl.style.color = '#b4231f'; shipStatusEl.textContent = 'Resend failed: ' + ((err && err.message) || err); });
    }

    function runShip() {
      shipStatusEl.style.color = '#33473d';
      var key = GM_getValue('ingest_key', '');
      if (!key) { shipStatusEl.style.color = '#b4231f'; shipStatusEl.textContent = 'Set the SWA ingest key first: Tampermonkey menu -> "Set SWA ingest key".'; return; }
      var userToken = authToken();
      if (!userToken) { shipStatusEl.style.color = '#b4231f'; shipStatusEl.textContent = 'No usable Umbrava session token right now - reload the tab, then try again.'; return; }
      var wh = (shipSrcSel.value === ADD_WH) ? '' : shipSrcSel.value;

      if (!shipSubmitted) {
        var kept = shipRows.filter(function (r) { return (r.sku.value || '').trim(); });
        if (!kept.length) { shipStatusEl.style.color = '#b4231f'; shipStatusEl.textContent = 'Add at least one line with a SKU.'; return; }
        var bad = [];
        kept.forEach(function (r, i) { if (!(Number((r.qty.value || '').trim()) > 0)) bad.push(i + 1); });
        if (bad.length) { shipStatusEl.style.color = '#b4231f'; shipStatusEl.textContent = 'Enter a whole quantity greater than 0 for line' + (bad.length > 1 ? 's ' : ' ') + bad.join(', ') + '.'; return; }
        if (!wh) { shipStatusEl.style.color = '#b4231f'; shipStatusEl.textContent = 'Pick a source warehouse to ship from.'; return; }
        // Commit the filter: drop blank rows so shipRows[i] <-> lines[i] stay aligned (index = SourceId suffix).
        shipRows.forEach(function (r) { if (!(r.sku.value || '').trim()) r.el.remove(); });
        shipRows = kept;
        var ids = shipMintIds((wo.value || '').trim(), newId);
        shipState = {
          shipmentId: ids.shipmentId, slipNumber: ids.slipNumber,
          shipDate: shipDateIn.value || todayISO(),
          woNum: (wo.value || '').trim(),
          sourceWarehouse: wh,
          shipTo: shipReadTo(),
          recipientEmail: (shipEmailIn.value || '').trim(),
          lines: shipRows.map(function (r) { return { sku: (r.sku.value || '').trim(), desc: r.desc || '', uom: r.uom || '', qty: (r.qty.value || '').trim(), status: 'pending', valueCents: 0, unitCostCents: 0, code: '', error: '' }; })
        };
        shipSubmitted = true;
        shipLockStructure();
      } else {
        // Retry: refresh only the NON-committed lines' qty (reduce-qty fix) + the editable ShipTo/email/date.
        // Committed lines are frozen and get skipped in shipIssueAll, so inventory can never double-post.
        shipRows.forEach(function (r, i) { var ln = shipState.lines[i]; if (ln && ln.status !== 'committed') ln.qty = (r.qty.value || '').trim(); });
        shipState.shipTo = shipReadTo();
        shipState.recipientEmail = (shipEmailIn.value || '').trim();
        shipState.shipDate = shipDateIn.value || shipState.shipDate;
      }

      // Pre-submit soft checks over the pending lines (warn, never block - the server 409 is the real gate).
      var preWarn = [];
      shipRows.forEach(function (r, i) {
        var ln = shipState.lines[i]; if (!ln || ln.status === 'committed') return;
        if (r.onhandRows) shipPrecheck(ln.qty, r.onhandRows, shipState.sourceWarehouse).forEach(function (w) { preWarn.push('line ' + (i + 1) + ': ' + w.msg); });
      });

      var deps = {
        post: gmPost, key: key, userToken: userToken,
        urls: { stock: PROXY_URL, slip: SLIP_URL },
        onLine: shipRenderLine
      };
      submit.disabled = true; submit.textContent = 'Shipping…'; resendBtn.style.display = 'none';
      shipStatusEl.style.color = '#33473d';
      var pending = shipState.lines.filter(function (l) { return l.status !== 'committed'; }).length;
      shipStatusEl.textContent = 'Issuing ' + pending + ' line(s)…' + (preWarn.length ? ('  ⚠ ' + preWarn.join(' | ')) : '');
      shipSubmit(deps, shipState).then(function (res) { submit.disabled = false; shipRenderSummary(res, preWarn); })
        .catch(function (err) { submit.disabled = false; submit.textContent = 'Retry'; shipStatusEl.style.color = '#b4231f'; shipStatusEl.textContent = 'Unexpected error: ' + ((err && err.message) || err); });
    }
    // =============== end SHIP ITEMS MODE ===============

    var msg = document.createElement('div');
    msg.style.cssText = 'min-height:18px;color:#b4231f;font-size:12.5px;margin:2px 0 10px;';

    var foot = document.createElement('div');
    foot.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;padding:6px 0 14px;';
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:9px 16px;border:1px solid #c6d2cc;background:#fff;color:#33473d;border-radius:8px;font:600 13px ' + FONT + ';cursor:pointer;';
    cancel.addEventListener('click', closeModal);
    var submit = document.createElement('button');
    submit.type = 'submit'; submit.textContent = 'Submit movement';
    submit.style.cssText = 'padding:9px 18px;border:none;background:#0d3d26;color:#fff;border-radius:8px;font:600 13px ' + FONT + ';cursor:pointer;';
    foot.appendChild(cancel); foot.appendChild(submit);

    form.appendChild(msg); form.appendChild(foot);

    // ---- On-hand lookup -------------------------------------------------------
    onhandBtn.addEventListener('click', function () {
      onhandOut.style.color = '#33473d';
      var itemCode = (sku.value || '').trim();
      if (!itemCode) { onhandOut.textContent = 'Enter a SKU first.'; return; }
      var key = GM_getValue('ingest_key', '');
      var userToken = authToken();
      if (!key) { onhandOut.textContent = 'Set the SWA ingest key (Tampermonkey menu) first.'; return; }
      if (!userToken) { onhandOut.textContent = 'No usable Umbrava session token - reload the tab.'; return; }
      onhandOut.textContent = 'Checking…';
      gmPost(ONHAND_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, { userToken: userToken, ItemCode: itemCode }, 20000)
        .then(function (r) {
          if (r.status >= 200 && r.status < 300 && r.json && r.json.ok) {
            var rows = r.json.onhand || [];
            if (!rows.length) { onhandOut.textContent = 'No stock on record for ' + itemCode + '.'; return; }
            onhandOut.textContent = rows.map(function (b) { return b.warehouse + ': ' + b.qty + ' @ $' + money(b.rate); }).join('  ·  ') +
              '   (total ' + (r.json.totalQty || 0) + ' units, $' + money(r.json.totalValue) + ')';
          } else {
            onhandOut.style.color = '#b4231f';
            onhandOut.textContent = 'On-hand lookup failed (' + r.status + ')' + (r.json && r.json.error ? ': ' + r.json.error : '') + '.';
          }
        })
        .catch(function (err) { onhandOut.style.color = '#b4231f'; onhandOut.textContent = (err && err.message ? err.message : 'could not reach the proxy') + '.'; });
    });

    // ---- Submit ---------------------------------------------------------------
    form.addEventListener('submit', function (e) {
      e.preventDefault();
      if (movement.value === 'ship') { runShip(); return; }   // Ship items owns its own status area + orchestration
      msg.textContent = '';
      var key = GM_getValue('ingest_key', '');
      if (!key) { msg.textContent = 'Set the SWA ingest key first: Tampermonkey menu -> "Set SWA ingest key".'; return; }
      var userToken = authToken();
      if (!userToken) { msg.textContent = 'No usable Umbrava session token right now - reload the tab, then try again.'; return; }

      var mv = MOVEMENTS[movement.value] || MOVEMENTS.receipt;
      var payload = {
        userToken: userToken,
        MovementType: movement.value,
        ItemCode: (sku.value || '').trim(),
        Quantity: (qty.value || '').trim(),
        Rate: mv.rate ? (rate.value || '').trim() : '',
        SourceWarehouse: mv.source ? (srcSel.value === ADD_WH ? '' : srcSel.value) : '',
        TargetWarehouse: mv.target ? (tgtSel.value === ADD_WH ? '' : tgtSel.value) : '',
        WorkOrderNumber: (wo.value || '').trim(),
        Remarks: (rem.value || '').trim()
      };
      var missing = [];
      if (!payload.ItemCode) missing.push('SKU');
      if (!payload.Quantity) missing.push('Quantity');
      if (mv.rate && !payload.Rate) missing.push('Unit cost');
      if (mv.source && !payload.SourceWarehouse) missing.push('Source warehouse');
      if (mv.target && !payload.TargetWarehouse) missing.push('Target warehouse');
      if (missing.length) { msg.textContent = 'Required: ' + missing.join(', '); return; }

      // Mint the idempotency key now if this is a fresh attempt; a no-edit retry keeps the same one so
      // the server dedups a resend, while any field edit will have cleared it (a new movement).
      if (!pendingSourceId) pendingSourceId = newId();
      payload.SourceId = pendingSourceId;

      var reenable = function () { submit.disabled = false; submit.textContent = 'Submit movement'; };
      submit.disabled = true; submit.textContent = 'Submitting…';

      gmPost(PROXY_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, payload, 30000)
        .then(function (r) {
          var code = (r.json && r.json.code) || '';
          if (r.status >= 200 && r.status < 300 && r.json && r.json.ok) {
            var extra = r.json.replay ? '  (already recorded)' : (r.json.glPosted === false ? '  (GL sync pending)' : '');
            closeModal();
            toast('Stock movement logged ✓  ' + MOVEMENTS[payload.MovementType].label + ' - ' + payload.ItemCode + ' ×' + payload.Quantity + extra, 6000);
          } else if (r.status === 401) {
            reenable(); msg.textContent = 'Umbrava could not verify your session (' + (code || '401') + ') - reload the tab and try again.';
          } else if (r.status === 403) {
            reenable(); msg.textContent = 'Rejected (403): the SWA ingest key is missing or wrong. Re-set it via the Tampermonkey menu.';
          } else if (r.status === 429) {
            reenable(); msg.textContent = 'Too many submissions in a row - wait a moment and try again.';
          } else if (code === 'NEGATIVE_STOCK') {
            reenable(); msg.textContent = 'Not enough on hand' + (typeof (r.json && r.json.have) === 'number' ? ' (only ' + r.json.have + ' available)' : '') + '.';
          } else if (code === 'NO_BIN') {
            reenable(); msg.textContent = 'No stock on record at that warehouse yet - receive some in first.';
          } else if (code === 'CONTENDED') {
            reenable(); msg.textContent = 'That item is busy right now - wait a moment and submit again.';
          } else if (r.status === 503) {
            reenable(); msg.textContent = 'The inventory system is unavailable right now - try again shortly.';
          } else {
            reenable(); msg.textContent = 'Submit failed (' + r.status + ')' + (r.json && r.json.error ? ': ' + r.json.error : '') + '.';
          }
        })
        .catch(function (err) { reenable(); msg.textContent = (err && err.message ? err.message : 'could not reach the proxy') + '.'; });
    });

    // Now that shipWrap + submit exist, wire the Movement select to switch modes (and set initial view).
    movement.addEventListener('change', applyMovementVisibility);
    applyMovementVisibility();

    // Load the master catalog (best-effort) and repopulate the SKU suggestions + warehouse pickers when
    // it lands. Cached across opens, so a re-open shows them immediately; this just refreshes.
    fetchMasters().then(function (m) {
      if (!m) return;   // unreachable / not signed in -> keep the GM fallback already rendered
      fillSkuList();
      rebuildWarehouseOptions(srcSel, srcSel.value || '');
      rebuildWarehouseOptions(tgtSel, tgtSel.value || '');
      if (!shipSubmitted) rebuildWarehouseOptions(shipSrcSel, shipSrcSel.value || '');
    });

    card.appendChild(head); card.appendChild(form);
    back.appendChild(card);
    document.body.appendChild(back);
    openEl = back;
    document.addEventListener('keydown', onKey);
    setTimeout(function () { sku.focus(); }, 30);
  }

  // ---- Tampermonkey menu (always-available fallback opener) ----------------
  try {
    GM_registerMenuCommand('Log an inventory movement', buildModal);
    GM_registerMenuCommand('Manage warehouses', manageWarehouses);
    GM_registerMenuCommand('Set SWA ingest key', function () {
      var v = prompt('SWA ingest key (same value as the connector WO_INGEST_KEY - used across the BWN Ops Suite):', GM_getValue('ingest_key', '') || '');
      if (v !== null) { GM_setValue('ingest_key', v.trim()); toast(v.trim() ? 'Ingest key saved.' : 'Ingest key cleared.'); }
    });
  } catch (e) { /* menu API absent - the dock still opens this modal */ }

  // Register with the dock now (and again whenever a host announces/pings).
  dockRegister();
})();
