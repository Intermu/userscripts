// test-vendor-snapshot.js - node harness for the Phase 1 read-only Vendor Snapshot card
// (BWN-VENDOR-SNAPSHOT block in bwn-bid-out.user.js).
//
// WHAT SHIPPED, as sliced from source:
//   A read-only snapshot card mounted at Select-Vendors time, gated on TWO fail-closed gates
//   (Umbrava rank ladder >= supervisor AND the vendorIntel governance flag), showing only
//   exists-now signals from the getAssignableVendors result the panel already loaded, plus a
//   slim id+locationServiceCount read, and ONE explainable, non-automatic suggested vendor.
//
// WHAT THIS HARNESS PROVES (pure, no pixels, no network - slices the shipped bytes and runs the
// real functions in a vm):
//   1. Governance parse fails closed: ONLY {vendorIntel:true} enables; everything else is OFF.
//   2. Rating is count-gated: a 0-sample average is NOT a score ("input-count >= 1 else '-'").
//   3. Metrics never impute: a missing value renders "-", a real 0 renders "0".
//   4. The recommendation is distance-ranked (never rating-ranked), explainable, and never an award.
//   5. Render states: loading (aria-busy skeleton), empty, ok, plus the metrics error+retry and
//      pending sub-states; user text is HTML-escaped; source labels are present.
//   6. SCHEMA PIN: the shipped base VEND_Q equals the recorded canonical shape (drift fails CI),
//      and the slim VS_METRICS_Q carries the vendorAssignmentJobMetrics(locationId){locationServiceCount}
//      selection with the same operation args.
//   7. Two gate integrations: vsGovernance() resolves OFF on any non-happy path; vsRankAllows()
//      honours the ladder (supervisor+ only, unknown/stale = deny).
//
// Every mutation at the end reverts one guard and asserts THIS harness goes red. mutate() throws if
// its target is absent or not unique, so a mutation that fails to apply cannot pass as a green control.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-vendor-snapshot.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var BID_SRC = path.join(__dirname, '..', 'bwn-bid-out.user.js');
function readLF(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }
var bidFull = readLF(BID_SRC);

// ---- slice the shipped block ------------------------------------------------------------------
function slice(text, start, end, what) {
  var a = text.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (text.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = text.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return text.slice(a, b);
}
var BLOCK = slice(bidFull,
  '  // ===== BWN-VENDOR-SNAPSHOT START v1',
  '  // ===== BWN-VENDOR-SNAPSHOT END v1',
  'vendor-snapshot block');

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// ---- canonical escaper (byte-behaviour of the shipped esc; see test-esc-canonical.js) ---------
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// ---- run a block copy in a fresh context with configurable stubs ------------------------------
function runBlock(src, opts) {
  opts = opts || {};
  var store = opts.store || {};
  var ctx = {
    console: console, Date: Date, JSON: JSON, Promise: Promise, String: String, isFinite: isFinite,
    FONT: 'sans-serif',
    esc: esc,
    openState: opts.openState || null,
    document: {
      _l: {},
      addEventListener: function (t, fn) { (this._l[t] = this._l[t] || []).push(fn); },
      body: { contains: function () { return opts.contains !== false; } }
    },
    localStorage: {
      getItem: function (k) { return (k in store) ? store[k] : null; }
    },
    gmGet: opts.gmGet || function () { return Promise.reject(new Error('no gmGet stub')); },
    gql: opts.gql || function () { return Promise.reject(new Error('no gql stub')); }
  };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

console.log('vendor snapshot (Phase 1) - real source\n');

var base = runBlock(BLOCK);

// ---- 1. governance parse: fail closed ---------------------------------------------------------
A.ok('gov: {vendorIntel:true} enables', base.vsParseGovernance({ vendorIntel: true }) === true);
A.ok('gov: {vendorIntel:false} off', base.vsParseGovernance({ vendorIntel: false }) === false);
A.ok('gov: string "true" is NOT true (non-boolean off)', base.vsParseGovernance({ vendorIntel: 'true' }) === false);
A.ok('gov: {} off', base.vsParseGovernance({}) === false);
A.ok('gov: null off', base.vsParseGovernance(null) === false);
A.ok('gov: unrelated key off', base.vsParseGovernance({ other: true }) === false);

// ---- 2. rating count-gate (input-count >= 1 else no score) ------------------------------------
var rlOk = base.vsRatingLabel(4.5, 12);
A.ok('rating: 4.5 over 12 is a score', rlOk.hasScore === true && rlOk.text === '4.5' && rlOk.count === 12 && rlOk.star === '\u2605', JSON.stringify(rlOk));
A.ok('rating: 4.5 over 0 samples is NOT a score', base.vsRatingLabel(4.5, 0).hasScore === false);
A.ok('rating: 0 over 0 is NOT a score', base.vsRatingLabel(0, 0).hasScore === false);
A.ok('rating: null avg is NOT a score', base.vsRatingLabel(null, 5).hasScore === false);
A.ok('rating: negative count is NOT a score', base.vsRatingLabel(4.5, -3).hasScore === false);
A.ok('rating: 3.0 over 1 IS a score', base.vsRatingLabel(3, 1).hasScore === true);
A.ok('rating: no-score label reads "no ratings yet"', base.vsRatingLabel(4, 0).text === 'no ratings yet');

// ---- 3. metrics never impute ------------------------------------------------------------------
A.ok('metric: real 0 renders "0" (a measured value)', base.vsMetricText(0) === '0');
A.ok('metric: 5 renders "5"', base.vsMetricText(5) === '5');
A.ok('metric: null renders "-" (never 0)', base.vsMetricText(null) === '-');
A.ok('metric: undefined renders "-"', base.vsMetricText(undefined) === '-');
A.ok('metric: NaN renders "-"', base.vsMetricText(NaN) === '-');
A.ok('miles: 4.25 renders "4.3 mi"', base.vsMiText(4.25) === '4.3 mi');
A.ok('miles: null renders "-"', base.vsMiText(null) === '-');

// ---- 4. comparable filter + recommendation (distance-ranked, explainable, non-automatic) ------
var vendors = [
  { id: 'n', name: 'Near Co', distanceFromLocation: 5, averageRating: 4.9, ratingCount: 0 },   // shiny 0-sample rating
  { id: 'm', name: 'Mid Co', distanceFromLocation: 22, averageRating: 3.0, ratingCount: 40 },
  { id: 'f', name: 'Far Co', distanceFromLocation: 90, averageRating: 4.8, ratingCount: 100 }
];
var cmp = base.vsComparable({ items: vendors }, 50);
A.ok('comparable: filters vendors beyond the radius', cmp.length === 2 && cmp.map(function (v) { return v.id; }).join(',') === 'n,m');
A.ok('comparable: keeps a null-distance (assignable, unmeasured) vendor',
  base.vsComparable({ items: [{ id: 'x', distanceFromLocation: null }] }, 50).length === 1);

var rec = base.vsPickRecommendation(cmp, { n: 8 });
A.ok('rec: picks the NEAREST vendor, not the highest 0-sample rating', rec && rec.id === 'n', JSON.stringify(rec));
A.ok('rec: why leads with the distance reason', /Closest assignable vendor .*5\.0 mi/.test(rec.why[0]), JSON.stringify(rec.why));
A.ok('rec: a 0-sample rating is reported as "no ratings", never as a score', rec.why[1] === 'No Umbrava ratings on file yet', JSON.stringify(rec.why));
A.ok('rec: service count from the map is stated in plain text', rec.why.some(function (w) { return /8 prior services at this location/.test(w); }), JSON.stringify(rec.why));
A.ok('rec: empty vendors -> null (nothing to suggest)', base.vsPickRecommendation([], null) === null);
var recNoDist = base.vsPickRecommendation([{ id: 'z', name: 'Z', distanceFromLocation: null, averageRating: 5, ratingCount: 3 }], null);
A.ok('rec: no-distance pool falls back to first and SAYS distance unknown', recNoDist && recNoDist.id === 'z' && /no distance on file/.test(recNoDist.why[0]), JSON.stringify(recNoDist));

// ---- 5. model + render states -----------------------------------------------------------------
A.ok('model: no comparable vendors -> empty state', base.vsModel({ items: [] }, 50, null, null).state === 'empty');
var mOk = base.vsModel({ items: vendors }, 50, { n: 8, m: 0 }, 'ok');
A.ok('model: ok state, rows capped, metricsState carried', mOk.state === 'ok' && mOk.rows.length === 2 && mOk.metricsState === 'ok');
A.ok('model: service 0 kept as 0, absent vendor kept as null', mOk.rows[0].service === 8 && mOk.rows[1].service === 0);
var mMiss = base.vsModel({ items: [{ id: 'q', name: 'Q', distanceFromLocation: 3, averageRating: 4, ratingCount: 2 }] }, 50, {}, 'ok');
A.ok('model: a vendor missing from the metrics map is null (renders "-")', mMiss.rows[0].service === null);

var hLoad = base.vsRenderCard({ state: 'loading' });
A.ok('render loading: aria-busy skeleton', /aria-busy="true"/.test(hLoad) && /bwn-bo-vsskel/.test(hLoad));
var hEmpty = base.vsRenderCard({ state: 'empty' });
A.ok('render empty: "No vendors on file" copy', /No vendors on file/.test(hEmpty));
var hErr = base.vsRenderCard({ state: 'ok', metricsState: 'error', recommendation: null, rows: [] });
A.ok('render error: "unavailable" + a real retry BUTTON', /Service history unavailable/.test(hErr) && /<button[^>]*class="bwn-bo-vsretry"/.test(hErr));
var hPend = base.vsRenderCard({ state: 'ok', metricsState: 'pending', recommendation: null, rows: [] });
A.ok('render pending: "Loading service history" note', /Loading service history/.test(hPend));

var hOk = base.vsRenderCard(base.vsModel({ items: vendors }, 50, { n: 8 }, 'ok'));
A.ok('render ok: "Umbrava rating" column label (rating labelled by source)', /Umbrava rating/.test(hOk));
A.ok('render ok: "Suggested:" recommendation present', /Suggested:/.test(hOk));
A.ok('render ok: non-automatic framing "not an award"', /not an award/.test(hOk));
A.ok('render ok: scored row shows star + number', /\u2605<\/span>\s*4\.9/.test(hOk) === false ? /\u2605/.test(hOk) && /4\.9|3\.0/.test(hOk) : true);
A.ok('render ok: a 0-sample row shows "no ratings yet", not a star', /no ratings yet/.test(hOk));
A.ok('render ok: legend names getAssignableVendors as the source', /getAssignableVendors/.test(hOk));
A.ok('render ok: legend names lookupVendors.status for authoritative Active/Inactive', /lookupVendors\.status/.test(hOk));
A.ok('render ok: legend flags compliance / W-9 as pending a captured op', /compliance \/ W-9 = pending a captured op/.test(hOk));

// escaping: a hostile vendor name cannot inject markup
var hXss = base.vsRenderCard(base.vsModel({ items: [{ id: 'p', name: '<script>x</script>', distanceFromLocation: 1, averageRating: 4, ratingCount: 3 }] }, 50, null, 'pending'));
A.ok('render ok: vendor name is HTML-escaped (no raw <script>)', hXss.indexOf('<script>') === -1 && /&lt;script&gt;/.test(hXss));

// ---- 6. schema pin: base VEND_Q + slim VS_METRICS_Q -------------------------------------------
function norm(q) { return String(q).replace(/\s+/g, ' ').trim(); }
// Reconstruct the runtime VEND_Q string from source (it is a '+'-concatenated single-quoted literal)
// WITHOUT eval: concatenate the contents of every single-quoted segment. The query strings carry no
// escaped quotes or backslashes, so a plain segment match is exact.
function extractConcatString(src, name) {
  var m = new RegExp('var\\s+' + name + '\\s*=\\s*([\\s\\S]*?);').exec(src);
  if (!m) throw new Error(name + ' not found in source');
  var parts = m[1].match(/'([^'\\]*)'/g) || [];
  return parts.map(function (p) { return p.slice(1, -1); }).join('');
}
var VEND_Q = extractConcatString(bidFull, 'VEND_Q');
var VEND_Q_CANON = norm(
  'query($t:[ID!]!,$loc:ID!,$type:Int!,$lat:Float,$lng:Float,$take:Int!){ ' +
  'getAssignableVendors(tradeIds:$t, tradeFilterOption:Any, locationId:$loc, workOrderTypeId:$type, ' +
  'locationLatitude:$lat, locationLongitude:$lng, page:{skip:0,take:$take}, ' +
  'sortBy:[{columnName:"distanceFromLocation",direction:ASC}], filter:[]){ value{ rowCount items{ ' +
  'id name distanceFromLocation averageRating ratingCount mainContactInfo{ emailAddress mainPhoneNumber } } } } }');
A.ok('schema pin: shipped VEND_Q matches the recorded canonical shape (drift fails CI)', norm(VEND_Q) === VEND_Q_CANON,
  'shipped=' + norm(VEND_Q));

var MQ = norm(base.VS_METRICS_Q);
A.ok('schema pin: VS_METRICS_Q queries getAssignableVendors', /getAssignableVendors\(/.test(MQ));
A.ok('schema pin: VS_METRICS_Q carries vendorAssignmentJobMetrics(locationId:$loc){ locationServiceCount }',
  /vendorAssignmentJobMetrics\(locationId:\$loc\)\{ locationServiceCount \}/.test(MQ), MQ);
A.ok('schema pin: VS_METRICS_Q selects id (for the by-id map)', /items\{ id vendorAssignmentJobMetrics/.test(MQ), MQ);
A.ok('schema pin: VS_METRICS_Q shares VEND_Q operation args',
  /query\(\$t:\[ID!\]!,\$loc:ID!,\$type:Int!,\$lat:Float,\$lng:Float,\$take:Int!\)/.test(MQ), MQ);

// ---- run: async gate integrations (governance + rank) -----------------------------------------
var SUPER = { ok: true, rank: 3, ts: Date.now() };
var COORD = { ok: true, rank: 2, ts: Date.now() };
var STALE = { ok: true, rank: 5, ts: Date.now() - (7 * 3600 * 1000) };   // older than the 6h TTL

// rank gate is synchronous (reads localStorage)
A.ok('rank: supervisor (3) is allowed', runBlock(BLOCK, { store: { 'bwn:role:last': JSON.stringify(SUPER) } }).vsRankAllows() === true);
A.ok('rank: coordinator (2) is denied', runBlock(BLOCK, { store: { 'bwn:role:last': JSON.stringify(COORD) } }).vsRankAllows() === false);
A.ok('rank: no role slot is denied (fail-closed)', runBlock(BLOCK, {}).vsRankAllows() === false);
A.ok('rank: a stale role record (past TTL) is denied', runBlock(BLOCK, { store: { 'bwn:role:last': JSON.stringify(STALE) } }).vsRankAllows() === false);

function gmGetStub(status, json, reject) {
  return function () { return reject ? Promise.reject(new Error('net')) : Promise.resolve({ status: status, json: json }); };
}
var govOn = runBlock(BLOCK, { gmGet: gmGetStub(200, { vendorIntel: true }) });
var govOff = runBlock(BLOCK, { gmGet: gmGetStub(200, { vendorIntel: false }) });
var gov404 = runBlock(BLOCK, { gmGet: gmGetStub(404, null) });
var govErr = runBlock(BLOCK, { gmGet: gmGetStub(0, null, true) });

Promise.all([
  govOn.vsGovernance().then(function (v) { A.ok('gov fetch: 200 + vendorIntel:true -> ON', v === true); }),
  govOff.vsGovernance().then(function (v) { A.ok('gov fetch: 200 + vendorIntel:false -> OFF', v === false); }),
  gov404.vsGovernance().then(function (v) { A.ok('gov fetch: 404 -> OFF (endpoint not deployed = dark)', v === false); }),
  govErr.vsGovernance().then(function (v) { A.ok('gov fetch: network error -> OFF (fail-closed)', v === false); })
]).then(function () {
  // ---- mutations: revert one guard each, assert the harness reddens -----------------------------
  console.log('\nmutations (each must redden its probe)');

  // M1: drop the count floor - a 0-sample average would masquerade as a score.
  var m1 = runBlock(mutate(BLOCK, 'if (c >= 1 && typeof rating', 'if (c >= 0 && typeof rating'));
  A.ok('M1 removing the count floor makes a 0-sample rating a score', m1.vsRatingLabel(4.5, 0).hasScore === true);

  // M2: impute a missing metric as 0 instead of "-".
  var m2 = runBlock(mutate(BLOCK, "? String(v) : '-'", "? String(v) : '0'"));
  A.ok('M2 imputing null-as-0 breaks the never-impute guard', m2.vsMetricText(null) === '0');

  // M3: rank the recommendation by rating instead of distance. Dataset where nearest != top-rated:
  // near is low-rated, far is high-rated. Real code (distance) picks near; the mutant (rating) picks far.
  var m3vendors = [
    { id: 'near', name: 'Near', distanceFromLocation: 5, averageRating: 3.0, ratingCount: 40 },
    { id: 'far', name: 'Far', distanceFromLocation: 40, averageRating: 4.9, ratingCount: 100 }
  ];
  A.ok('M3 real code picks the NEAR low-rated vendor', base.vsPickRecommendation(m3vendors, null).id === 'near');
  var m3 = runBlock(mutate(BLOCK,
    'return a.distanceFromLocation - b.distanceFromLocation;',
    'return (b.averageRating || 0) - (a.averageRating || 0);'));
  var m3rec = m3.vsPickRecommendation(m3vendors, null);
  A.ok('M3 rating-ranking picks the far high-rated vendor (proves real code ranks by distance)', m3rec.id === 'far', JSON.stringify(m3rec));

  // M4: schema drift - a VEND_Q with a dropped field must fail the canonical pin.
  var driftedFull = mutate(bidFull, 'id name distanceFromLocation averageRating ratingCount', 'id name distanceFromLocation averageRating');
  var driftedQ = extractConcatString(driftedFull, 'VEND_Q');
  A.ok('M4 a VEND_Q that drops ratingCount fails the schema pin', norm(driftedQ) !== VEND_Q_CANON);

  // M5: governance parse accepts a truthy non-true - fail-closed contract broken.
  var m5 = runBlock(mutate(BLOCK, 'json.vendorIntel === true', '!!json.vendorIntel'));
  A.ok('M5 accepting a truthy vendorIntel breaks fail-closed (string "true" would enable)', m5.vsParseGovernance({ vendorIntel: 'true' }) === true);

  console.log('\n(pure render/label/guard + schema pin + gate integrations x real source, 5 mutations.');
  console.log(' Nothing here proves the card RENDERS on a live Umbrava page - that is the live gate.)');
  A.finish();
});
