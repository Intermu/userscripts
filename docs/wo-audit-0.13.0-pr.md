# WO Audit 0.13.0 - evidence integrity, claim validation, key safety, status coverage

PR-ready package for branch `claude/wo-audit-quality`. **Not merged, not pushed, not deployed, no
notes posted to Umbrava.** Everything below is node-harness evidence; the live gate in section 8 is
owed and must be run by a human.

Base: `origin/main` @ `04d8f37`. Built in an isolated worktree so the primary checkout was not
touched ([[two-sessions-one-working-tree]]).

---

## 1. The defect that mattered most: the tool was laundering its own output

`deriveState` has filtered `[bwn:*]` notes out of its evidence since 0.12.0. The **AI prompts never
did** - `summarize` and `summarizeTimeline` were handed the raw `data.notes`. So a note this tool
posted last cycle went back to the model as source evidence.

It compounded: `ungroundedDates(chain, prompt)` grounds the model's output against **that same
prompt**. A date this tool invented last cycle therefore validated as an evidenced fact this cycle,
and could then be posted onto the work order as one.

0.13.0 builds both prompts from `meaningfulNotes(data.notes, now)` - the same filtered list
`deriveState` already used. `hasPriorAuditNote` still reads the **raw** notes, so posting
idempotency is untouched.

Pinned by `test-wo-audit-evidence.js` section 9, which asserts both directions: the filtered
evidence refuses the laundered date, and the *unfiltered* history would have accepted it. The
second half is the control that proves the fix is load-bearing rather than cosmetic.

## 2. The posted path had the weakest gate

Only over-30 rows can be posted to a work order, and that path ran **only** `ungroundedDates`. No
vague-filler check, no claim check. The full `validateAiNote` rules applied only to the note that
never leaves the workbook.

`validateTimelineChain` now applies the same gate to the chain - dates, vague filler and every claim
rule - minus the ECD clause, because `composeTimelineNote` owns that end and the model is told not
to write one. A rejected chain still ships through the identical wrapper, so the house format and
the three ECD tails are unchanged either way.

## 3. Three date formats walked past the date gate

`woaDateTokens` is slash-only, so `ECD 2026-11-30` and `by Nov 30` were invisible to the one check
that exists to catch an invented commitment.

`woaGroundTokens` is a **new, separate** tokenizer used only for grounding. It normalizes slash, ISO
and month-name forms to one `M/D` family and is applied to **both** sides, so widening it cannot
invent a date - only refuse one the evidence does not carry.

`woaDateTokens` is deliberately unchanged. It feeds ECD *derivation*, and widening that would start
lifting ISO and month-name strings out of note prose as completion commitments - exactly the
invention the no-ECD-invention contract exists to stop.

**A bare hyphen pair is deliberately NOT a token**, and that is a measured decision rather than a
guess. Of the 282 notes in the shipped `WO Audit 09.18.26` workbook, 26 carried a date-shaped bare
pair and **not one was a date** - each was either spillover between two slash dates (`5/4-5/5` →
`4-5`, with both real dates already tokenized correctly by the slash pass) or a lead time (`3-4
months`, `4-6 weeks`). Tokenizing them would let `4-6 weeks` in the evidence **ground** an invented
`4/6` in the output, which is the dangerous direction. The bypass this was meant to close is shut
anyway: `validateAiNote`'s tail rule accepts only `ECD <M>/<D>` or `ECD TBD`, so `ECD 9-30` is
rejected before grounding is consulted. Pinned both ways in the harness.

Month names must be real month spellings for the same reason: a permissive `/(dec)[a-z]*\s+\d/` read
`declined 4` and `decline 8` in that workbook as December dates - phantom tokens that could have
grounded an invented `12/4`.

## 4. The claim gate

`WOA_CLAIM_RULES` is a table. Each row is `{id, claim, allow, reason}`: `claim` is what the line
asserts, `allow` is what the evidence (the note history shown to the model, plus the derived facts)
must show for that assertion to be legitimate. Nine rules: completion, approval, financial
(NTE/DNE/PO/pricing), operational (scheduling/dispatch/on-site/vendor assignment), client contact,
blame, ownership, internal wording, and contradiction of a terminal status.

Three design points worth reviewing:

- **Clause splitting.** `woaClauses` splits note prose on sentence punctuation. An audit *line* has
  no full stops - it joins segments with `" - "` - so one `not` anywhere in it would veto every check
  on the line. `woaClaimMatch` adds the `" - "` separator so each segment is judged on its own
  polarity.
- **Directives are not claims.** The operational rule matches assertive forms only. `Vendor to
  confirm an on-site date` is the deterministic next action; matching it would make the gate reject
  the very fallback note it exists to protect.
- **Ownership.** Coordinator is always allowed (assigning internal chase work is not blame - the same
  reading the stale-note rule already relies on). Any other party must be named by the derived facts,
  by their prose, or by the evidence. Where the facts establish no ownership at all, the rule has
  nothing to contradict and does not fire.

Section 5 of the new harness sweeps **every** stage in `WOA_PHASE` and asserts the deterministic
fallback note passes `validateAiNote` - with and without a note behind it. A gate that rejects the
fallback would leave a row with nothing usable.

Both system prompts now state these rules, so the model is told the rule rather than merely failed
by it.

## 5. A compound work-order key silently read someone else's job

`woFetch` stripped every non-digit: `386564-2` became `3865642`, `386564/386565` became
`386564386565`. Both are plausible work-order numbers, and the audit would have gone and read them
with nothing on screen saying so.

`woaNormalizeKey` refuses anything carrying more than one candidate number, rather than guessing, and
returns a `matchConfidence`. Decoration the house actually uses (`W-`, `W`, `#`, whitespace, an Excel
`.0` round-trip) still reads `high`; one number plus stray text reads `medium` and is still fetched;
more than one number is `low` and is **not fetched at all**. The row errors with a reason naming the
cell.

## 6. Header-miss retention

A failed header read used to write `Live work-order header unavailable - Coordinator to re-run the
audit ... - ECD TBD` over the client-facing Notes cell - a statement about the tool, destroying
whatever the coordinator had there.

When the header read fails **and** there are no usable non-`[bwn:*]` notes, the row now retains the
workbook's existing note byte for byte: nothing is written, `noteMode: 'retained'`, `changed: false`,
`reviewRequired: true`, with a reason, and the row is surfaced in the run summary and on its card.
It is **not** counted as an error or a skip - the row was audited, nothing could be said truthfully,
and the original was deliberately kept. `auditTally` is untouched.

Where a header miss leaves usable notes, the row proceeds through the normal derivation and
validation path and is marked review-required. The two header-miss strings in `deriveState` were
reworded to be client-neutral (`Current status unavailable`, `Coordinator to confirm the current work
order status and record it on the work order`) because that clause can reach the Notes column and the
old wording named this tool's internals. This changed one existing assertion - see section 7.

## 7. Status coverage, the structured row result, and the UI

- **`statusCoverage(results)`** is read-only and pure. It records every raw `statusName` the run met,
  normalizes only for comparison, and lists the ones `WOA_PHASE` does not carry. It never edits the
  table, never maps an unknown status to a stage, and issues no extra requests - every name came from
  a header the run had already read. Unknown statuses still degrade exactly as before (raw status
  printed verbatim, low confidence, no blocker, no owner).
- **Row result** gains `correlationId`, `rowIndex`, `fetchStatus`, `matchConfidence`,
  `sourceStatusName`, `sourcePhase`, `flags`, `noteMode`, `priorNote`, `proposedNote`, `finalNote`,
  `noteValidation`, `reviewRequired`, `reviewReasons`, `postEligible`, `postIneligibleReason`,
  `changed`, `evidenceCount`, `error`. Purely additive: `auditTally` still reads `.error` only and
  `pendingRows` still reads `.error`/`.degraded`.
- **Per-row diagnostics are NOT written to `bwn:audit`**, by decision. That ring buffer is the shared
  cross-script *write* trail; per-row audit diagnostics would flood it and bury real writes.
  Diagnostics live in the UI, the log, and a **Copy diagnostics** button (unmapped statuses +
  review-required rows with reasons).
- **Post cards** now show note mode, whether the cell changed, the source status, match confidence,
  the deterministic flags, review reasons, and - in one ordered answer - whether the note can be
  posted and why not. Display only: `bwnGqlOp` remains the enforcement point. Retained and
  review-required rows appear on the list instead of being dropped for having no drafted note.
- **SheetJS fidelity** is stated in the mapping panel rather than left implicit.

## 8. Quoted-email furniture was reaching the client (found in the real workbook)

Measured on the shipped `WO Audit 09.18.26` run, 282 notes:

| | before |
|---|---:|
| notes carrying quoted-email furniture | **64 (22.7%)** |
| `From:` header content | 62 (22.0%) |
| `Sent:` / `To:` / `Subject:` | 49 (17.4%) |
| `-----Original Message-----` | 1 |
| **notes carrying a raw email address** | **32 (11.3%)** |
| distinct addresses that shipped | **28** |
| share of the note eaten by the paste | median 62%, max 92% |

The addresses included client contacts (`aleisha.bryant@pilottravelcenters.com`,
`Jennifer.Ball@`, `Tiffany.Green@`, `tonia.paz@`), vendor addresses, internal
`@broadwaynational.com` addresses and `app@umbrava.com`. This is a client-facing column.

It is not an AI failure: the text arrives through `deriveState`'s deterministic event clause, so no
prompt or validation change touches it.

`woaStripQuotedEmail` cuts the note at the first quoted-email boundary, removes any remaining
address, and tidies only what the removal can leave behind. The boundary set is deliberately narrow:
`From:`/`Sent:`/`To:`/`Subject:`/`Cc:`/`Bcc:` are matched **case-sensitively and only with the
colon**, so ordinary prose ("awaiting update from vendor", "findings from the technician", and the
measured "Email attempted to be sent: -Type: ...") is never a boundary, while the real headers -
always capitalized, sometimes dash-prefixed as `-From:` - always are. `Original Message` must appear
in words; a run of hyphens alone is not a marker. Addresses are **removed**, never replaced with a
`[email]` marker - a redaction token in a client note is still noise.

Applied at three points, and idempotent so the overlap is free:

1. `meaningfulNotes` - after the `[bwn:*]` marker test on the **raw** body (sanitizing first could
   cut the trailing marker off and reopen the self-laundering hole) and before the length test, so a
   note that was *only* a forwarded thread correctly becomes no usable evidence.
2. `buildAuditInput` - before the 4000-char cap.
3. `buildTimelineInput` - before the 600-char cap, so the cap is spent on event history rather than
   on a header block.

Because the sanitizer runs on the source note **before** any date is read, an email header date
(`Sent: Wednesday, September 16, 2026`) cannot become source evidence and cannot reach ECD
extraction. Quoted-body filler (`STILL WORKING ON IT`, `will provide ETA asap` - the three notes that
shipped banned filler) no longer reaches the note either, because it was never generated text: it was
pasted thread.

### Measured result, `WO Audit 09.18.26`, 282 rows

| | before | after |
|---|---:|---:|
| notes with quoted-email furniture | 64 | **0** |
| `From:` header content | 62 | **0** |
| `Sent:` / `To:` / `Subject:` header content | 49 | **0** |
| `-----Original Message-----` | 1 | **0** |
| notes with a raw email address | 32 | **0** |
| distinct raw addresses | 28 | **0** |
| meaningful pre-boundary content preserved | - | **64/64** |
| sanitized to nothing | - | **0** |

No final client-facing Note contains a raw email address. Regression checks in the same pass are
unchanged: `WOA_PHASE` 28 observed statuses / 0 unmapped, over-30 tails 104/104, non-over-30 ECD
clauses 178/178. **No hard-contract expectation changed for D3.**

### Intentional limitations of D3

These are deliberate for 0.13.0 and should not be widened without a measured corpus and separate
approval:

- **This is not a general PII redactor.** Phone numbers, street addresses and personal names in
  ordinary operational prose are untouched. Names still appear as attribution
  (`Daniel Russell: This is in fabrication now...`), which is operational content, not furniture.
- **Lower-case `from:` / `sent:` are deliberately NOT boundaries.** That is what protects the
  measured `Email attempted to be sent: -Type: ...`, which would otherwise be truncated mid-note.
  A lower-case header would survive; none exist in the corpus.
- **A recognized boundary truncates everything after it.** Content written *after* a quoted thread
  is dropped. The corpus showed zero such cases - the convention is quote-at-the-end - so
  reconstruction is not attempted in this release.
- **No email parser, no multi-thread or mid-note reconstruction.**
- **Cosmetic fragments may remain.** An address list removed from mid-sentence can leave
  `Contact:` with nothing after it. No raw address may remain, and none does.

## 9. Tests

```
node scripts/test-wo-audit-state.js         130/130   (126 before; +4 added, 1 changed)
node scripts/test-wo-audit-evidence.js      188/188   NEW
node scripts/test-wo-audit-timeline.js       26/26
node scripts/test-wo-audit-post.js           45/45
node scripts/test-wo-audit-accounting.js     57/57
node scripts/test-wo-audit-flags.js          48/48
node scripts/test-wo-audit-retry-floor.js    40/40
node scripts/test-bwn-ai-phase3.js           72/72
```

**WO Audit: 534 assertions across seven suites, all green.**

Whole-repo sweep: **108 CI-wired harnesses, 6,610 assertions, 107 green.** The single failure is
`test-field-map-conformance.js` - a pre-existing, unrelated cross-repository `field-map.json` mirror
drift. It reads `bwn-suite-core.user.js` and `scripts/field-map.json` and has **zero** matches
against the WO Audit file. It needs its own fix in the other repo.

`test-drop-upload-response-ladder.js` was flagged in an earlier sweep only because the sweep's own
`grep` matched the word inside an assertion LABEL ("a FAILED notes read is not answered"). Its real
result is **83/83 green**.

**The one changed assertion.** `null header -> says the header is unavailable` pinned the exact
string `Live work-order header unavailable`. It now pins `Current status unavailable`, for the reason
in section 6, and a new assertion was added that the null-header note carries no internal tooling
wording at all.

### Live gate - owed, human only

1. Standard high-confidence work order with supported new activity.
2. Over-30 work order with a valid ECD - tail reads `- ECD <M/D>`.
3. Over-30 work order with no ECD - tail reads `- ECD not set - needs ECD`.
4. A work order already carrying a `[bwn:wo-audit]` note: confirm it is absent from the drafted
   note's evidence and that the Post button is blocked as a duplicate.
5. Force an unsupported completion claim: confirm the deterministic fallback is written and the row
   shows as degraded with a reason.
6. Force an ISO / month-name date: confirm rejection.
7. A work order whose header read fails with no usable notes: confirm the workbook cell is unchanged.
8. A malformed or compound key cell: confirm no fetch happens and the reason names the cell.
9. A live status absent from `WOA_PHASE`: confirm it appears in Run diagnostics and copies out.
10. A `NO VENDOR` work order: confirm coordinator ownership, no vendor blame.
11. A post-ineligible row: confirm the precise reason is on the card.
12. A workbook with formulas and formatting: confirm only Notes and Audit Flags changed.

## 10. Contracts deliberately preserved

The three over-30 ECD tails byte for byte; `auditTally = { ok, errs, skipped }`; no ECD invention and
no calendar default; age and silence assign no owner; `NO VENDOR` is a coordinator gap; `[bwn:wo-audit]`
notes excluded from evidence but visible to `hasPriorAuditNote`; the `{ internal: 13 }` post floor;
one click per note with no bulk or automatic posting; the strict `> 30` age gate; all retry floors,
the Retry-After cap, non-retryable classification, row budget, concurrency, Cancel and Retry
Unfinished; every slice START/END marker line byte-identical to `origin/main`; all paste-identical
ledger blocks unchanged and their SHA gates green.
