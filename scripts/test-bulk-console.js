// test-bulk-console.js - RETIREMENT GUARD for bwn-write-queue's Bulk Operations Console modal.
//
// Converge ruling (2026-09-01): Core (bwn-suite-core, flag bulkOps) is now THE single Safe Bulk
// Operations Console (tested by scripts/test-bulk-ops.js). The write-queue operator MODAL and its pure
// orchestration engine (preview / dry-run / sequential runner / PII-safe projection / CSV+JSON export)
// were RETIRED from bwn-write-queue.user.js. What STAYS is the Track C DRAIN executor (BWN-WQ EXEC),
// which has its own harness (test-write-queue-drain.js).
//
// This file no longer tests the (deleted) modal. It now:
//   1. TRIPWIRE - asserts the retired regions + the bulkConsole flag menu commands are GONE and do not
//      silently return, and that the drain executor + its retirement tombstone are present.
//   2. FOLDS the one still-relevant executor guarantee that lived here: executeCommand's DRY-RUN path
//      performs ZERO writes - driven against the REAL EXEC bytes with a faithful bwnGqlOp stub, plus a
//      negative control on EACH dry-run guard (remove it -> a dry-run WRITES).
//
// Run with the Adobe-bundled node (system node is quarantined on this machine):
//   "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-bulk-console.js
// CI runs: node scripts/test-bulk-console.js

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var A = require("./assert.js");

var SRC = path.join(__dirname, "..", "bwn-write-queue.user.js");
var full = fs.readFileSync(SRC, "utf8").replace(/\r\n/g, "\n");

// ================= 1. RETIREMENT TRIPWIRE =====================================================
// The modal + its pure engine are gone; the drain executor stays. If any of these flips, the modal
// (or its flag) has crept back and the converge has regressed.
A.ok("the BWN-BULK-CONSOLE engine region is GONE", full.indexOf("// ==== BWN-BULK-CONSOLE START") === -1);
A.ok("the BWN-BULK-CONSOLE UI (modal) region is GONE", full.indexOf("// ==== BWN-BULK-CONSOLE UI") === -1);
A.ok("the retirement tombstone is in place", full.indexOf("// ==== BWN-BULK-CONSOLE RETIRED") !== -1);
A.ok("the modal's operator functions do NOT return", full.indexOf("function openBulkConsole") === -1 && full.indexOf("var bulkUI") === -1 && full.indexOf("function bulkRunBatch") === -1);
A.ok("the bulkConsole flag menu commands are GONE", full.indexOf("open Bulk Operations Console") === -1 && full.indexOf("ENABLE bulk console live writes") === -1 && full.indexOf("bulkSetFlag(\"bulkConsole\"") === -1);
A.ok("the DRAIN executor (BWN-WQ EXEC) is KEPT", full.indexOf("// ==== BWN-WQ EXEC START") !== -1 && full.indexOf("// ==== BWN-WQ EXEC END ====") !== -1);
A.ok("write-queue is bumped to 0.5.0 (@version + runtime VER in lockstep)", /@version\s+0\.5\.0/.test(full) && /VER = "0\.5\.0"/.test(full));

// ================= 2. FOLDED EXECUTOR COVERAGE: dry-run = ZERO writes =========================
// Slice the EXEC block ALONE and drive executeCommand({dryRun:true}) directly (the modal that used to
// wrap it is gone; the drain loop never dry-runs, so this guarantee has no other home). A faithful
// bwnGqlOp stub records every routed write so a dry-run leaking a write is caught.
function sliceBetween(src, startMark, endMark) {
  var a = src.indexOf(startMark);
  if (a === -1) throw new Error("START marker not found: " + startMark);
  if (src.indexOf(startMark, a + 1) !== -1) throw new Error("START marker not unique: " + startMark);
  var b = src.indexOf(endMark, a);
  if (b === -1) throw new Error("END marker not found after start: " + endMark);
  return src.slice(a, b);
}
var S_EXEC = sliceBetween(full, "// ==== BWN-WQ EXEC START", "// ==== BWN-WQ EXEC END ====");

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error("MUTATION TARGET ABSENT: " + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error("MUTATION TARGET NOT UNIQUE: " + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

function load(engineSrc) {
  var sandbox = { console: console, gql: null, BWN_VER: "0.5.0", setTimeout: setTimeout };
  // Faithful bwnGqlOp stub (same contract as test-write-queue-drain.js): records every routed write,
  // refuses a high-risk patch without confirmed:true, rejects a success:false envelope .bwnNonTransient.
  sandbox.bwnGqlOp = function (op, query, variables, opts) {
    opts = opts || {};
    if (op === "patchWorkOrder" && opts.confirmed !== true) return Promise.reject(new Error("bwnGqlOp: high-risk write needs confirmation"));
    sandbox.bwnGqlOp.calls.push({ op: op, opts: opts });
    return Promise.resolve(sandbox.gql(query, variables)).then(function (data) {
      var env = data && data[op];
      if (env && env.success === false) { var e = new Error(env.message || (op + " was refused")); e.bwnNonTransient = true; return Promise.reject(e); }
      return data;
    });
  };
  sandbox.bwnGqlOp.calls = [];
  vm.createContext(sandbox);
  vm.runInContext(engineSrc, sandbox);
  return sandbox;
}

var DEFAULT_WO = { statusId: 41, assignedTo: "g-old", serviceLevelAgreementId: "sla-1", priority: { label: "P3", expectedCompletionDate: null, hasPriorityOverride: false, category: "Svc", skipWeekends: false } };
function mkGql(opts) {
  opts = opts || {};
  function gql(query, variables) {
    gql.calls.push({ q: query, v: variables });
    var n = variables && variables.n;
    if (/patchWorkOrder/.test(query)) return Promise.resolve({ patchWorkOrder: { success: true } });
    if (/addEditJobNote/.test(query)) return Promise.resolve({ addEditJobNote: { success: true, note: { id: "note-1" } } });
    if (/workOrderNotes/.test(query)) return Promise.resolve({ workOrderNotes: (opts.notesByWo && opts.notesByWo[n]) || [] });
    if (/workOrder\s*\(/.test(query)) return Promise.resolve({ workOrder: (opts.wos && opts.wos[n]) || DEFAULT_WO });
    return Promise.resolve({});
  }
  gql.calls = [];
  return gql;
}
function statusCmd(wo, target) { return { id: "s" + wo, verb: "wo.status", woNumber: String(wo), idemKey: "k" + wo, args: { statusId: target } }; }
function noteCmd(wo, text) { return { id: "n" + wo, verb: "wo.note", woNumber: String(wo), idemKey: "m" + wo, args: { noteText: text } }; }

(async function () {
  var S = load(S_EXEC);

  // ---- dry-run status: reads happen, ZERO writes routed ----
  S.gql = mkGql({ wos: { 100: { statusId: 41 } } });
  S.bwnGqlOp.calls = [];
  var dS = await S.executeCommand(statusCmd(100, 77), { dryRun: true });
  A.eq("dry status: previews would-send (dryRun:true), before/after present", [dS.dryRun, dS.before.statusId, dS.after.statusId], [true, 41, 77]);
  A.eq("dry status: ZERO writes routed through bwnGqlOp", S.bwnGqlOp.calls.length, 0);
  A.ok("dry status: the WO READ still happened (a real preview)", S.gql.calls.length > 0);

  // ---- dry-run note: reads happen, ZERO writes routed ----
  S.gql = mkGql({ notesByWo: { 200: [] } });
  S.bwnGqlOp.calls = [];
  var dN = await S.executeCommand(noteCmd(200, "SECRET NOTE BODY"), { dryRun: true });
  A.eq("dry note: previews would-send, no note text on the result object", [dN.dryRun, JSON.stringify(dN).indexOf("SECRET")], [true, -1]);
  A.eq("dry note: ZERO writes routed through bwnGqlOp", S.bwnGqlOp.calls.length, 0);

  // ---- live control: WITHOUT dryRun, the same commands DO route a write (proves dry-run is the gate) ----
  S.gql = mkGql({ wos: { 100: { statusId: 41 } } });
  S.bwnGqlOp.calls = [];
  await S.executeCommand(statusCmd(100, 77));   // no opts -> live path
  A.eq("live control: without dryRun, a status write IS routed", S.bwnGqlOp.calls.length, 1);

  // ---- NEGATIVE CONTROL A: remove the PATCH dry-run guard -> a dry-run status WRITES ----
  var MUT_PATCH = mutate(S_EXEC, "if (opts.dryRun) return dryPatch(cmd.verb, before, after);", "if (false) return dryPatch(cmd.verb, before, after);");
  var Sa = load(MUT_PATCH);
  Sa.gql = mkGql({ wos: { 100: { statusId: 41 } } });
  Sa.bwnGqlOp.calls = [];
  await Sa.executeCommand(statusCmd(100, 77), { dryRun: true });
  A.eq("CONTROL A: without the patch dry-run guard, a DRY-RUN patch WRITES (guard is load-bearing)", Sa.bwnGqlOp.calls.length, 1);

  // ---- NEGATIVE CONTROL B: remove the NOTE dry-run guard -> a dry-run note POSTS ----
  var MUT_NOTE = mutate(S_EXEC, "if (opts.dryRun) return dryNote();", "if (false) return dryNote();");
  var Sb = load(MUT_NOTE);
  Sb.gql = mkGql({ notesByWo: { 200: [] } });
  Sb.bwnGqlOp.calls = [];
  await Sb.executeCommand(noteCmd(200, "hi"), { dryRun: true });
  A.eq("CONTROL B: without the note dry-run guard, a DRY-RUN note POSTS (guard is load-bearing)", Sb.bwnGqlOp.calls.length, 1);

  A.finish();
})().catch(function (e) { console.error(e); process.exit(1); });
