-- 0002_nudge_engine — what the priority ladder needs `nudges` to remember (plan.md §5 O2).
--
-- plan.md §2 sketched `nudges` as (repo_names, type, sent_at, outcome, shrunk, note).
-- Porting DESIGN.md §3's state machine faithfully needs four things that sketch
-- did not have. Each one is load-bearing for a rule that is otherwise untestable:
--
--   local_date  — every cap in DESIGN.md §3 is counted in the OWNER's day, not
--                 UTC. Asunción is UTC-3, so a 21:30 local push lands on the next
--                 UTC date and "max 1 push/day" would quietly allow two. Deriving
--                 the local day from sent_at at read time also makes a
--                 replayed/back-dated run untestable, so the decision stores the
--                 day it was made FOR.
--   pushed      — a silent decision is still today's decision (the `question`
--                 rung decides, and deliberately does not push). Without this
--                 flag "already decided today" and "pushes this week" cannot be
--                 two different counts, and a retry would turn a silence into a
--                 push.
--   parent_type — which rung a `shrunk` ask shrank FROM, so the escalation chain
--                 stays legible in the audit trail.
--   title/body  — what was actually sent. The `question` rung's whole output is
--                 text on the dashboard ("what is actually in the way on X?"),
--                 so it has to live somewhere; keeping the real copy for every
--                 rung also means the history explains itself later.
--
-- `momentum` joins the type list: it is rung 6 in DESIGN.md §3 ("after a completed
-- session… the one permitted back-to-back repeat") and 0001 simply did not list it.
--
-- Deliberately NOT added: a mute / shrunk-ignored state blob. Both are derivable
-- from this history (a `question` row mutes its repos for 7 days; consecutive
-- ignored `shrunk` rows are the ignore count), and a derived read cannot drift
-- out of sync with the audit trail the way a second copy can.

ALTER TABLE nudges ADD COLUMN IF NOT EXISTS local_date  DATE;
ALTER TABLE nudges ADD COLUMN IF NOT EXISTS pushed      BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE nudges ADD COLUMN IF NOT EXISTS parent_type TEXT;
ALTER TABLE nudges ADD COLUMN IF NOT EXISTS title       TEXT;
ALTER TABLE nudges ADD COLUMN IF NOT EXISTS body        TEXT;

-- Rows seeded from data/nudges.json (none today) carry no local day; fall back to
-- the UTC day of sent_at so the column can be NOT NULL from here on.
UPDATE nudges SET local_date = (sent_at AT TIME ZONE 'UTC')::date WHERE local_date IS NULL;
ALTER TABLE nudges ALTER COLUMN local_date SET NOT NULL;
ALTER TABLE nudges ALTER COLUMN local_date SET DEFAULT CURRENT_DATE;

ALTER TABLE nudges DROP CONSTRAINT IF EXISTS nudges_type_check;
ALTER TABLE nudges ADD CONSTRAINT nudges_type_check CHECK (type IN (
  'db-session','booked-reminder','quick-decisions','scope-review',
  'launch-verify','shrunk','question','momentum'));

-- The caps read the tail of the history by owner-local day, newest first.
CREATE INDEX IF NOT EXISTS nudges_local_date_idx ON nudges (local_date DESC, id DESC);
