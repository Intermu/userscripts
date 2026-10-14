// test-wq-catalog-push.js - the phase-2 catalog pusher in bwn-write-queue.user.js. Slices the pure
// mappers (WQ-CAT-PURE) into a vm and asserts the status/user row mapping; pins the wiring at source
// level (the two catalog queries, the catalog route, the version lockstep, the throttle).
// The inactive-user drop carries a negative control.
// Phase 1 PR-A (P1-06, Phase 0 decision 2): the push is SWITCHED OFF. BWN_MODULES.writeQueueCatalog is
// hard-OFF and the gate is the first statement of wqPushCatalogs, so no read and no POST happen; the
// 5 s load-time call is kept and returns at the gate; the "refresh catalogs" menu command is gone.
// Design: outputs/specs/2026-08-14-dashboard-write-enqueue-ui.md (Claude Brain vault).
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-wq-catalog-push.js

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var A = require("./assert.js");

var SRC = path.join(__dirname, "..", "bwn-write-queue.user.js");
var full = fs.readFileSync(SRC, "utf8").replace(/\r\n/g, "\n");

var START = "// WQ-CAT-PURE-BEGIN";
var END = "// WQ-CAT-PURE-END";
function slice(src) {
  var a = src.indexOf(START); if (a === -1) throw new Error("WQ-CAT-PURE-BEGIN missing");
  var b = src.indexOf(END, a); if (b === -1) throw new Error("WQ-CAT-PURE-END missing");
  return src.slice(a, b);
}
function load(engineSrc) {
  var sandbox = { console: console };
  vm.createContext(sandbox);
  vm.runInContext(engineSrc, sandbox);
  return sandbox;
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error("MUTATION TARGET ABSENT: " + JSON.stringify(from.slice(0, 60)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error("MUTATION TARGET NOT UNIQUE: " + JSON.stringify(from.slice(0, 60)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var S = load(slice(full));

// ---- wqMapStatus --------------------------------------------------------------------------
A.eq("status: maps + coerces the id to an int", S.wqMapStatus({ id: "77", name: "Dispatched", isActive: true }), { id: 77, name: "Dispatched", isActive: true });
A.eq("status: isActive defaults true when absent", S.wqMapStatus({ id: 5, name: "Open" }), { id: 5, name: "Open", isActive: true });
A.ok("status: a non-integer id drops the row", S.wqMapStatus({ id: "abc", name: "Bad" }) === null);
A.ok("status: a nameless row drops", S.wqMapStatus({ id: 5, name: "" }) === null);

// ---- wqMapUser ----------------------------------------------------------------------------
A.eq("user: first+last -> name, emailAddress -> email, isTechnician carried",
  S.wqMapUser({ id: "g-1", firstName: "Alice", lastName: "Ops", emailAddress: "alice@x.com", isTechnician: false }),
  { id: "g-1", name: "Alice Ops", email: "alice@x.com", isTechnician: false });
A.ok("user: an inactive user is dropped", S.wqMapUser({ id: "g-2", firstName: "Gone", lastName: "User", isInactive: true }) === null);
A.ok("user: an id-less row drops", S.wqMapUser({ id: "", firstName: "No", lastName: "Id" }) === null);
A.ok("user: a nameless row drops", S.wqMapUser({ id: "g-3", firstName: "", lastName: "" }) === null);
A.ok("user: a technician is kept (flagged), not dropped", (function(){ var u=S.wqMapUser({ id:"g-4", firstName:"Bob", lastName:"Tech", isTechnician:true }); return u && u.isTechnician === true; })());

// ---- negative control: without the isInactive drop, an inactive user leaks in --------------
var MUT = mutate(slice(full), "if(!u||u.isInactive) return null;", "if(!u) return null;");
var S2 = load(MUT);
A.ok("CONTROL: removing the isInactive check lets an inactive user through", S2.wqMapUser({ id: "g-9", firstName: "Gone", lastName: "User", isInactive: true }) !== null);

// ---- source-level wiring ------------------------------------------------------------------
A.ok("pins the workOrderStatuses query", /workOrderStatuses\{ id name isActive \}/.test(full));
A.ok("pins the users directory query", /users\(includeInactiveUsers:false, includeSystemUsers:false\)/.test(full));
A.ok("posts to /api/catalog-ingest", /CATALOG_URL = SWA_BASE \+ "\/api\/catalog-ingest"/.test(full));
A.ok("the 5 s load-time call is kept (it returns at the hard-OFF gate)", /setTimeout\(function \(\) \{ wqPushCatalogs\(false\); \}, 5000\)/.test(full));
A.ok("throttled via a wq_catalog_ts stamp", /GM_getValue\("wq_catalog_ts", 0\)/.test(full) && /GM_setValue\("wq_catalog_ts", Date\.now\(\)\)/.test(full));
A.ok("the force-refresh menu command is GONE (its alert would lie while the push is off)", !/refresh Umbrava catalogs now/.test(full) && full.indexOf("wqPushCatalogs(true)") === -1);
A.ok("@version and runtime VER are in lockstep", (function () { var a = /@version\s+(\S+)/.exec(full), b = /var VER = "([^"]+)"/.exec(full); return !!(a && b && a[1] === b[1]); })());
A.ok("writeQueueCatalog is seeded false unconditionally after the parser", full.indexOf("  BWN_MODULES.writeQueueCatalog = false;") !== -1 && !/if \(!\('writeQueueCatalog' in BWN_MODULES\)\)/.test(full));
A.ok("the hard-OFF gate is the FIRST statement of wqPushCatalogs", full.indexOf("  function wqPushCatalogs(force){\n    if (BWN_MODULES.writeQueueCatalog !== true) return;") !== -1);


// ---- wqPushCatalogs: the body carries userToken, read fresh; empty session sends nothing (guarded) ----
// R3: the sandbox carries BWN_MODULES (the gate reads it); default { writeQueueCatalog: true } keeps the
// body-shape proof below. gqlCalls counts every read, so the OFF runs can assert no read either.
var gqlCalls = 0;
function pushHarness(token, modules, src) {
  src = src || full;
  var a = src.indexOf("  function wqPushCatalogs(force){");
  var b = src.indexOf("\n  }\n", a);
  if (a === -1 || b === -1) throw new Error("wqPushCatalogs not found");
  var posted = [];
  gqlCalls = 0;
  var sb = {
    BWN_MODULES: modules || { writeQueueCatalog: true },
    ingestKey: function () { return "k"; }, authToken: function () { return token; },
    GM_getValue: function () { return 0; }, GM_setValue: function () {}, Date: Date, Promise: Promise,
    CAT_TTL_MS: 1, CAT_STATUS_Q: "s", CAT_USERS_Q: "u", CLIENT: "pilot", CATALOG_URL: "https://swa.example/api/catalog-ingest",
    gql: function (q) { gqlCalls++; return Promise.resolve(q === "s" ? { workOrderStatuses: [{ id: 1, name: "Open", isActive: true }] } : { users: [] }); },
    wqMapStatus: function (s) { return { id: s.id, name: s.name, isActive: true }; }, wqMapUser: function () { return null; },
    gmPost: function (url, headers, body) { posted.push(body); return Promise.resolve({ json: { ok: true } }); }
  };
  vm.createContext(sb);
  vm.runInContext(src.slice(a, b + 4) + "\nthis.wqPushCatalogs = wqPushCatalogs;", sb);
  sb.wqPushCatalogs(true);
  return new Promise(function (res) { setTimeout(function () { res(posted); }, 20); });
}
pushHarness("tok").then(function (posted) {
  A.eq("catalog push: one POST", posted.length, 1);
  A.eq("catalog push: body.userToken is the live token", posted[0] && posted[0].userToken, "tok");
  return pushHarness("");
}).then(function (posted) {
  A.eq("catalog push: empty session is guarded (no POST; the route needs a live session)", posted.length, 0);
  return pushHarness("tok", { writeQueueCatalog: true });
}).then(function (posted) {
  A.eq("catalog push ON (harness can see a push): 2 gql reads", gqlCalls, 2);
  A.eq("catalog push ON: 1 POST", posted.length, 1);
  return pushHarness("tok", {});
}).then(function (posted) {
  A.eq("catalog push OFF ({}): ZERO gql reads", gqlCalls, 0);
  A.eq("catalog push OFF ({}): ZERO gmPost", posted.length, 0);
  return pushHarness("tok", { writeQueueCatalog: false });
}).then(function (posted) {
  A.eq("catalog push OFF (writeQueueCatalog:false): ZERO gql reads", gqlCalls, 0);
  A.eq("catalog push OFF (writeQueueCatalog:false): ZERO gmPost", posted.length, 0);
  // CONTROL: the gate line removed -> the OFF run reads (and posts) again.
  var noGate = mutate(full, "    if (BWN_MODULES.writeQueueCatalog !== true) return;   // hard-OFF: no read, no POST\n", "");
  return pushHarness("tok", { writeQueueCatalog: false }, noGate);
}).then(function (posted) {
  A.ok("CONTROL: without the gate, writeQueueCatalog:false still reads + posts (\"zero gql when off\" goes red)", gqlCalls === 2 && posted.length === 1, "gql=" + gqlCalls + " posts=" + posted.length);
  A.finish();
});
