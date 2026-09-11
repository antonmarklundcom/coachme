# Phase S6 — Home digest and `/portfolio`. Sonnet session. Lane 2, parallel with S3–S5, S7.

Read ONLY: this file, `plan.md` §1 (D-J, D-M), §4, §6 S6, the phase table and §9,
`docs/log/o3.md`, `docs/log/o4.md`. Reference: `app/page.tsx` and every component it
imports (you are moving most of them), `lib/nudge/ladder.ts`'s new rungs (the digest
shape). Execute under the autonomy protocol §4.

Owns: `app/page.tsx`, `app/portfolio/**`, the existing `app/components/*.tsx`
files, `app/globals.css`, `docs/log/s6.md`.

Hard limits (§4.7): no schema, auth, ladder, scan or dispatch changes. Links to
`/repo/<name>` and `/money` are plain hrefs; S3/S5 build those pages in parallel, a
404 during your phase is expected and not yours to fix.

Budget: one session, ≤ 90 min. Open the PR the turn the exit criteria pass.

Phase rules:
- Branch `phase/s6-home-digest` off latest main. WIP commit every 30 min.
- Home order is fixed by §6 S6: Momentum · Merge · Approve · Your one step · Closest
  to money · links. Merge and Approve are server actions into existing `lib/`
  functions; Merge calls the same function `/api/merge` uses.
- `/portfolio` is a move, not a rewrite: the v2 sections keep their components and
  their tick flows byte-for-byte where possible.
- Empty states matter: zero work items, zero PRs, no weekly report yet — the page
  must still say what to do next (usually "Generate items on /repo/<top>").
- ONE screenshot pass at the end, ≤ 5 pages × 2 widths, into the PR, never git.
- Re-runnable; minor issues → `docs/log/s6.md`; stop only per §4.4.

Exit: every v2 tick flow (booked/done, decision accept, blocker clear, scope answer,
D6 next_step) persists from its new page; home with an empty `work_items` table
renders; home with seeded green PRs shows Merge rows; 390px both themes;
build/lint/tsc/suite green; PR merged; log; §9 line.

## After this phase
Follow `prompts/_handoff.md`. Spawn nothing.
