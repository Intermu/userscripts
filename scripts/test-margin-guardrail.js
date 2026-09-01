// test-margin-guardrail.js - the Phase-1 ADVISORY margin guardrail in bwn-proposal-actions.user.js.
//
// This feature is READ-ONLY: it displays GP% vs the governance floor/target, a below-floor banner,
// missing-priced-category detection, and (optional) on-device-AI scope-gap questions. It routes
// through NO mutation. The enforced exception-approval WRITE path is DEFERRED (see the TODO block in
// the userscript). So this harness proves the PURE guardrail MATH only - the DOM panel, the governance
// fetch, and the on-device AI are best-effort UI and are owed a live Chrome check, not asserted here.
//
// It slices the PA-GPLABEL and PA-MARGIN-LOGIC blocks out of the REAL .user.js and runs them together
// in a vm (so MARGIN_FLOOR_DEFAULT reads the shared GP_GOOD_THRESHOLD = 0.33). Negative controls mutate
// the sliced source and require the matching probe to flip, so a green run means the probes bite.
//
// Run with the Adobe-bundled node (system node is quarantined on this machine):
//   "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-margin-guardrail.js
// CI runs: node scripts/test-margin-guardrail.js

var fs = require("fs");
var path = require("path");
var vm = require("vm");
var A = require("./assert.js");

var SRC = path.join(__dirname, "..", "bwn-proposal-actions.user.js");
var full = fs.readFileSync(SRC, "utf8").replace(/\r\n/g, "\n");

function sliceBetween(a0, b0) {
  var a = full.indexOf(a0); if (a === -1) throw new Error("missing marker " + a0);
  if (full.indexOf(a0, a + 1) !== -1) throw new Error("marker not unique: " + a0);
  var b = full.indexOf(b0, a); if (b === -1) throw new Error("missing marker " + b0);
  return full.slice(a, b);
}
var GPLABEL = sliceBetween("// ===== PA-GPLABEL START", "// ===== PA-GPLABEL END");
var MARGIN = sliceBetween("// ===== PA-MARGIN-LOGIC START", "// ===== PA-MARGIN-LOGIC END");

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error("MUTATION TARGET ABSENT: " + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error("MUTATION TARGET NOT UNIQUE: " + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// Load GPLABEL + MARGIN together into one vm context; expose the declared fns/vars as box props.
function load(marginSrc) {
  var box = {
    console: console, Math: Math, Number: Number, String: String, Date: Date,
    Array: Array, Object: Object, JSON: JSON,
    parseFloat: parseFloat, isFinite: isFinite, isNaN: isNaN
  };
  vm.createContext(box);
  vm.runInContext(GPLABEL + "\n" + marginSrc, box);
  return box;
}

(function () {
  var S = load(MARGIN);

  A.ok("slice exposes gpLabel", typeof S.gpLabel === "function");
  A.ok("slice exposes parseBizRules", typeof S.parseBizRules === "function");
  A.ok("slice exposes marginVerdict", typeof S.marginVerdict === "function");
  A.ok("slice exposes presentCategories", typeof S.presentCategories === "function");
  A.ok("slice exposes missingCategories", typeof S.missingCategories === "function");
  A.ok("slice exposes moneyToDollars", typeof S.moneyToDollars === "function");
  A.ok("slice exposes impliedCostDollars", typeof S.impliedCostDollars === "function");
  A.ok("slice exposes marginDrivers", typeof S.marginDrivers === "function");

  // ---- 1. GP label boundaries (gpPct is a FRACTION; threshold 0.33) --------------------------
  console.log("\n-- 1. GP label boundaries --");
  A.eq("gpLabel: -0.01 -> Negative GP", S.gpLabel(-0.01), "Negative GP");
  A.eq("gpLabel: 0.32 -> Low GP (below the 0.33 floor)", S.gpLabel(0.32), "Low GP");
  A.eq("gpLabel: 0.33 -> Good GP (at the floor)", S.gpLabel(0.33), "Good GP");
  A.eq("gpLabel: null -> GP unknown (a failed read stays visible)", S.gpLabel(null), "GP unknown");
  A.eq("gpLabel: NaN -> GP unknown", S.gpLabel(NaN), "GP unknown");
  A.eq("MARGIN_FLOOR_DEFAULT reuses the shared GP_GOOD_THRESHOLD (0.33)", S.MARGIN_FLOOR_DEFAULT, 0.33);

  // ---- 2. below-floor vs a fixture biz-rules target (0.28) + stale fallback -------------------
  console.log("\n-- 2. below-floor vs governance target (fixture 0.28) + stale/absent fallback --");
  var biz = S.parseBizRules({ bizRules: { marginFloor: 0.28, marginTarget: 0.28 } }, Date.now());
  A.eq("parseBizRules: fixture target parsed to 0.28", biz.target, 0.28);
  A.eq("parseBizRules: fixture floor parsed to 0.28", biz.floor, 0.28);
  A.eq("parseBizRules: a parsed record is sourced 'governance'", biz.source, "governance");

  A.eq("belowFloor: GP 13% is below the 28% target", S.marginVerdict(0.13, biz.target).below, true);
  A.eq("belowFloor: GP 13% is a KNOWN verdict", S.marginVerdict(0.13, biz.target).known, true);
  A.eq("belowFloor: GP 30% is NOT below the 28% target", S.marginVerdict(0.30, biz.target).below, false);
  A.eq("belowFloor: GP exactly 28% is NOT below (strict <)", S.marginVerdict(0.28, biz.target).below, false);
  A.eq("belowFloor: null GP is UNKNOWN, never a confident 'below'", S.marginVerdict(null, biz.target).known, false);
  A.eq("belowFloor: null GP does not report below", S.marginVerdict(null, biz.target).below, false);

  // stale-target fallback to 0.33 (record older than the TTL)
  var staleTs = Date.now() - (25 * 3600 * 1000);   // 25h old, past the 24h TTL
  var stale = S.parseBizRules({ ts: staleTs, bizRules: { marginTarget: 0.28 } }, Date.now());
  A.eq("stale biz-rules -> default floor 0.33", stale.target, 0.33);
  A.eq("stale biz-rules -> source 'stale'", stale.source, "stale");
  // absent / unusable -> default floor 0.33
  A.eq("null governance -> default target 0.33", S.parseBizRules(null, Date.now()).target, 0.33);
  A.eq("null governance -> source 'default'", S.parseBizRules(null, Date.now()).source, "default");
  A.eq("out-of-range target (1.4, not a fraction) -> falls back to default", S.parseBizRules({ marginTarget: 1.4 }, Date.now()).target, 0.33);

  // ---- 3. missing-category set from fixture categories (enum is a FIXTURE; real enum TODO) ----
  console.log("\n-- 3. missing-category set difference (presence-by-category, case-insensitive) --");
  var present = S.presentCategories([{ category: "Labor" }, { category: "labor" }, { category: "Material" }, { category: "" }, {}]);
  A.eq("presentCategories: dedupes + normalizes, drops blanks/undefined", present.sort(), ["labor", "material"]);
  var REQ = ["Labor", "Material", "Travel"];   // FIXTURE required set - the REAL enum is uncaptured (TODO in the userscript)
  A.eq("missing = required \\ present -> ['Travel'] (case-insensitive match on Labor/Material)", S.missingCategories(present, REQ), ["Travel"]);
  A.eq("missing when everything present -> []", S.missingCategories(["labor", "material", "travel"], REQ), []);
  // the live REQUIRED_CATEGORIES ships EMPTY so no FALSE warning fires until the enum is captured
  A.eq("REQUIRED_CATEGORIES ships empty (enum capture pending) -> live panel emits no false missing-category", S.REQUIRED_CATEGORIES, []);

  // ---- 4. empty line items -> ALL required missing, as an ADVISORY (array, never a throw) -----
  console.log("\n-- 4. empty line items -> all-required-missing advisory (not an error) --");
  var threw = false, res = null;
  try { res = S.missingCategories(S.presentCategories([]), REQ); } catch (e) { threw = true; }
  A.ok("empty line items does NOT throw", !threw);
  A.eq("empty line items -> every required category is reported missing", res, ["Labor", "Material", "Travel"]);
  A.eq("empty line items with an EMPTY required set -> nothing missing (the live default)", S.missingCategories([], []), []);

  // ---- 5. dollar view: revenue (minor-units -> dollars) + implied cost from GP% ---------------
  console.log("\n-- 5. dollar view (Money minor-units -> dollars; implied cost from GP%) --");
  A.eq("moneyToDollars: 295580 minor @ precision 2 -> 2955.80", S.moneyToDollars({ amount: 295580, precision: 2 }), 2955.80);
  A.eq("moneyToDollars: null money -> null", S.moneyToDollars(null), null);
  A.eq("moneyToDollars: default precision 2 when absent", S.moneyToDollars({ amount: 100000 }), 1000);
  var cost = S.impliedCostDollars(2955.80, 0.13);
  A.ok("impliedCost: 2955.80 * (1 - 0.13) ~= 2571.55", Math.abs(cost - 2571.546) < 1e-6, "got " + cost);
  A.eq("impliedCost: null revenue -> null", S.impliedCostDollars(null, 0.13), null);
  A.eq("impliedCost: null GP -> null (never fabricated)", S.impliedCostDollars(1000, null), null);

  // ---- 6. plain-text drivers for the below-floor banner ---------------------------------------
  console.log("\n-- 6. below-floor drivers are plain TEXT sentences --");
  var d1 = S.marginDrivers(0.134, 0.28, ["Travel"]);
  A.ok("driver: names the GP vs target gap in words", d1.some(function (s) { return /GP 13\.4% is below the 28\.0% target/.test(s); }), JSON.stringify(d1));
  A.ok("driver: lists the missing category in words", d1.some(function (s) { return /Missing priced categories: Travel/.test(s); }), JSON.stringify(d1));
  var d2 = S.marginDrivers(-0.10, 0.28, []);
  A.ok("driver: negative GP is called out explicitly", d2.some(function (s) { return /negative/.test(s); }), JSON.stringify(d2));
  A.eq("driver: an at-target proposal with all categories has NO drivers", S.marginDrivers(0.40, 0.28, []).length, 0);

  // ---- 7. negative controls (each must flip its probe) ----------------------------------------
  console.log("\n-- 7. negative controls --");
  // C1: the default floor is load-bearing - move it to 0.99 and the default target follows.
  var c1 = load(mutate(MARGIN, "var MARGIN_FLOOR_DEFAULT = (typeof GP_GOOD_THRESHOLD === 'number' ? GP_GOOD_THRESHOLD : 0.33);",
    "var MARGIN_FLOOR_DEFAULT = 0.99;"));
  A.eq("C1: with the default at 0.99, an absent governance target reads 0.99 (default is load-bearing)", c1.parseBizRules(null, Date.now()).target, 0.99);
  // C2: the below-floor comparison direction is load-bearing - flip < to > and a below case flips.
  var c2 = load(mutate(MARGIN, "return { known: true, below: gpPct < target };", "return { known: true, below: gpPct > target };"));
  A.eq("C2: flipping the comparison makes 13% read NOT-below (direction is load-bearing)", c2.marginVerdict(0.13, 0.28).below, false);
  // C3: the stale TTL is load-bearing - drop the staleness guard and a stale record is trusted.
  var c3 = load(mutate(MARGIN, "if (ts != null && (now - ts) > BIZRULES_TTL_MS) { d.source = 'stale'; return d; }", "void 0;"));
  A.eq("C3: without the staleness guard, a 25h-old target is (wrongly) trusted at 0.28", c3.parseBizRules({ ts: staleTs, bizRules: { marginTarget: 0.28 } }, Date.now()).target, 0.28);

  // ---- 8. source-level wiring: advisory is READ-ONLY, flag-gated, no fabricated split ---------
  console.log("\n-- 8. source wiring (read-only, flag-gated, deferred write) --");
  A.ok("the Margin check item is gated on BWN_MODULES.marginGuardrail === true (default OFF)", /BWN_MODULES\.marginGuardrail === true/.test(full));
  A.ok("the panel renders 'component breakdown unavailable' rather than inventing a split", /component breakdown unavailable/i.test(full));
  A.ok("REQUIRED_CATEGORIES ships empty in source (enum capture pending)", /var REQUIRED_CATEGORIES = \[\];/.test(full));
  A.ok("the PURE margin slice contains NO mutation and NO write wrapper (advisory only)", !/bwnGqlOp|mutation\s+[A-Za-z]/.test(MARGIN));
  A.ok("the enforced write path is DEFERRED as a TODO, not built", /TODO\(write-path\)/.test(full) && /marginApproval/.test(full));
  var mV = full.match(/@version\s+([0-9.]+)/), mR = full.match(/VER\s*=\s*'([0-9.]+)'/);
  A.ok("@version and runtime VER agree", !!(mV && mR && mV[1] === mR[1]), "version " + (mV && mV[1]) + " vs VER " + (mR && mR[1]));
  A.eq("shipped at 0.5.0", mV && mV[1], "0.5.0");

  A.finish();
})();
