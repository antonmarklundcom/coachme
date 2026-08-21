# SCAN — the twice-weekly repo scan

The daily Routine (`ROUTINE.md`) is cheap and never reads a repo. This is the
other half: a scan that goes and looks, twice a week and on request, and writes
what it finds into `data/portfolio.json`.

- **Schedule:** Monday and Thursday, `0 5 * * 1,4` UTC — an hour before the
  daily nudge, so the nudge that morning is already based on fresh state.
- **Mode:** fresh session per firing. **Push notification: off.** A scan updates
  the record silently; if the scan changed something that deserves your
  attention, the daily Routine at 06:00 is what tells you (DESIGN.md §3 — one
  push a day, from one place).
- **Model:** Sonnet is the right tier. This is reading against a fixed rubric,
  not judgement. Save the expensive model for deciding what to *do* about a
  blocked repo.
- **Trigger id:** `data/config.json` → `scan_trigger_id`.

## Why it is incremental

53 repos re-read twice a week is slow, expensive and almost entirely wasted —
most of them have not moved since Friday. So the scan asks GitHub for one cheap
listing first (`pushed_at` per repo) and deep-reads only what changed.

`node src/refresh.js --plan remote.json` makes that decision, and it deep-scans
a repo when any of these hold:

| Condition | Why |
|---|---|
| pushed since its last scan | there is genuinely something new to read |
| its head SHA moved | the same signal without an API call — `git ls-remote` |
| never scanned, and no audit baseline | nothing on record to trust |
| the record is 30+ days old | catches progress that happened outside git, and audit guesses |
| named in `force` | you asked |

The 2026-08 audit counts as every repo's baseline scan (`meta.baseline_scan`),
so the first real run is an incremental update against it rather than a cold
re-read of everything.

## The prompt

```
You are the twice-weekly repo scan for antonmarklundcom/coachme. Read repos,
write findings into the state of record, and stay silent — the daily Routine
does the talking.

1. Work on `main`. Run `npm test` first; if it fails, stop and report.

2. Build the cheap listing at /tmp/remote.json, in whichever of these ways
   works in this session — try them in order and stop at the first that does:

   a. GitHub MCP tools (list repos for antonmarklundcom), keeping name,
      pushed_at, archived.
   b. curl the REST API once:
      curl -s "https://api.github.com/users/antonmarklundcom/repos?per_page=100&sort=pushed"
   c. `git ls-remote <url> HEAD` per repo named in data/portfolio.json, and
      record { "head": "<sha>" } instead of pushed_at — refresh.js treats a
      moved head exactly like a newer push.

   Write it as { "<name>": { "pushed_at": "...", "archived": false }, ... }
   or { "<name>": { "head": "<sha>" }, ... }.

3. Run: node src/refresh.js --plan /tmp/remote.json
   That prints which repos to deep-scan. Scan ONLY those. If the list is empty,
   skip to step 6.

4. For each repo to deep-scan, in parallel batches of about six:
   - shallow clone it read-only:
     GIT_LFS_SKIP_SMUDGE=1 git clone --depth 1 <url> /tmp/scan/<name>
   - read, in this order, whichever exist: PLAN.md, PROGRESS.md, TASKS.md,
     ROADMAP.md, CLAUDE.md, AGENTS.md, README.md, docs/
   - read `git log -20 --date=short --pretty=%ad%x09%s`
   - check open and recently merged PRs for that repo with the GitHub tools

   From that, judge each field. Say nothing you did not see evidence for —
   omit a field rather than guess it:
     pct          0-100, how finished the shipped product is (not test coverage)
     last_commit  ISO date of the newest commit
     blocker      one of: db-setup, credentials, integration, facts,
                  confirmation, sibling, none, scope-undefined, deferred,
                  owner-setup-unclassified
     lane         one of the six lanes in data/portfolio.json meta
     next_step    ONE line: the very next action, and whose it is
     open_prs     count of open PRs
     merged_prs   count of PRs merged in the last 30 days
     live_url_ok  true only if you actually fetched a deployed URL and it worked
     head         the head SHA you cloned, so the next run can skip this repo

5. Write all of it to /tmp/results.json as { "<name>": { ...fields }, ... } and
   run: node src/refresh.js --apply /tmp/results.json

6. Run: node src/refresh.js --sweep

7. If anything changed, commit `data/` (and only `data/`) to `main` with a
   message summarising it, e.g. "scan 2026-08-24: 3 repos re-read, propia.node
   88% → 91%, 2 scope reviews due". Push.

8. Regenerate and republish the dashboard: `node src/render.js`, then the
   Artifact tool with file_path dist/dashboard.html and `url` set to
   `artifact_url` from data/config.json.

9. Finish with a one-line summary for the log. Do NOT write anything designed to
   be read as a notification — this run is silent by design.

Never edit src/, templates/ or runbooks/. Never write credentials anywhere.
Never lower a repo's percentage or re-block a repo directly — refresh.js
handles those as drift, which is a question for the owner, not a fact.
```

## What the scan may and may not change

`src/refresh.js` is what actually writes, and it is deliberately asymmetric:

| Finding | What happens |
|---|---|
| percentage went **up** | applied |
| percentage went **down** | **not applied** — raised as a verify item on the dashboard |
| a new blocker on a repo the owner never ticked clear | applied, and flagged `newly blocked on you` |
| a blocker on a repo the owner **did** tick clear | **not applied** — raised as a verify item |
| a live URL that answers | repo marked launched at 100% |
| owner-blocked three scans running | flagged `stuck` in the launch queue |
| untouched 30+ days and under 70% done | scope review due |
| scope review ignored twice | snooze auto-proposed (never applied) |

The rule underneath all of it: **a scan is an estimate, a tick is a fact.** When
they disagree the coach asks; it never silently reverts a human. Un-ticking
someone's finished work is the fastest way to lose their trust in the whole
system, and the drift guard exists so that cannot happen by accident.

## On request

```
node src/refresh.js --plan /tmp/remote.json     # what would be scanned
node src/refresh.js --apply /tmp/results.json   # merge findings
node src/refresh.js --sweep                     # staleness + snooze proposals
```

Or fire the Routine early: `fire_trigger` with `scan_trigger_id`, optionally
with text naming repos to force-scan.
