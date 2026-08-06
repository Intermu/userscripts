// test-assist-advance-gate.js - node harness for the Next-Actions CLOSURE AUTO-ADVANCE
// step, added in bwn-suite-core 1.66.35 / WO Assist 2.69 (the lifecycle-gap-map
// "advance to Work Complete" gate in next-actions-overhaul).
//
// THE FEATURE, as built:
//   Jobs rot in confirm-complete after everything needed to close them is already on file.
//   This is the mirror image of the docs:none gate: at confirm-complete, when the
//   completion package IS confidently present (jobDocuments returned a non-empty list) AND
//   no PO is still pending confirmation, surface a step to mark the WO Work Complete. It is
//   a SUGGESTION - text is null, there is no resolve auto-converger - never an auto-check
//   and never an auto-advance. A "docs present" read must not move the WO on its own, the
//   same contract as docs:none, inverted. It also suppresses the confirm-complete phase
//   chase ("collect the completion package") when docs are present, so the checklist stops
//   asking for documents that are already attached.
//
// WHAT THIS PROVES, against the REAL shipped bytes (sliced from bwn-suite-core.user.js and
// run in a vm - nothing here restates the logic):
//   - the step fires ONLY at confirm-complete, ONLY on a confident docs count > 0, and only
//     when no PO is still pending confirmation.
//   - a null (unknown) docs read fires NOTHING - the read failing must never look like a
//     ready-to-close WO.
//   - a confident zero (docs:none's territory) fires nothing here.
//   - it carries no email text and no resolve converger, so it can never auto-complete.
//   - the confirm-complete phase chase is suppressed exactly when docs are present, and NOT
//     when the docs read is unknown or empty (then "collect the package" is still right).
//
// WHAT IT DOES NOT PROVE:
//   - that the coordinator actually advances the status - the step is a prompt, and the
//     live gate is a confirm-complete WO with docs attached showing the step, and the same
//     WO with no docs showing docs:none instead.
//   - the jobDocuments read itself - that is test-docs-api.js.
//
// Every case re-runs against mutated copies of the same source; each mutation MUST turn
// this harness red. mutate() throws if its target is absent or not unique.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-assist-advance-gate.js

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

var S_ADVANCE = slice('      // ---- Closure auto-advance: docs collected', '      var noSched = state.pos.filter(', 'advance step block');
var S_WA = slice('      var waTheme = {', "      if (woPhase !== 'costreview' && state.due", 'wa suppression');

function build(advSrc, waSrc) {
  var sandbox = { Math: Math, console: console };
  vm.createContext(sandbox);
  var src =
    '(function () {\n' +
    'function advanceFrag(woPhase, state, poThemes) {\n  var acts = [], ref = "W-1";\n' + advSrc + '\n  return acts;\n}\n' +
    'function waPush(woPhase, state, poThemes, wa) {\n  var acts = [];\n' + waSrc + '\n  return acts.length;\n}\n' +
    'return { advanceFrag: advanceFrag, waPush: waPush };\n})()';
  return vm.runInContext(src, sandbox, { filename: 'advance-gate.js' });
}

function runCases(advSrc, waSrc) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  function eq(name, got, want) {
    ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
  }

  var m;
  try { m = build(advSrc, waSrc); }
  catch (err) { out.push({ name: 'source loads', ok: false, detail: String(err && err.message || err) }); return out; }

  function adv(woPhase, docs, poThemes) { return m.advanceFrag(woPhase, { docs: docs, hrs: 200 }, poThemes || {}); }

  // --- fires only in the right conditions
  var fire = adv('confirmcomplete', { count: 3, docs: [{}, {}, {}] }, {});
  eq('confirm-complete + docs present + no open confirm -> one step', fire.length, 1);
  eq('and it is the advance step', fire[0].key, 'advance:workcomplete');
  ok('the why cites the document count', (fire[0].why || '').indexOf('3 on file') !== -1, fire[0].why);

  eq('a null (unknown) docs read fires NOTHING', adv('confirmcomplete', null, {}).length, 0);
  eq('a confident zero fires nothing here (that is docs:none)', adv('confirmcomplete', { count: 0, docs: [] }, {}).length, 0);
  eq('cost-review does not get the advance step (confirm-complete only)', adv('costreview', { count: 3, docs: [{}, {}, {}] }, {}).length, 0);
  eq('an in-flight phase does not get it either', adv('onsite', { count: 3, docs: [{}, {}, {}] }, {}).length, 0);
  eq('a PO still pending confirmation blocks the advance', adv('confirmcomplete', { count: 3, docs: [{}, {}, {}] }, { confirm: 1 }).length, 0);

  // --- it can never auto-complete: no email text, no resolve converger
  ok('the advance step carries no ready-to-send text (internal action)', fire[0].text === null, JSON.stringify(fire[0].text));
  ok('and no resolve converger, so nothing auto-checks it', fire[0].resolve === undefined, JSON.stringify(fire[0].resolve));

  // --- suppression of the confirm-complete "collect docs" chase, exactly when docs present
  var wa = { key: 'phase:confirmcomplete' };
  eq('the phase chase is suppressed when docs are present', m.waPush('confirmcomplete', { docs: { count: 3 }, stall: null, noShow: null }, {}, wa), 0);
  eq('but NOT suppressed when the docs read is unknown (collect is still right)', m.waPush('confirmcomplete', { docs: null, stall: null, noShow: null }, {}, wa), 1);
  eq('and NOT suppressed on a confident empty (docs:none blocks, chase still asks)', m.waPush('confirmcomplete', { docs: { count: 0 }, stall: null, noShow: null }, {}, wa), 1);
  eq('the pre-existing scheduled+stall suppression still holds', m.waPush('scheduled', { docs: null, stall: { days: 5 }, noShow: null }, {}, wa), 0);
  eq('and the pre-existing per-PO theme suppression still holds', m.waPush('confirmcomplete', { docs: null, stall: null, noShow: null }, { confirm: 1 }, wa), 0);

  return out;
}

// ---- Negative controls ------------------------------------------------------
var MUTATIONS = [
  { what: 'the advance step firing on a confident-empty docs read',
    adv: function (s) { return mutate(s, 'state.docs.count > 0', 'state.docs.count >= 0'); } },
  { what: 'the advance step escaping the confirm-complete phase',
    adv: function (s) { return mutate(s, "if (woPhase === 'confirmcomplete' && state.docs && state.docs.count > 0 && !poThemes.confirm) {", "if (woPhase !== 'nope' && state.docs && state.docs.count > 0 && !poThemes.confirm) {"); } },
  { what: 'the open-PO-confirm guard dropped (advises closing over an unconfirmed PO)',
    adv: function (s) { return mutate(s, '&& !poThemes.confirm) {', '&& !poThemes.nope) {'); } },
  { what: 'the docs-present suppression of the collect-docs chase removed',
    wa: function (s) { return mutate(s, " || (woPhase === 'confirmcomplete' && state.docs && state.docs.count > 0)", ''); } }
];

function main() {
  console.log('\n-- the shipped closure auto-advance step + suppression --');
  var results = runCases(S_ADVANCE, S_WA);
  results.forEach(function (r) { A.ok(r.name, r.ok, r.detail); });

  console.log('\n-- negative controls: each must turn the cases above red --');
  MUTATIONS.forEach(function (mm) {
    var adv = mm.adv ? mm.adv(S_ADVANCE) : S_ADVANCE;
    var wa = mm.wa ? mm.wa(S_WA) : S_WA;
    var rs;
    try { rs = runCases(adv, wa); }
    catch (err) { rs = [{ name: 'mutant ran', ok: false, detail: String(err && err.message || err) }]; }
    var reds = rs.filter(function (r) { return !r.ok; });
    A.ok('CAUGHT: ' + mm.what, reds.length > 0, reds.length ? '' : 'mutation produced NO failing case - this control proves nothing');
  });

  A.finish();
}

main();
