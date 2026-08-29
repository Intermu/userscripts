// ==UserScript==
// @name         BWN Write Queue (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.4.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-write-queue.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-write-queue.user.js
// @description  Drains the Track C write-back queue: claims THIS coordinator's own queued Umbrava write commands from the SWA, confirms each irreversible write, executes it via patchWorkOrder/addEditJobNote, and reports the result. Self-drain; every write is human-confirmed; disabled until you turn it on. v0.4 adds a gated Bulk Operations Console (whole-batch preview + zero-write dry-run + throttled cancellable execute with per-record results + CSV/JSON export).
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
  var VER = "0.4.0";   // keep in lockstep with @version (TM compares versions, not contents)

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

  // ==== BWN-BULK-CONSOLE START (RM-C1; pure orchestration + PII-safe projections; sliced by
  //      scripts/test-bulk-console.js and CONCATENATED with the EXEC block above, then driven with an
  //      INJECTED executeCommand - never a stub of the write path - so dry-run's 0-write guarantee is
  //      proven against the real engine). NO DOM here; the modal UI lives outside this region. ====
  //
  // RM-C1 is the whole-batch console for the SAME Track C queue the poll-drain sips one at a time.
  // It reuses executeCommand verbatim (proven by test-write-queue-drain.js) and the claim/report
  // transport; it adds: a whole-batch PREVIEW, a zero-write DRY-RUN, a throttled/cancellable/
  // failure-thresholded EXECUTE, per-record RESULTS, and CSV/JSON export of authorized fields only.
  //
  // CEILING (documented, not worked around): the SWA route exposes to the userscript only `claim`
  // (leases ONE command, attempts++) and `report`; `list`/`status` require the Dashboard's AAD
  // principal. So there is no read-only "peek all" - a whole-batch preview is assembled by CLAIMING
  // commands into memory (each a 90s lease). Collected-but-unexecuted commands are released back to
  // the queue (report failed+retryable) so nothing is lost, and a batch should be reviewed + run
  // promptly: a lapsed lease is idempotency-safe (executeCommand skip-if-equal + the note marker) but
  // its terminal report may return superseded. Server-side batch is NOT assumed; this is fully
  // client-orchestrated over the existing one-at-a-time primitives.

  // The field each verb targets - for the preview + export. NEVER the note text.
  var BULK_FIELD = { "wo.status": "status", "wo.assign": "assignedTo", "wo.ecd": "expectedCompletionDate", "wo.note": "note" };

  // ---- Gating (fail-closed) -------------------------------------------------------------------
  // The console may PREVIEW / DRY-RUN with the flag off, but a LIVE batch needs
  // bwn:modules.bulkConsole === true. Default OFF: an absent or unresolved flag reads false.
  function bulkFlagOn(modules) { return !!(modules && modules.bulkConsole === true); }
  // Mid-batch kill: the console's own flag going false OR the shared writeQueue write-switch going
  // false halts a running batch on the NEXT record (the UI re-reads bwn:modules per record, so a flip
  // lands immediately). bwnGqlOp also has its own load-time kill check on feature:'writeQueue'; this
  // is the fresh, mid-batch layer on top of it.
  function bulkKilled(modules) { return !!(modules && (modules.bulkConsole === false || modules.writeQueue === false)); }
  // Typed confirmation before a live batch - the operator types EXECUTE or the exact record count,
  // never a bare confirm(). Empty never matches.
  function bulkConfirmMatches(input, count) { var w = String(input == null ? "" : input).trim(); return w.length > 0 && (w === "EXECUTE" || w === String(count)); }
  // The one gate the UI calls before a live run: flag -> non-empty batch -> typed confirmation.
  function bulkExecuteGate(modules, input, count) {
    if (!bulkFlagOn(modules)) return { allowed: false, reason: "permission-denied" };
    if (!count) return { allowed: false, reason: "empty" };
    if (!bulkConfirmMatches(input, count)) return { allowed: false, reason: "confirm-required" };
    return { allowed: true, reason: null };
  }

  // ---- PII-safe projection --------------------------------------------------------------------
  // executeCommand's before/after are single-key {field:value} scalars (the same the bwn:audit ring
  // stores); pull the lone scalar for a row. Never a nested object, never free text.
  function bulkScalar(o) {
    if (o == null) return null;
    if (typeof o !== "object") return o;
    for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) { var v = o[k]; return (v == null || typeof v === "object") ? null : v; } }
    return null;
  }
  // Project ONE executeCommand outcome (or thrown error) into an authorized, export-safe row. Columns
  // are exactly wo / field / before / after / outcome / detail - never the note text and never a
  // nested object. Outcome vocabulary matches Core's bulk-ops engine: done / noop / would-send /
  // failed (bulkReleasedRow adds not-run).
  function bulkRow(cmd, result, err) {
    var wo = (cmd && cmd.woNumber != null) ? cmd.woNumber : null;
    var verb = cmd && cmd.verb;
    var field = BULK_FIELD[verb] || verb || null;
    if (err) {
      // executeCommand / bwnGqlOp error messages are STRUCTURAL (verb + wrapper layer), never note
      // text; still truncate so an unexpectedly long message cannot smuggle bulk data into an export.
      return { wo: wo, field: field, before: null, after: null, outcome: "failed", detail: String(err && err.message || err).slice(0, 140) };
    }
    var res = (result && result.result) || {};
    if (res.skipped) return { wo: wo, field: field, before: null, after: null, outcome: "noop", detail: String(res.skipped) };
    var before = bulkScalar(result && result.before);
    var after = bulkScalar(result && result.after);
    if (result && result.dryRun) return { wo: wo, field: field, before: before, after: after, outcome: "would-send", detail: "" };
    return { wo: wo, field: field, before: before, after: after, outcome: "done", detail: "" };
  }
  function bulkReleasedRow(cmd, reason) {
    return { wo: (cmd && cmd.woNumber != null) ? cmd.woNumber : null, field: BULK_FIELD[cmd && cmd.verb] || (cmd && cmd.verb) || null, before: null, after: null, outcome: "not-run", detail: String(reason || "released") };
  }
  // 4-state tally (Core's done / noop / failed / notRun vocabulary; would-send is a preview, counted
  // apart). Plain index loop so an unexpected outcome cannot silently vanish from the total.
  function bulkTally(rows) {
    var t = { done: 0, noop: 0, failed: 0, notRun: 0, would: 0, total: (rows || []).length };
    for (var i = 0; i < (rows || []).length; i++) {
      var o = rows[i] && rows[i].outcome;
      if (o === "done") t.done++;
      else if (o === "noop") t.noop++;
      else if (o === "failed") t.failed++;
      else if (o === "not-run") t.notRun++;
      else if (o === "would-send") t.would++;
    }
    return t;
  }

  // ---- The sequential batch runner ------------------------------------------------------------
  // ONE command in flight (the queue's own rule), throttled between real writes, cancellable, and
  // failure-thresholded. Transport-agnostic: it calls execFn(cmd,{dryRun}) and hands each outcome to
  // onRecord; on a STOP it hands every UNPROCESSED command to onReleased so nothing silently
  // continues or is lost. It performs NO writes and NO server reports itself - the caller wires those,
  // which is exactly why a dry run (execFn is dry-guarded AND the caller wires no report) is provably
  // write-free.  isStopped() returns 'pause' (halt, keep the leases, resumable) | any other truthy
  // value = cancel (halt + release the remainder) | falsy (continue).
  //   deps: { execFn, dryRun, throttleMs, delayFn, failThreshold, isStopped, onRecord, onReleased }
  function bulkRunBatch(batch, deps) {
    deps = deps || {};
    var execFn = deps.execFn;
    var dryRun = !!deps.dryRun;
    var throttleMs = deps.throttleMs || 0;
    var delayFn = deps.delayFn || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
    var failThreshold = deps.failThreshold || 0;   // 0 = never abort on failures alone
    var isStopped = deps.isStopped || function () { return false; };
    var onRecord = deps.onRecord || function () {};
    var onReleased = deps.onReleased || function () {};
    var rows = [], failCount = 0;

    function done() { return { rows: rows, stopped: false, reason: null, processed: rows.length, released: 0 }; }
    function paused(idx) { return { rows: rows, stopped: true, reason: "paused", pausedAt: idx, processed: rows.length, released: 0 }; }
    function release(fromIndex, reason) {
      var processed = rows.length;
      for (var k = fromIndex; k < batch.length; k++) { onReleased(batch[k], reason); rows.push(bulkReleasedRow(batch[k], reason)); }
      return { rows: rows, stopped: true, reason: reason, processed: processed, released: batch.length - fromIndex };
    }
    function stepAt(idx) {
      if (idx >= batch.length) return Promise.resolve(done());
      // Cancel / kill / pause is checked BEFORE firing this record - the established hazard is a bulk
      // path that keeps writing after a stop. On pause we keep the leases (resumable); on cancel every
      // remaining command is released, never silently executed.
      var stop = isStopped();
      if (stop === "pause") return Promise.resolve(paused(idx));
      if (stop) return Promise.resolve(release(idx, typeof stop === "string" ? stop : "cancelled"));
      var cmd = batch[idx];
      return Promise.resolve().then(function () { return execFn(cmd, { dryRun: dryRun }); }).then(function (r) {
        var row = bulkRow(cmd, r, null); rows.push(row); onRecord(row, cmd, idx, batch.length);
        return afterOne(idx);
      }, function (e) {
        failCount++;
        var row = bulkRow(cmd, null, e); rows.push(row); onRecord(row, cmd, idx, batch.length);
        // Partial-failure: one bad record does NOT abort the rest - UNLESS the failure threshold
        // trips, then the remainder (from idx+1; this one was already reported) is released.
        if (failThreshold && failCount >= failThreshold) return release(idx + 1, "fail-threshold");
        return afterOne(idx);
      });
    }
    function afterOne(idx) {
      if (idx + 1 >= batch.length) return done();
      var d = (!dryRun && throttleMs) ? throttleMs : 0;   // throttle real writes only; dry-run is read-only
      return (d ? delayFn(d) : Promise.resolve()).then(function () { return stepAt(idx + 1); });
    }
    return Promise.resolve().then(function () { return stepAt(0); });
  }

  // ---- Export (authorized fields only) --------------------------------------------------------
  function bulkCsvCell(v) { var s = (v == null ? "" : String(v)); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
  function bulkToCSV(rows) {
    var head = ["wo", "field", "before", "after", "outcome", "detail"];
    var out = [head.join(",")];
    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      out.push([r.wo, r.field, bulkCsvCell(r.before), bulkCsvCell(r.after), r.outcome, bulkCsvCell(r.detail)].join(","));
    }
    return out.join("\r\n");
  }
  function bulkToJSON(rows, meta) {
    meta = meta || {};
    return JSON.stringify({ schema: 1, tool: "bwn-bulk-console", ver: BWN_VER, mode: meta.mode || null, ts: Date.now(), count: (rows || []).length, tally: bulkTally(rows), rows: rows || [] }, null, 2);
  }
  // ==== BWN-BULK-CONSOLE END ====

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

  // ==== BWN-BULK-CONSOLE UI (RM-C1; the modal that drives the pure engine above). Kept OUT of the
  //      sliced BWN-BULK-CONSOLE region so the harness never needs a DOM. ====
  function bulkModules() { try { return JSON.parse(localStorage.getItem("bwn:modules") || "{}") || {}; } catch (e) { return {}; } }
  // Merge-write one bwn:modules flag (never clobber a sibling module's switch).
  function bulkSetFlag(name, val) {
    var m = bulkModules(); m[name] = val;
    try { localStorage.setItem("bwn:modules", JSON.stringify(m)); } catch (e) { }
  }

  // Minimal local focus trap. The shared BWN.a11yDialog lives in bwn-suite-core, a DIFFERENT GM
  // sandbox this island cannot reach, so it is reimplemented here (same contract: Tab wrap, Escape,
  // initial focus, focus restore).
  function bulkTrap(dialogEl, opts) {
    opts = opts || {};
    var prevFocus = document.activeElement;
    dialogEl.setAttribute("role", "dialog");
    dialogEl.setAttribute("aria-modal", "true");
    if (opts.label) dialogEl.setAttribute("aria-label", opts.label);
    if (!dialogEl.hasAttribute("tabindex")) dialogEl.setAttribute("tabindex", "-1");
    var SEL = 'a[href],button:not([disabled]),textarea:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])';
    function focusables() {
      return Array.prototype.filter.call(dialogEl.querySelectorAll(SEL), function (el) {
        return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
      });
    }
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); if (opts.onEscape) opts.onEscape(); return; }
      if (e.key !== "Tab" || !dialogEl.isConnected) return;
      var f = focusables(), act = document.activeElement;
      if (!f.length) { e.preventDefault(); try { dialogEl.focus(); } catch (_) { } return; }
      var first = f[0], last = f[f.length - 1];
      if (!dialogEl.contains(act)) { e.preventDefault(); first.focus(); return; }
      if (e.shiftKey && act === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && act === last) { e.preventDefault(); first.focus(); }
    }
    document.addEventListener("keydown", onKey, true);
    setTimeout(function () { try { (opts.initial || focusables()[0] || dialogEl).focus(); } catch (_) { } }, 0);
    return function release() {
      document.removeEventListener("keydown", onKey, true);
      try { if (prevFocus && prevFocus.focus && prevFocus.isConnected) prevFocus.focus(); } catch (_) { }
    };
  }

  var bulkStyleInjected = false;
  function bulkInjectStyle() {
    if (bulkStyleInjected) return;
    bulkStyleInjected = true;
    var s = document.createElement("style");
    s.textContent =
      '[data-bwn-bulk] :focus-visible{outline:2px solid #f59e0b;outline-offset:2px;}' +
      '[data-bwn-bulk] button{font:13px/1.4 system-ui,sans-serif;padding:6px 12px;border-radius:6px;cursor:pointer;border:1px solid #4b5563;background:#1f2937;color:#e5e7eb;}' +
      '[data-bwn-bulk] button[disabled]{opacity:.4;cursor:not-allowed;}' +
      '[data-bwn-bulk] button.primary{border:0;background:#2563eb;color:#fff;font-weight:600;}' +
      '[data-bwn-bulk] button.danger{border:0;background:#b91c1c;color:#fff;font-weight:600;}' +
      '[data-bwn-bulk] input{font:13px system-ui,sans-serif;padding:4px 6px;border-radius:5px;border:1px solid #4b5563;background:#0b1220;color:#e5e7eb;}' +
      '[data-bwn-bulk] th,[data-bwn-bulk] td{padding:4px 8px;border-bottom:1px solid #1f2937;text-align:left;white-space:nowrap;}' +
      '[data-bwn-bulk] .b-ok{color:#34d399;}[data-bwn-bulk] .b-noop{color:#9ca3af;}[data-bwn-bulk] .b-would{color:#93c5fd;}' +
      '[data-bwn-bulk] .b-fail{color:#f87171;}[data-bwn-bulk] .b-notrun{color:#fbbf24;}';
    (document.head || document.documentElement).appendChild(s);
  }

  function bel(tag, css, text) {
    var e = document.createElement(tag);
    if (css) e.style.cssText = css;
    if (text != null) e.textContent = text;
    return e;
  }

  // Console state. mode drives the button enable/disable + the state badge.
  var bulkUI = null;         // { release, refs... }
  var bulkState = { batch: [], rows: [], tok: "", mode: "idle", running: false, pause: false, cancel: false, cursor: 0 };

  function bulkOutcomeClass(o) {
    return o === "done" ? "b-ok" : o === "noop" ? "b-noop" : o === "would-send" ? "b-would" : o === "failed" ? "b-fail" : "b-notrun";
  }
  function bulkArrow(row) {
    if (row.field === "note") return "(internal note)";
    var b = row.before == null ? "—" : String(row.before);
    var a = row.after == null ? "—" : String(row.after);
    return b + " → " + a;
  }

  // Collect a batch by CLAIMING up to `limit` commands into memory (the documented ceiling: no
  // read-only peek). busy blocks the poll-drain from racing us for the same commands.
  function bulkCollect(limit) {
    var tok = authToken();
    if (!tok || !ingestKey()) return Promise.resolve({ error: "Not signed in to Umbrava, or the SWA ingest key is unset (set it from the menu)." });
    busy = true;
    var got = [];
    function loop() {
      if (got.length >= limit) return Promise.resolve();
      return claimOnce(tok).then(function (cmd) {
        if (!cmd) return Promise.resolve();
        got.push(cmd);
        return loop();
      });
    }
    return loop().then(function () { busy = false; return { tok: tok, batch: got }; },
      function (e) { busy = false; return { error: (e && e.message) || String(e) }; });
  }

  // isStopped for a LIVE run: user cancel -> 'cancel'; user pause -> 'pause'; a mid-batch kill (either
  // flag flipped false) -> 'cancel' (halt + release). Read bwn:modules FRESH so a flip lands at once.
  function bulkStopSignal() {
    if (bulkState.cancel) return "cancel";
    if (bulkKilled(bulkModules())) return "cancel";
    if (bulkState.pause) return "pause";
    return false;
  }

  function bulkRun(dryRun, startIndex) {
    var slice = bulkState.batch.slice(startIndex || 0);
    var throttle = bulkNum(bulkUI.throttle.value, 400);
    var threshold = bulkNum(bulkUI.threshold.value, 0);
    bulkState.running = true; bulkState.cancel = false; bulkState.pause = false;
    bulkState.mode = dryRun ? "dry" : "running";
    if (!dryRun) busy = true;
    bulkRender();
    return bulkRunBatch(slice, {
      execFn: executeCommand,
      dryRun: dryRun,
      throttleMs: throttle,
      failThreshold: threshold,
      isStopped: dryRun ? function () { return bulkState.cancel ? "cancel" : false; } : bulkStopSignal,
      onRecord: function (row, cmd) {
        bulkState.rows.push(row);
        if (!dryRun) {
          // Report the live terminal outcome to the SWA queue (done / failed). Best-effort: a failed
          // report does not change what already happened at Umbrava.
          if (row.outcome === "failed") reportResult(bulkState.tok, cmd.id, "failed", null, row.detail, false).catch(function () { });
          else reportResult(bulkState.tok, cmd.id, "done", { outcome: row.outcome }, "", false).catch(function () { });
        }
        bulkRenderRows();
      },
      onReleased: function (cmd, reason) {
        bulkState.rows.push(bulkReleasedRow(cmd, reason));
        // Return every unprocessed command to the queue so nothing silently continues or is lost.
        // Retryable -> it re-enters the queue for a later drain (dry-run never reports).
        if (!dryRun) reportResult(bulkState.tok, cmd.id, "failed", null, "released - " + reason, true).catch(function () { });
        bulkRenderRows();
      }
    }).then(function (summary) {
      bulkState.running = false;
      if (summary.reason === "paused") {
        bulkState.cursor = (startIndex || 0) + summary.pausedAt;
        bulkState.mode = "paused";
      } else {
        bulkState.cursor = bulkState.batch.length;
        bulkState.mode = dryRun ? "dry-done" : (summary.stopped ? "cancelled" : "done");
      }
      if (!dryRun && !bulkState.running) busy = false;
      bulkRender();
      return summary;
    });
  }

  function bulkNum(v, def) { var n = parseInt(v, 10); return isFinite(n) && n >= 0 ? n : def; }

  function bulkDownload(filename, text, mime) {
    try {
      var blob = new Blob([text], { type: mime || "text/plain" });
      var url = URL.createObjectURL(blob);
      var a = document.createElement("a");
      a.href = url; a.download = filename; a.style.display = "none";
      document.body.appendChild(a); a.click();
      setTimeout(function () { try { document.body.removeChild(a); } catch (e) { } URL.revokeObjectURL(url); }, 0);
    } catch (e) {
      try { navigator.clipboard.writeText(text); alert("Download blocked; " + filename + " copied to clipboard."); }
      catch (e2) { prompt("Copy " + filename + ":", text); }
    }
  }

  // ---- Render -------------------------------------------------------------------------------
  function bulkBadgeText() {
    var m = bulkState.mode;
    return m === "idle" ? "No batch" : m === "empty" ? "Nothing queued" : m === "ready" ? "Batch ready (preview)" : m === "dry" ? "Dry-run..." :
      m === "dry-done" ? "Dry-run complete (no writes)" : m === "running" ? "Executing..." : m === "paused" ? "Paused" :
        m === "cancelled" ? "Stopped" : m === "done" ? "Done" : m === "loading" ? "Collecting..." : m === "error" ? "Error" : m;
  }
  function bulkRenderRows() {
    if (!bulkUI) return;
    var tbody = bulkUI.tbody;
    tbody.textContent = "";
    if (!bulkState.rows.length) {
      var tr0 = bel("tr"); var td0 = bel("td", "color:#9ca3af;"); td0.colSpan = 4;
      td0.textContent = bulkState.mode === "loading" ? "Collecting queued commands…"
        : bulkState.batch.length ? "Batch collected. Run Dry-run to preview each change, or Execute to write."
          : "Nothing queued for you right now.";
      tr0.appendChild(td0); tbody.appendChild(tr0); return;
    }
    for (var i = 0; i < bulkState.rows.length; i++) {
      var r = bulkState.rows[i];
      var tr = bel("tr");
      tr.appendChild(bel("td", null, "W-" + (r.wo == null ? "?" : r.wo)));
      tr.appendChild(bel("td", null, r.field || ""));
      tr.appendChild(bel("td", null, bulkArrow(r)));
      var td = bel("td"); var span = bel("span", null, r.outcome + (r.detail ? (" · " + r.detail) : ""));
      span.className = bulkOutcomeClass(r.outcome); td.appendChild(span); tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }
  function bulkRender() {
    if (!bulkUI) return;
    var flagOn = bulkFlagOn(bulkModules());
    var hasBatch = bulkState.batch.length > 0;
    var idle = !bulkState.running;
    bulkUI.badge.textContent = bulkBadgeText();
    bulkUI.collectBtn.disabled = !idle;
    bulkUI.dryBtn.disabled = !idle || !hasBatch;
    bulkUI.execBtn.disabled = !idle || !hasBatch || !flagOn;
    bulkUI.confirmInput.disabled = !idle || !hasBatch || !flagOn;
    bulkUI.pauseBtn.disabled = !(bulkState.running && !bulkState.pause);
    bulkUI.resumeBtn.disabled = !(bulkState.mode === "paused");
    bulkUI.cancelBtn.disabled = !(bulkState.running || bulkState.mode === "paused");
    bulkUI.csvBtn.disabled = !bulkState.rows.length;
    bulkUI.jsonBtn.disabled = !bulkState.rows.length;
    // Permission notice (flag off = permission-denied for LIVE execution; preview stays available).
    if (!flagOn) {
      bulkUI.notice.textContent = "Live execution is OFF (bwn:modules.bulkConsole is not enabled). Preview and dry-run are available; enable writes from the Tampermonkey menu to execute.";
      bulkUI.notice.style.color = "#fbbf24";
    } else if (hasBatch && idle && bulkState.mode !== "done" && bulkState.mode !== "cancelled") {
      bulkUI.notice.textContent = "Ready. Type EXECUTE or the record count (" + bulkState.batch.length + ") to run " + bulkState.batch.length + " live write(s).";
      bulkUI.notice.style.color = "#93c5fd";
    } else {
      bulkUI.notice.textContent = "";
    }
    // Progress + tally (aria-live).
    var t = bulkTally(bulkState.rows);
    bulkUI.progress.textContent = bulkState.rows.length
      ? ("Processed " + bulkState.rows.length + " / " + bulkState.batch.length + "  —  done " + t.done + " · no-op " + t.noop + " · would-send " + t.would + " · failed " + t.failed + " · not-run " + t.notRun)
      : ("Batch size: " + bulkState.batch.length);
    bulkRenderRows();
  }

  function bulkClose() {
    if (bulkState.running) {
      // Never yank the modal out from under an in-flight write. Cancel first; it stops before the next
      // record and releases the remainder, then the run's .then closes nothing - the operator re-opens.
      bulkState.cancel = true;
      return;
    }
    if (bulkUI && bulkUI.release) bulkUI.release();
    if (bulkUI && bulkUI.overlay && bulkUI.overlay.parentNode) bulkUI.overlay.parentNode.removeChild(bulkUI.overlay);
    bulkUI = null;
    if (!bulkState.running) busy = false;
    // ponytail: collected-but-unexecuted commands are NOT actively released on close; their 90s claim
    // lease lapses and the contract re-offers them (reclaimable). Active release happens only on
    // cancel/threshold during a live run. Upgrade path: add an explicit release-on-close sweep if the
    // lease window proves too long in practice.
    bulkState = { batch: [], rows: [], tok: "", mode: "idle", running: false, pause: false, cancel: false, cursor: 0 };
  }

  function openBulkConsole() {
    if (bulkUI) { try { bulkUI.panel.focus(); } catch (e) { } return; }
    bulkInjectStyle();
    bulkState = { batch: [], rows: [], tok: "", mode: "idle", running: false, pause: false, cancel: false, cursor: 0 };

    var overlay = bel("div", "position:fixed;inset:0;z-index:2147483001;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;");
    overlay.setAttribute("data-bwn-bulk", "1");
    var panel = bel("div", "width:min(760px,94vw);max-height:88vh;overflow:auto;background:#0f172a;color:#e5e7eb;border:1px solid #334155;border-radius:12px;box-shadow:0 12px 40px rgba(0,0,0,.5);font:13px/1.5 system-ui,sans-serif;padding:16px 18px;");

    // Header
    var head = bel("div", "display:flex;align-items:center;gap:10px;margin-bottom:12px;");
    var h = bel("div", "font-weight:700;font-size:15px;color:#f9fafb;", "Bulk Operations Console");
    var badge = bel("span", "margin-left:auto;font-size:12px;color:#93c5fd;border:1px solid #334155;border-radius:999px;padding:2px 10px;");
    badge.setAttribute("aria-live", "polite");
    var closeBtn = bel("button", "border:1px solid #4b5563;background:transparent;", "✕");
    closeBtn.setAttribute("aria-label", "Close bulk console");
    head.appendChild(h); head.appendChild(badge); head.appendChild(closeBtn);

    var sub = bel("div", "color:#94a3b8;margin-bottom:12px;", "Whole-batch preview + zero-write dry-run + throttled, cancellable execute over your queued Track C write-back commands. Every live write is audited and confirmed.");

    // Controls
    var ctl = bel("div", "display:flex;flex-wrap:wrap;gap:12px;align-items:flex-end;margin-bottom:12px;");
    function field(labelText, val, w) {
      var wrap = bel("label", "display:flex;flex-direction:column;gap:3px;font-size:11px;color:#94a3b8;");
      wrap.appendChild(document.createTextNode(labelText));
      var inp = bel("input", "width:" + (w || 90) + "px;"); inp.type = "number"; inp.min = "0"; inp.value = String(val);
      wrap.appendChild(inp); return { wrap: wrap, input: inp };
    }
    var fLimit = field("Batch limit", 25, 90);
    var fThrottle = field("Throttle (ms)", 400, 100);
    var fThreshold = field("Stop after N fails (0=off)", 0, 150);
    var collectBtn = bel("button", null, "Collect queued");
    ctl.appendChild(fLimit.wrap); ctl.appendChild(fThrottle.wrap); ctl.appendChild(fThreshold.wrap); ctl.appendChild(collectBtn);

    var notice = bel("div", "min-height:18px;margin-bottom:8px;font-size:12px;");
    notice.setAttribute("aria-live", "polite");

    // Table
    var tableWrap = bel("div", "border:1px solid #1f2937;border-radius:8px;overflow:auto;max-height:38vh;margin-bottom:10px;");
    var table = bel("table", "border-collapse:collapse;width:100%;font-size:12.5px;");
    var thead = bel("thead"); var htr = bel("tr");
    ["WO", "Field", "Change (current → proposed)", "Result"].forEach(function (t) { var th = bel("th", "position:sticky;top:0;background:#0b1220;color:#cbd5e1;"); th.textContent = t; htr.appendChild(th); });
    thead.appendChild(htr); table.appendChild(thead);
    var tbody = bel("tbody"); table.appendChild(tbody); tableWrap.appendChild(table);

    var progress = bel("div", "color:#cbd5e1;font-size:12px;margin-bottom:10px;");
    progress.setAttribute("aria-live", "polite");

    // Typed-confirm
    var confirmRow = bel("div", "display:flex;align-items:center;gap:8px;margin-bottom:10px;");
    var confirmLbl = bel("label", "font-size:12px;color:#cbd5e1;");
    confirmLbl.setAttribute("for", "bwn-bulk-confirm");
    confirmLbl.textContent = "Type EXECUTE (or the count) to arm live writes:";
    var confirmInput = bel("input", "width:140px;"); confirmInput.id = "bwn-bulk-confirm"; confirmInput.type = "text"; confirmInput.autocomplete = "off";
    confirmRow.appendChild(confirmLbl); confirmRow.appendChild(confirmInput);

    // Actions
    var actions = bel("div", "display:flex;flex-wrap:wrap;gap:8px;");
    var dryBtn = bel("button", null, "Dry-run (no writes)");
    var execBtn = bel("button", null, "Execute batch"); execBtn.className = "primary";
    var pauseBtn = bel("button", null, "Pause");
    var resumeBtn = bel("button", null, "Resume");
    var cancelBtn = bel("button", null, "Cancel"); cancelBtn.className = "danger";
    var csvBtn = bel("button", null, "Export CSV");
    var jsonBtn = bel("button", null, "Export JSON");
    [dryBtn, execBtn, pauseBtn, resumeBtn, cancelBtn, csvBtn, jsonBtn].forEach(function (b) { actions.appendChild(b); });

    panel.appendChild(head); panel.appendChild(sub); panel.appendChild(ctl); panel.appendChild(notice);
    panel.appendChild(tableWrap); panel.appendChild(progress); panel.appendChild(confirmRow); panel.appendChild(actions);
    overlay.appendChild(panel); document.body.appendChild(overlay);
    // Clicking the backdrop (not the panel) closes when idle.
    overlay.addEventListener("mousedown", function (e) { if (e.target === overlay) bulkClose(); });

    var release = bulkTrap(panel, { label: "Bulk Operations Console", initial: collectBtn, onEscape: bulkClose });
    bulkUI = {
      overlay: overlay, panel: panel, badge: badge, notice: notice, progress: progress, tbody: tbody,
      limit: fLimit.input, throttle: fThrottle.input, threshold: fThreshold.input, confirmInput: confirmInput,
      collectBtn: collectBtn, dryBtn: dryBtn, execBtn: execBtn, pauseBtn: pauseBtn, resumeBtn: resumeBtn,
      cancelBtn: cancelBtn, csvBtn: csvBtn, jsonBtn: jsonBtn, release: release
    };

    closeBtn.addEventListener("click", bulkClose);
    collectBtn.addEventListener("click", function () {
      bulkState.mode = "loading"; bulkState.rows = []; bulkState.batch = []; bulkRender();
      bulkCollect(bulkNum(fLimit.input.value, 25)).then(function (res) {
        if (res.error) { bulkState.mode = "error"; bulkUI.notice.textContent = res.error; bulkUI.notice.style.color = "#f87171"; bulkRender(); return; }
        bulkState.batch = res.batch; bulkState.tok = res.tok; bulkState.cursor = 0;
        bulkState.mode = res.batch.length ? "ready" : "empty"; bulkRender();
      });
    });
    dryBtn.addEventListener("click", function () { bulkState.rows = []; bulkState.cursor = 0; bulkRun(true, 0); });
    execBtn.addEventListener("click", function () {
      var gate = bulkExecuteGate(bulkModules(), confirmInput.value, bulkState.batch.length);
      if (!gate.allowed) {
        bulkUI.notice.style.color = "#f87171";
        bulkUI.notice.textContent = gate.reason === "permission-denied" ? "Blocked: live execution is disabled (enable bulkConsole from the menu)."
          : gate.reason === "empty" ? "Nothing to execute - collect a batch first."
            : "Type EXECUTE or the exact count (" + bulkState.batch.length + ") to confirm.";
        try { confirmInput.focus(); } catch (e) { }
        return;
      }
      bulkState.rows = []; bulkState.cursor = 0; bulkRun(false, 0);
    });
    pauseBtn.addEventListener("click", function () { bulkState.pause = true; bulkState.mode = "paused"; bulkRender(); });
    resumeBtn.addEventListener("click", function () { if (bulkState.mode === "paused") bulkRun(false, bulkState.cursor); });
    cancelBtn.addEventListener("click", function () { bulkState.cancel = true; bulkState.pause = false; });
    csvBtn.addEventListener("click", function () { bulkDownload("bulk-console-results.csv", bulkToCSV(bulkState.rows), "text/csv"); });
    jsonBtn.addEventListener("click", function () { bulkDownload("bulk-console-results.json", bulkToJSON(bulkState.rows, { mode: bulkState.mode }), "application/json"); });

    bulkRender();
  }
  // ==== BWN-BULK-CONSOLE UI END ====

  // ---- Menu commands + boot ----
  GM_registerMenuCommand("BWN Write Queue: open Bulk Operations Console", function () { try { openBulkConsole(); } catch (e) { alert("Could not open the console: " + ((e && e.message) || e)); } });
  GM_registerMenuCommand("BWN Write Queue: ENABLE bulk console live writes", function () { bulkSetFlag("bulkConsole", true); alert("Bulk Console LIVE writes ENABLED (bwn:modules.bulkConsole = true). Each batch still needs a typed EXECUTE confirmation."); });
  GM_registerMenuCommand("BWN Write Queue: disable bulk console live writes", function () { bulkSetFlag("bulkConsole", false); alert("Bulk Console live writes disabled. Preview + dry-run stay available."); });
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
