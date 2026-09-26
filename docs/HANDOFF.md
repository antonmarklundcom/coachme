# Handoff — coachme v4 (2026-09-26)

Merged to main: plan (#23), phase 1 (#24), phase 2 (#25), phase 3 (#26), phase 4 (#27).
Phase 5 is on branch `claude/stoic-lamport-zcw3kp` (not merged). 127 tests green, build green.

## Phase 5 (Rhythm): done in code, owner checks left
- [x] Own Telegram bot, long polling (`src/notify/telegram.ts`, `bot.ts`): HTML escaping, 4000-char split, `ok` checked, token never in errors. Only `TELEGRAM_CHAT_ID` is answered; plain text → inbox, `/today`, `/idea …`. Update offset stored in `kv`.
- [x] Daily push at `notify.daily_at` (08:00), skipped on an empty day; red alert pushed once on open and once on close (`alerts.notified_at`, new `closed_notified_at`). `src/notify/rules.ts`, `rhythm.ts` (runs every minute from `src/server.ts`).
- [x] Weekly review Sunday 18:00 (`src/review/weekly.ts`): shipped (deploys, stage raises from the new `stage_changes` table, tasks done), broke, earned (revenue, leads), stalled ≥14 d, suggested kills. Stored in `reviews`, shown on `/review` with Pause/Kill, sent to Telegram. Catches up once if the PC was off, not more than 3 days late. `coach review [--send]`, `coach push`.
- [x] Idea gate on `/ideas/:id/promote`: both answers required and stored; the named project is paused and the idea becomes a `planned` project in one yaml write.
- [x] `scripts/register-task.ps1`, `scripts/unregister-task.ps1`.
- [x] `legacy-port/` deleted.
- [ ] Not verifiable in the cloud sandbox (api.telegram.org blocked, no Windows): Anton sets the bot env values, runs `coach review --send` and `coach push`, and checks a real message arrives; runs `register-task.ps1`, logs off and on, and checks http://127.0.0.1:4000 is up. The .ps1 scripts were not executed anywhere yet.
- Note: on first start with Telegram set, every red alert that is open at that moment is pushed once.

## Next
- [ ] Phase 6: Search Console OAuth (loopback), speed pass, backup script for `data/coach.db`, final README and KNOWN-ISSUES.

## Owner (Anton)
- Make the repo private (then un-ignore `portfolio.yaml`).
- Click "Accept all" on /portfolio (16 sites to live).
- `.env.local`: ANTHROPIC_API_KEY, TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID (new bot via @BotFather, steps in README), VENDERCRM_FEED_TOKENS.
- Hostinger SSH keys (see README).
- After phase 5 merges: delete the v3 Vercel project, its crons and the Neon DB (PLAN §12).
- Found live: estudio.com.py and nombres.com.py return 503; propia.com.py has no DNS; asado.com.py and flyttatillparaguay.se get SERVFAIL.
