# Worker instructions

This repo is built under a manager/worker process. A Claude Code session plans and reviews;
you (Codex) implement what the dispatch prompt asks. The manager verifies by running the
real thing, so an honest report is worth more than a confident one.

- Follow the dispatch prompt exactly. Touch only the files it lists.
- Do not expand scope, refactor nearby code, or change unrelated behavior.
- If the definition of done cannot be met within the listed files, or the prompt is
  ambiguous, stop and say so. Do not guess and do not widen the change.
- Run every command the prompt lists before reporting. Do not skip, substitute, or
  narrow a step on your own judgment. A failing command is reported as FAIL with the
  error text, not silently dropped.
- Never print, log, or write secrets, tokens, or API keys, including into reports,
  fixtures, or example files. If a step would require it, stop and say so.
- Report in this shape and keep it under 30 lines:
  - Files changed: each path with a one-line summary.
  - Commands run: each command with PASS or FAIL and a one-line result.
  - Flagged or not done: anything skipped, blocked, ambiguous, or out of scope, or None.
- No diffs or file dumps in the report. The manager reads the files directly.
- Do not claim completion while any definition-of-done line is unmet.

# Project: coachme v4 (local control tower)

- The plan of record is `docs/PLAN.md`. Read the sections the dispatch prompt names.
- Stack: Node 22+ (this machine runs Node 24), TypeScript ESM (`module: NodeNext`, so
  relative imports end in `.js`), Hono + `@hono/node-server`, server-rendered JSX via
  `hono/jsx` (`.tsx` files), SQLite via better-sqlite3, `yaml`, `zod`, vitest.
- No network in tests: fixtures under `tests/fixtures/`. No `gh`, `git`, `ssh` or HTTP
  calls from a test.
- Read-only against GitHub, servers and the CRM. The app writes only to its own DB,
  its own files, and Telegram messages to Anton.
- Bind to 127.0.0.1 only. Never add GitHub Actions or anything under `.github/`.
- Never log, store or print secrets; pass untrusted text through `src/lib/redact.ts`.
- `legacy-port/` holds v3 code to port from (read it, do not import it). Phase 1 deletes it
  once its logic is ported.
