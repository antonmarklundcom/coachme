# coachme v4

A local control tower for Anton's portfolio at **http://127.0.0.1:4000**. Every morning it
answers: what is broken, what is closest to money, and the 3 things to do today. It watches
GitHub, the checkouts under `C:\Claude 1`, agent sessions, the sites, Hostinger, VenderCRM,
revenue and Search Console, and writes only to its own database, its own files and Telegram.
Plan of record: [docs/PLAN.md](docs/PLAN.md). Open issues: [KNOWN-ISSUES.md](KNOWN-ISSUES.md).

## Run it

```
npm install
npm start          # builds if stale, serves on 127.0.0.1:4000, runs collectors and pushes
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1   # start at every logon (log: data\coachme.log)
```
Undo the logon task with `scripts\unregister-task.ps1`. `npm test` runs the fixture tests (no network).

## The three everyday edits

**Add a domain.** In `portfolio.yaml`, under the project:
```yaml
    domains:
      - { host: example.com.py, hosting: hst-a, app: php, crm_site: example, confidence: high }
```
`hosting` is an account id from `hosting_accounts`, `app` is `node`, `php` or `static`, and
`crm_site` is the site slug in VenderCRM (optional). The file reloads on save; the domain gets
its first check within 30 minutes (`coach collect domains` to check now). Domains the app finds
by itself land under `unassigned:`; move them into a project.

**Add a hosting account.** In `portfolio.yaml`:
```yaml
hosting_accounts:
  - id: hst-b
    label: Hostinger B
    ssh: { host: 1.2.3.4, port: 65002, user: u123456789, key: ~/.ssh/hostinger_b }   # optional
```
With `ssh` (key file in `~/.ssh`, SSH enabled in hPanel) processes are sampled every 10
minutes with one fixed read-only command. Without it, type the hPanel process count on `/hosting`.
Never put a password or key contents in the yaml.

**Add a goal.** On `/goals`, pick a period (`2026` or `2026-Q4`), a metric (revenue this month,
projects earning, leads this month, sites live, or custom), and a target. Each bar says where
its number comes from. Exchange rates and revenue entries are on the same page (or
`coach revenue add PROJECT AMOUNT PYG|SEK|USD|EUR [monthly] [CLIENT]`).

## Secrets (`.env.local`, never committed; names in `.env.example`)

| Name | Without it |
|---|---|
| `ANTHROPIC_API_KEY` | Deterministic ranking and reasons (AI capped at `ai.daily_usd_cap`, $0.50/day) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | No pushes; the weekly review is still written to `/review` |
| `VENDERCRM_STATS_KEY` or `VENDERCRM_FEED_TOKENS` | Leads show as "no data" |
| `GSC_CLIENT_ID`, `GSC_CLIENT_SECRET` | No Search Console data |

**Telegram:** create a bot with @BotFather (`/newbot`), send it a message, read your chat id from
`https://api.telegram.org/bot<TOKEN>/getUpdates`, put both values in `.env.local`, restart. Send
it text (goes to the inbox), `/today`, or `/idea …`. It pushes at 08:00 (only when there is
something), once when a red alert opens and once when it closes, and the Sunday 18:00 review.

**Search Console:** in Google Cloud, enable the Search Console API and create an OAuth client of
type *Desktop app*; put its id and secret in `.env.local`, restart, open `/gsc` and click
Connect. The token is stored in `data/secrets.json` (git-ignored). Weekly clicks and impressions
appear on each project page.

## CLI (`scripts\coach.cmd …`)

`add "text"` (inbox) · `today` · `task done|drop ID` · `collect all|NAME` · `status` ·
`review [--send]` · `push` · `backup` · `revenue add …` · `portfolio generate`

## Data

`data/coach.db` (SQLite) holds every observation. It is backed up daily to `data/backups/`
(14 kept; `coach backup` to do it now); snapshots older than 30 days are thinned to one per day.
Restore by stopping the server and copying a backup over `data/coach.db`.

## Safety

Binds to 127.0.0.1 only. Read-only against GitHub, git, Hostinger, websites, VenderCRM and
Search Console. The v1–v3 record is in [docs/history](docs/history/).
