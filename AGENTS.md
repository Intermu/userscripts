# Agent Instructions

## Project Overview

This repo is the **BWN Ops Suite**: ten Tampermonkey userscripts that BWN service
coordinators run in the browser on top of **Umbrava** (`app.umbrava.com`), the
vendor SaaS Broadway National uses for work-order / facilities management. The
scripts bolt workflow tooling onto Umbrava's own pages (WO triage, PO approval,
AI drafting, vendor bidding, credit-card requests, document intake) without any
server-side hook into Umbrava. They are injected client-side and coordinate with
each other through browser storage and DOM events, not a shared runtime.

There is no application here to build or run. Each `*.user.js` file IS the
deliverable: a coordinator installs it in Tampermonkey and it self-updates from
GitHub. All durable knowledge lives in the long `@description` metadata blocks and
in the inline `TASK-/RISK-/PAT-/SEC-` comment tags. Read those before changing
code.

The cross-script coordination layer (storage keys, event bus, module kill
switches, the shared AI transport, invariants) is documented separately in
[docs/suite-data-contract.md](docs/suite-data-contract.md). Read it before
touching anything that crosses a script boundary.

## Script Inventory

Version is the `@version` in each file's metadata header (the source of truth for
distribution; internal `VER`/`console.info` strings sometimes lag a patch).

| Script | Ver | Purpose |
|--------|-----|---------|
| bwn-suite-core.user.js | 1.62.0 | Monolith, zero paid egress. PO Approval + ETA, WO Assist (GP/ETA watchdog + playbook), Email Leak Guard, WO List Heat + My Day, Launcher / Ops Suite panel, Saved Views, Command Palette, Visit Memory, Reminders, Notes Timeline, Trips-to-.ics. Only network is same-origin Umbrava GraphQL. |
| bwn-suite-ai.user.js | 1.41.0 | Monolith for the outside-API tools. Client Update + WO Audit drafts (Claude via the SWA), Find Techs / Find Suppliers (Google Places), Job View, Service Request augmentation, and the SWA connector. Owns the network grant and injects the shared AI transport. |
| bwn-ask.user.js | 0.4.0 | "Coordinator Copilot": ask questions about the current WO. Reads the WO live (details + note/site-visit history) plus a location-wide roster over same-origin GraphQL, answers through the SWA `/api/ask` route. |
| bwn-bid-out.user.js | 0.24.0 | Tracked email-RFP wizard launched from Umbrava's "See Who Is Available" caret. Finds net-new vendors via Google Places, scrapes/enriches emails via the SWA, sends from the coordinator's own mailbox via SWA `/api/send-bid` (Microsoft Graph) with an Outlook-draft fallback. |
| bwn-cc-auth.user.js | 0.2.0 | "BWN CC Request": replaces the CC Authorization MS Form with an in-page modal for any vouched user. POSTs to SWA `/api/cc-auth` -> Power Automate approval flow. Owns the single floating Credit Card launcher (dropdown adds Log CC Purchase for supervisors+). |
| bwn-cc-purchase.user.js | 0.6.0 | "Log CC Purchase" modal, supervisor+ only (server re-checks rank). POSTs to SWA `/api/cc-purchase` -> Power Automate -> Credit Card Tracker.xlsx + email; optional receipt upload via `/api/cc-receipt`. Has no own button; opened by CC Request over the `bwn:evt` bus. |
| bwn-drop-upload.user.js | 1.9.0 | Drop files onto a WO to upload them. Parses `.msg` (OLE/MAPI) and `.eml` (RFC822) locally into an Outlook-style note, led by an on-device AI one-line summary. Zero network, `@grant none`. |
| bwn-vendor-intake.user.js | 0.8.1 | Prefills Umbrava's Create Vendor form from a Prospect Set-Up Form or a W-9. Fillable PDFs read from form fields; scanned W-9s read by on-device OCR (Tesseract + pdf.js). Document and TIN never leave the machine. |
| bwn-wo-audit.user.js | 0.4.0 | Batch WO-audit tool. Reads each WO's two latest notes in-page over Umbrava GraphQL, asks the SWA `/api/ai` summarize route for a client-ready status line, fills and re-downloads the `.xlsx`. Replaces the retired MCP-based SWA tool. |
| bwn-wo-intake.user.js | 0.9.0 | Drop a client PO/WO email onto the Create Work Order modal to prefill fields (Pilot Travel Centers, Caleres/Corrigo). After Create, hands the email to Drop Upload to auto-attach. Local parsing, `@grant none`. |

## Tech Stance

- **Plain ES5.** `var`, function expressions, no arrow functions in shipped code,
  no classes, no modules. Each script is one top-level IIFE (`(function(){ 'use
  strict'; ... })()`). This is deliberate: broad Tampermonkey/engine
  compatibility and no transpile step.
- **No build, no bundler, no package manager for the scripts.** The `.user.js`
  files are hand-edited and shipped as-is. `scripts/` holds Node test harnesses
  only (see Tests).
- **`@grant` split by trust.** `bwn-suite-core`, `bwn-drop-upload`, and
  `bwn-wo-intake` are `@grant none` (no privileged APIs, in-page only).
  Everything that talks to an outside host declares `GM_xmlhttpRequest`,
  `GM_getValue/GM_setValue`, `GM_registerMenuCommand`, and (AI) `GM_setClipboard`.
  Core and AI run in **separate Tampermonkey scopes** and cannot share a runtime
  object; they share DATA only (see the data-contract doc).
- **`@require` CDN dependencies** (pinned versions), loaded by Tampermonkey:

  | Script | `@require` / `@resource` |
  |--------|--------------------------|
  | bwn-bid-out, bwn-wo-audit | `xlsx` 0.18.5 (cdnjs) |
  | bwn-vendor-intake | `pdfjs-dist` 3.11.174 + `tesseract.js` 6.0.1 (jsDelivr); OCR worker/core/lang as `@resource` blobs fetched once at install |

- **On-device AI first.** Summaries/labels prefer Chrome's built-in Prompt API
  (Gemini Nano): free, zero egress, no key, works under `@grant none`. The paid
  tier (Claude/Haiku behind the SWA) is rank-gated and only reachable from the
  grant-holding AI script. See the `bwnAI` transport in the data-contract doc.
- **`@match`** is `https://app.umbrava.com/*` (core also matches `*.umbrava.com/*`;
  bid-out narrows to `/work-orders/*`). Most scripts run `@run-at document-idle`,
  `@noframes`.

## Distribution

- No release process. Each file carries
  `@downloadURL` / `@updateURL` =
  `https://raw.githubusercontent.com/Intermu/userscripts/main/<file>.user.js`.
- Committing to `main` on GitHub (`Intermu/userscripts`) IS the release:
  Tampermonkey polls the raw URL and offers the update to installed clients.
  Bumping the `@version` is what triggers the client update prompt, so a
  behavior change that is not seen by users usually means the version was not
  bumped.
- Practically: edit the `.user.js`, bump `@version`, commit, push to `main`.
  Clients pick it up on their next update poll.

## Server Side: the SWA Proxy

Every outside-API call goes through **broadway-internal-ops**, an Azure Static
Web App at `https://green-stone-0717dab0f.7.azurestaticapps.net` (its Functions
back the `/api/*` routes). That server code lives in a different repo; only the
client half is here. Routes the scripts call: `/api/ai`, `/api/ask`,
`/api/cc-auth`, `/api/cc-purchase`, `/api/cc-receipt`, `/api/user-role`,
`/api/wo-ingest`, `/api/scrape-contacts`, `/api/enrich-contacts`,
`/api/vendor-prospects`, `/api/send-bid`, `/api/bid-status`, `/api/hvac-benchmark`.

Two auth layers stack:

1. **`x-bwn-key` header** gates every SWA request. The value is the connector
   ingest key, stored per user in Tampermonkey storage (`GM_getValue('ingest_key')`,
   set via a menu command) and equal to the server's `WO_INGEST_KEY`. A missing
   key means the tool reports "not configured", not a crash.
2. **Umbrava-session vouch** for privileged routes. The coordinator's live
   Umbrava Auth0 access token is sent in the request **JSON body** (never the
   `Authorization` header, which the SWA edge overwrites: SEC-002). The server
   proves the token against Umbrava's own current-user API
   (`api/shared/umbrava-auth.js`), injects the verified email (e.g. as the CC
   requester), and derives the caller's rank. Client-side rank is UX-only; the
   server re-enforces it (403 `ROLE_REQUIRED`). Known anchors: supervisor =
   rank 3 (`RANK.SUPERVISOR`), advanced-AI / managers+ = rank 4
   (`BWN_AI_ADVANCED_MIN_RANK` default). The server is the source of truth for
   the ladder.

### Why not server-side MCP

The suite deliberately **abandoned the server-side MCP approach**. An Azure
Function has no Umbrava session, and Umbrava's GraphQL rejects any call without a
live-session bearer (the old `WO_Audit_Automation.html` MCP path failed with a
400 "Authentication error"). The fix was to move the data reads and the AI tool
loop **into the page**, where they inherit the operator's own Auth0 bearer over
same-origin `/api/graphql`. That bearer never leaves the browser (SEC-001); only
scrubbed, review-first content reaches the SWA. This is the core reason
`bwn-wo-audit` and the AI drafting run in-page instead of on the server.

## Invariants (do not break these)

- **SHARED CORE v7 is paste-identical across both monoliths.** The block between
  `// ===== BWN SHARED CORE` and `// ===== END BWN SHARED CORE` (the bus, suite
  config, parsers, brand tokens, UI primitives) is byte-identical in
  `bwn-suite-core` and `bwn-suite-ai`. When you edit it, bump its internal
  `VERSION` and paste it into BOTH files. Runtime drift detection compares
  version + export list across the `bwn:corever:{script}` slots and warns in the
  console and the Ops panel.
- **`bwnAI` v1 is paste-identical across three files** (`bwn-suite-ai`,
  `bwn-wo-audit`, `bwn-drop-upload`). Only the injected transport (`setProxy`)
  differs. The SHA-equality of the block is machine-checked by
  `scripts/test-bwn-ai-phase3.js` under tag **PAT-002**. Do not edit its
  internals in one file only.
- **Selector discipline.** Prefer Umbrava's stable `data-testid` hooks; do not
  pin fragile structural selectors (RISK-004 / repo "Hard Rule 6"). The Notes
  Timeline warns once per session when its selector assumptions drift.
- **Core stays zero paid egress.** `bwn-suite-core` may only make same-origin
  Umbrava GraphQL reads. Anything that reaches the SWA or an outside API belongs
  in the AI script (which enqueues from Core over `bwn:ingestq`).

## Tests

`scripts/` contains two Node harnesses that slice the real shipped sections out
of the `.user.js` files by their comment markers and run them against stubs
(the code under test is never rewritten):

- `test-bwn-ai-client.js` - Phase 2 client transport: tool registry (TASK-007),
  tool-loop driver (TASK-008), injected proxy sender (TASK-009).
- `test-bwn-ai-phase3.js` - Phase 3 consumer migration (TASK-011/013/014) and the
  PAT-002 SHA check across the three `bwnAI` files.

Run with Node (the harness headers pin an absolute `node.exe` path; any Node
works):

```bash
node scripts/test-bwn-ai-client.js
node scripts/test-bwn-ai-phase3.js
```

## Conventions

- **Comment tags** carry the design record: `TASK-xxx` (work item), `RISK-xxx`
  (known risk / accepted tradeoff), `PAT-xxx` (paste-identical pattern),
  `SEC-xxx` (security invariant), `GOAL-xxx` (phase goal). `[[wikilink]]`
  references (e.g. `[[bwn-ai-transport]]`, `[[umbrava-role-auth]]`) point to
  external spec notes, not files in this repo.
- **`bwn-drop-upload.user.js` reads as binary to git and ripgrep** (its `.msg`
  OLE/MAPI parser embeds non-UTF-8 bytes). `Grep` / `rg` silently skip it. Use
  `grep -a` or read the file directly when searching the suite, or a match there
  will be missed.
- `bwn-suite-core`, `bwn-suite-ai`, and `bwn-wo-audit` currently ship with CRLF
  line endings; the rest are LF. `.gitattributes` sets `* text=auto`.
- House style in prose and comments uses hyphens, not em-dashes.
