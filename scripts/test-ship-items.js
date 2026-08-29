// test-ship-items.js - node harness for bwn-inventory's "Ship items" orchestration (0.4.0).
//
// THE CHANGE, as found in source:
//   bwn-inventory 0.4.0 adds a "Ship items" mode: a multi-line grid that issues several SKUs to a
//   work order, then files ONE packing slip covering the lines that moved. The transactional core -
//   A (inventory issues) BEFORE B (one packing-slip POST), per-line non-atomic, never rolled back,
//   both halves separately idempotent - lives in the DOM-free, transport-injected block delimited by
//     // ===== SHIP-ITEMS ORCHESTRATION START ... END =====
//   in bwn-inventory.user.js. This harness SLICES that exact block out of the shipped bytes and runs
//   it in a vm with a STUBBED transport. It NEVER makes a network call - a real /api/inventory-stock
//   "issue" posts a live inventory movement + GL entry in production Table Storage, so the write path
//   is proven only against the stub here; the live gate is Mike's (see report + the vault flow note).
//
// WHAT THIS PROVES against the real sliced source (nothing below is a restatement of a stub):
//   - A before B: every line's issue POST precedes the single slip POST; the slip fires exactly once.
//   - Partial commit: a failed line does not roll back the committed ones; the slip covers ONLY the
//     committed lines; the failed line keeps a structured, guiding error.
//   - Slip-fail path: when the slip route fails, inventory stays committed and a resend (shipPostSlip)
//     re-POSTs the SLIP route ONLY - it adds zero new inventory calls (can never double-post stock).
//   - SourceId stability: a retry re-sends the FAILED line under the same SourceId (<ShipmentId>-<i>)
//     and does NOT re-send an already-committed line (idempotent skip).
//   - SlipNumber / SourceId formats; -valueDelta -> positive COGS cents; unitCost = round(value/qty).
//   - The $0-cost / over-qty / missing-bin pre-checks WARN and never block the issue.
//   - A blank RecipientEmail still ships (the key is OMITTED from the slip body, not sent empty).
//
// WHAT IT DOES NOT PROVE:
//   - that /api/inventory-stock or /api/packing-slip behave as coded on the live schema (the slip
//     route is being built on a sibling branch and is dark/503 until deployed); or any DOM wiring in
//     buildModal (the grid, ShipTo prefill, status rendering) - that is the live gate.
//
// Every case is re-run against mutated copies of the same source; each mutation MUST turn this
// harness red. mutate() throws if its target is absent or not unique, so a control that silently
// no-ops cannot pass.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-ship-items.js

var fs = require('fs');
var path = require('path');
var vm = require('vm');
var A = require('./assert.js');

var SRC = path.join(__dirname, '..', 'bwn-inventory.user.js');
var full = fs.readFileSync(SRC, 'utf8').replace(/\r\n/g, '\n');

function slice(start, end, what) {
  var a = full.indexOf(start);
  if (a === -1) throw new Error(what + ': START marker not found - the ship-items block is gone from bwn-inventory.user.js');
  if (full.indexOf(start, a + 1) !== -1) throw new Error(what + ': START marker not unique');
  var b = full.indexOf(end, a);
  if (b === -1) throw new Error(what + ': END marker not found after start');
  return full.slice(a, b);
}

var S_SHIP = slice('// ===== SHIP-ITEMS ORCHESTRATION START', '// ===== SHIP-ITEMS ORCHESTRATION END', 'ship orchestration block');

function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

function loadShip(src) {
  var sandbox = {
    Object: Object, Array: Array, Number: Number, String: String, JSON: JSON,
    Promise: Promise, RegExp: RegExp, Date: Date, Math: Math
  };
  vm.createContext(sandbox);
  return vm.runInContext(
    '(function () {\n' + src + '\n' +
    'return { shipFirst6: shipFirst6, shipSourceId: shipSourceId, shipSlipNumber: shipSlipNumber,' +
    ' shipMintIds: shipMintIds, parseShipAddr: parseShipAddr, shipPrecheck: shipPrecheck,' +
    ' classifyStock: classifyStock, shipSummary: shipSummary, shipIssueAll: shipIssueAll,' +
    ' shipSlipBody: shipSlipBody, shipPostSlip: shipPostSlip, shipSubmit: shipSubmit };\n})()',
    sandbox, { filename: 'ship-orchestration.js' });
}

// ---- Stub transport ----------------------------------------------------------
// handler(url, rec, callIndex) -> { status, json } to resolve, or { __reject: 'msg' } to reject
// (network/timeout). Records a deep-cloned copy of every call so a case can inspect what was sent.
function makeStub(handler) {
  var calls = [];
  function post(url, headers, body) {
    var idx = calls.length;
    var rec = { url: url, headers: headers, body: JSON.parse(JSON.stringify(body || {})) };
    calls.push(rec);
    var out = handler(url, rec, idx);
    if (out && out.__reject) return Promise.reject(new Error(out.__reject));
    return Promise.resolve({ status: out.status, json: out.json });
  }
  return { post: post, calls: calls };
}
function isStock(c) { return c.url === 'STOCK'; }
function isSlip(c) { return c.url === 'SLIP'; }
function depsFor(stub, over) {
  var d = { post: stub.post, key: 'k', userToken: 'tok', urls: { stock: 'STOCK', slip: 'SLIP' } };
  if (over) { for (var k in over) if (Object.prototype.hasOwnProperty.call(over, k)) d[k] = over[k]; }
  return d;
}
function mkLine(sku, qty) { return { sku: sku, desc: sku + ' desc', uom: 'ea', qty: qty, status: 'pending', valueCents: 0, unitCostCents: 0, code: '', error: '' }; }
function mkState(over) {
  var s = {
    shipmentId: 'abcdef12-3456-7890-abcd-ef1234567890',
    slipNumber: 'PS-386473-abcdef',
    shipDate: '2026-08-26', woNum: '386473', sourceWarehouse: 'Main',
    shipTo: { recipient: '', company: 'Acme', phone: '', address1: '1 A St', address2: '', city: 'X', state: 'NY', zip: '10001' },
    recipientEmail: 'tech@x.com',
    lines: [mkLine('SKU-A', '2'), mkLine('SKU-B', '3')]
  };
  if (over) { for (var k in over) if (Object.prototype.hasOwnProperty.call(over, k)) s[k] = over[k]; }
  return s;
}

// ---- The cases ---------------------------------------------------------------
// Collect results (not asserting) so the same body can be re-run against a mutant.
function runCases(src) {
  var out = [];
  function ok(name, cond, detail) { out.push({ name: name, ok: !!cond, detail: detail }); }
  function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), 'got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
  var api = loadShip(src);

  // ---- pure helpers: slip number / source id / mint --------------------------
  eq('slip number = PS-<WO>-<first6(ShipmentId)>', api.shipSlipNumber('386473', 'abcdef12-3456'), 'PS-386473-abcdef');
  eq('first6 strips dashes before taking 6', api.shipSlipNumber('1', 'ab-cd-ef-gh'), 'PS-1-abcdef');
  eq('blank WO falls back to NOWO', api.shipSlipNumber('', 'abcdef123'), 'PS-NOWO-abcdef');
  eq('source id = <ShipmentId>-<index>', api.shipSourceId('SID', 3), 'SID-3');
  var ids = api.shipMintIds('386473', function () { return 'deadbeef-1111-2222'; });
  eq('minted slip number matches the shipment id', ids.slipNumber, 'PS-386473-deadbe');

  // ---- pure: address parse ---------------------------------------------------
  eq('parses "street, city, ST zip"', api.parseShipAddr('123 Main St, Springfield, IL 62704'), { address1: '123 Main St', city: 'Springfield', state: 'IL', zip: '62704' });
  eq('zip+4 is supported', api.parseShipAddr('9 Oak Ave, Denver, CO 80202-1234').zip, '80202-1234');
  eq('an unparseable address drops whole into address1', api.parseShipAddr('somewhere odd'), { address1: 'somewhere odd', city: '', state: '', zip: '' });

  // ---- pure: pre-submit soft checks WARN, never block ------------------------
  var onhand = [{ warehouse: 'Main', qty: 5, rate: 1200 }, { warehouse: 'B', qty: 0, rate: 0 }];
  ok('over-qty warns NEGATIVE', api.shipPrecheck(10, onhand, 'Main').some(function (w) { return w.type === 'NEGATIVE'; }));
  ok('a $0-cost bin warns ZERO_COST', api.shipPrecheck(1, [{ warehouse: 'Main', qty: 5, rate: 0 }], 'Main').some(function (w) { return w.type === 'ZERO_COST'; }));
  ok('a missing bin warns NO_BIN', api.shipPrecheck(1, onhand, 'Nowhere').some(function (w) { return w.type === 'NO_BIN'; }));
  eq('within stock + priced = no warnings', api.shipPrecheck(1, onhand, 'Main').length, 0);

  // build the async chain of orchestration cases
  var chain = Promise.resolve();

  // ---- CASE 1: happy path - A before B, value math, slip covers both ---------
  chain = chain.then(function () {
    var stub = makeStub(function (url, rec) {
      if (url === 'STOCK') return { status: 200, json: { ok: true, valueDelta: -100 * Number(rec.body.Quantity) } };
      return { status: 200, json: { ok: true } };
    });
    var st = mkState();
    return api.shipSubmit(depsFor(stub), st).then(function (res) {
      eq('both lines committed', st.lines.map(function (l) { return l.status; }), ['committed', 'committed']);
      eq('valueCents is positive COGS (= -valueDelta)', st.lines[0].valueCents, 200);
      eq('unitCostCents = round(value / qty)', st.lines[0].unitCostCents, 100);
      eq('phaseA allCommitted', res.phaseA.allCommitted, true);
      ok('slip posted ok', res.slip && res.slip.ok, JSON.stringify(res.slip));
      var urls = stub.calls.map(function (c) { return c.url; });
      var slipIdx = urls.indexOf('SLIP');
      var lastStock = -1; stub.calls.forEach(function (c, i) { if (isStock(c)) lastStock = i; });
      ok('A before B: every issue precedes the one slip', slipIdx !== -1 && slipIdx > lastStock, 'order=' + urls.join(','));
      eq('exactly one slip call', stub.calls.filter(isSlip).length, 1);
      eq('two issue calls', stub.calls.filter(isStock).length, 2);
      var issue0 = stub.calls.filter(isStock)[0].body;
      eq('issue MovementType is issue', issue0.MovementType, 'issue');
      eq('issue SourceId = <ShipmentId>-0', issue0.SourceId, st.shipmentId + '-0');
      eq('issue carries the source warehouse', issue0.SourceWarehouse, 'Main');
      ok('issue Remarks names the slip', /slip PS-386473-/.test(issue0.Remarks), issue0.Remarks);
      var slipBody = stub.calls.filter(isSlip)[0].body;
      eq('slip covers both committed lines', slipBody.lines.length, 2);
      eq('slip line carries sku/qty/costs', [slipBody.lines[0].sku, slipBody.lines[0].qty, slipBody.lines[0].unitCostCents, slipBody.lines[0].lineValueCents], ['SKU-A', 2, 100, 200]);
      eq('slip carries the ShipmentId + SlipNumber', [slipBody.ShipmentId, slipBody.SlipNumber], [st.shipmentId, st.slipNumber]);
    });
  });

  // ---- CASE 2: partial commit - never roll back, slip covers committed only --
  chain = chain.then(function () {
    var stub = makeStub(function (url, rec) {
      if (url === 'STOCK') {
        if (rec.body.ItemCode === 'SKU-B') return { status: 409, json: { ok: false, code: 'NEGATIVE_STOCK', have: 1 } };
        return { status: 200, json: { ok: true, valueDelta: -200 } };
      }
      return { status: 200, json: { ok: true } };
    });
    var st = mkState();
    return api.shipSubmit(depsFor(stub), st).then(function (res) {
      eq('line A committed, line B failed (no rollback of A)', st.lines.map(function (l) { return l.status; }), ['committed', 'failed']);
      eq('failed line carries NEGATIVE_STOCK', st.lines[1].code, 'NEGATIVE_STOCK');
      ok('failed line message guides the fix', /reduce the qty|stocked warehouse|receive/.test(st.lines[1].error), st.lines[1].error);
      eq('summary counts 1 committed / 1 failed', [res.phaseA.committed, res.phaseA.failed], [1, 1]);
      ok('slip still filed for the committed line', res.slip && res.slip.ok);
      var slipBody = stub.calls.filter(isSlip)[0].body;
      eq('slip covers ONLY the committed line', slipBody.lines.map(function (l) { return l.sku; }), ['SKU-A']);
    });
  });

  // ---- CASE 3: slip fails, stock ok - resend never re-posts inventory --------
  chain = chain.then(function () {
    var mode = { slip: 503 };
    var stub = makeStub(function (url, rec) {
      if (url === 'STOCK') return { status: 200, json: { ok: true, valueDelta: -100 * Number(rec.body.Quantity) } };
      return { status: mode.slip, json: { ok: mode.slip >= 200 && mode.slip < 300 } };
    });
    var st = mkState();
    var deps = depsFor(stub);
    return api.shipSubmit(deps, st).then(function (res) {
      eq('all lines committed', st.lines.map(function (l) { return l.status; }), ['committed', 'committed']);
      ok('slip reported NOT ok', res.slip && res.slip.ok === false, JSON.stringify(res.slip));
      ok('slip failure message points at Resend', /Resend/.test(res.slip.msg), res.slip.msg);
      var stockBefore = stub.calls.filter(isStock).length;
      // Resend = the packing-slip POST only. Flip the slip route healthy.
      mode.slip = 200;
      return api.shipPostSlip(deps, st).then(function (slip2) {
        var stockAfter = stub.calls.filter(isStock).length;
        eq('resend adds NO new inventory calls', stockAfter, stockBefore);
        ok('resend hit the slip route again', stub.calls.filter(isSlip).length >= 2);
        ok('resend succeeded', slip2.ok);
      });
    });
  });

  // ---- CASE 4: SourceId stability + committed-skip across a retry ------------
  chain = chain.then(function () {
    var mode = { failB: true };
    var stub = makeStub(function (url, rec) {
      if (url === 'STOCK') {
        if (rec.body.ItemCode === 'SKU-B' && mode.failB) return { status: 409, json: { ok: false, code: 'CONTENDED' } };
        return { status: 200, json: { ok: true, valueDelta: -100 } };
      }
      return { status: 200, json: { ok: true } };
    });
    var st = mkState();
    var deps = depsFor(stub);
    return api.shipSubmit(deps, st).then(function () {
      var firstB = stub.calls.filter(function (c) { return isStock(c) && c.body.ItemCode === 'SKU-B'; });
      eq('one B attempt on the first pass', firstB.length, 1);
      var srcIdFirst = firstB[0].body.SourceId;
      mode.failB = false;
      return api.shipSubmit(deps, st).then(function () {
        var aCalls = stub.calls.filter(function (c) { return isStock(c) && c.body.ItemCode === 'SKU-A'; });
        var bCalls = stub.calls.filter(function (c) { return isStock(c) && c.body.ItemCode === 'SKU-B'; });
        eq('committed line A is NOT re-sent on retry', aCalls.length, 1);
        eq('failed line B is retried once more', bCalls.length, 2);
        eq('B SourceId is stable across the retry', bCalls[1].body.SourceId, srcIdFirst);
        eq('both lines committed after the retry', st.lines.map(function (l) { return l.status; }), ['committed', 'committed']);
        eq('exactly one slip call on the retry (not the first, 1 committed then; total 2)', stub.calls.filter(isSlip).length, 2);
      });
    });
  });

  // ---- CASE 5: nothing committed -> no slip (A before B, honestly) -----------
  chain = chain.then(function () {
    var stub = makeStub(function (url) {
      if (url === 'STOCK') return { status: 409, json: { ok: false, code: 'NEGATIVE_STOCK', have: 0 } };
      return { status: 200, json: { ok: true } };
    });
    var st = mkState();
    return api.shipSubmit(depsFor(stub), st).then(function (res) {
      eq('nothing moved -> res.slip is null', res.slip, null);
      eq('no slip call fired when nothing committed', stub.calls.filter(isSlip).length, 0);
    });
  });

  // ---- CASE 6: pre-check never blocks; a $0 issue books $0 -------------------
  chain = chain.then(function () {
    var stub = makeStub(function (url) {
      if (url === 'STOCK') return { status: 200, json: { ok: true, valueDelta: 0 } };
      return { status: 200, json: { ok: true } };
    });
    var st = mkState({ lines: [mkLine('SKU-Z', '999')] });
    return api.shipSubmit(depsFor(stub), st).then(function () {
      eq('the issue commits despite an over-qty / $0 condition (warn, not block)', st.lines[0].status, 'committed');
      eq('a $0-cost issue books $0 value', st.lines[0].valueCents, 0);
    });
  });

  // ---- CASE 7: blank RecipientEmail still ships (key OMITTED, not empty) -----
  chain = chain.then(function () {
    var stub = makeStub(function (url) {
      if (url === 'STOCK') return { status: 200, json: { ok: true, valueDelta: -50 } };
      return { status: 200, json: { ok: true } };
    });
    var st = mkState({ recipientEmail: '', lines: [mkLine('SKU-A', '1')] });
    return api.shipSubmit(depsFor(stub), st).then(function (res) {
      ok('ships with a blank recipient email', res.slip && res.slip.ok);
      var slipBody = stub.calls.filter(isSlip)[0].body;
      ok('a blank email is OMITTED from the slip body (not sent empty)', !('RecipientEmail' in slipBody), JSON.stringify(slipBody));
    });
  }).then(function () {
    var stub = makeStub(function (url) {
      if (url === 'STOCK') return { status: 200, json: { ok: true, valueDelta: -50 } };
      return { status: 200, json: { ok: true } };
    });
    var st = mkState({ recipientEmail: 'a@b.com', lines: [mkLine('SKU-A', '1')] });
    return api.shipSubmit(depsFor(stub), st).then(function () {
      var slipBody = stub.calls.filter(isSlip)[0].body;
      eq('a provided email DOES ride the slip', slipBody.RecipientEmail, 'a@b.com');
    });
  });

  // ---- CASE 8: a network timeout on a line is recorded retry-safe -----------
  chain = chain.then(function () {
    var stub = makeStub(function (url, rec) {
      if (url === 'STOCK') { if (rec.body.ItemCode === 'SKU-B') return { __reject: 'timed out' }; return { status: 200, json: { ok: true, valueDelta: -100 } }; }
      return { status: 200, json: { ok: true } };
    });
    var st = mkState();
    return api.shipSubmit(depsFor(stub), st).then(function (res) {
      eq('the timed-out line is failed, not committed', st.lines[1].status, 'failed');
      ok('the timeout is flagged safe to retry', /retry/i.test(st.lines[1].error), st.lines[1].error);
      eq('one line still committed + slipped', res.phaseA.committed, 1);
    });
  });

  return chain.then(function () { return out; }, function (err) {
    out.push({ name: 'cases ran without throwing', ok: false, detail: String(err && err.message || err) });
    return out;
  });
}

// ---- Negative controls -------------------------------------------------------
// Each reverts one piece of the real behaviour; every one MUST turn a case red.
var MUTATIONS = [
  { what: 'a committed line is re-sent on retry (idempotent skip removed)',
    m: function (s) { return mutate(s, "if (line.status === 'committed') { if (deps.onLine) deps.onLine(idx, line); return step(); }", "if (false) { if (deps.onLine) deps.onLine(idx, line); return step(); }"); } },
  { what: 'the slip carries failed lines too (committed-only filter removed)',
    m: function (s) { return mutate(s, "if (l.status !== 'committed') return;", "if (l.status === 'never') return;"); } },
  { what: 'valueDelta sign dropped (COGS booked negative)',
    m: function (s) { return mutate(s, 'line.valueCents = -Number(r.json.valueDelta || 0);', 'line.valueCents = Number(r.json.valueDelta || 0);'); } },
  { what: 'the SourceId separator changed (format/stability broken)',
    m: function (s) { return mutate(s, "return String(shipmentId) + '-' + i;", "return String(shipmentId) + '.' + i;"); } },
  { what: 'B runs even when nothing committed (A-before-B guard removed)',
    m: function (s) { return mutate(s, 'if (sum.committed === 0) return { phaseA: sum, slip: null };', 'if (sum.committed === -1) return { phaseA: sum, slip: null };'); } },
  { what: 'a blank RecipientEmail is sent anyway (omit guard removed)',
    m: function (s) { return mutate(s, 'if (state.recipientEmail) body.RecipientEmail = state.recipientEmail;', 'if (true) body.RecipientEmail = state.recipientEmail;'); } },
  { what: 'the over-qty NEGATIVE pre-check never fires',
    m: function (s) { return mutate(s, "if (q > have) warnings.push({ type: 'NEGATIVE'", "if (q > have + 1e9) warnings.push({ type: 'NEGATIVE'"); } },
  { what: 'the slip route is treated as always-ok (failure hidden)',
    m: function (s) { return mutate(s, 'r.json.ok) return { ok: true', 'r.json.ok && false) return { ok: true'); } },
  { what: 'RESEND re-posts inventory (slip route swapped for the stock route)',
    m: function (s) { return mutate(s, 'deps.post(deps.urls.slip, headers, body, 30000)', 'deps.post(deps.urls.stock, headers, body, 30000)'); } }
];

function main() {
  console.log('\n-- the shipped Ship-items orchestration --');
  runCases(S_SHIP).then(function (results) {
    results.forEach(function (r) { A.ok(r.name, r.ok, r.detail); });

    console.log('\n-- negative controls: each must turn a case above red --');
    return MUTATIONS.reduce(function (chain, mu) {
      return chain.then(function () {
        return runCases(mu.m(S_SHIP)).then(function (rs) {
          var reds = rs.filter(function (r) { return !r.ok; });
          A.ok('CAUGHT: ' + mu.what, reds.length > 0, reds.length ? '' : 'mutation produced NO failing case - this control proves nothing');
        });
      });
    }, Promise.resolve());
  }).then(function () {
    A.finish();
  }).catch(function (err) {
    console.log('HARNESS ERROR: ' + (err && err.stack || err));
    process.exit(1);
  });
}

main();
