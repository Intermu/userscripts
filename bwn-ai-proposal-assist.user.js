// ==UserScript==
// @name         BWN AI Proposal Assist (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.4.0
// @description  Read-only helper around Umbrava's AI client-proposal generator. Opens from an "AI Proposal" row in the BWN Suite dock (bwn:dock:*, needs bwn-suite-core 1.94.5+) that appears only on a vendor proposal page and the AI preview Generate leads to - there is no floating button. Three opt-in sections, all OFF until switched on: (1) Pre-flight on a vendor proposal's details page reads the line grid by header text and flags line shapes the AI cannot fix later - travel/labor not named "N Man Travel" / "N Man", one line covering several trips, a single lumped Material line, equipment or removal filed under Material/Other, missing $0 Shipping and Disposal, blank Trip #, numeric UOM, vendor total over the client NTE - with a recommended-lines table; (2) a prompt builder that assembles the Generate prompt from form fields in a fixed order with a live 1,000-character hard stop, Copy and Insert (armed before the Generate modal opens, because the modal makes the rest of the page inert), and saved per-client templates; (3) a post-generate checker that passively reads the GenerateAIProposalPreview / ReworkAIProposal responses the app already receives and shows pass/fail (charge below cost, negative or >35% materials markup, travel quantity, non-rate-card ranges, total vs NTE, banned headings, verbatim lines, Materials/Equipment section) plus the server's validationErrors text when Generate fails. With "Work order context" on (0.3.0) it READS eight fixed, named Umbrava GraphQL queries (the work order, its client proposals, the latest client proposal's lines, the PO trips, the POs and their quotes to find this vendor quote by id, the client's active rate card, and the WO notes) through one guarded same-origin path, to add the client NTE, existing client proposals, the earlier split and each trip's Incurred/Proposed status; it never sends a mutation. 0.4.0 adds a rate-card check of the vendor quote lines and a "Draft with AI" button that hands the read facts to bwn-suite-ai 1.50.0+ over the page bus (task 'proposal', server-owned prompt) to write the issue line and per-trip steps, which you review before Copy/Insert. It never reads the app's request headers, never edits the grid, never clicks anything it did not create, never saves, submits or approves.
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-ai-proposal-assist.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-ai-proposal-assist.user.js
// @match        https://app.umbrava.com/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

// WHY @grant none + document-start: the checker has to see the SPA's own /api/graphql responses.
// With any GM_* grant Tampermonkey sandboxes the script and `window.fetch` is the sandbox's copy,
// so the app's calls go straight past the tap (bwn-kanban 0.3.0 shipped that bug). document-start
// puts the tap in place before the app can capture its own fetch reference. Persistence is
// therefore localStorage, which is fine: nothing stored here is a secret.
//
// READ-ONLY CONTRACT (pinned by scripts/test-ai-proposal-assist.js):
//   - the fetch/XHR taps only READ a clone of responses the app already asked for; the request is
//     passed through untouched and no header is ever read;
//   - the script issues no request of its own;
//   - the only write into the page is Insert, which fills the Generate prompt textarea on an
//     explicit click and never presses Generate.

(function () {
  'use strict';

  var VER = '0.4.0';   // keep in step with @version
  // Duplicate-init guard: @grant none shares the page window, so a second install (two copies, a
  // reinstall without reload) sees the first one's stamp and stands down instead of double-tapping.
  if (window.__bwnApaInit) { console.warn('[BWN APA] already initialised (v' + window.__bwnApaInit + ') - second copy inert'); return; }
  window.__bwnApaInit = VER;

  // ===== APA-LOGIC START (pure; sliced and run by scripts/test-ai-proposal-assist.js) =====
  var PROMPT_MAX = 1000;     // server limit on userPrompt; over it the UI shows only "Something went wrong"
  var PROMPT_WARN = 950;
  var MATERIAL_MARKUP_MAX = 35;
  var WATCH_OPS = { GenerateAIProposalPreview: 1, ReworkAIProposal: 1 };
  // {wo} is the WO number. The AI preview's id is NOT the vendor quoteId (the vendor quoteId in the
  // ai-preview URL shows "No data available", live 2026-10-06), so cross-page context keys on the WO.
  var RX_VP = /^\/work-orders\/([^/]+)\/proposals\/vendor-proposals\/([^/]+)\/details\/?$/;
  var RX_AI = /^\/work-orders\/([^/]+)\/proposals\/([^/]+)\/ai-preview\/?$/;
  // Deny-list first, allow-list second: anything account/admin/auth shaped is inert even if a
  // future route happened to match the allow patterns.
  var DENY = [/^\/(login|logout|callback|signup|account|settings|company|admin|billing|users?)(\/|$)/i, /permission/i];
  var NEEDED_HEADERS = ['category', 'item', 'trip #', 'uom', 'quantity', 'unit cost'];
  var DEFAULT_SCOPE_LINE = 'Pilot scope: plain technician text, no Problem/Solution/Work Summary headings.';

  function routeOf(path) {
    path = String(path || '');
    for (var i = 0; i < DENY.length; i++) if (DENY[i].test(path)) return null;
    var m = RX_VP.exec(path);
    if (m) return { kind: 'vp', wo: m[1], quoteId: m[2] };
    m = RX_AI.exec(path);
    if (m) return { kind: 'ai', wo: m[1], quoteId: m[2] };
    return null;
  }

  function esc(s) {
    return s == null ? '' : String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function norm(s) { return String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); }

  // "$1,234.56" / "(12.00)" / "-$5" -> integer cents, or null.
  function moneyToCents(s) {
    if (s == null) return null;
    var t = String(s).trim(), neg = /^\(.*\)$/.test(t) || /^-/.test(t);
    var m = t.replace(/[,$\s()]/g, '').replace(/^-/, '').match(/^\d+(?:\.\d+)?$/);
    if (!m) return null;
    var c = Math.round(parseFloat(m[0]) * 100);
    return neg ? -c : c;
  }

  // GraphQL money: {amount, precision} is amount / 10^precision dollars; a bare number is cents.
  function gqlCents(v) {
    if (v == null) return null;
    if (typeof v === 'number') return v;
    if (typeof v === 'object' && typeof v.amount === 'number') {
      var p = typeof v.precision === 'number' ? v.precision : 2;
      return Math.round(v.amount * 100 / Math.pow(10, p));
    }
    return null;
  }

  function fmt(c) { return c == null ? '-' : (c < 0 ? '-$' : '$') + (Math.abs(c) / 100).toFixed(2); }

  // headers: array of header strings in display order; cells: array of rows (arrays of strings).
  // Keyed by header TEXT, never by a fixed column index.
  function rowsFromGrid(headers, cells) {
    var idx = {};
    headers.forEach(function (h, i) { var k = norm(h).toLowerCase(); if (!(k in idx)) idx[k] = i; });
    for (var n = 0; n < NEEDED_HEADERS.length; n++) if (!(NEEDED_HEADERS[n] in idx)) return null;
    // Umbrava renders an empty Trip # / UOM as "--" (live, 2026-10-06).
    function get(r, k) { var v = k in idx ? norm(r[idx[k]]) : ''; return /^-+$/.test(v) ? '' : v; }
    return cells.map(function (r) {
      return {
        category: get(r, 'category'), trade: get(r, 'trade'), item: get(r, 'item'),
        trip: get(r, 'trip #'), uom: get(r, 'uom'), qty: parseFloat(get(r, 'quantity').replace(/,/g, '')),
        unitCost: moneyToCents(get(r, 'unit cost')), totalCost: moneyToCents(get(r, 'total cost'))
      };
    }).filter(function (r) { return r.item || r.category; });
  }

  // rows: every table row as an array of cell texts, colspans already expanded. The real
  // vendor grid has a group-header row (Details/Cost/Tax) ABOVE the column row and a blank row
  // below it (live, 2026-10-06), so the header row is found by content, and data is what follows.
  function gridFromRows(rows) {
    for (var h = 0; h < rows.length; h++) {
      var low = rows[h].map(function (c) { return norm(c).toLowerCase(); });
      if (NEEDED_HEADERS.every(function (n) { return low.indexOf(n) >= 0; })) return rowsFromGrid(rows[h], rows.slice(h + 1));
    }
    return null;
  }

  var RX_TRAVEL = /travel|trip charge|mileage/i;
  var RX_GENERIC_MAT = /^(materials?|parts?|supplies|misc\.?|miscellaneous)\b/i;
  var RX_EQUIP = /equipment|lift|rental|removal|remove|haul|demo/i;
  function isTravel(r) { return RX_TRAVEL.test(r.category) || RX_TRAVEL.test(r.item); }
  function isLabor(r) { return !isTravel(r) && (/labor|labour/i.test(r.category) || /\blabor\b|technician|\bhelper\b/i.test(r.item)); }
  function isMaterial(r) { return /material/i.test(r.category); }

  function distinctTrips(rows) {
    var s = {};
    rows.forEach(function (r) { if (/^\d+$/.test(r.trip)) s[r.trip] = 1; });
    return Object.keys(s).map(Number).sort(function (a, b) { return a - b; });
  }

  // -> [{level:'fail'|'warn'|'ok', msg}]
  function preflight(rows, nte, vendorTotal, poNte) {
    // A blank Item cell is real (live 2026-10-06): name the row by its category instead of printing "".
    function nm(r) { return r.item ? '"' + r.item + '"' :'(' + (r.category || 'row') + ' line, no item name)'; }
    var out = [];
    function f(level, msg) { out.push({ level: level, msg: msg }); }
    var trips = distinctTrips(rows), nTrips = Math.max(trips.length, 1);
    var travel = rows.filter(isTravel), labor = rows.filter(isLabor);
    // Real materials only: equipment filed under Material and the $0 Shipping/Disposal lines do not count.
    var mats = rows.filter(function (r) { return isMaterial(r) && !RX_EQUIP.test(r.item) && !/shipping|disposal/i.test(r.item); });

    travel.forEach(function (r) {
      if (!/^\d+\s*man travel$/i.test(r.item)) f('fail', 'Travel line ' + nm(r) + ' is not named "N Man Travel".');
      if (r.qty > 1) f('warn', 'Travel line ' + nm(r) + ' has quantity ' + r.qty + ' - one line per trip.');
    });
    if (travel.length && travel.length < nTrips) f('fail', travel.length + ' travel line(s) cover ' + nTrips + ' trips - one travel line per trip.');

    labor.forEach(function (r) {
      if (!/^\d+\s*man$/i.test(r.item)) f('fail', 'Labor line ' + nm(r) + ' is not named "N Man".');
      if (!/^(hr|hrs|hour|hours)$/i.test(r.uom)) f('fail', 'Labor line ' + nm(r) + ' UOM is "' + r.uom + '", not per hour.');
    });
    if (labor.length && labor.length < nTrips) f('fail', labor.length + ' labor line(s) cover ' + nTrips + ' trips - one labor line per trip.');

    if (mats.length === 1 && (RX_GENERIC_MAT.test(mats[0].item) || /^(lot|ls|lump sum)$/i.test(mats[0].uom)))
      f('fail', 'Single lumped Material line ' + nm(mats[0]) + ' - itemise each material.');

    rows.forEach(function (r) {
      if (/material|other/i.test(r.category) && RX_EQUIP.test(r.item))
        f('warn', '' + nm(r) + ' is filed under ' + r.category + ' - equipment/removal belongs in its own category.');
    });

    var ship = rows.some(function (r) { return /shipping/i.test(r.item); });
    var disp = rows.some(function (r) { return /disposal/i.test(r.item); });
    if (!ship) f('fail', 'No Shipping line - add a $0 Shipping line.');
    if (!disp) f('fail', 'No Disposal line - add a $0 Disposal line.');

    rows.forEach(function (r) {
      if (!r.trip) f('fail', '' + nm(r) + ' has a blank Trip #.');
      if (/^\d+(\.\d+)?$/.test(r.uom)) f('fail', '' + nm(r) + ' has a numeric UOM "' + r.uom + '".');
    });

    var total = vendorTotal;
    if (total == null) total = rows.reduce(function (s, r) { return s + (r.totalCost || 0); }, 0);
    if (nte == null) f('warn', 'Client NTE not found on the page - total not compared.');
    else if (total > nte) f('fail', 'Vendor total ' + fmt(total) + ' is ' + (nte > 0 ? (Math.round(total / nte * 10) / 10) + 'x ' : 'over ') + 'the client NTE ' + fmt(nte) +
      ' - needs an NTE increase before submitting. Keep "stay under NTE" out of the prompt: the AI may cut lines below cost to fit it.');
    else f('ok', 'Vendor total ' + fmt(total) + ' is within the client NTE ' + fmt(nte) + '.');
    if (poNte != null && total > poNte) f('warn', 'Vendor total ' + fmt(total) + ' is over the vendor PO NTE ' + fmt(poNte) + '.');

    if (!out.some(function (o) { return o.level === 'fail'; })) f('ok', 'No line-shape problems found.');
    return out;
  }

  // Guidance only - the shape the AI needs, built from what the vendor already entered.
  function recommendedLines(rows) {
    var trips = distinctTrips(rows);
    if (!trips.length) trips = [1];
    var men = 1;
    rows.forEach(function (r) { var m = /^(\d+)\s*man/i.exec(r.item); if (m) men = Math.max(men, +m[1]); });
    var out = [];
    trips.forEach(function (t) {
      out.push({ category: 'Travel', item: men + ' Man Travel', trip: t, uom: 'Trip', qty: 1 });
      var hrs = rows.filter(function (r) { return isLabor(r) && String(r.trip) === String(t); })
        .reduce(function (s, r) { return s + (r.qty || 0); }, 0);
      out.push({ category: 'Labor', item: men + ' Man', trip: t, uom: 'Hr', qty: hrs || '' });
    });
    var t0 = trips[trips.length - 1];
    rows.forEach(function (r) {
      if (isTravel(r) || isLabor(r) || /shipping|disposal/i.test(r.item)) return;
      var cat = RX_EQUIP.test(r.item) && /material|other/i.test(r.category) ? 'Equipment' : r.category;
      out.push({ category: cat, item: r.item, trip: r.trip || t0, uom: /^\d/.test(r.uom) ? 'Each' : r.uom, qty: r.qty });
    });
    out.push({ category: 'Material', item: 'Shipping', trip: t0, uom: 'Each', qty: 1, note: '$0' });
    out.push({ category: 'Other', item: 'Disposal', trip: t0, uom: 'Each', qty: 1, note: '$0' });
    return out;
  }

  // "Item name: 50-120" / "Item: $50 - $120" -> [{name, min, max}] in cents.
  function parseRanges(text) {
    var out = [];
    String(text || '').split(/\n/).forEach(function (line) {
      var m = /^\s*(.+?)\s*:\s*\$?([\d,]+(?:\.\d+)?)\s*-\s*\$?([\d,]+(?:\.\d+)?)\s*$/.exec(line);
      if (m) out.push({ name: m[1], min: moneyToCents(m[2]), max: moneyToCents(m[3]) });
    });
    return out;
  }

  function lines(text) { return String(text || '').split(/\n/).map(norm).filter(Boolean); }

  // f: {pricingRules, ranges, scopeLine, issue, verbatim, materials, trip1Status, trip1, trip2}
  function buildPrompt(f) {
    var p = [];
    if (norm(f.pricingRules)) p.push(norm(f.pricingRules));
    var rg = parseRanges(f.ranges);
    if (rg.length) p.push('Non-rate-card ranges: ' + rg.map(function (r) { return r.name + ' ' + fmt(r.min) + '-' + fmt(r.max); }).join('; ') + '.');
    p.push(norm(f.scopeLine) || DEFAULT_SCOPE_LINE);
    p.push('1. ' + norm(f.issue));
    var vb = lines(f.verbatim);
    if (vb.length) p.push('2. Include verbatim: ' + vb.map(function (v) { return '"' + v + '"'; }).join(' '));
    var mats = lines(String(f.materials || '').replace(/,/g, '\n'))
      .filter(function (m) { return !/^(shipping|disposal)$/i.test(m); });
    p.push('3. "Materials/Equipment:" ' + mats.concat(['Shipping', 'Disposal']).join(', ') + '.');
    // One line per trip from item 4 on. The label is quoted, the format that kept the AI from
    // dropping sections in the field-tested prompt (2026-10-06).
    lines(f.trips).forEach(function (t, i) {
      var m = /^(Trip[^:]*):\s*(.*)$/.exec(t);
      if (m && !m[2]) return;   // a prefilled label nobody filled in
      p.push((4 + i) + '. ' + (m ? '"' + m[1] + '": ' + m[2] : t));
    });
    p.push('Bullets under 12 words.');
    return p.join('\n');
  }

  function promptState(text) {
    var n = text.length;
    return { n: n, over: n > PROMPT_MAX, warn: n >= PROMPT_WARN && n <= PROMPT_MAX };
  }

  // GraphQL op name from a request body string, or null.
  function opNameOf(body) {
    if (typeof body !== 'string' || body.indexOf('AIProposal') < 0) return null;
    try {
      var j = JSON.parse(body);
      var name = j && (j.operationName || (/(?:query|mutation)\s+(\w+)/.exec(j.query || '') || [])[1]);
      return name && WATCH_OPS[name] ? name : null;
    } catch (e) { return null; }
  }

  // Every human-readable error string in a GraphQL response: errors[].message plus any
  // validationErrors array found anywhere (strings or {message|errorMessage|propertyName}).
  function errorsOf(json) {
    var out = [];
    (json && json.errors || []).forEach(function (e) { if (e && e.message) out.push(String(e.message)); });
    (function walk(o, d) {
      if (!o || typeof o !== 'object' || d > 6) return;
      Object.keys(o).forEach(function (k) {
        var v = o[k];
        if (/^validationErrors$/i.test(k) && Array.isArray(v)) {
          v.forEach(function (x) {
            if (typeof x === 'string') out.push(x);
            else if (x) out.push(norm((x.propertyName ? x.propertyName + ': ' : '') + (x.message || x.errorMessage || JSON.stringify(x))));
          });
        } else walk(v, d + 1);
      });
    })(json, 0);
    var payload = payloadOf(json);
    if (payload && payload.success === false && payload.message) out.push(String(payload.message));
    return out.filter(function (s, i) { return out.indexOf(s) === i; });
  }

  // data.<firstField> - the field name is not hard-coded (inferred, see discovery notes).
  function payloadOf(json) {
    var d = json && json.data;
    if (!d || typeof d !== 'object') return null;
    // Live 2026-10-06: data.__typename is the FIRST key, so skip it.
    var k = Object.keys(d).filter(function (x) { return x !== '__typename'; })[0];
    return k ? d[k] : null;
  }

  // markUpPercent / chargeQuantity / estimatedGrossProfitPercent arrive as decimal STRINGS (live 2026-10-06).
  function num(v) { return v == null || v === '' ? null : Number(v); }

  // ctx: {nte (cents|null), ranges:[{name,min,max}], verbatim:[str], trips (int|null)}
  // -> [{level:'pass'|'fail'|'warn', msg}]
  function checkPreview(pv, ctx) {
    var out = [];
    function r(level, msg) { out.push({ level: level, msg: msg }); }
    var items = (pv && pv.lineItems) || [];
    var scope = String((pv && pv.scopeOfWork) || '');

    var below = items.filter(function (li) {
      var c = gqlCents(li.unitCost), ch = gqlCents(li.unitCharge);
      return c != null && ch != null && ch < c;
    });
    if (below.length) below.forEach(function (li) { r('fail', '"' + li.item + '" charges ' + fmt(gqlCents(li.unitCharge)) + ', below cost ' + fmt(gqlCents(li.unitCost)) + '.'); });
    else r('pass', 'No line charges below cost.');

    var neg = items.filter(function (li) { return num(li.markUpPercent) < 0; });
    neg.forEach(function (li) { r('fail', '"' + li.item + '" has negative markup ' + li.markUpPercent + '%.'); });

    var travel = items.filter(function (li) { return RX_TRAVEL.test(li.item || '') || RX_TRAVEL.test(li.categoryName || ''); });
    if (travel.length) {
      var q = travel.reduce(function (s, li) { return s + (num(li.chargeQuantity) || 0); }, 0);
      var want = ctx.trips || travel.length;
      if (q !== want) r('fail', 'Travel charge quantity totals ' + q + ' for ' + want + ' trip(s) / ' + travel.length + ' travel line(s).');
      else r('pass', 'Travel charge quantity matches ' + want + ' trip(s).');
    }

    var hi = items.filter(function (li) { return /material/i.test(li.categoryName || '') && num(li.markUpPercent) > MATERIAL_MARKUP_MAX; });
    if (hi.length) hi.forEach(function (li) { r('fail', 'Material "' + li.item + '" markup ' + li.markUpPercent + '% is over ' + MATERIAL_MARKUP_MAX + '%.'); });
    else r('pass', 'Materials markup within ' + MATERIAL_MARKUP_MAX + '%.');

    items.filter(function (li) { return li.rateId == null; }).forEach(function (li) {
      var name = String(li.item || '').toLowerCase();
      var rg = (ctx.ranges || []).filter(function (x) { var n = x.name.toLowerCase(); return name.indexOf(n) >= 0 || n.indexOf(name) >= 0; })[0];
      var ch = gqlCents(li.unitCharge);
      if (!rg) r('warn', 'Non-rate-card line "' + li.item + '" has no range set.');
      else if (ch == null || ch < rg.min || ch > rg.max) r('fail', 'Non-rate-card "' + li.item + '" at ' + fmt(ch) + ' is outside ' + fmt(rg.min) + '-' + fmt(rg.max) + '.');
      else r('pass', 'Non-rate-card "' + li.item + '" within range.');
    });

    var total = gqlCents(pv && pv.estimatedTotal);
    if (ctx.nte == null) r('warn', 'Client NTE not known - total not compared.');
    else if (total != null && total > ctx.nte) r('fail', 'Estimated total ' + fmt(total) + ' is over NTE ' + fmt(ctx.nte) + '.');
    else r('pass', 'Estimated total ' + fmt(total) + ' within NTE ' + fmt(ctx.nte) + '.');

    if (/the problem|the solution/i.test(scope)) r('fail', 'Scope contains "The Problem" / "The Solution" headings.');
    else r('pass', 'No Problem/Solution headings.');

    var ns = norm(scope).toLowerCase();
    (ctx.verbatim || []).forEach(function (v) {
      if (ns.indexOf(norm(v).toLowerCase()) >= 0) r('pass', 'Verbatim line present: "' + v + '".');
      else r('fail', 'Verbatim line missing: "' + v + '".');
    });

    if (/materials\s*\/\s*equipment/i.test(scope)) r('pass', 'Materials/Equipment section present.');
    else r('fail', 'Materials/Equipment section missing.');
    return out;
  }

  // Passive response tap. Calls onResp(opName, json) for watched ops; the request is passed
  // through untouched, the app gets the ORIGINAL response, and no header is read.
  function installTap(win, onResp) {
    var of = win.fetch;
    if (typeof of === 'function') {
      win.fetch = function (input, init) {
        var p = of.apply(this, arguments);
        try {
          var url = typeof input === 'string' ? input : (input && input.url) || '';
          var op = /\/api\/graphql/.test(url) ? opNameOf(init && init.body) : null;
          if (op) p.then(function (res) {
            try { res.clone().json().then(function (j) { onResp(op, j); }, function () { }); } catch (e) { }
          }, function () { });
        } catch (e) { /* never break the app's own request */ }
        return p;
      };
    }
    var X = win.XMLHttpRequest && win.XMLHttpRequest.prototype;
    if (X) {
      var oOpen = X.open, oSend = X.send;
      X.open = function (m, u) { this.__bwnApaUrl = u; return oOpen.apply(this, arguments); };
      X.send = function (b) {
        try {
          var op = /\/api\/graphql/.test(this.__bwnApaUrl || '') ? opNameOf(b) : null;
          if (op) this.addEventListener('load', function () {
            try { onResp(op, JSON.parse(this.responseText)); } catch (e) { }
          });
        } catch (e) { }
        return oSend.apply(this, arguments);
      };
    }
  }
  // ---- work-order context (0.3.0): pure shaping of the four read results ----
  // Cost category enum, the complete live list (from bwn-proposal-pricing CAT_LABEL).
  var CAT_LABEL = { 0: 'Labor', 1: 'Material', 2: 'Equipment', 3: 'Recycling', 4: 'Travel', 5: 'Management Fee', 6: 'Shipping', 7: 'Other', 8: 'Tax',
    9: 'Regular Rate', 10: 'Overtime Rate', 11: 'Premium Rate', 12: 'Emergency Rate', 13: 'Labor And Material', 14: 'Adjustment', 15: 'Discount', 16: 'Credit/Debit', 17: 'Permit' };

  // Client proposal status from its dates (same order as bwn-proposal-actions proposalRow).
  function propStatus(p) { return p.canceledDate ? 'Canceled' : p.rejectedDate ? 'Rejected' : p.approvedDate ? 'Approved' : p.submittedDate ? 'Submitted' : 'Draft'; }

  // purchaseOrderTrips -> [{n, status}] by trip number; a completed trip is Incurred, an open one
  // Proposed, a canceled one dropped. Any PO completing trip N makes N Incurred.
  function tripStatuses(pots) {
    var by = {};
    (pots || []).forEach(function (po) {
      (po.trips || []).forEach(function (t) {
        if (!t || t.canceledDate || t.number == null) return;
        if (by[t.number] !== 'Incurred') by[t.number] = t.completedDate ? 'Incurred' : 'Proposed';
      });
    });
    return Object.keys(by).map(Number).sort(function (a, b) { return a - b; }).map(function (n) { return { n: n, status: by[n] }; });
  }
  // Trip plan = the earlier client proposal's tripLabels ("1", "2", "3/4": the numbering and grouping
  // the coordinator already used) + the PO trips (the only record of what was DONE). A trip a PO
  // completed is Incurred; one only the proposal names is Proposed, flagged assumed. -> [{label, status, assumed}]
  function tripPlan(pots, priorLines) {
    var known = {}, groups = [], seen = {};
    tripStatuses(pots).forEach(function (t) { known[t.n] = t.status; });
    (priorLines || []).forEach(function (li) {
      var nums = (String(li.tripLabel || '').match(/\d+/g) || []).map(Number);
      var key = nums.join('/');
      if (!nums.length || seen[key]) return;
      seen[key] = 1;
      groups.push(nums);
    });
    Object.keys(known).map(Number).forEach(function (n) {
      if (!groups.some(function (g) { return g.indexOf(n) >= 0; })) groups.push([n]);
    });
    return groups.sort(function (a, b) { return a[0] - b[0]; }).map(function (g) {
      var all = g.every(function (n) { return known[n] === 'Incurred'; });
      return { label: 'Trip ' + (g.length > 1 ? g[0] + '-' + g[g.length - 1] : g[0]), status: all ? 'Incurred' : 'Proposed',
        assumed: !all && g.some(function (n) { return !(n in known); }) };
    });
  }
  function tripPrefill(plan) { return plan.map(function (t) { return t.label + ' (' + t.status + '): '; }).join('\n'); }

  // A client proposal line as "item $total" (chargeQuantity is a decimal STRING).
  function lineSummary(li) {
    var name = li.item || CAT_LABEL[li.category] || 'Line';
    var c = gqlCents(li.unitCharge), q = num(li.chargeQuantity);
    return name + (c != null ? ' ' + fmt(Math.round(c * (q == null ? 1 : q))) : '');
  }

  // cx: {proposals:[{number,status,total,gp,submitted}], prior:{number, lines}|null}; rows: the vendor
  // grid (or null). The NTE comparison lives in preflight(), fed the read NTE. -> [{level,msg}]
  function contextFindings(cx, rows) {
    var out = [];
    function f(level, msg) { out.push({ level: level, msg: msg }); }
    (cx.proposals || []).filter(function (p) { return p.status !== 'Canceled' && p.status !== 'Rejected'; }).forEach(function (p) {
      f('warn', 'Client proposal #' + p.number + ' already exists (' + fmt(p.total) + ', ' + p.status + (p.submitted ? ' ' + String(p.submitted).slice(0, 10) : '') +
        (p.gp != null ? ', ' + (Math.round(p.gp * 1000) / 10) + '% GP' : '') + ') - confirm whether this one replaces it before you send anything.');
    });
    var lumped = rows && (rows.length === 1 || rows.some(function (r) { return /labor and material/i.test(r.category); }));
    if (lumped && cx.prior && cx.prior.lines.length > 1)
      f('warn', 'Lumped vendor line. The earlier client proposal #' + cx.prior.number + ' priced it as: ' + cx.prior.lines.map(lineSummary).join('; ') +
        '. That split is an inference - confirm it with the vendor before Generate.');
    return out;
  }

  // Vendor quote lines vs the CLIENT rate card (listClientRates). Same category id; a location-specific
  // rate beats a general one; item matched by normalised name, exact first, then containment.
  // -> [{item, category, cost, rate, level, msg}] (cents). The rate card overrides prompt guardrails,
  // so a rate below vendor cost prices the line under water whatever the prompt says.
  function normItem(x) { return String(x || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function rateCheck(qLines, rates, locationId) {
    return (qLines || []).map(function (l) {
      var cat = l.categoryObject || {}, name = normItem(l.item), cost = gqlCents(l.unitCost);
      var pool = (rates || []).filter(function (r) {
        return r.categoryObject && r.categoryObject.id === cat.id && (r.locationId == null || r.locationId === locationId);
      }).sort(function (a, b) { return (b.locationId === locationId) - (a.locationId === locationId); });
      var hit = name && (pool.filter(function (r) { return normItem(r.item) === name; })[0] ||
        pool.filter(function (r) { var n = normItem(r.item); return n && (n.indexOf(name) >= 0 || name.indexOf(n) >= 0); })[0]);
      var label = (l.item || '(no item name)') + ' [' + (cat.name || 'category ' + l.category) + ']';
      var o = { item: l.item, category: cat.name, cost: cost, rate: hit ? gqlCents(hit.unitCost) : null };
      if (!hit) { o.level = 'warn'; o.msg = label + ': no client rate card match - the AI will mark it up toward the GP target instead of a contract rate.'; }
      else if (cost != null && o.rate != null && o.rate < cost) { o.level = 'fail'; o.msg = label + ': client rate ' + fmt(o.rate) + ' is below vendor cost ' + fmt(cost) + ' - this line will price under water; the rate card overrides the prompt.'; }
      else { o.level = 'pass'; o.msg = label + ': client rate ' + fmt(o.rate) + (cost != null ? ' vs vendor cost ' + fmt(cost) : '') + '.'; }
      return o;
    });
  }

  // The server's draft is a JSON object; tolerate a code fence or prose around it. -> {issue, trips[]} | null
  function parseDraft(text) {
    var m = /\{[\s\S]*\}/.exec(String(text || ''));
    if (!m) return null;
    try {
      var j = JSON.parse(m[0]);
      if (!j || typeof j !== 'object') return null;
      var trips = Array.isArray(j.trips) ? j.trips.filter(function (t) { return t && t.label && t.steps; }) : [];
      return { issue: norm(j.issue), trips: trips.map(function (t) { return norm(t.label) + ' (' + norm(t.status || 'Proposed') + '): ' + norm(t.steps); }) };
    } catch (e) { return null; }
  }

  // Notes for the AI: newest first, text only, capped (notes carry the tech's own trip narrative).
  function notesForAi(notes) {
    return (notes || []).filter(function (n) { return n && n.content; })
      .sort(function (a, b) { return String(b.createdDate).localeCompare(String(a.createdDate)); }).slice(0, 15)
      .map(function (n) { return { date: String(n.createdDate || '').slice(0, 10), text: norm(String(n.content).replace(/<[^>]*>/g, ' ')).slice(0, 300) }; });
  }

  // First sentence of the WO scope, for the builder's issue line.
  function firstSentence(t) { var m = /^[\s\S]*?[.!?](\s|$)/.exec(norm(t)); return (m ? m[0] : norm(t)).trim().slice(0, 160); }
  // ===== APA-LOGIC END =====

  // ---- read-only Umbrava reads (0.3.0) ----------------------------------------------------------
  // Four FIXED, named queries, all copied from proven suite reads (WorkOrderHeader/ProposalWO,
  // PA_Siblings, ClientProposalDetails, POTripsNoShow). apaGql is the ONLY request this script sends:
  // it refuses any op not in QUERIES, any document that is not one named `query`, and any origin
  // but Umbrava's. The token comes from the suite's shared picker, is used for the one call, and is
  // never stored. Names are APA_-prefixed and carry no page/skip/take VARIABLES, so Core's List Heat
  // never mistakes one for the board query.
  // ===== BWN-SHARED START v1 (paste-identical; pinned by scripts/test-shared-block-ledger.js) =====
  function isUmbravaToken(tok) {
    try {
      var p = JSON.parse(atob(String(tok).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
      var iss = String(p.iss || '').replace(/\/+$/, '');
      if (iss !== 'https://login.umbrava.com' && iss !== 'https://umbrava.us.auth0.com') return false;
      return !(typeof p.exp === 'number' && (Date.now() / 1000) > p.exp);
    } catch (e) { return false; }
  }
  function authToken() {
    try {
      var keys = Object.keys(localStorage).filter(function (x) {
        return /@@auth0spajs@@::.*::https:\/\/app\.umbrava\.com\/api::/.test(x);
      });
      for (var i = 0; i < keys.length; i++) {
        var body = (JSON.parse(localStorage.getItem(keys[i])) || {}).body;
        var tok = (body && body.access_token) || '';
        if (tok && isUmbravaToken(tok)) return tok;
      }
      return '';
    } catch (e) { return ''; }
  }
  // ===== BWN-SHARED END v1 =====

  var QUERIES = Object.freeze({
    APA_WorkOrder: 'query APA_WorkOrder($n: Int!) { workOrder(workOrderNumber: $n) { id number clientId locationId clientName locationName locationNumber address { city state } priority { label } doNotExceed { amount precision } totalNTE { amount precision } scopeOfWork statusName } }',
    APA_ClientProposals: 'query APA_ClientProposals($j: Int!) { listClientProposals(jobId: $j, page: { skip: 0, take: 50 }, sortBy: [{ columnName: "id", direction: DESC }]) { items { id number created submittedDate approvedDate rejectedDate canceledDate total { amount precision } grossProfitPercent } } }',
    APA_ClientProposal: 'query APA_ClientProposal($p: Int!) { proposal(id: $p) { id number scopeOfWork proposalLineItems { category tripLabel item quantity chargeQuantity unitOfMeasurement markUpPercent rateId unitCost { amount precision } unitCharge { amount precision } } } }',
    APA_Trips: 'query APA_Trips($j: Int!) { purchaseOrderTrips(jobId: $j) { number vendorName trips { number completedDate canceledDate status } } }',
    // Quote by id = this WO's POs, then their quotes, filtered to the route's quoteId (PosForPricing + QuotesForPricing).
    APA_POs: 'query APA_POs($n: Int) { purchaseOrders(workOrderNumber: $n) { id number vendorName } }',
    APA_Quotes: 'query APA_Quotes($ids: [Int!]) { quotes(purchaseOrderIds: $ids, includeLineItems: true) { id number vendorName purchaseOrderId aggregateRateDiscrepancy scopeOfWork total { amount precision } quoteLineItems { id category item quantity unitOfMeasurement rateId rateDiscrepancy categoryObject { id name } unitCost { amount precision } totalCost { amount precision } } } }',
    // Client rate card (ListClientRatesForPricing); sortBy is required server-side, inlined so no paging VARIABLES.
    APA_ClientRates: 'query APA_ClientRates($t: ID!) { listClientRates(targetTenantId: $t, page: { skip: 0, take: 200 }, sortBy: [{ columnName: "category", direction: ASC }], isActive: true) { items { id category item unitOfMeasurement locationId categoryObject { id name } unitCost { amount precision } } } }',
    APA_Notes: 'query APA_Notes($n: Int!) { workOrderNotes(workOrderNumber: $n, includeDeleted: false) { id content createdDate } }'
  });
  function checkDocument(op, doc) {
    if (!Object.prototype.hasOwnProperty.call(QUERIES, op)) throw new Error('blocked: ' + op);
    if ((String(doc).match(/(^|\})\s*(query|mutation|subscription|fragment)\b/g) || []).length !== 1) throw new Error('blocked: one operation only');
    if (doc.indexOf('query ' + op + '(') !== 0 || /\b(mutation|subscription)\b/i.test(doc)) throw new Error('blocked: read-only query only');
  }
  Object.keys(QUERIES).forEach(function (op) { checkDocument(op, QUERIES[op]); });   // fail closed at load

  // The single request path. Nothing else in this file sends anything.
  function apaGql(op, variables) {
    try {
      checkDocument(op, QUERIES[op]);
      if (location.origin !== 'https://app.umbrava.com') throw new Error('blocked: wrong origin');
    } catch (e) { return Promise.reject(e); }
    var tok = authToken();
    if (!tok) return Promise.reject(new Error('not signed in'));
    var req = fetch('/api/graphql', {
      method: 'POST', credentials: 'same-origin', cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + tok },
      body: JSON.stringify({ operationName: op, query: QUERIES[op], variables: variables })
    });
    tok = null;
    return req.then(function (r) {
      return r.json().catch(function () { return null; }).then(function (j) {
        if (!j || !j.data || (j.errors && j.errors.length)) throw new Error((j && j.errors && j.errors[0] && j.errors[0].message) || ('HTTP ' + r.status));
        return j.data;
      });
    });
  }

  // Per-WO context, read once per page per WO (Reload re-reads). Each part keeps its own error so a
  // failed read is shown as failed - never as "this WO has none" (the suite-ai trips bug, 2026-08-06).
  var wctx = null;
  function loadContext(rt) {
    var me = wctx = { wo: rt.wo, state: 'loading', wo_: null, proposals: null, prior: null, trips: null, quote: null, rates: null, notes: null, errs: {} };
    function done() { if (wctx === me) { me.state = 'done'; logAction('context read'); onContext(); render(); } }
    function fail(part) { return function (e) { me.errs[part] = String((e && e.message) || e).slice(0, 120); }; }
    apaGql('APA_WorkOrder', { n: Number(rt.wo) }).then(function (d) {
      me.wo_ = d.workOrder; if (!me.wo_) throw new Error('work order not found');
      var j = me.wo_.id;
      return Promise.all([
        apaGql('APA_ClientProposals', { j: j }).then(function (d2) {
          me.proposals = ((d2.listClientProposals && d2.listClientProposals.items) || []).map(function (p) {
            return { id: p.id, number: p.number, status: propStatus(p), total: gqlCents(p.total), gp: num(p.grossProfitPercent), submitted: p.submittedDate };
          });
          // The split comes from the latest SENT proposal; an unsent draft (possibly an AI test) only as a fallback.
          var live = me.proposals.filter(function (p) { return p.status === 'Submitted' || p.status === 'Approved'; })[0] ||
            me.proposals.filter(function (p) { return p.status !== 'Canceled' && p.status !== 'Rejected'; })[0];
          return live && apaGql('APA_ClientProposal', { p: live.id }).then(function (d3) {
            me.prior = { number: live.number, scope: (d3.proposal && d3.proposal.scopeOfWork) || '', lines: (d3.proposal && d3.proposal.proposalLineItems) || [] };
          }, fail('prior'));
        }, fail('proposals')),
        apaGql('APA_Trips', { j: j }).then(function (d4) { me.trips = d4.purchaseOrderTrips || []; }, fail('trips')),
        apaGql('APA_POs', { n: Number(rt.wo) }).then(function (d5) {
          var ids = (d5.purchaseOrders || []).map(function (p) { return Number(p.id); });
          if (!ids.length) throw new Error('no POs on this WO');
          return apaGql('APA_Quotes', { ids: ids }).then(function (d6) {
            me.quote = (d6.quotes || []).filter(function (q) { return String(q.id) === String(rt.quoteId); })[0] || null;
            if (!me.quote) throw new Error('quote ' + rt.quoteId + ' not found on this WO\'s POs');
          });
        }).catch(fail('quote')),
        me.wo_.clientId ? apaGql('APA_ClientRates', { t: me.wo_.clientId }).then(function (d7) { me.rates = (d7.listClientRates && d7.listClientRates.items) || []; }, fail('rates'))
          : Promise.resolve(fail('rates')(new Error('no clientId on the work order'))),
        apaGql('APA_Notes', { n: Number(rt.wo) }).then(function (d8) { me.notes = d8.workOrderNotes || []; }, fail('notes'))
      ]);
    }, fail('workOrder')).then(done, done);
  }
  function ctxFacts() {
    if (!wctx || wctx.state !== 'done' || !wctx.wo_) return null;
    return { nte: gqlCents(wctx.wo_.doNotExceed), proposals: wctx.proposals || [], prior: wctx.prior };
  }
  function ctxNte() { var c = ctxFacts(); return c ? c.nte : null; }
  // When the reads land, fill only the builder fields the user has left empty.
  function onContext() {
    if (!form || !wctx || !wctx.wo_ || form.wo !== wctx.wo) return;
    if (!norm(form.issue) && wctx.wo_.scopeOfWork) form.issue = firstSentence(wctx.wo_.scopeOfWork);
    if (!norm(form.trips) && (wctx.trips || wctx.prior)) form.trips = tripPrefill(tripPlan(wctx.trips, wctx.prior && wctx.prior.lines));
    if (wctx.prior) {
      var have = lines(form.materials).map(function (m) { return m.toLowerCase(); });
      wctx.prior.lines.filter(function (li) { return (li.category === 1 || li.category === 2) && li.item && have.indexOf(li.item.toLowerCase()) < 0; })
        .forEach(function (li) { form.materials = (norm(form.materials) ? form.materials + '\n' : '') + li.item; have.push(li.item.toLowerCase()); });
    }
  }

  // ---- AI draft (0.4.0): facts out over the page bus to bwn-suite-ai, JSON draft back ---------------
  // Only on a click. Sends the read facts (no prices) for task 'proposal'; fills the issue line and the
  // trip lines for the user to review. Overwrites those two fields only, and says so.
  var aiBusy = false, aiMsg = '';
  function aiFacts() {
    var w = wctx && wctx.wo_, q = wctx && wctx.quote, rows = routeOf(location.pathname) && readGrid();
    return {
      woScope: w ? norm(w.scopeOfWork).slice(0, 1500) : '',
      vendorScope: q ? norm(q.scopeOfWork).slice(0, 1500) : '',
      priorProposalScope: wctx && wctx.prior ? norm(String(wctx.prior.scope).replace(/<[^>]*>/g, ' ')).slice(0, 2000) : '',
      priorLines: wctx && wctx.prior ? wctx.prior.lines.map(function (li) { return { trip: li.tripLabel, category: CAT_LABEL[li.category] || li.category, item: li.item }; }) : [],
      trips: wctx ? tripPlan(wctx.trips, wctx.prior && wctx.prior.lines).map(function (t) { return { label: t.label, status: t.status }; }) : [],
      vendorLines: (rows || []).map(function (r) { return { category: r.category, item: r.item, trip: r.trip }; }),
      notes: notesForAi(wctx && wctx.notes)
    };
  }
  function aiDraft() {
    if (aiBusy || !form) return;
    if (!on('context') || !wctx || wctx.state !== 'done') { aiMsg = 'Turn on Work order context and let it load first - the draft is written from those facts.'; render(); return; }
    var rid = 'apa' + Date.now() + Math.random().toString(36).slice(2), timer = null;
    aiBusy = true; aiMsg = ''; logAction('ai draft requested'); render();
    function finish(msg) { document.removeEventListener('bwn:evt', onEvt); clearTimeout(timer); aiBusy = false; aiMsg = msg; render(); }
    function onEvt(e) {
      var d = e && e.detail;
      if (!d || d.id !== 'ai:apaDrafted' || d.rid !== rid) return;
      var dr = parseDraft(d.text);
      if (!dr || (!dr.issue && !dr.trips.length)) { finish(d.text ? 'The AI reply could not be read - nothing was changed.' : 'The AI returned nothing (no AI key in BWN Suite AI, rank not allowed, or the service failed) - nothing was changed.'); return; }
      if (dr.issue) form.issue = dr.issue;
      if (dr.trips.length) form.trips = dr.trips.join('\n');
      logAction('ai draft filled');
      finish('AI draft filled the issue line and trip steps - check every step against what actually happened before you Insert.');
    }
    document.addEventListener('bwn:evt', onEvt);
    timer = setTimeout(function () { finish('No answer from BWN Suite AI - it needs bwn-suite-ai 1.50.0+ installed with its AI key set.'); }, 50000);
    try { document.dispatchEvent(new CustomEvent('bwn:cmd', { detail: { id: 'ai:apaDraft', rid: rid, facts: aiFacts() } })); }
    catch (e) { finish('Could not reach BWN Suite AI.'); }
  }

  // ---- storage (localStorage: @grant none) ----------------------------------------------------
  var LS_SET = 'bwn:apa:settings', LS_TPL = 'bwn:apa:templates', LS_LOG = 'bwn:apa:log', SS_CTX = 'bwn:apa:ctx:';
  function lsGet(k, d, store) { try { var v = (store || localStorage).getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } }
  function lsSet(k, v, store) { try { (store || localStorage).setItem(k, JSON.stringify(v)); } catch (e) { /* storage denied */ } }

  var settings = lsGet(LS_SET, {});   // {preflight, builder, checker, open} - all absent = OFF
  function on(k) { return settings[k] === true; }

  // Activity log: action label + timestamp ONLY - never record content, amounts or ids.
  function logAction(label) {
    var l = lsGet(LS_LOG, []);
    l.unshift({ a: label, t: new Date().toISOString() });
    lsSet(LS_LOG, l.slice(0, 50));
  }

  var SEED_TEMPLATES = [
    { name: 'Pilot Travel Centers', pricingRules: '33% GP target. Materials markup max 35%. No line below cost. Do not change unit costs.', ranges: '', scopeLine: DEFAULT_SCOPE_LINE, verbatim: '' },
    { name: 'Generic', pricingRules: 'Materials markup max 35%. No line below cost. Do not change unit costs.', ranges: '', scopeLine: 'Scope: plain technician text, no Problem/Solution/Work Summary headings.', verbatim: '' }
  ];
  function templates() {
    var t = lsGet(LS_TPL, null);
    if (!Array.isArray(t) || !t.length) t = SEED_TEMPLATES.slice();
    // Pilot Travel Centers always first.
    t.sort(function (a, b) { return (b.name === 'Pilot Travel Centers') - (a.name === 'Pilot Travel Centers'); });
    return t;
  }

  // Per-WO context carried from the vendor-proposal page to the AI preview page (same tab).
  // Item names + trip count + NTE only; sessionStorage so it dies with the tab.
  function ctxGet(q) { return lsGet(SS_CTX + q, {}, sessionStorage); }
  function ctxSet(q, v) { lsSet(SS_CTX + q, v, sessionStorage); }

  // ---- tap: installed now (document-start), acts only when the checker is on + AI route --------
  var lastCheck = null;
  try {
    installTap(window, function (op, json) {
      var rt = routeOf(location.pathname);
      if (!on('checker') || !rt) return;   // Generate fires from the vendor proposal modal
      logAction('checker: ' + op + ' response read');
      lastCheck = { op: op, json: json, wo: rt.wo };
      var cr = checkResult(rt);
      dockBadge(cr.res ? String(cr.res.filter(function (o) { return o.level === 'fail'; }).length || '✓') : '!');
      render();
    });
  } catch (e) { console.warn('[BWN APA] response tap failed to install:', e); }

  // ---- DOM readers --------------------------------------------------------------------------
  var PANEL_ID = 'bwn-apa';
  function panelEl() { return document.getElementById(PANEL_ID); }
  function inPanel(n) { var p = panelEl(); return !!(p && n && p.contains(n)); }
  function txt(el) { return norm(el && (el.innerText || el.textContent)); }

  // Line grid: any table/grid whose header cells (by TEXT) include every needed header.
  function readGrid() {
    var boxes = document.querySelectorAll('table, [role="grid"], [role="table"], [role="treegrid"]');
    for (var i = 0; i < boxes.length; i++) {
      var box = boxes[i];
      if (inPanel(box)) continue;
      var rows = Array.prototype.map.call(box.querySelectorAll('tr, [role="row"]'), function (tr) {
        var out = [];
        Array.prototype.forEach.call(tr.children, function (c) {
          for (var s = 0; s < (c.colSpan || 1); s++) out.push(s ? '' : txt(c));
        });
        return out;
      });
      var g = gridFromRows(rows);
      if (g) return g;
    }
    return null;
  }

  // WO header strip value: first $ amount next to a label text node ("Client DNE", "Total Vendor Cost").
  function stripMoney(labelRx) {
    if (!document.body) return null;
    var w = document.createTreeWalker(document.body, 4 /* NodeFilter.SHOW_TEXT */), n;
    while ((n = w.nextNode())) {
      if (inPanel(n) || !labelRx.test(norm(n.nodeValue))) continue;
      var el = n.parentElement;
      for (var i = 0; i < 3 && el; i++, el = el.parentElement) {
        var m = (el.textContent || '').replace(n.nodeValue, '').match(/-?\$\s?[\d,]+(?:\.\d{1,2})?/);
        if (m) return moneyToCents(m[0].replace(/\s/g, ''));
      }
    }
    return null;
  }
  // A form field's value by its <label> text. On the WO page Client DNE is an input (live, 2026-10-06).
  function labeledMoney(labelRx) {
    var ls = document.querySelectorAll('label');
    for (var i = 0; i < ls.length; i++) {
      if (inPanel(ls[i]) || !labelRx.test(txt(ls[i]))) continue;
      var inp = ls[i].htmlFor ? document.getElementById(ls[i].htmlFor) : ls[i].parentElement && ls[i].parentElement.querySelector('input');
      if (inp && inp.value) return moneyToCents(inp.value);
    }
    return null;
  }
  function readNte() { var v = labeledMoney(/^client\s+dne\b/i); return v != null ? v : stripMoney(/^client\s+dne\b/i); }
  // Vendor proposal header shows the vendor's PO NTE, not the client DNE (live, 2026-10-06).
  function readPoNte() { return stripMoney(/^po\s+nte\b/i); }
  function readVendorTotal() { return stripMoney(/^total vendor cost\b/i); }

  // The Generate prompt box: the one text field sharing a close ancestor with a "Generate" button.
  // Live 2026-10-06: it is an <input type=text> ("Anything else you would like?") inside the react-aria
  // "Generate Client Proposal" modal on the VENDOR PROPOSAL page, not a textarea on ai-preview.
  function findPromptBox() {
    var btns = Array.prototype.filter.call(document.querySelectorAll('button'), function (b) {
      return !inPanel(b) && /^\s*generate\b/i.test(b.textContent || '');
    });
    for (var i = 0; i < btns.length; i++) {
      var el = btns[i];
      for (var d = 0; d < 6 && el; d++, el = el.parentElement) {
        var tas = Array.prototype.filter.call(el.querySelectorAll('textarea, input[type="text"], input:not([type])'), function (t) { return !inPanel(t); });
        if (tas.length === 1) return tas[0];
        if (tas.length > 1) break;
      }
    }
    return null;
  }

  // ---- UI -----------------------------------------------------------------------------------
  var CSS =
    '#bwn-apa{position:fixed;right:16px;bottom:16px;z-index:2147482000;width:min(440px,calc(100vw - 32px));max-height:80vh;display:flex;flex-direction:column;' +
    'background:#f0f4f8;color:#1d2b24;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.25);font:13px/1.45 "DM Sans",system-ui,sans-serif;overflow:hidden}' +
    '#bwn-apa .h{background:linear-gradient(135deg,#1a5f3e,#0d3d26);color:#fff;border-bottom:3px solid #2ECC71;padding:8px 12px;display:flex;align-items:center;gap:8px}' +
    '#bwn-apa .h b{flex:1;font-size:14px}' +
    '#bwn-apa .b{padding:10px 12px;overflow:auto}' +
    '#bwn-apa button{font:600 12px "DM Sans",system-ui,sans-serif;border:1px solid #1a5f3e;background:#fff;color:#1a5f3e;border-radius:6px;padding:4px 10px;cursor:pointer}' +
    '#bwn-apa button.p{background:#1a5f3e;color:#fff}#bwn-apa button:disabled{opacity:.45;cursor:not-allowed}' +
    '#bwn-apa .h button{background:transparent;color:#fff;border-color:rgba(255,255,255,.6)}' +
    '#bwn-apa button:focus-visible,#bwn-apa input:focus-visible,#bwn-apa textarea:focus-visible,#bwn-apa select:focus-visible{outline:2px solid #2ECC71;outline-offset:1px}' +
    '#bwn-apa h4{margin:10px 0 4px;font-size:12px;color:#1a5f3e;text-transform:uppercase;letter-spacing:.04em}' +
    '#bwn-apa label{display:block;font-size:12px;font-weight:600;color:#1a5f3e;margin:6px 0 2px}' +
    '#bwn-apa textarea,#bwn-apa input[type=text],#bwn-apa select{box-sizing:border-box;width:100%;font:12px "DM Sans",system-ui,sans-serif;border:1px solid #b9c7d3;border-radius:5px;padding:4px 6px;background:#fff}' +
    '#bwn-apa textarea{min-height:44px;resize:vertical}' +
    '#bwn-apa .mono,#bwn-apa pre{font-family:"DM Mono",ui-monospace,monospace;font-size:11px}' +
    '#bwn-apa pre{white-space:pre-wrap;background:#fff;border:1px solid #dbe3ea;border-radius:5px;padding:6px;margin:4px 0}' +
    '#bwn-apa ul{list-style:none;margin:4px 0;padding:0}#bwn-apa li{padding:2px 0 2px 18px;position:relative}' +
    '#bwn-apa li:before{position:absolute;left:0;font-weight:700}' +
    '#bwn-apa li.fail:before{content:"\\2717";color:#b3261e}#bwn-apa li.warn:before{content:"!";color:#9a6700}' +
    '#bwn-apa li.ok:before,#bwn-apa li.pass:before{content:"\\2713";color:#1a5f3e}' +
    '#bwn-apa table{border-collapse:collapse;width:100%;font-size:11px}#bwn-apa td,#bwn-apa th{border-bottom:1px solid #dbe3ea;padding:2px 4px;text-align:left}' +
    '#bwn-apa .row{display:flex;gap:6px;align-items:center;margin-top:6px;flex-wrap:wrap}' +
    '#bwn-apa .ctr{margin-left:auto}#bwn-apa .ctr.warn{color:#9a6700}#bwn-apa .ctr.over{color:#b3261e;font-weight:700}' +
    '#bwn-apa .off{color:#5b6b78;font-style:italic}';

  var form = null;          // builder field values survive re-renders within a page
  var gridSig = '';
  // Insert armed by a click while the Generate modal is closed. react-aria marks everything outside an
  // open modal inert (live 2026-10-06), so the panel cannot be clicked once the modal is up: the click
  // happens first, and the text lands once when the modal's prompt box appears. Never presses Generate.
  var armed = null;

  function fillBox(ta, text) {
    // React tracks the value through the prototype setter; a plain .value= is overwritten on the next render.
    // A single-line <input> (the live Generate box) drops newlines, so join sections with a space.
    if (ta.tagName !== 'TEXTAREA') text = text.split(String.fromCharCode(10)).join(' ');
    Object.getOwnPropertyDescriptor((ta.tagName === 'TEXTAREA' ? HTMLTextAreaElement : HTMLInputElement).prototype, 'value').set.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function ensurePanel() {
    var p = panelEl();
    if (p) return p;
    if (!document.getElementById('bwn-apa-css')) {
      var st = document.createElement('style');
      st.id = 'bwn-apa-css';
      st.textContent = CSS;
      (document.head || document.documentElement).appendChild(st);
    }
    p = document.createElement('section');
    p.id = PANEL_ID;
    p.setAttribute('role', 'region');
    p.setAttribute('aria-label', 'BWN AI Proposal Assist');
    document.body.appendChild(p);
    p.addEventListener('click', onClick);
    p.addEventListener('input', onInput);
    p.addEventListener('change', onInput);
    return p;
  }

  function removePanel() { var p = panelEl(); if (p) p.remove(); }

  function list(items) {
    return '<ul>' + items.map(function (o) { return '<li class="' + esc(o.level) + '">' + esc(o.msg) + '</li>'; }).join('') + '</ul>';
  }

  function toggles() {
    return '<h4>Features (off until switched on)</h4>' +
      ['context:Work order context (reads the WO, its client proposals and trips - read-only)', 'preflight:Pre-flight (vendor proposal page)', 'builder:Prompt builder (AI preview page)', 'checker:Post-generate checker (AI preview page)'].map(function (s) {
        var k = s.split(':')[0];
        return '<label><input type="checkbox" data-set="' + k + '"' + (on(k) ? ' checked' : '') + '> ' + esc(s.slice(k.length + 1)) + '</label>';
      }).join('');
  }

  function contextHtml(rt) {
    if (!on('context')) return '';
    var h = '<h4>Work order context</h4>';
    if (!wctx || wctx.wo !== rt.wo || wctx.state === 'loading') return h + '<p class="off">Reading the work order, its client proposals and trips...</p>';
    var w = wctx.wo_, out = h, errs = Object.keys(wctx.errs);
    if (w) {
      var loc = [w.locationName, w.address && [w.address.city, w.address.state].filter(Boolean).join(', ')].filter(Boolean).join(' - ');
      out += '<p>W-' + esc(w.number) + ' - ' + esc(w.clientName || '') + (loc ? ' - ' + esc(loc) : '') + (w.priority && w.priority.label ? ' (' + esc(w.priority.label) + ')' : '') +
        '<br>Client NTE <b>' + esc(fmt(gqlCents(w.doNotExceed))) + '</b>, vendor NTE ' + esc(fmt(gqlCents(w.totalNTE))) + (w.statusName ? ', ' + esc(w.statusName) : '') + '</p>';
    }
    if (wctx.trips) {
      var ts = tripPlan(wctx.trips, wctx.prior && wctx.prior.lines);
      out += '<p>Trips: ' + (ts.length ? ts.map(function (t) { return t.label + ' ' + t.status + (t.assumed ? ' (assumed - not on the POs, check)' : ''); }).map(esc).join(', ') : 'none on the POs') + '</p>';
    }
    if (wctx.prior && wctx.prior.lines.length) {
      out += '<details><summary>Client proposal #' + esc(wctx.prior.number) + ' lines</summary><table><tr><th>Trip</th><th>Category</th><th>Item</th><th>Charge</th></tr>' +
        wctx.prior.lines.map(function (li) {
          return '<tr><td>' + esc(li.tripLabel || '') + '</td><td>' + esc(CAT_LABEL[li.category] || li.category) + '</td><td>' + esc(li.item || '') + '</td><td>' + esc(lineSummary(li).replace(/^.* (?=-?\$)/, '')) + '</td></tr>';
        }).join('') + '</table></details>';
    }
    if (wctx.quote) {
      var q = wctx.quote;
      out += '<p>Vendor quote #' + esc(q.number) + ' - ' + esc(q.vendorName || '') + ', ' + esc(fmt(gqlCents(q.total))) + '</p>';
      if (wctx.rates) {
        out += '<h4>Rate card check</h4>' + list(rateCheck(q.quoteLineItems, wctx.rates, wctx.wo_ && wctx.wo_.locationId)) +
          '<p class="off">' + esc(wctx.rates.length) + ' active client rates read. A match below vendor cost cannot be fixed by the prompt - change the line or the rate first.</p>';
      }
    }
    if (errs.length) out += list(errs.map(function (k) { return { level: 'fail', msg: 'Read failed (' + k + '): ' + wctx.errs[k] + ' - this part is missing, not empty.' }; }));
    return out + '<div class="row"><button data-act="ctx-reload">Reload context</button></div>';
  }

  function preflightHtml(rt) {
    if (!on('preflight')) return '';
    var rows = readGrid();
    if (!rows) return '<h4>Pre-flight</h4><p class="off">Line grid layout not recognised — disabled.</p>';
    var nte = readNte() != null ? readNte() : ctxNte(), vt = readVendorTotal();
    var trips = distinctTrips(rows);
    var prev = ctxGet(rt.wo);
    var items = materialItems(rows);
    if (JSON.stringify(prev.items) !== JSON.stringify(items) || prev.nte !== nte || prev.trips !== trips.length) {
      ctxSet(rt.wo, { items: items, nte: nte, trips: trips.length });
      logAction('pre-flight run');
    }
    var rec = recommendedLines(rows);
    var cf = ctxFacts(), total = vt != null ? vt : rows.reduce(function (s, r) { return s + (r.totalCost || 0); }, 0);
    return '<h4>Pre-flight</h4>' + list(preflight(rows, nte, vt, readPoNte()).concat(cf ? contextFindings(cf, rows) : [])) +
      '<h4>Recommended lines</h4><table><tr><th>Category</th><th>Item</th><th>Trip #</th><th>UOM</th><th>Qty</th></tr>' +
      rec.map(function (r) {
        return '<tr><td>' + esc(r.category) + '</td><td>' + esc(r.item) + (r.note ? ' <span class="mono">' + esc(r.note) + '</span>' : '') + '</td><td>' + esc(r.trip) + '</td><td>' + esc(r.uom) + '</td><td>' + esc(r.qty) + '</td></tr>';
      }).join('') + '</table><p class="off">Guidance only - edit the vendor proposal yourself; this panel never changes the grid.</p>';
  }

  function materialItems(rows) {
    return rows.filter(function (r) { return r.item && !isTravel(r) && !isLabor(r) && !/shipping|disposal/i.test(r.item); }).map(function (r) { return r.item; });
  }

  function defaultForm(rt) {
    var t = templates()[0], c = ctxGet(rt.wo);
    if (!c.items && rt.kind === 'vp') { var g = readGrid(); c.items = g ? materialItems(g) : []; }   // pre-flight off: read the grid here
    return {
      tpl: t.name, pricingRules: t.pricingRules, ranges: t.ranges, scopeLine: t.scopeLine, verbatim: t.verbatim,
      issue: '', materials: (c.items || []).join('\n'), trips: ''
    };
  }

  function field(k, label, area) {
    var v = esc(form[k]);
    return '<label for="bwn-apa-' + k + '">' + esc(label) + '</label>' + (area
      ? '<textarea id="bwn-apa-' + k + '" data-f="' + k + '">' + v + '</textarea>'
      : '<input type="text" id="bwn-apa-' + k + '" data-f="' + k + '" value="' + v + '">');
  }

  function builderHtml(rt) {
    if (!on('builder')) return '';
    if (!form || form.wo !== rt.wo) { form = defaultForm(rt); form.wo = rt.wo; onContext(); }
    var compat = findPromptBox() ? ''
      : rt.kind === 'vp' ? '<p class="off">' + (armed ? 'Insert armed - open Generate Client Proposal and the prompt box is filled once.' : 'Fill this in first, click Insert, then open Generate Client Proposal (the panel cannot be clicked while that modal is open).') + '</p>'
      : '<p class="off">Generate prompt box: layout not recognised — disabled. Copy still works.</p>';
    return '<h4>Prompt builder</h4>' + compat +
      '<label for="bwn-apa-tpl">Client template</label><select id="bwn-apa-tpl" data-tpl="1">' +
      templates().map(function (t) { return '<option' + (t.name === form.tpl ? ' selected' : '') + '>' + esc(t.name) + '</option>'; }).join('') +
      '</select><div class="row"><button data-act="tpl-save">Save template</button><button data-act="tpl-del">Delete template</button></div>' +
      field('pricingRules', 'Pricing rules', true) +
      field('ranges', 'Non-rate-card ranges (one per line: Item: 50-120)', true) +
      field('scopeLine', 'Scope style line', false) +
      '<div class="row"><button data-act="ai-draft"' + (aiBusy ? ' disabled' : '') + '>' + (aiBusy ? 'Drafting...' : 'Draft issue + trip text with AI') + '</button></div>' +
      (aiMsg ? '<p class="off" aria-live="polite">' + esc(aiMsg) + '</p>' : '') +
      field('issue', '1. Issue sentence', false) +
      field('verbatim', '2. Required verbatim lines (one per line; save NEXREV override wording in the template)', true) +
      field('materials', '3. Materials/Equipment (one per line; Shipping, Disposal are added)', true) +
      field('trips', '4+. Trips, one per line: Trip 1 (Incurred): what was done (prefilled from the POs when context is on)', true) +
      '<pre id="bwn-apa-out" aria-label="Assembled prompt"></pre>' +
      '<div class="row"><button class="p" data-act="copy">Copy</button><button data-act="insert">' + (armed ? 'Armed' : 'Insert') + '</button>' +
      '<span class="ctr mono" id="bwn-apa-ctr" aria-live="polite"></span></div>';
  }

  function updatePrompt() {
    var out = document.getElementById('bwn-apa-out'), ctr = document.getElementById('bwn-apa-ctr');
    if (!out || !form) return;
    var text = buildPrompt(form), st = promptState(text);
    out.textContent = text;
    ctr.textContent = st.n + ' / ' + PROMPT_MAX + (st.over ? ' - over limit, shorten' : st.warn ? ' - near limit' : '');
    ctr.className = 'ctr mono' + (st.over ? ' over' : st.warn ? ' warn' : '');
    var p = panelEl();
    p.querySelector('[data-act="copy"]').disabled = st.over;
    var rt = routeOf(location.pathname);
    p.querySelector('[data-act="insert"]').disabled = st.over || (!findPromptBox() && !(rt && rt.kind === 'vp'));
  }

  // -> {errs, pv, res}; res is null when the response carried no preview.
  function checkResult(rt) {
    var j = lastCheck.json, pl = payloadOf(j), errs = errorsOf(j);
    var pv = pl && (pl.preview || pl.result || (pl.lineItems ? pl : null));
    if (errs.length || !pv) return { errs: errs, pv: null, res: null };
    var c = ctxGet(rt.wo), f = form || {};
    return { errs: errs, pv: pv, res: checkPreview(pv, {
      nte: readNte() != null ? readNte() : ctxNte() != null ? ctxNte() : (c.nte == null ? null : c.nte),
      ranges: parseRanges(f.ranges), verbatim: lines(f.verbatim), trips: c.trips || null
    }) };
  }

  function checkerHtml(rt) {
    if (!on('checker')) return '';
    if (!lastCheck || lastCheck.wo !== rt.wo) return '<h4>Post-generate check</h4><p class="off">Waiting for Generate or Revise - nothing is sent by this panel.</p>';
    var cr = checkResult(rt), h = '<h4>Post-generate check (' + esc(lastCheck.op) + ')</h4>';
    if (!cr.res) return h + list([{ level: 'fail', msg: 'Generate failed. Server said:' }].concat(
      (cr.errs.length ? cr.errs : ['(no error text in the response)']).map(function (e) { return { level: 'warn', msg: e }; })));
    return h + list(cr.res) + (cr.pv.reasoning ? '<details><summary>AI reasoning</summary><pre>' + esc(cr.pv.reasoning) + '</pre></details>' : '');
  }

  function render() {
    var rt = routeOf(location.pathname);
    if (!rt || !document.body || !isOpen) { removePanel(); return; }
    var p = ensurePanel();
    if (on('context') && (!wctx || wctx.wo !== rt.wo)) loadContext(rt);
    var body = contextHtml(rt) + (rt.kind === 'vp' ? preflightHtml(rt) : '') + builderHtml(rt) + checkerHtml(rt);
    var focusId = document.activeElement && inPanel(document.activeElement) ? document.activeElement.id : null;
    var oldB = p.querySelector('.b'), scroll = oldB ? oldB.scrollTop : 0;   // keep the reader's place across re-renders
    p.innerHTML = '<div class="h"><b>AI Proposal Assist</b><span class="mono">v' + esc(VER) + '</span>' +
      '<button data-act="close" aria-label="Close AI Proposal Assist">×</button></div>' +
      '<div class="b">' + (body || '<p class="off">No feature on for this page.</p>') + toggles() + '</div>';
    updatePrompt();
    var newB = p.querySelector('.b');
    if (newB) newB.scrollTop = scroll;
    if (focusId) { var f = document.getElementById(focusId); if (f) f.focus(); }
  }

  function onInput(ev) {
    var t = ev.target;
    if (t.dataset.set && ev.type === 'change') {
      settings[t.dataset.set] = t.checked;
      lsSet(LS_SET, settings);
      logAction('feature ' + t.dataset.set + (t.checked ? ' on' : ' off'));
      render();
    } else if (t.dataset.tpl && ev.type === 'change') {
      var tp = templates().filter(function (x) { return x.name === t.value; })[0];
      if (tp) ['pricingRules', 'ranges', 'scopeLine', 'verbatim'].forEach(function (k) { form[k] = tp[k] || ''; });
      form.tpl = t.value;
      render();
    } else if (t.dataset.f && form) {
      form[t.dataset.f] = t.value;
      if (armed) armed = promptState(buildPrompt(form)).over ? null : buildPrompt(form);   // armed text follows edits
      updatePrompt();
    }
  }

  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    var ta = document.createElement('textarea');
    ta.value = text;
    panelEl().appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
    return Promise.resolve();
  }

  function onClick(ev) {
    var b = ev.target.closest && ev.target.closest('button[data-act]');
    if (!b || b.disabled) return;
    var act = b.dataset.act;
    if (act === 'close') { closePanel(); return; }
    if (act === 'ctx-reload') { wctx = null; render(); return; }
    if (act === 'ai-draft') { aiDraft(); return; }
    if (!form) return;
    var text = buildPrompt(form);
    if (act === 'copy' && !promptState(text).over) {
      copyText(text).then(function () { b.textContent = 'Copied'; logAction('prompt copied'); }, function () { b.textContent = 'Copy failed'; });
    } else if (act === 'insert' && !promptState(text).over) {
      var ta = findPromptBox();
      if (ta) { fillBox(ta, text); b.textContent = 'Inserted'; logAction('prompt inserted'); }
      else { armed = text; logAction('prompt insert armed'); render(); }
    } else if (act === 'tpl-save') {
      var name = window.prompt('Template name', form.tpl || '');
      if (!name) return;
      var all = templates().filter(function (x) { return x.name !== name; });
      all.push({ name: name, pricingRules: form.pricingRules, ranges: form.ranges, scopeLine: form.scopeLine, verbatim: form.verbatim });
      lsSet(LS_TPL, all);
      form.tpl = name;
      logAction('template saved');
      render();
    } else if (act === 'tpl-del') {
      lsSet(LS_TPL, templates().filter(function (x) { return x.name !== form.tpl; }));
      form.tpl = templates()[0].name;
      logAction('template deleted');
      render();
    }
  }

  // ---- launcher: a row in the BWN Suite dock (bwn:dock:* host in bwn-suite-core) ---------------
  // Registered only on the vendor proposal page and the ai-preview page Generate lands on; gone
  // everywhere else (same reconcile as bwn-dispatch). No floating fallback: without Core there is no
  // launcher. Core's BWN_DOCK_POLICY must carry DOCK_KEY or the row stays hidden (fail-closed).
  var DOCK_KEY = 'ai-proposal';
  var isOpen = false, dockOn = false;
  function bus(detail) { try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: detail })); } catch (e) { /* no bus */ } }
  function dockPresence(show, force) {
    if (show && (!dockOn || force)) bus({ id: 'bwn:dock:register', key: DOCK_KEY, label: 'AI Proposal', icon: '✨', weight: 30,
      title: 'Pre-flight, prompt builder and post-generate check for the AI client proposal' });
    else if (!show && dockOn) bus({ id: 'bwn:dock:unregister', key: DOCK_KEY });
    dockOn = show;
  }
  function dockBadge(b) { if (dockOn) bus({ id: 'bwn:dock:update', key: DOCK_KEY, badge: b }); }
  function openPanel() {
    if (!routeOf(location.pathname)) return;
    bus({ id: 'bwn:drawer:open', key: DOCK_KEY });
    isOpen = true;
    dockBadge('');
    render();
  }
  function closePanel() { isOpen = false; removePanel(); }
  document.addEventListener('bwn:evt', function (e) {
    var d = e && e.detail;
    if (!d) return;
    if (d.id === 'bwn:dock:host' || d.id === 'bwn:dock:ping') dockPresence(!!routeOf(location.pathname), true);
    if (d.id === 'bwn:dock:open' && d.key === DOCK_KEY) { if (isOpen) closePanel(); else openPanel(); }
    if (d.id === 'bwn:drawer:open' && d.key !== DOCK_KEY && isOpen) closePanel();   // another tool took the slot
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && isOpen) closePanel(); });

  // ---- lifecycle: route check on init and on every SPA route change; grid via observer --------
  var mo = null, moTimer = null;
  function onRoute() {
    var rt = routeOf(location.pathname);
    if (mo) { mo.disconnect(); mo = null; }
    gridSig = '';
    armed = null;
    dockPresence(!!rt);
    if (!rt) { closePanel(); return; }
    render();
    if (rt.kind === 'vp' || rt.kind === 'ai') {
      // The grid / Generate box mount after the route; re-render when the page (not our panel) changes.
      mo = new MutationObserver(function (muts) {
        if (muts.every(function (m) { return inPanel(m.target); })) return;
        clearTimeout(moTimer);
        moTimer = setTimeout(function () {
          var g = (rt.kind === 'vp' ? JSON.stringify(readGrid()) + readNte() : '') + !!findPromptBox();
          var box = armed && findPromptBox();
          if (box) { fillBox(box, armed); armed = null; logAction('prompt inserted (armed)'); }
          if (g !== gridSig || !panelEl()) { gridSig = g; render(); }
        }, 300);
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  function boot() {
    var last = location.pathname;
    function ping() { if (location.pathname !== last) { last = location.pathname; onRoute(); } }
    window.addEventListener('popstate', ping);
    ['pushState', 'replaceState'].forEach(function (m) {
      var orig = history[m];
      if (typeof orig !== 'function') return;
      history[m] = function () { var r = orig.apply(this, arguments); setTimeout(ping, 0); return r; };
    });
    onRoute();
  }

  console.info('[BWN APA] v' + VER + ' - read-only AI proposal assist; dock row on vendor proposal pages; features off until enabled in the panel');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
