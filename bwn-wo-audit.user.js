// ==UserScript==
// @name         BWN WO Audit (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.1.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-wo-audit.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-wo-audit.user.js
// @description  Batch WO-audit tool. Upload a WO audit .xlsx; for each work order this reads its two most recent notes DIRECTLY from Umbrava's GraphQL API in-page (using your live Umbrava session - the same read the BWN Ops Suite AI drafts use), then asks the broadway-internal-ops SWA summarize route (x-bwn-key gated, Anthropic key server-side) to write a 1-3 sentence client-ready status note. Fills the audit's notes column and downloads the workbook, preserving every other cell and formula. Runs entirely in the app.umbrava.com page so it inherits your Umbrava auth - no MCP, no pasted keys, nothing sensitive in this script. This replaces the old standalone WO_Audit_Automation.html SWA tool, whose server-side MCP path could not authenticate to Umbrava.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      green-stone-0717dab0f.7.azurestaticapps.net
// @require      https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js
// ==/UserScript==

(function () {
  'use strict';

  var VER = '0.1.0';
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  var SWA_BASE = 'https://green-stone-0717dab0f.7.azurestaticapps.net';
  var AUDIT_URL = SWA_BASE + '/api/wo-audit';
  var GREEN = '#0d3d26';
  var MS_DAY = 86400000;
  var MODELS = [
    { id: 'claude-sonnet-5', label: 'Sonnet 5 (default)' },
    { id: 'claude-opus-4-8', label: 'Opus 4.8 (best)' },
    { id: 'claude-haiku-4-5', label: 'Haiku 4.5 (cheapest)' },
  ];
  var XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  console.info('[BWN WO AUDIT] v' + VER + ' - in-page GraphQL notes read -> SWA summarize route -> filled .xlsx download');

  // ====================================================================
  // Auth: the live Umbrava Auth0 bearer, read straight from the page (same
  // content-based pick bwn-suite-ai/gql use). This is the whole reason the tool
  // runs in-page: a server-side Function has no Umbrava session, which is why the
  // old MCP route failed with a 400 "Authentication error".
  // ====================================================================
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

  // Same-origin GraphQL POST -> resolves to `data`, throws on errors[]. Carries the
  // page's own Umbrava bearer; no @connect needed (app.umbrava.com is same-origin).
  function gql(query, variables) {
    var tok = authToken();
    return fetch('/api/graphql', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: query, variables: variables || {} })
    }).then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
        return j && j.data;
      });
  }

  function _date(v) { if (!v) return null; var d = new Date(v); return isNaN(+d) ? null : d; }
  function _stripHtml(s) { return String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // One WO's id + status + notes, newest first. Mirrors bwn-suite-ai woToJob's
  // proven ID/notes selectors (workOrder(workOrderNumber) -> id; workOrderNotes(workOrderId)).
  function woNotes(number) {
    var n = parseInt(String(number).replace(/^W-?/i, '').replace(/[^0-9]/g, ''), 10);
    if (!n || isNaN(n)) return Promise.reject(new Error('not a WO number: "' + number + '"'));
    // CRITICAL query is `{ id }` ONLY (the proven woToJob selector). statusName is fetched in
    // an ISOLATED follow-up so a drifted field name can never error the whole query and starve
    // the notes read; if it drifts we just fall back to the xlsx Status column.
    return gql('query($n:Int!){ workOrder(workOrderNumber:$n){ id } }', { n: n })
      .then(function (idr) {
        var wo = idr && idr.workOrder;
        if (!wo || wo.id == null) throw new Error('WO ' + n + ' not found');
        var statusP = gql('query($n:Int!){ workOrder(workOrderNumber:$n){ statusName } }', { n: n })
          .then(function (sr) { return (sr && sr.workOrder && sr.workOrder.statusName) || ''; })
          .catch(function () { return ''; });
        var notesP = gql('query($id:Int!){ workOrderNotes(workOrderId:$id){ content contentHtml createdDate isPinned type } }', { id: wo.id })
          .then(function (nr) { return (nr && nr.workOrderNotes) || []; })
          .catch(function () { return []; });   // notes selector drift -> empty, never fatal
        return Promise.all([statusP, notesP]).then(function (a) { return { wo: { id: wo.id, statusName: a[0] }, notes: a[1] }; });
      })
      .then(function (res) {
        var notes = res.notes.slice().sort(function (a, b) {
          return (_date(b && b.createdDate) || 0) - (_date(a && a.createdDate) || 0);
        }).map(function (x) {
          x = x || {};
          return {
            content: (x.content && String(x.content).trim()) || _stripHtml(x.contentHtml),
            createdDate: x.createdDate || '',
            type: x.type || '',
            isPinned: !!x.isPinned,
          };
        });
        return { id: res.wo.id, statusName: res.wo.statusName || '', notes: notes };
      });
  }

  // ---- SWA summarize call (cross-origin -> GM_xmlhttpRequest + @connect) ----
  function gmPost(url, headers, bodyObj, timeoutMs) {
    return new Promise(function (resolve, reject) {
      try {
        GM_xmlhttpRequest({
          method: 'POST', url: url, headers: headers, data: JSON.stringify(bodyObj), timeout: timeoutMs || 60000,
          onload: function (r) { var j = null; try { j = JSON.parse(r.responseText); } catch (e) { } resolve({ status: r.status, json: j }); },
          onerror: function () { reject(new Error('network error')); },
          ontimeout: function () { reject(new Error('timed out')); },
        });
      } catch (e) { reject(e); }
    });
  }
  // Summarize one WO's notes into a status note. Retries 429/5xx/network with backoff;
  // 400/403 are non-retryable (bad input / bad key) and throw immediately.
  function summarize(woFacts, notes, model, key, tries) {
    tries = tries || 3;
    var attempt = 0, lastErr = '';
    function once() {
      attempt++;
      return gmPost(AUDIT_URL, { 'Content-Type': 'application/json', 'x-bwn-key': key }, { wo: woFacts, notes: notes, model: model }, 60000)
        .then(function (r) {
          if (r.status >= 200 && r.status < 300 && r.json && r.json.ok) return r.json.note || '';
          if ((r.status === 429 || r.status >= 500 || r.status === 0) && attempt < tries) {
            lastErr = 'HTTP ' + r.status + ((r.json && r.json.error) ? ': ' + r.json.error : '');
            return sleep(600 * attempt).then(once);
          }
          throw new Error('HTTP ' + r.status + ((r.json && r.json.error) ? ': ' + r.json.error : ''));
        })
        .catch(function (e) {
          if (attempt < tries) { lastErr = (e && e.message) || 'network'; return sleep(600 * attempt).then(once); }
          throw new Error((e && e.message) || lastErr || 'summarize failed');
        });
    }
    return once();
  }

  // ---- Bounded-concurrency runner ----
  function runPool(items, worker, concurrency, onProgress) {
    return new Promise(function (resolve) {
      var i = 0, done = 0, results = new Array(items.length);
      function next() {
        if (i >= items.length) return Promise.resolve();
        var idx = i++;
        return Promise.resolve().then(function () { return worker(items[idx], idx); })
          .then(function (v) { results[idx] = v; }, function (e) { results[idx] = { error: (e && e.message) || String(e) }; })
          .then(function () { done++; if (onProgress) onProgress(done, items.length); return next(); });
      }
      var runners = [];
      for (var k = 0; k < Math.min(Math.max(1, concurrency), items.length || 1); k++) runners.push(next());
      Promise.all(runners).then(function () { resolve(results); });
    });
  }

  // ====================================================================
  // Workbook mapping. Header-based (survives column reorder) with a scan for the
  // header row; write-back column detected dynamically, appended if absent.
  // ====================================================================
  var KEY_PATTERNS = [/^wo\s*#?$/i, /work\s*order\s*#/i, /^wo\s*number/i];
  var KEY_FALLBACK = [/source\s*job\s*#?/i, /^job\s*id$/i, /^job\s*#?$/i];
  function findCol(hdr, patterns) {
    for (var p = 0; p < patterns.length; p++) {
      for (var c = 0; c < hdr.length; c++) { if (patterns[p].test(hdr[c])) return c; }
    }
    return -1;
  }
  function findNoteCol(hdr) {
    // Prefer an explicit audit/status-note column; else any "note(s)" column (last one).
    var pref = [/audit.*note|note.*audit/i, /status\s*note/i];
    for (var p = 0; p < pref.length; p++) { for (var c = 0; c < hdr.length; c++) { if (pref[p].test(hdr[c])) return c; } }
    var last = -1;
    for (var i = 0; i < hdr.length; i++) { if (/\bnotes?\b/i.test(hdr[i])) last = i; }
    return last;
  }
  function mapSheet(ws) {
    var aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: true, blankrows: false });
    // Locate the header row: the first row (of the first 15) that matches a key pattern.
    var headerRow = 0, keyCol = -1;
    for (var r = 0; r < Math.min(15, aoa.length); r++) {
      var row = (aoa[r] || []).map(function (x) { return String(x == null ? '' : x); });
      var k = findCol(row, KEY_PATTERNS);
      if (k === -1) k = findCol(row, KEY_FALLBACK);
      if (k !== -1) { headerRow = r; keyCol = k; break; }
    }
    var hdr = (aoa[headerRow] || []).map(function (x) { return String(x == null ? '' : x); });
    if (keyCol === -1) keyCol = findCol(hdr, KEY_PATTERNS);
    if (keyCol === -1) keyCol = findCol(hdr, KEY_FALLBACK);
    var map = {
      headerRow: headerRow,
      key: keyCol,
      keyName: keyCol > -1 ? hdr[keyCol] : null,
      status: findCol(hdr, [/^status$/i, /wo\s*status/i]),
      city: findCol(hdr, [/^city$/i]),
      state: findCol(hdr, [/^state$/i]),
      location: findCol(hdr, [/location|site|store/i]),
      days: findCol(hdr, [/aged|days\s*open|^days$/i]),
      assigned: findCol(hdr, [/assigned|coordinator|owner/i]),
      note: findNoteCol(hdr),
      noteAppended: false,
    };
    map.noteName = map.note > -1 ? hdr[map.note] : null;
    map.aoa = aoa;
    return map;
  }
  // Ensure a note column exists on the worksheet; append "Audit Notes" if none was found.
  function ensureNoteCol(ws, map) {
    if (map.note > -1) return map;
    var range = XLSX.utils.decode_range(ws['!ref']);
    var col = range.e.c + 1;
    ws[XLSX.utils.encode_cell({ c: col, r: map.headerRow })] = { t: 's', v: 'Audit Notes' };
    range.e.c = col;
    ws['!ref'] = XLSX.utils.encode_range(range);
    map.note = col; map.noteName = 'Audit Notes'; map.noteAppended = true;
    return map;
  }
  function cellStr(aoa, r, c) {
    if (c < 0) return '';
    var row = aoa[r] || [];
    var v = row[c];
    return v == null ? '' : String(v).trim();
  }

  // ====================================================================
  // UI
  // ====================================================================
  var session = null;   // { wb, ws, map, rows:[{rowIdx, key}], results:[], name }

  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;bottom:18px;left:50%;transform:translateX(-50%);background:' + GREEN + ';color:#fff;padding:9px 16px;border-radius:8px;font:600 13px ' + FONT + ';z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.3)';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 3200);
  }
  function getKey() { return GM_getValue('ingest_key', ''); }

  function buildModal() {
    if (document.getElementById('bwn-woaudit-ov')) return;
    var ov = document.createElement('div');
    ov.id = 'bwn-woaudit-ov';
    ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:2147483646;display:flex;align-items:center;justify-content:center;font:14px ' + FONT;
    var box = document.createElement('div');
    box.style.cssText = 'background:#fff;width:min(680px,94vw);max-height:90vh;overflow:auto;border-radius:12px;box-shadow:0 12px 48px rgba(0,0,0,.4)';
    box.innerHTML =
      '<div style="background:' + GREEN + ';color:#fff;padding:14px 18px;border-radius:12px 12px 0 0;display:flex;justify-content:space-between;align-items:center">' +
      '<b style="font-size:15px">WO Audit - batch status notes</b>' +
      '<span id="bwn-woaudit-x" style="cursor:pointer;font-size:20px;line-height:1">&times;</span></div>' +
      '<div style="padding:18px">' +
      '<div id="bwn-woaudit-keywarn" style="display:none;background:#fff4e5;border:1px solid #ffcf99;color:#8a4b00;padding:8px 10px;border-radius:8px;margin-bottom:12px;font-size:12.5px"></div>' +
      '<label style="display:block;font-weight:600;margin-bottom:6px">1. Audit workbook (.xlsx)</label>' +
      '<input type="file" id="bwn-woaudit-file" accept=".xlsx,.xls" style="margin-bottom:6px">' +
      '<div id="bwn-woaudit-sheetwrap" style="display:none;margin:8px 0"><label style="font-weight:600;margin-right:8px">Sheet</label><select id="bwn-woaudit-sheet"></select></div>' +
      '<div id="bwn-woaudit-mapinfo" style="font-size:12.5px;color:#444;margin:8px 0;white-space:pre-line"></div>' +
      '<div style="display:flex;gap:16px;margin:12px 0;flex-wrap:wrap">' +
      '<div><label style="display:block;font-weight:600;margin-bottom:4px">Model</label><select id="bwn-woaudit-model"></select></div>' +
      '<div><label style="display:block;font-weight:600;margin-bottom:4px">Concurrency</label><input id="bwn-woaudit-conc" type="number" min="1" max="6" value="3" style="width:64px"></div>' +
      '</div>' +
      '<div style="display:flex;gap:10px;align-items:center;margin:12px 0">' +
      '<button id="bwn-woaudit-start" style="background:' + GREEN + ';color:#fff;border:0;padding:9px 18px;border-radius:8px;font-weight:600;cursor:pointer">Start Audit</button>' +
      '<button id="bwn-woaudit-retry" style="display:none;background:#8a4b00;color:#fff;border:0;padding:9px 14px;border-radius:8px;font-weight:600;cursor:pointer">Retry Errors</button>' +
      '<button id="bwn-woaudit-dl" style="display:none;background:#1a5f3e;color:#fff;border:0;padding:9px 14px;border-radius:8px;font-weight:600;cursor:pointer">Download .xlsx</button>' +
      '</div>' +
      '<div id="bwn-woaudit-prog" style="font-weight:600;margin:6px 0"></div>' +
      '<div id="bwn-woaudit-log" style="font:12px ui-monospace,Consolas,monospace;background:#f6f8f7;border:1px solid #e0e6e2;border-radius:8px;padding:10px;max-height:240px;overflow:auto;white-space:pre-wrap"></div>' +
      '</div>';
    ov.appendChild(box);
    document.body.appendChild(ov);

    var $ = function (id) { return document.getElementById(id); };
    ov.addEventListener('click', function (e) { if (e.target === ov) ov.remove(); });
    $('bwn-woaudit-x').onclick = function () { ov.remove(); };

    var msel = $('bwn-woaudit-model');
    MODELS.forEach(function (m) { var o = document.createElement('option'); o.value = m.id; o.textContent = m.label; msel.appendChild(o); });

    var kw = $('bwn-woaudit-keywarn');
    if (!getKey()) { kw.style.display = 'block'; kw.textContent = 'SWA ingest key not set. Open the Tampermonkey menu -> "BWN WO Audit: Set SWA ingest key" (same key as the rest of the BWN Ops Suite), then reopen this.'; }

    var log = $('bwn-woaudit-log');
    function logln(s) { log.textContent += (log.textContent ? '\n' : '') + s; log.scrollTop = log.scrollHeight; }

    var loaded = null;   // { wb, name }
    $('bwn-woaudit-file').onchange = function (e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          if (typeof XLSX === 'undefined') throw new Error('spreadsheet library not loaded - reload the page');
          var wb = XLSX.read(new Uint8Array(fr.result), { type: 'array', cellFormula: true, cellStyles: true });
          loaded = { wb: wb, name: (f.name || 'wo-audit.xlsx').replace(/\.(xlsx|xls)$/i, '') };
          var sw = $('bwn-woaudit-sheetwrap'), ss = $('bwn-woaudit-sheet');
          ss.innerHTML = '';
          wb.SheetNames.forEach(function (nm) { var o = document.createElement('option'); o.value = nm; o.textContent = nm; ss.appendChild(o); });
          sw.style.display = wb.SheetNames.length > 1 ? 'block' : 'none';
          ss.onchange = describe;
          describe();
        } catch (err) { $('bwn-woaudit-mapinfo').textContent = 'Could not read workbook: ' + ((err && err.message) || err); }
      };
      fr.readAsArrayBuffer(f);
    };

    function currentSheet() { return loaded ? ($('bwn-woaudit-sheet').value || loaded.wb.SheetNames[0]) : null; }
    function describe() {
      if (!loaded) return;
      var ws = loaded.wb.Sheets[currentSheet()];
      var map = mapSheet(ws);
      var dataRows = [];
      for (var r = map.headerRow + 1; r < map.aoa.length; r++) {
        var key = cellStr(map.aoa, r, map.key);
        if (key) dataRows.push({ rowIdx: r, key: key });
      }
      var info = [
        'WO # column: ' + (map.keyName != null ? '"' + map.keyName + '"' : 'NOT FOUND (cannot run)'),
        'Notes write-back: ' + (map.noteName != null ? '"' + map.noteName + '"' : 'none found -> will append "Audit Notes"'),
        'Work orders detected: ' + dataRows.length,
      ].join('\n');
      $('bwn-woaudit-mapinfo').textContent = info;
      $('bwn-woaudit-start').disabled = !(map.key > -1 && dataRows.length);
      session = { wb: loaded.wb, sheet: currentSheet(), map: map, rows: dataRows, results: [], name: loaded.name };
    }

    $('bwn-woaudit-start').onclick = function () { runAudit(false); };
    $('bwn-woaudit-retry').onclick = function () { runAudit(true); };
    $('bwn-woaudit-dl').onclick = function () { downloadResult(); };

    function runAudit(retryOnly) {
      if (!session) return;
      var key = getKey();
      if (!key) { kw.style.display = 'block'; kw.textContent = 'Set the SWA ingest key first (Tampermonkey menu).'; return; }
      if (!authToken()) { logln('! Not signed into Umbrava (no usable token). Reload the tab and retry.'); return; }
      var model = $('bwn-woaudit-model').value;
      var conc = Math.max(1, Math.min(6, parseInt($('bwn-woaudit-conc').value, 10) || 3));
      var ws = session.wb.Sheets[session.sheet];
      ensureNoteCol(ws, session.map);

      var targets = retryOnly
        ? session.rows.filter(function (row, i) { return session.results[i] && session.results[i].error; })
        : session.rows.slice();
      if (retryOnly && !targets.length) { logln('No errored rows to retry.'); return; }

      $('bwn-woaudit-start').disabled = true; $('bwn-woaudit-retry').style.display = 'none'; $('bwn-woaudit-dl').style.display = 'none';
      if (!retryOnly) { log.textContent = ''; session.results = new Array(session.rows.length); }
      logln((retryOnly ? 'Retrying ' : 'Auditing ') + targets.length + ' work orders with ' + model + ' (concurrency ' + conc + ')...');
      var prog = $('bwn-woaudit-prog');

      runPool(targets, function (row) {
        var origIdx = session.rows.indexOf(row);
        return woNotes(row.key)
          .then(function (data) {
            var woFacts = {
              raw: row.key,
              number: row.key,
              status: data.statusName || cellStr(session.map.aoa, row.rowIdx, session.map.status),
              city: cellStr(session.map.aoa, row.rowIdx, session.map.city),
              state: cellStr(session.map.aoa, row.rowIdx, session.map.state),
              location: cellStr(session.map.aoa, row.rowIdx, session.map.location),
              days: cellStr(session.map.aoa, row.rowIdx, session.map.days),
              assignedTo: cellStr(session.map.aoa, row.rowIdx, session.map.assigned),
            };
            var top2 = data.notes.slice(0, 2);
            return summarize(woFacts, top2, model, key, 3).then(function (note) {
              return { note: note, notesFound: data.notes.length };
            });
          })
          .then(function (out) {
            // Write into the worksheet cell, dropping any formula (string value only).
            ws[XLSX.utils.encode_cell({ c: session.map.note, r: row.rowIdx })] = { t: 's', v: out.note };
            session.results[origIdx] = { key: row.key, note: out.note, notesFound: out.notesFound };
            logln('  WO ' + row.key + ' (' + out.notesFound + ' notes): ' + (out.note ? out.note.slice(0, 90) : '(blank)'));
            return session.results[origIdx];
          })
          .catch(function (e) {
            session.results[origIdx] = { key: row.key, error: (e && e.message) || String(e) };
            logln('  ! WO ' + row.key + ': ' + session.results[origIdx].error);
            throw e;   // marks the pool slot as errored too
          });
      }, conc, function (done, total) { prog.textContent = 'Progress: ' + done + ' / ' + total; })
        .then(function () {
          var errs = session.results.filter(function (r) { return r && r.error; }).length;
          var ok = session.results.filter(function (r) { return r && !r.error; }).length;
          logln('Done. ' + ok + ' written, ' + errs + ' errored.');
          $('bwn-woaudit-start').disabled = false;
          $('bwn-woaudit-dl').style.display = 'inline-block';
          if (errs) { $('bwn-woaudit-retry').style.display = 'inline-block'; }
        });
    }

    function downloadResult() {
      if (!session) return;
      try {
        var out = XLSX.write(session.wb, { bookType: 'xlsx', type: 'array', cellStyles: true });
        var blob = new Blob([out], { type: XLSX_MIME });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a'); a.href = url; a.download = session.name + '-audited.xlsx';
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
        toast('Downloaded ' + session.name + '-audited.xlsx');
      } catch (err) { logln('! Download failed: ' + ((err && err.message) || err)); }
    }
  }

  // ---- Launchers ----
  try {
    GM_registerMenuCommand('BWN WO Audit: open', buildModal);
    GM_registerMenuCommand('BWN WO Audit: Set SWA ingest key', function () {
      var v = prompt('SWA ingest key (same value as the connector WO_INGEST_KEY - used across the BWN Ops Suite):', getKey() || '');
      if (v !== null) { GM_setValue('ingest_key', v.trim()); toast(v.trim() ? 'Ingest key saved.' : 'Ingest key cleared.'); }
    });
  } catch (e) { /* menu API absent - floating button still works */ }

  // Small floating launcher, bottom-left so it never collides with the CC launcher (bottom-right).
  function addButton() {
    if (document.getElementById('bwn-woaudit-btn')) return;
    var b = document.createElement('button');
    b.id = 'bwn-woaudit-btn';
    b.textContent = 'WO Audit';
    b.title = 'BWN WO Audit - batch status notes from an audit .xlsx';
    b.style.cssText = 'position:fixed;bottom:18px;left:18px;z-index:2147483645;background:' + GREEN + ';color:#fff;border:0;padding:9px 14px;border-radius:20px;font:600 13px ' + FONT + ';cursor:pointer;box-shadow:0 3px 12px rgba(0,0,0,.25)';
    b.onclick = buildModal;
    document.body.appendChild(b);
  }
  if (document.body) addButton();
  else document.addEventListener('DOMContentLoaded', addButton);
})();
