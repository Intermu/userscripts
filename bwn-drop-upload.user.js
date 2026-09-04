// ==UserScript==
// @name         BWN Drop Upload (Broadway National)
// @namespace    broadwaynational.bwn
// @version      1.23.1
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-drop-upload.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-drop-upload.user.js
// @description  Drop files anywhere on an Umbrava work order to upload them. Opens the Documents tab and upload dialog, hands over the files, and builds each file's description from its contents. Emails are parsed locally (.msg via an OLE/MAPI reader, .eml via RFC822) into an Outlook-style block - From/Sent/To/Cc/Subject and the body - that becomes the WO note, led by a one-line summary from Chrome's on-device built-in AI (zero cost, zero egress, nothing leaves the browser), falling back to local WO-field extraction (store, city/state, priority, PO, NTE, problem, requester) when the on-device model is unavailable. That same summary fills each file's Description. The WO note's Type is chosen from the email's parties: inbound is typed by the sender (client -> Client, else Vendor); outbound from Broadway is typed by the recipients (a client recipient -> Client, any vendor recipient -> Vendor, all-internal -> Internal). Umbrava's Description field is a TipTap/ProseMirror rich-text editor. It rejects synthetic paste, beforeinput, insertHTML and raw innerHTML, but honours execCommand('insertText') plus a synthetic Enter keydown - so the note is filled line by line (Enter between lines to keep paragraphs), paced ~12ms/line so ProseMirror's async commit doesn't drop lines (measured live 2026-08-10). The text is also placed on your clipboard as a backup, and if every fill method fails a "Copy the WO note" button appears (its click supplies the gesture for a reliable copy, then Ctrl+V). A console diagnostic reports which editor was found and which fill method stuck. When WO Intake hands off a just-created WO's request email, each uploaded file's Label (document type) is set to "Work Order Request" and the note Type is forced to Client (a WO Intake handoff is a client's request, even when the sender is a broker like Fairmarkit that reads as a Vendor domain). Fairmarkit / bulk-email footer boilerplate (the Fairmarkit company block: tagline + Boston address + FAQ/Privacy/Terms/Unsubscribe, and the -----!{...}!----- machine tail) plus ALL tracking URLs (safelinks/awstrack/logo) are stripped from the note body, keeping content through the suppliers@ email. A Fairmarkit RFQ body is also condensed to one line per entry - single-spaced, with each line-item rejoined to its QTY and each Details label (Buyer/Close date/RFQ ID/Shipping address) rejoined to its value. Files upload via Umbrava's own API (initializeJobDocument -> Azure blob PUT -> bulkAddWorkOrderDocuments, captured live 2026-08-12), Label set by id, so the brittle upload-dialog combobox is bypassed; the dialog remains the automatic fallback if the API is unavailable. A manual drop does NOT auto-upload: the review box shows a "Document type" picker plus an Upload button, so the coordinator CHOOSES the document type before it is committed (there is no update-label mutation, so the label must be right at upload time). The picker defaults to MATCH the note Type we assigned (Client -> Client Correspondence, Vendor -> Vendor Correspondence, Internal -> Internal) and stays in sync as the note Type is changed, until the coordinator overrides the doc type directly; for an unknown external party the on-device classifier upgrades Vendor -> Supplier Correspondence when it reads as a parts supplier. The file Description is still filled automatically from the file's contents / the email summary. Only the WO Intake handoff still uploads automatically, and it labels per file: the request email itself is the "Work Order Request", while any image attachment is filed as a "Photo". The email note is shown in a centered BWN review box (editable; the Type picker offers a curated set of the note types a drop is actually filed under, defaulted to the party-derived Client/Vendor/Internal) and posted via addEditJobNote ONLY when you click Post - it is never auto-posted, and posts under your own Umbrava session for correct attribution. Network calls are same-origin to app.umbrava.com's own /api/graphql (the app's Auth0 bearer, no @connect/GM) plus the SAS-authorized blob PUT the SPA itself makes - nothing goes to any third party. @grant none.
// @match        https://app.umbrava.com/*
// @match        https://*.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var VER = '1.23.1';   // keep in step with @version (drift caught earlier: banner had lagged two releases)
  var BWN_VER = VER;   // stamped into BWN-OPS audit entries; the wrapper references BWN_VER
  console.info('[BWN DROP UPLOAD] v' + VER + ' · Uploads via Umbrava API (initializeJobDocument→blob PUT→bulkAddWorkOrderDocuments, Label by id), DOM dialog is the fallback · manual drop HOLDS the upload: the review box shows a Document type picker (defaulted to MATCH the note Type - Client->Client Correspondence, Vendor->Vendor Correspondence, Internal->Internal - and re-synced as the note Type changes, until overridden) + an Upload button, so the type is CHOSEN, not assumed · email→note in a human-gated BWN review box, posted via addEditJobNote on an explicit Post click (never auto-posted) · note Type by parties (inbound=sender, outbound=recipient) · note box shows instantly with a mechanical lead; the slow on-device AI brief (Gemini Nano / Edge Phi) fills in async · bwn:cmd dropupload:files bridge (handoff labels per file: the email = Work Order Request, image attachments = Photo)');

  // Active only on WO pages; checked at drag time so SPA navigation needs no watcher.
  // Excluded: the WO's billing invoice sub-pages (/billing/vendor-invoices, /billing/client-invoices),
  // where a dropped file means an invoice attachment, not a WO document upload - so the overlay
  // must not steal that drop.
  function onWorkOrder() {
    var p = location.pathname;
    if (/\/billing\/(vendor|client)-invoices(\/|$)/.test(p)) return false;
    return /\/work-orders\/\d+/.test(p);
  }

  function hasFiles(e) {
    var dt = e.dataTransfer;
    if (!dt || !dt.types) return false;
    for (var i = 0; i < dt.types.length; i++) {
      if (dt.types[i] === 'Files') return true;
    }
    return false;
  }

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

  // ---- File descriptions (all parsing is LOCAL - FileReader only) ------------

  function fileKind(f) {
    var n = (f.name || '').toLowerCase();
    if (/\.(eml|msg)$/.test(n)) return 'Email';
    if (/^image\//.test(f.type || '') || /\.(png|jpe?g|gif|bmp|heic|webp|tiff?)$/.test(n)) return 'Photo';
    if (/\.pdf$/.test(n)) return 'PDF';
    if (/\.(docx?|rtf|txt)$/.test(n)) return 'Document';
    if (/\.(xlsx?|xlsm|csv)$/.test(n)) return 'Spreadsheet';
    return 'File';
  }

  function humanSize(b) {
    b = +b || 0;
    return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : b >= 1024 ? Math.round(b / 1024) + ' KB' : b + ' B';
  }

  function shortDate(ms) {
    var d = new Date(ms || Date.now());
    return (d.getMonth() + 1) + '/' + d.getDate();
  }

  // .eml = RFC822. A real email is a MIME TREE, not one flat body: multipart/mixed wraps a
  // multipart/alternative (text/plain + text/html) plus attachments. The old flat parser split
  // head/body at the first blank line, split on ONE boundary, and took the first part whose text
  // matched /text\/plain/ - but that substring ALSO matches the NESTED multipart/alternative block,
  // so it dumped that whole subtree (inner boundary lines + the base64 attachment) into the note as
  // gibberish. Walk the tree instead: prefer text/plain, fall back to stripped text/html, and never
  // let an attachment's bytes reach the body. (Mirrors the bwn-wo-intake parseEml fix, 2026-08-17.)
  function splitHeadBody(seg) { var m = seg.match(/\r?\n\r?\n/); return m ? { head: seg.slice(0, m.index), body: seg.slice(m.index + m[0].length) } : { head: seg, body: '' }; }
  function hdr(head, name) {
    var m = head.replace(/\r?\n[ \t]+/g, ' ').match(new RegExp('^' + name + ':\\s*(.+)$', 'im'));
    return m ? m[1].replace(/\s+/g, ' ').trim() : '';
  }
  // Split a multipart body on its boundary (RFC 2046); preamble/epilogue and the closing --b-- drop.
  function mimeParts(body, boundary) {
    var out = [], b = '--' + boundary, i = body.indexOf(b);
    while (i >= 0) {
      if (body.substr(i + b.length, 2) === '--') break;              // closing delimiter --b--
      var nl = body.indexOf('\n', i); if (nl < 0) break;
      var next = body.indexOf(b, nl + 1); if (next < 0) break;
      out.push(body.slice(nl + 1, next).replace(/\r?\n$/, ''));       // trailing CRLF belongs to the delimiter
      i = next;
    }
    return out;
  }
  // Walk one MIME part: multipart recurses; an attachment is skipped; text fills plain/html.
  function walkPart(head, body, acc) {
    var ct = hdr(head, 'Content-Type') || 'text/plain';
    var cte = hdr(head, 'Content-Transfer-Encoding').toLowerCase();
    var disp = hdr(head, 'Content-Disposition');
    var bnd = ct.match(/boundary="?([^";]+)"?/i);
    if (/^\s*multipart\//i.test(ct) && bnd) {
      mimeParts(body, bnd[1]).forEach(function (seg) { var sp = splitHeadBody(seg); walkPart(sp.head, sp.body, acc); });
      return;
    }
    var fname = (disp.match(/filename="?([^";\r\n]+)"?/i) || ct.match(/name="?([^";\r\n]+)"?/i) || [])[1] || '';
    if (/attachment/i.test(disp) || (fname && !/^\s*text\//i.test(ct))) return;   // attachment bytes must never reach the note
    var txt = /quoted-printable/.test(cte) ? deqp(body) : /base64/.test(cte) ? deb64(body) : body;
    if (/text\/html/i.test(ct)) { if (!acc.html) acc.html = txt; }
    else if (!acc.plain) acc.plain = txt;
  }
  function parseEml(text) {
    var sp = splitHeadBody(text), acc = { plain: '', html: '' };
    walkPart(sp.head, sp.body, acc);
    var body = acc.plain || acc.html || '';
    return {
      from: hdr(sp.head, 'From'), date: hdr(sp.head, 'Date'), subject: hdr(sp.head, 'Subject'),
      to: hdr(sp.head, 'To'), cc: hdr(sp.head, 'Cc'), body: cleanBody(body)
    };
  }

  function deb64(s) {
    try {
      var bin = atob(String(s || '').replace(/\s+/g, ''));
      try { return new TextDecoder('utf-8').decode(Uint8Array.from(bin, function (c) { return c.charCodeAt(0); })); }
      catch (e) { return bin; }
    } catch (e2) { return s; }   // not valid base64 after all - keep raw
  }

  function deqp(s) {
    s = String(s || '').replace(/=\r?\n/g, '');
    // Route through percent-decoding so multi-byte UTF-8 sequences (=E2=80=94 → -)
    // decode correctly; byte-wise fallback on malformed input.
    try { return decodeURIComponent(s.replace(/%/g, '%25').replace(/=([0-9A-F]{2})/gi, '%$1')); }
    catch (e) {
      return s.replace(/=([0-9A-F]{2})/gi, function (m, hx) {
        try { return String.fromCharCode(parseInt(hx, 16)); } catch (e2) { return m; }
      });
    }
  }

  // Strip HTML + decode the common entities, but PRESERVE newlines (paragraph
  // structure) - the email formatter relies on line breaks to trim the quoted
  // thread and keep the message readable. Only runs of spaces/tabs are collapsed.
  function cleanBody(s) {
    return String(s || '')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
      .replace(/[ \t]+\n/g, '\n').replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  // .msg = OLE2/CFB compound binary (Outlook). We do a real, zero-dependency parse:
  // read the compound-file structure (FAT/miniFAT/directory), then pull the MAPI
  // property streams (subject/body/sender + recipient storages). This replaced a
  // brittle "grab the long UTF-16 runs" heuristic - verified byte-for-byte against a
  // real Outlook .msg (July 2026). All in-browser off the FileReader ArrayBuffer;
  // still @grant none / zero egress.
  function parseCFB(ab) {
    var dv = new DataView(ab), u8 = new Uint8Array(ab);
    var SIG = [0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    for (var i = 0; i < 8; i++) if (u8[i] !== SIG[i]) throw new Error('not CFB');
    var sectorSize = 1 << dv.getUint16(30, true);
    var miniSize = 1 << dv.getUint16(32, true);
    var dirStart = dv.getUint32(48, true);
    var miniCutoff = dv.getUint32(56, true);
    var miniFatStart = dv.getUint32(60, true);
    var numMiniFat = dv.getUint32(64, true);
    var difatStart = dv.getUint32(68, true);
    var numDifat = dv.getUint32(72, true);
    var ENDOFCHAIN = 0xFFFFFFFE, FREESECT = 0xFFFFFFFF;
    function secOff(sid) { return (sid + 1) * sectorSize; }
    var fatSectorIds = [];
    for (var a = 0; a < 109; a++) { var v = dv.getUint32(76 + a * 4, true); if (v === FREESECT || v === ENDOFCHAIN) break; fatSectorIds.push(v); }
    var ds = difatStart, g = 0;
    while (numDifat > 0 && ds !== ENDOFCHAIN && ds !== FREESECT && g++ < 100000) {
      var base = secOff(ds), per = sectorSize / 4;
      for (var b1 = 0; b1 < per - 1; b1++) { var vv = dv.getUint32(base + b1 * 4, true); if (vv !== FREESECT && vv !== ENDOFCHAIN) fatSectorIds.push(vv); }
      ds = dv.getUint32(base + (per - 1) * 4, true);
    }
    var fat = [];
    for (var f = 0; f < fatSectorIds.length; f++) { var bb = secOff(fatSectorIds[f]); for (var k = 0; k < sectorSize / 4; k++) fat.push(dv.getUint32(bb + k * 4, true)); }
    function chain(start) { var out = [], s = start, gg = 0; while (s !== ENDOFCHAIN && s !== FREESECT && s >= 0 && s < fat.length + 1 && gg++ < 2000000) { out.push(s); s = fat[s]; } return out; }
    function readFat(start, size) { var ch = chain(start), out = new Uint8Array(ch.length * sectorSize); for (var i = 0; i < ch.length; i++) { var o = secOff(ch[i]); out.set(u8.subarray(o, o + sectorSize), i * sectorSize); } return size != null ? out.subarray(0, size) : out; }
    var dirBytes = readFat(dirStart);
    var ddv = new DataView(dirBytes.buffer, dirBytes.byteOffset, dirBytes.byteLength);
    var entries = [], n = Math.floor(dirBytes.length / 128);
    for (var e = 0; e < n; e++) {
      var p = e * 128, nameLen = ddv.getUint16(p + 64, true), name = '';
      for (var c = 0; c < Math.max(0, nameLen - 2); c += 2) { var ch2 = ddv.getUint16(p + c, true); if (ch2) name += String.fromCharCode(ch2); }
      entries.push({ id: e, name: name, type: ddv.getUint8(p + 66), left: ddv.getUint32(p + 68, true), right: ddv.getUint32(p + 72, true), child: ddv.getUint32(p + 76, true), start: ddv.getUint32(p + 116, true), size: ddv.getUint32(p + 120, true) });
    }
    var root = null; for (var r = 0; r < entries.length; r++) if (entries[r].type === 5) { root = entries[r]; break; }
    var miniStream = root ? readFat(root.start, root.size) : new Uint8Array(0);
    var miniFat = [];
    if (numMiniFat > 0 && miniFatStart !== ENDOFCHAIN) { var mfb = readFat(miniFatStart); var mdv = new DataView(mfb.buffer, mfb.byteOffset, mfb.byteLength); for (var m = 0; m < mfb.length / 4; m++) miniFat.push(mdv.getUint32(m * 4, true)); }
    function readMini(start, size) { var out = new Uint8Array(Math.max(size, Math.ceil(size / miniSize) * miniSize)), s = start, o = 0, gg = 0; while (s !== ENDOFCHAIN && s !== FREESECT && s >= 0 && s < miniFat.length + 1 && gg++ < 2000000) { var so = s * miniSize; out.set(miniStream.subarray(so, so + miniSize), o); o += miniSize; s = miniFat[s]; } return out.subarray(0, size); }
    function readStream(entry) { if (!entry || entry.type !== 2) return new Uint8Array(0); return entry.size >= miniCutoff ? readFat(entry.start, entry.size) : readMini(entry.start, entry.size); }
    return { entries: entries, readStream: readStream };
  }

  function utf16le(u8) { var s = ''; for (var i = 0; i + 1 < u8.length; i += 2) { var c = u8[i] | (u8[i + 1] << 8); if (c) s += String.fromCharCode(c); } return s; }
  function asciiStr(u8) { var s = ''; for (var i = 0; i < u8.length; i++) { if (u8[i]) s += String.fromCharCode(u8[i]); } return s; }

  // Outlook .msg → the same email model shape parseEml produces (via emlToModel).
  function parseMsg(ab) {
    var cfb = parseCFB(ab), entries = cfb.entries;
    function byName(nm) { for (var i = 0; i < entries.length; i++) if (entries[i].name === nm) return entries[i]; return null; }
    function propIn(list, hex) {
      var u = null, a = null;
      for (var i = 0; i < list.length; i++) { if (list[i].name === '__substg1.0_' + hex + '001F') u = list[i]; else if (list[i].name === '__substg1.0_' + hex + '001E') a = list[i]; }
      if (u) { var s = utf16le(cfb.readStream(u)); if (s) return s; }
      if (a) return asciiStr(cfb.readStream(a));
      return '';
    }
    function prop(hex) { return propIn(entries, hex).replace(/ +$/, '').trim(); }
    function collectChildren(childId) {
      var kids = [], stack = [childId], seen = {};
      while (stack.length) { var id = stack.pop(); if (id === 0xFFFFFFFF || id == null || id < 0 || id >= entries.length || seen[id]) continue; seen[id] = 1; var e = entries[id]; kids.push(e); stack.push(e.left, e.right, e.child); }
      return kids;
    }
    function recipType(kids) {
      var rp = null; for (var i = 0; i < kids.length; i++) if (kids[i].name === '__properties_version1.0') { rp = kids[i]; break; }
      if (!rp) return 0;
      var bb = cfb.readStream(rp); if (bb.length < 24) return 0;
      var rdv = new DataView(bb.buffer, bb.byteOffset, bb.byteLength);
      for (var o = 8; o + 16 <= bb.length; o += 16) { if (rdv.getUint16(o + 2, true) === 0x0C15 && rdv.getUint16(o, true) === 0x0003) return rdv.getUint32(o + 8, true); }
      return 0;
    }
    var to = [], cc = [];
    for (var i = 0; i < entries.length; i++) {
      if (entries[i].type === 1 && entries[i].name.indexOf('__recip_version1.0') === 0) {
        var kids = collectChildren(entries[i].child);
        var ks = (function (kk) {
          return function (hex) {
            var uu = null, aa = null;
            for (var j = 0; j < kk.length; j++) { if (kk[j].name === '__substg1.0_' + hex + '001F') uu = kk[j]; else if (kk[j].name === '__substg1.0_' + hex + '001E') aa = kk[j]; }
            if (uu) { var s = utf16le(cfb.readStream(uu)); if (s) return s.replace(/ +$/, '').trim(); }
            if (aa) return asciiStr(cfb.readStream(aa)).replace(/ +$/, '').trim();
            return '';
          };
        })(kids);
        var rec = { name: ks('3001'), email: ks('39FE') || ks('3003') };
        var t = recipType(kids);
        if (t === 2) cc.push(rec); else if (t === 3) { /* Bcc: omit from the note */ } else to.push(rec);
      }
    }
    var sent = null, ps = byName('__properties_version1.0');
    if (ps) {
      var pb = cfb.readStream(ps);
      if (pb.length >= 48) {
        var pdv = new DataView(pb.buffer, pb.byteOffset, pb.byteLength), pick = null;
        for (var o2 = 32; o2 + 16 <= pb.length; o2 += 16) {
          var pid = pdv.getUint16(o2 + 2, true), ty = pdv.getUint16(o2, true);
          if (ty === 0x0040 && (pid === 0x0039 || pid === 0x0E06)) {
            var lo = pdv.getUint32(o2 + 8, true), hi = pdv.getUint32(o2 + 12, true), ft = hi * 4294967296 + lo, ms = ft / 10000 - 11644473600000;
            if (pid === 0x0039) { pick = ms; break; } if (pick === null) pick = ms;
          }
        }
        if (pick !== null && pick > 946684800000) sent = new Date(pick); // sanity: after 2000-01-01, else a zero/garbage FILETIME renders as a 1601 date
      }
    }
    return {
      subject: prop('0037'),
      fromName: prop('0C1A') || prop('0042'),
      fromEmail: prop('5D01') || prop('0C1F') || prop('5D02') || prop('0065'),
      to: to, cc: cc, sent: sent, sentRaw: '',
      body: propIn(entries, '1000').replace(/ +$/, '')
    };
  }

  // Parse one address ("Name <email>" / bare email / bare name) and a comma/semicolon
  // list of them - quotes and angle brackets are respected so a display name that
  // contains a comma ("Phillips, Patrick") isn't split in two.
  function parseAddr(v) {
    v = String(v || '').trim();
    var m = v.match(/^(.*?)<([^>]+)>\s*$/);
    if (m) return { name: m[1].trim().replace(/^["'](.*)["']$/, '$1').replace(/\s+/g, ' ').trim(), email: m[2].trim() };
    return /@/.test(v) ? { name: '', email: v } : { name: v.replace(/^["'](.*)["']$/, '$1').trim(), email: '' };
  }
  function parseAddrList(v) {
    if (!v) return [];
    var out = [], cur = '', inQ = false, inA = false;
    for (var i = 0; i < v.length; i++) {
      var ch = v[i];
      if (ch === '"') inQ = !inQ; else if (ch === '<') inA = true; else if (ch === '>') inA = false;
      if ((ch === ',' || ch === ';') && !inQ && !inA) { if (cur.trim()) out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim()) out.push(cur);
    return out.map(parseAddr).filter(function (r) { return r.name || r.email; });
  }
  function emlToModel(em) {
    var fromA = parseAddr(em.from), d = em.date ? new Date(em.date) : null; if (d && isNaN(d.getTime())) d = null;
    return { subject: em.subject, fromName: fromA.name, fromEmail: fromA.email, to: parseAddrList(em.to), cc: parseAddrList(em.cc), sent: d, sentRaw: d ? '' : em.date, body: em.body };
  }

  // ---- Email → Outlook-style block (what lands in the WO note) ---------------
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  var MONS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  function formatSent(d) {
    if (!d || isNaN(d.getTime())) return '';
    var h = d.getHours(), ap = h < 12 ? 'AM' : 'PM', h12 = h % 12; if (h12 === 0) h12 = 12;
    return DAYS[d.getDay()] + ', ' + MONS[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ' ' + h12 + ':' + ('0' + d.getMinutes()).slice(-2) + ' ' + ap;
  }
  // An internal Exchange sender/recipient carries a legacy X.500 Exchange DN
  // (/O=EXCHANGELABS/…/CN=…) in PR_SENDER_EMAIL_ADDRESS (0C1F) / PR_EMAIL_ADDRESS (3003)
  // when no SMTP property is present - that DN must never surface in the note. Keep an
  // address only if it's a real SMTP address (has "@" and isn't an X.500 "/o=…" path);
  // otherwise show the display name alone.
  function smtpAddr(s) { s = String(s || '').trim(); return (s.indexOf('@') !== -1 && s.charAt(0) !== '/') ? s : ''; }
  function fmtAddr(r) {
    var name = (r.name || '').trim(), email = smtpAddr(r.email);
    if (name && email && name.toLowerCase() !== email.toLowerCase()) return name + ' <' + email + '>';
    return email || name;
  }
  // Reduce the plain-text body to the NEW message: strip Outlook's inline link
  // artifacts and cut at the first quoted header block (the prior thread), so the
  // note carries what was actually written, not the whole reply chain.
  var BODY_MAX = 20000;   // bound regex work on pathological bodies (real plain-text email bodies are tiny)
  function tidyBody(raw) {
    var rawStr = String(raw || '');
    // Fairmarkit RFQ bodies come through the plain-text stream double-spaced with every table cell on
    // its own line; they also carry a company footer + tracking URLs. Detect so the extra cleanup is
    // scoped to them and ordinary client/vendor emails keep their existing formatting.
    var fm = /Fairmarkit/i.test(rawStr) && /Invitation to Quote|e-bidding platform|Request for Quote/i.test(rawStr);
    var body = rawStr.slice(0, BODY_MAX).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    body = body.replace(/ ?<(?:mailto:|https?:\/\/)[^>]*>/gi, '');
    body = body.replace(/-----!\{[\s\S]*?\}!-----/g, '');      // the machine tail
    body = body.replace(/https?:\/\/\S+/gi, '');               // ALL URLs (safelinks/awstrack/s3 logo); bare emails stay
    // Cut the Fairmarkit COMPANY footer (tagline + Boston address + FAQ/Privacy/Terms/Unsubscribe),
    // keeping "Keep an eye..." / "Reach our supplier relations" / the suppliers@ email above it.
    var fcut = body.search(/Autonomous sourcing for all spend|Fairmarkit,\s*1 Beacon/i);
    if (fcut > 0) body = body.slice(0, fcut).replace(/\n[ \t]*Fairmarkit[ \t]*\s*$/i, '\n');
    var lines = body.split('\n');
    for (var i = 0; i < lines.length; i++) {
      // Only treat a "From:" line as the start of the quoted reply thread if it
      // carries an actual address (@ or <…>) AND at least two more quoted-header
      // fields (Sent/To/Subject/Cc) follow within a few lines. Prose that merely
      // begins a line with "From:"/"To:" must NOT truncate the real message
      // (review: the looser heuristic false-positived on ordinary body text).
      if (/^\s*From:\s*.*[@<]/i.test(lines[i])) {
        var look = lines.slice(i + 1, i + 6).join('\n');
        var hits = (/^\s*Sent:/im.test(look) ? 1 : 0) + (/^\s*To:/im.test(look) ? 1 : 0) +
                   (/^\s*Subject:/im.test(look) ? 1 : 0) + (/^\s*Cc:/im.test(look) ? 1 : 0);
        if (hits >= 2) { lines = lines.slice(0, i); break; }
      }
    }
    body = lines.map(function (l) { return l.replace(/\s+$/, ''); }).join('\n');
    if (fm) {
      // Condense to one line per entry: single-space it, then rejoin a line-item to its QTY and each
      // Details label to its value (the plain-text flattening split those onto separate lines).
      body = body.replace(/\n{2,}/g, '\n');
      body = body.replace(/\n(\d+\.\d{2})\b[ \t]*/g, '\t$1');
      body = body.replace(/\n(Buyer:|Close date:|RFQ ID:|Shipping address:)[ \t]*\n[ \t]*/gi, '\n$1\t');
      return body.trim();
    }
    return body.replace(/\n{3,}/g, '\n\n').trim();
  }
  // Generated lead line for a client WO-request email: "<Sender> sent in WO Request for <problem>".
  // The problem text is the email's Description: section (the real scope). Added only when BOTH a
  // sender name and a Description are present, so ordinary emails never get a misfit summary line.
  function woSummary(m) {
    var name = (m.fromName || smtpAddr(m.fromEmail) || '').trim();
    var dm = String(m.body || '').match(/Description\s*:?\s*([\s\S]*?)(?:\n\s*(?:Dispatcher|Vendor|Model\s*:|Serial|Parts Warranty|Labor Warranty)\b|$)/i);
    var desc = dm ? dm[1].replace(/\s+/g, ' ').trim() : '';
    if (!name || !desc) return '';
    return name + ' sent in WO Request for ' + desc;
  }
  // `lead` (optional) overrides the note's opening summary line - Drop Upload passes the
  // AI one-line summary here. When absent/empty it falls back to the mechanical woSummary,
  // so the block still leads sensibly if AI is off.
  function formatEmailBlock(m, lead) {
    var L = [];
    var from = fmtAddr({ name: m.fromName, email: m.fromEmail }); if (from) L.push('From: ' + from);
    var sent = m.sent ? formatSent(m.sent) : (m.sentRaw || ''); if (sent) L.push('Sent: ' + sent);
    if (m.to && m.to.length) L.push('To: ' + m.to.map(fmtAddr).join('; '));
    if (m.cc && m.cc.length) L.push('Cc: ' + m.cc.map(fmtAddr).join('; '));
    if (m.subject) L.push('Subject: ' + m.subject);
    var body = tidyBody(m.body);
    var block = L.join('\n') + (body ? '\n\n' + body : '');
    var sum = (lead != null && String(lead).trim()) ? String(lead).trim() : woSummary(m);
    return sum ? (sum + '\n\n' + block) : block;
  }

  // Short one-liner for the Description field / clipboard (emails add from+sent).
  function emailDesc(m, name) {
    var meta = [];
    var fromShown = m.fromName || smtpAddr(m.fromEmail);   // never the raw Exchange DN
    if (fromShown) meta.push('from ' + fromShown);
    if (m.sent && !isNaN(m.sent.getTime())) meta.push('sent ' + shortDate(+m.sent));
    return (m.subject || name.replace(/\.(eml|msg)$/i, '')) + (meta.length ? ' (' + meta.join(', ') + ')' : '');
  }

  // ---- Local one-line summary (no AI, no cost, no network) --------------------
  // Client WO-request emails (Pilot, Caleres/Corrigo, and the generic template) carry the
  // work-order facts as labeled fields, so we EXTRACT them and template a single scan-line
  // for the coordinator - no LLM, no egress, instant. Returns '' when too little is found,
  // and the caller falls back to the mechanical emailDesc. Example output:
  //   "Pilot #7976 (Troutman, NC) - Bottom dryer still leaving towels little bit damp not
  //    fully heating. P2/24-hr, PO 170101420934, NTE $800; Tonia Paz is requesting an ETA."
  var US_STATES = {
    'alabama': 'AL', 'alaska': 'AK', 'arizona': 'AZ', 'arkansas': 'AR', 'california': 'CA',
    'colorado': 'CO', 'connecticut': 'CT', 'delaware': 'DE', 'florida': 'FL', 'georgia': 'GA',
    'hawaii': 'HI', 'idaho': 'ID', 'illinois': 'IL', 'indiana': 'IN', 'iowa': 'IA',
    'kansas': 'KS', 'kentucky': 'KY', 'louisiana': 'LA', 'maine': 'ME', 'maryland': 'MD',
    'massachusetts': 'MA', 'michigan': 'MI', 'minnesota': 'MN', 'mississippi': 'MS', 'missouri': 'MO',
    'montana': 'MT', 'nebraska': 'NE', 'nevada': 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
    'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', 'ohio': 'OH',
    'oklahoma': 'OK', 'oregon': 'OR', 'pennsylvania': 'PA', 'rhode island': 'RI', 'south carolina': 'SC',
    'south dakota': 'SD', 'tennessee': 'TN', 'texas': 'TX', 'utah': 'UT', 'vermont': 'VT',
    'virginia': 'VA', 'washington': 'WA', 'west virginia': 'WV', 'wisconsin': 'WI', 'wyoming': 'WY',
    'district of columbia': 'DC'
  };
  function stAbbrev(s) {
    s = String(s || '').trim();
    if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
    return US_STATES[s.toLowerCase()] || s;
  }
  var BRAND_BY_DOMAIN = { 'pilottravelcenters.com': 'Pilot', 'caleres.com': 'Caleres', 'staples.com': 'Staples' };
  function localSummary(m) {
    // Scan the NEW message only (tidyBody cuts the quoted reply thread). Scanning raw m.body made a
    // short reply inherit the PO/NTE/priority/ETA from the original request quoted below it, so a
    // "can you send revised NTE?" reply came out framed as a fresh WO request.
    var subject = String(m.subject || ''), body = tidyBody(m.body || ''), hay = subject + '\n' + body;

    // Brand: from the sender domain, else a "#### <Brand>" token in the body (e.g. "PFJ#: 7976 Pilot").
    var dom = (String(m.fromEmail || '').split('@')[1] || '').toLowerCase();
    var brand = BRAND_BY_DOMAIN[dom] || '';
    if (!brand) { var mb = body.match(/PFJ#?\s*:?\s*\d+\s+([A-Za-z][A-Za-z ]{1,20})/); if (mb) brand = mb[1].trim(); }

    // Store number: Pilot "PFJ#: 7976" / "Store: 7976" / subject "7976 ..."; Caleres "Caleres/3699/".
    var ms = body.match(/PFJ#?\s*:?\s*(\d{1,6})/i) || hay.match(/\bStore\s*:?\s*#?\s*(\d{2,6})/i) ||
             hay.match(/Caleres\/(\d{3,6})\//i) || subject.match(/^\s*(\d{3,6})\b/);
    var store = ms ? ms[1] : '';

    // City, State: an address line "Troutman, North Carolina 28166" or subject "Troutman, North Carolina".
    var city = '', state = '';
    var mcs = body.match(/\n\s*([A-Za-z][A-Za-z .'\-]+),\s*([A-Za-z][A-Za-z ]+?)\s+\d{5}(?:-\d{4})?/) ||
              hay.match(/([A-Za-z][A-Za-z .'\-]+),\s*([A-Z]{2})\b/);
    if (mcs) { city = mcs[1].replace(/\s+/g, ' ').trim(); state = stAbbrev(mcs[2]); }

    // Priority: "P2 - Normal (24 hrs)" -> "P2/24-hr"; else bare "P2".
    var prio = '';
    var mp = hay.match(/\b(P\d)\b[^\n(]*\((\d+)\s*(hr|hour|day)/i);
    if (mp) prio = mp[1].toUpperCase() + '/' + mp[2] + '-' + (/day/i.test(mp[3]) ? 'day' : 'hr');
    else { var mp2 = hay.match(/\b(P\d)\b/); if (mp2) prio = mp2[1].toUpperCase(); }

    // PO number and NTE dollar amount.
    var mpo = hay.match(/\bPO\s*#?\s*:?\s*(\d{6,})/i) || subject.match(/\b(\d{9,})\b/);
    var po = mpo ? mpo[1] : '';
    var mnte = body.match(/NTE\s*:?\s*\$?\s*([\d,]+(?:\.\d{2})?)/i);
    var nte = mnte ? mnte[1].replace(/,/g, '').replace(/\.00$/, '') : '';

    // Problem: the Description: field (the real scope), stopped at the next labeled block.
    var md = body.match(/Description\s*:?\s*([\s\S]*?)(?:\n\s*(?:Dispatcher|Vendor|Model\s*:|Serial|Parts Warranty|Labor Warranty|Kiosk|NTE Increase)\b|\*\*|$)/i);
    var problem = md ? md[1].replace(/\s+/g, ' ').trim() : '';
    if (problem.length > 240) problem = problem.slice(0, 237).replace(/\s+\S*$/, '') + '...';

    // Requester + the ask (ETA is the common one for these WO requests).
    var who = (m.fromName || '').trim();
    var wantsEta = /\bETA\b/i.test(hay);

    // Assemble - include only the parts we actually found.
    var head = brand ? (brand + (store ? ' #' + store : '')) : (store ? 'Store #' + store : '');
    var place = (city && state) ? (city + ', ' + state) : (city || state || '');
    if (place) head += (head ? ' ' : '') + '(' + place + ')';
    var tail = [];
    if (prio) tail.push(prio);
    if (po) tail.push('PO ' + po);
    if (nte) tail.push('NTE $' + nte);
    var line = head;
    if (problem) line += (line ? ' - ' : '') + problem;
    if (tail.length) line += (/[.?!]$/.test(line) ? ' ' : '. ') + tail.join(', ');
    if (who) line += '; ' + who + (wantsEta ? ' is requesting an ETA' : ' sent this request');
    line = line.replace(/\s+/g, ' ').trim();
    // Require enough signal to be useful: a store OR (a problem plus any of PO/NTE/priority).
    if (!store && !(problem && (po || nte || prio))) return '';
    return line.slice(0, 300);
  }

  // Mechanical floor for emails that AREN'T inbound WO-requests - outbound status replies, general
  // correspondence. localSummary returns '' for those (no store/PO/NTE/Description), and the on-device
  // AI line is '' whenever Chrome's built-in model isn't available, so without this the note would lead
  // with nothing. Leads instead with the sender + the opening line of the NEW (thread-cut) message body,
  // skipping a bare salutation, so a coordinator sees what the email SAID even with no AI. '' when there
  // is nothing usable (describeFile then falls to the mechanical woSummary / no lead).
  // NB: "thanks"/"thank you" are NOT skipped here - a line like "Thank you for the new service request.
  // We'll dispatch and provide an ETA" IS the substance, and skipping it landed the summary on the
  // "Kind Regards," sign-off below. A bare "Thanks,"/"Thank you." sign-off is < 12 chars, so the length
  // guard drops it anyway.
  var SALUTATION_RE = /^(hi|hello|hey|dear|good\s+(morning|afternoon|evening)|greetings)\b/i;
  function genericEmailSummary(m) {
    var who = (m.fromName || smtpAddr(m.fromEmail) || '').replace(/\s+/g, ' ').trim();
    var body = tidyBody(m.body || '');
    if (!body) return '';
    var parts = body.split(/\n{2,}/), para = '';
    for (var i = 0; i < parts.length; i++) {
      var s = parts[i].replace(/\s+/g, ' ').trim();
      if (s.length >= 12 && !SALUTATION_RE.test(s)) { para = s; break; }
    }
    if (!para) para = body.replace(/\s+/g, ' ').trim();
    if (!para) return '';
    var cap = 200;
    if (para.length > cap) {
      var win = para.slice(0, cap);
      var dot = Math.max(win.lastIndexOf('. '), win.lastIndexOf('? '), win.lastIndexOf('! '));
      para = (dot >= 80) ? win.slice(0, dot + 1) : win.replace(/\s+\S*$/, '') + '…';
    }
    return (who ? who + ': ' : '') + para;
  }

  // Lead line for the note + the file Description. A REPLY carries its new content in the BODY, so
  // lead with that ("<Responder>: <reply text>", via genericEmailSummary). An ORIGINAL send often
  // carries the real ask in its SUBJECT (WO#/store/EMERGENCY) over a body that's just a signature,
  // so lead with the subject instead ("<Sender>: Sent <Subject>"). Reply = an RE:/AW:/SV: subject.
  function isReplyEmail(m) { return /^\s*(re|aw|sv|res)\s*:/i.test((m && m.subject) || ''); }
  function emailLead(m) {
    if (m && m.subject && !isReplyEmail(m)) {
      var who = (m.fromName || smtpAddr(m.fromEmail) || '').replace(/\s+/g, ' ').trim();
      return (who ? who + ': ' : '') + 'Sent ' + String(m.subject).replace(/\s+/g, ' ').trim();
    }
    return genericEmailSummary(m);
  }

  // ---- Note Type from the email's parties ------------------------------------
  // classifyDomain: a client-side domain -> "Client", Broadway-internal -> "Internal", any
  // OTHER real domain -> "External" (undecided - vendor vs supplier is settled by content,
  // not assumed), no parseable address -> ''. It used to assume every non-client external
  // domain was a Vendor; that mislabeled all client work arriving through a broker/CMMS as
  // "Vendor Correspondence". CLIENT_DOMAINS is CLIENT-SIDE: our clients AND the brokers /
  // work-order platforms that route their WOs (a Corrigo/Fairmarkit email on a client WO is
  // the CLIENT's traffic). Extend this as clients and platforms surface - it is the one list
  // we maintain by hand.
  var CLIENT_DOMAINS = {
    // direct clients
    'pilottravelcenters.com': 1, 'caleres.com': 1, 'staples.com': 1,
    // brokers / CMMS / work-order platforms that carry client work (client-side, not vendors)
    'corrigo.com': 1, 'corrigopro.com': 1, 'fairmarkit.com': 1, 'servicechannel.com': 1,
    'famis.com': 1
    // ponytail: hand-maintained allowlist. Add domains here as they appear; an unlisted
    // external domain falls to the AI vendor/supplier classifier, not to a wrong guess.
  };
  var INTERNAL_DOMAIN = 'broadwaynational.com';
  function classifyDomain(email) {
    var dom = (String(email || '').split('@')[1] || '').toLowerCase().trim();
    if (!dom) return '';
    if (CLIENT_DOMAINS[dom]) return 'Client';
    if (dom === INTERNAL_DOMAIN) return 'Internal';
    return 'External';
  }
  // The party we are corresponding WITH, from domains + direction, deterministic (no AI):
  //   'Client'   - a client-side domain is sender or recipient
  //   'Internal' - Broadway on both ends
  //   'External' - a real but unrecognized external domain (a vendor or a supplier - content decides)
  //   ''         - nothing parseable (caller applies its own default)
  function partyByDomain(m) {
    if (!m) return '';
    var from = classifyDomain(m.fromEmail);
    if (from === 'Client') return 'Client';        // inbound from a client-side party
    if (from === 'External') return 'External';    // inbound from an unknown external party
    // from is Internal (outbound) or '' - decide by who it went to
    var recips = [].concat(m.to || [], m.cc || []), sawExternal = false;
    for (var i = 0; i < recips.length; i++) {
      var c = classifyDomain(recips[i] && recips[i].email);
      if (c === 'Client') return 'Client';         // outbound to a client-side party
      if (c === 'External') sawExternal = true;
    }
    if (sawExternal) return 'External';            // outbound to an unknown external party
    if (from === 'Internal') return 'Internal';    // internal <-> internal
    return '';
  }
  // Note Type is Client / Vendor / Internal only - there is no "Supplier" note type, so an
  // external party (vendor OR supplier) types the note as Vendor. The vendor-vs-supplier split
  // matters only for the document LABEL (see classifyEmail / docLabelForFiles). Nothing
  // parseable keeps the prior "Client" default (the WO-intake handoff's always-Client behavior).
  function noteTypeForEmail(m) {
    if (!m) return 'Client';
    var p = partyByDomain(m);
    if (p === 'Client') return 'Client';
    if (p === 'External') return 'Vendor';
    if (p === 'Internal') return 'Internal';
    return 'Client';
  }
  function noteTypeForFiles(files) {
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (f && f.isEmail && f.email) return noteTypeForEmail(f.email);
    }
    return 'Client';
  }

  // ---- "Needs a client response" (wo-assist queue, build step 4) ---------------
  // The first INBOUND email from a client domain in this drop. Only such a drop can owe a
  // reply: an outbound email is the reply, and a vendor email is somebody else's thread. The
  // toggle is offered on nothing else, because a checkbox that shows up on every drop is a
  // checkbox nobody reads.
  function inboundClientEmail(files) {
    for (var i = 0; i < (files || []).length; i++) {
      var f = files[i];
      if (!f || !f.isEmail || !f.email) continue;
      if (classifyDomain(f.email.fromEmail) === 'Client') return f;
    }
    return null;
  }
  function woIdFromUrl() {
    var m = String(location.pathname || '').match(/\/work-orders\/(\d+)/);
    return m ? m[1] : '';
  }
  function woNumberFromUrl() { var s = woIdFromUrl(); return s ? parseInt(s, 10) : 0; }

  // ===== API write path (note + document upload) - captured live 2026-08-12 ======
  // Historically this script was pure DOM: it drove Umbrava's own Add-Note composer and upload
  // dialog by clicking react-aria/MUI comboboxes. That is brittle (portal listboxes, 2.5s option
  // polls) and could not fill the Description field at all (Umbrava locks it - the code fell back
  // to a clipboard paste). These are the REAL mutations the SPA fires, captured off the wire on a
  // scratch WO, so we write via the API instead. Contract + id maps: [[umbrava-graphql-operations]]
  // "Mutations (the WRITE surface)". The note write stays HUMAN-GATED (a BWN review box, Post
  // button) - the API only fires on an explicit click, never on drop. Uploads fire on drop (the
  // drop IS the confirmation). Both fall back to the DOM path on any failure.
  //
  // Auth: a plain SAME-ORIGIN POST to /api/graphql carries the app's Auth0 bearer; the token is
  // content-picked from the SPA's @@auth0spajs@@ cache exactly as bwn-suite-core's bwnAuthToken
  // does (the audience slot transiently holds non-Umbrava tokens). No @connect, no GM_xhr. The
  // blob PUT (step 2 of an upload) goes to umbravadocuments.blob.core.windows.net, authorized by
  // the SAS in the URL (no bearer) - cross-origin but the storage account CORS-allows this origin
  // because the SPA makes the identical page-fetch PUT.
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

  // ===== BWN-PERM START v1 (paste-identical; pinned by scripts/test-perm-block-ledger.js) =====
  // Umbrava's own per-user permission checkboxes, as the one question a control has:
  //   bwnCan('WorkOrderNote.AddNew') -> true | false
  // Umbrava returns me.permissions as a JSON STRING of {"<Type>Permissions": "<bitmask>"} - one
  // bit per checkbox on /company/users/<id>/permissions. bwn-suite-core decodes it once a session
  // and publishes the DECODED grant list to `bwn:perm:last` + the `bwn:perm` bus event, the same
  // one-way producer/consumer shape as bwn:role. This block only READS that slot, so every
  // sandbox that pastes it needs neither the query, the token, nor the flag numbers.
  //
  // FAIL-OPEN on anything unknown - no slot yet, a stale slot, or a group the producer does not
  // map. Umbrava's server is the real boundary (it refuses the mutation either way), so an
  // unreadable cache must never strand a coordinator mid-shift. Fail-CLOSED only on a
  // positively-known missing bit. localStorage is per-origin, so this answers "unknown" (and
  // therefore allows) anywhere but app.umbrava.com - by design.
  var BWN_PERM_KEY = 'bwn:perm:last';
  var BWN_PERM_TTL_MS = 24 * 3600 * 1000;
  var _bwnPermSlot = null;      // memoized parse; invalidated by the bwn:perm listener below
  function bwnPermSlot() {
    if (_bwnPermSlot) return _bwnPermSlot;
    try {
      var p = JSON.parse(localStorage.getItem(BWN_PERM_KEY) || 'null');
      if (p && p.ts && (Date.now() - p.ts) < BWN_PERM_TTL_MS &&
        Array.isArray(p.groups) && Array.isArray(p.granted)) _bwnPermSlot = p;
    } catch (e) { /* an unreadable cache reads as unknown, which fails open */ }
    return _bwnPermSlot;
  }
  function bwnCan(key) {
    var p = bwnPermSlot();
    if (!p) return true;                                          // nothing decoded yet -> allow
    var grp = String(key).split('.')[0];
    if (p.groups.indexOf(grp) === -1) return true;                // group unmapped/absent -> allow
    return p.granted.indexOf(key) !== -1;
  }
  // keys: a 'Group.Flag' string, or an array of them (ALL must be granted).
  function bwnCanAll(keys) {
    if (!keys) return true;
    if (typeof keys === 'string') return bwnCan(keys);
    for (var i = 0; i < keys.length; i++) { if (!bwnCan(keys[i])) return false; }
    return true;
  }
  // patchWorkOrder is ONE mutation over MANY fields and Umbrava gates each field separately, so
  // its permission depends on the variables rather than the operation. This maps the data keys the
  // suite actually sends, all of them wire-proven; a key this map does not know contributes NO
  // requirement, which is the block's unknown -> allow rule and keeps a future field from being
  // blocked by a map nobody updated. `workOrderNumber` is the identifier, not a field write.
  var BWN_PATCH_FIELD_PERM = {
    statusId: 'WorkOrderField.Status',
    assignedTo: 'WorkOrderField.AssignedTo',
    // ECD rides inside the whole-object `priority` replace, and the SPA bundles the SLA id with it.
    priority: 'WorkOrderField.CompletionSLA',
    serviceLevelAgreementId: 'WorkOrderField.CompletionSLA',
    sourceJobNumber: 'WorkOrderField.SourceJobNumber',
    sourcePurchaseOrderNumber: 'WorkOrderField.SourcePurchaseOrderNumber'
  };
  // -> [] | ['WorkOrderField.Status', ...]; deduped, so a bundled priority+SLA asks once.
  function bwnPermsForPatch(variables) {
    var data = (variables && variables.data) || {};
    var out = [];
    Object.keys(data).forEach(function (k) {
      var p = BWN_PATCH_FIELD_PERM[k];
      if (p && out.indexOf(p) === -1) out.push(p);
    });
    return out;
  }
  try {
    document.addEventListener('bwn:evt', function (e) {
      var d = e && e.detail;
      if (d && d.id === 'bwn:perm') _bwnPermSlot = null;          // a fresh decode landed
    });
  } catch (e) { }
  // ===== BWN-PERM END v1 =====
  function duGql(op, query, variables) {
    var tok = authToken();
    if (!tok) return Promise.reject(new Error('no-umbrava-token'));
    return fetch('/api/graphql', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
      body: JSON.stringify({ operationName: op, query: query, variables: variables || {} })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || 'GraphQL error');
      return j && j.data;
    });
  }

  // ---- BWN-OPS: audited GraphQL wrapper for this sandbox --------------------
  // bwnGqlOp lives in the paste-identical BWN-OPS-WRAP block below (SHA-gated to Core).
  // It needs a uniform bwnGql(query, variables); drop-upload transport is the 3-arg
  // duGql(op, query, variables), so this is the adapter. BWN_OPS is this file registry
  // (only the ops it routes); BWN_MODULES is the shared kill-switch blob (only an explicit
  // false disables). The audit ring buffer writes the shared bwn:audit key, so a note
  // posted here lands in the SAME audit trail as Core writes.
  function bwnGql(query, variables) { var m = /\b(?:query|mutation)\s+([A-Za-z0-9_]+)/.exec(query); return duGql(m ? m[1] : null, query, variables); }
  var BWN_MODULES = (function () { try { return JSON.parse(localStorage.getItem('bwn:modules') || '{}') || {}; } catch (e) { return {}; } })();
  var BWN_OPS = {
    addEditJobNote: { kind: 'write', perm: 'WorkOrderNote.AddNew', target: 'note', risk: 'moderate', idempotent: false, retry: 'none',
      ok: 'Note posted.', fail: 'The note was not posted.' },
    initializeJobDocument: { kind: 'write', perm: 'WorkOrderDocument.AddNew', target: 'document', risk: 'moderate', idempotent: false, retry: 'none',
      ok: 'Document upload started.', fail: 'The upload could not start.' },
    bulkAddWorkOrderDocuments: { kind: 'write', perm: 'WorkOrderDocument.AddNew', target: 'document', risk: 'moderate', idempotent: false, retry: 'none',
      ok: 'Documents attached.', fail: 'The documents were not attached.' }
  };
  // ===== BWN-OPS-WRAP START v3 (paste-identical across adopters; SHA-gated by scripts/test-bwn-ops.js) =====
  // v3 (2026-09-02) adds the Umbrava permission gate (G7 below). It closes over bwnCan/bwnCanAll
  // from the BWN-PERM block, so an adopter of this wrapper must carry that block too - the ledger
  // in scripts/test-perm-block-ledger.js is what keeps the two lists in step.
  // Generic machinery only - NO registry, NO window hook - so it is byte-identical in every
  // sandbox that adopts it (Core, drop-upload, ...). It closes over four things each sandbox
  // supplies on its own: BWN_OPS (that file's registry), BWN_MODULES (kill switches), BWN_VER,
  // and bwnGql(query, variables) (that file's same-origin transport). The audit ring buffer
  // writes to the shared localStorage key, so every sandbox's writes land in ONE audit trail.
  function bwnCorrId() {
    try { if (window.crypto && window.crypto.randomUUID) return 'bwn-' + window.crypto.randomUUID(); }
    catch (e) { /* fall through to the timestamp form */ }
    return 'bwn-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }

  // Bounded, PII-free audit ring buffer in localStorage. Records ONLY what the caller passes
  // (ids + scalar before/after) plus operation metadata - NEVER the raw variables or the
  // response, which can carry note text, addresses, or vendor identity.
  var BWN_AUDIT_KEY = 'bwn:audit', BWN_AUDIT_MAX = 200, BWN_AUDIT_SCHEMA = 1;
  function bwnAuditAll() {
    try { var a = JSON.parse(localStorage.getItem(BWN_AUDIT_KEY) || '[]'); return Array.isArray(a) ? a : []; }
    catch (e) { return []; }
  }
  function bwnAuditRecord(entry) {
    try {
      var a = bwnAuditAll();
      a.push(entry);
      if (a.length > BWN_AUDIT_MAX) a = a.slice(a.length - BWN_AUDIT_MAX);
      localStorage.setItem(BWN_AUDIT_KEY, JSON.stringify(a));
    } catch (e) { /* audit is best-effort - it must never block or fail a write */ }
    return entry;
  }
  function bwnAuditExport() {
    return JSON.stringify({ schema: BWN_AUDIT_SCHEMA, ver: BWN_VER, exportedTs: Date.now(), entries: bwnAuditAll() }, null, 2);
  }
  function bwnAuditClear() { try { localStorage.removeItem(BWN_AUDIT_KEY); } catch (e) { /* best-effort */ } }
  function bwnAuditActor() {
    try {
      var r = JSON.parse(localStorage.getItem('bwn:role:last') || 'null');
      return (r && (r.label || r.role)) || 'unknown';
    } catch (e) { return 'unknown'; }
  }

  // Only a network-level failure is transient. A GraphQL validation error comes back through
  // bwnGql as a thrown Error carrying the server's message (deterministic - retrying just
  // repeats it), and a write refused with success:false is flagged bwnNonTransient below.
  // ponytail: bwnGql does not surface the HTTP status, so 429/5xx are not distinguished here;
  // attach r.status in bwnGql and widen this test if status-aware backoff is ever needed.
  function bwnIsTransient(err) {
    if (err && err.bwnNonTransient) return false;
    return /network|failed to fetch|load failed|timeout|timed out/i.test(String(err && err.message || err));
  }
  function bwnBackoff(tryNo) { return Math.min(4000, 400 * Math.pow(2, tryNo - 1)); }
  function bwnDelay(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // bwnGqlOp(op, query, variables, opts) -> Promise(data)
  //   op        BWN_OPS key. THROWS if unregistered - a captured op must be classified before
  //             it can be sent, which is what keeps guessed selectors out of the suite.
  //   query     the captured GraphQL document TEXT - the caller owns it, never invented here.
  //   variables the variables object (sent as-is to bwnGql; never copied into the audit).
  //   opts      { feature, validate, ids, before, after, actor } - all optional:
  //     feature   BWN_MODULES key; if that module is switched off the op is REFUSED and, for a
  //               write, audited outcome:'denied' - this is the per-feature kill switch.
  //     validate  fn(variables) -> true | 'message'; a write is blocked before it is sent.
  //     ids       { wo, po, vendorId, ... } scalar identifiers for the audit trail (NO PII).
  //     before    scalar snapshot of the value(s) about to change (NO PII, NO bulk data).
  //     after     scalar snapshot of the intended new value(s).
  //     actor     who initiated; defaults to the last-known rank label, else 'unknown'.
  // Reads resolve to `data`. A write whose {success,message} envelope says success:false is
  // REJECTED (never a silent false - the exact bug class the op-catalog warns about) and
  // audited outcome:'error'.
  // Injected per-sandbox by a caller that owns a high-risk write's confirmation UI, via
  // bwnGqlOp.setConfirm(fn). A risk:'high' write is refused unless the caller either passes
  // opts.confirmed===true (it confirmed through its own UI) OR a confirm handler returns truthy.
  var _confirmFn = null;
  function bwnGqlOp(op, query, variables, opts) {
    opts = opts || {};
    var meta = BWN_OPS[op];
    if (!meta) return Promise.reject(new Error('bwnGqlOp: unregistered operation "' + op + '"'));
    var isWrite = meta.kind === 'write';
    var corrId = bwnCorrId();
    var t0 = Date.now();
    var actor = opts.actor || bwnAuditActor();

    function writeAudit(outcome, extra) {
      if (!isWrite) return;
      var e = {
        ts: Date.now(), corrId: corrId, op: op, kind: meta.kind, target: meta.target,
        risk: meta.risk || null, actor: actor, ids: opts.ids || null,
        before: (opts.before === undefined ? null : opts.before),
        after: (opts.after === undefined ? null : opts.after),
        outcome: outcome, ms: Date.now() - t0, ver: BWN_VER
      };
      if (extra) { for (var k in extra) { if (Object.prototype.hasOwnProperty.call(extra, k)) e[k] = extra[k]; } }
      bwnAuditRecord(e);
    }

    // Fail-closed write classification (G5): a WRITE must carry a RECOGNIZED risk tier. An
    // unclassified write - a registry entry whose risk is missing or misspelled - is REFUSED here
    // rather than sent unlabelled, so a new mutation cannot slip past the governance by omitting
    // its risk. 'low'/'moderate' skip the confirm gate below; 'high' hits it; anything else fails
    // closed. Reads are unaffected (isWrite guards this). Audited denied so the refusal is visible.
    if (isWrite && meta.risk !== 'low' && meta.risk !== 'moderate' && meta.risk !== 'high') {
      writeAudit('denied', { reason: 'unclassified-write:' + (meta.risk || 'none') });
      return Promise.reject(new Error('bwnGqlOp: write "' + op + '" has no recognized risk classification'));
    }
    // Per-feature kill switch: a disabled module must not mutate even if its UI leaked in.
    if (opts.feature && BWN_MODULES[opts.feature] === false) {
      writeAudit('denied', { reason: 'feature-off:' + opts.feature });
      return Promise.reject(new Error('bwnGqlOp: feature "' + opts.feature + '" is disabled'));
    }
    // Umbrava permission gate (G7). The UI hides a control the operator's checkboxes do not cover,
    // but hiding is not enforcement: a palette entry, a stale drawer, a queued command, or a future
    // caller can all reach a write whose button was never rendered. This is the enforcement point -
    // every registered write passes through here, so ONE guard covers every caller.
    //   meta.perm  'Group.Flag' | ['Group.Flag', ...] | fn(variables) -> either of those
    // A function is how a multi-field mutation (patchWorkOrder) asks per FIELD instead of per op.
    // bwnCanAll fails OPEN on anything undecided - no slot, a stale slot, an unmapped group - so
    // this refuses ONLY a positively-known missing checkbox. Refusals are non-transient (retrying
    // cannot grant a permission) and audited `denied`, so a refusal is visible in the ring rather
    // than silent. The reason carries the permission NAME, which is a static key, never user data.
    if (isWrite && meta.perm) {
      var need = (typeof meta.perm === 'function') ? meta.perm(variables) : meta.perm;
      if (typeof need === 'string') need = [need];
      if (!Array.isArray(need)) need = [];
      if (need.length && !bwnCanAll(need)) {
        var missing = need.filter(function (k) { return !bwnCan(k); });
        writeAudit('denied', { reason: 'permission:' + missing.join('+') });
        var noPerm = new Error('bwnGqlOp: "' + op + '" needs Umbrava permission ' + missing.join(' + ') + ' - the write was NOT sent.');
        noPerm.bwnNonTransient = true;
        noPerm.bwnPermissionDenied = missing;
        return Promise.reject(noPerm);
      }
    }
    // Validate a write BEFORE it leaves the browser.
    if (isWrite && typeof opts.validate === 'function') {
      var vr = opts.validate(variables);
      if (vr !== true) {
        writeAudit('denied', { reason: 'validation:' + vr });
        return Promise.reject(new Error('bwnGqlOp: validation failed for "' + op + '": ' + vr));
      }
    }

    var maxTries = (meta.retry === 'safe' && (meta.kind === 'read' || meta.idempotent === true)) ? 3 : 1;
    function attempt(tryNo) {
      return bwnGql(query, variables).then(function (data) {
        if (isWrite) {
          var env = data && data[op];
          // F3: fail closed on an unrecognized write response. A registered write MUST return
          // { success: <bool>, ... } under its own field name (op === the response field name
          // for every adopter). A missing data[op] (a name/alias mismatch) or a non-boolean
          // success means the write cannot be confirmed to have landed - classify it as an
          // error, never a silent 'ok'. Verified safe: every current adopter selects `success`.
          if (!env || typeof env.success !== 'boolean') {
            var badShape = new Error(op + ': unrecognized write response (no {success} under data.' + op + ')');
            badShape.bwnNonTransient = true;
            writeAudit('error', { tries: tryNo, reason: 'unexpected-response-shape' });
            throw badShape;
          }
          if (env && env.success === false) {
            var refused = new Error(env.message || (op + ' was refused'));
            refused.bwnNonTransient = true;
            // F5: record a fixed category, never the server message (env.message can echo
            // input-derived text). The message still rides the thrown `refused` to the caller.
            writeAudit('error', { tries: tryNo, reason: 'write-refused' });
            throw refused;
          }
          writeAudit('ok', { tries: tryNo });
        }
        return data;
      }, function (err) {
        if (bwnIsTransient(err) && tryNo < maxTries) {
          return bwnDelay(bwnBackoff(tryNo)).then(function () { return attempt(tryNo + 1); });
        }
        // F5: audit a fixed category, never the raw error text (which can echo input-derived
        // server strings into the "PII-free" trail). The full error still rides the thrown err
        // to the caller for its toast/log.
        writeAudit('error', { tries: tryNo, reason: bwnIsTransient(err) ? 'transient-failure' : 'request-failed' });
        throw err;
      });
    }
    // High-risk confirmation gate (fail-closed, by construction). F4: a risk:'high' write has
    // NO path to the transport except through this block - it returns in every sub-case (send
    // or reject), so the trailing `return attempt(1)` below is reachable only by non-high-risk
    // ops. A future high-risk writer therefore cannot skip the gate by omission: an absent
    // confirmation is refused, never silently sent. Confirmation is proven EITHER by the
    // caller's own UI (opts.confirmed===true, e.g. dispatch's modal) OR by an injected _confirmFn
    // returning truthy.
    // KNOWN RESIDUAL (flagged, NOT closed here): opts.confirmed===true is a caller assertion the
    // wrapper trusts - it cannot tell a genuine confirm from a hardcoded literal. Closing that
    // would mean dropping bare-boolean trust and mandating an injected _confirmFn, which every
    // current high-risk adopter would fail (none inject one) - a live-behavior change, out of scope.
    if (isWrite && meta.risk === 'high') {
      if (opts.confirmed !== true) {
        if (typeof _confirmFn !== 'function') {
          writeAudit('denied', { reason: 'confirm-required' });
          return Promise.reject(new Error('bwnGqlOp: "' + op + '" is high-risk and needs confirmation (no confirm handler set)'));
        }
        var details = {
          op: op, target: meta.target, risk: meta.risk, ids: opts.ids || null,
          current: (opts.current === undefined ? null : opts.current),
          proposed: (opts.proposed === undefined ? null : opts.proposed),
          count: (opts.count === undefined ? null : opts.count),
          reason: opts.reason || null, irreversible: !!opts.irreversible
        };
        return Promise.resolve().then(function () { return _confirmFn(details); }).then(function (okd) {
          if (!okd) {
            writeAudit('denied', { reason: 'user-cancelled' });
            throw new Error('bwnGqlOp: "' + op + '" cancelled at confirmation');
          }
          return attempt(1);
        });
      }
      return attempt(1);
    }
    return attempt(1);
  }
  bwnGqlOp.setConfirm = function (fn) { _confirmFn = (typeof fn === 'function') ? fn : null; };
  // ===== BWN-OPS-WRAP END v3 =====

  // Doc-label id map, read live off the MUI Autocomplete options (the SPA loads it once at boot,
  // never on the wire). The names are stable tenant reference data; drop-upload only ever needs
  // "Work Order Request" (17), but the whole map is kept so a caller can pass any label by name.
  var DOC_LABELS = {
    'Contract': 0, 'Drawings': 2, 'Signoff': 3, 'Photo': 4, 'Permits': 6, 'Survey': 10,
    'Invoice': 12, 'Proposal Approved': 13, 'Proposal Declined': 14, 'Vendor Correspondence': 15,
    'Client Correspondence': 16, 'Work Order Request': 17, 'Supplier Correspondence': 18,
    'Location Correspondence': 19, 'Vendor Proposal': 20, 'Supplier Proposal': 21,
    'Client Proposal': 22, 'Internal': 23, 'Resale': 24, 'Certification': 25,
    'Municipal Correspondence': 26, 'Video': 28, 'Receipt': 29
  };
  function docLabelId(name) { var v = DOC_LABELS[name]; return (typeof v === 'number') ? v : null; }

  // Note-type id, resolved by NAME so the numeric ids are never hardcoded past a floor. The suite
  // caches the full id->name map in localStorage bwn:noteTypes (populated by Core); we invert it.
  // Fallback floor covers the three the party-typer produces, so a missing cache never blocks a note.
  var NOTE_TYPE_FALLBACK = { 'Internal': 13, 'Vendor': 18, 'Client': 55 };
  function noteTypeId(name) {
    if (!name) return null;
    try {
      var cache = JSON.parse(localStorage.getItem('bwn:noteTypes') || 'null');
      var map = cache && cache.map;
      if (map) {
        for (var id in map) { if (String(map[id]).toLowerCase() === String(name).toLowerCase()) return parseInt(id, 10); }
      }
    } catch (e) { }
    var f = NOTE_TYPE_FALLBACK[name];
    return (typeof f === 'number') ? f : null;
  }

  // Curated Type picker for the review box: the note types a coordinator actually files a dropped
  // email or document under, in relevance order (parties first). Umbrava has 82 note types, most of
  // them system/workflow (Auto Fax, Chargeback, EMS, Recruit, ...) that never apply to a drop, so we
  // do NOT dump the whole map. Names must match Umbrava's bwn:noteTypes vocabulary EXACTLY - that is
  // how postNoteViaApi resolves the numeric id. ponytail: hand-maintained allowlist, same pattern as
  // CLIENT_DOMAINS; add a name to surface it, remove one to hide it.
  var CURATED_NOTE_TYPES = [
    'Client', 'Vendor', 'Internal', 'Supplier', 'Email',
    'Escalation', 'Hold', 'Client Hold', 'Recap', 'Resolution', 'Action',
    'Scope Confirmed', 'Reschedule Date', 'Missed ETA', 'Confirmed Complete',
    'Billing', 'Client NTE Issue', 'Vendor NTE Issue',
    'Proposal Approved', 'Proposal Declined', 'Other'
  ];
  // The curated names Umbrava ACTUALLY has, in curated order (an entry the tenant lacks is dropped
  // so a picked type always resolves to a real id). Reads the shared bwn:noteTypes cache Core keeps
  // warm on WO pages; falls back to the party-typer's three when the cache is cold.
  function noteTypeNames() {
    try {
      var cache = JSON.parse(localStorage.getItem('bwn:noteTypes') || 'null');
      var map = cache && cache.map;
      if (map) {
        var have = {};
        for (var id in map) { var n = String(map[id] == null ? '' : map[id]).trim(); if (n) have[n.toLowerCase()] = 1; }
        var names = CURATED_NOTE_TYPES.filter(function (n) { return have[n.toLowerCase()]; });
        if (names.length) return names;
      }
    } catch (e) { }
    return ['Client', 'Vendor', 'Internal'];
  }

  // Plain text -> paragraph HTML (blank line = new <p>, single newline = <br>), matching what the
  // old TipTap paste path produced so a posted note reads like the email.
  function textToHtml(text) {
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    return String(text).replace(/\r\n/g, '\n').split(/\n{2,}/)
      .map(function (p) { return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
  }

  var MUT_ADD_NOTE = 'mutation AddEditWONote($addEditInput: WorkOrderNoteInput!) { addEditJobNote(data: $addEditInput) { success message note { id type } } }';
  var MUT_INIT_DOC = 'mutation InitializeJobDocument($workOrderNumber: Int, $data: NewFileInput!) { initializeJobDocument(workOrderNumber: $workOrderNumber, data: $data) { success message sasToken { documentInfoId uriWithSas displayFileName } } }';
  var MUT_BULK_ADD = 'mutation BulkAddWorkOrderDocuments($data: BulkAddWorkOrderDocumentsInput!) { bulkAddWorkOrderDocuments(data: $data) { success message documentIds } }';

  // Post a WO note via addEditJobNote. type is the numeric note-type id (resolved from the name).
  // Returns Promise<createdNote>; throws on no-token / GraphQL error / success:false.
  function postNoteViaApi(text, typeName, woNumber) {
    var typeId = noteTypeId(typeName);
    var input = {
      workOrderNumber: woNumber,
      type: typeId,
      content: String(text),
      contentHtml: textToHtml(text),
      isCompletion: false,
      isInvoice: false,
      isPinned: false,
      actionNoteEmails: null,
      targetPurchaseOrderNumbers: []
    };
    // Routed through bwnGqlOp (BWN-OPS): correlation id + shared audit entry + pre-send
    // validate; the wrapper rejects a success:false envelope, so no inline success check.
    return bwnGqlOp('addEditJobNote', MUT_ADD_NOTE, { addEditInput: input }, {
      ids: { wo: woNumber },
      validate: function (v) {
        var a = v && v.addEditInput;
        if (!a || a.workOrderNumber == null || typeof a.content !== 'string' || !a.content) return 'missing WO number or note content';
        return true;
      }
    }).then(function (d) {
      return d && d.addEditJobNote && d.addEditJobNote.note;
    });
  }

  // Upload ONE file: initializeJobDocument -> reserve blob + SAS, PUT the bytes, return the entry
  // BulkAddWorkOrderDocuments needs. rawFile is the real File (Blob body + name/size); description
  // is free text; labelId the numeric doc-label id. Throws on any step failing.
  function uploadOneViaApi(rawFile, description, labelId, woNumber) {
    return bwnGqlOp('initializeJobDocument', MUT_INIT_DOC, {
      workOrderNumber: woNumber,
      // fileSize is a STRING in the live schema, NOT Int (the captured request body couldn't reveal the
      // type; a live drop errored "String cannot represent a non string value: <bytes>" at data.fileSize).
      data: { fileName: rawFile.name, fileSize: String(rawFile.size) }
    }, { ids: { wo: woNumber } }).then(function (d) {
      var init = d && d.initializeJobDocument;
      if (!init || init.success !== true || !init.sasToken || !init.sasToken.uriWithSas) {
        throw new Error((init && init.message) || 'initializeJobDocument returned no SAS');
      }
      var sas = init.sasToken;
      return fetch(sas.uriWithSas, { method: 'PUT', headers: { 'x-ms-blob-type': 'BlockBlob' }, body: rawFile })
        .then(function (r) {
          if (!r.ok) throw new Error('blob PUT ' + r.status);
          var entry = { workOrderNumber: woNumber, documentInfoId: sas.documentInfoId, description: String(description || '') };
          if (typeof labelId === 'number') entry.label = labelId;
          return entry;
        });
    });
  }

  // Upload every file via the API, then ONE bulkAdd registers them. rawFiles[i] pairs with
  // describedFiles[i] (both built from the same raw list, same order). Returns Promise<documentIds>;
  // throws (so the caller can fall back to the DOM dialog) if init/PUT/bulkAdd fails.
  function uploadViaApi(rawFiles, describedFiles, labelName, woNumber) {
    if (!woNumber) return Promise.reject(new Error('no-wo-number'));
    if (!rawFiles || !rawFiles.length) return Promise.reject(new Error('no-files'));
    var jobs = [];
    for (var i = 0; i < rawFiles.length; i++) {
      var desc = (describedFiles && describedFiles[i] && describedFiles[i].desc) || '';
      // labelName may be a FUNCTION of the file, not one name for the batch: the WO-intake handoff
      // labels the request email "Work Order Request" but its photo attachments "Photo". One drop,
      // two document types - and there is no update-label mutation, so each has to be right here.
      var nm = (typeof labelName === 'function') ? labelName(rawFiles[i]) : labelName;
      jobs.push(uploadOneViaApi(rawFiles[i], desc, nm ? docLabelId(nm) : null, woNumber));
    }
    return Promise.all(jobs).then(function (entries) {
      return bwnGqlOp('bulkAddWorkOrderDocuments', MUT_BULK_ADD, { data: { workOrderNumber: woNumber, documents: entries } }, { ids: { wo: woNumber } })
        .then(function (d) {
          var res = d && d.bulkAddWorkOrderDocuments;
          if (!res || res.success !== true) throw new Error((res && res.message) || 'bulkAddWorkOrderDocuments reported no success');
          return res.documentIds || [];
        });
    });
  }

  // ===== bwnAI v1 - shared suite-wide AI router - KEEP IN SYNC across suite scripts =====
  // Single tiered helper (spec: [[bwn-ai-tiering]]). Generalizes this module's original
  // on-device aiSummary into a router every module can call the same way. Three tiers:
  //   local    - a module-supplied mechanical fn (no model). Always-available floor.
  //   ondevice - Chrome's built-in Prompt API (Gemini Nano). Free, zero-egress, no key,
  //              @grant none. Everyone. Good for summaries/labels/short classification.
  //   proxy    - one SERVER key behind the bwn-ai SWA (Claude/Haiku). Rank-gated to
  //              managers+ (BWN_AI_ADVANCED_MIN_RANK, default 4). The network transport
  //              is INJECTED by a grant-holding script via bwnAI.setProxy(fn); modules
  //              that are @grant none (this one) never attempt it - proxy simply misses
  //              and the router falls through to on-device / local.
  // Contract: async, self-bounded by timeoutMs, ALWAYS resolves (never throws), returns
  // '' (or the local result) on any miss. Paste this block verbatim into any module that
  // needs AI; only put the block here, never a key. This is UX/cost routing - the SERVER
  // re-enforces the rank on the proxy tier (403 ROLE_REQUIRED, treated here as a miss).
  var bwnAI = (function () {
    var TASK_TIER = { summarize: 'ondevice', classify: 'ondevice', draft: 'proxy', render: 'proxy' };
    var TASK_ONELINE = { summarize: true, classify: true };
    var TASK_SYSTEM = {
      summarize: 'Summarize the input into a single plain-text line (<=200 chars). No greeting, no sign-off, no preamble, no quotes - output only the one line.',
      classify: 'Classify the input. Respond with ONLY a short label of a few words - no explanation, no punctuation beyond the label.',
      draft: 'Draft a short, professional message for a facilities coordinator. Clear and courteous. Output only the message body - no preamble.',
      render: 'Synthesize the provided work-order details into a clear, well-structured plain-text brief for a facilities coordinator. Output only the brief.'
    };
    var ROLE_TTL_MS = 6 * 3600 * 1000;   // trust the cross-refresh role slot this long

    // ---- Rank read (client, cost/UX only - the server is the real gate) ----------
    // @grant-none-safe: the AI script resolves the SERVER-computed rank once per session
    // ([[umbrava-role-auth]]) and publishes it on the `bwn:role` bus event + the
    // localStorage `bwn:role:last` slot. A live bus event is trusted directly; the slot
    // is the cross-refresh fallback, trusted only when marked ok + fresh. Never re-fetches.
    var _liveRank = null;
    try {
      document.addEventListener('bwn:evt', function (e) {
        var d = e && e.detail;
        if (d && d.id === 'bwn:role' && typeof d.rank === 'number') _liveRank = d.rank;
      });
    } catch (e) { /* no document (worker) - rank stays unknown -> on-device */ }
    function rank() {
      if (typeof _liveRank === 'number') return _liveRank;
      try {
        var r = JSON.parse(localStorage.getItem('bwn:role:last') || 'null');
        if (r && r.ok && typeof r.rank === 'number' && r.ts && (Date.now() - r.ts) < ROLE_TTL_MS) return r.rank;
      } catch (e2) { }
      return null;
    }

    // ---- On-device (Chrome built-in Prompt API) -----------------------------------
    function langModel() {
      // The Prompt API surface has shifted across Chrome versions; probe the globals.
      var g = (typeof self !== 'undefined') ? self : (typeof window !== 'undefined' ? window : null);
      if (typeof LanguageModel !== 'undefined' && LanguageModel) return LanguageModel;
      if (g && g.LanguageModel) return g.LanguageModel;
      if (g && g.ai && g.ai.languageModel) return g.ai.languageModel;   // older window.ai shape
      return null;
    }
    function ready(api) {
      // Newer: availability() -> 'available'|'downloadable'|'downloading'|'unavailable'.
      // Older: capabilities() -> {available:'readily'|'after-download'|'no'}. Only
      // 'available'/'readily' means we can infer NOW without a multi-GB model download.
      try {
        if (typeof api.availability === 'function') return Promise.resolve(api.availability()).then(function (s) { return s === 'available'; }, function () { return false; });
        if (typeof api.capabilities === 'function') return Promise.resolve(api.capabilities()).then(function (c) { return !!c && c.available === 'readily'; }, function () { return false; });
      } catch (e) { }
      return Promise.resolve(false);
    }
    // Reuse one session PER system prompt (a new task/system gets its own; recreated on error).
    var SESSIONS = {};
    function session(api, sys) {
      var cached = SESSIONS[sys];
      if (cached) return Promise.resolve(cached);
      function keep(hasSystem) { return function (s) { try { s._bwnSystem = hasSystem; } catch (e) { } SESSIONS[sys] = s; return s; }; }
      // Prefer the system-prompt option; fall back to a bare session (older/newer variants)
      // where the instruction is prepended to the user prompt instead (_bwnSystem = false).
      return Promise.resolve(api.create({ initialPrompts: [{ role: 'system', content: sys }], outputLanguage: 'en' }))
        .then(keep(true), function () { return Promise.resolve(api.create({ outputLanguage: 'en' })).then(keep(false)); });
    }
    function onDevice(sys, content) {
      var api = langModel();
      if (!api || typeof api.create !== 'function') return Promise.resolve('');
      return ready(api).then(function (ok) {
        if (!ok) return '';
        return session(api, sys).then(function (s) {
          var usedSystem = !!(s && s._bwnSystem !== false);   // best-effort; harmless if unknown
          return s.prompt((usedSystem ? '' : sys + '\n\n') + content);
        });
      }).catch(function () { SESSIONS[sys] = null; return ''; });   // drop a bad cached session
    }

    // ---- Proxy (server key, injected transport) -----------------------------------
    // A grant-holding script installs the real cross-origin sender:
    //   bwnAI.setProxy(function (payload) { ... return Promise<string text>; })
    // payload = {task, system, prompt, maxTokens, minRank, rank}. The sender owns auth
    // (token in the JSON BODY, never Authorization - the SWA edge overwrites it) and must
    // RESOLVE '' / REJECT on any miss (403 ROLE_REQUIRED, network, empty) so we fall through.
    var _proxySend = null;
    function proxy(payload, send) {
      var fn = send || _proxySend;
      if (typeof fn !== 'function') return Promise.resolve('');   // no transport -> miss
      return Promise.resolve().then(function () { return fn(payload); })
        .then(function (t) { return String(t || ''); }, function () { return ''; });
    }

    function withTimeout(p, ms) {
      return new Promise(function (resolve) {
        var t = setTimeout(function () { resolve(undefined); }, ms);
        Promise.resolve(p).then(function (v) { clearTimeout(t); resolve(v); }, function () { clearTimeout(t); resolve(undefined); });
      });
    }
    function clean(text, oneLine, maxChars) {
      var s = String(text || '');
      if (oneLine) s = s.replace(/\s+/g, ' ').replace(/^["']+|["']+$/g, '');
      return s.trim().slice(0, maxChars);
    }

    // ---- Router -------------------------------------------------------------------
    function bwnAI(opts) {
      opts = opts || {};
      var task = opts.task || 'summarize';
      var oneLine = (opts.oneLine !== undefined) ? !!opts.oneLine : !!TASK_ONELINE[task];
      var maxChars = opts.maxChars || (oneLine ? 300 : 4000);
      var sys = opts.system || TASK_SYSTEM[task] || TASK_SYSTEM.summarize;
      var content = (opts.prompt != null) ? String(opts.prompt)
        : (typeof opts.input === 'string' ? opts.input : (opts.input != null ? JSON.stringify(opts.input) : ''));
      var localFn = (typeof opts.local === 'function') ? opts.local : null;
      var floor = function () { try { return localFn ? clean(localFn(), oneLine, maxChars) : ''; } catch (e) { return ''; } };

      // Ordered tier list: desired ceiling first (task default, unless tier overrides),
      // then the fallback chain. Deduped, capped at proxy when tier says 'ondevice'.
      var desired = (opts.tier && opts.tier !== 'auto') ? opts.tier : (TASK_TIER[task] || 'ondevice');
      var order = [desired].concat(opts.fallback || ['ondevice', 'local']);
      var seen = {}, tiers = [];
      order.forEach(function (t) { if (t && !seen[t]) { seen[t] = 1; tiers.push(t); } });

      var minRank = (typeof opts.minRank === 'number') ? opts.minRank : 4;
      var r = rank();

      function step(i) {
        if (i >= tiers.length) return Promise.resolve('');
        var t = tiers[i], next = function () { return step(i + 1); };
        if (t === 'local') { return Promise.resolve(floor()); }   // terminal floor
        if (t === 'proxy') {
          // Fail CLOSED: unknown/under-rank quietly skips the paid tier (no 403 flash, no
          // wasted key) and drops to on-device. The server still backstops if we do send.
          if (r == null || r < minRank) return next();
          return proxy({ task: task, system: sys, prompt: content, maxTokens: opts.maxTokens, minRank: minRank, rank: r }, opts.proxySend)
            .then(function (out) { out = clean(out, oneLine, maxChars); return out || next(); });
        }
        if (t === 'ondevice') {
          return onDevice(sys, content).then(function (out) { out = clean(out, oneLine, maxChars); return out || next(); });
        }
        return next();
      }

      var run = step(0).then(function (out) { return out || floor(); });
      return withTimeout(run, opts.timeoutMs || 8000).then(function (v) { return v || floor() || ''; });
    }
    bwnAI.setProxy = function (fn) { _proxySend = (typeof fn === 'function') ? fn : null; };
    bwnAI.rank = rank;   // exposed for debug / gating UI
    return bwnAI;
  })();
  // ===== END bwnAI =====

  // ---- On-device AI brief (now via the shared bwnAI router) ------------------
  // Summarizes the NEW message (thread already trimmed by tidyBody) into a SHORT 2-4 sentence brief
  // that LEADS the WO note - who sent it, what was done/reported, and any next step / date / WO-PO /
  // dollar figure. ON-DEVICE only (drop-upload is @grant none / zero-egress): Chrome's Gemini Nano or
  // Edge's Phi-4-mini, whichever the browser exposes as `LanguageModel`. Returns '' on any miss (model
  // off, timeout); describeFile then leads with the mechanical one-liner instead. NOT oneLine, so the
  // sentences and any line breaks survive; capped so a runaway generation can't bloat the note.
  function aiBrief(m) {
    var from = (m.fromName || smtpAddr(m.fromEmail) || '').trim();
    var to = (m.to || []).map(function (r) { return r.name || smtpAddr(r.email); }).filter(Boolean).join(', ');
    var body = tidyBody(m.body).slice(0, 4000);   // the NEW message only - thread cut
    var content = 'From: ' + from + '\nTo: ' + to + '\nSubject: ' + String(m.subject || '') + '\n\n' + body;
    return bwnAI({
      task: 'summarize',
      tier: 'ondevice',
      oneLine: false,
      maxChars: 700,
      system: 'You summarize ONE work-order email for a facilities coordinator into a SHORT brief of 2 to 4 plain sentences. State who sent it, what was done or is being reported, and any next step, dates, work-order or PO numbers, or dollar amounts mentioned. No greeting, no sign-off, no preamble, no bullet points, no quotes - output only the sentences.',
      prompt: content,
      fallback: ['ondevice'],   // local floor handled by describeFile's mechanical path
      timeoutMs: 9000
    });
  }

  // Background upgrade: after the note box is already up (with the fast mechanical lead), run the SLOW
  // on-device AI brief per email and swap it into the note when it lands - so the model never delays the
  // drop, the upload, or the box appearing. Patches the file's noteBlock, rebuilds pending.noteText, and
  // refreshes the textarea IN PLACE - but only if the box is still the current one AND the user has not
  // edited it (their edits always win). Idempotent: each email is enriched once (aiPending -> false when
  // claimed); a merge drop re-runs and only touches the newly added files. Never throws.
  function enrichNoteWithAI(pend) {
    if (!pend || !pend.files || !pend.files.length) return;
    pend.files.forEach(function (f) {
      if (!f || !f.isEmail || !f.email || !f.aiPending) return;
      f.aiPending = false;   // claim once - a failed/empty call keeps the mechanical lead, no retry
      aiBrief(f.email).then(function (brief) {
        if (!brief) return;
        var block;
        try { block = formatEmailBlock(f.email, brief); } catch (e) { return; }
        if (!block) return;
        f.summary = brief; f.aiUsed = true; f.noteBlock = block;
        // Only touch the live UI if this drop is still the current pending and its box is still open.
        if (pending !== pend || !noteBox) return;
        var newText;
        try { newText = buildNoteText(pend.files); } catch (e2) { return; }
        pend.noteText = newText;
        var ta = noteBox.__ta;
        if (ta && !noteBox.__noteEdited) { ta.value = newText; }
      }).catch(function () { });
    });
  }

  // Build per file: {kind, name, size, desc (short - Description field/clipboard),
  // noteLine (one-line WO-note fallback), and for emails isEmail + email model +
  // summary + noteBlock (the full Outlook-style block, led by the summary)}.
  // Email parsing is async (FileReader). The summary is the on-device AI line when
  // available, else the local field-extraction - either way, nothing leaves the browser.
  function describeFile(f) {
    var kind = fileKind(f);
    var base = { kind: kind, name: f.name || '(unnamed)', size: humanSize(f.size) };
    if (kind !== 'Email') {
      base.desc = kind + ' - ' + base.name + ' (' + base.size + (f.lastModified ? ', ' + shortDate(f.lastModified) : '') + ')';
      base.noteLine = '• ' + base.name + ' - ' + kind + ', ' + base.size;
      return Promise.resolve(base);
    }
    return new Promise(function (resolve) {
      var isMsg = /\.msg$/i.test(f.name || '');
      var done = false;
      function finish(v) { if (!done) { done = true; resolve(v); } }
      // Minimal fallback used by the timeout / read-error / parse-failure paths.
      function fallback(extra) {
        base.isEmail = true; base.email = null; base.noteBlock = '';
        base.desc = 'Email - ' + base.name;
        base.noteLine = '• ' + base.name + ' - Email' + (extra || '');
        finish(base);
      }
      // Belt-and-suspenders timeout (network-share / OneDrive-placeholder reads can
      // stall) - the upload flow must never wait on a description.
      setTimeout(function () { fallback(''); }, 10000);
      var rd = new FileReader();
      rd.onerror = function () { fallback(' (could not read contents)'); };
      rd.onload = function () {
        var m;
        try {
          m = isMsg ? parseMsg(rd.result) : emlToModel(parseEml(String(rd.result || '')));
        } catch (e) { return fallback(''); }
        try {
          var mech = '';
          try { mech = localSummary(m); } catch (e2) { mech = ''; }   // WO-request field extraction; '' unless it IS a request
          var generic = '';
          try { generic = emailLead(m); } catch (e2b) { generic = ''; }   // reply -> its body ("<Responder>: ..."); original -> "<Sender>: Sent <Subject>"
          // Resolve NOW with the mechanical lead - the on-device AI brief is SLOW, so it must not block
          // the drop, the upload, or the note box. enrichNoteWithAI() runs aiBrief in the background and
          // swaps the brief into the note when it lands (base.aiPending marks this email as not-yet-done).
          // localSummary is deliberately NOT the lead: it's a WO-request extractor and misframes a reply.
          var lead = generic || emailDesc(m, base.name);
          var line = generic || mech || emailDesc(m, base.name);   // short line for the doc Description + bullet
          var block = formatEmailBlock(m, lead);
          if (!block) return fallback('');
          base.isEmail = true; base.email = m; base.summary = lead; base.aiUsed = false; base.aiPending = true;
          base.noteBlock = block;
          base.desc = line ? line.slice(0, 300) : emailDesc(m, base.name);
          base.noteLine = '• ' + (line || m.subject || base.name) + ' - Email';
          finish(base);
        } catch (e3) { fallback(''); }
      };
      if (isMsg) rd.readAsArrayBuffer(f); else rd.readAsText(f);
    });
  }

  // ---- Pending upload summary (drop → dialog → Upload click → WO note) --------

  var pending = null;                                      // { ts, files:[described], noteText, originTab }
  // A manual drop HOLDS its files here (never auto-uploads) so the coordinator picks the document
  // TYPE before it is committed - there is no update-label mutation, so the label must be right at
  // bulkAdd time. The review box's Upload button fires runApiUpload with the chosen type and sets
  // .fired. The WO-intake handoff leaves this null (it forces 'Work Order Request' and uploads on
  // handoff), so the box shows no type picker there. { raw:[File], described:Promise<[described]>, ctx, fired }
  var pendingUpload = null;
  var PENDING_TTL = 15 * 60000;

  var NOTE_CAP = 6000;
  function buildNoteText(files) {
    var emailBlocks = files.filter(function (d) { return d.isEmail && d.noteBlock; });
    // A single email dropped on its own → the note IS the email (clean, matches
    // Outlook's own copy: From/Sent/To/Cc/Subject + the message body).
    if (files.length === 1 && emailBlocks.length === 1) {
      var t = emailBlocks[0].noteBlock;
      return t.length > NOTE_CAP ? t.slice(0, NOTE_CAP) + '…' : t;
    }
    var out = ['Uploaded to Documents (' + shortDate() + '):'];
    files.forEach(function (d) {
      if (d.isEmail && d.noteBlock) { out.push(''); out.push('- ' + d.name + ' -'); out.push(d.noteBlock); }
      else out.push(d.noteLine);
    });
    var text = out.join('\n');
    return text.length > NOTE_CAP ? text.slice(0, NOTE_CAP) + '…' : text;
  }

  // ---- Umbrava upload dialog plumbing --------------------------------------
  // The Upload dialog is react-dropzone: a zone div (onDrop React prop) wrapping
  // a hidden multiple-file input. We hand files over by dispatching synthetic
  // dragenter/dragover/drop events carrying a real DataTransfer at the zone.

  function dialogEl() {
    return document.querySelector('[role="dialog"], .MuiDialog-root');
  }

  function dialogFileInput() {
    return document.querySelector('[role="dialog"] input[type="file"], .MuiDialog-root input[type="file"]');
  }

  function documentsUploadButton() {
    return document.querySelector('[data-testid="documents-split-left-button"]');
  }

  function documentsTab() {
    var tabs = document.querySelectorAll('[role="tab"]');
    for (var i = 0; i < tabs.length; i++) {
      if ((tabs[i].textContent || '').trim() === 'Documents') return tabs[i];
    }
    return null;
  }

  function forwardToZone(input, dt) {
    var zone = input.parentElement || input;
    ['dragenter', 'dragover', 'drop'].forEach(function (type) {
      var ev = new DragEvent(type, { bubbles: true, cancelable: true });
      // DragEvent init ignores dataTransfer in Chrome; attach it directly.
      Object.defineProperty(ev, 'dataTransfer', { value: dt });
      zone.dispatchEvent(ev);
    });
  }

  function setNativeValue(el, val) {
    var proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    // Reset React's value tracker so it registers a change (else a controlled input
    // whose cached value already matches skips its onChange and never updates state).
    try { if (el._valueTracker) el._valueTracker.setValue('\u0000' + val); } catch (e) { }
    try { Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, val); } catch (e2) { el.value = val; }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  // Clipboard write with a synchronous execCommand fallback (the async Clipboard API
  // can reject when the drop gesture has expired or the doc isn't focused). Resolves
  // true only if the text actually landed - callers gate their "press Ctrl+V" wording
  // on it so we never tell the coordinator to paste an empty clipboard.
  function copyText(text) {
    return new Promise(function (resolve) {
      var done = false;
      function fin(v) { if (!done) { done = true; resolve(v); } }
      try {
        var p = navigator.clipboard && navigator.clipboard.writeText(text);
        if (p && p.then) { p.then(function () { fin(true); }, function () { fin(fallbackCopy(text)); }); return; }
      } catch (e) { }
      fin(fallbackCopy(text));
    });
  }

  function fallbackCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.cssText = 'position:fixed;top:-2000px;left:-2000px;opacity:0;';
      document.body.appendChild(ta);
      var active = document.activeElement;
      ta.select();
      var ok = document.execCommand('copy');
      ta.remove();
      // Restore focus we briefly borrowed so the coordinator's cursor doesn't jump.
      try { if (active && active.focus) active.focus(); } catch (e) { }
      return !!ok;
    } catch (e2) { return false; }
  }

  function labelTextFor(el) {
    try {
      if (el.id) { var l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return l.textContent || ''; }
      var p = el.closest('label'); if (p) return p.textContent || '';
      var fc = el.closest('.MuiFormControl-root, .MuiTextField-root');
      if (fc) { var lb = fc.querySelector('label'); if (lb) return lb.textContent || ''; }
    } catch (e) { }
    return '';
  }

  // The dialog renders Label/PO#/Description per file - find the Description
  // inputs by their label/placeholder/name text (no testids on this dialog).
  function descriptionFields() {
    var dlg = dialogEl();
    if (!dlg) return [];
    var out = [];
    var cands = dlg.querySelectorAll('textarea, input[type="text"], input:not([type])');
    Array.prototype.forEach.call(cands, function (el) {
      if (el.type === 'file' || el.offsetWidth === 0) return;
      var hay = ((el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('name') || '') + ' ' +
        (el.getAttribute('aria-label') || '') + ' ' + labelTextFor(el)).toLowerCase();
      if (hay.indexOf('description') !== -1) out.push(el);
    });
    return out;
  }

  // The upload dialog renders a per-file "Label" (document type) control next to PO#/Description.
  // It's Umbrava's react-aria combobox - the SAME component as the note Type control setNoteType
  // drives: input[aria-autocomplete="list"], typing filters but you must CLICK the option (portal
  // listbox). Each row's FormControl carries a stable testid `document[N]-upload-label-select-input`
  // (live-verified 2026-07-20), so prefer that; fall back to the label-text heuristic (PO# is also
  // a combobox, so gate on the "Label" field text to exclude it). Returns the per-file Label inputs
  // in row order.
  function documentLabelFields() {
    var dlg = dialogEl();
    if (!dlg) return [];
    var byTestid = dlg.querySelectorAll('[data-testid$="-upload-label-select-input"] input');
    if (byTestid.length) return [].slice.call(byTestid).filter(function (el) { return el.offsetWidth > 0; });
    var out = [];
    var acs = dlg.querySelectorAll('input[aria-autocomplete="list"]');
    Array.prototype.forEach.call(acs, function (el) {
      if (el.offsetWidth === 0) return;
      var hay = ((el.getAttribute('placeholder') || '') + ' ' + (el.getAttribute('name') || '') + ' ' +
        (el.getAttribute('aria-label') || '') + ' ' + labelTextFor(el)).toLowerCase();
      if (/\blabel\b|document type|doc type|category/.test(hay)) out.push(el);
    });
    return out;
  }

  // Select `want` in one Label combobox: focus, type to filter, then CLICK the matching
  // portal option (exact first, then contains). Programmatic value-set never selects it -
  // only the click cascades the react-aria state. Resolves 'selected' | 'notfound' | 'skip'.
  function selectDocLabel(inputEl, want) {
    return new Promise(function (resolve) {
      if (!inputEl) return resolve('skip');
      if (inputEl.disabled || inputEl.getAttribute('aria-disabled') === 'true') return resolve('skip');
      var esc = String(want).replace(/[.*+?^${}()|[\]\\]/g, function (m) { return '\\' + m; });
      var wantRe = new RegExp('^\\s*' + esc + '\\s*$', 'i'), partRe = new RegExp(esc, 'i');
      try {
        inputEl.focus();
        inputEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        var vset = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        vset.call(inputEl, want);
        inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        inputEl.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
      } catch (e) { }
      var t0 = Date.now();
      (function poll() {
        var os = document.querySelectorAll('[role="option"]'), exact = null, part = null;
        for (var i = 0; i < os.length; i++) {
          var tx = (os[i].textContent || '').replace(/\s+/g, ' ').trim();
          if (wantRe.test(tx)) { exact = os[i]; break; }
          if (!part && partRe.test(tx)) part = os[i];
        }
        var opt = exact || part;
        if (opt) { ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function (t) { opt.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); }); return resolve('selected'); }
        if (Date.now() - t0 > 2500) return resolve('notfound');
        setTimeout(poll, 70);
      })();
    });
  }

  // WO Intake handoff only: the incoming client email (+ its attachments) IS the work order
  // request, so set each uploaded file's Label to `label` ("Work Order Request"). THIS drop's
  // files map to the LAST N label fields (new rows append - same mapping fillDescriptions uses).
  // Sequential: each combobox opens its own portal listbox, so a second focus would close the
  // first. No-ops safely with a diagnostic toast if the field/option isn't found, so an Umbrava
  // markup change never blocks the upload. Returns a Promise that resolves when done.
  function applyDocLabels(files, label) {
    if (!label) return Promise.resolve();
    return waitFor(function () {
      var ls = documentLabelFields();
      return ls.length >= files.length ? ls : null;
    }, 7000).then(function (ls) {
      if (!ls) ls = documentLabelFields();                 // timeout - set what exists
      if (!ls.length) { toast('Couldn’t find the document Label field - set it to “' + label + '” manually before Upload.'); return; }
      var tail = ls.slice(-files.length), set = 0, missed = 0;
      return (function next(i) {
        if (i >= tail.length) {
          if (set) toast('Document Label set to “' + label + '”' + (set > 1 ? ' on ' + set + ' files' : '') + ' - review, then Upload.');
          else if (missed) toast('Couldn’t auto-set the Label to “' + label + '” - pick it manually before Upload.');
          return;
        }
        if ((tail[i].value || '').trim()) return next(i + 1);   // already set - leave it
        return selectDocLabel(tail[i], label).then(function (r) {
          if (r === 'selected') set++; else if (r === 'notfound') missed++;
          return next(i + 1);
        });
      })(0);
    });
  }

  // Prepare each file's Description ONCE files have landed in the dialog. Only EMPTY
  // fields are touched - anything the coordinator typed always wins. THIS drop's files
  // map to the LAST N description fields: new rows append, so an index-from-zero
  // mapping would write into pre-existing rows on a second drop (review).
  //
  // Umbrava's Description field is a react-aria ComboBox <textarea>: it owns its value
  // in useComboBoxState and snaps the DOM back to that state on ANY input/change event,
  // intercepts execCommand via onBeforeInput, and wipes a no-event set on blur - every
  // programmatic write technique fails and the submit reads the (empty) combobox state,
  // not the DOM (verified live, July 2026). Only a real Ctrl+V paste is honored. So we
  // still ATTEMPT the native set (works if a field is ever a plain input, and it's
  // free), then VERIFY it stuck; whatever didn't stick we put on the clipboard for a
  // one-tap paste - and it's folded into the WO note regardless.
  function fillDescriptions(files) {
    waitFor(function () {
      var eds = descriptionFields();
      return eds.length >= files.length ? eds : null;
    }, 7000).then(function (eds) {
      if (!eds) eds = descriptionFields();               // timeout - fill what exists
      if (!eds.length) return;
      var tail = eds.slice(-files.length), targets = [];
      for (var i = 0; i < tail.length && i < files.length; i++) {
        if ((tail[i].value || '').trim()) continue;      // coordinator typed - leave it
        var want = (files[i].desc || '').slice(0, 200);
        if (!want) continue;
        setNativeValue(tail[i], want);                   // best-effort; no focus stolen
        targets.push({ el: tail[i], want: want });
      }
      if (!targets.length) return;
      // Verify after React has had a tick to flush/revert, then decide what to tell them.
      setTimeout(function () {
        var stuck = 0, failed = [];
        targets.forEach(function (t) {
          if ((t.el.value || '').trim() === t.want.trim()) stuck++;
          else failed.push(t.want);
        });
        if (!failed.length) {
          toast('Description' + (stuck === 1 ? '' : 's') + ' auto-filled - review, then Upload.');
        } else if (failed.length === 1) {
          // One locked field - the clipboard can carry exactly one, so offer the paste.
          copyText(failed[0]).then(function (ok) {
            toast(ok
              ? 'Umbrava locks the Description field - its text is on your clipboard: click the field and press Ctrl+V. (Also in the upload note.)'
              : 'Umbrava locks the Description field - your file details are captured in the upload note (drafted when you click Upload).');
          });
        } else {
          // Several locked fields - one clipboard can't fill them all; the note carries every file.
          toast('Umbrava locks the Description field - your ' + failed.length + ' files’ details are captured in the upload note (drafted when you click Upload).');
        }
      }, 350);
    });
  }

  // ctx.aborted: a failed open must disarm THIS drop's note staging (a note claiming
  // "Uploaded…" for files that never reached the dialog is a false record - review).
  function handleDrop(dt, described, ctx, opts) {
    opts = opts || {};
    var input = dialogFileInput();
    var opened = Promise.resolve(input);

    if (!input) {
      var btn = documentsUploadButton();
      var viaTab = Promise.resolve(btn);
      if (!btn) {
        var tab = documentsTab();
        if (!tab) { ctx.aborted = true; toast('Couldn’t find the Documents tab on this page.'); return; }
        tab.click();
        viaTab = waitFor(documentsUploadButton, 6000);
      }
      opened = viaTab.then(function (b) {
        if (!b) { ctx.aborted = true; toast('Couldn’t find the Upload button - is this WO’s Documents tab available?'); return null; }
        b.click();
        return waitFor(dialogFileInput, 6000);
      });
    }

    opened.then(function (inp) {
      if (!inp) { if (!ctx.aborted) { ctx.aborted = true; toast('Upload dialog didn’t open - try the Upload button manually.'); } return; }
      forwardToZone(inp, dt);
      described.then(function (files) {
        if (ctx.aborted) return;
        // Set the Label combobox first (it focuses fields / opens listboxes), THEN fill
        // descriptions (which steals no focus) - avoids the two racing over the same rows.
        if (opts.docLabel) applyDocLabels(files, opts.docLabel).then(function () { fillDescriptions(files); });
        else fillDescriptions(files);
      });
    });
  }

  // ---- Upload click → prefill the WO note -------------------------------------
  // Capture-phase listener: when the dialog's Upload button is clicked and we have a
  // pending summary, open Umbrava's Add Note composer prefilled with it. The SAVE
  // stays manual - the coordinator reviews and posts as themselves (attribution).

  function addNoteButton() {
    var btns = document.querySelectorAll('button');
    for (var i = 0; i < btns.length; i++) {
      if (/add note/i.test((btns[i].textContent || '').trim())) return btns[i];
    }
    return null;
  }

  function editorsSnapshot() {
    return Array.prototype.slice.call(document.querySelectorAll('textarea, [contenteditable="true"]'));
  }

  // Fill a note editor. Returns Promise<boolean> (did the text actually land). Rich
  // contenteditable editors (React/Slate/Lexical/etc.) MUST be verified ASYNCHRONOUSLY:
  // many accept a programmatic insert into the DOM but overwrite it from their own state
  // a TICK LATER, so a synchronous "did it stick?" check lies - that was the v1.3.3 bug
  // that left the note empty. Ladder, each verified after a beat by checking the LAST line
  // is present (proves the WHOLE insert landed, not just line 1):
  //   1. insertHTML with <br>            - tightest spacing, if the editor honors it;
  //   2. insertText + insertLineBreak    - line-by-line with soft <br> breaks; goes through
  //                                         the editor's native input path (reliable) AND tight;
  //   3. insertText of the whole string  - the v1.3.2 path: reliably fills (may space out \n);
  //   4. innerHTML = html + input event  - last resort for a plain contenteditable.
  // If none stick, the caller falls back to the clipboard paste (note is always copied).
  function setEditorValue(ed, text) {
    if (ed.tagName === 'TEXTAREA' || ed.tagName === 'INPUT') {
      setNativeValue(ed, text);
      return Promise.resolve(!!(ed.value || '').trim());
    }
    var lines = String(text).split('\n');
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    // Paragraph-structured HTML: a blank line starts a new <p>; a single newline is a <br> inside
    // the paragraph. This is what makes the note read like the original email (matches Ctrl+V).
    var blockHtml = String(text).replace(/\r\n/g, '\n').split(/\n{2,}/).map(function (p) { return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('');
    var tail = '';
    for (var k = lines.length - 1; k >= 0; k--) { if (lines[k].trim()) { tail = lines[k].trim(); break; } }
    function stuck() { var t = ed.textContent || ''; return tail ? t.indexOf(tail.slice(0, 40)) !== -1 : !!t.trim(); }
    function clear() { try { ed.focus(); document.execCommand('selectAll', false, null); } catch (e) { } }
    function selectAllRange() { try { ed.focus(); var sel = window.getSelection(); var rg = document.createRange(); rg.selectNodeContents(ed); sel.removeAllRanges(); sel.addRange(rg); } catch (e) { } }
    // Preferred: a synthetic paste so the editor's OWN handler (Umbrava's Add Note is TipTap /
    // ProseMirror) builds real paragraphs - exactly what a manual Ctrl+V does. Verified live.
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
    // PRIMARY for Umbrava's TipTap/ProseMirror note editor. MEASURED live on a real WO 2026-08-10:
    // ProseMirror rejects synthetic paste, beforeinput, execCommand insertHTML and raw innerHTML, but
    // it DOES honour execCommand('insertText') and a synthetic Enter keydown (PM binds keydown on the
    // editable directly, so an untrusted keydown still runs its keymap). So: hard-clear via a Range,
    // then per line insert the text and press Enter between lines - the only method that both sticks
    // AND preserves paragraphs (a plain insertText of the whole string flattens every newline).
    // PACED: a tight synchronous loop outruns ProseMirror's async commit and drops/merges lines on a
    // long note (measured); a ~12ms gap per line lands every line cleanly. Returns a Promise.
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
    // Diagnostic: which editor we grabbed and which fill method (if any) actually stuck. The note
    // came up blank once live even though the synthetic paste is "verified" - this tells us WHERE it
    // fails (wrong editor element, or every method silently no-ops) instead of guessing.
    try { console.info('[BWN DROP UPLOAD] note editor:', (ed.tagName || '?') + (ed.id ? '#' + ed.id : '') + (ed.className ? '.' + String(ed.className).split(/\s+/)[0] : ''), '| contenteditable=', ed.getAttribute && ed.getAttribute('contenteditable'), '| role=', ed.getAttribute && ed.getAttribute('role')); } catch (e) { }
    function run(i) {
      if (i >= steps.length) { try { console.warn('[BWN DROP UPLOAD] note fill: NONE of the methods stuck - editor rejected all'); } catch (e) { } return Promise.resolve(stuck()); }
      // A step may be async (tryPmType paces itself) or sync - Promise.resolve handles both.
      return Promise.resolve(steps[i]()).then(function () { return settle(); }).then(function (ok) { try { console.info('[BWN DROP UPLOAD] note fill step "' + stepNames[i] + '":', ok ? 'STUCK' : 'no'); } catch (e) { } return ok ? true : run(i + 1); });
    }
    return run(0);
  }

  // The Add Note composer isn't on the Documents tab the upload flow switches to. Choose
  // the tab that hosts it: the WO's Notes/Overview tab first, then the user's origin view
  // (where they were when they dropped), then other plausible tabs - never Documents.
  function pickNoteTab(originText) {
    var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));
    function find(re) {
      for (var i = 0; i < tabs.length; i++) {
        var t = (tabs[i].textContent || '').trim();
        if (t && !/^documents$/i.test(t) && re.test(t)) return tabs[i];
      }
      return null;
    }
    return find(/^notes?$/i) || find(/^overview$/i) ||
      (originText && !/^documents$/i.test(originText)
        ? find(new RegExp('^' + originText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i')) : null) ||
      find(/summary|details|activity|timeline/i);
  }

  // Umbrava's Documents "Upload" is a SPLIT button - its "+"/caret opens a menu that
  // includes a Note option (user-confirmed). This is the most reliable way to reach the
  // note composer without leaving the Documents view, so it's tried before hopping tabs.
  // The main Upload half is [data-testid="documents-split-left-button"]; the caret is its
  // sibling in the button group (testid guess "…-right-button", else the other button).
  function splitCaret() {
    return document.querySelector('[data-testid="documents-split-right-button"]') || (function () {
      var left = documentsUploadButton(); if (!left) return null;
      var grp = left.closest('.MuiButtonGroup-root') || left.parentElement; if (!grp) return null;
      var btns = grp.querySelectorAll('button');
      for (var i = 0; i < btns.length; i++) { if (btns[i] !== left) return btns[i]; }
      return null;
    })();
  }
  function docsNoteMenuItem() {
    var items = document.querySelectorAll('[role="menuitem"], .MuiMenuItem-root, [role="menu"] li, [role="menu"] button');
    for (var i = 0; i < items.length; i++) { if (/note/i.test((items[i].textContent || '').trim())) return items[i]; }
    return null;
  }

  // Fire whatever opens the note composer, in reliability order:
  //  1. an "Add Note" button already visible on this view,
  //  2. the Documents Upload split-button "+" → Note menu item (stays on Documents),
  //  3. hop to the tab that hosts an Add Note button (Notes/Overview/origin/…).
  // Resolves true once a composer-opening action has fired.
  function triggerNoteComposer(originTab) {
    var direct = addNoteButton();
    if (direct) { direct.click(); return Promise.resolve(true); }
    var caret = splitCaret(), viaSplit;
    if (caret) {
      caret.click();
      viaSplit = waitFor(docsNoteMenuItem, 4000).then(function (item) { if (item) { item.click(); return true; } return false; });
    } else {
      viaSplit = Promise.resolve(false);
    }
    return viaSplit.then(function (ok) {
      if (ok) return true;
      var tab = pickNoteTab(originTab);
      if (!tab) return false;
      tab.click();
      return waitFor(addNoteButton, 5000).then(function (b) { if (b) { b.click(); return true; } return false; });
    });
  }

  // Best-effort: set the Add Note composer's note-type control to `label` (e.g. "Client").
  // Umbrava's control is a react-aria combobox (input[aria-autocomplete="list"]) - typing does
  // NOT select, you must CLICK the option. noteTypeInput() finds it by its STABLE testid first
  // (the composer's Type field is `add-wo-note-modal-type-field-input`, live-verified 2026-07-20)
  // - the SAME testid-first strategy documentLabelFields() uses for the upload Label - then falls
  // back to the "Type" field-label heuristic. Legacy <select> / clickable branches remain as a
  // last resort, gated on a note-type vocabulary so they never touch an unrelated dropdown.
  // No-ops safely if not found.
  var NOTE_TYPE_VOCAB = /^(internal|vendor|client|billing|general|public|private|customer|recap)$/i;
  function noteTypeInput(scope) {
    // 1) stable testid - the note composer's Type field (…-type-field-input / …-type-field).
    //    The upload Label testid ends "-label-select-input" and Share With "-autocomplete-input",
    //    so neither is matched here.
    var byId = scope.querySelector('[data-testid$="type-field-input"] input') ||
               scope.querySelector('[data-testid$="type-field"] input');
    if (byId) return byId;
    // 2) fallback: a "Type" field label wrapping a react-aria combobox.
    var flabs = scope.querySelectorAll('label');
    for (var a = 0; a < flabs.length; a++) {
      if (!/^\s*type\b/i.test((flabs[a].textContent || '').trim())) continue;
      var afc = flabs[a].closest('.MuiFormControl-root') || flabs[a].parentElement;
      var ai = afc ? afc.querySelector('input[aria-autocomplete="list"]') : null;
      if (ai) return ai;
    }
    return null;
  }
  function setNoteType(label, scope) {
    if (!label) return false;
    scope = scope || document;
    var esc2 = String(label).replace(/[.*+?^${}()|[\]\\]/g, function (m) { return '\\' + m; });
    var want = new RegExp('^\\s*' + esc2 + '\\s*$', 'i');
    var acInput = noteTypeInput(scope);
    if (acInput) {
      try {
        acInput.focus();
        acInput.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
        var vset = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        vset.call(acInput, label); acInput.dispatchEvent(new Event('input', { bubbles: true })); acInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true }));
        var contain = new RegExp(esc2, 'i'), nn = 0;
        (function pickAC() {
          var os = document.querySelectorAll('[role="option"]'), exact = null, part = null;
          for (var q = 0; q < os.length; q++) {
            var tx = (os[q].textContent || '').replace(/\s+/g, ' ').trim();
            if (want.test(tx)) { exact = os[q]; break; }
            if (!part && contain.test(tx)) part = os[q];
          }
          var opt = exact || part;
          if (opt) { ['pointerdown', 'mousedown', 'mouseup', 'click'].forEach(function (t) { opt.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window })); }); return; }
          if (++nn < 12) setTimeout(pickAC, 70);
        })();
      } catch (e) { }
      return true;
    }
    var sels = scope.querySelectorAll('select');
    for (var i = 0; i < sels.length; i++) {
      var opts = Array.prototype.slice.call(sels[i].options);
      if (!opts.some(function (o) { return NOTE_TYPE_VOCAB.test((o.textContent || '').trim()); })) continue;
      var m1 = opts.filter(function (o) { return want.test((o.textContent || '').trim()); })[0];
      if (m1) { try { setNativeValue(sels[i], m1.value); } catch (e) { } return true; }
    }
    var direct = scope.querySelectorAll('[role="tab"],[role="radio"],[role="option"],button,.MuiChip-root,label');
    for (var j = 0; j < direct.length; j++) {
      if (want.test((direct[j].textContent || '').trim()) && direct[j].offsetParent) { try { direct[j].click(); } catch (e) { } return true; }
    }
    return false;
  }

  function insertNote(text, originTab, noteType) {
    if (noteType == null) noteType = 'Client';   // undefined/null -> default; an explicit '' leaves the Type for the user (canned-note hook)
    // Clipboard backup first - rich editors can swallow programmatic text, and the
    // paste is then the instant recovery. Track whether it actually landed so the
    // toast wording doesn't over-promise a paste target.
    var copied = copyText(text);
    var before = editorsSnapshot();
    triggerNoteComposer(originTab).then(function (opened) {
      if (!opened) { copied.then(function (ok) { toast(ok ? 'Upload note copied to clipboard - couldn’t open the note composer.' : 'Couldn’t open the note composer - note not drafted.'); }); return; }
      waitFor(function () {
        var now = editorsSnapshot();
        for (var i = 0; i < now.length; i++) {
          if (before.indexOf(now[i]) === -1 && now[i].offsetWidth > 0) return now[i];
        }
        return null;
      }, 5000).then(function (ed) {
        if (!ed) { copied.then(function () { toast('The note composer didn’t open - use the Copy button to grab the note, then paste it in.'); copyNoteButton(text); }); return; }
        setEditorValue(ed, text).then(function (filled) {
          // Note Type is chosen from the email's parties (noteTypeForFiles -> noteTypeForEmail:
          // inbound by sender, outbound by recipient). Scope to the just-opened composer so we
          // never touch an unrelated dropdown. Best-effort; posts regardless.
          try { var comp = (ed.closest && ed.closest('[role="dialog"],.MuiDialog-root,form,.MuiPaper-root')) || document; setTimeout(function () { if (noteType) setNoteType(noteType, comp); }, 80); } catch (e) { }
          copied.then(function (ok) {
            if (filled) { toast('Note drafted' + (noteType ? ' (Type: ' + noteType + ')' : '') + ' - review and Save.' + (ok ? ' (Also on your clipboard.)' : '')); return; }
            // Editor rejected the fill. Always offer the Copy button: the auto clipboard write has no
            // user gesture and can silently no-op even when it reports success, leaving Ctrl+V empty.
            toast(ok ? 'Note composer opened - press Ctrl+V, or use the Copy button below first.'
                     : 'Note auto-fill + clipboard were blocked - click the Copy button, then Ctrl+V into Description.');
            copyNoteButton(text);
          });
        });
      });
    });
  }

  // Reuse hook for sibling @grant-none scripts (bwn-notes: canned dispatch templates). Both run in
  // the page window, so this exposes the live-tested composer-open + ProseMirror insert without
  // duplicating the fragile fill code. Insert-only - it NEVER posts (same as every insertNote path).
  // Pass noteType '' to leave the Type field for the user to pick.
  if (typeof window !== 'undefined') window.__bwnInsertNote = function (text, noteType) { return insertNote(text, '', noteType); };

  // Fill an ALREADY-OPEN note composer. The dispatch-board detail panel opens Umbrava's Add Note
  // modal from its own "+ Add" button (not an "Add Note" button), so bwn-notes clicks that itself
  // and then calls this - it waits for the tiptap editor and fills it with the SAME setEditorValue
  // the email path uses (no duplicated ProseMirror code). '' noteType leaves the Type for the user.
  // Insert-only: it NEVER posts; the human clicks Umbrava's own Add/Save.
  if (typeof window !== 'undefined') window.__bwnFillNoteEditor = function (text, noteType) {
    return waitFor(function () {
      var eds = document.querySelectorAll('.tiptap.ProseMirror');
      for (var i = eds.length - 1; i >= 0; i--) { if (eds[i].offsetParent && eds[i].offsetWidth > 0) return eds[i]; }
      return null;
    }, 6000).then(function (ed) {
      if (!ed) { toast('Could not find the note editor - open the note composer, then pick a template.'); return false; }
      return setEditorValue(ed, text).then(function (filled) {
        if (noteType) { try { var comp = (ed.closest && ed.closest('[role="dialog"],.MuiDialog-root,form,.MuiPaper-root')) || document; setTimeout(function () { setNoteType(noteType, comp); }, 80); } catch (e) { } }
        toast(filled ? 'Note drafted - review, fill any blanks, and Save.' : 'Auto-fill was blocked - use the composer paste or type it in.');
        return filled;
      });
    });
  };

  // ---- The needs-a-response chip ----------------------------------------------
  // BWN-owned DOM, deliberately. The obvious place for this toggle is inside Umbrava's own
  // upload dialog, but injecting a control into a third-party MUI dialog makes the feature a
  // hostage to their markup; this floats beside it and cannot be broken by a re-render.
  // It lives exactly as long as `pending` does, so it disappears with a cancelled drop.
  var respChip = null, respTimer = null;
  function clearRespChip() {
    if (respChip) { try { respChip.remove(); } catch (e) { } respChip = null; }
    if (respTimer) { clearTimeout(respTimer); respTimer = null; }
  }
  function showRespChip() {
    clearRespChip();
    if (!pending || !inboundClientEmail(pending.files) || !woIdFromUrl()) return;
    var box = document.createElement('div');
    box.id = 'bwn-du-resp';
    box.style.cssText =
      'position:fixed;right:22px;bottom:22px;z-index:2147483001;max-width:330px;' +
      'background:#fff;border:1px solid #c6d2cc;border-left:4px solid #b46b00;border-radius:10px;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.22);padding:11px 13px;' +
      'font:400 12.5px/1.45 -apple-system,BlinkMacSystemFont,\'Segoe UI\',\'Helvetica Neue\',Arial,sans-serif;color:#12241b;';
    var lab = document.createElement('label');
    lab.style.cssText = 'display:flex;gap:9px;align-items:flex-start;cursor:pointer;';
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.style.cssText = 'margin:2px 0 0;flex:0 0 auto;width:15px;height:15px;cursor:pointer;';
    cb.checked = !!(pending && pending.needsResponse);
    cb.addEventListener('change', function () { if (pending) pending.needsResponse = cb.checked; });
    var txt = document.createElement('div');
    txt.innerHTML =
      '<strong style="font-weight:600;">This client email needs a response</strong>' +
      '<div style="color:#5b6b8c;margin-top:3px;">Opens a tracked item on this WO, due on the priority clock. ' +
      'The upload note is logged as <strong>Internal</strong> so it does not read as "we updated the client".</div>';
    lab.appendChild(cb); lab.appendChild(txt);
    box.appendChild(lab);
    document.body.appendChild(box);
    respChip = box;
    // Outlives the drop dialog by design, but not the pending window: if the coordinator
    // wanders off, the chip goes with the drop it belongs to.
    respTimer = setTimeout(clearRespChip, PENDING_TTL);
  }

  // ---- BWN note review box (human-gated API note) -----------------------------
  // Replaces the old "draft into Umbrava's composer when the user clicks Upload" path. The note is
  // NEVER auto-posted: this box shows the drafted note (editable) and its Type, and only an explicit
  // "Post note to WO" click calls postNoteViaApi. It folds in the old respChip's "needs a response"
  // toggle and shows the upload status. If the API post fails it falls back to the DOM composer
  // (insertNote) so the note is never lost. One box at a time; it outlives the drop but not `pending`.
  var DEFAULT_DOC_LABEL = 'Work Order Request';  // non-email drops + the WO-intake handoff default here
  // Correspondence label by party. Internal -> the 'Internal' label (an internal email is an
  // internal document, not a client's Work Order Request); 'Work Order Request' is a client-side
  // document, forced only by the WO-intake handoff, never by an internal party here.
  var PARTY_LABEL = {
    'Client': 'Client Correspondence', 'Vendor': 'Vendor Correspondence',
    'Supplier': 'Supplier Correspondence', 'Internal': 'Internal'
  };
  // Vendor vs Supplier for an unrecognized external party. On-device only (@grant none / zero
  // egress): Chrome's Gemini Nano or Edge's Phi via the shared bwnAI router, short-bounded so it
  // cannot stall the upload. A miss (model off / timeout / empty) -> 'Vendor', the far more common
  // external party on a dispatch WO (a subcontractor doing the work, not a parts supplier).
  function vendorOrSupplier(m) {
    var from = (m.fromName || smtpAddr(m.fromEmail) || '').trim();
    var body = tidyBody(m.body).slice(0, 2000);   // the new message only; enough to tell the roles apart
    var content = 'From: ' + from + '\nSubject: ' + String(m.subject || '') + '\n\n' + body;
    return bwnAI({
      task: 'classify', tier: 'ondevice', oneLine: true, maxChars: 40,
      system: 'You label ONE email on a facilities work order. Its sender is an outside company that is either a VENDOR (a subcontractor performing on-site labor or service) or a SUPPLIER (sells parts, materials, or equipment, no on-site labor). Reply with ONLY one word: vendor or supplier.',
      prompt: content, fallback: ['ondevice'], timeoutMs: 2500
    }).then(function (out) { return /supplier/i.test(String(out || '')) ? 'Supplier' : 'Vendor'; });
  }
  // The corresponding party for an email, as a doc-label party: 'Client'|'Vendor'|'Supplier'|'Internal'.
  // Deterministic from domains where it can be (instant); only an unrecognized external party costs the
  // on-device AI call. Memoized per email object so label + any re-resolve never runs the model twice.
  function classifyEmail(m) {
    if (!m) return Promise.resolve('Client');
    if (m.__party) return Promise.resolve(m.__party);
    var p = partyByDomain(m);
    if (p !== 'External') { p = p || 'Client'; m.__party = p; return Promise.resolve(p); }
    return vendorOrSupplier(m).then(function (r) { m.__party = r; return r; });
  }
  // Auto-pick the doc Label for a manual drop. An email is CORRESPONDENCE, labeled by the other party:
  // a client (or broker/CMMS) email -> Client Correspondence, an external company -> Vendor or Supplier
  // Correspondence (AI-decided). A drop with no email (a photo, a PDF), or an internal-only email, keeps
  // the WO-request default. Only the WO-intake HANDOFF forces 'Work Order Request' explicitly (it really
  // is the request that created the WO) - it never calls this. Async: resolves the label (the AI leg is
  // awaited by runApiUpload before the label is committed in bulkAdd; there is no update-label mutation).
  function docLabelForFiles(files) {
    var email = null;
    for (var i = 0; i < (files || []).length; i++) { if (files[i] && files[i].isEmail && files[i].email) { email = files[i].email; break; } }
    if (!email) return Promise.resolve(DEFAULT_DOC_LABEL);
    return classifyEmail(email).then(function (p) { return PARTY_LABEL[p] || DEFAULT_DOC_LABEL; });
  }
  var noteBox = null, noteBoxTimer = null;
  function clearNoteBox() {
    if (noteBox) { try { if (noteBox.__unblockMO) noteBox.__unblockMO.disconnect(); } catch (e) { } try { noteBox.remove(); } catch (e) { } noteBox = null; }
    if (noteBoxTimer) { clearTimeout(noteBoxTimer); noteBoxTimer = null; }
  }
  function noteBoxStatus(msg) { if (noteBox && noteBox.__status) noteBox.__status.textContent = msg; }
  // Keep the note box editable while Umbrava's Upload dialog (a MUI modal) is open. Modern MUI marks
  // every body-level sibling of the modal `inert` + `aria-hidden` - and `inert` makes our textarea
  // truly un-focusable/un-typeable - and its FocusTrap yanks focus back on any `focusin` that reaches
  // document. This box deliberately floats OUTSIDE the dialog (so a dialog re-render can't break it),
  // so we defend it here: strip those attrs (and re-strip if the modal re-applies them), and stop our
  // own focusin from bubbling to document so the trap never fires. Verified against a simulated modal
  // (inert + focusin-restore): focus is blocked before, sticks after, and survives a re-add.
  function unblockFromModal(node) {
    function strip() {
      if (node.hasAttribute('aria-hidden')) node.removeAttribute('aria-hidden');
      if (node.inert) { try { node.inert = false; } catch (e) { } }
      if (node.hasAttribute('inert')) node.removeAttribute('inert');
    }
    strip();
    node.addEventListener('focusin', function (e) { e.stopPropagation(); }, false);
    try {
      var mo = new MutationObserver(strip);
      mo.observe(node, { attributes: true, attributeFilter: ['inert', 'aria-hidden'] });
      node.__unblockMO = mo;   // GC'd with the box; clearNoteBox drops the ref
    } catch (e) { }
  }
  function showNoteReview() {
    clearNoteBox();
    clearRespChip();
    if (!pending || !woNumberFromUrl()) return null;
    // The review box's only outcome is a work-order note. An operator who may upload documents but
    // not post notes gets the upload without the note step, rather than a box that cannot land.
    if (!bwnCan('WorkOrderNote.AddNew')) return null;
    var woNum = woNumberFromUrl();
    var canRespond = !!inboundClientEmail(pending.files);
    var box = document.createElement('div');
    box.id = 'bwn-du-note';
    box.style.cssText =
      'position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);z-index:2147483001;width:380px;max-width:92vw;max-height:88vh;overflow:auto;' +
      'background:#fff;border:1px solid #c6d2cc;border-left:4px solid #2f6f4f;border-radius:10px;' +
      'box-shadow:0 12px 40px rgba(0,0,0,.28);padding:12px 13px;' +
      'font:400 12.5px/1.45 -apple-system,BlinkMacSystemFont,\'Segoe UI\',\'Helvetica Neue\',Arial,sans-serif;color:#12241b;';
    var h = document.createElement('div');
    h.style.cssText = 'font-weight:600;margin-bottom:6px;';
    h.textContent = 'Upload note for W-' + woNum;
    box.appendChild(h);
    var status = document.createElement('div');
    status.style.cssText = 'color:#5b6b8c;margin-bottom:8px;font-size:11.5px;';
    box.appendChild(status);
    // Note Type -> document label map: the doc type AGREES with the note Type we assigned on drop
    // (Mike's ask), rather than being guessed independently. Client -> Client Correspondence,
    // Vendor -> Vendor Correspondence, Internal -> Internal (PARTY_LABEL).
    function noteToDocLabel(t) { return PARTY_LABEL[t] || DEFAULT_DOC_LABEL; }
    var initType = (pending.noteType && /^(Client|Vendor|Internal)$/.test(pending.noteType)) ? pending.noteType : 'Client';
    var hasEmail = (pending.files || []).some(function (f) { return f && f.isEmail; });
    // Document-type picker + Upload gate (manual drops only). The upload is HELD until the
    // coordinator picks a type and clicks Upload, because the label is committed at bulkAdd and
    // there is no update-label mutation. The type defaults to the note Type's label so the two
    // agree; the coordinator can still override either. One click in the common case.
    if (pendingUpload && !pendingUpload.fired) {
      var nUp = pendingUpload.raw.length;
      var upRow = document.createElement('div');
      upRow.style.cssText = 'display:flex;align-items:center;gap:7px;margin-bottom:9px;flex-wrap:wrap;';
      var dtl = document.createElement('span'); dtl.textContent = 'Document type:'; dtl.style.cssText = 'color:#5b6b8c;flex:0 0 auto;';
      var dsel = document.createElement('select');
      dsel.style.cssText = 'flex:1 1 110px;min-width:0;padding:3px 6px;border:1px solid #c6d2cc;border-radius:6px;font:inherit;';
      Object.keys(DOC_LABELS).forEach(function (name) { var o = document.createElement('option'); o.value = name; o.textContent = name; dsel.appendChild(o); });
      dsel.value = hasEmail ? noteToDocLabel(initType) : DEFAULT_DOC_LABEL;
      box.__docSel = dsel;   // the note-Type control syncs this until the coordinator overrides it
      dsel.addEventListener('change', function () { dsel.__touched = true; });
      // An unknown external party can be a vendor OR a supplier; the note Type has no Supplier
      // option, so ask the on-device classifier and upgrade Vendor Correspondence -> Supplier
      // Correspondence when it says supplier - unless the coordinator already changed the type.
      if (hasEmail) {
        docLabelForFiles(pending.files).then(function (lbl) {
          if (!dsel.__touched && lbl === 'Supplier Correspondence' && dsel.value === 'Vendor Correspondence') dsel.value = lbl;
        }).catch(function () { });
      }
      var up = document.createElement('button'); up.type = 'button';
      up.textContent = 'Upload ' + nUp + ' file' + (nUp > 1 ? 's' : '');
      up.style.cssText = 'flex:0 0 auto;padding:6px 12px;border:0;background:#2f6f4f;color:#fff;border-radius:7px;cursor:pointer;font:600 12px/1.2 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;';
      up.addEventListener('click', function () {
        if (!pendingUpload || pendingUpload.fired) return;
        pendingUpload.fired = true;
        dsel.disabled = true; up.disabled = true; up.textContent = 'Uploading…';
        var udt = new DataTransfer();
        pendingUpload.raw.forEach(function (f) { try { udt.items.add(f); } catch (e) { } });
        runApiUpload(pendingUpload.raw, pendingUpload.described, udt, pendingUpload.ctx, dsel.value);
      });
      upRow.appendChild(dtl); upRow.appendChild(dsel); upRow.appendChild(up);
      box.appendChild(upRow);
      status.textContent = nUp + ' file' + (nUp > 1 ? 's' : '') + ' ready - pick a document type, then Upload.';
    }
    var ta = document.createElement('textarea');
    ta.style.cssText = 'width:100%;height:150px;box-sizing:border-box;resize:vertical;border:1px solid #c6d2cc;border-radius:7px;padding:7px;font:inherit;color:#12241b;';
    ta.value = pending.noteText || '';
    box.appendChild(ta);
    // enrichNoteWithAI refreshes this textarea when the on-device brief lands - but never over a user
    // edit. The flag latches on the first keystroke and is what makes the async swap safe.
    box.__ta = ta;
    box.__noteEdited = false;
    ta.addEventListener('input', function () { box.__noteEdited = true; });
    var typeRow = document.createElement('div');
    typeRow.style.cssText = 'display:flex;align-items:center;gap:7px;margin-top:8px;';
    var tl = document.createElement('span'); tl.textContent = 'Type:'; tl.style.cssText = 'color:#5b6b8c;';
    var sel = document.createElement('select');
    sel.style.cssText = 'flex:1 1 auto;min-width:0;padding:3px 6px;border:1px solid #c6d2cc;border-radius:6px;font:inherit;';
    var typeNames = noteTypeNames();
    if (typeNames.indexOf(initType) === -1) typeNames = [initType].concat(typeNames);   // party default is always selectable
    typeNames.forEach(function (t) { var o = document.createElement('option'); o.value = t; o.textContent = t; sel.appendChild(o); });
    sel.value = initType;
    // Keep the document type mapped to the note Type as the coordinator changes it (until they
    // override the doc type directly). The needs-response toggle sets sel.value programmatically,
    // which fires no 'change' event, so it calls this explicitly.
    function syncDocFromNote() { var ds = box.__docSel; if (ds && hasEmail && !ds.__touched) ds.value = noteToDocLabel(sel.value); }
    sel.addEventListener('change', syncDocFromNote);
    typeRow.appendChild(tl); typeRow.appendChild(sel);
    box.appendChild(typeRow);
    var respCb = null;
    if (canRespond) {
      var lab = document.createElement('label');
      lab.style.cssText = 'display:flex;gap:8px;align-items:flex-start;cursor:pointer;margin-top:9px;';
      respCb = document.createElement('input'); respCb.type = 'checkbox'; respCb.checked = !!pending.needsResponse;
      respCb.style.cssText = 'margin:2px 0 0;flex:0 0 auto;width:15px;height:15px;';
      var lt = document.createElement('div');
      lt.innerHTML = '<strong style="font-weight:600;">This client email needs a response</strong>' +
        '<div style="color:#5b6b8c;margin-top:2px;">Opens a tracked item on the priority clock. The note posts as <strong>Internal</strong> so it does not read as “we updated the client”.</div>';
      lab.appendChild(respCb); lab.appendChild(lt);
      box.appendChild(lab);
      var syncType = function () { if (respCb.checked) { sel.value = 'Internal'; sel.disabled = true; } else { sel.disabled = false; } syncDocFromNote(); };
      respCb.addEventListener('change', syncType); syncType();
    }
    var btns = document.createElement('div');
    btns.style.cssText = 'display:flex;gap:8px;margin-top:11px;justify-content:flex-end;';
    var skip = document.createElement('button');
    skip.textContent = 'Skip note'; skip.type = 'button';
    skip.style.cssText = 'padding:6px 12px;border:1px solid #c6d2cc;background:#f4f7f5;border-radius:7px;cursor:pointer;font:inherit;';
    var post = document.createElement('button');
    post.textContent = 'Post note to WO'; post.type = 'button';
    post.style.cssText = 'padding:6px 13px;border:0;background:#2f6f4f;color:#fff;border-radius:7px;cursor:pointer;font:600 12.5px/1.2 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Arial,sans-serif;';
    btns.appendChild(skip); btns.appendChild(post);
    box.appendChild(btns);

    skip.addEventListener('click', function () { copyText(ta.value); clearNoteBox(); toast('Note skipped - kept on your clipboard.'); });
    post.addEventListener('click', function () {
      var text = ta.value, type = sel.value, needsResp = !!(respCb && respCb.checked);
      if (needsResp) type = 'Internal';
      post.disabled = true; post.textContent = 'Posting…';
      postNoteViaApi(text, type, woNum).then(function () {
        toast('Note posted to W-' + woNum + ' (Type: ' + type + ').');
        if (needsResp) { var f = inboundClientEmail(pending.files); if (f) requestTrack(f, String(woNum)); }
        clearNoteBox();
      }).catch(function (err) {
        post.disabled = false; post.textContent = 'Post note to WO';
        copyText(text);
        toast('API post failed (' + ((err && err.message) || err) + ') - opening the composer; text is on your clipboard.');
        try { insertNote(text, (pending && pending.originTab) || '', type); } catch (e) { }
      });
    });

    document.body.appendChild(box);
    unblockFromModal(box);
    box.__status = status;
    noteBox = box;
    noteBoxTimer = setTimeout(clearNoteBox, PENDING_TTL);
    if (pending) pending.__box = true;   // tells the legacy Upload-click handler the box owns the note
    return box;
  }

  // Run the API upload for a drop, update the review box, and fall back to the DOM dialog on any
  // failure (init / blob PUT / bulkAdd) so a drop never silently drops a file.
  function runApiUpload(rawFiles, described, dt, ctx, labelName) {
    var woNum = woNumberFromUrl();
    // A caller may FORCE a label (the WO-intake handoff passes 'Work Order Request'); otherwise the
    // label is auto-picked from the resolved files (email -> correspondence by party). Held in a closure
    // so the dialog fallback labels the same way if the API leg fails.
    // A per-file resolver has no single name, so the dialog fallback keeps the default.
    var resolvedLabel = (typeof labelName === 'string' && labelName) || DEFAULT_DOC_LABEL;
    return described.then(function (files) {
      if (ctx.aborted) throw new Error('aborted');
      // docLabelForFiles is async (an unrecognized external email asks the on-device AI vendor-vs-
      // supplier); await it here so the RIGHT label lands in bulkAdd - there is no update-label
      // mutation, so the label must be correct at upload time. A forced label skips the resolve.
      return (labelName ? Promise.resolve(labelName) : docLabelForFiles(files)).then(function (lbl) {
        if (typeof lbl === 'string') resolvedLabel = lbl;
        noteBoxStatus('Uploading ' + rawFiles.length + ' file' + (rawFiles.length > 1 ? 's' : '') + '…');
        return uploadViaApi(rawFiles, files, lbl, woNum);
      });
    }).then(function (ids) {
      var n = (ids && ids.length) || rawFiles.length;
      noteBoxStatus('Uploaded ' + n + ' file' + (n > 1 ? 's' : '') + ' ✓  - review the note, then Post.');
      toast('Uploaded ' + rawFiles.length + ' file' + (rawFiles.length > 1 ? 's' : '') + ' to W-' + woNum + '.');
    }).catch(function (err) {
      if (ctx.aborted) return;
      var reason = (err && err.message) || String(err || 'unknown');
      try { console.warn('[BWN DROP UPLOAD] API upload failed, falling back to the dialog:', reason); } catch (e) { }
      // Name the actual failing step in the box (not a generic "API unavailable"): this path never
      // passed a live dry-run, so the reason IS the diagnostic. The note box stays editable and the
      // Post button still works even while the Umbrava dialog is open (see the unblock() in showNoteReview).
      noteBoxStatus('Upload API failed (' + reason + ') - finish the Upload dialog; the note is still here to edit and Post.');
      handleDrop(dt, described, ctx, { docLabel: resolvedLabel });
    });
  }

  // Ask bwn-wo-assist to record the item. This script is @grant none - it has no egress at
  // all - so the assist script owns the POST. The ack leg is not optional: without it a
  // failed track is silent, and the coordinator walks away believing the WO is tracked.
  var _trackWait = {};
  function requestTrack(file, woId) {
    var m = file.email || {};
    var reqId = 'du-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    var detail = {
      id: 'bwn:assist:track', reqId: reqId, wo: woId, woNumber: woId,
      emailFrom: m.fromEmail || '', emailSubject: m.subject || '',
      ask: file.summary || m.subject || '', docRef: file.name || '', source: 'drop'
    };
    _trackWait[reqId] = setTimeout(function () {
      delete _trackWait[reqId];
      // No answer at all means the assist script is not installed or not listening. Say the
      // thing that is actually true and actionable, rather than "failed".
      toast('The email uploaded, but nothing tracked it - BWN WO Assist is not running on this page.');
    }, 20000);
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: detail })); }
    catch (e) { clearTimeout(_trackWait[reqId]); delete _trackWait[reqId]; toast('Could not ask WO Assist to track that email.'); }
  }
  document.addEventListener('bwn:evt', function (e) {
    var d = e && e.detail;
    if (!d || d.id !== 'bwn:assist:tracked' || !d.reqId || !_trackWait[d.reqId]) return;
    clearTimeout(_trackWait[d.reqId]); delete _trackWait[d.reqId];
    if (d.ok) toast('Tracked as needing a client response' + (d.why ? ' - ' + d.why : '') + '.');
    else toast('NOT tracked: ' + (d.why || 'the assist queue refused it') + '. The upload and the note are fine.');
  }, false);

  document.addEventListener('click', function (e) {
    if (!pending) return;
    if (pending.__box) return;   // the BWN note review box owns the note now; don't also draft into the composer
    if (Date.now() - pending.ts > PENDING_TTL) { pending = null; clearRespChip(); return; }
    var btn = e.target && e.target.closest ? e.target.closest('button') : null;
    if (!btn) return;
    var dlg = btn.closest('[role="dialog"], .MuiDialog-root');
    if (!dlg) return;
    if (!/^upload\b/i.test((btn.textContent || '').trim())) return;
    // The dialog must actually contain the staged files (by name) - a drop that was
    // CANCELLED must not prefill a note from some other dialog's Upload button, and a
    // reopened dialog with different files must not inherit the stale summary (review).
    var dlgText = dlg.textContent || '';
    var seen = pending.files.some(function (f) { return f.name && dlgText.indexOf(String(f.name).slice(0, 12)) !== -1; });
    if (!seen) return;
    var note = pending.noteText, originTab = pending.originTab || '', noteType = pending.noteType || 'Client';
    // Step 4: a tracked inbound client email is logged as INTERNAL, not Client. Two reasons,
    // and both are load-bearing rather than cosmetic:
    //   1. the item converges on an OUTBOUND reply, and a Client-typed note newer than the
    //      item would instantly self-close the thing that was just opened;
    //   2. a Client-typed note resets Next Actions' client-cadence clock, so logging a
    //      question we have NOT answered would read as "we updated the client".
    var track = null;
    if (pending.needsResponse) {
      var f = inboundClientEmail(pending.files);
      var woId = woIdFromUrl();
      if (f && woId) { track = { file: f, woId: woId }; noteType = 'Internal'; }
    }
    pending = null;
    clearRespChip();
    // Let the dialog close and the upload kick off before touching the notes pane.
    setTimeout(function () { insertNote(note, originTab, noteType); }, 1400);
    // Fire the track alongside the note rather than after it: the note is a human-review
    // draft that may sit unsaved for minutes, and the queue item should not wait on that.
    if (track) requestTrack(track.file, track.woId);
  }, true);

  // ---- Drop overlay ----------------------------------------------------------

  var overlay = null, hideTimer = null;

  function buildOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'bwn-drop-overlay';
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:2147483000;display:none;align-items:center;justify-content:center;' +
      'background:rgba(9,30,66,.55);backdrop-filter:blur(2px);cursor:copy;';
    var card = document.createElement('div');
    card.style.cssText =
      'pointer-events:none;text-align:center;padding:28px 44px;border-radius:14px;' +
      'background:#fff;border:2px dashed #4c6ef5;box-shadow:0 12px 40px rgba(0,0,0,.35);' +
      'font:500 20px/1.4 -apple-system,BlinkMacSystemFont,\'Segoe UI\',\'Helvetica Neue\',Arial,sans-serif;color:#1b2a4a;';
    card.innerHTML =
      '📎 Drop to upload to this Work Order' +
      '<div style="font:400 13px/1.5 -apple-system,BlinkMacSystemFont,\'Segoe UI\',\'Helvetica Neue\',Arial,sans-serif;color:#5b6b8c;margin-top:6px;">' +
      'Files upload straight to this WO; an email becomes a WO note you review and Post from the box.</div>';
    overlay.appendChild(card);

    overlay.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    overlay.addEventListener('drop', function (e) {
      e.preventDefault();
      e.stopPropagation();
      // The view the user dropped from - captured BEFORE handleDrop switches to the
      // Documents tab. The Add Note composer lives on the WO's notes/overview view, not
      // the Documents tab, so this is where the note gets drafted afterward.
      var originTab = (function () { var t = document.querySelector('[role="tab"][aria-selected="true"]'); return t ? (t.textContent || '').trim() : ''; })();
      hideOverlay();
      if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files.length) return;
      // Copy files out: the original DataTransfer is neutered after this handler. The DataTransfer
      // for the DOM-dialog fallback is rebuilt from raw at Upload-click time (the upload is held).
      var raw = [];
      for (var i = 0; i < e.dataTransfer.files.length; i++) {
        raw.push(e.dataTransfer.files[i]);
      }
      // Open the dialog IMMEDIATELY; descriptions parse in parallel (a big .msg on a
      // network share must not make the drop feel dead - review). A second drop into a
      // still-fresh pending MERGES (the note must list every file, not just the last drop).
      var ctx = { aborted: false };
      var described = Promise.all(raw.map(describeFile));
      described.then(function (files) {
        if (ctx.aborted) return;
        var fresh = pending && (Date.now() - pending.ts < PENDING_TTL);
        var merged = fresh ? pending.files.concat(files) : files;
        // On a merge, keep the FIRST drop's origin view - later drops fire after the script
        // has already switched to Documents, so their origin would just be "Documents".
        var origin = (fresh && pending.originTab) ? pending.originTab : originTab;
        // A merge keeps an already-ticked toggle: the coordinator answered the question once,
        // and dropping a second attachment is not them changing their mind.
        var keepResp = !!(fresh && pending.needsResponse);
        // Accumulate the HELD upload across a merge so one Upload click sends every file dropped
        // in this window; a fresh window (or one already fired) starts a new batch. described is
        // set to `merged` (already-resolved described objects) so raw[i] still pairs with described[i].
        if (fresh && pendingUpload && !pendingUpload.fired) { pendingUpload.raw = pendingUpload.raw.concat(raw); }
        else { pendingUpload = { raw: raw, ctx: ctx, fired: false }; }
        pendingUpload.described = Promise.resolve(merged);
        pending = { ts: Date.now(), files: merged, noteText: buildNoteText(merged), originTab: origin, noteType: noteTypeForFiles(merged), needsResponse: keepResp };
        showNoteReview();
        enrichNoteWithAI(pending);   // upgrade the mechanical lead to the AI brief in the background
      });
      // Upload is HELD, not auto-fired: the review box's Upload button calls runApiUpload with the
      // coordinator's chosen document type (there is no update-label mutation, so the type must be
      // picked before bulkAdd commits it). dt is rebuilt from pendingUpload.raw at click time.
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  function showOverlay() {
    buildOverlay().style.display = 'flex';
    bumpHideTimer();
  }

  function hideOverlay() {
    if (overlay) overlay.style.display = 'none';
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  // dragleave is unreliable when the cursor exits the window, so the overlay
  // self-hides whenever dragover events stop arriving.
  function bumpHideTimer() {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hideOverlay, 400);
  }

  window.addEventListener('dragenter', function (e) {
    if (!onWorkOrder() || !hasFiles(e)) return;
    // Umbrava permission gate: the overlay exists to attach documents to the work order. Without
    // the Document > Add New checkbox the upload would 403 at the end of the flow, so the overlay
    // never appears and the browser's own drop behaviour is left alone. Fails OPEN when unknown.
    if (!bwnCan('WorkOrderDocument.AddNew')) return;
    // Yield to the Create Work Order modal: when BWN WO Intake's drop zone is present (or the
    // Create WO modal is open), a file drag is meant for THAT modal's prefill, not this page's
    // document upload - so don't throw the full-screen overlay over it and steal the drop.
    if (document.getElementById('bwn-wo-drop') || document.querySelector('textarea#scopeOfWork')) return;
    // Same yield for the Create Vendor modal: BWN Vendor Intake's prefill zone (or the modal's
    // company-name field, if the zone hasn't injected yet) means the drag is a W-9/Prospect Form
    // for THAT modal, even when a work order sits behind it.
    if (document.getElementById('bwn-vi-bar') || document.querySelector('input[name="details.companyName"]')) return;
    showOverlay();
  }, true);

  window.addEventListener('dragover', function (e) {
    if (!overlay || overlay.style.display === 'none') return;
    bumpHideTimer();
  }, true);

  window.addEventListener('dragend', hideOverlay, true);
  window.addEventListener('drop', hideOverlay, true);

  // Programmatic entry: BWN WO Intake hands the just-created WO's PO email (+ any attachments)
  // here via bwn:cmd right after the WO is created, so they upload to Documents + draft the
  // email note through the EXACT same flow as a manual drop. Acks so the caller knows it landed.
  // No-op off a WO detail page or with no files.
  document.addEventListener('bwn:cmd', function (e) {
    var d = e && e.detail;
    if (!d || d.id !== 'dropupload:files' || !d.files || !d.files.length || !onWorkOrder()) return;
    var raw = [], dt = new DataTransfer();
    for (var i = 0; i < d.files.length; i++) { try { dt.items.add(d.files[i]); raw.push(d.files[i]); } catch (e2) { } }
    if (!raw.length) return;
    try { document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id: 'dropupload:accepted', count: raw.length } })); } catch (e3) { }
    var originTab = (function () { var t = document.querySelector('[role="tab"][aria-selected="true"]'); return t ? (t.textContent || '').trim() : ''; })();
    var ctx = { aborted: false };
    var described = Promise.all(raw.map(describeFile));
    described.then(function (files) {
      if (ctx.aborted) return;
      var fresh = pending && (Date.now() - pending.ts < PENDING_TTL);
      var merged = fresh ? pending.files.concat(files) : files;
      var origin = (fresh && pending.originTab) ? pending.originTab : originTab;
      // WO Intake handoff = a just-created WO's CLIENT request email, so the note is always a
      // Client note (the sender is often a broker like Fairmarkit that classifyDomain reads as Vendor).
      pending = { ts: Date.now(), files: merged, noteText: buildNoteText(merged), originTab: origin, noteType: 'Client' };
      showNoteReview();
      enrichNoteWithAI(pending);   // upgrade the mechanical lead to the AI brief in the background
    });
    // WO Intake handoff = a just-created WO's client request email. The EMAIL is the "Work Order
    // Request"; its image attachments are the site photos the requester sent, and filing those as
    // Work Order Requests too is what buried them (reported on the Pilot 258 painting request).
    // Label per file - Umbrava has no update-label mutation, so it has to be right at upload time.
    runApiUpload(raw, described, dt, ctx, function (f) {
      return fileKind(f) === 'Photo' ? 'Photo' : 'Work Order Request';
    });
  }, false);

  // ---- Toast -----------------------------------------------------------------

  function toast(msg) {
    var el = document.createElement('div');
    el.style.cssText =
      'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);z-index:2147483001;' +
      'background:#1b2a4a;color:#fff;padding:10px 18px;border-radius:8px;' +
      'font:500 13px/1.4 -apple-system,BlinkMacSystemFont,\'Segoe UI\',\'Helvetica Neue\',Arial,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.3);';
    el.textContent = 'BWN Drop Upload: ' + msg;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 4500);
  }

  // When the note composer opens but Umbrava's editor rejects the programmatic fill AND the automatic
  // clipboard write had no user gesture to ride on (this whole flow is auto-triggered by WO Intake, so
  // the drop/create gesture's transient activation has long expired), the coordinator is left with a
  // blank note and an empty clipboard - Ctrl+V pastes nothing. This button supplies the missing
  // gesture: the click IS a user activation, so copyText() lands, and their Ctrl+V into the Description
  // then works. No animation (the no-motion UI contract for this module).
  function copyNoteButton(text) {
    try {
      var old = document.getElementById('bwn-du-copynote'); if (old) old.remove();
      var b = document.createElement('button');
      b.id = 'bwn-du-copynote'; b.type = 'button';
      b.textContent = '📋 Copy the WO note, then Ctrl+V into Description';
      b.style.cssText = 'position:fixed;bottom:70px;left:50%;transform:translateX(-50%);z-index:2147483002;' +
        'background:#1a5f3e;color:#fff;border:none;padding:12px 18px;border-radius:9px;cursor:pointer;' +
        'font:600 13px/1.4 -apple-system,BlinkMacSystemFont,\'Segoe UI\',\'Helvetica Neue\',Arial,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);';
      b.addEventListener('click', function () {
        copyText(text).then(function (ok) {
          if (ok) { b.textContent = '✓ Copied - click the Description field and press Ctrl+V'; setTimeout(function () { if (b.parentNode) b.remove(); }, 8000); }
          else { try { console.info('[BWN DROP UPLOAD] WO note (copy blocked; select it from here):\n\n' + text); } catch (e) { } b.textContent = 'Copy blocked by the browser - the note is in the console (F12)'; }
        });
      });
      document.body.appendChild(b);
      setTimeout(function () { if (document.getElementById('bwn-du-copynote') === b) b.remove(); }, 90000);
    } catch (e) { }
  }
})();
