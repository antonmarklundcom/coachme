-- Phase 3: tasks carry the repo and checkout they came from (for the copy prompt) and a
-- short context line; sessions remember which file they were read from so a task can be
-- closed when a newer session in the same repo ends cleanly.
ALTER TABLE tasks ADD COLUMN repo TEXT;
ALTER TABLE tasks ADD COLUMN local_path TEXT;
ALTER TABLE tasks ADD COLUMN detail TEXT CHECK(detail IS NULL OR length(detail) <= 300);
ALTER TABLE tasks ADD COLUMN updated_at TEXT;
CREATE INDEX tasks_status ON tasks(status, project_id);
ALTER TABLE agent_sessions ADD COLUMN branch TEXT;
ALTER TABLE agent_sessions ADD COLUMN cwd TEXT;
