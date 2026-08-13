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
          var match = (newN === srcN) && (srcSub == null || newSub === srcSub);
          return { ok: true, newProposalId: newId, created: true, filled: true, readBack: { sourceItems: srcN, newItems: newN, sourceSubtotal: srcSub, newSubtotal: newSub, match: match } };
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

  // ===== ui =================================================================
  // (row button + drawer + picker land here in Task 5.)

})();
