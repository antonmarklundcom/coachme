# Handoff — coachme v4 (2026-09-26)

All six phases of docs/PLAN.md are merged: plan (#23), phases 1–4 (#24–#27), phase 5 (#28),
phase 6 (this branch's PR). 139 tests green, build green. Open items: `KNOWN-ISSUES.md`.

## Phase 6: done in code
- [x] Search Console: OAuth installed-app flow with PKCE and a 127.0.0.1 loopback (`/gsc`),
  refresh token in git-ignored `data/secrets.json`, daily `gsc` collector storing weekly clicks
  and impressions per project domain (`gsc_weekly`), trends on project pages.
- [x] Speed pass: latest-snapshot views rewritten (migration 006); Today 161 → ~25 ms and
  Portfolio 137 → ~50 ms on a month of real-shaped data (`npx tsx scripts/bench.ts`); a test
  keeps Today under 200 ms.
- [x] Backups: `coach backup` and a daily automatic backup to `data/backups/` (14 kept), then
  snapshots older than 30 days are thinned to one per subject per day.
- [x] README rewritten (add a domain, an account, a goal on one page); `KNOWN-ISSUES.md` added.

## Owner (Anton), in this order
1. Delete the v3 Vercel project and its crons, and the Neon DB (the red Vercel check on PRs).
2. Make the repo private, then un-ignore and commit `portfolio.yaml`.
3. `.env.local`: `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`,
   `VENDERCRM_FEED_TOKENS` (or `VENDERCRM_STATS_KEY`), `GSC_CLIENT_ID` + `GSC_CLIENT_SECRET`.
4. `git pull`, `npm install`, `npm start`; click "Accept all" on /portfolio; Connect on /gsc.
5. `scripts\coach.cmd push` and `scripts\coach.cmd review --send`: check both arrive in Telegram.
6. `scripts\register-task.ps1`, log off and on, check http://127.0.0.1:4000.
7. Hostinger SSH keys (README), and fix the broken sites listed in KNOWN-ISSUES.
