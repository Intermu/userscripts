// test-ask-render.js - pins the Bundle A / Commit 2 modal overhaul in bwn-ask.user.js:
// persistent Read-only badge, safe context chip, truthful status, distinct degradation states,
// conditional section rendering, safe citation chips, the exact manual-draft panel, copy-only
// (no network / no mutation), no mutation-implying controls, escaping intact, and the NARROW
// U+2014 hygiene exception (the one product-mandated label only, this file only).
// Structural byte assertions over the shipped source (same discipline as the other harnesses).
var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = fs.readFileSync(path.join(__dirname, '..', 'bwn-ask.user.js'), 'utf8').replace(/\r\n/g, '\n');
var EMD = String.fromCharCode(0x2014);

function has(re, name, detail) { A.ok(name, (re instanceof RegExp ? re.test(SRC) : SRC.indexOf(re) !== -1), detail); }

// --- A. persistent Read-only badge ---
has(/roBadge\.textContent = 'Read-only'/, 'header renders a Read-only badge');
has(/className = 'bwn-ask-ro'/, 'Read-only badge has a stable class');
A.ok('Read-only badge is never removed (persistent)', SRC.indexOf('roBadge') !== -1 && !/roBadge[^\n]*\.remove\(/.test(SRC));

// --- B. safe context chip (no PII) ---
has(/'No record identified'/, "context chip supports 'No record identified'");
has(/'WO #' \+ n/, "context chip supports 'WO #<n>'");
var setCtx = SRC.slice(SRC.indexOf('function setContextChip'), SRC.indexOf('function withCitations'));
A.ok('context chip exposes no PII fields', !/locationName|address|client|vendorName|assignedTo|postalCode|scopeOfWork/.test(setCtx));

// --- C. truthful status states (only the ones the UI can honestly reflect) ---
["'Ready'", "'Reading record'", "'Needs work order'", "'Limited by available data'"].forEach(function (s) {
  has(new RegExp('setStatus\\(' + s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'status uses ' + s);
});
A.ok('status is not spinner-only (status text present)', /statusEl\.textContent/.test(SRC));

// --- D. distinct, truthful degradation states ---
[
  'Ask BWN could not identify a usable work order from the current screen',
  'No notes were returned for this work order',
  'Documented notes could not be retrieved for this work order',
  'Site records could not be retrieved',
  'No site work orders were returned for this location'
].forEach(function (s) { has(s, 'degradation state: "' + s + '"'); });

// --- E. conditional answer-section rendering ---
["'### Answer'", "'### Evidence'", "'### Limits or Gaps'", "'### Suggested Next Check'"].forEach(function (h) {
  has(h, 'knows section heading ' + h);
});
has(/function parseSections/, 'section parser present');
has(/function renderSection/, 'section renderer present');
has(/document\.createElement\('details'\)/, 'long evidence collapses behind <details>');
has(/secs\.length[^]*renderSection|parseSections\(text\)/, 'answer routes through section parsing with a fallback');

// --- F. citation chips are safe (informational only) ---
has(/class="bwn-ask-cite"/, 'citations render as source chips');
var wc = SRC.slice(SRC.indexOf('function withCitations'), SRC.indexOf('function para'));
A.ok('citation chips do not navigate or handle clicks', !/addEventListener|href=|location\.|window\.open/.test(wc));
A.ok('citation regex covers WO / Knowledge / Site roster / Current screen',
  /WO #\\d\+/.test(wc) && /Knowledge:/.test(wc) && /Site roster for/.test(wc) && /Current screen:/.test(wc));

// --- G. exact manual-draft panel + copy-only ---
A.ok('exact em-dash draft label present exactly once', SRC.split('DRAFT ' + EMD + ' coordinator must review and submit manually').length - 1 === 1);
has("'Ask BWN cannot submit this for you.'", 'exact manual-draft reminder present');
has(/textContent = 'Copy draft'/, 'draft panel offers Copy draft');
var draftFn = SRC.slice(SRC.indexOf('function draftPanel'), SRC.indexOf('function buildAnswerNode'))
  .replace(/\/\/[^\n]*/g, '');   // strip line comments so prose ("no autofill") is not judged as code
A.ok('Copy draft is client-side only (no network)', !/GM_xmlhttpRequest|gmPost|\bfetch\(/.test(draftFn));
A.ok('Copy draft does not mutate/insert/autofill', !/inputEl\.value|addNote|createNote|\.submit\(|autofill/.test(draftFn));
A.ok('Copy uses clipboard, not a request', /navigator\.clipboard|execCommand\('copy'\)/.test(draftFn));

// --- no mutation-implying controls anywhere in the modal ---
A.ok('no mutation-implying control labels', !/textContent\s*=\s*'(Send|Post|Save|Add note|Apply|Dispatch|Approve|Close work order)'/.test(SRC));
has(/sendBtn\.textContent = 'Ask'/, 'submit control is the neutral "Ask"');
has('Ask about this work order or choose a quick command' + String.fromCharCode(0x2026), 'exact scope-aware placeholder');

// --- escaping intact / no raw payload rendering ---
A.ok('rendered text is escaped before display', /withCitations\(esc\(/.test(SRC));
A.ok('answers are not injected as raw innerHTML', !/innerHTML\s*=\s*(ans|text|r\.json)/.test(SRC));

// --- H. narrow U+2014 exception (regression) ---
var APPROVED = 'DRAFT ' + EMD + ' coordinator must review and submit manually';
var emCount = (SRC.match(new RegExp(EMD, 'g')) || []).length;
var labelCount = SRC.split(APPROVED).length - 1;
A.ok('the ONLY U+2014 in bwn-ask is inside the one approved label', emCount === labelCount && labelCount === 1, 'em=' + emCount + ' label=' + labelCount);
A.ok('arbitrary em-dash is rejected (removing the label leaves zero U+2014)',
  (SRC.split(APPROVED).join('').match(new RegExp(EMD, 'g')) || []).length === 0);
// exception does not apply to another file: a sibling userscript must carry no literal em-dash.
var SIB = fs.readFileSync(path.join(__dirname, '..', 'bwn-suite-ai.user.js'), 'utf8');
A.ok('the U+2014 exception does not leak to bwn-suite-ai.user.js', (SIB.match(new RegExp(EMD, 'g')) || []).length === 0);

// --- invariants preserved ---
A.ok('still exactly two bwnFocusTrap(panelEl) calls', (SRC.match(/bwnFocusTrap\(panelEl\)/g) || []).length === 2);
A.ok('@version bumped past 0.8.0', SRC.indexOf('// @version      0.7.6') === -1 && /\/\/ @version\s+0\.(?:9|1\d)\./.test(SRC));

A.finish();
