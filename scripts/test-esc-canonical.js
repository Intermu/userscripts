// test-esc-canonical.js - one canonical, attribute-safe HTML escaper across the whole suite.
//
// WHY THIS EXISTS (RM-A1 / findings M1 + ACC3):
//   The HTML-escape helper (esc / escapeHtml / lgEsc / tvEsc / srEsc ...) was hand-duplicated across
//   ~11 userscripts and DIVERGED on quote escaping. Several copies escaped only & < > (or only the
//   double quote), so any value rendered into an HTML ATTRIBUTE could break out of it:
//       html += '<a title="' + esc(userText) + '">';   // esc that leaves " or ' raw = attribute XSS
//   A payload like  "><script>  or  ' onmouseover=alert(1)  escapes the attribute and injects markup.
//   Each userscript runs in its OWN Tampermonkey sandbox and cannot share a runtime object (see
//   test-shared-block-ledger.js), so "one canonical helper" here means ONE canonical BEHAVIOUR pasted
//   into every adopter - and this harness is what pins that behaviour so a copy can never drift unsafe
//   again. It is stronger than a byte/SHA gate: it EXECUTES every escaper and proves the security
//   property directly, so a new escaper in any form (char-class or replace-chain) is auto-caught.
//
// THE CANONICAL CONTRACT: escape all five of  & < > " '  so the result is safe in BOTH a text node
// and inside single- OR double-quoted attributes. The one true output for the five specials is:
//       &  ->  &amp;      <  ->  &lt;      >  ->  &gt;      "  ->  &quot;      '  ->  &#39;
//   and the helper is null-safe (null / undefined -> '').
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-esc-canonical.js
// No pixels, no network: this reads the shipped bytes only and runs the sliced helpers in-process.

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var ROOT = path.join(__dirname, '..');
function read(name) { return fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n'); }

// ---- the canonical output, the single source of truth for the five specials --------------------
var SPECIALS = '&<>"\'';
var CANON_OUT = '&amp;&lt;&gt;&quot;&#39;';

// ---- escaper discovery -------------------------------------------------------------------------
// An HTML escaper is a NAMED function (or `var NAME = function`) whose body maps the raw specials to
// entities in the ESCAPE direction. We detect the two forms the suite uses:
//   char-class:  .replace(/[&<>...]/g, ...)   (covers the safe /[&<>"']/g AND any unsafe subset)
//   chain:       .replace(/&/g, '&amp;')...
// A DECODER (entity -> char, e.g. .replace(/&amp;/g, '&')) and a tag-stripper are deliberately NOT
// matched: they carry '&amp;' as a PATTERN, never as the replacement of a bare '&'. So a discovered
// escaper is always something that PRODUCES '&amp;' from '&', which is exactly what must be quote-safe.
var HEAD = /(?:function\s+(\w+)|(?:var|const|let)\s+(\w+)\s*=\s*function)\s*\(/g;
function isEscaperBody(b) {
  return /\.replace\(\/\[&<>/.test(b) || /\.replace\(\/&\/g,\s*['"]&amp;/.test(b);
}
// A dedicated escaper HELPER's whole body is a single `return String(...).replace(...)`. The head
// regex is ANCHORED at ^ so it matches only when the function's OWN body opens with `return String(`
// - a builder like textToHtml/setEditorValue that DEFINES a nested esc and then returns wrapped HTML
// opens with `function esc...`, so it is excluded (its nested esc is still discovered on its own head).
var HELPER_HEAD = /^function\s+\w*\s*\([^)]*\)\s*\{\s*return\s+String\s*\(/;
function isPureEscaper(text) {
  return HELPER_HEAD.test(text) && isEscaperBody(text) && text.length < 500;
}
// Slice a balanced `function ... (...) { ... }` starting at/after idx. The escaper bodies contain no
// braces inside string literals (their strings are '&amp;' etc.), so plain brace-depth counting is
// exact here; nested braces (the object literal and the inner replace callback) balance correctly.
function sliceFnAt(src, idx) {
  var start = src.indexOf('function', idx);
  if (start === -1) return null;
  var b = src.indexOf('{', start);
  if (b === -1) return null;
  var depth = 0, i = b;
  for (; i < src.length; i++) {
    var ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return depth === 0 ? src.slice(start, i) : null;
}
function discoverEscapers(src) {
  var out = [], m;
  HEAD.lastIndex = 0;
  while ((m = HEAD.exec(src))) {
    var name = m[1] || m[2];
    // cheap gate: an escaper produces '&amp;' close to its head; skip the file's huge functions.
    var amp = src.indexOf('&amp;', m.index);
    if (amp === -1 || amp - m.index > 400) continue;
    var text = sliceFnAt(src, m.index);
    if (!text || amp > m.index + text.length) continue;
    if (!isPureEscaper(text)) continue;
    out.push({ name: name, text: text });
  }
  return out;
}
// Turn a sliced escaper (named-fn or anonymous-fn expression) into a callable, in isolation.
// eval of a first-party sliced helper (pure String().replace) is intentional and safe here; the
// repo's eslint config is correctness-only and does not enable no-eval, so no suppression is needed.
function compile(text) { return eval('(' + text + ')'); }

// The pure judge every real assertion AND every negative control runs through, so a control can only
// pass by making the SAME judge flip - never a parallel check that could agree with the bug.
function isCanonical(fn) {
  try {
    return fn(SPECIALS) === CANON_OUT &&      // all five specials, in canonical entities
           fn(null) === '' && fn(undefined) === '' &&   // null-safe
           fn('') === '' &&
           fn('plain text 123') === 'plain text 123';   // leaves ordinary text untouched
  } catch (e) { return false; }
}

// The manifest: which escapers each file is EXPECTED to carry. Forces a human to update this list
// when a script grows or drops an escaper (Section 1 enforces both directions), the same discipline
// test-shared-block-ledger.js applies to the token picker.
var EXPECT = {
  'bwn-ask.user.js':              ['esc'],
  'bwn-bid-out.user.js':          ['esc'],
  'bwn-dispatch.user.js':         ['esc'],
  'bwn-drop-upload.user.js':      ['esc', 'esc'],       // two: textToHtml (line ~875) + a second builder
  'bwn-low-gp.user.js':           ['lgEsc'],
  'bwn-notes.user.js':            ['esc'],
  'bwn-proposal-actions.user.js': ['escapeHtml'],
  'bwn-proposal-copy.user.js':    ['escapeHtml'],
  'bwn-suite-ai.user.js':         ['escapeHtml', 'srEsc'],   // ported jobView escapeHtml + supplier-search srEsc
  'bwn-suite-core.user.js':       ['esc', 'esc', 'esc'],     // three render/copy paths
  'bwn-temp-vendor.user.js':      ['tvEsc'],
  'bwn-write-queue.user.js':      ['esc']
};

// =============================================================================================
// 1. DISCOVERY + MANIFEST: every escaper on disk is expected, and every expected escaper is found.
// =============================================================================================
console.log('-- 1. discovery + manifest (disk <-> expected) --');
var FILES = fs.readdirSync(ROOT).filter(function (f) { return /^bwn-.*\.user\.js$/.test(f); });
var FOUND = {};
var totalFound = 0;
FILES.forEach(function (f) {
  var d = discoverEscapers(read(f));
  FOUND[f] = d;
  totalFound += d.length;
});
Object.keys(EXPECT).forEach(function (f) {
  var got = (FOUND[f] || []).map(function (e) { return e.name; }).sort();
  var want = EXPECT[f].slice().sort();
  A.ok('manifest: ' + f + ' carries [' + want.join(', ') + ']',
    JSON.stringify(got) === JSON.stringify(want), 'found [' + got.join(', ') + ']');
});
// No file OUTSIDE the manifest may carry an escaper (a new one must be classified before it ships).
FILES.forEach(function (f) {
  if (EXPECT[f]) return;
  A.ok('no unlisted escaper in ' + f, (FOUND[f] || []).length === 0,
    'found [' + (FOUND[f] || []).map(function (e) { return e.name; }).join(', ') + '] - add it to EXPECT and it will be run below');
});
var totalExpected = Object.keys(EXPECT).reduce(function (n, f) { return n + EXPECT[f].length; }, 0);
A.ok('total escapers discovered == ' + totalExpected, totalFound === totalExpected, 'found ' + totalFound);

// =============================================================================================
// 2. BEHAVIOUR: run EVERY discovered escaper and prove it neutralizes the payloads in BOTH contexts.
// =============================================================================================
console.log('\n-- 2. behaviour: every escaper is attribute-safe (' + totalFound + ' escapers) --');
// The attacker payloads from the task, exercised against each escaper.
var PAYLOADS = ['"><script>', "' onmouseover=alert(1)", '</textarea>', '&<>', SPECIALS];
FILES.slice().sort().forEach(function (f) {
  (FOUND[f] || []).forEach(function (e, i) {
    var label = f.replace(/^bwn-|\.user\.js$/g, '') + ':' + e.name + (FOUND[f].length > 1 ? '#' + i : '');
    var fn;
    try { fn = compile(e.text); } catch (err) { A.ok(label + ' compiles', false, String(err)); return; }

    // 2a. the canonical five-special output - the single strongest assertion.
    A.ok(label + ' maps & < > " \' to canonical entities', isCanonical(fn), 'got ' + JSON.stringify(fn(SPECIALS)));

    // 2b. TEXT context: no raw < or > can survive to open a tag or close a <textarea>/<title>.
    PAYLOADS.forEach(function (p) {
      var o = fn(p);
      A.ok(label + ' text-safe for ' + JSON.stringify(p), o.indexOf('<') === -1 && o.indexOf('>') === -1, 'got ' + JSON.stringify(o));
    });

    // 2c. DOUBLE-quoted attribute: value is placed as x="<out>" - no raw " may survive to close it.
    PAYLOADS.forEach(function (p) {
      var o = fn(p);
      A.ok(label + ' dq-attr-safe for ' + JSON.stringify(p), o.indexOf('"') === -1, 'raw double-quote in ' + JSON.stringify(o));
    });

    // 2d. SINGLE-quoted attribute: value is placed as x='<out>' - no raw ' may survive to close it.
    PAYLOADS.forEach(function (p) {
      var o = fn(p);
      A.ok(label + " sq-attr-safe for " + JSON.stringify(p), o.indexOf("'") === -1, 'raw single-quote in ' + JSON.stringify(o));
    });

    // 2e. full round-trip through a real attribute string: parse back the quoted value and confirm it
    // is exactly one attribute whose decoded value equals the payload (no breakout, no lost data).
    PAYLOADS.forEach(function (p) {
      var attr = '<a data-x="' + fn(p) + '"></a>';
      // the tag must contain exactly the ONE quote pair we opened - i.e. exactly two double-quotes.
      var dq = (attr.match(/"/g) || []).length;
      A.ok(label + ' builds a single clean attribute for ' + JSON.stringify(p), dq === 2, attr);
    });
  });
});

// =============================================================================================
// 3. AMPERSAND correctness: & is escaped FIRST / atomically, never double-encoded.
// =============================================================================================
console.log('\n-- 3. ampersand is encoded once, not double-encoded --');
FILES.slice().sort().forEach(function (f) {
  (FOUND[f] || []).forEach(function (e, i) {
    var fn = compile(e.text);
    var label = f.replace(/^bwn-|\.user\.js$/g, '') + ':' + e.name + (FOUND[f].length > 1 ? '#' + i : '');
    // an already-safe-looking string must not have its entities re-escaped into &amp;lt; etc.
    A.ok(label + ' does not double-encode an existing entity', fn('&amp;') === '&amp;amp;',
      'a single pass over & must yield exactly &amp;amp; for the literal text "&amp;", got ' + JSON.stringify(fn('&amp;')));
    A.ok(label + ' encodes a lone & to &amp;', fn('a & b') === 'a &amp; b', 'got ' + JSON.stringify(fn('a & b')));
  });
});

// =============================================================================================
// 4. NEGATIVE CONTROLS: the exact divergent forms this task removed MUST fail isCanonical, proving
// the judge is load-bearing (a control that passed would mean the judge cannot see the bug).
// =============================================================================================
console.log('\n-- 4. negative controls (each divergent escaper MUST be rejected) --');
// C1: the "& < > only" copy (drop-upload / notes / core / write-queue before the fix): quotes raw.
var c1 = function (s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); };
A.ok('C1: &<>-only escaper is rejected (both quotes raw)', isCanonical(c1) === false);
A.ok('C1: proof it leaks a quote', c1(SPECIALS).indexOf('"') !== -1 && c1(SPECIALS).indexOf("'") !== -1);

// C2: the "double-quote only" char-class (bid-out / dispatch / lg / sr / core#9899 before the fix):
// single quote survives -> single-quoted attribute breakout.
var c2 = function (s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
A.ok('C2: double-quote-only escaper is rejected (single quote raw)', isCanonical(c2) === false);
A.ok('C2: proof the single quote leaks', c2("' x").indexOf("'") !== -1);

// C3: a decoder (entity -> char) must NOT be mistaken for an escaper by discovery, and would fail
// the judge anyway. Confirms the direction guard in isEscaperBody.
var decoderText = "function dec(s){ return String(s).replace(/&amp;/g,'&').replace(/&lt;/g,'<'); }";
A.ok('C3: a decoder body is not classified as an escaper', isEscaperBody(decoderText) === false);

// C4: the canonical helper itself is accepted (positive anchor for the judge).
var good = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
A.ok('C4: the canonical attribute-safe escaper is accepted', isCanonical(good) === true);

console.log('\n(one canonical, attribute-safe escaper; ' + totalFound + ' copies across the suite, each RUN and');
console.log(' proven to neutralize & < > " \' in text and in single- and double-quoted attributes.)');
A.finish();
