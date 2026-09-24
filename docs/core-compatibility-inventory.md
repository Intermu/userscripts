# BWN Suite Core Compatibility Inventory

Documentation only. No runtime, test, ledger, metadata, or version change accompanies this file.

- **Last verified against:** `bwn-suite-core.user.js` `@version 1.89.1`, `origin/main` @ `892277f` (2026-09-23).
- **Method:** targeted greps + reads of the shipped source and `scripts/` harnesses. Line numbers are
  approximate (`~`) and drift; function names, block markers, and event ids are the stable anchors.
- **Scope rule:** only facts confirmed in code. Anything inferred or unchecked is marked **not verified**.
- No credentials, work-order data, vendor names, amounts, or emails appear here.

---

## 1. Do Not Break

1. **Single raw-published file.** Tampermonkey installs and updates Core straight from
   `raw.githubusercontent.com/Intermu/userscripts/main/bwn-suite-core.user.js`. No bundler, no module
   split, no build step is authorized.
2. **`@grant none`.** Core shares the page `window` on purpose. `@grant none` siblings read Core's
   `window.*` bridges directly (section 3.3). GM-granted siblings live in a sandbox and see Core
   **only** through the document-level `CustomEvent` bus.
3. **Event names and payload shapes.** Keep every `bwn:evt` `detail.id`, every `bwn:cmd` id, and every
   raw event (`bwn:config`, `bwn:gov`, `bwn:update`, `bwn:theme`) exactly as listed in section 3.
4. **`bwn:dock:*` contract.** Keep host election (priority 100, then born-ts, then hostId), the 20 s
   heartbeat/ping, the 65 s prune TTL, register keyed by `key`, and the `BWN_DOCK_POLICY` allow-list.
5. **XLSX `@require`.** `xlsx 0.18.5` from cdnjs, pinned with `#sha384=` SRI. Used by Bulk Ops `.xlsx`
   intake. `test-manifest-ledger.js` checks the SRI pin.
6. **Umbrava write paths and their gates.** Every write goes through `bwnGqlOp` and the `BWN_OPS`
   registry (section 5.4). Keep the feature kill switches, the high-risk confirm, dry-run + typed confirm
   in the bulk consoles, the audit ring, and the ship-OFF flags.
7. **Named source blocks.** Most harnesses slice Core by text between `START`/`END` comment markers and
   run the slice in a `vm`. Several blocks are also **byte-identical across scripts** and SHA-gated.
   Renaming, moving, or reformatting a marker, or editing inside a pinned block, breaks CI
   (section 7).
8. **Launcher SWA handoff.** The Job Board link carries WO context as URL query parameters on a user
   click (section 5.1). Keep it user-initiated, and do not add fields.
9. **Companion behavior.** 19 of the 21 other userscripts have a confirmed Core touchpoint (section 4). Each is
   separately versioned and loads in any order.

---

## 2. Repository and Delivery Model

| Item | Value |
|---|---|
| Canonical file | `bwn-suite-core.user.js` (~18.4k lines, one IIFE) |
| `@name` / `@namespace` | `BWN Suite - Core (Broadway National)` / `broadwaynational.bwn` |
| `@version` | `1.89.1` (also exposed as `BWN_VER`, written to `localStorage['bwn:status:core']`) |
| `@match` | `https://app.umbrava.com/*`, `https://*.umbrava.com/*` |
| `@run-at` | `document-start` |
| `@grant` | `none` |
| `@require` | `https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js#sha384=…` |
| `@downloadURL` / `@updateURL` | the raw `main` URL above |
| Build system | none. No `package.json`. `eslint.config.mjs` runs via `npx eslint@9` in CI |
| Suite size | 22 `*.user.js` files at the repo root (Core + 21) |
| Tests | 126 `scripts/*.js` standalone node harnesses; 63 of them read `bwn-suite-core.user.js` directly |

**CI (`.github/workflows/ci.yml`).** Two jobs, both required checks on `main`:
- `test` (Node 22): `node --check` over every `*.user.js`, then each harness as its own step.
  `test-domproj-parity.js` (Core's `BWN-DOM`/`BWN-DOMC` vs the sibling `broadway-internal-ops` repo) is
  advisory while `BWN_DOM_PARITY_ADVISORY: 'true'`.
- `lint`: `npx eslint@9 --max-warnings 0 "*.user.js" "scripts/**/*.js"`.
- Renaming a job breaks the required check. An unquoted `: ` in a step name makes the workflow file fail
  to parse.

**CLAUDE.md obligations** (repo root):
- *Roster change* (add / retire / rename / fold a script): update the vault wiki roster
  (`userscript-install-links.md`), the suite hub (`bwn-suite-userscripts.md`), and the one-pager artifact
  in the same change.
- *Version bump*: sync the Version column and the one-pager chips, reading every version from
  `git show origin/main:<file> | grep -m1 @version`.
- A new doc under `docs/` triggers neither rule. Neither applied to this file.

---

## 3. Public Contract Inventory

### 3.1 `bwn:evt` bus

Transport: `document.dispatchEvent(new CustomEvent('bwn:evt', { detail: { id, ... } }))`. `detail.id`
is the event name.

**No envelope, no version, no source field.** Listeners follow one defensive pattern:
`var d = e && e.detail; if (d && d.id === '…')`, plus `typeof` checks on numeric fields. Any script on
the page can forge any event. The code says outright that the bus is **not** a security boundary:
permission decode plus `bwnGqlOp` re-checks are the real gate. Core never removes its `bwn:evt`
listeners; they live for the page's lifetime.

**Core publishes**

| `detail.id` | Where (~line) | Payload | Consumers |
|---|---|---|---|
| `bwn:perm` | `bwnPermPublish` (~1945) | `groups` (count), `granted` (count), `ts` | BWN-PERM consumer copies in 10 scripts (see 4) |
| `bwn:assist:due` | `armAssistDue` (~5745) | `escSev` (number) | `bwn-wo-assist` |
| `bwn:heat:rows` | `heatRowsAnnounce` (~9443) | none (signal only; data via `window.__bwnHeatRows()`) | `bwn-kanban`, `bwn-low-gp` |
| `bwn:dispatch:synced` | dispatch sync handler (~10967) | `ok` (bool), `rows` (count of `bwn:dispatchq` rows; 0 on failure) | `bwn-suite-ai` |
| `bwn:drawer:open` | `openSuitePanel` (~11593), Bulk Ops (~17431), Bulk Source (~18173) | `key` | every drawer owner (drawer slot, 3.2) |
| `domp:result` | DOM Passport `reply` (~17117) | `rid`, `result` (object) | `bwn-ask`, `bwn-suite-ai` |
| `bwn:dock:host` / `ping` / `open` | Launcher `dockEmit` | see 3.2 | dock registrants |
| `bwn:dock:register` | Bulk Ops (~17387), Bulk Source (~18137) | see 3.2 | Core's own dock host |

`domp:result.result` can carry page-derived text (snapshot/extract). Its shape depends on the verb and
has no schema. Treat it as **sensitive**.

**Core consumes**

| `detail.id` | Where (~line) | Fields read | Producer |
|---|---|---|---|
| `bwn:perm` | BWN-PERM listener (~1889) | `id` | Core itself (invalidates `_bwnPermSlot`) |
| `bwn:role` | WO Assist (~4010), Launcher (~12751), DOM Passport (~17092) | `rank` (number) | `bwn-suite-ai` |
| `bwn:assist:state` | WO Assist (~5757) | `wo`, `found`, `record` | `bwn-wo-assist` |
| `bwn:drawer:open` | Settings drawer (~12042), Bulk Ops (~17419), Bulk Source (~18162) | `key` | any drawer owner |
| `bwn:dock:register` / `update` / `unregister` | Launcher dock bus (~12758) | see 3.2 | registrants |
| `bwn:dock:host` / `ping` | Launcher (~12755) | `hostId`, `priority`, `ts` | competing hosts |
| `bwn:dock:register` / `update` / `unregister` | WO Assist `waDockSeen` (~5724) | `key` | registrants (tracks which tools are live) |

### 3.2 `bwn:dock:*` shared launcher dock (Launcher module, ~12380-12830)

The contract comment at ~12382-12409 is authoritative. Modules never touch dock DOM; only serializable
events cross the bus.

| id | Direction | Payload |
|---|---|---|
| `bwn:dock:host` | host to all | `{hostId, priority, ts}`: announce + heartbeat |
| `bwn:dock:ping` | host to all | `{hostId}`: "(re)register now" |
| `bwn:dock:register` | module to host | `{key, label, icon, weight, badge?, minRank?, title?, needPerm?}` |
| `bwn:dock:update` | module to host | `{key, label?, icon?, badge?, minRank?, needPerm?}` |
| `bwn:dock:unregister` | module to host | `{key}` |
| `bwn:dock:open` | host to module | `{key}`: user clicked; the owner opens its own UI |

Behavior as implemented:
- **Host identity.** `dockHostId = 'h' + random36 + bornTs36`, one per page load. `HOST_PRIORITY = 100`.
- **Election** (`dockOtherWins`, ~12464). Higher `priority` wins. On a tie, the earlier `ts` wins. On a
  second tie, the lexically smaller `hostId` wins. A losing Core sets `dockAmHost = false`, runs
  `removeDockStack()`, and ignores register/update/unregister.
- **Reclaim.** The heartbeat is `setInterval` every `DOCK_PING_MS` = 20000. A demoted Core that hears no
  foreign host within `DOCK_TTL_MS` = 65000 takes the host role back. Spoofed or departed hosts can't
  demote it permanently.
- **Boot.** Core calls `dockAnnounce(); dockPing();` once immediately, then every 20 s. Registrants
  (re)register on `host` or `ping`. Late loaders are therefore picked up within ≤20 s; there is no boot
  window.
- **Register** is keyed only by `key`. **No owner is recorded or checked.** A second script sending the
  same key silently replaces label, icon, weight, badge, and so on, keeping only the original `order`.
  There is no warning. Known collision risk.
- **Update** applies only if the key already exists; otherwise it is ignored. **Unregister** deletes the
  key if present.
- **Ordering** (`dockVisible`): by `weight` ascending (default 50), then first-registration order
  (`dockOrderSeq`). No grouping except a static "TOOLS" section rendered after the rows.
- **Visibility** (`dockPolicyAllows`, fail-closed). Driven by Core's hard-coded `BWN_DOCK_POLICY`
  `key → {minRank, perms}`, **not** the registrant's own `minRank`/`needPerm`. An unclassified key is
  hidden and warned once. Rank comes from the `bwn:role` event or a `bwn:role:last` seed (6 h TTL).
  Classified keys today: `ask`, `assist`, `inventory`, `cc`, `bidout`, `wo-extract` (rank 1);
  `bulk-source` (2); `wo-audit`, `dispatch` (3); `operate`, `bulk-ops` (4). That list matches every
  registered key in the suite. **A new registrant needs a policy row, or it never shows.**
- **Stale entries.** `pruneDock` drops entries unseen for 65 s. Route changes do **not** clear the
  roster. Only `bwn-bid-out` and `bwn-dispatch` ever send `unregister`.
- **Disabled state.** No "disabled row" exists: a denied row is simply absent. With zero rows, Core
  shows the standalone Tools pill (`DOCK_ID`), which opens Suite Settings.
- **Collapsed state.** `localStorage['bwn:dock:collapsed'] = '1'` or the key is removed.
- **Render.** `scheduleDockRender` is a 120 ms trailing debounce. The rail self-heals when the DOM is
  wiped (**not verified**: exact observer target).
- **No companion becomes host.** The 9 other scripts that mention `bwn:dock:host` only listen for it
  (to re-register and set `_hostSeen`). With no Core, `bwn-ask`, `bwn-cc-auth`, `bwn-dispatch`, and
  `bwn-wo-audit` log a `console.warn` "no dock host", and those tools are unreachable except via the
  Tampermonkey menu where one exists (**not verified** per script).

**Drawer slot** (`bwn:drawer:open {key}`). Separate from the dock. It keeps one suite drawer or overlay
open at a time: an opener emits it first, and every other panel closes unless the key is its own. The
pattern is copied, not SHA-gated, in Core's Settings, Bulk Ops, and Bulk Source, and in most companions.
`bwn-suite-ai` also uses slot keys `findtechs`, `jobview`, `clientupdate`, `over30`. These are drawer
keys, not dock keys.

### 3.3 `bwn:cmd` bus and raw events

`bwn:cmd` (`detail.id`), same transport and same lack of validation as `bwn:evt`:

| id | Core role | Payload | Other side |
|---|---|---|---|
| `ai:over30batch` | publishes (~11200) | none (data in `sessionStorage['bwn:o30batch']`) | `bwn-suite-ai` |
| `core:eoddigest`, `core:remind`, `core:notestimeline` | publishes (Tools menu) + consumes | none | Core itself |
| `core:settings` | consumes (~12814) | none | Core palette |
| `core:ecd` | consumes (WO Assist ~7608) | none | `bwn-suite-ai` |
| `core:act` | consumes (~7609) | `key`, `note` (**WO note text**) | `bwn-suite-ai` |
| `core:insertnote` | consumes (~7622) | `text`, `noteType` (**WO note text**) | `bwn-suite-ai` |
| `bwn:dispatch:sync` | consumes (~10959) | `id` | `bwn-suite-ai` |
| `domp:snapshot`, `domp:act` | consumes (DOM Passport ~17121) | `rid`, `verb`, args | `bwn-ask`, `bwn-suite-ai` |

`core:act` and `core:insertnote` put note text on the clipboard or prefill the composer. The user still
posts it; nothing is written automatically. `domp:act` accepts only `inspect`, `extract`, and
`refresh_snapshot` (`BUS_VERBS`). It is rank-gated through `dompRank()` and built with no
`write: true`. A request without `rid` is dropped. There is no timeout or retry on the responder side.

Raw `CustomEvent` types (no `detail.id`):

| type | Core role | Other side |
|---|---|---|
| `bwn:config` | publishes on config save/reset; consumes to refresh | `bwn-kanban`, `bwn-suite-ai`, `bwn-wo-audit` |
| `bwn:update` | publishes + consumes | `bwn-dispatch`, `bwn-suite-ai` |
| `bwn:gov` | consumes, and re-runs `bwnApplyGov` | `bwn-suite-ai` dispatches it after caching the governance bundle |
| `bwn:theme` | publishes (~371) | no listener found in the suite |

### 3.4 Page-window globals (visible to `@grant none` scripts only)

| Global | Set (~line) | Guard | Readers |
|---|---|---|---|
| `bwnToast` | 965 | none | Core |
| `bwnOnRoute` | 1020 | none | 12 reads across `@grant none` siblings (`bwn-kanban`, `bwn-low-gp`, `bwn-notes`, `bwn-proposal-actions`, …) |
| `bwnReport` | 1092 | none | `bwn-proposal-copy`, `bwn-wo-intake`, others (6 reads) |
| `__bwnPerm` | 1960 | none | `{can, canAll, slot, refresh, map}`; dev/diagnostic |
| `__bwnHeatRows` / `__bwnHeatScan` / `__bwnHeatAck` / `__bwnHeatRefresh` / `__bwnHeatDiag` | 11307-11348 | none | `bwn-kanban`, `bwn-low-gp` (the documented List Heat read surface) |
| `__bwnDispatchSyncNow` | 10953 | none | referenced by `bwn-suite-ai` comments; dispatch push |
| `__bwnLauncher` | 11413 | `if (window.__bwnLauncher) return` | once-only guard for the Launcher module |
| `__bwnWoHeat` | 8281 | once-only guard | List Heat |
| `__bwnHeatNetHook` | 1151 | once-only guard | GraphQL tap (5.1) |
| `__bwnOps`, `__bwnPoParity` | 1817, 3063 | none | dev hooks |
| `BWNDOM`, `BWNDOMC` | ~15401, ~17032 (`root.*`) | **not verified** | DOM Passport. GM-sandboxed `bwn-suite-ai` cannot see them (its comment at ~1788 says so) |
| `window.fetch`, `XMLHttpRequest.prototype.open/send` | ~1156 | `__bwnHeatNetHook` | Core **wraps** these to observe `/api/graphql` bodies and responses |

`bwnGqlOp` is **not** a global. Each adopter carries its own paste-identical `BWN-OPS-WRAP` copy (10
scripts, section 4). `BWN` stays module-scoped.

Core has **no whole-script single-instance guard**. Protection is per module (`__bwnLauncher`,
`__bwnWoHeat`, `__bwnHeatNetHook`). What happens on reinjection or double install is **not verified**
for modules without such a flag.

### 3.5 Storage keys owned or read by Core

| Key | Store | Owner / purpose | Shared with |
|---|---|---|---|
| `bwn:modules` | local | user module toggles, merged over `BWN_MODULES` at boot (boolean keys only); written by Suite Settings | all siblings read their own keys |
| `bwn:gov` | local | governance bundle `{flags:{…, globalKillSwitch}}`: **one-way disable only** | written by `bwn-suite-ai` |
| `bwn:config` | local | suite config via `BWN.config`; one legacy check for `bwn-gp-target` (~2320) | `bwn-kanban`, `bwn-suite-ai`, `bwn-wo-audit` |
| `bwn:status:core` / `bwn:status:ai` | local | `{ver, ts}` liveness for the health readout | AI writes `:ai` |
| `bwn:err:core` | local | last 10 `{tag, msg≤200, ts}` from `BWN.guard` / `safeModule` | Ops panel |
| `bwn:health:core`, `bwn:corever:*` | local | health and version readouts (**not verified**: exact shape) | Ops panel |
| `bwn:theme` | local | `'dark'` / `'light'` | — |
| `bwn:role:last` | local | `{ok, rank, ts}` rank seed, 6 h TTL | produced from `bwn:role` |
| `bwn:perm:last` | local | decoded permission slot (record carries `v:1`) | BWN-PERM consumers |
| `bwn:audit` | local | `bwnGqlOp` write audit ring, max 200, schema v1, no raw variables/responses | — |
| `bwn:auditHW` | local | audit mirror high-water mark | — |
| `bwn:dock:collapsed` | local | rail folded | — |
| `bwn:acts:collapsed`, `bwn:coordq:debug`, `bwn:coordq:sec:<name>` | local | WO Assist UI prefs | — |
| `bwn:heat:autoscan` | local | List Heat auto-scan toggle | — |
| `bwn:wo:<id>` | session | per-WO cached context | `bwn-cc-auth`, `bwn-cc-purchase`, `bwn-dispatch`, `bwn-inventory`, `bwn-suite-ai`, `bwn-wo-assist`, `bwn-wo-extract` |
| `bwn:heat:<id>`, `bwn:heat:users` | session | List Heat scan caches | — |
| `bwn:o30batch` | session | over-30 batch `{v, ts, jobs}` handed to AI | `bwn-suite-ai` |
| `bwn:sel:notets:warned` | session | one-time selector-drift warning | — |

Other Core prefixes seen by grep, purpose **not verified**: `bwn:visit:snap:`, `bwn:visit:day:`
(visitLog), `bwn:reminders`, `bwn:notes:`, `bwn:trips:`, `bwn:docs:`, `bwn:site:`, `bwn:tasks:`,
`bwn:props:`, `bwn:po:suppliers`, `bwn:po:ov:`, `bwn:ecdset:`, `bwn:eg:contacts`, `bwn:eg:overrides`
(Leak Guard), `bwn:views:pending`, `bwn:planq`, `bwn:plansent`, `bwn:actsq`, `bwn:actssent`,
`bwn:actstats`, `bwn:ingestq`, `bwn:dispatchq`, `bwn:swa:`, `bwn:inv:`.

**Migrations.** No general schema versioning. Versioned records seen so far: `bwn:audit` (v1),
`bwn:perm:last` (`v:1`), `bwn:o30batch` (`v`). There is no suite-wide reset in Core (**not verified**
whether Suite Settings clears any keys).

### 3.6 Load-order notes

- Core runs at `document-start` and queues module boots (`bwnBoot` → `BWN_BOOT_Q`, flushed by
  `bwnBootAll`). A late `bwnBoot` call runs immediately.
- **Siblings loading before Core** re-register on Core's first `host`/`ping`.
- **Siblings loading after Core** register immediately.
- **Without Core**: `@grant none` readers probe `typeof window.__bwnHeatRows === 'function'` and fall
  back (`bwn-kanban` ~1437, `bwn-low-gp` ~772). Dock tools warn and stay hidden.

---

## 4. Companion Dependency Map

`perm` = carries the byte-identical BWN-PERM consumer block (listens for `bwn:perm`, reads
`bwn:perm:last`). `ops` = carries its own `BWN-OPS-WRAP` copy of `bwnGqlOp`. Fallback column is
**not verified** unless it cites a line.

| Script | `@grant` | Touches Core via | Ids / dock key | Core state read | Main risk if Core changes |
|---|---|---|---|---|---|
| `bwn-ask` | GM_* | evt, cmd, dock | dock `ask`; `domp:*`; drawer slot | `bwn:role` | dock or `domp` contract drift; warns if no host (~1089) |
| `bwn-bid-out` | GM_* | evt, cmd, dock (sends unregister) | dock `bidout` | — | register/unregister semantics |
| `bwn-cc-auth` | GM_* | evt, dock | dock `cc`; `bwn:cc:*` | `bwn:wo:*`, role | WO context key shape; warns if no host (~565) |
| `bwn-cc-purchase` | GM_* | evt (via CC Auth, no dock row) | `bwn:cc:register` | `bwn:wo:*` | reachable only through CC Auth |
| `bwn-dispatch` | GM_* | evt, cmd, dock (sends unregister), perm, ops | dock `dispatch`; `bwn:update` | `bwn:modules`, perm, role, `bwn:wo:*` | ops/perm block drift, dock policy rank 3 |
| `bwn-drop-upload` | none | evt, cmd, perm, ops | `ai:summarize`, `dropupload:*` | `bwn:modules`, perm, role | ops/perm block drift |
| `bwn-inventory` | GM_* | evt, dock | dock `inventory` | `bwn:wo:*` | dock drift |
| `bwn-kanban` | none | evt, globals (`__bwnHeat*`, `bwnOnRoute`), perm, ops | `bwn:heat:rows`, `bwn:config` | `bwn:config`, `bwn:modules`, perm, role | **List Heat row shape** (`__bwnHeatRows`), route hook |
| `bwn-low-gp` | none | evt, `bwnOnRoute`, heat globals, perm, ops | `bwn:heat:rows` | `bwn:modules`, perm, role | heat and route bridges |
| `bwn-notes` | none | evt, cmd, `bwnOnRoute`, perm | `notes:tpl:*` | `bwn:modules`, perm, role | route hook, perm |
| `bwn-proposal-actions` | none | evt, `bwnOnRoute`, perm, ops | — | `bwn:modules`, perm, role | perm/ops drift |
| `bwn-proposal-copy` | none | evt, `bwnReport`, perm, ops | drawer slot | `bwn:modules`, perm, role | `bwnReport` signature |
| `bwn-suite-ai` | GM_* incl. clipboard | evt, cmd, dock, raw events | dock `operate`; produces `bwn:role`, `bwn:gov`, `bwn:config`, `bwn:update`, `core:*`, `ai:*`, `domp:*` | `bwn:config`, `bwn:modules`, role, theme, `bwn:wo:*`, heat | **broadest coupling**: near-peer to Core |
| `bwn-temp-vendor` | none | evt, perm, ops | — | `bwn:modules`, perm, role | perm/ops drift |
| `bwn-wo-assist` | GM_* | evt, dock | dock `assist`; `bwn:assist:state` / `:due` / `:cr` | `bwn:wo:*` | assist handshake with Core WO Assist |
| `bwn-wo-audit` | GM_* | evt, dock, perm, ops | dock `wo-audit` | `bwn:config`, `bwn:modules`, perm, role | ops/perm drift; warns if no host (~5000) |
| `bwn-wo-extract` | GM_* | evt, dock | dock `wo-extract` | `bwn:wo:*` | dock drift |
| `bwn-wo-intake` | none | evt, cmd, `bwnReport` | `dropupload:files` | — | `bwnReport`, drop-upload handoff |
| `bwn-write-queue` | GM_* | evt, perm, ops | — | `bwn:modules`, perm, role | `bwnGqlOp` contract (its whole job) |
| `bwn-vendor-intake` | GM_getResourceURL | **none** | — | — | — |
| `bwn-wide-list` | GM_* | **none** (own `bwn:wideList` GM value) | — | — | — |

19 of the 21 other scripts have a confirmed Core touchpoint. `bwn-vendor-intake` and
`bwn-wide-list` have none.

**BWN-PERM copies:** `bwn-dispatch`, `bwn-drop-upload`, `bwn-kanban`, `bwn-low-gp`, `bwn-notes`,
`bwn-proposal-actions`, `bwn-proposal-copy`, `bwn-temp-vendor`, `bwn-wo-audit`, `bwn-write-queue`.

**BWN-OPS-WRAP copies:** `bwn-dispatch`, `bwn-drop-upload`, `bwn-kanban`, `bwn-low-gp`,
`bwn-proposal-actions`, `bwn-proposal-copy`, `bwn-temp-vendor`, `bwn-wo-audit`, `bwn-write-queue`.

---

## 5. Lifecycle, Governance, and Writes (as built)

### 5.1 Lifecycle
- **Module switches.** Resolved once, before `bwnBootAll`, in this order: `BWN_MODULES` defaults, then
  `localStorage['bwn:modules']` booleans, then `bwnApplyGov()` one-way disables. `bwnApplyGov()` also
  re-runs on the `bwn:gov` event, and `bwnGqlOp` reads `BWN_MODULES` live, so a remote kill blocks new
  writes with no reload. Ship-OFF flags: `woAssistWrites`, `bulkOps`, `bulkOpsDestructive` (reserved,
  gates nothing yet), `routeHelper`.
- **Error isolation.** `BWN.safeModule(id, fn)` wraps each module's startup. `BWN.guard(fn, tag)` wraps
  long-lived callbacks. Both catch everything, never rethrow, and call `pushErr`: `console.error` of the
  raw error, plus `{tag, msg (≤200 chars), ts}` into `bwn:err:core` (last 10, one per tag per minute).
  The raw error message is logged as is (**not verified** that no message ever contains page data).
- **Page changes.** The `BWN-ROUTE` block (`BWN.onRoute` / `window.bwnOnRoute`, ~968-1021) patches
  `pushState`/`replaceState` once and listens for `popstate`. It fires after a 150 ms trailing debounce,
  only on a **pathname** change (search/hash ignored). Subscribers get an unsubscribe closure. A
  throwing subscriber is caught. The helper is always defined; `routeHelper: false` only controls
  whether adopters use it. **Most Core modules still run their own** lifecycle: 10 `new MutationObserver`
  sites and 6 `setInterval` sites (PO Approval poll ~2280, Leak Guard poll ~8253, a local interval
  ~10539, dock heartbeat 20 s ~12798, reminders 30 s ~14361, Bulk Source ~18130). Page-scoped teardown
  is **not verified** per module. `AbortController` is not used anywhere in Core.
- **Keyboard.** 21 `addEventListener('keydown'` sites (dialogs, drawers, palette). The canonical
  `bwnFocusTrap` is SHA-pinned by `test-a11y-focus.js`.
- **Network (script-initiated).** Same-origin `fetch('/api/graphql')` only: `bwnGql` (~1443) and
  `bwnGqlRead` (~1487, classified envelope). Auth header is `Bearer <authToken()>`, the shared
  token-picker block. Core also wraps `window.fetch` and XHR to *observe* Umbrava's own GraphQL traffic
  (`installGqlHook`, ~1150, List Heat seed); it sends nothing new. The XLSX file is fetched by
  Tampermonkey at install/update time (`@require`), not by Core at runtime.
- **SWA context handoff (user-initiated navigation).** The Launcher's `LAUNCHER_APPS` rows open the
  Static Web App host hard-coded in `LAUNCHER_BASE` (~11423) in a new tab with `window.open(url, '_blank',
  'noopener')`. For apps with `context: true` (today only "Projects Job Board"), `buildUrl` appends the
  current WO context as **URL query parameters**: `woId`, `tracking`, `wo`, `client`, `addr`,
  `location`, `status`, `dne`, `gpPct`. This is sensitive operational data in a URL, sent only on the
  user's click. It is an existing, intentional contract; do not widen it. Other rows (Pricing Assistant,
  Client Profile Intake, Daily Ops Agenda) have empty paths and do not render. Copy context / Copy WO
  link write the same fields to the clipboard only.

### 5.2 `permGate`
`BWN-PERM` (~1824-1960) decodes `me{permissions}` once per session and publishes `bwn:perm:last`, the
`bwn:perm` event (counts only), and `window.__bwnPerm`. Core is the **only producer**; 10 scripts carry
consumer copies. The gate **fails open** when the decode is undecided, unmapped, or stale, and **fails
closed** on a checkbox known to be missing. It hides dock rows, WO-Assist write buttons, and the bulk
consoles. UI visibility only; every write re-checks at execution.

### 5.3 `bwnGqlOp` (`BWN-OPS` registry ~1510, `BWN-OPS-WRAP` v3 ~1592)
- **Signature.** `bwnGqlOp(op, query, variables, opts)` returns `Promise<data>`. `op` must be a
  `BWN_OPS` key, or the call is rejected.
- **Options.** `opts`: `feature`, `validate`, `ids`, `before`, `after`, `actor`, `confirmed`, `current`,
  `proposed`, `count`, `reason`, `irreversible`.
- **Read vs write** comes from registry `kind`, not the query text. A write with a `risk` other than
  `low`, `moderate`, or `high` is refused as `unclassified-write`.
- **Kill switch.** `BWN_MODULES[opts.feature] === false` means denied and audited.
- **High-risk confirm.** Requires `opts.confirmed === true` or `setConfirm` handler approval. With
  neither, the call is rejected. `confirmed:true` is trusted from the caller; the source marks this as a
  known gap.
- **Permissions.** `meta.perm` (string, array, or `fn(vars)`, e.g. `bwnPermsForPatch`) is checked via
  `bwnCan` / `bwnCanAll`.
- **Retries.** Up to 3 only for `retry:'safe'` reads or idempotent writes. Non-idempotent writes try
  once.
- **Audit.** Writes only. A `bwnCorrId()` per call goes into `bwn:audit` with fixed-category outcome
  strings, never raw variables or server messages.
- **Registry backstop.** `test-registry-authoritative.js` fails if the registry and the call sites
  diverge in either direction.

### 5.4 Umbrava write paths in Core

| Op (risk) | Caller | Gates |
|---|---|---|
| `putUserPreference` (low, idempotent) | BWN Views save (~12899-12988) | `viewManager` module; user-initiated save; no confirm |
| `addTask` (moderate) | WO Assist "Create task" (`WA-WRITES` ~6661) | `woAssistWrites` ships **false** + `feature:'woAssist'` + permGate |
| `patchWorkOrder` (high, non-idempotent) | WO Assist "Change status" (`WA-WRITES` ~6705) | `woAssistWrites` ships **false** + `feature:'woAssist'` + high-risk confirm + permGate |
| `patchWorkOrder` (high) | Bulk Ops set-ECD (`BULK-OPS-ENGINE` ~17167) | `bulkOps` ships **false**, rank 4 dock policy, dry run + typed confirm |
| `addEditJobNote` (moderate) | Bulk Ops add-note (~17297) | same as the Bulk Ops row above |
| `patchWorkOrder` (high) | Bulk Source / Edit PO#/WO# (`BULK-SOURCE-ENGINE` ~17934) | `bulkSource` **on** (since 2026-09-02), rank 2, dry run + typed confirm, blanks only |

Literal `bwnGqlOp('<op>'` call sites in Core: `me`, `workOrder`, `addTask`, `patchWorkOrder`,
`putUserPreference`, `addEditJobNote`. The bulk engines also pass the op name indirectly.
`test-registry-authoritative.js` is the source of truth for the op-to-caller map.
`WA-WRITES` is sliced by `test-a2-taskcreate.js` and `test-b2-statuswrite.js`.

Registry snapshot: low `putUserPreference`; moderate `addEditJobNote`, `addClientProposalNote`,
`initializeJobDocument`, `bulkAddWorkOrderDocuments`, `addTask`, `completeTask`, `deactivateVendor`;
high `patchWorkOrder`, `activateVendor`. The typed-confirm dialogs themselves were **not
read line-by-line**; their presence is confirmed by source comments and `test-bulk-ops.js` /
`test-bulk-source.js`.

XLSX (`window.XLSX` from the `@require`) is used by Bulk Ops `.xlsx` intake only. It loads for every
user even with `bulkOps` off, a documented `ponytail:` ceiling (header ~14-18).

---

## 6. Feature Boundary Map

| Feature (flag) | Page | Mount / entry | Reads / writes Umbrava | Contracts owned | Regression-sensitive | Tests (examples) |
|---|---|---|---|---|---|---|
| PO Approval + ETA Builder (`poApproval`, module ~2009-2300) | Send PO modal | text buttons in modal; one observer + one poll | no GraphQL call in the module range; no write | none verified | duplicate buttons on modal rerender | **not verified** |
| WO Assist (`woAssist`, module ~2300-7635): GP/ETA, stall watchdog, DNE, playbook | WO detail | side-docked card; coordinator queue | reads WO/notes/trips/POs (`BWN-PO-API` ~2878)/docs; writes only via `woAssistWrites` (off) | `bwn:assist:*`, `core:ecd/act/insertnote`, `bwn:wo:*`, `bwn:po:*`, `bwn:acts:collapsed` | ECD derived from note dates, escalate handoff | `test-assist-*.js`, `test-coord-*.js`, `test-ecdrisk.js`, `test-po-api.js` |
| Email Leak Guard (`leakGuard`, module ~7635-8272) | outbound email compose | pre-send check; observer + poll | offline | `bwn:eg:contacts`, `bwn:eg:overrides` | shared vendor-token matcher (`bwnVendorTokens`, ~1970, above the module): tokens must start a word | **not verified** |
| WO List Heat (`listHeat`): overlay, My Day, full-board scan, autoscan | WO list | row overlay + strip | reads `listWorkOrdersPaginated`; GraphQL tap | `__bwnHeat*`, `bwn:heat:rows`, `bwn:heat:*`, `bwn:heat:autoscan` | row shape read by kanban/low-gp; full-board coverage | `test-heat-*.js` |
| BWN Views (`viewManager`) | WO list | saved column layouts | reads `userPreference`; **writes** `putUserPreference` | `bwn:views:pending` | layout vs current columns | **not verified** |
| Launcher + dock (`launcher`) | all | left-edge rail / Tools pill; SWA app links; Copy context / Copy WO link (clipboard) | none (the SWA link is a user-clicked new tab, see 5.1) | `bwn:dock:*`, `bwn:drawer:open`, `bwn:dock:collapsed` | host election, policy table, `LAUNCHER_APPS` context handoff | `test-dock-latent-fixes.js`, `test-bidout-dock.js` |
| Suite Settings | all (dock / `core:settings`) | drawer | none | `bwn:modules`, `bwn:config` | `BWN-SETTINGS` block | `test-ops-settings.js` |
| Palette (`palette`) | all | Ctrl/Cmd-K | none | `bwn:cmd` sends | — | **not verified** |
| visitLog, reminders, notesTimeline, tripCal | WO detail | strips / overlay / `.ics` export | reads only | `bwn:visit:*`, `bwn:reminders`, `core:*` cmds | — | `test-reminders-channel.js` |
| DOM Handles / Passport (`domHandle`) | all | bus responder | none (no `write:true`) | `domp:*`, `BWNDOM`, `BWNDOMC` | cross-repo parity | `test-domproj-parity.js`, `test-domp-bus.js` |
| Bulk Ops (`bulkOps`, off) | dock `bulk-ops` | drawer | writes `patchWorkOrder` | drawer slot | dry run / typed confirm | `test-bulk-ops.js`, `test-bulk-console.js` |
| Bulk Source (`bulkSource`) | WO list + dock `bulk-source` | row checkboxes + drawer | writes `patchWorkOrder` | drawer slot | blanks-only rule | `test-bulk-source.js` |
| permGate (`permGate`) | all | none (data) | reads `me` | `bwn:perm*`, `__bwnPerm` | fail-open/closed rules | `test-perm-block-ledger.js` |

---

## 7. Test and CI Constraints

**SHA / byte-identity gates.** Editing any of these blocks in Core means editing every copy the same
way.

| Harness | Protects |
|---|---|
| `test-bwn-ops.js` | `BWN-OPS-WRAP` (bwnGqlOp) across adopters |
| `test-perm-block-ledger.js` | `BWN-PERM` in 11 files (Core + 10 companions) + decode negative controls |
| `test-shared-block-ledger.js` | `BWN-SHARED` Auth0 token picker (ADOPTED / PENDING / NA per script) |
| `test-toast-ledger.js`, `test-drawerdismiss-ledger.js` | canonical `toast()` / `drawerDismiss()` |
| `test-a11y-focus.js` | `bwnFocusTrap` bytes + behavior |
| `test-ui-contract-ledger.js` | UI contract (drawer exit, toast motion, reduced motion, rail anchor) per script; every new `bwn-*.user.js` needs a classified row |
| `test-esc-canonical.js` | every HTML-escaper copy fuzzed with breakout payloads |
| `test-manifest-ledger.js` | roster vs metadata (`@updateURL`, `@downloadURL`, `@version`, `@namespace`, SRI pins) |
| `test-domproj-parity.js` | `BWN-DOM` / `BWN-DOMC` vs `broadway-internal-ops` (advisory) |
| `test-registry-authoritative.js` | `BWN_OPS` registry vs call sites |

**Slice-by-marker harnesses.** Moving code or renaming a marker breaks them.
- `BWN-GOV-APPLY-SLICE-START`/`END` → `test-governance-sync.js`
- `BWN-ROUTE` → `test-route-helper.js`
- `BWN-REPORT` → `test-error-reporter.js`
- `BWN-GQL-READ` → `test-bwn-gql-read.js`
- `BWN-OPS` → `test-bwn-ops.js`
- `BWN-PO-API` → `test-po-api.js`
- `WA-WRITES` → `test-a2-taskcreate.js`, `test-b2-statuswrite.js`
- `BWN-ACCT-FILTER` → `test-acct-filter.js`
- `BWN-SETTINGS` → `test-ops-settings.js`
- `BWN-REM-CHANNEL` → `test-reminders-channel.js`
- `COORD-QUEUE` → `test-coord-*.js`
- `BULK-OPS-ENGINE`, `BULK-SOURCE-ENGINE`

63 harnesses read Core's source text. Assume any restructuring touches some of them. Run the full CI
list locally before pushing.

**Test gaps** that are safe to fill later without runtime change:
- Leak Guard matching (word-start tokens, vendor / amount / budget hits)
- BWN Views layout validation against current columns
- WO Assist GP / ETA / DNE / playbook rules where not already sliced
- stale async result after WO-to-WO navigation
- duplicate observers or listeners after repeated navigation
- dock keyboard / focus behavior
- dock duplicate-key overwrite (document current behavior before changing it)

---

## 8. Safe Future Work

Required order. Each step lands and is green before the next one starts.

1. **Pin current duplicate dock-key behavior.** One narrow harness should prove that a second
   `bwn:dock:register` with an existing key overwrites label, icon, weight and so on, and keeps `order`.
   It pins today's behavior; it does not endorse it. No runtime change.
2. **Pure-logic tests, then extraction**, inside the single Core file.
3. **Lifecycle hardening.**
4. **Dock / settings UX.**

| Category | Allowed scope | Key preconditions | Primary risk |
|---|---|---|---|
| Documentation / tests | inventory-backed tests only, no runtime change | this inventory | misreading current behavior |
| Pure logic extraction | helpers stay inside Core, in new marker blocks; existing markers untouched | tests pin output first | SHA-gated and sliced blocks (section 7) |
| Lifecycle hardening | scoped cleanup, stale-result guards, adopt `BWN.onRoute` per module | observers and timers mapped per module (5.1) | SPA regressions, duplicate UI |
| Dock / settings UX | accessibility, focus, local diagnostics | dock contract (3.2) locked; `BWN_DOCK_POLICY` untouched | shared UI contract ledgers, companion drawers |
| **Avoid** without explicit approval + migration plan | bundler, file split, delivery model, event rename or reshape, host-election change, `@grant` change | — | breaks raw delivery and 19 companions |

## Open items (not verified)

- Exact fallback UX for each dock tool when Core is absent.
- Per-module observer/timer teardown on route change.
- Reinjection behavior for modules without a once-only flag.
- Exact op names the bulk engines pass indirectly (beyond the literal call sites in 5.4).
- Purposes of the prefixes listed at the end of 3.5.
- Whether `pushErr` messages can contain page data.
- `bwn:theme` has no listener in the suite (possibly vestigial).
