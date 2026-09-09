// test-bulk-console.js - the RM-C1 Bulk Operations Console layered on bwn-write-queue.user.js.
//
// Slices TWO regions out of the shipped userscript - the BWN-WQ EXEC block (executeCommand + its
// dry-run guards) and the BWN-BULK-CONSOLE block (the pure orchestration + PII-safe projections) -
// CONCATENATES them, and runs them in a vm with the SAME faithful bwnGqlOp stub the drain harness
// uses (patch needs confirmed:true; success:false rejects .bwnNonTransient; every routed write is
// recorded) plus a programmable gql. So the batch runner is driven through the REAL executeCommand
// write path, never a stub of it - which is what makes the dry-run 0-write proof mean something.
//
// Proves: dry-run performs 0 writes (with a negative control on EACH dry-run guard); throttle is
// respected (and skipped in dry-run); cancel stops mid-batch with no further writes and releases the
// remainder; a failure threshold aborts the remainder; partial failure yields a per-record report;
// the flag gate is fail-closed (flag OFF blocks execution even with a correct typed confirm, with a
// negative control on the flag check); and no export column ever carries note text or a nested object.
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

function sliceBetween(src, startMark, endMark) {
  var a = src.indexOf(startMark);
  if (a === -1) throw new Error("START marker not found: " + startMark);
  if (src.indexOf(startMark, a + 1) !== -1) throw new Error("START marker not unique: " + startMark);
  var b = src.indexOf(endMark, a);
  if (b === -1) throw new Error("END marker not found after start: " + endMark);
  return src.slice(a, b);
}
var S_EXEC = sliceBetween(full, "// ==== BWN-WQ EXEC START", "// ==== BWN-WQ EXEC END ====");
var S_BULK = sliceBetween(full, "// ==== BWN-BULK-CONSOLE START", "// ==== BWN-BULK-CONSOLE END ====");
var S_ALL = S_EXEC + "\n" + S_BULK;

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error("MUTATION TARGET ABSENT: " + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error("MUTATION TARGET NOT UNIQUE: " + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

function load(engineSrc) {
  var sandbox = { console: console, gql: null, BWN_VER: "0.5.0", setTimeout: setTimeout, bwnCan: function () { return true; } };
  // Faithful bwnGqlOp stub (identical contract to test-write-queue-drain.js): records every routed
  // write, refuses a high-risk patch without confirmed:true, and rejects a success:false envelope
  // with .bwnNonTransient so classifyError sees a non-retryable refusal.
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

// A programmable gql keyed by WO number. wos[n] is the workOrder record; notesByWo[n] its notes;
// patchFail[n]=true makes THAT WO's patch come back success:false.
function mkGql(opts) {
  opts = opts || {};
  function gql(query, variables) {
    gql.calls.push({ q: query, v: variables });
    var n = variables && variables.n;
    if (/patchWorkOrder/.test(query)) {
      // find the WO number from the patch data
      var wo = variables && variables.data && variables.data.workOrderNumber;
      if (opts.patchFail && opts.patchFail[wo]) return Promise.resolve({ patchWorkOrder: { success: false, message: "refused-" + wo } });
      return Promise.resolve({ patchWorkOrder: { success: true } });
    }
    if (/addEditJobNote/.test(query)) return Promise.resolve({ addEditJobNote: { success: true, note: { id: "note-" + Date.now() } } });
    if (/workOrderNotes/.test(query)) return Promise.resolve({ workOrderNotes: (opts.notesByWo && opts.notesByWo[n]) || [] });
    if (/workOrder\s*\(/.test(query)) return Promise.resolve({ workOrder: (opts.wos && opts.wos[n]) || DEFAULT_WO });
    return Promise.resolve({});
  }
  gql.calls = [];
  return gql;
}
var DEFAULT_WO = { statusId: 41, assignedTo: "g-old", serviceLevelAgreementId: "sla-1", priority: { label: "P3", responseMinutes: 1440, expectedCompletionDate: null, hasPriorityOverride: false, category: "Svc", skipWeekends: false } };
function statusCmd(id, wo, target) { return { id: id, verb: "wo.status", woNumber: String(wo), idemKey: "k" + wo, args: { statusId: target } }; }
function noteCmd(id, wo, text) { return { id: id, verb: "wo.note", woNumber: String(wo), idemKey: "n" + wo, args: { noteText: text } }; }
function recordingDelay() { var f = function (ms) { f.calls.push(ms); return Promise.resolve(); }; f.calls = []; return f; }

(async function () {
  var S = load(S_ALL);

  // ================= 1. GATING (fail-closed) =====================================================
  A.ok("bulkFlagOn: true only when === true", S.bulkFlagOn({ bulkConsole: true }) === true);
  A.ok("bulkFlagOn: absent flag is OFF", S.bulkFlagOn({}) === false);
  A.ok("bulkFlagOn: a non-true value is OFF", S.bulkFlagOn({ bulkConsole: "yes" }) === false && S.bulkFlagOn({ bulkConsole: 1 }) === false);
  A.ok("bulkFlagOn: null modules is OFF", S.bulkFlagOn(null) === false);

  A.ok("bulkConfirmMatches: EXECUTE matches", S.bulkConfirmMatches("EXECUTE", 5) === true);
  A.ok("bulkConfirmMatches: the exact count matches", S.bulkConfirmMatches("5", 5) === true);
  A.ok("bulkConfirmMatches: trims surrounding space", S.bulkConfirmMatches("  EXECUTE  ", 5) === true);
  A.ok("bulkConfirmMatches: wrong word is refused", S.bulkConfirmMatches("execute", 5) === false);
  A.ok("bulkConfirmMatches: wrong count is refused", S.bulkConfirmMatches("4", 5) === false);
  A.ok("bulkConfirmMatches: empty is refused", S.bulkConfirmMatches("", 5) === false && S.bulkConfirmMatches(null, 5) === false);

  A.eq("gate: flag OFF -> permission-denied even with a correct typed confirm", S.bulkExecuteGate({}, "EXECUTE", 3), { allowed: false, reason: "permission-denied" });
  A.eq("gate: flag ON + empty batch -> empty", S.bulkExecuteGate({ bulkConsole: true }, "EXECUTE", 0), { allowed: false, reason: "empty" });
  A.eq("gate: flag ON + wrong confirm -> confirm-required", S.bulkExecuteGate({ bulkConsole: true }, "nope", 3), { allowed: false, reason: "confirm-required" });
  A.eq("gate: flag ON + EXECUTE -> allowed", S.bulkExecuteGate({ bulkConsole: true }, "EXECUTE", 3), { allowed: true, reason: null });
  A.eq("gate: flag ON + count -> allowed", S.bulkExecuteGate({ bulkConsole: true }, "3", 3), { allowed: true, reason: null });

  A.ok("bulkKilled: bulkConsole:false kills", S.bulkKilled({ bulkConsole: false }) === true);
  A.ok("bulkKilled: writeQueue:false kills (shared switch)", S.bulkKilled({ writeQueue: false }) === true);
  A.ok("bulkKilled: neither set -> not killed", S.bulkKilled({ bulkConsole: true }) === false && S.bulkKilled({}) === false);

  // NEGATIVE CONTROL: without the flag check, flag-OFF would be allowed to execute.
  var MUT_FLAG = mutate(S_ALL, "return !!(modules && modules.bulkConsole === true);", "return true;");
  var Sf = load(MUT_FLAG);
  A.ok("CONTROL: neutering bulkFlagOn makes flag-OFF EXECUTABLE (so the flag gate is load-bearing)", Sf.bulkExecuteGate({}, "EXECUTE", 3).allowed === true);

  // ================= 2. ROW PROJECTION (PII-safe) ================================================
  A.eq("row: dry patch -> would-send with scalar before/after",
    S.bulkRow(statusCmd("i1", 100, 77), { outcome: "done", dryRun: true, result: { would: "wo.status" }, before: { statusId: 41 }, after: { statusId: 77 } }, null),
    { wo: "100", field: "status", before: 41, after: 77, outcome: "would-send", detail: "" });
  A.eq("row: live done -> done",
    S.bulkRow(statusCmd("i1", 100, 77), { outcome: "done", result: { verb: "wo.status" } }, null),
    { wo: "100", field: "status", before: null, after: null, outcome: "done", detail: "" });
  A.eq("row: skip -> noop with the skip token",
    S.bulkRow(statusCmd("i1", 100, 77), { outcome: "done", result: { skipped: "already-status" } }, null),
    { wo: "100", field: "status", before: null, after: null, outcome: "noop", detail: "already-status" });
  A.eq("row: error -> failed with a (truncated) structural detail",
    S.bulkRow(statusCmd("i1", 100, 77), null, new Error("patchWorkOrder reported no success")),
    { wo: "100", field: "status", before: null, after: null, outcome: "failed", detail: "patchWorkOrder reported no success" });
  A.eq("row: note verb -> field 'note', NO before/after (note text never leaves)",
    S.bulkRow(noteCmd("i2", 200, "SECRET BODY"), { outcome: "done", dryRun: true, result: { would: "wo.note" } }, null),
    { wo: "200", field: "note", before: null, after: null, outcome: "would-send", detail: "" });
  A.eq("row: released -> not-run", S.bulkReleasedRow(statusCmd("i1", 100, 77), "cancelled"),
    { wo: "100", field: "status", before: null, after: null, outcome: "not-run", detail: "cancelled" });
  A.ok("row: a nested before object is flattened to null, never leaked",
    S.bulkRow(statusCmd("i1", 100, 77), { outcome: "done", dryRun: true, before: { nested: { a: 1 } }, after: { statusId: 5 } }, null).before === null);

  // ================= 3. TALLY + EXPORT ==========================================================
  var demoRows = [
    { wo: "1", field: "status", before: 1, after: 2, outcome: "done", detail: "" },
    { wo: "2", field: "status", before: 2, after: 2, outcome: "noop", detail: "already-status" },
    { wo: "3", field: "note", before: null, after: null, outcome: "failed", detail: "boom, with \"quote\" and, comma" },
    { wo: "4", field: "ecd", before: null, after: null, outcome: "not-run", detail: "cancelled" },
    { wo: "5", field: "status", before: 9, after: 10, outcome: "would-send", detail: "" }
  ];
  A.eq("tally: 4-state + would-send + total", S.bulkTally(demoRows), { done: 1, noop: 1, failed: 1, notRun: 1, would: 1, total: 5 });

  var csv = S.bulkToCSV(demoRows);
  var lines = csv.split("\r\n");
  A.eq("csv: header row", lines[0], "wo,field,before,after,outcome,detail");
  A.eq("csv: one line per row + header", lines.length, demoRows.length + 1);
  A.ok("csv: a comma/quote detail is RFC-escaped", lines[3].indexOf('"boom, with ""quote"" and, comma"') !== -1);
  A.ok("csv: a would-send preview row exports", lines[5].indexOf("would-send") !== -1);

  var noteDump = S.bulkToCSV([S.bulkRow(noteCmd("i", 9, "TOP SECRET NOTE TEXT"), { outcome: "done", dryRun: true, result: { would: "wo.note" } }, null)]);
  A.ok("csv: a note row NEVER carries the note text (authorized fields only)", noteDump.indexOf("TOP SECRET") === -1);

  var jsonStr = S.bulkToJSON(demoRows, { mode: "dry" });
  var parsed = JSON.parse(jsonStr);
  A.eq("json: schema + ver + count", [parsed.schema, parsed.ver, parsed.count], [1, "0.5.0", 5]);
  A.eq("json: carries the tally", parsed.tally, { done: 1, noop: 1, failed: 1, notRun: 1, would: 1, total: 5 });
  A.ok("json: parses and round-trips the rows", Array.isArray(parsed.rows) && parsed.rows.length === 5);

  // ================= 4. DRY-RUN = ZERO WRITES (the headline) =====================================
  var dryBatch = [statusCmd("d1", 100, 77), { id: "d2", verb: "wo.assign", woNumber: "101", idemKey: "a", args: { assignedTo: "g-new" } },
    { id: "d3", verb: "wo.ecd", woNumber: "102", idemKey: "e", args: { expectedCompletionDate: "2027-01-01" } }, noteCmd("d4", 103, "hello")];
  S.gql = mkGql({
    wos: { 100: { statusId: 41 }, 101: { assignedTo: "g-old" }, 102: { serviceLevelAgreementId: "s", priority: { expectedCompletionDate: "2026-01-01" } } },
    notesByWo: { 103: [] }
  });
  S.bwnGqlOp.calls = [];
  var dryDelay = recordingDelay();
  var dryRows = [];
  var drySummary = await S.bulkRunBatch(dryBatch, { execFn: S.executeCommand, dryRun: true, throttleMs: 500, delayFn: dryDelay, onRecord: function (r) { dryRows.push(r); } });
  A.eq("DRY-RUN: ZERO writes routed through bwnGqlOp", S.bwnGqlOp.calls.length, 0);
  A.ok("DRY-RUN: reads DID happen (it is a real preview, not a no-op)", S.gql.calls.length > 0);
  A.eq("DRY-RUN: every record previews as would-send", dryRows.map(function (r) { return r.outcome; }), ["would-send", "would-send", "would-send", "would-send"]);
  A.eq("DRY-RUN: the status preview shows current -> proposed", [dryRows[0].before, dryRows[0].after], [41, 77]);
  A.eq("DRY-RUN: throttle is SKIPPED (no delay between read-only records)", dryDelay.calls.length, 0);
  A.ok("DRY-RUN: summary is a clean completion", drySummary.stopped === false && drySummary.processed === 4);

  // NEGATIVE CONTROL A: remove the PATCH dry-run guard -> a dry-run status DOES write.
  var MUT_PATCH = mutate(S_ALL, "if (opts.dryRun) return dryPatch(cmd.verb, before, after);", "if (false) return dryPatch(cmd.verb, before, after);");
  var Sa = load(MUT_PATCH);
  Sa.gql = mkGql({ wos: { 100: { statusId: 41 } } });
  Sa.bwnGqlOp.calls = [];
  await Sa.bulkRunBatch([statusCmd("x", 100, 77)], { execFn: Sa.executeCommand, dryRun: true });
  A.ok("CONTROL A: without the patch dry-run guard, a DRY-RUN patch WRITES (guard is load-bearing)", Sa.bwnGqlOp.calls.length === 1);

  // NEGATIVE CONTROL B: remove the NOTE dry-run guard -> a dry-run note DOES post.
  var MUT_NOTE = mutate(S_ALL, "if (opts.dryRun) return dryNote();", "if (false) return dryNote();");
  var Sb = load(MUT_NOTE);
  Sb.gql = mkGql({ notesByWo: { 200: [] } });
  Sb.bwnGqlOp.calls = [];
  await Sb.bulkRunBatch([noteCmd("x", 200, "hi")], { execFn: Sb.executeCommand, dryRun: true });
  A.ok("CONTROL B: without the note dry-run guard, a DRY-RUN note POSTS (guard is load-bearing)", Sb.bwnGqlOp.calls.length === 1);

  // ================= 5. THROTTLE (live) =========================================================
  S.gql = mkGql({ wos: { 100: { statusId: 41 }, 101: { statusId: 41 }, 102: { statusId: 41 } } });
  S.bwnGqlOp.calls = [];
  var liveDelay = recordingDelay();
  await S.bulkRunBatch([statusCmd("t1", 100, 77), statusCmd("t2", 101, 77), statusCmd("t3", 102, 77)],
    { execFn: S.executeCommand, dryRun: false, throttleMs: 50, delayFn: liveDelay });
  A.eq("throttle: 3 live writes routed", S.bwnGqlOp.calls.length, 3);
  A.eq("throttle: delayed BETWEEN records only (n-1 = 2 delays)", liveDelay.calls, [50, 50]);

  // ================= 6. CANCEL stops mid-batch (no further writes) ================================
  S.gql = mkGql({ wos: { 100: { statusId: 41 }, 101: { statusId: 41 }, 102: { statusId: 41 }, 103: { statusId: 41 } } });
  S.bwnGqlOp.calls = [];
  var processed = 0, released = [];
  var cancelSummary = await S.bulkRunBatch([statusCmd("c1", 100, 77), statusCmd("c2", 101, 77), statusCmd("c3", 102, 77), statusCmd("c4", 103, 77)], {
    execFn: S.executeCommand, dryRun: false, throttleMs: 0,
    isStopped: function () { return processed >= 1 ? "cancel" : false; },   // cancel after the first record
    onRecord: function () { processed++; },
    onReleased: function (cmd) { released.push(cmd.id); }
  });
  A.eq("cancel: exactly ONE write fired before the stop", S.bwnGqlOp.calls.length, 1);
  A.eq("cancel: the remaining 3 were released, none executed", released, ["c2", "c3", "c4"]);
  A.ok("cancel: summary marks the stop + release count", cancelSummary.stopped === true && cancelSummary.released === 3);
  A.eq("cancel: the report lists every outcome (1 done + 3 not-run)", S.bulkTally(cancelSummary.rows), { done: 1, noop: 0, failed: 0, notRun: 3, would: 0, total: 4 });

  // ================= 7. PARTIAL FAILURE -> per-record report (threshold OFF) ======================
  S.gql = mkGql({ wos: { 100: { statusId: 41 }, 101: { statusId: 41 }, 102: { statusId: 41 } }, patchFail: { 101: true } });
  S.bwnGqlOp.calls = [];
  var partial = await S.bulkRunBatch([statusCmd("p1", 100, 77), statusCmd("p2", 101, 77), statusCmd("p3", 102, 77)],
    { execFn: S.executeCommand, dryRun: false, failThreshold: 0 });
  A.eq("partial: one failing record does NOT abort the rest", partial.rows.map(function (r) { return r.outcome; }), ["done", "failed", "done"]);
  A.eq("partial: the failed row names its WO", partial.rows[1].wo, "101");
  A.eq("partial: tally reflects 2 done + 1 failed", S.bulkTally(partial.rows), { done: 2, noop: 0, failed: 1, notRun: 0, would: 0, total: 3 });

  // ================= 8. FAILURE THRESHOLD aborts the remainder ====================================
  S.gql = mkGql({ wos: { 100: { statusId: 41 }, 101: { statusId: 41 }, 102: { statusId: 41 }, 103: { statusId: 41 } }, patchFail: { 100: true, 101: true, 102: true, 103: true } });
  S.bwnGqlOp.calls = [];
  var relInfo = [];
  var thr = await S.bulkRunBatch([statusCmd("f1", 100, 77), statusCmd("f2", 101, 77), statusCmd("f3", 102, 77), statusCmd("f4", 103, 77)],
    { execFn: S.executeCommand, dryRun: false, failThreshold: 2, onReleased: function (cmd, reason) { relInfo.push(reason); } });
  A.eq("threshold: stopped after the 2nd failure (only 2 writes attempted)", S.bwnGqlOp.calls.length, 2);
  A.eq("threshold: the remaining 2 are released as fail-threshold", relInfo, ["fail-threshold", "fail-threshold"]);
  A.eq("threshold: final report = 2 failed + 2 not-run", S.bulkTally(thr.rows), { done: 0, noop: 0, failed: 2, notRun: 2, would: 0, total: 4 });

  // ================= 9. FLAG-OFF blocks a live batch behaviourally =================================
  // The console calls bulkExecuteGate BEFORE bulkRunBatch. With the flag off the gate refuses, so no
  // batch is ever started - proven by the gate returning permission-denied for the exact inputs a
  // correct operator would supply.
  A.ok("flag-off: a correctly-typed EXECUTE is still blocked when the flag is off",
    S.bulkExecuteGate({ writeQueue: true }, "EXECUTE", 4).allowed === false &&
    S.bulkExecuteGate({ writeQueue: true }, "EXECUTE", 4).reason === "permission-denied");

  A.finish();
})().catch(function (e) { console.error(e); process.exit(1); });
