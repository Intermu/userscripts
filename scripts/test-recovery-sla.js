// test-recovery-sla.js - Recovery Playbooks Layer A (read-only). Proves the PURE
// slaCountdown + breachPredict engine by SLICING the REAL shipped BWN-SLA block (plus the
// bwnThresholdsFor clock it reuses) out of bwn-suite-core.user.js and running it in a vm - the
// logic is never restated here (test-ecdrisk.js precedent). Structural guards then assert the
// two module flags default OFF and that the job-acts overlay carries the SLA fields, so a
// surface without the engine (the SWA case file) can render the same chip.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-recovery-sla.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var core = fs.readFileSync(path.join(__dirname, '..', 'bwn-suite-core.user.js'), 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = core.indexOf(start);
  if (a === -1) throw new Error('SLICE START ABSENT (' + what + '): ' + JSON.stringify(start.slice(0, 60)));
  var b = core.indexOf(end, a);
  if (b === -1) throw new Error('SLICE END ABSENT (' + what + '): ' + JSON.stringify(end.slice(0, 60)));
  return core.slice(a, b + end.length);
}

// The clock (HEAT_CFG + prio helpers + bwnSlaMult + bwnThresholdsFor) and the BWN-SLA block are
// contiguous in the file - one slice captures both, so the test runs exactly the shipped bytes.
var BLOCK = slice('  var BWN_HEAT_CFG = {', '// ===== BWN-SLA END v1 =====', 'sla-block');

// A minimal BWN stub - only cfg() is reached (bwnThresholdsFor's `C = C || BWN.cfg()` fallback;
// every call below passes C explicitly, so cfg() is a belt-and-braces default, not the path).
var CFG = { hrsWarn: 72, hrsBad: 240, activeMult: 0.5, dueWarnDays: 3, schedGraceDays: 1, noteStaleDays: 7 };
var sandbox = {
  BWN: { cfg: function () { return CFG; } },
  Math: Math, Number: Number, String: String, parseInt: parseInt, isFinite: isFinite, isNaN: isNaN, console: console
};
sandbox.module = { exports: {} };
// Expose the two engine fns from inside the slice.
vm.runInNewContext(BLOCK + '\n;module.exports={ slaCountdown: slaCountdown, breachPredict: breachPredict, thresholdsFor: bwnThresholdsFor };', sandbox, { filename: 'sla-block.js' });
var E = sandbox.module.exports;
var NOW = Date.UTC(2026, 8, 1);   // injected clock (unused by the pure math, present for parity)

// ---- slaCountdown: null when there is no hours-in-status reading ----
A.eq('no hrs -> null', E.slaCountdown({ status: 'New', priority: '', hrs: null }, CFG, NOW), null);
A.eq('undefined hrs -> null', E.slaCountdown({ status: 'New', priority: '' }, CFG, NOW), null);
A.ok('null state -> null', E.slaCountdown(null, CFG, NOW) === null);

// ---- slaCountdown boundaries (plain status -> mult 1 -> warn 72 / bad 240) ----
function sc(hrs, extra) { return E.slaCountdown(Object.assign({ status: 'New', priority: '', hrs: hrs }, extra || {}), CFG, NOW); }
A.eq('below warn -> ok', sc(50).level, 'ok');
A.eq('below warn hrsToBad', sc(50).hrsToBad, 190);
A.eq('just under warn -> ok', sc(71.9).level, 'ok');
A.eq('AT warn -> warn', sc(72).level, 'warn');
A.eq('between warn/bad -> warn', sc(200).level, 'warn');
A.eq('just under bad -> warn', sc(239).level, 'warn');
A.eq('AT bad -> breach', sc(240).level, 'breach');
A.eq('AT bad -> breached true', sc(240).breached, true);
A.eq('past bad -> breach', sc(300).level, 'breach');
A.eq('warnHrs/badHrs surfaced', [sc(50).warnHrs, sc(50).badHrs], [72, 240]);

// ---- Active-status scaling (Scheduled matches ACTIVE_RE -> mult *0.5 -> warn 36 / bad 120) ----
var act = E.slaCountdown({ status: 'Scheduled', priority: '', hrs: 120 }, CFG, NOW);
A.eq('active status halves the clock (bad 120)', act.badHrs, 120);
A.eq('active status at 120h -> breach', act.level, 'breach');

// ---- SLA category scaling via state.sla (bwnSlaMult): emergency -> *0.25 -> bad 60 ----
var emg = sc(61, { sla: { responseMinutes: null, category: 'emergency' } });
A.eq('emergency category -> bad 60', emg.badHrs, 60);
A.eq('emergency at 61h -> breach', emg.level, 'breach');
A.eq('slaScaled true when facts present', emg.slaScaled, true);
A.eq('no sla facts -> slaScaled false', sc(50).slaScaled, false);

// ---- breachPredict: the flag fires BEFORE the due date (the headline case) ----
// hrs 200 (warn72/bad240 -> hrsToBad 40h), ECD 5 days out (120h). 40h < 120h -> predicted breach.
var bp1 = E.breachPredict({ status: 'New', priority: '', hrs: 200, due: { label: 'Due 5d' } }, CFG, NOW);
A.eq('predicts breach before due', bp1.willBreach, true);
A.eq('predicted, not yet breached', bp1.breached, false);
A.eq('carries dueDays', bp1.dueDays, 5);

// No false positive: plenty of clock left before a near ECD.
var bp2 = E.breachPredict({ status: 'New', priority: '', hrs: 50, due: { label: 'Due 2d' } }, CFG, NOW);
A.eq('no breach when clock outlasts due', bp2.willBreach, false);

// Overdue ECD -> always predicted.
var bp3 = E.breachPredict({ status: 'New', priority: '', hrs: 50, due: { label: 'Overdue 3d' } }, CFG, NOW);
A.eq('overdue ECD -> willBreach', bp3.willBreach, true);
A.eq('overdue ECD -> dueDays negative', bp3.dueDays, -3);

// Already breached -> breached AND willBreach true, regardless of ECD.
var bp4 = E.breachPredict({ status: 'New', priority: '', hrs: 260, due: { label: 'Due 90d' } }, CFG, NOW);
A.eq('already breached -> breached', bp4.breached, true);
A.eq('already breached -> willBreach', bp4.willBreach, true);

// No ECD (state.due null): not-breached -> no horizon -> not predicted.
var bp5 = E.breachPredict({ status: 'New', priority: '', hrs: 100, due: null }, CFG, NOW);
A.eq('no ECD + not breached -> no prediction', bp5.willBreach, false);

// No hrs reading -> breachPredict is inert (no countdown).
var bp6 = E.breachPredict({ status: 'New', priority: '', hrs: null, due: { label: 'Overdue 9d' } }, CFG, NOW);
A.eq('no hrs -> willBreach false', bp6.willBreach, false);

// ---- Structural guards over the SHIPPED source (flags default OFF; overlay carries SLA) ----
A.ok('recoveryPlaybooks default OFF', /recoveryPlaybooks:\s*false/.test(core));
A.ok('recoveryWrites default OFF', /recoveryWrites:\s*false/.test(core));
A.ok('overlay carries slaCountdown', /slaCountdown:\s*\(function/.test(core));
A.ok('overlay carries breachPredict', /breachPredict:\s*\(function/.test(core));
A.ok('state carries sla facts', /sla:\s*\(woApi && woApi\.priority\)/.test(core));

A.finish();
