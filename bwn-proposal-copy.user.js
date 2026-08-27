// ==UserScript==
// @name         BWN Proposal Copy (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.1.13
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

  var VER = '0.1.13';   // keep in step with @version
  var DRY_RUN = false; // when true, the two WRITE mutations are logged, not sent
  console.info('[BWN PROPOSAL COPY] v' + VER + ' - copy client proposal to another WO as a Draft (createDraftProposal + editProposal replay)');

  function onProposalPage() { return /\/work-orders\/\d+/.test(location.pathname); }

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
  function pcGql(op, query, variables) {
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
  // ---- BWN-OPS: audited GraphQL wrapper for this sandbox --------------------
  // Routes proposal-copy's two writes (createDraftProposal, editProposal) through bwnGqlOp (the
  // paste-identical BWN-OPS-WRAP below, SHA-gated to Core): a correlation id + the shared
  // bwn:audit entry + the fail-closed high-risk confirm gate + centralized success:false
  // rejection. bwnGql wraps this file's 3-arg pcGql, recovering the SPA operation name (the
  // document's second token) for pcGql's operationName arg without a regex. copyProposal confirms
  // the whole copy in its own drawer, so both high-risk writes pass confirmed:true; the reads
  // stay on pcGql directly. BWN_VER is derived via a typeof guard so the copy-engine node harness
  // (which slices from this block, without VER in scope) still loads.
  var bwnGql = function (query, variables) {
    var q = String(query), i = 0, n = q.length;
    while (i < n && q.charAt(i) <= ' ') i++;
    while (i < n && q.charAt(i) > ' ') i++;
    while (i < n && q.charAt(i) <= ' ') i++;
    var j = i;
    while (j < n) { var c = q.charAt(j); if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_') j++; else break; }
    return pcGql(q.slice(i, j) || null, query, variables);
  };
  var BWN_VER = (typeof VER !== 'undefined') ? VER : '0.1.12';
  var BWN_MODULES = (function () { try { return JSON.parse(localStorage.getItem('bwn:modules') || '{}') || {}; } catch (e) { return {}; } })();
  var BWN_OPS = {
    createDraftProposal: { kind: 'write', target: 'proposal', risk: 'high', idempotent: false, retry: 'none',
      ok: 'Draft proposal created.', fail: 'The draft proposal was not created.' },
    editProposal: { kind: 'write', target: 'proposal', risk: 'high', idempotent: false, retry: 'none',
      ok: 'Proposal updated.', fail: 'The proposal was not updated.' }
  };
  // ===== BWN-OPS-WRAP START v2 (paste-identical across adopters; SHA-gated by scripts/test-bwn-ops.js) =====
  // Generic machinery only - NO registry, NO window hook - so it is byte-identical in every
  // sandbox that adopts it (Core, drop-upload, ...). It closes over four things each sandbox
  // supplies on its own: BWN_OPS (that file's registry), BWN_MODULES (kill switches), BWN_VER,
  // and bwnGql(query, variables) (that file's same-origin transport). The audit ring buffer
  // writes to the shared localStorage key, so every sandbox's writes land in ONE audit trail.
  function bwnCorrId() {
    try { if (window.crypto && window.crypto.randomUUID) return 'bwn-' + window.crypto.randomUUID(); }
    catch (e) { /* fall through to the timestamp form */ }
    return 'bwn-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // Bounded, PII-free audit ring buffer in localStorage. Records ONLY what the caller passes
  // (ids + scalar before/after) plus operation metadata - NEVER the raw variables or the
  // response, which can carry note text, addresses, or vendor identity.
  var BWN_AUDIT_KEY = 'bwn:audit', BWN_AUDIT_MAX = 200, BWN_AUDIT_SCHEMA = 1;
  function bwnAuditAll() {
    try { var a = JSON.parse(localStorage.getItem(BWN_AUDIT_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function bwnAuditRecord(entry) {
    try {
      var a = bwnAuditAll();
      a.push(entry);
      if (a.length > BWN_AUDIT_MAX) a = a.slice(a.length - BWN_AUDIT_MAX);
      localStorage.setItem(BWN_AUDIT_KEY, JSON.stringify(a));
    } catch (e) { /* audit is best-effort - it must never block or fail a write */ }
    return entry;
  }
  function bwnAuditExport() {
    return JSON.stringify({ schema: BWN_AUDIT_SCHEMA, ver: BWN_VER, exportedTs: Date.now(), entries: bwnAuditAll() }, null, 2);
  }
  function bwnAuditClear() { try { localStorage.removeItem(BWN_AUDIT_KEY); } catch (e) { /* best-effort */ } }
  function bwnAuditActor() {
    try {
      var r = JSON.parse(localStorage.getItem('bwn:role:last') || 'null');
      return (r && (r.label || r.role)) || 'unknown';
    } catch (e) { return 'unknown'; }
  }

  // Only a network-level failure is transient. A GraphQL validation error comes back through
  // bwnGql as a thrown Error carrying the server's message (deterministic - retrying just
  // repeats it), and a write refused with success:false is flagged bwnNonTransient below.
  // ponytail: bwnGql does not surface the HTTP status, so 429/5xx are not distinguished here;
  // attach r.status in bwnGql and widen this test if status-aware backoff is ever needed.
  function bwnIsTransient(err) {
    if (err && err.bwnNonTransient) return false;
    return /network|failed to fetch|load failed|timeout|timed out/i.test(String(err && err.message || err));
  }
  function bwnBackoff(tryNo) { return Math.min(4000, 400 * Math.pow(2, tryNo - 1)); }
  function bwnDelay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // bwnGqlOp(op, query, variables, opts) -> Promise(data)
  //   op        BWN_OPS key. THROWS if unregistered - a captured op must be classified before
  //             it can be sent, which is what keeps guessed selectors out of the suite.
  //   query     the captured GraphQL document TEXT - the caller owns it, never invented here.
  //   variables the variables object (sent as-is to bwnGql; never copied into the audit).
  //   opts      { feature, validate, ids, before, after, actor } - all optional:
  //     feature   BWN_MODULES key; if that module is switched off the op is REFUSED and, for a
  //               write, audited outcome:'denied' - this is the per-feature kill switch.
  //     validate  fn(variables) -> true | 'message'; a write is blocked before it is sent.
  //     ids       { wo, po, vendorId, ... } scalar identifiers for the audit trail (NO PII).
  //     before    scalar snapshot of the value(s) about to change (NO PII, NO bulk data).
  //     after     scalar snapshot of the intended new value(s).
  //     actor     who initiated; defaults to the last-known rank label, else 'unknown'.
  // Reads resolve to `data`. A write whose {success,message} envelope says success:false is
  // REJECTED (never a silent false - the exact bug class the op-catalog warns about) and
  // audited outcome:'error'.
  // Injected per-sandbox by a caller that owns a high-risk write's confirmation UI, via
  // bwnGqlOp.setConfirm(fn). A risk:'high' write is refused unless the caller either passes
  // opts.confirmed===true (it confirmed through its own UI) OR a confirm handler returns truthy.
  var _confirmFn = null;
  function bwnGqlOp(op, query, variables, opts) {
    opts = opts || {};
    var meta = BWN_OPS[op];
    if (!meta) return Promise.reject(new Error('bwnGqlOp: unregistered operation "' + op + '"'));
    var isWrite = meta.kind === 'write';
    var corrId = bwnCorrId();
    var t0 = Date.now();
    var actor = opts.actor || bwnAuditActor();

    function writeAudit(outcome, extra) {
      if (!isWrite) return;
      var e = {
        ts: Date.now(), corrId: corrId, op: op, kind: meta.kind, target: meta.target,
        risk: meta.risk || null, actor: actor, ids: opts.ids || null,
        before: (opts.before === undefined ? null : opts.before),
        after: (opts.after === undefined ? null : opts.after),
        outcome: outcome, ms: Date.now() - t0, ver: BWN_VER
      };
      if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k]; } }
      bwnAuditRecord(e);
    }

    // Per-feature kill switch: a disabled module must not mutate even if its UI leaked in.
    if (opts.feature && BWN_MODULES[opts.feature] === false) {
      writeAudit('denied', { reason: 'feature-off:' + opts.feature });
      return Promise.reject(new Error('bwnGqlOp: feature "' + opts.feature + '" is disabled'));
    }
    // Validate a write BEFORE it leaves the browser.
    if (isWrite && typeof opts.validate === 'function') {
      var vr = opts.validate(variables);
      if (vr !== true) {
        writeAudit('denied', { reason: 'validation:' + vr });
        return Promise.reject(new Error('bwnGqlOp: validation failed for "' + op + '": ' + vr));
      }
    }

    var maxTries = (meta.retry === 'safe' && (meta.kind === 'read' || meta.idempotent === true)) ? 3 : 1;
    function attempt(tryNo) {
      return bwnGql(query, variables).then(function (data) {
        if (isWrite) {
          var env = data && data[op];
          if (env && env.success === false) {
            var refused = new Error(env.message || (op + ' was refused'));
            refused.bwnNonTransient = true;
            writeAudit('error', { tries: tryNo, reason: refused.message });
            throw refused;
          }
          writeAudit('ok', { tries: tryNo });
        }
        return data;
      }, function (err) {
        if (bwnIsTransient(err) && tryNo < maxTries) {
          return bwnDelay(bwnBackoff(tryNo)).then(function () { return attempt(tryNo + 1); });
        }
        writeAudit('error', { tries: tryNo, reason: String(err && err.message || err) });
        throw err;
      });
    }
    // High-risk confirmation gate (fail-closed). A risk:'high' write must be proven confirmed:
    // either the caller passes opts.confirmed===true (it ran its own confirm UI, e.g. dispatch's
    // modal) OR an injected _confirmFn returns truthy. Neither -> refused, never a silent send.
    if (isWrite && meta.risk === 'high' && opts.confirmed !== true) {
      if (typeof _confirmFn !== 'function') {
        writeAudit('denied', { reason: 'confirm-required' });
        return Promise.reject(new Error('bwnGqlOp: "' + op + '" is high-risk and needs confirmation (no confirm handler set)'));
      }
      var details = {
        op: op, target: meta.target, risk: meta.risk, ids: opts.ids || null,
        current: (opts.current === undefined ? null : opts.current),
        proposed: (opts.proposed === undefined ? null : opts.proposed),
        count: (opts.count === undefined ? null : opts.count),
        reason: opts.reason || null, irreversible: !!opts.irreversible
      };
      return Promise.resolve().then(function () { return _confirmFn(details); }).then(function (okd) {
        if (!okd) {
          writeAudit('denied', { reason: 'user-cancelled' });
          throw new Error('bwnGqlOp: "' + op + '" cancelled at confirmation');
        }
        return attempt(1);
      });
    }
    return attempt(1);
  }
  bwnGqlOp.setConfirm = function (fn) { _confirmFn = (typeof fn === 'function') ? fn : null; };
  // ===== BWN-OPS-WRAP END v2 =====

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
  var Q_PROPOSAL_WO = 'query ProposalWO($workOrderNumber: Int!) { job: workOrder(workOrderNumber: $workOrderNumber) { id number clientId clientName locationId locationName locationNumber formattedClientPurchaseOrderNumber address { addressLine1 addressLine2 city state postalCode isInternational latitude longitude googlePlaceId subAdministrativeArea countryCode } } }';
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
  // Quantity coercion: the ClientProposalDetails read returns quantity / chargeQuantity as
  // STRINGS ("1", "4"), but ProposalLineItemInput.quantity / chargeQuantity are Int, with
  // fractionalQuantity / fractionalChargeQuantity carrying the exact decimal as a String.
  // Sending the raw string to the Int field is REJECTED (measured live 2026-08-14:
  // 'Int cannot represent non-integer value: "1"'). Send both: the Int (truncated) to satisfy
  // the scalar, and the exact value as the fractional String so precision survives.
  function pcInt(v) { if (v == null || v === '') return null; var n = Math.trunc(Number(v)); return isFinite(n) ? n : null; }
  function pcFrac(v) { return (v == null) ? null : String(v); }
  function mapLineItem(src) {
    src = src || {};
    var out = {
      id: src.id,
      category: src.category,
      tripLabel: src.tripLabel,
      tradeId: (src.trade && src.trade.id) != null ? src.trade.id : src.tradeId,
      quantity: pcInt(src.quantity),
      fractionalQuantity: (src.fractionalQuantity != null) ? String(src.fractionalQuantity) : pcFrac(src.quantity),
      chargeQuantity: pcInt(src.chargeQuantity),
      fractionalChargeQuantity: (src.fractionalChargeQuantity != null) ? String(src.fractionalChargeQuantity) : pcFrac(src.chargeQuantity),
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
    var a = target.address || {};
    // createDraftProposal server-validates jobId + a full location.address as REQUIRED
    // (both nullable in the GraphQL schema, but rejected empty by the server - measured
    // live 2026-08-14). location is by number/name + address (ProposalLocationInfoInput
    // has no id field). Address is copied from the TARGET WO, not the source proposal.
    return { proposalData: {
      jobId: target.id,
      workOrderNumber: target.number,
      location: {
        number: target.locationNumber,
        name: target.locationName,
        address: {
          addressLine1: a.addressLine1,
          addressLine2: a.addressLine2,
          city: a.city,
          state: a.state,
          postalCode: a.postalCode,
          isInternational: a.isInternational,
          latitude: a.latitude,
          longitude: a.longitude,
          googlePlaceId: a.googlePlaceId,
          subAdministrativeArea: a.subAdministrativeArea,
          countryCode: a.countryCode
        }
      },
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
        // Routed through bwnGqlOp: correlation id + shared bwn:audit entry + the fail-closed
        // high-risk confirm gate + centralized success:false rejection. The drawer's Confirm is
        // this copy's confirmation, so both high-risk writes pass confirmed:true. The wrapper
        // rejects a success:false envelope, so re-tag that rejection with the copy stage (create
        // vs edit) the outer catch reports to the UI.
        return bwnGqlOp('createDraftProposal', M_CREATE_DRAFT, createVars, { confirmed: true, ids: { wo: target.number } })
          .catch(function (err) { throw (err && err.stage) ? err : stage('create', (err && err.message) || String(err)); })
          .then(function (r) {
          var res = r && r.createDraftProposal;
          if (!res || res.success !== true || !res.proposal || res.proposal.id == null) throw stage('create', (res && res.message) || 'createDraftProposal reported no success');
          newId = res.proposal.id;
          return bwnGqlOp('editProposal', M_EDIT, buildEditVars(newId, source), { confirmed: true, ids: { wo: target.number, proposalId: newId }, after: { lineItems: (source.proposalLineItems || []).length } })
            .catch(function (err) { throw (err && err.stage) ? err : stage('edit', (err && err.message) || String(err)); });
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
  // Actions-menu item injection, drawer, target picker, confirm card + progress.
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
  // Selectors that touch the Proposals section FAIL SAFE: if the expected row/menu/anchor is not
  // found, the injector adds nothing rather than guessing (see the actions-menu block below).

  // ---- console entry point for the live gate (DOM-independent) --------------
  // Registered HERE, early and before any DOM/injection code runs, so a throw in
  // the row-injection lifecycle (or an unverified selector) can never prevent it.
  // Runs the copy engine straight, so the copy is testable even while the
  // Proposals-row selectors are unverified and no button has injected. Suite
  // convention (cf. window.__bwnLauncher, __bwnDispatchSyncNow). Defaults to
  // DRY-RUN regardless of the DRY_RUN flag - a console call NEVER writes unless
  // {dryRun:false} is passed explicitly, so it cannot fire a write by accident.
  // (copyProposal is a hoisted function declaration, so referencing it here is safe.)
  try {
    window.__bwnCopyProposal = function (sourceProposalId, targetWorkOrderNumber, opts) {
      opts = opts || {};
      if (opts.dryRun == null) opts.dryRun = true;
      return copyProposal(sourceProposalId, targetWorkOrderNumber, opts);
    };
    console.info('[BWN PROPOSAL COPY] console entry: __bwnCopyProposal(sourceProposalId, targetWorkOrderNumber, {dryRun:true})  (dry-run default; pass {dryRun:false} to write)');
  } catch (e) { }

  var MIN_RANK = 4;
  function gated() { return typeof rank() === 'number' && rank() >= MIN_RANK; }
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

  // ---- row discovery (VERIFIED live 2026-08-14) ----------------------------
  // Measured on /work-orders/<n>/proposals/client-proposals: the client-proposal list is a
  // MUI table whose rows are <tr id="table-row-<proposalId>"> (the row id carries the real
  // proposal id, e.g. table-row-517386). The route lists ONLY client proposals (vendor
  // proposals are a sibling route), so route membership is the client-ness signal.
  var MENU_ITEM_CLASS = 'bwn-pc-menu-item';   // our injected "Copy to another WO..." <li>
  function onClientProposalsList() {
    // LIST route ONLY. The old prefix form also matched .../client-proposals/<id>/details
    // and .../client-proposals/<id>/notes - those subpages render the SAME
    // tr[id^="table-row-"] MUI grid (line items / notes), so Copy leaked onto note rows and
    // read a NOTE id as if it were a proposal id. Anchor to the bare list path; any
    // /<proposalId>/ subroute now fails closed (keeps Copy off Details + Notes tabs).
    return /\/work-orders\/\d+\/proposals\/client-proposals\/?$/.test(location.pathname || '');
  }
  function proposalIdFromRow(row) {
    // The proposal id is in the row's own id ("table-row-517386"). NEVER scrape the visible
    // "number" column - that shows the proposal NUMBER (1,2,3), not the id copyProposal needs.
    var m = /table-row-(\d+)/.exec((row && row.id) || '');
    return m ? parseInt(m[1], 10) : null;
  }
  // ---- Copy as a native item in the row's "..." (More) menu ------------------
  // History: 0.1.3-0.1.10 gave Copy its own cell/column, which on this table-layout:fixed +
  // <colgroup> grid starved the operator's Gross Profit % column (an extra cell with no matching
  // <col> stole a column's width and shifted every native column right by one). 0.1.11 drops the
  // standalone control entirely and instead adds a native-styled "Copy to another WO..." item to
  // the row's EXISTING actions menu - the same MUI menu the "..." kebab opens (View Audit /
  // Duplicate / Send Email / ...). Zero table footprint; it reads as one of Umbrava's own actions.
  //
  // That menu is a <ul role="menu"> portaled to <body>, built on kebab click and destroyed on
  // close (verified live 2026-08-19). It carries no row id, so: (1) a capture-phase click listener
  // records which proposal row's kebab was clicked, and (2) a MutationObserver on <body> appends
  // our item when the menu element appears. Both re-run every open. Closing: the menu ignores
  // synthetic events, so on select we HIDE its portal node and let React unmount it (see
  // closeActionsMenu).
  var _pcPendingPid = null, _pcPendingAt = 0;
  var PC_PENDING_TTL_MS = 4000;   // a recorded kebab click counts as "fresh" only this long

  // (1) Record the row's proposal id the instant its kebab is clicked - capture phase, so it runs
  // before React opens the menu. Gated + route-scoped; never guesses a row.
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
        if (pid != null) { _pcPendingPid = pid; _pcPendingAt = Date.now(); }
      } catch (err) { }
    }, true);
  } catch (e) { }

  // Distinguish the proposal actions menu from any other MUI menu that might open, by its native
  // items - so we never inject our item into an unrelated menu.
  function isProposalActionsMenu(menu) {
    var txt = (menu && menu.textContent) || '';
    return /View Audit/i.test(txt) || /Convert to Invoice/i.test(txt) || /Work Order Notes/i.test(txt);
  }
  function closeActionsMenu() {
    // This menu trusts only REAL events - synthetic Escape / click-away / kebab-toggle are all
    // ignored (measured live 2026-08-19), so we cannot script the native close. Instead HIDE the
    // menu's portal node immediately; React still owns it and unmounts it cleanly on the user's next
    // real interaction (inevitable once the drawer is up). Hiding is safe here where REMOVING the
    // node would make React throw on its later unmount.
    try {
      var menu = document.querySelector('ul[role="menu"]');
      if (!menu) return;
      var node = menu;
      while (node.parentElement && node.parentElement !== document.body) node = node.parentElement;
      node.style.display = 'none';   // the MuiPopper-root portal wrapper
    } catch (e) { }
  }
  // (2) Add our "Copy to another WO..." item to a freshly opened actions menu. Idempotent.
  function injectMenuItem(menu) {
    if (!menu || !gated() || !onClientProposalsList()) return;
    if (_pcPendingPid == null || (Date.now() - _pcPendingAt) > PC_PENDING_TTL_MS) return;  // no fresh row context
    if (!isProposalActionsMenu(menu)) return;   // menu may still be rendering its items - a retry catches it
    var pid = _pcPendingPid;
    var existing = menu.querySelector('.' + MENU_ITEM_CLASS);
    if (existing) { if (existing.getAttribute('data-pid') === String(pid)) return; existing.remove(); }
    // Borrow a live native item's className so ours matches the menu chrome exactly (the MUI/emotion
    // hash changes per build, so copy it at runtime rather than hardcoding it).
    var sib = menu.querySelector('li[role="menuitem"]:not(.Mui-disabled), a[role="menuitem"]');
    var li = document.createElement('li');
    li.className = (sib ? sib.className : 'MuiButtonBase-root MuiMenuItem-root MuiMenuItem-gutters') + ' ' + MENU_ITEM_CLASS;
    li.setAttribute('role', 'menuitem');
    li.setAttribute('tabindex', '-1');
    li.setAttribute('data-pid', String(pid));
    li.style.gap = '8px';
    li.title = 'Copy this proposal onto another work order as a Draft';
    // Feather "copy" icon + label. Static markup (no user data) - innerHTML is safe here; the label
    // itself is set via textContent.
    li.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="flex:0 0 auto" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span></span>';
    var span = li.querySelector('span'); if (span) span.textContent = 'Copy to another WO…';
    li.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      closeActionsMenu();
      openDrawer(pid);
    });
    // Place it just under the first native item (below "View Audit").
    var first = menu.querySelector('li[role="menuitem"],a[role="menuitem"]');
    if (first && first.nextSibling) menu.insertBefore(li, first.nextSibling);
    else menu.appendChild(li);
  }
  function scanMenus() {
    Array.prototype.forEach.call(document.querySelectorAll('ul[role="menu"]'), function (m) {
      try { injectMenuItem(m); } catch (e) { }
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
  // Self-contained overlay close - a plain remove, NOT the suite's shared .bwn-closing
  // drawer-exit animation (this is the no-host-fallback overlay per the DESIGN NOTE, so it
  // deliberately does not carry the shared drawer primitive). Named to avoid colliding with
  // the shared `drawerDismiss` the UI-contract ledger detects (harness would then require the
  // full shared exit contract this overlay intentionally does not implement).
  function pcRemoveDrawer(el) {
    try { el.remove(); } catch (e) { }
  }
  function closeDrawer() {
    if (!openEl) return;
    document.removeEventListener('keydown', onKeyClose);
    pcRemoveDrawer(openEl);
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
    pcState = { hasToken: !!authToken(), source: null, sourceWo: null, target: null };

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
      pcState.hasToken = !!authToken();   // re-check - the drawer may have sat open a while
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
        // Build the "open W-<n>" link with DOM APIs, never string-interpolation into innerHTML:
        // target.number is Number()-coerced into the href and set as textContent, so it cannot
        // inject regardless of source.
        // UNVERIFIED: the exact Proposals-TAB deep-link shape (query/hash param). The bare
        // WO route below is proven (onProposalPage's own match); landing on the Proposals
        // tab specifically is not confirmed - the operator may need one extra click there.
        var openLink = document.createElement('a');
        openLink.href = '/work-orders/' + Number(target.number);
        openLink.style.cssText = 'color:#0d3d26;font-weight:600;';
        openLink.textContent = 'open W-' + target.number;

        var rb = r.readBack;
        if (rb && rb.match === false) {
          // The Draft WAS created, but the read-back of the new proposal did not match the source:
          // a dropped line item, a changed subtotal, or a client PO the edit silently nulled - all
          // on a client-facing money document. Report "created, but verify" with the specifics, NOT
          // a green success, and log the full read-back so the drop is never silent.
          var diffs = [];
          if (rb.newItems !== rb.sourceItems) diffs.push('line items ' + rb.sourceItems + ' -> ' + rb.newItems);
          if (rb.sourceSubtotal != null && rb.newSubtotal !== rb.sourceSubtotal) diffs.push('subtotal changed');
          if (rb.sourcePO !== rb.newPO) diffs.push('client PO ' + (rb.sourcePO || 'none') + ' -> ' + (rb.newPO || 'none'));
          console.warn('[BWN PROPOSAL COPY] read-back did NOT match the source on the new Draft', rb);
          pcToast('Copied to W-' + target.number + ', but the read-back did NOT match - verify it.');
          progress.className = 'bwn-pc-warn';
          progress.textContent = 'Created as a Draft, but VERIFY (' + (diffs.join('; ') || 'read-back differs') + ') - ';
          progress.appendChild(openLink);
          progress.appendChild(document.createTextNode(' and check its line items, total and client PO.'));
          // confirmBtn stays disabled: the Draft exists, so re-running would create a duplicate.
          cancelBtn.disabled = false;
          confirmBtn.textContent = 'Created - verify';
          // Deliberately no auto-close: leave the warning on screen until the operator dismisses it.
        } else {
          pcToast('Copied to W-' + target.number + ' as a new Draft proposal.');
          progress.className = 'bwn-pc-ok';
          progress.textContent = 'Done - ';
          progress.appendChild(openLink);
          progress.appendChild(document.createTextNode(' and check its Proposals tab.'));
          confirmBtn.textContent = 'Copied';
          setTimeout(closeDrawer, 3000);
        }
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

  // ---- lifecycle: inject our item whenever the actions menu opens -----------
  // The menu is portaled to <body> on kebab click. Watch for the <ul role="menu"> being added and
  // inject then. Because React may attach the menu container a tick before it fills in its items,
  // a couple of short retries catch the case where isProposalActionsMenu() was not yet true.
  function pcOnMenuMaybeOpened() {
    scanMenus();
    setTimeout(scanMenus, 60);
    setTimeout(scanMenus, 200);
  }
  try {
    var pcObs = new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var added = muts[i].addedNodes;
        for (var j = 0; j < added.length; j++) {
          var n = added[j];
          if (!n || n.nodeType !== 1) continue;
          if ((n.matches && n.matches('ul[role="menu"]')) ||
              (n.querySelector && n.querySelector('ul[role="menu"]'))) {
            pcOnMenuMaybeOpened();
            break;
          }
        }
      }
    });
    pcObs.observe(document.body, { childList: true, subtree: true });
  } catch (e) { }
  // Catch a menu that was already open when we loaded (or that the observer missed).
  scanMenus();

})();
