CREATE TABLE projects (
 id TEXT PRIMARY KEY, name TEXT NOT NULL,
 stage TEXT NOT NULL CHECK(stage IN ('idea','planned','building','deployed','live','earning','paused','killed')),
 stage_before TEXT CHECK(stage_before IN ('idea','planned','building','deployed','live','earning')),
 status_note TEXT, market TEXT NOT NULL CHECK(market IN ('PY','SE','global')),
 kind TEXT NOT NULL CHECK(kind IN ('leadgen','portal','saas','consumer','content','infra','client')),
 money_model TEXT NOT NULL, money_weight INTEGER NOT NULL CHECK(money_weight BETWEEN 1 AND 5),
 notes TEXT NOT NULL DEFAULT '', paused_at TEXT, killed_at TEXT, stage_suggestion TEXT CHECK(stage_suggestion IN ('idea','planned','building','deployed','live','earning')),
 stage_evidence TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(stage_evidence)),
 CHECK(stage NOT IN ('paused','killed') OR (stage_before IS NOT NULL AND length(trim(status_note)) > 0))
);
CREATE TABLE repos (name TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
 local_path TEXT, default_branch TEXT, archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
 on_github INTEGER NOT NULL DEFAULT 1 CHECK(on_github IN (0,1)), local_only INTEGER NOT NULL DEFAULT 0 CHECK(local_only IN (0,1)));
CREATE TABLE hosting_accounts (id TEXT PRIMARY KEY, label TEXT NOT NULL, has_ssh INTEGER NOT NULL CHECK(has_ssh IN (0,1)), process_limit INTEGER NOT NULL DEFAULT 200 CHECK(process_limit > 0));
CREATE TABLE domains (host TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
 hosting_account_id TEXT REFERENCES hosting_accounts(id) ON DELETE SET NULL,
 app_kind TEXT CHECK(app_kind IN ('node','php','static')), crm_site TEXT, source TEXT,
 confidence TEXT CHECK(confidence IN ('high','medium','low')));
CREATE TABLE collector_runs (id INTEGER PRIMARY KEY, collector TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT NOT NULL,
 ok INTEGER NOT NULL CHECK(ok IN (0,1)), error_short TEXT, items INTEGER NOT NULL DEFAULT 0 CHECK(items >= 0));
CREATE INDEX collector_runs_subject_at ON collector_runs(collector, started_at);
-- Observations deliberately have no identity foreign keys: deleting YAML identity retains history.
CREATE TABLE gh_snapshots (id INTEGER PRIMARY KEY, repo TEXT NOT NULL, at TEXT NOT NULL, last_push_at TEXT, last_commit_at TEXT,
 open_prs TEXT NOT NULL CHECK(json_valid(open_prs)), default_ci TEXT NOT NULL CHECK(default_ci IN ('green','red','pending','none','unknown')),
 stale_branches TEXT NOT NULL CHECK(json_valid(stale_branches)));
CREATE INDEX gh_snapshots_subject_at ON gh_snapshots(repo, at);
CREATE TABLE deploys (id INTEGER PRIMARY KEY, repo TEXT NOT NULL, at TEXT NOT NULL, sha TEXT NOT NULL, pr_number INTEGER,
 source TEXT NOT NULL CHECK(source IN ('merged PR','push to default branch')), UNIQUE(repo,sha,source));
CREATE INDEX deploys_subject_at ON deploys(repo, at);
CREATE TABLE local_snapshots (id INTEGER PRIMARY KEY, path TEXT NOT NULL, at TEXT NOT NULL, repo TEXT,
 dirty_files INTEGER NOT NULL CHECK(dirty_files >= 0), unpushed_commits INTEGER NOT NULL CHECK(unpushed_commits >= 0),
 branch TEXT, ahead INTEGER NOT NULL CHECK(ahead >= 0), behind INTEGER NOT NULL CHECK(behind >= 0), local_only INTEGER NOT NULL CHECK(local_only IN (0,1)));
CREATE INDEX local_snapshots_subject_at ON local_snapshots(path, at);
CREATE INDEX local_snapshots_repo_at ON local_snapshots(repo, at);
CREATE TABLE agent_sessions (id TEXT PRIMARY KEY, tool TEXT NOT NULL CHECK(tool IN ('claude','codex')), repo TEXT, project_id TEXT,
 started_at TEXT, last_at TEXT, last_request TEXT CHECK(length(last_request) <= 200), ended_mid_task INTEGER CHECK(ended_mid_task IN (0,1)),
 summary TEXT CHECK(length(summary) <= 300), file_mtime REAL);
CREATE INDEX agent_sessions_subject_at ON agent_sessions(project_id,last_at);
CREATE TABLE domain_checks (id INTEGER PRIMARY KEY, host TEXT NOT NULL, at TEXT NOT NULL, dns_ok INTEGER CHECK(dns_ok IN (0,1)),
 status INTEGER, final_url TEXT, redirects INTEGER, ms REAL, tls_expires_at TEXT, title TEXT, has_robots INTEGER CHECK(has_robots IN (0,1)),
 has_sitemap INTEGER CHECK(has_sitemap IN (0,1)), has_lead_form INTEGER CHECK(has_lead_form IN (0,1)), error_kind TEXT);
CREATE INDEX domain_checks_subject_at ON domain_checks(host,at);
CREATE TABLE process_samples (id INTEGER PRIMARY KEY, account_id TEXT NOT NULL, at TEXT NOT NULL, procs INTEGER, threads INTEGER,
 node_apps TEXT CHECK(json_valid(node_apps)), source TEXT NOT NULL CHECK(source IN ('ssh','manual')));
CREATE INDEX process_samples_subject_at ON process_samples(account_id,at);
CREATE TABLE crm_leads_daily (crm_site TEXT NOT NULL, day TEXT NOT NULL, leads INTEGER NOT NULL CHECK(leads >= 0), source TEXT, PRIMARY KEY(crm_site,day));
CREATE TABLE gsc_weekly (host TEXT NOT NULL, week TEXT NOT NULL, clicks INTEGER CHECK(clicks >= 0), impressions INTEGER CHECK(impressions >= 0), PRIMARY KEY(host,week));
CREATE TABLE revenue (id INTEGER PRIMARY KEY, project_id TEXT, client TEXT, amount REAL NOT NULL, currency TEXT NOT NULL CHECK(currency IN ('PYG','SEK','USD','EUR')),
 recurring TEXT NOT NULL CHECK(recurring IN ('none','monthly','yearly')), date TEXT NOT NULL, note TEXT);
CREATE INDEX revenue_subject_at ON revenue(project_id,date);
CREATE TABLE fx (currency TEXT PRIMARY KEY CHECK(currency IN ('PYG','SEK','USD','EUR')), per_usd REAL NOT NULL CHECK(per_usd > 0), set_at TEXT NOT NULL);
CREATE TABLE tasks (id INTEGER PRIMARY KEY, project_id TEXT, title TEXT NOT NULL,
 source_kind TEXT NOT NULL CHECK(source_kind IN ('known-issue','handoff','plan-phase','todo','session','inbox','manual','alert')),
 source_file TEXT, source_line INTEGER, source_hash TEXT UNIQUE, status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','dropped')),
 money_impact REAL, closeness REAL, effort_h REAL CHECK(effort_h > 0), pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0,1)), created_at TEXT NOT NULL, done_at TEXT);
CREATE INDEX tasks_subject_at ON tasks(project_id,created_at);
CREATE TABLE ideas (id INTEGER PRIMARY KEY, text TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'parked' CHECK(status IN ('parked','promoted','dropped')), gate_more_valuable_than TEXT, gate_pause_project TEXT);
CREATE TABLE inbox (id INTEGER PRIMARY KEY, text TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('ui','cli','telegram')), created_at TEXT NOT NULL, triaged_as TEXT CHECK(triaged_as IN ('task','idea','dropped')));
CREATE TABLE goals (id INTEGER PRIMARY KEY, period TEXT NOT NULL, metric TEXT NOT NULL CHECK(metric IN ('revenue_monthly','projects_earning','leads_month','sites_live','custom')), target REAL NOT NULL, unit TEXT, manual_value REAL);
CREATE TABLE alerts (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, subject TEXT NOT NULL, from_state TEXT, to_state TEXT,
 severity TEXT NOT NULL CHECK(severity IN ('red','amber')), opened_at TEXT NOT NULL, closed_at TEXT, notified_at TEXT);
CREATE INDEX alerts_subject_at ON alerts(subject,opened_at);
CREATE TABLE ai_calls (id INTEGER PRIMARY KEY, at TEXT NOT NULL, purpose TEXT NOT NULL, model TEXT NOT NULL, cache_key TEXT,
 in_tok INTEGER CHECK(in_tok >= 0), out_tok INTEGER CHECK(out_tok >= 0), usd REAL CHECK(usd >= 0));
CREATE INDEX ai_calls_subject_at ON ai_calls(purpose,at);
CREATE TABLE ai_cache (cache_key TEXT PRIMARY KEY, output TEXT NOT NULL CHECK(json_valid(output)), at TEXT NOT NULL);
CREATE VIEW latest_gh_snapshot AS SELECT s.* FROM gh_snapshots s WHERE s.id = (SELECT t.id FROM gh_snapshots t WHERE t.repo=s.repo ORDER BY t.at DESC,t.id DESC LIMIT 1);
CREATE VIEW latest_local_snapshot AS SELECT s.* FROM local_snapshots s WHERE s.id = (SELECT t.id FROM local_snapshots t WHERE t.path=s.path ORDER BY t.at DESC,t.id DESC LIMIT 1);
