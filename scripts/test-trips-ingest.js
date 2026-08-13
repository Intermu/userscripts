// test-trips-ingest.js - Track A trips/no-show slice: surfacing a vendor no-show on the Ops
// Dashboard. Core (fetchTrips) already computes the earliest scheduled trip whose onsite date
// passed with NO clock-in (jobIVRs) into bwn:trips:<wo>; this slice has AI's pushJobFacts carry
// it as noShowDays + noShowVendor over the live-jobs path (AI-only - no Core change).
//
// Executes the SHIPPED AI no-show lookup bytes in a vm against a fake bwn:trips store: fresh
// no-show -> days-since + vendor, stale (>12h TTL) -> null, no noShow -> null, absent -> null,
// missing vendor -> days but null vendor. Plus source + cross-file wiring: AI reads bwn:trips,
// includes both fields in jobFacts, Core writes bwn:trips, and field-map declares both as
// live-jobs. The end-to-end push landing on the Dashboard is the live gate.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-trips-ingest.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

function readLF(p) { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n'); }
var core = readLF('bwn-suite-core.user.js');
var ai = readLF('bwn-suite-ai.user.js');
var map = JSON.parse(fs.readFileSync(path.join(__dirname, 'field-map.json'), 'utf8'));

// ---- 1. field-map declares both no-show fields as live-jobs -------------------------------
function field(w) { return map.fields.filter(function (f) { return f.wire === w; })[0]; }
var nd = field('noShowDays'), nv = field('noShowVendor');
A.ok('field-map declares noShowDays', !!nd);
A.ok('field-map declares noShowVendor', !!nv);
if (nd) { A.eq('noShowDays canonical', nd.canonical, 'No-Show Days'); A.eq('noShowDays type num', nd.type, 'num'); A.ok('noShowDays live-jobs', nd.producers.indexOf('live-jobs') !== -1); }
if (nv) { A.eq('noShowVendor canonical', nv.canonical, 'No-Show Vendor'); A.eq('noShowVendor type str', nv.type, 'str'); A.ok('noShowVendor live-jobs', nv.producers.indexOf('live-jobs') !== -1); }

// ---- 2. cross-file wiring: Core WRITES bwn:trips, AI READS it -----------------------------
A.ok('Core computes + writes bwn:trips (fetchTrips)', /BWN\.ssSetJSON\('bwn:trips:' \+ woNum/.test(core), 'no bwn:trips writer in Core');
A.ok('Core no-show is a scheduled+past+no-clock-in trip', core.indexOf("/scheduled/i.test(st)") !== -1 && core.indexOf('clockedPO[poNum]') !== -1);
A.ok('AI pushJobFacts reads bwn:trips', ai.indexOf("BWN.ssGetJSON('bwn:trips:'") !== -1, 'AI never reads bwn:trips');
A.ok('AI includes noShowDays + noShowVendor in jobFacts', /jobFacts:\{[\s\S]*?noShowDays:noShowDays[\s\S]*?noShowVendor:noShowVendor[\s\S]*?\}/.test(ai));
A.ok('AI applies the 12h TTL (matches state.noShow)', /12\s*\*\s*3600000/.test(ai), 'no TTL guard on the push - a long-lived tab would push a stale phantom');

// ---- 3. execute the SHIPPED lookup bytes against a fake bwn:trips --------------------------
var snip = ai.match(/var noShowDays = null, noShowVendor = null;[\s\S]*?catch\(e\)\{\}/);
A.ok('sliced the AI no-show lookup snippet from source', !!snip, 'snippet markers not found - did the lookup change shape?');
if (snip) {
  var DAY = 86400000, now = Date.now();
  function run(store, job) {
    var ctx = { BWN: { ssGetJSON: function (k, d) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d; } }, job: job, Date: Date, Math: Math, noShowDays: undefined, noShowVendor: undefined };
    vm.createContext(ctx);
    vm.runInContext(snip[0] + '\nthis.noShowDays = noShowDays; this.noShowVendor = noShowVendor;', ctx);
    return { days: ctx.noShowDays, vendor: ctx.noShowVendor };
  }
  var fresh = { ts: now - 1000, noShow: { ms: now - 3 * DAY, vendor: 'Acme', trip: '2' } };
  var r1 = run({ 'bwn:trips:344409': fresh }, { wo: '344409' });
  A.eq('fresh no-show -> days-since', r1.days, 3);
  A.eq('fresh no-show -> vendor', r1.vendor, 'Acme');

  var r2 = run({ 'bwn:trips:344409': { ts: now - 13 * 3600000, noShow: { ms: now - 3 * DAY, vendor: 'Acme' } } }, { wo: '344409' });
  A.eq('stale (>12h TTL) -> days null', r2.days, null);
  A.eq('stale -> vendor null', r2.vendor, null);

  var r3 = run({ 'bwn:trips:344409': { ts: now - 1000, latestScheduled: now + DAY } }, { wo: '344409' });
  A.eq('no noShow in payload -> null', r3.days, null);

  var r4 = run({}, { wo: '344409' });
  A.eq('absent store -> null', r4.days, null);

  var r5 = run({ 'bwn:trips:99': { ts: now - 1000, noShow: { ms: now - 1 * DAY, vendor: '' } } }, { woNumber: '99' });
  A.eq('missing vendor -> days set', r5.days, 1);
  A.eq('missing vendor -> vendor null', r5.vendor, null);
}

A.finish();
