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
// A term in at least this many notes says little about which note is meant; ranking every note it is in held a
// search of five words over 100k notes for a quarter to half a second.
const COMMON = 1000;
// `max` lifts the cap of 20 hits a tool answer gets: the Storage panel's list ranks up to a thousand.

// User text never reaches FTS syntax: only letter/digit tokens, each quoted as a prefix term.
export function toMatch(q: string, op: 'AND' | 'OR'): string | null {
  const tokens = q.match(/[\p{L}\p{N}]{2,}/gu);
  return tokens ? tokens.map((t) => `"${t}"*`).join(` ${op} `) : null;
}

function openIndex() {
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
  // How many notes a term is in, counted up to COMMON only: a cheap test for a term too common to rank by.
  const capped = db.prepare(`SELECT count(*) AS n FROM (SELECT rowid FROM memory_fts WHERE memory_fts MATCH ? LIMIT ${COMMON})`);
  const byPath = db.prepare(`
    SELECT docs.id, docs.path, memory_fts.project, memory_fts.type, memory_fts.name, memory_fts.description, substr(memory_fts.body, 1, 400) AS snippet
    FROM docs JOIN memory_fts ON memory_fts.rowid = docs.rowid WHERE docs.path = ?
  `);
  return { db, allDocs, deleteFts, deleteDoc, insertDoc, insertFts, search, capped, byPath };
}

type Changes = { counts: { added: number; changed: number; removed: number }; docs: SearchDoc[]; removes: string[] };

// What to write for `input` against the rows the index holds now.
function diff(known: Map<string, string>, input: SearchDoc[]): Changes {
  const counts = { added: 0, changed: 0, removed: 0 };
  const docs: SearchDoc[] = [];
  for (const d of input) {
    const sha = known.get(d.path);
    known.delete(d.path);
    if (sha === d.sha) continue;
    if (sha === undefined) counts.added++;
    else counts.changed++;
    docs.push(d);
  }
  counts.removed = known.size;
  return { counts, docs, removes: [...known.keys()] };
}

// A few changed notes on top of what is left to write, without a diff of every row; the latest change of a path wins
// over one still queued.
function withChanges(queue: Queue, indexed: Map<string, string>, docs: SearchDoc[], removes: string[]): Queue {
  const paths = new Set([...docs.map((d) => d.path), ...removes]);
  return {
    docs: [...queue.docs.filter((d) => !paths.has(d.path)), ...docs.filter((d) => indexed.get(d.path) !== d.sha)],
    removes: [...queue.removes.filter((p) => !paths.has(p)), ...removes.filter((p) => indexed.has(p))],
  };
}

type Queue = { docs: SearchDoc[]; removes: string[] };

// In-memory FTS5 index over notes; nothing is persisted, the owner rebuilds it with sync() or plan() and step().
export function createSearchIndex() {
  const { db, allDocs, deleteFts, deleteDoc, insertDoc, insertFts, search, capped, byPath } = openIndex();

  // path -> sha of every indexed row, mirrored here: reading 60k rows back for each plan cost more than the plan.
  const indexed = new Map<string, string>();
  const reload = () => {
    indexed.clear();
    for (const r of allDocs.all() as { path: string; sha: string }[]) indexed.set(r.path, r.sha);
  };

  function remove(path: string) {
    indexed.delete(path);
    deleteFts.run(path);
    deleteDoc.run(path);
  }

  // What the last plan() left to write: built in one diff, written in steps so a large first build never
  // holds the server for seconds.
  let queue: { docs: SearchDoc[]; removes: string[] } = { docs: [], removes: [] };

  function plan(input: SearchDoc[]) {
    const { counts, ...rest } = diff(new Map(indexed), input);
    queue = rest;
    return counts;
  }

  const enqueue = (docs: SearchDoc[], removes: string[]) => void (queue = withChanges(queue, indexed, docs, removes));
  // Writes queued rows until the budget runs out; true when nothing is left.
  function step(budgetMs = Infinity): boolean {
    const until = performance.now() + budgetMs;
    let first = true; // every step writes at least one row, so a tiny budget still progresses
    const more = () => first || performance.now() < until;
    db.exec('BEGIN');
    try {
      while (queue.removes.length && more()) {
        remove(queue.removes.pop()!);
        first = false;
      }
      while (queue.docs.length && more()) {
        first = false;
        const d = queue.docs.pop()!;
        remove(d.path);
        const { lastInsertRowid } = insertDoc.run(d.path, d.id, d.sha, d.mtime);
        indexed.set(d.path, d.sha);
        insertFts.run(lastInsertRowid, d.path, d.project, d.type, d.name, d.description, d.tags.join(' '), d.body);
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      reload();
      throw err;
    }
    return queue.docs.length + queue.removes.length === 0;
  }

  function sync(input: SearchDoc[]) {
    const counts = plan(input);
    step();
    return counts;
  }

  function query(
    q: string,
    opts: { limit?: number; project?: string | null; boost?: string | null; marks?: [string, string]; max?: number } = {},
  ): SearchHit[] {
    const limit = hitLimit(opts);
    const [open, close] = opts.marks ?? ['[', ']'];
    const project = opts.project ?? null;
    const boost = opts.boost ?? null;
    const run = (match: string | null) =>
      match ? (search.all(open, close, match, project, project, boost, limit) as unknown as SearchHit[]) : [];
    const hits = topUp(run(toMatch(q, 'AND')), () => run(toMatch(rareTerms(q, (m) => (capped.get(m) as { n: number }).n), 'OR')), limit);
    return hits.map((h) => ({ ...h, snippet: clip(h.snippet.replace(/\s+/g, ' ').trim(), open, close) }));
  }

  return { sync, plan, enqueue, step, pending: () => queue.docs.length + queue.removes.length, query, hits: (paths: string[]) => hitsOf(byPath, paths), close: () => db.close() };
}

// The rows of these notes in this order, the start of the body as the snippet: the hits search by meaning found.
function hitsOf(byPath: ReturnType<typeof openIndex>['byPath'], paths: string[]): SearchHit[] {
  return paths.flatMap((p) => {
    const h = byPath.get(p) as unknown as SearchHit | undefined;
    return h ? [{ ...h, snippet: clip(h.snippet.replace(/\s+/g, ' ').trim(), '\0', '\0') }] : [];
  });
}

// 1 to `max` (20 by default) hits, 5 when not given.
export const hitLimit = (opts: { limit?: number; max?: number }) =>
  Math.min(opts.max ?? 20, Math.max(1, Math.trunc(Number.isFinite(opts.limit) ? opts.limit! : 5)));

// Notes with every word first, then the best of those with some: a note a hit links to often shares only part of
// the words (an eval at 100k notes missed a [[link]] target that AND alone left out).
function topUp(all: SearchHit[], some: () => SearchHit[], limit: number): SearchHit[] {
  if (all.length >= limit) return all;
  const ids = new Set(all.map((h) => h.id));
  return [...all, ...some().filter((h) => !ids.has(h.id))].slice(0, limit);
}

// The words of q found in fewer than COMMON notes, or all of them when none is: what an OR search ranks by.
function rareTerms(q: string, count: (match: string) => number): string {
  const words = q.match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const rare = words.filter((w) => {
    const n = count(`"${w}"*`);
    return n > 0 && n < COMMON;
  });
  return (rare.length ? rare : words).join(' ');
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
