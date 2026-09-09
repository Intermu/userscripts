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
  vm.runInContext(src + '\nthis.firstNameFromUser = firstNameFromUser; this.TEMPLATES = TEMPLATES; this.buildNote = buildNote; this.fmtDay = fmtDay; this.fmtWeekOf = fmtWeekOf; this.applyDate = applyDate; this.spokeTag = spokeTag; this.prependSpokeTag = prependSpokeTag; this.mruAdd = mruAdd;', ctx);
  return ctx;
}
var env = build(SRC);
var TEMPLATES = env.TEMPLATES, buildNote = env.buildNote, firstNameFromUser = env.firstNameFromUser;
var fmtDay = env.fmtDay, fmtWeekOf = env.fmtWeekOf, applyDate = env.applyDate;
var spokeTag = env.spokeTag, prependSpokeTag = env.prependSpokeTag, mruAdd = env.mruAdd;
function allItems(t) { return t.reduce(function (a, g) { return a.concat(g.items); }, []); }

// ---- groups + templates intact -----------------------------------------------------------
A.eq('4 groups', TEMPLATES.length, 4);
A.eq('group titles', TEMPLATES.map(function (g) { return g.group; }).join(' | '), 'Call outs | Completed work | New work to schedule | Approvals');
A.eq('Call outs = 2', TEMPLATES[0].items.length, 2);
A.eq('Completed work = 3', TEMPLATES[1].items.length, 3);
A.eq('New work to schedule = 4', TEMPLATES[2].items.length, 4);
A.eq('Approvals = 2', TEMPLATES[3].items.length, 2);
A.eq('11 templates total', allItems(TEMPLATES).length, 11);
A.ok('every template has a label and a body', allItems(TEMPLATES).every(function (t) { return t.label && t.body && typeof t.signed === 'boolean'; }));
A.ok('call-outs are unsigned', TEMPLATES[0].items.every(function (t) { return t.signed === false; }));
A.ok('completed + new-work + approvals are signed', TEMPLATES[1].items.concat(TEMPLATES[2].items).concat(TEMPLATES[3].items).every(function (t) { return t.signed === true; }));

// ---- verbatim spot-checks ----------------------------------------------------------------
function byLabel(re) { return allItems(TEMPLATES).find(function (t) { return re.test(t.label); }); }
A.ok('reschedule template keeps the blank', /rescheduled for ______\./.test(byLabel(/reschedule/).body));
A.ok('completed template mentions adjusting the NTE', /adjust the NTE accordingly/.test(byLabel(/Completed/).body));
A.ok('too-far template mentions round-trip travel', /round-trip travel/.test(byLabel(/cost-effective/).body));
A.ok('approval back-on-schedule template thanks for the approval + keeps the date blank', /Thank you for the approval, this is back on schedule for ______\./.test(byLabel(/back on schedule/).body));
A.ok('approval order-material template thanks for the approval + follows up with a lead time', /Thank you for the approval, we will order material and follow up with a lead time/.test(byLabel(/ordering material/).body));

// ---- firstNameFromUser -------------------------------------------------------------------
A.eq('given_name wins', firstNameFromUser({ given_name: 'Alyssa', name: 'X Y' }), 'Alyssa');
A.eq('given_name first token only', firstNameFromUser({ given_name: 'Alyssa Marie' }), 'Alyssa');
A.eq('falls back to display-name first token', firstNameFromUser({ name: 'Alyssa Smith' }), 'Alyssa');
A.eq('single-word name', firstNameFromUser({ name: 'Alyssa' }), 'Alyssa');
A.eq('no claims -> empty', firstNameFromUser({}), '');
A.eq('null user -> empty', firstNameFromUser(null), '');

// ---- sign-off nicknames: Nicholas signs as Nick (from given_name or display name, any case) -----
A.eq('nickname maps given_name Nicholas -> Nick', firstNameFromUser({ given_name: 'Nicholas' }), 'Nick');
A.eq('nickname maps display-name Nicholas -> Nick', firstNameFromUser({ name: 'Nicholas Smith' }), 'Nick');
A.eq('nickname is case-insensitive', firstNameFromUser({ given_name: 'nicholas' }), 'Nick');
A.eq('a non-nicknamed name is untouched', firstNameFromUser({ given_name: 'Nick' }), 'Nick');

// ---- buildNote: signature is dynamic + gated ---------------------------------------------
var signed = byLabel(/Scheduled for/), callout = byLabel(/redirect \(week full\)/);
A.ok('signed note ends with -<FirstName>', /\n-Alyssa$/.test(buildNote(signed, 'Alyssa')));
A.ok('signed note with no name leaves -______', /\n-______$/.test(buildNote(signed, '')));
A.eq('unsigned note gets NO signature (body unchanged)', buildNote(callout, 'Alyssa'), callout.body);
A.ok('no template body bakes in a literal name (signature is always dynamic)',
  allItems(TEMPLATES).every(function (t) { return !/-\s*Alyssa\b/i.test(t.body); }));

// ---- date-fill: the picker turns y/m/d into the blank's text -----------------------------
// The four date templates declare a `date` kind; the rest declare none (money/hours stay manual).
A.eq('exactly 5 templates carry a date blank', allItems(TEMPLATES).filter(function (t) { return t.date; }).length, 5);
A.eq('reschedule is a day', byLabel(/reschedule/).date, 'day');
A.eq('scheduled-for is a day', byLabel(/^Scheduled for/).date, 'day');
A.eq('soonest-on-site is a day', byLabel(/Soonest on-site/).date, 'day');
A.eq('week-of is weekOf', byLabel(/week of/).date, 'weekOf');
A.eq('approval back-on-schedule is a day', byLabel(/back on schedule/).date, 'day');
A.ok('applyDate fills the approval back-on-schedule blank', /back on schedule for Friday 8\/21\./.test(applyDate(byLabel(/back on schedule/).body, 'day', 2026, 8, 21)));
A.ok('completed FC ($, not a date) has no date kind', !byLabel(/Completed/).date);
// Aug 21 2026 is a Friday; Monday of its week is Aug 17. Built LOCALLY so weekday is TZ-stable.
A.eq('fmtDay -> weekday + M/D', fmtDay(2026, 8, 21), 'Friday 8/21');
A.eq('fmtWeekOf -> that week\'s Monday, M/D', fmtWeekOf(2026, 8, 21), '8/17');
A.eq('fmtWeekOf snaps a Monday to itself', fmtWeekOf(2026, 8, 17), '8/17');
A.eq('fmtWeekOf snaps a Sunday back to its Monday', fmtWeekOf(2026, 8, 23), '8/17');
A.ok('applyDate fills the reschedule blank', /rescheduled for Friday 8\/21\./.test(applyDate(byLabel(/reschedule/).body, 'day', 2026, 8, 21)));
A.ok('applyDate fills the week-of blank', /week of 8\/17,/.test(applyDate(byLabel(/week of/).body, 'weekOf', 2026, 8, 21)));
A.eq('applyDate leaves a blank-less body untouched', applyDate('no blank here', 'day', 2026, 8, 21), 'no blank here');

// ---- vendor "spoke with" tag -------------------------------------------------------------
A.eq('spokeTag format', spokeTag('ABC Plumbing'), '[Spoke with: ABC Plumbing]');
A.eq('spokeTag trims the vendor', spokeTag('  ABC Plumbing  '), '[Spoke with: ABC Plumbing]');
A.eq('spokeTag on null -> empty vendor', spokeTag(null), '[Spoke with: ]');
A.ok('tag lands at the TOP, above an existing note', /^\[Spoke with: ABC\]\nHi team, this is done$/.test(prependSpokeTag('Hi team, this is done', 'ABC')));
A.eq('tag on an empty note = tag + newline (cursor drops below)', prependSpokeTag('', 'ABC'), '[Spoke with: ABC]\n');
A.eq('tag on a whitespace-only note = tag + newline', prependSpokeTag('   \n  ', 'ABC'), '[Spoke with: ABC]\n');
A.ok('prepend preserves a multi-line template below the tag', /^\[Spoke with: ABC\]\nline1\nline2$/.test(prependSpokeTag('line1\nline2', 'ABC')));

// ---- recent-vendor MRU (dropdown suggestions) --------------------------------------------
A.eq('mruAdd puts the newest first', mruAdd(['B'], 'A', 20).join(','), 'A,B');
A.eq('mruAdd dedupes case-insensitively and moves to front', mruAdd(['A', 'B'], 'a', 20).join(','), 'a,B');
A.eq('mruAdd caps the list length', mruAdd(['1', '2', '3'], '4', 3).join(','), '4,1,2');
A.eq('mruAdd ignores an empty/blank vendor', mruAdd(['A', 'B'], '   ', 20).join(','), 'A,B');
A.eq('mruAdd on a non-array starts fresh', mruAdd(null, 'A', 20).join(','), 'A');

// ---- negative control: put the tag at the BOTTOM, assert the top-of-note test goes red ----
var g0 = build(mutate(SRC, "return body.trim() ? tag + '\\n' + body : tag + '\\n';", "return body.trim() ? body + '\\n' + tag : tag + '\\n';"));
A.ok('[neg] with the tag appended at the bottom, it is NOT at the top of an existing note',
  !/^\[Spoke with: ABC\]\n/.test(g0.prependSpokeTag('Hi team, this is done', 'ABC')));

// ---- negative control: revert the signed-gate, assert red --------------------------------
var g1 = build(mutate(SRC, 'if (tpl.signed) t += ', 'if (true) t += '));
A.ok('[neg] without the signed gate, an unsigned call-out wrongly gets a signature',
  /\n-Alyssa$/.test(g1.buildNote(env.TEMPLATES[0].items[0], 'Alyssa')));

// ---- negative control: drop the Monday snap, assert weekOf no longer lands on Monday ------
var g2 = build(mutate(SRC, 'dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));', ''));
A.eq('[neg] without the Monday snap, a Friday stays a Friday (8/21, not 8/17)', g2.fmtWeekOf(2026, 8, 21), '8/21');

A.finish();
