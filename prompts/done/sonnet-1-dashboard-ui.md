# Phase S1 — Dashboard UI. Paste into a fresh Sonnet session, ONLY after phase O2 is merged.

Read `plan.md` FIRST, in full — plus `DESIGN.md §2` (the six dashboard sections you're
building) and plan §9 build log for what O1/O2 actually built. Execute plan §6 "S1"
under the autonomy protocol §4.

**Hard limits (repeat of plan §4.7): no schema changes, no auth changes, no changes
to the scan/nudge/chat service contracts O1/O2 built.** Call the existing query/
service functions; add new ones only for pure display needs. If you hit a real gap in
what O1/O2 exposed, work around it in the UI layer and note it in `KNOWN-ISSUES.md` +
plan §10 Backlog — do not redesign the service layer to fix it.

Phase rules:
- Branch `phase/s1-dashboard-ui` off latest `main`. If O2 isn't merged, stop.
- Mobile-first — this gets opened on a phone daily. Theme-aware (light/dark), both
  correct. No layout that breaks at phone width.
- Checkbox/short-text writes go straight to Neon via server actions — there is no
  render→fetch→harvest step anymore; don't build one.
- Today's One Thing can stub the runbook content (S2's job) — say so in the build
  log rather than blocking on it.
- Re-runnable; minor issues → `KNOWN-ISSUES.md`; stop only per plan §4.4.

Exit: all six sections (`DESIGN.md §2.1`–`§2.6`) render from real Neon data; a
checkbox tick persists across a reload; no obvious mobile regressions (huge images,
layout shift); PR merged.

## After this phase — hand off to S2 (fresh session)
Per plan §4.9: merge PR green, exit checklist, pre-handoff audit, build-log entry.
Then call `create_session` with inherited environment/permission mode, `model:
"sonnet"`, `prompt: "Read prompts/sonnet-2-runbooks-and-polish.md in this repo and
execute it."` If `create_session` is unavailable, continue in the same window (same
model, no stop required). Never hand off with a red build or an unmerged PR.
