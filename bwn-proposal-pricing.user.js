// ==UserScript==
// @name         BWN Proposal Pricing Assistant (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.2.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-proposal-pricing.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-proposal-pricing.user.js
// @description  Turn a work order's vendor quote into a priced, categorized client proposal WITH a full explanation of how each price was derived - crew size read from the vendor's own line text, the contracted-rate ladder, why a line is left at cost or flagged under water, and the read (never recomputed) GP basis. Coordinator-visible; read-only in this release (no writes, no per-user AI keys). @grant none.
// @match        https://app.umbrava.com/*
// @match        https://*.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.2.0';   // keep in step with @version
  console.info('[BWN PROPOSAL PRICING] v' + VER + ' - price a vendor quote into a client proposal with a full pricing explanation (read-only)');

  // ===== auth + gql =========================================================
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

  // Same-origin GraphQL wrapper (proposal-copy's pcGql shape; renamed ppGql). This release READS
  // only - the port's write leg (createDraftProposal / updateProposalV2) is deferred and will land
  // gated OFF behind a flag with the BWN-PERM + BWN-OPS blocks, matching bwn-proposal-copy.
  function ppGql(op, query, variables) {
    var tok = authToken();
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

  // ===== rank read (coordinators and above) =================================
  // bwn-suite-ai is the sole producer of `rank` (server-computed ladder: 1 coordinator, 3
  // supervisor, 4 manager, 5 director), published to the bwn:role bus + bwn:role:last slot. We read
  // only. View/price floor is rank>=1; the future write leg will gate separately at rank>=4 +
  // bwnCan('WorkOrderProposal.AddNew'), so a coordinator sees the pricing explanation without any
  // write surface existing.
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
  var MIN_RANK = 1;   // coordinators and above (view + price; read-only)
  function gated() { return typeof rank() === 'number' && rank() >= MIN_RANK; }

  // ===== small helpers ======================================================
  function woNumberFromUrl() {
    var m = String(location.pathname || '').match(/\/work-orders\/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }
  function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtMoney(money) {
    if (!money || money.amount == null) return '-';
    var precision = (money.precision != null) ? money.precision : 2;
    return '$' + (Number(money.amount) / Math.pow(10, precision)).toFixed(2);
  }

  // ===== ops (read; Phase 1 subset) =========================================
  // The engine's full 11-op set (quotes+lineItems, proposals+lineItems, listClientRates,
  // rateMatches, costCategories, ...) lands in Phase 1b with the pricing engine. This scaffold
  // loads the client proposal itself to prove the auth+gql+drawer path end to end.
  var Q_PROPOSAL_DETAILS = 'query ClientProposalDetails($proposalId: Int!) { proposal(id: $proposalId) { id number description scopeOfWork jobId type { id name } status { id name } subtotal { amount currency precision } proposalLineItems { id category quantity unitOfMeasurement item description unitCost { amount currency precision } unitCharge { amount currency precision } } } }';

  // ===== row discovery (shared with bwn-proposal-copy; same route + row shape) ==============
  var MENU_ITEM_CLASS = 'bwn-pp-menu-item';   // our injected "Price this quote" <li>
  function onClientProposalsList() {
    // LIST route ONLY - matches proposal-copy's anchor. Subroutes (/<id>/details, /notes) render
    // the same MUI grid and must fail closed, so the price entry never reads a note id as a proposal.
    return /\/work-orders\/\d+\/proposals\/client-proposals\/?$/.test(location.pathname || '');
  }
  function proposalIdFromRow(row) {
    var m = /table-row-(\d+)/.exec((row && row.id) || '');
    return m ? parseInt(m[1], 10) : null;
  }
  var _ppPendingPid = null, _ppPendingAt = 0;
  var PP_PENDING_TTL_MS = 4000;

  // (1) Record the row's proposal id the instant its kebab is clicked - capture phase. Gated +
  // route-scoped; never guesses a row.
  try {
    document.addEventListener('click', function (e) {
      try {
        if (!onClientProposalsList() || !gated()) return;
        var t = e.target;
        var wrap = t && t.closest ? t.closest('.context-menu-wrapper') : null;
        if (!wrap) return;
        var row = wrap.closest ? wrap.closest('tr[id^="table-row-"]') : null;
        if (!row) return;
        var pid = proposalIdFromRow(row);
        if (pid != null) { _ppPendingPid = pid; _ppPendingAt = Date.now(); }
      } catch (err) { }
    }, true);
  } catch (e) { }

  function isProposalActionsMenu(menu) {
    var txt = (menu && menu.textContent) || '';
    return /View Audit/i.test(txt) || /Convert to Invoice/i.test(txt) || /Work Order Notes/i.test(txt);
  }
  function closeActionsMenu() {
    // The MUI menu trusts only real events (measured live 2026-08-19), so hide its portal node and
    // let React unmount it on the user's next interaction. Same handling as proposal-copy.
    try {
      var menu = document.querySelector('ul[role="menu"]');
      if (!menu) return;
      var node = menu;
      while (node.parentElement && node.parentElement !== document.body) node = node.parentElement;
      node.style.display = 'none';
    } catch (e) { }
  }
  // (2) Add our "Price this quote" item to a freshly opened actions menu. Idempotent. Sits beside
  // proposal-copy's "Copy to another WO..." (different class, both re-inject per open).
  function injectMenuItem(menu) {
    if (!menu || !gated() || !onClientProposalsList()) return;
    if (_ppPendingPid == null || (Date.now() - _ppPendingAt) > PP_PENDING_TTL_MS) return;
    if (!isProposalActionsMenu(menu)) return;
    var pid = _ppPendingPid;
    var existing = menu.querySelector('.' + MENU_ITEM_CLASS);
    if (existing) { if (existing.getAttribute('data-pid') === String(pid)) return; existing.remove(); }
    var sib = menu.querySelector('li[role="menuitem"]:not(.Mui-disabled), a[role="menuitem"]');
    var li = document.createElement('li');
    li.className = (sib ? sib.className : 'MuiButtonBase-root MuiMenuItem-root MuiMenuItem-gutters') + ' ' + MENU_ITEM_CLASS;
    li.setAttribute('role', 'menuitem');
    li.setAttribute('tabindex', '-1');
    li.setAttribute('data-pid', String(pid));
    li.style.gap = '8px';
    li.title = 'Price this proposal from the WO vendor quote, with a full explanation';
    // Feather "dollar-sign" icon + label. Static markup (no user data); label via textContent.
    li.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto" aria-hidden="true"><line x1="12" y1="1" x2="12" y2="23"></line><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"></path></svg><span></span>';
    var span = li.querySelector('span'); if (span) span.textContent = 'Price this quote…';
    li.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      closeActionsMenu();
      openDrawer(pid);
    });
    var first = menu.querySelector('li[role="menuitem"],a[role="menuitem"]');
    if (first && first.nextSibling) menu.insertBefore(li, first.nextSibling);
    else menu.appendChild(li);
  }
  function scanMenus() {
    Array.prototype.forEach.call(document.querySelectorAll('ul[role="menu"]'), function (m) {
      try { injectMenuItem(m); } catch (e) { }
    });
  }

  // ===== drawer shell (self-contained; own DRAWER_KEY so it mutually yields with the copy drawer) =
  var DRAWER_KEY = 'proposal-price';
  var openEl = null;
  function ensurePpStyle() {
    if (document.getElementById('bwn-pp-style')) return;
    var st = document.createElement('style');
    st.id = 'bwn-pp-style';
    st.textContent =
      '#bwn-pp-overlay{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;' +
      'background:rgba(9,30,66,.45);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Helvetica Neue",Arial,sans-serif;}' +
      '#bwn-pp-card{width:560px;max-width:94vw;max-height:88vh;overflow:auto;background:#fff;border-radius:12px;' +
      'box-shadow:0 20px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;color:#12241b;}' +
      '#bwn-pp-hd{padding:14px 18px;border-radius:12px 12px 0 0;background:linear-gradient(135deg,#1a5f3e,#0d3d26);color:#fff;display:flex;align-items:flex-start;gap:10px;}' +
      '#bwn-pp-hd .t{font:600 15px inherit;}' +
      '#bwn-pp-hd .s{font:500 11px ui-monospace,"Segoe UI Mono","SF Mono",monospace;color:rgba(255,255,255,.75);margin-top:2px;}' +
      '#bwn-pp-x{margin-left:auto;flex:none;background:rgba(255,255,255,.14);border:none;border-radius:6px;color:#fff;width:26px;height:26px;cursor:pointer;font-size:16px;line-height:1;}' +
      '#bwn-pp-body{padding:14px 18px;flex:1;}' +
      '.bwn-pp-table{width:100%;border-collapse:collapse;font-size:12px;margin-top:8px;}' +
      '.bwn-pp-table th,.bwn-pp-table td{border-bottom:1px solid #e2e8e5;padding:5px 6px;text-align:left;}' +
      '.bwn-pp-warn{background:#fdf4e3;border:1px solid #f0dcb4;color:#8a5a00;border-radius:6px;padding:7px 9px;font-size:12px;margin-top:8px;}' +
      '.bwn-pp-err{background:#fef0ee;border:1px solid #f7c9c9;color:#8b1a1a;border-radius:6px;padding:8px 10px;font-size:12.5px;margin-top:8px;}' +
      '.bwn-pp-note{background:#eef3fb;border:1px solid #cfe0f5;color:#264a7a;border-radius:6px;padding:8px 10px;font-size:12.5px;margin-top:8px;}';
    document.head.appendChild(st);
  }
  function ppRemoveDrawer(el) { try { el.remove(); } catch (e) { } }
  function closeDrawer() {
    if (!openEl) return;
    document.removeEventListener('keydown', onKeyClose);
    ppRemoveDrawer(openEl);
    openEl = null;
  }
  function onKeyClose(e) { if (e.key === 'Escape') closeDrawer(); }
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:drawer:open' && d.key !== DRAWER_KEY) closeDrawer();
    });
  } catch (e) { }

  function renderError(hd, body, msg) {
    var s = hd.querySelector('.s'); if (s) s.textContent = 'error';
    body.innerHTML = '';
    var e = document.createElement('div'); e.className = 'bwn-pp-err'; e.textContent = msg;
    body.appendChild(e);
  }

  function openDrawer(sourceProposalId) {
    if (sourceProposalId == null) return;
    if (openEl) closeDrawer();
    ensurePpStyle();
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: DRAWER_KEY } })); } catch (e) { }

    var overlay = document.createElement('div');
    overlay.id = 'bwn-pp-overlay';
    var card = document.createElement('div');
    card.id = 'bwn-pp-card';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-label', 'Price this quote');
    overlay.appendChild(card);

    var hd = document.createElement('div');
    hd.id = 'bwn-pp-hd';
    hd.innerHTML = '<div><div class="t">Proposal Pricing Assistant</div><div class="s">loading proposal…</div></div>';
    var x = document.createElement('button');
    x.id = 'bwn-pp-x'; x.type = 'button'; x.textContent = '×'; x.setAttribute('aria-label', 'Close');
    x.addEventListener('click', closeDrawer);
    hd.appendChild(x);
    card.appendChild(hd);

    var body = document.createElement('div'); body.id = 'bwn-pp-body'; body.textContent = 'Loading…';
    card.appendChild(body);

    document.body.appendChild(overlay);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeDrawer(); });
    document.addEventListener('keydown', onKeyClose);
    openEl = overlay;

    if (!authToken()) { renderError(hd, body, 'Not signed in to Umbrava (no live token). Open this from an Umbrava tab where you are logged in.'); return; }

    ppGql('ClientProposalDetails', Q_PROPOSAL_DETAILS, { proposalId: sourceProposalId }).then(function (res) {
      if (openEl !== overlay) return;   // closed while loading
      var p = res && res.proposal;
      if (!p) { renderError(hd, body, 'Could not load proposal #' + sourceProposalId + '.'); return; }
      renderLoaded(hd, body, p, sourceProposalId);
    }).catch(function (err) {
      if (openEl !== overlay) return;
      renderError(hd, body, 'Could not load the proposal (' + ((err && err.message) || err) + ').');
    });
  }

  // renderLoaded: the drawer opened on a client proposal row. We already read the proposal (p) for
  // context; now drive the PRICING off the WO's own vendor quote(s). Loads WO -> POs -> quotes ->
  // rate card -> rate matches, prices the lines, and renders the priced table + reasoning + panels.
  function renderLoaded(hd, body, p, pid) {
    var s = hd.querySelector('.s');
    if (s) s.textContent = 'Proposal #' + (p.number != null ? p.number : pid) + ' - loading vendor quote…';
    body.innerHTML = '';
    var note = document.createElement('div');
    note.className = 'bwn-pp-note';
    note.textContent = 'Reading the work order’s vendor quote(s), the contracted rate card, and rate matches…';
    body.appendChild(note);

    var woNum = woNumberFromUrl();
    if (woNum == null) { renderError(hd, body, 'Could not read the work order number from the URL.'); return; }

    loadPricing(woNum, p).then(function () {
      if (openEl == null) return;   // closed while loading
      renderPriced(hd, body, p);
    }).catch(function (err) {
      if (openEl == null) return;
      renderError(hd, body, 'Could not load the vendor quote (' + ((err && err.message) || err) + ').');
    });
  }

  // =========================================================================================
  //  PP-ENGINE START (pure pricing engine; sliced by scripts/test-proposal-pricing.js)
  // =========================================================================================
  //  Ported from Proposal_Pricing_Assistant_3.html (v4.4.0). Money / GP / rate arithmetic is
  //  byte-for-byte with the standalone. The ONLY adaptations, none of which touch an arithmetic
  //  line, are:
  //    (a) DOM input reads $('cv') / $('pv') / $('default-tax')  ->  drawer state S.cpct / S.prm /
  //        S.defTax, all defaulting to 0 (the drawer exposes no markup/premium/tax field).
  //    (b) getGPTarget() returns the constant GP_TARGET (the standalone read getConfig()/CFG,
  //        which do not exist in the drawer).
  //    (c) applyRateMatch / setRateMatchQty / setRateMatchChoice drop their trailing DOM re-render
  //        + toast + snapshot/autoSave side-effects; the drawer's caller re-renders. The item /
  //        row mutations are verbatim.
  //  Everything else is a straight paste. This block references no DOM, network, or render symbol,
  //  so the node harness can run it standalone.

  var GP_TARGET = 0.33;                       // standalone default (CFG.gpTarget)
  function getGPTarget(){ return GP_TARGET; } // adapted: no getConfig()/CFG in the drawer

  // Drawer-local state, analogous to the standalone's global S.
  var S = {
    items: [], rates: [], clientRates: null, rateMatch: null, wo: null, scopeFlags: null,
    cpct: 0, prm: 0, defTax: 0,
    pricingGuidance: null, riskScore: null,
    protections: { included: '', excluded: '', assumptions: '' },
    approval: { status: 'pending' }, photoAnalysis: null, scopeNarrative: ''
  };
  function resetEngineState(){
    S.items = []; S.rates = []; S.clientRates = null; S.rateMatch = null; S.wo = null;
    S.scopeFlags = null; S.cpct = 0; S.prm = 0; S.defTax = 0;
    S.pricingGuidance = null; S.riskScore = null;
    S.protections = { included: '', excluded: '', assumptions: '' };
    S.approval = { status: 'pending' }; S.photoAnalysis = null; S.scopeNarrative = '';
    markDirty();
  }

  // esc/fmt — copied verbatim so the sliced engine is self-contained (the shell keeps its own
  // escapeHtml/fmtMoney for the pre-load error path; identical behaviour, different scope).
  var esc = function(s){ return String(s == null ? '' : s).replace(/[&<>"']/g, function(c){ return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]; }); };
  var fmt = function(n){ return '$' + Number(n||0).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); };

  // Cost categories — the COMPLETE live list (18). Verbatim. Other is 7 (not 3), 3 is Recycling,
  // Shipping is 6 (not 7).
  var CAT_LABEL = {
    0:'Labor',          1:'Material',      2:'Equipment',   3:'Recycling',
    4:'Travel',         5:'Management Fee',6:'Shipping',     7:'Other',
    8:'Tax',            9:'Regular Rate', 10:'Overtime Rate',11:'Premium Rate',
   12:'Emergency Rate',13:'Labor And Material',14:'Adjustment',15:'Discount',
   16:'Credit/Debit',  17:'Permit'
  };
  var CAT_ID = Object.fromEntries(Object.entries(CAT_LABEL).map(function(e){ return [e[1], Number(e[0])]; }));
  CAT_ID.Materials = 1;  // the pricing engine pluralises this one

  var PROPOSAL_STATE = {0:'Draft', 1:'Submitted', 2:'Approved', 3:'Rejected', 4:'Canceled'};

  // Money: minor units in, dollars out — and back again. Divide by 10^precision ONCE. Verbatim.
  var umbMoney   = function(m){ return (m && typeof m.amount === 'number') ? m.amount / Math.pow(10, m.precision != null ? m.precision : 2) : 0; };
  var umbMoneyIn = function(dollars, currency, precision){
    currency = currency === undefined ? 'USD' : currency;
    precision = precision === undefined ? 2 : precision;
    return {amount: Math.round(Number(dollars || 0) * Math.pow(10, precision)), currency: currency, precision: precision};
  };

  // ── single-item pricing. Verbatim. The _clientUnitRate manual-override path (rate * qty) is how a
  //    contracted rate prices a line while the vendor cost survives.
  function getRate(trade){return S.rates.find(function(r){return r.trade===trade;}) || S.rates.find(function(r){return r.trade==='All';}) || null;}
  function calcItem(item){
    if(item._clientUnitRate !== undefined){
      const cp  = item._clientUnitRate * (item.qty||1);
      const mg  = cp - (item.vendorTotal||0);
      const mgp = cp > 0 ? (mg/cp)*100 : 0;
      return {...item, clientPrice:cp, rateLabel:'manual override', margin:mg, marginPct:mgp};
    }
    if(item.subItems?.length){
      const cp = item.subItems.reduce((s,si)=>s+si.total,0);
      const mg = cp - item.vendorTotal, mgp = cp>0?(mg/cp)*100:0;
      const cats = [...new Set(item.subItems.map(si=>si.category))].join('+');
      return {...item, clientPrice:cp, rateLabel:cats, margin:mg, marginPct:mgp};
    }
    const rate = getRate(item.trade);
    if(!rate) return {...item, clientPrice:item.vendorTotal, rateLabel:'No rate', margin:0, marginPct:0};
    let cp, rl;
    switch(rate.type){
      case'markup':        cp = item.vendorTotal*(1+rate.value/100); rl=`+${rate.value}% total`; break;
      case'markup_labor':  cp = (item.labor*(1+rate.value/100))+item.materials; rl=`+${rate.value}% labor`; break;
      case'markup_materials': cp = item.labor+(item.materials*(1+rate.value/100)); rl=`+${rate.value}% mat.`; break;
      case'flat_hour':     cp = item.labor*rate.value+item.materials; rl=`${fmt(rate.value)}/hr`; break;
      case'flat_unit':     cp = (item.qty||1)*rate.value; rl=`${fmt(rate.value)}/${item.unit||'unit'}`; break;
      default:             cp = item.vendorTotal; rl='—';
    }
    const mg = cp - item.vendorTotal, mgp = cp>0 ? (mg/cp)*100 : 0;
    return {...item, clientPrice:cp, rateLabel:rl, margin:mg, marginPct:mgp};
  }

  // ── calc cache
  let _calcCache = null;
  let _calcDirty = true;
  function markDirty(){ _calcDirty = true; }

  // ── flatten S.items into display rows. Verbatim except $('default-tax') -> S.defTax.
  function getProposalRows(){
    const rows = [];
    const defTax = Number(S.defTax)||0;   // adapted from parseFloat($('default-tax')?.value)||0
    S.items.forEach(item=>{
      if(item.subItems?.length){
        item.subItems.forEach((si,idx)=>{
          const qty    = parseFloat(si.qty)||1;
          const uRate  = parseFloat(si.unitRate)||0;
          const sub    = parseFloat(si.total)||(qty*uRate);
          const taxPct = si.taxPct!=null ? si.taxPct : (si.taxable===false ? 0 : defTax);
          const taxAmt = sub*(taxPct/100);
          const cat    = si.category||'Labor';
          const parentTotal = item.vendorTotal||0;
          const parentSub   = (item.subItems||[]).reduce((s,x)=>s+(x.total||0),0)||1;
          const vendorShare = parentTotal * (sub/parentSub);
          const markupPct   = vendorShare>0 ? ((sub-vendorShare)/vendorShare*100) : 0;
          rows.push({
            _itemId:item.id, _subIdx:idx, _fromSub:true,
            id:`${item.id}_${idx}`,
            category:cat,
            trade:item.trade,
            item:si.clientDescription||si.description||item.clientDescription,
            tripNum:si.tripNum||'',
            uom:si.unit||'ea',
            chargeQty:qty,
            unitCharge:uRate,
            _item:item,
            subtotal:sub,
            vendorCost:vendorShare,
            markupPct,
            taxable:si.taxable!==false,
            taxPct,
            taxAmt,
            totalCharge:sub+taxAmt,
            scopeFlag:S.scopeFlags?.[item.id]
          });
        });
      } else {
        const ci = calcItem(item);
        const sub = ci.clientPrice;
        const unitCharge = item._clientUnitRate !== undefined
          ? item._clientUnitRate
          : sub / (item.qty||1);
        const taxPct = item.taxPct!=null ? item.taxPct : (item.taxable===false ? 0 : defTax);
        const taxAmt = sub*(taxPct/100);
        const cat = item._catRaw
          ? ({labor:'Labor',material:'Material',materials:'Material',travel:'Travel',equipment:'Equipment',shipping:'Shipping'}[item._catRaw.toLowerCase()]||'Other')
          : 'Other';
        rows.push({
          _itemId:item.id, _subIdx:-1, _fromSub:false,
          id:item.id,
          category:cat,
          trade:item.trade,
          item:item.clientDescription,
          tripNum:item.tripNum||'',
          uom:item.unit||'ea',
          chargeQty:item.qty||1,
          _item:item,
          unitCharge,
          subtotal:sub,
          vendorCost:item.vendorTotal,
          markupPct:ci.marginPct,
          taxable:item.taxable!==false,
          taxPct,
          taxAmt,
          totalCharge:sub+taxAmt,
          scopeFlag:S.scopeFlags?.[item.id]
        });
      }
    });
    return rows;
  }

  // ── full proposal totals. GP basis is PRE-TAX: mg = subCharge - vS, mgp = mg/subCharge. The
  //    taxed pair (mgTaxed/mgpTaxed) is kept for reference only. Verbatim except the three DOM reads
  //    -> S.cpct / S.prm / S.defTax.
  function calcT(){
    const cpct = Number(S.cpct)||0;    // adapted from parseFloat($('cv')?.value)||0
    const prm  = Number(S.prm)||0;     // adapted from parseFloat($('pv')?.value)||0
    const defTax = Number(S.defTax)||0;// adapted from parseFloat($('default-tax')?.value)||0
    try{
      const key = cpct+'|'+prm+'|'+defTax+'|'+S.items.length+'|'+S.items.map(i=>i.id+(i.subItems?.length||0)+(i.vendorTotal||0)).join(',');
      if(!_calcDirty && _calcCache && _calcCache._key===key) return _calcCache;
      _calcDirty = false;
    }catch(e){}

    const items = S.items.map(calcItem);
    const vS = items.reduce((s,i)=>s+i.vendorTotal, 0);
    const cS = items.reduce((s,i)=>s+i.clientPrice, 0);
    const rows = getProposalRows();
    const taxTotal = rows.reduce((s,r)=>s+r.taxAmt, 0);
    const totalCharge = rows.reduce((s,r)=>s+r.totalCharge, 0);
    S.cpct = cpct; S.prm = prm;
    const adj = cS*(cpct/100) + prm;

    const subCharge = cS + adj;          // client revenue, PRE-TAX
    const cT        = totalCharge + adj; // client total, tax included

    const mg  = subCharge - vS;
    const mgp = subCharge > 0 ? (mg/subCharge)*100 : 0;
    const mgTaxed  = cT - vS;
    const mgpTaxed = cT > 0 ? (mgTaxed/cT)*100 : 0;

    const gpTarget  = getGPTarget();
    const targetCT  = vS > 0 ? vS/(1-gpTarget) : 0; // pre-tax subtotal to hit target
    const targetGap = targetCT - subCharge;

    const cats = {};
    rows.forEach(r=>{
      const grp = ['Labor','Material','Travel','Equipment','Shipping'].includes(r.category) ? r.category : 'All Other';
      cats[grp] = (cats[grp]||0) + r.subtotal;
    });
    cats['Tax'] = taxTotal;
    const key2 = cpct+'|'+prm+'|'+defTax+'|'+S.items.length+'|'+S.items.map(i=>i.id+(i.subItems?.length||0)+(i.vendorTotal||0)).join(',');
    _calcCache = {items, rows, vS, cS, taxTotal, adj, subCharge, cT, mg, mgp, mgTaxed, mgpTaxed,
                  targetCT, targetGap, targetGPPct:gpTarget*100, cats, _key:key2};
    return _calcCache;
  }

  // ── rate-match helpers. catOf/crewOf verbatim (lifted from runRateMatch's local consts).
  function catOf(it){
    if(it._catRaw && CAT_ID[it._catRaw] != null) return CAT_ID[it._catRaw];
    if(it.labor > 0 && !(it.materials > 0)) return CAT_ID.Labor;
    if(it.materials > 0 && !(it.labor > 0)) return CAT_ID.Material;
    return null; // mixed or unknown
  }
  function crewOf(it){
    const txt = [it.clientDescription, it.description, it._umbItem].filter(Boolean).join(' ');
    const m = txt.match(/(\d+)\s*(?:-|\s)?\s*(?:man|men|tech(?:s|nician|nicians)?|guy|guys|crew)\b/i)
           || txt.match(/crew\s*(?:of|size)?\s*(\d+)/i);
    const n = m ? Number(m[1]) : 0;
    return n > 0 && n < 20 ? n : 0;   // 0 = not stated
  }

  // The rateMatches() INPUT builder — verbatim. behavior Ranked (SingleBest returns nothing), never
  // a tradeId (zeroes the match), crewSize only when the vendor stated one, search only when set.
  function umbRateMatchInput(clientId, categoryId, opts){
    const o = opts || {};
    const input = {
      behavior:       'Ranked',
      direction:      'ClientBilling',
      targetTenantId: clientId,
      categoryId:     Number(categoryId),
      page:           {skip:0, take: o.take || 25}
    };
    if(o.locationId)        input.locationId = o.locationId;
    if(o.workOrderId)       input.workOrderId = Number(o.workOrderId);
    if(o.unitOfMeasurement) input.unitOfMeasurement = o.unitOfMeasurement;
    if(o.crewSize > 0)      input.crewSize = Number(o.crewSize);
    if(o.search)            input.search = String(o.search);
    return input;
  }

  // Assemble S.rateMatch from the per-key match results (byKey). The pure body of runRateMatch:
  // pairs each item with its category+crew suggestion, prices only when the arithmetic is defined
  // (real quantity), preserves vendor cost, and derives the constraints. Verbatim.
  function assembleRateMatch(items, byKey){
    const keyOf = it => { const c = catOf(it); return c == null ? null : c + '|' + crewOf(it); };
    const cats = [...new Set(items.map(catOf).filter(c => c != null))];
    const byCat = {};
    cats.forEach(c => {
      const merged = [];
      Object.entries(byKey).forEach(([k, m]) => {
        if(Number(k.split('|')[0]) !== c) return;
        (m.options || []).forEach(o => { if(!merged.some(x => x.id === o.id)) merged.push(o); });
      });
      byCat[c] = {suggested: null, rowCount: merged.length, options: merged};
    });

    const rows = items.map(it => {
      const cid = catOf(it);
      const m   = byKey[keyOf(it)] || null;
      const sug = m?.suggested || null;
      const crew = crewOf(it);
      const qty = Number(it.qty) || 1;
      const unitKnown  = !!(it.unit && String(it.unit).trim());
      const qtyKnown   = !!it._umbQtyKnown;
      const uomMismatch = !!(sug && unitKnown && sug.uom &&
                             String(it.unit).toLowerCase() !== String(sug.uom).toLowerCase());
      const needsQty = !!sug && !uomMismatch && !qtyKnown;
      return {
        itemId:      it.id,
        description: it.clientDescription || it.description || '',
        categoryId:  cid,
        category:    cid != null ? CAT_LABEL[cid] : '(none)',
        vendorCost:  it.vendorTotal || 0,
        qty,
        unit:        unitKnown ? it.unit : (sug?.uom || ''),
        unitKnown, qtyKnown, needsQty,
        crew,
        matched:     sug,
        chosenRateId:sug?.id || null,
        clientPrice: sug ? sug.rate * qty : null,
        uomMismatch,
        skip:        !sug || uomMismatch || needsQty
      };
    });

    const sellable   = rows.filter(r => !r.skip);
    const sellSub    = sellable.reduce((s,r) => s + r.clientPrice, 0)
                     + rows.filter(r => r.skip).reduce((s,r) => s + (r.vendorCost || 0), 0);
    const vendorCost = rows.reduce((s,r) => s + (r.vendorCost || 0), 0);
    const projectedGP = sellSub > 0 ? (sellSub - vendorCost) / sellSub : 0;

    const constraints = [];
    const noMatch = rows.filter(r => !r.matched);
    const badUom  = rows.filter(r => r.matched && r.uomMismatch);
    if(noMatch.length) constraints.push(noMatch.length + ' line(s) have no contracted rate for their category — left at vendor cost');
    if(badUom.length)  constraints.push(badUom.length + ' line(s) skipped: unit differs from the rate\'s unit of measurement');
    const needQty = rows.filter(r => r.needsQty);
    if(needQty.length) constraints.push(needQty.length + ' line(s) are lump sums — the vendor stated no unit or quantity, so enter the real quantity to price them at the contracted rate');
    const belowCost = rows.filter(r => !r.skip && r.clientPrice < (r.vendorCost || 0));
    if(belowCost.length) constraints.push('LOSS: ' + belowCost.length
      + ' line(s) price BELOW vendor cost at the contracted rate — '
      + fmt(belowCost.reduce((s,r) => s + ((r.vendorCost||0) - r.clientPrice), 0)) + ' under water');
    cats.forEach(c => {
      const inCat = rows.filter(r => r.categoryId === c);
      if(inCat.length && inCat.every(r => !r.matched)){
        constraints.push('No ' + (CAT_LABEL[c] || c) + ' rate is contracted for this client');
      }
    });

    return {
      source:      'umbrava',
      byCat, byKey, rows,
      projectedGP, gap: (getGPTarget() - projectedGP),
      canHitTarget: projectedGP >= getGPTarget() - 0.005,
      reasoning:   'Umbrava matched ' + sellable.length + ' of ' + rows.length
                 + ' line(s) to contracted rates across ' + cats.length + ' categor'
                 + (cats.length === 1 ? 'y' : 'ies') + '.',
      constraints
    };
  }

  // Supply a lump-sum line's quantity. Verbatim except the trailing rRateMatchPanel() DOM re-render
  // (the drawer's onchange handler re-renders).
  function setRateMatchQty(itemId, val){
    const rm = S.rateMatch;
    const row = rm?.rows?.find(r => r.itemId === itemId);
    if(!row) return;
    const q = Number(val);
    if(!(q > 0)){
      row.qty = 1; row.needsQty = true; row.skip = true; row.clientPrice = row.matched ? row.matched.rate : null;
    }else{
      row.qty = q;
      row.qtyKnown = true;
      row.needsQty = false;
      row.clientPrice = row.matched ? row.matched.rate * q : null;
      row.skip = !row.matched || row.uomMismatch;
      const it = S.items.find(i => i.id === itemId);
      if(it){ it.qty = q; it._umbQtyKnown = true; markDirty(); }
    }
    recomputeRateMatchProjection();
  }

  function recomputeRateMatchProjection(){
    const rm = S.rateMatch;
    if(!rm?.rows) return;
    const sellSub = rm.rows.reduce((s,r) => s + (r.skip ? (r.vendorCost||0) : (r.clientPrice||0)), 0);
    const cost    = rm.rows.reduce((s,r) => s + (r.vendorCost||0), 0);
    rm.projectedGP  = sellSub > 0 ? (sellSub - cost) / sellSub : 0;
    rm.gap          = getGPTarget() - rm.projectedGP;
    rm.canHitTarget = rm.projectedGP >= getGPTarget() - 0.005;
  }

  // Swap one line to a different contracted rate. Verbatim except the trailing DOM re-render.
  function setRateMatchChoice(itemId, rateId){
    const rm = S.rateMatch;
    const row = rm?.rows?.find(r => r.itemId === itemId);
    if(!row) return;
    const pick = (rm.byCat?.[row.categoryId]?.options || []).find(o => o.id === rateId);
    if(!pick) return;
    row.matched      = pick;
    row.chosenRateId = pick.id;
    row.uomMismatch  = !!(row.unitKnown && pick.uom &&
                          String(row.unit).toLowerCase() !== String(pick.uom).toLowerCase());
    if(!row.unitKnown) row.unit = pick.uom || row.unit;
    row.needsQty     = !row.uomMismatch && !row.qtyKnown;
    row.clientPrice  = pick.rate * (Number(row.qty) || 1);
    row.skip         = row.uomMismatch || row.needsQty;
    recomputeRateMatchProjection();
  }

  // Price the matched (non-skipped) rows IN PLACE via the manual-override path, so vendor cost
  // survives and GP stays the real pre-tax number. Verbatim item loop; the DOM/toast/snapshot/
  // autoSave side-effects are dropped (adaptation c). This is the canonical, test-covered apply.
  function applyRateMatch(){
    const rm = S.rateMatch;
    const rows = (rm?.rows || []).filter(r => !r.skip && r.matched);
    if(!rows.length) return;
    let applied = 0;
    rows.forEach(r => {
      const it = S.items.find(i => i.id === r.itemId);
      if(!it) return;
      it._clientUnitRate = r.matched.rate;   // per-unit charge; calcItem does rate * qty
      it.unit            = r.matched.uom || it.unit;
      it.rateLabel       = fmt(r.matched.rate) + '/' + (r.matched.uom || 'ea');
      it._umbRateId      = r.matched.id;
      it._umbRateItem    = r.matched.item;
      it._fromRateCard   = true;
      applied++;
    });
    S.rateMatch = null;
    markDirty();
  }

  // ── advisory panel MATH (pure). Ported verbatim from calcPricingGuidance / calcRiskScore /
  //    renderApprovalCard; the render, toast, autoSave and cross-calls are stripped and each returns
  //    its object. CFG.gpTarget -> GP_TARGET, CFG.approvalThreshold -> 10000. The risk mgp uses the
  //    taxed total (t.cT) exactly as the standalone does — it is a risk heuristic, not the GP banner.
  function calcPricingGuidancePure(){
    if(!S.items.length) return null;
    const t         = calcT();
    const vendorCost= t.vS || S.items.reduce((s,i)=>s+i.vendorTotal,0);
    const clientTotal= t.cT;
    const gpTarget  = GP_TARGET;

    const matPct     = vendorCost > 0 ? S.items.reduce((s,i)=>s+(i.materials||0),0)/vendorCost : 0;
    const flagCount  = S.items.filter(i=>i.materialBenchmark?.flagStatus==='flag').length;
    const lowConf    = S.items.filter(i=>i.materialBenchmark?.confidence==='low').length;
    const scopeWords = (S.wo?.description||'').toLowerCase();
    const isUrgent   = /urgent|emergency|asap|same.?day|after.?hours/.test(scopeWords);
    const hasLift    = /lift|bucket|aerial|boom|scaffold/.test(scopeWords+(S.photoAnalysis?.overallScope||''));
    const hasRateMatch= (S.clientRates||[]).length > 0;
    const trips      = Math.max(...S.items.map(i=>parseInt(i.tripNum)||0), 1);

    let riskMult = 0;
    if(matPct > 0.5)      riskMult += 0.03;
    if(flagCount > 0)     riskMult += flagCount * 0.02;
    if(lowConf > 0)       riskMult += 0.03;
    if(isUrgent)          riskMult += 0.05;
    if(hasLift)           riskMult += 0.04;
    if(!hasRateMatch)     riskMult += 0.02;
    if(trips > 2)         riskMult += (trips-2) * 0.01;

    const riskLabel = riskMult >= 0.10 ? 'high' : riskMult >= 0.05 ? 'medium' : 'low';

    const minGP  = Math.max(0.15, gpTarget - 0.05);
    const floor  = vendorCost / (1 - minGP);
    const target = (vendorCost / (1 - gpTarget)) * (1 + riskMult * 0.5);
    const stretch= target * (1 + riskMult + 0.05);

    const floorGP   = vendorCost>0 ? ((floor-vendorCost)/floor*100) : 0;
    const targetGP  = vendorCost>0 ? ((target-vendorCost)/target*100) : 0;
    const stretchGP = vendorCost>0 ? ((stretch-vendorCost)/stretch*100) : 0;
    const marginImpact = target - clientTotal;

    const reasons = [];
    if(isUrgent)      reasons.push('urgency premium');
    if(hasLift)       reasons.push('equipment/lift requirement');
    if(matPct > 0.5)  reasons.push('material-heavy scope');
    if(flagCount > 0) reasons.push(flagCount+' benchmark flag'+(flagCount>1?'s':''));
    if(trips > 2)     reasons.push(trips+'-trip mobilization');
    if(!hasRateMatch) reasons.push('no agreed rate card');
    const explanation = reasons.length
      ? 'Target pricing reflects: '+reasons.join(', ')+'.'
      : 'Standard markup applied at GP target with no significant risk factors.';

    return {floor,target,stretch,floorGP,targetGP,stretchGP,riskLabel,explanation,marginImpact,vendorCost};
  }

  function calcRiskScorePure(){
    if(!S.items.length) return null;
    const t        = calcT();
    const gpTarget = GP_TARGET;
    const mgp      = t.cT > 0 ? (t.cT - t.vS) / t.cT : 0;
    const vendorCost= t.vS;
    const matPct   = vendorCost > 0 ? S.items.reduce((s,i)=>s+(i.materials||0),0)/vendorCost : 0;

    let score = 0;
    const reasons = [];

    if(mgp < gpTarget){
      const gap = (gpTarget - mgp) * 100;
      score += Math.min(30, gap * 2);
      reasons.push('GP '+((mgp*100).toFixed(1))+'% is '+(gap.toFixed(1))+'pts below target');
    }
    if(matPct > 0.6){
      score += 10;
      reasons.push('Material-heavy job ('+(matPct*100).toFixed(0)+'% materials) — higher exposure');
    }
    const flagged = S.items.filter(i=>i.materialBenchmark?.flagStatus==='flag').length;
    if(flagged > 0){
      score += Math.min(20, flagged * 7);
      reasons.push(flagged+' benchmark flag'+(flagged>1?'s':'')+' unresolved');
    }
    const lowConf = S.items.filter(i=>i.materialBenchmark?.confidence==='low').length;
    if(lowConf > 0){
      score += Math.min(10, lowConf * 3);
      reasons.push(lowConf+' item'+(lowConf>1?'s':'')+' with low-confidence benchmarks');
    }
    if(!(S.clientRates||[]).length){
      score += 8;
      reasons.push('No agreed client rate card loaded');
    }
    if(!(S.wo?.description||S.scopeNarrative||'').trim()){
      score += 5;
      reasons.push('No scope of work defined');
    }
    const scopeWords = (S.wo?.description||'').toLowerCase();
    if(/urgent|emergency|asap|same.?day|after.?hours/.test(scopeWords)){
      score += 8;
      reasons.push('Urgency or after-hours indicators in scope');
    }
    const manualCount = S.items.filter(i=>i._clientUnitRate!==undefined||i._manuallyEdited).length;
    if(manualCount > S.items.length * 0.4){
      score += 7;
      reasons.push('High proportion of manually overridden line items');
    }
    if(/lift|bucket|aerial|boom|scaffold/.test(scopeWords+(S.photoAnalysis?.overallScope||''))){
      score += 8;
      reasons.push('Equipment/lift requirements detected');
    }

    score = Math.min(100, Math.round(score));
    const label  = score >= 65 ? 'HIGH RISK' : score >= 35 ? 'WATCH' : 'SAFE';
    const action = score >= 65 ? 'Manager approval required'
                 : score >= 50 ? 'Review materials and benchmarks before submitting'
                 : score >= 35 ? 'Review flagged items — add contingency if uncertain'
                 : 'Ready to submit';

    return {score, label, reasons: reasons.slice(0,5), action};
  }

  function calcApprovalPure(){
    const triggers = [];
    const t = calcT();
    const gpTarget = GP_TARGET;
    const mgp = t.cT > 0 ? (t.cT - t.vS)/t.cT : 0;
    const totalThreshold = 10000;

    if(mgp < gpTarget - 0.05)     triggers.push('GP '+(mgp*100).toFixed(1)+'% is significantly below target');
    if(t.cT > totalThreshold)     triggers.push('Proposal total '+fmt(t.cT)+' exceeds approval threshold');
    if(S.riskScore?.score >= 65)   triggers.push('Risk score '+S.riskScore.score+'/100 — HIGH RISK');
    const unresolved = S.items.filter(i=>i.materialBenchmark?.flagStatus==='flag').length;
    if(unresolved > 0)             triggers.push(unresolved+' benchmark flag'+(unresolved>1?'s':'')+' unresolved');
    if(!S.protections.excluded && S.riskScore?.score >= 50) triggers.push('No exclusions on high-risk job');

    const needsManager = triggers.length >= 3 || (S.riskScore?.score >= 65) || t.cT > totalThreshold * 2;
    const needsReview  = triggers.length > 0 && !needsManager;
    const label = needsManager ? 'Manager approval required'
                : needsReview  ? 'Review needed'
                : 'Ready to submit';
    return {triggers, needsManager, needsReview, label};
  }

  // Non-destructive equivalent of applyRateMatch for the LIVE drawer: prices S.items from the
  // current rate-match rows without tearing S.rateMatch down, so the interactive table (qty inputs,
  // alternates) keeps re-rendering. ponytail: mirrors applyRateMatch's per-item assignment — that
  // one stays the canonical, test-covered version; this is the read-only view's copy.
  function syncItemsPricing(){
    const rm = S.rateMatch;
    if(!rm || !rm.rows) return;
    rm.rows.forEach(r => {
      const it = S.items.find(i => i.id === r.itemId);
      if(!it) return;
      if(!r.skip && r.matched){ it._clientUnitRate = r.matched.rate; it.unit = r.matched.uom || it.unit; it._umbRateId = r.matched.id; }
      else { delete it._clientUnitRate; }
    });
    markDirty();
  }
  // =========================================================================================
  //  PP-ENGINE END
  // =========================================================================================

  // ===== read-only ops (all via ppGql; @grant none, same-origin) ===========================
  function uid(){ return 'i' + Date.now() + Math.random().toString(36).slice(2,5); }
  function normTrade(raw){
    const r=(raw||'').toLowerCase();
    if(r==='lighting') return 'Lighting';
    if(r==='signage') return 'Signage';
    if(r==='welding') return 'Welding';
    if(r.includes('electric')||r.includes('lighting')||r.includes('power')||r.includes('panel')) return 'Electrical';
    if(r.includes('plumb')||r.includes('pipe')||r.includes('drain')||r.includes('water')) return 'Plumbing';
    if(r.includes('hvac')||r.includes('heat')||r.includes('cool')||r.includes('air')||r.includes('refriger')) return 'HVAC';
    if(r.includes('door')||r.includes('lock')||r.includes('key')||r.includes('access')) return 'Doors/Locks';
    if(r.includes('handy')||r.includes('general')||r.includes('misc')||r.includes('carpent')||r.includes('paint')) return 'Handyman';
    if(r.includes('sign')) return 'Signage';
    if(r.includes('light')) return 'Lighting';
    if(r.includes('weld')) return 'Welding';
    return 'Other';
  }

  // Trimmed WO read — only the fields the pricing path needs (clientId for the rate card + match,
  // locationId + jobId to scope the match, scopeOfWork + trade for the advisory panels).
  var Q_WO = 'query WorkOrderForPricing($workOrderNumber: Int!) { workOrder(workOrderNumber: $workOrderNumber) { id number clientId clientName locationId locationNumber locationName scopeOfWork trades { id name systemTradeName } } }';
  function ppWorkOrder(woNum){
    return ppGql('WorkOrderForPricing', Q_WO, {workOrderNumber: Number(woNum)}).then(function(d){ return d && d.workOrder || null; });
  }
  var Q_POS = 'query PosForPricing($workOrderNumber: Int) { purchaseOrders(workOrderNumber: $workOrderNumber) { id number formattedPurchaseOrderNumber state scopeOfWork vendorId vendorName } }';
  function ppPurchaseOrders(woNum){
    return ppGql('PosForPricing', Q_POS, {workOrderNumber: Number(woNum)}).then(function(d){ return d && d.purchaseOrders || []; });
  }
  var Q_QUOTES = 'query QuotesForPricing($purchaseOrderIds: [Int!]) { quotes(purchaseOrderIds: $purchaseOrderIds, includeLineItems: true) { id number description state purchaseOrderId purchaseOrderNumber formattedPurchaseOrderNumber jobNumber vendorName vendorTenantProfileId created submittedDate approvedDate aggregateRateDiscrepancy scopeOfWork status { id name } type { id name } subtotal { amount currency precision } taxTotal { amount currency precision } total { amount currency precision } quoteLineItems { id category item description quantity unitOfMeasurement isTaxable taxRate rateId rateDiscrepancy sortOrder categoryObject { id name } trade { id name systemTradeName } unitCost { amount currency precision } totalCost { amount currency precision } totalTax { amount currency precision } totalCharge { amount currency precision } } } }';
  function ppQuotes(poIds){
    if(!poIds || !poIds.length) return Promise.resolve([]);
    return ppGql('QuotesForPricing', Q_QUOTES, {purchaseOrderIds: poIds.map(Number)}).then(function(d){ return d && d.quotes || []; });
  }
  var Q_RATES = 'query ListClientRatesForPricing($targetTenantId: ID!, $page: PageInput!, $sortBy: [SortInput!]) { listClientRates(targetTenantId: $targetTenantId, page: $page, sortBy: $sortBy, isActive: true) { rowCount items { id isActive category item unitOfMeasurement type status locationId categoryObject { id name } unitCost { amount currency precision } trade { id name systemTradeName } } } }';
  function ppClientRates(clientId){
    // sortBy is REQUIRED by the server though nullable in schema (400 otherwise).
    return ppGql('ListClientRatesForPricing', Q_RATES, {
      targetTenantId: clientId, page: {skip:0, take:200}, sortBy: [{columnName:'category', direction:'ASC'}]
    }).then(function(d){
      var items = (d && d.listClientRates && d.listClientRates.items) || [];
      return items.map(function(i){ return {
        id: i.id, trade: (i.trade && i.trade.name) || 'Other', tradeNorm: normTrade((i.trade && i.trade.name) || ''),
        category: (i.categoryObject && i.categoryObject.name) || CAT_LABEL[i.category] || 'Other',
        item: i.item, uom: i.unitOfMeasurement || 'ea', rate: umbMoney(i.unitCost),
        locationId: i.locationId || null, rateType: i.type || null, rateStatus: i.status || null
      }; });
    });
  }
  var Q_RATEMATCH = 'query RateMatchesForPricing($input: RateMatchInput!) { rateMatches(input: $input) { suggestedRate { id item unitOfMeasurement rank isAccepted isServiceRequestRate status locationId category { id name } trade { id name } amount { amount currency precision } labor { rateClass priorityCategory crewSize professionLevel isUnion } } rates { rowCount take items { id item unitOfMeasurement rank isAccepted isServiceRequestRate status category { id name } trade { id name } amount { amount currency precision } labor { rateClass priorityCategory crewSize professionLevel isUnion } } } } }';
  function ppRateMatches(clientId, categoryId, opts){
    var input = umbRateMatchInput(clientId, categoryId, opts);
    return ppGql('RateMatchesForPricing', Q_RATEMATCH, {input: input}).then(function(d){
      var r = d && d.rateMatches;
      var norm = function(x){ return !x ? null : ({
        id: x.id, item: x.item || '', uom: x.unitOfMeasurement || 'ea',
        rate: umbMoney(x.amount),
        category: (x.category && x.category.name) || CAT_LABEL[categoryId] || 'Other',
        categoryId: (x.category && x.category.id) != null ? x.category.id : Number(categoryId),
        trade: (x.trade && x.trade.name) || '', accepted: !!x.isAccepted,
        isSvcReq: !!x.isServiceRequestRate, status: x.status || null, labor: x.labor || null
      }); };
      return {
        suggested: norm(r && r.suggestedRate),
        rowCount: (r && r.rates && r.rates.rowCount) || 0,
        options: ((r && r.rates && r.rates.items) || []).map(norm)
      };
    });
  }

  // Map raw quotes -> vendor-proposal view with per-line lump-sum detection. Verbatim from selWO().
  function mapVendorProposals(quotes, pos){
    pos = pos || [];
    return quotes.map(v => ({
      id: v.id, number: v.number, vendor: v.vendorName || '',
      poNumber: v.formattedPurchaseOrderNumber || '',
      state: v.status?.name || PROPOSAL_STATE[v.state] || '',
      subtotal: umbMoney(v.subtotal), tax: umbMoney(v.taxTotal), total: umbMoney(v.total),
      rateFlag: v.aggregateRateDiscrepancy,
      scope: v.scopeOfWork || pos.find(p => p.id === v.purchaseOrderId)?.scopeOfWork || '',
      lines: (v.quoteLineItems || []).map(l => {
        const qty  = Number(l.quantity);
        const cost = umbMoney(l.totalCost);
        return {
          category:   CAT_LABEL[l.category] || l.categoryObject?.name || 'Other',
          categoryId: l.category,
          item:       l.item || '',
          description:l.description || l.item || '',
          qty:        Number.isFinite(qty) && qty > 0 ? qty : null,
          uom:        l.unitOfMeasurement || '',
          unitCost:   umbMoney(l.unitCost),
          totalCost:  cost,
          totalCharge:umbMoney(l.totalCharge),
          taxable:    !!l.isTaxable,
          taxPct:     (Number(l.taxRate) || 0) * 100,
          trade:      l.trade?.name || '',
          isLumpSum:  !l.unitOfMeasurement || !(qty > 1) || umbMoney(l.unitCost) === cost,
          rateVerdict:l.rateDiscrepancy || null,
          rateId:     l.rateId || null
        };
      }).filter(l => l.totalCost > 0 || l.qty)
    }));
  }

  // Push a vendor proposal's lines into S.items. Verbatim from the "Import vendor quote lines"
  // handler: an absent unit stays absent, a fabricated 1 is recorded as NOT vendor-stated
  // (_umbQtyKnown), labour/material split is READ from the category, not guessed.
  function importQuoteLines(vps){
    vps.forEach(v => (v.lines || []).forEach(l => {
      S.items.push({
        id:               uid(),
        vendorTotal:      l.totalCost,
        qty:              l.qty || 1,
        _umbQtyKnown:     l.qty != null && !l.isLumpSum,
        unit:             l.uom,
        _catRaw:          l.category,
        trade:            normTrade(l.trade || S.wo?.trade || ''),
        clientDescription:l.description || (l.category + ' — ' + fmt(l.totalCost)),
        taxPct:           l.taxPct,
        taxable:          l.taxable,
        labor:            l.categoryId === 0 ? l.totalCost : 0,
        materials:        l.categoryId === 1 ? l.totalCost : 0,
        _umbRateVerdict:  l.rateVerdict,
        _fromUmbravaQuote:true
      });
    }));
  }

  // Orchestrate the read path: WO -> POs -> quotes -> rate card -> rate matches, then price.
  function loadPricing(woNum, proposal){
    resetEngineState();
    return ppWorkOrder(woNum).then(function(wo){
      if(!wo) throw new Error('work order #' + woNum + ' not found');
      S.wo = {
        id: wo.id, jobId: wo.id, number: wo.number,
        clientId: wo.clientId, client: wo.clientName,
        locationId: wo.locationId, locationName: wo.locationName, locationNumber: wo.locationNumber,
        description: wo.scopeOfWork || (proposal && proposal.scopeOfWork) || '',
        trade: (wo.trades && wo.trades[0] && wo.trades[0].name) || ''
      };
      return ppPurchaseOrders(woNum);
    }).then(function(pos){
      S._pos = pos;
      var ids = pos.map(function(p){ return p.id; });
      return ppQuotes(ids);
    }).then(function(quotes){
      var vps = mapVendorProposals(quotes, S._pos);
      S.umbVendorProposals = vps;
      importQuoteLines(vps);
      // Rate card (needs the client tenant). A failure here is non-fatal: lines still show at cost.
      if(!S.wo.clientId) return null;
      return ppClientRates(S.wo.clientId).then(function(rates){ S.clientRates = rates; }).catch(function(){ S.clientRates = null; });
    }).then(function(){
      if(!S.items.length || !S.wo.clientId) return null;
      return runRateMatch();
    });
  }

  // Network wrapper around assembleRateMatch: one rateMatches() call per DISTINCT category+crew.
  function runRateMatch(){
    if(!S.items.length) return Promise.resolve();
    var clientId = S.wo && S.wo.clientId;
    if(!clientId) return Promise.resolve();
    var byKey = {};
    var keyOf = function(it){ var c = catOf(it); return c == null ? null : c + '|' + crewOf(it); };
    var keys = [];
    S.items.forEach(function(it){ var k = keyOf(it); if(k != null && keys.indexOf(k) === -1) keys.push(k); });
    var chain = Promise.resolve();
    keys.forEach(function(k){
      chain = chain.then(function(){
        var it = S.items.find(function(x){ return keyOf(x) === k; });
        return ppRateMatches(clientId, catOf(it), {
          locationId: S.wo && S.wo.locationId, workOrderId: S.wo && S.wo.jobId,
          crewSize: crewOf(it), take: 25
        }).then(function(m){ byKey[k] = m; });
      });
    });
    return chain.then(function(){ S.rateMatch = assembleRateMatch(S.items, byKey); }).catch(function(err){
      S.rateMatch = {error: (err && err.message) || 'rate match failed', rows: [], constraints: []};
    });
  }

  // ===== render (drawer-native; read-only) =================================================
  function catBadgePP(cat){
    return '<span style="display:inline-block;font-size:9px;font-weight:600;padding:2px 7px;border-radius:10px;white-space:nowrap;background:#eef3fb;color:#264a7a;border:1px solid #cfe0f5">' + esc(cat) + '</span>';
  }
  function gpColor(pct, target){ return pct >= target - 0.5 ? '#1a7a3e' : pct >= target - 5 ? '#8a5a00' : '#8b1a1a'; }

  // Per-line reasoning: crew read from the vendor text, the chosen rate, or why a line is skipped.
  function reasonFor(row){
    if(!row.matched) return 'left at cost — no contracted rate for ' + esc(row.category);
    if(row.uomMismatch) return 'SKIPPED — unit disagrees (vendor ' + esc(row.unit || '?') + ' vs rate ' + esc(row.matched.uom || '?') + ')';
    var crew = row.crew > 0 ? 'crew ' + row.crew + ' (from vendor text); ' : '';
    if(row.needsQty) return crew + 'lump sum — enter the ' + esc(row.unit || 'unit') + ' quantity to price at ' + fmt(row.matched.rate) + '/' + esc(row.matched.uom || 'ea');
    if(row.clientPrice < (row.vendorCost || 0)) return crew + 'LOSS — ' + fmt((row.vendorCost || 0) - row.clientPrice) + ' under water at ' + fmt(row.matched.rate) + '/' + esc(row.matched.uom || 'ea');
    return crew + esc(row.matched.item || 'rate') + ' @ ' + fmt(row.matched.rate) + '/' + esc(row.matched.uom || 'ea');
  }

  function panelBlock(title, inner){
    return '<div style="border:1px solid #e2e8e5;border-radius:8px;margin-top:10px;overflow:hidden">' +
      '<div style="padding:6px 10px;background:#f4f7f5;font-size:11px;font-weight:600;color:#12241b">' + esc(title) + '</div>' +
      '<div style="padding:8px 10px">' + inner + '</div></div>';
  }

  function renderPriced(hd, body, proposal){
    syncItemsPricing();
    var t = calcT();
    var rm = S.rateMatch || {rows: [], constraints: []};
    var rows = rm.rows || [];
    var targetPct = GP_TARGET * 100;

    var s = hd.querySelector('.s');
    if(s) s.textContent = 'WO #' + (S.wo && S.wo.number != null ? S.wo.number : '?') + ' · ' + S.items.length + ' line(s)';
    body.innerHTML = '';

    var html = '';
    // context
    html += '<div style="font-size:12px;line-height:1.5;margin-bottom:6px">' +
      '<div><strong>Client:</strong> ' + esc((S.wo && S.wo.client) || '-') + '</div>' +
      '<div><strong>Location:</strong> ' + esc((S.wo && (S.wo.locationName || S.wo.locationNumber)) || '-') + '</div>' +
      '<div><strong>Rate card:</strong> ' + ((S.clientRates && S.clientRates.length) ? (S.clientRates.length + ' contracted rate(s)') : 'none loaded') + '</div>' +
      '</div>';

    if(rm.error){
      html += '<div class="bwn-pp-err">Rate match failed: ' + esc(rm.error) + '. Lines shown at vendor cost.</div>';
    }

    if(!S.items.length){
      html += '<div class="bwn-pp-note">This work order has no vendor quote line items to price. Import the vendor quote in Umbrava first.</div>';
      body.innerHTML = html;
      return;
    }

    // priced line table
    html += '<table class="bwn-pp-table"><tr>' +
      '<th>Line</th><th>Cat</th><th style="text-align:right">Vendor</th><th style="text-align:right">Client</th><th style="text-align:right">GP</th></tr>';
    rows.forEach(function(row){
      var priced = !row.skip && row.matched && row.clientPrice != null;
      var cp = priced ? row.clientPrice : (row.vendorCost || 0);
      var lineGP = priced && cp > 0 ? ((cp - (row.vendorCost || 0)) / cp) * 100 : 0;
      var alt = (rm.byCat && rm.byCat[row.categoryId] && rm.byCat[row.categoryId].options) || [];
      var reason = reasonFor(row);
      html += '<tr>' +
        '<td>' + esc(row.description || '-') +
          '<div style="font-size:10px;color:#5a6b62;margin-top:2px">' + reason + '</div>';
      // qty input for lump-sum lines that need a quantity
      if(row.needsQty){
        html += '<div style="margin-top:3px"><input type="number" min="0" step="0.5" data-pp-qty="' + esc(row.itemId) +
          '" placeholder="qty" style="width:70px;font-size:11px;padding:2px 4px;border:1px solid #cfe0f5;border-radius:4px"> ' +
          esc(row.matched && row.matched.uom || 'unit') + '</div>';
      }
      // alternates dropdown
      if(alt.length > 1){
        html += '<div style="margin-top:3px"><select data-pp-alt="' + esc(row.itemId) + '" style="font-size:10px;max-width:220px">';
        alt.forEach(function(o){
          html += '<option value="' + esc(o.id) + '"' + (o.id === row.chosenRateId ? ' selected' : '') + '>' +
            esc(o.item || 'rate') + ' — ' + fmt(o.rate) + '/' + esc(o.uom || 'ea') + '</option>';
        });
        html += '</select></div>';
      }
      html += '</td>' +
        '<td>' + catBadgePP(row.category) + '</td>' +
        '<td style="text-align:right" class="mono">' + fmt(row.vendorCost || 0) + '</td>' +
        '<td style="text-align:right" class="mono">' + (priced ? fmt(cp) : '<span style="color:#8a5a00">at cost</span>') + '</td>' +
        '<td style="text-align:right;color:' + gpColor(lineGP, targetPct) + '">' + (priced ? lineGP.toFixed(1) + '%' : '—') + '</td>' +
        '</tr>';
    });
    html += '</table>';

    // overall GP (pre-tax) vs target + contracted-rate ladder note
    var onTarget = t.mgp >= targetPct - 0.5;
    html += '<div style="margin-top:10px;padding:9px 11px;border-radius:8px;background:' +
      (onTarget ? '#eaf6ee' : '#fdf4e3') + ';border:1px solid ' + (onTarget ? '#bfe3c9' : '#f0dcb4') + '">' +
      '<div style="font-size:13px;font-weight:600;color:' + gpColor(t.mgp, targetPct) + '">Overall GP (pre-tax): ' +
      t.mgp.toFixed(1) + '% <span style="font-weight:400;color:#5a6b62">vs ' + targetPct.toFixed(0) + '% target</span></div>' +
      '<div style="font-size:11px;color:#5a6b62;margin-top:2px">Client subtotal ' + fmt(t.subCharge) +
      ' · vendor cost ' + fmt(t.vS) + ' · GP ' + fmt(t.mg) + '</div>';
    if(!onTarget && t.targetGap > 0){
      html += '<div style="font-size:11px;color:#8a5a00;margin-top:4px">To reach ' + targetPct.toFixed(0) +
        '% GP the pre-tax subtotal needs ' + fmt(t.targetCT) + ' (' + fmt(t.targetGap) +
        ' more) — raise the contracted-rate ladder or re-scope.</div>';
    }
    html += '</div>';

    // constraints (at-cost / skipped / needs-qty / LOSS / no-rate)
    if(rm.constraints && rm.constraints.length){
      html += '<div class="bwn-pp-warn"><strong>Notes</strong><ul style="margin:4px 0 0 16px;padding:0">' +
        rm.constraints.map(function(c){ return '<li>' + esc(c) + '</li>'; }).join('') + '</ul></div>';
    }

    // ── advisory panels (computed from loaded data). Benchmark / CO-triggers / lump-preview /
    //    client-explanation panels are intentionally NOT rendered — they depend on AI, photo, or
    //    material-benchmark input the read-only drawer does not load.
    S.riskScore = calcRiskScorePure();          // risk first (approval + guidance read it)
    S.pricingGuidance = calcPricingGuidancePure();
    var g = S.pricingGuidance;
    if(g){
      html += panelBlock('Pricing guidance',
        '<div style="display:flex;gap:8px;text-align:center">' +
        '<div style="flex:1;padding:6px;background:#f4f7f5;border-radius:6px"><div style="font-size:9px;color:#5a6b62">FLOOR</div><div class="mono" style="font-weight:600">' + fmt(g.floor) + '</div><div style="font-size:9px;color:#5a6b62">' + g.floorGP.toFixed(1) + '% GP</div></div>' +
        '<div style="flex:1;padding:6px;background:#eef3fb;border-radius:6px;border:1.5px solid #264a7a"><div style="font-size:9px;color:#264a7a">★ TARGET</div><div class="mono" style="font-weight:700;color:#264a7a">' + fmt(g.target) + '</div><div style="font-size:9px;color:#264a7a">' + g.targetGP.toFixed(1) + '% GP</div></div>' +
        '<div style="flex:1;padding:6px;background:#f4f7f5;border-radius:6px"><div style="font-size:9px;color:#5a6b62">STRETCH</div><div class="mono" style="font-weight:600">' + fmt(g.stretch) + '</div><div style="font-size:9px;color:#5a6b62">' + g.stretchGP.toFixed(1) + '% GP</div></div>' +
        '</div><div style="font-size:11px;color:#5a6b62;margin-top:6px">Risk: <strong>' + esc(g.riskLabel.toUpperCase()) + '</strong> — ' + esc(g.explanation) + '</div>');
    }
    var rs = S.riskScore;
    if(rs){
      var rsColor = rs.label === 'HIGH RISK' ? '#8b1a1a' : rs.label === 'WATCH' ? '#8a5a00' : '#1a7a3e';
      html += panelBlock('Margin risk score',
        '<div style="display:flex;justify-content:space-between"><span style="font-size:11px;font-weight:600;color:' + rsColor + '">' + esc(rs.label) + '</span><span class="mono" style="font-size:11px;color:' + rsColor + '">' + rs.score + '/100</span></div>' +
        '<div style="font-size:10px;color:' + rsColor + ';margin:4px 0">' + esc(rs.action) + '</div>' +
        rs.reasons.map(function(r){ return '<div style="font-size:10px;color:#5a6b62">• ' + esc(r) + '</div>'; }).join(''));
    }
    var ap = calcApprovalPure();
    var apColor = ap.needsManager ? '#8b1a1a' : ap.needsReview ? '#8a5a00' : '#1a7a3e';
    html += panelBlock('Approval',
      '<div style="font-size:12px;font-weight:600;color:' + apColor + '">' + esc(ap.label) + '</div>' +
      (ap.triggers.length ? ap.triggers.map(function(r){ return '<div style="font-size:10px;color:#5a6b62">• ' + esc(r) + '</div>'; }).join('') : '<div style="font-size:10px;color:#5a6b62">No approval triggers.</div>'));
    // protections warning (high-risk job with no exclusions/assumptions loaded)
    var isHighRisk = (rs && (rs.label === 'HIGH RISK' || rs.score >= 50));
    if(isHighRisk && !S.protections.excluded && !S.protections.assumptions){
      html += '<div class="bwn-pp-warn" style="margin-top:8px">High-risk job with no exclusions or assumptions on the proposal. Add proposal protections before sending (drafted outside this read-only view).</div>';
    }

    body.innerHTML = html;

    // wire the interactive inputs (no inline handlers — CSP-friendly, matches the shell)
    Array.prototype.forEach.call(body.querySelectorAll('input[data-pp-qty]'), function(inp){
      inp.addEventListener('change', function(){
        setRateMatchQty(inp.getAttribute('data-pp-qty'), inp.value);
        renderPriced(hd, body, proposal);
      });
    });
    Array.prototype.forEach.call(body.querySelectorAll('select[data-pp-alt]'), function(sel){
      sel.addEventListener('change', function(){
        setRateMatchChoice(sel.getAttribute('data-pp-alt'), sel.value);
        renderPriced(hd, body, proposal);
      });
    });
  }

  // ===== lifecycle: inject when the actions menu opens ======================
  function ppOnMenuMaybeOpened() {
    scanMenus();
    setTimeout(scanMenus, 60);
    setTimeout(scanMenus, 200);
  }
  try {
    var ppObs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (!n || n.nodeType !== 1) continue;
          if ((n.matches && n.matches('ul[role="menu"]')) ||
              (n.querySelector && n.querySelector('ul[role="menu"]'))) {
            ppOnMenuMaybeOpened();
            break;
          }
        }
      }
    });
    ppObs.observe(document.body, { childList: true, subtree: true });
  } catch (e) { }
  scanMenus();

  // Console entry for DOM-independent smoke testing (read-only).
  try {
    window.__bwnPriceProposal = function (proposalId) { openDrawer(parseInt(proposalId, 10)); };
    console.info('[BWN PROPOSAL PRICING] console entry: __bwnPriceProposal(proposalId)  (opens the pricing drawer for a client proposal id)');
  } catch (e) { }

})();
