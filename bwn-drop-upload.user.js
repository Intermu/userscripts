// ==UserScript==
// @name         BWN Drop Upload (Broadway National)
// @namespace    broadwaynational.bwn
// @version      1.3.5
// @downloadURL  https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-drop-upload.user.js
// @updateURL    https://raw.githubusercontent.com/Intermu/userscripts/main/bwn-drop-upload.user.js
// @description  Drop files anywhere on an Umbrava work order to upload them. Opens the Documents tab and upload dialog, hands over the files, and builds each file's description from its contents. Emails are parsed locally (.msg via an OLE/MAPI reader, .eml via RFC822) into an Outlook-style block - From/Sent/To/Cc/Subject and the body - that becomes the WO note. Umbrava's Description field is a locked react-aria combobox that rejects programmatic fills, so the description goes on your clipboard for a one-tap Ctrl+V. You review and Save everything. Runs in the browser only: no network access, no grants.
// @match        https://app.umbrava.com/*
// @match        https://*.umbrava.com/*
// @run-at       document-idle
// @noframes
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  var VER = '1.3.5';
  console.info('[BWN DROP UPLOAD] v' + VER + ' · Email→note: real .msg (OLE/MAPI) + .eml parsing · Description: clipboard-paste assist (locked react-aria combobox)');

  // Active only on WO pages; checked at drag time so SPA navigation needs no watcher.
  function onWorkOrder() {
    return /\/work-orders\/\d+/.test(location.pathname);
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
        if (Date.now() - t0 > timeoutMs) return resolve(null);
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

  // .eml = RFC822 text. Headers end at the first blank line; multipart bodies keep
  // the text/plain part; quoted-printable soft breaks are undone; HTML falls back
  // to tag-stripping. Best-effort - a miss just means a plainer description.
  function parseEml(text) {
    var headEnd = text.search(/\r?\n\r?\n/);
    var head = headEnd > 0 ? text.slice(0, headEnd) : text.slice(0, 3000);
    var unfold = head.replace(/\r?\n[ \t]+/g, ' ');
    function h(name) {
      var m = unfold.match(new RegExp('^' + name + ':\\s*(.+)$', 'im'));
      return m ? m[1].replace(/\s+/g, ' ').trim() : '';
    }
    var body = headEnd > 0 ? text.slice(headEnd + 2) : '';
    var ct = h('Content-Type');
    var bm = ct.match(/boundary="?([^";]+)"?/i);
    if (bm) {
      var parts = body.split('--' + bm[1]);
      for (var i = 0; i < parts.length; i++) {
        if (/content-type:\s*text\/plain/i.test(parts[i])) {
          var pe = parts[i].search(/\r?\n\r?\n/);
          var pb = pe > 0 ? parts[i].slice(pe + 2) : parts[i];
          var ph = parts[i].slice(0, pe > 0 ? pe : 400);
          if (/quoted-printable/i.test(ph)) pb = deqp(pb);
          else if (/base64/i.test(ph)) pb = deb64(pb);   // Outlook .eml with non-ASCII commonly base64s the body - raw b64 in the note is noise (review)
          body = pb;
          break;
        }
      }
    } else if (/quoted-printable/i.test(unfold)) {
      body = deqp(body);
    } else if (/^content-transfer-encoding:.*base64/im.test(unfold)) {
      body = deb64(body);
    }
    return { from: h('From'), date: h('Date'), subject: h('Subject'), to: h('To'), cc: h('Cc'), body: cleanBody(body) };
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
    var body = String(raw || '').slice(0, BODY_MAX).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    body = body.replace(/ ?<(?:mailto:|https?:\/\/)[^>]*>/gi, '');
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
    return lines.join('\n').split('\n').map(function (l) { return l.replace(/\s+$/, ''); }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  function formatEmailBlock(m) {
    var L = [];
    var from = fmtAddr({ name: m.fromName, email: m.fromEmail }); if (from) L.push('From: ' + from);
    var sent = m.sent ? formatSent(m.sent) : (m.sentRaw || ''); if (sent) L.push('Sent: ' + sent);
    if (m.to && m.to.length) L.push('To: ' + m.to.map(fmtAddr).join('; '));
    if (m.cc && m.cc.length) L.push('Cc: ' + m.cc.map(fmtAddr).join('; '));
    if (m.subject) L.push('Subject: ' + m.subject);
    var body = tidyBody(m.body);
    return L.join('\n') + (body ? '\n\n' + body : '');
  }

  // Short one-liner for the Description field / clipboard (emails add from+sent).
  function emailDesc(m, name) {
    var meta = [];
    var fromShown = m.fromName || smtpAddr(m.fromEmail);   // never the raw Exchange DN
    if (fromShown) meta.push('from ' + fromShown);
    if (m.sent && !isNaN(m.sent.getTime())) meta.push('sent ' + shortDate(+m.sent));
    return (m.subject || name.replace(/\.(eml|msg)$/i, '')) + (meta.length ? ' (' + meta.join(', ') + ')' : '');
  }

  // Build per file: {kind, name, size, desc (short - Description field/clipboard),
  // noteLine (one-line WO-note fallback), and for emails isEmail + email model +
  // noteBlock (the full Outlook-style block)}. Email parsing is async (FileReader).
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
        try {
          var m = isMsg ? parseMsg(rd.result) : emlToModel(parseEml(String(rd.result || '')));
          var block = formatEmailBlock(m);
          if (!block) return fallback('');
          base.isEmail = true; base.email = m; base.noteBlock = block;
          base.desc = emailDesc(m, base.name);
          base.noteLine = '• ' + (m.subject || base.name) + ' - Email';
        } catch (e) { return fallback(''); }
        finish(base);
      };
      if (isMsg) rd.readAsArrayBuffer(f); else rd.readAsText(f);
    });
  }

  // ---- Pending upload summary (drop → dialog → Upload click → WO note) --------

  var pending = null;                                      // { ts, files:[described], noteText, originTab }
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
    try { if (el._valueTracker) el._valueTracker.setValue(' ' + val); } catch (e) { }
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
  function handleDrop(dt, described, ctx) {
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
      described.then(function (files) { if (!ctx.aborted) fillDescriptions(files); });
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
    var html = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>');
    var tail = '';
    for (var k = lines.length - 1; k >= 0; k--) { if (lines[k].trim()) { tail = lines[k].trim(); break; } }
    function stuck() { var t = ed.textContent || ''; return tail ? t.indexOf(tail.slice(0, 40)) !== -1 : !!t.trim(); }
    function clear() { try { ed.focus(); document.execCommand('selectAll', false, null); } catch (e) { } }
    function tryHtml() { clear(); try { document.execCommand('insertHTML', false, html); } catch (e) { } }
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
    function tryInner() { try { ed.innerHTML = html; ed.dispatchEvent(new Event('input', { bubbles: true })); } catch (e) { } }
    function settle() { return new Promise(function (r) { setTimeout(function () { r(stuck()); }, 250); }); }
    var steps = [tryHtml, trySoftLines, tryText, tryInner];
    function run(i) {
      if (i >= steps.length) return Promise.resolve(stuck());
      steps[i]();
      return settle().then(function (ok) { return ok ? true : run(i + 1); });
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

  function insertNote(text, originTab) {
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
        if (!ed) { copied.then(function (ok) { toast(ok ? 'Upload note copied to clipboard - the note composer didn’t open.' : 'The note composer didn’t open.'); }); return; }
        setEditorValue(ed, text).then(function (filled) {
          copied.then(function (ok) {
            if (filled) toast('Upload note drafted - review and Save.' + (ok ? ' (Also on your clipboard.)' : ''));
            else toast(ok ? 'Note composer opened but it blocked auto-fill - press Ctrl+V to paste the note.' : 'Note composer opened but auto-fill was blocked.');
          });
        });
      });
    });
  }

  document.addEventListener('click', function (e) {
    if (!pending) return;
    if (Date.now() - pending.ts > PENDING_TTL) { pending = null; return; }
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
    var note = pending.noteText, originTab = pending.originTab || '';
    pending = null;
    // Let the dialog close and the upload kick off before touching the notes pane.
    setTimeout(function () { insertNote(note, originTab); }, 1400);
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
      'Descriptions are prepped for one-tap paste; emails become a full WO note on Upload - you review and Save.</div>';
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
      // Copy files out: the original DataTransfer is neutered after this handler.
      var dt = new DataTransfer();
      var raw = [];
      for (var i = 0; i < e.dataTransfer.files.length; i++) {
        dt.items.add(e.dataTransfer.files[i]);
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
        pending = { ts: Date.now(), files: merged, noteText: buildNoteText(merged), originTab: origin };
      });
      handleDrop(dt, described, ctx);
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
    // Yield to the Create Work Order modal: when BWN WO Intake's drop zone is present (or the
    // Create WO modal is open), a file drag is meant for THAT modal's prefill, not this page's
    // document upload - so don't throw the full-screen overlay over it and steal the drop.
    if (document.getElementById('bwn-wo-drop') || document.querySelector('textarea#scopeOfWork')) return;
    showOverlay();
  }, true);

  window.addEventListener('dragover', function (e) {
    if (!overlay || overlay.style.display === 'none') return;
    bumpHideTimer();
  }, true);

  window.addEventListener('dragend', hideOverlay, true);
  window.addEventListener('drop', hideOverlay, true);

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
})();
