# KNOWN-ISSUES

Non-blocking things a later phase (or a later session) should know. Per
`plan.md` §4.3, minor issues land here rather than stopping a build.

## From phase O1 (2026-08-28)

- **The migration ran against local Postgres 16, not Neon.** No `DATABASE_URL`
  for a Neon database existed in the build session (`plan.md` §7 lists it as a
  before-O1 human input). Everything else about the exit criterion held: real
  Postgres, real DDL, `repos` 53/53 and `stacks` 12/12 matching the JSON,
  `propia.node` carrying its `unblocks`. The schema is plain Postgres with no
  local-only features, so `npm run migrate && npm run seed` against Neon should
  be a re-run, not a port — but it has not been run there yet. **Whoever gets
  the Neon URL first should run it and confirm the same counts.**
- **No `ANTHROPIC_API_KEY` in the build session**, so the scan's classification
  step has never run against the real model. Its degraded path did run: the
  scan fetched commits, PRs, the head SHA and the live-URL check, wrote a
  `scan_events` row and updated the repo. The prompt and the response
  sanitizer are unit-tested; the round-trip to Sonnet is not.
- **GitHub owner-wide listing is not available to every token.** In the build
  session `/users/antonmarklundcom/repos` returned 403 while individual
  `/repos/:owner/:name` calls worked, so `runScan` falls back to probing each
  known repo for its own `pushed_at` (six at a time). With a normal read-only
  PAT the single listing call should work and the fallback stays unused.
- **`stacks.migrations` counts directory entries**, so a repo that keeps
  migrations somewhere other than `drizzle/` or `prisma/migrations/` reports 0.
  The old clone-based scan had the same limitation.
- **The dashboard at `/` is a placeholder.** It proves the gate, the database
  and the scoring service; the six real sections of `DESIGN.md` §2 are phase S1.
- **Nudge history migrated as 0 rows** because `data/nudges.json` has an empty
  history. Nothing lost — noted so a future audit does not read it as a bug.

## Not from O1 — flagging before the first real scan run

A broader manual audit (61 repos, 2026-08-28, outside this repo) is more current
than the 53-repo baseline O1 migrated. Full findings, sorted closest-to-done to
furthest: https://claude.ai/code/artifact/a74e5a0f-cc79-488b-a011-8d816a36fa7c
Three things it surfaces that the migrated `repos` table doesn't have yet —
**the first real scan (once `GITHUB_TOKEN`/`ANTHROPIC_API_KEY` exist) should pick
these up naturally, but flagging in case it doesn't:**
- 8 repos not in the 53-repo baseline at all: `rent`, `content-engine`, `mailer`,
  `aiinsights`, `contenido`, `inteligenciaartificial`, `viaje`, `dentista`.
- `lenceria`, `productos`, `mascota`, `ecom` are literal duplicate clones of one
  e-commerce template (identical file SHAs) — worth a `related`/note flag so scope
  review surfaces them together, not as four independent launch-queue entries.
- `flyttatillspanien` contains an unrelated Paraguay real-estate codebase, not
  Spain-relocation content — likely mislabeled or repurposed; the classifier may
  need a nudge to not just trust the repo name.
