# BWN Suite Data Contract v1

## Why this exists

Tampermonkey runs each userscript in its own scope. `bwn-suite-core` is `@grant
none`; `bwn-suite-ai` and the satellites hold `GM_*` grants. They run on the same
page but **cannot share a runtime object across that grant boundary**. So the
suite coordinates by sharing DATA, not references:

- **Web storage** (`sessionStorage` / `localStorage`, per Umbrava origin) for
  state that must survive a read on another script or another tab.
- **DOM `CustomEvent`s on `document`** for live, fire-and-forget signalling.

Every consumer treats the DOM as truth and the bus/storage as a best-effort
cache. A missing or malformed key falls back to a safe default; nothing here is
load-bearing enough to throw. All records are versioned (`v: 1`) and timestamped
(`ts`); readers reject the wrong version or a stale `ts`.

Producer names below use the module, not the file: **WO Assist**, **List Heat**,
**Launcher/Ops Suite**, **Client Update**, **Job View**, and the **SWA connector**
live in the two monoliths; the satellites are named by script.

## Storage Keys

`{id}` is the numeric Umbrava work-order id from the URL
(`/work-orders/(\d+)`). `{script}` is `core` or `ai`.

### sessionStorage (per tab, per origin)

| Key | Producer | Consumers | Shape / notes |
|-----|----------|-----------|---------------|
| `bwn:wo:{id}` | WO Assist (Core) | AI, Ask, CC Request, CC Purchase, Bid-Out, everyone | `{v,ts,pos:[{vendor,...}],...}` current WO facts (POs/vendors, GP, status). The primary WO record. `busPut` also fires `bwn:update`. |
| `bwn:heat:{id}` | List Heat (Core) | WO Assist, AI | `{v,ts,...}` per-WO triage verdict. |
| `bwn:health:{script}` | shared core `announceCore` | Ops panel | per-tab module health; re-reported by modules on load. |
| `bwn:o30batch` | List Heat (Core) | AI Over-30 batch | staged list of WOs for the batch Over-30 line draft. |
| `bwn:sel:notets:warned` | Notes Timeline (Core/AI) | self | one-shot flag so the selector-drift warning fires once per session. |

### localStorage (cross tab, per origin, persistent)

| Key | Producer | Consumers | Shape / notes |
|-----|----------|-----------|---------------|
| `bwn:config` | WO Assist / Ops Suite (Core) | WO Assist, List Heat | `{v,targetGP,gpWarn,gpBad,hrsWarn,hrsBad,activeMult,dueWarnDays,schedGraceDays,noteStaleDays,...}`. Read-modify-write PRESERVES unknown keys (e.g. Saved Views presets) so any module can stash data in it. Saving fires `bwn:config`. |
| `bwn:modules` | Ops Suite panel (Core) | Core + AI | `{moduleKey:boolean,...}` kill-switch overrides. Each script honors only keys it owns. Includes the `connector` pseudo-key. |
| `bwn:status:core` | Core | Ops panel | `{ver,ts}` version readout. |
| `bwn:status:ai` | AI | Ops panel (Core) | `{ver,anthropic,places,ingest,ts}`. Booleans report key presence, never keys. `ts` is the AI script's LOAD time and is never refreshed on key save; Core's "loaded this session" handshake compares it to Core's own load stamp within ~60s. |
| `bwn:corever:{script}` | shared core `announceCore` | peer script | `{v,ts,exports:[...]}` for SHARED CORE drift detection. |
| `bwn:po:cls:{id}` | PO grouping (Core) | CC Request, CC Purchase | `{items:[{vendor,sup}]}` per-WO Vendor/Supplier classification (which PO line the user flipped to "Supplier"). |
| `bwn:role:last` | role resolve (AI) | `bwnAI` rank, Ask, CC Request, WO Audit | `{ok,rank,role,tier,email,roleQuery,ts}` server-computed role. Trusted only when `ok` and fresh (TTL 6h). Cross-refresh fallback for the `bwn:role` bus event. |
| `bwn:ingestq` | Core (`ingestPush`) | AI connector (drains) | array of `{id,action,detail,...}` coordinator-action events. Core enqueues and STAYS zero-egress; the AI script POSTs them. See Connector Contract. |
| `bwn:theme` | shared core | Core + AI | active light/dark theme token. |
| `bwn:acts:collapsed` | WO Assist (Core) | self | actions panel collapsed state. |
| `bwn:err:{script}` | shared core | Ops panel | last error info; cleared from the Ops panel. |
| `bwn:eg:contacts` | Email Leak Guard (Core) | self | cached recipient contacts; cleared from the Ops panel. |
| `bwn:heat:snap` / `bwn:o30:snapsent` | List Heat / AI relay | connector | Over-30 daily snapshot and its sent-guard. |

## Event Bus

All events are `document.dispatchEvent(new CustomEvent(name, {detail}))`. Two
top-level events plus two namespaced buses.

| Event | Detail | Meaning |
|-------|--------|---------|
| `bwn:update` | `{id}` | the `bwn:wo:{id}` record changed (fired by `busPut`). |
| `bwn:config` | none | `bwn:config` was saved; WO Assist + List Heat live-refresh. |

### `bwn:evt` (state / presence broadcasts)

| `detail.id` | Payload | From -> To |
|-------------|---------|------------|
| `bwn:role` | `{role,rank,tier,email,roleQuery}` | AI (role resolve) -> `bwnAI` rank readers in all three transport files, Ask, CC Request. Mirrored to `bwn:role:last`. |
| `bwn:cc:register` | `{tool:'purchase'}` | CC Purchase -> CC Request (announces it is loaded). |
| `bwn:cc:ping` | none | CC Request -> CC Purchase (are you there?). |
| `bwn:cc:open` | `{tool:'purchase'}` | CC Request -> CC Purchase (open your modal). |
| `dropupload:accepted` | `{count}` | Drop Upload -> WO Intake (handoff ack). |

### `bwn:cmd` (command / handoff bus)

| `detail.id` | Payload | From -> To |
|-------------|---------|------------|
| `dropupload:files` | `{files}` | WO Intake -> Drop Upload (attach these to the new WO). |
| `core:insertnote` | `{text,noteType}` | AI Client Update -> Core (insert a drafted note). |
| `core:ecd` | none | AI Job View -> Core (open the ECD setter). |
| `core:act` | `{key,note}` | AI Job View -> Core (mark a next-action done). |
| `ai:over30batch` | none | List Heat (Core) -> AI (draft one "OVER 30" line per staged WO). |
| `bidout:invite` | `{leads}` | AI Find Techs -> Bid-Out (seed the RFP wizard). |
| `core:eoddigest` / `core:remind` / `core:notestimeline` | none | Core palette -> Core modules. |

## Module Kill Switches (`BWN_MODULES`)

Each monolith declares a `BWN_MODULES` object literal at the top (edit-here
defaults). At load, both scripts merge overrides from `localStorage bwn:modules`
and honor only their own keys. The Ops Suite panel (Core, Launcher module) writes
`bwn:modules`; changes apply on reload, except the `connector` toggle which is
read live on every tick.

**Core** (`bwn-suite-core`): `poApproval`, `woAssist`, `leakGuard`, `listHeat`,
`launcher`, `viewManager`, `palette`, `visitLog`, `reminders`, `notesTimeline`,
`tripCal`.

**AI** (`bwn-suite-ai`): `clientUpdate`, `findTechs`, `jobView`, `serviceRequest`.

**`connector`** is a pseudo-module: not in either `BWN_MODULES` literal, but the
AI script reads `bwn:modules.connector !== false` live. Turning it off disables
ALL SWA egress (activity events, checklist merge, Over-30 sync, daily trend
relay) without a reload. The Ops panel lists it alongside the real modules.

## `bwnAI` Transport Contract

`bwnAI` v1 is the suite-wide AI router. The block between `// ===== bwnAI v1` and
`// ===== END bwnAI` is pasted **byte-identical into three files**:

| File | Role |
|------|------|
| `bwn-suite-ai` | Grant holder. Wires the REAL proxy via `setProxy`: builds the `/api/ai` request and runs the stateless client<->server tool loop (TASK-007/008/009). |
| `bwn-wo-audit` | Summarize-only consumer. Injects a minimal single-POST sender (no tools). |
| `bwn-drop-upload` | `@grant none`. Carries the block but installs no proxy, so the paid tier always misses and it falls through to on-device. |

**PAT-002 invariant:** the block's SHA must match across those three files.
`scripts/test-bwn-ai-phase3.js` asserts it. Edit the block in one file only and
you break the suite; re-paste into all three.

### Tiers (fallback order)

1. `local` - a module-supplied mechanical function. Always-available floor.
2. `ondevice` - Chrome built-in Prompt API (Gemini Nano). Free, zero egress, no
   key, works under `@grant none`. Everyone.
3. `proxy` - one SERVER key behind the SWA `/api/ai` (Claude/Haiku). Rank-gated
   to managers+ (`minRank` default 4). Transport is INJECTED by a grant holder;
   modules without it never attempt the tier.

### Router contract

- `bwnAI(opts)` is async, self-bounded by `opts.timeoutMs` (default 8000ms),
  **ALWAYS resolves and never throws**. On any miss it returns `''` or the local
  floor result.
- Task defaults: `summarize` and `classify` -> `ondevice` (one-line output);
  `draft` and `render` -> `proxy`; `ask` runs the tool loop.
- Proxy fails CLOSED: unknown or under-`minRank` quietly skips the paid tier (no
  403 flash, no wasted key) and drops to on-device. The server re-enforces rank
  regardless (403 `ROLE_REQUIRED`, treated here as a miss).
- Rank comes from the live `bwn:role` event, else `bwn:role:last` (fresh, `ok`).
  It is UX/cost routing only; the server is the real gate.

### Security invariants

- **SEC-001:** the operator's Umbrava bearer NEVER leaves the browser. In-page
  tools ride same-origin `/api/graphql`; only scrubbed, review-first content goes
  to the SWA.
- **SEC-002:** when a token must reach the SWA, it goes in the JSON BODY
  (`userToken`), never the `Authorization` header (the SWA edge overwrites it).
- **RISK-001:** the userToken is re-read fresh each tool-loop round (it is
  short-lived); a client round cap backstops the loop so it never hangs.
- **TASK-013:** only `task:'ask'` attaches the tool registry; `draft`/`render`
  are single round-trip and tool-free.
- **TASK-014:** the per-user Anthropic key was retired. There is no
  `api.anthropic.com` / `anthropic_key` anywhere in the suite; drafting rides the
  shared SWA connector and one server-side key.

## SHARED CORE v7 Drift Detection

The `BWN SHARED CORE` block (bus + config + parsers + brand tokens + UI
primitives) is also paste-identical, across the two monoliths. On load each
announces `{v,ts,exports}` to `bwn:corever:{script}`. After a 2.5s deferral (so
the peer has announced its current blob), it compares:

- **version mismatch** -> one file was updated without the other.
- **same version, different export list** -> a paste dropped part of the block.

Either warns loudly in the console and shows in the Ops panel. Fix: paste the
newer block into both files and re-import.

## Connector Contract v1

`CONNECTOR_V = 1`. Core is zero-egress, so it only enqueues; the AI script (which
holds the grant) drains and POSTs.

- Core `ingestPush(action, detail)` appends `{id,action,detail,...}` to
  `localStorage bwn:ingestq` (actions like `escalate`, `na-done`, `na-undone`,
  `ecd-set`, `po-cost-confirm`).
- AI drains the queue and POSTs `{actor, events[]}` to SWA `/api/wo-ingest` with
  the `x-bwn-key` header, then removes the sent ids. Kill switch:
  `bwn:modules.connector === false` stops all of it, read live per tick.

## Gotchas

1. **Core and AI cannot call each other's functions.** Different Tampermonkey
   scopes, no shared runtime. Cross-script actions go over `bwn:cmd` / `bwn:evt`
   plus shared storage. Never try to reach a function in the other script.

2. **`bwn:cmd` is fire-and-forget.** There is no guaranteed listener. If the
   target module is disabled or not loaded, the event is dropped silently. When
   you need confirmation, use an ack event (Drop Upload replies with
   `dropupload:accepted`) or a capability probe, and time out with a fallback
   message. WO Intake waits ~1800ms for the ack before telling the user Drop
   Upload was not detected.

3. **`bwn:wo:{id}` may be absent or stale.** WO Assist is the only producer. If
   Core is not installed, or the user has not opened the WO's Job View yet,
   consumers get `null`. Always fall back to the DOM. Records past their
   `maxAgeMs` are rejected by `busGet`.

4. **`bwn:config` reads must be read-modify-write.** The blob holds unknown keys
   (Saved Views presets, and whatever future modules stash). Overwriting it with
   only your keys destroys another module's data. Use `cfgSave(partial)`, which
   merges.

5. **`bwn:status:ai.ts` is a LOAD stamp, not a heartbeat.** It is deliberately
   never refreshed on key save. Do not treat a "stale" `ts` as the AI script
   being gone; the freshness handshake is a ~60s window against Core's own load
   time. Restamping it on save made the suite call the AI script stale the moment
   a key was set mid-session.

6. **Editing SHARED CORE or `bwnAI` in one file only breaks the suite.** SHARED
   CORE is byte-identical across the two monoliths (drift-detected at runtime);
   `bwnAI` is byte-identical across three files (SHA-checked by
   `test-bwn-ai-phase3.js`, PAT-002). Bump the version and re-paste into every
   copy.

7. **The paid AI tier silently no-ops for most users.** Proxy fails closed on
   unknown/under-rank, `@grant none` modules never install a transport, and the
   `connector` kill switch or a missing `ingest_key` also stops it. A blank AI
   result is usually one of these, not an error. Check rank, the `connector`
   toggle, and the ingest key.

8. **`bwn-drop-upload.user.js` is treated as binary by git and ripgrep.** Its
   `.msg` OLE/MAPI parser embeds non-UTF-8 bytes, so `Grep` / `rg` skip it
   silently. Cross-script searches (for a `bwn:cmd` id, a storage key, `bwnAI`)
   will miss it. Use `grep -a` or open the file directly.

## Error Recovery

| Symptom | Likely cause | Next step |
|---------|--------------|-----------|
| Consumer sees no WO facts | `bwn:wo:{id}` absent (Core off, WO not opened) or stale | Read the DOM; confirm Core is installed and the WO page loaded. `busGet` returns null past `maxAgeMs`. |
| Console: `SHARED CORE DRIFT: ... announced v<n>` | one monolith updated without the other | Paste the newer SHARED CORE block into both files, bump `VERSION`, re-import both. |
| Console: `SHARED CORE DRIFT: ... export lists differ` | a paste dropped part of the block | Re-paste the full block into both files. |
| `test-bwn-ai-phase3.js` PAT-002 fails | the `bwnAI` block diverged across the three files | Re-paste the identical block into `suite-ai`, `wo-audit`, `drop-upload`. |
| AI returns empty, no error | proxy failed closed (rank/grant), on-device unavailable, or floor empty | Check `bwn:role:last.rank` >= `minRank`, that a grant holder installed `setProxy`, and the on-device Prompt API availability. |
| SWA call rejected / "not configured" | missing or wrong `x-bwn-key` (`GM ingest_key`) | Set the ingest key via the script's Tampermonkey menu command (same value as `WO_INGEST_KEY`). |
| SWA privileged route 403 `ROLE_REQUIRED` | server re-checked rank and refused | The caller lacks the required rank; client-side UX gating is not authoritative. |
| Connector "SWA sync failing (HTTP ...)" | ingest key wrong or deployment down | Verify the ingest key and the SWA deployment; the beat clears on the next OK tick. |
| WO Intake: "Drop Upload not detected" | no `dropupload:accepted` ack within the window | Install/update `bwn-drop-upload`; then drag the `.msg` onto the WO manually. |
| CC launcher shows two buttons or none | CC Request/CC Purchase presence handshake missed | Both scripts installed and enabled; CC Request owns the button and opens CC Purchase over `bwn:evt`. Reload to re-run the ping. |
