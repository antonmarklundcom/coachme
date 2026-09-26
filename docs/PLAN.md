# PLAN — coachme v4, the control tower

Status: **draft, waiting for Anton's approval. No code is written until it is approved.**
Written 2026-09-26 after reading the v1–v3 record (README, `plan.md` v3, `PLAN.md` v1,
`docs/report-2026-09-11.md`, O3/O4 logs, KNOWN-ISSUES) and the live portfolio
(`gh repo list`: 87 repos; `C:\Claude 1`: 36 git checkouts).

v4 replaces v3. It is a **local-first** app on Anton's PC. Every morning it answers three
questions in under a minute: *What is broken? What is closest to money? What are the 3 things I
do today?* It watches everything (GitHub, disk, agent sessions, sites, Hostinger, CRM,
revenue) and writes only to its own SQLite database, its own files, and Telegram messages
to Anton.

---

## 0. What v1–v3 taught, in one paragraph

v1 (an Artifact plus Routines) and v2/v3 (Next.js on Vercel plus Neon) got the *logic* right:
rank by distance to money, raise a stage only on evidence, finish before starting, keep a
kill/keep question, stay quiet unless something matters. The *delivery* was wrong. Nothing
ran for weeks: v2 was never deployed, and v3's dispatch had no write token. None of it could
see the things that actually hurt: Hostinger process limits, half-finished agent sessions,
local uncommitted work, sites returning 5xx. v4 keeps the logic, drops the cloud delivery,
and adds the observation layer.

## 1. Keep / port / delete: the existing repo, part by part

**Delete.** Git history keeps all of it.

| Part | Why |
|---|---|
| Next.js app: `app/`, `proxy.ts`, `next.config.ts`, `eslint.config.mjs` (next config), `public/` (PWA, `sw.js`, icons), `vercel.json` | New stack is Hono on 127.0.0.1, server-rendered. There is no Vercel, no PWA and no login gate. |
| Postgres layer: `lib/db.ts`, `lib/queries.ts`, `migrations/0001–0004.sql`, `scripts/migrate.ts`, `scripts/seed.ts`, the `pg` dependency | Replaced by SQLite (better-sqlite3) with a new schema (§4). The two schemas don't line up well enough to port the SQL. |
| Auth and push: `lib/auth.ts`, `lib/push.ts`, `scripts/vapid.ts`, `scripts/icons.ts`, `web-push` | The app binds to 127.0.0.1, so there is nothing to authenticate. Telegram replaces Web Push. |
| **GitHub write capability**: `lib/github/write.ts`, `lib/github/probe.ts`, `lib/dispatch/*`, `app/api/dispatch`, `app/api/merge` | v4 is **read-only against GitHub** (brief constraint). The copy-prompt button replaces dispatch-by-commit. |
| Nudge engine: `lib/nudge/*`, `scripts/nudge.ts`, `lib/momentum.ts` | The ladder, the shrink escalation and the streak were the "nag the human" part that the 2026-09-11 report already judged a failure. Only the caps survive, as a rule (see Port). |
| Chat: `lib/chat.ts`, `lib/gemini.ts`, `ChatPanel` | Out of scope. The brief limits AI to four uses (§7). |
| Cloud scan: `lib/scan/run.ts`, `apply.ts`, `plan.ts`, `link.ts`, `app/api/scan` | Replaced by local collectors (§5). |
| `scripts/legacy/` (v1 plain-Node scripts and 130 tests) | They were the reference for a port that is now itself being replaced. |
| `.github/workflows/test.yml` | **No GitHub Actions** (Anton's minutes are budgeted). It currently runs on every push, so removing it saves minutes right away. |
| `prompts/` (v2/v3 phase prompts), `data/decisions.json`, `data/nudges.json`, `data/config.json` | These were v3 execution artifacts. |
| Tests bound to deleted code (`auth`, `chat`, `push`, `nudge`, `dispatch`, `github-write`, `robots`, `momentum`) | They go with their code. |

**Port.** The logic is rewritten against the new types, and each port gets its own test.

| From | To | What survives |
|---|---|---|
| `lib/score.ts` (`moneyDistance`, leverage) | `src/rank/score.ts` | A project's closeness to money comes from its stage. The old invariant stays: inside one stage, nearly-done beats barely-started. |
| `lib/launch/stage.ts` | `src/rank/stage.ts` | A stage is raised only on evidence and never lowered automatically. Manual set is always allowed. The rules map to the new stages (§4). |
| `lib/generate/prompt.ts` (mandatory header), `sanitize.ts` | `src/prompts/build.ts` | Every copy-prompt carries the same header: repo path, branch convention, "read AGENTS.md/CLAUDE.md first", goal, definition of done, "stop and report". |
| `templates/prompts/*.md` + `index.json`, `lib/runbook.ts` + `templates/runbook-*.md` | `templates/prompts/` | Template kinds: finish-feature, owner-step, Hostinger DB setup (from the runbooks), fix CI, lead form → VenderCRM, deploy. |
| `lib/github/checks.ts` | `src/collectors/github/ci.ts` | Pure CI-state reading. Two rules carry over: an unreachable checks API reads as "unknown", never green, and "no CI at all" counts as a neutral dot, not red. |
| `lib/report/weekly.ts` | `src/review/weekly.ts` | The weekly report shape (stage changes, merged work, closest-to-money step) becomes a section of the weekly review. |
| `lib/scan/stacks.ts` | `src/collectors/local/stack.ts` | Stack detection (engine, Prisma/Drizzle, migrations dir), used by the portfolio generator. |
| `lib/scan/classify.ts` sanitizer approach, `lib/anthropic.ts` | `src/ai/*` | AI output is strict JSON and sanitized before use. The client is rewritten with a cache and a spend cap. |
| `lib/clock.ts` | `src/lib/clock.ts` | Owner timezone: America/Asunción. The v1 decision D1 stands. |
| Nudge caps (from `DESIGN.md`) | `src/notify/rules.ts` | At most one unprompted Telegram message a day, plus red alerts. Silence is a valid outcome. |
| `data/portfolio.json` (53 repos: tier, pct, blocker), `data/stacks.json` | Hints for the `portfolio.yaml` generator, then moved to `docs/history/data/` | Seeds tiers and known blockers. The generator keeps no other link to them. |

**Keep and move.** `DESIGN.md`, `ROUTINE.md`, `SCAN.md`, `DEPLOY.md`, `plan.md` (v3),
`PLAN.md` (v1), `docs/report-2026-09-11.md`, `docs/log/*` and `runbooks/` all go under
`docs/history/`. `README.md`, `AGENTS.md`, `CLAUDE.md` and `KNOWN-ISSUES.md` are rewritten
for v4. The old KNOWN-ISSUES moves to history.

> ⚠️ **Repo defect to fix in Phase 1:** `PLAN.md` and `plan.md` are both tracked and collide
> on Windows. `git clone` warned, and only one of the two is in the working tree. Phase 1
> uses `git mv`/`git rm` to move both into `docs/history/` under distinct names.

**Outside this repo (Anton's actions, flagged rather than done):**
- `https://coachme-five.vercel.app` **answers (HTTP 307 to /login)**, so v3 *was* deployed.
  Its Vercel crons may still be scanning and pushing. Once Phase 5 has replaced the digest,
  Anton should delete the Vercel project and the Neon database. If there is state in Neon
  worth keeping (kill flags, tiers), put its `DATABASE_URL` in `.env.local` before
  Phase 1. The generator will read it once, read-only, and nothing else ever will.
- The coachme repo is **still public** (v1's D0 was never done), and `portfolio.yaml` will
  hold the whole business map. **Make it private before Phase 1 merges.**

---

## 2. Stack and why

| Choice | Reason |
|---|---|
| Node 22 + TypeScript, ESM, `tsc` build to `dist/` | As the brief requires. |
| **Hono** (+ `@hono/node-server`), bound to `127.0.0.1:4000` | It's small, it's fast, it has typed routes, and its built-in JSX renders HTML on the server. Fastify is fine too, but it gives nothing extra here. |
| **Server-rendered HTML (hono/jsx), no client framework.** Around 150 lines of vanilla JS in total: copy-to-clipboard, a quick-capture form, one-click pause/kill (form POSTs). | This is one user on localhost. Server rendering means first paint in well under 100 ms, no client bundle, no Vite pipeline and no hydration bugs, and every view can be tested as a string. Charts (process pressure, goal bars) are **inline SVG generated on the server**, so there's no chart library. Vite+React would add a second build and a state layer, and a read-mostly dashboard needs neither. |
| SQLite via **better-sqlite3**, WAL mode, `data/coach.db` (git-ignored) | Synchronous and fast, a single file, easy to back up. The CLI and the server share it safely under WAL. Prebuilt binaries exist for Node 22 on win32-x64. |
| Migrations: plain `.sql` files in `migrations/`, applied at startup, versions tracked in `schema_migrations` | This is the v2 convention, with a new schema. |
| `yaml` package for `portfolio.yaml`, `zod` for validation | The yaml file is edited by hand, so bad edits need clear errors with line numbers. |
| vitest | Already in use. Tests use fixtures only: no network, no `gh`, no SSH. |
| `@anthropic-ai/sdk`, model from config (default `claude-sonnet-5`) | §7. |
| Scheduler: **inside the server process.** A 60-second tick runs any collector whose interval has passed since its last successful run, so the PC coming back from sleep catches up. | `scripts/register-task.ps1` registers **one** Task Scheduler job, "at logon, run `npm start` hidden", plus a matching `unregister-task.ps1`. There are no per-collector OS tasks. Anton runs the register script himself; the plan doesn't touch his Task Scheduler without him. |
| CLI `coach` (`src/cli.ts`, package `bin`, plus a `coach.cmd` shim in `%USERPROFILE%\.local\bin`, which is already on PATH) | `coach add "…"`, `coach today`, `coach collect <name>`, `coach portfolio generate`. It writes straight to SQLite, so it works while the server is down. |

`npm start` = build if stale, migrate, and serve with collectors running.
`npm run dev` = tsx watch.
`npm test` and `npm run build` are the gates.

---

## 3. `portfolio.yaml`: the one hand-edited source of truth

```yaml
version: 1
owner_tz: America/Asuncion
limits: { hostinger_process_limit: 200 }
hosting_accounts:
  - id: hst-a                     # label is Anton's; never a password
    label: "Hostinger A (PY sites)"
    ssh: { host: "…", port: 65002, user: "u123456789", key: "~/.ssh/hostinger_a" }  # optional
projects:
  - id: propia
    name: Propia
    stage: live                   # idea|planned|building|deployed|live|earning|paused|killed
    market: PY                    # PY|SE|global
    kind: portal                  # leadgen|portal|saas|consumer|content|infra|client
    money: { model: leadgen, weight: 4 }   # weight 1–5 is Anton's money-impact estimate
    repos: [propia.node, app.propia]
    domains:
      - { host: propia.com.py, hosting: hst-a, app: node, crm_site: propia }
    notes: ""
unassigned:                        # the generator appends new finds here; Anton moves them
  repos: []
  domains: []
```

**Generator** (`coach portfolio generate`):
1. It lists repos with `gh repo list antonmarklundcom --limit 200`. It does the same for any
   org listed in config.
2. It maps local checkouts **by `git remote get-url origin`, not by folder name**. Folder
   names differ from repo names (`comida-com-py` vs `comida`, `venderCRM-repo` vs
   `vendercrm`). 9 local repos have no antonmarklundcom remote and are listed as `local-only`.
3. It discovers domains, in this order: `CNAME` file; GitHub `homepageUrl`;
   `package.json` `homepage`; `.env.example` `*SITE_URL*`; next-sitemap `siteUrl`;
   canonical/`og:url` in HTML templates; the repo-name pattern (`asado-com-py` →
   `asado.com.py`); and in Phase 2 `ls ~/domains` over Hostinger SSH, which is the most
   accurate source. Every domain it finds carries `source` and `confidence`.
4. It groups repos into projects with conservative rules: a shared domain, a shared stem
   (`propia.node` + `app.propia`, `embarazo` + `embarazo.2.1`), or the known clone family
   (`ecom`, `lenceria`, `productos`, `mascota`, flagged as `related`). Anything uncertain
   becomes a one-repo project.
5. It seeds `stage` from evidence: a live site → `live`; commits in the last 30 days →
   `building`; otherwise `planned`. It seeds the money weight from the v3 `tier`.

**It never overwrites hand edits.** The first run writes `portfolio.yaml`. Later runs write
`portfolio.generated.yaml` and **only append** new repos and domains to `unassigned:` in
`portfolio.yaml`. The yaml is the source for identity and grouping. SQLite stores
observations. A project's stage set in yaml always wins over any suggestion; suggestions
show in the UI as "evidence says live → accept?".

---

## 4. Data model (SQLite)

Identity comes from yaml and is synced into tables at startup and on file change.
Observations are append-only with timestamps (history), with a `latest_*` view for each.

| Table | Key columns |
|---|---|
| `projects` | `id` (yaml id), `name`, `stage`, `market`, `kind`, `money_model`, `money_weight`, `paused_at`, `killed_at`, `stage_suggestion`, `stage_evidence` json |
| `repos` | `name`, `project_id`, `local_path`, `default_branch`, `archived`, `on_github`, `local_only` |
| `domains` | `host`, `project_id`, `hosting_account_id`, `app_kind` (node, php, static), `crm_site`, `source`, `confidence` |
| `hosting_accounts` | `id`, `label`, `has_ssh`, `process_limit` (no secrets. The SSH key *path* stays in yaml, never the key.) |
| `collector_runs` | `collector`, `started_at`, `finished_at`, `ok`, `error_short`, `items`. This drives "stale since…". |
| `gh_snapshots` | `repo`, `at`, `last_push_at`, `last_commit_at`, `open_prs` json (number, title, branch, age, checks), `default_ci` (green, red, none, unknown), `stale_branches` json (>14 days, unmerged) |
| `deploys` | `repo`, `at`, `sha`, `pr_number`, `source` (merged PR / push to default branch). Hostinger deploys on push, so this is the deploy log. |
| `local_snapshots` | `path`, `at`, `repo`, `dirty_files`, `unpushed_commits`, `branch`, `ahead`, `behind`, `local_only` |
| `agent_sessions` | `id` (hash of the file path), `tool` (claude, codex), `repo` (or null), `project_id`, `started_at`, `last_at`, `last_request` (≤200 chars, **redacted**), `ended_mid_task`, `summary` (≤300 chars, redacted, AI or heuristic), `file_mtime` |
| `domain_checks` | `host`, `at`, `dns_ok`, `status`, `final_url`, `redirects`, `ms`, `tls_expires_at`, `title`, `has_robots`, `has_sitemap`, `has_lead_form`, `error_kind` |
| `process_samples` | `account_id`, `at`, `procs`, `threads`, `node_apps` json (pid, app_dir, threads, is_next_build), `source` (ssh, manual) |
| `crm_leads_daily` | `crm_site`, `day`, `leads`, `source` |
| `gsc_weekly` | `host`, `week`, `clicks`, `impressions` (Phase 6) |
| `revenue` | `id`, `project_id`, `client`, `amount`, `currency` (PYG, SEK, USD, EUR), `recurring` (none, monthly, yearly), `date`, `note` |
| `fx` | `currency`, `per_usd`, `set_at`. Manual in config, used only to add amounts across currencies. |
| `tasks` | `id`, `project_id`, `title`, `source_kind` (known-issue, handoff, plan-phase, todo, session, inbox, manual, alert), `source_file`, `source_line`, `source_hash` (dedupe across re-reads), `status` (open, done, dropped), `money_impact`, `closeness`, `effort_h`, `pinned`, `created_at`, `done_at` |
| `ideas` | `id`, `text`, `created_at`, `status` (parked, promoted, dropped), `gate_more_valuable_than`, `gate_pause_project` |
| `inbox` | `id`, `text`, `source` (ui, cli, telegram), `created_at`, `triaged_as` (task, idea, dropped) |
| `goals` | `id`, `period` (`2026`, `2026-Q4`), `metric` (revenue_monthly, projects_earning, leads_month, sites_live, custom), `target`, `unit`, `manual_value` |
| `alerts` | `id`, `kind`, `subject`, `from_state`, `to_state`, `severity` (red, amber), `opened_at`, `closed_at`, `notified_at` |
| `ai_calls` | `at`, `purpose`, `model`, `cache_key`, `in_tok`, `out_tok`, `usd`. This drives the daily cap. |
| `ai_cache` | `cache_key` (hash of purpose, model and input), `output` json, `at` |

**Stages:** `idea → planned → building → deployed → live → earning`, plus `paused` and `killed`
(which carry the stage they left). Evidence rules, ported from v3 and tested:
- `deployed`: a domain answers 2xx on any host.
- `live`: the domain is in yaml with confidence ≥ high, answers 2xx, and has a real `<title>`
  (not a Hostinger or parking placeholder).
- `earning`: a revenue entry exists in the last 60 days.

Suggestions only move up. The app never lowers a stage by itself.

---

## 5. Collectors

Every collector is `src/collectors/<name>/` with the same shape: `collect(ctx) → Raw`, a
pure `parse(raw) → rows`, and `store(rows)`. Tests hit only `parse`, with fixtures under
`tests/fixtures/<name>/`. Each run is wrapped. An exception writes `collector_runs.ok=0`
and a short error, and the UI shows **"stale since <time>"** for that collector's data.
Nothing else is affected. No collector ever runs a command that is not a constant in its
own module.

| # | Collector | Interval | How | Notes and limits |
|---|---|---|---|---|
| 1 | `github` | 30 min | `gh api graphql` in batches (one query for ~90 repos: pushedAt, default-branch CI rollup, open PRs with checks, refs), `gh api` for merged PRs since the last run → `deploys` | Read-only calls only. Throttles on the rate-limit header. |
| 2 | `local` | 15 min | Walks `C:\Claude 1` one level deep (config `local_roots`), then `git status --porcelain=v2 -b`, `git log @{u}..`, `git remote get-url origin` | It lists "local-only" repos and "on GitHub, no checkout". It never fetches or pulls (git reads only). |
| 3 | `sessions` | 30 min | Parses `~/.claude/projects/**/*.jsonl` (149 files today) and `~/.codex/sessions/**/*.jsonl` (217) **incrementally**, skipping files whose mtime hasn't changed | See the secrets rule below. |
| 4 | `notes` | 60 min, plus after `local` sees a change | Reads `KNOWN-ISSUES.md`, `HANDOFF*.md`, `plan.md`/`PLAN.md`/`docs/PLAN.md` (unchecked `- [ ]` items under the current phase), and `TODO:` lines (capped at 20 per repo, excluding `node_modules`, `vendor`, `dist`) in every local checkout | Each item becomes a task with `source_file:line` and `source_hash`. If the source line disappears, the task auto-closes as done. |
| 5 | `domains` | 30 min | Node `dns.promises`, `fetch` with manual redirect follow (≤5), TLS expiry via `tls.connect`, and `<title>`, `/robots.txt`, `/sitemap.xml`, and a lead-form heuristic (a `<form>` with a tel/email/whatsapp field, or a VenderCRM script or endpoint) | Concurrency 6, 15 s timeout. It's a GET of the public page, the same as any visitor. An alert fires on a state change only (2xx→5xx, DNS gone, TLS < 14 days, title turned into a placeholder). The UI explains every code in plain words (§6). |
| 6 | `hostinger` | 10 min | `ssh -o BatchMode=yes -i <key> user@host "<fixed command>"` with Windows OpenSSH | See below. |
| 7 | `crm` | 60 min | Phase 4: the VenderCRM read-only stats endpoint if one exists, else a spec plus a task | See below. |
| 8 | `gsc` | daily | Search Console API, OAuth installed-app flow with a loopback redirect to 127.0.0.1 | Phase 6. |
| 9 | revenue | — | Manual entry in the UI and `coach revenue add` | It isn't a collector. It's listed so nothing is dropped. |

**Hostinger (collector 6), the fixed command.** It's a single string, pinned by a test:
```
echo "P $(ps -u $USER --no-headers | wc -l)"; echo "T $(ps -u $USER -L --no-headers | wc -l)";
ps -u $USER -o pid=,nlwp=,args= | grep -E "[n]ode|[n]ext" ; for p in $(pgrep -u $USER node); do echo "CWD $p $(readlink /proc/$p/cwd 2>/dev/null)"; done;
ls -1 ~/domains 2>/dev/null | sed 's/^/D /'
```
It only reads. It never runs `kill`, `pkill`, `pm2`, `npm`, `restart` or writes. The test
asserts that none of those tokens appear in the module. Without SSH configured, the Hosting
view shows a one-field form ("processes from hPanel: ___") that stores a `manual` sample.
The chart plots samples against the 200 limit, with deploy markers from `deploys` for the
account's repos. A spike within 15 minutes of a deploy is labelled as "likely from
<repo> deploy". A `next build` process is flagged in red.
*Uncertain:* Hostinger may hide `/proc/<pid>/cwd` on shared plans. The fallback is to parse
the app dir from `args`, and the phase report says which one actually worked.

**VenderCRM (collector 7).** I read the repo and found **no read-only stats endpoint**:
`src/app/api/v1` only has public capture routes (booking, chat, email), and `api/ops/v1`
is batch operations. Phase 4 first checks `api/exports`. If there's still nothing
read-only, it writes `docs/specs/vendercrm-stats-endpoint.md` (`GET
/api/ops/v1/stats/leads?from&to` → `[{site_slug, day, count}]`, key-auth, read-only) and
adds the task "build this endpoint in vendercrm", with a copy-prompt. **Nothing is built
inside vendercrm from here.** Until the endpoint exists, the leads dot shows "no data" and
goals that depend on leads show manual values.

**Sessions and the secrets rule (collector 3).** It stores only: tool, repo, timestamps,
`ended_mid_task`, and a **redacted** last user request and summary, each capped. Redaction
(`src/lib/redact.ts`, tested against a fixture seeded with fake secrets) removes:
`sk-ant-…`, `sk-…`, `ghp_`/`github_pat_`/`gho_`, `xox*`, `AKIA…`, JWTs, `-----BEGIN … KEY-----`
blocks, `Bearer …`, `password|passwd|secret|token|api_key\s*[:=]\s*\S+`, URLs with
`user:pass@`, `.env`-style `KEY=value` lines, and any run of 32 or more base64/hex
characters. Raw log text is never written to the DB, to logs, or to AI prompts before
redaction. Only redacted text goes to the summariser.
*Found while reading the logs:* almost every session's `cwd` is `C:\Claude 1`, the parent
folder, not a repo. Repo attribution is therefore:
1. `cwd` if it is inside a checkout;
2. otherwise the most-referenced `C:\Claude 1\<dir>\…` path in the session's tool calls,
   mapped to a repo by remote;
3. otherwise `gitBranch`;
4. otherwise "unattributed" (shown, not hidden).

Codex compaction blocks are encrypted, so only plaintext user and assistant messages are
used. Cloud sessions (claude.ai/code, Codex cloud) aren't on disk. Their work shows up
through collector 1 as `claude/*` and `codex/*` branches and PRs.
`ended_mid_task` = the last event is a tool call or result, or a user message with no
assistant reply after it, or the final assistant text asks a question. It is a heuristic
and is labelled as one.

---

## 6. Views (all at `http://127.0.0.1:4000`)

A top nav on every page: **Today · Portfolio · Hosting · Inbox · Ideas · Goals · Review**,
with a red badge showing the open red-alert count.

- **Today (`/`)**
  - Every **red alert** comes first, in plain words.
  - Then **max 3 actions**, each with project, why (the AI reason, or a deterministic
    reason when there's no AI), effort, a source link, a **Copy prompt** button, and Done/Drop.
  - Then a "closest to money" strip: the top 5 projects by stage and money weight.
  - Then collector freshness in the footer.
- **Portfolio (`/portfolio`)**
  - A column per stage, one card per project, with four dots: **site** (latest domain
    checks), **CI** (default branch), **leads** (CRM 7-day vs the previous 7), and
    **activity** (last commit or session: green under 7 days, amber under 30, grey older).
  - One-click **Pause** or **Kill**, which asks for a one-line reason, hides the project,
    and records the change in yaml via a patch that preserves comments.
  - A "show paused/killed" toggle.
  - A project page lists its repos, domains, tasks, sessions, local dirt and revenue.
- **Hosting (`/hosting`)**
  - For each account: its apps (domain, app dir, threads), a 7-day SVG chart of
    processes and threads against the 200 limit with deploy markers, `next build` flags,
    the last deploys, and recommendations.
  - Recommendations are deterministic rules, for example:
    - over 80% of the limit at p95 → move the highest-thread app to the account with the
      most headroom;
    - more than one concurrent `next build` seen → stagger merges or deploys;
    - an app whose thread count sits far above its peers.
- **Inbox (`/inbox`)**: a quick-capture box, plus items from the UI, the CLI and Telegram.
  Each item has one-tap **→ task (pick project)**, **→ idea** or **drop**.
- **Ideas (`/ideas`)**: the parking lot. **Promote to project** always shows the gate, and
  both answers are required and stored:
  1. "Which live project is this more valuable than?", picked from live and earning
     projects.
  2. "What gets paused?", which pauses the named project in the same action.
  There is no way around the gate, and new ideas never create repos.
- **Goals (`/goals`)**: yearly and quarterly targets Anton sets, with progress bars.
  Values come from collectors (`sites_live` from domain checks, `projects_earning` and
  revenue from revenue entries, `leads_month` from the CRM), or from a manual value if
  there is no source yet. Each bar says where its number comes from.
- **Review (`/review`)**: the latest weekly review plus the archive (§8).

Plain-words map for site codes (`src/lib/explain.ts`, tested). Examples:
- `503` → "the Node app is down or restarting, often the process limit on Hostinger";
- `ENOTFOUND` → "the domain doesn't resolve: DNS is missing or the domain expired";
- `CERT_HAS_EXPIRED` → "the HTTPS certificate expired, so visitors see a warning".

### Ranking (`src/rank/today.ts`, pure, fully tested)

```
score = money × closeness ÷ effort_h
money     = project money_weight (1–5) × stage factor (earning 1.0, live 0.9, deployed 0.7, building 0.5, planned 0.2, idea 0.1)
closeness = by source: session ended mid-task 0.8 · HANDOFF next step 0.9 · plan phase ≥80% ticked 0.8 · known-issue 0.5 · TODO 0.3 · inbox/manual 0.5 (overridable)
effort_h  = task estimate, default by source (0.5–4 h), minimum 0.25
```
- Paused and killed projects are excluded.
- A **maximum of 2 of the 3** can come from one project, so one stuck project can't take
  the whole day.
- A task gets a +50% boost if its project has an open red alert that the task addresses.
- Ties go to the most recently active project.
- Pinned tasks always take a slot.

The AI (§7) may only **reorder the top 10 deterministic candidates** and write the reason. It
can't add tasks. If the AI is off, over its cap, or fails, the deterministic order is used.

### Copy prompt (`src/prompts/build.ts`)

Ported mandatory header plus a template by source kind:
```
Repo: C:\Claude 1\<dir> (github antonmarklundcom/<repo>)   Read AGENTS.md / CLAUDE.md first.
Goal: <task title + context from the source file>
Source: <file:line>
Definition of done: <template DoD, e.g. build + tests pass, site answers 200, item removed from KNOWN-ISSUES.md>
Branch: claude/<slug> or codex/<slug>. Stop and report with files changed and what you verified.
```
The AI may polish the goal paragraph. The header and the DoD are always deterministic.

---

## 7. AI layer

- **Uses.** The client is `src/ai/`. It's used for exactly four things:
  (1) the Today reorder plus reason;
  (2) session summaries;
  (3) polishing the copy-prompt goal paragraph;
  (4) writing the weekly review prose.
  Everything else is plain code.
- **Model and key.** `config.ai.model` defaults to `claude-sonnet-5`, the latest Sonnet as
  of this plan. `ANTHROPIC_API_KEY` is read from `.env.local` only.
- **Cache.** `ai_cache` is keyed on a hash of purpose, model and input. Session summaries are
  cached per file mtime. Today is cached per day plus the input hash.
- **Cap.** `config.ai.daily_usd_cap` defaults to **$0.50**. `usd` is computed from the
  response's usage and a price table in config. Once the cap is reached, every caller falls
  back to its deterministic path and the footer says "AI paused: daily cap".
- Strict JSON output and sanitizing, ported from v3. The key is never logged, and errors are
  logged with the key redacted.

## 8. Rhythm: Telegram and the weekly review

- **Separate bot.** aiinsights receives Telegram by **webhook**. A local app can't take a
  webhook on 127.0.0.1, and Telegram refuses `getUpdates` on a bot that has a webhook set.
  So coachme uses **its own bot with long polling**. It reuses aiinsights'
  `src/lib/telegram*.ts` approach (formatting, splitting, chat-id allowlist) by copying
  those modules, not by sharing the bot.
- **Access.** It only accepts messages from `TELEGRAM_CHAT_ID`. Plain text goes to the
  inbox. `/today` replies with the 3 actions. `/idea …` goes to ideas.
- **Daily push** at 08:00 America/Asunción: red alerts plus the 3 actions. Nothing is sent on
  a day that has neither. Each red alert is pushed **once** when it opens, and once when it
  closes. That's the whole notification contract.
- **Weekly review**, Sunday 18:00. It covers:
  - **shipped**: merged PRs and deploys, plus stage raises;
  - **broke**: alerts opened or still open;
  - **earned**: revenue entries and leads;
  - **stalled**: projects in building, deployed or live with no commit or session for
    14 days or more;
  - **suggested kills**: stalled for 30 days or more, below live, with money weight ≤ 2,
    with a one-tap **Pause** or **Kill** in the UI.

  It's stored in `/review` and sent to Telegram.

## 9. Configuration and secrets

- `config.yaml` (committed) holds non-secret settings: intervals, `local_roots`, the AI cap
  and prices, `fx`, notification times, and the process limit.
- `.env.local` (git-ignored) holds the secrets. `.env.example` is committed with names only:
  - `ANTHROPIC_API_KEY`
  - `TELEGRAM_BOT_TOKEN`
  - `TELEGRAM_CHAT_ID`
  - `VENDERCRM_STATS_KEY`
  - `GSC_CLIENT_ID`
  - `GSC_CLIENT_SECRET`
  - optionally `NEON_DATABASE_URL`, for the one-time import
- SSH keys stay in `~/.ssh`. Yaml holds only the path. GSC refresh tokens go in
  `data/secrets.json`, which is git-ignored and never shown in the UI.
- The pino logger has a redaction list, and the same `redact()` runs on every error
  message before it is stored.

---

## 10. Phases: one PR each, stop and report after each

Every phase must pass the same gates:
- `npm test` and `npm run build` are green.
- `npm start` serves on `127.0.0.1:4000` with **real data from this machine**. That includes
  a check that `curl http://<LAN-IP>:4000` is refused.
- A report lists the files changed, what was verified by running it, and what was skipped or
  uncertain.
- No GitHub Actions are added.

Each phase also has its own acceptance checks:

**Phase 1: Foundation.** Teardown (§1), new skeleton, schema, `portfolio.yaml` generator,
the `github` and `local` collectors, the Portfolio board, and the collector freshness framework.
- [ ] `docs/history/` holds v1–v3. The `PLAN.md`/`plan.md` collision is gone (a clean clone
  on Windows gives no warning). `.github/workflows/test.yml`, `pg`, `next` and `web-push`
  are removed.
- [ ] `coach portfolio generate` produces a valid `portfolio.yaml` covering all **87** GitHub
  repos plus the local-only ones. A second run changes nothing in `portfolio.yaml` except
  `unassigned:` additions (tested with a fixture).
- [ ] Yaml validation errors name the line.
- [ ] The github collector stores snapshots for every repo in a single run, in under
  60 seconds. A fixture test covers the CI states green, red, none and unknown.
- [ ] The local collector lists dirty and unpushed repos under `C:\Claude 1`, maps them by
  remote, and flags the 9 without an antonmarklundcom remote.
- [ ] Forcing a collector to throw (env `COACH_FAIL=github`) leaves the app up and shows
  "stale since…".
- [ ] The Portfolio board renders every project with its CI and activity dots. Pause and
  Kill persist to yaml with comments intact (tested), and the project hides.

**Phase 2: Health.** The `domains` and `hostinger` collectors, the Hosting view, and alerts.
- [ ] Every domain in yaml has a check row within one interval. The explain map has a test
  for each code class.
- [ ] State-change alerts are tested with a fixture sequence (200 → 503 → 200 opens, then
  closes, one red alert). Red alerts show in the nav badge.
- [ ] With SSH configured for at least one account, samples are stored every 10 minutes and
  the chart renders with deploy markers. Without SSH, the manual form stores a sample.
- [ ] The parser is tested on captured `ps` output fixtures. A test asserts the command
  constant contains no write or kill verbs.
- [ ] Hosting recommendations are tested for each rule.
- [ ] `ls ~/domains` results reconcile the yaml domains (new ones go to `unassigned`).

**Phase 3: Today.** The `notes` and `sessions` collectors, the task model, ranking,
copy-prompt, inbox in the UI and the CLI, and AI reorder plus summaries.
- [ ] Notes tasks carry `file:line`. Removing the line closes the task. Dedupe by hash is
  tested.
- [ ] Sessions: attribution tested on fixtures for the `cwd = C:\Claude 1` case. A redaction
  test with fake keys of every listed kind finds **zero** of them in the DB, the logs or the
  AI input.
- [ ] Ranking unit tests cover the formula, the per-project max of 2, pinned tasks,
  paused/killed exclusion, the red-alert boost, and the AI reorder being unable to inject
  tasks. The fallback works when the AI is off.
- [ ] Today shows at most 3 actions, each with a working Copy prompt (the clipboard contains
  the header, repo path and DoD).
- [ ] `coach add "…"` and the UI capture both land in the inbox. Triage to task or idea works.
- [ ] The AI spend cap is tested: once it's hit, calls fall back and the footer says so.

**Phase 4: Money.** The CRM leads collector (or the endpoint spec plus a task), revenue
entries, fx, and the Goals view.
- [ ] VenderCRM: either a read-only stats source is wired and leads per site per day are
  stored, or `docs/specs/vendercrm-stats-endpoint.md` exists and a task with a copy-prompt
  sits in the vendercrm project. The report says which.
- [ ] Revenue entries are added and edited in PYG and SEK, and totals convert via `fx`.
  `earning` is suggested once a project has a recent entry.
- [ ] Goals are editable. Each bar shows its value source. The leads dot on Portfolio is fed
  by CRM data where it exists.

**Phase 5: Rhythm.** The Telegram bot (capture, `/today`, the daily push, alert pushes), the
weekly review, and the idea gate.
- [ ] The bot ignores other chat ids (tested). The daily push is skipped on an empty day. An
  alert is pushed exactly once per open and once per close (tested).
- [ ] The weekly review is generated from a fixture week with every section covered, stored,
  and sent (a real message to Anton during verification).
- [ ] Promoting an idea can't skip the gate (route test), and the named project is paused
  in the same action.
- [ ] `scripts/register-task.ps1` and `unregister-task.ps1` exist. Anton runs the register
  script, and after a re-login `npm start` is up.

**Phase 6: Search Console and polish.** The GSC OAuth loopback, weekly clicks and impressions
per domain, trends on project pages, a speed pass (Today renders in under 200 ms on real
data), a backup script for `data/coach.db`, and the rewritten README and KNOWN-ISSUES.
- [ ] OAuth completes via 127.0.0.1, the token is stored git-ignored, and the collector
  stores weeks.
- [ ] The README tells Anton how to add a domain, an account and a goal in under one page.

---

## 11. How this gets built

The global CLAUDE.md sets the process: **this session plans and audits, and Codex CLI
(`gpt-6-astra`, reasoning effort low) writes the code.** Each phase is dispatched as one
Codex task with the phase's acceptance list as its definition of done. This session then
runs the gates itself (build, tests, `npm start`, the real-data checks). Failures go back to
the same Codex session with the exact error. The report to Anton labels which model produced
what. **Anton confirms this, or says Opus writes it directly, when approving.**

Branches are `v4/phase-<n>-<name>`, with one PR per phase. Nothing merges without Anton,
and CI is not used.

## 12. What Anton provides (and when)

| Input | Phase | Without it |
|---|---|---|
| Approve this plan, and pick builder: Codex (default) or Opus | now | Nothing starts |
| Make `antonmarklundcom/coachme` private | before Phase 1 merges | The business map sits in a public repo |
| Optional: Neon `DATABASE_URL` for a one-time read of v3 state | Phase 1 | The seed comes from `data/portfolio.json` (August data) |
| Hostinger accounts: label, SSH host, port and user, plus a key in `~/.ssh` with SSH enabled in hPanel, and which domains live where if known | Phase 2 | The manual hPanel number form. The domain → account mapping stays in `unassigned` |
| `ANTHROPIC_API_KEY` in `.env.local` | Phase 3 | Deterministic ranking and reasons, heuristic session summaries |
| A VenderCRM read key, if the endpoint exists | Phase 4 | Endpoint spec plus task |
| Revenue history, fx rates and goal targets | Phase 4 | Empty bars saying "set a target" |
| New Telegram bot via BotFather, plus the chat id | Phase 5 | No push. Capture still works in the UI and CLI |
| Run `register-task.ps1` | Phase 5 | Start with `npm start` by hand |
| Google Cloud OAuth client (desktop app) with the Search Console API enabled | Phase 6 | No GSC data |
| After Phase 5: delete the Vercel project, its crons and the Neon DB | after 5 | The old v3 pushes may keep arriving |

## 13. Risks and open questions, flagged not decided

1. **Process-limit root cause.** The chart shows correlation with deploys, but not
   causation. If the spikes don't line up with deploys, the next suspect is idle Next.js
   apps holding worker threads. The Phase 2 report will say which.
2. **Session attribution** is heuristic (§5). The sessions list shows the share that is
   "unattributed". If it is above 30%, a later phase asks whether to add a
   `.coach-repo` marker convention.
3. **Domain discovery** will be incomplete on the first run. About 60 domains are expected;
   the generator will find what code and Hostinger reveal, and Anton finishes it by hand
   once. That is the intended workflow, not a failure.
4. **"Closeness to done"** is estimated from the source kind. It will be wrong for some
   tasks, so every task has a one-tap override.
5. **Stage vocabulary change.** v3 used `deployable|sellable|marketed`. v4 uses the brief's
   stages. The v3 values map as `deployable → deployed`, `sellable|marketed → live`.
