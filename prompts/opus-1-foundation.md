# Phase O1 — Foundation. Paste into a fresh Opus session.

Read `plan.md` FIRST, in full — plus `DESIGN.md` (the coaching logic you're
implementing) and `SCAN.md` (the incremental-scan rules you're porting). Also skim
`data/portfolio.json`, `data/decisions.json`, `data/stacks.json`, `data/nudges.json` —
this is the seed data you migrate into Neon. Execute plan §5 "O1" under the autonomy
protocol §4. Build nothing outside the plan.

Phase rules:
- Branch `phase/o1-foundation` off latest `main`.
- Load `nodejs-mysql-hostinger-stack` for stack conventions if useful, but this is
  Vercel + Neon, not Hostinger — don't apply Hostinger-specific steps.
- Load `fable-cost-guardrail` before writing anything that names a model — Opus and
  Sonnet only, anywhere in this codebase, ever.
- The schema in plan §2 is the whole schema, even though later phases use most of
  it — don't retrofit tables later.
- The migration script must actually run once against a real Neon database as part
  of your exit criteria, not just exist as a dry run.
- The scan service's drift-guard behavior (percentage-down and reclaimed-blocker
  never auto-apply) is a foundation decision Sonnet phases cannot safely redesign —
  get it right per `SCAN.md`'s "What the scan may and may not change" table.
- Re-runnable; minor issues → `KNOWN-ISSUES.md`; stop only per plan §4.4 (missing
  credential with no fallback, or a schema/auth/scan-contract call risky to guess).

Exit: `npm run build` green; migration run against real Neon, row count matches
`data/portfolio.json`; `/login` gates every other route; scan endpoint writes at
least one `scan_events` row when triggered with real credentials (or documents why
it couldn't, per the graceful-degradation rule); scoring-invariant unit test passes;
PR merged.

## After this phase — hand off to O2 (fresh session)
Per plan §4.9: merge PR green, run the exit checklist, do the pre-handoff audit
(re-run build/tests, adversarially re-read your own diff, fix what you find), commit
a build-log entry to plan §9. Then call `create_session` with: inherited
environment/permission mode (never `plan` mode), `model: "opus"`, `prompt: "Read
prompts/opus-2-push-and-nudge.md in this repo and execute it."` If `create_session`
is unavailable, continue in the same window (same model, so no stop is required) and
say so in your report. Never hand off with a red build or an unmerged PR.
