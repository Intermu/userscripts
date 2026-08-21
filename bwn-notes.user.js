// ==UserScript==
// @name         BWN Suite - Note Templates (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.7.0
// @description  Canned dispatch-note templates in a "Templates" dropdown beside the "+ Add" note button in the Umbrava Dispatch Board's work-order detail panel (Notes tab). Picking a template opens Umbrava's own Add Note composer and DRAFTS the note into it (signed with your first name, ______ blanks left for you to fill) - it is NEVER auto-posted; you review, set the Type, and click Save. STANDALONE: carries its own tiptap/ProseMirror inserter, so in-house techs install this one script alone - no drop-upload dependency. Still prefers drop-upload's hook (window.__bwnFillNoteEditor) when that script is also installed, so coordinator machines keep a single live-tested fill path. Also, on the regular WO page, a "Spoke with" button stamps a [Spoke with: <Vendor>] tag at the TOP of a note (vendor picked from your recent vendors or typed) so you can record which of several WO vendors you spoke with - same human-gated draft, never auto-posted. @grant none, zero egress.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @grant        none
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-notes.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-notes.user.js
// ==/UserScript==
(function () {
  'use strict';

  var GREEN = 'linear-gradient(135deg,#2ECC71,#1a5f3e)';   // Broadway green (Core's --bwn-green/-dk, inlined for a standalone script)

  // ===== Pure logic (sliced + unit-tested by scripts/test-notes-templates.js) ==============
  // BWN-NOTES-SLICE-START
  // First name of the signed-in user. Read from the Auth0 SPA cache in localStorage (the same
  // decodedToken.user the suite's actor() helpers read) - a pure read, no network, no GUID lookup.
  // Prefer the OIDC given_name claim if present, else the first token of the display name.
  function firstNameFromUser(u) {
    if (!u) return '';
    var gn = u.given_name || u.givenName;
    if (gn) return String(gn).trim().split(/\s+/)[0];
    if (u.name) return String(u.name).trim().split(/\s+/)[0];
    return '';
  }

  // The dispatchers' most-used notes, grouped. `body` is verbatim; the signature is appended
  // dynamically (buildNote) so it is always the CURRENT user, never a baked-in name. `signed:false`
  // notes (call-outs) carry no signature, as written. Blanks (______) are left for the user to fill.
  var TEMPLATES = [
    { group: 'Call outs', items: [
      { label: 'Tech called out - redirect (week full)', signed: false,
        body: 'Good morning,\nUnfortunately, our technician called out today and his schedule for the rest of the week is full.\nThis work order will need to be redirected. Sorry for any inconvenience.' },
      { label: 'Tech called out - reschedule for ___', signed: false, date: 'day',
        body: 'Good morning,\nUnfortunately, our technician called out today and this work order will need to be rescheduled for ______ . Apologies for the inconvenience.' }
    ] },
    { group: 'Completed work', items: [
      { label: 'Completed - FC $___, adjust NTE', signed: true,
        body: 'Hi team this has been completed, and our FC is $______ please adjust the NTE accordingly when you have a chance\nThank you' },
      { label: 'Invoice + closing docs to follow', signed: true,
        body: 'Hi team, we will get invoice and closing documents over to your shortly.\nThank you for your patience' },
      { label: 'Quote to follow', signed: true,
        body: 'Hi team, we will get this quote over to your shortly.\nThank you for your patience' }
    ] },
    { group: 'New work to schedule', items: [
      { label: 'Scheduled for ___', signed: true, date: 'day',
        body: 'Hi Team, this has been scheduled for ______\nThank you' },
      { label: 'No availability until week of ___ - redirect', signed: true, date: 'weekOf',
        body: "Hi team, at this time we don't have availability in this area until the week of _______ , apologies please redirect" },
      { label: 'Soonest on-site ___ - schedule or redirect', signed: true, date: 'day',
        body: 'Good afternoon,\nUnfortunately, the soonest we could have someone on site for this work order would be ________\nIf the store can wait until then we can get this schedule, otherwise this will need to be redirected.\nPlease advise' },
      { label: 'Too far / not cost-effective - redirect', signed: true,
        body: "Hi team,\nThis location is _____ hours from our nearest technician, which would round-trip travel of __________ in addition to the assessment fee. Given the scope of work, I don't believe this is cost-effective for either your team or ours.\nPlease redirect\nThank you." }
    ] }
  ];

  // Compose the note text: body verbatim, plus a "-<FirstName>" signature for signed templates.
  // When no first name resolves, leave a "-______" blank rather than a bare dash.
  function buildNote(tpl, firstName) {
    var t = tpl.body;
    if (tpl.signed) t += '\n-' + (firstName || '______');
    return t;
  }

  // ---- Date-fill for templates that carry a `date` blank -----------------------------------
  // A native <input type="date"> gives the picker; these turn its y/m/d into the text that
  // replaces the blank, so nobody types the date. Build the Date LOCALLY (new Date(y, m-1, d))
  // - parsing "yyyy-mm-dd" as a string is UTC and lands a day early in western time zones.
  //   date:'day'    -> "Friday 8/21" (weekday + M/D, the way the notes read)
  //   date:'weekOf' -> "8/18", snapped to that week's Monday (body already says "week of")
  var DOW = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  function fmtDay(y, m, d) {
    var dt = new Date(y, m - 1, d);
    return DOW[dt.getDay()] + ' ' + (dt.getMonth() + 1) + '/' + dt.getDate();
  }
  function fmtWeekOf(y, m, d) {
    var dt = new Date(y, m - 1, d);
    dt.setDate(dt.getDate() - ((dt.getDay() + 6) % 7));   // back up to Monday (Mon=0 ... Sun=6)
    return (dt.getMonth() + 1) + '/' + dt.getDate();
  }
  // Replace the FIRST underscore-run blank with the formatted date. No blank -> body unchanged
  // (a mislabelled template just drafts as-is rather than throwing).
  function applyDate(body, kind, y, m, d) {
    return body.replace(/_{3,}/, kind === 'weekOf' ? fmtWeekOf(y, m, d) : fmtDay(y, m, d));
  }

  // ---- Vendor "spoke with" tag (pure; sliced + unit-tested) --------------------------------
  // A coordinator on a multi-vendor WO tags a note with which vendor they spoke with. Structurally an
  // Umbrava note attaches to the WO, not a vendor, so this is a standardized TEXT tag stamped at the
  // TOP of the note; the vendor is picked (recent list) or typed, never linked to an entity.
  function spokeTag(vendor) { return '[Spoke with: ' + String(vendor == null ? '' : vendor).trim() + ']'; }
  // Put the tag on its own first line, above whatever is already drafted (a template, or nothing).
  function prependSpokeTag(existing, vendor) {
    var tag = spokeTag(vendor);
    var body = String(existing == null ? '' : existing);
    return body.trim() ? tag + '\n' + body : tag + '\n';
  }
  // Most-recently-used vendor list: newest first, case-insensitive dedupe, capped. Empty is ignored.
  function mruAdd(list, vendor, cap) {
    var v = String(vendor == null ? '' : vendor).trim();
    var out = (Array.isArray(list) ? list : []).filter(function (x) { return String(x).toLowerCase() !== v.toLowerCase(); });
    if (v) out.unshift(v);
    return out.slice(0, cap || 20);
  }
  // BWN-NOTES-SLICE-END

  function currentFirstName() {
    try {
      var k = Object.keys(localStorage).find(function (x) { return /@@auth0spajs@@::.*::@@user@@/.test(x); });
      var u = k ? ((JSON.parse(localStorage.getItem(k)) || {}).decodedToken || {}).user : null;
      return firstNameFromUser(u);
    } catch (e) { return ''; }
  }

  // ===== Inlined tiptap/ProseMirror composer-fill (makes this script STANDALONE) ============
  // ponytail: verbatim copy of bwn-drop-upload's live-tested fill code (waitFor + setNativeValue +
  // setEditorValue), so in-house techs need only THIS script. Source of truth is drop-upload; if that
  // measured code changes there (Umbrava editor change), mirror the change here. Coordinators still run
  // drop-upload's hook (pickTemplate prefers it), so its copy stays the exercised one.
  function waitFor(fn, timeoutMs) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function poll() {
        var v = fn();
        if (v) return resolve(v);
        if (Date.now() - t0 > (timeoutMs || 2500)) return resolve(null);
        setTimeout(poll, 120);
      })();
    });
  }
  function setNativeValue(el, val) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    try { if (el._valueTracker) el._valueTracker.setValue('\u0000' + val); } catch (e) { }
    try { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val); } catch (e2) { el.value = val; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function setEditorValue(ed, text) {
    if (ed.tagName === 'TEXTAREA' || ed.tagName === 'INPUT') {
      setNativeValue(ed, text);
      return Promise.resolve(!!(ed.value || '').trim());
    }
    var lines = String(text).split('\n');
    function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
    var blockHtml = String(text).replace(/\r\n/g, '\n').split(/\n{2,}/).map(function (p) { return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
    var tail = '';
    for (var k = lines.length - 1; k >= 0; k--) { if (lines[k].trim()) { tail = lines[k].trim(); break; } }
    function stuck() { var t = ed.textContent || ''; return tail ? t.indexOf(tail.slice(0, 40)) !== -1 : !!t.trim(); }
    function clear() { try { ed.focus(); document.execCommand('selectAll', false, null); } catch (e) { } }
    function selectAllRange() { try { ed.focus(); var sel = window.getSelection(); var rg = document.createRange(); rg.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(rg); } catch (e) { } }
    function tryPaste() {
      selectAllRange();
      try { var dt = new DataTransfer(); dt.setData('text/html', blockHtml); dt.setData('text/plain', String(text)); ed.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); } catch (e) { }
    }
    function tryHtml() { clear(); try { document.execCommand('insertHTML', false, blockHtml); } catch (e) { } }
    function trySoftLines() {
      clear();
      try {
        for (var i = 0; i < lines.length; i++) {
          if (i > 0 && !document.execCommand('insertLineBreak')) return;   // soft <br>; bail if unsupported
          if (lines[i]) document.execCommand('insertText', false, lines[i]);
        }
      } catch (e) { }
    }
    function tryText() { clear(); try { document.execCommand('insertText', false, text); } catch (e) { } }
    function tryInner() { try { ed.innerHTML = blockHtml; ed.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { } }
    // PRIMARY for Umbrava's TipTap/ProseMirror note editor (measured live 2026-08-10): PM rejects
    // synthetic paste/beforeinput/insertHTML/innerHTML but honours execCommand('insertText') + a
    // synthetic Enter keydown. Hard-clear via Range, then per line insert text + press Enter. A ~12ms
    // gap per line is required - a tight loop outruns PM's async commit and drops/merges lines.
    function tryPmType() {
      return new Promise(function (resolve) {
        try {
          ed.focus();
          var sel = window.getSelection(), r = document.createRange();
          r.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(r);
          document.execCommand('delete', false, null);
          var ls = String(text).replace(/\r\n/g, '\n').split('\n'), i = 0;
          (function stepLine() {
            if (i >= ls.length) { resolve(); return; }
            if (i > 0) ['keydown', 'keyup'].forEach(function (ty) { ed.dispatchEvent(new KeyboardEvent(ty, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true })); });
            if (ls[i]) document.execCommand('insertText', false, ls[i]);
            i++;
            setTimeout(stepLine, 12);
          })();
        } catch (e) { resolve(); }
      });
    }
    function settle() { return new Promise(function (r) { setTimeout(function () { r(stuck()); }, 250); }); }
    var steps = [tryPmType, tryPaste, tryHtml, trySoftLines, tryText, tryInner], stepNames = ['pmType', 'paste', 'insertHTML', 'softLines', 'insertText', 'innerHTML'];
    try { console.info('[BWN NOTES] note editor:', (ed.tagName || '?') + (ed.id ? '#' + ed.id : '') + (ed.className ? '.' + String(ed.className).split(/\s+/)[0] : ''), '| contenteditable=', ed.getAttribute && ed.getAttribute('contenteditable'), '| role=', ed.getAttribute && ed.getAttribute('role')); } catch (e) { }
    function run(i) {
      if (i >= steps.length) { try { console.warn('[BWN NOTES] note fill: NONE of the methods stuck - editor rejected all'); } catch (e) { } return Promise.resolve(stuck()); }
      return Promise.resolve(steps[i]()).then(function () { return settle(); }).then(function (ok) { try { console.info('[BWN NOTES] note fill step "' + stepNames[i] + '":', ok ? 'STUCK' : 'no'); } catch (e) { } return ok ? true : run(i + 1); });
    }
    return run(0);
  }
  // Fill an ALREADY-OPEN note composer with `text`. Waits for the tiptap editor, then fills it.
  // Insert-only: NEVER posts; the human clicks Umbrava's own Add/Save. Returns a Promise<boolean>.
  function fillNoteEditor(text) {
    return waitFor(function () {
      var eds = document.querySelectorAll('.tiptap.ProseMirror');
      for (var i = eds.length - 1; i >= 0; i--) { if (eds[i].offsetParent && eds[i].offsetWidth > 0) return eds[i]; }
      return null;
    }, 6000).then(function (ed) {
      if (!ed) { alert('Could not find the note editor - open the note composer, then pick a template.'); return false; }
      return setEditorValue(ed, text).then(function (filled) {
        if (!filled) alert('Auto-fill was blocked - type the note in, or install "BWN Suite - Drop Upload" for the clipboard fallback.');
        return filled;
      });
    });
  }

  // ===== Draft the chosen template into the composer (human-gated; never posts) =============
  // On the dispatch-board detail panel: click the note "+ Add" button to open Umbrava's own Add Note
  // modal (the SAME tiptap/ProseMirror composer as the WO page), then fill it. The dispatcher reviews,
  // fills the ______ blanks, sets the Type, and clicks Umbrava's Add/Save. We NEVER post.
  // Entry point for a picked template. Date templates (reschedule / scheduled / soonest / week-of)
  // pop a native date picker first so the blank is filled from a calendar, not typed; the rest draft
  // straight away. Either way we open Umbrava's own Add Note composer and DRAFT - we NEVER post.
  function pickTemplate(tpl) {
    if (tpl.date) { promptDateThenDraft(tpl); return; }
    draftTemplate(tpl, tpl.body);
  }
  function draftTemplate(tpl, body) {
    var addBtn = noteAddButton();
    if (!addBtn) { alert('Open a work order (board panel or WO page) on its Notes tab, then pick a template.'); return; }
    var text = buildNote({ body: body, signed: tpl.signed }, currentFirstName());
    addBtn.click();                              // open Umbrava's Add Note composer
    // Prefer drop-upload's live-tested hook when that script is also installed (coordinators); else use
    // our own inlined fill (in-house techs run this script alone). '' noteType = leave Type for the user.
    var fill = (typeof window.__bwnFillNoteEditor === 'function') ? window.__bwnFillNoteEditor : fillNoteEditor;
    try { fill(text, ''); } catch (e) { alert('Could not draft the note: ' + ((e && e.message) || e)); }
  }
  // A small popover with a native <input type="date">. Picking a date substitutes the blank and drafts;
  // "Leave blank" drafts with the ______ intact (the old behaviour). Escape / click-out cancels.
  function promptDateThenDraft(tpl) {
    var old = document.getElementById('bwn-notes-datepop'); if (old) old.remove();
    var pop = document.createElement('div');
    pop.id = 'bwn-notes-datepop';
    pop.style.cssText = 'position:fixed;z-index:99999;top:96px;left:50%;transform:translateX(-50%);min-width:264px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 12px 34px rgba(0,0,0,.22);padding:14px 16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;';
    var title = document.createElement('div');
    title.textContent = tpl.date === 'weekOf' ? 'Pick the week' : 'Pick the date';
    title.style.cssText = 'font:600 13px inherit;color:#1e293b;margin-bottom:8px;';
    var inp = document.createElement('input');
    inp.type = 'date';
    inp.style.cssText = 'font:500 14px inherit;padding:7px 9px;border:1px solid #cbd5e1;border-radius:7px;width:100%;box-sizing:border-box;color:#1e293b;';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:12px;';
    if (tpl.date === 'weekOf') {
      var hint = document.createElement('div');
      hint.textContent = "Any day in the week - we'll use that week's Monday.";
      hint.style.cssText = 'font:500 11px inherit;color:#64748b;margin-top:6px;';
      pop.appendChild(title); pop.appendChild(inp); pop.appendChild(hint);
    } else {
      pop.appendChild(title); pop.appendChild(inp);
    }
    var blank = document.createElement('button');
    blank.type = 'button'; blank.textContent = 'Leave blank';
    blank.style.cssText = 'padding:6px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:7px;cursor:pointer;font:500 12px inherit;color:#475569;';
    var use = document.createElement('button');
    use.type = 'button'; use.textContent = 'Use date';
    use.style.cssText = 'padding:6px 12px;border:none;border-radius:7px;cursor:pointer;font:600 12px inherit;color:#fff;background:' + GREEN + ';';
    row.appendChild(blank); row.appendChild(use);
    pop.appendChild(row);

    function close() {
      pop.remove();
      document.removeEventListener('mousedown', onOut, true);
      document.removeEventListener('keydown', onKey, true);
    }
    function onOut(e) { if (!pop.contains(e.target)) close(); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    function commit() {
      if (!inp.value) { inp.focus(); return; }
      var p = inp.value.split('-');            // yyyy-mm-dd
      var body = applyDate(tpl.body, tpl.date, +p[0], +p[1], +p[2]);
      close(); draftTemplate(tpl, body);
    }
    use.addEventListener('click', commit);
    inp.addEventListener('change', function () { if (inp.value) commit(); });
    blank.addEventListener('click', function () { close(); draftTemplate(tpl, tpl.body); });
    document.body.appendChild(pop);
    setTimeout(function () {
      document.addEventListener('mousedown', onOut, true);
      document.addEventListener('keydown', onKey, true);
      try { inp.focus(); if (inp.showPicker) inp.showPicker(); } catch (e) { }   // open the OS calendar
    }, 0);
  }

  // Cross-script bridge to the AI script over the DOM event bus. The AI script is GM_-sandboxed and
  // cannot read this @grant-none script's page-window globals, so we don't expose a global - we answer
  // the bus: on `notes:tpl:req` reply with a serializable list (no functions cross the sandbox), and on
  // `notes:tpl:pick` run our own pickTemplate (the bodies, the calendar and the fill all live here). A
  // req also tells us an AI script is present and will render the merged "Draft", so we stand our own
  // WO-page button down (aiWantsMerge) to avoid a double button.
  var aiWantsMerge = false;
  function tplList() {
    return TEMPLATES.map(function (g, gi) {
      return { group: g.group, items: g.items.map(function (t, ii) { return { id: gi + ':' + ii, label: t.label, date: t.date || null }; }) };
    });
  }
  function tplById(id) {
    var p = String(id).split(':'), g = TEMPLATES[+p[0]];
    return g ? g.items[+p[1]] : null;
  }
  function announceTpl() { try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'notes:tpl:list', groups: tplList() } })); } catch (e) { } }
  document.addEventListener('bwn:cmd', function (e) {
    var d = e && e.detail; if (!d) return;
    if (d.id === 'notes:tpl:req') {
      aiWantsMerge = true;
      var own = document.getElementById(WO_BTN_ID); if (own) own.remove();   // AI owns the merged Draft
      announceTpl();
    } else if (d.id === 'notes:tpl:pick') {
      var t = tplById(d.tplId); if (t) pickTemplate(t);
    }
  });
  announceTpl();   // broadcast once on load too, for an AI script that mounted before it could ask

  // ===== "Spoke with" vendor tag (WO page only) ===========================================
  // Coordinator flow: click "Spoke with" -> pick/type the vendor -> we open Umbrava's Add Note
  // composer (or reuse an open one), stamp "[Spoke with: <Vendor>]" at the TOP (above any template
  // already drafted), and leave it for the human to finish + Save. NEVER auto-posted, like templates.
  var VENDOR_MRU_KEY = 'bwn:notes:vendors';
  function recentVendors() { try { var a = JSON.parse(localStorage.getItem(VENDOR_MRU_KEY)); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  function rememberVendor(v) { try { localStorage.setItem(VENDOR_MRU_KEY, JSON.stringify(mruAdd(recentVendors(), v, 20))); } catch (e) { } }

  // The visible note editor, if the composer is open (mirrors fillNoteEditor's own probe).
  function visibleEditor() {
    var eds = document.querySelectorAll('.tiptap.ProseMirror');
    for (var i = eds.length - 1; i >= 0; i--) { if (eds[i].offsetParent && eds[i].offsetWidth > 0) return eds[i]; }
    return null;
  }
  // Plain text currently in the open composer, so the tag can be prepended without clobbering a
  // template already drafted. innerText keeps line breaks; collapse runaway blank lines, trim tail.
  function currentEditorText() {
    var ed = visibleEditor();
    if (!ed) return '';
    return (ed.innerText || ed.textContent || '').replace(/ /g, ' ').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  }
  // Open the composer if needed, then re-fill it with the tag prepended to whatever is there.
  function tagSpokeWith(vendor) {
    if (!visibleEditor()) {
      var add = noteAddButton();
      if (!add) { alert('Open a work order on its Notes tab, then use "Spoke with".'); return; }
      add.click();                              // open Umbrava's Add Note composer
    }
    var fill = (typeof window.__bwnFillNoteEditor === 'function') ? window.__bwnFillNoteEditor : fillNoteEditor;
    waitFor(visibleEditor, 6000).then(function (ed) {
      if (!ed) { alert('Could not find the note editor - open the note composer, then use "Spoke with".'); return; }
      var text = prependSpokeTag(currentEditorText(), vendor);
      try { fill(text, ''); } catch (e) { alert('Could not draft the note: ' + ((e && e.message) || e)); }
    });
  }
  // Small popover: a vendor text field with a <datalist> of the user's recent vendors (pick or type
  // any name). "Add tag" stamps it; Escape / click-out cancels. Sibling of promptDateThenDraft.
  // ponytail: the suggestion list is the user's own recent vendors (localStorage), zero network. To
  // offer ALL area vendors for the WO instead, seed the datalist from getAssignableVendors via a
  // same-origin /api/graphql read (BWN-SHARED authToken + WO number from the URL) - a bigger change to
  // this @grant-none standalone script, added only if recents + free-type prove not enough.
  function promptVendorThenTag() {
    var old = document.getElementById('bwn-notes-vendorpop'); if (old) old.remove();
    var pop = document.createElement('div');
    pop.id = 'bwn-notes-vendorpop';
    pop.style.cssText = 'position:fixed;z-index:99999;top:96px;left:50%;transform:translateX(-50%);min-width:280px;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 12px 34px rgba(0,0,0,.22);padding:14px 16px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;';
    var title = document.createElement('div');
    title.textContent = 'Which vendor did you speak with?';
    title.style.cssText = 'font:600 13px inherit;color:#1e293b;margin-bottom:8px;';
    var recents = recentVendors();
    var inp = document.createElement('input');
    inp.type = 'text'; inp.setAttribute('list', 'bwn-notes-vendorlist'); inp.setAttribute('autocomplete', 'off');
    inp.placeholder = 'Vendor name';
    inp.style.cssText = 'font:500 14px inherit;padding:7px 9px;border:1px solid #cbd5e1;border-radius:7px;width:100%;box-sizing:border-box;color:#1e293b;';
    var dl = document.createElement('datalist'); dl.id = 'bwn-notes-vendorlist';
    recents.forEach(function (v) { var o = document.createElement('option'); o.value = v; dl.appendChild(o); });
    var hint = document.createElement('div');
    hint.textContent = recents.length ? 'Pick a recent vendor or type any name.' : 'Type the vendor name.';
    hint.style.cssText = 'font:500 11px inherit;color:#64748b;margin-top:6px;';
    var row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;align-items:center;margin-top:12px;';
    var cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.style.cssText = 'padding:6px 10px;border:1px solid #cbd5e1;background:#fff;border-radius:7px;cursor:pointer;font:500 12px inherit;color:#475569;';
    var use = document.createElement('button');
    use.type = 'button'; use.textContent = 'Add tag';
    use.style.cssText = 'padding:6px 12px;border:none;border-radius:7px;cursor:pointer;font:600 12px inherit;color:#fff;background:' + GREEN + ';';
    row.appendChild(cancel); row.appendChild(use);
    pop.appendChild(title); pop.appendChild(inp); pop.appendChild(dl); pop.appendChild(hint); pop.appendChild(row);

    function close() {
      pop.remove();
      document.removeEventListener('mousedown', onOut, true);
      document.removeEventListener('keydown', onKey, true);
    }
    function onOut(e) { if (!pop.contains(e.target)) close(); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    function commit() {
      var vendor = inp.value.trim();
      if (!vendor) { inp.focus(); return; }
      rememberVendor(vendor);
      close();
      tagSpokeWith(vendor);
    }
    use.addEventListener('click', commit);
    cancel.addEventListener('click', function () { close(); });
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    document.body.appendChild(pop);
    setTimeout(function () {
      document.addEventListener('mousedown', onOut, true);
      document.addEventListener('keydown', onKey, true);
      try { inp.focus(); } catch (e) { }
    }, 0);
  }
  function buildSpokeButton() {
    var b = document.createElement('button');
    b.type = 'button';
    b.textContent = 'Spoke with';
    b.title = 'Tag this note with the vendor you spoke with';
    b.style.cssText = 'min-width:96px;padding:6px 12px;font:500 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#1a5f3e;background:#fff;border:1px solid #1a5f3e;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;';
    b.addEventListener('click', function (e) { e.preventDefault(); promptVendorThenTag(); });
    return b;
  }

  // ===== The dropdown (self-contained; fixed-positioned so no ancestor clips it) ============
  function buildDropdown() {
    var wrap = document.createElement('span');
    wrap.style.cssText = 'display:inline-flex;vertical-align:middle;';
    var trig = document.createElement('button');
    trig.type = 'button';
    trig.setAttribute('aria-haspopup', 'menu');
    trig.setAttribute('aria-expanded', 'false');
    trig.style.cssText = 'min-width:96px;padding:6px 12px;font:500 14px/1 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#fff;border:none;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;gap:7px;background:' + GREEN + ';';
    var lab = document.createElement('span'); lab.textContent = 'Templates';
    var car = document.createElement('span'); car.textContent = '▾'; car.setAttribute('aria-hidden', 'true'); car.style.cssText = 'font-size:10px;opacity:.85;';
    trig.appendChild(lab); trig.appendChild(car);
    wrap.appendChild(trig);

    var menu = null;
    function close() {
      if (!menu) return;
      menu.remove(); menu = null;
      trig.setAttribute('aria-expanded', 'false');
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close, true);
    }
    function onDoc(e) { if (menu && !menu.contains(e.target) && !trig.contains(e.target)) close(); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    function open() {
      menu = document.createElement('div');
      menu.setAttribute('role', 'menu');
      menu.setAttribute('aria-label', 'Note templates');
      menu.style.cssText = 'position:fixed;z-index:99998;min-width:300px;max-height:72vh;overflow:auto;background:#fff;border:1px solid #e2e8f0;border-radius:10px;box-shadow:0 10px 30px rgba(0,0,0,.18);padding:6px;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;';
      TEMPLATES.forEach(function (grp) {
        var h = document.createElement('div');
        h.textContent = grp.group;
        h.style.cssText = 'padding:8px 10px 4px;font:700 10px ui-monospace,"Segoe UI Mono",monospace;letter-spacing:.6px;text-transform:uppercase;color:#64748b;';
        menu.appendChild(h);
        grp.items.forEach(function (tpl) {
          var row = document.createElement('button');
          row.type = 'button'; row.setAttribute('role', 'menuitem'); row.tabIndex = -1;
          row.textContent = tpl.label;
          row.style.cssText = 'display:block;width:100%;box-sizing:border-box;text-align:left;padding:8px 10px;border:none;background:transparent;border-radius:7px;cursor:pointer;font:500 13px -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#1e293b;';
          row.addEventListener('mouseenter', function () { row.style.background = '#f0fdf4'; });
          row.addEventListener('mouseleave', function () { row.style.background = 'transparent'; });
          row.addEventListener('click', function (e) { e.preventDefault(); close(); pickTemplate(tpl); });
          menu.appendChild(row);
        });
      });
      document.body.appendChild(menu);
      var r = trig.getBoundingClientRect();
      var w = menu.offsetWidth || 300;
      menu.style.top = Math.round(r.bottom + 4) + 'px';
      menu.style.left = Math.round(Math.min(r.left, window.innerWidth - w - 8)) + 'px';
      trig.setAttribute('aria-expanded', 'true');
      document.addEventListener('mousedown', onDoc, true);
      document.addEventListener('keydown', onKey, true);
      window.addEventListener('scroll', close, true);
      window.addEventListener('resize', close, true);
    }
    trig.addEventListener('click', function (e) { e.preventDefault(); if (menu) close(); else open(); });
    return wrap;
  }

  // ===== Mount beside the note "+ Add" in the dispatch-board detail panel ====================
  // The panel's Notes tab has a search box ("Search note description and type") and a "+ Add" button
  // beside it (no testid, build-hashed class). Anchor via the search placeholder - user-facing and
  // stable - then take the adjacent "Add" button. Its click opens Umbrava's Add Note modal (the same
  // tiptap composer as the WO page - verified live 2026-08-13).
  var BTN_ID = 'bwn-notes-dd';
  function noteSearchInput() {
    var ins = document.querySelectorAll('input');
    for (var i = 0; i < ins.length; i++) {
      if (ins[i].offsetParent && /note description/i.test(ins[i].getAttribute('placeholder') || '')) return ins[i];
    }
    return null;
  }
  // The clickable note "Add" trigger, in EITHER notes state:
  //  - populated: the toolbar "+ Add" button beside the "note description" search box (live-tested).
  //  - empty ("No Notes / Click Add to create a new Note"): the inline "Add" link - the panel has no
  //    search box or toolbar then. pickTemplate clicks whichever we return to open the Add composer.
  function toolbarAdd(s) {
    var row = s;
    for (var d = 0; d < 5 && row; d++) {
      var btns = row.querySelectorAll ? row.querySelectorAll('button') : [];
      for (var j = 0; j < btns.length; j++) {
        if (btns[j].offsetParent && /^\+?\s*add$/i.test((btns[j].textContent || '').trim())) return btns[j];
      }
      row = row.parentElement;
    }
    return null;
  }
  // The "Add" word inside the empty-notes prompt. Match an element whose WHOLE text is "Add" and that
  // sits within the "...create a new Note" prompt, so we never grab some other "Add" on the panel.
  function emptyStateAdd() {
    var els = document.querySelectorAll('a,button,[role="button"],span');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.offsetParent || (el.textContent || '').trim().toLowerCase() !== 'add') continue;
      var ctx = el;
      for (var d = 0; d < 4 && ctx; d++) {
        if (/create a new note/i.test(ctx.textContent || '')) return el;
        ctx = ctx.parentElement;
      }
    }
    return null;
  }
  // The full WO page (/work-orders/<id>) has an "Add Note" button (not the board's "+ Add"). Needed so
  // a template picked from the merged "Draft" flyout can open the composer there too.
  function woAddNote() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (btns[i].offsetParent && /^add note$/i.test((btns[i].textContent || '').trim())) return btns[i];
    }
    return null;
  }
  function noteAddButton() {
    var s = noteSearchInput();
    if (s) return toolbarAdd(s);              // board, populated
    return woAddNote() || emptyStateAdd();    // WO page "Add Note", else board empty-state "Add"
  }
  // The Trips/Notes/Docs/Proposals tab strip - the band the toolbar (and Templates) normally sits
  // under. Used to place the button there in the empty state, where there is no toolbar to anchor to,
  // so it lands as close to its populated spot (screenshot: left of "+ Add") as the empty DOM allows.
  function notesTabStrip() {
    var els = document.querySelectorAll('button,a,[role="tab"]');
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (!el.offsetParent || (el.textContent || '').trim() !== 'Notes') continue;
      var strip = el.parentElement;
      for (var d = 0; d < 3 && strip; d++) {
        var t = strip.textContent || '';
        if (/Trips/.test(t) && /Docs/.test(t)) return strip;
        strip = strip.parentElement;
      }
    }
    return null;
  }
  function mount() {
    var existing = document.getElementById(BTN_ID);
    if (existing && existing.isConnected) return true;
    var search = noteSearchInput();
    var addBtn = search ? toolbarAdd(search) : emptyStateAdd();
    if (!addBtn || !addBtn.parentNode) return false;
    var bar = document.createElement('span');
    bar.id = BTN_ID;
    bar.appendChild(buildDropdown());
    if (search) {
      // Populated: a real toolbar exists - sit just left of "+ Add" (screenshot: Search | Templates | + Add).
      bar.style.cssText = 'display:inline-flex;align-items:center;vertical-align:middle;margin-right:8px;';
      addBtn.parentNode.insertBefore(bar, addBtn);
    } else {
      // Empty ("No Notes"): no toolbar to anchor to. Drop it into the Trips/Notes/Docs tab-strip band so
      // it lands as close to the populated spot as the empty DOM allows, instead of wedging mid-sentence
      // beside the inline "Add". Fall back to beside "Add" only if the strip isn't found, so it still shows.
      var strip = notesTabStrip();
      if (strip && strip.parentNode) {
        // ponytail: float:right right-aligns it in the band without knowing the strip's flex/grid setup;
        // swap to the container's own layout once the empty-state DOM is measured live.
        bar.style.cssText = 'display:inline-flex;align-items:center;float:right;margin:6px 6px 0 8px;';
        strip.parentNode.insertBefore(bar, strip.nextSibling);
      } else {
        bar.style.cssText = 'display:inline-flex;align-items:center;vertical-align:middle;margin:0 6px;';
        addBtn.parentNode.insertBefore(bar, addBtn);
      }
    }
    console.info('[BWN NOTES] template dropdown mounted (notes ' + (search ? 'toolbar' : 'empty state') + ')');
    return true;
  }

  // The regular WO page (/work-orders/<id>) has no board toolbar - anchor a "Templates" button left of
  // "Add Note". Only for techs whose machine has NO AI script: when the AI script is present it asks us
  // over the bus (aiWantsMerge) and renders the merged "Draft" instead, so we stand down.
  var WO_BTN_ID = 'bwn-notes-wo-dd';
  function aiDraftPresent() { return !!document.getElementById('bwn-client-update-btn'); }
  function woMount() {
    // Stand our standalone button down whenever the AI script's Draft button is up (it renders the
    // merged flyout). Check the DOM, not just the bus flag: the AI script can pick up our load-time
    // broadcast without ever sending a req we hear, so the flag alone missed it and both mounted.
    if (aiWantsMerge || aiDraftPresent()) { var claimed = document.getElementById(WO_BTN_ID); if (claimed) claimed.remove(); return true; }
    var ex = document.getElementById(WO_BTN_ID);
    if (ex && ex.isConnected) return true;
    var add = woAddNote();
    if (!add || !add.parentNode) return false;
    var bar = document.createElement('span');
    bar.id = WO_BTN_ID;
    bar.style.cssText = 'display:inline-flex;align-items:center;vertical-align:middle;margin-right:8px;';
    bar.appendChild(buildDropdown());
    add.parentNode.insertBefore(bar, add);            // sit just left of "Add Note"
    console.info('[BWN NOTES] template dropdown mounted (WO page, standalone)');
    return true;
  }
  // The WO-page "Spoke with" button - stamps a [Spoke with: <Vendor>] tag at the top of a note so a
  // coordinator can record which of several WO vendors they spoke with. WO PAGE ONLY (not the board).
  // Independent of the Templates / AI-Draft merge above: it is a distinct affordance, so it mounts
  // beside "Add Note" whether or not the AI Draft button is present.
  var SPOKE_BTN_ID = 'bwn-notes-spoke';
  function mountSpoke() {
    var ex = document.getElementById(SPOKE_BTN_ID);
    if (ex && ex.isConnected) return true;
    var add = woAddNote();
    if (!add || !add.parentNode) return false;
    var bar = document.createElement('span');
    bar.id = SPOKE_BTN_ID;
    bar.style.cssText = 'display:inline-flex;align-items:center;vertical-align:middle;margin-right:8px;';
    bar.appendChild(buildSpokeButton());
    add.parentNode.insertBefore(bar, add);            // sit just left of "Add Note"
    console.info('[BWN NOTES] "Spoke with" button mounted (WO page)');
    return true;
  }
  // Route-aware tick: the board panel uses mount() (search / empty-state / tab-strip anchors), the WO
  // page uses woMount() for templates + mountSpoke() for the vendor tag. Returns true when nothing is
  // left to do so the poll can rest (run both WO mounts each tick - don't short-circuit one).
  function tick() {
    if (/dispatch-board/.test(location.pathname)) return mount();
    if (/\/work-orders\//.test(location.pathname)) { var tpl = woMount(); var spoke = mountSpoke(); return tpl && spoke; }
    return true;
  }
  var pollTimer = null;
  function schedule() {
    if (tick()) { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } return; }
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (tick()) { clearInterval(pollTimer); pollTimer = null; }
    }, 400);
  }
  var obs = new MutationObserver(schedule);
  obs.observe(document.body, { childList: true, subtree: true });
  schedule();
})();
