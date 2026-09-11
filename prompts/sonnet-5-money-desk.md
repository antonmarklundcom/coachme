# Phase S5 — Money desk `/money`. Sonnet session. Lane 2, parallel with S3, S4, S6, S7.

Read ONLY: this file, `plan.md` §1 (D-H, D-I), §2 (repos revenue fields,
`revenue_checks`, `settings.weekly_report`), §4, §6 S5, the phase table and §9,
`docs/log/o3.md`. Reference: `app/components/QuickDecisions.tsx` +
`AutoSubmitForm.tsx`, `lib/queries.ts` (`patchRevenue`, `getRevenueChecks`,
`setRevenueCheck`, `getQueues`). Execute under the autonomy protocol §4.

Owns: `data/revenue-playbooks.json`, `lib/revenue/**`, `app/money/**`,
`app/components/money/**`, `tests/revenue*.test.ts`, `docs/log/s5.md`,
a `/* == s5 == */` block appended to `app/globals.css`.

Hard limits (§4.7): no schema changes; `lib/revenue/` is playbook lookup and
`ensureChecks` only, no scoring changes.

Budget: one session, ≤ 90 min. Open the PR the turn the exit criteria pass.

Phase rules:
- Branch `phase/s5-money-desk` off latest main. WIP commit every 30 min.
- Load `paraguay-business-apps` and `sweden-business-apps` before writing the
  playbooks: rails, invoicing rules and WhatsApp-first vs Swish/BankID differ.
- Playbooks: `saas`, `lead-gen`, `ecommerce`, `content-ads`, `service` × `py`, `se`;
  5–8 checks each; every check phrased as a verifiable fact ("pricing page answers
  200", "first invoice sent"), never a feeling.
- The table sorts by `money_distance`; experiments and `internal` repos are listed
  under a collapsed "not for sale" section, not hidden.
- Re-runnable; minor issues → `docs/log/s5.md`; stop only per §4.4.

Exit: editing every revenue field persists across reload; a check tick persists;
`ensureChecks` is idempotent (test); the weekly report renders from a seeded
`settings.weekly_report`; 390px both themes; build/lint/tsc/suite green; PR merged;
log; §9 line.

## After this phase
Follow `prompts/_handoff.md`. Spawn nothing.
