# Phase S3 — Work desk `/repo/[name]`. Sonnet session. Lane 2, parallel with S4–S7.

Read ONLY: this file, `plan.md` §1, §4, §6 S3, the phase table and §9,
`docs/log/o3.md`, `docs/log/o4.md`. Reference: `app/components/QuickDecisions.tsx`
+ `app/components/AutoSubmitForm.tsx` (the write pattern), `app/components/OneThing.tsx`
(runbook + chat panel), `lib/queries.ts` exports named in the O3 log.
Execute under the autonomy protocol §4.

Owns: `app/repo/**`, `app/components/work/**`, `app/actions.ts` (append only),
`docs/log/s3.md`, a `/* == s3 == */` block appended to `app/globals.css`.

Hard limits (§4.7): no schema, auth, generator, dispatch, write-guard, scan or
ladder changes. Every write goes through a server action that calls an existing
`lib/` function. If a query you need is missing, compute in the page from existing
ones and note it in the log.

Budget: one session, ≤ 90 min. Open the PR the turn the exit criteria pass.

Phase rules:
- Branch `phase/s3-work-desk` off latest main. WIP commit every 30 min.
- Phone first: the one-liner must be selectable text, not only a copy button.
- Buttons follow the state machine in `lib/launch/items.ts`; render only the
  transitions that are legal from the item's current status.
- Merge button is enabled only when `pr_state = 'green'`; red or conflict shows why.
- Prompt preview is the raw markdown in a `<pre>`, collapsed by default.
- Re-runnable; minor issues → `docs/log/s3.md`; stop only per §4.4.

Exit: approve → dispatch (`copy`) → reload shows `dispatched`; drop works; merge
disabled on a non-green PR; Generate calls `/api/generate` and new proposals appear;
390px light + dark screenshots; build/lint/tsc/suite green; PR merged; log; §9 line.

## After this phase
Follow `prompts/_handoff.md`. Spawn nothing.
