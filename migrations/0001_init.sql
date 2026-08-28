-- 0001_init — the whole schema (plan.md §2).
--
-- Written in full in phase O1 even though O2/S1/S2 use most of it: later phases
-- are forbidden from changing the schema, so nothing here may be retrofitted.
--
-- Lane / blocker / tier values match data/portfolio.json `meta` exactly. They are
-- CHECK constraints rather than Postgres enums so that adding a value later is a
-- migration, not a type rewrite — but adding one still means updating DESIGN.md.

CREATE TABLE IF NOT EXISTS repos (
  id                        SERIAL PRIMARY KEY,
  name                      TEXT NOT NULL UNIQUE,
  github_full_name          TEXT,
  pct                       INTEGER NOT NULL DEFAULT 0 CHECK (pct BETWEEN 0 AND 100),
  lane                      TEXT NOT NULL CHECK (lane IN (
                              'launch-owner-blocked','launch-agent-drivable',
                              'mid-agent-drivable','mid-owner-stalled',
                              'early-open','early-owner-stalled')),
  blocker                   TEXT NOT NULL CHECK (blocker IN (
                              'db-setup','credentials','integration','facts',
                              'confirmation','sibling','none','scope-undefined',
                              'deferred','owner-setup-unclassified')),
  tier                      TEXT NOT NULL CHECK (tier IN ('infra','revenue','experiment')),
  hostinger_account         TEXT,
  market                    TEXT CHECK (market IN ('se','py')),
  next_step                 TEXT,
  open_prs                  INTEGER NOT NULL DEFAULT 0,
  merged_prs_30d            INTEGER NOT NULL DEFAULT 0,
  live_url                  TEXT,
  live_url_ok               BOOLEAN,
  launched_at               DATE,
  -- The scoring graph (DESIGN.md §4). Dropping these would silently gut ranking.
  unblocks                  JSONB NOT NULL DEFAULT '[]'::jsonb,
  depends_on                JSONB NOT NULL DEFAULT '[]'::jsonb,
  related                   JSONB NOT NULL DEFAULT '[]'::jsonb,
  unblocks_revenue          BOOLEAN,
  notes                     TEXT,
  -- Drift-guard provenance: a blocker the OWNER ticked clear, with the date.
  cleared_blockers          JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Scope-review state machine (DESIGN.md §2.5).
  snoozed_until             DATE,
  scope_review_due          BOOLEAN NOT NULL DEFAULT FALSE,
  scope_review_proposed     TEXT,
  scope_reviews_unanswered  INTEGER NOT NULL DEFAULT 0,
  kept_at                   DATE,
  killed_at                 DATE,
  -- Scan bookkeeping.
  last_commit_at            DATE,
  pushed_at                 TIMESTAMPTZ,
  last_scan_at              TIMESTAMPTZ,
  last_scan_head_sha        TEXT,
  blocked_scans             INTEGER NOT NULL DEFAULT 0,
  newly_blocked_at          DATE,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS repos_blocker_idx ON repos (blocker);
CREATE INDEX IF NOT EXISTS repos_last_scan_idx ON repos (last_scan_at NULLS FIRST);

-- One row per DB-blocked repo: what the runbook generator (S2) renders from.
-- Stack metadata only — never a credential, only the NAMES of env vars.
CREATE TABLE IF NOT EXISTS stacks (
  repo_id             INTEGER PRIMARY KEY REFERENCES repos(id) ON DELETE CASCADE,
  -- The package.json name, which is often not the repo name (besikt → rapportverket).
  package_name        TEXT,
  engine              TEXT,
  dialect             TEXT,
  package_manager     TEXT,
  migrations          INTEGER NOT NULL DEFAULT 0,
  scripts             JSONB NOT NULL DEFAULT '{}'::jsonb,
  env_file            TEXT,
  env_session         JSONB NOT NULL DEFAULT '[]'::jsonb,
  env_deferred_count  INTEGER NOT NULL DEFAULT 0,
  notes               JSONB NOT NULL DEFAULT '[]'::jsonb,
  scanned_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The quick-decisions inbox (DESIGN.md §2.3).
CREATE TABLE IF NOT EXISTS decisions (
  id           TEXT PRIMARY KEY,
  question     TEXT NOT NULL,
  needed_for   TEXT,
  recommended  TEXT,
  why          TEXT,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','corrected')),
  answer       TEXT,
  batch        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at  TIMESTAMPTZ
);

-- Nudge history for the anti-annoyance state machine (DESIGN.md §3).
-- repo_names is a list because one nudge covers a whole DB batch.
CREATE TABLE IF NOT EXISTS nudges (
  id          SERIAL PRIMARY KEY,
  repo_names  JSONB NOT NULL DEFAULT '[]'::jsonb,
  type        TEXT NOT NULL CHECK (type IN (
                'db-session','booked-reminder','quick-decisions','scope-review',
                'launch-verify','shrunk','question')),
  sent_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome     TEXT NOT NULL DEFAULT 'pending' CHECK (outcome IN ('pending','acted','ignored','snoozed','shrunk')),
  shrunk      BOOLEAN NOT NULL DEFAULT FALSE,
  note        TEXT
);

CREATE INDEX IF NOT EXISTS nudges_sent_at_idx ON nudges (sent_at DESC);

-- Every scan result, applied or held. The audit trail: `repos` is never written
-- from a scan without an event row first (SCAN.md drift guard).
CREATE TABLE IF NOT EXISTS scan_events (
  id            SERIAL PRIMARY KEY,
  repo_id       INTEGER REFERENCES repos(id) ON DELETE CASCADE,
  source        TEXT NOT NULL CHECK (source IN ('cron','manual')),
  findings      JSONB NOT NULL DEFAULT '{}'::jsonb,
  applied       BOOLEAN NOT NULL DEFAULT FALSE,
  verify_reason TEXT,
  resolved_at   TIMESTAMPTZ,
  resolution    TEXT CHECK (resolution IN ('confirmed','rejected')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS scan_events_repo_idx ON scan_events (repo_id, created_at DESC);
-- Open verify items are what the dashboard asks about.
CREATE INDEX IF NOT EXISTS scan_events_verify_idx ON scan_events (created_at DESC)
  WHERE verify_reason IS NOT NULL AND resolved_at IS NULL;

-- Web Push endpoints (O2 writes these; the table exists from O1).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          SERIAL PRIMARY KEY,
  endpoint    TEXT NOT NULL UNIQUE,
  keys        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Exactly one row (id = TRUE).
CREATE TABLE IF NOT EXISTS settings (
  id                       BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  owner_timezone           TEXT NOT NULL DEFAULT 'America/Asuncion',
  hpanel_baseline_minutes  INTEGER NOT NULL DEFAULT 0,
  scope_review_last        DATE,
  -- The old portfolio.session object: { batch, booked, when, done, done_date }.
  session_state            JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
