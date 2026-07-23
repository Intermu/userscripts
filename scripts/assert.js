// assert.js - shared tiny assert harness for the BWN node test scripts.
//
// Extracted verbatim from the per-file helpers that test-bwn-ai-client.js and
// test-bwn-ai-phase3.js each carried, so both share one implementation. This repo
// ships zero-build userscripts (runtime deps via Tampermonkey @require) and has no
// package.json/lockfile; CI runs these harnesses directly with `node scripts/test-*.js`,
// so this is a plain CommonJS module with no framework and no dependencies.
//
// Module-level counters are per-process: each harness is its own `node` invocation, so
// there is no cross-file state bleed. Call finish() once at the end to print the summary
// and exit non-zero if any assertion failed.

var pass = 0, fail = 0, cases = 0;

function ok(name, cond, detail) {
  cases++;
  if (cond) { pass++; console.log('  ok  - ' + name); }
  else { fail++; console.log('  FAIL- ' + name + (detail ? ('  [' + detail + ']') : '')); }
}

function eq(name, got, want) {
  ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want));
}

// Print the summary line and exit: non-zero if any assertion failed.
function finish() {
  console.log('\n' + pass + '/' + cases + ' assertions passed' + (fail ? (', ' + fail + ' FAILED') : ''));
  process.exit(fail ? 1 : 0);
}

// Current counts, for callers that want to inspect without exiting.
function counts() { return { pass: pass, fail: fail, cases: cases }; }

module.exports = { ok: ok, eq: eq, finish: finish, counts: counts };
