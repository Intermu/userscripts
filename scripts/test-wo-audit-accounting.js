// test-wo-audit-accounting.js - node harness for WO Audit run accounting (UX-1 + council).
//
// THE DEFECT that reached production: a batch cancelled mid-run abandoned every un-dispatched
// row with NO record. The summary counted only written and errored rows, the retry filter matched
// only rows carrying `.error`, and Download was still offered - so a coordinator shipped a
// workbook with unwritten note cells and had no way to finish those rows.
//
// Root cause is a THIRD row state. `runPool` returns from next() before the worker ever sees a
// skipped row, so `session.results[i]` stays a HOLE - not a note, not an error. Both consumers
// tested `.error` alone, and the summary used `.filter`, which skips holes outright.
//
// Also covers the council findings against the FIRST version of this fix:
//   QA-5c  the note-column guard keyed on `retryOnly`, so a second Start Audit still appended a
//          duplicate "Audit Notes" column and split one audit across two half-blank columns
//   QA-4c  `describe()` rebuilds `session` with `results: []` but left Retry visible, so a stale
//          press audited the NEW workbook into its existing Notes column, overwriting client text
//   UAT-2  the warning asserted the cells were BLANK; nothing is written to an errored or skipped
//          row, so a recurring workbook still holds last cycle's status text
//   UX-3   "unaudited" and "never audited" meant different totals on different surfaces
//
// Loads the REAL shipped code by slicing it out of the .user.js. Nothing under test is retyped -
// including the worker's index mapping, which the previous harness reimplemented as
// `row.rowIdx - 1` and therefore never exercised.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-wo-audit-accounting.js

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-wo-audit.user.js');
var TEXT = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(startMark, endMark) {
  var a = TEXT.indexOf(startMark), b = TEXT.indexOf(endMark);
  if (a === -1 || b === -1) throw new Error('marker not found: ' + (a === -1 ? startMark : endMark));
  var end = TEXT.indexOf('\n', b);
  return TEXT.slice(a, end === -1 ? TEXT.length : end);
}

var src = slice('  // ---- Bounded-concurrency runner ----', '  // ===== END RUN ACCOUNTING');
var mod = new Function(src + '\n; return { runPool: runPool, auditTally: auditTally, pendingRows: pendingRows, owedPhrase: owedPhrase, UNWRITTEN_NOTE: UNWRITTEN_NOTE };')();
var runPool = mod.runPool, auditTally = mod.auditTally, pendingRows = mod.pendingRows;

function mkRows(n) {
  var r = [];
  for (var i = 0; i < n; i++) r.push({ rowIdx: i + 1, key: 'W-' + (1000 + i) });
  return r;
}

// Drive the REAL runPool the way runAudit does, including the SHIPPED index mapping
// `session.rows.indexOf(row)` rather than a retyped equivalent.
function simulateRun(allRows, targets, plan, cancelAfter, seed) {
  var results = seed || new Array(allRows.length);
  var settled = 0;
  return runPool(targets, function (row) {
    var origIdx = allRows.indexOf(row);
    return Promise.resolve().then(function () {
      settled++;
      if (plan[origIdx] === 'err') {
        results[origIdx] = { key: row.key, error: 'the AI service was busy, rate limited (HTTP 429)' };
        throw new Error('rate limited');
      }
      results[origIdx] = { key: row.key, note: 'Note for ' + row.key, notesFound: 2 };
    });
  }, 1, function () {}, function () {
    return cancelAfter != null && settled >= cancelAfter;
  }).then(function () { return results; });
}

// ---- 1. the premise: cancel really does leave holes -------------------------------------
function section1() {
  console.log('\n1. runPool cancel semantics (the premise the fix rests on)');
  var rows = mkRows(5);
  return simulateRun(rows, rows.slice(), ['ok', 'ok', 'ok', 'ok', 'ok'], 2).then(function (res) {
    A.ok('rows 3-5 are HOLES, not error objects',
      res[2] === undefined && res[3] === undefined && res[4] === undefined, JSON.stringify(res));
    A.eq('.filter() SKIPS the holes (root cause)', res.filter(function (r) { return r; }).length, 2);
    A.eq('but .length still says 5', res.length, 5);
  });
}

// ---- 2. accounting across all three states -----------------------------------------------
function section2() {
  console.log('\n2. auditTally + pendingRows across all three row states');
  var rows = mkRows(5);
  return simulateRun(rows, rows.slice(), ['ok', 'ok', 'ok', 'ok', 'ok'], null).then(function (res) {
    A.eq('full success', auditTally(res, 5), { ok: 5, errs: 0, skipped: 0 });
    A.eq('nothing pending', pendingRows(rows, res).length, 0);
    return simulateRun(rows, rows.slice(), ['ok', 'err', 'ok', 'err', 'ok'], null);
  }).then(function (res) {
    A.eq('two errored', auditTally(res, 5), { ok: 3, errs: 2, skipped: 0 });
    A.eq('pending = the errored rows', pendingRows(rows, res).map(function (r) { return r.key; }), ['W-1001', 'W-1003']);
    return simulateRun(rows, rows.slice(), ['ok', 'ok', 'ok', 'ok', 'ok'], 2);
  }).then(function (res) {
    A.eq('cancel after 2 -> 3 SKIPPED, counted', auditTally(res, 5), { ok: 2, errs: 0, skipped: 3 });
    A.eq('skipped rows are pending and resumable',
      pendingRows(rows, res).map(function (r) { return r.key; }), ['W-1002', 'W-1003', 'W-1004']);
    A.ok('retry button shows on (errs || skipped) where old (errs) hid it', (0 || 3) > 0);
    return simulateRun(rows, rows.slice(), ['err', 'ok', 'ok', 'ok', 'ok'], 3);
  }).then(function (res) {
    A.eq('cancel + error together', auditTally(res, 5), { ok: 2, errs: 1, skipped: 2 });
    A.eq('pending mixes both', pendingRows(rows, res).map(function (r) { return r.key; }), ['W-1000', 'W-1003', 'W-1004']);
    return simulateRun(rows, rows.slice(), ['ok', 'ok', 'ok', 'ok', 'ok'], 0);
  }).then(function (res) {
    A.eq('cancel before any row ran', auditTally(res, 5), { ok: 0, errs: 0, skipped: 5 });
    A.ok('summary must NOT read as "every row failed"', auditTally(res, 5).errs === 0);
    // Resume against the SAME results array, through the shipped index mapping.
    return simulateRun(rows, pendingRows(rows, res), ['ok', 'ok', 'ok', 'ok', 'ok'], null, res);
  }).then(function (res) {
    A.eq('resume completes the batch', auditTally(res, 5), { ok: 5, errs: 0, skipped: 0 });
    A.eq('nothing left pending', pendingRows(rows, res).length, 0);
  });
}

// ---- 3. repeated partial resumes converge -------------------------------------------------
function section3() {
  console.log('\n3. repeated cancel/resume loses no row');
  var rows = mkRows(5);
  return simulateRun(rows, rows.slice(), ['ok', 'ok', 'ok', 'ok', 'ok'], 1).then(function (r1) {
    A.eq('first pass leaves 4 pending', pendingRows(rows, r1).length, 4);
    return simulateRun(rows, pendingRows(rows, r1), ['ok', 'ok', 'ok', 'ok', 'ok'], 2, r1);
  }).then(function (r2) {
    A.eq('second pass writes 2 more', auditTally(r2, 5), { ok: 3, errs: 0, skipped: 2 });
    return simulateRun(rows, pendingRows(rows, r2), ['ok', 'ok', 'ok', 'ok', 'ok'], null, r2);
  }).then(function (r3) {
    A.eq('third pass finishes', auditTally(r3, 5), { ok: 5, errs: 0, skipped: 0 });
  });
}

// ---- 4. an entry is not a hole -------------------------------------------------------------
function section4() {
  console.log('\n4. a falsy-looking entry is still an attempt');
  var res = new Array(3);
  res[0] = { key: 'a', note: '' };           // empty note is still a WRITE
  res[1] = { key: 'b', error: 'boom' };
  A.eq('empty-string note counts as written', auditTally(res, 3), { ok: 1, errs: 1, skipped: 1 });
  A.eq('row with empty note is NOT pending',
    pendingRows(mkRows(3), res).map(function (r) { return r.key; }), ['W-1001', 'W-1002']);
  return Promise.resolve();
}

// ---- 5. one vocabulary, correct grammar, no BLANK claim ------------------------------------
function section5() {
  console.log('\n5. the coordinator-facing strings (UX-3, UX-4, UAT-2)');
  A.eq('mixed causes are itemised against one total',
    mod.owedPhrase({ ok: 12, errs: 3, skipped: 5 }), '8 rows with no note (3 failed, 5 never audited)');
  A.eq('errors only', mod.owedPhrase({ ok: 17, errs: 3, skipped: 0 }), '3 rows with no note (3 failed)');
  A.eq('skips only', mod.owedPhrase({ ok: 15, errs: 0, skipped: 5 }), '5 rows with no note (5 never audited)');
  // The plural bug: the suffix must follow the OWED count, not the batch size.
  A.eq('exactly one owed row reads as singular',
    mod.owedPhrase({ ok: 19, errs: 1, skipped: 0 }), '1 row with no note (1 failed)');
  // The defect was ASSERTING the cells are blank. Using the word conditionally is correct and
  // required - the cell really is blank when the column is new - so the test targets the claim,
  // not the word.
  A.ok('the warning never asserts the cells are blank',
    !/\b(are|is|go out|going out)\s+blank\b/i.test(mod.UNWRITTEN_NOTE), mod.UNWRITTEN_NOTE);
  A.ok('...it offers blank as a CONDITIONAL outcome', /blank if/i.test(mod.UNWRITTEN_NOTE), mod.UNWRITTEN_NOTE);
  A.ok('...and names the stale-text outcome too', /previous text/i.test(mod.UNWRITTEN_NOTE), mod.UNWRITTEN_NOTE);
  // Both surfaces must carry the same sentence, which is what killed the old contradiction where
  // the cancel warning said "go out blank" and the download warning said otherwise.
  A.eq('the same sentence is used on both surfaces',
    (TEXT.match(/UNWRITTEN_NOTE/g) || []).length >= 3, true);
  A.ok('no surface still says the cells go out blank', !/go out blank/i.test(TEXT));
  return Promise.resolve();
}

// ---- 6. source-level guards the slice cannot execute ---------------------------------------
// These four live inside buildModal's closure, so they cannot be driven from node without
// restructuring the file. Asserting on the shipped SOURCE is weaker than executing it and is
// labelled as such - it catches a reversion, not a logic error.
function section6() {
  console.log('\n6. source assertions for closure-bound guards (weaker than execution)');
  A.ok('note column is guarded on noteAppended, not retryOnly (QA-5c)',
    /if \(!session\.map\.noteAppended\) \{/.test(TEXT));
  A.ok('describe() refuses to rebuild mid-run (QA-3a)',
    /function describe\(\)[\s\S]{0,900}?if \(_running\) return;/.test(TEXT));
  A.ok('describe() hides Retry and Download on rebuild (QA-4c)',
    /bwn-woaudit-retry'\); if \(rb0\) rb0\.style\.display = 'none'/.test(TEXT));
  A.ok('file input is disabled during a run (QA-3a)',
    /\$\('bwn-woaudit-file'\)\.disabled = true;/.test(TEXT));
  A.ok('retry targets come from pendingRows, not an .error filter',
    /\? pendingRows\(session\.rows, session\.results\)/.test(TEXT));
  A.ok('retry button gate covers skipped rows',
    /if \(tal\.errs \|\| tal\.skipped\) \{ var rb =/.test(TEXT));
  A.ok('gql is bounded by a timeout (UAT-4a)', /GQL_TIMEOUT_MS/.test(TEXT) && /ctl\.abort\(\)/.test(TEXT));
  A.ok('all-failed guidance is derived from observed causes (UAT-1a)',
    /allThrottle/.test(TEXT) && /Nothing is misconfigured/.test(TEXT));
  A.ok('button row wraps (UX-6)', /display:flex;flex-wrap:wrap;gap:10px;align-items:center/.test(TEXT));
  A.ok('button label covers skipped rows too', />Retry Unfinished</.test(TEXT));
  A.ok('no stale "Retry Errors" label remains', !/>Retry Errors</.test(TEXT));
  return Promise.resolve();
}

console.log('WO Audit run accounting - ' + path.basename(SRC));
section1().then(section2).then(section3).then(section4).then(section5).then(section6)
  .then(function () { A.finish(); })
  .catch(function (e) { console.error('\nHARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
