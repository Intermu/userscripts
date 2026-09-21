// ==UserScript==
// @name         BWN Proposal Copy (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.4.0
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

  var VER = '0.4.0';   // keep in step with @version
  var DRY_RUN = false; // when true, the two WRITE mutations are logged, not sent
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  var GREEN = '#0d3d26';
  console.info('[BWN PROPOSAL COPY] v' + VER + ' - copy client proposal to another WO as a Draft (createDraftProposal + editProposal replay)');

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

  // 0.4.0 note: the shared drawerDismiss helper was dropped when Copy Proposal moved OFF the dock-rail
  // .bwn-drawer into its own wide centered workflow modal (see the DESIGN NOTE in the UI section). The
  // modal owns a self-contained reduced-motion-aware close (bcpRemove) instead. bwnFocusTrap above is
  // kept - the centered modal still traps focus.

  // RM-B2 error-reporter adoption: leave a bounded, PII-FREE bwn:errlog breadcrumb via Core's
  // window.bwnReport (both @grant none, shared page window) when the errorReporter flag is ON, so a
  // user-facing WRITE failure/degrade here (the copy failed, or the Draft was created but its
  // read-back did not match the source money document) is recorded durably instead of living only in
  // the drawer + a console.warn. The operator still sees THIS script's own drawer message + pcToast
  // unchanged - we pass NO `toast` field, so Core's toast never fires and the drawer stays the sole
  // surface. The breadcrumb carries a short FIXED tag, SCALAR ids (proposal id + WO#) and a short
  // stage `code` ONLY, NEVER line items, amounts, client PO, a client name, or the error text. Core
  // absent or the flag OFF => a no-op, so flag-OFF behavior is byte-identical. (Pinned by
  // test-error-reporter.js.) This is SEPARATE from this script's own bwn:audit ring, which the
  // reporter never touches.
  function reportFail(o) { try { if (typeof window.bwnReport === 'function') window.bwnReport(o); } catch (e) { } }

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

  // ===== BWN-PERM START v1 (paste-identical; pinned by scripts/test-perm-block-ledger.js) =====
  // Umbrava's own per-user permission checkboxes, as the one question a control has:
  //   bwnCan('WorkOrderNote.AddNew') -> true | false
  // Umbrava returns me.permissions as a JSON STRING of {"<Type>Permissions": "<bitmask>"} - one
  // bit per checkbox on /company/users/<id>/permissions. bwn-suite-core decodes it once a session
  // and publishes the DECODED grant list to `bwn:perm:last` + the `bwn:perm` bus event, the same
  // one-way producer/consumer shape as bwn:role. This block only READS that slot, so every
  // sandbox that pastes it needs neither the query, the token, nor the flag numbers.
  //
  // FAIL-OPEN on anything unknown - no slot yet, a stale slot, or a group the producer does not
  // map. Umbrava's server is the real boundary (it refuses the mutation either way), so an
  // unreadable cache must never strand a coordinator mid-shift. Fail-CLOSED only on a
  // positively-known missing bit. localStorage is per-origin, so this answers "unknown" (and
  // therefore allows) anywhere but app.umbrava.com - by design.
  var BWN_PERM_KEY = 'bwn:perm:last';
  var BWN_PERM_TTL_MS = 24 * 3600 * 1000;
  var _bwnPermSlot = null;      // memoized parse; invalidated by the bwn:perm listener below
  function bwnPermSlot() {
    if (_bwnPermSlot) return _bwnPermSlot;
    try {
      var p = JSON.parse(localStorage.getItem(BWN_PERM_KEY) || 'null');
      if (p && p.ts && (Date.now() - p.ts) < BWN_PERM_TTL_MS &&
        Array.isArray(p.groups) && Array.isArray(p.granted)) _bwnPermSlot = p;
    } catch (e) { /* an unreadable cache reads as unknown, which fails open */ }
    return _bwnPermSlot;
  }
  function bwnCan(key) {
    var p = bwnPermSlot();
    if (!p) return true;                                          // nothing decoded yet -> allow
    var grp = String(key).split('.')[0];
    if (p.groups.indexOf(grp) === -1) return true;                // group unmapped/absent -> allow
    return p.granted.indexOf(key) !== -1;
  }
  // keys: a 'Group.Flag' string, or an array of them (ALL must be granted).
  function bwnCanAll(keys) {
    if (!keys) return true;
    if (typeof keys === 'string') return bwnCan(keys);
    for (var i = 0; i < keys.length; i++) { if (!bwnCan(keys[i])) return false; }
    return true;
  }
  // patchWorkOrder is ONE mutation over MANY fields and Umbrava gates each field separately, so
  // its permission depends on the variables rather than the operation. This maps the data keys the
  // suite actually sends, all of them wire-proven; a key this map does not know contributes NO
  // requirement, which is the block's unknown -> allow rule and keeps a future field from being
  // blocked by a map nobody updated. `workOrderNumber` is the identifier, not a field write.
  var BWN_PATCH_FIELD_PERM = {
    statusId: 'WorkOrderField.Status',
    assignedTo: 'WorkOrderField.AssignedTo',
    // ECD rides inside the whole-object `priority` replace, and the SPA bundles the SLA id with it.
    priority: 'WorkOrderField.CompletionSLA',
    serviceLevelAgreementId: 'WorkOrderField.CompletionSLA',
    sourceJobNumber: 'WorkOrderField.SourceJobNumber',
    sourcePurchaseOrderNumber: 'WorkOrderField.SourcePurchaseOrderNumber'
  };
  // -> [] | ['WorkOrderField.Status', ...]; deduped, so a bundled priority+SLA asks once.
  function bwnPermsForPatch(variables) {
    var data = (variables && variables.data) || {};
    var out = [];
    Object.keys(data).forEach(function (k) {
      var p = BWN_PATCH_FIELD_PERM[k];
      if (p && out.indexOf(p) === -1) out.push(p);
    });
    return out;
  }
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:perm') _bwnPermSlot = null;          // a fresh decode landed
    });
  } catch (e) { }
  // ===== BWN-PERM END v1 =====
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
    createDraftProposal: { kind: 'write', perm: 'WorkOrderProposal.AddNew', target: 'proposal', risk: 'high', idempotent: false, retry: 'none',
      ok: 'Draft proposal created.', fail: 'The draft proposal was not created.' },
    editProposal: { kind: 'write', perm: 'WorkOrderProposal.EditFields', target: 'proposal', risk: 'high', idempotent: false, retry: 'none',
      ok: 'Proposal updated.', fail: 'The proposal was not updated.' }
  };
  // ===== BWN-OPS-WRAP START v3 (paste-identical across adopters; SHA-gated by scripts/test-bwn-ops.js) =====
  // v3 (2026-09-02) adds the Umbrava permission gate (G7 below). It closes over bwnCan/bwnCanAll
  // from the BWN-PERM block, so an adopter of this wrapper must carry that block too - the ledger
  // in scripts/test-perm-block-ledger.js is what keeps the two lists in step.
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

    // Fail-closed write classification (G5): a WRITE must carry a RECOGNIZED risk tier. An
    // unclassified write - a registry entry whose risk is missing or misspelled - is REFUSED here
    // rather than sent unlabelled, so a new mutation cannot slip past the governance by omitting
    // its risk. 'low'/'moderate' skip the confirm gate below; 'high' hits it; anything else fails
    // closed. Reads are unaffected (isWrite guards this). Audited denied so the refusal is visible.
    if (isWrite && meta.risk !== 'low' && meta.risk !== 'moderate' && meta.risk !== 'high') {
      writeAudit('denied', { reason: 'unclassified-write:' + (meta.risk || 'none') });
      return Promise.reject(new Error('bwnGqlOp: write "' + op + '" has no recognized risk classification'));
    }
    // Per-feature kill switch: a disabled module must not mutate even if its UI leaked in.
    if (opts.feature && BWN_MODULES[opts.feature] === false) {
      writeAudit('denied', { reason: 'feature-off:' + opts.feature });
      return Promise.reject(new Error('bwnGqlOp: feature "' + opts.feature + '" is disabled'));
    }
    // Umbrava permission gate (G7). The UI hides a control the operator's checkboxes do not cover,
    // but hiding is not enforcement: a palette entry, a stale drawer, a queued command, or a future
    // caller can all reach a write whose button was never rendered. This is the enforcement point -
    // every registered write passes through here, so ONE guard covers every caller.
    //   meta.perm  'Group.Flag' | ['Group.Flag', ...] | fn(variables) -> either of those
    // A function is how a multi-field mutation (patchWorkOrder) asks per FIELD instead of per op.
    // bwnCanAll fails OPEN on anything undecided - no slot, a stale slot, an unmapped group - so
    // this refuses ONLY a positively-known missing checkbox. Refusals are non-transient (retrying
    // cannot grant a permission) and audited `denied`, so a refusal is visible in the ring rather
    // than silent. The reason carries the permission NAME, which is a static key, never user data.
    if (isWrite && meta.perm) {
      var need = (typeof meta.perm === 'function') ? meta.perm(variables) : meta.perm;
      if (typeof need === 'string') need = [need];
      if (!Array.isArray(need)) need = [];
      if (need.length && !bwnCanAll(need)) {
        var missing = need.filter(function (k) { return !bwnCan(k); });
        writeAudit('denied', { reason: 'permission:' + missing.join('+') });
        var noPerm = new Error('bwnGqlOp: "' + op + '" needs Umbrava permission ' + missing.join(' + ') + ' - the write was NOT sent.');
        noPerm.bwnNonTransient = true;
        noPerm.bwnPermissionDenied = missing;
        return Promise.reject(noPerm);
      }
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
          // F3: fail closed on an unrecognized write response. A registered write MUST return
          // { success: <bool>, ... } under its own field name (op === the response field name
          // for every adopter). A missing data[op] (a name/alias mismatch) or a non-boolean
          // success means the write cannot be confirmed to have landed - classify it as an
          // error, never a silent 'ok'. Verified safe: every current adopter selects `success`.
          if (!env || typeof env.success !== 'boolean') {
            var badShape = new Error(op + ': unrecognized write response (no {success} under data.' + op + ')');
            badShape.bwnNonTransient = true;
            writeAudit('error', { tries: tryNo, reason: 'unexpected-response-shape' });
            throw badShape;
          }
          if (env && env.success === false) {
            var refused = new Error(env.message || (op + ' was refused'));
            refused.bwnNonTransient = true;
            // F5: record a fixed category, never the server message (env.message can echo
            // input-derived text). The message still rides the thrown `refused` to the caller.
            writeAudit('error', { tries: tryNo, reason: 'write-refused' });
            throw refused;
          }
          writeAudit('ok', { tries: tryNo });
        }
        return data;
      }, function (err) {
        if (bwnIsTransient(err) && tryNo < maxTries) {
          return bwnDelay(bwnBackoff(tryNo)).then(function () { return attempt(tryNo + 1); });
        }
        // F5: audit a fixed category, never the raw error text (which can echo input-derived
        // server strings into the "PII-free" trail). The full error still rides the thrown err
        // to the caller for its toast/log.
        writeAudit('error', { tries: tryNo, reason: bwnIsTransient(err) ? 'transient-failure' : 'request-failed' });
        throw err;
      });
    }
    // High-risk confirmation gate (fail-closed, by construction). F4: a risk:'high' write has
    // NO path to the transport except through this block - it returns in every sub-case (send
    // or reject), so the trailing `return attempt(1)` below is reachable only by non-high-risk
    // ops. A future high-risk writer therefore cannot skip the gate by omission: an absent
    // confirmation is refused, never silently sent. Confirmation is proven EITHER by the
    // caller's own UI (opts.confirmed===true, e.g. dispatch's modal) OR by an injected _confirmFn
    // returning truthy.
    // KNOWN RESIDUAL (flagged, NOT closed here): opts.confirmed===true is a caller assertion the
    // wrapper trusts - it cannot tell a genuine confirm from a hardcoded literal. Closing that
    // would mean dropping bare-boolean trust and mandating an injected _confirmFn, which every
    // current high-risk adopter would fail (none inject one) - a live-behavior change, out of scope.
    if (isWrite && meta.risk === 'high') {
      if (opts.confirmed !== true) {
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
    return attempt(1);
  }
  bwnGqlOp.setConfirm = function (fn) { _confirmFn = (typeof fn === 'function') ? fn : null; };
  // ===== BWN-OPS-WRAP END v3 =====

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
  // Existing client proposals on a WO, for the pre-copy duplicate check (0.4.0). READ-ONLY.
  // Shape verified from [[umbrava-graphql-operations]] (listClientProposals, introspected): keys off
  // jobId (== ProposalWO's job.id), jobType enum literal WorkOrder. Selects only what the dup panel
  // shows - number, description, type, state, status, subtotal - never line items or PII.
  var Q_LIST_CLIENT_PROPOSALS = 'query ListClientProposals($jobId: Int, $page: PageInput!) { listClientProposals(jobId: $jobId, jobType: WorkOrder, page: $page) { rowCount items { id number description state type { id name } status { id name } subtotal { amount currency precision } } } }';

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

  // ---- duplicate check (DOM-free, sliced + tested by the node harness) ------
  // Non-blocking REVIEW only. We compare the source proposal against the target WO's existing client
  // proposals (from Q_LIST_CLIENT_PROPOSALS) and surface a "similar proposal may already exist"
  // review when a candidate matches - NEVER an auto-block, because neither signal below establishes
  // an EXACT duplicate (a shared description or a coincident subtotal is common and legitimate). The
  // operator reviews the evidence and decides. Match = same normalized non-empty description OR the
  // same subtotal (amount+currency+precision). moneyEq guards null/precision so two absent totals do
  // not read as equal.
  function dupNormDesc(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim().toLowerCase(); }
  function dupMoneyEq(a, b) {
    if (!a || !b || a.amount == null || b.amount == null) return false;
    return Number(a.amount) === Number(b.amount) && (a.currency || '') === (b.currency || '') &&
      (a.precision == null ? 2 : a.precision) === (b.precision == null ? 2 : b.precision);
  }
  // -> array of the existing proposals that look like the source. Empty = Safe. `source` is the
  // ClientProposalDetails read; `items` is listClientProposals.items for the TARGET WO.
  function dupFindMatches(source, items) {
    source = source || {};
    var srcDesc = dupNormDesc(source.description);
    var srcSub = source.subtotal;
    return (items || []).filter(function (p) {
      if (!p) return false;
      var descHit = srcDesc !== '' && dupNormDesc(p.description) === srcDesc;
      var subHit = dupMoneyEq(srcSub, p.subtotal);
      return descHit || subHit;
    });
  }

  // ===== ui =================================================================
  // Actions-menu item injection + the Copy Proposal workflow modal (source review -> destination
  // -> create & verify), plus its progress/success/error states.
  //
  // DESIGN NOTE (0.4.0 workflow-modal redesign): Copy Proposal now renders as a SELF-CONTAINED,
  // wide (760px) centered workflow modal with its own `.bcp-*` stylesheet - NOT the 0.3.0 dock-rail
  // `.bwn-drawer`. Why the move: the operation needs a real review surface (source summary + line
  // items + destination validation + pre-copy duplicate check + a confirmation card) that a 420px
  // rail cannot hold without becoming a scroll tunnel. The modal borrows WO Audit's VISUAL LANGUAGE
  // (deep evergreen header, off-white canvas, white cards with restrained borders/shadow, 8px
  // rhythm, accessible green/amber/red/blue states, inline SVG icons only) but owns all of its own
  // CSS so it does not depend on Core's sheet being present. It keeps the bwnFocusTrap a11y trap and
  // adds its own reduced-motion-aware close (bcpRemove) using CSS transitions only. Still gated the
  // same way (rank>=4 + both proposal permissions) and still announces bwn:drawer:open so a Core
  // drawer yields. The copy ENGINE (copyProposal + queries + validation) is untouched - this is a
  // UI layer over it.
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
    // The item creates a DRAFT proposal on the target work order and then fills its line items, so
    // it needs both proposal checkboxes. Fails OPEN while the permission decode is unknown.
    if (!bwnCanAll(['WorkOrderProposal.AddNew', 'WorkOrderProposal.EditFields'])) return;
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
      openModal(pid);
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
      'background:' + GREEN + ';color:#fff;padding:10px 18px;border-radius:8px;' +
      'font:500 13px ' + FONT + ';box-shadow:0 6px 24px rgba(0,0,0,.3);';
    el.textContent = 'BWN Proposal Copy: ' + msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 5000);
  }

  // ---- workflow-modal shell (self-contained .bcp-* UI; see DESIGN NOTE above) ----
  var DRAWER_KEY = 'proposal-copy';
  var activeModal = null;    // the current .bcp-ov overlay element, or null
  var modalBusy = false;     // a create request is in flight (non-cancellable): block close/Escape

  // Inline SVG icon set (Feather-style, 1.9 stroke, currentColor). aria-hidden - labels carry meaning.
  function bcpIcon(name, size) {
    var s = size || 16;
    var p = {
      copy: '<rect x="9" y="9" width="13" height="13" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>',
      file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline>',
      list: '<line x1="8" y1="6" x2="21" y2="6"></line><line x1="8" y1="12" x2="21" y2="12"></line><line x1="8" y1="18" x2="21" y2="18"></line><line x1="3" y1="6" x2="3.01" y2="6"></line><line x1="3" y1="12" x2="3.01" y2="12"></line><line x1="3" y1="18" x2="3.01" y2="18"></line>',
      pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle>',
      search: '<circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line>',
      check: '<polyline points="20 6 9 17 4 12"></polyline>',
      warning: '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line>',
      shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>',
      info: '<circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line>',
      external: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line>',
      close: '<line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line>',
      lock: '<rect x="3" y="11" width="18" height="11" rx="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
      target: '<circle cx="12" cy="12" r="10"></circle><circle cx="12" cy="12" r="6"></circle><circle cx="12" cy="12" r="2"></circle>'
    }[name] || '';
    return '<svg class="bcp-ic" width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
  }

  // Own stylesheet - no dependency on Core's sheet or its CSS vars. WO Audit's visual language
  // (deep evergreen header, off-white canvas, white cards, 8px rhythm, accessible state colors),
  // transitions only (no `animation:`) so a headless/reduced-motion path stays honest.
  function ensureBcpStyle() {
    if (document.getElementById('bcp-style')) return;
    var st = document.createElement('style');
    st.id = 'bcp-style';
    st.textContent = [
      '.bcp-ov{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;background:rgba(9,24,18,.5);opacity:0;transition:opacity .16s ease;font-family:' + FONT + ';}',
      '.bcp-ov.bcp-in{opacity:1;}',
      '.bcp-ov.bcp-closing{opacity:0;}',
      '.bcp-modal{width:760px;max-width:100%;max-height:88vh;display:flex;flex-direction:column;background:#f4f6f5;border-radius:12px;overflow:hidden;box-shadow:0 18px 60px rgba(0,0,0,.35);transform:translateY(8px);opacity:0;transition:transform .18s cubic-bezier(.23,1,.32,1),opacity .18s ease;color:#1f2a24;box-sizing:border-box;}',
      '.bcp-ov.bcp-in .bcp-modal{transform:none;opacity:1;}',
      '.bcp-hd{background:#0d3d26;color:#fff;padding:16px 20px;display:flex;align-items:flex-start;gap:14px;}',
      '.bcp-hd-main{flex:1;min-width:0;}',
      '.bcp-eyebrow{font:600 10px ui-monospace,"SF Mono","Segoe UI Mono",monospace;letter-spacing:.14em;color:rgba(255,255,255,.62);}',
      '.bcp-title{font:600 18px ' + FONT + ';margin-top:3px;}',
      '.bcp-sub{font:400 12.5px ' + FONT + ';color:rgba(255,255,255,.78);margin-top:3px;}',
      '.bcp-badge{flex:none;display:inline-flex;align-items:center;gap:6px;padding:4px 11px;border-radius:999px;font:600 11px ' + FONT + ';background:rgba(255,255,255,.16);color:#fff;white-space:nowrap;}',
      '.bcp-badge .bcp-bdot{width:7px;height:7px;border-radius:50%;background:currentColor;flex:none;}',
      '.bcp-badge.busy{background:#f4e3c1;color:#6b4700;}',
      '.bcp-badge.good{background:#bfe3cc;color:#0d3d26;}',
      '.bcp-badge.review{background:#f6dca6;color:#6b4700;}',
      '.bcp-badge.err{background:#f3c1bc;color:#7b1a12;}',
      '.bcp-x{flex:none;width:30px;height:30px;border:none;border-radius:8px;cursor:pointer;background:rgba(255,255,255,.14);color:#fff;display:flex;align-items:center;justify-content:center;}',
      '.bcp-x:hover{background:rgba(255,255,255,.26);}',
      '.bcp-x:focus-visible{outline:2px solid #7fd3a3;outline-offset:2px;}',
      '.bcp-steps{display:flex;align-items:center;padding:11px 20px;background:#0a3120;color:#fff;}',
      '.bcp-step{display:flex;align-items:center;gap:8px;flex:0 0 auto;opacity:.5;}',
      '.bcp-step.active,.bcp-step.done{opacity:1;}',
      '.bcp-step-n{width:22px;height:22px;border-radius:50%;border:1.5px solid rgba(255,255,255,.5);display:flex;align-items:center;justify-content:center;font:600 11px ' + FONT + ';flex:none;}',
      '.bcp-step.active .bcp-step-n{background:#fff;color:#0d3d26;border-color:#fff;}',
      '.bcp-step.done .bcp-step-n{background:#2ecc71;border-color:#2ecc71;color:#0a3120;}',
      '.bcp-step-l{font:600 12px ' + FONT + ';white-space:nowrap;}',
      '.bcp-step-bar{flex:1;height:1.5px;background:rgba(255,255,255,.25);margin:0 12px;min-width:14px;}',
      '.bcp-body{flex:1;overflow:auto;padding:16px 20px;display:flex;flex-direction:column;gap:16px;}',
      '.bcp-card{background:#fff;border:1px solid #e3e9e5;border-radius:10px;box-shadow:0 1px 2px rgba(16,40,28,.05);overflow:hidden;}',
      '.bcp-card.accent{border-color:#cfe6d8;box-shadow:0 1px 2px rgba(16,40,28,.05),0 0 0 1px rgba(21,121,74,.08);}',
      '.bcp-card-hd{display:flex;align-items:center;gap:9px;padding:11px 14px;border-bottom:1px solid #eef2ef;}',
      '.bcp-card-hd .bcp-ic{color:#15794a;flex:none;}',
      '.bcp-card-t{font:600 13px ' + FONT + ';flex:1;min-width:0;}',
      '.bcp-card-meta{font:600 11.5px ' + FONT + ';color:#5a6b62;display:flex;gap:12px;align-items:center;}',
      '.bcp-card-bd{padding:14px;}',
      '.bcp-chip{display:inline-block;padding:2px 8px;border-radius:6px;background:#eef3f0;color:#0d3d26;font:600 11px ui-monospace,"SF Mono",monospace;}',
      '.bcp-tiles{display:grid;grid-template-columns:2fr 1fr 1fr;gap:10px;margin-bottom:12px;}',
      '.bcp-tile{background:#f7faf8;border:1px solid #e8efe9;border-radius:9px;padding:10px 12px;}',
      '.bcp-tile .k{font:600 10px ui-monospace,"SF Mono",monospace;letter-spacing:.04em;color:#5a6b62;text-transform:uppercase;}',
      '.bcp-tile .v{font:600 15px ' + FONT + ';color:#1f2a24;margin-top:3px;}',
      '.bcp-tile.total{background:#eef6f0;border-color:#cfe6d8;}',
      '.bcp-tile.total .v{font-size:21px;color:#0d3d26;}',
      '.bcp-meta{font:400 12.5px ' + FONT + ';color:#5a6b62;line-height:1.7;}',
      '.bcp-meta strong{color:#1f2a24;font-weight:600;}',
      '.bcp-note{display:flex;gap:8px;align-items:flex-start;border-radius:8px;padding:8px 11px;font:400 12.5px ' + FONT + ';margin-top:8px;line-height:1.5;}',
      '.bcp-note .bcp-ic{flex:none;margin-top:1px;}',
      '.bcp-note.info{background:#eaf1f8;color:#1c4f7c;}',
      '.bcp-note.warn{background:#fff4e5;color:#8a5a00;}',
      '.bcp-note.err{background:#fdecea;color:#8b1a1a;}',
      '.bcp-note.ok{background:#e8f3ed;color:#0d3d26;}',
      '.bcp-scroll{max-height:250px;overflow:auto;border:1px solid #eef2ef;border-radius:8px;}',
      '.bcp-tbl{width:100%;border-collapse:collapse;font:400 12px ' + FONT + ';}',
      '.bcp-tbl th{position:sticky;top:0;background:#f3f6f4;color:#5a6b62;font-weight:600;text-align:left;padding:7px 10px;border-bottom:1px solid #e3e9e5;z-index:1;}',
      '.bcp-tbl td{padding:7px 10px;border-bottom:1px solid #f0f3f1;vertical-align:top;}',
      '.bcp-tbl tr:last-child td{border-bottom:none;}',
      '.bcp-tbl .num{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;}',
      '.bcp-tbl .zero{color:#8a5a00;font-weight:600;}',
      '.bcp-linkbtn{background:none;border:none;color:#15794a;font:600 12px ' + FONT + ';cursor:pointer;padding:0;text-decoration:underline;}',
      '.bcp-linkbtn:focus-visible{outline:2px solid #15794a;outline-offset:2px;}',
      '.bcp-sumrow{display:flex;justify-content:space-between;align-items:center;padding:9px 2px 0;font:600 12.5px ' + FONT + ';color:#1f2a24;}',
      '.bcp-lbl{display:block;font:600 12px ' + FONT + ';color:#1f2a24;margin:0 0 5px;}',
      '.bcp-inp{width:100%;box-sizing:border-box;padding:9px 11px;border:1px solid #d3ddd7;border-radius:8px;font:400 13px ' + FONT + ';background:#fff;color:#1f2a24;outline:none;}',
      '.bcp-inp:focus{border-color:#15794a;box-shadow:0 0 0 3px rgba(21,121,74,.14);}',
      '.bcp-search{position:relative;}',
      '.bcp-search>.bcp-ic{position:absolute;left:10px;top:50%;transform:translateY(-50%);color:#7a8a80;pointer-events:none;}',
      '.bcp-search select,.bcp-search input{padding-left:32px;}',
      '.bcp-or{font:600 11px ui-monospace,"SF Mono",monospace;color:#7a8a80;text-align:center;margin:9px 0;letter-spacing:.06em;}',
      '.bcp-target{border:1px solid #cfe6d8;background:#f2f9f5;border-radius:9px;padding:11px 13px;display:flex;gap:10px;align-items:flex-start;}',
      '.bcp-target>.bcp-ic{color:#15794a;flex:none;margin-top:2px;}',
      '.bcp-target-main{flex:1;min-width:0;}',
      '.bcp-target-wo{font:600 14px ' + FONT + ';color:#0d3d26;}',
      '.bcp-target-loc{font:400 12.5px ' + FONT + ';color:#5a6b62;margin-top:2px;}',
      '.bcp-check{display:flex;gap:9px;align-items:flex-start;padding:1px 0;font:400 12.5px ' + FONT + ';line-height:1.5;}',
      '.bcp-check .bcp-ic{flex:none;margin-top:1px;}',
      '.bcp-check.ok{color:#0d3d26;}.bcp-check.ok .bcp-ic{color:#15794a;}',
      '.bcp-check.review{color:#8a5a00;}.bcp-check.review .bcp-ic{color:#b6791a;}',
      '.bcp-check.err{color:#8b1a1a;}.bcp-check.err .bcp-ic{color:#b83a2e;}',
      '.bcp-check.busy{color:#5a6b62;}',
      '.bcp-evi{margin-top:9px;border:1px solid #f0dcb4;border-radius:8px;overflow:hidden;}',
      '.bcp-evi-row{display:flex;justify-content:space-between;gap:12px;padding:7px 11px;font:400 12px ' + FONT + ';border-bottom:1px solid #f6ead1;background:#fffdf8;}',
      '.bcp-evi-row:last-child{border-bottom:none;}',
      '.bcp-evi-row .n{font-weight:600;color:#1f2a24;}',
      '.bcp-confirm{background:#eef6f0;border:1px solid #cfe6d8;border-radius:10px;padding:12px 14px;font:400 13px ' + FONT + ';color:#1f2a24;line-height:1.55;}',
      '.bcp-confirm strong{color:#0d3d26;}',
      '.bcp-confirm .sub{font-size:12px;color:#5a6b62;margin-top:6px;}',
      '.bcp-ft{flex:none;display:flex;gap:10px;align-items:center;padding:12px 20px;background:#fff;border-top:1px solid #e3e9e5;}',
      '.bcp-ft-spacer{flex:1;}',
      '.bcp-btn{display:inline-flex;align-items:center;gap:7px;padding:9px 16px;border-radius:8px;border:1px solid transparent;font:600 13px ' + FONT + ';cursor:pointer;}',
      '.bcp-btn:focus-visible{outline:2px solid #15794a;outline-offset:2px;}',
      '.bcp-btn.primary{background:#15794a;color:#fff;}',
      '.bcp-btn.primary:hover{background:#0f6b40;}',
      '.bcp-btn.ghost{background:#fff;border-color:#d3ddd7;color:#1f2a24;}',
      '.bcp-btn.ghost:hover{background:#f4f6f5;}',
      '.bcp-btn.neutral{background:#eef2ef;color:#3a4a42;}',
      '.bcp-btn:disabled{opacity:.5;cursor:default;}',
      '.bcp-btn .bcp-ic{flex:none;}',
      '.bcp-empty{color:#7a8a80;font-style:italic;}',
      '.bcp-tech{margin-top:8px;}',
      '.bcp-tech summary{cursor:pointer;font:600 11.5px ' + FONT + ';color:#5a6b62;}',
      '.bcp-tech pre{white-space:pre-wrap;word-break:break-word;font:11px ui-monospace,"SF Mono",monospace;color:#5a6b62;background:#f4f6f5;border-radius:6px;padding:8px;margin:6px 0 0;max-height:120px;overflow:auto;}',
      '@media (max-width:720px){.bcp-tiles{grid-template-columns:1fr;}.bcp-step-l{display:none;}.bcp-step-bar{margin:0 8px;}.bcp-ft{flex-wrap:wrap;}}',
      '@media (prefers-reduced-motion:reduce){.bcp-ov,.bcp-modal{transition:none;}}'
    ].join('');
    document.head.appendChild(st);
  }

  // Self-contained reduced-motion-aware close (replaces the shared drawerDismiss). bwnFocusTrap
  // self-releases when the node leaves the DOM, restoring focus to the opener.
  function bcpRemove(ov) {
    var reduce = false;
    try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { }
    if (reduce) { try { ov.remove(); } catch (e) { } return; }
    ov.classList.add('bcp-closing'); ov.classList.remove('bcp-in');
    setTimeout(function () { try { ov.remove(); } catch (e) { } }, 190);
  }
  function closeModal(force) {
    if (!activeModal) return;
    if (modalBusy && !force) return;   // a create request in flight is non-cancellable
    document.removeEventListener('keydown', onKeyClose);
    bcpRemove(activeModal);
    activeModal = null; modalBusy = false;
  }
  function onKeyClose(e) { if (e.key === 'Escape' && !modalBusy) closeModal(); }
  // Suite bus: yield the slot to any other suite panel that opens (unless a create is in flight).
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:drawer:open' && d.key !== DRAWER_KEY && !modalBusy) closeModal();
    });
  } catch (e) { }

  // ---- state-machine helpers (badge + 3-step indicator; reflect REAL state only) --------------
  var STEP_LABELS = ['Review source', 'Select destination', 'Create & verify'];
  function setBadge(M, cls, text) {
    if (!M.badge) return;
    M.badge.className = 'bcp-badge' + (cls ? ' ' + cls : '');
    M.badge.innerHTML = '<span class="bcp-bdot"></span>';
    M.badge.appendChild(document.createTextNode(text));
    M.badge.setAttribute('aria-label', 'Status: ' + text);
  }
  // active = the 0-based step in progress; done = number of fully-completed leading steps.
  function setStep(M, active, done) {
    (M.stepEls || []).forEach(function (el, i) {
      var cls = 'bcp-step', mark = String(i + 1);
      if (i < done) { cls += ' done'; mark = '✓'; }
      else if (i === active) { cls += ' active'; }
      el.className = cls;
      var n = el.querySelector('.bcp-step-n'); if (n) n.textContent = mark;
    });
  }

  function openModal(sourceProposalId) {
    if (sourceProposalId == null) return;
    if (activeModal) closeModal(true);
    ensureBcpStyle();
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'bwn:drawer:open', key: DRAWER_KEY } })); } catch (e) { }

    var ov = document.createElement('div');
    ov.className = 'bcp-ov';
    var modal = document.createElement('div');
    modal.className = 'bcp-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'bcp-title');
    ov.appendChild(modal);

    // header
    var hd = document.createElement('div'); hd.className = 'bcp-hd';
    hd.innerHTML =
      '<div class="bcp-hd-main">' +
      '<div class="bcp-eyebrow">PROPOSAL OPERATIONS</div>' +
      '<div class="bcp-title" id="bcp-title">Copy proposal</div>' +
      '<div class="bcp-sub">Create a draft copy of this proposal on another work order.</div>' +
      '</div>';
    var badge = document.createElement('span');
    var x = document.createElement('button');
    x.className = 'bcp-x'; x.type = 'button'; x.setAttribute('aria-label', 'Close'); x.title = 'Close';
    x.innerHTML = bcpIcon('close', 18);
    x.addEventListener('click', function () { closeModal(); });
    hd.appendChild(badge); hd.appendChild(x);
    modal.appendChild(hd);

    // step indicator
    var steps = document.createElement('div'); steps.className = 'bcp-steps';
    steps.setAttribute('aria-hidden', 'true');
    var stepEls = [];
    STEP_LABELS.forEach(function (lbl, i) {
      if (i) { var bar = document.createElement('div'); bar.className = 'bcp-step-bar'; steps.appendChild(bar); }
      var s = document.createElement('div'); s.className = 'bcp-step';
      s.innerHTML = '<span class="bcp-step-n">' + (i + 1) + '</span><span class="bcp-step-l"></span>';
      s.querySelector('.bcp-step-l').textContent = lbl;
      steps.appendChild(s); stepEls.push(s);
    });
    modal.appendChild(steps);

    // body + footer (aria-live for status updates)
    var body = document.createElement('div'); body.className = 'bcp-body';
    body.setAttribute('role', 'status'); body.setAttribute('aria-live', 'polite');
    body.textContent = 'Loading source proposal…';
    modal.appendChild(body);
    var ft = document.createElement('div'); ft.className = 'bcp-ft';
    modal.appendChild(ft);

    document.body.appendChild(ov);
    try { requestAnimationFrame(function () { ov.classList.add('bcp-in'); }); } catch (e) { ov.classList.add('bcp-in'); }
    bwnFocusTrap(modal);
    document.addEventListener('keydown', onKeyClose);
    activeModal = ov;

    var M = {
      ov: ov, modal: modal, badge: badge, stepEls: stepEls, body: body, ft: ft,
      sourcePid: sourceProposalId, source: null, sourceWo: null,
      target: null, dup: { state: 'idle', matches: [] }
    };
    setBadge(M, 'busy', 'Validating'); setStep(M, 0, 0);

    var sourceWoNumber = woNumberFromUrl();
    Promise.all([
      pcGql('ClientProposalDetails', Q_PROPOSAL_DETAILS, { proposalId: sourceProposalId }),
      sourceWoNumber ? pcGql('ProposalWO', Q_PROPOSAL_WO, { workOrderNumber: sourceWoNumber }) : Promise.resolve(null)
    ]).then(function (res) {
      if (activeModal !== ov) return;   // closed/replaced while loading
      var sourceData = res[0] && res[0].proposal;
      if (!sourceData) { renderFatal(M, 'Could not load the source proposal', 'The proposal data came back empty. Close and try again from the proposal row.'); return; }
      if (!Array.isArray(sourceData.proposalLineItems) || sourceData.proposalLineItems.length === 0) {
        M.source = sourceData; renderFatal(M, 'This proposal has no line items', 'There is nothing to copy. Add line items to the source proposal first.'); return;
      }
      M.source = sourceData;
      M.sourceWo = res[1] && res[1].job;
      renderLoaded(M);
    }).catch(function (err) {
      if (activeModal !== ov) return;
      renderFatal(M, 'Could not load the source proposal', (err && err.message) || String(err));
    });
  }

  // A terminal load error: source could not be read / has nothing to copy. Header + a single card;
  // footer collapses to Close.
  function renderFatal(M, title, detail) {
    setBadge(M, 'err', 'Error'); setStep(M, 0, 0);
    M.body.innerHTML = '';
    var card = document.createElement('div'); card.className = 'bcp-card';
    card.innerHTML =
      '<div class="bcp-card-hd">' + bcpIcon('warning') + '<div class="bcp-card-t">' + escapeHtml(title) + '</div></div>' +
      '<div class="bcp-card-bd"><div class="bcp-note err">' + bcpIcon('info') + '<span></span></div></div>';
    card.querySelector('.bcp-note span').textContent = detail;
    M.body.appendChild(card);
    M.ft.innerHTML = '';
    var close = document.createElement('button'); close.className = 'bcp-btn ghost'; close.type = 'button'; close.textContent = 'Close';
    close.addEventListener('click', function () { closeModal(); });
    var sp = document.createElement('div'); sp.className = 'bcp-ft-spacer';
    M.ft.appendChild(sp); M.ft.appendChild(close);
  }

  function renderLoaded(M) {
    var ov = M.ov, source = M.source, sourceWo = M.sourceWo, pid = M.sourcePid;
    var items = source.proposalLineItems || [];
    var subEl = M.modal.querySelector('.bcp-sub');
    if (subEl) subEl.textContent = 'Create a draft copy of Proposal #' + (source.number != null ? source.number : pid) + ' on another work order.';
    setBadge(M, '', 'Ready'); setStep(M, 1, 1);

    // ---- pure per-line helpers --------------------------------------------
    // Extended = unit charge x charge-quantity, DISPLAY ONLY. The authoritative proposal value is
    // source.subtotal (markup/tax/freight live at the proposal level), which we never recompute -
    // extended is shown per row for scanability and blanks to "-" when the quantity is not numeric.
    function qtyOf(li) { var v = (li.chargeQuantity != null ? li.chargeQuantity : li.quantity); var n = Number(v); return isFinite(n) ? n : null; }
    function extMoney(li) {
      var q = qtyOf(li); if (q == null || !li.unitCharge || li.unitCharge.amount == null) return null;
      return { amount: Number(li.unitCharge.amount) * q, currency: li.unitCharge.currency, precision: li.unitCharge.precision };
    }
    var anyZeroQty = items.some(function (li) { return qtyOf(li) === 0; });
    var qtySum = 0, qtyKnown = true;
    items.forEach(function (li) { var q = qtyOf(li); if (q == null) qtyKnown = false; else qtySum += q; });

    M.body.removeAttribute('aria-live');   // per-region live areas take over from the whole-body one
    M.body.innerHTML = '';

    // ---- 1. Source proposal card ------------------------------------------
    var srcClient = sourceWo ? [sourceWo.clientName, (sourceWo.locationName || (sourceWo.locationNumber != null ? 'Loc ' + sourceWo.locationNumber : ''))].filter(Boolean).join(' · ') : '';
    var srcCard = document.createElement('div'); srcCard.className = 'bcp-card';
    srcCard.innerHTML =
      '<div class="bcp-card-hd">' + bcpIcon('file') + '<div class="bcp-card-t">Source proposal</div>' +
      '<span class="bcp-chip">#' + escapeHtml(source.number != null ? source.number : pid) + '</span></div>' +
      '<div class="bcp-card-bd">' +
      '<div class="bcp-tiles">' +
      '<div class="bcp-tile total"><div class="k">Proposal total</div><div class="v">' + escapeHtml(fmtMoney(source.subtotal)) + '</div></div>' +
      '<div class="bcp-tile"><div class="k">Line items</div><div class="v">' + items.length + '</div></div>' +
      '<div class="bcp-tile"><div class="k">Total qty</div><div class="v">' + (qtyKnown ? escapeHtml(String(qtySum)) : '-') + '</div></div>' +
      '</div>' +
      '<div class="bcp-meta">' +
      (source.type && source.type.name ? '<div><strong>Type:</strong> ' + escapeHtml(source.type.name) + '</div>' : '') +
      '<div><strong>Description:</strong> ' + (source.description ? escapeHtml(source.description) : '<span class="bcp-empty">No description provided.</span>') + '</div>' +
      (sourceWo ? '<div><strong>Source WO:</strong> W-' + escapeHtml(sourceWo.number) + (srcClient ? ' · ' + escapeHtml(srcClient) : '') + '</div>' : '') +
      (source.status && source.status.name ? '<div><strong>Status:</strong> ' + escapeHtml(source.status.name) + '</div>' : '') +
      '</div>' +
      '<div class="bcp-note info">' + bcpIcon('info') + '<span>This action creates a new draft proposal on the target work order. It does not modify the source proposal. All included line items will be copied to the new draft.</span></div>' +
      '</div>';
    M.body.appendChild(srcCard);

    // ---- 2. Included line items card --------------------------------------
    var liCard = document.createElement('div'); liCard.className = 'bcp-card';
    var liHd = document.createElement('div'); liHd.className = 'bcp-card-hd';
    liHd.innerHTML = bcpIcon('list') + '<div class="bcp-card-t">Included line items</div>' +
      '<div class="bcp-card-meta"><span>' + items.length + ' item' + (items.length === 1 ? '' : 's') + '</span><span>' + escapeHtml(fmtMoney(source.subtotal)) + '</span></div>';
    var toggle = document.createElement('button'); toggle.className = 'bcp-linkbtn'; toggle.type = 'button';
    liHd.querySelector('.bcp-card-meta').appendChild(toggle);
    var liBd = document.createElement('div'); liBd.className = 'bcp-card-bd';
    liCard.appendChild(liHd); liCard.appendChild(liBd);
    M.body.appendChild(liCard);
    var expanded = items.length <= 8;
    function renderItems() {
      liBd.innerHTML = '';
      var showAll = expanded;
      var shown = showAll ? items : items.slice(0, 5);
      var scroll = document.createElement('div'); scroll.className = 'bcp-scroll';
      var t = document.createElement('table'); t.className = 'bcp-tbl';
      t.innerHTML = '<thead><tr><th>Description</th><th class="num">Qty</th><th class="num">Unit charge</th><th class="num">Extended</th></tr></thead>';
      var tb = document.createElement('tbody');
      shown.forEach(function (li) {
        var q = qtyOf(li), ext = extMoney(li), tr = document.createElement('tr');
        tr.innerHTML =
          '<td>' + escapeHtml(li.description || li.item || '-') + '</td>' +
          '<td class="' + (q === 0 ? 'num zero' : 'num') + '">' + escapeHtml(q == null ? '-' : String(q)) + '</td>' +
          '<td class="num">' + escapeHtml(fmtMoney(li.unitCharge)) + '</td>' +
          '<td class="num">' + (ext ? escapeHtml(fmtMoney(ext)) : '-') + '</td>';
        tb.appendChild(tr);
      });
      t.appendChild(tb); scroll.appendChild(t); liBd.appendChild(scroll);
      if (!showAll) {
        var more = document.createElement('button'); more.className = 'bcp-linkbtn'; more.type = 'button'; more.style.marginTop = '9px';
        more.textContent = 'View all ' + items.length + ' line items';
        more.addEventListener('click', function () { expanded = true; syncToggle(); renderItems(); });
        liBd.appendChild(more);
      }
      var sum = document.createElement('div'); sum.className = 'bcp-sumrow';
      sum.innerHTML = '<span>' + items.length + ' line' + (items.length === 1 ? '' : 's') + ' copied</span><span>' + escapeHtml(fmtMoney(source.subtotal)) + '</span>';
      liBd.appendChild(sum);
      if (anyZeroQty) {
        var cav = document.createElement('div'); cav.className = 'bcp-note info'; cav.style.marginTop = '8px';
        cav.innerHTML = bcpIcon('info') + '<span>Some lines have a zero quantity. These are valid in the source and are preserved and copied exactly.</span>';
        liBd.appendChild(cav);
      }
    }
    function syncToggle() { toggle.textContent = expanded ? 'Collapse' : ('View all ' + items.length); }
    if (items.length > 8) { syncToggle(); toggle.addEventListener('click', function () { expanded = !expanded; syncToggle(); renderItems(); }); }
    else { toggle.style.display = 'none'; }
    renderItems();

    // ---- 3. Destination card ----------------------------------------------
    var destCard = document.createElement('div'); destCard.className = 'bcp-card accent';
    destCard.innerHTML = '<div class="bcp-card-hd">' + bcpIcon('pin') + '<div class="bcp-card-t">Copy to work order</div></div>';
    var destBd = document.createElement('div'); destBd.className = 'bcp-card-bd';
    destCard.appendChild(destBd); M.body.appendChild(destCard);

    // ---- 4. Pre-copy checks card (hidden until a target is validated) ------
    var checksCard = document.createElement('div'); checksCard.className = 'bcp-card'; checksCard.style.display = 'none';
    checksCard.innerHTML = '<div class="bcp-card-hd">' + bcpIcon('shield') + '<div class="bcp-card-t">Pre-copy checks</div></div>';
    var checksBd = document.createElement('div'); checksBd.className = 'bcp-card-bd';
    checksBd.setAttribute('role', 'status'); checksBd.setAttribute('aria-live', 'polite');
    checksCard.appendChild(checksBd); M.body.appendChild(checksCard);

    // ---- 5. Pre-copy confirmation (hidden until creation is possible) ------
    var confirmWrap = document.createElement('div'); confirmWrap.style.display = 'none';
    M.body.appendChild(confirmWrap);

    // ---- footer ------------------------------------------------------------
    M.ft.innerHTML = '';
    var cancelBtn = document.createElement('button'); cancelBtn.className = 'bcp-btn ghost'; cancelBtn.type = 'button'; cancelBtn.textContent = 'Cancel';
    cancelBtn.addEventListener('click', function () { closeModal(); });
    var resetBtn = document.createElement('button'); resetBtn.className = 'bcp-btn neutral'; resetBtn.type = 'button'; resetBtn.textContent = 'Reset target'; resetBtn.style.display = 'none';
    resetBtn.addEventListener('click', function () { clearTarget(); });
    var spacer = document.createElement('div'); spacer.className = 'bcp-ft-spacer';
    var primary = document.createElement('button'); primary.className = 'bcp-btn primary'; primary.type = 'button';
    M.ft.appendChild(cancelBtn); M.ft.appendChild(resetBtn); M.ft.appendChild(spacer); M.ft.appendChild(primary);

    // ---- destination state + logic ----------------------------------------
    var openWos = [];       // same-location open WOs for the selector (once loaded)
    var freeTimer = null;

    function clearTarget() {
      M.target = null; M.manualStr = ''; M.targetErr = ''; M.validating = false;
      M.dup = { state: 'idle', matches: [] };
      setBadge(M, '', 'Ready'); setStep(M, 1, 1);
      renderDest(); renderChecks(); renderConfirm(); updateCTA();
    }

    function renderDest() {
      destBd.innerHTML = '';
      if (M.target) {
        var loc = [M.target.clientName, (M.target.locationName || (M.target.locationNumber != null ? 'Loc ' + M.target.locationNumber : ''))].filter(Boolean).join(' · ');
        var panel = document.createElement('div'); panel.className = 'bcp-target';
        panel.innerHTML = bcpIcon('target') + '<div class="bcp-target-main"><div class="bcp-target-wo">Target: W-' + escapeHtml(M.target.number) + '</div>' + (loc ? '<div class="bcp-target-loc">' + escapeHtml(loc) + '</div>' : '') + '</div>';
        var change = document.createElement('button'); change.className = 'bcp-linkbtn'; change.type = 'button'; change.textContent = 'Change';
        change.addEventListener('click', function () { clearTarget(); });
        panel.appendChild(change);
        destBd.appendChild(panel);
        if (sourceWo && sourceWo.locationId != null && M.target.locationId != null && M.target.locationId !== sourceWo.locationId) {
          var w = document.createElement('div'); w.className = 'bcp-note warn'; w.style.marginTop = '9px';
          w.innerHTML = bcpIcon('warning') + '<span>This work order is at a different location than the source. Double-check this is intended (it is not blocked).</span>';
          destBd.appendChild(w);
        }
        return;
      }
      var selLbl = document.createElement('label'); selLbl.className = 'bcp-lbl'; selLbl.textContent = 'Search open work orders'; destBd.appendChild(selLbl);
      var searchWrap = document.createElement('div'); searchWrap.className = 'bcp-search'; searchWrap.innerHTML = bcpIcon('search');
      var sel = document.createElement('select'); sel.className = 'bcp-inp'; sel.setAttribute('aria-label', 'Open work orders at this location');
      searchWrap.appendChild(sel); destBd.appendChild(searchWrap);
      var blank = document.createElement('option'); blank.value = '';
      if (M.woLoadErr) blank.textContent = 'Could not load work orders – use the field below';
      else if (!sourceWo || sourceWo.locationId == null) blank.textContent = 'Source location unknown – use the field below';
      else blank.textContent = openWos.length ? 'Search by WO number, site, or location' : 'No other open WOs at this location';
      sel.appendChild(blank);
      openWos.forEach(function (w) {
        var o = document.createElement('option'); o.value = String(w.number);
        o.textContent = 'W-' + w.number + (w.scopeOfWork ? ' – ' + String(w.scopeOfWork).slice(0, 46) : '');
        sel.appendChild(o);
      });
      sel.addEventListener('change', function () { if (sel.value) { manual.value = sel.value; M.manualStr = sel.value; verifyTarget(sel.value); } });

      var or = document.createElement('div'); or.className = 'bcp-or'; or.textContent = 'OR ENTER A WORK ORDER NUMBER'; destBd.appendChild(or);
      var manLbl = document.createElement('label'); manLbl.className = 'bcp-lbl'; manLbl.setAttribute('for', 'bcp-wo'); manLbl.textContent = 'Work order number'; destBd.appendChild(manLbl);
      var manual = document.createElement('input'); manual.className = 'bcp-inp'; manual.id = 'bcp-wo'; manual.type = 'text'; manual.placeholder = 'e.g., 396180'; manual.autocomplete = 'off';
      manual.value = M.manualStr || ''; destBd.appendChild(manual);
      var status = document.createElement('div'); status.style.marginTop = '8px'; destBd.appendChild(status);
      if (M.validating) { status.className = 'bcp-check busy'; status.innerHTML = bcpIcon('search') + '<span>Checking target work order…</span>'; }
      else if (M.targetErr) { status.className = 'bcp-note err'; status.innerHTML = bcpIcon('warning') + '<span></span>'; status.querySelector('span').textContent = M.targetErr; }
      else { status.className = 'bcp-check'; status.innerHTML = '<span class="bcp-empty">Select or enter a target work order.</span>'; }
      manual.addEventListener('input', function () {
        M.manualStr = manual.value.trim(); M.targetErr = '';
        if (freeTimer) clearTimeout(freeTimer);
        if (M.manualStr) freeTimer = setTimeout(function () { verifyTarget(M.manualStr); }, 500);
        updateCTA();
      });
      manual.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (freeTimer) clearTimeout(freeTimer); if (M.manualStr) verifyTarget(M.manualStr); } });
      manual.addEventListener('blur', function () { if (M.manualStr && !M.validating && !M.target) { if (freeTimer) clearTimeout(freeTimer); verifyTarget(M.manualStr); } });
    }

    // Live target verify (Q_PROPOSAL_WO). Same-as-source is blocked here; confirmReady still requires
    // target.id, which only a real read supplies.
    function verifyTarget(numStr) {
      var n = parseInt(numStr, 10);
      if (!isFinite(n)) { M.target = null; M.validating = false; M.targetErr = 'Enter a valid work order number.'; setBadge(M, 'err', 'Error'); renderDest(); renderChecks(); renderConfirm(); updateCTA(); return; }
      if (sourceWo && sourceWo.number != null && n === sourceWo.number) {
        M.target = null; M.validating = false; M.targetErr = 'The target must be different from the source work order (W-' + sourceWo.number + ').';
        setBadge(M, 'err', 'Error'); renderDest(); renderChecks(); renderConfirm(); updateCTA(); return;
      }
      M.validating = true; M.targetErr = ''; M.manualStr = String(n);
      setBadge(M, 'busy', 'Validating'); renderDest(); renderChecks(); renderConfirm(); updateCTA();
      pcGql('ProposalWO', Q_PROPOSAL_WO, { workOrderNumber: n }).then(function (d) {
        if (activeModal !== ov) return;
        M.validating = false;
        var job = d && d.job;
        if (!job || job.number == null || job.id == null) { M.target = null; M.targetErr = 'Work order W-' + n + ' was not found.'; setBadge(M, 'err', 'Error'); renderDest(); updateCTA(); return; }
        M.target = job; M.targetErr = '';
        renderDest(); runDupCheck();
      }).catch(function (err) {
        if (activeModal !== ov) return;
        M.validating = false; M.target = null;
        M.targetErr = 'Could not check W-' + n + ' (' + ((err && err.message) || err) + '). Try again.';
        setBadge(M, 'err', 'Error'); renderDest(); updateCTA();
      });
    }

    // The real, verified pre-copy duplicate check: list the target WO's existing client proposals
    // and surface a non-blocking REVIEW when one matches the source. Never auto-blocks.
    function runDupCheck() {
      if (!M.target) return;
      M.dup = { state: 'checking', matches: [] };
      setBadge(M, 'busy', 'Validating'); setStep(M, 1, 1);
      renderChecks(); renderConfirm(); updateCTA();
      pcGql('ListClientProposals', Q_LIST_CLIENT_PROPOSALS, { jobId: M.target.id, page: { skip: 0, take: 100 } }).then(function (d) {
        if (activeModal !== ov) return;
        var list = (d && d.listClientProposals && d.listClientProposals.items) || [];
        var matches = dupFindMatches(source, list);
        M.dup = { state: matches.length ? 'review' : 'safe', matches: matches };
        setBadge(M, matches.length ? 'review' : 'good', matches.length ? 'Review suggested' : 'Ready to copy');
        setStep(M, 2, 2);
        renderChecks(); renderConfirm(); updateCTA();
      }).catch(function (err) {
        if (activeModal !== ov) return;
        M.dup = { state: 'unknown', matches: [], err: (err && err.message) || String(err) };
        setBadge(M, 'review', 'Check unavailable'); setStep(M, 1, 1);
        renderChecks(); renderConfirm(); updateCTA();
      });
    }

    function renderChecks() {
      if (!M.target) { checksCard.style.display = 'none'; checksBd.innerHTML = ''; return; }
      checksCard.style.display = ''; checksBd.innerHTML = '';
      var d = M.dup;
      if (d.state === 'checking') {
        checksBd.innerHTML = '<div class="bcp-check busy">' + bcpIcon('search') + '<span>Checking for an existing proposal on W-' + escapeHtml(M.target.number) + '…</span></div>';
      } else if (d.state === 'safe') {
        checksBd.innerHTML = '<div class="bcp-check ok">' + bcpIcon('check') + '<span>No conflicting proposal found on the selected target work order.</span></div>';
      } else if (d.state === 'unknown') {
        var u = document.createElement('div'); u.className = 'bcp-check err'; u.innerHTML = bcpIcon('warning') + '<span>Duplicate check could not be completed. Creation is disabled until it succeeds.</span>';
        checksBd.appendChild(u);
        var retry = document.createElement('button'); retry.className = 'bcp-btn ghost'; retry.type = 'button'; retry.style.marginTop = '10px'; retry.innerHTML = bcpIcon('shield') + '<span>Retry duplicate check</span>';
        retry.addEventListener('click', function () { runDupCheck(); });
        checksBd.appendChild(retry);
        if (d.err) { var td = document.createElement('details'); td.className = 'bcp-tech'; td.innerHTML = '<summary>Technical details</summary><pre></pre>'; td.querySelector('pre').textContent = d.err; checksBd.appendChild(td); }
      } else if (d.state === 'review') {
        var r = document.createElement('div'); r.className = 'bcp-check review'; r.innerHTML = bcpIcon('warning') + '<span>A similar proposal may already exist on this work order. Review before creating another draft.</span>';
        checksBd.appendChild(r);
        var evi = document.createElement('div'); evi.className = 'bcp-evi';
        d.matches.slice(0, 6).forEach(function (p) {
          var row = document.createElement('div'); row.className = 'bcp-evi-row';
          var left = '#' + (p.number != null ? p.number : '?') + (p.description ? ' · ' + String(p.description).slice(0, 46) : '') + (p.status && p.status.name ? ' · ' + p.status.name : '');
          row.innerHTML = '<span class="n"></span><span>' + escapeHtml(fmtMoney(p.subtotal)) + '</span>';
          row.querySelector('.n').textContent = left;
          evi.appendChild(row);
        });
        checksBd.appendChild(evi);
      }
    }

    function canCreate() {
      if (M.busyCreate) return false;
      if (!confirmReady({ hasToken: !!authToken(), source: source, target: M.target })) return false;
      if (sourceWo && sourceWo.number != null && M.target && M.target.number === sourceWo.number) return false;
      return M.dup.state === 'safe' || M.dup.state === 'review';
    }

    function renderConfirm() {
      if (!canCreate()) { confirmWrap.style.display = 'none'; confirmWrap.innerHTML = ''; return; }
      confirmWrap.style.display = ''; confirmWrap.innerHTML = '';
      var c = document.createElement('div'); c.className = 'bcp-confirm';
      var n = items.length;
      c.innerHTML =
        '<div><strong>You are about to create a draft.</strong> A draft proposal with ' + n + ' line item' + (n === 1 ? '' : 's') + ' totaling ' + escapeHtml(fmtMoney(source.subtotal)) + ' will be created on WO W-' + escapeHtml(M.target.number) + '.</div>' +
        '<div class="sub">Source: Proposal #' + escapeHtml(source.number != null ? source.number : pid) + '  →  Target: W-' + escapeHtml(M.target.number) + '. The source proposal will not be changed. The new proposal must be reviewed and submitted through the normal proposal workflow.</div>';
      confirmWrap.appendChild(c);
    }

    // Footer primary CTA reflects the real blocking reason at every moment.
    function updateCTA() {
      var label, icon, disabled = true, action = null;
      if (M.busyCreate) { label = 'Creating draft…'; icon = 'lock'; }
      else if (!M.target && M.manualStr) { label = 'Check work order'; icon = 'search'; disabled = M.validating; action = function () { if (freeTimer) clearTimeout(freeTimer); verifyTarget(M.manualStr); }; }
      else if (!M.target) { label = 'Select a target'; icon = 'target'; }
      else if (M.dup.state === 'checking') { label = 'Checking…'; icon = 'shield'; }
      else if (canCreate()) { label = 'Create draft proposal'; icon = 'copy'; disabled = false; action = runCreate; }
      else { label = 'Create draft proposal'; icon = 'lock'; }   // dup unknown / same-WO / not ready
      primary.disabled = disabled;
      primary.innerHTML = bcpIcon(icon) + '<span></span>';
      primary.querySelector('span').textContent = label;
      primary.onclick = (disabled || !action) ? null : action;
      resetBtn.style.display = (M.target || M.manualStr) ? '' : 'none';
    }

    function runCreate() {
      if (M.busyCreate || !canCreate()) return;
      M.busyCreate = true; modalBusy = true;
      setBadge(M, 'busy', 'Creating draft'); setStep(M, 2, 2);
      cancelBtn.disabled = true; resetBtn.disabled = true; updateCTA();
      var tnum = M.target.number;
      copyProposal(pid, tnum, {}).then(function (r) {
        M.busyCreate = false; modalBusy = false; cancelBtn.disabled = false; resetBtn.disabled = false;
        if (activeModal !== ov) return;
        if (r && r.ok) renderSuccess(r, tnum);
        else renderCreateError((r && r.stage) || 'unknown', (r && r.error) || 'Unknown error', tnum);
      }).catch(function (err) {
        M.busyCreate = false; modalBusy = false; cancelBtn.disabled = false; resetBtn.disabled = false;
        if (activeModal !== ov) return;
        renderCreateError('exception', (err && err.message) || String(err), tnum);
      });
    }

    // Terminal success panel. Distinguishes a clean copy from a created-but-read-back-mismatch (the
    // engine's honesty guard) - the latter is amber, not green.
    function renderSuccess(r, tnum) {
      var rb = r.readBack || {}, mismatch = rb.match === false;
      var diffs = [];
      if (mismatch) {
        if (rb.newItems !== rb.sourceItems) diffs.push('line items ' + rb.sourceItems + ' → ' + rb.newItems);
        if (rb.sourceSubtotal != null && rb.newSubtotal !== rb.sourceSubtotal) diffs.push('subtotal changed');
        if (rb.sourcePO !== rb.newPO) diffs.push('client PO ' + (rb.sourcePO || 'none') + ' → ' + (rb.newPO || 'none'));
        console.warn('[BWN PROPOSAL COPY] read-back did NOT match the source on the new Draft', rb);
        reportFail({ level: 'warn', tag: 'proposalCopy.readback.mismatch', feature: 'proposalCopy', ids: { proposal: pid, wo: Number(tnum) }, code: 'readback-mismatch' });
      }
      pcToast(mismatch ? ('Copied to W-' + tnum + ', but the read-back did not match – verify it.') : ('Copied to W-' + tnum + ' as a new Draft proposal.'));
      setBadge(M, mismatch ? 'review' : 'good', mismatch ? 'Created – verify' : 'Created'); setStep(M, -1, 3);
      var loc = M.target ? [M.target.clientName, M.target.locationName].filter(Boolean).join(' · ') : '';
      M.body.innerHTML = '';
      var card = document.createElement('div'); card.className = 'bcp-card';
      card.innerHTML = '<div class="bcp-card-hd">' + bcpIcon(mismatch ? 'warning' : 'check') + '<div class="bcp-card-t">' + (mismatch ? 'Draft created – please verify' : 'Draft proposal created') + '</div></div>';
      var bd = document.createElement('div'); bd.className = 'bcp-card-bd';
      var meta = document.createElement('div'); meta.className = 'bcp-meta';
      meta.innerHTML =
        (r.newProposalId != null ? '<div><strong>New draft id:</strong> #' + escapeHtml(r.newProposalId) + '</div>' : '') +
        '<div><strong>Target WO:</strong> W-' + escapeHtml(tnum) + (loc ? ' · ' + escapeHtml(loc) : '') + '</div>' +
        '<div><strong>Lines copied:</strong> ' + escapeHtml(rb.newItems != null ? rb.newItems : items.length) + '</div>' +
        '<div><strong>Total copied:</strong> ' + escapeHtml(fmtMoney(source.subtotal)) + '</div>' +
        (rb.newPO ? '<div><strong>Client PO:</strong> ' + escapeHtml(rb.newPO) + '</div>' : '');
      bd.appendChild(meta);
      var note = document.createElement('div');
      if (mismatch) { note.className = 'bcp-note warn'; note.innerHTML = bcpIcon('warning') + '<span></span>'; note.querySelector('span').textContent = 'The draft was created, but the read-back did not match the source (' + (diffs.join('; ') || 'read-back differs') + '). Open the target work order and check its line items, total and client PO.'; }
      else { note.className = 'bcp-note ok'; note.innerHTML = bcpIcon('check') + '<span>The draft is on the target work order’s Proposals tab. Review and submit it through the normal proposal workflow.</span>'; }
      bd.appendChild(note);
      card.appendChild(bd); M.body.appendChild(card);
      // footer: primary = open the target WO (verified route); secondaries = copy details / another / close
      M.ft.innerHTML = '';
      var copyBtn = document.createElement('button'); copyBtn.className = 'bcp-btn ghost'; copyBtn.type = 'button'; copyBtn.innerHTML = bcpIcon('copy') + '<span>Copy details</span>';
      copyBtn.addEventListener('click', function () {
        var lines = ['Copied Proposal #' + (source.number != null ? source.number : pid) + ' to W-' + tnum, (r.newProposalId != null ? 'New draft id: ' + r.newProposalId : ''), 'Lines: ' + (rb.newItems != null ? rb.newItems : items.length), 'Total: ' + fmtMoney(source.subtotal)].filter(Boolean).join('\n');
        try { (navigator.clipboard && navigator.clipboard.writeText ? navigator.clipboard.writeText(lines) : Promise.reject()).then(function () { pcToast('Details copied to clipboard.'); }, function () { pcToast('Could not copy – details are shown above.'); }); } catch (e) { pcToast('Could not copy – details are shown above.'); }
      });
      var another = document.createElement('button'); another.className = 'bcp-btn ghost'; another.type = 'button'; another.textContent = 'Copy another';
      another.addEventListener('click', function () { closeModal(true); setTimeout(function () { openModal(pid); }, 30); });
      var closeB = document.createElement('button'); closeB.className = 'bcp-btn ghost'; closeB.type = 'button'; closeB.textContent = 'Close';
      closeB.addEventListener('click', function () { closeModal(); });
      var sp = document.createElement('div'); sp.className = 'bcp-ft-spacer';
      M.ft.appendChild(copyBtn); M.ft.appendChild(another); M.ft.appendChild(closeB); M.ft.appendChild(sp);
      var open = document.createElement('a'); open.className = 'bcp-btn primary'; open.href = '/work-orders/' + Number(tnum); open.target = '_blank'; open.rel = 'noopener';
      open.innerHTML = bcpIcon('external') + '<span>Open target work order</span>';
      M.ft.appendChild(open);
    }

    function renderCreateError(stage, msg, tnum) {
      setBadge(M, 'err', 'Error');
      reportFail({ level: 'error', tag: 'proposalCopy.copy.fail', feature: 'proposalCopy', ids: { proposal: pid, wo: Number(tnum) }, code: stage });   // free-text msg stays in the drawer, never logged
      confirmWrap.style.display = ''; confirmWrap.innerHTML = '';
      var card = document.createElement('div'); card.className = 'bcp-card';
      card.innerHTML = '<div class="bcp-card-hd">' + bcpIcon('warning') + '<div class="bcp-card-t">Copy failed</div></div>';
      var bd = document.createElement('div'); bd.className = 'bcp-card-bd';
      var note = document.createElement('div'); note.className = 'bcp-note err'; note.innerHTML = bcpIcon('warning') + '<span></span>';
      note.querySelector('span').textContent = 'The draft was not created (failed at: ' + stage + '). Your target selection is preserved – you can retry.';
      bd.appendChild(note);
      var td = document.createElement('details'); td.className = 'bcp-tech'; td.innerHTML = '<summary>Technical details</summary><pre></pre>'; td.querySelector('pre').textContent = String(msg);
      bd.appendChild(td); card.appendChild(bd); confirmWrap.appendChild(card);
      updateCTA();
      primary.innerHTML = bcpIcon('copy') + '<span>Retry create</span>'; primary.disabled = false; primary.onclick = runCreate;
    }

    // initial paint + load the same-location open WOs for the selector
    renderDest(); renderChecks(); renderConfirm(); updateCTA();
    if (sourceWo && sourceWo.locationId != null) {
      pcGql('PagedWorkOrders', Q_LOCATION_OPEN_WOS, { page: { skip: 0, take: 100 }, sortBy: [{ columnName: 'formattedJobNumber', direction: 'ASC' }], locationId: sourceWo.locationId, phase: 'Open' }).then(function (d) {
        if (activeModal !== ov) return;
        var list = (d && d.listWorkOrdersPaginated && d.listWorkOrdersPaginated.items) || [];
        openWos = pickerFilter(list, sourceWo.locationId, sourceWo.number);
        if (!M.target) renderDest();
      }).catch(function () { if (activeModal !== ov) return; M.woLoadErr = true; if (!M.target) renderDest(); });
    }
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
