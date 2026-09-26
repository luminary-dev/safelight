-- index agent_runs_started (on agent_runs)
CREATE INDEX agent_runs_started ON agent_runs (started_at DESC);

-- index library_items_model (on library_items)
CREATE INDEX library_items_model ON library_items (model);

-- index library_items_mtime (on library_items)
CREATE INDEX library_items_mtime ON library_items (mtime DESC);

-- index project_notes_project (on project_notes)
CREATE INDEX project_notes_project ON project_notes (project_id, ts DESC);

-- index sessions_kind_updated (on sessions)
CREATE INDEX sessions_kind_updated ON sessions (kind, updated_at DESC);

-- index sessions_project (on sessions)
CREATE INDEX sessions_project ON sessions (project_id);

-- table agent_events (on agent_events)
CREATE TABLE agent_events ( run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL, ts INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (run_id, seq) );

-- table agent_runs (on agent_runs)
CREATE TABLE agent_runs ( id TEXT PRIMARY KEY, client_id TEXT NOT NULL, mode TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER, status TEXT NOT NULL DEFAULT 'running', error TEXT );

-- table library_fts (on library_fts)
CREATE VIRTUAL TABLE library_fts USING fts5(path UNINDEXED, prompt, model);

-- table library_fts_config (on library_fts_config)
CREATE TABLE 'library_fts_config'(k PRIMARY KEY, v) WITHOUT ROWID;

-- table library_fts_content (on library_fts_content)
CREATE TABLE 'library_fts_content'(id INTEGER PRIMARY KEY, c0, c1, c2);

-- table library_fts_data (on library_fts_data)
CREATE TABLE 'library_fts_data'(id INTEGER PRIMARY KEY, block BLOB);

-- table library_fts_docsize (on library_fts_docsize)
CREATE TABLE 'library_fts_docsize'(id INTEGER PRIMARY KEY, sz BLOB);

-- table library_fts_idx (on library_fts_idx)
CREATE TABLE 'library_fts_idx'(segid, term, pgno, PRIMARY KEY(segid, term)) WITHOUT ROWID;

-- table library_items (on library_items)
CREATE TABLE library_items ( path TEXT PRIMARY KEY, mtime INTEGER NOT NULL, size INTEGER NOT NULL, width INTEGER, height INTEGER, model TEXT, seed INTEGER, prompt TEXT, meta TEXT, phash TEXT, favorite INTEGER NOT NULL DEFAULT 0, indexed_at INTEGER NOT NULL );

-- table library_tags (on library_tags)
CREATE TABLE library_tags ( path TEXT NOT NULL REFERENCES library_items(path) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (path, tag) );

-- table project_notes (on project_notes)
CREATE TABLE project_notes ( id INTEGER PRIMARY KEY AUTOINCREMENT, project_id TEXT NOT NULL, ts INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'agent', note TEXT NOT NULL );

-- table projects (on projects)
CREATE TABLE projects ( id TEXT PRIMARY KEY, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );

-- table prompts (on prompts)
CREATE TABLE prompts ( id TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL, negative TEXT, tags TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL );

-- table rate_limits (on rate_limits)
CREATE TABLE rate_limits ( key TEXT PRIMARY KEY, tokens REAL NOT NULL, updated_at INTEGER NOT NULL );

-- table schema_migrations (on schema_migrations)
CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);

-- table search_cache (on search_cache)
CREATE TABLE search_cache ( query_hash TEXT PRIMARY KEY, provider TEXT NOT NULL, results TEXT NOT NULL, created_at INTEGER NOT NULL );

-- table sessions (on sessions)
CREATE TABLE sessions ( id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('chat','image','code','design')), project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, title TEXT NOT NULL, titled INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, data TEXT NOT NULL );

-- table settings (on settings)
CREATE TABLE settings ( key TEXT PRIMARY KEY, value TEXT NOT NULL );

-- table themes (on themes)
CREATE TABLE themes ( name TEXT PRIMARY KEY, data TEXT NOT NULL, saved_at INTEGER NOT NULL );

-- table usage_events (on usage_events)
CREATE TABLE usage_events ( id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, mode TEXT NOT NULL, input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, images INTEGER NOT NULL DEFAULT 0, duration_ms INTEGER NOT NULL DEFAULT 0, cost REAL NOT NULL DEFAULT 0 );
