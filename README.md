# coachme v4

A local-first control tower for Anton's portfolio. One page at http://127.0.0.1:4000 that
answers every morning: what is broken, what is closest to money, and the 3 things to do
today. Plan of record: [docs/PLAN.md](docs/PLAN.md).

## Run it

```
npm install
npm start        # builds if stale, then serves on 127.0.0.1:4000 and runs the collectors
npm test         # fixture tests, no network
npm run build
```

The CLI is `scripts\coach.cmd` (or `node dist/cli.js`):

| Command | What it does |
|---|---|
| `coach add "call the propia client"` | Capture to the inbox; works while the server is down |
| `coach today` | Print red alerts and today's 3 actions |
| `coach task done 42` / `coach task drop 42` | Close a task |
| `coach collect all` or `coach collect <name>` | Run collectors now: github, local, domains, hostinger, notes, sessions |
| `coach status` | Collector freshness |
| `coach review` / `coach review --send` | Write this week's review now (and send it to Telegram) |
| `coach push` | Send today's message (red alerts plus the 3 actions) to Telegram now |
| `coach portfolio generate` | First run creates `portfolio.yaml`; later runs only append new finds under `unassigned` |

## Where things live

- `portfolio.yaml` is the hand-edited map: projects, repos, domains, hosting accounts, stages.
  It is git-ignored while this repo is public.
- `config.yaml` holds non-secret settings: intervals, local roots, the AI model and daily cap.
- `.env.local` holds secrets (names in `.env.example`). It is never committed or logged.
- `data/coach.db` (SQLite) holds every observation with history.

## Today

Tasks come from `KNOWN-ISSUES.md`, `HANDOFF*.md`, the current phase of `plan.md`/`PLAN.md`,
`TODO`/`FIXME` comments, agent sessions that stopped mid-task, and the inbox. The ranking is
money × closeness ÷ effort (PLAN.md §6), with at most 2 of the 3 from one project. **Copy
prompt** gives a ready-to-paste Claude Code / Codex prompt with the repo path, goal and
definition of done.

With `ANTHROPIC_API_KEY` in `.env.local`, Sonnet reorders the top 10 and writes the reasons,
polishes the prompt goals, and summarises sessions. It stops at `ai.daily_usd_cap` (default
$0.50) and caches every answer. Without a key, everything still works deterministically.

Agent sessions are read from `%USERPROFILE%\.claude\projects` and `%USERPROFILE%\.codex\sessions`.
Only the repo, timestamps, and a redacted, truncated last request and summary are stored.

## Telegram and the weekly review

coachme has its **own** Telegram bot (not the aiinsights one, which uses a webhook) and reads
it by long polling, so nothing needs to reach this PC from outside.

1. In Telegram, talk to @BotFather, `/newbot`, and copy the token.
2. Send your new bot any message, then open
   `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and copy `message.chat.id`.
3. Put both in `.env.local`: `TELEGRAM_BOT_TOKEN=…` and `TELEGRAM_CHAT_ID=…`, then restart.

What it does (times in `config.yaml` under `notify`, owner timezone):
- Plain text you send goes to the inbox; `/today` answers with red alerts and the 3 actions;
  `/idea …` parks an idea. Messages from any other chat are ignored.
- 08:00: red alerts plus the 3 actions. Nothing is sent on a day with neither.
- A red alert is pushed once when it opens and once when it closes.
- Sunday 18:00: the weekly review (shipped, broke, earned, stalled 14+ days, suggested kills),
  stored on `/review` and sent. Without Telegram it is still written to `/review`.

Promoting an idea on `/ideas` always asks which live project it beats and which project gets
paused, and pauses that project in the same step.

## Start at logon

```
powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1     # npm start at every logon
powershell -ExecutionPolicy Bypass -File scripts\unregister-task.ps1   # remove it
```
Output goes to `data\coachme.log`.

## Hostinger SSH setup

Enable SSH in hPanel and keep the private key in `~/.ssh`. Add an `ssh` block to the account in
`portfolio.yaml`: `ssh: { host: server.example.com, port: 65002, user: u123456789, key: ~/.ssh/hostinger_a }`.
Never put a password or key contents in YAML. The collector runs one fixed read-only command
every 10 minutes. Without SSH, type the hPanel process count on `/hosting`.

## Safety

The server binds to 127.0.0.1 only. It is read-only against GitHub (`gh` queries), git (no
fetch or pull), Hostinger (one pinned `ps`/`ls` command) and websites (plain GET). It writes
only to its own database and files.

The v1–v3 record is in [docs/history](docs/history/).
