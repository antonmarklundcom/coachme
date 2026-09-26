-- Phase 4: goals get a label (for custom goals) and a creation time; revenue entries record
-- when they were typed in.
ALTER TABLE goals ADD COLUMN label TEXT;
ALTER TABLE goals ADD COLUMN created_at TEXT;
ALTER TABLE revenue ADD COLUMN created_at TEXT;
