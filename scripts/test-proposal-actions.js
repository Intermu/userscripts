// test-proposal-actions.js - the write path of bwn-proposal-actions.user.js (Approval / TSP /
// Kickback proposal workflow). Slices the PA-WRITES block out of the REAL .user.js and runs it in a
// vm with an INJECTED paGql (programmable per test), asserting the three newly-pinned mutations'
// request shapes: addClientProposalNote (proposal "billing note"), addTask (entityType 1 / entityId
// = WO# String), completeTask ({ id }). Carries negative controls: disabling a success check no
// longer throws, and changing entityType off 1 is observable - so each assertion is load-bearing.
// Pins: umbrava-graphql-operations.md "Task + entity-NOTE write mutations" (Claude Brain vault).
//
// Run with the Adobe-bundled node (system node is quarantined on this machine):
//   "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-proposal-actions.js
// CI runs: node scripts/test-proposal-actions.js

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var A = require("./assert.js");

var SRC = path.join(__dirname, "..", "bwn-proposal-actions.user.js");
var full = fs.readFileSync(SRC, "utf8").replace(/\r\n/g, "\n");

var START = "// ===== PA-WRITES START";
var END = "// ===== PA-WRITES END";
function slice(src) {
  var a = src.indexOf(START);
  if (a === -1) throw new Error("PA-WRITES START marker not found in bwn-proposal-actions.user.js");
  if (src.indexOf(START, a + 1) !== -1) throw new Error("PA-WRITES START marker not unique");
  var b = src.indexOf(END, a);
  if (b === -1) throw new Error("PA-WRITES END marker not found after start");
  return src.slice(a, b);
}
var ENGINE = slice(full);

// gpLabel lives outside PA-WRITES; slice it on its own markers and eval as a pure function.
function sliceBetween(a0, b0) {
  var a = full.indexOf(a0); if (a === -1) throw new Error("missing marker " + a0);
  var b = full.indexOf(b0, a); if (b === -1) throw new Error("missing marker " + b0);
  return full.slice(a, b);
}
var GPLABEL = sliceBetween("// ===== PA-GPLABEL START", "// ===== PA-GPLABEL END");
function loadGpLabel(src) { var box = { console: console }; vm.createContext(box); vm.runInContext(src, box); return box; }

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error("MUTATION TARGET ABSENT: " + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error("MUTATION TARGET NOT UNIQUE: " + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// A programmable paGql. Records every call {op, query, variables}; returns success:true unless a
// knob says otherwise. The sliced code calls paGql(op, query, variables) and reads d.<field>.
function mkGql(opts) {
  opts = opts || {};
  function paGql(op, query, variables) {
    paGql.calls.push({ op: op, q: query, v: variables });
    var field =
      /addClientProposalNote/.test(query) ? "addClientProposalNote" :
      /addTask/.test(query) ? "addTask" :
      /completeTask/.test(query) ? "completeTask" :
      /patchWorkOrder/.test(query) ? "patchWorkOrder" :
      /addEditJobNote/.test(query) ? "addEditJobNote" : null;
    if (!field) return Promise.resolve({});
    if (opts.fail) return Promise.resolve((function () { var o = {}; o[field] = { success: false, message: "refused" }; return o; })());
    var o = {}; o[field] = { success: true, message: "" };
    return Promise.resolve(o);
  }
  paGql.calls = [];
  return paGql;
}
function load(engineSrc, gql) {
  var sandbox = {
    console: console,
    paGql: gql,
    DRY_RUN: false,
    NOTE_TYPE_INTERNAL: 13,
    textToHtml: function (t) { return "<p>" + String(t == null ? "" : t).replace(/\n/g, "</p><p>") + "</p>"; }
  };
  vm.createContext(sandbox);
  vm.runInContext(engineSrc, sandbox);
  return sandbox;
}
function callsOf(g, op) { return g.calls.filter(function (c) { return c.op === op; }); }

(async function () {
  var g = mkGql();
  var S = load(ENGINE, g);

  A.ok("slice exposes addProposalNote", typeof S.addProposalNote === "function");
  A.ok("slice exposes createTask", typeof S.createTask === "function");
  A.ok("slice exposes completeTask", typeof S.completeTask === "function");
  A.ok("slice exposes completeAllTasks", typeof S.completeAllTasks === "function");

  // ---- gpLabel: threshold at 33% (GP is a FRACTION) ------------------------------------------
  var GL = loadGpLabel(GPLABEL);
  A.eq("gpLabel: 41.07% -> Good GP (was mislabeled 'Low GP' by the old rule)", GL.gpLabel(0.4107), "Good GP");
  A.eq("gpLabel: exactly 33% -> Good GP (at/above the threshold)", GL.gpLabel(0.33), "Good GP");
  A.eq("gpLabel: 32% -> Low GP (below the threshold)", GL.gpLabel(0.32), "Low GP");
  A.eq("gpLabel: 16.7% -> Low GP", GL.gpLabel(0.167), "Low GP");
  A.eq("gpLabel: negative -> Negative GP", GL.gpLabel(-0.1), "Negative GP");
  A.eq("gpLabel: null (read failed) -> GP unknown, never a confident label", GL.gpLabel(null), "GP unknown");
  A.eq("gpLabel: NaN -> GP unknown", GL.gpLabel(NaN), "GP unknown");
  // CONTROL: the 0.33 threshold is load-bearing - raising it flips a 41% proposal back to Low GP
  var GL2 = loadGpLabel(mutate(GPLABEL, "GP_GOOD_THRESHOLD = 0.33", "GP_GOOD_THRESHOLD = 0.99"));
  A.eq("CONTROL: with the threshold at 0.99, 41% reads Low GP (threshold is load-bearing)", GL2.gpLabel(0.4107), "Low GP");

  // ---- addProposalNote: a client-proposal "billing note" keyed by proposal entityId ----------
  var r = await S.addProposalNote(537526, "Good to submit - Low GP - Summary\nTotal\n$2,955.80");
  A.eq("proposal note: resolves true on success", r, true);
  var pc = callsOf(g, "AddClientProposalNote");
  A.eq("proposal note: exactly one mutation issued", pc.length, 1);
  A.eq("proposal note: entityId is the proposal id (number, verbatim)", pc[0].v.data.entityId, 537526);
  A.eq("proposal note: plainTextContent is the raw text", pc[0].v.data.plainTextContent, "Good to submit - Low GP - Summary\nTotal\n$2,955.80");
  A.ok("proposal note: htmlContent is the HTML rendering", /^<p>/.test(pc[0].v.data.htmlContent));
  A.ok("proposal note: does NOT send a WO note (never addEditJobNote)", callsOf(g, "AddEditWONote").length === 0);

  // ---- createTask: addTask, entityType 1, entityId = WO# as String, assignedTo GUID ----------
  g = mkGql(); S = load(ENGINE, g);
  r = await S.createTask(385048, "ff655968-a371-43b9-a199-e66847a54a2a", "Good to submit - Low GP - Summary");
  A.eq("create task: resolves true on success", r, true);
  var tc = callsOf(g, "AddTask");
  A.eq("create task: one mutation issued", tc.length, 1);
  A.eq("create task: entityType is 1 (work order)", tc[0].v.data.entityType, 1);
  A.eq("create task: entityId is the WO number as a STRING", tc[0].v.data.entityId, "385048");
  A.eq("create task: description is the task text", tc[0].v.data.description, "Good to submit - Low GP - Summary");
  A.eq("create task: assignedTo is the coordinator GUID", tc[0].v.data.assignedTo, "ff655968-a371-43b9-a199-e66847a54a2a");
  A.ok("create task: sends a required targetStartDate", typeof tc[0].v.data.targetStartDate === "string" && tc[0].v.data.targetStartDate.length > 0);
  // The REST backend (taskrestapi/api/Task/AddTask) 500s without metadata; the SPA sends both. Captured 2026-08-17.
  A.eq("create task: metadata is the WO number as a JSON string (backend REST requires it)", tc[0].v.data.metadata, JSON.stringify({ number: "385048" }));
  A.eq("create task: notifyCreator false (matches the SPA payload)", tc[0].v.data.notifyCreator, false);

  // assignedTo falls back to null (unassigned) rather than "" or undefined when no GUID
  g = mkGql(); S = load(ENGINE, g);
  await S.createTask(385048, "", "x");
  A.eq("create task: empty assignee -> null (unassigned), never a blank string", callsOf(g, "AddTask")[0].v.data.assignedTo, null);

  // ---- completeTask: CompleteTaskInput is JUST { id } ----------------------------------------
  g = mkGql(); S = load(ENGINE, g);
  r = await S.completeTask("task-guid-1");
  A.eq("complete task: resolves true on success", r, true);
  var cc = callsOf(g, "CompleteTask");
  A.eq("complete task: one mutation issued", cc.length, 1);
  A.eq("complete task: data is exactly { id }", JSON.stringify(cc[0].v.data), JSON.stringify({ id: "task-guid-1" }));

  // ---- completeAllTasks: [] is a trivial success (no call); N tasks -> N completes -----------
  g = mkGql(); S = load(ENGINE, g);
  r = await S.completeAllTasks([]);
  A.eq("complete all: empty list resolves true", r, true);
  A.eq("complete all: empty list issues NO mutation", callsOf(g, "CompleteTask").length, 0);
  g = mkGql(); S = load(ENGINE, g);
  await S.completeAllTasks([{ id: "t1" }, { id: "t2" }]);
  A.eq("complete all: one completeTask per open task", callsOf(g, "CompleteTask").length, 2);

  // ---- failure classification: a success:false throws (not a silent pass) --------------------
  g = mkGql({ fail: true }); S = load(ENGINE, g);
  var threw = false;
  try { await S.addProposalNote(1, "x"); } catch (e) { threw = true; }
  A.ok("proposal note: success:false THROWS", threw);
  g = mkGql({ fail: true }); S = load(ENGINE, g);
  threw = false;
  try { await S.completeTask("t"); } catch (e) { threw = true; }
  A.ok("complete task: success:false THROWS", threw);

  // ---- NEGATIVE CONTROL 1: disabling the success check makes a failed write pass silently -----
  var MUT1 = mutate(ENGINE,
    "if (!r || !r.success) throw new Error((r && r.message) || 'completeTask failed');",
    "if (false) throw new Error((r && r.message) || 'completeTask failed');");
  var g1 = mkGql({ fail: true }); var S1 = load(MUT1, g1);
  var passed = await S1.completeTask("t").then(function () { return true; }, function () { return false; });
  A.ok("CONTROL: without the success check, a success:false does NOT throw (so the check is load-bearing)", passed === true);

  // ---- NEGATIVE CONTROL 2: entityType 1 is load-bearing (the WO entity kind) ------------------
  var MUT2 = mutate(ENGINE, "entityType: 1,", "entityType: 2,");
  var g2 = mkGql(); var S2 = load(MUT2, g2);
  await S2.createTask(385048, "g", "x");
  A.eq("CONTROL: mutating entityType off 1 is observable in the payload", callsOf(g2, "AddTask")[0].v.data.entityType, 2);

  // ---- NEGATIVE CONTROL 3: metadata is load-bearing (dropping it is what 500'd the backend) ---
  var MUT3 = mutate(ENGINE, "metadata: JSON.stringify({ number: String(woNumber) })", "metadata: undefined");
  var g3 = mkGql(); var S3 = load(MUT3, g3);
  await S3.createTask(385048, "g", "x");
  A.ok("CONTROL: without the metadata line the payload loses it (the field the REST backend requires)", callsOf(g3, "AddTask")[0].v.data.metadata === undefined);

  // ---- source-level wiring -------------------------------------------------------------------
  A.ok("no NOT_PINNED stub remains (all three are wired)", !/notPinned\s*\(/.test(full));
  A.ok("pins addClientProposalNote mutation", /addClientProposalNote\(data: \$data\)/.test(full));
  A.ok("pins addTask mutation", /addTask\(data: \$data\)/.test(full));
  A.ok("pins completeTask mutation", /completeTask\(data: \$data\)/.test(full));
  A.ok("no step is left flagged pending (all three now execute)", !/pending: true/.test(full));
  A.ok("every write still honors DRY_RUN", (full.match(/\[PA DRY_RUN\]/g) || []).length >= 5);
  var mV = full.match(/@version\s+([0-9.]+)/), mR = full.match(/VER\s*=\s*'([0-9.]+)'/);
  A.ok("@version and runtime VER agree", !!(mV && mR && mV[1] === mR[1]));
  A.eq("shipped at 0.2.2", mV && mV[1], "0.2.2");

  A.finish();
})().catch(function (e) { console.error(e); process.exit(1); });
