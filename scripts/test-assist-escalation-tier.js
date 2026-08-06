// test-assist-escalation-tier.js - node harness for the Next-Actions TIERED, ROLE-AWARE
// escalation mapping, shipped in bwn-suite-core 1.66.34 / WO Assist 2.68 (Phase 3 of
// next-actions-overhaul).
//
// THE FEATURE, as found in source:
//   The flat "Escalate to management" step now scales on TWO independent axes.
//     - SEVERITY + PRIORITY pick the TIER: level 2 (supervisor) for a fresh escalation,
//       level 3 (management decision) once it is >=2x past the clock OR a P1 emergency.
//     - The reader's OWN RANK picks the RECIPIENT: a coordinator (rank <=2 or unknown)
//       escalates UP to a supervisor then management; a supervisor (3-4) has nobody above
//       but management, so both levels route there; a director (>=5) owns the call.
//   The key carries the tier (escalate:<phase>:<tier>) so a heavier escalation re-opens a
//   step that was checked at a lighter tier - reopening early is the safe direction.
//   The rank read (bwnEscRank) is @grant-none-safe: it reads ONLY the bwn:role bus event
//   (trusted, fetched for this user this session) and the bwn:role:last localStorage slot.
//   Core never fetches a role itself - that would need cross-origin GM_*/@connect it does
//   not have - so an absent publisher degrades to plain "Escalate to management", never a
//   wrong access decision. This is UX phrasing only, never an access boundary.
//
// WHAT THIS PROVES, against the REAL shipped bytes (sliced from bwn-suite-core.user.js
// and run in a vm - nothing here restates the logic):
//   - tier is severity/priority-driven; recipient is rank-driven, and the two are
//     independent (a supervisor at a light miss still routes to management at tier 2).
//   - a coordinator sees supervisor at a light miss, management once sev>=2 or P1.
//   - a director gets "own the call" (tierName "decision"), nobody to escalate to.
//   - a heavier severity yields a different tier number, so the step key reopens.
//   - bwnEscRank prefers the in-memory bus value, honours the localStorage slot only
//     while fresh (6h TTL) and ok, and returns null otherwise - and NEVER makes a network
//     call (asserted against the source text itself).
//
// WHAT IT DOES NOT PROVE:
//   - that the bwn:role publisher (the AI role script) is installed on any given machine.
//     When it is absent bwnEscRank returns null and the coordinator path is used - which
//     is the safe default this harness pins.
//   - the escalate FIRE conditions / severity math - that is test-assist-priority-clock.js.
//
// Every case re-runs against mutated copies of the same source; each mutation MUST turn
// this harness red. mutate() throws if its target is absent or not unique.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-assist-escalation-tier.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var CORE_SRC = path.join(__dirname, '..', 'bwn-suite-core.user.js');
var coreFull = fs.readFileSync(CORE_SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = coreFull.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (coreFull.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = coreFull.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  if (coreFull.indexOf(end, b + 1) !== -1) throw new Error(what + ': END marker not unique');
  return coreFull.slice(a, b);
}

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var S_RANK = slice('    var _bwnEscRank = null;', '    // Tiered, role-aware escalation target.', 'bwnEscRank');
var S_TIER = slice('    function bwnEscalationTier(sev, prioNum, rank) {', '    // Impure wrapper: assembles', 'bwnEscalationTier');

function build(rankSrc, tierSrc) {
  var store = {};
  var handlers = [];
  var sandbox = {
    JSON: JSON, Date: Date, console: console, Object: Object,
    localStorage: { getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; } },
    document: { addEventListener: function (n, cb) { handlers.push(cb); } }
  };
  vm.createContext(sandbox);
  var api = vm.runInContext(
    '(function () {\n' + rankSrc + '\n' + tierSrc + '\n' +
    'return { bwnEscRank: bwnEscRank, bwnEscalationTier: bwnEscalationTier };\n})()',
    sandbox, { filename: 'esc-tier.js' });
  return {
    escRank: api.bwnEscRank,
    tier: api.bwnEscalationTier,
    setSlot: function (obj) { store['bwn:role:last'] = JSON.stringify(obj); },
    clearSlot: function () { delete store['bwn:role:last']; },
    fireRole: function (detail) { handlers.forEach(function (cb) { cb({ detail: detail }); }); }
  };
}

function runCases(rankSrc, tierSrc) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  function eq(name, got, want) {
    ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  }

  var m;
  try { m = build(rankSrc, tierSrc); }
  catch (err) { out.push({ name: 'source loads', ok: false, detail: String(err && err.message || err) }); return out; }

  // --- tier mapping: recipient (rank) is independent of tier number (severity/priority)
  var coordLight = m.tier(1, 3, null);   // coordinator/unknown, fresh escalation, P3
  eq('coordinator + light miss -> tier 2', coordLight.tier, 2);
  eq('and routes to the supervisor', coordLight.owner, 'supervisor');

  var coordHeavy = m.tier(2, 3, null);   // >=2x past the clock
  eq('coordinator + heavy miss -> tier 3', coordHeavy.tier, 3);
  eq('and routes to management', coordHeavy.owner, 'management');

  var coordP1 = m.tier(1, 1, null);      // P1 emergency, even on a fresh escalation
  eq('a P1 forces tier 3 regardless of severity', coordP1.tier, 3);
  eq('and routes to management', coordP1.owner, 'management');

  var supLight = m.tier(1, 3, 4);        // a supervisor (rank 4)
  eq('a supervisor at a light miss keeps the light TIER number', supLight.tier, 2);
  eq('but the recipient is management (nobody above them to flag)', supLight.owner, 'management');

  var director = m.tier(3, 1, 6);        // a director (rank >=5)
  eq('a director owns the call, whatever the tier', director.owner, 'director');
  eq('and the tier name reads "decision", not a recipient', director.tierName, 'decision');
  ok('the director label is make-the-call, not escalate', /own the call/i.test(director.label), director.label);

  ok('a heavier severity changes the tier number, so the key reopens',
    m.tier(1, 3, null).tier !== m.tier(2, 3, null).tier, 'both were ' + m.tier(1, 3, null).tier);

  // --- bwnEscRank: source of truth + freshness, and NO network
  m.clearSlot();
  eq('no slot and no event -> unknown rank (null)', m.escRank(), null);

  m.setSlot({ ok: true, rank: 4, ts: Date.now() - 60 * 1000 });
  eq('a fresh, ok slot is honoured', m.escRank(), 4);

  m.setSlot({ ok: true, rank: 4, ts: Date.now() - 7 * 3600 * 1000 });
  eq('a slot past the 6h TTL is ignored', m.escRank(), null);

  m.setSlot({ ok: false, rank: 4, ts: Date.now() - 60 * 1000 });
  eq('a not-ok slot is ignored', m.escRank(), null);

  // the bus event is trusted live and wins over any slot (checked in-memory first)
  m.setSlot({ ok: true, rank: 2, ts: Date.now() - 60 * 1000 });
  m.fireRole({ id: 'bwn:role', rank: 5 });
  eq('the live bus event wins over the slot', m.escRank(), 5);
  m.fireRole({ id: 'something-else', rank: 9 });
  eq('an unrelated bus event does not move the rank', m.escRank(), 5);

  ok('bwnEscRank makes NO network call (no fetch / XHR / GM in its source)',
    !/fetch\s*\(|XMLHttpRequest|GM_xmlhttpRequest/.test(rankSrc), 'source references a network primitive');
  ok('it reads the role from the bwn:role:last slot', rankSrc.indexOf('bwn:role:last') !== -1);
  ok('and latches the bwn:role bus event', rankSrc.indexOf("'bwn:role'") !== -1);

  return out;
}

// ---- Negative controls ------------------------------------------------------
var MUTATIONS = [
  { what: 'severity/priority no longer escalates the tier number',
    tier: function (s) { return mutate(s, 'var level = (sev >= 2 || prioNum === 1) ? 3 : 2;', 'var level = (false) ? 3 : 2;'); } },
  { what: 'the director "own the call" branch removed',
    tier: function (s) { return mutate(s, 'if (rank !== null && rank >= 5) {', 'if (false) {'); } },
  { what: 'a supervisor no longer routed straight to management',
    tier: function (s) { return mutate(s, '} else if (rank !== null && rank >= 3) {', '} else if (false) {'); } },
  { what: 'the TTL freshness check dropped (a stale rank is trusted)',
    rank: function (s) { return mutate(s, '(Date.now() - r.ts) < BWN_ROLE_TTL_MS', 'true'); } },
  { what: 'the ok flag dropped (a not-ok slot is trusted)',
    rank: function (s) { return mutate(s, 'if (r && r.ok && typeof r.rank === \'number\'', 'if (r && typeof r.rank === \'number\''); } }
];

function main() {
  console.log('\n-- the shipped tiered, role-aware escalation mapping --');
  var results = runCases(S_RANK, S_TIER);
  results.forEach(function (r) { A.ok(r.name, r.ok, r.detail); });

  console.log('\n-- negative controls: each must turn the cases above red --');
  MUTATIONS.forEach(function (mm) {
    var rank = mm.rank ? mm.rank(S_RANK) : S_RANK;
    var tier = mm.tier ? mm.tier(S_TIER) : S_TIER;
    var rs;
    try { rs = runCases(rank, tier); }
    catch (err) { rs = [{ name: 'mutant ran', ok: false, detail: String(err && err.message || err) }]; }
    var reds = rs.filter(function (r) { return !r.ok; });
    A.ok('CAUGHT: ' + mm.what, reds.length > 0, reds.length ? '' : 'mutation produced NO failing case - this control proves nothing');
  });

  A.finish();
}

main();
