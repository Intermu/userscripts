// test-drop-upload-queue.js - node harness for bwn-drop-upload's queue merge dedup
// (1.26.0, 2026-09-09). Overhaul: the review box now lists every queued file with a ×
// to remove it before Upload, and a second drop of a file already queued (same name +
// size) is skipped so dragging the same thing twice does not upload it twice.
//
// The list + × are DOM (covered by the live gate). The dedup is a pure function
// (dedupNewPairs) sliced out of the real source and run here - nothing below is a stub:
//   - a new file whose name+size is already queued is dropped, and counted;
//   - duplicates WITHIN one drop are also collapsed (the seen set grows as it goes);
//   - the kept raw[] and files[] stay index-aligned (the note pairs raw[i] with files[i]);
//   - dupes counts exactly what was dropped.
//
// The negative control re-runs against a mutated copy with the dedup guard defeated and
// REQUIRES it to stop deduping - a guard that silently no-ops cannot pass.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-drop-upload-queue.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-drop-upload.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

var START = '  function fileSig(f)';
var END = '  // ===== end queue merge dedup =====';
function slice(src, what) {
  var a = src.indexOf(START);
  if (a === -1) throw new Error(what + ': START marker (fileSig) not found');
  if (src.indexOf(START, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = src.indexOf(END, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return src.slice(a, b);
}

function load(src) {
  var code = slice(src, 'queue block') + '\n;({ fileSig: fileSig, dedupNewPairs: dedupNewPairs });';
  return vm.runInNewContext(code, {});
}

function F(name, size) { return { name: name, size: size }; }        // fake File
function D(tag) { return { tag: tag }; }                              // fake described

var Q = load(full);

// A file already queued is dropped on merge, and counted.
(function () {
  var r = Q.dedupNewPairs([F('a.pdf', 1)], [F('a.pdf', 1), F('b.pdf', 2)], [D('A'), D('B')]);
  A.eq('one dupe dropped', r.dupes, 1);
  A.eq('kept raw is the new file only', r.raw, [F('b.pdf', 2)]);
  A.eq('kept files stay aligned', r.files, [D('B')]);
})();

// Nothing in common -> nothing dropped.
(function () {
  var r = Q.dedupNewPairs([F('a.pdf', 1)], [F('c.pdf', 3), F('d.pdf', 4)], [D('C'), D('D')]);
  A.eq('no dupes', r.dupes, 0);
  A.eq('both kept', r.files, [D('C'), D('D')]);
})();

// Same name, DIFFERENT size -> not a duplicate (two real files that happen to share a name).
(function () {
  var r = Q.dedupNewPairs([F('a.pdf', 1)], [F('a.pdf', 9)], [D('A2')]);
  A.eq('name match but size differs is kept', r.dupes, 0);
  A.eq('kept', r.files, [D('A2')]);
})();

// Every new file already queued -> all dropped.
(function () {
  var r = Q.dedupNewPairs([F('a', 1), F('b', 2)], [F('a', 1), F('b', 2)], [D('A'), D('B')]);
  A.eq('all dupes', r.dupes, 2);
  A.eq('nothing kept', r.files, []);
})();

// Duplicates WITHIN one drop collapse too (seen grows as the loop runs).
(function () {
  var r = Q.dedupNewPairs([], [F('a', 1), F('a', 1), F('b', 2)], [D('A1'), D('A2'), D('B')]);
  A.eq('intra-drop dupe counted', r.dupes, 1);
  A.eq('first wins, second dropped', r.files, [D('A1'), D('B')]);
})();

// Negative control: defeat the dedup guard in the source and REQUIRE the behaviour to change.
(function () {
  var GUARD = 'if (seen[sig]) { dupes++; return; }';
  if (full.indexOf(GUARD) === -1) throw new Error('negative control: dedup guard line not found - update this harness');
  var mutated = full.replace(GUARD, 'if (false) { dupes++; return; }');
  var r = load(mutated).dedupNewPairs([F('a', 1)], [F('a', 1)], [D('A')]);
  A.ok('guard defeated -> duplicate is NO LONGER dropped', r.files.length === 1 && r.dupes === 0,
    'got dupes=' + r.dupes + ' kept=' + r.files.length);
})();

A.finish();
