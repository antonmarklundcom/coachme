# Handoff gates — every phase, before it ends

A phase is done only when all four gates pass, in order:

1. **PR merged green** on `main` (branch `phase/<id>`, squash merge). Red CI is the
   session's own work; never merge red, never skip a test to get green.
2. **Exit checklist** from the prompt file passed, each item checked against the
   merged main, not the branch.
3. **Pre-handoff audit, once:** re-run `npm run build && npm run lint && npx tsc
   --noEmit && npm test` on main, then re-read the merged diff adversarially
   (what would break the next phase? what did the tests not cover?). Fix findings in
   ONE follow-up commit. No second round.
4. **Phase log** `docs/log/<id>.md` (§4.11 shape) and the §9 index line committed.

Then, per the phase table:
- **O3** → `create_session(model: "opus", prompt: "Read prompts/opus-4-dispatch.md
  in this repo and execute it.")`, inherited environment and permission mode, never
  `plan`.
- **O4** → create the watcher Routine (`prompts/_watcher.md`), then
  `create_session(model: "sonnet", …)` for S3, S4, S5, S6 (and S7 if
  `docs/log/p0.md` exists), at most 4 running at once; the watcher starts the rest.
- **S3–S7** → spawn nothing; end with the phase report.
- **S8** → delete the watcher; end with the closing report.

Local-CLI fallback (no `create_session`): continue in the same window only if the
next phase uses the same model; otherwise stop and tell Anton which prompt to paste
into which model's window.

Never message a running session. Never spawn Fable. If a decision needs Anton,
write it to `docs/decisions-needed.md`, commit, push, end.
