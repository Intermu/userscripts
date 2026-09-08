# Session handoff - BWN userscripts (US-0 + WO Intake sanitization)

Written 2026-09-02. Untracked on purpose: decide whether this belongs in git before committing it.
Everything below is verified against the working tree, not remembered.

## Read this first

- **`Intermu/userscripts` is anonymously readable.** Confirmed by an HTTP 200 on a raw URL and
  implied by Tampermonkey auto-updating without credentials. Anything committed here is public.
  `scripts/assert.js:22` prints `got`/`want` on failure, so a red harness prints its fixture into
  public GitHub Actions logs. Never put a real client email, name, phone, address, PO or GL code in
  a fixture.
- **Nothing has been pushed.** Two local branches, one with uncommitted work. No `@version` bump
  anywhere, so no installed browser has received any of this.
- **No node on PATH.** Use the bundled one:
  `NODE="/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe"`.
  There is no `package.json`, no `npm`, and no `npx`, so the CI lint job cannot be run locally.

## Branch state

`main` is at `bb8916d`. Two stacked branches, neither pushed:

| branch | base | state |
| --- | --- | --- |
| `feat/us0-manifest-selfcheck` | `main` | 2 commits, complete, verified |
| `feat/intake-fixture-sanitize` | `feat/us0-manifest-selfcheck` | **uncommitted working tree**, complete, verified |

`feat/us0-manifest-selfcheck` commits:
- `7032b6b` `fix(cc): sync the VER banner consts to @version` - `bwn-cc-auth` (0.4.1 -> 0.4.6) and
  `bwn-cc-purchase` (0.7.1 -> 0.7.6). Console banner only; touches no rank-gating logic.
- `250f8ff` `feat(us0): installed-vs-repository diff self-check` (amended once, see below).

`feat/intake-fixture-sanitize` working tree, **not yet committed** - suggested split is three
commits: fixture sanitization / the intake runtime guard / the new harness plus its CI step.
```
 M .github/workflows/ci.yml
 M bwn-wo-intake.user.js
 M scripts/test-amazon-rfq-intake.js
 M scripts/test-cw-amazon-intake.js
 M scripts/test-cw-corrigo-intake.js
 M scripts/test-jll-amazon-intake.js
 M scripts/test-pilot-intake.js
 M scripts/test-transform-intake.js
?? scripts/test-intake-guards.js
```

Unrelated and untouched: `origin/fix/dock-edit-po-wo` still carries `cb9ac85`
"test: update Core @version pins 1.80.1 -> 1.80.2", unmerged. It touches the two harnesses that
hand-pin Core's version. Owner decision whether it lands.

## Baseline

**92/92 harnesses green**, syntax gate clean on all 21 `*.user.js`, CI wiring 1:1 with harness files
(92 files, 92 `ci.yml` references). Reproduce:
```bash
NODE="/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe"
for f in *.user.js; do "$NODE" --check "$f" || echo "SYNTAX FAIL: $f"; done
for f in scripts/test-*.js; do "$NODE" "$f" >/dev/null || echo "FAIL: $f"; done
```
`ci.yml` hand-enumerates every harness as its own step. There is **no orphan-harness guard**, so a
new `scripts/test-*.js` is a silent no-op in CI unless you add its step. Check parity by hand:
```bash
ls -1 scripts/test-*.js | sed 's|scripts/||' | sort > /tmp/a
grep -oE 'scripts/test-[a-z0-9-]+\.js' .github/workflows/ci.yml | sed 's|scripts/||' | sort -u > /tmp/b
diff /tmp/a /tmp/b
```

## Task 1 - US-0 installed-vs-repository self-check (done)

Diagnostic only, Node-side, no browser code. That shape was chosen deliberately: it removes three
security blockers by construction rather than by control - no page to inject into, no `bwn:audit`
ring to leak through, no live Umbrava tab to freeze.

New files:
- `scripts/userscript-meta.js` - the repo's first `==UserScript==` parser. Headers, in-body
  `VER`/`VERSION`/`BWN_VER` const, `(namespace, name)` identity, SHA-256, integrity-pin reader.
  Five harnesses had each grown their own narrow `@version`-only regex; this replaces the need for a
  sixth. **Do not** join the identity pair with a separator - it is `JSON.stringify([ns, name])`
  because a joined string is forgeable (see the amend note below).
- `scripts/userscript-manifest.json` - roster of all 21. Declares only what disk cannot say:
  `expectedInstalled` plus per-check waivers with a recorded reason. Versions, URLs and hashes are
  derived from the shipped bytes every run, so this file cannot drift on them.
- `scripts/test-manifest-ledger.js` - 78 assertions, 10 negative controls. Bidirectional roster
  completeness, `@updateURL == @downloadURL ==` the raw `main` URL for that filename, `@version`
  against the in-body const, canonical `@namespace`, `#sha384=` on every `@require`/`@resource`,
  unique identity per script.
- `scripts/selfcheck-installed.js` - the diff tool.
- `scripts/test-selfcheck-installed.js` - 62 assertions, fixtures synthesised in a temp dir.

### How to run the self-check
```
Tampermonkey Dashboard -> Utilities -> Export, save the zip, UNZIP it, then:
"$NODE" scripts/selfcheck-installed.js <that-folder> [--json]
```
It deliberately does not read zips - the OS already unzips. It **never opens
`<Name>.storage.json`**, which is where GM storage values live (the shared SWA ingest key, the audit
key, the Places key, cached coordinator emails, card labels). Content comparison is hash-only, never
a diff hunk. `test-selfcheck-installed.js` asserts statically that the source carries no egress
primitive, no write path and no `bwn:audit` path, so the guarantee cannot rot.

### What it found on a real export
An export already on disk at
`C:\Users\mnajarro\OneDrive - Broadway National\tampermonkey_scripts (1).zip` reports:
- **Core 1.40.0 and AI 1.18.0 as `SOURCE_LESS + UNGOVERNED`** - installed under the pre-rename
  em-dash `@name` with no `@updateURL` at all. Tampermonkey keys a script on `(@namespace, @name)`,
  so the hyphen rename minted new identities and left the old copies installed as shadows no push
  will ever reach.
- **Drop Upload as `UNGOVERNED + VERSION_MISMATCH`** - 1.3.0 installed against 1.22.0 shipped, no
  `@updateURL`.
- 20 `MISSING`, which is expected noise: that export is partial. A partial export is
  indistinguishable from a genuinely absent install, and the report says so.

Also stale and unaddressed: `OneDrive - Broadway National\Tampermonkey Scripts\*.txt` still holds
hand-pasted masters from 2026-07-14/15, and `broadway-internal-ops/CLAUDE.md` still names that
OneDrive folder as the userscript source of truth. Neither was touched.

### Why `250f8ff` was amended
The first version committed `userscript-meta.js` as **binary** - its `identity()` separator was a
literal NUL byte. Two problems in one: no reviewable diff, and a forgeable identity key. A side-load
declaring namespace `broadwaynational.bwn BWN Kanban (Broadway National)` with an empty `@name`
joins to the same key as the real script, so it would have been matched to `bwn-kanban.user.js` and
reported as a version mismatch on a script it is not, instead of `SOURCE_LESS`. Two negative
controls now pin this (`N6`, `N7` in `test-selfcheck-installed.js`).

### Dead ends, so nobody re-explores them
- `GM_info` self-reports only, and is `undefined` under `@grant none` - 10 of 21 scripts, Core
  included. It cannot see a peer script, with or without grants.
- The Tampermonkey dashboard is a different origin, unreachable from a page-injected script.
- `bwn:status:*` / `bwn:corever:*` cover 3 scripts and carry version plus freshness only - no
  namespace, match, URL or hash.
- A user-produced export is the only full-fidelity surface. Hence the manual step.

## Task 2 - WO Intake (done, uncommitted)

**The queued premise was false.** Amazon-RFQ, CW-Amazon, CW-Corrigo and Transform-SR are not
unpushed - all four ship on `origin/main` in `bwn-wo-intake.user.js` at `@version 0.9.25`, each an
isolated `is*`/`extract*` cluster, each with a harness that slices the real source into a `vm`
(not a stub), each wired into `ci.yml`. Introducing commits: `b80265b`, `b210e07`, `9c25aef`,
`70936ef`, `08dc5ed`. Every branch and worktree carries a byte-identical copy. Nothing to build.

What was actually wrong: the five intake harnesses used **real client emails verbatim** as fixtures
on a public repo - named third parties with direct numbers, work email addresses, site addresses,
client GL codes, a client PO, an equipment serial. Owner decisions taken: **sanitize forward-only**
(no history rewrite - it breaks clones and forks while not recalling what forks, caches and the API
already served) and **validate plus close the real gaps** rather than build anything new.

Done:
- **Fixtures sanitized** in all six intake harnesses, shape-preserving so no regex went unexercised.
  Assertion counts held or rose: 21 / 68 / **46** (was 31) / 77 / 72 / 40.
- **Two client domains must stay real.** `isTransform` keys on the `transformco.com` sender domain
  and `clientFromDomain` on `pilottravelcenters.com`. Replacing them with `example.com` broke three
  detection assertions. The person is synthetic; the company mail domain is not personal data.
- **`sanitizeWo()`** added at `fillWo` - the single point every client path passes through. Strips
  inline emails and phone numbers from `scope`/`_note`/`_warn` and caps all three (`_note` and
  `_warn` were uncapped, letting a pathological document bury the modal a human must review).
  It deliberately does **not** collapse whitespace: the CorrigoPro Problem block and the Pilot asset
  block carry meaningful newlines. Identifier shapes that look phone-ish - GL codes, Caleres WO
  numbers, 12-digit Pilot POs - are asserted to survive it.
- Both `.msg` OLE directory-name maps are `Object.create(null)` (a stream named `__proto__` is
  attacker-controlled input keyed straight into a plain object). The `console.info` no longer echoes
  a parsed field value. The `&mdash;` in the drop-zone is now a hyphen.
- **`scripts/test-intake-guards.js`** (117 assertions, wired into `ci.yml`) pins PII containment
  including a control proving the "is `sanitizeWo` wired into `fillWo`" check can fail; the
  no-auto-create and no-egress source guards; exactly one `.click()` and it is on the hidden file
  input; both OLE maps null-prototype; and every extractor degrading to blank fields on
  anchor-missing, truncated, entity-laden and empty documents.

`bwn-wo-intake.user.js:455` still contains one U+2014, inside a regex character class (hyphen,
en-dash, em-dash) that parses client subject lines. Matching an em-dash in third-party input is not
authoring one, so it stays - expect an em-dash scan of that file to report 1 and be correct.

### Verify task 2
```bash
for f in scripts/test-*intake*.js scripts/test-intake-guards.js; do "$NODE" "$f" | tail -1; done
"$NODE" scripts/test-error-reporter.js       # 35/35 - SHA-gated reportFail shim untouched
"$NODE" scripts/test-shared-block-ledger.js  # 81/81 - this file must carry no token picker
# residual PII scan: expect 0 everywhere
for f in scripts/test-*intake*.js scripts/test-intake-guards.js; do
  grep -oE '\b[0-9]{3}[-. ][0-9]{3}[-. ][0-9]{4}\b' "$f" | grep -vc 555
done
```

## Open owner decisions

Surfaced, deliberately not actioned. The first two are live risks in code this branch does not touch.

1. **Automatic document upload with no confirmation.** `bwn-drop-upload.user.js:2397` calls
   `runApiUpload(...)` unconditionally on the intake handoff, uploading the raw client email and
   every attachment to Umbrava Documents labelled "Work Order Request". The manual drop path stops
   at a review box (`:2320`); the handoff does not. It matches the target WO on a path heuristic
   (`bwn-wo-intake.user.js:1349`) with **no WO-number assertion**, so create-then-navigate-elsewhere
   can attach a client email to the wrong work order. "No auto-create" holds for the work order; it
   does not hold for the document.
2. **Unbounded retention of raw client email.** Files are stashed in IndexedDB on the Create click
   (`:1329`); the 3-minute TTL and the delete both live inside `maybeConsumePending()`, which only
   runs on a `/work-orders/N` path (`:1344`). Close the tab and the record persists. Fix is a
   boot-time TTL sweep.
3. **Hard Rule 5, vendor-facing PII.** `bwn-bid-out.user.js:577` and `:754` push `scopeOfWork` into
   the BCC'd vendor RFP. Note the correction: bid-out reads that field back **from Umbrava**
   (`:93`), not from intake, so `sanitizeWo()` narrows one inflow but does not close the path - a
   coordinator-typed scope still reaches vendors. The guard belongs at bid-out's render and send
   boundary.
4. **Public CI logs** already printed real client email text on any past red run of the five intake
   harnesses. Sanitizing source does not purge Actions logs.
5. **Two phone-shaped strings in shipped scripts** - one each in `bwn-bid-out.user.js` and
   `bwn-dispatch.user.js`. Possibly a legitimate Broadway sender number; they ship to every install.
6. **Disclosure handling** under the Pilot / TransformCo / C&W / JLL agreements. Not a code question.
7. `expectedInstalled` in `scripts/userscript-manifest.json` is seeded `true` for all 21. Flip any
   that are not meant to be on every coordinator machine.
8. **`bwn-ask.user.js` namespace** is `https://broadwaynational.com/bwn` where the other 20 are
   `broadwaynational.bwn`. Recorded as a waiver, deliberately **not** normalized: `@namespace` is
   half of Tampermonkey's identity key, so changing it orphans every installed copy into a manual
   reinstall.

## Remaining task queue

Not started. Sequence as given by the owner.

3. **RM-C3 WO Command Center** - HIGH. Read-only docked panel unifying List Heat, Kanban, WO Assist
   and Case File into one explainable triage view. Every verdict from deterministic inspectable
   rules. Strictly read-only: no mutation buttons, no GraphQL/SWA writes, no notes, emails, vendor
   notifications, auto-escalation, or new write transport. Prove the no-mutation guarantee with a
   test. Reuse existing drawer/dock/lifecycle patterns.
4. **RM-B4 route/lifecycle helper** - HIGH, discovery plus a limited pilot. Inspect
   `rm-b2-b4-core-helpers`; inventory the ~12 scripts duplicating observers, History hooks, route
   detection and reinjection; document the helper API and init contract. Flag stays OFF. Do **not**
   migrate all 12 at once - propose phased waves and migrate at most ONE low-risk, non-financial,
   non-write-heavy pilot, only if discovery confirms it safe. Tests: initial load, SPA nav, DOM
   replacement, repeated nav, duplicate-init prevention, flag OFF and ON.
5. **RM-C1 Bulk Operations Console** - HIGH, **readiness report only**. Inspect
   `rm-c1-bulk-console`. Do not merge, do not enable `bulkConsole`, do not run a live bulk mutation.
   Note: `feat/bulk-console-converge` (13 commits, worktree `C:/Users/mnajarro/repos/_wt/bulk-console-converge`)
   already contains "converge onto Core bulkOps as the one Safe Bulk Operations Console" plus
   adversarial F1/F2/F3 fixes - the owner decision this task asks for may already be settled in
   code. Confirm before scoping.
6. **Design-system convergence** - MEDIUM, cross-repo. The SWA session owns the audit; this session
   contributes the userscript style inventory (toasts, danger variants, drawers, dialogs, focus
   patterns) when asked. Do not double-build, do not choose the palette.

## Working agreements in force

- **Plan mode first.** Per task: dispatch the repo's read-only agents for discovery, synthesize one
  discovery report plus one file-by-file plan, wait for approval, then implement in the main
  session, add targeted tests, run local checks, and stage a PR package.
- Agent dispatch is correlation-driven: always include `repo-investigator` before any edit and
  `security-governance-reviewer` for independent review, plus whichever domain specialists match.
  Agents are read-only; implementation stays in the main session.
- **Never without explicit approval:** push to `main`, merge a PR, bump a script version for
  release, flip a feature flag, run a live GraphQL mutation, SWA write, queue drain or email, or
  reveal secrets. Never add a raw GraphQL writer where `bwnGqlOp` applies. Never bypass a
  `risk:high` confirmation. When a SHA-gated shared block changes, update every required copy and
  prove byte identity with a harness.
- **Commit and push only when asked.** Descriptive `feat/*` branch per task, small commits, never
  disturb unrelated work.
- Repo `CLAUDE.md` obligation: any change to the shipped script roster (new, retired, renamed,
  folded) must update the vault wiki - `userscript-install-links.md`, `bwn-suite-userscripts.md`,
  the one-pager HTML - in the same piece of work. Neither branch changes the roster, so neither
  triggers this.
- House style: no em-dash (U+2014) in code, comments, UI or docs.
