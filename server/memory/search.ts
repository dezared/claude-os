import { DatabaseSync } from 'node:sqlite';

export interface SearchDoc {
  id: string;
  path: string;
  project: string | null;
  type: string | null;
  name: string;
  description: string | null;
  tags: string[];
  body: string;
  mtime: number;
  sha: string;
}

export interface SearchHit {
  id: string;
  path: string;
  project: string | null;
  type: string | null;
  name: string;
  description: string | null;
  snippet: string;
}

const SNIPPET_MAX = 160;

// User text never reaches FTS syntax: only letter/digit tokens, each quoted as a prefix term.
export function toMatch(q: string, op: 'AND' | 'OR'): string | null {
  const tokens = q.match(/[\p{L}\p{N}]{2,}/gu);
  return tokens ? tokens.map((t) => `"${t}"*`).join(` ${op} `) : null;
}

// In-memory FTS5 index over notes; nothing is persisted, the owner rebuilds it with sync().
export function createSearchIndex() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE VIRTUAL TABLE memory_fts USING fts5(
      path UNINDEXED, project UNINDEXED, type UNINDEXED, name, description, tags, body,
      tokenize='porter unicode61 remove_diacritics 2'
    );
    CREATE TABLE docs (path TEXT PRIMARY KEY, id TEXT NOT NULL, sha TEXT NOT NULL, mtime REAL NOT NULL);
  `);
  // docs.rowid doubles as the memory_fts rowid, so rows are found without scanning the FTS table.
  const allDocs = db.prepare('SELECT path, sha FROM docs');
  const deleteFts = db.prepare('DELETE FROM memory_fts WHERE rowid = (SELECT rowid FROM docs WHERE path = ?)');
  const deleteDoc = db.prepare('DELETE FROM docs WHERE path = ?');
  const insertDoc = db.prepare('INSERT INTO docs (path, id, sha, mtime) VALUES (?, ?, ?, ?)');
  const insertFts = db.prepare(
    'INSERT INTO memory_fts (rowid, path, project, type, name, description, tags, body) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const search = db.prepare(`
    SELECT docs.id, docs.path, memory_fts.project, memory_fts.type, memory_fts.name, memory_fts.description,
      snippet(memory_fts, -1, ?, ?, '…', 16) AS snippet
    FROM memory_fts JOIN docs ON docs.rowid = memory_fts.rowid
    WHERE memory_fts MATCH ? AND (? IS NULL OR memory_fts.project = ?)
    ORDER BY bm25(memory_fts, 0, 0, 0, 8, 4, 4, 1) * (CASE WHEN memory_fts.project = ? THEN 1.5 ELSE 1 END), docs.mtime DESC
    LIMIT ?
  `);

  function remove(path: string) {
    deleteFts.run(path);
    deleteDoc.run(path);
  }

  function sync(input: SearchDoc[]) {
    const known = new Map((allDocs.all() as { path: string; sha: string }[]).map((r) => [r.path, r.sha]));
    const counts = { added: 0, changed: 0, removed: 0 };
    db.exec('BEGIN');
    try {
      for (const d of input) {
        const sha = known.get(d.path);
        known.delete(d.path);
        if (sha === d.sha) continue;
        if (sha === undefined) counts.added++;
        else {
          counts.changed++;
          remove(d.path);
        }
        const { lastInsertRowid } = insertDoc.run(d.path, d.id, d.sha, d.mtime);
        insertFts.run(lastInsertRowid, d.path, d.project, d.type, d.name, d.description, d.tags.join(' '), d.body);
      }
      for (const path of known.keys()) {
        remove(path);
        counts.removed++;
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    return counts;
  }

  function query(
    q: string,
    opts: { limit?: number; project?: string | null; boost?: string | null; marks?: [string, string] } = {},
  ): SearchHit[] {
    const limit = Math.min(20, Math.max(1, Math.trunc(Number.isFinite(opts.limit) ? opts.limit! : 5)));
    const [open, close] = opts.marks ?? ['[', ']'];
    const project = opts.project ?? null;
    const boost = opts.boost ?? null;
    const run = (match: string | null) =>
      match ? (search.all(open, close, match, project, project, boost, limit) as unknown as SearchHit[]) : [];
    let hits = run(toMatch(q, 'AND'));
    if (!hits.length) hits = run(toMatch(q, 'OR'));
    return hits.map((h) => ({ ...h, snippet: clip(h.snippet.replace(/\s+/g, ' ').trim(), open, close) }));
  }

  return { sync, query, close: () => db.close() };
}

// Cuts to SNIPPET_MAX and never leaves an open mark without its close.
function clip(s: string, open: string, close: string): string {
  if (s.length <= SNIPPET_MAX) return s;
  let cut = s.slice(0, SNIPPET_MAX - 1);
  if (cut.lastIndexOf(open) > cut.lastIndexOf(close)) cut = cut.slice(0, cut.lastIndexOf(open));
  return `${cut}…`;
}

export function formatHits(hits: SearchHit[]): string {
  if (!hits.length) return 'No notes match. Try other English keywords, or project "*".';
  return hits
    .map((h) => `${h.project ?? 'global'}/${h.name} [${h.type ?? '-'}] — ${h.description ?? ''}\n  ${h.snippet}\n  ${h.path}`)
    .join('\n\n');
}
