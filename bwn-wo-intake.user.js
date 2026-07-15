// ==UserScript==
// @name         BWN WO Intake (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.1.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-wo-intake.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-wo-intake.user.js
// @description  Drop a client PO email (.msg or .eml) onto the Create Work Order modal and it prefills the fields (Source PO #, scope, client, location, NTE) from the email. Reads the email entirely in the browser - nothing is uploaded. (Auto-attaching the email + its files to the new WO's Documents is the next stage.) Best-effort: review every field before you click Create.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  var VER = '0.1.0';
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  console.info('[BWN WO INTAKE] v' + VER + ' - drop a PO email (.msg/.eml) on Create Work Order to prefill; reads locally, nothing leaves the browser');

  function toast(msg, ms) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:26px;transform:translateX(-50%);background:#0d3d26;color:#fff;font:400 14px ' + FONT + ';padding:11px 16px;border-radius:9px;max-width:70vw;box-shadow:0 6px 24px rgba(0,0,0,.3);line-height:1.45;';
    document.body.appendChild(t);
    setTimeout(function () { t.style.transition = 'opacity .4s'; t.style.opacity = '0'; setTimeout(function () { t.remove(); }, 420); }, ms || 6000);
  }
  function setNativeValue(el, val) {
    var proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype : (el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype);
    var setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // ---- Email parsing (local) ----------------------------------------------
  // .eml is MIME text (easy). .msg is Outlook OLE2 (binary) - a full parse needs a library,
  // but the CORE fields (subject, sender) are UTF-16 strings we can pull heuristically, which
  // is enough for PO # / client / location / NTE. The full body + attachments are stage 2.
  function u8FromBuf(buf) { return new Uint8Array(buf); }
  function utf16Runs(u8, min) {
    var runs = [], cur = '';
    for (var i = 0; i + 1 < u8.length; i += 2) { var lo = u8[i], hi = u8[i + 1]; if (hi === 0 && lo >= 0x20 && lo < 0x7f) cur += String.fromCharCode(lo); else { if (cur.length >= (min || 4)) runs.push(cur); cur = ''; } }
    if (cur.length >= (min || 4)) runs.push(cur);
    return runs;
  }
  function asciiRuns(u8, min) {
    var runs = [], cur = '';
    for (var i = 0; i < u8.length; i++) { var c = u8[i]; if (c >= 0x20 && c < 0x7f) cur += String.fromCharCode(c); else { if (cur.length >= (min || 6)) runs.push(cur); cur = ''; } }
    if (cur.length >= (min || 6)) runs.push(cur);
    return runs;
  }
  function uniq(a) { var s = {}, o = []; a.forEach(function (x) { if (!s[x]) { s[x] = 1; o.push(x); } }); return o; }
  function allEmails(list) {
    var out = [];
    list.forEach(function (s) { var m = s.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g); if (m) m.forEach(function (e) { out.push(e.toLowerCase()); }); });
    return uniq(out);
  }
  function parseMsg(u8) {
    var u16 = uniq(utf16Runs(u8, 4)), asc = uniq(asciiRuns(u8, 6)), all = u16.concat(asc);
    var subjCand = u16.filter(function (s) { return /purchase order|work order|\border\b|store|invoice|\bPO\b/i.test(s) && s.length >= 10 && s.length < 220 && !/^__|@@|x-ms|content-|received:|dkim|arc-/i.test(s); });
    subjCand.sort(function (a, b) { return b.length - a.length; });
    var subject = (subjCand[0] || '').replace(/^\s*subject:\s*/i, '').trim();
    var emails = allEmails(all);
    var ext = emails.filter(function (e) { return !/broadwaynational\.com|microsoft|outlook|exchange|salesforce|\.onmicrosoft\./i.test(e); });
    var money = null; all.forEach(function (s) { var m = s.match(/\$\s?([\d,]+(?:\.\d{2})?)/); if (m && !money) money = m[1].replace(/,/g, ''); });
    // body-ish: the longest few utf16 runs that aren't headers/stream names
    var body = u16.filter(function (s) { return s.length >= 25 && !/^__|@@|x-ms|content-|received:|dkim|arc-|authentication|=exchange/i.test(s); }).slice(0, 8).join('\n');
    return { subject: subject, senderEmail: ext[0] || emails[0] || '', money: money, body: body, kind: 'msg' };
  }
  function parseEml(text) {
    var headEnd = text.search(/\r?\n\r?\n/);
    var head = headEnd >= 0 ? text.slice(0, headEnd) : text;
    function h(name) { var m = head.match(new RegExp('^' + name + ':\\s*(.*(?:\\r?\\n[ \\t].*)*)', 'im')); return m ? m[1].replace(/\r?\n[ \t]+/g, ' ').trim() : ''; }
    var subject = h('Subject').replace(/=\?[^?]+\?[bq]\?[^?]*\?=/gi, function (s) { return s; }); // (best-effort; leave MIME-encoded as-is)
    var from = h('From');
    var em = (from.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/) || [''])[0].toLowerCase();
    var body = headEnd >= 0 ? text.slice(headEnd).replace(/=\r?\n/g, '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ') : '';
    var money = (body.match(/\$\s?([\d,]+(?:\.\d{2})?)/) || [])[1];
    return { subject: subject, senderEmail: em, money: money ? money.replace(/,/g, '') : null, body: body.slice(0, 4000), kind: 'eml' };
  }

  // Known client domains -> the exact name to search in Umbrava's Client picker. Extend as needed.
  var CLIENT_BY_DOMAIN = {
    'pilottravelcenters.com': 'Pilot Travel Centers',
    'staples.com': 'Staples'
  };
  function clientFromDomain(email) {
    var dom = String(email || '').split('@')[1] || '';
    if (CLIENT_BY_DOMAIN[dom]) return CLIENT_BY_DOMAIN[dom];
    // fallback: the domain base, so the user can at least see/adjust it in the picker
    return dom.replace(/\.(com|net|org|us|co)$/i, '').replace(/[.\-]/g, ' ');
  }
  function extractWo(p) {
    var subj = p.subject || '', out = { po: '', sourceJob: '', client: '', location: '', scope: '', nte: p.money || '' };
    var mpo = subj.match(/(?:purchase order|source po|po)\s*#?\s*:?\s*(\d{6,})/i) || subj.match(/\b(\d{9,})\b/);
    if (mpo) out.po = mpo[1];
    var loc = [];
    var mstore = subj.match(/store\s*#?\s*:?\s*(\d{2,})/i) || subj.match(/\bPFJ\s*(\d{2,})/i);
    if (mstore) loc.push('Store ' + mstore[1]);
    var mtc = subj.match(/travel center|flying j|distribution center/i); if (mtc) loc.push(mtc[0]);
    out.location = loc.join(' - ');
    out.client = clientFromDomain(p.senderEmail);
    // scope draft: subject minus the PO#/store noise, plus the first body line(s)
    var scope = subj.replace(/purchase order\s*:?\s*\d+/i, '').replace(/\s{2,}/g, ' ').trim();
    if (p.body) { var firstBody = String(p.body).split(/\n/).map(function (l) { return l.trim(); }).filter(function (l) { return l.length > 15; })[0] || ''; if (firstBody) scope += (scope ? ' - ' : '') + firstBody; }
    out.scope = scope.slice(0, 400);
    return out;
  }

  // ---- Create WO modal --------------------------------------------------------
  function woModal() {
    var s = document.querySelector('textarea#scopeOfWork') || document.querySelector('input#client-dropdown');
    return s ? (s.closest('.MuiDialog-container, [role="dialog"], .MuiPaper-root') || null) : null;
  }
  function pretype(root, sel, val, label) {
    if (!val) return false;
    var el = root.querySelector(sel); if (!el) return false;
    el.focus(); setNativeValue(el, val);
    return true;
  }
  function fillWo(root, wo) {
    var done = [], assist = [];
    function setV(sel, v, label) { var el = root.querySelector(sel); if (el && v) { setNativeValue(el, v); done.push(label); } }
    setV('textarea#scopeOfWork', wo.scope, 'Scope');
    setV('input#sourcePurchaseOrderNumber', wo.po, 'Source PO #');
    setV('input#sourceJobNumber', wo.sourceJob, 'Source Job #');
    setV('input#vendorNotToExceed', wo.nte, 'Vendor NTE');   // only if the Manual-Dispatch field is present
    // Client / Location are dependent MUI autocompletes: pre-type the guess, user picks the option.
    if (pretype(root, 'input#client-dropdown', wo.client)) assist.push('Client "' + wo.client + '"');
    // Location depends on the client being chosen first, so only a hint is offered.
    var notes = [];
    if (done.length) notes.push('Filled ' + done.join(', '));
    if (assist.length) notes.push('typed ' + assist.join(' / ') + ' - pick from the list');
    if (wo.location) notes.push('Location hint: ' + wo.location + ' (set after Client)');
    notes.push('review before Create');
    toast('From the PO email: ' + notes.join(' · '), 13000);
    // Stash the dropped file for the (stage 2) post-create Documents upload.
    try { PENDING_EMAIL = wo._file || null; } catch (e) { }
  }

  var PENDING_EMAIL = null;

  async function handleDrop(file, root) {
    try {
      var name = (file.name || '').toLowerCase();
      var parsed;
      if (/\.eml$/.test(name) || file.type === 'message/rfc822') {
        parsed = parseEml(await file.text());
      } else {
        parsed = parseMsg(u8FromBuf(await file.arrayBuffer()));
      }
      if (!parsed.subject && !parsed.senderEmail) { toast('Could not read that email. Save it as a .msg or .eml file and drop the file (dragging straight from Outlook often gives the browser nothing).', 12000); return; }
      var wo = extractWo(parsed); wo._file = file;
      fillWo(root, wo);
    } catch (e) { toast('Could not read the email: ' + ((e && e.message) || e), 10000); }
  }

  // ---- Drop zone injected into the Create WO modal ----------------------------
  function injectDropZone() {
    var root = woModal();
    if (!root) return;
    if (root.querySelector('#bwn-wo-drop')) return;
    var dz = document.createElement('div');
    dz.id = 'bwn-wo-drop';
    dz.style.cssText = 'margin:14px 0 0;padding:16px;border:2px dashed #1a5f3e;border-radius:10px;background:#f3f7f5;color:#0d3d26;font:500 14px ' + FONT + ';text-align:center;cursor:pointer;line-height:1.5;';
    dz.innerHTML = '📧 Drop the PO email here to prefill<div style="font:400 12px ' + FONT + ';color:#5a6b62;margin-top:4px;">saved .msg or .eml file - read locally, nothing leaves your browser</div>';
    var file = document.createElement('input'); file.type = 'file'; file.accept = '.msg,.eml,message/rfc822,application/vnd.ms-outlook'; file.style.display = 'none';
    dz.appendChild(file);
    dz.addEventListener('click', function (e) { if (e.target !== file) { file.value = ''; file.click(); } });
    file.addEventListener('change', function () { if (file.files && file.files[0]) handleDrop(file.files[0], woModal() || root); });
    function stop(e) { e.preventDefault(); e.stopPropagation(); }
    dz.addEventListener('dragover', function (e) { stop(e); dz.style.background = '#e2efe9'; });
    dz.addEventListener('dragleave', function (e) { stop(e); dz.style.background = '#f3f7f5'; });
    dz.addEventListener('drop', function (e) {
      stop(e); dz.style.background = '#f3f7f5';
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) handleDrop(f, woModal() || root);
      else toast('No file came through. Dragging directly from Outlook often does not - save the email as a .msg first, then drag that file (or click the box to pick it).', 12000);
    });
    // Place it in the right-hand column under the dispatch section (the empty space); fall back
    // to the modal bottom if that column can't be found.
    var anchor = root.querySelector('input#vendorNotToExceed');
    var col = anchor ? (anchor.closest('.MuiGrid-item, .MuiGrid-root, [class*="col"]') || anchor.parentElement) : null;
    if (col && col.parentElement) col.parentElement.appendChild(dz);
    else {
      var body = root.querySelector('.MuiDialogContent-root') || root.querySelector('form') || root;
      body.appendChild(dz);
    }
  }

  var obs = new MutationObserver(function () { injectDropZone(); });
  obs.observe(document.body, { childList: true, subtree: true });
  setInterval(injectDropZone, 900);
  injectDropZone();
})();
