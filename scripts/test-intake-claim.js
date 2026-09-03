// test-intake-claim.js - the consume-once claim in bwn-wo-intake.user.js's stage-2 handoff.
//
// The bug this pins (live, W-392732 on 2026-09-03): every document the WO Intake handoff attached
// landed TWICE - two bulkAddWorkOrderDocuments batches 10ms apart. The pending files were read with
// a READONLY transaction and deleted with a separate one, so two overlapping checkers (the second
// tab Umbrava leaves on the same new WO, or a load plus a path-change tick in one tab) both read
// the record before either delete committed, and both handed the same files to BWN Drop Upload.
//
// The fix is atomicity, not a bigger flag: idbClaim reads and deletes inside ONE readwrite
// transaction, so exactly one caller can ever come away with the record.
//
// Same pattern as the sibling harnesses: slice the REAL shipped source and run it in a vm. The
// IndexedDB stand-in below models the one property the fix depends on - readwrite transactions on
// a store serialize, readonly ones do not - and the negative control at the end proves it is
// sensitive to exactly the bug that shipped (the old readonly-get + separate-delete pattern
// double-claims against this same stand-in).
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-intake-claim.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-wo-intake.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(startNeedle, endNeedle, what) {
  var a = full.indexOf(startNeedle);
  if (a === -1) throw new Error('SLICE START ABSENT (' + what + '): ' + JSON.stringify(startNeedle.slice(0, 60)));
  var b = full.indexOf(endNeedle, a);
  if (b === -1) throw new Error('SLICE END ABSENT (' + what + '): ' + JSON.stringify(endNeedle.slice(0, 60)));
  return full.slice(a, b);
}

var BLOCK_IDB = slice('function idbReq(', 'function waitWoReady(', 'stage-2 IndexedDB helpers');

// ---- IndexedDB stand-in -------------------------------------------------------------------------
// Models the guarantee the fix rests on: a readwrite transaction holds the store for its whole
// life (queued behind any other readwrite), a readonly one reads straight away. Requests resolve
// asynchronously and a request's onsuccess may queue further work in the same transaction.
function makeFakeIndexedDB(seed) {
  var data = {};
  for (var k in seed) { if (Object.prototype.hasOwnProperty.call(seed, k)) data[k] = seed[k]; }
  var rwHeld = false, rwWaiting = [];

  function release() {
    rwHeld = false;
    if (rwWaiting.length) { var next = rwWaiting.shift(); rwHeld = true; setTimeout(next, 0); }
  }

  function makeTx(mode) {
    var queue = [], drained = false, tx = { oncomplete: null, onerror: null };
    var store = {
      get: function (key) { return op(function () { return data[key]; }); },
      put: function (val, key) { return op(function () { data[key] = val; }); },
      delete: function (key) { return op(function () { delete data[key]; }); }
    };
    function op(fn) {
      var rq = { onsuccess: null, onerror: null, result: undefined };
      queue.push(function () { rq.result = fn(); if (rq.onsuccess) rq.onsuccess(); });
      if (drained) drain();   // queued from inside a callback while we already hold the store
      return rq;
    }
    function drain() {
      drained = true;
      while (queue.length) queue.shift()();
    }
    function start() {
      drain();
      if (mode === 'readwrite') release();
      if (tx.oncomplete) tx.oncomplete();
    }
    tx.objectStore = function () { return store; };
    // The caller queues its requests synchronously right after transaction(); start on the next tick.
    if (mode === 'readwrite') {
      if (rwHeld) rwWaiting.push(start); else { rwHeld = true; setTimeout(start, 0); }
    } else {
      setTimeout(start, 0);
    }
    return tx;
  }

  return {
    _data: data,
    open: function () {
      var rq = { onsuccess: null, onerror: null, onupgradeneeded: null, result: null };
      rq.result = { transaction: function (name, mode) { return makeTx(mode); }, createObjectStore: function () { } };
      setTimeout(function () { if (rq.onsuccess) rq.onsuccess(); }, 0);
      return rq;
    }
  };
}

function load(seed) {
  var ctx = {
    indexedDB: makeFakeIndexedDB(seed), setTimeout: setTimeout, Promise: Promise, Date: Date, console: console,
    document: { addEventListener: function () { } }   // the slice carries the Create-click listener; registering it is a no-op here
  };
  vm.runInNewContext(BLOCK_IDB + '\n;this.idbReq=idbReq;this.idbPut=idbPut;this.idbClaim=idbClaim;', ctx);
  return ctx;
}

var PATH_WO = '/work-orders/1312119';
var TTL = 3 * 60 * 1000;
function pending(over) {
  var p = { ts: Date.now(), fromPath: '/work-orders', files: ['email.msg', 'wo.pdf'], po: '1135476-00000012', client: 'Caleres Inc' };
  for (var k in over) { if (Object.prototype.hasOwnProperty.call(over, k)) p[k] = over[k]; }
  return p;
}

console.log('WO Intake stage-2 claim - consume-once under overlapping checkers\n');

var tests = [];

// 1. THE BUG. Two checkers race for one pending record; exactly one may come away with it.
tests.push(function () {
  var ctx = load({ current: pending() });
  return Promise.all([ctx.idbClaim('current', PATH_WO, TTL), ctx.idbClaim('current', PATH_WO, TTL)]).then(function (r) {
    var won = r.filter(Boolean);
    A.eq('two overlapping claims -> exactly one wins (the duplicate-upload bug)', won.length, 1);
    A.eq('  the winner carries the files', won[0] && won[0].files, ['email.msg', 'wo.pdf']);
    A.ok('  the record is consumed', ctx.indexedDB._data.current === undefined);
  });
});

// 2. A single claim still works, and a second later claim finds nothing.
tests.push(function () {
  var ctx = load({ current: pending() });
  return ctx.idbClaim('current', PATH_WO, TTL).then(function (first) {
    A.ok('a lone claim returns the record', !!first);
    return ctx.idbClaim('current', PATH_WO, TTL);
  }).then(function (second) {
    A.eq('a claim after the record is consumed returns null', second, null);
  });
});

// 3. Create failed - the modal never navigated, so the record must SURVIVE for the real create.
tests.push(function () {
  var ctx = load({ current: pending({ fromPath: PATH_WO }) });
  return ctx.idbClaim('current', PATH_WO, TTL).then(function (p) {
    A.eq('same path (create failed) -> claims nothing', p, null);
    A.ok('  and the record is left for the next attempt', !!ctx.indexedDB._data.current);
  });
});

// 4. Stale record: claim nothing, but clear it out.
tests.push(function () {
  var ctx = load({ current: pending({ ts: Date.now() - 10 * 60 * 1000 }) });
  return ctx.idbClaim('current', PATH_WO, TTL).then(function (p) {
    A.eq('stale record -> claims nothing', p, null);
    A.ok('  and is deleted rather than left to fire later', ctx.indexedDB._data.current === undefined);
  });
});

// 5. Empty / absent record.
tests.push(function () {
  var ctx = load({});
  return ctx.idbClaim('current', PATH_WO, TTL).then(function (p) {
    A.eq('no record -> null', p, null);
    var c2 = load({ current: pending({ files: [] }) });
    return c2.idbClaim('current', PATH_WO, TTL);
  }).then(function (p2) {
    A.eq('record with no files -> null', p2, null);
  });
});

// 6. NEGATIVE CONTROL. The pattern that shipped - a readonly get, then a separate delete - must
//    double-claim against this same stand-in. Without this, a stand-in that serialized everything
//    would pass test 1 no matter what the source does.
tests.push(function () {
  var ctx = load({ current: pending() });
  function oldClaim() {
    return ctx.idbReq('readonly', function (st) { return st.get('current'); }).then(function (p) {
      if (!p || !p.files || !p.files.length) return null;
      if (p.fromPath === PATH_WO) return null;
      ctx.idbReq('readwrite', function (st) { st.delete('current'); });
      return p;
    });
  }
  return Promise.all([oldClaim(), oldClaim()]).then(function (r) {
    A.eq('negative control: the old readonly-get pattern DOES double-claim here', r.filter(Boolean).length, 2);
  });
});

tests.reduce(function (chain, t) { return chain.then(t); }, Promise.resolve())
  .then(function () { A.finish(); })
  .catch(function (e) { console.error('HARNESS ERROR: ' + (e && e.stack || e)); process.exit(1); });
