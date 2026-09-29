---
name: tool-brief
description: >
  Fill the standard TOOL brief (name, location, version, user, workflow, objects, UI surface, pain points,
  non-negotiables, data/API constraints, desired outcome, risk) for one BWN userscript, researched from the
  repo, then turn it into a ready-to-paste work prompt for a future session. Use when the user says
  "tool brief", "fill this out for <script>", "brief the <X> userscript", "make a prompt for <X>",
  pastes the TOOL template, or invokes /tool-brief <script>.
---

# Tool brief

Input: a script name, loose is fine ("Low GP", "proposal actions", "drop upload"). Output: the filled brief,
then the work prompt built from it. Both are researched from code, never guessed.

## 1. Resolve the script

- Match the name against `ls *.user.js` in the repo root. Several match: pick the closest and say which one.
  Nothing matches: list the roster and ask.
- If the user's message names one script and pasted text names another, the user's own words win. Say so in one line.

## 2. Research (read, do not skim)

Run these, then read the whole file, not just grep hits:

```bash
git fetch origin                                       # so origin/main is current before comparing
git show origin/main:<file> | grep -m1 @version      # shipped version (the raw URL serves only origin/main)
grep -m1 @version <file>                               # working-tree version, which may be ahead
git status --short <file>; git log --oneline -8 -- <file>
git diff --stat origin/main...HEAD -- <file>           # branch drift vs main
git branch -a | grep -i <topic>                        # in-flight work that overlaps
ls scripts/ | grep -i <topic>                          # its tests
grep -n <file> scripts/userscript-manifest.json
grep -ln '<its CSS prefix / shared-block id / storage key>' *.user.js   # who else depends on it
```

Pull every field from evidence:

| Field | Where it comes from |
|---|---|
| Name | `@name` |
| Location | file path, line count, test file, raw install URL (`@downloadURL`) |
| Version / branch | origin/main `@version`; flag it if the working tree is ahead or dirty; last feature commit |
| Primary user | rank gate constant (`*_MIN_RANK`, ESC rank 1 staff .. 5 director), `@description`, who gets notified |
| Business workflow | the user journey from click to write, in plain operations terms |
| Primary objects | WO / proposal / vendor / PO / client / report, from the GraphQL ops it calls |
| UI surface | mount point + view states (modal / drawer / page / dashboard / table / export / header button / dock) |
| Known pain points | missing guards (dedupe, retry, partial failure), slow fallbacks, DOM-mount fragility, fail-closed gates that look like "missing", inlined Core copies (drift), `ponytail:` / TODO comments, related open branches |
| Non-negotiables | confirm-before-write, exact note bodies and markup, captured wire shapes (with capture dates), `bwnGqlOp` feature key, kill switch, audit, rank floor, `@grant`, egress |
| Data / API constraints | every query/mutation name and why each one exists, required args (e.g. `sortBy`), localStorage keys and their quirks, BWN_OPS registration, that Umbrava's server is the real authorization boundary, and what other scripts depend on (shared blocks, selectors, tokens, storage keys) |
| Desired outcome | **never invent it.** Leave `[FILL IN]` and list 3-4 candidates drawn from the pain points |
| Risk level | low = read-only / local UI; medium = additive production writes or notifications; high = bulk, financial, destructive, or status-changing writes. Give one line of reasoning |

Cite functions/constants by name. Never claim behavior you did not read. Anything unverifiable: say "unverified".

## 3. Output

First the brief, in one fenced block, using this exact skeleton:

```
TOOL
- Name:
- File / repository location:
- Current version / branch:
- Primary user:
- Business workflow:
- Primary objects:              (WO / proposal / vendor / PO / client / report)
- Current UI surface:           (modal / drawer / page / dashboard / table / export)
- Known pain points:
- Non-negotiable behavior:
- Data / API constraints:
- Desired outcome:
- Risk level:                   (low / medium / high)
```

Then the work prompt, in one fenced `markdown` block, with these sections in order:

1. One-line context: repo, target file, "under the BWN Operations Design System".
2. `## Source of truth (read first)`: these vault pages, as absolute paths under
   `C:\Users\mnajarro\Documents\Brain\Claude Brain\wiki\`:
   `bwn-operations-design-system.md` (principles, voice, semantic color), `bwn-design-tokens.md` (canonical
   bn-theme.css tokens, `--bwn-*` fallbacks), `bwn-ui-patterns.md` (pick the right pattern, no modal-by-reflex),
   `bwn-accessibility-baseline.md` (non-negotiable a11y floor), `bwn-modernization-workflow.md` (Phase 0-5 +
   implementation standards).
3. `## Tool brief`: location, version, user, workflow, objects, UI surface.
4. `## Known pain points`: numbered.
5. `## Non-negotiable behavior (do NOT change)`
6. `## Data / API constraints`, which always includes: every new op registered in BWN_OPS with a risk class; captured
   query text only, never invented fields; Test + Lint required on `main`; the ui-contract ledger stays green; the
   dependents found in research.
7. `## Risk level`
8. `## Desired outcome`: the user's goal if given. Otherwise `[FILL IN]` + the candidates + "if unfilled, propose
   options with effort/risk and STOP to ask".
9. `## Design and implementation rules`, always these:
   - Preserve business logic. No change to API behavior, data models, or DOM workflows unless the task asks and
     Mike approves.
   - Apply the design system selectively; use the right pattern for the task. Do not turn the tool into the same
     modal/card/dashboard as every other tool.
   - Stateful, honest UI: no fake capability, success, data, or decorative controls. Every async action shows what
     is happening, whether input is locked, whether cancel is possible, and the success/failure outcome.
   - Preserve source data, additive by default. Irreversible or high-value actions (delete / overwrite / send /
     post / bulk write) need an explicit confirm with a review summary.
   - Accessibility per the baseline: keyboard operable, focus trap + return, visible focus, `aria-live` for async,
     labeled fields, no color-alone status.
   - Userscript isolation: scoped CSS prefix, namespaced DOM and listeners, z-index ownership, inline SVG icons, no
     new dependency, SPA-safe (stale nodes, route changes), cleanup on close, no duplicate modals, no double-submit.
     (SWA target instead: consume bn-theme.css, do not paste userscript CSS; responsive; first-class
     table/filter/loading/error/empty states; real routing/state boundaries.)
   - Tokens only: no new hex, no new palette, no second token source; fallbacks map to canonical values.
10. `## How to work`, always these steps:
   1. Read the target file, its tests, and repo `CLAUDE.md` in full; trace the whole flow and every file the change
      touches; do not infer behavior from names. Check branches/PRs for overlap.
   2. `git fetch`; diff `origin/main...HEAD`; confirm the live `@version`. Report drift before building.
   3. Present a short plan (files, ops, pattern chosen, how each non-negotiable is kept) and wait for approval.
      Risk high or broad redesign: a PHASED plan, approved before broad edits.
   4. Smallest change that works; keep pure logic inside the SLICE markers; extend the tests narrowly.
   5. Bump `@version` (minor = feature, patch = fix) and sync the version-bearing vault docs per `CLAUDE.md`.
   6. Run the existing tests + preflight and prove they ran (test counts, no green-by-absence or partial run).
   7. STOP before branch creation, push, PR, merge, or deploy. Wait for Mike's instruction.
11. `## Quality gates` as a checklist, each verified and reported, none claimed done until all pass:
    desktop AND narrow viewport; long AND short data (many / one / zero rows); empty, loading, error, success,
    no-data, and access-denied states; whole flow keyboard-operable with visible focus; modal/drawer traps focus,
    Escape correct, focus returns on close; focus ring and borders legible on dark / host-page chrome;
    duplicate-submit and duplicate-modal prevented; console has no new errors/warnings; no source-data corruption,
    irreversible actions gated by confirm + summary; regression tests + preflight green and proven run;
    money/date/duration/WO-id formatting right (no cents / 60x / day-age bugs); semantic color right
    (green confirmed, amber action, red blocking, blue info, gray muted), never color alone.
12. `## Deliverable`: the change on a local working copy only, plus a report: files changed, patterns used,
    behavior preserved and explicitly UNCHANGED, gates passed, known limitations, and what could not be verified
    live (Tampermonkey is not drivable from browser tools). No push, PR, merge, or deploy until Mike says so.

Close with one line naming any field left `[FILL IN]`. Write nothing to disk unless asked. If the user asks for a
shareable page, publish it as an Artifact.
