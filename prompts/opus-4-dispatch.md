# Phase O4 — Dispatch, tracking, ladder rungs, weekly report, watcher. Opus session. Lane 1, last.

Read ONLY: this file, `plan.md` §1 (D-E, D-F, D-G, D-J), §2, §4, §5 O4, the phase
table and §9, and `docs/log/o3.md`. Reference while coding: `lib/scan/github.ts`,
`lib/scan/run.ts`, `lib/nudge/ladder.ts`, `lib/nudge/run.ts`, `app/api/chat/route.ts`
(the owner-gated route pattern), `prompts/_watcher.md`.
Execute under the autonomy protocol §4. Build nothing outside the plan.

Owns (plus §4.9 exceptions): `lib/github/**`, `lib/dispatch/**`, `lib/scan/**`,
`lib/nudge/**`, `lib/report/**`, `app/api/dispatch/**`, `app/api/merge/**`,
`app/api/generate/**`, `app/api/scan/**`, `app/api/nudge/**`, `proxy.ts`,
`prompts/_watcher.md`, `tests/dispatch*.test.ts`, `tests/github*.test.ts`,
`tests/nudge.test.ts`, `tests/scan.test.ts`, `docs/log/o4.md`.

Budget: one session, ≤ 90 min. When the exit criteria pass, open the PR that turn.

Phase rules:
- Branch `phase/o4-dispatch` off latest main. WIP commit every 30 min.
- **D-F is the most important thing in this phase.** `lib/github/write.ts` has three
  exported functions and no others. Tests must fail if anyone adds a delete, a
  force-push, a branch deletion, a path outside `prompts/coachme/`, or a merge of a
  branch outside the allowed prefixes. Read your own diff for it before the PR.
- The `copy` dispatch target must work with no token at all; the app is useful the
  day it deploys even before the PAT exists.
- PR linking must not misfire on unrelated `claude/*` branches: a PR links only by
  `coachme/<slug>` head or the `[coachme:<slug>]` title marker.
- Ladder changes: two rungs on top, everything below untouched; every v2 nudge test
  stays green, add tests for the new rungs and for the Monday report.
- Load `fable-cost-guardrail` before creating the watcher Routine: model
  `claude-sonnet-5`, hourly, fresh session, prompt exactly
  `Read prompts/_watcher.md in this repo and execute it.`
- Re-runnable; minor issues → `docs/log/o4.md`; stop only per §4.4.

Exit: write-guard, dispatch, linking and ladder tests green; one real dispatch
against a scratch repo if the PAT has write scope (else `copy` end-to-end and the
file path against a mock, documented in the log); seeded Monday `/api/nudge` yields
a decision and a `weekly_report`; build/lint/tsc/suite green; PR merged;
`docs/log/o4.md`; §9 line.

## After this phase
Follow `prompts/_handoff.md`. Create the watcher Routine, then spawn ALL lane 2
phases at once, model Sonnet each, up to 4 concurrently: S3 `sonnet-3-work-desk.md`,
S4 `sonnet-4-prompt-library.md`, S5 `sonnet-5-money-desk.md`, S6
`sonnet-6-home-digest.md`; S7 `sonnet-7-portfolio-refresh.md` only if `docs/log/p0.md`
exists (else the watcher starts it later). Then STOP with the phase report.
