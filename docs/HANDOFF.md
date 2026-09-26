# Handoff — coachme v4 (2026-09-26)

Merged to main: plan (#23), phase 1 (#24), phase 2 (#25), phase 3 (#26), phase 4 (#27). 114 tests green.

## Next
- [ ] Phase 5 (Rhythm), branch `v4/phase-5-rhythm`, PLAN.md §8 and §10:
  - Telegram bot with long polling: its **own** bot, not the aiinsights one, which uses a webhook. Copy the approach of aiinsights `src/lib/telegram.ts` (4000-char cut, HTML escaping, checking the `ok` field).
  - Accept only messages from `TELEGRAM_CHAT_ID`. Plain text goes to the inbox; `/today` and `/idea` also work.
  - Daily push at 08:00 Asunción (red alerts plus the 3 actions; skipped when there's nothing). Alert pushed once when it opens and once when it closes (`alerts.notified_at`).
  - Weekly review, Sunday 18:00: shipped, broke, earned, stalled >14 days, suggested kills. Stored and shown on `/review`, sent to Telegram (`src/ai/purposes.ts` writeWeekly already exists).
  - Idea gate on `/ideas` promote: "more valuable than which live project" plus "what gets paused". Pauses the named project.
  - `scripts/register-task.ps1` and `scripts/unregister-task.ps1` (at logon, run `npm start`).
  - Delete `legacy-port/`.
- [ ] Phase 6: Search Console OAuth (loopback), speed pass, backup script for `data/coach.db`, final README and KNOWN-ISSUES.

## Owner (Anton)
- Make the repo private (then un-ignore `portfolio.yaml`).
- Click "Accept all" on /portfolio (16 sites to live).
- `.env.local`: ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, VENDERCRM_FEED_TOKENS.
- Hostinger SSH keys (see README).
- Found live: estudio.com.py and nombres.com.py return 503; propia.com.py has no DNS; asado.com.py and flyttatillparaguay.se get SERVFAIL.
