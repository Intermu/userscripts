// test-margin-guardrail.js - the read-only "Margin check" advisory in bwn-proposal-actions.user.js.
//
// Slices the PA-GPLABEL and PA-MARGIN-LOGIC blocks (plus the real escapeHtml one-liner) out of the
// REAL .user.js and runs them in a vm: the margin math, the governance-target parse, and the panel
// markup (marginPanelHtml), including that every Umbrava value is escaped. Negative controls mutate
// the sliced source and require the matching probe to flip, so a green run means the probes bite.
// Not covered here (owed a live Chrome check): the overlay wiring, focus trap, and on-device AI.
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
var ESC = (full.match(/^ {2}function escapeHtml\(s\) \{.*\}$/m) || [])[0];
if (!ESC) throw new Error("escapeHtml one-liner not found");

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error("MUTATION TARGET ABSENT: " + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error("MUTATION TARGET NOT UNIQUE: " + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}
function load(marginSrc) {
  var box = { console: console, Math: Math, Number: Number, String: String, Date: Date, Array: Array,
    Object: Object, JSON: JSON, parseFloat: parseFloat, isFinite: isFinite, isNaN: isNaN };
  vm.createContext(box);
  vm.runInContext(ESC + "\n" + GPLABEL + "\n" + marginSrc, box);
  return box;
}

var NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
var FRESH = NOW - 3600 * 1000;
var STALE = NOW - 25 * 3600 * 1000;
var DEF = { target: 0.33, source: "default" };
function view(o) {
  var v = { n: 1305076, pid: 901, total: "$2,955.80", gpPct: 0.40, cost: 1773.48, biz: DEF, items: { ok: true, categories: ["labor"] } };
  for (var k in o) v[k] = o[k];
  return v;
}

(function () {
  var S = load(MARGIN);

  console.log("\n-- 1. one threshold: the target, defaulting to the shared 33% --");
  A.eq("default target reuses GP_GOOD_THRESHOLD", S.MARGIN_TARGET_DEFAULT, 0.33);
  A.eq("no governance -> default 0.33", S.parseBizRules(null, NOW), DEF);
  A.eq("fresh bizRules.marginTarget is used", S.parseBizRules({ bizRules: { marginTarget: 0.28, ts: FRESH } }, NOW), { target: 0.28, source: "governance" });
  A.eq("margin.marginTarget slot also accepted", S.parseBizRules({ margin: { marginTarget: 0.3 }, ts: FRESH }, NOW).target, 0.3);
  A.eq("a floor key is NOT a second threshold (ignored)", S.parseBizRules({ bizRules: { marginFloor: 0.2, ts: FRESH } }, NOW), DEF);
  A.eq("a generic top-level target key is never read as a margin target", S.parseBizRules({ target: 0.1, ts: FRESH }, NOW), DEF);
  A.eq("stale record (25h) -> default, source stale", S.parseBizRules({ bizRules: { marginTarget: 0.28, ts: STALE } }, NOW), { target: 0.33, source: "stale" });
  A.eq("UNDATED record -> default, source stale (TTL is enforceable)", S.parseBizRules({ bizRules: { marginTarget: 0.28 } }, NOW), { target: 0.33, source: "stale" });
  A.eq("out-of-range target (1.4) -> default", S.parseBizRules({ bizRules: { marginTarget: 1.4, ts: FRESH } }, NOW), DEF);
  A.eq("default target agrees with gpLabel at 32%", [S.marginVerdict(0.32, S.MARGIN_TARGET_DEFAULT).below, S.gpLabel(0.32)], [true, "Low GP"]);
  A.eq("default target agrees with gpLabel at 33%", [S.marginVerdict(0.33, S.MARGIN_TARGET_DEFAULT).below, S.gpLabel(0.33)], [false, "Good GP"]);

  console.log("\n-- 2. verdict compares the DISPLAYED (1-decimal) percent --");
  A.eq("13% vs 28% -> below", S.marginVerdict(0.13, 0.28), { known: true, below: true });
  A.eq("30% vs 28% -> not below", S.marginVerdict(0.30, 0.28).below, false);
  A.eq("exactly 28% -> not below", S.marginVerdict(0.28, 0.28).below, false);
  A.eq("27.96% shows as 28.0% -> not below (no '28.0% below 28.0%')", S.marginVerdict(0.2796, 0.28).below, false);
  A.eq("27.94% shows as 27.9% -> below", S.marginVerdict(0.2794, 0.28).below, true);
  A.eq("null GP -> unknown, never below", S.marginVerdict(null, 0.28), { known: false, below: false });
  A.eq("NaN GP -> unknown", S.marginVerdict(NaN, 0.28).known, false);

  console.log("\n-- 3. categories --");
  var present = S.presentCategories([{ category: "Labor" }, { category: "labor" }, { category: "Material" }, { category: "" }, {}]);
  A.eq("presentCategories dedupes, lowercases, drops blanks", present.sort(), ["labor", "material"]);
  var REQ = ["Labor", "Material", "Travel"];
  A.eq("missing = required minus present", S.missingCategories(present, REQ), ["Travel"]);
  A.eq("nothing present -> all required missing (advisory, no throw)", S.missingCategories(S.presentCategories([]), REQ), REQ);
  A.eq("REQUIRED_CATEGORIES ships empty (enum not captured)", S.REQUIRED_CATEGORIES, []);

  console.log("\n-- 4. dollars --");
  A.eq("295580 minor @2 -> 2955.80", S.moneyToDollars({ amount: 295580, precision: 2 }), 2955.8);
  A.eq("precision defaults to 2", S.moneyToDollars({ amount: 100000 }), 1000);
  A.eq("null money -> null", S.moneyToDollars(null), null);
  A.ok("implied cost 2955.80 x (1 - 0.13)", Math.abs(S.impliedCostDollars(2955.8, 0.13) - 2571.546) < 1e-6);
  A.eq("implied cost with null GP -> null (never invented)", S.impliedCostDollars(1000, null), null);
  A.eq("fmtDollars formats", S.fmtDollars(2571.546), "$2,571.55");
  A.eq("fmtDollars null -> n/a", S.fmtDollars(null), "n/a");

  console.log("\n-- 5. drivers --");
  var d1 = S.marginDrivers(0.134, 0.28, ["Travel"]);
  A.eq("below + missing -> two sentences", d1, ["GP 13.4% is below the 28.0% target.", "Missing priced categories: Travel."]);
  A.ok("negative GP called out", S.marginDrivers(-0.1, 0.28, []).some(function (s) { return /negative/.test(s); }));
  A.eq("at target, nothing missing -> no drivers", S.marginDrivers(0.4, 0.28, []), []);
  A.eq("27.96% vs 28% -> no 'below' driver (rounding agrees with verdict)", S.marginDrivers(0.2796, 0.28, []), []);

  console.log("\n-- 6. panel markup --");
  var ok = S.marginPanelHtml(view({}), S.escapeHtml);
  A.ok("meets-target line", /GP 40\.0% meets the 33\.0% margin target\./.test(ok));
  A.ok("header shows GP percent, not the 33% Low/Good label", /GP 40\.0%<\/div>/.test(ok) && !/Good GP|Low GP/.test(ok));
  A.ok("source says default", /default - no governance target published/.test(ok));
  A.ok("implied cost shown", /\$1,773\.48/.test(ok));
  var low = S.marginPanelHtml(view({ gpPct: 0.13 }), S.escapeHtml);
  A.ok("below target -> alert banner with the driver", /class="warn" role="alert"><strong>Below the margin target/.test(low) && /GP 13\.0% is below the 33\.0% target\./.test(low));
  var unk = S.marginPanelHtml(view({ gpPct: null, cost: null }), S.escapeHtml);
  A.ok("unknown GP -> says it cannot be checked, no banner", /GP could not be read/.test(unk) && !/role="alert"/.test(unk));
  var failed = S.marginPanelHtml(view({ items: { ok: false } }), S.escapeHtml);
  A.ok("failed line-item read is SAID, not shown as '(none)'", /Line items could not be read/.test(failed) && !/Categories on this proposal/.test(failed));
  var none = S.marginPanelHtml(view({ items: { ok: true, categories: [] } }), S.escapeHtml);
  A.ok("successful read with no categories says 'none'", /Categories on this proposal: none\./.test(none));

  console.log("\n-- 7. escaping (every Umbrava value) --");
  var X = '<img src=x onerror=alert(1)>';
  var hostile = S.marginPanelHtml(view({ total: X, pid: X, items: { ok: true, categories: [X] } }), S.escapeHtml);
  A.ok("no raw hostile tag anywhere in the panel", hostile.indexOf("<img") === -1);
  A.ok("hostile category rendered escaped", hostile.indexOf("&lt;img src=x onerror=alert(1)&gt;") !== -1);
  // Drivers carry category names when a required set exists: exercise that path with a fixture set.
  var R = load(mutate(MARGIN, "var REQUIRED_CATEGORIES = [];", "var REQUIRED_CATEGORIES = ['<b>Travel</b>'];"));
  var hostileMissing = R.marginPanelHtml(view({ gpPct: 0.1, items: { ok: true, categories: [] } }), R.escapeHtml);
  A.ok("hostile missing-category text escaped in drivers AND the category line", hostileMissing.indexOf("<b>") === -1 && (hostileMissing.match(/&lt;b&gt;Travel/g) || []).length === 2);

  console.log("\n-- 8. negative controls --");
  var c1 = load(mutate(MARGIN, "var MARGIN_TARGET_DEFAULT = GP_GOOD_THRESHOLD;", "var MARGIN_TARGET_DEFAULT = 0.99;"));
  A.eq("C1 default target is load-bearing", c1.parseBizRules(null, NOW).target, 0.99);
  var c2 = load(mutate(MARGIN, "below: pct1(gpPct) < pct1(target)", "below: pct1(gpPct) > pct1(target)"));
  A.eq("C2 comparison direction is load-bearing", c2.marginVerdict(0.13, 0.28).below, false);
  var c3 = load(mutate(MARGIN, "if (ts == null || (now - ts) > BIZRULES_TTL_MS)", "if (false)"));
  A.eq("C3 staleness guard is load-bearing", c3.parseBizRules({ bizRules: { marginTarget: 0.28, ts: STALE } }, NOW).target, 0.28);
  var c4 = load(mutate(MARGIN, "below: pct1(gpPct) < pct1(target)", "below: gpPct < target"));
  A.eq("C4 raw-fraction compare brings back '28.0% below 28.0%'", c4.marginVerdict(0.2796, 0.28).below, true);
  var c5 = load(mutate(mutate(MARGIN, "return '<li>' + esc(d) + '</li>';", "return '<li>' + d + '</li>';"), "var REQUIRED_CATEGORIES = [];", "var REQUIRED_CATEGORIES = ['<b>Travel</b>'];"));
  A.ok("C5 unescaped drivers leak the raw tag", c5.marginPanelHtml(view({ gpPct: 0.1, items: { ok: true, categories: [] } }), c5.escapeHtml).indexOf("<li>Missing priced categories: <b>Travel") !== -1);
  var c6 = load(mutate(MARGIN, "esc(cats.length ? cats.join(', ') : 'none')", "(cats.length ? cats.join(', ') : 'none')"));
  A.ok("C6 unescaped categories leak the raw tag", c6.marginPanelHtml(view({ items: { ok: true, categories: [X] } }), c6.escapeHtml).indexOf("<img") !== -1);
  var c7 = load(mutate(MARGIN, "var cats = (v.items && v.items.ok) ? v.items.categories : null;", "var cats = (v.items && v.items.categories) || [];"));
  A.ok("C7 without the ok-check a failed read shows as 'none'", /Categories on this proposal: none/.test(c7.marginPanelHtml(view({ items: { ok: false } }), c7.escapeHtml)));

  console.log("\n-- 9. source wiring --");
  A.ok("menu item gated on BWN_MODULES.marginGuardrail === true (default OFF)", /if \(BWN_MODULES\.marginGuardrail === true\)/.test(full));
  A.ok("startMarginCheck refuses while a run is in flight", /function startMarginCheck\(\) \{[\s\S]{0,200}paRefuseWhileRunning\(\)/.test(full));
  A.ok("render takes the shared overlay slot (never wipes a live workflow dialog)", /function renderMarginCheck[\s\S]{0,300}paTakeOverlaySlot\(\)/.test(full));
  A.ok("render uses the shared focus trap", /function renderMarginCheck[\s\S]{0,2000}paArmTrap\(overlay\)/.test(full));
  A.ok("no local focus-trap copy", !/function paFocusTrap/.test(full));
  var fns = sliceBetween("  // ===== margin check (read-only", "  // ===== dropdown UI");
  A.ok("margin runtime block issues no mutation / write wrapper / fetch", !/bwnGqlOp|mutation\s|fetch\(|GM_xmlhttpRequest/.test(fns + MARGIN));
  A.ok("description no longer claims 'no network calls'", !/no network calls/.test(full.split("\n").slice(0, 12).join("\n")));
  var mV = full.match(/@version\s+([0-9.]+)/), mR = full.match(/VER\s*=\s*'([0-9.]+)'/);
  A.ok("@version and runtime VER agree", !!(mV && mR && mV[1] === mR[1]));

  A.finish();
})();
