# Known issues — coachme v4

Updated 2026-09-26, after phase 6. Newest first within each group.

## Needs Anton

- **Vercel check is red on every PR.** The v3 Vercel project is still connected to this repo
  and tries to build an app that no longer exists. v4 does not use Vercel. Fix: delete the
  Vercel project `coachme` (and its crons) and the Neon database (PLAN §12).
- **Not yet run against the real services.** The Telegram bot, the Search Console OAuth flow
  and the Windows logon task are tested with fakes only; the build environment could not reach
  api.telegram.org or Google, and has no Windows. First real run: `coach push`,
  `coach review --send`, Connect on `/gsc`, `scripts\register-task.ps1` then log off and on.
- **The repo is public**, so `portfolio.yaml` (the business map) is git-ignored. Make the repo
  private, then remove `portfolio.yaml` from `.gitignore` and commit it.
- **VenderCRM has no stats endpoint yet.** Leads come from contacts-export feed tokens
  (`VENDERCRM_FEED_TOKENS`) or show "no data". Spec: `docs/specs/vendercrm-stats-endpoint.md`;
  a task with a copy prompt sits in the vendercrm project.
- **Sites found broken at build time:** estudio.com.py and nombres.com.py answer 503;
  propia.com.py has no DNS; asado.com.py and flyttatillparaguay.se get SERVFAIL.

## Behaviour to know

- On the first start with Telegram configured, every red alert open at that moment is pushed
  once (after that only openings and closings).
- A missed Sunday review is caught up once within 3 days; older weeks are not backfilled.
- Search Console: a domain property is filtered to each host's own pages, so an apex domain that
  redirects to `www.` shows 0 clicks and the `www.` host carries them. Data lags about 3 days.
- Snapshots older than 30 days are thinned to one per subject per day after the daily backup.

## Heuristics (PLAN §13, flagged not decided)

- Hosting chart shows correlation between deploys and process spikes, not the cause.
- Agent-session attribution is heuristic; Today shows how many recent sessions could not be tied
  to a repo. If that share stays above 30%, consider a `.coach-repo` marker file.
- Domain discovery is incomplete by design; finish `unassigned:` in `portfolio.yaml` by hand.
- "Closeness to done" is estimated from where a task came from; every task has an effort override.

## Not built

- The optional one-time import of v3 state from Neon (phase 1). The portfolio was seeded from
  the August `data/portfolio.json` instead (now in `docs/history/data/`).
