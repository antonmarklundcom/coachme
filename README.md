# coachme — Portfolio Focus Coach

A coach for a 53-repo solo builder. Its one job: get already-finished code launched by
shrinking the activation energy of the final-mile ops step (Hostinger DB/hosting setup)
to a prepped, bookable, 20-minute copy-paste session — and keep the whole portfolio
honest about where attention should go.

## Architecture (settled — do not re-open)

- **This repo** holds all logic and state: the portfolio state file, the leverage
  scoring, the runbook generator, and the live-doc renderer. No hosting, no Node slot.
- **The dashboard** is a Claude Artifact in live-doc mode. Permanent URL, opens on
  phone or laptop. Checkboxes the owner ticks ("besikt DB done") persist and are read
  back by Claude on the next run via WebFetch.
- **The nudge** is a scheduled Claude Code Routine that fires daily in a fresh session:
  it reads `data/portfolio.json` + the live-doc's checked state, decides whether
  today earns a push notification (max one), refreshes the dashboard, and re-arms.

## Documents

| File | What it is |
|---|---|
| `DESIGN.md` | Diagnosis of the pattern + the full coaching logic: live-doc structure, nudge triggers and cadence, anti-annoyance rules, what each Routine run computes |
| `PLAN.md` | PR-numbered build plan with the owner-vs-agent split and the business decisions needed before/while building |
| `data/portfolio.json` | State of record for all 53 repos, seeded from the 2026-08 read-only audit |
| `runbooks/` | Generated per-repo DB/hosting setup runbooks (PR-2 output) — placeholders only, never real credentials |

## Operating principle

The coach optimizes for **finishing over starting**. It surfaces exactly one prepped
action per day, batches the 5-minute decisions, periodically asks the kill/keep
question about untouched repos, and celebrates launches. Under 5 minutes a day to use,
except the 20-minute DB sessions it exists to get booked.
