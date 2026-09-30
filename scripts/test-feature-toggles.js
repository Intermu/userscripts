// test-feature-toggles.js - Suite settings module toggles are real and wired.
//
// Core 1.91.0 added per-feature toggles inside WO Assist (Next Actions card, ECD auto-prompt,
// close-out preflight) that apply live, plus the three AI modules the list was missing.
// Pins: every SUITE_MODULES key is a real BWN_MODULES key in the script it names (a typo'd key
// would render a checkbox that does nothing), and every live toggle actually gates its call.

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

function read(f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8'); }
function moduleKeys(src) {
  var m = src.match(/var BWN_MODULES = \{([\s\S]*?)\n\s*\};/);
  var keys = {};
  if (m) m[1].replace(/^\s*([A-Za-z]+):\s*(true|false)/gm, function (_, k) { keys[k] = 1; });
  return keys;
}

var core = read('bwn-suite-core.user.js');
var keys = { Core: moduleKeys(core), AI: moduleKeys(read('bwn-suite-ai.user.js')) };
A.ok('read Core + AI module tables', Object.keys(keys.Core).length > 10 && Object.keys(keys.AI).length >= 5);

var list = core.match(/var SUITE_MODULES = \[([\s\S]*?)\n\s*\];/);
A.ok('found SUITE_MODULES', !!list);
var rows = [];
list[1].replace(/\{ k: '([A-Za-z]+)', script: '(Core|AI)'[^}]*?(live: true)?\s*\}/g, function (_, k, s, live) { rows.push({ k: k, s: s, live: !!live }); });

rows.forEach(function (r) {
  if (r.k === 'connector') return;   // AI reads bwn:modules.connector live; it is not a BWN_MODULES key
  A.ok('toggle "' + r.k + '" is a real ' + r.s + ' module key', !!keys[r.s][r.k]);
});
['jobView', 'serviceRequest', 'operate'].forEach(function (k) {
  A.ok('AI module "' + k + '" has a toggle', rows.some(function (r) { return r.k === k; }));
});

var GATES = { actsCard: 'renderActsInline(st)', ecdPrompt: 'maybeAutoECD(st)', closePreflight: 'maybePreflight(st)' };
Object.keys(GATES).forEach(function (k) {
  var row = rows.filter(function (r) { return r.k === k; })[0];
  A.ok('"' + k + '" is listed as a live toggle', !!(row && row.live));
  A.ok('"' + k + '" gates ' + GATES[k], core.indexOf('if (BWN_MODULES.' + k + ') ' + GATES[k]) !== -1);
});
A.ok('Next Actions off removes a card already on the page',
  /if \(BWN_MODULES\.actsCard\) renderActsInline\(st\);\s*else \{ var _ac = document\.getElementById\(ACT_CARD_ID\); if \(_ac\) _ac\.remove\(\); \}/.test(core));
A.ok('a live toggle updates BWN_MODULES and fires bwn:config',
  core.indexOf("if (mod.live) { BWN_MODULES[mod.k] = cb.checked; try { document.dispatchEvent(new CustomEvent('bwn:config'));") !== -1);

A.finish();
