-- Phase 6 speed pass: the latest-snapshot views looked up the newest row once per stored row
-- (every snapshot ever taken). They now look it up once per subject.
DROP VIEW latest_gh_snapshot;
CREATE VIEW latest_gh_snapshot AS SELECT s.* FROM (SELECT DISTINCT repo FROM gh_snapshots) r
 JOIN gh_snapshots s ON s.id = (SELECT t.id FROM gh_snapshots t WHERE t.repo=r.repo ORDER BY t.at DESC,t.id DESC LIMIT 1);
DROP VIEW latest_local_snapshot;
CREATE VIEW latest_local_snapshot AS SELECT s.* FROM (SELECT DISTINCT path FROM local_snapshots) p
 JOIN local_snapshots s ON s.id = (SELECT t.id FROM local_snapshots t WHERE t.path=p.path ORDER BY t.at DESC,t.id DESC LIMIT 1);
