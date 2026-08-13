// test-notes-hist-ingest.js - Track A notes-history slice: note volume + client-response silence
// on the Ops Dashboard. AI-only - Core (WO Assist) already publishes state.noteCount + lastClientNote
// on the bwn:wo bus; AI's pushJobFacts reads the SAME bus read it uses for gpPct and carries
// noteCount + clientNoteDays (days since the newest client-typed note - distinct from the board's
// any-note lastNoteDate).
//
// Executes the SHIPPED AI bus block against a fake bwn:wo bus (noteCount carried, lastClientNote ->
// days, absent -> null, 0 -> 0) and asserts the cross-file contract (Core publishes both on the bus).
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-notes-hist-ingest.js

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
var nc = field('noteCount'), cn = field('clientNoteDays');
A.ok('field-map declares noteCount', !!nc);
A.ok('field-map declares clientNoteDays', !!cn);
if (nc) { A.eq('noteCount canonical', nc.canonical, 'Note Count'); A.eq('noteCount type num', nc.type, 'num'); A.ok('noteCount live-jobs', nc.producers.indexOf('live-jobs') !== -1); }
if (cn) { A.eq('clientNoteDays canonical', cn.canonical, 'Client Note Days'); A.eq('clientNoteDays type num', cn.type, 'num'); A.ok('clientNoteDays live-jobs', cn.producers.indexOf('live-jobs') !== -1); }

// ---- 2. cross-file: Core publishes both on the bwn:wo bus; AI reads + carries -------------
A.ok('Core publishes noteCount on the bus', /noteCount: \(st\.noteCount != null/.test(core), 'noteCount not on the bus publish');
A.ok('Core publishes lastClientNote on the bus', /lastClientNote: st\.lastClientNote/.test(core), 'lastClientNote not on the bus publish');
A.ok('AI reads noteCount off the bus', ai.indexOf("typeof _b.noteCount === 'number'") !== -1);
A.ok('AI derives clientNoteDays from lastClientNote', ai.indexOf('_b.lastClientNote') !== -1 && /clientNoteDays = Math\.floor/.test(ai));
A.ok('AI includes noteCount + clientNoteDays in jobFacts', /jobFacts:\{[\s\S]*?noteCount:noteCount[\s\S]*?clientNoteDays:clientNoteDays[\s\S]*?\}/.test(ai));

// ---- 3. execute the SHIPPED bus block against a fake bwn:wo bus ---------------------------
var snip = ai.match(/var gpPct = null, openProposals = null, noteCount = null, clientNoteDays = null;[\s\S]*?\} \} catch\(e\)\{\}/);
A.ok('sliced the AI bus block from source', !!snip);
if (snip) {
  var DAY = 86400000, now = Date.now();
  function run(bus, job) {
    var ctx = { BWN: { busGet: function (k) { return Object.prototype.hasOwnProperty.call(bus, k) ? bus[k] : null; } }, job: job, Date: Date, Math: Math, isNaN: isNaN, noteCount: undefined, clientNoteDays: undefined, gpPct: undefined };
    vm.createContext(ctx);
    vm.runInContext(snip[0] + '\nthis.noteCount = noteCount; this.clientNoteDays = clientNoteDays;', ctx);
    return { nc: ctx.noteCount, cn: ctx.clientNoteDays };
  }
  var r1 = run({ '344409': { noteCount: 8, lastClientNote: new Date(now - 5 * DAY).toISOString() } }, { wo: '344409' });
  A.eq('bus noteCount -> carried', r1.nc, 8);
  A.eq('lastClientNote 5d ago -> clientNoteDays 5', r1.cn, 5);
  var r2 = run({ '344409': { noteCount: 0 } }, { wo: '344409' });
  A.eq('noteCount 0 -> 0 (not dropped)', r2.nc, 0);
  A.eq('no lastClientNote -> clientNoteDays null', r2.cn, null);
  var r3 = run({}, { wo: '344409' });
  A.eq('absent bus -> noteCount null', r3.nc, null);
  A.eq('absent bus -> clientNoteDays null', r3.cn, null);
  var r4 = run({ '344409': { lastClientNote: 'not-a-date' } }, { wo: '344409' });
  A.eq('unparseable lastClientNote -> clientNoteDays null', r4.cn, null);
}

A.finish();
