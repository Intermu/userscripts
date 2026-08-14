// ==UserScript==
// @name         BWN Write Queue (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.2.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-write-queue.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-write-queue.user.js
// @description  Drains the Track C write-back queue: claims THIS coordinator's own queued Umbrava write commands from the SWA, confirms each irreversible write, executes it via patchWorkOrder/addEditJobNote, and reports the result. Self-drain; every write is human-confirmed; disabled until you turn it on.
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
  var VER = "0.2.0";   // keep in lockstep with @version (TM compares versions, not contents)

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
  function isUmbravaToken(t) {
    try {
      var p = JSON.parse(atob(String(t).split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
      var iss = String(p.iss || "").replace(/\/+$/, "");
      if (iss !== "https://login.umbrava.com" && iss !== "https://umbrava.us.auth0.com") return false;
      return !(typeof p.exp === "number" && (Date.now() / 1000) > p.exp);
    } catch (e) { return false; }
  }
  function authToken() {
    try {
      var keys = Object.keys(localStorage).filter(function (x) {
        return /@@auth0spajs@@::.*::https:\/\/app\.umbrava\.com\/api::/.test(x);
      });
      for (var i = 0; i < keys.length; i++) {
        var body = (JSON.parse(localStorage.getItem(keys[i])) || {}).body;
        var t = (body && body.access_token) || "";
        if (t && isUmbravaToken(t)) return t;
      }
      return "";
    } catch (e) { return ""; }
  }

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

  // ==== BWN-WQ EXEC START (sliced by test-write-queue-drain.js; references the injected `gql`) ====
  var INTERNAL_NOTE_TYPE = 13;   // Internal (drop-upload's fallback map). v1 posts every note as Internal.

  var WO_READ_Q = "query($n:Int!){ workOrder(workOrderNumber:$n){ assignedTo statusId serviceLevelAgreementId priority{ label responseMinutes firstTripDate serviceLevelAgreementMinutes expirationMinutes expectedCompletionDate hasPriorityOverride category skipWeekends } } }";
  var NOTES_Q = "query BwnWorkOrderNotes($n: Int!) { workOrderNotes(workOrderNumber: $n) { id type content isDeleted } }";
  var PATCH_M = "mutation PatchWorkOrder($data: PatchWorkOrderInput!) { patchWorkOrder(data: $data) { success message } }";
  var ADD_NOTE_M = "mutation AddEditWONote($addEditInput: WorkOrderNoteInput!) { addEditJobNote(data: $addEditInput) { success message note { id type } } }";

  function cond(v) { return { shouldInclude: true, value: v }; }   // the Conditional*Input wrapper
  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function gqlError(msg) { var e = new Error(msg); e.business = true; return e; }   // a verb-level refusal, never retryable
  function classifyError(err) { return !(err && (err.business || err.graphql)); }   // retryable iff it is a transport error

  function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
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

  // Execute ONE claimed command. Returns { outcome:'done', result } or throws (the caller classifies
  // and reports failed). Confirmation is the caller's job - this function is confirm-free so it is
  // fully unit-testable in a vm with an injected gql.
  function executeCommand(cmd) {
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
        return gql(ADD_NOTE_M, { addEditInput: input }).then(function (d) {
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

      if (cmd.verb === "wo.status") {
        var target = parseInt(args.statusId, 10);
        if (Number(rec.statusId) === target) return { outcome: "done", result: { skipped: "already-status", statusId: target } };
        data.statusId = cond(target);
      } else if (cmd.verb === "wo.assign") {
        var who = String(args.assignedTo);
        if (String(rec.assignedTo) === who) return { outcome: "done", result: { skipped: "already-assigned" } };
        data.assignedTo = cond(who);
      } else if (cmd.verb === "wo.ecd") {
        var date = String(args.expectedCompletionDate);
        var cur = rec.priority && rec.priority.expectedCompletionDate;
        if (cur && String(cur).slice(0, 10) === date.slice(0, 10)) return { outcome: "done", result: { skipped: "already-ecd" } };
        data.priority = cond(priorityWriteValue(rec.priority, date));
        if (rec.serviceLevelAgreementId) data.serviceLevelAgreementId = cond(rec.serviceLevelAgreementId);
      } else {
        throw gqlError("unknown verb: " + cmd.verb);
      }

      return gql(PATCH_M, { data: data }).then(function (d) {
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
