// ==UserScript==
// @name         BWN Bulk Asset Uploader (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.2.0
// @description  Bulk-creates Umbrava assets across a client's locations from a CSV/XLSX (one row = one asset at one location), or bulk-renames existing assets when the file has a "New Name" column (rename by Tag ID: Location # + Tag ID find the asset, Validate shows current -> new name, each rename reads the whole asset, sends it back with only the name changed via editAsset, then re-reads it and halts if anything but the name moved). Opens from the shared dock (bwn:dock:*, hosted by bwn-suite-core) on /clients/<id> pages only; without Core a floating "Bulk Assets" button appears instead. Columns are matched by header name; Validate is read-only (loads the client's location list once and matches each location # locally, matches trades/asset types by name, flags bad dates, in-file duplicates, and assets that already exist at the location by serial, else tag, else name). Create runs only after a confirm showing the count and number of locations, one createAsset at a time (350ms apart) through the governed bwnGqlOp path (audit ring, kill switch flag bulkAssets, high-risk confirm), with live progress and a Stop that finishes the current row. A 401/403/expired session/429 or an unsure network failure halts the run; re-running skips rows already created. Download results writes an XLSX of every row's outcome. Same-origin /api/graphql with the page's own Umbrava session token, read per request and never stored or shown. @grant none, no @connect.
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-bulk-assets.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-bulk-assets.user.js
// @match        https://app.umbrava.com/*
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js#sha384=bed8dab3289d528d245bde0ae4c5c35e7b73389a50801297984eded866b82c6d2c9134cb7818bdede1405eca9ec098f0
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.2.0';
  var DOCK_KEY = 'bulk-assets';
  var FEATURE = 'bulkAssets';           // bwn:modules kill switch for the create write
  var DOCK_WAIT_MS = 4000;
  var CREATE_GAP_MS = 350;
  var READ_GAP_MS = 100;
  var EXPIRY_MARGIN_SEC = 120;
  var LOCATION_PAGE = 200;
  var LOCATION_LIST_CAP = 20000;        // ponytail: the whole client list is loaded once; past this, go back to per-row search
  var ASSET_PAGE = 500;
  var OPEN_ONLY_FILTER = { columnName: 'Status', operation: 'In', searchTerm: '["Open"]' };
  // Umbrava's own field limits (the asset form's maxlength, 2026-10-07; the server refused a 54-char
  // Tag ID with "must be 50 characters or fewer"). Checked in Validate so a long value is a row
  // error before the run, not a refused create mid-run.
  var FIELD_LIMITS = [['name', 'Asset Name', 100], ['tagId', 'Tag ID', 50], ['modelNumber', 'Model', 50],
    ['serialNumber', 'Serial', 50], ['manufacturer', 'Manufacturer', 100], ['tagLocation', 'Tag Location', 400],
    ['PhysicalLocation', 'Physical Location', 400]];

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

  // ===== BWN-PERM START v2 (paste-identical; pinned by scripts/test-perm-block-ledger.js) =====
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
  //
  // v2 binds the slot to the Auth0 `sub` of the Umbrava API token it was decoded under. A slot that
  // is not provably the CURRENT user's - another user's (account switch in the same browser
  // profile), a v1 slot, or a page whose token store names no single user - reads exactly like
  // "nothing decoded yet", so user A's grants AND denials never apply to user B. Identity
  // isolation only: the fail-open fallback above is unchanged and the server stays the boundary.
  var BWN_PERM_KEY = 'bwn:perm:last';
  var BWN_PERM_TTL_MS = 24 * 3600 * 1000;
  var _bwnPermSlot = null;      // memoized parse; re-validated (sub + TTL) on every read
  // The signed-in user's Auth0 subject, from the unexpired Umbrava-issued API token(s) in the SDK
  // cache, or null when there is none or they name more than one user. Payload only, no signature
  // check (nothing here is trusted beyond "which user is this page"); the token is never kept.
  function bwnPermSub() {
    var found = null;
    try {
      var keys = Object.keys(localStorage);
      for (var i = 0; i < keys.length; i++) {
        if (!/@@auth0spajs@@::.*::https:\/\/app\.umbrava\.com\/api::/.test(keys[i])) continue;
        var sub = null;
        try {
          var body = (JSON.parse(localStorage.getItem(keys[i])) || {}).body;
          var t = JSON.parse(atob(String(body && body.access_token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
          var iss = String(t.iss || '').replace(/\/+$/, '');
          if ((iss === 'https://login.umbrava.com' || iss === 'https://umbrava.us.auth0.com') &&
            !(typeof t.exp === 'number' && (Date.now() / 1000) > t.exp) &&
            typeof t.sub === 'string' && t.sub) sub = t.sub;
        } catch (e) { /* an unreadable entry is not a candidate */ }
        if (!sub) continue;
        if (found && found !== sub) return null;                 // two users' tokens -> ambiguous
        found = sub;
      }
    } catch (e) { return null; }
    return found;
  }
  function bwnPermOwn(p, sub) {
    var now = Date.now();
    return !!(p && typeof p === 'object' && !Array.isArray(p) && p.v === 2 &&
      typeof p.sub === 'string' && p.sub !== '' && p.sub === sub &&
      typeof p.ts === 'number' && isFinite(p.ts) && p.ts <= now && (now - p.ts) < BWN_PERM_TTL_MS &&
      Array.isArray(p.groups) && Array.isArray(p.granted));
  }
  function bwnPermSlot() {
    // Re-resolve sub on every read so a same-page account switch cannot reuse cached grants.
    var sub = bwnPermSub();
    if (!sub) return null;
    if (bwnPermOwn(_bwnPermSlot, sub)) return _bwnPermSlot;
    _bwnPermSlot = null;
    try {
      var p = JSON.parse(localStorage.getItem(BWN_PERM_KEY) || 'null');
      if (bwnPermOwn(p, sub)) _bwnPermSlot = p;
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
  // ===== BWN-PERM END v2 =====

  // ---- Transport ------------------------------------------------------------------------------
  // A halt error stops a run (or a validation) outright. kind: 'auth' | 'rate' | 'network';
  // 'network' on a write means the request may or may not have landed.
  function haltError(message, kind) {
    var e = new Error(message);
    e.baHalt = kind;
    e.bwnNonTransient = true;           // never let the wrapper retry a halt
    return e;
  }
  // Expiry read for the "refresh before it lapses mid-run" warning. Payload only; the token is
  // never kept.
  function tokenExpiresSoon(tok) {
    try {
      var p = JSON.parse(atob(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      return typeof p.exp === 'number' && p.exp - Date.now() / 1000 < EXPIRY_MARGIN_SEC;
    } catch (e) { return false; }
  }

  // Umbrava has three error envelopes: [{message}], ["text"], and ASP.NET {Field:["text"]}, and a
  // write the REST backend refuses comes back BAD_USER_INPUT with message "". An empty message
  // falls back to extensions.code rather than a JSON dump of the stack.
  function gqlErrText(j) {
    var e = j && j.errors;
    if (!e) return null;
    var parts;
    if (Array.isArray(e)) {
      parts = e.map(function (x) {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object' && 'message' in x) return String(x.message || (x.extensions && x.extensions.code) || '');
        return JSON.stringify(x);
      });
    } else if (typeof e === 'object') {
      parts = Object.keys(e).map(function (k) { return k + ': ' + [].concat(e[k]).join(' '); });
    } else parts = [String(e)];
    var out = parts.join('; ').trim();
    return out ? out.slice(0, 300) : null;
  }

  var AUTH_CODE_RE = /UNAUTHENTICATED|UNAUTHORIZED|FORBIDDEN|AUTH_NOT_AUTHENTICATED|AUTH_NOT_AUTHORIZED/i;
  async function baGql(query, variables, write) {
    var tok = authToken();
    if (!tok) throw haltError('No active Umbrava session. Refresh the page and sign in, then try again.', 'auth');
    if (tokenExpiresSoon(tok)) throw haltError('Your Umbrava session is about to expire. Refresh the page, reload the file and Validate again - rows already created will show as "exists".', 'auth');
    var unsure = ' The row may or may not have been created - Validate again before resuming.';
    var m = /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query);
    var res, text;
    try {
      res = await fetch('/api/graphql', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
        body: JSON.stringify({ operationName: m ? m[1] : null, query: query, variables: variables || {} })
      });
      text = await res.text();
    } catch (e) {
      throw haltError('Network error.' + (write ? unsure : ' Check your connection and try again.'), 'network');
    } finally {
      tok = null;
    }
    var j = null;
    try { j = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON body: reported below */ }
    var codes = (j && Array.isArray(j.errors) ? j.errors : []).map(function (x) { return String((x && x.extensions && x.extensions.code) || ''); });
    // Auth first: Umbrava answers an unauthenticated call with HTTP 500 + UNAUTHENTICATED.
    if (res.status === 401 || res.status === 403 || codes.some(function (c) { return AUTH_CODE_RE.test(c); })) {
      throw haltError('Umbrava refused the session (HTTP ' + res.status + '). Refresh the page and sign in again.', 'auth');
    }
    if (res.status === 429) throw haltError('Umbrava is rate-limiting requests (HTTP 429). Wait a minute, then resume.', 'rate');
    if (res.status >= 500 && write) throw haltError('Umbrava server error (HTTP ' + res.status + ').' + unsure, 'network');
    if (j && j.errors) throw new Error(gqlErrText(j) || 'Umbrava rejected the request (no detail given)');
    if (!res.ok) throw new Error('HTTP ' + res.status + (text ? '' : ' (empty response)'));
    if (!j || !j.data) throw new Error('Unexpected response from Umbrava (no data)');
    return j.data;
  }

  // ---- BWN-OPS: the one write goes through the audited wrapper -------------------------------
  function bwnGql(query, variables) { return baGql(query, variables, /^\s*mutation\b/.test(query)); }
  var BWN_VER = VER;
  var BWN_MODULES = (function () { try { return JSON.parse(localStorage.getItem('bwn:modules') || '{}') || {}; } catch (e) { return {}; } })();
  // Central governance: fold the org flags bwn-suite-ai caches to bwn:gov into BWN_MODULES as
  // ONE-WAY disables (same shape as Core's bwnApplyGov). flags.bulkAssets===false or
  // globalKillSwitch blocks new creates with no reload; nothing remote can enable one.
  if (!(FEATURE in BWN_MODULES)) BWN_MODULES[FEATURE] = true;
  function bwnApplyGov() {
    try {
      var g = JSON.parse(localStorage.getItem('bwn:gov') || 'null');
      if (!g || typeof g !== 'object' || !g.flags || typeof g.flags !== 'object') return;
      var f = g.flags, kill = f.globalKillSwitch === true;
      Object.keys(BWN_MODULES).forEach(function (k) {
        if (kill || f[k] === false) BWN_MODULES[k] = false;   // one-way: only ever disable
      });
    } catch (e) { /* corrupt bundle -> keep local defaults (safe) */ }
  }
  bwnApplyGov();
  try { document.addEventListener('bwn:gov', function () { bwnApplyGov(); }); } catch (e) { }
  // createAsset: high risk because one confirm sends many writes; not idempotent, never retried.
  // No `perm` (OWED, exempted in scripts/test-registry-authoritative.js): Umbrava's asset permission
  // flags have not been captured, and a guessed key would fail OPEN anyway. The server is the gate.
  // editAsset (rename mode): a FULL replace of the asset's 27 fields, so a field left out could be
  // blanked - the caller always sends the whole record it just read. Same OWED perm as createAsset.
  var BWN_OPS = {
    createAsset: { kind: 'write', target: 'asset', risk: 'high', idempotent: false, retry: 'none',
      ok: 'Asset created.', fail: 'The asset was not created.' },
    editAsset: { kind: 'write', target: 'asset', risk: 'high', idempotent: false, retry: 'none',
      ok: 'Asset renamed.', fail: 'The asset was not renamed.' }
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

  // ---- GraphQL documents (live capture 2026-10-07; nothing else is sent) ---------------------
  var Q_LOCATIONS = 'query PagedLocations($page: PageInput!, $sortBy: [SortInput!], $search: String, $filters: [ColumnFilterInput!] = [], $clientTenantProfileId: ID!) { ' +
    'pagedLocations(page: $page, sortBy: $sortBy, search: $search, filters: $filters, clientTenantProfileId: $clientTenantProfileId) { rowCount items { id locationNumber name } } }';
  var Q_TRADES = 'query ListTrades($includeHidden: Boolean = false) { listTrades(includeHidden: $includeHidden) { id name } }';
  var Q_ASSET_TYPES = 'query AssetTypes($tenantId: ID!, $activeOnly: Boolean = true) { assetTypes(tenantId: $tenantId, activeOnly: $activeOnly) { id name } }';
  var Q_LOCATION_ASSETS = 'query ListLocationAssets($locationId: ID!, $isActive: Boolean, $page: PageInput!, $sortBy: [SortInput!]!, $search: String, $filter: [ColumnFilterInput!]) { ' +
    'listAssets(locationId: $locationId, isActive: $isActive, page: $page, sortBy: $sortBy, search: $search, filters: $filter) { rowCount items { id name serialNumber tagId } } }';
  var M_CREATE_ASSET = 'mutation CreateAsset($newAssetData: CreateAssetInput!) { createAsset(data: $newAssetData) { success message asset { id name } } }';
  // Captured 2026-10-08 from the Umbrava asset form's own save (EditAsset / AssetDetails). The read
  // selects exactly the 27 EditAssetInput keys (trade as an object; tradeId is trade.id).
  var Q_ASSET_DETAILS = 'query AssetDetails($assetId: ID!) { asset(assetId: $assetId) { id locationId name tagId isActive modelNumber usefulLife ' +
    'physicalLocation serialNumber manufacturer tagLocation replacementThreshold owner warrantyInstructions ' +
    'purchasePrice { amount currency precision } bookValue { amount currency precision } replacementCost { amount currency precision } ' +
    'maintenanceCost { amount currency precision } repairCost { amount currency precision } trade { id } assetTypeId ' +
    'orderDate installDate manufactureDate manufacturerWarrantyEnd materialWarrantyEnd laborWarrantyEnd } }';
  var M_EDIT_ASSET = 'mutation EditAsset($assetData: EditAssetInput!) { editAsset(data: $assetData) { success message asset { id name } } }';

  // Skip/take paging is only safe on a unique sort key. On Pilot every location's name is "Pilot
  // Travel Center", so a Name sort reordered between pages: the right rowCount, but 181 of 896
  // locations never came back (duplicates on some pages, gaps on others; 2026-10-08). Callers sort
  // by Id; this keeps one copy per id and refuses a list that still comes up short, so a paging
  // fault is a loud error instead of a false "Location not found".
  async function pageAll(what, take, fetchPage) {
    var byId = Object.create(null), items = [], skip = 0, rowCount = 0;
    do {
      var p = (await fetchPage(skip)) || {};
      var got = p.items || [];
      rowCount = p.rowCount || 0;
      got.forEach(function (x) { if (!byId[x.id]) { byId[x.id] = 1; items.push(x); } });
      skip += take;
      if (!got.length) break;
    } while (skip < rowCount);
    if (items.length !== rowCount) {
      throw new Error('Umbrava reported ' + rowCount + ' ' + what + ' but paging returned ' + items.length +
        ' distinct - the list may have changed mid-load. Run Validate again.');
    }
    return items;
  }

  var umbravaApi = {
    // The client's whole location list, loaded once per validation and matched locally. A per-row
    // server search is a contains-match: "PFJ 0123" pages through hundreds of loose hits (~10 s a
    // store on Pilot's 896), where this is ~5 requests for the whole file.
    listClientLocations: function (clientId, openOnly) {
      return pageAll('locations', LOCATION_PAGE, async function (skip) {
        var p = (await baGql(Q_LOCATIONS, {
          page: { skip: skip, take: LOCATION_PAGE },
          sortBy: [{ columnName: 'Id', direction: 'ASC' }],
          search: '',
          filters: openOnly ? [OPEN_ONLY_FILTER] : [],
          clientTenantProfileId: clientId
        })).pagedLocations || {};
        if (p.rowCount > LOCATION_LIST_CAP) throw new Error('This client has ' + p.rowCount + ' locations - more than this tool loads at once.');
        return p;
      });
    },
    listTrades: async function () {
      return (await baGql(Q_TRADES, { includeHidden: false })).listTrades || [];
    },
    listAssetTypes: async function (clientId) {
      return (await baGql(Q_ASSET_TYPES, { tenantId: clientId, activeOnly: true })).assetTypes || [];
    },
    listLocationAssets: function (locationId) {
      return pageAll('assets at this location', ASSET_PAGE, async function (skip) {
        return (await baGql(Q_LOCATION_ASSETS, {
          locationId: locationId, page: { skip: skip, take: ASSET_PAGE }, sortBy: { columnName: 'Id', direction: 'ASC' }
        })).listAssets;
      });
    },
    // The only write. bwnGqlOp owns the audit entry, the kill switch, the high-risk confirm
    // (the caller's confirm() is the confirmation) and the success:false rejection.
    createAsset: async function (input) {
      var d = await bwnGqlOp('createAsset', M_CREATE_ASSET, { newAssetData: input }, {
        feature: FEATURE, confirmed: true, ids: { locationId: input.locationId }
      });
      return d.createAsset;
    },
    getAsset: async function (assetId) {
      return (await baGql(Q_ASSET_DETAILS, { assetId: assetId })).asset || null;
    },
    // input = toEditInput(the record just read) with only the name changed.
    editAsset: async function (input) {
      var d = await bwnGqlOp('editAsset', M_EDIT_ASSET, { assetData: input }, {
        feature: FEATURE, confirmed: true, ids: { assetId: input.id, locationId: input.locationId }
      });
      return d.editAsset;
    }
  };

  // ---- File -> rows (pure) --------------------------------------------------------------------
  // Columns match by header alias, never by position. Aliases compare after normKey, so
  // "Location #", "location" and "LOCATION-#" are the same header.
  function normKey(v) { return String(v == null ? '' : v).toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function cellText(v) { return v == null ? '' : String(v).trim(); }

  var FIELDS = [
    { key: 'locationNumber', label: 'Location #', required: true, aliases: ['location', 'location number', 'location no', 'loc', 'loc number', 'store', 'store number', 'site', 'site number'] },
    { key: 'name', label: 'Asset Name', required: true, aliases: ['asset', 'name'] },
    { key: 'tagId', label: 'Tag ID', aliases: ['tag', 'tag number', 'asset tag'] },
    { key: 'manufacturer', label: 'Manufacturer', aliases: ['make', 'mfr'] },
    { key: 'modelNumber', label: 'Model', aliases: ['model number', 'model no'] },
    { key: 'serialNumber', label: 'Serial', aliases: ['serial number', 'serial no', 'sn', 's/n'] },
    { key: 'trade', label: 'Trade', aliases: [] },
    { key: 'assetType', label: 'Asset Type', aliases: ['type'] },
    { key: 'tagLocation', label: 'Tag Location', aliases: [] },
    { key: 'physicalLocation', label: 'Physical Location', aliases: [] },
    { key: 'manufactureDate', label: 'Manufacture Date', date: true, aliases: ['manufactured date', 'mfg date', 'date of manufacture'] },
    { key: 'orderDate', label: 'Order Date', date: true, aliases: [] },
    { key: 'installDate', label: 'Install Date', date: true, aliases: ['installation date', 'installed date'] },
    { key: 'manufacturerWarrantyEnd', label: 'Manufacturer Warranty End', date: true, aliases: ['mfr warranty end', 'manufacturer warranty'] },
    { key: 'materialWarrantyEnd', label: 'Material Warranty End', date: true, aliases: ['material warranty'] },
    { key: 'laborWarrantyEnd', label: 'Labor Warranty End', date: true, aliases: ['labour warranty end', 'labor warranty', 'labour warranty'] },
    // Rename mode: a "New Name" column switches the file from create to rename-by-Tag-ID.
    { key: 'newName', label: 'New Name', aliases: ['new asset name', 'rename to'] },
    { key: 'currentName', label: 'Current Name', aliases: ['current asset name', 'old name'] }
  ];
  var RENAME_REQUIRED = ['locationNumber', 'tagId', 'newName'];
  var ALIAS_TO_KEY = Object.create(null);
  FIELDS.forEach(function (f) { [f.label].concat(f.aliases).forEach(function (a) { ALIAS_TO_KEY[normKey(a)] = f.key; }); });

  function mapHeaders(headers) {
    var cols = {}, ignored = [], duplicate = [];
    headers.forEach(function (h, i) {
      var text = cellText(h);
      if (!text) return;
      var key = ALIAS_TO_KEY[normKey(text)];
      if (!key) ignored.push(text);
      else if (key in cols) duplicate.push(text);
      else cols[key] = i;
    });
    var mode = 'newName' in cols ? 'rename' : 'create';
    var missing = FIELDS.filter(function (f) {
      return (mode === 'rename' ? RENAME_REQUIRED.indexOf(f.key) !== -1 : f.required) && !(f.key in cols);
    }).map(function (f) { return f.label; });
    return { cols: cols, ignored: ignored, duplicate: duplicate, missing: missing, mode: mode };
  }

  // aoa: array of arrays, row 0 = headers. rowNum is the spreadsheet row number users see.
  function rowsFromAoa(aoa) {
    var mapping = mapHeaders(aoa[0] || []);
    var rows = [];
    for (var r = 1; r < aoa.length; r++) {
      var line = aoa[r] || [], raw = {}, any = false;
      Object.keys(mapping.cols).forEach(function (key) {
        var v = line[mapping.cols[key]];
        raw[key] = v == null ? '' : v;
        if (cellText(raw[key])) any = true;
      });
      if (any) rows.push({ rowNum: r + 1, raw: raw });
    }
    return { mapping: mapping, rows: rows };
  }

  function serialToYmd(n, date1904) {
    if (!isFinite(n) || n < 1 || n >= 2958466) return null;
    var d = new Date(Date.UTC(1899, 11, 30) + (Math.floor(n) + (date1904 ? 1462 : 0)) * 86400000);
    return [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
  }
  // -> { iso: string|null } or { bad: true }. Blank -> null. Excel serials, Date cells, MM/DD/YYYY
  // and ISO (time part ignored). Output is what the Umbrava UI sends: local midnight as ISO UTC.
  function parseDate(v, date1904) {
    var ymd = null, m;
    if (v instanceof Date) ymd = isNaN(v) ? null : [v.getFullYear(), v.getMonth() + 1, v.getDate()];
    else if (typeof v === 'number') ymd = serialToYmd(v, date1904);
    else {
      var s = cellText(v);
      if (!s) return { iso: null };
      if ((m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s))) ymd = [+m[3], +m[1], +m[2]];
      else if ((m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?)?$/.exec(s))) ymd = [+m[1], +m[2], +m[3]];
    }
    if (!ymd) return { bad: true };
    var dt = new Date(ymd[0], ymd[1] - 1, ymd[2]);
    if (ymd[0] < 1900 || ymd[0] > 2100 || dt.getFullYear() !== ymd[0] || dt.getMonth() !== ymd[1] - 1 || dt.getDate() !== ymd[2]) return { bad: true };
    return { iso: dt.toISOString() };
  }

  function templateAoa() {
    var example = {
      locationNumber: 'EXAMPLE-0001', name: 'EXAMPLE - delete this row', tagId: 'TAG-000123',
      manufacturer: 'Carrier', modelNumber: '48TC', serialNumber: '1234X56789', trade: 'HVAC',
      assetType: '', tagLocation: 'Roof', physicalLocation: 'Roof - north side',
      manufactureDate: '01/15/2020', orderDate: '02/01/2020', installDate: '03/10/2020',
      manufacturerWarrantyEnd: '03/10/2025', materialWarrantyEnd: '03/10/2023', laborWarrantyEnd: '03/10/2021'
    };
    var cols = FIELDS.filter(function (f) { return f.key in example; });   // the create template; rename columns stay out
    return [cols.map(function (f) { return f.label; }), cols.map(function (f) { return example[f.key]; })];
  }

  // ---- Validation (pure apart from the injected api; read-only) -------------------------------
  // Serial/tag values that mean "none": blank for duplicate/exists matching only, still sent as typed.
  var PLACEHOLDER_IDS = ['', 'na', 'none', 'null', 'unknown', 'unk', 'tbd', 'nan', 'notavailable'];
  function idKey(v) { var k = normKey(v); return PLACEHOLDER_IDS.indexOf(k) === -1 ? k : ''; }
  function stripZeros(d) { return d.replace(/^0+(?=\d)/, ''); }
  function nameKey(v) { return cellText(v).toLowerCase().replace(/\s+/g, ' '); }

  // Digits-only sheet value ("1", "0001"): equals the location number's digits as a number, never
  // endsWith ("1" is not "0011"). Anything else: equal after stripping punctuation/space/case.
  function locationMatches(sheetValue, locationNumber) {
    var s = cellText(sheetValue);
    if (/^\d+$/.test(s)) {
      var digits = String(locationNumber == null ? '' : locationNumber).replace(/\D/g, '');
      return digits !== '' && stripZeros(digits) === stripZeros(s);
    }
    var k = normKey(s);
    return k !== '' && normKey(locationNumber) === k;
  }

  // locations: the client's full list (api.listClientLocations). Pure.
  function resolveLocation(locations, sheetValue, openOnly) {
    var s = cellText(sheetValue);
    var seen = Object.create(null), hits = [];
    locations.forEach(function (l) { if (locationMatches(s, l.locationNumber) && !seen[l.id]) { seen[l.id] = 1; hits.push(l); } });
    if (hits.length === 1) return { location: hits[0] };
    if (hits.length > 1) {
      return { error: 'Ambiguous location: ' + hits.length + ' match "' + s + '" (' +
        hits.slice(0, 3).map(function (h) { return h.locationNumber; }).join(', ') + (hits.length > 3 ? ', ...' : '') + ')' };
    }
    return { error: 'Location "' + s + '" not found' + (openOnly ? ' among open locations' : '') };
  }

  function indexByName(list) {
    var m = Object.create(null);
    list.forEach(function (x) { var k = nameKey(x.name); (m[k] = m[k] || []).push(x.id); });
    return m;
  }
  function indexAssets(assets) {
    var idx = { serial: Object.create(null), tag: Object.create(null), name: Object.create(null) };
    assets.forEach(function (a) {
      var s = idKey(a.serialNumber), t = idKey(a.tagId), n = nameKey(a.name);
      if (s && !idx.serial[s]) idx.serial[s] = a;
      if (t && !idx.tag[t]) idx.tag[t] = a;
      if (n && !idx.name[n]) idx.name[n] = a;
    });
    return idx;
  }
  // One identity per row - serial, else tag, else name - drives both the in-file duplicate check
  // and the "already exists" check, so they never disagree. The name fallback is deliberate: a
  // token expiry forces a page refresh, which loses the in-memory created list, and without it a
  // row with no serial and no tag would be created twice on the re-run.
  function identity(raw) {
    var s = idKey(raw.serialNumber);
    if (s) return { kind: 'serial', key: s };
    var t = idKey(raw.tagId);
    if (t) return { kind: 'tag', key: t };
    return { kind: 'name', key: nameKey(raw.name) };
  }
  function lookupId(index, label, value, issues) {
    var text = cellText(value);
    if (!text) return null;
    var ids = index[nameKey(text)];
    if (!ids) { issues.push('Unknown ' + label + ' "' + text + '"'); return null; }
    if (ids.length > 1) { issues.push(label + ' "' + text + '" matches ' + ids.length + ' entries'); return null; }
    return ids[0];
  }

  // rows: [{ rowNum, raw, created?, assetId? }]. A row created earlier this session stays
  // "created" and is never re-sent (assetId can be '' if Umbrava returned none).
  async function validateRows(rows, o) {
    var api = o.api, clientId = o.clientId, openOnly = o.openOnly !== false, date1904 = !!o.date1904;
    var onProgress = o.onProgress || function () { };
    var pause = o.sleep || sleep;
    onProgress('Loading trades and asset types');
    var trades = rows.some(function (r) { return cellText(r.raw.trade); }) ? indexByName(await api.listTrades()) : Object.create(null);
    var types = rows.some(function (r) { return cellText(r.raw.assetType); }) ? indexByName(await api.listAssetTypes(clientId)) : Object.create(null);

    var locByText = Object.create(null);
    if (rows.some(function (r) { return cellText(r.raw.locationNumber); })) {
      onProgress('Loading client locations');
      var allLocs = await api.listClientLocations(clientId, openOnly);
      rows.forEach(function (r) {
        var t = cellText(r.raw.locationNumber);
        if (t && !locByText[t]) locByText[t] = resolveLocation(allLocs, t, openOnly);
      });
    }

    var locIds = [];
    Object.keys(locByText).forEach(function (k) { var l = locByText[k].location; if (l && locIds.indexOf(l.id) === -1) locIds.push(l.id); });
    var existing = Object.create(null);
    for (var j = 0; j < locIds.length; j++) {
      onProgress('Checking existing assets at location ' + (j + 1) + ' of ' + locIds.length);
      existing[locIds[j]] = indexAssets(await api.listLocationAssets(locIds[j]));
      await pause(READ_GAP_MS);
    }

    var seenKey = Object.create(null), seenName = Object.create(null);
    var out = rows.map(function (r) {
      var raw = r.raw, issues = [];
      function t(k) { return cellText(raw[k]) || null; }
      var locText = cellText(raw.locationNumber);
      if (!locText) issues.push('Missing Location #');
      if (!t('name')) issues.push('Missing Asset Name');
      var location = null;
      if (locText) { var lr = locByText[locText]; if (lr.error) issues.push(lr.error); else location = lr.location; }

      var dates = {};
      FIELDS.filter(function (f) { return f.date; }).forEach(function (f) {
        var d = parseDate(raw[f.key], date1904);
        if (d.bad) issues.push('Bad ' + f.label + ': "' + cellText(raw[f.key]) + '"');
        dates[f.key] = d.bad ? null : d.iso;
      });

      // CreateAssetInput exactly as the Umbrava UI sends it (capital-P PhysicalLocation). Blank -> null.
      var input = {
        name: t('name'),
        manufacturer: t('manufacturer'),
        manufactureDate: dates.manufactureDate,
        orderDate: dates.orderDate,
        installDate: dates.installDate,
        modelNumber: t('modelNumber'),
        serialNumber: t('serialNumber'),
        manufacturerWarrantyEnd: dates.manufacturerWarrantyEnd,
        materialWarrantyEnd: dates.materialWarrantyEnd,
        laborWarrantyEnd: dates.laborWarrantyEnd,
        locationId: location ? location.id : null,
        tagLocation: t('tagLocation'),
        assetTypeId: lookupId(types, 'Asset Type', raw.assetType, issues),
        PhysicalLocation: t('physicalLocation'),
        tradeId: lookupId(trades, 'Trade', raw.trade, issues),
        tagId: t('tagId')
      };

      FIELD_LIMITS.forEach(function (f) {
        var v = input[f[0]];
        if (v && v.length > f[2]) issues.push(f[1] + ' is ' + v.length + ' characters - Umbrava allows ' + f[2]);
      });

      var locKey = location ? location.id : 'sheet:' + normKey(locText);
      var id = identity(raw);
      if (id.key) {
        var dupKey = locKey + '|' + id.kind + ':' + id.key;
        if (seenKey[dupKey]) issues.push('Duplicate of row ' + seenKey[dupKey] + ' (same location and ' + id.kind + ')');
        else seenKey[dupKey] = r.rowNum;
      }
      // Umbrava refuses a second asset with the same name at one store ("Asset name [...] already in
      // use"), whatever the serial. A name-identity row is already covered by the duplicate check above.
      var nk = nameKey(raw.name);
      if (nk && id.kind !== 'name') {
        var nameDup = locKey + '|' + nk;
        if (seenName[nameDup]) issues.push('Asset Name also used by row ' + seenName[nameDup] + ' at this store - Umbrava needs a unique name per store');
        else seenName[nameDup] = r.rowNum;
      }

      var base = { rowNum: r.rowNum, raw: raw, location: location, input: input, issues: issues };
      if (r.created) return Object.assign(base, { status: 'created', assetId: r.assetId || '', note: 'Created earlier in this session' });
      if (issues.length) return Object.assign(base, { status: 'error' });
      var hit = location && id.key && existing[location.id][id.kind][id.key];
      if (hit) return Object.assign(base, { status: 'exists', note: 'Already at this location (' + id.kind + ' match: "' + hit.name + '")' });
      var taken = location && nk && existing[location.id].name[nk];
      if (taken) {
        issues.push('Asset Name is already used at this store by an existing asset (serial ' + (taken.serialNumber || 'none') + ') - Umbrava needs a unique name per store');
        return Object.assign(base, { status: 'error' });
      }
      return Object.assign(base, { status: 'ready' });
    });
    return { rows: out, clientId: clientId, openOnly: openOnly };
  }

  // ---- Rename by Tag ID (pure apart from the injected api; read-only) -------------------------
  // rows: [{ rowNum, raw, renamed? }]. Location # + Tag ID must find exactly one asset; a "Current
  // Name" column, when present, must still match Umbrava (the list may be stale); the new name must
  // be free at that store. A row renamed earlier this session stays "renamed" and is never re-sent.
  async function validateRenames(rows, o) {
    var api = o.api, clientId = o.clientId, openOnly = o.openOnly !== false;
    var onProgress = o.onProgress || function () { };
    var pause = o.sleep || sleep;
    onProgress('Loading client locations');
    var allLocs = await api.listClientLocations(clientId, openOnly);
    var locByText = Object.create(null), locIds = [];
    rows.forEach(function (r) {
      var t = cellText(r.raw.locationNumber);
      if (!t || locByText[t]) return;
      locByText[t] = resolveLocation(allLocs, t, openOnly);
      var l = locByText[t].location;
      if (l && locIds.indexOf(l.id) === -1) locIds.push(l.id);
    });
    var assetsAt = Object.create(null);
    for (var j = 0; j < locIds.length; j++) {
      onProgress('Reading assets at location ' + (j + 1) + ' of ' + locIds.length);
      assetsAt[locIds[j]] = await api.listLocationAssets(locIds[j]);
      await pause(READ_GAP_MS);
    }
    var seenAsset = Object.create(null), seenName = Object.create(null);
    var out = rows.map(function (r) {
      var raw = r.raw, issues = [];
      var locText = cellText(raw.locationNumber), tag = idKey(raw.tagId), newName = cellText(raw.newName), cur = cellText(raw.currentName);
      if (!locText) issues.push('Missing Location #');
      if (!tag) issues.push('Missing Tag ID');
      if (!newName) issues.push('Missing New Name');
      else if (newName.length > 100) issues.push('New Name is ' + newName.length + ' characters - Umbrava allows 100');
      var location = null, asset = null;
      if (locText) { var lr = locByText[locText]; if (lr.error) issues.push(lr.error); else location = lr.location; }
      if (location && tag) {
        var hits = assetsAt[location.id].filter(function (a) { return idKey(a.tagId) === tag; });
        if (!hits.length) issues.push('No asset with Tag ID "' + cellText(raw.tagId) + '" at this store');
        else if (hits.length > 1) issues.push(hits.length + ' assets share Tag ID "' + cellText(raw.tagId) + '" at this store - rename them by hand');
        else asset = hits[0];
      }
      if (asset && newName) {
        var nk = nameKey(newName);
        if (seenAsset[asset.id]) issues.push('Same asset as row ' + seenAsset[asset.id]);
        else seenAsset[asset.id] = r.rowNum;
        if (cur && nameKey(cur) !== nameKey(asset.name) && nameKey(asset.name) !== nk) {
          issues.push('Name in Umbrava is now "' + asset.name + '", not "' + cur + '" - check the list');
        }
        var other = assetsAt[location.id].filter(function (a) { return a.id !== asset.id && nameKey(a.name) === nk; })[0];
        if (other) issues.push('New Name is already used at this store by another asset (Tag ID ' + (other.tagId || 'none') + ')');
        var nd = location.id + '|' + nk;
        if (seenName[nd]) issues.push('New Name also used by row ' + seenName[nd] + ' at this store');
        else seenName[nd] = r.rowNum;
      }
      var base = { rowNum: r.rowNum, raw: raw, location: location, issues: issues,
        assetId: asset ? asset.id : '', currentName: asset ? cellText(asset.name) : '', newName: newName };
      if (r.renamed) return Object.assign(base, { status: 'renamed', note: 'Renamed earlier in this session' });
      if (issues.length) return Object.assign(base, { status: 'error' });
      if (base.currentName === newName) return Object.assign(base, { status: 'exists', note: 'Already named "' + newName + '"' });
      return Object.assign(base, { status: 'ready', note: '"' + base.currentName + '" -> "' + newName + '"' });
    });
    return { rows: out, clientId: clientId, openOnly: openOnly, mode: 'rename' };
  }

  // EditAssetInput is a full replace: every key, taken from the record just read (AssetDetails).
  var EDIT_KEYS = ['id', 'locationId', 'name', 'tagId', 'isActive', 'modelNumber', 'usefulLife', 'physicalLocation', 'serialNumber',
    'manufacturer', 'tagLocation', 'replacementThreshold', 'owner', 'warrantyInstructions', 'purchasePrice', 'bookValue',
    'replacementCost', 'maintenanceCost', 'repairCost', 'tradeId', 'assetTypeId', 'orderDate', 'installDate', 'manufactureDate',
    'manufacturerWarrantyEnd', 'materialWarrantyEnd', 'laborWarrantyEnd'];
  var MONEY_KEYS = ['purchasePrice', 'bookValue', 'replacementCost', 'maintenanceCost', 'repairCost'];
  var DATE_KEYS = ['orderDate', 'installDate', 'manufactureDate', 'manufacturerWarrantyEnd', 'materialWarrantyEnd', 'laborWarrantyEnd'];
  function toEditInput(a) {
    var o = {};
    EDIT_KEYS.forEach(function (k) {
      var v = k === 'tradeId' ? (a.trade ? a.trade.id : null) : a[k];
      if (v === undefined) v = null;
      if (MONEY_KEYS.indexOf(k) !== -1 && v) v = { amount: v.amount, currency: v.currency, precision: v.precision };
      o[k] = v;
    });
    return o;
  }
  // Keys that moved between the read before and the read after a rename, other than the expected
  // name. Umbrava's own form save turns an empty money field into $0 and a 04:00 time into midnight
  // of the same day, so those compare by amount and by calendar day; anything else is real drift.
  function editDrift(before, after, newName) {
    var b = toEditInput(before), a = toEditInput(after), out = [];
    EDIT_KEYS.forEach(function (k) {
      if (k === 'name') { if (cellText(a.name) !== newName) out.push('name'); return; }
      var x = b[k], y = a[k], same;
      if (MONEY_KEYS.indexOf(k) !== -1) same = (x ? x.amount : 0) === (y ? y.amount : 0);
      else if (DATE_KEYS.indexOf(k) !== -1) same = String(x || '').slice(0, 10) === String(y || '').slice(0, 10);
      else same = JSON.stringify(x) === JSON.stringify(y);
      if (!same) out.push(k);
    });
    return out;
  }

  // One rename: read the whole asset, send it back with only the name changed, read it again.
  // -> null when only the name moved, else the list of other keys that changed (the run halts).
  async function renameRow(r, api) {
    var before = await api.getAsset(r.assetId);
    if (!before || cellText(before.name) !== r.currentName) {
      throw new Error('Name changed since Validate (now "' + (before ? before.name : 'asset missing') + '") - not renamed; Validate again');
    }
    var input = toEditInput(before);
    input.name = r.newName;
    await api.editAsset(input);
    var after;
    try { after = await api.getAsset(r.assetId); } catch (e) { return ['(could not re-read the asset: ' + e.message + ')']; }
    var d = editDrift(before, after || {}, r.newName);
    return d.length ? d : null;
  }

  function summarize(rows) {
    var c = { ready: 0, exists: 0, error: 0, created: 0, renamed: 0, failed: 0, unknown: 0 };
    rows.forEach(function (r) { c[r.status] = (c[r.status] || 0) + 1; });
    return c;
  }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clientIdFromPath(pathname) {
    var m = /^\/clients\/([^/?#]+)/.exec(pathname);
    return m ? decodeURIComponent(m[1]) : null;
  }

  // Test hook for offline checks (Tampermonkey has no `module`, so this never fires in the browser).
  if (typeof module === 'object' && module && module.exports) {
    module.exports = { FIELDS: FIELDS, mapHeaders: mapHeaders, rowsFromAoa: rowsFromAoa, parseDate: parseDate,
      templateAoa: templateAoa, locationMatches: locationMatches, resolveLocation: resolveLocation, validateRows: validateRows,
      validateRenames: validateRenames, toEditInput: toEditInput, editDrift: editDrift, EDIT_KEYS: EDIT_KEYS, renameRow: renameRow,
      summarize: summarize, gqlErrText: gqlErrText, clientIdFromPath: clientIdFromPath, tokenExpiresSoon: tokenExpiresSoon,
      baGql: baGql, umbravaApi: umbravaApi, BWN_OPS: BWN_OPS, BWN_MODULES: BWN_MODULES };
    return;
  }

  // ---- UI: a drawer in the suite's shared slot ------------------------------------------------
  // Core's stylesheet owns .bwn-drawer / -hd / -body / -ft and the rail geometry; this sheet only
  // widens the panel and styles the content. .bwnba-solo is the no-Core fallback shell. Brand
  // tokens fall back to the house values when Core's variables are absent.
  var CSS = [
    '.bwn-drawer.bwnba{width:1100px}',
    '.bwnba{--ba-green:var(--bwn-green,#1a5f3e);--ba-green-dk:var(--bwn-green-dk,#0d3d26);--ba-accent:var(--bwn-accent,#2ECC71);',
    'color:#1e293b;font:400 14px/1.45 "DM Sans",-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif}',
    '.bwnba [hidden]{display:none!important}',
    '.bwnba *{box-sizing:border-box}',
    '.bwnba .bwn-drawer-body{background:#f0f4f8;display:flex;flex-direction:column;gap:12px}',
    '.bwnba .ba-mono,.bwnba td.ba-num{font-family:"DM Mono",ui-monospace,"Segoe UI Mono",Consolas,monospace}',
    '.bwnba .ba-row{display:flex;flex-wrap:wrap;align-items:center;gap:10px}',
    '.bwnba .ba-btn{display:inline-flex;align-items:center;gap:6px;padding:8px 15px;border-radius:8px;border:1px solid #e2e8f0;background:#fff;color:var(--ba-green);',
    'font:600 13px "DM Sans",-apple-system,"Segoe UI",Arial,sans-serif;cursor:pointer}',
    '.bwnba .ba-btn.primary{border:0;color:#fff;background:linear-gradient(135deg,var(--ba-green),var(--ba-green-dk))}',
    '.bwnba .ba-btn.danger{border-color:#e74c3c;color:#b03a2e}',
    '.bwnba .ba-btn:disabled{opacity:.45;cursor:not-allowed}',
    '.bwnba .ba-btn:focus-visible,.bwnba .ba-file:focus-within,.bwnba input:focus-visible{outline:2px solid var(--ba-accent);outline-offset:2px}',
    '.bwnba .ba-file{position:relative}',
    '.bwnba .ba-file input{position:absolute;width:1px;height:1px;opacity:0}',
    '.bwnba .ba-file.off{opacity:.45;pointer-events:none}',
    '.bwnba .ba-chk{display:inline-flex;align-items:center;gap:6px;font-size:13px;color:#64748b}',
    '.bwnba .ba-chk input{accent-color:var(--ba-green)}',
    '.bwnba .ba-note{padding:10px 12px;border-radius:9px;background:#fff;border-left:4px solid var(--ba-accent)}',
    '.bwnba .ba-note.warn{border-left-color:#f39c12;background:#fff8ec}',
    '.bwnba .ba-note.error{border-left-color:#e74c3c;background:#fdecea}',
    '.bwnba .ba-card{background:#fff;border:1px solid #e2e8f0;border-radius:9px;padding:10px 12px;font-size:13px}',
    '.bwnba .ba-chips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}',
    '.bwnba .ba-chip{padding:2px 9px;border-radius:999px;background:#d1f0e6;color:#1a5f3e;font:500 12px "DM Mono",ui-monospace,Consolas,monospace}',
    '.bwnba .ba-chip.off{background:#eef2f6;color:#64748b}',
    '.bwnba .ba-prog{display:flex;align-items:center;gap:10px;font-size:12px;color:#64748b}',
    '.bwnba progress{width:260px;height:10px;accent-color:var(--ba-accent)}',
    '.bwnba .ba-tablewrap{background:#fff;border:1px solid #e2e8f0;border-radius:9px;overflow:auto;max-height:48vh}',
    '.bwnba table{border-collapse:collapse;width:100%;font-size:12.5px}',
    '.bwnba th,.bwnba td{text-align:left;padding:6px 8px;border-bottom:1px solid #e2e8f0;vertical-align:top}',
    '.bwnba th{position:sticky;top:0;z-index:1;background:var(--ba-green);color:#fff;font-weight:600}',
    '.bwnba td.ba-issues{color:#64748b;min-width:220px}',
    '.bwnba .ba-st{display:inline-block;padding:1px 9px;border-radius:999px;font:600 11.5px "DM Mono",ui-monospace,Consolas,monospace;white-space:nowrap}',
    '.bwnba .ba-st.pending{background:#eef2f6;color:#64748b}',
    '.bwnba .ba-st.ready{background:#d1f0e6;color:#1a5f3e}',
    '.bwnba .ba-st.exists{background:#e3f0fb;color:#1d5f8f}',
    '.bwnba .ba-st.error,.bwnba .ba-st.failed{background:#fdecea;color:#b03a2e}',
    '.bwnba .ba-st.created,.bwnba .ba-st.renamed{background:#1a5f3e;color:#fff}',
    '.bwnba .ba-st.unknown{background:#fff4e0;color:#8a5a00}',
    '.bwnba details{font-size:12.5px;color:#64748b}',
    '.bwnba .ba-log{margin:6px 0 0;padding-left:20px;max-height:150px;overflow:auto;font:400 12px "DM Mono",ui-monospace,Consolas,monospace}',
    // No-Core fallback shell (Core's .bwn-drawer rules absent).
    '.bwnba.bwnba-solo{position:fixed;top:0;bottom:0;left:0;z-index:99997;width:1100px;max-width:100vw;display:flex;flex-direction:column;',
    'background:#fff;border-radius:0 14px 14px 0;box-shadow:10px 0 34px rgba(0,0,0,.2)}',
    '.bwnba-solo .bwn-drawer-hd{display:flex;align-items:flex-start;gap:10px;padding:15px 16px 14px 18px;color:#fff;',
    'background:linear-gradient(135deg,var(--ba-green),var(--ba-green-dk));border-bottom:3px solid var(--ba-accent)}',
    '.bwnba-solo .bwn-drawer-hd>div:first-child{flex:1}',
    '.bwnba-solo .bwn-drawer-hd .t{font-weight:600;font-size:15px}',
    '.bwnba-solo .bwn-drawer-hd .s{font:500 11px "DM Mono",ui-monospace,Consolas,monospace;color:rgba(255,255,255,.72);margin-top:3px}',
    '.bwnba-solo .bwn-drawer-x{width:26px;height:26px;border:0;border-radius:7px;background:rgba(255,255,255,.14);color:#fff;font-size:17px;cursor:pointer}',
    '.bwnba-solo .bwn-drawer-body{flex:1;overflow:auto;padding:14px 18px}',
    '.bwnba-solo .bwn-drawer-ft{display:flex;gap:8px;justify-content:flex-end;padding:12px 18px;border-top:1px solid #e2e8f0}',
    '#bwnba-launch{position:fixed;right:24px;bottom:24px;z-index:2147483000;font:600 13px "DM Sans",system-ui,sans-serif;color:#fff;border:0;',
    'background:linear-gradient(135deg,#1a5f3e,#0d3d26);border-radius:22px;padding:10px 16px;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer}',
    '#bwnba-launch[hidden]{display:none!important}',
    '#bwnba-launch:focus-visible{outline:3px solid #2ECC71;outline-offset:2px}'
  ].join('');

  var STATUS_LABEL = { pending: 'not validated', ready: 'ready', exists: 'exists', error: 'error', created: 'created', renamed: 'renamed', failed: 'failed', unknown: 'unknown' };
  function isRename() { return !!state.file && state.file.mode === 'rename'; }

  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) {
      if (attrs[k] == null || attrs[k] === false) return;
      if (k === 'text') el.textContent = attrs[k];
      else if (k === 'class') el.className = attrs[k];
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] === true) el.setAttribute(k, '');
      else el.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return el;
  }
  function plural(n, w) { return n + ' ' + w + (n === 1 ? '' : 's'); }

  var state = {
    clientId: clientIdFromPath(location.pathname),
    file: null,          // { sheetName, date1904, mapping, mappedLabels, rows }
    validated: null,     // { rows, clientId, openOnly }
    openOnly: true,
    busy: false, running: false, stopRequested: false, needsRevalidate: false,
    notice: null,        // { text, kind }
    progress: null,      // { text, done, total }
    log: []
  };
  var ui = null;         // the open drawer's nodes, or null
  var dockHostSeen = false;
  var dockWaited = false;  // the fallback button only shows once a host has had DOCK_WAIT_MS to answer
  var dockOn = false;
  var launchBtn = null;

  // Canonical drawer exit (SHA-pinned by scripts/test-drawerdismiss-ledger.js).
  function drawerDismiss(el) {
    var reduce = false;
    try { reduce = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { }
    if (reduce) { el.remove(); return; }
    el.removeAttribute('id'); el.setAttribute('aria-hidden', 'true');   // id freed now: a reopen builds a fresh node
    el.classList.add('bwn-closing');
    setTimeout(function () { try { el.remove(); } catch (e) { } }, 170);
  }

  function bus(detail) {
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: detail })); } catch (e) { /* no bus */ }
  }
  function dockSync() {
    var want = !!state.clientId;
    if (want) bus({ id: 'bwn:dock:register', key: DOCK_KEY, label: 'Bulk Assets', icon: '📤', weight: 45,
      title: "Create assets across this client's locations from a CSV / XLSX" });
    else if (dockOn) bus({ id: 'bwn:dock:unregister', key: DOCK_KEY });
    dockOn = want;
    if (launchBtn) launchBtn.hidden = dockHostSeen || !dockWaited || !want;
  }

  function logLine(text) {
    state.log.push(new Date().toLocaleTimeString() + '  ' + text);
    if (ui) ui.log.appendChild(h('li', { text: state.log[state.log.length - 1] }));
  }
  function setNotice(text, kind) { state.notice = text ? { text: text, kind: kind || 'info' } : null; render(); }
  function setProgress(text, done, total) { state.progress = text == null ? null : { text: text, done: done, total: total }; render(); }

  function openDrawer() {
    if (ui) { ui.closeBtn.focus(); return; }
    bus({ id: 'bwn:drawer:open', key: DOCK_KEY });
    var opener = document.activeElement;
    var aside = h('aside', { id: 'bwn-drawer-' + DOCK_KEY, role: 'dialog', 'aria-label': 'Bulk Asset Uploader' });
    aside.className = 'bwn-drawer';
    aside.classList.add('bwnba');
    if (!dockHostSeen) aside.classList.add('bwnba-solo');
    var n = { aside: aside, opener: opener };
    n.closeBtn = h('button', { type: 'button', class: 'bwn-drawer-x', 'aria-label': 'Close', title: 'Close', text: '×', onclick: closeDrawer });
    n.sub = h('div', { class: 's' });
    n.fileInput = h('input', { type: 'file', accept: '.csv,.xlsx,.xls', onchange: function () {
      var f = n.fileInput.files && n.fileInput.files[0];
      n.fileInput.value = '';                         // the same file can be chosen again
      if (f) onFile(f);
    } });
    n.fileLabel = h('label', { class: 'ba-btn ba-file' }, ['Choose CSV / XLSX', n.fileInput]);
    n.openOnly = h('input', { type: 'checkbox', onchange: onOpenOnlyChange });
    n.openOnly.checked = state.openOnly;
    n.notice = h('div', { class: 'ba-note', role: 'status' });
    n.mapping = h('div', { class: 'ba-card' });
    n.progText = h('span', { class: 'ba-mono' });
    n.prog = h('progress', { max: '1' });
    n.progRow = h('div', { class: 'ba-prog' }, [n.prog, n.progText]);
    n.summary = h('div', { class: 'ba-chips' });
    n.tbody = h('tbody');
    n.tableWrap = h('div', { class: 'ba-tablewrap' }, [h('table', {}, [
      h('thead', {}, [h('tr', {}, ['Row', 'Status', 'Sheet location', 'Resolved location', 'Asset name', 'Serial', 'Tag ID', 'Trade', 'Issues / note']
        .map(function (c) { return h('th', { scope: 'col', text: c }); }))]),
      n.tbody])]);
    n.log = h('ol', { class: 'ba-log' }, state.log.map(function (l) { return h('li', { text: l }); }));
    n.validateBtn = h('button', { type: 'button', class: 'ba-btn', text: 'Validate (read-only)', onclick: onValidate });
    n.runBtn = h('button', { type: 'button', class: 'ba-btn primary', onclick: onRun });
    n.stopBtn = h('button', { type: 'button', class: 'ba-btn danger', text: 'Stop after current row', onclick: onStop });
    n.resultsBtn = h('button', { type: 'button', class: 'ba-btn', text: 'Download results', onclick: onResults });
    n.trByRow = Object.create(null);

    aside.appendChild(h('div', { class: 'bwn-drawer-hd' }, [h('div', {}, [h('div', { class: 't', text: 'Bulk Asset Uploader' }), n.sub]), n.closeBtn]));
    aside.appendChild(h('div', { class: 'bwn-drawer-body' }, [
      n.notice,
      h('div', { class: 'ba-row' }, [n.fileLabel,
        h('button', { type: 'button', class: 'ba-btn', text: 'Download template', onclick: onTemplate }),
        h('label', { class: 'ba-chk' }, [n.openOnly, 'Open locations only'])]),
      n.mapping, n.progRow, n.summary, n.tableWrap,
      h('details', {}, [h('summary', { text: 'Activity log' }), n.log])
    ]));
    aside.appendChild(h('div', { class: 'bwn-drawer-ft' }, [n.resultsBtn, n.stopBtn, n.validateBtn, n.runBtn]));
    aside.addEventListener('keydown', function (e) { if (e.key === 'Escape') { e.stopPropagation(); closeDrawer(); } });
    document.body.appendChild(aside);
    ui = n;
    renderMapping();
    renderTable();
    render();
    n.closeBtn.focus();
  }

  function closeDrawer() {
    if (!ui) return;
    var n = ui;
    ui = null;
    drawerDismiss(n.aside);
    try { if (n.opener && n.opener.focus && n.opener.isConnected) n.opener.focus(); } catch (e) { }
  }

  function shownRows() { return state.validated ? state.validated.rows : state.file ? state.file.rows : []; }
  function clientMismatch() { return !!state.validated && state.validated.clientId !== state.clientId; }

  function render() {
    if (!ui) return;
    var v = state.validated;
    var readyCount = v ? v.rows.filter(function (r) { return r.status === 'ready'; }).length : 0;
    var idle = !state.busy && !state.running;
    ui.sub.textContent = state.clientId ? 'Client ' + state.clientId + ' · CSV / XLSX → Umbrava assets' : 'Open a client page to use this tool';
    var nt = state.notice;
    if (!state.clientId) nt = { text: 'Open a client page (/clients/...) to use this tool. Validate and Create are disabled here.', kind: 'warn' };
    else if (clientMismatch() && !state.running) nt = { text: 'You are on a different client than the one this file was validated for. Validate again before creating.', kind: 'warn' };
    ui.notice.hidden = !nt;
    if (nt) { ui.notice.className = 'ba-note' + (nt.kind === 'info' ? '' : ' ' + nt.kind); ui.notice.textContent = nt.text; }
    ui.fileLabel.classList.toggle('off', !idle);
    ui.fileInput.disabled = !idle;
    ui.openOnly.disabled = !idle;
    ui.validateBtn.disabled = !(idle && state.clientId && state.file);
    ui.runBtn.disabled = !(idle && v && readyCount > 0 && !state.needsRevalidate && !clientMismatch() && state.clientId);
    ui.runBtn.textContent = (isRename() ? 'Rename ' : 'Create ') + plural(readyCount, 'asset');
    ui.stopBtn.hidden = !state.running;
    ui.stopBtn.disabled = state.stopRequested;
    ui.resultsBtn.disabled = state.busy || !v;
    ui.progRow.hidden = !state.progress;
    if (state.progress) {
      ui.progText.textContent = state.progress.text;
      if (state.progress.total) { ui.prog.max = state.progress.total; ui.prog.value = state.progress.done; }
      else ui.prog.removeAttribute('value');           // indeterminate
    }
    var c = v ? summarize(v.rows) : {};
    ui.summary.replaceChildren.apply(ui.summary, Object.keys(c).filter(function (k) { return c[k]; }).map(function (k) {
      return h('span', { class: 'ba-st ' + k, text: c[k] + ' ' + (STATUS_LABEL[k] || k) });
    }));
  }

  function renderMapping() {
    if (!ui) return;
    var f = state.file;
    ui.mapping.hidden = !f;
    if (!f) return;
    ui.mapping.replaceChildren(
      h('div', {}, [h('b', { text: plural(f.rows.length, 'row') }), ' from sheet "' + f.sheetName + '". ',
        h('b', { text: f.mode === 'rename' ? 'Mode: rename by Tag ID.' : 'Mode: create.' }), ' Mapped columns:']),
      h('div', { class: 'ba-chips' }, f.mappedLabels.map(function (l) { return h('span', { class: 'ba-chip', text: l }); })
        .concat(f.mapping.ignored.map(function (l) { return h('span', { class: 'ba-chip off', text: 'ignored: ' + l }); }))));
  }

  function fillRow(tr, r) {
    var loc = r.location ? r.location.locationNumber + ' - ' + (r.location.name || '') : '';
    var note = (r.issues || []).concat(r.note ? [r.note] : []).join('; ');
    var status = r.status || 'pending';
    var name = isRename() ? cellText(r.raw.newName) : cellText(r.raw.name);
    var cells = [String(r.rowNum), null, cellText(r.raw.locationNumber), loc, name, cellText(r.raw.serialNumber), cellText(r.raw.tagId), cellText(r.raw.trade), note];
    tr.replaceChildren.apply(tr, cells.map(function (c, i) {
      if (i === 1) return h('td', {}, [h('span', { class: 'ba-st ' + status, text: STATUS_LABEL[status] || status })]);
      return h('td', { class: i === 0 ? 'ba-num' : i === 8 ? 'ba-issues' : null, text: c });
    }));
  }
  function renderTable() {
    if (!ui) return;
    var rows = shownRows();
    ui.tableWrap.hidden = !rows.length;
    ui.trByRow = Object.create(null);
    ui.tbody.replaceChildren.apply(ui.tbody, rows.map(function (r) {
      var tr = h('tr');
      fillRow(tr, r);
      ui.trByRow[r.rowNum] = tr;
      return tr;
    }));
  }
  function updateRow(r) { if (ui && ui.trByRow[r.rowNum]) fillRow(ui.trByRow[r.rowNum], r); }

  // ---- Actions --------------------------------------------------------------------------------
  async function onFile(file) {
    if (state.busy || state.running) return;
    state.busy = true; render();
    try {
      if (typeof XLSX === 'undefined') throw new Error('The spreadsheet library did not load. Reload the page and try again.');
      // CSV as decoded text so UTF-8 survives; workbooks as bytes. raw:true keeps CSV cells as
      // typed text ("0001" stays "0001", dates stay strings for parseDate).
      var isCsv = /\.csv$/i.test(file.name);
      var wb = XLSX.read(isCsv ? await file.text() : await file.arrayBuffer(), { type: isCsv ? 'string' : 'array', raw: true });
      var ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error('The file has no sheets.');
      var parsed = rowsFromAoa(XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, defval: '' }));
      var mp = parsed.mapping;
      if (mp.missing.length || mp.duplicate.length) {
        throw new Error("Can't use this file - " + [
          mp.missing.length ? 'missing required column(s): ' + mp.missing.join(', ') : '',
          mp.duplicate.length ? 'more than one column maps to the same field: ' + mp.duplicate.join(', ') : ''
        ].filter(Boolean).join('; ') + '. Download the template for the expected headers.');
      }
      if (!parsed.rows.length) throw new Error('The first sheet has headers but no data rows.');
      state.file = {
        mode: mp.mode,
        sheetName: wb.SheetNames[0],
        date1904: !!(wb.Workbook && wb.Workbook.WBProps && wb.Workbook.WBProps.date1904),
        mapping: mp,
        mappedLabels: FIELDS.filter(function (f) { return f.key in mp.cols; }).map(function (f) { return f.label; }),
        rows: parsed.rows.map(function (r) { return { rowNum: r.rowNum, raw: r.raw, status: 'pending' }; })
      };
      state.validated = null;
      state.needsRevalidate = false;
      state.notice = { text: 'File loaded. Validate checks every row against Umbrava without writing anything.', kind: 'info' };
      logLine('File loaded: ' + plural(parsed.rows.length, 'row') + (mp.mode === 'rename' ? ' (rename by Tag ID)' : ''));
      renderMapping();
      renderTable();
    } catch (e) {
      state.notice = { text: e.message, kind: 'error' };
      logLine('File load failed');
    } finally {
      state.busy = false; render();
    }
  }

  function onTemplate() {
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(templateAoa()), 'Assets');
    XLSX.writeFile(wb, 'bwn-bulk-assets-template.xlsx');
  }

  function onOpenOnlyChange() {
    state.openOnly = ui.openOnly.checked;
    if (!state.validated) return;
    state.needsRevalidate = true;
    setNotice('Location filter changed - Validate again before creating.', 'warn');
  }

  async function onValidate() {
    if (!state.clientId || !state.file || state.busy || state.running) return;
    state.busy = true; state.notice = null; render();
    // Rows created earlier this session are carried over so they are never re-sent.
    var prior = Object.create(null);
    (state.validated ? state.validated.rows : []).forEach(function (r) { if (r.status === 'created' || r.status === 'renamed') prior[r.rowNum] = r.assetId || ''; });
    var rename = isRename();
    var rows = state.file.rows.map(function (r) {
      var done = r.rowNum in prior;
      return { rowNum: r.rowNum, raw: r.raw, created: !rename && done, renamed: rename && done, assetId: prior[r.rowNum] };
    });
    try {
      logLine('Validate started');
      state.validated = await (rename ? validateRenames : validateRows)(rows, {
        api: umbravaApi, clientId: state.clientId, openOnly: state.openOnly, date1904: state.file.date1904,
        onProgress: function (t) { setProgress(t); }
      });
      state.needsRevalidate = false;
      var c = summarize(state.validated.rows);
      var locs = [];
      state.validated.rows.forEach(function (r) { if (r.location && locs.indexOf(r.location.id) === -1) locs.push(r.location.id); });
      var verb = rename ? 'rename' : 'create';
      logLine('Validated: ' + c.ready + ' ready, ' + c.exists + (rename ? ' already named' : ' exists') + ', ' + c.error + ' errors, ' +
        (rename ? c.renamed + ' renamed' : c.created + ' created') + ' earlier; ' + plural(locs.length, 'location'));
      state.notice = c.ready
        ? { text: plural(c.ready, 'row') + ' ready to ' + verb + '. Rows marked error or exists will be skipped.', kind: c.error ? 'warn' : 'info' }
        : { text: 'Nothing to ' + verb + ' - every row is an error, already done, or was done earlier this session.', kind: c.error ? 'warn' : 'info' };
      renderTable();
    } catch (e) {
      state.notice = { text: 'Validation stopped: ' + e.message, kind: 'error' };
      logLine('Validate failed' + (e.baHalt ? ' (' + e.baHalt + ')' : ''));
    } finally {
      state.busy = false; state.progress = null; render();
    }
  }

  async function onRun() {
    var v = state.validated;
    if (!v || state.running || state.busy || state.needsRevalidate) return;
    if (clientIdFromPath(location.pathname) !== v.clientId) { onRoute(); return; }
    var todo = v.rows.filter(function (r) { return r.status === 'ready'; });
    if (!todo.length) return;
    var rename = v.mode === 'rename', Verb = rename ? 'Rename' : 'Create';
    var locs = [];
    todo.forEach(function (r) { if (locs.indexOf(r.location.id) === -1) locs.push(r.location.id); });
    var ok = window.confirm(Verb + ' ' + plural(todo.length, 'asset') + ' across ' + plural(locs.length, 'location') + ' in Umbrava?\n\nClient: ' + v.clientId +
      '\n\nThis writes to Umbrava. Rows are ' + (rename ? 'renamed' : 'created') + ' one at a time; Stop finishes the current row first. Keep this tab open until the run ends.');
    if (!ok) { logLine(Verb + ' cancelled at confirm'); return; }

    state.running = true; state.stopRequested = false; state.notice = null; render();
    logLine(Verb + ' started: ' + plural(todo.length, 'row') + ', ' + plural(locs.length, 'location'));
    var done = 0;
    for (var i = 0; i < todo.length; i++) {
      if (state.stopRequested) break;
      var r = todo[i];
      setProgress((rename ? 'Renaming ' : 'Creating ') + (done + 1) + ' of ' + todo.length + ' (row ' + r.rowNum + ')', done, todo.length);
      try {
        if (rename) {
          var drift = await renameRow(r, umbravaApi);
          if (drift) {
            r.status = 'failed';
            r.note = 'Renamed, but Umbrava also changed: ' + drift.join(', ') + ' - check this asset';
            updateRow(r);
            state.notice = { text: 'Run halted at row ' + r.rowNum + ': fields other than the name changed. Check that asset before resuming.', kind: 'error' };
            logLine('Run halted at row ' + r.rowNum + ' (unexpected change)');
            break;
          }
          r.status = 'renamed';
          r.note = '"' + r.currentName + '" -> "' + r.newName + '"';
          logLine('Row ' + r.rowNum + ': renamed');
        } else {
          var res = await umbravaApi.createAsset(r.input);
          r.status = 'created';
          r.assetId = (res && res.asset && res.asset.id) || '';
          r.note = r.assetId ? '' : 'Created, but Umbrava returned no asset id';
          logLine('Row ' + r.rowNum + ': created');
        }
      } catch (e) {
        if (e.baHalt) {
          if (e.baHalt === 'network') {
            r.status = 'unknown';
            r.note = 'Request failed mid-flight - may or may not have been created';
            state.needsRevalidate = true;
          }
          updateRow(r);
          state.notice = { text: 'Run halted at row ' + r.rowNum + ': ' + e.message, kind: 'error' };
          logLine('Run halted at row ' + r.rowNum + ' (' + e.baHalt + ')');
          break;
        }
        if (/feature "bulkAssets" is disabled/.test(e.message)) {
          state.notice = { text: 'Bulk Assets writes are switched off (Suite settings or the central kill switch). Nothing more was sent.', kind: 'error' };
          logLine('Run halted at row ' + r.rowNum + ' (disabled)');
          break;
        }
        r.status = 'failed';                            // success:false or a GraphQL error: this row only
        r.note = e.message;
        logLine('Row ' + r.rowNum + ': failed');
      }
      updateRow(r);
      done++;
      render();
      if (done < todo.length && !state.stopRequested) await sleep(CREATE_GAP_MS);
    }
    var c = summarize(v.rows);
    if (state.stopRequested) {
      state.notice = { text: 'Stopped. ' + plural(c.ready, 'row') + ' still ready - press ' + Verb + ' to resume.', kind: 'warn' };
      logLine('Stopped after ' + plural(done, 'row'));
    }
    logLine(Verb + ' finished: ' + (rename ? c.renamed + ' renamed' : c.created + ' created') + ', ' + c.failed + ' failed' + (c.unknown ? ', ' + c.unknown + ' unknown' : ''));
    state.running = false; state.stopRequested = false; state.progress = null; render();
  }

  function onStop() { state.stopRequested = true; logLine('Stop requested'); render(); }

  function onResults() {
    var rename = isRename();
    var header = ['Row', 'Status', 'Location', 'Location Name', rename ? 'New Name' : 'Asset Name', rename ? 'Tag ID' : 'Serial', 'Asset ID', 'Error / Note'];
    var lines = shownRows().map(function (r) {
      return [r.rowNum, r.status === 'pending' ? 'not validated' : r.status,
        r.location ? r.location.locationNumber : cellText(r.raw.locationNumber), r.location ? r.location.name || '' : '',
        cellText(rename ? r.raw.newName : r.raw.name), cellText(rename ? r.raw.tagId : r.raw.serialNumber), r.assetId || '',
        (r.issues || []).concat(r.note ? [r.note] : []).join('; ')];
    });
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header].concat(lines)), 'Results');
    var stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, '').replace('T', '-');
    XLSX.writeFile(wb, 'bwn-bulk-assets-results-' + stamp + '.xlsx');
    logLine('Results downloaded: ' + plural(lines.length, 'row'));
  }

  // ---- Routing + dock -------------------------------------------------------------------------
  function onRoute() {
    state.clientId = clientIdFromPath(location.pathname);
    dockSync();
    render();
  }

  function boot() {
    if (window.__bwnBulkAssetsLoaded) return;           // duplicate-init guard
    window.__bwnBulkAssetsLoaded = true;
    document.head.appendChild(h('style', { id: 'bwnba-style', text: CSS }));
    launchBtn = h('button', { id: 'bwnba-launch', type: 'button', 'aria-haspopup': 'dialog', text: 'Bulk Assets', hidden: true, onclick: openDrawer });
    document.body.appendChild(launchBtn);
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (!d) return;
      if (d.id === 'bwn:dock:host' || d.id === 'bwn:dock:ping') {
        dockHostSeen = true;
        if (ui) ui.aside.classList.remove('bwnba-solo');
        dockSync();
      }
      if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY) openDrawer();
      if (d.id === 'bwn:drawer:open' && d.key !== DOCK_KEY && !state.running) closeDrawer();   // another tool took the slot
    });
    // SPA navigation: Umbrava routes with pushState. Patched once (guard above); no polling.
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      history[m] = function () {
        var out = orig.apply(this, arguments);
        try { window.dispatchEvent(new Event('bwn-bulk-assets:route')); } catch (e) { }
        return out;
      };
    });
    window.addEventListener('popstate', onRoute);
    window.addEventListener('bwn-bulk-assets:route', onRoute);
    window.addEventListener('beforeunload', function (e) { if (state.running) { e.preventDefault(); e.returnValue = ''; } });
    onRoute();
    setTimeout(function () { dockWaited = true; dockSync(); }, DOCK_WAIT_MS);  // no host by now -> the fallback button shows
  }

  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
