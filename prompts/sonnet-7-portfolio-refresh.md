# Phase S7 — Portfolio refresh. Sonnet session. Lane 2, needs P0 merged.

Read ONLY: this file, `plan.md` §1 (D-N), §4, §6 S7, the phase table and §9,
`docs/log/p0.md` (the live URL, the secrets' names), `docs/log/o4.md`, and the
KNOWN-ISSUES section "Not from O1 — flagging before the first real scan run".
If `docs/log/p0.md` does not exist, stop: write one line to
`docs/decisions-needed.md` ("S7 waiting on P0") and end.
Execute under the autonomy protocol §4.

Owns: `data/portfolio.json`, `data/stacks.json`, `docs/portfolio-audit-2026-09.md`,
`docs/log/s7.md`.

Hard limits (§4.7): data and docs only. No code. You drive the live app through its
own endpoints with `CRON_SECRET` / the owner cookie; you never write SQL against Neon
by hand.

Budget: one session, ≤ 90 min. Open the PR the turn the exit criteria pass.

Phase rules:
- Branch `phase/s7-portfolio-refresh` off latest main. WIP commit every 30 min.
- Add the 8 missing repos to `data/portfolio.json` (stage `building`, tier
  `experiment`, blocker `owner-setup-unclassified` unless the README says
  otherwise), run `npm run seed` against the live `DATABASE_URL` (idempotent).
- Loop `GET /api/scan?cap=10` with the bearer token until no repo's `last_scan_at`
  predates the phase start; respect the serverless cap, never raise it.
- Mark the four `ecom` template clones `related` to each other; fix the
  `flyttatillspanien` note; both through `data/portfolio.json` + seed, then verify
  the rows changed.
- `POST /api/generate?repo=<name>` for the 10 lowest `money_distance` repos.
- The audit doc is one line per repo, sorted by distance; ≤ 80 lines total.
- Re-runnable; minor issues → `docs/log/s7.md`; stop only per §4.4.

Exit: 61 repos, all scanned after phase start, ≥ 10 with a `proposed` item; audit
doc committed; PR merged; log; §9 line.

## After this phase
Follow `prompts/_handoff.md`. Spawn nothing.
