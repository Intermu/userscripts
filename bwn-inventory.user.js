// ==UserScript==
// @name         BWN Inventory (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.3.1
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-inventory.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-inventory.user.js
// @description  Logs a stock movement into the Broadway inventory subledger from inside Umbrava. Pick a movement (receive / issue / transfer), a SKU, a quantity and warehouse(s); a receipt also takes a unit cost. Submit POSTs to the broadway-internal-ops SWA (x-bwn-key gated, your Umbrava session token vouched server-side), which appends to an append-only movement ledger on Azure Table Storage - updating live per-warehouse on-hand + moving-average value and posting the double-entry GL. The same modal looks up current on-hand (qty + value) per warehouse for a SKU (the thing the old Excel log could not answer). Item codes and warehouses come from the shared master catalog (curated on the SWA Inventory page): the SKU field suggests known items and the warehouse pickers list active warehouses, so a typo cannot silently fork a bin; if the catalog is unreachable it falls back to a per-user warehouse pick-list. Opened on a work order, it prefills the Work Order # into the movement note. Each submit carries a stable id so a retry after a dropped response never double-posts. Nothing sensitive lives in this script. Open it from the suite dock (📦 Inventory) or the Tampermonkey menu.
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

  var VER = '0.3.1';
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  var SWA_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
  var PROXY_URL = SWA_BASE + '/api/inventory-stock';
  var ONHAND_URL = SWA_BASE + '/api/inventory-onhand';
  var MASTERS_URL = SWA_BASE + '/api/inventory-masters';
  console.info('[BWN INVENTORY] v' + VER + ' - stock movement modal -> SWA -> Table Storage subledger (movement ledger + moving-avg on-hand + double-entry GL). Item/warehouse dropdowns from the master catalog. Dock: 📦 Inventory.');

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

  // ---- BWN Ops Suite bus (read-only consumer of the suite data contract v1) ----
  // bwn-suite-core PUBLISHES the current WO's facts to sessionStorage `bwn:wo:{id}`. We only
  // READ it (WO # -> movement remarks). Absent (Core not installed / Job View not opened) -> blank.
  function woIdFromUrl() {
    var m = location.pathname.match(/work-orders\/(\d+)/);
    return m ? m[1] : null;
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
    // Enter the way it leaves (animation review 2026-08-10). It used to POP in and fade out -
    // half an animation, and the missing half is the one the eye actually catches. Transitions,
    // not keyframes, so a toast replaced mid-flight retargets instead of restarting from zero.
    // `ease` rather than a strong ease-out on purpose: a toast reads as elegant slightly slower
    // than the rest of the UI. The transform composes with the centring translateX, which is why
    // both states write the full translate() - one axis cannot be animated past the other.
    // Reduced motion keeps the fade and drops the travel: gentler, not gone.
    var reduce = false;
    try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { }
    void t.offsetHeight;                                   // flush the start state or the transition never runs
    t.style.transition = reduce ? 'opacity .3s ease' : 'opacity .3s ease, transform .3s ease';
    t.style.opacity = '1';
    t.style.transform = 'translate(-50%,0)';               // under reduce this jumps: transform is not in the transition
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
    el.removeAttribute('id'); el.setAttribute('aria-hidden', 'true');   // id freed now: a reopen builds a fresh node
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
      var mv = MOVEMENTS[movement.value] || MOVEMENTS.receipt;
      srcF.wrap.style.display = mv.source ? '' : 'none';
      tgtF.wrap.style.display = mv.target ? '' : 'none';
      rateF.wrap.style.display = mv.rate ? '' : 'none';
    }
    movement.addEventListener('change', applyMovementVisibility);
    applyMovementVisibility();

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

    // Load the master catalog (best-effort) and repopulate the SKU suggestions + warehouse pickers when
    // it lands. Cached across opens, so a re-open shows them immediately; this just refreshes.
    fetchMasters().then(function (m) {
      if (!m) return;   // unreachable / not signed in -> keep the GM fallback already rendered
      fillSkuList();
      rebuildWarehouseOptions(srcSel, srcSel.value || '');
      rebuildWarehouseOptions(tgtSel, tgtSel.value || '');
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
