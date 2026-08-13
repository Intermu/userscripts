// ==UserScript==
// @name         BWN Suite - Note Templates (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.1.0
// @description  Canned dispatch-note templates in a dropdown beside "Add Note" on an Umbrava work order. Picking a template DRAFTS it into the note composer (signed with your first name, blanks left for you to fill) - it is NEVER auto-posted. Reuses bwn-drop-upload's live-tested ProseMirror inserter via the page-window hook window.__bwnInsertNote, so the fragile editor-fill code is not duplicated. @grant none, zero egress.
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
      { label: 'Tech called out - reschedule for ___', signed: false,
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
      { label: 'Scheduled for ___', signed: true,
        body: 'Hi Team, this has been scheduled for ______\nThank you' },
      { label: 'No availability until week of ___ - redirect', signed: true,
        body: "Hi team, at this time we don't have availability in this area until the week of _______ , apologies please redirect" },
      { label: 'Soonest on-site ___ - schedule or redirect', signed: true,
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
  // BWN-NOTES-SLICE-END

  function currentFirstName() {
    try {
      var k = Object.keys(localStorage).find(function (x) { return /@@auth0spajs@@::.*::@@user@@/.test(x); });
      var u = k ? ((JSON.parse(localStorage.getItem(k)) || {}).decodedToken || {}).user : null;
      return firstNameFromUser(u);
    } catch (e) { return ''; }
  }

  // ===== Draft the chosen template into the composer (human-gated; never posts) =============
  function pickTemplate(tpl) {
    if (typeof window.__bwnInsertNote !== 'function') {
      alert('The note inserter is not available.\n\nThe "BWN Suite - Drop Upload" script provides it - make sure that script is enabled and up to date, then try again.');
      return;
    }
    var text = buildNote(tpl, currentFirstName());
    // '' = leave the note Type for the dispatcher to pick. Insert-only: bwn-drop-upload opens the
    // composer and fills it; the human reviews, fills the blanks, sets the Type, and clicks Save.
    try { window.__bwnInsertNote(text, ''); } catch (e) { alert('Could not draft the note: ' + ((e && e.message) || e)); }
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
    var lab = document.createElement('span'); lab.textContent = 'Notes';
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

  // ===== Mount beside "Add Note" (mirrors bwn-suite-ai's AI-Draft mount) ====================
  var BTN_ID = 'bwn-notes-dd';
  function addNoteButton() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) { if (/add note/i.test((btns[i].textContent || '').trim())) return btns[i]; }
    return null;
  }
  function notesLoaded() { return !!document.querySelector('[data-testid^="wo-note-"][data-testid$="-summary"]'); }
  function mount() {
    if (document.getElementById(BTN_ID)) return true;
    if (!notesLoaded()) return false;
    var bar = document.createElement('span');
    bar.id = BTN_ID;
    bar.style.cssText = 'display:inline-flex;align-items:center;vertical-align:middle;margin-right:8px;';
    bar.appendChild(buildDropdown());
    var addNote = addNoteButton();
    if (addNote && addNote.parentNode) {
      addNote.parentNode.insertBefore(bar, addNote);   // sit just left of Add Note
    } else {
      var dl = document.querySelector('[data-testid="download-notes-button"]');
      if (dl && dl.parentNode) {
        dl.parentNode.insertBefore(bar, dl.nextSibling);
      } else {
        bar.style.cssText += 'position:fixed;bottom:20px;right:78px;z-index:99999;box-shadow:0 4px 14px rgba(0,0,0,.25);';
        document.body.appendChild(bar);   // right:78px so it clears bwn-suite-ai's AI-Draft float
      }
    }
    console.info('[BWN NOTES] template dropdown mounted');
    return true;
  }

  var pollTimer = null;
  function schedule() {
    if (mount()) { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } return; }
    if (pollTimer) return;
    pollTimer = setInterval(function () {
      if (mount() || !/\/work-orders\//.test(location.pathname)) { clearInterval(pollTimer); pollTimer = null; }
    }, 300);
  }
  var obs = new MutationObserver(schedule);
  obs.observe(document.body, { childList: true, subtree: true });
  schedule();
})();
