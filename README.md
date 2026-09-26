# coachme v4

A local-first control tower for Anton's portfolio. Phase 1 tracks project stages,
GitHub CI and activity, local checkout dirt, and collector freshness.

Run `npm start` to build if stale and serve at http://127.0.0.1:4000.
Use `npm run build` and `npm test` to verify changes.

After building, use `scripts\coach.cmd` (or `node dist/cli.js`):

- `coach portfolio generate` discovers repositories and creates portfolio.yaml.
- `coach collect github`, `coach collect local`, or `coach collect all` collects observations.
- `coach status` shows collector freshness while the server is up or down.

config.yaml contains non-secret settings. Put credentials in .env.local; names
are documented in .env.example. GitHub collection requires authenticated gh.
The app binds only to 127.0.0.1 and uses read-only GitHub and git commands.

Edit portfolio.yaml for identity, domains and stages; changes sync automatically.
Later generator runs write portfolio.generated.yaml and only append new finds to
unassigned in portfolio.yaml. Local-only checkouts appear under local_only.
History lives in data/coach.db. Pause/kill require a reason; resume restores stage.

The v1-v3 record is in [docs/history](docs/history/).
# Hostinger SSH setup

Enable SSH in hPanel and keep the private key in `~/.ssh`. Add an optional `ssh` block to the account in `portfolio.yaml`: `ssh: { host: server.example.com, port: 65002, user: account_user, key: ~/.ssh/hostinger_a }`. Use your account's host, port and user; never put a password or key contents in YAML. The collector reads process counts every 10 minutes. Without SSH, enter the hPanel process count on `/hosting`.
