-- 0004_digest_rungs — two more values for `nudges.type` (plan.md Decision D-J).
--
-- Written in O4 rather than O3 because it is not part of §2's object model: it
-- is the v2 nudge table catching up with the two rungs the launch desk adds on
-- top of DESIGN.md §3's ladder.
--
--   merge-prs   green pull requests are waiting for one tap each
--   owner-step  the one thing only Anton can do, on the repo closest to money
--
-- Everything below those two rungs is untouched, and so are every cap in
-- DESIGN.md §3: this widens what the coach may say, never how often.

ALTER TABLE nudges DROP CONSTRAINT IF EXISTS nudges_type_check;
ALTER TABLE nudges ADD CONSTRAINT nudges_type_check CHECK (type IN (
  'db-session','booked-reminder','quick-decisions','scope-review',
  'launch-verify','shrunk','question','momentum',
  'merge-prs','owner-step'));
