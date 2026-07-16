// ==UserScript==
// @name         BWN WO Intake (Broadway National)
// @namespace    broadwaynational.bwn
// @version      0.6.0
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-wo-intake.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-wo-intake.user.js
// @description  Drop a client PO email (.msg or .eml) onto the Create Work Order modal and it prefills the fields from the email body - Scope (the Description), Source PO #, then selects Client, Location (PFJ store #, zero-padded), Trade (from the asset) and Priority by clicking the real dropdown option, and fills Client DNE (the PO NTE) once the client unlocks it. Then, after you Create the WO, it hands the email to BWN Drop Upload to attach it to the new WO's Documents and draft the email note. Reads the email entirely in the browser via a built-in Outlook .msg reader; nothing is uploaded to any server. Best-effort: review every field before you click Create.
// @match        https://app.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';
  var VER = '0.6.0';
  var FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',Arial,sans-serif";
  console.info('[BWN WO INTAKE] v' + VER + ' - drop a PO email (.msg/.eml) on Create Work Order to prefill + auto-attach to the new WO Documents (via Drop Upload); reads locally, nothing leaves the browser');

  function toast(msg, ms) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;z-index:2147483647;left:50%;bottom:26px;transform:translateX(-50%);background:#0d3d26;color:#fff;font:400 14px ' + FONT + ';padding:11px 16px;border-radius:9px;max-width:74vw;box-shadow:0 6px 24px rgba(0,0,0,.3);line-height:1.5;';
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

  // ---- Outlook .msg reader (OLE2/CFBF, local) -----------------------------
  // A .msg is a compound binary file; the body/subject/sender live in named streams (some in
  // scattered mini-FAT sectors, so string-scraping only gets fragments) and each embedded
  // attachment is its own `__attach_version1.0_#N` STORAGE with child streams. This reader follows
  // the FAT / mini-FAT chains AND walks the directory red-black tree so we can pull both. In-browser.
  function parseCFBF(u8) {
    var dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    if (dv.getUint32(0, false) !== 0xD0CF11E0) return null;   // not a compound file
    var u32 = function (o) { return dv.getUint32(o, true); };
    var secSz = 1 << dv.getUint16(30, true), miniSz = 1 << dv.getUint16(32, true);
    var dirStart = u32(48), miniCut = u32(56), miniFatStart = u32(60), difatStart = u32(68);
    var secOff = function (s) { return 512 + s * secSz; };
    var fatSecs = []; for (var i = 0; i < 109; i++) { var s = u32(76 + i * 4); if (s !== 0xFFFFFFFF) fatSecs.push(s); }
    var dsx = difatStart, g = 0; while (dsx !== 0xFFFFFFFE && dsx !== 0xFFFFFFFF && g++ < 1000) { var b = secOff(dsx); for (var j = 0; j < secSz / 4 - 1; j++) { var s2 = u32(b + j * 4); if (s2 !== 0xFFFFFFFF) fatSecs.push(s2); } dsx = u32(b + secSz - 4); }
    var fat = []; fatSecs.forEach(function (f) { var base = secOff(f); for (var k = 0; k < secSz / 4; k++) fat.push(u32(base + k * 4)); });
    function chain(start, arr) { var o = [], s = start, gg = 0; while (s !== 0xFFFFFFFE && s !== 0xFFFFFFFF && gg++ < 1e6) { o.push(s); s = arr[s]; if (s == null) break; } return o; }
    function readFAT(start) { var secs = chain(start, fat), out = new Uint8Array(secs.length * secSz); secs.forEach(function (s, i) { out.set(u8.subarray(secOff(s), secOff(s) + secSz), i * secSz); }); return out; }
    var dir = readFAT(dirStart), entries = [];
    // Keep EVERY 128-byte slot so entries[did] is addressable by directory-id - the tree's
    // left/right/child pointers are DIDs, so skipping empty slots would shift every index.
    for (var o2 = 0; o2 + 128 <= dir.length; o2 += 128) {
      var nameLen = dir[o2 + 64] | (dir[o2 + 65] << 8);
      var name = ''; for (var q = 0; q < Math.max(0, nameLen - 2); q += 2) { var c = dir[o2 + q] | (dir[o2 + q + 1] << 8); if (c) name += String.fromCharCode(c); }
      entries.push({
        did: entries.length, name: name, type: dir[o2 + 66],
        left: dir[o2 + 68] | (dir[o2 + 69] << 8) | (dir[o2 + 70] << 16) | (dir[o2 + 71] * 16777216),
        right: dir[o2 + 72] | (dir[o2 + 73] << 8) | (dir[o2 + 74] << 16) | (dir[o2 + 75] * 16777216),
        child: dir[o2 + 76] | (dir[o2 + 77] << 8) | (dir[o2 + 78] << 16) | (dir[o2 + 79] * 16777216),
        startSec: dir[o2 + 116] | (dir[o2 + 117] << 8) | (dir[o2 + 118] << 16) | (dir[o2 + 119] * 16777216),
        size: (dir[o2 + 120] | (dir[o2 + 121] << 8) | (dir[o2 + 122] << 16) | (dir[o2 + 123] * 16777216))
      });
    }
    var root = entries.filter(function (e) { return e.type === 5; })[0];
    var mini = root ? readFAT(root.startSec).subarray(0, root.size) : new Uint8Array(0);
    var mfBuf = miniFatStart === 0xFFFFFFFE ? new Uint8Array(0) : readFAT(miniFatStart), miniFat = [];
    for (var mm = 0; mm + 4 <= mfBuf.length; mm += 4) miniFat.push(mfBuf[mm] | (mfBuf[mm + 1] << 8) | (mfBuf[mm + 2] << 16) | (mfBuf[mm + 3] * 16777216));
    function readStream(e) {
      if (e.size >= miniCut) return readFAT(e.startSec).subarray(0, e.size);
      var secs = chain(e.startSec, miniFat), out = new Uint8Array(secs.length * miniSz);
      secs.forEach(function (s, i) { out.set(mini.subarray(s * miniSz, s * miniSz + miniSz), i * miniSz); });
      return out.subarray(0, e.size);
    }
    var NIL = 0xFFFFFFFF;
    function childrenOf(did) {   // in-order walk of the red-black tree hanging off entries[did].child
      var out = [], e = entries[did]; if (!e || e.child === NIL) return out;
      (function walk(d) { if (d === NIL || d == null) return; var n = entries[d]; if (!n) return; walk(n.left); out.push(n); walk(n.right); })(e.child);
      return out;
    }
    var topByName = {}; if (root) childrenOf(root.did).forEach(function (e) { topByName[e.name] = e; });
    return {
      // message-level property streams live directly under the root storage
      get: function (tag) { var e = topByName['__substg1.0_' + tag]; return e ? readStream(e) : null; },
      // each embedded attachment is a `__attach_version1.0_#N` storage under the root; pull its
      // filename (3707 long / 3704 short) + mime (370E) + data (37010102 = PR_ATTACH_DATA_BIN)
      attachments: function () {
        if (!root) return [];
        var out = [];
        childrenOf(root.did).forEach(function (e) {
          if (e.type !== 1 || !/^__attach_version1\.0_/i.test(e.name)) return;
          var byName = {}; childrenOf(e.did).forEach(function (k) { byName[k.name] = k; });
          function s(tag) { var x = byName['__substg1.0_' + tag]; return x ? readStream(x) : null; }
          var nm = utf16(s('3707001F')) || latin1(s('3707001E')) || utf16(s('3704001F')) || latin1(s('3704001E')) || '';
          var mime = utf16(s('370E001F')) || latin1(s('370E001E')) || '';
          var data = s('37010102');
          if (data && data.length) out.push({ name: (nm || ('attachment' + (out.length + 1))).replace(/[\r\n\/\\]/g, '_').trim(), mime: mime, bytes: data });
        });
        return out;
      }
    };
  }
  function utf16(b) { if (!b) return ''; var s = ''; for (var i = 0; i + 1 < b.length; i += 2) { var c = b[i] | (b[i + 1] << 8); if (c) s += String.fromCharCode(c); } return s; }
  function latin1(b) { if (!b) return ''; var s = ''; for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; }
  function stripHtml(h) { return String(h || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, '\n').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(+n); }); }

  function parseMsg(u8) {
    var m = parseCFBF(u8);
    if (!m) return { subject: '', body: '', senderEmail: '', attachments: [] };
    var subject = utf16(m.get('0037001F'));
    var body = utf16(m.get('1000001F'));
    if (!body) { var html = m.get('10130102'); if (html) body = stripHtml(latin1(html)); }
    var sender = utf16(m.get('0C1F001F')) || utf16(m.get('0065001F'));
    if (!/@/.test(sender)) { var em = String(sender).match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/); sender = em ? em[0] : (String(latin1(m.get('0C1F001F') || new Uint8Array(0))).match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/) || [''])[0]; }
    var attachments = []; try { attachments = m.attachments(); } catch (e) { }
    return { subject: subject, body: body, senderEmail: (sender || '').toLowerCase(), attachments: attachments };
  }
  function parseEml(text) {
    var he = text.search(/\r?\n\r?\n/);
    var head = he >= 0 ? text.slice(0, he) : text;
    function h(name) { var mm = head.match(new RegExp('^' + name + ':\\s*(.*(?:\\r?\\n[ \\t].*)*)', 'im')); return mm ? mm[1].replace(/\r?\n[ \t]+/g, ' ').trim() : ''; }
    var from = h('From');
    var em = (from.match(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/) || [''])[0].toLowerCase();
    var body = he >= 0 ? text.slice(he) : '';
    if (/<[a-z!]/i.test(body)) body = stripHtml(body);
    body = body.replace(/=\r?\n/g, '').replace(/=3D/g, '=');
    return { subject: h('Subject'), body: body, senderEmail: em, attachments: [] };   // .eml MIME-part attachments not yet extracted
  }

  // ---- Email -> Work Order field mapping ----------------------------------
  var CLIENT_BY_DOMAIN = { 'pilottravelcenters.com': 'Pilot Travel Centers', 'staples.com': 'Staples' };
  function clientFromDomain(email) { var d = String(email || '').split('@')[1] || ''; return CLIENT_BY_DOMAIN[d] || d.replace(/\.(com|net|org|us|co)$/i, '').replace(/[.\-]/g, ' '); }
  // The asset name describes the work, so it drives the Trade. Keyword map; unknown -> '' so
  // the user picks (logic takeover). Extend as new asset wordings show up.
  function assetToTrade(asset) {
    var s = String(asset || '').toLowerCase();
    if (/light|lamp|pole|fixture|bulb|luminaire/.test(s)) return /out.?side|exterior|parking|canopy|pole|lot|yard|site/.test(s) ? 'Exterior Lighting' : 'Lighting';
    if (/hvac|heat|cool|\bac\b|air cond|\brtu\b|furnace|condenser|refriger|freezer|cooler|chiller/.test(s)) return 'HVAC';
    if (/plumb|toilet|drain|water heater|sink|faucet|urinal|sewer|grease/.test(s)) return 'Plumbing';
    if (/electric|breaker|panel|wiring|outlet|transformer|generator/.test(s)) return 'Electrical';
    if (/door|hardware|overhead|dock/.test(s)) return 'Doors and Hardware';
    if (/\block\b|padlock|deadbolt|keyed/.test(s)) return 'Locks';
    if (/\bsign|signage|reader board|monument|marquee/.test(s)) return 'Signage';
    if (/roof|\bleak\b|gutter|fascia|soffit|siding|skylight/.test(s)) return 'Roofing and Siding';
    if (/window|glass|mirror|tint/.test(s)) return 'Windows and Glass';
    if (/gate|fence/.test(s)) return 'Gates and Fences';
    if (/camera|access control|security alarm|\bcctv\b/.test(s)) return 'Security';
    // Umbrava has no fuel/dispenser trade, so fuel assets fall through to '' (user picks).
    return '';
  }
  function extractWo(subject, body, senderEmail) {
    subject = subject || ''; body = body || '';
    var out = { po: '', sourceJob: '', client: '', location: '', trade: '', scope: '', clientDne: '', priorityLevel: '', assetName: '' };
    var mpo = (body.match(/\bPO\s*#?\s*:?\s*(\d{6,})/i) || subject.match(/(?:purchase order)\s*:?\s*(\d{6,})/i) || subject.match(/\b(\d{9,})\b/)); if (mpo) out.po = mpo[1];
    var mnte = body.match(/NTE\s*:?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i); if (mnte) out.clientDne = mnte[1].replace(/,/g, '');
    var mp = body.match(/Priority\s*:?\s*(P\d)/i) || subject.match(/\b(P\d)\b/); if (mp) out.priorityLevel = mp[1].toUpperCase();
    var mstore = body.match(/PFJ#?\s*:?\s*(\d{1,5})/i) || subject.match(/store\s*:?\s*(\d{1,5})/i); if (mstore) out.location = 'PFJ ' + String(mstore[1]).padStart(4, '0');
    var masset = body.match(/Asset Name\s*:?\s*([^\r\n]+)/i); if (masset) { out.assetName = masset[1].trim(); out.trade = assetToTrade(out.assetName); }
    var mdesc = body.match(/Description\s*:?\s*([\s\S]*?)(?:[\r\n]+\s*(?:Dispatcher|Vendor|Model\s*:|Serial|Parts Warranty|Labor Warranty)\b|$)/i);
    if (mdesc) out.scope = mdesc[1].replace(/\s+/g, ' ').trim().slice(0, 600);
    if (!out.scope) out.scope = subject.replace(/purchase order\s*:?\s*\d+/i, '').replace(/\s{2,}/g, ' ').trim().slice(0, 300);
    out.client = clientFromDomain(senderEmail);
    return out;
  }

  // ---- Create WO modal --------------------------------------------------------
  function woModal() {
    var s = document.querySelector('textarea#scopeOfWork') || document.querySelector('input#client-dropdown');
    return s ? (s.closest('.MuiDialog-container, [role="dialog"], .MuiPaper-root') || null) : null;
  }
  function normText(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
  // Find an input by its field label - for fields with a dynamic id (Priority) or no id (Client DNE).
  function inputByLabel(root, re) {
    var labs = [].slice.call(root.querySelectorAll('label, .MuiInputLabel-root'));
    var lab = labs.filter(function (l) { return re.test(normText(l.textContent)); })[0];
    if (!lab) return null;
    var fc = lab.closest('.MuiFormControl-root, .MuiTextField-root') || lab.parentElement;
    return fc ? fc.querySelector('input, textarea') : null;
  }
  function waitEnabled(root, sel, timeoutMs) {
    return new Promise(function (res) {
      var t0 = Date.now();
      (function poll() {
        var el = root.querySelector(sel);
        if (el && !el.disabled && el.getAttribute('aria-disabled') !== 'true') return res(el);
        if (Date.now() - t0 > (timeoutMs || 2500)) return res(el || null);
        setTimeout(poll, 120);
      })();
    });
  }
  // Poll until getter() returns a truthy element (or timeout). Used to wait for a field that only
  // renders after a cascade (e.g. Client DNE appears once a client is selected).
  function waitForEl(getter, timeoutMs) {
    return new Promise(function (res) {
      var t0 = Date.now();
      (function poll() {
        var el = getter();
        if (el) return res(el);
        if (Date.now() - t0 > (timeoutMs || 2500)) return res(null);
        setTimeout(poll, 100);
      })();
    });
  }
  // Best option for a target string: exact, then starts-with, then contains (case-insensitive).
  function bestOption(opts, target) {
    var t = normText(target).toLowerCase(); if (!t) return null;
    var txt = opts.map(function (o) { return normText(o.textContent).toLowerCase(); });
    var i;
    for (i = 0; i < opts.length; i++) if (txt[i] === t) return opts[i];
    for (i = 0; i < opts.length; i++) if (txt[i].indexOf(t) === 0) return opts[i];
    for (i = 0; i < opts.length; i++) if (txt[i].indexOf(t) >= 0) return opts[i];
    return null;
  }
  // Type into an autocomplete WITHOUT blurring - a blur closes the option list before we can click.
  function acType(el, val) {
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(el, val);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
  }
  // Umbrava's Client / Location / Trade / Priority are custom autocompletes (aria-autocomplete=
  // "list"): pre-typing does NOT select - you must click an option in the listbox, and that click
  // is what cascades (Client unlocks Location + reveals Client DNE; Location unlocks Asset). Open,
  // filter by searchTerm, then POLL until the MATCHING option renders and click it. The Client list
  // is network-fetched and can take >1.5s, and a stray/transient option may flash first - so we must
  // wait for a real match, not resolve on the first option that appears. Returns
  // 'selected' | 'typed' | 'disabled' | 'skip'.
  function selectAC(el, searchTerm, matchTarget) {
    return new Promise(function (resolve) {
      if (!el) return resolve('skip');
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') return resolve('disabled');
      el.focus();
      el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
      if (searchTerm) acType(el, searchTerm);
      var target = matchTarget || searchTerm, t0 = Date.now();
      (function poll() {
        var pick = bestOption([].slice.call(document.querySelectorAll('[role="option"]')), target);
        if (pick) {
          ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function (t) { pick.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); });
          return resolve('selected');
        }
        if (Date.now() - t0 > 2500) return resolve(searchTerm ? 'typed' : 'skip');
        setTimeout(poll, 70);
      })();
    });
  }
  function fillWo(root, wo) {
    var done = [], picked = [], hint = [];
    function setV(sel, v, label) { var el = root.querySelector(sel); if (el && v) { setNativeValue(el, v); done.push(label); } }
    setV('textarea#scopeOfWork', wo.scope, 'Scope');
    setV('input#sourcePurchaseOrderNumber', wo.po, 'Source PO #');
    setV('input#sourceJobNumber', wo.sourceJob, 'Source Job #');
    try { PENDING = wo._file ? { files: [wo._file].concat(wo._attachments || []), po: wo.po, client: wo.client } : null; } catch (e) { }

    // The dropdowns cascade, so select in order and wait for each dependent field to appear/enable:
    // Client -> (Location unlocks + Client DNE appears) -> Location -> Trade -> Priority.
    (async function () {
      if (wo.client) {
        var rc = await selectAC(root.querySelector('input#client-dropdown'), wo.client, wo.client);
        if (rc === 'selected') picked.push('Client "' + wo.client + '"');
        else hint.push('Client: pick "' + wo.client + '"');
      }
      // Client DNE = the PO NTE (the CLIENT ceiling, never the vendor NTE). The field only EXISTS
      // once a client is selected (that is why it was blank before), so WAIT for it to render.
      if (wo.clientDne) {
        var dne = await waitForEl(function () { return inputByLabel(root, /^client dne/i); }, 2500);
        if (dne) { setNativeValue(dne, wo.clientDne); done.push('Client DNE $' + wo.clientDne); }
        else hint.push('Client DNE: $' + wo.clientDne);
      }
      if (wo.location) {
        await waitEnabled(root, 'input#location-dropdown', 3000);
        var store = wo.location.replace(/\D/g, '') || wo.location;   // search by the store number, match the "PFJ ####" option
        var rl = await selectAC(root.querySelector('input#location-dropdown'), store, wo.location);
        if (rl === 'selected') picked.push('Location "' + wo.location + '"'); else hint.push('Location: pick ' + wo.location);
      }
      if (wo.trade) {
        var rt = await selectAC(root.querySelector('input#trades'), wo.trade, wo.trade);
        if (rt === 'selected') picked.push('Trade "' + wo.trade + '"'); else hint.push('Trade: ' + wo.trade + ' (pick the closest)');
      }
      if (wo.priorityLevel) {
        var rp = await selectAC(inputByLabel(root, /^priority/i), wo.priorityLevel, wo.priorityLevel);
        if (rp === 'selected') picked.push('Priority ' + wo.priorityLevel); else hint.push('Priority: set ' + wo.priorityLevel);
      }
      var parts = [];
      if (done.length) parts.push('Filled ' + done.join(', '));
      if (picked.length) parts.push('selected ' + picked.join(' / '));
      if (hint.length) parts.push('check: ' + hint.join(' · '));
      var nAtt = (wo._attachments || []).length;
      if (nAtt) parts.push('the email + ' + nAtt + ' attachment' + (nAtt === 1 ? '' : 's') + ' will attach to Documents after Create');
      parts.push('review before Create');
      toast('From the PO email - ' + parts.join(' · '), 15000);
    })();
  }

  // ---- Stage 2: carry the dropped email to the new WO, then auto-attach to Documents ------
  // On Create, stash the file(s) in IndexedDB (survives the create->WO-page hop, SPA nav OR a
  // reload). On the new WO page, hand them to BWN Drop Upload via bwn:cmd - it uploads them to
  // Documents AND drafts the email as a WO note (its existing flow). All local; no egress.
  var PENDING = null;   // { files:[emailFile, ...attachmentFiles], po, client } - set on a successful drop
  function idbReq(mode, fn) {
    return new Promise(function (res, rej) {
      var o = indexedDB.open('bwn-wo-intake', 1);
      o.onupgradeneeded = function () { o.result.createObjectStore('pending'); };
      o.onerror = function () { rej(o.error); };
      o.onsuccess = function () {
        var db = o.result, tx = db.transaction('pending', mode), st = tx.objectStore('pending'), rq;
        try { rq = fn(st); } catch (e) { rej(e); return; }
        tx.oncomplete = function () { res(rq ? rq.result : undefined); };
        tx.onerror = function () { rej(tx.error); };
      };
    });
  }
  function idbPut(k, v) { return idbReq('readwrite', function (st) { st.put(v, k); }); }
  function idbGet(k) { return idbReq('readonly', function (st) { return st.get(k); }); }
  function idbDel(k) { return idbReq('readwrite', function (st) { st.delete(k); }).catch(function () { }); }

  // On the modal's Create click (with a dropped email pending), persist for the new WO page.
  // fromPath lets the new page tell a real create-navigation from a validation failure (modal
  // stays -> same path -> we don't consume). Scoped to the modal's own Create button.
  document.addEventListener('click', function (e) {
    if (!PENDING || !PENDING.files || !PENDING.files.length) return;
    var btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!btn || !/^create\b/i.test((btn.textContent || '').trim())) return;
    var m = woModal(); if (!m || !m.contains(btn)) return;
    idbPut('current', { ts: Date.now(), fromPath: location.pathname, files: PENDING.files, po: PENDING.po || '', client: PENDING.client || '' }).catch(function () { });
  }, true);

  function waitWoReady(timeoutMs) {
    return new Promise(function (resolve) {
      var t0 = Date.now();
      (function poll() {
        if (document.querySelector('[role="tab"]') || document.querySelector('[data-testid^="documents-"]')) return resolve(true);
        if (Date.now() - t0 > (timeoutMs || 9000)) return resolve(false);
        setTimeout(poll, 250);
      })();
    });
  }
  var _consuming = false;
  function maybeConsumePending() {
    if (_consuming || !/\/work-orders\/\d+/.test(location.pathname)) return;
    idbGet('current').then(function (p) {
      if (!p || !p.files || !p.files.length) return;
      if (Date.now() - p.ts > 3 * 60 * 1000) { idbDel('current'); return; }   // stale
      if (p.fromPath === location.pathname) return;                            // create failed / not navigated yet - wait
      _consuming = true;
      idbDel('current');   // consume-once: delete before dispatch so a re-check can't double-fire
      waitWoReady(9000).then(function () {
        var acked = false;
        function onAck(ev) { if (ev && ev.detail && ev.detail.id === 'dropupload:accepted') acked = true; }
        document.addEventListener('bwn:evt', onAck, false);
        try { document.dispatchEvent(new CustomEvent('bwn:cmd', { detail: { id: 'dropupload:files', files: p.files } })); } catch (e) { }
        setTimeout(function () {
          document.removeEventListener('bwn:evt', onAck, false);
          if (acked) toast('Handed the PO email to Drop Upload - attaching to this WO\'s Documents + drafting the note. Review + Save.', 11000);
          else toast('Could not auto-attach: BWN Drop Upload not detected (install/update it). Drag the .msg onto the Work Order to attach it.', 13000);
          _consuming = false;
        }, 1800);
      });
    }).catch(function () { });
  }

  async function handleDrop(file, root) {
    try {
      var name = (file.name || '').toLowerCase(), parsed;
      if (/\.eml$/.test(name) || file.type === 'message/rfc822') parsed = parseEml(await file.text());
      else parsed = parseMsg(new Uint8Array(await file.arrayBuffer()));
      if (!parsed.subject && !parsed.body && !parsed.senderEmail) { toast('Could not read that email. Save it as a .msg or .eml file and drop the file (dragging straight from Outlook often gives the browser nothing).', 12000); return; }
      var wo = extractWo(parsed.subject, parsed.body, parsed.senderEmail); wo._file = file;
      // Turn the email's embedded attachments into File objects so they carry to the new WO's
      // Documents alongside the email (Increment 2 Part B).
      wo._attachments = [];
      (parsed.attachments || []).forEach(function (a) {
        try { wo._attachments.push(new File([a.bytes], a.name, { type: a.mime || 'application/octet-stream' })); } catch (e) { }
      });
      fillWo(root, wo);
    } catch (e) { toast('Could not read the email: ' + ((e && e.message) || e), 10000); }
  }

  // ---- Drop zone injected into the Create WO modal ----------------------------
  function injectDropZone() {
    var root = woModal();
    if (!root || root.querySelector('#bwn-wo-drop')) return;
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
    var anchor = root.querySelector('input#vendorNotToExceed');
    var col = anchor ? (anchor.closest('.MuiGrid-item, .MuiGrid-root, [class*="col"]') || anchor.parentElement) : null;
    if (col && col.parentElement) col.parentElement.appendChild(dz);
    else { (root.querySelector('.MuiDialogContent-root') || root.querySelector('form') || root).appendChild(dz); }
  }

  var obs = new MutationObserver(function () { injectDropZone(); });
  obs.observe(document.body, { childList: true, subtree: true });
  setInterval(injectDropZone, 900);
  injectDropZone();
  // Stage-2 consumer: on SPA path change to a new WO, and on direct load/reload onto one.
  var _lastPath = location.pathname;
  setInterval(function () { if (location.pathname !== _lastPath) { _lastPath = location.pathname; maybeConsumePending(); } }, 700);
  maybeConsumePending();
})();
