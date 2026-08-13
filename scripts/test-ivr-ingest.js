// test-ivr-ingest.js - Track A IVR-hours slice: total labor + travel hours per WO on the Ops
// Dashboard. Core extends the jobIVRs read it ALREADY does for the no-show check (fetchTrips) to
// select the hours fields, sums them over non-canceled records, and adds laborHours + travelHours
// to the bwn:trips payload; AI's pushJobFacts carries both (from the same bwn:trips read it uses
// for the no-show).
//
// Executes the SHIPPED AI hours extraction (present->carried, absent->null) AND Core's hours-sum
// (canceled excluded, missing fields skipped) against fixtures, plus source + cross-file wiring.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-ivr-ingest.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

function readLF(p) { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n'); }
var core = readLF('bwn-suite-core.user.js');
var ai = readLF('bwn-suite-ai.user.js');
var map = JSON.parse(fs.readFileSync(path.join(__dirname, 'field-map.json'), 'utf8'));

// ---- 1. field-map declares both fields as live-jobs nums ----------------------------------
function field(w) { return map.fields.filter(function (x) { return x.wire === w; })[0]; }
var lh = field('laborHours'), th = field('travelHours');
A.ok('field-map declares laborHours', !!lh);
A.ok('field-map declares travelHours', !!th);
if (lh) { A.eq('laborHours canonical', lh.canonical, 'Labor Hours'); A.eq('laborHours type num', lh.type, 'num'); A.ok('laborHours live-jobs', lh.producers.indexOf('live-jobs') !== -1); }
if (th) { A.eq('travelHours canonical', th.canonical, 'Travel Hours'); A.eq('travelHours type num', th.type, 'num'); A.ok('travelHours live-jobs', th.producers.indexOf('live-jobs') !== -1); }

// ---- 2. Core: jobIVRs read carries hours; fetchTrips sums them; payload guarded -----------
A.ok('WO_IVRS_Q selects numberOfHours + travelNumberOfHours', /jobIVRs\(workOrderNumber: \$n\) \{[^}]*numberOfHours travelNumberOfHours/.test(core), 'hours fields not in the IVR query');
A.ok('fetchTrips sums labor over non-canceled records', core.indexOf('if (typeof v.numberOfHours === \'number\') labor += v.numberOfHours;') !== -1);
A.ok('fetchTrips sums travel', core.indexOf('if (typeof v.travelNumberOfHours === \'number\') travel += v.travelNumberOfHours;') !== -1);
A.ok('hours added to bwn:trips payload ONLY on a successful jobIVRs read (unknown stays absent)',
  /if \(res\[1\] && Array\.isArray\(res\[1\]\.jobIVRs\)\) \{[\s\S]*?payload\.laborHours = /.test(core));

// ---- 3. AI carries both (source) ---------------------------------------------------------
A.ok('AI reads laborHours off bwn:trips', core && ai.indexOf("typeof _tb.laborHours === 'number'") !== -1);
A.ok('AI reads travelHours off bwn:trips', ai.indexOf("typeof _tb.travelHours === 'number'") !== -1);
A.ok('AI includes laborHours + travelHours in jobFacts', /jobFacts:\{[\s\S]*?laborHours:laborHours[\s\S]*?travelHours:travelHours[\s\S]*?\}/.test(ai));

// ---- 4. execute the SHIPPED AI hours extraction ------------------------------------------
var snip = ai.match(/if\(_tb && typeof _tb\.laborHours === 'number'\) laborHours = _tb\.laborHours;\n\s*if\(_tb && typeof _tb\.travelHours === 'number'\) travelHours = _tb\.travelHours;/);
A.ok('sliced the AI hours extraction from source', !!snip);
if (snip) {
  function run(tb) {
    var ctx = { _tb: tb, laborHours: null, travelHours: null };
    vm.createContext(ctx);
    vm.runInContext(snip[0] + '\nthis.laborHours = laborHours; this.travelHours = travelHours;', ctx);
    return { l: ctx.laborHours, t: ctx.travelHours };
  }
  var r1 = run({ laborHours: 6.5, travelHours: 2 });
  A.eq('present labor -> carried', r1.l, 6.5);
  A.eq('present travel -> carried', r1.t, 2);
  var r2 = run({ laborHours: 0, travelHours: 0 });
  A.eq('labor 0 -> 0 (confident none)', r2.l, 0);
  A.eq('travel 0 -> 0', r2.t, 0);
  var r3 = run({ noShow: { ms: 1 } });   // trips payload with no hours (older Core)
  A.eq('no hours in payload -> laborHours null', r3.l, null);
  A.eq('no hours in payload -> travelHours null', r3.t, null);
  var r4 = run(null);
  A.eq('absent payload -> null', r4.l, null);
}

// ---- 5. execute Core's hours-sum over a fixture jobIVRs ledger ----------------------------
var sumSrc = core.match(/var labor = 0, travel = 0;\n\s*ivrs\.forEach\(function \(v\) \{[\s\S]*?\}\);/);
A.ok('sliced Core hours-sum', !!sumSrc);
if (sumSrc) {
  var ivrs = [
    { numberOfHours: 3, travelNumberOfHours: 1 },
    { numberOfHours: 2.5, travelNumberOfHours: 0.5 },
    { numberOfHours: 9, travelNumberOfHours: 9, isCanceled: true },   // excluded
    { travelNumberOfHours: 1 },   // no labor field - skipped for labor
    null
  ];
  var ctx = { ivrs: ivrs, labor: undefined, travel: undefined };
  vm.createContext(ctx);
  vm.runInContext(sumSrc[0] + '\nthis.labor = labor; this.travel = travel;', ctx);
  A.eq('labor sums non-canceled records with a numberOfHours (3 + 2.5)', ctx.labor, 5.5);
  A.eq('travel sums non-canceled travelNumberOfHours (1 + 0.5 + 1)', ctx.travel, 2.5);
}

A.finish();
