# Phase S4 — Prompt library. Sonnet session. Lane 2, parallel with S3, S5–S7.

Read ONLY: this file, `plan.md` §1, §4, §6 S4, the phase table and §9,
`docs/log/o3.md`, and O3's two exemplar templates + `templates/prompts/index.json`.
Execute under the autonomy protocol §4.

Owns: `templates/prompts/**`, `tests/prompt-library.test.ts`, `docs/log/s4.md`.

Hard limits (§4.7): content only. Do not touch `lib/generate/**`; if a template
needs a placeholder the generator does not fill, list it in `index.json` and note
it in the log for S8.

Budget: one session, ≤ 90 min. Open the PR the turn the exit criteria pass.

Phase rules:
- Branch `phase/s4-prompt-library` off latest main. WIP commit every 30 min.
- Load, per template: `nextjs-deploy-hostinger` (deploy-hostinger-node),
  `php-site-template` (deploy-php-hostinger), `sweden-business-apps` +
  `paraguay-business-apps` (add-payments), `vendercrm-lead-capture`
  (lead-form-vendercrm), `phased-autonomous-build` (finish-feature's shape).
- Every template: the O3 mandatory header verbatim, a "Read first" list, 3–6 phase
  rules, concrete exit criteria, the skills to load, `model_default` and
  `tool_default` in `index.json`. ≤ 40 lines each.
- Same-shaped units: write `finish-feature.md` fully first, then fan out the rest as
  parallel Sonnet subagents per `fable-directs-sonnet-builds`; one verify, one PR.
- Re-runnable; minor issues → `docs/log/s4.md`; stop only per §4.4.

Exit: 8 templates present; structural test green (header, exit section, every
`{{placeholder}}` listed in `index.json`); the generator with two fixture repos
(one Next.js DB-blocked, one PHP brochure) selects the expected template in a test;
build/lint/suite green; PR merged; log; §9 line.

## After this phase
Follow `prompts/_handoff.md`. Spawn nothing.
