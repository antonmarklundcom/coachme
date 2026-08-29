# Deploying coachme to Vercel — a step-by-step for Anton

**This has not happened yet.** Every build session (O1, O2, S1, S2) ran against a
local Postgres and had no Vercel account access, no `DATABASE_URL` for Neon, and no
`ANTHROPIC_API_KEY` — see `KNOWN-ISSUES.md`. That's fine for building and testing the
code, but it means the app has never actually been deployed. This file is the exact,
in-order checklist to do that — the human-inputs checklist from `plan.md` §7, turned
into commands and clicks.

Most of this needs your own Vercel/GitHub/Neon account access, which a Claude Code
session doesn't have — but a Claude Code session with this repo checked out *can*
run the commands (`npm run vapid`, `npm run migrate`, `npm run seed`, generating
`OWNER_SECRET`/`CRON_SECRET`) on your behalf if you paste in the connection string
and want the convenience. The only tradeoff: whatever you paste into a session
becomes part of that session's transcript. For a single-owner personal tool that's
a low-stakes tradeoff most people are fine with; if you're not, run the commands
below yourself instead, or rotate the values afterward (Neon: reset the DB
password; secrets: regenerate and overwrite the Vercel env values — no code
changes needed either way). It's 15–20 minutes, once.

## 1. Make the repo private (D0, overdue independent of this build)

GitHub → this repo → Settings → General → Danger Zone → **Change visibility → Private**.
It holds `data/portfolio.json`, your business situation.

## 2. Create the Neon database

1. https://console.neon.tech → **New Project**.
2. Copy the **pooled** connection string (`postgresql://...`).
3. Keep it — you'll paste it into Vercel's env vars in step 5, and use it locally
   below to run the migration once.

## 3. Create the Vercel project

1. https://vercel.com/new → **Import Git Repository** → pick `antonmarklundcom/coachme`.
2. Framework preset auto-detects Next.js. Don't change the build command.
3. **Don't deploy yet** — click through to the project without waiting for the first
   build, or let it fail once; it needs the env vars from step 5 first anyway.

## 4. Generate the secrets you don't already have

Run these from your own machine (`git clone`, `npm install` first) or any shell with
Node ≥20 — not inside a Claude Code build session, so nothing generated here ever
touches a session transcript:

```bash
# OWNER_SECRET and CRON_SECRET: any strong random string each, e.g.
openssl rand -hex 24   # run twice, once per secret

# VAPID keypair for Web Push — generates fresh, prints once, writes nothing to disk:
npm run vapid
```

Save all four values (plus the Neon `DATABASE_URL` from step 2) in your password
manager now — this is the only place the raw values need to live besides Vercel's
env settings.

## 5. Set the Vercel project's environment variables

Vercel project → **Settings → Environment Variables**. Add each of these for
**Production** (and Preview, if you want PR previews to work too) — see
`.env.example` for what each one does and how the app degrades if it's missing:

| Variable | Value |
|---|---|
| `DATABASE_URL` | the Neon pooled connection string from step 2 |
| `OWNER_SECRET` | from step 4 |
| `CRON_SECRET` | from step 4 |
| `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` | from step 4 |
| `GITHUB_TOKEN` | a read-only PAT, `repo` scope on public repos is enough |
| `ANTHROPIC_API_KEY` | for the scan classifier and the chat panel |

Then **Deploy** (Deployments tab → redeploy, or push any commit to `main`).

## 6. Run the migration and seed against Neon — once

From your own machine, with `DATABASE_URL` pointed at the **same** Neon string you
put in Vercel:

```bash
export DATABASE_URL="postgresql://...neon..."
npm run migrate   # applies migrations/0001_init.sql, 0002_nudge_engine.sql
npm run seed      # one-time: data/*.json → Postgres (idempotent, re-runnable)
```

Confirm the counts match what O1's build log recorded against local Postgres:
53 repos, 12 stacks, 6 decisions.

## 7. Confirm the cron jobs are actually scheduled and firing

**No build session has ever verified this against the real deployment** — it needs
the Vercel dashboard, which no Claude Code session in this build has had access to.
Check it yourself:

1. Vercel project → **Settings → Cron Jobs**. You should see two entries, matching
   `vercel.json`: `/api/scan` at `0 7 * * 1,4` and `/api/nudge` at `0 11 * * *` (both
   UTC — 04:00 / 08:00 America/Asunción).
2. Vercel project → **Observability** (or **Logs**) tab, filter to `/api/scan` and
   `/api/nudge` — after the next scheduled time passes, you should see an invocation
   with a `200` and a log line from `lib/scan/run.ts` / `lib/nudge/run.ts`.
3. If you don't want to wait for the schedule: trigger either manually —
   `curl -H "Authorization: Bearer $CRON_SECRET" https://<your-app>.vercel.app/api/scan`
   (same for `/api/nudge`) — and confirm a `scan_events` / `nudges` row landed in Neon.

If the Cron Jobs tab is empty, the most common cause is deploying from a branch or a
stale build before `vercel.json` existed — redeploy from `main` after step 5.

## 8. Open it on your phone (plan.md §7's final human step)

1. Visit `https://<your-app>.vercel.app/login` on Android Chrome, sign in with
   `OWNER_SECRET`.
2. Menu → **Add to Home Screen**. A real app icon should appear (this is what
   `public/manifest.json` + `public/sw.js` + Lighthouse's installability check in O2
   proved works, structurally).
3. Open the installed app once — accept the push-notification permission prompt.
   The dashboard's push card (bottom of the page) confirms the subscription reached
   `push_subscriptions` in Neon.
4. Book the first real DB session on a `db-setup` repo (`besikt` is the reference
   quality bar for its runbook) — that's the entire point of this tool.

## Verifying it's actually working, end to end

- Dashboard loads and shows real data (not the "DATABASE_URL is not set" warning) →
  steps 3, 5, 6 all correct.
- `/login` works, other pages redirect to it when signed out → `OWNER_SECRET` correct.
- A manual `curl .../api/scan` with the right bearer token returns 200 and a repo's
  `last_scan_at` updates → `GITHUB_TOKEN` (and `ANTHROPIC_API_KEY`, for the
  classification step) correct.
- Today's One Thing shows a real runbook (not "no stack metadata yet") for a
  `db-setup` repo, and the "Ask about …" panel answers a question → chat working.
- A test push arrives on your phone after step 8 → VAPID keys correct end to end
  (the FCM hop is the one link O2 could never test from a sandboxed container).
