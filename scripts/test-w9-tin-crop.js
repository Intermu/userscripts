// test-w9-tin-crop.js - node harness for the SCANNED W-9 Tax ID crop pass (vendor-intake 0.9.4).
//
// WHY THIS FILE EXISTS. 0.9.3 introduced the crop pass with NO harness in version control at all:
// `test-w9-tin-region.js` scored 59/59 on 0.9.2 and 0.9.3 alike, because it tests findTIN - a
// function the scanned path no longer calls for the Tax ID - and the "7/7 fixtures + 3/4 mutations"
// quoted for 0.9.3 lived in a scratchpad that is not in this repo. A four-lens council then found
// two defects in the untested code, both of which this file pins:
//
//   BLOCKER 1 - an EMPTY comb could FABRICATE a Tax ID. `tessedit_char_whitelist:'0123456789'`
//   forces every glyph the engine sees to a digit, so the comb's printed cell edges can come back
//   as a well-formed nine-digit number. 0.9.2's guard (a majority of the characters that formed the
//   run must have been digits BEFORE any substitution) has no whitelisted equivalent, and 0.9.3
//   caught only the all-same-digit artifact - non-uniform is what a scan makes. 0.9.4 answers with
//   two defences that do not need the engine's cooperation: an ink profile over the crop's PIXELS,
//   and one corroborating read with the whitelist DROPPED.
//
//   BLOCKER 2 - the 4-pad consensus asserted an independence the pads do not have. On a 40px row
//   0.7 and 0.85 are 6px apart and read the same ink, so their agreement is ONE measurement
//   reported as two. It was also non-monotonic (three-to-one refused, two votes plus two malformed
//   reads accepted) and it deleted 0.9.2's uncertainty signal, so a wrong Tax ID rendered exactly
//   like a right one. 0.9.4 counts identical crop geometry once, and separates ACCEPTED from
//   CONFIRMED - unconfirmed reads come back as bare digits.
//
// WHAT THIS HARNESS IS NOT. It stubs the OCR engine, so it proves the LOGIC around the engine and
// nothing about recognition accuracy on a real scan. Every fixture in this project is still a
// vector render; the acceptance gate for merging remains one real scanned W-9 (masked output).
// Do not read a green run here as evidence that the Tax ID reads correctly on paper.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-w9-tin-crop.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-vendor-intake.user.js');
var RAW = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(text, startMark, endMark) {
  var a = text.indexOf(startMark), b = text.indexOf(endMark);
  if (a === -1 || b === -1) throw new Error('marker not found: ' + (a === -1 ? startMark : endMark));
  return text.slice(a, b);
}

// ---- build the module under test ------------------------------------------------------------
// fmtTIN is what renders the CONFIRMED result, so it comes from the source too rather than being
// re-implemented here - a re-implementation would agree with a broken original.
function build(text) {
  var srcFmt = slice(text, '  function fmtTIN(', '  // ===== TIN REGION');
  var srcCrop = slice(text, '  var TIN_SSN_WORDS', '  // Returns { text, tin, tinKind, tinConfident');
  var body = srcFmt + '\n' + srcCrop +
    '\n; return { ocrTinByCrop: ocrTinByCrop, tinReadRow: tinReadRow, tinInkStats: tinInkStats,' +
    ' tinRowHasInk: tinRowHasInk, tinDigitMajority: tinDigitMajority, tinFindPhrase: tinFindPhrase,' +
    ' tinLines: tinLines, fmtTIN: fmtTIN, TIN_PADS: TIN_PADS, TIN_MIN_VOTES: TIN_MIN_VOTES,' +
    ' TIN_CONFIRM_VOTES: TIN_CONFIRM_VOTES, TIN_PAD_SEP: TIN_PAD_SEP };';
  return new Function('document', body);
}
// A mutation that does not apply is a green run that proves nothing, so every replacement is
// checked for a match and throws when it finds none.
function mutate(text, from, to) {
  if (text.indexOf(from) === -1) throw new Error('MUTATION DID NOT APPLY (source moved?): ' + from);
  return text.replace(from, to);
}

// ---- browser stubs ---------------------------------------------------------------------------
// A page is a width/height plus ink(x,y) -> true when that pixel is dark. tinCropBox copies a
// rectangle out of it; tinCanvasInk reads that rectangle back. Both go through these.
function makeDocument() {
  return {
    createElement: function () {
      var cv = { width: 0, height: 0, __ctx: null };
      cv.getContext = function () {
        if (cv.__ctx) return cv.__ctx;
        cv.__ctx = {
          drawImage: function (src, sx, sy) { cv.__src = src; cv.__sx = sx; cv.__sy = sy; },
          getImageData: function (x, y, w, h) {
            var d = new Uint8Array(w * h * 4), i, px, py, o;
            for (py = 0; py < h; py++) {
              for (px = 0; px < w; px++) {
                o = (py * w + px) * 4;
                var dark = cv.__src && cv.__src.ink ? cv.__src.ink(cv.__sx + px, cv.__sy + py) : false;
                d[o] = d[o + 1] = d[o + 2] = dark ? 0 : 255;
                d[o + 3] = 255;
              }
            }
            return { data: d, width: w, height: h };
          }
        };
        return cv.__ctx;
      };
      return cv;
    }
  };
}

// ---- fixture geometry (mirrors the real form's stacking: SSN box above EIN box) ---------------
var SSN_LABEL = { x0: 422, x1: 700, y0: 400, y1: 420 };
var SSN_ROW = { x0: 424, x1: 690, y0: 430, y1: 450 };   // lh 20 -> pads 8/14/17/20 px
var EIN_LABEL = { x0: 422, x1: 700, y0: 470, y1: 490 };
var EIN_ROW = { x0: 424, x1: 690, y0: 500, y1: 520 };

function words(text, box) {
  var parts = String(text).split(' '), n = parts.length, w = (box.x1 - box.x0) / n;
  return parts.map(function (p, i) {
    return { text: p, bbox: { x0: box.x0 + i * w, x1: box.x0 + (i + 1) * w, y0: box.y0, y1: box.y1 } };
  });
}
function ln(text, box) { return { text: text, bbox: { x0: box.x0, x1: box.x1, y0: box.y0, y1: box.y1 }, words: words(text, box) }; }
function psm3(lines) { return { blocks: [{ paragraphs: [{ lines: lines }] }] }; }

// Part I's instruction prose carries BOTH caption phrases before the box labels ever appear - the
// fact that sank five earlier rounds of this bug. The prose lines start where the sentence puts
// them, so they never share the labels' left edge.
function proseLines() {
  return [
    ln('for individuals this is generally your social security number ssn however for a', { x0: 60, x1: 400, y0: 300, y1: 316 }),
    ln('entities it is your employer identification number ein if you do not have a', { x0: 72, x1: 400, y0: 320, y1: 336 })
  ];
}
function formLines(opts) {
  var L = proseLines();
  L.push(ln('social security number', SSN_LABEL));
  if (!opts.ssnRowMissing) L.push(ln('987 65 4321', SSN_ROW));
  L.push(ln('employer identification number', EIN_LABEL));
  if (!opts.einRowMissing) L.push(ln('98 7654321', EIN_ROW));
  return L;
}

// ---- ink models -------------------------------------------------------------------------------
// An EMPTY comb is nine printed cells: full-height rules and nothing between them. A FILLED comb
// is the same rules plus a solid block of digit ink in the middle of every cell.
function combInk(box, filled) {
  var rules = [], i, cellW = (box.x1 - box.x0) / 9;
  for (i = 0; i <= 9; i++) rules.push(Math.round(box.x0 + i * cellW));
  return function (x, y) {
    if (y < box.y0 || y > box.y1) return false;                       // outside the row: paper
    for (i = 0; i < rules.length; i++) if (Math.abs(x - rules[i]) <= 1) return true;   // printed rule
    if (!filled) return false;
    var off = (x - box.x0) % cellW, inset = (box.y1 - box.y0) * 0.2;   // digit ink inside the cell
    return off > cellW * 0.3 && off < cellW * 0.7 && y > box.y0 + inset && y < box.y1 - inset;
  };
}
function pageInk(parts) {
  return function (x, y) { for (var i = 0; i < parts.length; i++) if (parts[i](x, y)) return true; return false; };
}
function page(inkFn) { return { width: 1700, height: 2200, ink: inkFn || function () { return false; } }; }

// ---- fake engine ------------------------------------------------------------------------------
// reads: { ssn: fn(padPx) -> text, ein: fn(padPx) -> text } for the whitelisted pass, and
// corroborate: { ssn|ein: text } for the pass that runs with the whitelist dropped.
function makeWorker(reads, corroborate) {
  var params = { tessedit_pageseg_mode: '6', tessedit_char_whitelist: '' };
  var w = {
    calls: [], params: params, paramHistory: [],
    setParameters: async function (p) {
      Object.keys(p).forEach(function (k) { params[k] = p[k]; });
      w.paramHistory.push(JSON.stringify(params));
    },
    recognize: async function (cv) {
      var mid = cv.__sy + cv.height / 2, row = null, pad;
      if (Math.abs(mid - (SSN_ROW.y0 + SSN_ROW.y1) / 2) < 6) { row = 'ssn'; pad = (cv.height - (SSN_ROW.y1 - SSN_ROW.y0)) / 2; }
      else if (Math.abs(mid - (EIN_ROW.y0 + EIN_ROW.y1) / 2) < 6) { row = 'ein'; pad = (cv.height - (EIN_ROW.y1 - EIN_ROW.y0)) / 2; }
      else if (Math.abs(mid - (EIN_LABEL.y0 + EIN_LABEL.y1) / 2) < 6) { row = 'einLabel'; pad = (cv.height - (EIN_LABEL.y1 - EIN_LABEL.y0)) / 2; }
      else { row = 'other'; pad = 0; }
      var whitelisted = params.tessedit_char_whitelist === '0123456789';
      w.calls.push({ row: row, pad: pad, whitelisted: whitelisted, h: cv.height });
      var text;
      if (!whitelisted) text = (corroborate && corroborate[row] !== undefined) ? corroborate[row] : '';
      else text = (reads && reads[row]) ? reads[row](pad) : '';
      return { data: { text: text } };
    }
  };
  return w;
}
function callsFor(worker, row, whitelisted) {
  return worker.calls.filter(function (c) { return c.row === row && c.whitelisted === whitelisted; });
}

// A read that is right at every pad, and its honest corroboration.
function steady(v) { return function () { return v; }; }
// A read that only lands at the two pads the sweep measured as good for the SSN row (0.7/0.85 of a
// 20px row = 14px and 17px), and is malformed everywhere else. This is the correlated-agreement
// case: two crops 3px apart, reported by 0.9.3 as two independent votes.
function onlyMid(v) { return function (pad) { return (pad === 14 || pad === 17) ? v : '12'; }; }

var doc = makeDocument();
var mod = build(RAW)(doc);

async function run() {
  console.log('W-9 Tax ID crop pass (vendor-intake 0.9.4)\n');

  // ===== 1. ink profile - the defence that needs no engine ====================================
  console.log('ink profile');
  function inkArray(inkFn, box) {
    var w = box.x1 - box.x0, h = box.y1 - box.y0, d = new Uint8Array(w * h * 4), x, y, o;
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      o = (y * w + x) * 4;
      var dark = inkFn(box.x0 + x, box.y0 + y);
      d[o] = d[o + 1] = d[o + 2] = dark ? 0 : 255; d[o + 3] = 255;
    }
    return { data: d, w: w, h: h };
  }
  var emptyImg = inkArray(combInk(SSN_ROW, false), SSN_ROW);
  var fullImg = inkArray(combInk(SSN_ROW, true), SSN_ROW);
  var sEmpty = mod.tinInkStats(emptyImg.data, emptyImg.w, emptyImg.h);
  var sFull = mod.tinInkStats(fullImg.data, fullImg.w, fullImg.h);
  A.ok('empty comb: the printed rules are recognised as rules', sEmpty.ruleCols >= 10, 'ruleCols=' + sEmpty.ruleCols);
  A.ok('empty comb: no ink outside the rules', sEmpty.otherDark === 0, 'otherDark=' + sEmpty.otherDark);
  A.ok('empty comb: refused as blank', mod.tinRowHasInk(sEmpty) === false, JSON.stringify(sEmpty));
  A.ok('filled comb: ink between the rules', sFull.otherDark > 0, 'otherDark=' + sFull.otherDark);
  A.ok('filled comb: accepted as filled', mod.tinRowHasInk(sFull) === true, JSON.stringify(sFull));
  A.ok('filled comb reads far above the threshold, not marginally',
    sFull.otherFrac > 4 * 0.004, 'otherFrac=' + sFull.otherFrac);
  // REGRESSION, found by this harness on the first run: the crop handed to the ink profile is
  // PADDED - a 1.0 pad makes it three times the row's height - so measuring "full height" against
  // the crop classified the comb's own rules as content and let an empty comb through to the
  // engine, which is the exact fabrication this guard exists to stop.
  var paddedBox = { x0: SSN_ROW.x0 - 6, x1: SSN_ROW.x1 + 6, y0: SSN_ROW.y0 - 20, y1: SSN_ROW.y1 + 20 };
  var paddedEmpty = inkArray(combInk(SSN_ROW, false), paddedBox);
  var paddedFull = inkArray(combInk(SSN_ROW, true), paddedBox);
  A.ok('empty comb in a 3x-padded crop is still refused',
    mod.tinRowHasInk(mod.tinInkStats(paddedEmpty.data, paddedEmpty.w, paddedEmpty.h)) === false,
    JSON.stringify(mod.tinInkStats(paddedEmpty.data, paddedEmpty.w, paddedEmpty.h)));
  A.ok('filled comb in a 3x-padded crop is still accepted',
    mod.tinRowHasInk(mod.tinInkStats(paddedFull.data, paddedFull.w, paddedFull.h)) === true);
  A.ok('padding does not dilute the density measurement',
    Math.abs(mod.tinInkStats(paddedFull.data, paddedFull.w, paddedFull.h).otherFrac - sFull.otherFrac) < 0.02,
    'padded=' + mod.tinInkStats(paddedFull.data, paddedFull.w, paddedFull.h).otherFrac + ' tight=' + sFull.otherFrac);

  var blank = inkArray(function () { return false; }, SSN_ROW);
  A.ok('blank paper: no ink at all', mod.tinInkStats(blank.data, blank.w, blank.h).otherFrac === 0);
  // Two rules 2px apart share the column between them. Discounting by COLUMN rather than by pixel
  // count is what stops that column being subtracted twice into a negative total.
  var tight = inkArray(function (x, y) {
    return (x === SSN_ROW.x0 + 10 || x === SSN_ROW.x0 + 12) && y >= SSN_ROW.y0 && y <= SSN_ROW.y1;
  }, SSN_ROW);
  A.ok('adjacent rules do not double-discount their shared neighbour',
    mod.tinInkStats(tight.data, tight.w, tight.h).otherDark === 0);

  // ===== 2. digit majority - 0.9.2's guard, restored ==========================================
  console.log('\nunwhitelisted digit majority');
  A.ok('nine clean digits pass', mod.tinDigitMajority('987654321').ok === true);
  A.ok('digits welded to the cell edges still pass', mod.tinDigitMajority('9|8|7|6|5|4|3|2|1').ok === true);
  A.ok('an empty comb read as bars fails', mod.tinDigitMajority('| | | | | | | |').ok === false);
  A.ok('an empty comb read as letters fails', mod.tinDigitMajority('I l I l I l I l I').ok === false);
  A.ok('a label line fails (it is not a comb row)', mod.tinDigitMajority('employer identification number').ok === false);
  A.ok('whitespace is not counted as a character', mod.tinDigitMajority('  987 654 321  ').chars === 9);
  // Documented limit: five digits of nine is exactly 0.9.2's bar, deliberately kept, so an
  // alternating bar/digit misread passes THIS test. The ink profile is what refuses that shape.
  A.ok('0.9.2 parity: exactly five digits of nine passes (ink profile is the defence here)',
    mod.tinDigitMajority('1I1I1I1I1').ok === true);
  A.ok('four digits of nine fails', mod.tinDigitMajority('lIl1l1l1l').ok === false);

  // ===== 3. label pairing =====================================================================
  console.log('\nlabel pairing');
  var r, w;
  w = makeWorker({ ein: steady('98 7654321') }, { ein: '98 7654321' });
  r = await mod.ocrTinByCrop(page(pageInk([combInk(EIN_ROW, true)])), psm3(formLines({ ssnRowMissing: true })), w);
  A.ok('prose captions do not pair - only the two box labels share a left edge', r.reject === '', 'reject=' + r.reject);
  A.eq('the EIN row is read and hyphenated to its label', r.tin, '98-7654321');
  A.eq('kind comes from the label, not from the digits', r.kind, 'ein');

  w = makeWorker({}, {});
  r = await mod.ocrTinByCrop(page(), psm3(proseLines()), w);
  A.eq('no box labels at all: refused, not guessed', r.reject, 'label-pairs:0');
  A.eq('...and nothing is filled', r.tin, '');

  var twoPair = formLines({ ssnRowMissing: true, einRowMissing: true });
  twoPair.push(ln('social security number', { x0: 422, x1: 700, y0: 900, y1: 920 }));
  twoPair.push(ln('employer identification number', { x0: 422, x1: 700, y0: 940, y1: 960 }));
  w = makeWorker({}, {});
  r = await mod.ocrTinByCrop(page(), psm3(twoPair), w);
  A.ok('a second caption printed in the real column refuses rather than picks',
    /^label-pairs:[2-9]/.test(r.reject), 'reject=' + r.reject);

  // ===== 4. THE FABRICATION CASE - blocker 1 ==================================================
  console.log('\nempty comb must never produce a Tax ID');
  // The engine is scripted to hand back a well-formed, non-uniform nine-digit number for a row
  // that is physically EMPTY. That is exactly what a digits-only whitelist can do to cell edges,
  // and 0.9.3 had nothing that could contradict it.
  w = makeWorker({ ein: steady('51 4131211') }, { ein: '51 4131211' });
  r = await mod.ocrTinByCrop(page(pageInk([combInk(EIN_ROW, false)])), psm3(formLines({ ssnRowMissing: true })), w);
  A.eq('an empty comb yields NO Tax ID even when the engine offers one', r.tin, '');
  A.ok('...and is named as an empty comb', /empty-comb/.test(r.reject), 'reject=' + r.reject);
  A.ok('...without spending a single OCR call on it', callsFor(w, 'ein', true).length === 0,
    JSON.stringify(w.calls));

  // Same empty row, but with the pixels unreadable (a tainted canvas returns null stats), so the
  // ink defence is unavailable and the corroborating read has to carry it alone.
  w = makeWorker({ ein: steady('51 4131211') }, { ein: '| | | | | | | | |' });
  r = await mod.ocrTinByCrop(page(pageInk([combInk(EIN_ROW, true)])), psm3(formLines({ ssnRowMissing: true })), w);
  A.eq('a bar-heavy unwhitelisted read refuses the row on its own', r.tin, '');
  A.ok('...and says why', /digit-minority/.test(r.reject), 'reject=' + r.reject);
  A.ok('the corroborating read runs with the whitelist DROPPED',
    callsFor(w, 'ein', false).length === 1, JSON.stringify(w.calls));

  // 0.9.3 assumed an empty comb produces no line at all. It does not: the nearest line under the
  // SSN label is then the EIN LABEL itself, which the crop pass would have read as a comb row.
  w = makeWorker({ einLabel: steady('98 7654321') }, { einLabel: 'employer identification number' });
  r = await mod.ocrTinByCrop(page(pageInk([combInk(EIN_ROW, true)])), psm3(formLines({ ssnRowMissing: true, einRowMissing: true })), w);
  A.eq('an empty SSN comb does not turn the EIN LABEL into a Tax ID', r.tin, '');

  // ===== 5. vote logic - blocker 2 ============================================================
  console.log('\nconsensus, independence and the uncertainty signal');
  w = makeWorker({ ein: steady('98 7654321') }, { ein: '98 7654321' });
  r = await mod.ocrTinByCrop(page(pageInk([combInk(EIN_ROW, true)])), psm3(formLines({ ssnRowMissing: true })), w);
  A.eq('four agreeing pads: CONFIRMED and hyphenated', r.tin, '98-7654321');
  A.eq('...confident flag set', r.confident, true);
  A.eq('four distinct crop heights, four reads', callsFor(w, 'ein', true).length, 4);

  // The SSN row's measured-good pads are 0.7/0.85 - 14px and 17px on a 20px row. They agree, so
  // the read is ACCEPTED, but 3px of crop apart is the same ink twice, so it is NOT confirmed.
  w = makeWorker({ ssn: onlyMid('987654321') }, { ssn: '987 65 4321' });
  r = await mod.ocrTinByCrop(page(pageInk([combInk(SSN_ROW, true)])), psm3(formLines({ einRowMissing: true })), w);
  A.eq('two correlated pads: accepted but NOT confirmed', r.confident, false);
  A.eq('...emitted as BARE DIGITS, which is the uncertainty signal', r.tin, '987654321');
  A.ok('...and it is not the hyphenated form', r.tin.indexOf('-') === -1);

  // One pad reading something else is not a minority to be outvoted; it means the row is being
  // guessed at, so the whole row goes.
  w = makeWorker({ ein: function (pad) { return pad === 20 ? '98 7654322' : '98 7654321'; } }, { ein: '98 7654321' });
  r = await mod.ocrTinByCrop(page(pageInk([combInk(EIN_ROW, true)])), psm3(formLines({ ssnRowMissing: true })), w);
  A.eq('three-to-one disagreement refuses the row', r.tin, '');
  A.ok('...named as a disagreement', /disagree/.test(r.reject), 'reject=' + r.reject);

  // Monotonicity: malformed reads may only lower the count. Two good pads plus two malformed is
  // the SAME verdict as two good pads alone - never a stronger one.
  w = makeWorker({ ein: function (pad) { return (pad === 14 || pad === 17) ? '98 7654321' : '1234'; } }, { ein: '98 7654321' });
  r = await mod.ocrTinByCrop(page(pageInk([combInk(EIN_ROW, true)])), psm3(formLines({ ssnRowMissing: true })), w);
  A.eq('two votes plus two malformed: accepted', r.tin, '987654321');
  A.eq('...but never CONFIRMED by the malformed pair', r.confident, false);

  w = makeWorker({ ein: function (pad) { return pad === 8 ? '98 7654321' : 'x'; } }, { ein: '98 7654321' });
  r = await mod.ocrTinByCrop(page(pageInk([combInk(EIN_ROW, true)])), psm3(formLines({ ssnRowMissing: true })), w);
  A.eq('a single vote is below the floor and fills nothing', r.tin, '');

  // Enough votes, but all three crops sit within 6px of each other - the count is satisfied and the
  // independence is not, so this is accepted and NOT confirmed. Mutation control M4 below is what
  // proves the separation rule and not the vote floor is doing this.
  w = makeWorker({ ein: function (pad) { return pad === 8 ? 'x' : '98 7654321'; } }, { ein: '98 7654321' });
  r = await mod.ocrTinByCrop(page(pageInk([combInk(EIN_ROW, true)])), psm3(formLines({ ssnRowMissing: true })), w);
  A.eq('three clustered votes: accepted', r.tin, '987654321');
  A.eq('...but not confirmed, because 6px of crop is one look at the same ink', r.confident, false);

  w = makeWorker({ ein: steady('111111111') }, { ein: '111111111' });
  r = await mod.ocrTinByCrop(page(pageInk([combInk(EIN_ROW, true)])), psm3(formLines({ ssnRowMissing: true })), w);
  A.eq('nine identical digits are box edges, not a TIN', r.tin, '');

  w = makeWorker({ ein: steady('98 765432') }, { ein: '98 765432' });
  r = await mod.ocrTinByCrop(page(pageInk([combInk(EIN_ROW, true)])), psm3(formLines({ ssnRowMissing: true })), w);
  A.eq('eight digits is not a TIN', r.tin, '');

  // Both rows filled is ambiguous on a form that carries one TIN, and picking between them is the
  // bug class this whole pass exists to delete.
  w = makeWorker({ ssn: steady('987654321'), ein: steady('98 7654321') }, { ssn: '987654321', ein: '98 7654321' });
  r = await mod.ocrTinByCrop(page(pageInk([combInk(SSN_ROW, true), combInk(EIN_ROW, true)])), psm3(formLines({})), w);
  A.eq('two filled combs: refused', r.tin, '');
  A.eq('...named', r.reject, 'both-rows-filled');

  // ===== 6. the worker is handed back the way every other extractor needs it ==================
  console.log('\nengine state');
  w = makeWorker({ ein: steady('98 7654321') }, { ein: '98 7654321' });
  await mod.ocrTinByCrop(page(pageInk([combInk(EIN_ROW, true)])), psm3(formLines({ ssnRowMissing: true })), w);
  A.eq('page segmentation restored to the default every other extractor reads', w.params.tessedit_pageseg_mode, '6');
  A.eq('whitelist cleared, so the next document is not read as digits', w.params.tessedit_char_whitelist, '');
  A.ok('the whitelist is re-armed after the corroborating read, not left off',
    w.paramHistory.filter(function (h) { return /0123456789/.test(h); }).length >= 2, w.paramHistory.join(' | '));

  // ===== 7. MUTATION CONTROLS =================================================================
  // Each one reverts a single 0.9.4 fix in the SOURCE and must make the case above go wrong. A
  // control that cannot apply throws; a control that applies and changes nothing is reported here
  // as a failure, because that is the shape of a harness that tests nothing.
  console.log('\nmutation controls (each must break a case above)');

  async function underMutation(from, to, fn) {
    var m = build(mutate(RAW, from, to))(makeDocument());
    return await fn(m);
  }

  A.eq('M1 ink guard removed -> the empty comb fabricates a Tax ID',
    await underMutation('function tinRowHasInk(stats) { return !!stats && stats.otherFrac >= TIN_INK_MIN; }',
      'function tinRowHasInk(stats) { return true; }',
      async function (m) {
        var mw = makeWorker({ ein: steady('51 4131211') }, { ein: '51 4131211' });
        return (await m.ocrTinByCrop(page(pageInk([combInk(EIN_ROW, false)])), psm3(formLines({ ssnRowMissing: true })), mw)).tin;
      }), '51-4131211');

  A.eq('M2 corroborating read ignored -> a bar-heavy row becomes a Tax ID',
    await underMutation('if (!maj.ok) return', 'if (false && !maj.ok) return',
      async function (m) {
        var mw = makeWorker({ ein: steady('51 4131211') }, { ein: '| | | | | | | | |' });
        return (await m.ocrTinByCrop(page(pageInk([combInk(EIN_ROW, true)])), psm3(formLines({ ssnRowMissing: true })), mw)).tin;
      }), '51-4131211');

  A.eq('M3 confidence gate removed -> an unconfirmed read comes back hyphenated, wrong looking like right',
    await underMutation('confident: n >= TIN_CONFIRM_VOTES && spread >= TIN_PAD_SEP',
      'confident: true',
      async function (m) {
        var mw = makeWorker({ ssn: onlyMid('987654321') }, { ssn: '987 65 4321' });
        return (await m.ocrTinByCrop(page(pageInk([combInk(SSN_ROW, true)])), psm3(formLines({ einRowMissing: true })), mw)).tin;
      }), '987-65-4321');

  // Three votes clustered in 6px of crop height: enough of them, but they read the same ink. The
  // vote floor cannot catch this one - only the separation rule can - which is what makes it the
  // right fixture for M4. (An earlier M4 used the two-vote case and passed against BOTH sources,
  // proving nothing: the vote floor was doing the work.)
  function clustered() {
    return makeWorker({ ein: function (pad) { return pad === 8 ? 'x' : '98 7654321'; } }, { ein: '98 7654321' });
  }
  async function clusteredRun(m) {
    var mw = clustered();
    return await m.ocrTinByCrop(page(pageInk([combInk(EIN_ROW, true)])), psm3(formLines({ ssnRowMissing: true })), mw);
  }
  A.eq('M4 pad separation dropped -> three crops 6px apart are reported as CONFIRMED',
    (await underMutation('&& spread >= TIN_PAD_SEP', '&& spread >= 0', clusteredRun)).confident, true);
  A.eq('...and the mutant hyphenates what 0.9.4 leaves bare',
    (await underMutation('&& spread >= TIN_PAD_SEP', '&& spread >= 0', clusteredRun)).tin, '98-7654321');

  // M5 needs a pad set with a genuine duplicate. With the shipped [0.4,0.7,0.85,1.0] no two pads
  // round to the same pixel height on a realistic row, so the dedupe is defensive - it exists to
  // hold the line the FIRST time someone adds a fifth pad next to an existing one. That edit is
  // simulated here rather than waited for, and the pair below is what makes it differential: same
  // pad set both times, dedupe the only difference.
  var DUP_PADS = 'var TIN_PADS = [0.4, 0.7, 0.7, 0.85, 1.0];';
  var PADS_LINE = 'var TIN_PADS = [0.4, 0.7, 0.85, 1.0];';
  // Only the 0.7 pad (14px on a 20px row) reads cleanly; every other pad is malformed. One real
  // measurement, which is below the floor of two.
  function onlySeven() {
    return makeWorker({ ein: function (pad) { return pad === 14 ? '98 7654321' : '12'; } }, { ein: '98 7654321' });
  }
  async function dupPadRun(text) {
    var m = build(text)(makeDocument());
    var mw = onlySeven();
    return await m.ocrTinByCrop(page(pageInk([combInk(EIN_ROW, true)])), psm3(formLines({ ssnRowMissing: true })), mw);
  }
  A.eq('a duplicated pad alone changes nothing - one crop is still one measurement',
    (await dupPadRun(mutate(RAW, PADS_LINE, DUP_PADS))).tin, '');
  A.eq('M5 geometry dedupe removed -> that same duplicate pad votes twice and clears the floor',
    (await dupPadRun(mutate(mutate(RAW, PADS_LINE, DUP_PADS), 'if (seenPad[p]) continue;', 'if (false) continue;'))).tin,
    '987654321');

  A.finish();
}

run().catch(function (e) { console.error('HARNESS CRASHED: ' + (e && e.stack || e)); process.exit(1); });
