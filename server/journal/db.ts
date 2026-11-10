import type { DatabaseSync } from 'node:sqlite';

// Bump when parse.ts starts extracting something new: all journals are read again, upserts stay idempotent.
const PARSER_VERSION = '1';

export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      key TEXT PRIMARY KEY, name TEXT NOT NULL, root TEXT NOT NULL UNIQUE, has_git INTEGER NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS cwd_projects (cwd TEXT PRIMARY KEY, project TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY, project TEXT, cwd TEXT NOT NULL DEFAULT '', kind TEXT NOT NULL DEFAULT 'interactive',
      origin TEXT NOT NULL DEFAULT 'external', name TEXT, title TEXT, last_prompt TEXT,
      first_activity INTEGER, last_activity INTEGER, status TEXT NOT NULL DEFAULT 'ended', pid INTEGER,
      cost_usd REAL, version TEXT
    );
    CREATE INDEX IF NOT EXISTS sessions_project ON sessions(project);
    CREATE TABLE IF NOT EXISTS subagents (
      session TEXT NOT NULL, id TEXT NOT NULL, agent_type TEXT, description TEXT, last_activity INTEGER,
      PRIMARY KEY (session, id)
    );
    CREATE TABLE IF NOT EXISTS usage_messages (
      message_id TEXT PRIMARY KEY, session TEXT NOT NULL, agent_id TEXT, ts INTEGER, day TEXT, model TEXT,
      is_subagent INTEGER NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL,
      cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS usage_day ON usage_messages(day);
    CREATE INDEX IF NOT EXISTS usage_session ON usage_messages(session, agent_id);
    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, skill TEXT, session TEXT NOT NULL, ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS tool_calls_skill ON tool_calls(skill);
    CREATE TABLE IF NOT EXISTS file_offsets (path TEXT PRIMARY KEY, offset INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS unknown_records (
      type TEXT PRIMARY KEY, count INTEGER NOT NULL, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, version TEXT
    );
    CREATE TABLE IF NOT EXISTS record_stats (day TEXT PRIMARY KEY, total INTEGER NOT NULL, unknown INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits (
      session TEXT NOT NULL, kind TEXT NOT NULL, received_at INTEGER NOT NULL, raw TEXT NOT NULL, PRIMARY KEY (session, kind)
    );
    CREATE TABLE IF NOT EXISTS journal_meta (k TEXT PRIMARY KEY, v TEXT);
    CREATE TABLE IF NOT EXISTS usage_log (
      tool_id TEXT PRIMARY KEY, session TEXT NOT NULL, tool TEXT NOT NULL, target TEXT NOT NULL,
      kind TEXT NOT NULL, op TEXT NOT NULL, ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS usage_log_target ON usage_log(target);
    CREATE INDEX IF NOT EXISTS usage_log_session ON usage_log(session, ts);
    CREATE INDEX IF NOT EXISTS usage_log_ts ON usage_log(ts);
    CREATE TABLE IF NOT EXISTS os_changes (
      tool_id TEXT PRIMARY KEY, session TEXT NOT NULL, path TEXT NOT NULL, level TEXT NOT NULL, ts INTEGER
    );
    CREATE INDEX IF NOT EXISTS os_changes_session ON os_changes(session);
  `);
  addColumn(db, 'projects', 'pinned', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'projects', 'removed_at', 'INTEGER');
  addColumn(db, 'projects', 'map_pin', 'INTEGER');
  addColumn(db, 'projects', 'description', 'TEXT');
  addColumn(db, 'projects', 'color', 'TEXT');
  addColumn(db, 'projects', 'parent', 'TEXT');
  addColumn(db, 'projects', 'folder', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'sessions', 'removed', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'sessions', 'os_source', 'TEXT');
  addColumn(db, 'sessions', 'os_source_detail', 'TEXT');
  if (getMeta(db, 'parser_version') !== PARSER_VERSION) {
    db.exec('DELETE FROM file_offsets');
    setMeta(db, 'parser_version', PARSER_VERSION);
  }
}

function addColumn(db: DatabaseSync, table: string, column: string, type: string): void {
  const has = (db.prepare(`PRAGMA table_info(${table})`).all() as unknown as { name: string }[]).some((c) => c.name === column);
  if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}

export function getMeta(db: DatabaseSync, k: string): string | null {
  const row = db.prepare('SELECT v FROM journal_meta WHERE k = ?').get(k) as { v: string | null } | undefined;
  return row?.v ?? null;
}

export function setMeta(db: DatabaseSync, k: string, v: string): void {
  db.prepare('INSERT INTO journal_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, v);
}

export function localDay(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
