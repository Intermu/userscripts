// test-dispatch-autotask.js - node harness for bwn-dispatch 0.14.0's auto-dispatch task handling
// and bwn-wo-intake 0.10.0's auto-dispatch Vendor NTE.
//
// Umbrava auto-dispatch (Pilot, 2026-10) leaves the WO in Pending Schedule on Team T with an OPEN
// task "Purchase Order created, call vendor to confirm receipt" (live on W-401152). Dispatch now
// shows its launcher while that task is open and can move the task to the assignee via editTask -
// a FULL REPLACE, so the payload must carry the fresh record back with only assignedTo changed.
//
// WHAT THIS PROVES, against the real shipped bytes (the AUTO-TASK-ENGINE block is sliced out and run
// in a vm with a stubbed gql + bwnGqlOp):
//   - findAutoTask matches only the OPEN auto-dispatch task on this WO, and rejects a short read;
//   - the editTask payload carries every protected field verbatim, omits categoryId, changes only
//     assignedTo, and passes the engine's own validate();
//   - moveAutoTask refuses a task that changed since the snapshot, a flagged task, and reports a
//     read-back that does not show the move - it only returns '' on a verified read-back;
//   - vendorNteFor floors DNE x 0.66 to whole dollars ($1,500 -> 990, GP >= 34%).
// WHAT IT DOES NOT PROVE: the live editTask on this exact task. Core's bulkTask capture
// (2026-09-29) is the wire proof for the shape; the first real dispatch is the live check.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-dispatch-autotask.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

function read(f) { return fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/\r\n/g, '\n'); }
function slice(src, a, b) {
  var i = src.indexOf(a); if (i === -1) throw new Error('slice start absent: ' + a);
  var j = src.indexOf(b, i); if (j === -1) throw new Error('slice end absent: ' + b);
  return src.slice(i, j);
}
var disp = read('bwn-dispatch.user.js');
var consts = slice(disp, '  var AUTO_TASK_RE =', '  // -> the open auto-dispatch task');
var engine = slice(disp, '  // ===== AUTO-TASK-ENGINE START', '  // ===== AUTO-TASK-ENGINE END');

var TASK = {
  id: 't1', entityId: '401152', entityType: 1, description: 'Purchase Order created, call vendor to confirm receipt',
  targetStartDate: '2026-10-01T21:02:43.758+00:00', assignedTo: 'team-t', metadata: '{"number":"401152"}',
  categoryId: null, isComplete: false, flag: false, priorityStatus: 0
};
function clone(o) { return JSON.parse(JSON.stringify(o)); }

function harness(opts) {
  var reads = 0, sent = [];
  var ctx = {
    console: console, Date: Date, isFinite: isFinite, parseInt: parseInt, String: String, Array: Array, Promise: Promise,
    gql: function (q, v) {
      reads++;
      var tasks = opts.tasks(reads);
      return opts.readFail && reads === opts.readFail ? Promise.reject(new Error('net')) :
        Promise.resolve({ tasksByEntityTypeAndId: { total: opts.total != null ? opts.total : tasks.length, tasks: tasks } });
    },
    bwnGqlOp: function (op, q, vars, o) {
      var vr = o.validate(vars);
      sent.push({ op: op, vars: vars, validate: vr, feature: o.feature });
      if (vr !== true) return Promise.reject(new Error('validation failed'));
      return opts.writeFail ? Promise.reject(new Error('refused')) : Promise.resolve({ editTask: { success: true } });
    }
  };
  vm.createContext(ctx);
  vm.runInContext(consts + engine + '\nthis.findAutoTask=findAutoTask;this.moveAutoTask=moveAutoTask;this.autoTaskPayload=autoTaskPayload;this.autoTaskBlocker=autoTaskBlocker;', ctx);
  ctx.sent = sent;
  return ctx;
}

(async function () {
  console.log('# findAutoTask');
  var other = Object.assign(clone(TASK), { id: 't2', description: 'UPDATE CLIENT TENTATIVE TODAY' });
  var done = Object.assign(clone(TASK), { id: 't3', isComplete: true });
  var h = harness({ tasks: function () { return [other, done, clone(TASK)]; } });
  var t = await h.findAutoTask(401152);
  A.eq('picks the open auto-dispatch task', t && t.id, 't1');
  h = harness({ tasks: function () { return [other, done]; } });
  A.eq('no open auto task -> null', await h.findAutoTask(401152), null);
  h = harness({ tasks: function () { return [clone(TASK)]; }, total: 5 });
  var rej = false; try { await h.findAutoTask(401152); } catch (e) { rej = true; }
  A.ok('short read (total > rows) rejects, never "no task"', rej);

  console.log('\n# payload = fresh record, only assignedTo changed');
  var p = h.autoTaskPayload(clone(TASK), 'mike').data;
  A.eq('id/entity verbatim', [p.id, p.entityId, p.entityType].join('|'), 't1|401152|1');
  A.eq('description verbatim', p.description, TASK.description);
  A.eq('metadata verbatim', p.metadata, TASK.metadata);
  A.eq('same instant', Date.parse(p.targetStartDate), Date.parse(TASK.targetStartDate));
  A.ok('categoryId omitted (not null)', !('categoryId' in p));
  A.eq('assignedTo = target', p.assignedTo, 'mike');

  console.log('\n# moveAutoTask');
  var moved = Object.assign(clone(TASK), { assignedTo: 'mike' });
  h = harness({ tasks: function (n) { return n === 1 ? [clone(TASK)] : [moved]; } });
  A.eq('verified read-back -> ""', await h.moveAutoTask('401152', clone(TASK), 'mike'), '');
  A.eq('one editTask sent, validate passed', h.sent.length + ':' + h.sent[0].validate + ':' + h.sent[0].op, '1:true:editTask');
  A.eq('routed under the dispatch kill switch', h.sent[0].feature, 'dispatch');

  var changed = Object.assign(clone(TASK), { assignedTo: 'someone-else' });
  h = harness({ tasks: function () { return [changed]; } });
  A.eq('changed since snapshot -> refused, nothing sent', (await h.moveAutoTask('401152', clone(TASK), 'mike')) + ':' + h.sent.length, 'task changed since the drawer opened:0');

  var flagged = Object.assign(clone(TASK), { flag: true });
  h = harness({ tasks: function () { return [flagged]; } });
  A.ok('flagged task -> refused, nothing sent', /flagged/.test(await h.moveAutoTask('401152', flagged, 'mike')) && h.sent.length === 0);

  h = harness({ tasks: function () { return [clone(TASK)]; } });
  A.eq('read-back still on Team T -> reported', await h.moveAutoTask('401152', clone(TASK), 'mike'), 'read-back does not show the new assignee');

  h = harness({ tasks: function (n) { return n === 1 ? [clone(TASK)] : [moved]; }, writeFail: true });
  A.ok('write error that landed is called out, not ok', /read-back shows it moved/.test(await h.moveAutoTask('401152', clone(TASK), 'mike')));

  h = harness({ tasks: function () { return []; } });
  A.eq('task gone -> reported', await h.moveAutoTask('401152', clone(TASK), 'mike'), 'task is no longer open');

  console.log('\n# wo-intake vendorNteFor (~34% GP, floored)');
  var intake = read('bwn-wo-intake.user.js');
  var ictx = { Math: Math, String: String };
  vm.createContext(ictx);
  vm.runInContext(slice(intake, '  var AUTO_DISPATCH_GP =', '  function fillAutoDispatchNte(') + '\nthis.vendorNteFor=vendorNteFor;', ictx);
  A.eq('$1,500 DNE -> 990', ictx.vendorNteFor(1500), '990');
  A.eq('$800 DNE -> 528', ictx.vendorNteFor(800), '528');
  A.eq('$1,234.56 DNE -> 814 (floored)', ictx.vendorNteFor(1234.56), '814');
  [350, 800, 1500, 2725.5].forEach(function (d) {
    var gp = Math.round((1 - Number(ictx.vendorNteFor(d)) / d) * 1e6) / 1e6;
    A.ok('GP at $' + d + ' within 34-35% (' + (gp * 100).toFixed(2) + '%)', gp >= 0.34 && gp < 0.35);
  });

  A.finish();
})().catch(function (e) { console.error(e); process.exit(1); });
