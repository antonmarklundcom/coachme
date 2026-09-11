-- 0003_launch_desk — the launch desk's object model (plan.md §2, phase O3).
--
-- v2 could say how finished a repo was. It could not say how far it was from
-- money, and it had nowhere to put the work itself. Three things follow from
-- that, and this migration is all three:
--
--   stage + revenue fields on `repos` — where a repo is on the road from a
--       green build to a paid invoice (D-C), and which road it is on (D-I).
--       `stage_evidence` keeps WHY each raise happened, because a stage that
--       rose on a guess and a stage that rose on a fetched URL have to be
--       distinguishable later; the drift-guard principle from SCAN.md ("a scan
--       is an estimate, a tick is a fact") applied to stages.
--   work_items — the unit of work the desk actually hands out (D-D). It carries
--       the whole prompt body, not a pointer to one, so that what Anton
--       approved and what the agent reads are the same bytes even if the
--       generator, the template library or the model changes afterwards.
--   dispatches — the audit trail of every write this app made to ANOTHER repo
--       (D-E, D-F). Separate from work_items because one item may be dispatched
--       twice (a file commit AND an issue), and because an append-only log of
--       outbound writes is exactly what you want to be able to read when a
--       write guard is the thing standing between a coach and 61 repos.
--
-- `revenue_checks` is per-repo tick state for the S5 playbooks (D-I); the
-- playbook CONTENT is JSON in the repo, so adding a check later is a data
-- change, not a migration.
--
-- Enums are CHECK constraints, matching 0001's style: adding a value stays a
-- migration rather than a type rewrite.

/* ------------------------------------------------------------------ repos */

ALTER TABLE repos ADD COLUMN IF NOT EXISTS stage            TEXT NOT NULL DEFAULT 'building';
ALTER TABLE repos ADD COLUMN IF NOT EXISTS revenue_model    TEXT;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS price_note       TEXT;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS currency         TEXT;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS payment_rail     TEXT;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS channel          TEXT;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS sell_url         TEXT;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS first_revenue_at DATE;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS revenue_30d      NUMERIC;
ALTER TABLE repos ADD COLUMN IF NOT EXISTS stage_evidence   JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE repos DROP CONSTRAINT IF EXISTS repos_stage_check;
ALTER TABLE repos ADD CONSTRAINT repos_stage_check CHECK (stage IN (
  'building','deployable','live','sellable','marketed','earning'));

ALTER TABLE repos DROP CONSTRAINT IF EXISTS repos_revenue_model_check;
ALTER TABLE repos ADD CONSTRAINT repos_revenue_model_check CHECK (revenue_model IS NULL OR revenue_model IN (
  'saas','lead-gen','ecommerce','content-ads','service','internal','unknown'));

ALTER TABLE repos DROP CONSTRAINT IF EXISTS repos_currency_check;
ALTER TABLE repos ADD CONSTRAINT repos_currency_check CHECK (currency IS NULL OR currency IN (
  'PYG','SEK','USD','EUR'));

ALTER TABLE repos DROP CONSTRAINT IF EXISTS repos_payment_rail_check;
ALTER TABLE repos ADD CONSTRAINT repos_payment_rail_check CHECK (payment_rail IS NULL OR payment_rail IN (
  'stripe','swish','bancard','transfer','whatsapp-manual','none'));

-- The money desk and the home digest both sort by stage before anything else.
CREATE INDEX IF NOT EXISTS repos_stage_idx ON repos (stage);

/* ------------------------------------------------------------- work_items */

CREATE TABLE IF NOT EXISTS work_items (
  id                SERIAL PRIMARY KEY,
  repo_id           INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  -- kebab-case and short because it is also a branch name (`coachme/<slug>`)
  -- and a file name (`prompts/coachme/<slug>.md`) on the TARGET repo.
  slug              TEXT NOT NULL CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$' AND length(slug) <= 40),
  title             TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('agent','owner')),
  tool              TEXT NOT NULL CHECK (tool IN ('claude','codex','either','owner')),
  -- Opus or Sonnet only, ever (plan.md §4.8, the fable-cost-guardrail skill).
  model             TEXT CHECK (model IS NULL OR model IN ('opus','sonnet')),
  stage_target      TEXT NOT NULL CHECK (stage_target IN (
                      'building','deployable','live','sellable','marketed','earning')),
  prompt_md         TEXT NOT NULL,
  one_liner         TEXT NOT NULL,
  estimate_minutes  INTEGER,
  status            TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN (
                      'proposed','approved','dispatched','in_progress','pr_open',
                      'merged','done','dropped')),
  source            TEXT NOT NULL CHECK (source IN ('generator','owner','scan')),
  branch            TEXT,
  pr_url            TEXT,
  pr_number         INTEGER,
  pr_state          TEXT CHECK (pr_state IS NULL OR pr_state IN ('open','green','red','conflict','merged')),
  note              TEXT,
  dispatched_at     TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (repo_id, slug)
);

-- "What is open on this repo" (the generator's no-double-proposal rule, the
-- work desk's grouping) and "what is open anywhere" (the home digest) are the
-- only two ways this table is ever read.
CREATE INDEX IF NOT EXISTS work_items_repo_idx ON work_items (repo_id, status);
CREATE INDEX IF NOT EXISTS work_items_status_idx ON work_items (status, updated_at DESC);

/* ------------------------------------------------------------- dispatches */

CREATE TABLE IF NOT EXISTS dispatches (
  id            SERIAL PRIMARY KEY,
  work_item_id  INTEGER NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  target        TEXT NOT NULL CHECK (target IN ('repo-file','issue','copy')),
  commit_sha    TEXT,
  issue_url     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS dispatches_item_idx ON dispatches (work_item_id, created_at DESC);

/* --------------------------------------------------------- revenue_checks */

CREATE TABLE IF NOT EXISTS revenue_checks (
  id       SERIAL PRIMARY KEY,
  repo_id  INTEGER NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  key      TEXT NOT NULL,
  label    TEXT NOT NULL,
  done_at  TIMESTAMPTZ,
  source   TEXT NOT NULL DEFAULT 'playbook' CHECK (source IN ('playbook','owner')),
  UNIQUE (repo_id, key)
);

/* --------------------------------------------------------------- settings */

-- Monday's money report, rendered by S5/S6 and written by O4's weekly run.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS weekly_report    JSONB;
-- Set by O4's token probe: does GITHUB_TOKEN actually carry the D-F scopes?
-- Stored rather than probed per request so the UI can grey out "Dispatch →
-- repo file" without a round-trip to GitHub on every page render.
ALTER TABLE settings ADD COLUMN IF NOT EXISTS github_write_ok  BOOLEAN NOT NULL DEFAULT FALSE;
