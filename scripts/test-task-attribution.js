// test-task-attribution.js - the read-only "Open tasks" strip in WO Assist's Next Actions card
// (bwn-suite-core). Slices the REAL shipped taskAttrLines out of the core bytes and runs it in a vm.
//
// WHAT THIS PROVES, against the sliced source:
//   - each open task renders its description, "Created by", "Assigned to" and "Created" from the
//     task record itself (fixture shaped like the live WOOpenTasks read, W-394868, 2026-09-29);
//   - an id the name map can't resolve, a missing field, or a failed users read (null map) reads
//     "Not available" - never a guessed name;
//   - long / multi-line descriptions collapse to one short line;
//   - the WOOpenTasks query text selects the four attribution fields and stays a READ
//     (no mutation keyword in it).
// Negative controls revert pieces of the logic and assert a case goes red.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-task-attribution.js

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
var SRC = slice('    // BWN-TASK-ATTR-START', '    // BWN-TASK-ATTR-END', 'taskAttrLines');
function build(src) {
  var ctx = vm.createContext({});
  vm.runInContext(src + '\nthis.taskAttrLines = taskAttrLines;', ctx);
  return ctx.taskAttrLines;
}

var CREATOR = 'b6332032-dbb4-457c-b926-b7bec1dd93af', ASSIGNEE = '979c34e7-4b8e-4c86-a9bb-0e1d05292e45';
var NAMES = {}; NAMES[CREATOR] = 'Rachel B'; NAMES[ASSIGNEE] = 'Angela E';
var LIVE_ROW = { id: '11545483-8e90-48d6-382e-08df179003f6', isComplete: false, description: '** HAVE THE TECH COME DOWN',
  assignedTo: ASSIGNEE, createdBy_UserProfileId: CREATOR, createdDate: '2026-09-21T20:18:42.5493634+00:00' };

function run(fn) {
  var out = [];
  function eq(name, got, want) { out.push({ name: name, ok: got === want, detail: 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want) }); }
  var lines = fn([LIVE_ROW], NAMES);
  eq('one line per open task', lines.length, 1);
  eq('live-shaped row renders creator, assignee and created date from the record', lines[0],
    '** HAVE THE TECH COME DOWN · Created by: Rachel B · Assigned to: Angela E · Created: 9/21/2026');
  eq('an unresolvable id reads Not available (no guess)',
    fn([{ description: 'x', assignedTo: 'nobody', createdBy_UserProfileId: CREATOR, createdDate: '2026-01-02T00:00:00Z' }], NAMES)[0],
    'x · Created by: Rachel B · Assigned to: Not available · Created: 1/2/2026');
  eq('a failed users read (null map) leaves every name Not available',
    fn([LIVE_ROW], null)[0], '** HAVE THE TECH COME DOWN · Created by: Not available · Assigned to: Not available · Created: 9/21/2026');
  eq('absent fields read Not available / (no description)', fn([{}], NAMES)[0],
    '(no description) · Created by: Not available · Assigned to: Not available · Created: Not available');
  eq('multi-line description collapses to one line', fn([{ description: 'a\n\n  b' }], NAMES)[0].indexOf('a b · '), 0);
  var long = fn([{ description: new Array(200).join('z') }], NAMES)[0];
  eq('a long description is capped at 90 chars', long.indexOf(' · Created by:'), 90);
  eq('no rows -> no lines', fn(null, NAMES).length, 0);
  return out;
}

console.log('\n-- taskAttrLines (sliced from bwn-suite-core) --');
run(build(SRC)).forEach(function (r) { A.ok(r.name, r.ok, r.detail); });

console.log('\n-- the task read --');
var q = (/var OPEN_TASKS_Q = '([^']+)'/.exec(core) || [])[1] || '';
['description', 'assignedTo', 'createdBy_UserProfileId', 'createdDate'].forEach(function (f) {
  A.ok('WOOpenTasks selects ' + f, new RegExp('\\b' + f + '\\b').test(q), q);
});
A.ok('WOOpenTasks is a query, not a mutation', /^query WOOpenTasks/.test(q) && !/mutation/i.test(q), q);

console.log('\n-- negative controls: each must turn a case above red --');
[
  { what: 'guessing the raw id instead of Not available', m: ["return (id && names && names[id]) || NA;", "return (id && names && names[id]) || id || NA;"] },
  { what: 'swapping creator and assignee', m: ["who(t && t.createdBy_UserProfileId) +", "who(t && t.assignedTo) +"] },
  { what: 'dropping the whitespace collapse', m: [".replace(/\\s+/g, ' ').trim();\n        if (desc.length", ".trim();\n        if (desc.length"] }
].forEach(function (mm) {
  var rs;
  try { rs = run(build(mutate(SRC, mm.m[0], mm.m[1]))); }
  catch (err) { rs = [{ ok: false }]; }
  A.ok('CAUGHT: ' + mm.what, rs.some(function (r) { return !r.ok; }), 'mutation produced NO failing case');
});

A.finish();
