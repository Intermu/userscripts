// test-notes-templates.js - the canned dispatch-note templates + signature logic.
//
// Slices the pure block (firstNameFromUser / TEMPLATES / buildNote) out of the SHIPPED
// bwn-notes.user.js bytes and runs it in a vm. Proves:
//   - the 3 groups + 9 templates are intact (Call outs 2, Completed work 3, New work 4);
//   - firstNameFromUser reads given_name first, else the first token of the display name;
//   - buildNote appends "-<FirstName>" to signed templates only, "-______" when no name resolves,
//     and NOTHING to unsigned (call-out) templates;
//   - NO template body bakes in a name (the signature is always dynamic) - so a shared script can
//     never post someone else's name.
// A negative control reverts the signed-gate and asserts the harness goes red.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-notes-templates.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

function readLF(p) { return fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n'); }
function slice(text, start, end, what) {
  var a = text.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found');
  if (text.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = text.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return text.slice(a, b);
}
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 60)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 60)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

var SRC = slice(readLF(path.join(__dirname, '..', 'bwn-notes.user.js')),
  '  // BWN-NOTES-SLICE-START', '  // BWN-NOTES-SLICE-END', 'bwn-notes pure block');

function build(src) {
  var ctx = vm.createContext({ console: console });
  vm.runInContext(src + '\nthis.firstNameFromUser = firstNameFromUser; this.TEMPLATES = TEMPLATES; this.buildNote = buildNote;', ctx);
  return ctx;
}
var env = build(SRC);
var TEMPLATES = env.TEMPLATES, buildNote = env.buildNote, firstNameFromUser = env.firstNameFromUser;
function allItems(t) { return t.reduce(function (a, g) { return a.concat(g.items); }, []); }

// ---- groups + templates intact -----------------------------------------------------------
A.eq('3 groups', TEMPLATES.length, 3);
A.eq('group titles', TEMPLATES.map(function (g) { return g.group; }).join(' | '), 'Call outs | Completed work | New work to schedule');
A.eq('Call outs = 2', TEMPLATES[0].items.length, 2);
A.eq('Completed work = 3', TEMPLATES[1].items.length, 3);
A.eq('New work to schedule = 4', TEMPLATES[2].items.length, 4);
A.eq('9 templates total', allItems(TEMPLATES).length, 9);
A.ok('every template has a label and a body', allItems(TEMPLATES).every(function (t) { return t.label && t.body && typeof t.signed === 'boolean'; }));
A.ok('call-outs are unsigned', TEMPLATES[0].items.every(function (t) { return t.signed === false; }));
A.ok('completed + new-work are signed', TEMPLATES[1].items.concat(TEMPLATES[2].items).every(function (t) { return t.signed === true; }));

// ---- verbatim spot-checks ----------------------------------------------------------------
function byLabel(re) { return allItems(TEMPLATES).find(function (t) { return re.test(t.label); }); }
A.ok('reschedule template keeps the blank', /rescheduled for ______ ./.test(byLabel(/reschedule/).body));
A.ok('completed template mentions adjusting the NTE', /adjust the NTE accordingly/.test(byLabel(/Completed/).body));
A.ok('too-far template mentions round-trip travel', /round-trip travel/.test(byLabel(/cost-effective/).body));

// ---- firstNameFromUser -------------------------------------------------------------------
A.eq('given_name wins', firstNameFromUser({ given_name: 'Alyssa', name: 'X Y' }), 'Alyssa');
A.eq('given_name first token only', firstNameFromUser({ given_name: 'Alyssa Marie' }), 'Alyssa');
A.eq('falls back to display-name first token', firstNameFromUser({ name: 'Alyssa Smith' }), 'Alyssa');
A.eq('single-word name', firstNameFromUser({ name: 'Alyssa' }), 'Alyssa');
A.eq('no claims -> empty', firstNameFromUser({}), '');
A.eq('null user -> empty', firstNameFromUser(null), '');

// ---- buildNote: signature is dynamic + gated ---------------------------------------------
var signed = byLabel(/Scheduled for/), callout = byLabel(/redirect \(week full\)/);
A.ok('signed note ends with -<FirstName>', /\n-Alyssa$/.test(buildNote(signed, 'Alyssa')));
A.ok('signed note with no name leaves -______', /\n-______$/.test(buildNote(signed, '')));
A.eq('unsigned note gets NO signature (body unchanged)', buildNote(callout, 'Alyssa'), callout.body);
A.ok('no template body bakes in a literal name (signature is always dynamic)',
  allItems(TEMPLATES).every(function (t) { return !/-\s*Alyssa\b/i.test(t.body); }));

// ---- negative control: revert the signed-gate, assert red --------------------------------
var g1 = build(mutate(SRC, 'if (tpl.signed) t += ', 'if (true) t += '));
A.ok('[neg] without the signed gate, an unsigned call-out wrongly gets a signature',
  /\n-Alyssa$/.test(g1.buildNote(env.TEMPLATES[0].items[0], 'Alyssa')));

A.finish();
