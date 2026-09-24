// test-leak-guard-matcher.js - characterizes the CURRENT behavior of Core's distinctive-token vendor
// matcher, the shared helper Email Leak Guard (and PO Approval) use to decide "does this recipient
// text belong to this vendor?":
//
//   bwnVendorTokens(name)                  -> distinctive tokens of a vendor name
//   bwnVendorMatch(vendorName, recipientRaw) -> { hit, token }
//
// Pinned rules, each read from the shipped source before it was encoded here:
//   - tokens: uppercased, non [A-Z0-9 ] becomes a space, split on whitespace, kept only when
//     length >= 4 and not in BWN_GENERIC_WORDS (trade words + LLC/INC/THE/...);
//   - a token hits when it STARTS a recipient word ("GRID" never hits inside "INGRID");
//   - a token of 6+ letters may also hit mid-word ("johnvirtue@..."); 5 letters may not;
//   - tokens are tried in vendor-name order; the FIRST hit returns { hit:true, token:<token> };
//   - fallbacks return { hit:true, token:null }: LCS >= 6 over the joined distinctive letters, the
//     legacy full-name LCS >= 6 when the name has NO distinctive token, and a near-whole-name LCS
//     (>= max(9, len-2)) when the distinctive letters are shorter than 6;
//   - a generic trade word alone never produces a hit for a name that has a distinctive token.
//
// This documents behavior; it does not endorse it. Change the matcher on purpose, then update this
// harness in the same change.
//
// Drives the REAL shipped bytes: slices the two matcher functions, their word list, and the two
// BWN helpers they call (alphaOnly, lcsLen) out of bwn-suite-core.user.js by declaration, using the
// brace-counting sliceFn convention of scripts/test-a11y-focus.js. No Core markers, no line numbers.
// Every declaration must occur exactly once or the harness fails loudly. All vendor and recipient
// strings below are synthetic (".test" domains); no real vendor, client, or email data.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-leak-guard-matcher.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = fs.readFileSync(path.join(__dirname, '..', 'bwn-suite-core.user.js'), 'utf8').replace(/\r\n/g, '\n');

function once(src, decl) {
  var a = src.indexOf(decl);
  if (a === -1) throw new Error('declaration not found: ' + decl);
  if (src.indexOf(decl, a + 1) !== -1) throw new Error('declaration not unique: ' + decl);
  return a;
}
// Slice one function by name, brace-counting to its end (same as test-a11y-focus.js sliceFn).
function sliceFn(src, decl) {
  var a = once(src, decl);
  var depth = 0, i = src.indexOf('{', a);
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(a, j + 1); }
  }
  throw new Error('unbalanced braces after ' + decl);
}
function sliceVar(src, decl, terminator) {
  var a = once(src, decl);
  var b = src.indexOf(terminator, a);
  if (b === -1) throw new Error('terminator not found after ' + decl);
  return src.slice(a, b + terminator.length);
}

var PARTS = {
  alphaOnly: sliceFn(SRC, 'function alphaOnly('),
  lcsLen: sliceFn(SRC, 'function lcsLen('),
  words: sliceVar(SRC, 'var BWN_GENERIC_WORDS =', '];'),
  tokens: sliceFn(SRC, 'function bwnVendorTokens('),
  match: sliceFn(SRC, 'function bwnVendorMatch(')
};

// `mutateKey`/`from`/`to` let a negative control revert one rule in the real sliced source.
function load(mutateKey, from, to) {
  var p = {};
  Object.keys(PARTS).forEach(function (k) { p[k] = PARTS[k]; });
  if (mutateKey) {
    var s = p[mutateKey], i = s.indexOf(from);
    if (i === -1 || s.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET ABSENT OR NOT UNIQUE: ' + from);
    p[mutateKey] = s.slice(0, i) + to + s.slice(i + from.length);
  }
  return new Function(
    "'use strict';\n" + p.alphaOnly + '\n' + p.lcsLen + '\n' +
    'var BWN = { alphaOnly: alphaOnly, lcsLen: lcsLen };\n' +
    p.words + '\n' + p.tokens + '\n' + p.match + '\n' +
    'return { tokens: bwnVendorTokens, match: bwnVendorMatch };'
  )();
}

var M = load();
var HIT = function (t) { return { hit: true, token: t }; };
var FALLBACK = { hit: true, token: null };
var MISS = { hit: false, token: null };

// ---- bwnVendorTokens -------------------------------------------------------------------------
A.eq('tokens: generic words and <4-char words dropped', M.tokens('Acme Grid Electric LLC'), ['ACME', 'GRID']);
A.eq('tokens: 3-letter word dropped, 4-letter kept', M.tokens('Abc Abcd'), ['ABCD']);
A.eq('tokens: punctuation splits words', M.tokens("O'Neil-Brothers"), ['NEIL', 'BROTHERS']);
A.eq('tokens: digits kept inside a token', M.tokens('AB24 Electric'), ['AB24']);
A.eq('tokens: all-generic name yields none', M.tokens('National Electric Services Group'), []);
A.eq('tokens: empty/null name yields none', [M.tokens(''), M.tokens(null)], [[], []]);

// ---- bwnVendorMatch: guards and result shape --------------------------------------------------
A.eq('match: empty vendor -> miss', M.match('', 'grid@x.test'), MISS);
A.eq('match: empty recipient -> miss', M.match('Grid Works', ''), MISS);

// ---- word-start rule -------------------------------------------------------------------------
A.eq('word-start: GRID hits when it starts a recipient word', M.match('Grid Works', 'grid.ops@x.test'), HIT('GRID'));
A.eq('word-start: GRID does NOT hit inside INGRID', M.match('Grid Works', 'ingrid@x.test'), MISS);
A.eq('word-start: case-insensitive', M.match('grid works', 'GRID@X.TEST'), HIT('GRID'));
A.eq('word-start: digits stripped from recipient words before the check', M.match('Grid Works', 'grid2@x.test'), HIT('GRID'));
A.eq('word-start: returned token is the vendor token, digits included', M.match('Grid9 Works', 'grid@x.test'), HIT('GRID9'));
A.eq('order: first vendor token that hits wins', M.match('Acme Grid', 'grid@acme.test'), HIT('ACME'));

// ---- mid-word threshold ------------------------------------------------------------------------
A.eq('mid-word: 6-letter token hits mid-word', M.match('Virtue Roofing', 'johnvirtue@x.test'), HIT('VIRTUE'));
A.eq('mid-word: 5-letter token does NOT hit mid-word', M.match('Sable Paint', 'jsable@x.test'), MISS);

// ---- generic trade-word suppression ------------------------------------------------------------
A.eq('generic: shared trade word alone does not match a distinctive vendor', M.match('Jones Electric', 'smithelectric@x.test'), MISS);
A.eq('generic: the distinctive token still matches', M.match('Jones Electric', 'jones@x.test'), HIT('JONES'));

// ---- fallbacks (token: null) -------------------------------------------------------------------
A.eq('fallback: misspelled distinctive letters, LCS >= 6', M.match('Brightwater Plumbing', 'brightwatr@x.test'), FALLBACK);
A.eq('fallback: no distinctive token -> legacy full-name LCS >= 6', M.match('ABC Electric LLC', 'abcelectric@x.test'), FALLBACK);
A.eq('fallback: all-generic name still matches its generic words (legacy)', M.match('National Electric Services', 'electricsvc@x.test'), FALLBACK);
A.eq('fallback: short distinctive letters need near-whole name (hit)', M.match('AB24 Electric', 'abelectric@x.test'), FALLBACK);
A.eq('fallback: short distinctive letters need near-whole name (miss)', M.match('AB24 Electric', 'electric@x.test'), MISS);

// ---- negative controls: each reverts one rule and must turn its probe red ----------------------
function mutant(key, from, to) { return load(key, from, to); }
var m1 = mutant('match', "key.indexOf('|' + alphaTok)", 'key.indexOf(alphaTok)');
A.ok('mutant: drop word-start anchor -> INGRID probe goes red', JSON.stringify(m1.match('Grid Works', 'ingrid@x.test')) !== JSON.stringify(MISS));
var m2 = mutant('match', 'alphaTok.length >= 6 &&', 'alphaTok.length >= 5 &&');
A.ok('mutant: lower mid-word threshold to 5 -> Sable probe goes red', JSON.stringify(m2.match('Sable Paint', 'jsable@x.test')) !== JSON.stringify(MISS));
var m3 = mutant('words', "'ELECTRIC', ", '');
A.ok('mutant: drop ELECTRIC from generic list -> trade-word probe goes red', JSON.stringify(m3.match('Jones Electric', 'smithelectric@x.test')) !== JSON.stringify(MISS));
var m4 = mutant('tokens', 'w.length >= 4', 'w.length >= 3');
A.ok('mutant: min token length 3 -> 3-letter probe goes red', JSON.stringify(m4.tokens('Abc Abcd')) !== JSON.stringify(['ABCD']));

A.finish();
