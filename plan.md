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
- **AI judgment via direct Anthropic API calls, not Claude Code sessions.** The old
  design's deep-scan ran inside a Claude Code Routine session (can clone repos, run
  arbitrary tools). The new scan runs inside a Vercel serverless function: it can only
  call the GitHub REST API (file contents, commits, PRs) and the Anthropic Messages
  API (`claude-sonnet-5` — **never Fable**, see `fable-cost-guardrail`) for
  classification. This is cheaper and fits a function timeout; it cannot clone a repo
  or run shell commands, so judgments are text-in/text-out from fetched file content.
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
  next_step, open_prs, merged_prs_30d, live_url, live_url_ok, killed, last_commit_at,
  last_scan_at, last_scan_head_sha, created_at, updated_at`. Lane/blocker enums match
  `data/portfolio.json` meta exactly (`lanes`, `blockers` arrays) — do not invent new
  values without updating `DESIGN.md`.
- **decisions** — `id, question, needed_for, recommended, why, status
  (pending|accepted|corrected), answer, batch, created_at, resolved_at`.
- **nudges** — `id, repo_id nullable, type, sent_at, outcome, shrunk boolean` — the
  anti-annoyance state machine's history (`DESIGN.md §3`).
- **scan_events** — `id, repo_id, source (cron|manual), findings jsonb, applied
  boolean, verify_reason text nullable, created_at` — every scan result, whether
  auto-applied or held as a drift-guard verify item. This table is the audit trail;
  never overwrite `repos` directly from a scan without writing the event first.
- **push_subscriptions** — `id, endpoint, keys jsonb, created_at`.
- **sessions** — `id, cookie_hash, created_at, expires_at` for the owner auth gate (or
  a stateless signed cookie if the implementer prefers — pick one in O1, record the
  choice in the build log).

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
  `stacks.json` + `nudges.json` from this repo, write into Neon. Run it once against
  the real database as part of this phase's exit criteria (not just as a dry run).
- Owner-auth: a `/login` route gated by a shared secret (`OWNER_SECRET` env var),
  setting a signed httpOnly cookie checked by middleware on every other route.
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
     API (PLAN.md/README/etc., recent commits, open PRs) and call the Anthropic
     Messages API (`claude-sonnet-5`) with a prompt adapted from `SCAN.md`'s scan
     prompt, asking for the same fields (`pct, blocker, lane, next_step, open_prs,
     live_url_ok, ...`) as strict JSON;
  4. write every result to `scan_events`; apply the drift-guard rules from
     `SCAN.md` ("What the scan may and may not change") — percentage down or a
     blocker reappearing on an owner-cleared repo is written as `applied: false` with
     a `verify_reason`, never silently overwriting `repos`.
- Vercel Cron entry (`vercel.json`) firing the scan twice weekly, matching the old
  Mon/Thu 07:00 America/Asunción cadence (convert to UTC cron correctly, DST-aware
  window like the old D1 answer).
- `.env.example` documenting `DATABASE_URL`, `OWNER_SECRET`, `ANTHROPIC_API_KEY`,
  `GITHUB_TOKEN` (read-only PAT) — all optional at build time, required at runtime,
  each with a documented graceful-degradation behavior if absent.
- **Exit:** `npm run build` green; migration script run once against real Neon with a
  row count matching `data/portfolio.json`; `/login` gates every other route; hitting
  the scan endpoint locally (with a real `GITHUB_TOKEN`/`ANTHROPIC_API_KEY` in
  `.env.local`, or documented as skipped if unavailable) writes at least one
  `scan_events` row; unit tests for the scoring invariant pass; PR merged.

### After O1 — hand off to O2 (fresh Opus session)
Per §4.9: merge PR, pre-handoff audit, build-log entry, then
`create_session(model: "opus", prompt: "Read prompts/opus-2-push-and-nudge.md in this repo and execute it.")`.
Fallback if `create_session` unavailable: continue in the same window (same model).

### O2 — Nudge engine, Web Push, PWA, AI chat endpoint
- Port `DESIGN.md §3`'s priority ladder + anti-annoyance state machine into a
  `app/api/nudge/route.ts` driven by Vercel Cron (daily). It reads `repos` +
  `nudges` from Neon, decides today's action (or silence) by the same six-rule
  ladder, writes a `nudges` row, and — if a real action was produced — sends a Web
  Push notification.
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
  nudge delivers a real notification; the dashboard installs to an Android home
  screen with an icon; `/api/chat` answers a question about a seeded repo and cannot
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
  stored stack metadata (migrate `data/stacks.json` in O1 if not already covered —
  flag it if it was missed), render the same copy-paste runbook (placeholders only,
  never real credentials) as a page/panel, replacing S1's stub.
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

| Input | Needed for | First needed |
|---|---|---|
| Vercel account + project linked to this repo | Hosting | O1 |
| Neon Postgres database + `DATABASE_URL` | State of record | O1 |
| `GITHUB_TOKEN` — read-only PAT, `repo` scope (public repos only is enough) | Scan service | O1 |
| `ANTHROPIC_API_KEY` | Scan classification + chat panel | O1 (scan), O2 (chat) |
| `OWNER_SECRET` (any strong random string) | Owner-auth gate | O1 |
| Accept the browser push-permission prompt once | Web Push | O2 |
| **D0 — make this GitHub repo private** (unrelated to this build, still overdue) | Privacy | now |

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

*(empty — first entry lands when Phase O1's PR merges)*

## 10. Backlog

- GitHub App / per-repo webhooks for real-time updates instead of Cron polling.
- Calendar integration for booking DB sessions directly from the dashboard.
- Expanding the AI chat panel beyond single-repo Q&A (e.g. portfolio-wide questions).
- Automatic detection of near-duplicate repos (the four `ecom`-template clones found
  in the 2026-08-28 manual audit) — flag them in the scope review instead of the
  owner discovering it by hand.
- Automatic name/content mismatch detection (e.g. `flyttatillspanien` containing
  Paraguay real-estate code — also found manually on 2026-08-28).
