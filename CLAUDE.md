# CLAUDE.md - Intermu/userscripts (the BWN Suite)

Standing instructions for Claude when working in this repo.

## NEVER run an unbounded filesystem search (applies to subagents too)

`find /` is effectively a hang on this machine, not a slow command. Measured 2026-09-17: a
subagent ran `find / -iname "bwn-wo-audit.user.js"` and it was still running **60 minutes** later
having produced nothing, holding its parent task open the whole time. Two reasons it never
finishes here:

- OneDrive placeholder directories can trigger per-file network hydration as `find` stats them.
- SentinelOne inspects every `stat`, so each directory entry carries real cost.

Rules - these bind every agent and subagent, not just the main session:

1. **Never `find /`.** Never search from the POSIX root, and never from `/c` either.
2. **Start from the repo root or a named bounded directory.** The repo is at
   `/c/Users/mnajarro/repos/userscripts`; worktrees live under `/c/Users/mnajarro/repos/_wt/`.
   Prefer the Grep and Glob tools over shelling out to `find` at all - they are already scoped.
3. **Use Git Bash paths**, e.g. `/c/Users/mnajarro/...`. A quoted Windows path like
   `"C:\Users\mnajarro"` is WRONG: Git Bash reads the backslashes as escapes, so `find` receives
   the literal string `C:Usersmnajarro`, errors, and - when the caller has appended `2>/dev/null` -
   the error is swallowed and the command silently returns nothing. This exact mistake shipped in
   the same 2026-09-17 command.
4. **Add `-maxdepth` whenever practical.** A bounded `find /c/Users/mnajarro -maxdepth 4 -iname
   "bwn-wo-audit*"` answered the same question in about a second.
5. **Do not background a command you do not need**, and kill one that is no longer needed. A
   `run_in_background` search keeps its task "running" long after the work that wanted it is done,
   which makes a finished agent look stuck.

## Roster changes MUST update the vault wiki (same change, before you call it done)

**Trigger:** whenever the set of shipped userscripts changes -
- a **new** `*.user.js` joins the suite,
- one is **retired / deleted**,
- one is **renamed**, or
- one script's function is **folded into** another (e.g. a floating button absorbed into Core's
  shared dock, or two scripts merged) -

update the canonical roster that lives in the Claude Brain vault, in the same piece of work, before
treating it as finished. Do not leave it "for later"; the wiki is what people install from, so a
stale roster ships a wrong link or hides a script that exists.

Update all of these:

1. **`C:\Users\mnajarro\Documents\Brain\Claude Brain\wiki\userscript-install-links.md`** - the roster
   of record. Add or remove the table row (Script / Version / raw URL) **and** its line in the
   "What each script needs to run (dependencies)" table. Read the version from `origin/main`, never
   from the working tree - the raw URL only serves what is on `origin/main`:
   ```bash
   git show origin/main:<file>.user.js | grep -m1 @version
   ```
2. **`...\wiki\bwn-suite-userscripts.md`** - the suite hub narrative. Reflect the add / retire / fold.
3. **`...\outputs\bwn-userscript-suite-one-pager.html`** - the branded one-pager. Regenerate the
   affected card(s) and republish the artifact (republishing the same file path keeps its URL).
4. If a script's status changed materially, update the matching memory pointer under
   `~\.claude\projects\C--Users-mnajarro-Documents-Brain-Claude-Brain\memory\`.

**A script is "part of the ecosystem" once it is committed to `main` here** - not while it lives only
on a branch, and not as a side-load. BWN GraphQL Capture is TEMPORARY side-load-only, never committed
and never installed by URL, so it stays **out** of the roster on purpose.

Then fold both the repo and the vault into the same session's write-back.
