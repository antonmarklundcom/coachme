# Phase S2 — Runbooks, scope review, chat UI, deploy polish. Paste into a fresh Sonnet session, ONLY after phase S1 is merged. Final phase — no further handoff.

Read `plan.md` FIRST, in full — plus `src/runbook.js` and `templates/runbook-*.md`
(what you're porting) and plan §9 build log for what O1/O2/S1 actually built.
Execute plan §6 "S2" under the autonomy protocol §4.

**Hard limits (repeat of plan §4.7): no schema changes, no auth changes, no changes
to the scan/nudge/chat service contracts.** Same rule as S1.

Phase rules:
- Branch `phase/s2-runbooks-and-polish` off latest `main`. If S1 isn't merged, stop.
- Runbook output must never contain a real credential — placeholders only
  (`<PASTE_PASSWORD>` etc.), exactly like the existing `runbooks/*.md` files. Diff
  your output against one of those as a sanity check.
- Scope-review kill sets a flag only — it must never call any GitHub API that
  archives or modifies a repository. Verify this by reading your own diff for any
  GitHub-write call before merging.
- Confirm the Cron jobs are actually scheduled on the *deployed* Vercel app, not just
  present in `vercel.json` locally — check the Vercel dashboard/API if you have
  access, or clearly instruct the owner how to verify it themselves if you don't.
- Re-runnable; minor issues → `KNOWN-ISSUES.md`; stop only per plan §4.4.

Exit: a runbook page for a real DB-blocked repo (e.g. `besikt`) matches the quality
bar of the existing `runbooks/besikt.md`; a scope-review kill tick sets the `killed`
flag and the repo drops out of the launch queue; the chat panel answers a real
question against production data; the app is live at its Vercel URL and reachable
from a phone; PR merged.

## This is the final phase — STOP and report
No further handoff. In your final report, give: the live Vercel URL; the human-inputs
checklist (plan §7) with what's still outstanding vs. done; and the exact next manual
step for the owner (open it on Android, add to home screen, accept the push
permission prompt, then book the first DB session — the entire point of this tool).
