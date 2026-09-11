# Phase O3 — Launch model, generator, ranking. Opus session. Lane 1, first.

Read ONLY: this file, `plan.md` §1, §2, §4, §5 O3, the phase table and §9, and
`docs/report-2026-09-11.md` §2 (what the product is now). Then, as reference while
coding: `lib/domain.ts`, `lib/queries.ts`, `lib/score.ts`, `lib/scan/classify.ts`
(the sanitizer pattern to copy), `migrations/0002_nudge_engine.sql` (migration
style). Execute under the autonomy protocol §4. Build nothing outside the plan.

Owns (plus the §4.9 append-only exceptions): `migrations/0003_*.sql`,
`lib/domain.ts`, `lib/queries.ts`, `lib/score.ts`, `lib/launch/**`,
`lib/generate/**`, `templates/prompts/**` (the two exemplars + `index.json`),
`scripts/seed.ts`, `data/portfolio.json` (stage/revenue fields only),
`tests/launch*.test.ts`, `tests/generate*.test.ts`, `tests/score.test.ts`,
`.env.example`, `docs/log/o3.md`.

Budget: one session, ≤ 90 min. When the exit criteria pass, open the PR that turn.

Phase rules:
- Branch `phase/o3-launch-model` off latest main. WIP commit every 30 min.
- Load `fable-cost-guardrail` before writing anything that names a model; the
  generator calls `claude-sonnet-5` through `lib/anthropic.ts`, nothing else.
- §2 is the whole contract: every column, every enum, every transition. Later
  phases cannot add to it. If §2 is wrong, fix §2 in the same PR and say so in the
  log; do not quietly diverge.
- The generator's mandatory prompt header is the thing every dispatched agent will
  read first: branch `coachme/<slug>`, PR title `[coachme:<slug>] <title>`, "read
  AGENTS.md and CLAUDE.md first", concrete exit criteria, "open the PR when they
  pass and stop". Write it once in `lib/generate/prompt.ts` and test that every
  generated item starts with it.
- "Omit rather than guess" for the generator, exactly as `SCAN.md` says for the scan.
- No `DATABASE_URL` → local Postgres 16 (`sudo service postgresql start`), as v2 did.
- Re-runnable; minor issues → `docs/log/o3.md`; stop only per §4.4.

Exit: build, lint, `tsc --noEmit`, full suite green; migration + seed on a real
Postgres with every repo carrying a stage; one real (or documented-degraded)
`generateForRepo` run producing ≤ 3 `proposed` items with the header; the new
ranking test green; PR merged; `docs/log/o3.md` written; §9 line added.

## After this phase
Follow `prompts/_handoff.md`. Next: `prompts/opus-4-dispatch.md`, model Opus.
