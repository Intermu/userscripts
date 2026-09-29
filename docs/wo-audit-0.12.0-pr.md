# WO Audit 0.12.0 - evidence-grounded operational notes

PR-ready package for branch `feat/wo-audit-note-overhaul`. **Not merged, not deployed, no notes
posted.** Everything below is node-harness evidence; the live gate in section 7 is still owed and
must be run by a human.

---

## 1. What changed and why

The standard audit note read as a generic AI summary. A real 0.11.0 note from the 09/17 workbook:

> The work order is currently pending vendor proposal as we await completion and receipt of the
> survey details. Follow-ups have been made to prompt the vendor for an update to proceed. No
> scheduling has been confirmed yet.

It names no stage, no blocker, no owner and no ECD, so an operations manager scanning the audit
learns nothing actionable. 0.12.0 adds a deterministic operational-state layer that runs **before**
any AI call, so the model phrases facts instead of inferring them.

The same fixture under 0.12.0:

> Materials pending - parts on backorder (Materials) - 9/13: Parts are on backorder, supplier lead
> time quoted through 9/29. - Vendor to confirm the delivery date and schedule the return visit on
> receipt - ECD 10/2

Note the ECD is `10/2`, from the work order's own field - **not** the `9/29` delivery date sitting
in the note. An arrival or delivery date is never a completion commitment.

---

## 2. Commits

| Hash | Subject |
|---|---|
| `3f7e20b` | `feat(wo-audit): evidence-grounded operational notes + deterministic fallback (0.12.0)` |
| `55d1f38` | `fix(wo-audit): four defects found by adversarial review of 0.12.0` |
| *(this commit)* | `docs: bound filesystem searches + PR package for 0.12.0` - the safeguard and this document. Deliberately not self-referenced by hash: a doc that names its own commit goes stale on any amend or rebase. |

`git diff main...HEAD --stat`:

```
 .github/workflows/ci.yml            |  11 +
 CLAUDE.md                           |  27 ++
 bwn-wo-audit.user.js                | 580 +++++++++++++++++++++++++++++++++---
 docs/wo-audit-0.12.0-pr.md          | 361 ++++++++++++++++++++++
 scripts/test-bwn-ai-phase3.js       |  11 +-
 scripts/test-wo-audit-accounting.js |  29 +-
 scripts/test-wo-audit-state.js      | 412 +++++++++++++++++++++++
 7 files changed, 1384 insertions(+), 47 deletions(-)
```

Production code is one file: `bwn-wo-audit.user.js`. Everything else is tests, CI wiring, the
standing-instruction safeguard, and this document.

`@version` / `VER` bumped `0.11.0` -> `0.12.0`. An unbumped push reaches nobody through
Tampermonkey.

---

## 3. New functions

All pure, all in a new sliced block `// ===== BWN WO-AUDIT STATE =====`, all driven by the harness
against the real shipped bytes.

| Function | Responsibility |
|---|---|
| `deriveState(h, notes, nowMs)` | The normalized fact set. Injected clock. Stage is a **table lookup** on live `statusName` via Core's measured ~50-status `WO_PHASE` map. Never throws, never returns null, always carries at least one evidence row. |
| `composeAuditStatusNote(facts)` | The deterministic note. Omits unsupported clauses rather than inventing them; always states the stage and always ends `ECD <M/D>` or `ECD TBD`. |
| `validateAiNote(note, facts, ground)` | Strict output gate. Rejects empty, too-short, vague-filler, non-ECD-terminated output; rejects any date absent from the evidence; **pins the printed ECD to the derived one**. |
| `ungroundedDates(text, ground)` | Shared date gate, used by the standard note **and** the over-30 chain that actually gets posted. |
| `fallbackChain(facts)` | Deterministic stand-in for the model's event chain, so an AI-less over-30 row keeps the house format. |
| `meaningfulNotes(notes, nowMs)` | Evidence filter: drops sub-12-char bodies, anything bearing a `[bwn:*]` marker, and notes dated after the audit clock. |

`WO_PHASE`, `ACT_NEG`/`actAffirm` and the hyphen-range strip are **copied** from
`bwn-suite-core.user.js`, not imported - GM sandboxes cannot share a runtime object across the
`@grant` boundary, the same reason `bwnFocusTrap` is duplicated in every drawer module.

---

## 4. How the pieces flow

```
woFetch(number)
  |-- HEADER_Q  (pinned WorkOrderFields, best-effort, null on error)
  |-- NOTES_Q   jobNotes(workOrderNumber:$n)   <- unchanged, keyed by WO NUMBER
  v
computeFlags(h, notes, now) --> WRITTEN TO THE SHEET IMMEDIATELY
  (deterministic, no AI: the exception audit survives an AI outage)
  v
deriveState(h, notes, now) --> facts {stage, blocker, owner, event, next, ecd, confidence, evidence}
  v
  +-- grounds buildAuditInput / buildTimelineInput (facts block prepended/appended)
  +-- backs validateAiNote  (the ECD and every date are checked against it)
  +-- IS the fallback note   (composeAuditStatusNote / fallbackChain)
  v
AI phrases the facts
  v
validateAiNote / ungroundedDates
  |-- pass  -> ship the model's line
  |-- fail  -> ship the deterministic note, mark the row `degraded`
  v
sheet cell written  ->  UI card (stage/blocker/owner chip + degraded badge)  ->  human clicks Post
```

The audit never depends on the AI for a usable note. Flags, live data, the deterministic note and
the downloadable workbook all survive a total provider outage.

---

## 5. Compatibility exception - the Over 30 tails (DECIDED: preserve unchanged)

**The three established Over 30 tail formats are preserved byte-identical for this release.** The
mandatory `ECD <date>` / `ECD TBD` terminal-token requirement applies to the **new standard
audit-note formatter only**.

Why: acceptance criterion 4 ("every generated note ends with `ECD <supported date>` or `ECD TBD`")
conflicts with functional requirement 1 ("maintain the existing deterministic
`Over 30 - <trade> ... - ECD <date>` convention **if that is the established current output**").
It is established. Measured directly from `WO Audit 09.17.26.xlsm-audited.xlsx`, all 108 Over-30
notes in column H end in exactly the three tails `composeTimelineNote` already emits:

| Tail | Occurrences |
|---|---|
| ` - ECD <M/D>` | 63 |
| ` - ECD <M/D> PAST - awaiting new ECD` | 44 |
| ` - ECD not set - needs ECD` | 1 |
| anything else | **0** |

Zero em dashes anywhere in the column; the separator is a plain hyphen with spaces.

Consequences of this decision:

- `composeTimelineNote` is untouched, and **no pinned assertion in `test-wo-audit-timeline.js`
  changed** (26/26 still green, including all three tail forms).
- The standard note reaches the same goal differently: a lapsed ECD renders `ECD TBD` with the
  lapse stated *before* the token, e.g. `... Vendor to report completion; prior ECD 9/1 lapsed,
  Coordinator to reset it - ECD TBD`. No information the old tail carried is lost.
- A degraded (AI-less) over-30 row still goes through `composeTimelineNote`, so it cannot become a
  fourth note shape the workbook has never carried.

**If the terminal-token rule should instead apply to Over-30 too, that is a deliberate follow-up:**
two assertions in `test-wo-audit-timeline.js` would change, and 44+ production notes would gain a
new shape. Not done here without an explicit call.

---

## 6. Verification

### 6.1 Commands and results

Node is the Adobe-bundled runtime; this repo has no npm and no local CI path.

```bash
N="/c/Program Files/Adobe/Adobe Creative Cloud Experience/libs/node.exe"

# syntax gate, every userscript
for f in *.user.js; do "$N" --check "$f"; done
# -> clean, no output

# every harness CI invokes (105 total)
sed -n 's/.*run: node \(scripts\/[^ ]*\).*/\1/p' .github/workflows/ci.yml | sort -u \
  | while read t; do "$N" "$t"; done
# -> passed=104 failed=1
```

| Harness | Result |
|---|---|
| `test-wo-audit-state.js` (new) | **126/126** |
| `test-wo-audit-timeline.js` | 26/26 (three shipped tails unchanged) |
| `test-wo-audit-flags.js` | 48/48 |
| `test-wo-audit-post.js` | 45/45 |
| `test-wo-audit-accounting.js` | 57/57 |
| `test-wo-audit-retry-floor.js` | 40/40 |
| `test-bwn-ai-phase3.js` | 72/72 |
| `test-bwn-ops.js` | 126/126 |
| `test-shared-block-ledger.js` | 84/84 |
| `test-perm-block-ledger.js` | 86/86 |
| **Total** | **104 of 105 harnesses pass** |

### 6.2 The one failure is PRE-EXISTING on clean main

`scripts/test-field-map-conformance.js` fails:

> `FAIL- mirror content matches the SWA canonical field-map.json (EOL-normalized)`
> `[the two copies have drifted - re-copy the canonical]`

Confirmed pre-existing, not caused by this branch:

```bash
git worktree add /c/Users/mnajarro/repos/_wt/_baseline-check --detach main
cd /c/Users/mnajarro/repos/_wt/_baseline-check
"$N" scripts/test-field-map-conformance.js
# -> 39/40 assertions passed, 1 FAILED   (identical failure, clean main, zero local changes)
```

This branch does not touch `scripts/field-map.json`:

```bash
git diff main...HEAD --name-only | grep -i field-map   # -> no match
```

It is a cross-repo drift against the SWA canonical copy and is **out of scope here** - left alone
deliberately rather than folded into an unrelated PR.

---

## 7. Safety review: findings and resolutions

An independent read-only reviewer was run fresh against the first commit. It returned
**approve with changes**: four blocking defects, all introduced by that commit, all reaching
output. Each was reproduced before fixing.

| # | Severity | Finding | Resolution |
|---|---|---|---|
| B1 | HIGH | A full AI outage read as a clean run. The row worker catches every AI rejection to write the deterministic note, so `.error` was never set and `tal.errs` stayed 0: the credits/throttle/auth guidance never printed, **Retry Unfinished stayed hidden**, and the workbook downloaded with no INCOMPLETE warning. Exactly the 2026-08-18 credit-exhaustion scenario the accounting layer exists for. | Degraded rows are counted, logged, folded into the causes ladder (`rr.error \|\| rr.degraded`) and included in the retry-button gate. Pinned by 4 new accounting assertions. |
| B2 | HIGH | The new "strip an echoed ECD" guard was greedy to end of string. `"received 7/1 - ECD 8/15 committed - 8/20 no-show - 9/2 awaiting reschedule"` became `"received 7/1"` - three of four dated segments deleted from the note a coordinator then posts. **Worse than main**, which had no strip. | Anchored to a genuine trailing `- ECD <date\|TBD\|not set>` tail. Pinned against the exact chain that regressed. |
| B3 | HIGH | `validateAiNote` checked only that a printed date appeared *somewhere* in the evidence, never that the printed ECD was the derived one - so a parts-delivery or appointment date could be lifted and printed as a completion commitment, passing the gate. The precise invention this overhaul claims to prevent. | The printed ECD is pinned to `facts.ecdText`. The derived ECD is always allowed; anything else is rejected by name. |
| B4 | HIGH | `WOA_ACCESS` kept bare `badge`, `site contact`, `access window`, `escort required` alternatives and is matched raw (no negation veto), so "Replaced the badge reader", "Site contact is Bob", "Access window confirmed for Monday" and "Escort required - handled, no delay" all produced a site-access blocker owned by Scheduling/Access. **Five of nine realistic notes inverted.** | Reduced to phrases that encode a failure to get in. Pinned by a nine-note corpus - benign notes must not fire, real failures must. |

Non-blocking items also addressed:

- **N5 / N4** - the over-30 path (the one that actually gets **posted**) had no output gate at all,
  while the gated path was the one that never gets posted. It now shares the date-grounding check
  and falls back through `composeTimelineNote`, keeping the house format.
- **N3** - the deterministic note pasted a note body verbatim into the downloaded workbook,
  including money and margin talk that `buildAuditInput` deliberately withholds from the AI note.
  Amounts and GP phrases are now redacted (`$4,200` -> `[amount]`).
- **N2** - `WOA_VAGUE` gained "monitoring this closely" / "no update available".

The reviewer also mutation-tested the new harness: 9 of 10 mutants killed. The survivor, **M10**,
exposed a genuinely vacuous assertion - the only low-confidence fixture had no blocker, so deleting
the "low confidence suppresses an inferred blocker" guard changed nothing. That gap is now closed
with a fixture carrying a blocker, plus its `blockerCertain` counterpart.

Accepted, not fixed (recorded deliberately):

- **N1** - the date gate is slash-only, so `9-30` / `Sept 30` / `2026-11-15` bypass it. The human
  click before posting caps the blast radius. Widening the *used*-side tokenizer is a clean
  follow-up.
- **N6** - `WOA_NTE` can read a client-side scope change as an internal approval gate.
- **N7** - a row the model can never satisfy stays in `pendingRows` indefinitely; a human decides
  whether to press Retry again.

---

## 8. Invariants verified NOT weakened

| Invariant | Evidence |
|---|---|
| `jobNotes(workOrderNumber:$n)`, keyed by WO number | `NOTES_Q` unchanged, no diff hunk |
| `computeFlags` pure, deterministic, injected clock | unchanged; `test-wo-audit-flags.js` 48/48 |
| Flags written to the sheet **before** any AI call | worker order preserved; flags survive an outage |
| SheetJS preserves unrelated cells and formulas | only the same two cells per row are written |
| Internal-only posting, `noteTypeId('internal')` floor 13 | unchanged |
| One explicit human click per note, **no "post all"** | per-card button only; no aggregate handler exists |
| Age gate strictly `> 30` | `postEligible` unchanged; boundary asserted |
| `[bwn:wo-audit]` idempotency | marker embed + `hasPriorAuditNote` unchanged; the new evidence filter excludes markers from *evidence only* |
| `bwnGqlOp` / BWN-PERM / BWN-OPS-WRAP / kill switch / audit trail | untouched; ledgers 126/126, 84/84, 86/86 |
| Retry / throttle / `Retry-After` / non-retryable / `INSUFFICIENT_CREDITS` | zero diff hunks; 40/40 |
| The three Over 30 tails | byte-identical; 26/26 |
| Posted text == operator-seen text | both `r.note`; textarea is `readOnly` |
| No secrets added | none in the diff |

---

## 9. MANUAL live smoke test - REQUIRED before merge

Cannot be automated: it needs a live Umbrava session and a real work order. Run in order; stop and
report on any surprise.

### a. Small batch comparison against 0.11.0

1. Pick a workbook of **10-15 rows** with a mix of over-30 and under-30 ages. Keep an untouched
   copy of the file.
2. Run the batch on 0.11.0 (current installed version), download, and keep that output.
3. Install 0.12.0, run the **same** file, download.
4. Diff the notes column side by side. Expected:
   - every over-30 note still opens `Over 30 - <trade>` and ends in one of the **three** shipped
     tails - if a fourth shape appears, stop;
   - over-30 chains are **not shorter** than 0.11.0's (B2 was exactly this regression);
   - standard notes now name a stage, a blocker + owner where evidenced, and end `ECD <date>`
     or `ECD TBD`;
   - the Audit Flags column is unchanged between versions.
5. Spot-check 3 rows against the live work order in Umbrava: is the stated blocker real? Is the
   owner right? Is the ECD the WO's own expected-completion date, and **not** a delivery or
   appointment date lifted from a note?

### b. Forced AI-outage fallback

1. Set a deliberately bad SWA ingest key (Tampermonkey menu).
2. Run a small batch.
3. Expected:
   - every row still gets a note in the sheet, and the Audit Flags column is still populated;
   - each card shows the amber **"Deterministic note (no AI phrasing): ..."** badge;
   - the log prints `N rows fell back to the deterministic audit note ...`;
   - the **Retry Unfinished button is visible** (this is B1 - if it is hidden, stop);
   - the run summary names the real cause, not a key/role red herring.
4. Restore the key, press Retry Unfinished, confirm those rows re-draft with AI phrasing and the
   degraded badge clears.

### c. One manually approved Internal post to a >30-day work order

1. Choose **one** work order aged **>30 days** with no prior audit note.
2. Read the drafted note in the card before clicking. Confirm it does not assert anything the WO
   does not support - especially a date.
3. Click **Post** on that single row. Do not post any other row.
4. In Umbrava, verify:
   - the note is **Internal**, not client-visible;
   - the body matches the textarea text exactly;
   - the `[bwn:wo-audit]` marker is present at the end.

### d. Idempotency

1. Re-run the same workbook without changing anything.
2. The work order posted in (c) must come back showing **"already has a WO-audit note - skipped"**
   with **no Post button**.
3. Confirm no second note was created in Umbrava.

### e. Workbook formula / cell preservation

1. Use a workbook that has **formulas**, conditional formatting and extra sheets.
2. Run a batch and download.
3. Verify:
   - formulas in untouched columns still evaluate (not flattened to values);
   - other sheets, column widths and formatting survive;
   - only the **Notes** and **Audit Flags** cells for audited rows changed;
   - a row that errored or was skipped is **not** silently left holding last cycle's text without
     the INCOMPLETE warning naming it.

---

## 10. Assumptions a human must confirm

1. **`WOA_PHASE` status names** are copied from Core and not re-measured against this tenant today.
   An unmapped status degrades safely - quoted verbatim, confidence low, no guessed stage - so a
   miss is quiet rather than wrong. Worth a pass against the live status list.
2. **Owner labels** `Materials`, `PO/Approval`, `Scheduling/Access` are vocabulary invented for this
   note format, not Umbrava roles. Confirm ops reads them the way they are meant.
3. **`WOA_ACCESS` and `WOA_NTE` vocabulary** is not corpus-validated. B4 tightened access after
   measured false positives; `WOA_NTE` (N6) can still over-fire on client-side scope changes.
4. **Note evidence widened 2 -> 5 notes** per row in the prompt. More internal note text leaves the
   browser for the SWA/Anthropic per work order - intentional and bounded, but a real change.
5. **The 108-of-108 workbook measurement** in section 5 was taken from
   `C:\Users\mnajarro\Downloads\WO Audit 09.17.26.xlsm-audited.xlsx`. That file is not checked in,
   so the figure is not reproducible from the repo alone.
6. **`computeFlags`' `STALE`** still counts raw notes while the state layer counts *meaningful*
   ones, so the Flags column and the note can legitimately disagree on staleness for the same row.
   Left deliberately so no existing flags assertion churns.

---

## 11. Deployment

This repo has **no local node CI path**; it deploys by PR plus green CI, and the PR is
**PR-protected on `main`**. Sequence:

1. Push `feat/wo-audit-note-overhaul`, open the PR, wait for green CI.
2. Run the section 9 smoke test against the branch build.
3. Merge only after (a)-(e) pass.
4. After merge, coordinators must **reinstall** the script - Tampermonkey serves `@version` off
   `origin/main`, and the bump to `0.12.0` is what makes the update visible at all.
5. Roster note: this is a **version bump to an existing script**, not a new/retired/renamed one, so
   the vault roster trigger in `CLAUDE.md` does not fire. The version column in
   `wiki/userscript-install-links.md` should still be refreshed from `origin/main` after merge.
