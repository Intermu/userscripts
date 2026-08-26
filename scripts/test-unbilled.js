// test-unbilled.js - node harness for the T8-B1 unbilled / completion-mismatch rule in
// computeNextActions (bwn-suite-core). Slices the REAL shipped block and runs it in a vm.
// NO GraphQL write is involved.
//
// THE RULE: Work Complete is terminal for this tool, but a WO that has sat Work Complete past
// unbilledStaleDays (config, default 3) with no billing movement is unbilled revenue the
// coordinator owns. Emit ONE 'advance to invoicing' row plus the standing completion anchor,
// then return - the full playbook is not opened for a finished WO.
//
// WHAT THIS PROVES:
//   - fires on Work Complete past the stale window -> exactly the unbilled row + anchor;
//   - silent when the status is Invoiced (not work-complete) or still fresh (within the window);
//   - the days figure and key derive from state.hrs; the threshold is read from config (default
//     3 when the key is absent).
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-unbilled.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var core = fs.readFileSync(path.join(__dirname, '..', 'bwn-suite-core.user.js'), 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = core.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (core.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = core.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return core.slice(a, b);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var S_B1 = slice('      // ---- Unbilled: work complete but no billing movement (T8-B1',
  '      // Terminal phase, OR an unmapped/custom status that reads as terminal', 'B1 block');

function build(mutations) {
  var b1 = S_B1;
  (mutations || []).forEach(function (m) { b1 = mutate(b1, m[0], m[1]); });
  var sandbox = { Math: Math, String: String, console: console };
  // The B1 block ends in a `return acts;` when it fires; the trailing return covers the clear case.
  var src = 'this.__b1 = function (state, C) { var acts = [], ref = "W-1";\n' + b1 + '\n  return acts; };\n';
  vm.runInNewContext(src, sandbox, { filename: 'b1.js' });
  return sandbox.__b1;
}

function runCases(mutations) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  function eq(name, got, want) { ok(name, got === want, 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }

  var b1;
  try { b1 = build(mutations); }
  catch (err) { out.push({ name: 'source loads', ok: false, detail: String(err && err.message || err) }); return out; }

  // B1-fire: Work Complete, 100h (>3d) -> unbilled row + anchor, playbook not opened
  var fire = b1({ status: 'Work Complete', hrs: 100 }, { unbilledStaleDays: 3 });
  eq('B1-fire: exactly the unbilled row + anchor (playbook not opened)', fire.length, 2);
  eq('the first row is the unbilled advance-to-invoicing row', fire[0] && fire[0].key, 'unbilled:4');
  ok('its label names the advance', fire[0] && /Advance to invoicing/.test(fire[0].label), fire[0] && fire[0].label);
  ok('the second row is the unbilled completion anchor', fire[1] && fire[1].key === 'anchor:unbilled' && fire[1].anchor === true, JSON.stringify(fire[1]));

  // B1-clear: Invoiced is not work-complete -> nothing
  eq('B1-clear: an Invoiced WO produces no unbilled row', b1({ status: 'Invoiced', hrs: 100 }, { unbilledStaleDays: 3 }).length, 0);

  // fresh: Work Complete but within the window -> nothing yet
  eq('a just-completed WO (within the window) is silent', b1({ status: 'Work Complete', hrs: 50 }, { unbilledStaleDays: 3 }).length, 0);

  // null hrs -> nothing (guard)
  eq('an unknown hours-in-status fires nothing', b1({ status: 'Work Complete', hrs: null }, { unbilledStaleDays: 3 }).length, 0);

  // config threshold honored: a longer window suppresses the same age
  eq('a longer unbilledStaleDays suppresses the same age', b1({ status: 'Work Complete', hrs: 100 }, { unbilledStaleDays: 10 }).length, 0);

  // default 3 when the config key is absent
  eq('the default window (3d) applies when the config key is absent', b1({ status: 'Work Complete', hrs: 100 }, {}).length, 2);

  // case-insensitive status match
  eq('the status match is case-insensitive', b1({ status: 'WORK COMPLETE', hrs: 100 }, {}).length, 2);

  return out;
}

var MUTATIONS = [
  { what: 'the work-complete status test forced true (fires on any status)',
    m: ["/\\bwork\\s*complete\\b/i.test(state.status || '')", 'true'] },
  { what: 'the stale-window threshold dropped (fires on a fresh WO)',
    m: ['state.hrs > unbilledStaleDays * 24', 'state.hrs >= 0'] },
  { what: 'the config threshold ignored (hardcoded), so a longer window no longer suppresses',
    m: ['(C && C.unbilledStaleDays != null) ? C.unbilledStaleDays : 3', '3'] }
];

function main() {
  console.log('\n-- the T8-B1 unbilled / completion-mismatch rule --');
  runCases(null).forEach(function (r) { A.ok(r.name, r.ok, r.detail); });

  console.log('\n-- negative controls: each must turn a case above red --');
  MUTATIONS.forEach(function (mm) {
    var rs;
    try { rs = runCases([mm.m]); }
    catch (err) { rs = [{ name: 'mutant ran', ok: false, detail: String(err && err.message || err) }]; }
    var reds = rs.filter(function (r) { return !r.ok; });
    A.ok('CAUGHT: ' + mm.what, reds.length > 0, reds.length ? '' : 'mutation produced NO failing case');
  });

  A.finish();
}

main();
