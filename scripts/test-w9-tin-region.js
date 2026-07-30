// test-w9-tin-region.js - node harness for the W-9 Tax ID region (round-5 BLOCKER 1 + council).
//
// THE DEFECT (live in 0.9.0, ed77580): findTIN searched the WHOLE page and returned the first
// 9-digit run it found, so a vendor could choose the Tax ID Broadway records for them. A planted
// `12 3456789` on line 7 ("List account number(s) here") beats the real comb; a routing number
// above Part I becomes the Tax ID. Silent - the toast never prints the value.
//
// THE FIRST REPAIR WAS WORSE, and this file exists mostly to stop that recurring. Anchoring on
// the first occurrence of a caption PHRASE failed twice over:
//   - the phrase is text a vendor prints on their own document, so the window moved to them, and
//     a planted `Social security number 021000021` came back as `021-00-0021` - the invented
//     grouping making a routing number read as a well-formed SSN
//   - on the REAL form both phrases occur first inside Part I's instruction prose, 451 chars
//     above the box labels, so a 320-char window closed before the comb: blank on every scan
//
// >>> THE FIXTURE BELOW CARRIES THE REAL PART I PROSE. <<<
// Every previous fixture in this project truncated it, which is exactly why five rounds shipped
// green while broken and why an indexOf -> lastIndexOf mutant survived all 14 cases of the last
// suite. The caption-bearing sentences are verbatim from a measured extraction of the blank IRS
// form (Rev. March 2024); see wiki/w9-part-i-caption-anchor.md for the offsets.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-w9-tin-region.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-vendor-intake.user.js');

function slice(startMark, endMark) {
  var t = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');
  var a = t.indexOf(startMark), b = t.indexOf(endMark);
  if (a === -1 || b === -1) throw new Error('marker not found: ' + (a === -1 ? startMark : endMark));
  return t.slice(a, b);
}
// classToEntity sits above the TIN block and extractW9FromText calls it.
var src0 = slice('  function classToEntity', '  // A ZIP+4 is nine digits');
// Covers looksLikeZip4/groupedKind/fmtTIN, the TIN REGION block, and findTIN itself.
var src = slice('  // A ZIP+4 is nine digits', '  function extractW9(af) {');
// ...and the FIELD extractor, which the previous suite stopped short of, so plausibleValue, the
// certification anchor, the street/city part anchors and the ZIP separators had zero coverage
// while being reported as closed (council UAT-5c).
var src2 = slice('  // Of the (up to 2) rasterized pages', '  // ---- Field mapping ---');
var mod = new Function(src0 + '\n' + src + '\n' + src2 +
  '\n; return { findTIN: findTIN, tinRegion: tinRegion, looksLikeZip4: looksLikeZip4,' +
  ' plausibleValue: plausibleValue, extractW9FromText: extractW9FromText, pickFormPage: pickFormPage };')();
var findTIN = mod.findTIN, tinRegion = mod.tinRegion;

// ---- the REAL Part I block --------------------------------------------------------------
// Verbatim from the measured extraction. Note BOTH caption phrases appear here, mid-sentence,
// BEFORE the box labels below. That ordering is the whole point of this fixture.
var PART_I_PROSE = [
  'Part I Taxpayer Identification Number (TIN)',
  'Enter your TIN in the appropriate box. The TIN provided must match the name given on line 1 to avoid ',
  'backup withholding. For individuals, this is generally your social security number (SSN). However, for a ',
  'resident alien, sole proprietor, or disregarded entity, see the instructions for Part I, later. For other ',
  'entities, it is your employer identification number (EIN). If you do not have a number, see How to get a ',
  'TIN, later.',
  'Note: If the account is in more than one name, see the instructions for line 1. See also What Name and',
  'Number To Give the Requester for guidelines on whose number to enter.'
].join('\n');

// The box labels, which DO own their own lines, and the comb between them.
function labelBlock(ssnComb, einComb) {
  return [
    'Social security number',
    ssnComb === undefined ? '- -' : ssnComb,
    'or',
    'Employer identification number',
    einComb === undefined ? '-' : einComb
  ].join('\n');
}

// A full page 1. `opts.accountLine` and `opts.aboveJunk` are VENDOR-CONTROLLED text.
function w9Page(opts) {
  opts = opts || {};
  return [
    'Form W-9',
    '(Rev. March 2024)',
    'Department of the Treasury  Internal Revenue Service',
    'Request for Taxpayer Identification Number and Certification',
    '1 Name of entity/individual. An entry is required.',
    'Northgate Sales & Service LLC',
    '2 Business name/disregarded entity name, if different from above',
    '3a Check the appropriate box for federal tax classification',
    '[x] Limited liability company',
    opts.aboveJunk || '',
    '5 Address (number, street, and apt. or suite no.) See instructions.',
    '118 Mill Road',
    '6 City, state, and ZIP code',
    'Sparta, NJ 07871',
    "Requester's name and address (optional)",
    '7 List account number(s) here (optional)',
    opts.accountLine || '',
    PART_I_PROSE,
    opts.insideJunk || '',
    labelBlock(opts.ssnComb, opts.einComb === undefined ? '9 8 7 6 5 4 3 2 1' : opts.einComb),
    'Part II Certification',
    'Under penalties of perjury, I certify that:'
  ].filter(function (l) { return l !== ''; }).join('\n');
}

// ---- 1. THE REGRESSION THAT BROKE THE LAST FIX -------------------------------------------
function section1() {
  console.log('\n1. the real Part I prose must not blank the Tax ID (council QA-1c)');
  var page = w9Page();
  var low = page.toLowerCase();

  // Prove the fixture actually reproduces the hazard, or the rest of this file proves nothing.
  A.ok('fixture contains a PROSE "social security number" before the label',
    low.indexOf('social security number') < low.lastIndexOf('social security number'),
    'first=' + low.indexOf('social security number') + ' last=' + low.lastIndexOf('social security number'));
  A.ok('fixture contains a PROSE "employer identification number" before the label',
    low.indexOf('employer identification number') < low.lastIndexOf('employer identification number'));
  A.ok('the gap is wide enough to have defeated a 320-char window',
    low.lastIndexOf('employer identification number') - low.indexOf('social security number') > 320,
    'gap=' + (low.lastIndexOf('employer identification number') - low.indexOf('social security number')));

  A.eq('the comb is still found on a clean real-shaped form', findTIN(page).tin, '987654321');

  var reg = tinRegion(page);
  A.ok('region floor is BELOW the prose captions',
    reg.lo > low.indexOf('employer identification number'), 'lo=' + reg.lo);
  A.eq('region floor is the first LINE-START caption', reg.lo, page.indexOf('Social security number'));
  A.eq('region ceiling is Part II', reg.hi, page.indexOf('Part II Certification'));
}

// ---- 2. vendor-controlled numbers ---------------------------------------------------------
function section2() {
  console.log('\n2. vendor-controlled numbers must not become the Tax ID');
  A.eq('planted account number loses to the real comb',
    findTIN(w9Page({ accountLine: '12 3456789' })).tin, '987654321');
  A.eq('routing number above Part I is not the TIN',
    findTIN(w9Page({ aboveJunk: 'Remit to: First National, routing 021000021' })).tin, '987654321');
  A.eq('hyphenated plant above Part I is not the TIN',
    findTIN(w9Page({ accountLine: 'Acct 12-3456789' })).tin, '987654321');
  A.eq('SSN-shaped plant above Part I is not the TIN',
    findTIN(w9Page({ accountLine: 'Ref 123-45-6789' })).tin, '987654321');

  // The exploit that beat the FIRST repair: a caption phrase printed by the vendor.
  A.eq('planted CAPTION above Part I does not move the region',
    findTIN(w9Page({ accountLine: 'Employer identification number 12-3456789' })).tin, '987654321');
  A.eq('planted caption + routing number does not yield a fake SSN',
    findTIN(w9Page({ aboveJunk: 'Social security number 021000021' })).tin, '987654321');

  // Plant a caption on its OWN line inside Part I - the only remaining aim point.
  var inside = w9Page({ insideJunk: 'Employer identification number\n12-3456789' });
  A.eq('a third caption line inside Part I refuses the whole region', findTIN(inside).tin, '');
  A.eq('...and tinRegion says so explicitly', tinRegion(inside), null);

  // Unreadable comb plus a plant: blank must beat the attacker's number.
  A.eq('unreadable comb + plant -> blank, not the plant',
    findTIN(w9Page({ accountLine: '12 3456789', einComb: '417  7 7' })).tin, '');
}

// ---- 3. structure required ----------------------------------------------------------------
function section3() {
  console.log('\n3. no Part I structure means no Tax ID');
  A.eq('page with no headings -> null region', tinRegion('some other document 123456789'), null);
  A.eq('...and findTIN returns blank', findTIN('some other document 123456789').tin, '');

  var twoForms = w9Page() + '\n' + w9Page();
  A.eq('two Part I headings (unscoped packet) -> refused', tinRegion(twoForms), null);

  var noPartII = w9Page().replace('Part II Certification', 'Signature block');
  A.eq('missing Part II -> refused', tinRegion(noPartII), null);

  // The masthead contains "Taxpayer Identification Number"; it must never act as the anchor.
  var page = w9Page();
  A.ok('floor is far below the masthead', tinRegion(page).lo > page.indexOf('Request for Taxpayer'));
}

// ---- 4. attribution unchanged (the 0.8.9 property) ----------------------------------------
function section4() {
  console.log('\n4. side-by-side attribution still behaves as 0.8.9 made it');
  A.eq('both captions precede the run -> bare digits, no invented grouping', findTIN(w9Page()).kind, '');
  A.eq('printed 3-2-4 grouping reads as SSN', findTIN(w9Page({ einComb: '987-65-4321' })).kind, 'ssn');
  A.eq('printed 2-7 grouping reads as EIN', findTIN(w9Page({ einComb: '12-3456789' })).kind, 'ein');
  A.eq('empty comb artifacts still refused', findTIN(w9Page({ einComb: '| | | | | | | | |' })).tin, '');
  A.eq('all-same-digit run still refused', findTIN(w9Page({ einComb: '1 1 1 1 1 1 1 1 1' })).tin, '');
}

// ---- 5. ZIP+4 net, both directions --------------------------------------------------------
function section5() {
  console.log('\n5. ZIP+4 confusion is resolved structurally, not by heuristic');
  // The separator widening still matters for the pristine pre-scans.
  A.ok('a spaced ZIP+4 is recognised', mod.looksLikeZip4('07081 1234'));
  A.ok('an OCR pipe separator is recognised too', mod.looksLikeZip4('07081|1234'));
  A.ok('a comma separator is recognised too', mod.looksLikeZip4('07081,1234'));
  A.ok('nine bare digits are not a ZIP+4', !mod.looksLikeZip4('123456789'));

  // A genuine comb read as 5 digits, separator, 4 digits is INDISTINGUISHABLE from a ZIP+4.
  // There is no heuristic that separates them, so the old net threw away real Tax IDs. Inside
  // the Part I..Part II span there is no address, so the run is a TIN and is accepted.
  A.eq('a comb read as `12345 6789` is accepted inside Part I',
    findTIN(w9Page({ einComb: '12345 6789' })).tin, '123456789');
  A.eq('so is a hyphenated 5-4 shape, for the same reason',
    findTIN(w9Page({ einComb: '07081-1234' })).tin, '070811234');

  // What actually keeps a ZIP out is the ceiling: line 6 and the requester panel are above
  // Part I, so no address can be scanned however it happens to be shaped.
  var page = w9Page();
  var reg = tinRegion(page);
  A.ok('the city/state/ZIP line sits BELOW the region floor',
    page.indexOf('Sparta, NJ 07871') < reg.lo, 'zip@' + page.indexOf('Sparta, NJ 07871') + ' lo=' + reg.lo);
  A.ok('the requester panel also sits above the region',
    page.indexOf("Requester's name") < reg.lo);
  A.eq('and a ZIP+4 on line 6 never becomes the Tax ID',
    findTIN(w9Page({ aboveJunk: 'Mail to 07081-1234' })).tin, '987654321');
}

// ---- 6. the field-value gate (round-5 leftovers, council UAT-5c) --------------------------
function section6() {
  console.log('\n6. plausibleValue accepts real names and still rejects glyph soup');
  var pv = mod.plausibleValue;

  // Names the old gate blanked.
  A.ok('GE (2 chars) is a company name', pv('GE'));
  A.ok('3M (letter+digit, 2 chars) is a company name', pv('3M'));
  A.ok('H&R is a company name', pv('H&R'));
  A.ok("R|verside's Sales & Service survives an OCR pipe", pv("R|verside's Sales & Service"));
  A.ok('a curly apostrophe is not a reject', pv('O’Brien Mechanical Inc'));
  A.ok('an ordinary long name passes', pv('Northgate Sales & Service LLC'));
  A.ok('a street address passes', pv('118 Mill Road'));

  // Glyph soup that reached the live form in earlier rounds - must STILL be rejected.
  A.ok('checkbox-column soup is rejected', !pv('o | 38'));
  A.ok('comb-box soup is rejected', !pv('1 fein) > 4 HA0)\\'));
  A.ok('a degree-mark comb read is rejected', !pv('417° 7 7'));
  A.ok('a single character is rejected', !pv('x'));
  A.ok('box edges are rejected', !pv('| | | |'));
  A.ok('empty is rejected', !pv(''));
}

// ---- 7. label anchors no longer eat real values --------------------------------------------
function section7() {
  console.log('\n7. certification / part anchors stop matching inside real values');
  var page = w9Page();

  // `certification` unanchored blanked a company whose NAME contains it.
  var certPage = page.replace('Northgate Sales & Service LLC', 'Rand Certification Inc');
  A.eq('a company named "Rand Certification Inc" is read', mod.extractW9FromText(certPage).name, 'Rand Certification Inc');

  // `part` unanchored matched inside Sparta and discarded the city line whole.
  var got = mod.extractW9FromText(page);
  A.eq('city survives a place name containing "part"', got.city, 'Sparta');
  A.eq('state', got.state, 'NJ');
  A.eq('zip', got.zip, '07871');
  A.eq('street still reads', got.street, '118 Mill Road');
  A.eq('and the TIN still comes through the same call', got.tin, '987654321');
}

// ---- 8. grouping forcing (PEN-3) -----------------------------------------------------------
function section8() {
  console.log('\n8. a printed caption cannot force the wrong grouping');
  // Both captions precede the run in the genuine side-by-side layout -> bare digits.
  A.eq('genuine layout emits bare digits', findTIN(w9Page()).kind, '');
  // PEN-3: a lone digit between the two captions defeated the adjacency test, flipping a real EIN
  // to 'ssn' so fmtTIN rendered 123456789 as 123-45-6789 - right digits, wrong format, which
  // passes an eyeball check and fails IRS name/TIN matching.
  //
  // Aiming this is fiddly, and getting it wrong makes the test look like it passes against the
  // OLD code too. The planted SSN mention has to be the LAST caption before the run (so it must
  // sit AFTER the real EIN label), it must have a digit between it and that label, and it must
  // NOT be alone on its line or tinRegion's duplicate-caption refusal rejects the page first and
  // the attribution path is never reached.
  var forced = w9Page().replace(
    'Employer identification number\n9 8 7 6 5 4 3 2 1',
    'Employer identification number\nref 5 social security number\n9 8 7 6 5 4 3 2 1');
  A.ok('the plant is positioned to actually reach attribute()', tinRegion(forced) !== null);
  var r = findTIN(forced);
  A.eq('the digits still read correctly', r.tin.replace(/\D/g, ''), '987654321');
  A.ok('a digit between captions does not force a grouping', r.kind !== 'ssn', JSON.stringify(r));
  A.ok('...and the emitted value is not a fake SSN', !/^\d{3}-\d{2}-\d{4}$/.test(r.tin), r.tin);
}

console.log('W-9 Tax ID region - ' + path.basename(SRC));
try {
  section1(); section2(); section3(); section4(); section5(); section6(); section7(); section8();
  A.finish();
} catch (e) {
  console.error('\nHARNESS ERROR: ' + (e && e.stack || e));
  process.exit(1);
}
