// test-tasks-ingest.js - Track A tasks slice: open-task count per WO on the Ops Dashboard.
// Core (fetchTasks) reads tasksByEntityTypeAndId(entityType:1, entityId:<WO number>), counts
// INCOMPLETE tasks (client-side, not trusting includeComplete alone), caches to bwn:tasks:<wo>;
// AI's pushJobFacts carries openTasks. This is the DETERMINISTIC API count that replaces the
// fragile DOM "Open Tasks N" scrape (readOpenTasks) for the ingest.
//
// Executes the SHIPPED AI lookup bytes (present->carried, 0->0, absent->null, malformed->null)
// AND Core's incomplete-count filter, plus source + cross-file wiring. End-to-end is the live gate.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-tasks-ingest.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

function readLF(p) { return fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n'); }
var core = readLF('bwn-suite-core.user.js');
var ai = readLF('bwn-suite-ai.user.js');
var map = JSON.parse(fs.readFileSync(path.join(__dirname, 'field-map.json'), 'utf8'));

// ---- 1. field-map declares openTasks as a live-jobs num -----------------------------------
var f = map.fields.filter(function (x) { return x.wire === 'openTasks'; })[0];
A.ok('field-map declares openTasks', !!f);
if (f) { A.eq('openTasks canonical', f.canonical, 'Open Tasks'); A.eq('openTasks type num', f.type, 'num'); A.ok('openTasks live-jobs', f.producers.indexOf('live-jobs') !== -1); }

// ---- 2. Core fetchTasks reader (source) --------------------------------------------------
A.ok('Core reads tasksByEntityTypeAndId(entityType:1, ...)', /tasksByEntityTypeAndId\(entityType: 1, entityId: \$id/.test(core), 'no tasks reader');
A.ok('Core entityId is the WO NUMBER as a String', core.indexOf('{ id: String(woNum) }') !== -1);
A.ok('Core counts INCOMPLETE tasks client-side', core.indexOf('r.tasks.filter(function (t) { return t && !t.isComplete; }).length') !== -1);
A.ok('Core writes bwn:tasks on the confident branch', /BWN\.lsSetJSON\('bwn:tasks:' \+ woNum, \{ open: open/.test(core));
A.ok('Core error branch does not write bwn:tasks (unknown stays absent, never a guessed 0)',
  /TASKS_DONE\[woNum\] = 'error';(?![\s\S]{0,140}bwn:tasks)/.test(core), 'an error path writes bwn:tasks');
A.ok('Core calls fetchTasks from compute (keyed by the WO number only)', core.indexOf('fetchTasks(currentWOId())') !== -1);

// ---- 3. AI carries openTasks (source) ----------------------------------------------------
A.ok('AI reads bwn:tasks', ai.indexOf("BWN.lsGetJSON('bwn:tasks:'") !== -1);
A.ok('AI includes openTasks in jobFacts', /jobFacts:\{[\s\S]*?openTasks:openTasks[\s\S]*?\}/.test(ai));

// ---- 4. execute the SHIPPED AI lookup bytes ----------------------------------------------
var snip = ai.match(/var openTasks = null;\n\s*try \{ var _tk = BWN\.lsGetJSON\('bwn:tasks:'[\s\S]*?catch\(e\)\{\}/);
A.ok('sliced the AI openTasks lookup from source', !!snip);
if (snip) {
  function run(store, job) {
    var ctx = { BWN: { lsGetJSON: function (k, d) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : d; } }, job: job, openTasks: undefined };
    vm.createContext(ctx);
    vm.runInContext(snip[0] + '\nthis.openTasks = openTasks;', ctx);
    return ctx.openTasks;
  }
  A.eq('present open -> carried', run({ 'bwn:tasks:344409': { open: 4 } }, { wo: '344409' }), 4);
  A.eq('open 0 -> 0 (confident none)', run({ 'bwn:tasks:344409': { open: 0 } }, { wo: '344409' }), 0);
  A.eq('absent -> null', run({}, { wo: '344409' }), null);
  A.eq('malformed open -> null', run({ 'bwn:tasks:344409': { open: 'x' } }, { wo: '344409' }), null);
  A.eq('falls back to woNumber', run({ 'bwn:tasks:99': { open: 2 } }, { woNumber: '99' }), 2);
}

// ---- 5. execute Core's incomplete-count filter -------------------------------------------
var filt = core.match(/r\.tasks\.filter\(function \(t\) \{ return t && !t\.isComplete; \}\)\.length/);
A.ok('sliced Core incomplete-count filter', !!filt);
if (filt) {
  var ctx = { r: { tasks: [ { isComplete: false }, { isComplete: true }, {}, { isComplete: false } ] }, open: undefined };
  vm.createContext(ctx);
  vm.runInContext('this.open = ' + filt[0] + ';', ctx);
  A.eq('open counts the 3 incomplete tasks (the completed one excluded)', ctx.open, 3);
}

A.finish();
