// test-ask-commands.js - pins the Ask BWN Quick Command library (Bundle A / Commit 1).
// Judges the SHIPPED bytes of bwn-ask.user.js: the BWN-ASK-CMDS block, its wiring into the
// panel, the initial <=8 cap, site-command gating, and the safety rules on labels (no write
// verbs, no unsupported-certainty labels, no active candidate-capability commands). It also
// re-asserts the a11y invariants this commit must not disturb (single 'Escape' literal, two
// bwnFocusTrap(panelEl) calls) so a Quick Command regression cannot silently break them.
var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = fs.readFileSync(path.join(__dirname, '..', 'bwn-ask.user.js'), 'utf8').replace(/\r\n/g, '\n');

function slice(text, start, end, what) {
  var a = text.indexOf(start); if (a === -1) throw new Error('slice start not found (' + what + '): ' + start);
  var b = text.indexOf(end, a); if (b === -1) throw new Error('slice end not found (' + what + '): ' + end);
  return text.slice(a, b);
}
var BLOCK = slice(SRC, '/* ===== BWN-ASK-CMDS:START', '/* ===== BWN-ASK-CMDS:END', 'cmds block');
var labels = (BLOCK.match(/label:\s*'([^']+)'/g) || []).map(function (m) { return m.replace(/label:\s*'/, '').replace(/'$/, ''); });

// --- required library (exact labels) ---
var REQUIRED_PRIMARY = [
  'Summarize this WO', 'Catch me up', 'What needs attention?', 'Show current assignment',
  'What is documented as the next step?', 'Prepare handoff summary',
  'Show other open WOs at this site', 'Show client/site instructions'
];
var REQUIRED_MORE = [
  'Show schedule details', 'What is missing from this record?', 'Show documented vendor activity',
  'Can we confirm completed work?', 'Show site work-order roster', 'Check for related site issues',
  'Compare this WO to site history', 'Possible repeat pattern?', 'What site context is available?',
  'What client rule applies here?', 'What SOP applies to this issue?', 'Show escalation guidance',
  'What should be verified before escalation?', 'Draft escalation summary', 'Draft vendor follow-up',
  'Draft client update', 'Draft internal handoff'
];
REQUIRED_PRIMARY.concat(REQUIRED_MORE).forEach(function (l) {
  A.ok('library has "' + l + '"', labels.indexOf(l) !== -1, 'missing chip label');
});

// --- initial view is <=8 and is exactly the required primary set ---
var primaryCount = (BLOCK.match(/,\s*primary:\s*true/g) || []).length;   // definition form only (not the prose in the block comment)
A.ok('initial (primary) chip count is <= 8', primaryCount <= 8, 'got ' + primaryCount);
A.ok('initial (primary) chip count is exactly 8', primaryCount === 8, 'got ' + primaryCount);

// --- site-history chips are marked site:true and gated on an open WO ---
var siteCount = (BLOCK.match(/site:\s*true/g) || []).length;
A.ok('site-history chips are tagged site:true (6)', siteCount === 6, 'got ' + siteCount);
A.ok('site chips are disabled when no WO is open', /c\.site && !hasWO/.test(BLOCK) && /disabled = true/.test(BLOCK),
  'no location/WO gating found for site commands');
A.ok('disabled site chip explains why', /Site roster unavailable/.test(BLOCK));

// --- no labels that promise unsupported certainty ---
['Confirm visit', 'Find last vendor', 'Show all site history'].forEach(function (bad) {
  A.ok('no forbidden certainty label "' + bad + '"', labels.indexOf(bad) === -1);
});

// --- no write-verb controls in labels ---
var WRITE = /\b(dispatch|approve|close|send|save|post|apply|submit|create|delete|reassign|cancel)\b/i;
labels.forEach(function (l) { A.ok('label has no write verb: "' + l + '"', !WRITE.test(l)); });

// --- no ACTIVE candidate-capability commands (Tier 1-3 surfaces) ---
var CANDIDATE = /(vendor profile|invoice|purchase order|\bPO\b|proposal|\brates?\b|\btrips?\b|\bproject\b|\btask\b|global search|cross-location|\bemail\b|teams)/i;
labels.forEach(function (l) { A.ok('label is not a candidate capability: "' + l + '"', !CANDIDATE.test(l)); });

// --- wiring + version + hygiene invariants ---
A.ok('command bar is wired into buildPanel', /panelEl\.appendChild\(buildCmdBar\(\)\)/.test(SRC));
A.ok('runCmd fills the input and runs the existing ask flow', /function runCmd\([^)]*\)\s*\{[^}]*inputEl\.value\s*=\s*promptText;\s*doAsk\(\);/.test(SRC));
A.ok('@version bumped to 0.8.0', SRC.indexOf('// @version      0.8.0') !== -1, 'userscript version not bumped');

// invariants this commit must NOT disturb
A.ok('still exactly one \'Escape\' literal (a11y invariant preserved)', (SRC.match(/'Escape'/g) || []).length === 1);
A.ok('still exactly two bwnFocusTrap(panelEl) calls (a11y invariant preserved)', (SRC.match(/bwnFocusTrap\(panelEl\)/g) || []).length === 2);
A.ok('no em-dash introduced (U+2014 count = 0)', (SRC.match(new RegExp(String.fromCharCode(0x2014), 'g')) || []).length === 0);

A.finish();
