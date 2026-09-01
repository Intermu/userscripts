// test-wq-catalog-push.js - the phase-2 catalog pusher in bwn-write-queue.user.js. Slices the pure
// mappers (WQ-CAT-PURE) into a vm and asserts the status/user row mapping; pins the wiring at source
// level (the two catalog queries, the catalog route, the version bump, the always-on/throttled push).
// The inactive-user drop carries a negative control.
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
A.ok("catalog push runs on load INDEPENDENT of draining (not gated on enabled())", /setTimeout\(function \(\) \{ wqPushCatalogs\(false\); \}, 5000\)/.test(full));
A.ok("throttled via a wq_catalog_ts stamp", /GM_getValue\("wq_catalog_ts", 0\)/.test(full) && /GM_setValue\("wq_catalog_ts", Date\.now\(\)\)/.test(full));
A.ok("a menu command force-refreshes the catalogs", /refresh Umbrava catalogs now/.test(full));
A.ok("@version and runtime VER are both 0.5.0", /@version\s+0\.5\.0/.test(full) && /VER = "0\.5\.0"/.test(full));

A.finish();
