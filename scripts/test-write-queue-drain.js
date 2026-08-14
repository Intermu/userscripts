// test-write-queue-drain.js - the execute half of Track C write-back (bwn-write-queue.user.js).
// Slices the BWN-WQ EXEC block out of the shipped userscript, runs it in a vm with an INJECTED gql
// (settable per test so each Umbrava response is programmable), and asserts executeCommand's write
// shapes + the two-layer idempotency: set verbs skip when current==target, and the append verb
// (wo.note) checks for its [bwn:<idemKey>] marker before posting. The append dedup carries a real
// negative control - disabling the marker check double-posts, which goes RED.
// Contract: outputs/specs/2026-08-14-track-c-write-queue-contract.md (Claude Brain vault).
//
// Run with the Adobe-bundled node (system node is quarantined on this machine):
//   "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-write-queue-drain.js
// CI runs: node scripts/test-write-queue-drain.js

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var A = require("./assert.js");

var SRC = path.join(__dirname, "..", "bwn-write-queue.user.js");
var full = fs.readFileSync(SRC, "utf8").replace(/\r\n/g, "\n");

var START = "// ==== BWN-WQ EXEC START";
var END = "// ==== BWN-WQ EXEC END ====";
function slice(src) {
  var a = src.indexOf(START);
  if (a === -1) throw new Error("START marker not found - the exec block is gone from bwn-write-queue.user.js");
  if (src.indexOf(START, a + 1) !== -1) throw new Error("START marker not unique");
  var b = src.indexOf(END, a);
  if (b === -1) throw new Error("END marker not found after start");
  return src.slice(a, b);
}
var S_ENGINE = slice(full);

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error("MUTATION TARGET ABSENT: " + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error("MUTATION TARGET NOT UNIQUE: " + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

function load(engineSrc) {
  var sandbox = { console: console, gql: null };
  vm.createContext(sandbox);
  vm.runInContext(engineSrc, sandbox);
  return sandbox;
}

var DEFAULT_WO = {
  statusId: 41, assignedTo: "g-old", serviceLevelAgreementId: "sla-1",
  priority: { label: "P3", responseMinutes: 1440, firstTripDate: null, serviceLevelAgreementMinutes: 1440, expirationMinutes: 0, expectedCompletionDate: null, hasPriorityOverride: false, category: "Svc", skipWeekends: false }
};
// A programmable gql stub. Records every call so a test can assert what was (or was NOT) issued.
function mkGql(opts) {
  opts = opts || {};
  function gql(query, variables) {
    gql.calls.push({ q: query, v: variables });
    if (/patchWorkOrder/.test(query)) {
      if (opts.patchThrow) return Promise.reject(opts.patchThrow);
      if (opts.patchNoSuccess) return Promise.resolve({ patchWorkOrder: { success: false, message: "refused" } });
      return Promise.resolve({ patchWorkOrder: { success: true } });
    }
    if (/addEditJobNote/.test(query)) return Promise.resolve({ addEditJobNote: { success: true, note: { id: "note-9" } } });
    if (/workOrderNotes/.test(query)) return Promise.resolve({ workOrderNotes: opts.notes || [] });
    if (/workOrder\s*\(/.test(query)) return Promise.resolve({ workOrder: opts.wo || DEFAULT_WO });
    return Promise.resolve({});
  }
  gql.calls = [];
  return gql;
}
function patchesOf(g) { return g.calls.filter(function (c) { return /patchWorkOrder/.test(c.q); }); }
function notePostsOf(g) { return g.calls.filter(function (c) { return /addEditJobNote/.test(c.q); }); }

(async function () {
  var S = load(S_ENGINE);

  // ---- pure helpers ------------------------------------------------------------------
  A.eq("cond wraps {shouldInclude:true, value}", S.cond(41), { shouldInclude: true, value: 41 });
  A.eq("markerFor(idemKey)", S.markerFor("abc"), "[bwn:abc]");
  A.ok("noteHasMarker finds the tag", S.noteHasMarker([{ content: "x [bwn:K1] y" }], "K1"));
  A.ok("noteHasMarker ignores a deleted note", !S.noteHasMarker([{ content: "[bwn:K1]", isDeleted: true }], "K1"));
  A.ok("noteHasMarker is per idemKey", !S.noteHasMarker([{ content: "[bwn:OTHER]" }], "K1"));

  // ---- priorityWriteValue: whole-object copy, never a partial (the blanking hazard) --
  var pw = S.priorityWriteValue({ label: "P2", responseMinutes: 720, firstTripDate: "2026-01-01", serviceLevelAgreementMinutes: 60, expirationMinutes: 10, category: "RF", skipWeekends: true, hasPriorityOverride: false }, "2026-09-01T00:00:00Z");
  A.eq("priority keeps label", pw.label, "P2");
  A.eq("priority keeps category", pw.category, "RF");
  A.eq("priority keeps skipWeekends", pw.skipWeekends, true);
  A.eq("priority sets the new ECD", pw.expectedCompletionDate, "2026-09-01T00:00:00Z");
  A.eq("priority forces hasOverridePriority (read->input name flip)", pw.hasOverridePriority, true);

  // ---- wo.status ---------------------------------------------------------------------
  S.gql = mkGql({ wo: { statusId: 41, assignedTo: "g", serviceLevelAgreementId: "s", priority: {} } });
  var r = await S.executeCommand({ verb: "wo.status", woNumber: "100", idemKey: "k", args: { statusId: 77 } });
  A.eq("status: outcome done", r.outcome, "done");
  A.eq("status: one patch issued", patchesOf(S.gql).length, 1);
  A.eq("status: patch carries statusId cond", patchesOf(S.gql)[0].v.data.statusId, { shouldInclude: true, value: 77 });

  S.gql = mkGql({ wo: { statusId: 77 } });
  r = await S.executeCommand({ verb: "wo.status", woNumber: "100", idemKey: "k", args: { statusId: 77 } });
  A.eq("status: skips when current==target (no clock reset)", r.result.skipped, "already-status");
  A.eq("status: skip issues NO patch", patchesOf(S.gql).length, 0);

  // ---- wo.assign ---------------------------------------------------------------------
  S.gql = mkGql({ wo: { assignedTo: "g-old" } });
  r = await S.executeCommand({ verb: "wo.assign", woNumber: "100", idemKey: "k", args: { assignedTo: "g-new" } });
  A.eq("assign: patch carries assignedTo cond", patchesOf(S.gql)[0].v.data.assignedTo, { shouldInclude: true, value: "g-new" });

  S.gql = mkGql({ wo: { assignedTo: "g-same" } });
  r = await S.executeCommand({ verb: "wo.assign", woNumber: "100", idemKey: "k", args: { assignedTo: "g-same" } });
  A.eq("assign: skips when already assigned", r.result.skipped, "already-assigned");
  A.eq("assign: skip issues NO patch", patchesOf(S.gql).length, 0);

  // ---- wo.ecd: read-copy-override of the whole priority -------------------------------
  S.gql = mkGql({ wo: { serviceLevelAgreementId: "sla-9", priority: { label: "P2", responseMinutes: 720, firstTripDate: null, serviceLevelAgreementMinutes: 720, expirationMinutes: 0, expectedCompletionDate: "2026-01-01", hasPriorityOverride: false, category: "Svc", skipWeekends: false } } });
  r = await S.executeCommand({ verb: "wo.ecd", woNumber: "100", idemKey: "k", args: { expectedCompletionDate: "2026-09-01" } });
  var pd = patchesOf(S.gql)[0].v.data;
  A.eq("ecd: sends the new date inside the whole priority", pd.priority.value.expectedCompletionDate, "2026-09-01");
  A.eq("ecd: preserves label (not blanked)", pd.priority.value.label, "P2");
  A.eq("ecd: forces the override", pd.priority.value.hasOverridePriority, true);
  A.eq("ecd: bundles serviceLevelAgreementId", pd.serviceLevelAgreementId, { shouldInclude: true, value: "sla-9" });

  S.gql = mkGql({ wo: { priority: { expectedCompletionDate: "2026-09-01T12:00:00Z" } } });
  r = await S.executeCommand({ verb: "wo.ecd", woNumber: "100", idemKey: "k", args: { expectedCompletionDate: "2026-09-01" } });
  A.eq("ecd: skips when the date already matches", r.result.skipped, "already-ecd");
  A.eq("ecd: skip issues NO patch", patchesOf(S.gql).length, 0);

  // ---- wo.note: happy path posts WITH the marker ------------------------------------
  S.gql = mkGql({ notes: [] });
  r = await S.executeCommand({ verb: "wo.note", woNumber: "100", idemKey: "KX", args: { noteText: "call the vendor" } });
  A.eq("note: posted once", notePostsOf(S.gql).length, 1);
  A.ok("note: content carries the [bwn:KX] marker", notePostsOf(S.gql)[0].v.addEditInput.content.indexOf("[bwn:KX]") !== -1);
  A.eq("note: posted as Internal (type 13)", notePostsOf(S.gql)[0].v.addEditInput.type, 13);

  // ---- wo.note APPEND IDEMPOTENCY: marker present -> report done WITHOUT a second post
  S.gql = mkGql({ notes: [{ content: "prior [bwn:KX] tag", isDeleted: false }] });
  r = await S.executeCommand({ verb: "wo.note", woNumber: "100", idemKey: "KX", args: { noteText: "call the vendor" } });
  A.eq("note: skipped when its marker already exists", r.result.skipped, "already-posted");
  A.eq("note: skip issues NO post", notePostsOf(S.gql).length, 0);

  // ---- NEGATIVE CONTROL: without the marker check, the same re-run double-posts -------
  var MUT = mutate(S_ENGINE,
    'if (noteHasMarker(notes, cmd.idemKey)) return { outcome: "done", result: { skipped: "already-posted" } };',
    'if (false) return { outcome: "done", result: { skipped: "already-posted" } };');
  var S2 = load(MUT);
  S2.gql = mkGql({ notes: [{ content: "prior [bwn:KX] tag", isDeleted: false }] });
  await S2.executeCommand({ verb: "wo.note", woNumber: "100", idemKey: "KX", args: { noteText: "x" } });
  A.eq("CONTROL: disabling the marker check DOES double-post (so the check is load-bearing)", notePostsOf(S2.gql).length, 1);

  // ---- failure classification --------------------------------------------------------
  S.gql = mkGql({ wo: { statusId: 41 }, patchNoSuccess: true });
  var threw = false, cErr = null;
  try { await S.executeCommand({ verb: "wo.status", woNumber: "1", idemKey: "k", args: { statusId: 77 } }); } catch (e) { threw = true; cErr = e; }
  A.ok("a patchWorkOrder success:false throws", threw);
  A.ok("...and is classified NON-retryable (a bad mutation will not fix itself)", S.classifyError(cErr) === false);
  A.ok("a plain transport error is classified retryable", S.classifyError(new Error("network")) === true);

  // ---- describe: the status confirm warns about the clock reset -----------------------
  A.ok("status confirm warns the time-in-status clock resets", /RESETS/.test(S.describeCommand({ verb: "wo.status", woNumber: "5", args: { statusId: 77 } })));

  // ---- transport contract (source-level; the HTTP legs are not vm-run) ----------------
  A.ok("claim sends the dedupAppend capability (so it may drain append verbs)", /capabilities:\s*\{\s*dedupAppend:\s*true\s*\}/.test(full));
  A.ok("posts op:'claim'", /op:\s*"claim"/.test(full));
  A.ok("posts op:'report'", /op:\s*"report"/.test(full));
  A.ok("targets /api/wo-write-queue", /\/api\/wo-write-queue/.test(full));
  A.ok("draining is DISABLED by default (wq_enabled false)", /GM_getValue\("wq_enabled",\s*false\)/.test(full));
  var _mV = full.match(/@version\s+([0-9.]+)/), _mR = full.match(/VER\s*=\s*"([0-9.]+)"/);
  A.ok("@version and runtime VER agree", !!(_mV && _mR && _mV[1] === _mR[1]));

  A.finish();
})().catch(function (e) { console.error(e); process.exit(1); });
