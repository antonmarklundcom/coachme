# plan.md — coachme, Vercel + Neon rebuild

Supersedes the "Architecture (settled — do not re-open)" note in `README.md` and the
PR sequence in the old `PLAN.md`. Anton reopened the delivery-architecture decision
on 2026-08-28 and chose Vercel + Neon over the Claude-Artifact/Routine design. The
**coaching logic is not changing** — `DESIGN.md` (leverage scoring, the six dashboard
sections, the priority ladder, the drift guard) is still the spec. This plan only
changes where it runs and how state is stored.

Old `PLAN.md`, `ROUTINE.md`, `SCAN.md` become historical record of the first build —
do not delete them, but do not follow their PR sequence or their "no hosting, ever"
constraint. `DESIGN.md` stays authoritative for *what* the coach does.

| Phase | Model | Prompt file | Plan sections |
|---|---|---|---|
| O1 | Opus | `prompts/opus-1-foundation.md` | §2, §5 O1 |
| O2 | Opus | `prompts/opus-2-push-and-nudge.md` | §5 O2 |
| S1 | Sonnet | `prompts/sonnet-1-dashboard-ui.md` | §6 S1 |
| S2 | Sonnet | `prompts/sonnet-2-runbooks-and-polish.md` | §6 S2 |

---

## 1. Decisions already made — do not re-litigate

- **Platform: Next.js (App Router) on Vercel, Postgres on Neon.** Chosen over
  Hostinger specifically to avoid spending one of Anton's three limited Hostinger
  Node.js slots on a meta-tool instead of a revenue app. If Vercel/Neon ever stops
  making sense, the app is plain Next.js + Postgres and can redeploy to a Hostinger
  slot later — nothing here is Vercel-proprietary by design.
- **Port, don't rewrite.** `src/score.js` (leverage scoring), `src/runbook.js`
  (runbook generation), the incremental-scan logic in `SCAN.md`, and the priority
  ladder in `DESIGN.md §3` are the algorithms. This build re-implements them against
  Neon + API routes; it does not redesign them.
- **Seed from existing state.** `data/portfolio.json`, `decisions.json`,
  `stacks.json`, `nudges.json` are the seed data — a one-time migration into Neon,
  not a re-audit. The 2026-08 baseline audit still counts as every repo's last scan.
- **Single-owner auth.** Anton is the only user. A signed shared-secret cookie is
  enough — no user table, no OAuth, no roles.
- **v1 real-time = Cron polling, not per-repo webhooks.** Installing a GitHub webhook
  on all 53+ repos (or standing up a GitHub App) is real setup cost for marginal gain
  over a cheap `pushed_at` poll every few hours. Vercel Cron + the existing
  incremental-scan logic (only deep-read what actually changed) is v1. A GitHub App
  for true push-based real-time is Backlog (§10), not blocking.
  **Hobby-plan cron budget:** Vercel Hobby allows **2 cron jobs, max once/day each,
  with up to ~an hour of timing slop.** This build uses exactly both (scan + nudge)
  — never add a third cron without upgrading the plan or multiplexing one endpoint.
  The slop also means the old "scan fires an hour before the nudge" ordering is not
  guaranteed; schedule the scan ≥3h before the nudge (see O1) so fresh state always
  precedes the morning push.
- **AI judgment via direct Anthropic API calls, not Claude Code sessions.** The old
  design's deep-scan ran inside a Claude Code Routine session (can clone repos, run
  arbitrary tools). The new scan runs inside a Vercel serverless function: it can only
  call the GitHub REST API (file contents, commits, PRs) and the Anthropic Messages
  API (`claude-sonnet-5` — **never Fable**, see `fable-cost-guardrail`) for
  classification. This is cheaper and fits a function timeout; it cannot clone a repo
  or run shell commands, so judgments are text-in/text-out from fetched file content.
  Two duties the old clone-based scan carried move with it explicitly: (a) the
  **stack-metadata refresh** (`src/runbook.js --scan` read local clones to build
  `data/stacks.json`; the new deep scan fetches `package.json`, `.env.example`, and
  the drizzle/prisma config via the contents API instead, so runbooks never
  fossilize at the migrated snapshot), and (b) the **live-URL check** (a plain
  `fetch` of `live_url` from the function — `live_url_ok` stays evidence-based,
  never inferred).
- **Push notifications are real Web Push (VAPID)**, replacing "push via the Claude
  app." The dashboard becomes an installable PWA (Android/iOS home-screen icon).
- **AI chat panel is read-only advice**, grounded in a repo's stored row — it answers
  "why is X blocked" / "what should I do next," it does not mutate state. Ticking
  things stays a deliberate user action, per the drift-guard principle in
  `DESIGN.md §1c` / `SCAN.md` ("a scan is an estimate, a tick is a fact").
- **D0 stands regardless of this rebuild:** the `coachme` repo is still public and
  holds `data/portfolio.json` (Anton's business situation). Make it private
  immediately — unrelated to which platform runs the dashboard.

## 2. Roles & object model

One role: **owner**. No multi-tenancy, no other users, no permission tiers.

Neon schema (Postgres), written in full in Phase O1 even though later phases use
most of it — see `DESIGN.md §5` for what each field feeds:

- **repos** — `id, name, github_full_name, pct, lane, blocker, tier, hostinger_account,
  next_step, open_prs, merged_prs_30d, live_url, live_url_ok, launched_at,
  unblocks jsonb, depends_on jsonb, related jsonb, unblocks_revenue boolean, notes,
  cleared_blockers jsonb, snoozed_until, scope_review_due boolean,
  scope_reviews_unanswered int, killed_at nullable, last_commit_at,
  last_scan_at, last_scan_head_sha, created_at, updated_at`. Lane/blocker enums match
  `data/portfolio.json` meta exactly (`lanes`, `blockers` arrays) — do not invent new
  values without updating `DESIGN.md`. The graph fields (`unblocks`, `depends_on`,
  `related`, `unblocks_revenue`, `notes`) exist in `data/portfolio.json` today and
  feed `unblock_weight` in `DESIGN.md §4` / `src/score.js` — dropping them in the
  migration would silently gut the scoring. `cleared_blockers` (list of
  `{blocker, date}`, see `src/portfolio.js`) is what the drift guard checks to know
  a blocker was **owner**-cleared — without it, "a blocker reappearing on a repo the
  owner ticked clear" is undetectable. `snoozed_until` / `scope_review_due` /
  `scope_reviews_unanswered` / `killed_at` carry the scope-review state machine
  (`DESIGN.md §2.5`, `src/scope.js` — two ignored reviews auto-propose snooze);
  `launched_at` feeds the momentum strip's "launches this month".
- **stacks** — `repo_id, engine, dialect, package_manager, migrations int,
  scripts jsonb, env_file, env_session jsonb, env_deferred_count, notes jsonb,
  scanned_at` — one row per DB-blocked repo, seeded from `data/stacks.json`,
  refreshed by the deep scan (§5 O1). This is what the runbook generator (S2)
  renders from; never credentials, only names of env vars.
- **decisions** — `id, question, needed_for, recommended, why, status
  (pending|accepted|corrected), answer, batch, created_at, resolved_at`.
- **nudges** — `id, repo_names jsonb, type, sent_at, outcome, shrunk boolean, note` —
  the anti-annoyance state machine's history (`DESIGN.md §3`). `repo_names` is a
  list, not a single FK: one nudge covers a whole DB batch ("45 min unblocks 3
  launches"), and the per-repo cooldown rule needs every name. The daily/weekly
  caps are evaluated in the owner's timezone from `settings`, not UTC.
- **scan_events** — `id, repo_id, source (cron|manual), findings jsonb, applied
  boolean, verify_reason text nullable, resolved_at nullable, resolution
  (confirmed|rejected) nullable, created_at` — every scan result, whether
  auto-applied or held as a drift-guard verify item. `resolved_at`/`resolution` are
  how a verify item leaves the dashboard once the owner answers it. This table is
  the audit trail; never overwrite `repos` directly from a scan without writing the
  event first.
- **push_subscriptions** — `id, endpoint, keys jsonb, created_at`.
- **settings** — single row: `owner_timezone, hpanel_baseline_minutes,
  scope_review_last, session_state jsonb`. Seeded from `data/config.json`
  (`owner_timezone` drives "today"/Sunday-silence/one-push-a-day;
  `hpanel_baseline_minutes` is the momentum burn-down baseline). `session_state`
  mirrors the old `portfolio.session` object — `{batch, booked, when, done,
  done_date}` — which ladder rules 1–2 and the momentum-repeat push read
  (`src/select.js`); the "☐ Booked (when?)" card writes it.
- **auth_sessions** — `id, cookie_hash, created_at, expires_at` for the owner auth
  gate (or a stateless signed cookie if the implementer prefers — pick one in O1,
  record the choice in the build log). Named `auth_sessions`, not `sessions` — in
  this app a "session" means a booked hPanel sitting, and that collision would
  confuse every later phase.

## 3. Feature scope

**Ported 1:1 from the existing design (behavior must match `DESIGN.md`):**
1. Six-section dashboard: Today's One Thing, Launch queue, Quick decisions inbox,
   Agent lane, Scope review, Momentum strip (`DESIGN.md §2`).
2. Leverage scoring and DB-batch composition (`DESIGN.md §4`, `src/score.js`).
3. Runbook generator (`src/runbook.js`, `templates/runbook-*.md`) — placeholders
   only, never real credentials, ever.
4. Daily priority ladder + anti-annoyance rules (`DESIGN.md §3`).
5. Incremental scan (cheap listing → deep-scan only what moved) and the drift guard
   (percentage down, or a blocker reappearing on a repo the owner ticked clear, is
   never auto-applied — always a verify item).

**New, because Vercel + Neon makes it possible:**
6. Real Web Push notifications + installable PWA manifest/service worker.
7. AI chat panel (Sonnet via Anthropic API), read-only, grounded in one repo's row.
8. Live writes (checkbox ticks hit Neon directly via server actions) — the old
   render→WebFetch→harvest round-trip is gone; there is nothing to harvest.

## 4. Autonomy protocol

1. Work each phase to its exit criteria; never ask permission for in-plan work.
2. One PR per phase: branch `phase/<id>` off latest `main`; open, watch, and merge
   when green. Never start a phase on top of an unmerged previous one.
3. Minor non-blocking issues → `KNOWN-ISSUES.md`, keep building.
4. Stop and ask ONLY for: a missing credential with no graceful fallback (see §7 —
   most have one), or a bad-foundation call (schema shape, auth shape, the
   scan/drift-guard contract) where guessing wrong forces a rewrite. Everything else:
   choose reasonably, record the choice in §9, continue.
5. Missing env values never block: document in `.env.example`, degrade gracefully
   (e.g. no `ANTHROPIC_API_KEY` yet → scan endpoint no-ops with a clear log line, UI
   still renders from seeded data).
6. Every phase prompt is re-runnable: check what exists on the branch first, continue
   from the first unmet exit criterion.
7. Sonnet phases (S1, S2) hard limit: **no schema changes, no auth changes, no
   changes to the scan/scoring service contracts built in O1/O2.** UI and page data
   access only through the query/service layer Opus built. Found a real foundation
   gap? Work around it and note it in `KNOWN-ISSUES.md` + Backlog — do not silently
   redesign.
8. **Model cost guardrail**: Fable is never used for any phase, subagent, or
   scheduled job in this build. Phase table below only ever names Opus and Sonnet.
   If something seems to genuinely need Fable, stop and ask Anton first, in his
   current conversation — do not spawn it.
9. **Phase handoff** — hand off only once: PR merged green; phase's exit checklist
   passed; pre-handoff audit done (re-run build + tests, re-read your own merged diff
   adversarially, fix what you find — this is the last cheap moment); build-log entry
   committed to §9. Then spawn the next phase as a **new session** via
   `create_session`: inherit environment/permission mode (never `plan` mode for an
   unattended child), set `model` per the phase table, `prompt` exactly
   `Read prompts/<next-file>.md in this repo and execute it.` End with a phase report.
   If `create_session` is unavailable, continue in the same window for a same-model
   phase, or stop and report at a model switch.
10. **Build log**: before merging, append a dated 5–10 line entry to §9 — phase id +
    PR, what now exists, decisions/deviations from this plan, where the next phase
    should look first. Fresh sessions orient from `plan.md` + §9 + `KNOWN-ISSUES.md`
    only — keep it tight so they stay cheap.

## 5. Model-A (Opus) phases

### O1 — Foundation: Next.js/Vercel scaffold, Neon schema, migration, scan service
- `create-next-app` (App Router, TypeScript) committed to this repo's root (existing
  `src/*.js` scripts move to `scripts/legacy/` — kept for reference, not deleted; the
  new app supersedes them but the algorithms they encode must be ported faithfully).
- Neon connection via `@neondatabase/serverless` or `pg` — implementer's call, record
  it in §9. Write the full schema from §2 as SQL migrations (a `migrations/` folder,
  plain SQL, no ORM required unless the implementer strongly prefers one — if so,
  Drizzle, matching Anton's usual stack per `nodejs-mysql-hostinger-stack`).
- One-time migration script: read `data/portfolio.json` + `decisions.json` +
  `stacks.json` + `nudges.json` + `data/config.json` (timezone, hPanel baseline →
  `settings`) from this repo, write into Neon. Carry **every** repo field —
  `unblocks`, `depends_on`, `related`, `notes`, `cleared_blockers` included, not
  just the obvious columns; the scoring graph lives in those. Run it once against
  the real database as part of this phase's exit criteria (not just as a dry run).
- Owner-auth: a `/login` route gated by a shared secret (`OWNER_SECRET` env var),
  setting a signed httpOnly cookie checked by middleware on every other route —
  **except the cron endpoints** (`/api/scan`, later `/api/nudge`): Vercel Cron
  requests carry no owner cookie, so blanket middleware would 401 the coach's own
  heartbeat. Exclude those routes from the cookie check and require
  `Authorization: Bearer $CRON_SECRET` on them instead (Vercel sends it
  automatically when `CRON_SECRET` is set in project env), so they are neither
  owner-gated nor open to the public internet.
- Port `src/score.js`'s leverage formula (`DESIGN.md §4`) into a service module that
  queries Neon and returns the ranked launch queue + DB-batch composition. Unit-test
  the same invariant the old code tested: a 95%-done infra repo must outrank any
  early-stage repo under every reasonable coefficient choice.
- Scan service (`app/api/scan/route.ts` or similar), callable by Vercel Cron:
  1. cheap listing — GitHub API `pushed_at` per repo (or `git ls-remote` fallback);
  2. `shouldDeepScan(repo)` — same conditions as old `SCAN.md` ("Why it is
     incremental" table): pushed since last scan, head moved, never scanned, blocker
     unclassified, record 30+ days stale;
  3. for each repo needing a deep scan, fetch relevant file contents via the GitHub
     API (the `SCAN.md` shortlist: PLAN.md/PROGRESS.md/TASKS.md/ROADMAP.md/
     CLAUDE.md/AGENTS.md/README.md, recent commits, open + recently-merged PRs) and
     call the Anthropic Messages API (`claude-sonnet-5`) with a prompt adapted from
     `SCAN.md`'s scan prompt, asking for the same fields (`pct, blocker, lane,
     next_step, open_prs, live_url_ok, ...`) as strict JSON — keep `SCAN.md`'s
     "omit a field rather than guess it" rule verbatim;
  4. for a repo whose blocker is `db-setup` (or newly classified as such), also
     fetch `package.json`, `.env.example`, and the drizzle/prisma config and upsert
     the `stacks` row — this replaces the old `runbook.js --scan` clone-based
     refresh; and if the repo has a `live_url`, `fetch` it — a URL that answers is
     the launch signal (`SCAN.md`: launched at 100%, set `launched_at`);
  5. write every result to `scan_events`; apply the drift-guard rules from
     `SCAN.md` ("What the scan may and may not change") — percentage down or a
     blocker reappearing on an owner-cleared repo (per `cleared_blockers`) is
     written as `applied: false` with a `verify_reason`, never silently
     overwriting `repos`.

  The scan must fit a serverless timeout: cap deep scans per invocation (~5, worst
  case is a Sonnet call each) and make the endpoint resumable — `last_scan_at` /
  `last_scan_head_sha` already encode progress, so a re-trigger continues where the
  last run stopped instead of starting over. A cron firing that finds more work
  than its cap does the first N and leaves the rest for the next firing (or a
  manual re-trigger) — never one long invocation racing the timeout.
- Vercel Cron entry (`vercel.json`) firing the scan Mon/Thu at **04:00
  America/Asunción** (`0 7 * * 1,4` UTC — Paraguay is permanently UTC-3, no DST) —
  earlier than the old 07:00 because Hobby cron timing has up to an hour of slop
  (§1) and the scan must reliably land before O2's 08:00 nudge.
- `.env.example` documenting `DATABASE_URL`, `OWNER_SECRET`, `CRON_SECRET`,
  `ANTHROPIC_API_KEY`, `GITHUB_TOKEN` (read-only PAT) — all optional at build time,
  required at runtime, each with a documented graceful-degradation behavior if
  absent.
- **Exit:** `npm run build` green; migration script run once against real Neon with a
  `repos` row count matching `data/portfolio.json`, a `stacks` row count matching
  `data/stacks.json`, and one spot-checked repo (`propia.node`) whose migrated row
  still carries its `unblocks` list; `/login` gates every route except the
  `CRON_SECRET`-gated cron endpoints; hitting the scan endpoint locally (with a real
  `GITHUB_TOKEN`/`ANTHROPIC_API_KEY` in `.env.local`, or documented as skipped if
  unavailable) writes at least one `scan_events` row; unit tests for the scoring
  invariant pass; PR merged.

### After O1 — hand off to O2 (fresh Opus session)
Per §4.9: merge PR, pre-handoff audit, build-log entry, then
`create_session(model: "opus", prompt: "Read prompts/opus-2-push-and-nudge.md in this repo and execute it.")`.
Fallback if `create_session` unavailable: continue in the same window (same model).

### O2 — Nudge engine, Web Push, PWA, AI chat endpoint
- Port `DESIGN.md §3`'s priority ladder + anti-annoyance state machine into a
  `app/api/nudge/route.ts` driven by Vercel Cron (daily, 08:00 America/Asunción =
  `0 11 * * *` UTC, the answered D1 time; gated by `CRON_SECRET` like the scan —
  this is the second and final cron in the Hobby budget, §1). It reads `repos` +
  `nudges` + `settings` (owner timezone decides "today", Sunday silence, and the
  caps; `session_state` feeds ladder rules 1–2 and the momentum repeat) from Neon,
  decides today's action (or silence) by the same six-rule ladder, writes a
  `nudges` row, and — if a real action was produced — sends a Web Push
  notification.
- Web Push: generate a VAPID keypair (document it in `.env.example` as
  `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`, generated once and committed to Vercel env,
  never to the repo), a `/api/push/subscribe` route storing `push_subscriptions`, and
  client-side subscription code triggered from the dashboard.
- PWA: `manifest.json` + a minimal service worker (cache-shell only, no complex
  offline logic — this is a status dashboard, not an offline-first app) so Android
  Chrome's "Add to Home Screen" installs a real app icon and Web Push works.
- AI chat endpoint (`app/api/chat/route.ts`): given a `repo_id`, load that repo's row
  (+ recent `scan_events`) from Neon, call the Anthropic Messages API
  (`claude-sonnet-5`) with that context and the owner's question, return the answer.
  **Read-only** — this endpoint must not write to `repos`, `decisions`, or anything
  else. Rate-limit or cap it modestly (this is a personal tool, not a public API) —
  implementer's call, record it in §9.
- **Exit:** a manually-triggered `/api/nudge` run against seeded data produces a
  correct action from the ladder, and a second immediate run stays silent (same test
  the old `ROUTINE.md` specified); subscribing to push in a browser and firing a test
  nudge delivers a real notification — the pre-installed headless Chromium (grant
  notification permission programmatically) is an acceptable stand-in for a phone;
  Anton's real device subscribes after S2 (§7); the manifest + service worker pass
  Lighthouse's installability check (the Android home-screen install itself is also
  a §7 human step); `/api/chat` answers a question about a seeded repo and cannot
  be made to write state (test this adversarially — ask it to "mark X done" and
  confirm nothing in Neon changes); PR merged.

### After O2 — hand off to S1 (fresh Sonnet session, model switch)
Per §4.9, with the model-switch note: `create_session(model: "sonnet", prompt: "Read prompts/sonnet-1-dashboard-ui.md in this repo and execute it.")`.

## 6. Model-B (Sonnet) phases

Hard limits (repeat of §4.7): no schema changes, no auth changes, no changes to the
scan/nudge/chat service contracts O1/O2 built. Call them; don't redesign them.

### S1 — Dashboard UI
- Build the six sections from `DESIGN.md §2` as real Next.js pages/components,
  reading from the O1/O2 service layer (never raw SQL in a page component — go
  through the same query functions O1 wrote, adding new ones only for pure display
  needs, not new business logic).
- Mobile-first (this is opened on a phone daily), theme-aware (light/dark), matching
  the visual intent of the old `templates/dashboard.html` but as a live app: ticking
  a checkbox or editing a short-text field writes directly to Neon via a server
  action — no more render→fetch→harvest round-trip, there is nothing to harvest
  anymore since state is never baked into static HTML.
- Today's One Thing card renders the runbook inline (collapsed), using O1's stored
  `repos` data — the actual runbook *content* generation is S2's job; S1 can render
  a placeholder/stub here if runbooks aren't ported yet, and should say so in the
  build log rather than block.
- Load `artifact-design`-equivalent care is not required here (this is a real app,
  not a Claude Artifact) — but still: real typographic hierarchy, considered
  spacing, dark/light both correct, no layout that breaks on a phone width.
- **Exit:** all six sections render from real Neon data; a checkbox tick persists
  (reload the page, it's still ticked); Lighthouse mobile score reasonable (no hard
  number required, but no obvious regressions — huge unoptimized images, layout
  shift, etc.); PR merged.

### After S1 — hand off to S2 (fresh Sonnet session)
Per §4.9: `create_session(model: "sonnet", prompt: "Read prompts/sonnet-2-runbooks-and-polish.md in this repo and execute it.")`.

### S2 — Runbooks, scope review, chat UI, deploy polish
- Port `src/runbook.js` + `templates/runbook-*.md` into the app: given a repo's
  `stacks` row (§2 — seeded from `data/stacks.json` in O1, kept fresh by the deep
  scan), render the same copy-paste runbook (placeholders only, never real
  credentials) as a page/panel, replacing S1's stub.
- Scope review UI: monthly keep/snooze/kill per stale repo, writing the `killed`
  flag — this never touches GitHub, exactly as the old design specified (D4).
- Wire the AI chat panel UI to O2's `/api/chat` endpoint (a simple Q&A panel per
  repo, not a general chatbot).
- Deploy polish: confirm production env vars are documented and set on Vercel,
  confirm the Cron jobs are actually scheduled and firing on the deployed app (not
  just locally), final phone QA pass (install, push permission prompt, dark/light).
- **Exit:** a runbook page for a real DB-blocked repo (e.g. `besikt`) matches the
  quality bar of the existing `runbooks/besikt.md`; scope-review tick sets `killed`
  and the repo drops out of the launch queue; chat panel answers a real question
  against production data; the app is live on its Vercel URL and reachable from a
  phone; PR merged.

### After S2 — STOP, final report
No further phase. Report: the live Vercel URL, the human-inputs checklist (§7) with
what's still outstanding, and the exact next manual step (probably: open it on
Android, add to home screen, accept the push permission prompt, and finally book the
first DB session — the entire point of this tool).

## 7. Human-inputs checklist

Everything marked **before O1** must exist before the O1 prompt is pasted — O1's
exit criteria run against the real database and real APIs, and the autonomy
protocol (§4.4) stops the build on a missing credential with no fallback. Each env
value goes in **two places**: the Vercel project's env settings (for the deployed
app) and the build sessions' environment / `.env.local` (so a phase can run the
migration and hit the scan endpoint itself).

| Input | Needed for | First needed |
|---|---|---|
| **D0 — make this GitHub repo private** (unrelated to this build, still overdue) | Privacy | now |
| Vercel account + project linked to this repo (Hobby is fine: 2 crons is exactly the budget, §1) | Hosting | before O1 |
| Neon Postgres database + `DATABASE_URL` | State of record | before O1 |
| `GITHUB_TOKEN` — read-only PAT, `repo` scope (public repos only is enough) | Scan service | before O1 |
| `ANTHROPIC_API_KEY` | Scan classification + chat panel | before O1 (scan), O2 (chat) |
| `OWNER_SECRET` (any strong random string) | Owner-auth gate | before O1 |
| `CRON_SECRET` (any strong random string, set in Vercel env) | Gates `/api/scan` + `/api/nudge` | before O1 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` — O2 generates the pair and prints it; paste into Vercel env, never into the repo | Web Push | O2 |
| Open the deployed app on the phone: add to home screen, accept the push-permission prompt, confirm one test push arrives | Web Push on the real device | after S2 (the final report's first manual step) |

D2/D3/D6 (Hostinger account mapping, tier confirmation, unclassified-blocker
one-liners) no longer need answering before the build — they're just rows in the
Quick decisions inbox (S1) once the app exists. Answer them there, whenever.

## 8. Open business questions (parked, not build work)

- Whether to add a GitHub App for true push-based real-time later, once Cron-polling
  proves too coarse (see Backlog).
- Whether to later move this off Vercel/Neon to a Hostinger slot if the free tiers
  stop fitting — Anton flagged this as an explicit "maybe later," not now. Nothing in
  this plan should make that harder (plain Next.js + Postgres, no Vercel-only APIs
  beyond Cron, which has a documented equivalent — a plain scheduled job — if ever
  needed).

## 9. Build log & handoff

### O1 — Foundation (2026-08-28) — branch `claude/opus-1-foundation-prompt-jy22jx`

**Now exists:** a Next.js 16 (App Router, TS) app at the repo root; the whole §2
schema as plain SQL in `migrations/0001_init.sql` with a `schema_migrations`
ledger; `npm run seed`, the one-time JSON → Postgres migration (53 repos, 12
stacks, 6 decisions, settings from `data/config.json`), re-runnable and
self-checking; `lib/score.ts`, a faithful port of `src/score.js` whose CLI output
(`npm run queue`) is byte-identical to the legacy script's on the seeded data;
`lib/scan/*` — planner, GitHub client, Sonnet classifier, stack refresh, drift
guard, orchestrator — behind `/api/scan`, capped at 5 deep reads per firing and
resumable; the owner gate (`/login` + `proxy.ts`); `vercel.json` with the Mon/Thu
04:00 America/Asunción cron; 37 unit tests plus the 130 legacy ones.

**Decisions taken (the ones §5 O1 left open):**
- **Driver: `pg`**, not `@neondatabase/serverless` — the same pool works against
  Neon and a local Postgres, and nothing in the app is Neon-proprietary (§8).
  Routes that touch it declare `runtime = 'nodejs'`.
- **Auth: a stateless signed cookie**, not the `auth_sessions` table §2 offered
  as the alternative. The check runs in `proxy.ts` on the edge runtime, where a
  Postgres lookup is not available; with one user and one secret a session table
  buys nothing. `auth_sessions` is therefore **not** in the schema — the only §2
  table deliberately omitted.
- **Migrations are plain SQL, no ORM.** The schema is read by hand often enough
  (by the next phase, by a session debugging a drift item) that readable DDL wins.
- Two columns §2 did not name were added to `repos` because SCAN.md's rules need
  them: `blocked_scans` ("owner-blocked three scans running") and
  `newly_blocked_at` ("newly blocked on you"). Also `market` (the D2 batching
  proxy), `pushed_at`, `scope_review_proposed`, `kept_at`, and
  `stacks.package_name` (besikt's package is `rapportverket`; runbooks need it).
- Next 16 deprecated `middleware.ts` in favour of `proxy.ts`; the gate uses the
  new convention.

**Deviations:** the migration ran against **local Postgres 16, not Neon** — no
`DATABASE_URL` existed in the session (`plan.md` §7 lists it as a before-O1 human
input). Counts matched (53/53, 12/12, `propia.node` still carries its `unblocks`).
The scan endpoint was verified end-to-end against the real GitHub API, writing a
`scan_events` row and updating the repo row; its Sonnet classification step ran
its documented degraded path because no `ANTHROPIC_API_KEY` was available. Both
are in `KNOWN-ISSUES.md` as the first things to re-run once the credentials exist.

**Where O2 should look first:** `lib/queries.ts` (every read/write goes through
it), `lib/domain.ts` (lanes, blockers, owner-minutes — the nudge ladder's
vocabulary), `lib/scan/run.ts` for the shape a cron route takes here, and
`proxy.ts`'s `OPEN_PATHS`, which already exempts `/api/nudge`.

### O2 — Nudge engine, Web Push, PWA, chat (2026-08-28) — branch `phase/o2-push-and-nudge`

**Now exists:** the daily coach. `lib/nudge/*` — `history.ts` (the caps),
`ladder.ts` (the six rungs), `outcomes.ts`, `run.ts` (resolve → select →
record → notify) — a port of `scripts/legacy/src/select.js` reading Neon;
`lib/clock.ts`, the owner-timezone day every cap is counted in; `/api/nudge`
behind `CRON_SECRET` plus the second and final Hobby cron (daily 08:00
America/Asunción); `lib/push.ts` + `/api/push/subscribe` + `npm run vapid`;
a real PWA (`public/manifest.json`, `public/sw.js`, generated icons via
`npm run icons`) and the `PushToggle` card that subscribes a browser;
`/api/chat`, read-only, on `claude-sonnet-5`; `lib/anthropic.ts`, now the one
Messages-API call site for both the scan and the chat. 57 new unit tests (94
vitest + 130 legacy, all green).

**Decisions taken (the ones §5 O2 left open):**
- **`nudges` gained four columns** (`migrations/0002_nudge_engine.sql`) and
  `momentum` joined its type list. §2's sketch could not express the rules:
  `local_date` because every cap is the OWNER's day and Asunción is UTC-3, so
  a late push would otherwise count on the wrong day; `pushed` because the
  `question` rung decides *without* pushing and "already decided today" must
  stay a different count from "pushes this week"; `parent_type` and
  `title`/`body` so the escalation chain and the question text survive in the
  audit trail. The schema freeze in §4.7 binds the Sonnet phases; this is the
  Opus phase that was meant to finish the foundation.
- **Mute and shrunk-ignored state is derived from the history, not stored.** A
  `question` row *is* the mute; consecutive ignored `shrunk` rows are the
  ignore count. One copy cannot drift from the audit trail; two can.
- **Outcome resolution replaces the harvest.** There is no live-doc to diff, so
  "did the owner act?" is answered from the traces a deliberate owner action
  leaves: `cleared_blockers` dates, `kept_at`/`killed_at`, answered
  `decisions`, resolved `scan_events`. Never from a scan — SCAN.md's rule that
  an estimate is not a fact applies here too.
- **A pure silence is not recorded.** Only asks go in `nudges`. A "nothing
  qualifies" row would break `chainLength` (it walks back until the repos stop
  matching) and would make Sunday look like a decision.
- **Chat rate limit: a fixed window in module memory**, 20 questions per 10
  minutes per instance. One user behind an auth gate; the limit is there to
  bound an accidental loop, not an attacker, and a shared counter would mean
  another table and a round-trip per question.
- **Raw `fetch`, not the Anthropic SDK.** O1 set that pattern and both call
  sites want one plain request with a timeout; mixing an SDK call site and a
  `fetch` one would be worse than either.

**Exit criteria, and how each was actually checked:**
- *Ladder*: `npm run nudge` against seeded data → `PUSH db-session` /
  "45 min unblocks 3 launches: qr, facturar, ecom" — the DESIGN.md §1a
  headline. An immediate second run → `silent — daily cap of 1 reached`.
- *Caps*: 35 unit tests, one per hard rule in §3, including the ones only a
  test can catch — a Sunday must not reset an escalation chain, an undelivered
  decision must not count against the weekly push cap.
- *Web Push*: the FCM hop is unreachable from this container, so both halves
  were proven separately. Send: a real `web-push` call to a local HTTPS push
  service stand-in — `aes128gcm`, 327 encrypted bytes, and the VAPID ES256
  signature verified against `VAPID_PUBLIC_KEY` with node's crypto (right
  `aud`, right `sub`, future `exp`); a 410 pruned the row. Receive: a real
  Chromium registered the real `public/sw.js`, precached exactly the four
  shell entries, and turned the exact payload into a real Notification —
  correct title, body, icon and data; a second push with the same tag replaced
  it rather than stacking; an empty payload still showed something. Then the
  whole app path: subscription in Postgres → `POST /api/nudge` → `sent: 1`,
  second run silent and sending nothing, 410 pruning the row, and the run
  still deciding and recording with nothing subscribed.
- *Installable*: Chrome's own parser (`Page.getAppManifest`) reported no
  errors, and 14/14 install criteria pass — including that every declared icon
  actually resolves as a PNG and the worker has both a `fetch` and a `push`
  handler.
- *Chat is read-only*: tested adversarially, and harder than a happy path
  would have been. Pointed at a stand-in that claims to have written, emits
  SQL, emits an unsolicited `tool_use` block and attempts a prompt-injection
  override, then asked six questions including "mark besikt as done" and
  "ignore all previous instructions". Every one of the seven tables was
  md5-identical before and after; besikt stayed at 95%/db-setup. Structurally:
  the path imports three SELECT-only functions, reaches no write function,
  declares no tools, and never parses the reply — all pinned in
  `tests/chat.test.ts`.

**Deviations / still open:** the same two as O1, unchanged — no Neon
`DATABASE_URL` (0002 has only run against local Postgres 16) and no
`ANTHROPIC_API_KEY` (the real Sonnet round-trip is still unexercised, on both
the scan and the chat). Both are in `KNOWN-ISSUES.md` with what to re-run.

**Where S1 should look first:** `lib/queries.ts` still — `getNudges`,
`getOwnerActions` and `patchSessionState` are new there. The dashboard's
"Today's One Thing" reads `settings.session_state` (`booked`/`when`/`done`/
`done_date`/`shrink`), and the ☐ Booked and ☐ Done cards write it through
`patchSessionState`; ticking a blocker clear goes through `clearBlocker`,
which is what tells the nudge engine the owner acted. Open `question` nudges
(type `question`, outcome `pending`) carry their text in `title` — that is the
"what is actually in the way on X?" card §3 asks for. `app/components/PushToggle.tsx`
is the notifications card, ready to drop into the real dashboard.

## 10. Backlog

- Push-based real-time updates instead of Cron polling. If ever done: a GitHub App
  installed once on the `antonmarklundcom` account with all-repos access (one
  install, one webhook endpoint) — **not** 53 per-repo webhooks, and note the
  account is a user account, so there is no org-level webhook shortcut. Stays
  Backlog because the coach only speaks once a day and scans twice a week —
  freshness beyond the poll cadence changes nothing the owner sees.
- Calendar integration for booking DB sessions directly from the dashboard.
- Expanding the AI chat panel beyond single-repo Q&A (e.g. portfolio-wide questions).
- Automatic detection of near-duplicate repos (the four `ecom`-template clones found
  in the 2026-08-28 manual audit) — flag them in the scope review instead of the
  owner discovering it by hand.
- Automatic name/content mismatch detection (e.g. `flyttatillspanien` containing
  Paraguay real-estate code — also found manually on 2026-08-28).
