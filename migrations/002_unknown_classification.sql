-- Rebuild the enum constraints while retaining identities, evidence and references.
CREATE TABLE projects_new (
 id TEXT PRIMARY KEY, name TEXT NOT NULL,
 stage TEXT NOT NULL CHECK(stage IN ('idea','planned','building','deployed','live','earning','paused','killed')),
 stage_before TEXT CHECK(stage_before IN ('idea','planned','building','deployed','live','earning')),
 status_note TEXT, market TEXT NOT NULL DEFAULT 'unknown' CHECK(market IN ('PY','SE','global','unknown')),
 kind TEXT NOT NULL DEFAULT 'unknown' CHECK(kind IN ('leadgen','portal','saas','consumer','content','infra','client','unknown')),
 money_model TEXT NOT NULL, money_weight INTEGER NOT NULL CHECK(money_weight BETWEEN 1 AND 5),
 notes TEXT NOT NULL DEFAULT '', paused_at TEXT, killed_at TEXT, stage_suggestion TEXT CHECK(stage_suggestion IN ('idea','planned','building','deployed','live','earning')),
 stage_evidence TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(stage_evidence)),
 CHECK(stage NOT IN ('paused','killed') OR (stage_before IS NOT NULL AND length(trim(status_note)) > 0))
);
INSERT INTO projects_new SELECT * FROM projects;
CREATE TEMP TABLE repo_projects AS SELECT name,project_id FROM repos;
CREATE TEMP TABLE domain_projects AS SELECT host,project_id FROM domains;
DROP TABLE projects;
ALTER TABLE projects_new RENAME TO projects;
UPDATE repos SET project_id=(SELECT project_id FROM repo_projects WHERE repo_projects.name=repos.name);
UPDATE domains SET project_id=(SELECT project_id FROM domain_projects WHERE domain_projects.host=domains.host);
DROP TABLE repo_projects;
DROP TABLE domain_projects;
