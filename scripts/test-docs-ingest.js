// test-docs-ingest.js - Track A docs-closure slice: the bwn:docs publish (Core) + docCount
// carry (AI pushJobFacts) that surfaces per-WO document presence on the Ops Dashboard.
//
// Executes the SHIPPED AI docCount-lookup bytes in a vm against a fake bwn:docs store (the
// load-bearing NEW logic: present count -> that number, absent/malformed -> null, 0 -> 0),
// and asserts the source-level wiring both sides: Core writes bwn:docs ONLY on the confident
// read branch (unknown stays absent, never a guessed 0), AI includes docCount in jobFacts,
// the two agree on the bwn:docs: key, and field-map.json declares docCount as a live-jobs num.
// The end-to-end push landing on the Dashboard is the live gate, not this harness.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-docs-ingest.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

function readLF(p) { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n'); }
var core = readLF('bwn-suite-core.user.js');
var ai = readLF('bwn-suite-ai.user.js');
var map = JSON.parse(fs.readFileSync(path.join(__dirname, 'field-map.json'), 'utf8'));

// ---- 1. field-map declares docCount as a live-jobs num -> "Doc Count" --------------------
var dc = map.fields.filter(function (f) { return f.wire === 'docCount'; })[0];
A.ok('field-map declares docCount', !!dc, 'missing from field-map.json');
if (dc) {
  A.eq('docCount canonical is "Doc Count"', dc.canonical, 'Doc Count');
  A.eq('docCount type is num', dc.type, 'num');
  A.ok('docCount is a live-jobs field', dc.producers.indexOf('live-jobs') !== -1, JSON.stringify(dc.producers));
}

// ---- 2. Core publishes bwn:docs on the CONFIDENT branch only -----------------------------
// The confident assignment and the publish sit together; the error/pending branches must not.
var confIdx = core.indexOf('DOCS_CACHE[woNum] = { count: live.length, docs: live, byLabel: byLabel };');
A.ok('Core has the confident docs assignment', confIdx !== -1);
var publishIdx = core.indexOf("BWN.lsSetJSON('bwn:docs:' + woNum");
A.ok('Core publishes bwn:docs:<woNum>', publishIdx !== -1, 'no bwn:docs write in Core');
A.ok('the bwn:docs publish follows the confident assignment (same branch)',
  publishIdx > confIdx && (publishIdx - confIdx) < 600, 'publish is not adjacent to the confident read');
// The two unknown branches set the cache to a bare string and must NOT carry a bwn:docs write.
A.ok('the error branch does not publish bwn:docs',
  /DOCS_CACHE\[woNum\] = 'error';(?![\s\S]{0,120}bwn:docs)/.test(core), 'an error path writes bwn:docs (would publish a guessed count)');
A.ok('Core writes {count, ts} (ts lets a consumer judge staleness)',
  /bwn:docs:' \+ woNum, \{ count: live\.length, ts:/.test(core));

// ---- 3. AI carries docCount in the jobFacts push, keyed off the same store ---------------
A.ok('AI pushJobFacts reads bwn:docs:', ai.indexOf("BWN.lsGetJSON('bwn:docs:'") !== -1, 'AI never reads bwn:docs');
A.ok('AI includes docCount in the jobFacts object', /jobFacts:\{[\s\S]*?docCount:docCount[\s\S]*?\}/.test(ai), 'docCount not added to jobFacts');
// Cross-file key agreement: what Core writes is what AI reads.
A.ok("Core write key prefix == AI read key prefix ('bwn:docs:')",
  core.indexOf("'bwn:docs:'") !== -1 && ai.indexOf("'bwn:docs:'") !== -1, 'the bwn:docs key drifted between writer and reader');

// ---- 4. Execute the SHIPPED docCount-lookup bytes against a fake store --------------------
var snip = ai.match(/var docCount = null;\n\s*try \{ var _dc = BWN\.lsGetJSON\('bwn:docs:'[\s\S]*?catch\(e\)\{\}/);
A.ok('sliced the AI docCount-lookup snippet from source', !!snip, 'snippet markers not found - did the lookup change shape?');
if (snip) {
  function run(store, job) {
    var ctx = {
      BWN: { lsGetJSON: function (k, d) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d; } },
      job: job, docCount: undefined
    };
    vm.createContext(ctx);
    vm.runInContext(snip[0] + '\nthis.docCount = docCount;', ctx);
    return ctx.docCount;
  }
  A.eq('present count -> that number', run({ 'bwn:docs:344409': { count: 7, ts: 't' } }, { wo: '344409' }), 7);
  A.eq('confident empty (0) -> 0, not dropped', run({ 'bwn:docs:344409': { count: 0, ts: 't' } }, { wo: '344409' }), 0);
  A.eq('absent store -> null (unknown, omitted downstream)', run({}, { wo: '344409' }), null);
  A.eq('malformed count -> null', run({ 'bwn:docs:344409': { count: 'x' } }, { wo: '344409' }), null);
  A.eq('falls back to woNumber when wo missing', run({ 'bwn:docs:99': { count: 3, ts: 't' } }, { woNumber: '99' }), 3);
}

A.finish();
