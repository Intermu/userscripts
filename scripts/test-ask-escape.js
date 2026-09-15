// test-ask-escape.js - Bundle A / Commit 3: safe Escape + unsent-text protection, keyboard,
// scroll stability + Jump-to-latest, accessible names, and confirmation that NO new telemetry
// egress was added (ROI deferred). Structural byte assertions over the shipped bwn-ask.user.js.
var fs = require('fs');
var path = require('path');
var A = require('./assert.js');
var SRC = fs.readFileSync(path.join(__dirname, '..', 'bwn-ask.user.js'), 'utf8').replace(/\r\n/g, '\n');
function has(re, name, detail) { A.ok(name, (re instanceof RegExp ? re.test(SRC) : SRC.indexOf(re) !== -1), detail); }

// --- safe Escape ---
var escH = SRC.slice(SRC.indexOf("if (e.key !== 'Escape') return;"));
escH = escH.slice(0, escH.indexOf('});') + 3);
A.ok('Escape handler exists and prevents default', /e\.key !== 'Escape'\) return;/.test(SRC) && /e\.preventDefault\(\)/.test(escH));
A.ok('empty input closes immediately via hidePanel()', /hidePanel\(\)/.test(escH));
A.ok('unsent text is protected (armed confirmation, not silent discard)', /_escArmed/.test(escH) && /inputEl[\s\S]*value[\s\S]*trim/.test(escH));
A.ok('exactly one \'Escape\' token (no stray handlers)', (SRC.match(/'Escape'/g) || []).length === 1);
has(/panelEl\._escReset = function/, 're-arm hook present');
has(/inputEl\.addEventListener\('input', function/, 'typing re-arms the Escape confirmation');

// --- keyboard ---
has(/e\.key === 'Enter' && !e\.shiftKey[\s\S]{0,40}doAsk\(\)/, 'Enter submits; Shift+Enter falls through to a newline');

// --- scroll stability + jump-to-latest ---
has(/function atBottom\(\)/, 'atBottom() scroll helper present');
A.ok('new content sticks to bottom only when already at bottom (2 call sites)', (SRC.match(/var stick = atBottom\(\)/g) || []).length === 2);
A.ok('no unconditional auto-scroll on message append', !/appendChild\(wrap\);\s*msgsEl\.scrollTop = msgsEl\.scrollHeight;/.test(SRC));
has("jumpBtn.textContent = 'Jump to latest'", 'Jump-to-latest control present');
has('jumpBtn.hidden = true', 'Jump-to-latest hidden by default');
var jumpFn = SRC.slice(SRC.indexOf('jumpBtn.addEventListener'));
jumpFn = jumpFn.slice(0, jumpFn.indexOf('});') + 3);
A.ok('Jump-to-latest only scrolls (no fetch/mutation/GM)', /scrollTop/.test(jumpFn) && !/fetch\(|GM_xmlhttpRequest|gmPost|\.value\s*=/.test(jumpFn));
has("msgsEl.addEventListener('scroll'", 'scroll listener hides jump when back at bottom');

// --- accessible names ---
[
  ["aria-label', 'Close'", 'Close'],
  ["aria-label', 'Ask this question'", 'Ask'],
  ["aria-label', 'Ask about this work order'", 'input'],
  ["aria-label', 'Jump to latest messages'", 'Jump-to-latest'],
  ["aria-label', 'Copy draft'", 'Copy draft'],
  ["aria-label', 'More commands'", 'More commands'],
  ["aria-label', 'Manual draft'", 'draft boundary'],
  ["aria-label', 'Read-only assistant'", 'Read-only badge']
].forEach(function (p) { has(p[0], 'accessible name: ' + p[1]); });
has(/statusEl\.setAttribute\('role', 'status'\)/, 'status region is a live status');
has(/reduced-motion|prefers-reduced-motion/, 'reduced-motion is respected on close');

// --- ROI deferred: NO new telemetry egress added ---
// The only outbound calls remain the existing AI proxy (gmPost -> AI_URL) and same-origin gql.
function count(needle) { return SRC.split(needle).length - 1; }
A.ok('no analytics SDK / beacon added', !/sendBeacon|mixpanel|gtag\(|datadog|amplitude|posthog/i.test(SRC));
A.ok('GM_xmlhttpRequest is used only by the existing gmPost transport (no new egress)', count('GM_xmlhttpRequest') <= 2);
A.ok('no new telemetry fetch endpoint (only same-origin graphql remains)', count("fetch('/api/") === count("fetch('/api/graphql'"));

// --- invariants ---
A.ok('still exactly two bwnFocusTrap(panelEl) calls', (SRC.match(/bwnFocusTrap\(panelEl\)/g) || []).length === 2);
A.ok('@version bumped to 0.10.0', SRC.indexOf('// @version      0.10.0') !== -1);

A.finish();
