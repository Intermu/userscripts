// test-ecdrisk.js - node harness for the T8-A1 composite ECD-risk rule in
// computeNextActions (bwn-suite-core). Slices the REAL shipped block + the real parseUSDate
// and runs them in a vm; nothing here restates the logic. NO GraphQL write is involved.
//
// THE RULE: when the expected completion date is within 24h, active PO work exists, no vendor
// visit is CONFIRMED (a structured schedDate on a non-'accept' PO) and nothing marks the WO
// complete, emit an urgent 'ecdrisk' vendor-chase row. It has NO ACT_SIGNALS entry, so a note
// can never fake-clear it - it self-clears structurally.
//
// WHAT THIS PROVES:
//   - happy: ECD ~within 24h + one active PO with no schedule -> exactly one ecdrisk row;
//   - suppressed when a PO is structurally confirmed (schedDate + status != accept);
//   - suppressed when the ECD is already past (overdue is the existing 'Reset ECD' push);
//   - suppressed with no active PO work, and when any PO is at Confirm Complete;
//   - a scheduled-but-unaccepted PO does NOT count as confirmed (still chased).
//
// Dates are computed relative to the real clock (tomorrow / yesterday) so the case is
// deterministic without stubbing Date: parseUSDate floors to midnight, so tomorrow's date is
// always 0-24h out and yesterday's is always in the past.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-ecdrisk.js

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

var S_PARSE = slice('    function parseUSDate(s)', '    function alphaOnly(s)', 'parseUSDate');
var S_A1 = slice('      // ---- ECD imminent + vendor unconfirmed + no completion (T8-A1',
  '      // Clocked Out: Complete = the tech has finished on-site.', 'A1 block');

function build(mutations) {
  var a1 = S_A1;
  (mutations || []).forEach(function (m) { a1 = mutate(a1, m[0], m[1]); });
  var sandbox = { Date: Date, Math: Math, String: String, Number: Number, Array: Array, parseInt: parseInt, isNaN: isNaN, console: console };
  var src = S_PARSE + '\nthis.__a1 = function (state, woPhase) { var acts = [], ref = "W-1";\n' + a1 + '\n  return acts; };\n';
  vm.runInNewContext(src, sandbox, { filename: 'a1.js' });
  return sandbox.__a1;
}

function fmt(d) { return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear(); }
var TOMORROW = fmt(new Date(Date.now() + 24 * 3600e3));
var YESTERDAY = fmt(new Date(Date.now() - 24 * 3600e3));
var ACTIVE = { done: false, amount: 100 };                                    // open PO, no schedule
var CONFIRMED = { done: false, amount: 100, schedDate: '9/01/2026', poStatus: 'materials' };
var ACCEPT = { done: false, amount: 100, schedDate: '9/01/2026', poStatus: 'accept' }; // scheduled but unaccepted

function runCases(mutations) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  function eq(name, got, want) { ok(name, got === want, 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }

  var a1;
  try { a1 = build(mutations); }
  catch (err) { out.push({ name: 'source loads', ok: false, detail: String(err && err.message || err) }); return out; }

  // A1-happy
  var happy = a1({ due: { raw: TOMORROW }, pos: [ACTIVE] }, 'scheduled');
  eq('A1-happy: ECD within 24h + active unscheduled PO emits one row', happy.length, 1);
  ok('and it is the ecdrisk row', happy[0] && happy[0].key.indexOf('ecdrisk:') === 0, JSON.stringify(happy[0] && happy[0].key));
  ok('with the urgent chase label', happy[0] && /Chase vendor NOW/.test(happy[0].label), happy[0] && happy[0].label);
  ok('and NO resolve signal (cannot be fake-cleared by a note)', happy[0] && !happy[0].resolve, JSON.stringify(happy[0] && happy[0].resolve));

  // A1-suppress-confirmed
  eq('A1-suppress-confirmed: a structurally-confirmed visit fires nothing', a1({ due: { raw: TOMORROW }, pos: [CONFIRMED] }, 'scheduled').length, 0);

  // A1-suppress-overdue
  eq('A1-suppress-overdue: a past ECD fires nothing (that is the Reset-ECD push)', a1({ due: { raw: YESTERDAY }, pos: [ACTIVE] }, 'scheduled').length, 0);

  // A1-suppress-no-active-work
  eq('no active PO work -> nothing', a1({ due: { raw: TOMORROW }, pos: [] }, 'scheduled').length, 0);

  // A1-suppress-confirm-complete PO present
  eq('a PO at Confirm Complete suppresses it (completion in progress)', a1({ due: { raw: TOMORROW }, pos: [ACTIVE, { poStatus: 'confirm' }] }, 'scheduled').length, 0);

  // accept != confirmed
  eq('a scheduled-but-UNACCEPTED PO still fires (accept != confirmed)', a1({ due: { raw: TOMORROW }, pos: [ACCEPT] }, 'scheduled').length, 1);

  // no ECD at all -> nothing (guard)
  eq('no ECD on the WO -> nothing', a1({ due: null, pos: [ACTIVE] }, 'scheduled').length, 0);

  return out;
}

var MUTATIONS = [
  { what: 'the imminent-window lower bound dropped, so an overdue ECD also fires',
    m: ['hrsToEcd > 0 && hrsToEcd <= 24', 'hrsToEcd <= 24'] },
  { what: 'the vendor-confirmed suppression removed',
    m: ['if (ecdImminent && activeWork && !vendorConfirmed && noCompletion) {', 'if (ecdImminent && activeWork && noCompletion) {'] },
  { what: 'the Confirm-Complete suppression removed',
    m: ["!state.pos.some(function (p) { return p.poStatus === 'confirm'; })", 'true'] },
  { what: 'accept treated as a confirmed visit (would swallow the real risk)',
    m: ["p.schedDate && p.poStatus !== 'accept'", 'p.schedDate'] }
];

function main() {
  console.log('\n-- the T8-A1 composite ECD-risk rule --');
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
