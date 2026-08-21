# ROUTINE — the daily run

This file is the source of truth for what the scheduled Routine does. The prompt
below is what the Routine actually fires with; if you change the prompt, change
it here first and copy it over (`update_trigger`), so the behaviour stays
version-controlled.

- **Schedule:** daily, `0 6 * * *` UTC = **08:00 Europe/Stockholm** (Decision D1's
  default — see "Timezone" below).
- **Mode:** fresh session per firing.
- **Push notification:** on.
- **Trigger id:** recorded in `data/config.json` as `routine_trigger_id`.

The session is a thin driver. All the logic lives in `src/`, tested by
`npm test` — the prompt only does the two things a script cannot: reach the
network, and publish.

---

## The prompt

```
You are the daily run of the portfolio focus coach in antonmarklundcom/coachme.
Follow these steps exactly and do not improvise beyond them. Everything you need
is already in the repo; the scripts hold all the logic.

1. Work on `main`. Run `npm test` first — if it fails, stop, push nothing, and
   report the failure. A broken build must never write to the state of record.

2. Read `data/config.json` for `artifact_url`. WebFetch that URL and save the
   returned HTML to `/tmp/page.html`. If the fetch fails, continue without it —
   run step 3 without `--page` rather than skipping the run.

3. Work out today's date in Europe/Stockholm (not UTC — the cap rules are about
   the owner's days), then run:

       node src/run.js --page /tmp/page.html --date <YYYY-MM-DD>

   It prints a JSON summary. That summary is the decision — do not second-guess
   it, do not add a nudge of your own, and do not push if it says push: false.

4. If `commit_needed` is true, commit `data/` (and only `data/`) directly to
   `main` with a message naming what changed, e.g.
   "coach 2026-08-25: qr db-setup cleared; nudge db-session". Then push.

5. Republish the dashboard: use the Artifact tool with
   file_path `dist/dashboard.html` and `url` set to `artifact_url` from
   `data/config.json`, so it updates in place and keeps the same link. Do not
   pass `capabilities` — omitting it carries the live-doc declaration forward.

6. Finish your turn:
   - If `push` is true, your final message must be exactly the summary's `title`
     on the first line and `body` on the second. Nothing else — no preamble, no
     encouragement, no restating the queue. That text is the notification.
   - If `push` is false, your final message must be exactly:
     "No push today. (<reason>)" — using the summary's `reason`.

Never write credentials anywhere. Never edit `src/`, `templates/` or
`runbooks/` — this run only moves state.
```

---

## What each step is for

| Step | Why it exists |
|---|---|
| `npm test` first | The run writes to the state of record. A failing suite means the logic is wrong, and a wrong write is worse than a missed day. |
| WebFetch → `--page` | The live-doc's markup *is* the document: the owner's ticks live in the served HTML and nowhere else. This is the only way to learn them. |
| `run.js` | harvest → resolve outcomes → select → apply → render, all of it tested. The prompt cannot drift from the design because it does not contain any of it. |
| commit `data/` only | State changes are data. Code changes go through a PR like anything else. |
| republish with `url` | Same permanent link, in place. Republishing without `url` would create a second artifact and orphan the one on the owner's phone. |
| the exact final message | The completion notification is the session's last message. Anything the model adds is something the owner reads on a lock screen at 08:00. |

## Timezone

Cron is UTC and does not follow daylight saving. `0 6 * * *` is 08:00 in
Stockholm from late March to late October, and 07:00 the rest of the year. When
the clocks change, one `update_trigger` call to `0 7 * * *` restores 08:00 —
or leave it, if an hour earlier in winter is fine.

Step 3 computes the *date* in Europe/Stockholm on purpose. "One push per day"
and "Sunday is silent" are about the owner's calendar, and a 06:00 UTC firing is
already the same day locally — but that stops being true if the fire time ever
moves earlier, so the script is told the local date rather than inferring one.

## Manual firing

To test without waiting for the schedule: `fire_trigger` with the trigger id, or
locally

```
node src/run.js --dry --date 2026-08-25    # decide and print, write nothing
node src/run.js --date 2026-08-25          # a real run
```

A second run on the same date is silent by design — the first one settled the
day, and that holds whether the first was a push or a deliberate silence.
