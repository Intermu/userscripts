// test-wo-audit-timeline.js - node harness for the over-30 timeline-note helpers (0.11.0).
//
// Slices the PURE `BWN WO-AUDIT TIMELINE` block out of the .user.js and runs the real shipped bytes
// in a plain Function (no DOM, no network - same technique as test-wo-audit-post.js). Covers the
// DETERMINISTIC parts of the over-30 note - date formatting, ECD past/absent detection, the trade
// label, and the prefix/tail wrapping - since those, not the model's event chain, are what must be
// exact. Every case carries at least one NEGATIVE control.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-wo-audit-timeline.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-wo-audit.user.js');

function extractSection() {
  var t = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  var a = t.indexOf('// ===== BWN WO-AUDIT TIMELINE START');
  var b = t.indexOf('// ===== BWN WO-AUDIT TIMELINE END');
  if (a === -1 || b === -1) throw new Error('BWN WO-AUDIT TIMELINE markers not found in ' + SRC);
  return t.slice(a, b);
}
var SECTION = extractSection();
var T = (new Function(
  SECTION + '\n;return { fmtMD: fmtMD, ecdInfo: ecdInfo, tradeLabel: tradeLabel,' +
  ' composeTimelineNote: composeTimelineNote };'
))();

// Fixed clock: 2026-09-10 (local noon), so "past"/"future" are deterministic on any machine.
var NOW = +new Date(2026, 8, 10, 12, 0, 0);
function H(ecd, trades) { return { priority: ecd ? { expectedCompletionDate: ecd } : null, trades: trades || [] }; }

console.log('WO Audit over-30 timeline helpers (0.11.0) - ' + path.basename(SRC));

// 1. fmtMD: M/D from the STRING parts (no timezone drift), '' when unparseable.
console.log('\n1. fmtMD');
A.eq('"2026-08-25" -> 8/25', T.fmtMD('2026-08-25'), '8/25');
A.eq('"2026-08-06T09:00:00Z" -> 8/6 (no leading zero)', T.fmtMD('2026-08-06T09:00:00Z'), '8/6');
A.eq('"2026-12-31" -> 12/31', T.fmtMD('2026-12-31'), '12/31');
A.eq('blank -> ""', T.fmtMD(''), '');
A.eq('null -> ""', T.fmtMD(null), '');
// negative control: a non-date string is not coerced into a fake M/D.
A.eq('control: "n/a" -> ""', T.fmtMD('n/a'), '');

// 2. ecdInfo: str + past, computed on the injected clock; null when no ECD is set.
console.log('\n2. ecdInfo (clock = 2026-09-10)');
A.eq('future ECD -> not past', T.ecdInfo(H('2026-09-20'), NOW).past, false);
A.eq('future ECD -> str 9/20', T.ecdInfo(H('2026-09-20'), NOW).str, '9/20');
A.eq('past ECD -> past', T.ecdInfo(H('2026-08-25'), NOW).past, true);
A.eq('past ECD -> str 8/25', T.ecdInfo(H('2026-08-25'), NOW).str, '8/25');
// boundary: ECD == today is NOT past (only strictly earlier dates flag).
A.eq('ECD == today -> not past', T.ecdInfo(H('2026-09-10'), NOW).past, false);
// absent ECD -> null (distinct from a past one, so the tail can say "not set").
A.eq('no ECD -> null', T.ecdInfo(H(null), NOW), null);
// negative control: yesterday is past, tomorrow is not - the boundary is real, not always-true.
A.eq('control: 2026-09-09 -> past', T.ecdInfo(H('2026-09-09'), NOW).past, true);
A.eq('control: 2026-09-11 -> not past', T.ecdInfo(H('2026-09-11'), NOW).past, false);

// 3. tradeLabel: first named trade, '' when none.
console.log('\n3. tradeLabel');
A.eq('one trade -> its name', T.tradeLabel(H(null, [{ name: 'Service' }])), 'Service');
A.eq('no trades -> ""', T.tradeLabel(H(null, [])), '');
A.eq('null header -> ""', T.tradeLabel(null), '');
// negative control: a blank first name is skipped, not returned as the label.
A.eq('control: blank then named -> the named one', T.tradeLabel(H(null, [{ name: '' }, { name: 'Electrical' }])), 'Electrical');

// 4. composeTimelineNote: deterministic prefix + tail around the model's chain.
console.log('\n4. composeTimelineNote');
A.eq('trade + future ECD',
  T.composeTimelineNote('received 8/13 - install pending', H('2026-09-20', [{ name: 'Service' }]), NOW),
  'Over 30 - Service - received 8/13 - install pending - ECD 9/20');
A.eq('past ECD -> PAST flag',
  T.composeTimelineNote('reorder pending', H('2026-08-25', [{ name: 'Service' }]), NOW),
  'Over 30 - Service - reorder pending - ECD 8/25 PAST - awaiting new ECD');
A.eq('absent ECD -> needs-ECD flag',
  T.composeTimelineNote('reorder pending', H(null, [{ name: 'Service' }]), NOW),
  'Over 30 - Service - reorder pending - ECD not set - needs ECD');
A.eq('no trade -> no trade segment',
  T.composeTimelineNote('x', H('2026-09-20', []), NOW),
  'Over 30 - x - ECD 9/20');
A.eq('stray leading/trailing dashes trimmed',
  T.composeTimelineNote('  - a - b -  ', H('2026-09-20', [{ name: 'Service' }]), NOW),
  'Over 30 - Service - a - b - ECD 9/20');
A.eq('an echoed "Over 30" prefix is stripped (no double heading)',
  T.composeTimelineNote('Over 30 - a - b', H('2026-09-20', [{ name: 'Service' }]), NOW),
  'Over 30 - Service - a - b - ECD 9/20');
// negative control: a future ECD must NOT carry the PAST flag.
A.ok('control: future ECD note has no PAST flag',
  T.composeTimelineNote('x', H('2026-09-20', [{ name: 'Service' }]), NOW).indexOf('PAST') === -1);
// negative control: a chain NOT echoing the prefix is left intact (the strip is targeted).
A.eq('control: a normal chain is not over-stripped',
  T.composeTimelineNote('over-ordered parts 8/1', H('2026-09-20', []), NOW),
  'Over 30 - over-ordered parts 8/1 - ECD 9/20');

A.finish();
