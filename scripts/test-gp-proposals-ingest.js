// test-gp-proposals-ingest.js - Track A proposals+GP slice: surfacing the real API GP% and the
// open client-proposal count on the Ops Dashboard.
//   GP%  : Core already publishes state.gpPct (the API grossProfitInfo override) on the bwn:wo bus;
//          AI's pushJobFacts reads the bus and carries gpPct. AI-only for GP.
//   props: Core (fetchProposals) reads listClientProposals(jobId), counts proposals with NO terminal
//          date (approved/rejected/canceled), caches to bwn:props:<wo>; AI carries openProposals.
//
// Executes the SHIPPED AI lookup bytes (bus gpPct present->carried / absent->null; bwn:props open
// present->carried / absent->null) AND Core's open-classification filter (terminal-dated proposals
// excluded) against fixtures. Plus source + cross-file wiring. End-to-end is the live gate.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-gp-proposals-ingest.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

function readLF(p) { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n'); }
var core = readLF('bwn-suite-core.user.js');
var ai = readLF('bwn-suite-ai.user.js');
var map = JSON.parse(fs.readFileSync(path.join(__dirname, 'field-map.json'), 'utf8'));

// ---- 1. field-map declares both fields as live-jobs nums ----------------------------------
function field(w) { return map.fields.filter(function (f) { return f.wire === w; })[0]; }
var gp = field('gpPct'), op = field('openProposals');
A.ok('field-map declares gpPct', !!gp);
A.ok('field-map declares openProposals', !!op);
if (gp) { A.eq('gpPct canonical', gp.canonical, 'GP % Live'); A.eq('gpPct type num', gp.type, 'num'); A.ok('gpPct live-jobs', gp.producers.indexOf('live-jobs') !== -1); }
if (op) { A.eq('openProposals canonical', op.canonical, 'Open Proposals'); A.eq('openProposals type num', op.type, 'num'); A.ok('openProposals live-jobs', op.producers.indexOf('live-jobs') !== -1); }

// ---- 2. Core fetchProposals reader (source) ----------------------------------------------
A.ok('Core reads listClientProposals(jobId)', /listClientProposals\(jobId: \$jobId/.test(core), 'no listClientProposals reader');
A.ok('Core open = proposals with NO terminal date', core.indexOf('!p.approvedDate && !p.rejectedDate && !p.canceledDate') !== -1);
A.ok('Core writes bwn:props on the confident branch', /BWN\.lsSetJSON\('bwn:props:' \+ woNum, \{ open: open/.test(core));
A.ok('Core error branch does not write bwn:props (unknown stays absent, never a guessed 0)',
  /PROPS_DONE\[woNum\] = 'error';(?![\s\S]{0,140}bwn:props)/.test(core), 'an error path writes bwn:props');
A.ok('Core calls fetchProposals from compute (keyed by jobId)', core.indexOf('fetchProposals(currentWOId(), woApi.id)') !== -1);

// ---- 3. AI carries both (source) ---------------------------------------------------------
A.ok('AI reads the bwn:wo bus for gpPct', ai.indexOf('BWN.busGet(job.wo') !== -1);
A.ok('AI reads bwn:props for openProposals', ai.indexOf("BWN.lsGetJSON('bwn:props:'") !== -1);
A.ok('AI includes gpPct + openProposals in jobFacts', /jobFacts:\{[\s\S]*?gpPct:gpPct[\s\S]*?openProposals:openProposals[\s\S]*?\}/.test(ai));

// ---- 4. execute the SHIPPED AI lookup bytes ----------------------------------------------
var snip = ai.match(/var gpPct = null, openProposals = null;[\s\S]*?catch\(e\)\{\}\n\s*try \{ var _pp[\s\S]*?catch\(e\)\{\}/);
A.ok('sliced the AI gp/props lookup snippet from source', !!snip);
if (snip) {
  function run(bus, props, job) {
    var ctx = {
      BWN: {
        busGet: function (k) { return Object.prototype.hasOwnProperty.call(bus, k) ? bus[k] : null; },
        lsGetJSON: function (k, d) { return Object.prototype.hasOwnProperty.call(props, k) ? props[k] : d; }
      }, job: job, Date: Date, gpPct: undefined, openProposals: undefined
    };
    vm.createContext(ctx);
    vm.runInContext(snip[0] + '\nthis.gpPct = gpPct; this.openProposals = openProposals;', ctx);
    return { gp: ctx.gpPct, op: ctx.openProposals };
  }
  var r1 = run({ '344409': { gpPct: -11.7 } }, { 'bwn:props:344409': { open: 2 } }, { wo: '344409' });
  A.eq('bus gpPct -> carried (incl. negative)', r1.gp, -11.7);
  A.eq('bwn:props open -> carried', r1.op, 2);
  var r2 = run({ '344409': { gpPct: 0 } }, { 'bwn:props:344409': { open: 0 } }, { wo: '344409' });
  A.eq('gpPct 0 -> 0 (not dropped)', r2.gp, 0);
  A.eq('openProposals 0 -> 0 (confident none)', r2.op, 0);
  var r3 = run({}, {}, { wo: '344409' });
  A.eq('absent bus -> gpPct null', r3.gp, null);
  A.eq('absent bwn:props -> openProposals null', r3.op, null);
  var r4 = run({ '344409': { gpPct: null } }, { 'bwn:props:344409': { total: 5 } }, { wo: '344409' });
  A.eq('bus gpPct null -> null', r4.gp, null);
  A.eq('bwn:props without open -> null', r4.op, null);
}

// ---- 5. execute Core's open-classification filter against fixture proposals ---------------
var filt = core.match(/r\.items\.filter\(function \(p\) \{ return p && !p\.approvedDate[\s\S]*?\}\)\.length/);
A.ok('sliced Core open-count filter', !!filt);
if (filt) {
  var ctx = { r: { items: [ {}, { approvedDate: 'x' }, { rejectedDate: 'x' }, { canceledDate: 'x' }, { id: 9 }, { reopenedDate: 'x' } ] }, open: undefined };
  vm.createContext(ctx);
  vm.runInContext('this.open = ' + filt[0] + ';', ctx);
  A.eq('open counts the 3 non-terminal proposals ({}, {id}, reopened); the 3 terminal-dated ones excluded', ctx.open, 3);
}

A.finish();
