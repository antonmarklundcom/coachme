# KNOWN-ISSUES

Non-blocking things a later phase (or a later session) should know. Per
`plan.md` §4.3, minor issues land here rather than stopping a build.

## From phase S1 (2026-08-28)

- **The runbook shown in Today's One Thing is a stub, as planned.** It renders
  O1's stored `stacks` row (package name, engine, migrations count, the names
  of env vars to set) rather than the full copy-paste runbook — the generator
  (`src/runbook.js` + `templates/runbook-*.md`) is phase S2's job (plan.md §6
  S1 says exactly this is allowed). A repo with no `stacks` row yet just says
  so and points at the next scan.
- **The old template's manual "Not today — shrink it" checkbox is dropped, on
  purpose.** `DESIGN.md §2.1` describes an owner-initiated escape hatch, but
  `settings.session_state.shrink` is not that any more: O2's ladder
  (`lib/nudge/ladder.ts`) now owns that field itself — it sets it on the
  automated day-3 shrink escalation, and the comment on `SessionState.shrink`
  says the dashboard only *renders* the smaller ask. Wiring a checkbox to it
  would let the owner flip a flag the ladder's own history-based state machine
  (`chainLength`, `shrunkIgnored`, `isMuted`) does not expect to move on its
  own, corrupting the escalation the hard limit (plan.md §4.7) forbids
  redesigning. Instead, Today's One Thing reads whatever the ladder actually
  decided today (`nudges` for today's `local_date`) and renders the shrunk or
  question form read-only when that is what O2 chose. If a manual override is
  wanted later, it needs its own field and its own decision, not this one —
  see Backlog.
- **Still local Postgres, still no Neon `DATABASE_URL` or `ANTHROPIC_API_KEY`
  in the build session** — unchanged from O1/O2, and nothing in S1 needed
  either: the dashboard was exercised end to end (all six sections, a launch-
  queue clear, a quick-decision accept, and the shrunk/question One Thing
  states) against the same local Postgres 16 O1 seeded. **Whoever gets the
  Neon URL first should still be the one to run `npm run migrate && npm run
  seed` there.**
- **No `lighthouse` binary in this build session**, so the exit criterion's
  "Lighthouse mobile score reasonable" was checked structurally instead of
  numerically: the page ships no images (nothing to cause CLS or a large
  unoptimized asset), fonts are self-hosted via `next/font/google` (no
  render-blocking external font request, `font-display: swap` by default),
  and the real pre-installed Chromium at a 390×844 mobile viewport showed no
  layout shift or overflow across all six sections in both themes.

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

## From phase O2 (2026-08-28)

- **Still no Neon `DATABASE_URL` in the build session.** O2 ran, like O1,
  against a local Postgres 16: `migrations/0002_nudge_engine.sql` applied
  cleanly there and the nudge engine was exercised end to end against the real
  seeded data, but neither migration has yet run against Neon. Nothing in 0002
  is local-only (four `ADD COLUMN`s, a `CHECK` swap and an index), so it should
  be a re-run, not a port. **Whoever gets the Neon URL first should run
  `npm run migrate && npm run seed` there and confirm the counts.**
- **Still no `ANTHROPIC_API_KEY`, so `/api/chat` has never called the real
  Sonnet.** Everything either side of that one hop is verified: the endpoint
  loads the repo's real row and stack metadata, builds the grounded prompt,
  sends `model: claude-sonnet-5`, and returns the reply as a string (see the
  §9 build log for the transcript). Only the inference itself is unexercised —
  the same gap O1 recorded for the scan classifier, and the same fix: set the
  key and ask `/api/chat` one real question.
- **Real Web Push could not traverse a real push service from this container.**
  Chromium's `pushManager.subscribe()` needs an outbound connection to Google's
  FCM servers, which the sandbox blocks, so it hangs. Both halves were proven
  separately instead, and thoroughly (§9): the send half against a real push
  service stand-in, with the VAPID ES256 signature verified against the public
  key; the receive half in a real Chromium, delivering the payload to the real
  `public/sw.js` over CDP. The untested link is the FCM hop, which is not this
  app's code. **Anton's first real device subscription (the §7 human step after
  S2) is still what confirms the whole chain.**
- **`npm audit` reports 5 vulnerabilities, all in the vitest/vite dev
  toolchain** (esbuild's dev-server advisory, inherited through `vitest@2`).
  Nothing ships them — they are devDependencies of the test runner — so the
  fix (a vitest 3 major bump) was left out of a phase that had no other reason
  to touch the test runner. Worth doing in S2's polish pass.
- **The nudge history is not pruned.** One row a day forever is a few hundred
  rows a year, and every read walks the whole table backwards. Fine for years;
  worth an index-backed window or a prune if it is ever not.

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
