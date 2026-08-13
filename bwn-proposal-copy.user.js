// ==UserScript==
// @name         BWN Proposal Copy (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.1.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-proposal-copy.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-proposal-copy.user.js
// @description  Copy a client proposal from an aged-out work order onto a chosen replacement WO as an un-submitted Draft, in one confirmed action. Replays Umbrava's own createDraftProposal + editProposal mutations (line items copied verbatim); never submits, deletes, or retries. Manager-gated visibility. @grant none.
// @match        https://app.umbrava.com/*
// @match        https://*.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.1.0';   // keep in step with @version
  var DRY_RUN = false; // when true, the two WRITE mutations are logged, not sent
  console.info('[BWN PROPOSAL COPY] v' + VER + ' - copy client proposal to another WO as a Draft (createDraftProposal + editProposal replay)');

  function onProposalPage() { return /\/work-orders\/\d+/.test(location.pathname); }

  // ===== auth + gql =========================================================
  function pcIsUmbravaToken(tok) {
    try {
      var p = JSON.parse(atob(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      var iss = String(p.iss || '').replace(/\/+$/, '');
      if (iss !== 'https://login.umbrava.com' && iss !== 'https://umbrava.us.auth0.com') return false;
      return !(typeof p.exp === 'number' && (Date.now() / 1000) > p.exp);
    } catch (e) { return false; }
  }
  function pcAuthToken() {
    try {
      var keys = Object.keys(localStorage).filter(function (x) {
        return /@@auth0spajs@@::.*::https:\/\/app\.umbrava\.com\/api::/.test(x);
      });
      for (var i = 0; i < keys.length; i++) {
        var body = (JSON.parse(localStorage.getItem(keys[i])) || {}).body;
        var tok = (body && body.access_token) || '';
        if (tok && pcIsUmbravaToken(tok)) return tok;
      }
    } catch (e) { }
    return '';
  }
  function pcGql(op, query, variables) {
    var tok = pcAuthToken();
    if (!tok) return Promise.reject(new Error('no-umbrava-token'));
    return fetch('/api/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationName: op, query: query, variables: variables || {} })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
      return j && j.data;
    });
  }
  var ROLE_TTL_MS = 6 * 3600 * 1000;
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

  // ===== ops ================================================================
  var Q_PROPOSAL_WO = 'query ProposalWO($workOrderNumber: Int!) { job: workOrder(workOrderNumber: $workOrderNumber) { id number clientId clientName locationId locationName locationNumber formattedClientPurchaseOrderNumber } }';
  var Q_PROPOSAL_DETAILS = 'query ClientProposalDetails($proposalId: Int!) { proposal(id: $proposalId) { id number description scopeOfWork scopeOfWorkHtml disclaimer jobId jobType formattedClientPurchaseOrderNumber timeFrameDays { value } type { id name } status { id name } subtotal { amount currency precision } proposalLineItems { id category tripLabel quantity chargeQuantity unitOfMeasurement useMarkUpPercent markUpPercent isTaxable taxRate item itemId isPrivate sortOrder rateId description descriptionHtml trade { id } unitCost { amount currency precision } unitCharge { amount currency precision } } } }';
  var Q_LOCATION_OPEN_WOS = 'query PagedWorkOrders($page: PageInput!, $sortBy: [SortInput!]!, $locationId: ID, $phase: SystemPhaseValue) { listWorkOrdersPaginated(page: $page, sortBy: $sortBy, locationId: $locationId, phase: $phase) { rowCount items { id number statusName scopeOfWork locationId locationNumber } } }';
  // Return selection {success message proposal{id number}} is the wrapper editProposal + cloneProposal
  // were both captured returning (2026-08-13). createDraftProposal's wrapper is assumed identical;
  // the first dry-run/live create confirms it.
  var M_CREATE_DRAFT = 'mutation CreateDraftProposal($proposalData: CreateDraftProposalInput!) { createDraftProposal(proposalData: $proposalData) { success message proposal { id number } } }';
  var M_EDIT = 'mutation EditProposal($proposalData: EditProposalInput!) { editProposal(proposalData: $proposalData) { success message proposal { id number } } }';

  // ===== copy engine ========================================================
  // (mapLineItem, buildCreateVars, buildEditVars, copyProposal land here in
  //  Tasks 2-4. Kept DOM-free so the node harness can run it headless.)
  function mapLineItem(src) {
    src = src || {};
    var out = {
      id: src.id,
      category: src.category,
      tripLabel: src.tripLabel,
      tradeId: (src.trade && src.trade.id) != null ? src.trade.id : src.tradeId,
      quantity: src.quantity,
      fractionalQuantity: src.fractionalQuantity,
      chargeQuantity: src.chargeQuantity,
      fractionalChargeQuantity: src.fractionalChargeQuantity,
      unitCost: src.unitCost ? { amount: src.unitCost.amount, currency: src.unitCost.currency, precision: src.unitCost.precision } : null,
      unitOfMeasurement: src.unitOfMeasurement,
      useMarkUpPercent: src.useMarkUpPercent,
      markUpPercent: src.markUpPercent,
      unitCharge: src.unitCharge ? { amount: src.unitCharge.amount, currency: src.unitCharge.currency, precision: src.unitCharge.precision } : null,
      isTaxable: src.isTaxable,
      taxRate: src.taxRate,
      item: src.item,
      itemId: src.itemId,
      isPrivate: src.isPrivate,
      sortOrder: src.sortOrder,
      rateId: src.rateId,
      description: src.description,
      descriptionHtml: src.descriptionHtml
    };
    delete out.id;   // a copied line is a NEW row; sending the source id would target an existing item
    return out;
  }
  function buildCreateVars(source, target) {
    source = source || {}; target = target || {};
    return { proposalData: {
      workOrderNumber: target.number,
      typeId: source.type ? source.type.id : null,
      scopeOfWork: source.scopeOfWork,
      scopeOfWorkHtml: source.scopeOfWorkHtml,
      description: source.description,
      disclaimer: source.disclaimer,
      timeFrameDays: source.timeFrameDays && (source.timeFrameDays.value != null)
        ? { value: source.timeFrameDays.value } : null,
      clientPurchaseOrderNumber: source.formattedClientPurchaseOrderNumber || null
    } };
  }
  function buildEditVars(newProposalId, source) {
    source = source || {};
    var items = (source.proposalLineItems || []).map(mapLineItem);
    return { proposalData: {
      proposalId: newProposalId,
      typeId: source.type ? source.type.id : null,
      scopeOfWork: source.scopeOfWork,
      scopeOfWorkHtml: source.scopeOfWorkHtml,
      description: source.description,
      disclaimer: source.disclaimer,
      timeFrameDays: source.timeFrameDays && (source.timeFrameDays.value != null)
        ? { value: source.timeFrameDays.value } : null,
      proposalLineItems: items
    } };
  }
  function copyProposal(sourceProposalId, targetWorkOrderNumber, opts) {
    opts = opts || {};
    var dry = (opts.dryRun != null) ? opts.dryRun : DRY_RUN;
    var source = null, target = null, newId = null;
    return pcGql('ClientProposalDetails', Q_PROPOSAL_DETAILS, { proposalId: sourceProposalId })
      .then(function (d) {
        source = d && d.proposal;
        if (!source || !Array.isArray(source.proposalLineItems)) throw stage('read-source', 'source proposal not found or empty');
        return pcGql('ProposalWO', Q_PROPOSAL_WO, { workOrderNumber: targetWorkOrderNumber });
      })
      .then(function (d) {
        target = d && d.job;
        if (!target || target.number == null || target.id == null) throw stage('resolve-target', 'target WO not found');
        var createVars = buildCreateVars(source, target);
        if (dry) {
          var editPreview = buildEditVars('<newId>', source);
          console.info('[BWN PROPOSAL COPY] DRY-RUN create', JSON.stringify(createVars));
          console.info('[BWN PROPOSAL COPY] DRY-RUN edit', JSON.stringify(editPreview));
          return { __dry: true, create: createVars, edit: editPreview };
        }
        return pcGql('CreateDraftProposal', M_CREATE_DRAFT, createVars).then(function (r) {
          var res = r && r.createDraftProposal;
          if (!res || res.success !== true || !res.proposal || res.proposal.id == null) throw stage('create', (res && res.message) || 'createDraftProposal reported no success');
          newId = res.proposal.id;
          return pcGql('EditProposal', M_EDIT, buildEditVars(newId, source));
        }).then(function (r) {
          var res = r && r.editProposal;
          if (!res || res.success !== true) throw stage('edit', (res && res.message) || 'editProposal reported no success');
          return pcGql('ClientProposalDetails', Q_PROPOSAL_DETAILS, { proposalId: newId });
        }).then(function (d) {
          var nu = d && d.proposal;
          var srcN = source.proposalLineItems.length;
          var newN = nu && Array.isArray(nu.proposalLineItems) ? nu.proposalLineItems.length : -1;
          var srcSub = source.subtotal ? source.subtotal.amount : null;
          var newSub = nu && nu.subtotal ? nu.subtotal.amount : null;
          // EditProposalInput has NO clientPurchaseOrderNumber field (confirmed against the pinned
          // schema), so editProposal can never resend the PO that createDraftProposal set. If the
          // server does a whole-object replace on edit, that PO could be silently nulled out - compare
          // it here so the drop is visible instead of passing as a clean match. Two null/absent POs
          // (neither side ever had one) still agree.
          var srcPO = source.formattedClientPurchaseOrderNumber || null;
          var newPO = (nu && nu.formattedClientPurchaseOrderNumber) || null;
          var poMatch = srcPO === newPO;
          var match = (newN === srcN) && (srcSub == null || newSub === srcSub) && poMatch;
          return { ok: true, newProposalId: newId, created: true, filled: true, readBack: { sourceItems: srcN, newItems: newN, sourceSubtotal: srcSub, newSubtotal: newSub, sourcePO: srcPO, newPO: newPO, match: match } };
        });
      })
      .then(function (r) {
        if (r && r.__dry) return { ok: true, dryRun: true, create: r.create, edit: r.edit };
        return r;
      })
      .catch(function (err) {
        return { ok: false, newProposalId: newId, stage: (err && err.stage) || 'unknown', error: (err && err.message) || String(err) };
      });
    function stage(s, msg) { var e = new Error(msg); e.stage = s; return e; }
  }

  // ---- pure UI helpers (DOM-free, sliced by the node harness) --------------
  // Same-location open WOs, minus the source WO itself. `items` is whatever
  // Q_LOCATION_OPEN_WOS's listWorkOrdersPaginated.items came back as.
  function pickerFilter(items, sourceLocationId, sourceWorkOrderNumber) {
    return (items || []).filter(function (w) {
      if (w.number === sourceWorkOrderNumber) return false;
      if (sourceLocationId != null && w.locationId != null && w.locationId !== sourceLocationId) return false;
      return true;
    });
  }
  // Confirm enables only once every precondition holds: a usable token, a non-empty
  // source (so there is something to copy), and a target VERIFIED via Q_PROPOSAL_WO
  // (never just a typed number - id+number both present means the read succeeded).
  function confirmReady(state) {
    state = state || {};
    if (!state.hasToken) return false;
    if (!state.source || !Array.isArray(state.source.proposalLineItems) || state.source.proposalLineItems.length === 0) return false;
    if (!state.target || state.target.number == null || state.target.id == null) return false;
    return true;
  }

  // ===== ui =================================================================
  // Row button injection, drawer, target picker, confirm card + progress.
  //
  // DESIGN NOTE (no live WO snapshot was available while building this - see
  // task-5-report.md): the drawer is a fully SELF-CONTAINED overlay (own inline
  // stylesheet, own DOM, no dependency on Core's .bwn-drawer CSS actually being
  // present on the page) - the same "no-host fallback" shape bwn-drop-upload's
  // note box and bwn-suite-ai's job-view overlay use, so it renders identically
  // whether or not bwn-suite-core happens to be installed. It still PARTICIPATES
  // in the suite's one-panel-at-a-time bus contract (bwn:drawer:open) so it
  // doesn't stack with a real Core drawer when Core IS present.
  //
  // Every selector/extraction below that touches the Proposals section is marked
  // UNVERIFIED and is written to FAIL SAFE: if the expected row/anchor/id is not
  // found, injectRowButtons() injects nothing rather than guessing. Confirm each
  // UNVERIFIED marker against a live WO snapshot before the live gate (Task 6).

  var MIN_RANK = 4;
  function gated() { return typeof rank() === 'number' && rank() >= MIN_RANK; }
  function woNumberFromUrl() {
    var m = String(location.pathname || '').match(/\/work-orders\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmtMoney(money) {
    if (!money || money.amount == null) return '-';
    var precision = (money.precision != null) ? money.precision : 2;
    return '$' + (Number(money.amount) / Math.pow(10, precision)).toFixed(2);
  }

  // ---- row discovery (UNVERIFIED) ------------------------------------------
  // UNVERIFIED: confirm against a live WO snapshot before the live gate. No WO carrying
  // a client proposal was available while building this script, so the Proposals
  // section's row markup and how a row exposes its OWN proposal id were never captured
  // live. These probes are written defensively - a miss at any step means NOTHING is
  // injected, rather than guessing a selector that merely looks plausible.
  var ROW_BTN_MARK = 'data-bwn-pc';
  var ROW_BTN_CLASS = 'bwn-pc-row-btn';
  function proposalRows() {
    // UNVERIFIED: the Proposals section container + row selector.
    var scope = document.querySelector('[data-testid="proposals-section"], [data-testid*="proposal-list" i], [data-testid*="proposals" i]') || document;
    var rows = scope.querySelectorAll('[data-testid*="proposal-row" i], [data-proposal-id], tr[data-id]');
    return Array.prototype.slice.call(rows);
  }
  function proposalIdFromRow(row) {
    // UNVERIFIED: how a row exposes its own proposal id. Only ever read from the row's
    // OWN data (never scraped from visible text - a displayed "number" is the proposal
    // NUMBER, not the id copyProposal() needs).
    var raw = row.getAttribute('data-proposal-id') || row.getAttribute('data-id');
    if (raw == null) return null;
    var n = parseInt(raw, 10);
    return isFinite(n) ? n : null;
  }
  function isClientProposalRow(row) {
    // UNVERIFIED: how a row marks itself as a CLIENT proposal (vs. vendor/other). Fails
    // CLOSED - an unrecognized row is left alone rather than assumed to qualify, so a
    // wrong guess here can only under-inject, never mis-offer the button on the wrong row.
    var kind = (row.getAttribute('data-proposal-type') || row.getAttribute('data-kind') || '').toLowerCase();
    return kind.indexOf('client') !== -1;
  }
  function buildRowButton(sourceProposalId) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = ROW_BTN_CLASS;
    btn.textContent = 'Copy to WO…';
    btn.style.cssText = 'margin-left:8px;padding:4px 10px;border:1px solid #1a5f3e;border-radius:6px;' +
      'background:#f0fdf4;color:#0d3d26;font:600 12px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;cursor:pointer;';
    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      openDrawer(sourceProposalId);
    });
    return btn;
  }
  function injectRowButtons() {
    if (!onProposalPage()) return;
    if (!gated()) {
      // Rank dropped (or was never known) after a button was already shown - hide, don't
      // remove, so a later rank recovery doesn't need to re-discover the row.
      var shown = document.querySelectorAll('.' + ROW_BTN_CLASS);
      Array.prototype.forEach.call(shown, function (b) { b.style.display = 'none'; });
      return;
    }
    var rows = proposalRows();
    rows.forEach(function (row) {
      var mark = row.getAttribute(ROW_BTN_MARK);
      if (mark) {
        var existing = row.querySelector('.' + ROW_BTN_CLASS);
        if (existing) existing.style.display = '';   // rank regained - unhide
        return;
      }
      if (!isClientProposalRow(row)) return;
      var pid = proposalIdFromRow(row);
      if (pid == null) return;   // fail safe: no confirmed id, no button
      row.setAttribute(ROW_BTN_MARK, '1');
      row.appendChild(buildRowButton(pid));   // UNVERIFIED: append point within the row
    });
  }

  // ---- toast ----------------------------------------------------------------
  function pcToast(msg) {
    var el = document.createElement('div');
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483001;' +
      'background:#1b2a4a;color:#fff;padding:10px 18px;border-radius:8px;' +
      'font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3);';
    el.textContent = 'BWN Proposal Copy: ' + msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 5000);
  }

  // ---- drawer shell (self-contained; see DESIGN NOTE above) ------------------
  var DRAWER_KEY = 'proposal-copy';
  var openEl = null;
  var pcState = null;   // { hasToken, source, sourceWo, target }
  function ensurePcStyle() {
    if (document.getElementById('bwn-pc-style')) return;
    var st = document.createElement('style');
    st.id = 'bwn-pc-style';
    st.textContent =
      '#bwn-pc-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(9,30,66,.45);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
      '#bwn-pc-card{width:480px;max-width:92vw;max-height:86vh;overflow:auto;background:#fff;border-radius:12px;' +
      'box-shadow:0 20px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;color:#12241b;}' +
      '#bwn-pc-hd{padding:14px 18px;border-radius:12px 12px 0 0;background:linear-gradient(135deg,#1a5f3e,#0d3d26);color:#fff;display:flex;align-items:flex-start;gap:10px;}' +
      '#bwn-pc-hd .t{font:600 15px inherit;}' +
      '#bwn-pc-hd .s{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:rgba(255,255,255,.75);margin-top:2px;}' +
      '#bwn-pc-x{margin-left:auto;flex:none;background:rgba(255,255,255,.14);border:none;border-radius:6px;color:#fff;width:26px;height:26px;cursor:pointer;font-size:16px;line-height:1;}' +
      '#bwn-pc-body{padding:14px 18px;flex:1;}' +
      '#bwn-pc-ft{padding:12px 18px;border-top:1px solid #e2e8e5;display:flex;gap:8px;justify-content:flex-end;}' +
      '.bwn-pc-btn{padding:8px 14px;border-radius:8px;border:1px solid #c6d2cc;background:#f4f7f5;color:#12241b;cursor:pointer;font:500 13px inherit;}' +
      '.bwn-pc-btn.primary{background:#1a5f3e;border-color:#1a5f3e;color:#fff;}' +
      '.bwn-pc-btn:disabled{opacity:.55;cursor:default;}' +
      '.bwn-pc-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;}' +
      '.bwn-pc-table th,.bwn-pc-table td{border-bottom:1px solid #e2e8e5;padding:5px 6px;text-align:left;}' +
      '.bwn-pc-warn{background:#fdf4e3;border:1px solid #f0dcb4;color:#8a5a00;border-radius:6px;padding:7px 9px;font-size:12px;margin-top:8px;}' +
      '.bwn-pc-err{background:#fef0ee;border:1px solid #f7c9c9;color:#8b1a1a;border-radius:6px;padding:8px 10px;font-size:12.5px;margin-top:8px;}' +
      '.bwn-pc-ok{background:#eef8f1;border:1px solid #bfe3cc;color:#0d3d26;border-radius:6px;padding:8px 10px;font-size:12.5px;margin-top:8px;}' +
      '@media (prefers-reduced-motion:reduce){#bwn-pc-overlay,#bwn-pc-card{transition:none;}}';
    document.head.appendChild(st);
  }
  function drawerDismiss(el) {
    try { el.remove(); } catch (e) { }
  }
  function closeDrawer() {
    if (!openEl) return;
    document.removeEventListener('keydown', onKeyClose);
    drawerDismiss(openEl);
    openEl = null; pcState = null;
  }
  function onKeyClose(e) { if (e.key === 'Escape') closeDrawer(); }
  // Suite bus: announce so a real Core drawer yields the slot, and yield ourselves if
  // another suite tool opens (same contract bwn-dispatch's drawer follows).
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:drawer:open' && d.key !== DRAWER_KEY) closeDrawer();
    });
  } catch (e) { }

  function renderError(hd, body, msg) {
    var s = hd.querySelector('.s'); if (s) s.textContent = 'error';
    body.innerHTML = '';
    var e = document.createElement('div'); e.className = 'bwn-pc-err'; e.textContent = msg;
    body.appendChild(e);
  }

  function openDrawer(sourceProposalId) {
    if (sourceProposalId == null) return;
    if (openEl) closeDrawer();
    ensurePcStyle();
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: DRAWER_KEY } })); } catch (e) { }

    var overlay = document.createElement('div');
    overlay.id = 'bwn-pc-overlay';
    var card = document.createElement('div');
    card.id = 'bwn-pc-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Copy proposal to another work order');
    overlay.appendChild(card);

    var hd = document.createElement('div');
    hd.innerHTML = '<div><div class="t">Copy proposal to another WO</div><div class="s">loading source proposal…</div></div>';
    hd.id = 'bwn-pc-hd';
    var x = document.createElement('button');
    x.id = 'bwn-pc-x'; x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', closeDrawer);
    hd.appendChild(x);
    card.appendChild(hd);

    var body = document.createElement('div'); body.id = 'bwn-pc-body'; body.textContent = 'Loading…';
    card.appendChild(body);
    var ft = document.createElement('div'); ft.id = 'bwn-pc-ft';
    card.appendChild(ft);

    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeDrawer(); });
    document.addEventListener('keydown', onKeyClose);
    openEl = overlay;

    var sourceWoNumber = woNumberFromUrl();
    pcState = { hasToken: !!pcAuthToken(), source: null, sourceWo: null, target: null };

    Promise.all([
      pcGql('ClientProposalDetails', Q_PROPOSAL_DETAILS, { proposalId: sourceProposalId }),
      sourceWoNumber ? pcGql('ProposalWO', Q_PROPOSAL_WO, { workOrderNumber: sourceWoNumber }) : Promise.resolve(null)
    ]).then(function (res) {
      if (openEl !== overlay) return;   // closed while loading
      var sourceData = res[0] && res[0].proposal;
      var woData = res[1] && res[1].job;
      if (!sourceData) { renderError(hd, body, 'Could not load the source proposal.'); return; }
      pcState.source = sourceData;
      pcState.sourceWo = woData;
      renderLoaded(overlay, hd, body, ft, sourceData, woData, sourceProposalId);
    }).catch(function (err) {
      if (openEl !== overlay) return;
      renderError(hd, body, 'Could not load the source proposal (' + ((err && err.message) || err) + ').');
    });
  }

  function renderLoaded(overlay, hd, body, ft, source, sourceWo, sourceProposalId) {
    var s = hd.querySelector('.s');
    if (s) s.textContent = 'Proposal #' + (source.number != null ? source.number : sourceProposalId);
    body.innerHTML = '';

    var summary = document.createElement('div');
    summary.innerHTML =
      '<div style="font-size:13px;line-height:1.6;">' +
      '<div><strong>Type:</strong> ' + escapeHtml(source.type && source.type.name) + '</div>' +
      '<div><strong>Description:</strong> ' + escapeHtml(source.description || '-') + '</div>' +
      '<div><strong>Total:</strong> ' + fmtMoney(source.subtotal) + '</div>' +
      '</div>';
    body.appendChild(summary);

    var items = source.proposalLineItems || [];
    var tbl = document.createElement('table'); tbl.className = 'bwn-pc-table';
    tbl.innerHTML = '<thead><tr><th>Description</th><th>Qty</th><th>Unit charge</th></tr></thead>';
    var tb = document.createElement('tbody');
    items.forEach(function (li) {
      var tr = document.createElement('tr');
      tr.innerHTML = '<td>' + escapeHtml(li.description || li.item || '') + '</td>' +
        '<td>' + escapeHtml(li.quantity) + '</td>' +
        '<td>' + fmtMoney(li.unitCharge) + '</td>';
      tb.appendChild(tr);
    });
    tbl.appendChild(tb);
    body.appendChild(tbl);

    // ---- target picker ------------------------------------------------------
    var pickWrap = document.createElement('div');
    pickWrap.style.cssText = 'margin-top:14px;border-top:1px solid #e2e8e5;padding-top:12px;';
    pickWrap.innerHTML = '<div style="font-weight:600;font-size:12.5px;margin-bottom:6px;">Copy to</div>';
    body.appendChild(pickWrap);

    var sel = document.createElement('select');
    sel.style.cssText = 'width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #c6d2cc;border-radius:7px;font:400 13px inherit;margin-bottom:8px;';
    sel.innerHTML = '<option value="">Loading open work orders…</option>';
    pickWrap.appendChild(sel);

    var freeWrap = document.createElement('div');
    freeWrap.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:4px;';
    var freeLbl = document.createElement('span'); freeLbl.textContent = 'or WO #:'; freeLbl.style.cssText = 'font-size:12px;color:#5b6b8c;';
    var freeInput = document.createElement('input'); freeInput.type = 'text'; freeInput.placeholder = 'e.g. 8002';
    freeInput.style.cssText = 'flex:1;padding:6px 9px;border:1px solid #c6d2cc;border-radius:7px;font:400 13px inherit;';
    freeWrap.appendChild(freeLbl); freeWrap.appendChild(freeInput);
    pickWrap.appendChild(freeWrap);

    var warnEl = document.createElement('div'); pickWrap.appendChild(warnEl);
    var verifyStatus = document.createElement('div');
    verifyStatus.style.cssText = 'font-size:11.5px;color:#5b6b8c;margin-top:4px;';
    pickWrap.appendChild(verifyStatus);

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button'; cancelBtn.className = 'bwn-pc-btn'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', closeDrawer);
    var confirmBtn = document.createElement('button');
    confirmBtn.type = 'button'; confirmBtn.className = 'bwn-pc-btn primary'; confirmBtn.textContent = 'Copy proposal';
    confirmBtn.disabled = true;
    ft.appendChild(cancelBtn); ft.appendChild(confirmBtn);

    function refreshConfirm() { confirmBtn.disabled = !confirmReady(pcState); }

    function setTarget(t) {
      // Guard against a stale async callback (a verify that started before this drawer was
      // closed, or before a NEW drawer replaced it): once openEl no longer IS this overlay,
      // pcState may be null (closed) or may belong to a different, currently-open drawer
      // (superseded) - either way, this call must touch NOTHING.
      if (openEl !== overlay) return;
      pcState.target = t;
      warnEl.innerHTML = '';
      if (t && sourceWo && sourceWo.locationId != null && t.locationId != null && t.locationId !== sourceWo.locationId) {
        var w = document.createElement('div'); w.className = 'bwn-pc-warn';
        w.textContent = 'This work order is at a different location than the source - double check this is intended (it is not blocked).';
        warnEl.appendChild(w);
      }
      refreshConfirm();
    }

    // Same-location open WOs (VERIFIED page/sortBy shape - see Core's pinned PagedWorkOrders
    // seed, [[umbrava-graphql-operations]]: page:{skip,take}, sortBy:[{columnName,direction}],
    // phase enum literal). Filtered through the pure pickerFilter helper (excludes the source WO).
    if (sourceWo && sourceWo.locationId != null) {
      pcGql('PagedWorkOrders', Q_LOCATION_OPEN_WOS, {
        page: { skip: 0, take: 100 },
        sortBy: [{ columnName: 'formattedJobNumber', direction: 'ASC' }],
        locationId: sourceWo.locationId,
        phase: 'Open'
      }).then(function (d) {
        var list = (d && d.listWorkOrdersPaginated && d.listWorkOrdersPaginated.items) || [];
        var filtered = pickerFilter(list, sourceWo.locationId, sourceWo.number);
        sel.innerHTML = '';
        var blank = document.createElement('option');
        blank.value = '';
        blank.textContent = filtered.length ? 'Choose an open work order…' : 'No other open WOs at this location';
        sel.appendChild(blank);
        filtered.forEach(function (w) {
          var o = document.createElement('option');
          o.value = String(w.number);
          o.textContent = 'W-' + w.number + (w.scopeOfWork ? ' - ' + String(w.scopeOfWork).slice(0, 40) : '');
          sel.appendChild(o);
        });
      }).catch(function () {
        sel.innerHTML = '<option value="">Could not load open work orders - use the WO # field</option>';
      });
    } else {
      sel.innerHTML = '<option value="">Source location unknown - use the WO # field</option>';
    }

    sel.addEventListener('change', function () {
      if (!sel.value) { setTarget(null); verifyStatus.textContent = ''; return; }
      freeInput.value = sel.value;
      verifyTarget(sel.value);
    });

    var freeTimer = null;
    freeInput.addEventListener('input', function () {
      if (freeTimer) clearTimeout(freeTimer);
      var v = freeInput.value.trim();
      if (!v) { setTarget(null); verifyStatus.textContent = ''; return; }
      freeTimer = setTimeout(function () { verifyTarget(v); }, 450);
    });

    // The free WO-number field is ALWAYS re-verified live via Q_PROPOSAL_WO before Confirm
    // can enable - confirmReady requires target.id, which only a real read supplies.
    function verifyTarget(numStr) {
      var n = parseInt(numStr, 10);
      if (!isFinite(n)) { setTarget(null); verifyStatus.textContent = 'Not a valid WO number.'; return; }
      verifyStatus.textContent = 'Verifying W-' + n + '…';
      pcGql('ProposalWO', Q_PROPOSAL_WO, { workOrderNumber: n }).then(function (d) {
        // Same guard as setTarget: this request may resolve after the drawer that started
        // it closed (or was replaced by a new one) - a stale response must update nothing,
        // not even the status line, and must never reach into a (possibly null, possibly
        // reassigned-to-another-drawer) pcState.
        if (openEl !== overlay) return;
        var job = d && d.job;
        if (!job || job.number == null || job.id == null) { verifyStatus.textContent = 'W-' + n + ' was not found.'; setTarget(null); return; }
        verifyStatus.textContent = 'Target: W-' + job.number + (job.locationName ? ' - ' + job.locationName : '');
        setTarget(job);
      }).catch(function (err) {
        if (openEl !== overlay) return;   // drawer closed/superseded - nothing left to update
        verifyStatus.textContent = 'Could not verify W-' + n + ' (' + ((err && err.message) || err) + ').';
        setTarget(null);
      });
    }

    confirmBtn.addEventListener('click', function () {
      pcState.hasToken = !!pcAuthToken();   // re-check - the drawer may have sat open a while
      if (!confirmReady(pcState)) { refreshConfirm(); return; }
      runCopy(body, confirmBtn, cancelBtn, sourceProposalId, pcState.target);
    });

    refreshConfirm();
  }

  function runCopy(body, confirmBtn, cancelBtn, sourceProposalId, target) {
    confirmBtn.disabled = true; cancelBtn.disabled = true;
    confirmBtn.textContent = 'Copying…';
    var progress = document.createElement('div');
    progress.className = 'bwn-pc-warn';
    progress.textContent = 'Copying proposal to W-' + target.number + '…';
    body.appendChild(progress);
    copyProposal(sourceProposalId, target.number, {}).then(function (r) {
      if (r && r.ok) {
        pcToast('Copied to W-' + target.number + ' as a new Draft proposal.');
        // UNVERIFIED: the exact Proposals-TAB deep-link shape (query/hash param). The bare
        // WO route below is proven (onProposalPage's own match); landing on the Proposals
        // tab specifically is not confirmed - the operator may need one extra click there.
        var link = '/work-orders/' + target.number;
        progress.className = 'bwn-pc-ok';
        progress.innerHTML = 'Done - <a href="' + link + '" style="color:#0d3d26;font-weight:600;">open W-' + target.number + '</a> and check its Proposals tab.';
        confirmBtn.textContent = 'Copied';
        setTimeout(closeDrawer, 3000);
      } else {
        confirmBtn.disabled = false; cancelBtn.disabled = false;
        confirmBtn.textContent = 'Retry';
        progress.className = 'bwn-pc-err';
        progress.textContent = 'Copy failed at "' + ((r && r.stage) || 'unknown') + '": ' + ((r && r.error) || 'unknown error');
      }
    }).catch(function (err) {
      confirmBtn.disabled = false; cancelBtn.disabled = false;
      confirmBtn.textContent = 'Retry';
      progress.className = 'bwn-pc-err';
      progress.textContent = 'Copy failed: ' + ((err && err.message) || err);
    });
  }

  // ---- injection lifecycle: rank-gated, idempotent, SPA-nav aware ----------
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:role') injectRowButtons();
    });
  } catch (e) { }
  try {
    var pcObs = new MutationObserver(function () { injectRowButtons(); });
    pcObs.observe(document.body, { childList: true, subtree: true });
  } catch (e) { }
  var _pcLastPath = location.pathname;
  setInterval(function () {
    if (location.pathname !== _pcLastPath) _pcLastPath = location.pathname;
    injectRowButtons();
  }, 900);
  injectRowButtons();

})();
