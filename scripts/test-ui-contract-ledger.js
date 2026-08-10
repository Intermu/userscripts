// test-ui-contract-ledger.js - completeness ledger over the shared UI contracts of the BWN suite.
//
// WHY THIS EXISTS, and why it is not test-drawer-motion.js:
//   The 2026-08-10 animation review fixed four shared UI primitives - the .bwn-drawer exit, the
//   bottom-centre toast() helper, the prefers-reduced-motion coverage, and the rail-anchored panel
//   geometry - and each fix had to be copied into every sandbox that carries the primitive, because
//   the scripts run in separate Tampermonkey scopes and cannot share a runtime object. That copying
//   landed UNEVENLY: the toast fix went to five modules and not Core, the reduced-motion fix went to
//   Core alone, the drawer fix to six owners. test-drawer-motion.js proves each fix WORKS in the
//   files it already knows about - but it learns those files from hand-written arrays (MODULES,
//   TOAST_MODULES, ANIMATED_BY_FILE, RAIL_ANCHORED). A script that GROWS one of these primitives, or
//   a brand-new script, is invisible to those arrays: the sweep passes while the new surface ships
//   the exact bug the review just spent a night removing. That is the "quietly dropped" hole.
//
//   f1b73cc said it plainly: "The reduced-motion hole had shipped four times, so stop finding it by
//   hand." This harness is the stop-finding-it-by-hand half. It does NOT re-prove the fixes work
//   (that is the sibling's job); it enumerates EVERY bwn-*.user.js on disk and forces each one into a
//   classified row for every contract, then ties that ledger back to the sibling's arrays so the two
//   cannot drift. It is GREEN today - the ledger below is the measured 2026-08-10 state - and it goes
//   RED the moment reality drifts from the ledger in EITHER direction: a script gains a primitive
//   nobody classified, a HAS fix regresses, an OWES gets fixed without being closed out, a blessed
//   no-motion surface grows half an animation, a new .user.js appears, or one disappears.
//
// STATUS VOCABULARY (per script, per contract):
//   HAS       - the script carries the primitive AND the review's fix marker for it.
//   OWES      - the script carries the primitive but NOT the fix; the work is pending and NAMED here
//               so it cannot be forgotten. (No cell is OWES today; the machinery is kept live so a
//               future decision to owe the fix is a one-word edit that the harness then tracks.)
//   NA        - the script does not carry the primitive at all. Asserted ABSENT, so a script that
//               grows the primitive can never sit silently under NA.
//   DIVERGENT - the script carries the primitive but is DELIBERATELY not the shared-fixed form, per a
//               recorded decision (see DIVERGENCE below). Asserted present-but-unfixed, plus an
//               intent guard where one is cheap, so a divergence that silently converges on (or
//               half-converges toward) the shared fix is caught and forced back through review.
//
// Run: "/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe" scripts/test-ui-contract-ledger.js
// No pixels are rendered here and none can be: this reads the shipped bytes only.

var fs = require('fs');
var path = require('path');
var A = require('./assert.js');

var ROOT = path.join(__dirname, '..');
function read(name) { return fs.readFileSync(path.join(ROOT, name), 'utf8').replace(/\r\n/g, '\n'); }

// Reverts ONE piece of a source string; throws if the target is absent or not unique, so a control
// that failed to apply cannot masquerade as a passing one. Same contract as test-drawer-motion.js.
function mutate(src, from, to) {
  var i = src.indexOf(from);
  if (i === -1) throw new Error('MUTATION TARGET ABSENT: ' + JSON.stringify(from.slice(0, 70)));
  if (src.indexOf(from, i + 1) !== -1) throw new Error('MUTATION TARGET NOT UNIQUE: ' + JSON.stringify(from.slice(0, 70)));
  return src.slice(0, i) + to + src.slice(i + from.length);
}

// Slice one function body out of the shipped bytes by name, brace-counting to its end so the check
// keeps working when the body changes.
function sliceFn(src, decl) {
  var a = src.indexOf(decl);
  if (a === -1) throw new Error('function not found: ' + decl);
  var depth = 0, i = src.indexOf('{', a);
  for (var j = i; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') { depth--; if (depth === 0) return src.slice(a, j + 1); }
  }
  throw new Error('unbalanced braces after ' + decl);
}

// ---- detectors: primitive PRESENCE and review FIX MARKER, per contract -----------------------
// Each pair is deliberately conservative and grounded in the shipped bytes of 2026-08-10. Where a
// detector is looser or tighter than it looks, the negative controls below prove it fires.

// Drawer: an owner either creates an element with the shared class or carries the exit helper. Core
// builds its .bwn-drawer through a different path than the modules, so presence is the UNION; a bare
// ".bwn-drawer" mention in a comment (bid-out) is not ownership and must not match.
function createsDrawer(src) { return /\.className\s*=\s*'bwn-drawer'/.test(src); }
function hasDrawerDismiss(src) { return /function drawerDismiss\(/.test(src); }
function drawerPresent(src) { return createsDrawer(src) || hasDrawerDismiss(src); }
function drawerFixed(src) { return hasDrawerDismiss(src); }

// Toast: the bottom-centre helper. The review's fix forces a reflow before the entrance transition;
// its absence in a helper that also has NO transition at all is the honest no-motion form.
function toastPresent(src) { return /function toast\(/.test(src); }
function toastBody(src) { return sliceFn(src, 'function toast('); }
function toastFixed(src) { return toastBody(src).indexOf('void t.offsetHeight') !== -1; }
function toastHasTransition(src) { return /\.style\.transition\s*=/.test(toastBody(src)); }

// Reduced motion: a file "participates" once it declares a real (non-none) animation. The fix is a
// prefers-reduced-motion block; whether it covers EVERY selector is the sibling's sweep - here we
// only assert participation and that a block exists, then tie the participant SET to the sweep.
function animates(src) { return /animation:(?!none)[a-zA-Z]/.test(src); }
function hasReduceBlock(src) { return /prefers-reduced-motion/.test(src); }

// Rail anchor: a file participates once it reads the shift variable. The fix moves the rail's
// position onto a transform instead of into `left`/`max-width`.
function railPresent(src) { return src.indexOf('--bwn-dock-shift') !== -1; }
function railFixed(src) { return /transform:translateX\(var\(--bwn-dock-shift/.test(src); }

var CONTRACTS = {
  drawer:  { present: drawerPresent, fixed: drawerFixed },
  toast:   { present: toastPresent,  fixed: toastFixed  },
  rmotion: { present: animates,      fixed: function (s) { return animates(s) && hasReduceBlock(s); } },
  rail:    { present: railPresent,   fixed: railFixed   }
};

// ---- THE LEDGER: measured suite state, 2026-08-10 --------------------------------------------
// Every bwn-*.user.js in the repo root MUST appear here (Section 1 enforces both directions). Adding
// a script forces a row; the CI step then keeps that row honest.
var LEDGER = {
  'bwn-ask.user.js':           { drawer: 'DIVERGENT', toast: 'NA',        rmotion: 'NA',  rail: 'NA'  },
  'bwn-bid-out.user.js':       { drawer: 'NA',        toast: 'DIVERGENT', rmotion: 'NA',  rail: 'HAS' },
  'bwn-cc-auth.user.js':       { drawer: 'HAS',       toast: 'HAS',       rmotion: 'NA',  rail: 'NA'  },
  'bwn-cc-purchase.user.js':   { drawer: 'HAS',       toast: 'HAS',       rmotion: 'NA',  rail: 'NA'  },
  'bwn-dispatch.user.js':      { drawer: 'HAS',       toast: 'HAS',       rmotion: 'NA',  rail: 'NA'  },
  'bwn-drop-upload.user.js':   { drawer: 'NA',        toast: 'DIVERGENT', rmotion: 'NA',  rail: 'NA'  },
  'bwn-kanban.user.js':        { drawer: 'NA',        toast: 'NA',        rmotion: 'NA',  rail: 'NA'  },
  'bwn-suite-ai.user.js':      { drawer: 'NA',        toast: 'DIVERGENT', rmotion: 'HAS', rail: 'HAS' },
  'bwn-suite-core.user.js':    { drawer: 'HAS',       toast: 'DIVERGENT', rmotion: 'HAS', rail: 'HAS' },
  'bwn-vendor-intake.user.js': { drawer: 'NA',        toast: 'DIVERGENT', rmotion: 'NA',  rail: 'NA'  },
  'bwn-wide-list.user.js':     { drawer: 'NA',        toast: 'NA',        rmotion: 'NA',  rail: 'NA'  },
  'bwn-wo-assist.user.js':     { drawer: 'HAS',       toast: 'HAS',       rmotion: 'NA',  rail: 'NA'  },
  'bwn-wo-audit.user.js':      { drawer: 'HAS',       toast: 'DIVERGENT', rmotion: 'NA',  rail: 'NA'  },
  'bwn-wo-intake.user.js':     { drawer: 'NA',        toast: 'HAS',       rmotion: 'NA',  rail: 'NA'  }
};

// Why each DIVERGENT cell is intentional, not owed. Confirmed with Mike 2026-08-10; the toast rows
// for bid-out/wo-audit/suite-ai are verbatim from commit 215af97, drop-upload/vendor-intake were
// ruled the same class in the same session, and the ask drawer is the deliberately-different close
// recorded in wiki/bwn-launcher-dock.md and handled on its own path by test-drawer-motion.js.
var DIVERGENCE = {
  'bwn-ask.user.js/drawer':           'Owns #bwn-drawer-ask on Core\'s shared sheet but closes on its own path; deliberately NOT the shared drawerDismiss. Its behaviour is proven separately in test-drawer-motion.js.',
  'bwn-bid-out.user.js/toast':        'No-motion toast: honest for an occasional surface (commit 215af97). Not the half-animation defect.',
  'bwn-drop-upload.user.js/toast':    'No-motion toast (append + remove). Ruled blessed no-motion 2026-08-10, same class as bid-out/wo-audit/suite-ai.',
  'bwn-suite-ai.user.js/toast':       'No-motion toast: honest for an occasional surface (commit 215af97).',
  'bwn-suite-core.user.js/toast':     'The Reminders toast(msg,url) is a distinct 20s dismissible surface, not the shared toast(msg,ms,bg) helper; intentionally static.',
  'bwn-vendor-intake.user.js/toast':  'No-motion toast (append + remove). Ruled blessed no-motion 2026-08-10, same class as bid-out/wo-audit/suite-ai.',
  'bwn-wo-audit.user.js/toast':       'No-motion toast: honest for an occasional surface (commit 215af97).'
};

// ---- one pure judge, used by both the real assertions and every negative control -------------
// Returns { ok, why }. Keeping it pure means a control can feed it a mutated source and require the
// SAME judge to flip, rather than a parallel check that could agree with the bug by construction.
function judge(src, contract, status) {
  var C = CONTRACTS[contract];
  var present = C.present(src);
  var fixed = present && C.fixed(src);
  if (status === 'NA') {
    return { ok: !present, why: present ? 'primitive PRESENT but ledger says NA - it must be classified' : 'absent as declared' };
  }
  if (status === 'HAS') {
    if (!present) return { ok: false, why: 'ledger says HAS but the primitive is MISSING' };
    return { ok: fixed, why: fixed ? 'present and fixed' : 'primitive present but the FIX MARKER is gone (regressed?)' };
  }
  if (status === 'OWES') {
    if (!present) return { ok: false, why: 'ledger says OWES but the primitive is MISSING' };
    return { ok: !fixed, why: fixed ? 'the fix is now PRESENT - close the ledger out (OWES -> HAS)' : 'present and still owed (named, not forgotten)' };
  }
  if (status === 'DIVERGENT') {
    if (!present) return { ok: false, why: 'ledger says DIVERGENT but the primitive vanished' };
    if (fixed) return { ok: false, why: 'a divergent surface silently adopted the shared fix - reclassify to HAS' };
    if (contract === 'toast' && toastHasTransition(src)) {
      return { ok: false, why: 'a blessed no-motion toast grew a transition (half-animation or partial fix) - reclassify' };
    }
    return { ok: true, why: 'divergent, intentionally not the shared fix' };
  }
  return { ok: false, why: 'unknown status ' + status };
}

// Pull a named array/object-key set out of the sibling harness source, so the two are tied and a
// rename there fails loudly here rather than letting the two drift apart silently.
var SIB = read('scripts/test-drawer-motion.js');
function siblingListNames(varName) {
  var i = SIB.indexOf('var ' + varName + ' = [');
  if (i === -1) throw new Error('sibling array not found: ' + varName);
  var end = SIB.indexOf('];', i);
  var seg = SIB.slice(i, end);
  return (seg.match(/'(bwn-[a-z0-9-]+\.user\.js)'/g) || []).map(function (s) { return s.replace(/'/g, ''); });
}
function siblingObjectKeys(varName) {
  var i = SIB.indexOf('var ' + varName + ' = {');
  if (i === -1) throw new Error('sibling object not found: ' + varName);
  var depth = 0, start = SIB.indexOf('{', i), keys = [];
  for (var j = start; j < SIB.length; j++) {
    if (SIB[j] === '{') depth++;
    else if (SIB[j] === '}') { depth--; if (depth === 0) { var seg = SIB.slice(start, j + 1); (seg.match(/'(bwn-[a-z0-9-]+\.user\.js)':/g) || []).forEach(function (m) { keys.push(m.replace(/['":]/g, '')); }); return keys; } }
  }
  throw new Error('unbalanced braces reading ' + varName);
}
function setEq(a, b) { var sa = a.slice().sort().join('|'), sb = b.slice().sort().join('|'); return sa === sb; }
function ledgerScriptsWith(contract, status) {
  return Object.keys(LEDGER).filter(function (f) { return LEDGER[f][contract] === status; });
}

// =============================================================================================
// 1. MANIFEST COMPLETENESS: every *.user.js on disk is in the ledger, and vice versa.
// This is the whole point - the ledger's authority comes from the filesystem, not a hand-list that
// could itself be quietly short.
// =============================================================================================
console.log('-- 1. manifest: disk <-> ledger --');
var onDisk = fs.readdirSync(ROOT).filter(function (f) { return /^bwn-.*\.user\.js$/.test(f); });
var inLedger = Object.keys(LEDGER);
onDisk.forEach(function (f) {
  A.ok('on disk and in the ledger: ' + f, inLedger.indexOf(f) !== -1, 'a new script must be given a row before it ships');
});
inLedger.forEach(function (f) {
  A.ok('in the ledger and still on disk: ' + f, onDisk.indexOf(f) !== -1, 'a removed script must be dropped from the ledger');
});
A.ok('ledger row count equals the ' + onDisk.length + ' scripts on disk', inLedger.length === onDisk.length,
  'ledger ' + inLedger.length + ' vs disk ' + onDisk.length);

// =============================================================================================
// 2. PER-CELL: detected reality agrees with the ledger classification, for all 14 scripts.
// =============================================================================================
console.log('\n-- 2. per-script classification (' + onDisk.length + ' scripts x 4 contracts) --');
var SRC = {};
onDisk.forEach(function (f) { SRC[f] = read(f); });
Object.keys(CONTRACTS).forEach(function (contract) {
  onDisk.slice().sort().forEach(function (f) {
    var status = LEDGER[f][contract];
    var r = judge(SRC[f], contract, status);
    var label = f.replace(/^bwn-|\.user\.js$/g, '') + ' . ' + contract + ' = ' + status;
    A.ok(label, r.ok, r.why);
    if (status === 'DIVERGENT') {
      A.ok('  ^ divergence for ' + f + '/' + contract + ' has a recorded reason',
        typeof DIVERGENCE[f + '/' + contract] === 'string', 'add a DIVERGENCE entry so the blessing is not silent');
    }
  });
});

// =============================================================================================
// 3. TIE TO THE SIBLING: the ledger's HAS/participant sets must equal the arrays test-drawer-motion.js
// actually sweeps, so neither harness can quietly omit a script the other trusts.
// =============================================================================================
console.log('\n-- 3. ledger <-> test-drawer-motion.js arrays --');
var animatingOnDisk = onDisk.filter(function (f) { return animates(SRC[f]); });
var railOnDisk = onDisk.filter(function (f) { return railPresent(SRC[f]); });

A.ok('reduced-motion: files that animate == ledger rmotion:HAS',
  setEq(animatingOnDisk, ledgerScriptsWith('rmotion', 'HAS')), 'disk ' + animatingOnDisk.join(',') + ' vs ledger ' + ledgerScriptsWith('rmotion', 'HAS').join(','));
A.ok('reduced-motion: ledger rmotion:HAS == ANIMATED_BY_FILE keys in the sibling',
  setEq(ledgerScriptsWith('rmotion', 'HAS'), siblingObjectKeys('ANIMATED_BY_FILE')), 'sibling ' + siblingObjectKeys('ANIMATED_BY_FILE').join(','));

A.ok('rail: files reading --bwn-dock-shift == ledger rail:HAS',
  setEq(railOnDisk, ledgerScriptsWith('rail', 'HAS')), 'disk ' + railOnDisk.join(',') + ' vs ledger ' + ledgerScriptsWith('rail', 'HAS').join(','));
A.ok('rail: ledger rail:HAS == RAIL_ANCHORED keys in the sibling',
  setEq(ledgerScriptsWith('rail', 'HAS'), siblingObjectKeys('RAIL_ANCHORED')), 'sibling ' + siblingObjectKeys('RAIL_ANCHORED').join(','));

A.ok('toast: ledger toast:HAS == TOAST_MODULES in the sibling',
  setEq(ledgerScriptsWith('toast', 'HAS'), siblingListNames('TOAST_MODULES')), 'sibling ' + siblingListNames('TOAST_MODULES').join(','));

// Drawer: the sibling's MODULES are the non-Core drawer owners it runs drawerDismiss against; the
// ledger's drawer:HAS is those plus Core (Core is checked by the sibling on its own probes, ask is
// the DIVERGENT owner handled on its own path). So MODULES == ledger drawer:HAS minus Core.
var drawerHasNonCore = ledgerScriptsWith('drawer', 'HAS').filter(function (f) { return f !== 'bwn-suite-core.user.js'; });
A.ok('drawer: sibling MODULES == ledger drawer:HAS minus Core',
  setEq(siblingListNames('MODULES'), drawerHasNonCore), 'sibling ' + siblingListNames('MODULES').join(',') + ' vs ledger ' + drawerHasNonCore.join(','));

// =============================================================================================
// 4. SUITE-WIDE SAFETY: no file - present or future - may read the LIVE rail width into a layout
// property. That is the teleport bug; the sibling asserts it for the three known files, we assert it
// for ALL of them so a new dock-anchored panel cannot reintroduce it unseen.
// =============================================================================================
console.log('\n-- 4. suite-wide: nobody reads --bwn-dock-w into left/max-width --');
onDisk.forEach(function (f) {
  A.ok(f.replace(/^bwn-|\.user\.js$/g, '') + ': no live-width `left`', !/left:\s*var\(--bwn-dock-w/.test(SRC[f]));
  A.ok(f.replace(/^bwn-|\.user\.js$/g, '') + ': no live-width `max-width`', !/max-width:calc\(100vw - var\(--bwn-dock-w/.test(SRC[f]));
});

// =============================================================================================
// 5. NEGATIVE CONTROLS: each reproduces a specific "quietly dropped" scenario and requires the
// matching guard above to catch it. A control that no-ops would let the guard rot; mutate() throws
// if its target is missing, and every judge() control asserts the judge FLIPS to not-ok.
// =============================================================================================
console.log('\n-- 5. negative controls (each must catch its own drift) --');

// C1: a NA script grows a drawer. The manifest/per-cell guard must refuse to keep calling it NA.
var c1 = SRC['bwn-kanban.user.js'] + "\n(function(){ var d=document.createElement('div'); d.className = 'bwn-drawer'; })();\n";
A.ok('C1: a drawer appearing in a NA script trips the NA guard', judge(c1, 'drawer', 'NA').ok === false);

// C2: a HAS drawer owner loses its exit helper (the "vanish" regression).
var c2 = mutate(SRC['bwn-dispatch.user.js'], 'function drawerDismiss(', 'function drawerDismiss_DISABLED(');
A.ok('C2: a HAS drawer losing drawerDismiss trips the HAS guard', judge(c2, 'drawer', 'HAS').ok === false);

// C3: a NA script grows a real animation - the exact "stop finding it by hand" hole. The disk-vs-
// ledger animation set must diverge.
var c3src = SRC['bwn-wide-list.user.js'] + "\nvar _x='animation:bwnX 1s ease;';\n";
var c3set = onDisk.map(function (f) { return f === 'bwn-wide-list.user.js' ? null : (animates(SRC[f]) ? f : null); }).filter(Boolean).concat(animates(c3src) ? ['bwn-wide-list.user.js'] : []);
A.ok('C3: a new animating file breaks the reduced-motion participant set',
  setEq(c3set, ledgerScriptsWith('rmotion', 'HAS')) === false);

// C4: a NA script starts reading the dock-shift variable without a ledger row for it.
var c4src = SRC['bwn-kanban.user.js'] + "\nvar _y='transform:translateX(var(--bwn-dock-shift,0px))';\n";
A.ok('C4: a rail primitive appearing in a NA script trips the NA guard', judge(c4src, 'rail', 'NA').ok === false);

// C5: a blessed no-motion toast grows a transition (half-animation, the bug the review removed).
var c5src = "function toast(m){ var t=document.createElement('div'); t.textContent=m; document.body.appendChild(t); t.style.transition='opacity .3s'; }";
A.ok('C5: a no-motion toast growing a transition trips the DIVERGENT guard', judge(c5src, 'toast', 'DIVERGENT').ok === false);

// C6: an OWES cell whose fix silently landed must be forced to close out (OWES -> HAS). Uses a real
// FIXED toast source; if the ledger ever marks it OWES, the appearance of the fix must fail the OWES.
A.ok('C6: a fixed toast under an OWES status is caught (forces OWES -> HAS)',
  judge(SRC['bwn-cc-auth.user.js'], 'toast', 'OWES').ok === false);

// C7: the manifest guard must notice a disk file with no ledger row.
var c7disk = onDisk.concat(['bwn-phantom.user.js']);
A.ok('C7: a disk script with no ledger row is caught',
  c7disk.every(function (f) { return inLedger.indexOf(f) !== -1; }) === false);

// C8: and a ledger row whose file has been removed from disk.
var c8ledger = inLedger.concat(['bwn-ghost.user.js']);
A.ok('C8: a ledger row with no file on disk is caught',
  c8ledger.every(function (f) { return onDisk.indexOf(f) !== -1; }) === false);

// C9: the tie to the sibling must break if the sibling quietly drops a swept script.
var c9 = siblingListNames('TOAST_MODULES').filter(function (f) { return f !== 'bwn-dispatch.user.js'; });
A.ok('C9: the sibling dropping a toast module breaks the tie',
  setEq(c9, ledgerScriptsWith('toast', 'HAS')) === false);

console.log('\n(ledger: ' + onDisk.length + ' scripts x 4 contracts, tied to test-drawer-motion.js. Green == the recorded');
console.log(' 2026-08-10 scope; a red here is drift from it, named by script and contract, never a silent drop.)');
A.finish();
