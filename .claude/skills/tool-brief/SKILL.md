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
git show origin/main:<file> | grep -m1 @version      # shipped version (the raw URL serves only origin/main)
grep -m1 @version <file>                               # working-tree version, which may be ahead
git status --short <file>; git log --oneline -8 -- <file>
git branch -a | grep -i <topic>                        # in-flight work that overlaps
ls scripts/ | grep -i <topic>                          # its tests
grep -n <file> scripts/userscript-manifest.json
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
| Data / API constraints | every query/mutation name and why each one exists, required args (e.g. `sortBy`), localStorage keys and their quirks, BWN_OPS registration, and that Umbrava's server is the real authorization boundary |
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

1. One-line context: repo, target file.
2. `## Tool brief`: location, version, user, workflow, objects, UI surface.
3. `## Known pain points`: numbered.
4. `## Non-negotiable behavior (do NOT change)`
5. `## Data / API constraints`, which always includes: every new op registered in BWN_OPS with a risk class; captured
   query text only, never invented fields; Test + Lint required on `main`; the ui-contract ledger stays green.
6. `## Risk level`
7. `## Desired outcome`: the user's goal if given. Otherwise `[FILL IN]` + the candidates + "if unfilled, propose
   options with effort/risk and STOP to ask".
8. `## How to work`, always these steps:
   1. Read the target file, its tests, and repo `CLAUDE.md` in full; check branches/PRs for overlap.
   2. Present a short plan (files, ops, how each non-negotiable is kept) and wait for approval.
   3. Smallest change that works; keep pure logic inside the SLICE markers; extend the tests.
   4. Bump `@version` (minor = feature, patch = fix) and sync the version-bearing vault docs per `CLAUDE.md`.
   5. Run the tests; open a PR on a `claude/<short>-<topic>` branch; do not merge.
   6. Report changes, test results, and what could not be verified live (Tampermonkey is not drivable from browser tools).

Close with one line naming any field left `[FILL IN]`. Write nothing to disk unless asked. If the user asks for a
shareable page, publish it as an Artifact.
