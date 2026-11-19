// What lint and search derive from the store's view: the vault-wide lint context and the in-memory FTS index.
import { join, relative, sep } from 'node:path';
import type { MemorySearchHit } from '../../shared/contract.ts';
import type { Ctx, MemoryApi, Paths } from '../context.ts';
import type { NoteMeta } from './frontmatter.ts';
import { lintNote, slugOf, type LintCtx } from './lint.ts';
import { drain } from './scan.ts';
import { createSearchIndex, hitLimit, type SearchDoc } from './search.ts';
import { registerSemantic } from './semantic/index.ts';
import type { Store } from './store.ts';
import { nextTurn } from './turns.ts';
import type { IndexNote } from './wikiIndex.ts';
import { isWikiManaged } from './wikiManaged.ts';
import { normalizeName } from './wikilinks.ts';

export interface IndexedNote {
  id: string;
  path: string;
  file: string;
  nameKey: string;
  content: string;
  sha: string;
  meta: NoteMeta;
  mtime: number;
  summary: string | null;
  project: string | null;
  vaultKey: string | null;
  isGlobal: boolean;
  dir: string | null; // set for old-place notes
  links: string[];
}

export interface LintIndex {
  names: Map<string, string[]>; // normalizeName(file) -> vault note paths
  tags: Map<string | null, string[]>; // vault project key (null: global) -> its tags, most used first
  byName: Map<string, IndexedNote[]>; // every view note, keyed like buildLinks resolves links
  issues: Map<string, string[]>; // note id -> lint issue codes, vault notes only
  tagCounts: Map<string | null, Map<string, number>>; // what tags is sorted from, kept for a view update
  // Notes not linted within the build's budget (a cold start at tens of thousands of notes): each job lints one
  // and fills in its issues. Until it ran, the note shows its last known issues, or none.
  pending: (() => void)[];
}

// A note in the vault, not the generated MEMORY.md: the only files lint judges.
export const isVaultNote = (n: IndexedNote) => !n.dir && n.file !== 'MEMORY.md';

export const byFrequency = (counts: Map<string, number>) =>
  [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);

// Lint results kept between view rebuilds. A note is linted again when its text changed or when a name it
// depends on did: one of its possible names (a duplicate check) or a link target (resolution). At 60k notes a
// rebuild after one write then relints a handful of notes, not all of them.
export interface LintCache {
  entries: Map<string, { sha: string; deps: string[]; codes: string[] }>; // note path ->
  places: Map<string, string>; // note path -> its name, project and folder kind, as of the last rebuild
  dependents: Map<string, Set<string>>; // name -> paths of the entries that depend on it, for a view update
}

export const newLintCache = (): LintCache => ({ entries: new Map(), places: new Map(), dependents: new Map() });

// Every change of an entry goes through these two, so the dependents stay those of the entries.
export function dropEntry(cache: LintCache, path: string): void {
  for (const d of cache.entries.get(path)?.deps ?? []) cache.dependents.get(d)?.delete(path);
  cache.entries.delete(path);
}

function setEntry(cache: LintCache, path: string, entry: { sha: string; deps: string[]; codes: string[] }): void {
  dropEntry(cache, path);
  cache.entries.set(path, entry);
  for (const d of entry.deps) {
    const set = cache.dependents.get(d);
    if (set) set.add(path);
    else cache.dependents.set(d, new Set([path]));
  }
}

// Where the duplicate check and link resolution see a note: a change of it changes what its names resolve to.
export const placeOf = (n: IndexedNote) => `${n.nameKey}|${n.project ?? ''}|${n.isGlobal ? 1 : 0}|${n.dir === null ? 1 : 0}`;

// The names whose set of notes changed since the last rebuild: those of notes added, removed or moved to
// another project. Link resolution and the duplicate check read nothing else.
function* changedNames(notes: IndexedNote[], cache: LintCache): Generator<void, Set<string>> {
  const places = new Map<string, string>();
  const changed = new Set<string>();
  for (const n of notes) {
    const place = placeOf(n);
    places.set(n.path, place);
    const before = cache.places.get(n.path);
    if (before === place) continue;
    changed.add(n.nameKey);
    if (before !== undefined) changed.add(before.slice(0, before.indexOf('|')));
    yield;
  }
  for (const [path, before] of cache.places) if (!places.has(path)) changed.add(before.slice(0, before.indexOf('|')));
  cache.places = places;
  return changed;
}

// Every name lintNote looks up for this note: what it may be called and what it links to.
function depsOf(n: IndexedNote): string[] {
  const stem = n.file.replace(/\.md$/i, '');
  return [...new Set([n.meta.name ?? '', slugOf(stem), stem].filter(Boolean).map(normalizeName)), ...n.links];
}

export function isFresh(n: IndexedNote, cache: LintCache, changed: Set<string>): boolean {
  const hit = cache.entries.get(n.path);
  return !!hit && hit.sha === n.sha && (changed.size === 0 || !hit.deps.some((d) => changed.has(d)));
}

export function relint(n: IndexedNote, ctx: LintCtx, cache: LintCache): string[] {
  const codes = lintNote(n.file, n.content, ctx).issues.map((i) => i.code);
  setEntry(cache, n.path, { sha: n.sha, deps: depsOf(n), codes });
  return codes;
}

// Fresh cache hits always, new lint runs until the deadline, the rest as pending jobs.
function* judgeAll(index: LintIndex, notes: IndexedNote[], cache: LintCache, at: { vault: string; deadline: number }): Generator<void, void> {
  const { vault, deadline } = at;
  const changed = yield* changedNames(notes, cache);
  for (const n of notes.filter(isVaultNote)) {
    yield;
    const cached = cache.entries.get(n.path);
    if (cached && isFresh(n, cache, changed)) index.issues.set(n.id, cached.codes);
    else if (performance.now() < deadline) index.issues.set(n.id, relint(n, lintCtxIn(vault, index, n.path), cache));
    else {
      index.issues.set(n.id, cached?.codes ?? []);
      // Until its job ran the entry is stale: without it a later rebuild relints the note instead of trusting it.
      dropEntry(cache, n.path);
      // A view update may have replaced the note since: its own judgement then stands.
      index.pending.push(() => {
        if (index.byName.get(n.nameKey)?.includes(n)) index.issues.set(n.id, relint(n, lintCtxIn(vault, index, n.path), cache));
      });
    }
  }
}

// Vault note names (for the duplicate check) and each project's tag counts.
function* namesAndTags(vaultNotes: IndexedNote[]) {
  const names = new Map<string, string[]>();
  const counts = new Map<string | null, Map<string, number>>();
  for (const n of vaultNotes) {
    const name = n.nameKey;
    const list = names.get(name);
    if (list) list.push(n.path);
    else names.set(name, [n.path]);
    const own = counts.get(n.vaultKey) ?? new Map<string, number>();
    for (const t of n.meta.tags) own.set(t, (own.get(t) ?? 0) + 1);
    counts.set(n.vaultKey, own);
    yield;
  }
  return { names, counts };
}

type LintOpts = { cache?: LintCache; budgetMs?: number };

// Built once per view rebuild: every vault note is judged against the rest of the vault (see LintCache).
// One note per step, so the first build at 100k notes runs between requests.
export function* lintIndexSteps(vault: string, notes: IndexedNote[], byName: Map<string, IndexedNote[]>, opts: LintOpts = {}): Generator<void, LintIndex> {
  const cache = opts.cache ?? newLintCache();
  const vaultNotes = notes.filter(isVaultNote);
  const { names, counts } = yield* namesAndTags(vaultNotes);
  const index: LintIndex = { names, tags: new Map([...counts].map(([key, c]) => [key, byFrequency(c)])), tagCounts: counts, byName, issues: new Map(), pending: [] };
  yield* judgeAll(index, notes, cache, { vault, deadline: performance.now() + (opts.budgetMs ?? Infinity) });
  const live = new Set(vaultNotes.map((n) => n.path));
  for (const path of cache.entries.keys()) if (!live.has(path)) dropEntry(cache, path);
  return index;
}

export const buildLintIndex = (vault: string, notes: IndexedNote[], byName: Map<string, IndexedNote[]>, opts: LintOpts = {}): LintIndex =>
  drain(lintIndexSteps(vault, notes, byName, opts));

// What lint needs to judge the note at path against the rest of the vault.
export function lintCtxIn(vault: string, index: LintIndex, path: string): LintCtx {
  const rel = relative(join(vault, 'projects'), path).split(sep);
  const project = rel.length === 2 && rel[0] !== '..' ? rel[0] : null;
  return {
    path,
    project,
    names: index.names,
    tags: index.tags.get(project) ?? [],
    // Like buildLinks' resolveLink, but only inside the project or global/.
    resolves: (name) => (index.byName.get(normalizeName(name)) ?? []).some((c) => c.isGlobal || (project !== null && c.project === project)),
  };
}

export function searchDocOf(n: IndexedNote): SearchDoc {
  const mtime = n.meta.modified ?? n.mtime;
  return {
    id: n.id,
    path: n.path,
    project: n.project,
    type: n.meta.type,
    name: n.meta.name || n.file.replace(/\.md$/i, ''),
    description: n.meta.description,
    tags: n.meta.tags,
    body: n.meta.body,
    mtime,
    sha: `${n.sha}:${n.project ?? ''}:${mtime}`, // project and mtime live in the index row too
  };
}

// Notes do not change in place: the search by meaning diffs every note's doc after each change.
const docCache = new WeakMap<IndexedNote, SearchDoc>();
export const searchDocsOf = (notes: IndexedNote[]): SearchDoc[] =>
  notes.filter((n) => n.file !== 'MEMORY.md').map((n) => docCache.get(n) ?? docCache.set(n, searchDocOf(n)).get(n)!);

// What an editor save writes: in a managed project mechanical defects are fixed silently; MEMORY.md and
// notes of unmanaged projects as typed.
export function savedText(paths: Paths, file: string, markdown: string, ctx: LintCtx): string {
  if (file === 'MEMORY.md' || !isWikiManaged(paths, ctx.project)) return markdown;
  return lintNote(file, markdown, ctx).fixed ?? markdown;
}

// Notes do not change in place, so each keeps its entry: MEMORY.md of a 25k-note project is regenerated after every write.
const indexNoteCache = new WeakMap<IndexedNote, IndexNote>();

// The project's vault notes as MEMORY.md and the catalog list them; a thousand notes per step.
export function* indexNotesSteps(notes: IndexedNote[], key: string): Generator<void, IndexNote[]> {
  const out: IndexNote[] = [];
  for (let i = 0; i < notes.length; i += 1000) {
    out.push(...indexNotesOf(notes.slice(i, i + 1000), key));
    yield;
  }
  return out;
}

export function indexNotesOf(notes: IndexedNote[], key: string): IndexNote[] {
  return notes.filter((n) => n.vaultKey === key && isVaultNote(n)).map((n) => indexNoteCache.get(n) ?? indexNoteCache.set(n, {
    name: n.meta.name || n.file.replace(/\.md$/i, ''),
    file: n.file,
    description: n.meta.description,
    summary: n.summary,
    type: n.meta.type,
    tags: n.meta.tags,
    recency: n.meta.modified ?? n.mtime,
  }).get(n)!);
}

// MemorySearchHit's highlight marks: control chars, so brackets in a note stay literal.
const WEB_MARKS: [string, string] = ['\u0001', '\u0002'];

type SearchOpts = NonNullable<Parameters<MemoryApi['search']>[1]> & { max?: number };

export interface Searcher {
  search: MemoryApi['search'];
  find: MemoryApi['find'];
  changed(): void; // notes were written: their vectors follow
  // The ids of the best `max` hits in relevance order, each with its snippet (marks as in the web hits).
  ranked(q: string, max: number): Map<string, string>;
}

// Rows written per step while the index catches up in the background; a smaller backlog is written at once.
const STEP_MS = 10;
const WRITE_NOW = 500;
// The first build of a large vault starts after the server is up, not on the first search.
const WARM_MS = 2_000;
// How deep each list goes before fusion: a note a little down both lists can still make the top five.
const FUSE_DEPTH = 20;

// Keeps the index in step with the store's view. A rebuild of the view queues the difference; a small one is
// written before the query, a large one (the first build, a migration) in steps between requests, and until it
// is done a search sees the notes indexed so far.
function indexFollower(ctx: Ctx, store: Store) {
  const index = createSearchIndex();
  let synced = -1;
  let timer: { cancel(): void } | null = null;
  const tick = () => {
    timer = index.step(STEP_MS) ? null : nextTurn(tick);
  };
  const catchUp = () => {
    const build = store.notesBuild();
    // A view update hands over the notes it changed; only a full rebuild costs a diff of every row.
    const changes = build !== synced ? store.searchChanges() : null;
    if (changes) index.enqueue(changes.docs, changes.removes);
    else if (build !== synced) index.plan(store.searchDocs());
    synced = build;
    if (index.pending() <= WRITE_NOW) index.step();
    else timer ??= nextTurn(tick);
  };
  const warm = setTimeout(() => {
    try {
      catchUp();
    } catch (err) {
      ctx.app.log.error(err);
    }
  }, WARM_MS);
  warm.unref();
  ctx.app.addHook('onClose', async () => {
    clearTimeout(warm);
    timer?.cancel();
    index.close();
  });
  return { index, catchUp };
}

export function registerSearch(ctx: Ctx, store: Store): Searcher {
  const { index, catchUp } = indexFollower(ctx, store);
  const search = (q: string, opts: SearchOpts, marks: [string, string]) => {
    catchUp();
    return index.query(q, { ...opts, marks });
  };
  const semantic = registerSemantic(ctx, { docs: () => store.searchDocs(), hits: (paths) => index.hits(paths) });
  // FTS fused with the search by meaning when its vectors are ready.
  const find = async (q: string, opts: SearchOpts, marks: [string, string]) => {
    const limit = hitLimit(opts);
    const depth = Math.max(limit, FUSE_DEPTH);
    return semantic.rank(q, search(q, { ...opts, limit: depth, max: depth }, marks), { project: opts.project ?? null, limit, depth });
  };
  ctx.app.get<{ Querystring: { q?: string; limit?: string; project?: string } }>('/api/memory/search', async (req): Promise<MemorySearchHit[]> => {
    const { q = '', limit, project } = req.query;
    return (await find(q, { limit: limit ? Number(limit) : 20, project: project || null }, WEB_MARKS)).map(({ path: _path, ...hit }) => hit);
  });
  return {
    search: (q, opts = {}) => search(q, opts, ['[', ']']),
    find: (q, opts = {}) => find(q, opts, ['[', ']']),
    changed: semantic.changed,
    ranked: (q, max) => new Map(search(q, { limit: max, max }, WEB_MARKS).map((h) => [h.id, h.snippet])),
  };
}
