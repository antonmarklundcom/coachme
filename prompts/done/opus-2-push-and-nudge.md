# Phase O2 — Push, PWA, nudge engine, AI chat. Paste into a fresh Opus session, ONLY after phase O1 is merged.

Read `plan.md` FIRST, in full — plus `DESIGN.md §3` (the priority ladder + the
anti-annoyance rules you're porting) and plan §9 build log for what O1 actually
built (interfaces may differ slightly from the plan's sketch — trust the merged
code, not the plan prose, where they disagree). Execute plan §5 "O2" under the
autonomy protocol §4. Build nothing outside the plan.

Phase rules:
- Branch `phase/o2-push-and-nudge` off latest `main`. If O1 isn't merged, stop and
  say so — do not build on an unmerged branch.
- Load `fable-cost-guardrail` before writing anything that names a model — Opus and
  Sonnet only, everywhere in this codebase.
- The AI chat endpoint must be provably read-only: after building it, adversarially
  test it by asking it to change/mark/tick something, and confirm nothing in Neon
  moved. This is part of your exit criteria, not optional polish.
- VAPID keys and any other new secrets go in `.env.example` as documented,
  human-set env vars — never generate-and-commit a real secret into the repo.
- The nudge ladder's anti-annoyance caps (max 1 push/day, max 5/week, no 3-day
  repeat, Sunday silence) are hard rules from `DESIGN.md §3` — test them, don't
  eyeball them.
- Re-runnable; minor issues → `KNOWN-ISSUES.md`; stop only per plan §4.4.

Exit: a manual `/api/nudge` run against seeded data produces a correct action, and an
immediate second run stays silent; a real Web Push notification is delivered after
subscribing in a browser; the app installs to an Android home screen with a real
icon; `/api/chat` answers a real question and is confirmed unable to write state; PR
merged.

## After this phase — hand off to S1 (fresh session, MODEL SWITCH)
Per plan §4.9: merge PR green, exit checklist, pre-handoff audit, build-log entry.
Then call `create_session` with inherited environment/permission mode, **`model:
"sonnet"`** (this is the Opus→Sonnet switch — do not default to Opus), `prompt:
"Read prompts/sonnet-1-dashboard-ui.md in this repo and execute it."` If
`create_session` is unavailable, STOP and report — do not continue in the same
window across a model switch. Never hand off with a red build or an unmerged PR.
