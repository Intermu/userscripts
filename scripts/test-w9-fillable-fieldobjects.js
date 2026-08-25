// test-w9-fillable-fieldobjects.js - node harness for the FILLABLE W-9 Tax ID reader (audit F1).
//
// THE DEFECT (live in 0.9.5, on main): readDoc built the fillable Tax ID from fillableFields(raw),
// which regexes every /T(name)../V(value) pair across the ENTIRE vendor-supplied PDF, first
// occurrence in BYTE ORDER winning, with NO test that the matched /T is a live member of the
// document's AcroForm /Fields tree. So a vendor can plant a decoy /T(f1_14)/V(...) earlier in byte
// order (or leave an orphaned field object) and the tool extracts a Tax ID that differs from the
// one the form renders, then prefills Umbrava's Tax ID for the operator to accept. The recorded TIN
// drives vendor payment and 1099 reporting, so a vendor-steered wrong TIN is an integrity/compliance
// exploit - the fillable twin of the scanned-path blocker already closed. See
// wiki/security-audit-untested-writes-2026-08-24 (F1) and wiki/w9-part-i-caption-anchor.
//
// THE FIX (0.9.6): read the fillable fields from pdf.js getFieldObjects() - the AUTHORITATIVE
// AcroForm /Fields tree, resolved through the catalog, so it returns only the fields a viewer
// actually renders. A planted or orphaned /T that is not in that tree is simply absent. The raw
// /T../V sweep is kept ONLY as a fallback for when getFieldObjects returns nothing (image-only or
// non-AcroForm PDF). The field object's charLimit is used as a comb-width validator a byte regex
// cannot see.
//
// WHAT THIS HARNESS PROVES, AND WHAT IT DOES NOT. It slices the shipped pure functions
// (w9FromFieldObjects, chooseFillable, extractW9Fillable, fillableFields, normKey, leafName) and
// runs them over a SYNTHETIC getFieldObjects() object plus raw byte strings. That proves the
// SELECTION LOGIC - that an authoritative field beats a byte-order-earlier decoy, that charLimit
// rejects a wrong-width plant, that the fallback still reads a non-AcroForm form. It does NOT prove
// that live pdf.js returns the field shape assumed here; that is the live gate (drop a real IRS
// W-9, and a decoy-planted copy of it, in a browser). getFieldObjects was exercised end-to-end in
// node against a real form during the 0.9.1/0.9.2 measurement (wiki/vendor-intake-tin-blocker-live).
//
// Every negative control below reverts one guarantee in the sliced source and asserts THIS harness
// goes red. mutate() throws if its target string is absent or not unique, so a control that fails
// to apply cannot masquerade as a passing test (see wiki/negative-control-silent-noop).
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-w9-fillable-fieldobjects.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-vendor-intake.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = full.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found: ' + JSON.stringify(start));
  if (full.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique: ' + JSON.stringify(start));
  var b = full.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start: ' + JSON.stringify(end));
  return full.slice(a, b);
}

// unesc (used by fieldOccurrences/fillableFields), classToEntity (used by extractW9Fillable), and
// the field-name reader block: decodeName -> chooseFillable, stopping BEFORE the async
// readFieldObjects (it references pdfjsLib/GM_getResourceURL, which this pure harness never calls).
var S_UNESC = slice('  function unesc(x) {', '  function fieldsFromStr(s) {', 'unesc');
var S_CLASS = slice('  function classToEntity(c) {', '  // A ZIP+4 is nine digits', 'classToEntity');
var S_MAIN = slice('  function decodeName(bytes) {', '  // Load the PDF once through pdf.js', 'field-name reader block');

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 80)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 80)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

function build(mainSrc) {
  var src = S_UNESC + '\n' + S_CLASS + '\n' + (mainSrc || S_MAIN) +
    '\n; return { w9FromFieldObjects: w9FromFieldObjects, chooseFillable: chooseFillable,' +
    ' extractW9Fillable: extractW9Fillable, fillableFields: fillableFields,' +
    ' normKey: normKey, leafName: leafName };';
  return new Function(src)();
}
var M = build();

// ---- fixtures ------------------------------------------------------------------------------
// A pdf.js getFieldObjects() result for a filled IRS W-9. Keys are FULLY-QUALIFIED dotted names,
// values are arrays of widget objects; text fields carry .value + .charLimit, the classification is
// a radiobutton whose .value is the selected export ("6" = LLC). f1_01/f1_02/... exercise normKey's
// leading-zero normalisation (an older-revision numbering) alongside f1_14/f1_15.
function realFieldObjects(opts) {
  opts = opts || {};
  var P = 'topmostSubform[0].Page1[0].';
  var o = {};
  o[P + 'f1_01[0]'] = [{ name: 'f1_01[0]', value: 'Northgate Sales & Service LLC', type: 'text', charLimit: 0 }];
  o[P + 'f1_02[0]'] = [{ name: 'f1_02[0]', value: (opts.dba || ''), type: 'text', charLimit: 0 }];
  o[P + 'f1_07[0]'] = [{ name: 'f1_07[0]', value: '118 Mill Road', type: 'text', charLimit: 0 }];
  o[P + 'f1_08[0]'] = [{ name: 'f1_08[0]', value: 'Sparta, NJ 07871', type: 'text', charLimit: 0 }];
  o[P + 'f1_14[0]'] = [{ name: 'f1_14[0]', value: (opts.einA === undefined ? '12' : opts.einA), type: 'text', charLimit: (opts.einAlim === undefined ? 2 : opts.einAlim) }];
  o[P + 'f1_15[0]'] = [{ name: 'f1_15[0]', value: (opts.einB === undefined ? '3456789' : opts.einB), type: 'text', charLimit: (opts.einBlim === undefined ? 7 : opts.einBlim) }];
  o[P + 'c1_1[0]'] = [{ name: 'c1_1[0]', value: (opts.radio === undefined ? '6' : opts.radio), type: 'radiobutton' }];
  return o;
}

// Raw bytes carrying a DECOY EIN planted early in byte order. On a genuine IRS W-9 the real values
// live in compressed object streams, so any cleartext plant precedes them and the byte-order-first
// sweep reads the plant. getFieldObjects never sees it (it is not in the /Fields tree).
function rawWithDecoy(a, b) {
  return '%PDF-1.7\n'
    + '1 0 obj\n<< /T (f1_14[0]) /V (' + a + ') >>\nendobj\n'
    + '2 0 obj\n<< /T (f1_15[0]) /V (' + b + ') >>\nendobj\n'
    + '3 0 obj\n<< /T (f1_1[0]) /V (Decoy Holdings LLC) >>\nendobj\n'
    + '4 0 obj\n<< /T (c1_1[0]) /V /6 >>\nendobj\n';
}

// A legitimate NON-AcroForm-recognised fillable PDF that pdf.js could not field-read: the raw sweep
// is the only reader left, and it must still work (this is the fallback the design keeps).
function rawLegit() {
  return '%PDF-1.7\n'
    + '10 0 obj\n<< /T (f1_1[0]) /V (Riverside Sales & Service) >>\nendobj\n'
    + '11 0 obj\n<< /T (f1_7[0]) /V (5 Depot St) >>\nendobj\n'
    + '12 0 obj\n<< /T (f1_8[0]) /V (Erie, PA 16501) >>\nendobj\n'
    + '13 0 obj\n<< /T (f1_14[0]) /V (45) >>\nendobj\n'
    + '14 0 obj\n<< /T (f1_15[0]) /V (6789012) >>\nendobj\n'
    + '15 0 obj\n<< /T (c1_1[0]) /V /6 >>\nendobj\n';
}

// ---- 1. the mapping: getFieldObjects -> the { text, radioN, names, charLimit } shape -------------
function section1() {
  console.log('\n1. w9FromFieldObjects maps authoritative fields correctly');
  var ff = M.w9FromFieldObjects(realFieldObjects());
  A.eq('leaf + normKey: f1_01[0] -> f1_1 (leading zero normalised)', ff.text.f1_1, 'Northgate Sales & Service LLC');
  A.eq('f1_07[0] -> f1_7 address', ff.text.f1_7, '118 Mill Road');
  A.eq('f1_14[0] -> f1_14 EIN part 1', ff.text.f1_14, '12');
  A.eq('f1_15[0] -> f1_15 EIN part 2', ff.text.f1_15, '3456789');
  A.eq('classification radio -> export "6"', ff.radioN, '6');
  A.eq('charLimit captured for f1_14', ff.charLimit.f1_14, 2);
  A.eq('charLimit captured for f1_15', ff.charLimit.f1_15, 7);
  A.ok('a zero charLimit (no limit) is NOT recorded', !('f1_1' in ff.charLimit), JSON.stringify(ff.charLimit));
  var w9 = M.extractW9Fillable(ff);
  A.eq('the authoritative EIN reads', w9.tin, '12-3456789');
  A.eq('...as an EIN', w9.tinKind, 'ein');
  A.eq('the LLC classification maps to an entity', w9.entity, 'LLC');
  A.eq('the company name reads', w9.name, 'Northgate Sales & Service LLC');
}

// ---- 2. the hazard is real: the raw sweep alone reads the DECOY --------------------------------
function section2() {
  console.log('\n2. the fixture reproduces the F1 hazard (the raw sweep trusts a byte-order plant)');
  // If this does not hold, everything below proves nothing (see w9-part-i-caption-anchor's
  // "prove the fixture reproduces the hazard" discipline).
  var swept = M.fillableFields(rawWithDecoy('99', '9999999'));
  A.eq('raw sweep picks the planted f1_14', swept.text.f1_14, '99');
  A.eq('raw sweep picks the planted f1_15', swept.text.f1_15, '9999999');
  A.eq('...and extractW9Fillable turns the plant into the Tax ID', M.extractW9Fillable(swept).tin, '99-9999999');
  A.eq('the raw sweep also reads the planted NAME', swept.text.f1_1, 'Decoy Holdings LLC');
}

// ---- 3. the fix: authoritative fields beat the byte-order-earlier decoy ------------------------
function section3() {
  console.log('\n3. authoritative getFieldObjects beats the planted decoy (the F1 fix)');
  var authoritative = M.w9FromFieldObjects(realFieldObjects());   // real EIN 12-3456789
  var raw = rawWithDecoy('99', '9999999');                        // decoy 99-9999999 planted first
  var ff = M.chooseFillable(authoritative, raw);
  A.eq('chooseFillable returns the authoritative map, not the raw sweep', ff.text.f1_14, '12');
  A.eq('the extracted Tax ID is the RENDERED value, not the decoy', M.extractW9Fillable(ff).tin, '12-3456789');
  A.ok('the decoy value never appears in the chosen field map',
    ff.text.f1_14 !== '99' && ff.text.f1_15 !== '9999999', JSON.stringify(ff.text));
  A.eq('the authoritative NAME wins over the planted decoy name', M.extractW9Fillable(ff).name, 'Northgate Sales & Service LLC');
}

// ---- 4. charLimit as a comb-width validator (what a byte regex cannot see) ---------------------
function section4() {
  console.log('\n4. charLimit rejects a wrong-width comb field that the length check would accept');
  // A plant sitting in an f1_14 field whose declared width is 5, not 2, but whose value is a
  // plausible 2 digits. The hardcoded 2/7 length check would ACCEPT '99'; charLimit (5) rejects it.
  var wrongWidth = M.w9FromFieldObjects(realFieldObjects({ einA: '99', einAlim: 5 }));
  A.eq('a 2-digit value in a width-5 field is blanked -> no Tax ID', M.extractW9Fillable(wrongWidth).tin, '');
  // Same values, but charLimit unrecorded (width 0): now only the hardcoded length gate applies, so
  // it reads - which isolates charLimit as the discriminator above.
  var noLimit = M.w9FromFieldObjects(realFieldObjects({ einA: '99', einAlim: 0, einB: '3456789', einBlim: 0 }));
  A.eq('the SAME values with no declared width read (charLimit was the discriminator)', M.extractW9Fillable(noLimit).tin, '99-3456789');
}

// ---- 5. the fallback is preserved (primary-plus-fallback, not sole-reader) ---------------------
function section5() {
  console.log('\n5. the raw-sweep fallback still reads a form pdf.js could not field-read');
  // authoritative == null (getFieldObjects returned nothing): the raw sweep is the only reader left.
  var ff = M.chooseFillable(null, rawLegit());
  A.eq('fallback reads the EIN from the raw sweep', M.extractW9Fillable(ff).tin, '45-6789012');
  A.eq('fallback reads the name', M.extractW9Fillable(ff).name, 'Riverside Sales & Service');
  // An empty authoritative map (names.length 0) is treated as "no authoritative fields" -> fallback.
  var ff2 = M.chooseFillable({ text: {}, radioN: '', names: [], charLimit: {} }, rawLegit());
  A.eq('an empty authoritative map also falls back', M.extractW9Fillable(ff2).tin, '45-6789012');
}

// ---- 6. NEGATIVE CONTROLS: revert a guarantee, assert this harness reddens ---------------------
function section6() {
  console.log('\n6. negative controls (each must redden a probe above)');

  // M1: the core of the fix - revert chooseFillable to raw-first, ignoring the authoritative map.
  // This is exactly the 0.9.5 behaviour, and the decoy must win again.
  var m1src = mutate(S_MAIN,
    'return (authoritative && authoritative.names && authoritative.names.length) ? authoritative : fillableFields(raw);',
    'return fillableFields(raw);');
  var m1 = build(m1src);
  var decoyWins = M1_tin(m1) === '99-9999999';
  var realWins = M1_tin(M) === '12-3456789';
  A.ok('M1 reverting to the raw-sweep reader lets the byte-order decoy win again', decoyWins && realWins,
    'mutated=' + M1_tin(m1) + ' real=' + M1_tin(M));

  // M2: drop the charLimit validator (accept the digits regardless of declared width). The
  // wrong-width plant from section 4 now reads instead of blanking.
  var m2src = mutate(S_MAIN,
    "return (typeof cl[key] === 'number' && d.length !== cl[key]) ? '' : d;",
    'return d;');
  var m2 = build(m2src);
  var wrongWidth = m2.w9FromFieldObjects(realFieldObjects({ einA: '99', einAlim: 5 }));
  A.ok('M2 removing the charLimit check lets a wrong-width comb field read', m2.extractW9Fillable(wrongWidth).tin === '99-3456789',
    'got ' + m2.extractW9Fillable(wrongWidth).tin);

  // M3: break the empty-map guard so an authoritative map with zero fields wins over the fallback,
  // which would blank a form pdf.js could not field-read (a functional regression, not a leak).
  var m3src = mutate(S_MAIN,
    'return (authoritative && authoritative.names && authoritative.names.length) ? authoritative : fillableFields(raw);',
    'return authoritative ? authoritative : fillableFields(raw);');
  var m3 = build(m3src);
  var ff = m3.chooseFillable({ text: {}, radioN: '', names: [], charLimit: {} }, rawLegit());
  A.ok('M3 dropping the names.length guard makes an empty map swallow the fallback', m3.extractW9Fillable(ff).tin === '',
    'got ' + m3.extractW9Fillable(ff).tin);
}
// helper for M1: the authoritative-beats-decoy outcome under a given module.
function M1_tin(mod) {
  var authoritative = mod.w9FromFieldObjects(realFieldObjects());
  return mod.extractW9Fillable(mod.chooseFillable(authoritative, rawWithDecoy('99', '9999999'))).tin;
}

console.log('W-9 fillable field-object reader (audit F1) - ' + path.basename(SRC));
try {
  section1(); section2(); section3(); section4(); section5(); section6();
  A.finish();
} catch (e) {
  console.error('\nHARNESS ERROR: ' + (e && e.stack || e));
  process.exit(1);
}
