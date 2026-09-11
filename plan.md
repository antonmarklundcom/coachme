# plan.md — coachme v3, the launch desk

Supersedes `docs/history/plan-v2-vercel-neon.md` (the Vercel + Neon rebuild, phases
O1–S2, all merged 2026-08-28). Why v3 exists and what changed is in
`docs/report-2026-09-11.md`. `DESIGN.md` remains the record of the coaching logic
that v2 built; where this plan and DESIGN.md disagree, this plan wins.

## Phase table

| Phase | Lane | Model | Prompt file | Plan sections | Owns | Depends on |
|---|---|---|---|---|---|---|
| P0 | 0 | Sonnet (Anton present) | `prompts/p0-deploy.md` | §7 | `DEPLOY.md`, `docs/log/p0.md` | — |
| O3 | 1 | Opus | `prompts/opus-3-launch-model.md` | §2, §5 O3 | `migrations/0003_*.sql`, `lib/domain.ts`, `lib/queries.ts`, `lib/score.ts`, `lib/launch/**`, `lib/generate/**`, `scripts/seed.ts`, `data/portfolio.json` (stage/revenue fields only), `tests/launch*.test.ts`, `tests/generate*.test.ts`, `tests/score.test.ts`, `.env.example` | — |
| O4 | 1 | Opus | `prompts/opus-4-dispatch.md` | §5 O4 | `lib/github/**`, `lib/dispatch/**`, `lib/scan/**`, `lib/nudge/**`, `lib/report/**`, `app/api/dispatch/**`, `app/api/merge/**`, `app/api/generate/**`, `app/api/scan/**`, `app/api/nudge/**`, `proxy.ts`, `prompts/_watcher.md`, `tests/dispatch*.test.ts`, `tests/github*.test.ts`, `tests/nudge.test.ts`, `tests/scan.test.ts` | O3 |
| S3 | 2 | Sonnet | `prompts/sonnet-3-work-desk.md` | §6 S3 | `app/repo/**`, `app/components/work/**`, `app/actions.ts` (append only) | O3, O4 |
| S4 | 2 | Sonnet | `prompts/sonnet-4-prompt-library.md` | §6 S4 | `templates/prompts/**`, `tests/prompt-library.test.ts` | O3 |
| S5 | 2 | Sonnet | `prompts/sonnet-5-money-desk.md` | §6 S5 | `data/revenue-playbooks.json`, `lib/revenue/**`, `app/money/**`, `app/components/money/**`, `tests/revenue*.test.ts` | O3 |
| S6 | 2 | Sonnet | `prompts/sonnet-6-home-digest.md` | §6 S6 | `app/page.tsx`, `app/portfolio/**`, `app/components/*.tsx` (existing files), `app/globals.css` | O3, O4 |
| S7 | 2 | Sonnet | `prompts/sonnet-7-portfolio-refresh.md` | §6 S7 | `data/portfolio.json`, `data/stacks.json`, `docs/portfolio-audit-2026-09.md` | P0, O4 |
| S8 | — | Sonnet | `prompts/sonnet-8-link-pass.md` | §6 S8 | `app/layout.tsx`, `README.md`, `KNOWN-ISSUES.md`, `DEPLOY.md`, `.github/**` | all of lane 2 |

Lane 1 is sequential (O3 then O4). O4 creates the watcher Routine and spawns every
lane 2 phase at once. Lane 2 phases spawn nothing. S8 is spawned by the watcher when
every lane 2 PR is merged. P0 runs whenever Anton has 30 minutes; S7 is the only
phase that hard-depends on it.

---

## 1. Decisions already made — do not re-litigate

The v2 decisions in `docs/history/plan-v2-vercel-neon.md` §1 stand (Vercel + Neon,
`pg`, plain SQL migrations, stateless cookie auth, cron polling, two Hobby crons,
read-only chat, Fable never in a build). Added for v3, with their letter in
`docs/report-2026-09-11.md` §3:

- **D-A Launch desk, not coach.** The product's output is agent work (prompt files
  dispatched to Claude Code / Codex), PRs to merge, and a money path per repo. The
  nudge engine is the delivery channel for a daily digest, nothing more.
- **D-B Deploy first.** P0 is mandatory. It is done when the app answers at its
  Vercel URL with real Neon data and both crons show in the Vercel dashboard.
- **D-C Stage enum** on `repos`: `building | deployable | live | sellable |
  marketed | earning`. Automatic raises need evidence (§2); manual set is always
  allowed; automatic lowering never happens (drift guard).
- **D-D Work items** carry the prompt body and a status machine. `proposed` is an
  estimate; `approved` is Anton's tick; nothing dispatches without it.
- **D-E Dispatch primitive** is a file commit: `prompts/coachme/<slug>.md` on the
  target repo's default branch, plus the one-liner `Read prompts/coachme/<slug>.md
  in this repo and execute it.` Optional second target: a GitHub issue with the same
  body. The same file drives Claude Code and Codex.
- **D-F GitHub write guard.** `GITHUB_TOKEN` becomes a fine-grained PAT with
  Contents, Pull requests, Issues write on all account repos. `lib/github/write.ts`
  exposes exactly: `putPromptFile` (path must start with `prompts/coachme/`),
  `createIssue`, `mergePull` (squash; head branch must start with `coachme/`,
  `claude/` or `codex/`; checks must be green). Nothing else. Tests pin the path
  prefix, the branch prefix and the absence of any delete/force endpoint.
- **D-G PR tracking** runs inside the existing scan (`/api/scan`), linking PRs by
  head branch `coachme/<slug>` or a `[coachme:<slug>]` marker in the PR title.
- **D-H Ranking** is distance to first revenue first, v2 leverage score second.
- **D-I Money playbooks** are content in `data/revenue-playbooks.json`; per-repo
  tick state is the `revenue_checks` table.
- **D-J Ladder** gains two rungs on top (green PRs to merge; owner item on the
  closest-to-money repo). Caps unchanged. Monday's `/api/nudge` run also writes the
  weekly money report. Still exactly two crons.
- **D-K Models.** Generator + scan classifier: `claude-sonnet-5` via
  `lib/anthropic.ts`. Chat: Gemini Flash (unchanged). Phases: Opus / Sonnet only.
- **D-L Codex** is a dispatch target with no extra mechanism: the prompt file header
  names the branch and the PR-title marker; Codex cloud reads AGENTS.md and the file.
- **D-M Nothing from v2 is deleted.** Scope review, agent lane, push card and the
  D6 classifier move to `/portfolio`.
- **D-N Data refresh** is a phase (S7), run with real credentials against the live
  app, reconciling the 2026-08-28 61-repo audit.

## 2. Object model (the O3 contract — written once, never retrofitted)

Migration `migrations/0003_launch_desk.sql`. Enums as `CHECK` constraints, matching
v2 style.

**repos** gains: `stage text not null default 'building'` (D-C values);
`revenue_model text` (`saas | lead-gen | ecommerce | content-ads | service |
internal | unknown`); `price_note text`; `currency text` (`PYG | SEK | USD | EUR`);
`payment_rail text` (`stripe | swish | bancard | transfer | whatsapp-manual |
none`); `channel text` (first-customer channel, free text); `sell_url text`
(pricing / lead / checkout page); `first_revenue_at date`; `revenue_30d numeric`;
`stage_evidence jsonb default '[]'` (list of `{stage, evidence, at, source}`).

Stage evidence rules (`lib/launch/stage.ts`, pure, tested): `deployable` when the
repo builds green in CI or the scan classifier reports pct ≥ 90 and blocker in
`none | db-setup | credentials`; `live` when `live_url_ok` is true; `sellable` when
`sell_url` answers or `payment_rail` ≠ none; `marketed` and `earning` are manual
(`first_revenue_at` set ⇒ `earning`). A scan may raise by at most one stage per run
and writes the evidence; it never lowers.

**work_items**: `id serial, repo_id int references repos, slug text (unique with
repo_id, kebab-case, ≤ 40 chars), title text, kind text (agent | owner), tool text
(claude | codex | either | owner), model text null (opus | sonnet, agent items only),
stage_target text (stage enum), prompt_md text, one_liner text, estimate_minutes int
null (owner items), status text (proposed | approved | dispatched | in_progress |
pr_open | merged | done | dropped), source text (generator | owner | scan), branch
text null, pr_url text null, pr_number int null, pr_state text null (open | green |
red | conflict | merged), note text null, dispatched_at timestamptz null,
created_at, updated_at`. One `approved` or later item per repo at a time is the
UI's rule, not a constraint.

**dispatches**: `id, work_item_id, target text (repo-file | issue | copy),
commit_sha text null, issue_url text null, created_at` — the audit trail of every
write the app made to another repo.

**revenue_checks**: `id, repo_id, key text, label text, done_at timestamptz null,
source text (playbook | owner), unique (repo_id, key)`.

**settings** gains: `weekly_report jsonb null` (last Monday's money report, rendered
by S5/S6), `github_write_ok boolean default false` (set by O4's token probe).

**Generator contract** (`lib/generate/`): input = the repo row, its `stacks` row,
`fetchDocs()` output (the scan's doc shortlist), open PRs, the stage rules, and the
prompt-template index from `templates/prompts/` (S4 fills the library; O3 ships two
templates as the exemplar — `finish-feature.md` and `owner-step.md`). Output is
strict JSON: `{ stage_suggestion, items: [{slug, title, kind, tool, model,
stage_target, estimate_minutes, prompt_md}] }`, at most 3 items, omit rather than
guess, sanitized the same way `lib/scan/classify.ts` sanitizes. Every generated
`prompt_md` begins with the mandatory header (branch `coachme/<slug>`, PR title
`[coachme:<slug>] …`, "read AGENTS.md / CLAUDE.md first", the exit criteria, "stop
and open the PR when they pass"). Items land as `proposed`; a repo with an item in
`approved…pr_open` gets no new proposals. Runs inside the deep scan (same cap of 5
per firing) and on demand at `POST /api/generate?repo=<name>`.

**Ranking** (`lib/score.ts`): `money_distance = stageGap(stage) * 100 + (100 −
pct)`, lower is closer; queue order = money_distance asc, then v2 leverage score
desc. v2's invariant test stays green; a new test: a `live` repo at 60% outranks a
`building` repo at 95%.

## 3. Feature scope

Kept from v2 unchanged: six sections' logic, scoring port, runbook generator, drift
guard, incremental scan, nudge caps, Web Push + PWA, chat panel.

New in v3, by dependency chain:
1. Stage + revenue fields + work items + generator (O3).
2. GitHub write client + dispatch + PR tracking + merge + new ladder rungs +
   weekly money report + watcher (O4).
3. Work desk UI per repo (S3); prompt library (S4); money desk (S5); home digest +
   `/portfolio` (S6); data refresh (S7); link pass (S8).

## 4. Autonomy protocol

1. Work until the phase's exit criteria all pass; never ask permission for in-plan
   work.
2. One PR per phase: branch `phase/<id>` off latest `main`; create, watch and merge
   the PR when green; a red build is always the session's own work. Lane 2 phases
   never wait for each other, only for lane 1.
3. Minor non-blocking issues go to the phase's `docs/log/<phase>.md` "Known issues";
   keep building. S8 promotes still-open cross-phase items to `KNOWN-ISSUES.md`.
4. Stop and ask ONLY for a missing credential with no graceful fallback, or a
   bad-foundation decision (schema, auth, the dispatch/write guard, money math) where
   guessing wrong forces a rewrite. "Ask" means: append the question to
   `docs/decisions-needed.md`, commit, push, end the session. Never wait in-session.
5. Missing env values never block: document in `.env.example`, degrade gracefully.
   Without `DATABASE_URL` a phase provisions a local Postgres 16 like v2 did.
6. Every prompt is re-runnable: check what exists on the branch first, continue from
   the first unmet exit criterion. WIP commit at least every 30 minutes.
7. Lane 2 hard limits: no schema changes, no auth changes, no changes to the
   generator, dispatch, write-guard, scan or ladder contracts. Workaround + Backlog
   note instead.
8. **Model cost guardrail.** Fable is never used for a phase, subagent, spawned
   session, watcher or Routine. Phase tables name Opus and Sonnet only. Anything
   that seems to need Fable goes to `docs/decisions-needed.md` and the session ends.
9. **File ownership.** A phase writes only the paths in its `Owns` cell, plus its
   own `docs/log/<phase>.md`, a `/* == <phase> == */` block appended to
   `app/globals.css`, and one line in `docs/decisions-needed.md` if it has a
   cross-cutting wish for S8. On `git merge main` conflicts: main wins, re-apply your
   change on top. Never edit outside your Owns to resolve a conflict.
10. **Handoff.** Done = PR merged green + exit checklist passed + one pre-handoff
    audit (one re-run of build/tests/lint on main + one adversarial re-read of the
    merged diff, findings fixed in one follow-up commit) + phase log committed +
    index line in §9. Then: O3 spawns O4 (`create_session`, model `opus`, inherited
    environment and permission mode, never `plan`, prompt exactly `Read
    prompts/opus-4-dispatch.md in this repo and execute it.`). O4 creates the watcher
    Routine (`prompts/_watcher.md`), then spawns S3, S4, S5, S6 (S7 too if P0's log
    exists), up to 4 concurrently; the watcher spawns the rest. Lane 2 spawns
    nothing. S8 deletes the watcher before its closing report. Local-CLI fallback:
    same model continues in the same window; stop and report at a model switch.
11. **Phase log** `docs/log/<phase>.md`: ≤ 12 lines "Built", ≤ 8 "Decisions", ≤ 8
    "Known issues", one line "Verification: green on <commit>".
12. **Orientation read.** A fresh session reads: its prompt file, plan §1, §4, its
    own sections, the phase table, §9, and the logs of its `Depends on` phases.
    Not the v2 plan, not DESIGN.md unless the prompt says so, not every log.
13. **Polish cap.** One screenshot pass (≤ 5 pages × 2 widths) after the last code
    change; one Lighthouse run only if the exit criteria name a number; PR body
    written once, ≤ 25 lines. When the exit criteria pass, open the PR that turn.
14. **Screenshots live in CI or the PR, never in git.** `docs/screenshots/` is
    git-ignored.
15. **Decisions travel by files.** To change what a running phase does, edit its
    prompt file on main. Never message a running session.
16. **Write guard is sacred.** No phase, ever, adds a GitHub write capability beyond
    D-F. A phase that needs one writes to `docs/decisions-needed.md` and ends.

## 5. Lane 1 — Opus phases (sequential)

### O3 — Launch model, generator, ranking
- Migration `0003_launch_desk.sql` implementing §2 in full. `npm run migrate` applies
  it; `scripts/seed.ts` stays idempotent and seeds `stage` for the current data:
  `live_url_ok` ⇒ `live`; pct ≥ 90 ⇒ `deployable`; else `building`. `revenue_model`
  seeded `unknown` everywhere except the five `infra` repos (`internal`).
- `lib/domain.ts`: `STAGES`, `REVENUE_MODELS`, `PAYMENT_RAILS`, `WORK_STATUSES`,
  `WorkItem`, `Dispatch`, `RevenueCheck` types; `stageGap()`.
- `lib/launch/stage.ts`: the evidence rules; `lib/launch/items.ts`: status
  transitions (`proposed→approved→dispatched→pr_open→merged→done`, any → `dropped`,
  `in_progress` set by the scan when the branch exists but no PR yet), each illegal
  transition throws.
- `lib/queries.ts`: `getWorkItems(repoId?)`, `createWorkItems`, `setWorkItemStatus`,
  `updateWorkItem`, `getRevenueChecks`, `setRevenueCheck`, `setStage` (writes
  evidence), `patchRevenue`, `recordDispatch`, plus `getQueues` returning
  `money_distance` and stage.
- `lib/generate/`: `prompt.ts` (the generator system prompt, the mandatory prompt
  header, the JSON schema), `sanitize.ts`, `run.ts` (`generateForRepo(repoId)`),
  the two exemplar templates in `templates/prompts/` with a `templates/prompts/
  index.json` describing each template's `key`, `when`, `model_default`, `tool_default`.
- `lib/score.ts`: `money_distance` and the new order (§2). `npm run queue` prints
  stage and distance.
- `.env.example`: `GITHUB_TOKEN` re-documented as the D-F PAT (O4 uses it; O3 only
  documents).
- **Exit:** build, lint, `tsc --noEmit`, full test suite green; migration + seed
  against a real Postgres (Neon if `DATABASE_URL` exists, local otherwise) with 53
  repos all carrying a stage; `generateForRepo` run against one real repo with
  `ANTHROPIC_API_KEY` if present (else the degraded path documented, as v2 did)
  yielding ≤ 3 `proposed` items whose `prompt_md` starts with the mandatory header;
  new ranking test green; PR merged; `docs/log/o3.md`.

### O4 — Dispatch, tracking, ladder rungs, weekly report, watcher
- `lib/github/write.ts` per D-F, with a token probe (`GET /user` + a permissions
  check, sets `settings.github_write_ok`). Tests pin: path prefix, branch prefix,
  green-only merge, and that the module never references `DELETE`, `force`, or
  `git/refs` deletion.
- `lib/dispatch/run.ts`: `dispatch(workItemId, target)` → `putPromptFile` on the
  target repo's default branch (create or update, commit message
  `coachme: dispatch <slug>`), or `createIssue`, or `copy` (no write, just a status
  change); records the dispatch, sets `dispatched_at`, status `dispatched`.
  `app/api/dispatch/route.ts` and `app/api/merge/route.ts` are owner-gated (cookie),
  POST only, 503 without `OWNER_SECRET` like `/api/chat`.
- Scan: after `listPulls`, link PRs to work items (D-G), set `pr_url/pr_number/
  pr_state` using the check-runs API, advance status (`dispatched→in_progress` when
  the branch exists, `→pr_open` when a PR exists, `→merged` when merged). A merged
  work item whose `stage_target` evidence now holds raises the stage (§2 rules).
- `app/api/generate/route.ts`: owner-gated on-demand generation for one repo.
- Ladder: two rungs on top per D-J, `lib/nudge/ladder.ts` + tests; the digest body
  format `"2 PRs green · approve 1 item · owner: <title> (<min> min)"`.
- `lib/report/weekly.ts`: on Mondays (owner timezone) `/api/nudge` also computes the
  money report (per repo: stage, distance, last week's stage changes, items merged,
  the single closest-to-money owner step) into `settings.weekly_report`.
- `prompts/_watcher.md` reviewed against the final phase table; create the watcher
  Routine (hourly, fresh session, model `claude-sonnet-5`, prompt exactly `Read
  prompts/_watcher.md in this repo and execute it.`).
- **Exit:** tests for the write guard, dispatch state machine, PR linking and the two
  rungs green; a real dispatch against a scratch repo Anton owns if
  `GITHUB_TOKEN` has write scope (else the `copy` target end-to-end and the
  repo-file path against a mocked API, documented); `/api/nudge` on a seeded Monday
  produces both a decision and a `weekly_report`; PR merged; watcher created; lane 2
  spawned; `docs/log/o4.md`.

## 6. Lane 2 — Sonnet phases (parallel) and the link pass

Hard limits (§4.7) apply to every phase here.

### S3 — Work desk `/repo/[name]`
Stage badge with evidence; revenue fields (read-only here, edited in S5); the list
of work items grouped by status; per item: title, kind/tool/model chips, expandable
prompt preview, buttons **Approve**, **Dispatch → repo file**, **Dispatch → issue**,
**Copy one-liner** (with the one-liner visible as text for phones), **Drop**; PR
row with state and a **Merge** button enabled only when `pr_state = green`; a
**Generate** button calling `/api/generate`; the existing runbook + chat panel for
owner items. Server actions appended to `app/actions.ts`, each a thin call into
`lib/queries.ts` / `lib/dispatch`. **Exit:** approve → dispatch (copy target) →
status visible after reload; merge button disabled on a red PR; 390px both themes.

### S4 — Prompt library
`templates/prompts/`: `finish-feature.md`, `deploy-hostinger-node.md` (from
`nextjs-deploy-hostinger`), `deploy-php-hostinger.md` (from `php-site-template`),
`add-payments.md` (Stripe for SE/USD, Bancard or transfer + WhatsApp for PY, from
the market skills), `lead-form-vendercrm.md` (from `vendercrm-lead-capture`),
`seo-content-batch.md`, `fix-ci.md`, `owner-step.md` (O3's exemplar, refined),
plus `index.json` entries. Each template: the mandatory header, `{{placeholders}}`
the generator fills, exit criteria, the skills to load, and the model default.
**Exit:** every template passes a structural test (header present, exit section
present, no placeholder left unlisted in `index.json`); the generator, pointed at
the library, picks the matching template for two fixture repos.

### S5 — Money desk `/money`
`data/revenue-playbooks.json`: one playbook per `revenue_model × market` (PY, SE)
with 5–8 checks each (pricing page, payment rail live, first-customer channel
named, first outreach sent, first invoice, etc.). `lib/revenue/`: playbook lookup,
`ensureChecks(repo)` creating missing rows. `/money`: table of non-experiment repos
sorted by money distance; inline edit of `revenue_model`, `currency`,
`payment_rail`, `price_note`, `channel`, `sell_url`, `first_revenue_at`; the
checklist per repo; last weekly report rendered. **Exit:** editing a field persists;
ticking a check persists; the report renders from `settings.weekly_report`.

### S6 — Home digest and `/portfolio`
Home becomes: Momentum strip (unchanged) · **Merge** (green PRs, one tap each) ·
**Approve** (proposed items, top 5) · **Your one step** (the ladder's owner item,
runbook inline as today) · **Closest to money** (top 5 with distance) · link cards
to `/repo/…`, `/money`, `/portfolio`. `/portfolio` holds Launch queue, Quick
decisions + D6 classifier, Agent lane, Scope review, Push card, exactly as today.
**Exit:** all of v2's tick flows still persist from their new page; home renders
with zero work items without breaking; 390px both themes.

### S7 — Portfolio refresh (needs P0)
Against the live app: run `/api/scan?cap=10` repeatedly until every repo is
scanned; add the 8 repos from the 2026-08-28 audit to `data/portfolio.json` and
seed; mark the four `ecom` clones `related` to each other with a note; correct
`flyttatillspanien`'s note; run `/api/generate` for the 10 closest-to-money repos;
write `docs/portfolio-audit-2026-09.md` (one line per repo: stage, distance, first
proposed item). **Exit:** 61 repos in `repos`, each with `last_scan_at` after the
phase start, ≥ 10 repos with a `proposed` item.

### S8 — Link pass (after all lane 2 PRs merge)
Nav in `app/layout.tsx` (Home · Money · Portfolio), README rewritten for v3 (keep
the v2 section as history), `DEPLOY.md` gains the PAT scopes, KNOWN-ISSUES
promotion, CI screenshot job if missing, delete the watcher Routine, closing report
to Anton with the exact first actions to take in the app.

## 7. Human-inputs checklist

| Input | Needed for | First needed |
|---|---|---|
| Vercel project linked to this repo, Neon `DATABASE_URL`, `OWNER_SECRET`, `CRON_SECRET`, VAPID pair, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | P0 (`DEPLOY.md`) | P0 |
| `GITHUB_TOKEN` as a fine-grained PAT: all repos, Contents RW, Pull requests RW, Issues RW, Metadata R | O4's real dispatch test, S7, every dispatch afterwards | O4 (degrades to `copy` target without it) |
| One scratch repo for O4's real dispatch test (any throwaway) | O4 | O4 (optional) |
| Phone: install the PWA, accept push | digest delivery | after P0 |
| Make this repo private (D0 from v2, still open) | privacy | now |

## 8. Open business questions (parked)

- Which Hostinger account each DB-blocked repo lives in (D2) — a row in Quick decisions.
- Pricing per product — S5 gives the fields; the numbers are Anton's.
- Whether to let the app open the Claude Code / Codex session itself via an API once
  one exists; today it hands over the one-liner.

## 9. Build log index

| Phase | PR | Log |
|---|---|---|
| plan v3 | this PR | `docs/report-2026-09-11.md` |

## 10. Backlog

- Everything in v2's backlog (`docs/history/plan-v2-vercel-neon.md` §10).
- Auto-merge of green PRs for repos Anton flags as trusted.
- A GitHub App instead of a PAT once the dispatch volume justifies it.
- Reading Codex task status directly if an API appears.
