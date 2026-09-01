// ==UserScript==
// @name         BWN Write Queue (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.5.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-write-queue.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-write-queue.user.js
// @description  Drains the Track C write-back queue: claims THIS coordinator's own queued Umbrava write commands from the SWA, confirms each irreversible write, executes it via patchWorkOrder/addEditJobNote, and reports the result. Self-drain; every write is human-confirmed; disabled until you turn it on. v0.5 RETIRES this script's Bulk Operations Console modal - Core (bwn-suite-core, flag bulkOps) is now the single Safe Bulk Operations Console; the drain executor stays here as Track C infrastructure.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      green-stone-0717dab0f.7.azurestaticapps.net
// ==/UserScript==

// The execute half of Track C write-back. The SWA queue (broadway-internal-ops /api/wo-write-queue,
// contract outputs/specs/2026-08-14-track-c-write-queue-contract.md) holds the commands; this script
// runs in the coordinator's app.umbrava.com tab - the only place that holds an Umbrava bearer - and
// turns a claimed command into a real patchWorkOrder / addEditJobNote write.
//
// SELF-DRAIN (v1): the server only ever hands this tab commands whose enqueuedBy matches this user's
// vouched email, so issuer == executor and every confirm is the same person who queued the intent.
//
// EXACTLY-ONCE is the two-layer claim from the contract. The queue gives at-least-once; this half is
// the verb layer:
//   - set verbs (wo.status / wo.assign / wo.ecd) READ the current value first and SKIP the write when
//     it already equals the target - so a re-run is a no-op AND the time-in-status clock is not
//     needlessly reset.
//   - the append verb (wo.note) embeds a [bwn:<idemKey>] marker and reads workOrderNotes for it BEFORE
//     posting; a re-run finds its own marker and reports done without a second note.
//
// DISABLED BY DEFAULT. Nothing is claimed or written until you run the "BWN Write Queue: enable
// draining" menu command - and even then every write waits behind a confirm strip. Safe to install
// before the route deploys: an undeployed /api/* returns 200 HTML, which fails the JSON-required check
// and is treated as "queue unavailable" (no-op).

(function () {
  "use strict";
  var VER = "0.5.0";   // keep in lockstep with @version (TM compares versions, not contents)

  var SWA_BASE = "https://green-stone-0717dab0f.7.azurestaticapps.net";
  var PROXY_URL = SWA_BASE + "/api/wo-write-queue";
  var CATALOG_URL = SWA_BASE + "/api/catalog-ingest";   // phase 2: push the status list + user directory for the Dashboard pickers
  var CLIENT = "pilot";
  var POLL_MS = 20000;         // 20s; well under the route's 60/min courtesy cap
  var CONFIRM_TIMEOUT_MS = 0;  // 0 = the strip waits for the human indefinitely (lease may lapse; see contract)

  // ---- Umbrava access token, read from the Auth0 SPA cache by CONTENT (issuer + not-expired).
  // Sent to the SWA in the JSON body as userToken (the SWA edge overwrites the Authorization header),
  // and used directly as the Bearer on same-origin /api/graphql writes. Ported from bwn-wo-assist /
  // bwn-dispatch.
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

  // ---- Same-origin Umbrava GraphQL with an explicit bearer (works from the GM sandbox). A GraphQL
  // error is tagged .graphql so the report leg can classify it non-retryable; a network reject stays
  // untagged (retryable). Ported from bwn-dispatch gql().
  function gql(query, variables) {
    var tok = authToken();
    return fetch("/api/graphql", {
      method: "POST",
      headers: { "Authorization": "Bearer " + tok, "Content-Type": "application/json" },
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.errors && j.errors.length) { var e = new Error(j.errors[0].message || "GraphQL error"); e.graphql = true; throw e; }
        return j && j.data;
      });
  }

  // ---- BWN-OPS: audited GraphQL wrapper for this sandbox --------------------
  // RM-D1/G1: the two LIVE writes (patchWorkOrder + addEditJobNote) route through bwnGqlOp - the
  // paste-identical BWN-OPS-WRAP below, SHA-gated byte-for-byte to Core by scripts/test-bwn-ops.js -
  // so each gets a correlation id + the shared bwn:audit entry + the centralized success:false
  // rejection, and patchWorkOrder additionally the fail-closed high-risk confirm gate. The queue's
  // own Approve strip IS this write's confirmation, so it passes opts.confirmed:true (same pattern as
  // dispatch/kanban). write-queue's 2-arg gql() matches the wrapper's bwnGql(query,variables), so
  // this aliases it; the READS (WO_READ_Q / NOTES_Q / the catalog queries) stay on raw gql. Passing
  // feature:'writeQueue' wires the queue into the shared bwn:modules kill switch, so setting
  // bwn:modules {"writeQueue":false} halts every queued write suite-wide, audited outcome:'denied'.
  var bwnGql = gql;
  var BWN_VER = VER;
  var BWN_MODULES = (function () { try { return JSON.parse(localStorage.getItem('bwn:modules') || '{}') || {}; } catch (e) { return {}; } })();
  var BWN_OPS = {
    patchWorkOrder: { kind: 'write', target: 'workOrder', risk: 'high', idempotent: false, retry: 'none',
      ok: 'Work order updated.', fail: 'The work order was not updated.' },
    addEditJobNote: { kind: 'write', target: 'note', risk: 'moderate', idempotent: false, retry: 'none',
      ok: 'Note posted.', fail: 'The note was not posted.' }
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
  // ===== BWN-OPS-WRAP END v2 =====

  // ==== BWN-WQ EXEC START (sliced by test-write-queue-drain.js; references injected `gql` (reads) + `bwnGqlOp` (writes)) ====
  var INTERNAL_NOTE_TYPE = 13;   // Internal (drop-upload's fallback map). v1 posts every note as Internal.

  var WO_READ_Q = "query($n:Int!){ workOrder(workOrderNumber:$n){ assignedTo statusId serviceLevelAgreementId priority{ label responseMinutes firstTripDate serviceLevelAgreementMinutes expirationMinutes expectedCompletionDate hasPriorityOverride category skipWeekends } } }";
  var NOTES_Q = "query BwnWorkOrderNotes($n: Int!) { workOrderNotes(workOrderNumber: $n) { id type content isDeleted } }";
  var PATCH_M = "mutation PatchWorkOrder($data: PatchWorkOrderInput!) { patchWorkOrder(data: $data) { success message } }";
  var ADD_NOTE_M = "mutation AddEditWONote($addEditInput: WorkOrderNoteInput!) { addEditJobNote(data: $addEditInput) { success message note { id type } } }";

  function cond(v) { return { shouldInclude: true, value: v }; }   // the Conditional*Input wrapper
  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function gqlError(msg) { var e = new Error(msg); e.business = true; return e; }   // a verb-level refusal, never retryable
  // Retryable iff it is a transport error. A write refused by the wrapper (success:false) rejects with
  // .bwnNonTransient set (the BWN-OPS-WRAP contract) - a deterministic refusal that must NOT be retried,
  // same class as .business / .graphql. Omitting it would let a governance refusal loop on the queue.
  function classifyError(err) { return !(err && (err.business || err.graphql || err.bwnNonTransient)); }

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function textToHtml(t) {
    return String(t).split(/\n\n+/).map(function (par) {
      return "<p>" + par.split("\n").map(esc).join("<br>") + "</p>";
    }).join("");
  }

  function markerFor(idemKey) { return "[bwn:" + String(idemKey) + "]"; }
  function noteHasMarker(notes, idemKey) {
    var m = markerFor(idemKey);
    return (notes || []).some(function (n) { return n && !n.isDeleted && String(n.content || "").indexOf(m) !== -1; });
  }

  // Whole-object priority replace for an ECD write: patchWorkOrder replaces the ENTIRE priority
  // object, so every sibling field must be copied or it is blanked (the captured hazard). Read field
  // hasPriorityOverride flips to input field hasOverridePriority. Ported from bwn-dispatch.
  function priorityWriteValue(readPriority, newEcd) {
    var p = readPriority || {};
    return {
      label: (p.label == null ? null : String(p.label)),
      responseMinutes: num(p.responseMinutes),
      firstTripDate: (p.firstTripDate == null ? null : String(p.firstTripDate)),
      serviceLevelAgreementMinutes: num(p.serviceLevelAgreementMinutes),
      expirationMinutes: num(p.expirationMinutes),
      expectedCompletionDate: newEcd,
      hasOverridePriority: true,
      category: (p.category == null ? null : String(p.category)),
      skipWeekends: !!p.skipWeekends
    };
  }

  // Dry-run short-circuits for the Bulk Operations Console PREVIEW. Each returns the SAME
  // {outcome:'done'} shape the live path reports, tagged dryRun:true and (for a patch) the scalar
  // before/after for the preview row - but WITHOUT ever calling bwnGqlOp, so a preview provably
  // cannot mutate. Two distinct functions so scripts/test-bulk-console.js can remove either guard as
  // an isolated negative control (a shared line would not be a unique mutate() target).
  function dryPatch(verb, before, after) { return { outcome: "done", dryRun: true, result: { would: verb }, before: before, after: after }; }
  function dryNote() { return { outcome: "done", dryRun: true, result: { would: "wo.note" } }; }

  // Execute ONE claimed command. Returns { outcome:'done', result } or throws (the caller classifies
  // and reports failed). Confirmation is the caller's job - the queue's Approve strip runs BEFORE
  // this, so the write passes confirmed:true. Reads use raw gql; writes route through bwnGqlOp. Fully
  // unit-testable in a vm with an injected gql (reads) + bwnGqlOp (writes; a faithful stub in the harness).
  // opts.dryRun (bulk console): do every READ + skip-if-equal decision but return BEFORE the single
  // bwnGqlOp write. Default (no opts / opts.dryRun falsy) is the unchanged LIVE path - so every existing
  // one-arg caller (pollTick, the drain harness) is byte-for-byte unaffected.
  function executeCommand(cmd, opts) {
    opts = opts || {};
    var wo = parseInt(cmd.woNumber, 10);
    var args = cmd.args || {};

    if (cmd.verb === "wo.note") {
      // Append idempotency: a re-run must find its own marker and NOT post a second note.
      return gql(NOTES_Q, { n: wo }).then(function (nd) {
        var notes = (nd && nd.workOrderNotes) || [];
        if (noteHasMarker(notes, cmd.idemKey)) return { outcome: "done", result: { skipped: "already-posted" } };
        var text = String(args.noteText || "");
        var marked = text + "\n\n" + markerFor(cmd.idemKey);
        var input = {
          workOrderNumber: wo, type: INTERNAL_NOTE_TYPE, content: marked, contentHtml: textToHtml(marked),
          isCompletion: false, isInvoice: false, isPinned: false, actionNoteEmails: null, targetPurchaseOrderNumbers: []
        };
        // Dry-run (bulk console PREVIEW): the note is NOT posted - return before the bwnGqlOp write.
        // scripts/test-bulk-console.js asserts 0 note posts here and carries a control removing this.
        if (opts.dryRun) return dryNote();
        // addEditJobNote is a moderate write: routed through bwnGqlOp for the corrId + shared
        // bwn:audit entry + success:false rejection (no confirm gate). ids carry the scalar WO number
        // only; the note text stays in variables, never the audit trail.
        return bwnGqlOp('addEditJobNote', ADD_NOTE_M, { addEditInput: input }, { feature: 'writeQueue', ids: { wo: wo } }).then(function (d) {
          var res = d && d.addEditJobNote;
          if (!res || res.success !== true) throw gqlError((res && res.message) || "addEditJobNote reported no success");
          return { outcome: "done", result: { noteId: res.note && res.note.id } };
        });
      });
    }

    // patchWorkOrder verbs: read the current value first, skip the write when it already matches.
    return gql(WO_READ_Q, { n: wo }).then(function (rd) {
      var rec = rd && rd.workOrder;
      if (!rec) throw gqlError("workOrder " + wo + " not found");
      var data = { workOrderNumber: wo };
      var before = null, after = null;   // scalar before/after for the audit trail (PII-free)

      if (cmd.verb === "wo.status") {
        var target = parseInt(args.statusId, 10);
        if (Number(rec.statusId) === target) return { outcome: "done", result: { skipped: "already-status", statusId: target } };
        data.statusId = cond(target);
        before = { statusId: rec.statusId }; after = { statusId: target };
      } else if (cmd.verb === "wo.assign") {
        var who = String(args.assignedTo);
        if (String(rec.assignedTo) === who) return { outcome: "done", result: { skipped: "already-assigned" } };
        data.assignedTo = cond(who);
        before = { assignedTo: rec.assignedTo }; after = { assignedTo: who };
      } else if (cmd.verb === "wo.ecd") {
        var date = String(args.expectedCompletionDate);
        var cur = rec.priority && rec.priority.expectedCompletionDate;
        if (cur && String(cur).slice(0, 10) === date.slice(0, 10)) return { outcome: "done", result: { skipped: "already-ecd" } };
        data.priority = cond(priorityWriteValue(rec.priority, date));
        if (rec.serviceLevelAgreementId) data.serviceLevelAgreementId = cond(rec.serviceLevelAgreementId);
        before = { ecd: cur || null }; after = { ecd: date };
      } else {
        throw gqlError("unknown verb: " + cmd.verb);
      }

      // Dry-run (bulk console PREVIEW): the WO is NOT patched - return before the bwnGqlOp write with
      // the scalar before/after for the preview row. scripts/test-bulk-console.js asserts 0 writes here
      // and carries a control removing this line.
      if (opts.dryRun) return dryPatch(cmd.verb, before, after);
      // patchWorkOrder is a high-risk write: routed through bwnGqlOp for the corrId + shared bwn:audit
      // entry + the fail-closed confirm gate + success:false rejection. The Approve strip already
      // confirmed, so confirmed:true; before/after carry the scalar change for the audit trail.
      return bwnGqlOp('patchWorkOrder', PATCH_M, { data: data }, { confirmed: true, feature: 'writeQueue', ids: { wo: wo }, before: before, after: after }).then(function (d) {
        var p = d && d.patchWorkOrder;
        if (!p || !p.success) throw gqlError((p && p.message) || "patchWorkOrder reported no success");
        return { outcome: "done", result: { verb: cmd.verb } };
      });
    });
  }

  // Human-readable one-liner for the confirm strip. Names the exact write and flags the clock reset.
  function describeCommand(cmd) {
    var a = cmd.args || {};
    if (cmd.verb === "wo.status") return "Set status to #" + a.statusId + " on W-" + cmd.woNumber + " (this RESETS the time-in-status clock)";
    if (cmd.verb === "wo.assign") return "Reassign W-" + cmd.woNumber + " to user " + a.assignedTo;
    if (cmd.verb === "wo.ecd") return "Set expected completion date to " + String(a.expectedCompletionDate).slice(0, 10) + " on W-" + cmd.woNumber;
    if (cmd.verb === "wo.note") return "Post an internal note to W-" + cmd.woNumber + ": " + String(a.noteText || "").slice(0, 120);
    return cmd.verb + " on W-" + cmd.woNumber;
  }
  // ==== BWN-WQ EXEC END ====

  // ==== BWN-BULK-CONSOLE RETIRED (converge ruling 2026-09-01) ====
  // The write-queue operator modal + its pure orchestration engine (preview / dry-run / sequential
  // runner / PII-safe projection / CSV+JSON export) were RETIRED here: Core bwn-suite-core.user.js is
  // now THE single Safe Bulk Operations Console (flag bulkOps). Its engine folds in the PII-safe
  // authorized-column export that lived here. What STAYS in this file is the Track C DRAIN executor
  // (BWN-WQ EXEC above), which the coordinator-tab poll loop uses to turn one queued command at a time
  // into a real patchWorkOrder / addEditJobNote write; it has its own harness (test-write-queue-drain.js).
  // The bulkConsole flag + its menu commands are gone with the modal. Do NOT rebuild the modal here.
  // ==== BWN-BULK-CONSOLE RETIRED END ====
  // ---- SWA transport (GM_xmlhttpRequest, x-bwn-key). JSON-required success: an undeployed /api/*
  // route returns 200 HTML, so a non-JSON body means the queue is unavailable, not a valid answer.
  function gmPost(url, headers, bodyObj, timeoutMs) {
    return new Promise(function (resolve, reject) {
      try {
        GM_xmlhttpRequest({
          method: "POST", url: url, headers: headers, data: JSON.stringify(bodyObj), timeout: timeoutMs || 30000,
          onload: function (r) { var j = null; try { j = JSON.parse(r.responseText); } catch (e) { } resolve({ status: r.status, json: j }); },
          onerror: function () { reject(new Error("network error")); },
          ontimeout: function () { reject(new Error("timed out")); }
        });
      } catch (e) { reject(e); }
    });
  }
  function ingestKey() { return GM_getValue("ingest_key", ""); }
  function enabled() { return GM_getValue("wq_enabled", false) === true; }

  // ---- Catalog push (phase 2): feed the Dashboard's Status/Assign pickers ----
  // Reads the tenant STATUS list + USER directory and pushes them to /api/catalog-ingest (key-gated,
  // no vouch - the catalogs are not user-specific). Runs on load REGARDLESS of wq_enabled (the pickers
  // must work for Dashboard users who never enable draining), throttled to once per 6h per browser.
  var CAT_TTL_MS = 6 * 3600000;
  var CAT_STATUS_Q = "query{ workOrderStatuses{ id name isActive } }";
  var CAT_USERS_Q = "query{ users(includeInactiveUsers:false, includeSystemUsers:false){ id firstName lastName emailAddress isInactive isTechnician } }";
  // WQ-CAT-PURE-BEGIN - pure mappers, sliced by scripts/test-wq-catalog-push.js
  function wqMapStatus(s){ if(!s) return null; var id=parseInt(s.id,10); var name=String(s.name||"").trim(); if(!isFinite(id)||!name) return null; return { id:id, name:name, isActive:s.isActive!==false }; }
  function wqMapUser(u){ if(!u||u.isInactive) return null; var id=String(u.id||"").trim(); var name=((u.firstName||"")+" "+(u.lastName||"")).trim(); if(!id||!name) return null; return { id:id, name:name, email:String(u.emailAddress||"").trim(), isTechnician:!!u.isTechnician }; }
  // WQ-CAT-PURE-END
  function wqPushCatalogs(force){
    if(!ingestKey() || !authToken()) return;                       // need the shared key + a live Umbrava session
    var last = Number(GM_getValue("wq_catalog_ts", 0)) || 0;
    if(!force && (Date.now() - last < CAT_TTL_MS)) return;          // throttle
    Promise.all([ gql(CAT_STATUS_Q, {}).catch(function(){ return null; }), gql(CAT_USERS_Q, {}).catch(function(){ return null; }) ]).then(function(res){
      var sd = res[0], ud = res[1];
      var statuses = (sd && Array.isArray(sd.workOrderStatuses)) ? sd.workOrderStatuses.map(wqMapStatus).filter(Boolean) : null;
      var users = (ud && Array.isArray(ud.users)) ? ud.users.map(wqMapUser).filter(Boolean) : null;
      if((!statuses || !statuses.length) && (!users || !users.length)) return;   // read failed both ways - do not stamp the throttle
      var body = { client: CLIENT, actor: "write-queue-catalog" };
      if(statuses && statuses.length) body.statuses = statuses;
      if(users && users.length) body.users = users;
      gmPost(CATALOG_URL, { "Content-Type": "application/json", "x-bwn-key": ingestKey() }, body, 30000).then(function(r){
        if(r && r.json && r.json.ok) GM_setValue("wq_catalog_ts", Date.now());
      });
    });
  }

  function claimOnce(tok) {
    return gmPost(PROXY_URL, { "Content-Type": "application/json", "x-bwn-key": ingestKey() },
      { op: "claim", userToken: tok, client: CLIENT, capabilities: { dedupAppend: true } }, 20000)
      .then(function (r) { return (r.json && r.json.ok) ? (r.json.command || null) : null; });
  }
  function reportResult(tok, id, outcome, result, error, retryable) {
    return gmPost(PROXY_URL, { "Content-Type": "application/json", "x-bwn-key": ingestKey() },
      { op: "report", userToken: tok, client: CLIENT, id: id, outcome: outcome, result: result || null, error: error || "", retryable: !!retryable }, 20000)
      .then(function (r) { return r.json; });
  }

  // ---- Confirm strip (the human gate). One at a time; resolves 'approve' or 'skip'.
  var stripEl = null;
  function confirmStrip(cmd) {
    return new Promise(function (resolve) {
      if (stripEl && stripEl.parentNode) stripEl.parentNode.removeChild(stripEl);
      var wrap = document.createElement("div");
      wrap.setAttribute("data-bwn-wq-ui", "1");
      wrap.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483000;max-width:380px;background:#111827;color:#f9fafb;border:1px solid #374151;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.4);font:13px/1.45 system-ui,sans-serif;padding:12px 14px;";
      var title = document.createElement("div");
      title.style.cssText = "font-weight:600;margin-bottom:6px;color:#93c5fd;";
      title.textContent = "BWN Write Queue - confirm write";
      var body = document.createElement("div");
      body.style.cssText = "margin-bottom:10px;white-space:normal;word-break:break-word;";
      body.textContent = describeCommand(cmd);
      var row = document.createElement("div");
      row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";
      var skip = document.createElement("button");
      skip.textContent = "Skip";
      skip.style.cssText = "padding:6px 12px;border-radius:6px;border:1px solid #4b5563;background:transparent;color:#e5e7eb;cursor:pointer;";
      var ok = document.createElement("button");
      ok.textContent = "Approve";
      ok.style.cssText = "padding:6px 12px;border-radius:6px;border:0;background:#2563eb;color:#fff;cursor:pointer;font-weight:600;";
      function done(v) { if (wrap.parentNode) wrap.parentNode.removeChild(wrap); stripEl = null; resolve(v); }
      skip.addEventListener("click", function () { done("skip"); });
      ok.addEventListener("click", function () { done("approve"); });
      row.appendChild(skip); row.appendChild(ok);
      wrap.appendChild(title); wrap.appendChild(body); wrap.appendChild(row);
      document.body.appendChild(wrap);
      stripEl = wrap;
      if (CONFIRM_TIMEOUT_MS > 0) setTimeout(function () { if (stripEl === wrap) done("skip"); }, CONFIRM_TIMEOUT_MS);
    });
  }

  // ---- Poll tick: claim one, confirm, execute, report. One in flight at a time.
  var busy = false;
  function pollTick() {
    if (busy || !enabled() || document.hidden) return;
    var tok = authToken();
    if (!tok || !ingestKey()) return;
    busy = true;
    claimOnce(tok).then(function (cmd) {
      if (!cmd) { busy = false; return; }
      return confirmStrip(cmd).then(function (choice) {
        if (choice !== "approve") {
          // Operator declined: dead-letter cleanly rather than re-prompting on a loop.
          return reportResult(tok, cmd.id, "failed", null, "operator skipped", false).then(function () { busy = false; });
        }
        return executeCommand(cmd).then(function (r) {
          return reportResult(tok, cmd.id, r.outcome, r.result, "", false).then(function () { busy = false; });
        }).catch(function (err) {
          return reportResult(tok, cmd.id, "failed", null, (err && err.message) || String(err), classifyError(err)).then(function () { busy = false; });
        });
      });
    }).catch(function () { busy = false; });
  }

  // ---- Menu commands + boot ----
  GM_registerMenuCommand("BWN Write Queue: set SWA ingest key", function () {
    var v = prompt("SWA ingest key (same value as the connector WO_INGEST_KEY, shared across the BWN Ops Suite):", ingestKey() || "");
    if (v !== null) GM_setValue("ingest_key", v.trim());
  });
  GM_registerMenuCommand("BWN Write Queue: enable draining", function () { GM_setValue("wq_enabled", true); alert("Write-queue draining ENABLED. Each write still waits for your Approve."); });
  GM_registerMenuCommand("BWN Write Queue: disable draining", function () { GM_setValue("wq_enabled", false); alert("Write-queue draining disabled."); });
  GM_registerMenuCommand("BWN Write Queue: refresh Umbrava catalogs now", function () { GM_setValue("wq_catalog_ts", 0); wqPushCatalogs(true); alert("Refreshing the status + user catalogs for the Dashboard pickers."); });

  setInterval(pollTick, POLL_MS);
  setTimeout(pollTick, 3000);
  setTimeout(function () { wqPushCatalogs(false); }, 5000);   // push catalogs on load (throttled), independent of draining
  try { console.log("[BWN Write Queue " + VER + "] loaded" + (enabled() ? " (draining ON)" : " (disabled - use the menu to enable)")); } catch (e) { }
})();
