# BWN AI Proposal Assist - test plan

Status key: **auto** = `scripts/test-ai-proposal-assist.js` in CI; **fixture** = run 2026-10-06 in
the in-app browser against a local 127.0.0.1 fixture page (fake grid, fake Generate box, stub
`/api/graphql`), not Umbrava; **live** = still to do on app.umbrava.com.

| # | Case | How | Expected | Status |
|---|---|---|---|---|
| 1 | SPA navigation | pushState from the vendor proposal page to AI preview, then to a deny-listed route, then back | Panel switches content, is removed on the denied route, comes back after | fixture PASS; live TODO |
| 2 | Missing grid | Vendor proposal route with no table | "Line grid layout not recognised — disabled." | fixture PASS; auto (null on a missing header) |
| 3 | Missing Generate box | AI route with no textarea | "layout not recognised — disabled", Insert disabled | fixture PASS; live TODO |
| 4 | 1,000-char boundary | 949 / 999 / 1,000 / 1,001 chars | no warn / warn / warn and allowed / hard stop (Copy + Insert disabled) | auto PASS; fixture PASS (1,372 blocked) |
| 5 | Generate validation error | Response with `success:false` plus `validationErrors` | Server text shown ("UserPrompt: must be 1000 characters or fewer") | auto PASS; fixture PASS; live TODO (real error shape) |
| 6 | Negative-markup detection | Line with `markUpPercent -25`, `unitCharge < unitCost` | Both flagged as fail | auto PASS (plus a negative control); fixture PASS |
| 7 | Duplicate init | Inject the script a second time | One panel, second copy inert | fixture PASS; auto (static guard) |
| 8 | Chrome | Install in Tampermonkey, run 1-6 on a real quote | Same as above | live TODO |
| 9 | Edge | Same as 8 in Edge + Tampermonkey | Same as above | live TODO |
| 10 | Wrote nothing to Umbrava | DevTools Network, filtered to `graphql`, through 1-6 | Only requests the app made itself (Generate pressed by a human). Zero extra requests, no request from the script's initiator | fixture PASS (script made 0 requests); auto (static: no own fetch/XHR, no .click(), no submit); live TODO |

## Also covered automatically

- Header-text keyed grid read (columns in reverse order).
- Every pre-flight rule.
- Recommended lines.
- Template order.
- Shipping/Disposal de-duplication.
- Travel quantity vs trips.
- Materials markup over 35%.
- Non-rate-card ranges.
- Total vs NTE.
- Problem/Solution headings.
- Verbatim lines (whitespace-insensitive).
- Materials/Equipment section.
- The tap passes the request through untouched and returns the original response.
- `@match` / `@grant` / no `@connect`.
- No polling.
- No auth or cookie read.
- The activity log stores a label and a timestamp only.

## Live run notes (to fill)

Record which inferred items in `discovery-notes.md` were confirmed or corrected, with the date.
For row 10, write an explicit line: "Confirmed: script issued no request to Umbrava."
