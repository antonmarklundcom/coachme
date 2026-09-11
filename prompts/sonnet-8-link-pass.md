# Phase S8 — Link pass. Sonnet session. Runs only after every lane 2 PR is merged.

Read ONLY: this file, `plan.md` §4, §6 S8, the phase table and §9, every
`docs/log/s*.md` and `docs/log/o*.md` "Known issues" section, and
`docs/decisions-needed.md`. Execute under the autonomy protocol §4.

Owns: `app/layout.tsx`, `README.md`, `KNOWN-ISSUES.md`, `DEPLOY.md`, `.github/**`,
`docs/log/s8.md`, plus any one-line cross-link wish another phase logged in
`docs/decisions-needed.md` for you.

Budget: one session, ≤ 60 min. Open the PR the turn the exit criteria pass.

Phase rules:
- Branch `phase/s8-link-pass` off latest main.
- Nav: Home · Money · Portfolio, plus a repo search box if trivial; nothing else.
- README: v3 first (what the app is, the daily loop, the dispatch one-liner, the
  PAT scopes), v2 and v1 kept below as history, shortened.
- `DEPLOY.md`: add the fine-grained PAT scopes from plan §7; nothing else changes.
- KNOWN-ISSUES: promote only still-open, cross-phase items from the phase logs; drop
  v2 items the phases closed (deployment, first real scan, first real chat call)
  once `docs/log/p0.md` / `s7.md` confirm them.
- CI: add a Playwright screenshot job uploading a PR artifact if none exists;
  `docs/screenshots/` git-ignored.
- Delete the watcher Routine (`list_triggers` → the one whose prompt names
  `_watcher.md` → `delete_trigger`) before writing the closing report.

Exit: nav works on every page; README/DEPLOY/KNOWN-ISSUES updated; build/lint/
suite green; PR merged; watcher deleted; §9 complete; closing report.

## Closing report (to Anton, as the session's last message)
The live URL; what each phase shipped in one line; open items from KNOWN-ISSUES;
the exact first three actions to take in the app (merge what is green, approve the
top proposals, dispatch the first one and paste its one-liner into an Opus or
Sonnet window per the item's `model`); the §7 human inputs still missing.
