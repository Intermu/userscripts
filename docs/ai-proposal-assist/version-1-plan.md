# BWN AI Proposal Assist - version 1 plan

## Shape

One file, `bwn-ai-proposal-assist.user.js`, at the repo root like the rest of the suite. The
original spec asked for `src/` plus `build.mjs` in broadway-internal-ops. That was dropped when the
script moved into this repo, which is no-build by design (see `ci.yml`). The pure logic sits
between the `APA-LOGIC START/END` markers so `scripts/test-ai-proposal-assist.js` can slice it and
run it, the same way the other harnesses work.

- `@match https://app.umbrava.com/*`, `@grant none`, no `@connect`, `@run-at document-start`.
  `@grant none` is required so the tap sees the page's own `fetch` (the bwn-kanban 0.3.0 lesson).
- Persistence uses localStorage (settings, templates, activity log) and sessionStorage (per-quote
  context). No GM storage, because `@grant none`.
- Duplicate init: `window.__bwnApaInit` stamp. A second copy logs a warning and stands down.

## Features (all off until ticked in the panel)

| # | Route | What it does | Writes to the page? |
|---|---|---|---|
| 1 | vendor proposal details | Pre-flight: reads the grid by header text and shows the flag list plus a recommended-lines table | No |
| 2 | AI preview | Prompt builder: fields, then the fixed template, then a live counter (warn at 950, hard stop over 1,000). Copy (clipboard on click), Insert (native setter + `input` event on click, never presses Generate). Saved client templates, with Pilot Travel Centers first | Only Insert, only on a click |
| 3 | AI preview | Checker: passive tap on `GenerateAIProposalPreview` / `ReworkAIProposal` responses. Shows pass/fail, the server's `validationErrors` text, and the AI reasoning (collapsible) | No |

The panel appears only on those two routes. A deny-list (auth, account, company, admin, users,
permissions) is checked first, on init and on every pushState/replaceState/popstate. On other
routes the panel is removed and the observer disconnected. The tap stays installed but returns
straight away unless the checker is on and the route is AI preview.

If the grid headers or the Generate textarea aren't found, the panel shows "layout not recognised
— disabled" for that feature. Copy still works without the textarea.

The activity log keeps action labels and ISO timestamps only, capped at 50. It never stores
prompt text, amounts, ids or names.

## Out of scope for v1

- Revise automation. Field testing showed Revise rewrites the whole scope and ignores "do not
  change".
- Any API call of its own, any read of auth headers, any grid edit, any save/submit/approve.
- A Core dock row. The panel is self-contained, so no Core release is needed (see the
  `new-dock-row-needs-core-update` memory). Fold it into the dock later if it graduates.

## Rollout

1. Merge to main. `expectedInstalled: false` in `scripts/userscript-manifest.json` until the pilot.
2. Live-verify the inferred items in `discovery-notes.md` on one real quote (see `test-plan.md`).
3. Once it's on main, add the row to the vault roster (`wiki/userscript-install-links.md`, the
   suite hub and the one-pager), per CLAUDE.md. A branch doesn't count as shipped.
4. Pilot with the coordinator team, then flip `expectedInstalled` to true.
