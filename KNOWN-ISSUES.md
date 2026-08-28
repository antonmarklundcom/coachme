# KNOWN-ISSUES

Non-blocking things a later phase (or a later session) should know. Per
`plan.md` §4.3, minor issues land here rather than stopping a build.

## From phase S2 (2026-08-28)

- **The app has never actually been deployed to Vercel.** Checked directly this
  time, not just inferred from a missing env var: PR #16's (phase S1) check runs
  are exactly the three GitHub Actions jobs (`node (20)`, `node (22)`, `build`) —
  no Vercel deployment check at all, which is what a linked Vercel project posts
  on every PR. No phase (O1, O2, S1, S2) has had Vercel or Neon credentials, so
  this was never going to be caught earlier — but it means plan.md §6 S2's exit
  criterion "the app is live at its Vercel URL and reachable from a phone" is not
  met by this PR alone, and can't be: it needs Anton's Vercel account, which no
  Claude Code session has access to. **`DEPLOY.md` (new this phase) is the exact
  checklist** — create the Vercel project, set the six env vars, run the
  migration against the real Neon database, confirm the two cron jobs actually
  show up in the Vercel dashboard's Cron Jobs tab (also unverifiable from here),
  then the phone install. This is the single biggest thing left before this tool
  does its job.
- **Lighthouse was available in this build session** (`npx lighthouse`, unlike
  every prior phase) — run against a real `next start` production build, not
  `next dev` (dev mode's unminified bundle badly understates performance; a
  first pass against it scored 0.79/before-fixes on performance alone). Real
  numbers, mobile, authenticated: **performance 0.95, accessibility 1.00,
  best-practices 1.00**, closing the "no lighthouse binary" gap S1 left in
  KNOWN-ISSUES. Two real findings came out of it and were fixed, not just
  measured:
  - `--ink-3` (the light-mode label/eyebrow color) only cleared 3.1–3.65:1
    contrast against this page's backgrounds — short of WCAG AA's 4.5:1. Darkened
    to `#606b78` (light) / `#7c8996` (dark, which had the same problem at
    4.07–4.50:1). Accessibility went from 0.95/0.96 to a clean 1.00.
  - `/robots.txt` didn't exist, so a crawler (and the SEO audit) got the
    `/login` redirect instead — `proxy.ts`'s owner gate didn't exempt it, unlike
    `/manifest.json` and `/sw.js`. Added `public/robots.txt` (`Disallow: /` —
    this is a private single-user tool, it should say so) and opened the path.
    This does drop the SEO category score (`is-crawlable` now correctly fails —
    the page is deliberately blocked from indexing), which is the right
    tradeoff for an app holding Anton's business situation, not a regression.
- **The runbook generator is ported and wired in** (`lib/runbook.ts` +
  `lib/render.ts` + `lib/markdown.ts`, replacing S1's `RunbookStub`), verified
  the strongest way available: every repo in `data/stacks.json` renders
  byte-identical to its existing `runbooks/*.md` file from the 2026-08 baseline
  (`tests/runbook.test.ts`). `next.config.ts` gained `outputFileTracingIncludes`
  for `templates/*.md` — without it the runbook works in `next dev` (repo
  checkout on disk) but would silently 500 on Vercel, where only traced files
  ship in the serverless bundle; confirmed present in the real build's
  `.next/server/app/page.js.nft.json`.
- **The chat panel UI is wired to `/api/chat`** (`app/components/ChatPanel.tsx`),
  in the same per-repo `<details>` as the runbook (Today's One Thing) and also on
  each Launch Queue row, since "why is X blocked" is asked from there just as
  often. Tested against a real (local Postgres) database end to end: the panel
  correctly surfaces the endpoint's documented 503 ("needs ANTHROPIC_API_KEY")
  since no key exists in this build session either — the same unexercised gap
  O2 recorded for the model round-trip itself, now also unexercised one layer up
  at the UI. Whoever sets `ANTHROPIC_API_KEY` first should ask a real question
  through the UI, not just `curl` the endpoint.
- **Scope review needed no new code.** S1's build log already said its "Scope
  review UI" item was done in S1, and plan.md §6 S2's own item was redundant —
  confirmed this phase by reading the diff: `applyScopeAnswer` / `applyScope` /
  `ScopeReview.tsx` contain no GitHub call of any kind (grepped for it), and a
  live kill through the UI (local Postgres, `yt` forced into scope-review-due for
  the test) set `killed_at` and dropped the repo out of the due list on reload,
  exactly as designed.
- **Still local Postgres, still no Neon `DATABASE_URL` in the build session** —
  see the Vercel item above; this is the same root cause. `npm run migrate &&
  npm run seed` against local Postgres 16 (fresh cluster, this session) matched
  O1's original counts (53 repos, 12 stacks, 6 decisions).

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
