-- Phase 5: rhythm. Alerts remember when their close was pushed; stage changes keep a history
-- for the weekly review; reviews are stored; a small key-value table holds the Telegram
-- update offset and the last daily and weekly push keys.
ALTER TABLE alerts ADD COLUMN closed_notified_at TEXT;
CREATE TABLE stage_changes (id INTEGER PRIMARY KEY, project_id TEXT NOT NULL, from_stage TEXT, to_stage TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX stage_changes_subject_at ON stage_changes(project_id, at);
CREATE TABLE reviews (id INTEGER PRIMARY KEY, week TEXT NOT NULL UNIQUE, generated_at TEXT NOT NULL,
 facts TEXT NOT NULL CHECK(json_valid(facts)), headline TEXT NOT NULL, body TEXT NOT NULL, ai INTEGER NOT NULL DEFAULT 0 CHECK(ai IN (0,1)), sent_at TEXT);
CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, at TEXT NOT NULL);
