# Phase P0 — Deploy. Sonnet session, Anton present. Lane 0, any time.

Read ONLY: this file, `DEPLOY.md`, `plan.md` §1 (D-B) and §7. Do not read the rest.
This phase is the one v2 never got: the app running at its Vercel URL on real data.
Anton pastes the values into this conversation; the trade-off is stated in `DEPLOY.md`.

Ask Anton for, in one message: the Neon pooled `DATABASE_URL`, a `VERCEL_TOKEN`
(or confirmation that he will click the Vercel steps himself), `ANTHROPIC_API_KEY`,
`GEMINI_API_KEY`, and the fine-grained `GITHUB_TOKEN` (plan §7 scopes). Generate
`OWNER_SECRET`, `CRON_SECRET` and the VAPID pair yourself (`openssl rand -hex 24`,
`npm run vapid`) and print them once for his password manager.

Then, with `npx vercel` (token in `VERCEL_TOKEN`): `vercel link` to
`antonmarklundcom/coachme`, `vercel env add` for every variable in `.env.example`
for Production, `vercel --prod`. Run `npm run migrate && npm run seed` with
`DATABASE_URL` exported. Verify: dashboard loads with real data, `/login` gates,
`curl -H "Authorization: Bearer $CRON_SECRET" https://<app>/api/scan?cap=2` returns
200 and a `scan_events` row lands, `/api/nudge` decides once and is silent the
second time, both crons appear in Vercel → Settings → Cron Jobs (ask Anton to
confirm the tab, you cannot see it).

Write `docs/log/p0.md` (the URL, what was verified, what is still owner-only), add
the §9 index line, commit to `phase/p0-deploy`, open and merge the PR. Never commit
a secret; grep your diff for every value pasted before committing.

## After this phase
Tell Anton: install the PWA on the phone and accept push, then open an Opus window
with `Read prompts/opus-3-launch-model.md in this repo and execute it.` if O3 has
not run yet. Spawn nothing.
