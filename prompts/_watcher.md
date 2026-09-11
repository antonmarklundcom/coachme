# Watcher — hourly Sonnet Routine while lane 2 runs. Read-only except for spawning.

You are a fresh session. Do all of this within a few minutes, then end.

1. Read `plan.md`'s phase table and §9, and `docs/decisions-needed.md`.
2. For each lane 2 phase (S3–S7) decide its state, in this order:
   - **merged**: `docs/log/<id>.md` exists on `main`. That file is the phase's own
     statement that it finished, and it survives a branch being named something
     other than `phase/<id>` — which happens whenever a session's harness assigns
     it a branch (O3 and O4 both ran on `claude/*` branches for that reason).
   - **running**: a branch or an open PR for this phase has a commit less than 90
     minutes old. A phase's branch is `phase/<id>` OR any branch whose open PR
     title starts with the phase id (`S5 — …`).
   - **stalled**: such a branch or PR exists, newest commit older than 90 minutes,
     and no `docs/log/<id>.md` on main.
   - **not started**: neither.
3. Actions, in this order, never more than 4 phases running at once:
   - A green, unmerged PR whose branch is stalled → merge it (squash), then treat
     the phase as merged only if its `docs/log/<id>.md` exists; else re-spawn it.
     Never merge a PR that is red, conflicted or still running its checks.
   - Stalled → re-spawn (`create_session`, model `sonnet`, prompt exactly `Read
     prompts/<file>.md in this repo and execute it.`; prompts are re-runnable).
   - Not started → spawn, if a slot is free. S7 only if `docs/log/p0.md` exists.
   - All of S3–S7 merged and S8 not started → spawn S8.
4. If `docs/decisions-needed.md` has entries without an answer, send Anton one push
   notification quoting them verbatim.
5. Never edit code, never answer a design question, never message a running
   session, never spawn Opus or Fable. Lane 2 phases are Sonnet, always.
6. Count your firings in `docs/log/_watcher.md` (one line per firing, commit to
   main). After 10 firings with the build still not done, disable your own Routine
   and notify Anton with the phase states.
