// test-intake-guards.js - the cross-client guarantees for bwn-wo-intake.user.js.
//
// The five per-client harnesses (amazon-rfq, cw-amazon, cw-corrigo, jll-amazon, transform) each
// prove their own happy-path field mapping. Three things nothing proved, all of which are the
// reason a coordinator can trust this script at all:
//
//   1. PII CONTAINMENT. Client emails carry contact details INLINE, mid-sentence, where
//      genericBodyScope's line-shaped signature detector cannot see them. Scope of Work is not a
//      dead end: bwn-bid-out reads scopeOfWork back out of Umbrava and pastes it into the BCC'd
//      vendor RFP, where Hard Rule 5 permits city/state only. sanitizeWo() is the one guard at the
//      fill boundary; this pins it, including that it is actually WIRED into fillWo.
//   2. NO AUTO-CREATE. The work order is created by the human clicking Umbrava's own Create button;
//      this script only observes that click. It holds structurally - no GraphQL, no bwnGqlOp, no
//      egress primitive, no synthesized click on a submit control - and until now nothing asserted
//      it, so a future edit could quietly add a write path and CI would stay green.
//   3. MALFORMED-DOCUMENT DEGRADATION. Every extractor must return blank fields rather than throw
//      or mis-capture a neighbouring value when its anchors are absent. A thrown parse leaves the
//      operator with a dead drop-zone; a mis-capture is worse - it prefills a plausible wrong value
//      that a human may not catch before Create.
//
// Same proven pattern as the sibling harnesses: slice the REAL shipped source and run it in a vm.
// Fixtures here are synthetic by construction.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-intake-guards.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-wo-intake.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(startNeedle, endNeedle, what) {
  var a = full.indexOf(startNeedle);
  if (a === -1) throw new Error('SLICE START ABSENT (' + what + '): ' + JSON.stringify(startNeedle.slice(0, 60)));
  var b = full.indexOf(endNeedle, a);
  if (b === -1) throw new Error('SLICE END ABSENT (' + what + '): ' + JSON.stringify(endNeedle.slice(0, 60)));
  return full.slice(a, b);
}

// Every client extractor plus the shared scope builder, in one contiguous shipped region.
var BLOCK_CLIENTS = slice('var CLIENT_BY_DOMAIN', '// ---- Create WO modal', 'client extractors');
// The PII guard, up to (not including) fillWo.
var BLOCK_GUARD = slice('var PII_EMAIL =', 'function fillWo(', 'PII guard');

var exportLine = '\n;this.extractWo=extractWo;this.genericBodyScope=genericBodyScope;' +
  'this.extractAmazon=extractAmazon;this.extractCwAmazon=extractCwAmazon;' +
  'this.extractCwCorrigo=extractCwCorrigo;this.extractJllAmazon=extractJllAmazon;' +
  'this.extractTransform=extractTransform;this.extractCaleres=extractCaleres;' +
  'this.stripInlinePii=stripInlinePii;this.sanitizeWo=sanitizeWo;this.TEXT_CAP=TEXT_CAP;';
var api = {};
vm.runInNewContext(BLOCK_CLIENTS + '\n' + BLOCK_GUARD + exportLine, api);

console.log('WO Intake cross-client guards - PII containment, no-auto-create, malformed input\n');

// ---- 1. PII containment ------------------------------------------------------------------------

console.log('# stripInlinePii');
A.eq('  strips an inline phone mid-sentence',
  api.stripInlinePii('Call the site lead at 555-555-0101 before arrival.'),
  'Call the site lead at [phone removed] before arrival.');
A.eq('  strips a dotted phone',
  api.stripInlinePii('reach him on 555.555.0102 today'),
  'reach him on [phone removed] today');
A.eq('  strips a parenthesised phone with a country code',
  api.stripInlinePii('dispatch: +1 (555) 555-0103'),
  'dispatch: [phone removed]');
A.eq('  strips an inline email address',
  api.stripInlinePii('questions to fm.lead@client-example.com please'),
  'questions to [contact removed] please');
A.eq('  leaves text with no contact details untouched',
  api.stripInlinePii('Replace the drum and belt on the left dryer.'),
  'Replace the drum and belt on the left dryer.');
A.eq('  preserves single newlines (CorrigoPro Problem block, Pilot asset block)',
  api.stripInlinePii('Interior > Electrical Issues\nPreventive Maintenance Task'),
  'Interior > Electrical Issues\nPreventive Maintenance Task');
A.eq('  preserves a blank line between blocks', api.stripInlinePii('Description here.\n\nAsset: DRYER'),
  'Description here.\n\nAsset: DRYER');
A.eq('  null / undefined -> empty string, never a crash', api.stripInlinePii(null) + api.stripInlinePii(undefined), '');

// Identifier shapes that merely look phone-ish must survive: a stripped WO number or GL code would
// silently break the prefill this whole script exists for.
console.log('\n# stripInlinePii must NOT eat parsed identifiers');
A.eq('  a GL account code survives', api.stripInlinePii('GL Account/Code: 610-000-01'), 'GL Account/Code: 610-000-01');
A.eq('  a Caleres source WO survives', api.stripInlinePii('WO# 1199001-00000009'), 'WO# 1199001-00000009');
A.eq('  a 12-digit Pilot PO survives', api.stripInlinePii('PO 170101999001'), 'PO 170101999001');
A.eq('  a CorrigoPro WO number survives', api.stripInlinePii('WORK ORDER #AMNEXM2000123'), 'WORK ORDER #AMNEXM2000123');
A.eq('  an NTE amount survives', api.stripInlinePii('NTE: $1,414.71'), 'NTE: $1,414.71');

console.log('\n# sanitizeWo (the fill-boundary guard)');
var dirty = {
  scope: 'No power to dock door 3. Per onsite Ops Mgr Rae 555-555-0104, breaker may be tripped.',
  _note: 'Requested By Robin Loe, C&W - 555-555-0105',
  _warn: 'procedures live in CorrigoPro; call 555-555-0106',
  po: '170101999001', sourceJob: 'AMNEXM2000123', client: 'CW-Amazon', trade: 'Electrical'
};
var clean = api.sanitizeWo(dirty);
A.ok('  scope has no phone left', !/\d{3}[-. ]\d{3}[-. ]\d{4}/.test(clean.scope), 'got ' + JSON.stringify(clean.scope));
A.ok('  scope keeps the operative request text', clean.scope.indexOf('No power to dock door 3') === 0, 'got ' + JSON.stringify(clean.scope));
A.ok('  _note has no phone left', !/\d{3}[-. ]\d{3}[-. ]\d{4}/.test(clean._note), 'got ' + JSON.stringify(clean._note));
A.ok('  _warn has no phone left', !/\d{3}[-. ]\d{3}[-. ]\d{4}/.test(clean._warn), 'got ' + JSON.stringify(clean._warn));
A.eq('  Source PO # is an identifier, not free text - untouched', clean.po, '170101999001');
A.eq('  Source Job # untouched', clean.sourceJob, 'AMNEXM2000123');
A.eq('  client untouched', clean.client, 'CW-Amazon');

var long = { scope: new Array(900).join('x'), _note: new Array(900).join('y'), _warn: new Array(900).join('z') };
api.sanitizeWo(long);
A.ok('  scope capped at TEXT_CAP', long.scope.length === api.TEXT_CAP, 'len ' + long.scope.length);
A.ok('  _note capped (was uncapped - an oversized toast hides the modal being reviewed)',
  long._note.length === api.TEXT_CAP, 'len ' + long._note.length);
A.ok('  _warn capped', long._warn.length === api.TEXT_CAP, 'len ' + long._warn.length);
A.ok('  a null wo does not crash the fill path', api.sanitizeWo(null) === null);

// ---- 2. No auto-create, no egress --------------------------------------------------------------
// Source-text guards, the technique already proven at test-amazon-rfq-intake.js.

console.log('\n# no-auto-create / no-egress source guards');
A.ok('no bwnGqlOp registration or call in this script', full.indexOf('bwnGqlOp') === -1);
A.ok('no GraphQL mutation string', !/mutation\s+\w*\s*\(/.test(full));
A.ok('no GM_xmlhttpRequest', full.indexOf('GM_xmlhttpRequest') === -1);
A.ok('no fetch( call', full.indexOf('fetch(') === -1);
A.ok('no XMLHttpRequest', full.indexOf('XMLHttpRequest') === -1);
A.ok('no sendBeacon', full.indexOf('sendBeacon') === -1);
A.ok('no @connect host declared (zero egress capability)', !/^\/\/ @connect/m.test(full));
A.ok('@grant is none', /^\/\/ @grant\s+none$/m.test(full));

// The only click this script issues is on its own hidden file input. A click synthesized on a
// Create/Submit/Save control would be an auto-create regression.
var clicks = full.match(/\.click\(\)/g) || [];
A.eq('exactly one .click() in the script (the hidden file input)', clicks.length, 1);
A.ok('the one .click() is on the hidden file input, not a submit control',
  full.indexOf('file.click()') !== -1 && /var file = document\.createElement\('input'\); file\.type = 'file'/.test(full),
  'the single click is not the file-picker click on a created input[type=file]');
A.ok('the Create button is only LISTENED to, never clicked',
  full.indexOf("addEventListener('click'") !== -1 && !/create[^\n]{0,40}\.click\(\)/i.test(full));

console.log('\n# the PII guard is wired in, not just defined');
function callsSanitize(src) { return /function fillWo\([^)]*\)\s*\{[\s\S]{0,400}?sanitizeWo\(wo\);/.test(src); }
A.ok('fillWo calls sanitizeWo before rendering or filling anything', callsSanitize(full));
A.ok('CONTROL: removing that call is detected',
  callsSanitize(full.replace('sanitizeWo(wo);', '/* removed */')) === false,
  'the wiring check is vacuous - it passes even with the call gone');

console.log('\n# untrusted .msg stream names cannot reach Object.prototype');
var oleMaps = full.match(/var (?:topByName|byName) = Object\.create\(null\)/g) || [];
A.eq('both OLE directory-name maps are null-prototype', oleMaps.length, 2);
A.ok('no plain-object OLE name map remains',
  full.indexOf('var topByName = {}') === -1 && full.indexOf('var byName = {}') === -1);

// ---- 3. Malformed-document degradation ---------------------------------------------------------
// Anchor-missing, truncated and entity-laden bodies. Every extractor must return an object with
// blank identifier fields - never throw, never mis-capture a neighbouring value.

console.log('\n# malformed input: anchors absent (blank, not thrown, not mis-captured)');
var JUNK = 'Hello, please see attached. Thanks.';
var TRUNC = 'WORK ORDER #';                                   // anchor present, value cut off
var ENTITY = '&lt;div&gt;Request ID: &amp;nbsp; Priority: &lt;/div&gt;';   // entity-laden, no real values

function safeCall(name, fn, subject, body) {
  var out = null, threw = null;
  try { out = fn(subject, body); } catch (e) { threw = e; }
  A.ok('  ' + name + ' does not throw', threw === null, threw && String(threw.message));
  A.ok('  ' + name + ' returns an object', out !== null && typeof out === 'object');
  return out || {};
}

['JUNK', 'TRUNC', 'ENTITY'].forEach(function (label) {
  var body = label === 'JUNK' ? JUNK : (label === 'TRUNC' ? TRUNC : ENTITY);
  console.log('  -- ' + label);
  var am = safeCall('extractAmazon[' + label + ']', api.extractAmazon, 'no subject here', body);
  A.eq('  extractAmazon rfqId blank', am.rfqId || '', '');
  A.eq('  extractAmazon site code blank', am._siteCode || '', '');

  var cw = safeCall('extractCwAmazon[' + label + ']', api.extractCwAmazon, 'no subject here', body);
  A.eq('  extractCwAmazon requestId blank', cw.requestId || '', '');

  var cc = safeCall('extractCwCorrigo[' + label + ']', api.extractCwCorrigo, 'no subject here', body);
  A.eq('  extractCwCorrigo site code blank', cc.siteCode || '', '');

  var jl = safeCall('extractJllAmazon[' + label + ']', api.extractJllAmazon, 'no subject here', body);
  A.eq('  extractJllAmazon site code blank', jl.siteCode || '', '');

  var tx = safeCall('extractTransform[' + label + ']', api.extractTransform, 'no subject here', body);
  A.eq('  extractTransform store blank', tx.store || '', '');
  A.eq('  extractTransform ref blank', tx.ref || '', '');

  var gen = safeCall('extractWo[' + label + ']', function (s, b) { return api.extractWo(s, b, 'someone@example.com'); },
    'no subject here', body);
  A.eq('  extractWo po blank', gen.po || '', '');
});

console.log('\n# malformed input: empty and absent bodies');
A.eq('genericBodyScope("") -> ""', api.genericBodyScope(''), '');
A.eq('genericBodyScope(null) -> ""', api.genericBodyScope(null), '');
A.eq('genericBodyScope(undefined) -> ""', api.genericBodyScope(undefined), '');
safeCall('extractAmazon[empty]', api.extractAmazon, '', '');
safeCall('extractCwAmazon[empty]', api.extractCwAmazon, '', '');
safeCall('extractCwCorrigo[empty]', api.extractCwCorrigo, '', '');
safeCall('extractJllAmazon[empty]', api.extractJllAmazon, '', '');
safeCall('extractTransform[empty]', api.extractTransform, '', '');

// A body that is nothing but a signature block must not become the scope.
console.log('\n# a signature-only body yields no scope');
A.eq('signature-only -> empty scope',
  api.genericBodyScope('Thanks,\nJane Doe\noffice: 555-0100\njane@example.com'), '');

// ---- 4. Negative controls ----------------------------------------------------------------------
// Each proves an assertion above is load-bearing rather than vacuously green.

console.log('\n# negative controls');
A.ok('N1 the phone pattern the tripwire uses really matches the shapes it claims',
  /\d{3}[-. ]\d{3}[-. ]\d{4}/.test('555-555-0101') &&
  /\d{3}[-. ]\d{3}[-. ]\d{4}/.test('555.555.0102') &&
  /\d{3}[-. ]\d{3}[-. ]\d{4}/.test('555 555 0103'));
A.ok('N2 an unsanitized scope WOULD carry the phone (so the sanitize assertions are not vacuous)',
  /\d{3}[-. ]\d{3}[-. ]\d{4}/.test('breaker tripped, call 555-555-0104'));
A.ok('N3 the egress guard is capable of firing',
  ('var x = fetch(' + '"/api")').indexOf('fetch(') !== -1);
A.ok('N4 the .click() count guard is capable of firing',
  (('a.click()' + 'b.click()').match(/\.click\(\)/g) || []).length === 2);

A.finish();
