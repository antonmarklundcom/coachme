# coachme — Portfolio Focus Coach

A coach for a 53-repo solo builder. Its one job: get already-finished code launched by
shrinking the activation energy of the final-mile ops step (Hostinger DB/hosting setup)
to a prepped, bookable, 20-minute copy-paste session — and keep the whole portfolio
honest about where attention should go.

> **Superseded on 2026-08-28 by `plan.md`.** The coach is being rebuilt as a
> Next.js app on Vercel with its state of record in Neon Postgres — the
> *coaching logic* in `DESIGN.md` is unchanged, but the delivery architecture
> below (Claude Artifact live-doc + Routines, "no hosting, ever") is history.
> Read `plan.md` first; the sections below describe the first build and are kept
> as the record of it.

## Running the app

```bash
npm install
cp .env.example .env.local     # fill in DATABASE_URL, OWNER_SECRET, CRON_SECRET, …
npm run migrate                # apply migrations/*.sql
npm run seed                   # one-time: data/*.json → Postgres (re-runnable)
npm run dev                    # http://localhost:3000, gated by /login
npm run queue                  # the ranked launch queue, from the database
npm test                       # unit tests + the legacy script suite
```

The twice-weekly scan is `POST /api/scan` (and `GET`, which is how Vercel Cron
fires it), gated on `Authorization: Bearer $CRON_SECRET`:

```bash
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  "http://localhost:3000/api/scan?cap=3&force=besikt"
```

| Path | What lives there |
|---|---|
| `app/` | Routes: the dashboard placeholder, `/login`, `/api/scan` |
| `lib/` | `domain.ts` (vocabulary), `score.ts` (leverage scoring), `queries.ts` (every read/write), `auth.ts`, `scan/` |
| `migrations/` | Plain SQL, applied in order by `npm run migrate` |
| `scripts/` | `migrate.ts`, `seed.ts`, `queue.ts`, and `legacy/` — the pre-Vercel Node scripts, kept as the reference the ports were made from |

## Architecture of the first build (historical)

- **This repo** holds all logic and state: the portfolio state file, the leverage
  scoring, the runbook generator, and the live-doc renderer. No hosting, no Node slot.
- **The dashboard** is a Claude Artifact in live-doc mode. Permanent URL, opens on
  phone or laptop. Checkboxes the owner ticks ("besikt DB done") persist and are read
  back by Claude on the next run via WebFetch.
- **The scan** is a second Routine, Monday and Thursday, that re-reads only the repos
  that have actually moved since their last scan and writes what it finds into
  `data/portfolio.json`. It is silent by design — anything it learns that matters
  reaches you through the daily nudge, not as a second notification.
- **The nudge** is a scheduled Claude Code Routine that fires daily in a fresh session:
  it reads `data/portfolio.json` + the live-doc's checked state, decides whether
  today earns a push notification (max one), refreshes the dashboard, and re-arms.

## Documents

| File | What it is |
|---|---|
| `DESIGN.md` | Diagnosis of the pattern + the full coaching logic: live-doc structure, nudge triggers and cadence, anti-annoyance rules, what each Routine run computes |
| `SCAN.md` | The twice-weekly repo scan: its prompt, why it is incremental, and what a scan may and may not change |
| `ROUTINE.md` | The daily Routine: its exact prompt, schedule, and why each step exists |
| `PLAN.md` | PR-numbered build plan with the owner-vs-agent split and the business decisions needed before/while building |
| `data/portfolio.json` | State of record for all 53 repos, seeded from the 2026-08 read-only audit |
| `data/decisions.json` | The quick-decisions inbox: D1–D6 with their recommended answers |
| `data/config.json` | The dashboard's permanent Artifact URL and the hPanel burn-down baseline |
| `data/stacks.json` | Scanned stack metadata for the DB-blocked repos (engine, dialect, migration/seed commands) — never credentials |
| `data/nudges.json` | Nudge history for the anti-annoyance state machine |
| `runbooks/` | Generated per-repo DB/hosting setup runbooks (PR-2 output) — placeholders only, never real credentials |

## How you actually use it (no hosting, ever)

Nothing in this project runs on your PC and nothing gets hosted — not on Hostinger,
not on a free host, no `coach.antonmarklund.com` subdomain, no DNS:

- **On your phone or laptop** you open one thing: the dashboard's permanent
  `claude.ai` Artifact URL (bookmark it / add to home screen). Artifacts are
  **private by default** — only your Claude account sees it. Ticking boxes there is
  the entire daily interaction.
- **The code in this repo** runs inside Claude Code sessions in the cloud: the daily
  Routine spins up a session, runs the scripts, republishes the dashboard, and sends
  the push notification through the Claude app. You never start a server or a cron
  job anywhere. (You *can* also run the scripts locally with `node`/Claude Code CLI
  if you ever want to, but it's optional, not part of the design.)
- Your **Hostinger Node.js slots stay untouched** — that constraint is why the
  architecture is repo + Artifact + Routine in the first place.

## Privacy

- **This repo must be private.** It holds your portfolio state (`data/portfolio.json`),
  which is your business situation. Owner action, 30 seconds, do it first.
- The dashboard Artifact is private to your Claude account unless you explicitly share it.
- **No real credentials ever** enter this repo or the dashboard — runbooks use
  `<PASTE_PASSWORD>` placeholders; secrets live only in your password manager and
  local `.env` files on the machines that need them.

## Running the scripts

Plain Node (>=20), no dependencies, no build step:

```
node src/score.js            # ranked launch queue + the first proposed DB session
node src/score.js --batches  # every proposed DB session
node src/score.js --json     # machine-readable, for the Routine

node src/runbook.js                              # regenerate every runbooks/*.md
node src/runbook.js besikt                       # print one runbook
node src/runbook.js --scan ../antonmarklundcom   # re-read the target repos' stacks

node src/render.js                               # write dist/dashboard.html
node src/harvest.js <fetched-page.html>          # show what the page's ticks would change
node src/harvest.js <fetched-page.html> --apply  # write them into portfolio.json

node src/select.js                               # what would today's run do?
node src/run.js --dry --date 2026-08-25          # a full run, writing nothing
node src/run.js --page fetched.html              # a real run

node src/refresh.js --plan remote.json           # which repos need a deep scan
node src/refresh.js --apply results.json         # merge a scan into the record
node src/refresh.js --sweep                      # staleness + snooze proposals

npm test                     # node --test
```

The dashboard's permanent URL lives in `data/config.json`. `render.js` writes the
page; publishing it is a session action (the Artifact tool, `capabilities: {artifact: {}}`),
never something a script does — nothing here touches the network.

The page also carries the coach's own memory: `src/memory.js` embeds the nudge
history in an inert `application/json` block, and the next run adopts whatever
the page knows that the repo does not. A Routine session is not always permitted
to commit — and a coach that forgets what it said yesterday repeats it forever,
so the surface that always works carries the backup.

`runbook.js` is deliberately split in two: `--scan` reads local clones of the target
repos and records their stack in `data/stacks.json`; everything else is pure,
offline rendering from that file. Only the scan needs the clones present.

## Scope review and momentum

The coach asks, once a month, whether a repo should still exist: **keep**,
**snooze 90 days**, or **kill**. Two ignored reviews auto-propose a snooze rather
than asking a third time. **Kill is a flag in this repo and nothing else** — no
repository is ever archived on GitHub (Decision D4's default). Repos you put
down leave the queue and the batches, and are listed under "repos you have put
down" so nothing vanishes without a trace. A snooze expires on its own.

The streak in the momentum strip counts **days since an ask was dropped**, not
days of activity. A quiet day does not break it — silence is a feature, and a
streak that punished the coach for having nothing to say would measure the wrong
thing.

## Operating principle

The coach optimizes for **finishing over starting**. It surfaces exactly one prepped
action per day, batches the 5-minute decisions, periodically asks the kill/keep
question about untouched repos, and celebrates launches. Under 5 minutes a day to use,
except the 20-minute DB sessions it exists to get booked.
