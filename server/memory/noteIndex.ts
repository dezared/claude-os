// What lint and search derive from the store's view: the vault-wide lint context and the in-memory FTS index.
import { join, relative, sep } from 'node:path';
import type { MemorySearchHit } from '../../shared/contract.ts';
import type { Ctx, MemoryApi, Paths } from '../context.ts';
import type { NoteMeta } from './frontmatter.ts';
import { lintNote, type LintCtx } from './lint.ts';
import { createSearchIndex, type SearchDoc } from './search.ts';
import type { Store } from './store.ts';
import type { IndexNote } from './wikiIndex.ts';
import { isWikiManaged } from './wikiManaged.ts';
import { normalizeName } from './wikilinks.ts';

export interface IndexedNote {
  id: string;
  path: string;
  file: string;
  content: string;
  sha: string;
  meta: NoteMeta;
  mtime: number;
  summary: string | null;
  project: string | null;
  vaultKey: string | null;
  isGlobal: boolean;
  dir: string | null; // set for old-place notes
}

export interface LintIndex {
  names: Map<string, string[]>; // normalizeName(file) -> vault note paths
  tags: Map<string | null, string[]>; // vault project key (null: global) -> its tags, most used first
  byName: Map<string, IndexedNote[]>; // every view note, keyed like buildLinks resolves links
  issues: Map<string, string[]>; // note id -> lint issue codes, vault notes only
}

// A note in the vault, not the generated MEMORY.md: the only files lint judges.
const isVaultNote = (n: IndexedNote) => !n.dir && n.file !== 'MEMORY.md';

const byFrequency = (counts: Map<string, number>) =>
  [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([t]) => t);

// Built once per view rebuild: every vault note is linted against the rest of the vault.
export function buildLintIndex(vault: string, notes: IndexedNote[], byName: Map<string, IndexedNote[]>): LintIndex {
  const names = new Map<string, string[]>();
  const counts = new Map<string | null, Map<string, number>>();
  const vaultNotes = notes.filter(isVaultNote);
  for (const n of vaultNotes) {
    const name = normalizeName(n.file);
    names.set(name, [...(names.get(name) ?? []), n.path]);
    const own = counts.get(n.vaultKey) ?? new Map<string, number>();
    for (const t of n.meta.tags) own.set(t, (own.get(t) ?? 0) + 1);
    counts.set(n.vaultKey, own);
  }
  const index: LintIndex = { names, tags: new Map([...counts].map(([key, c]) => [key, byFrequency(c)])), byName, issues: new Map() };
  for (const n of vaultNotes) index.issues.set(n.id, lintNote(n.file, n.content, lintCtxIn(vault, index, n.path)).issues.map((i) => i.code));
  return index;
}

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

export function searchDocsOf(notes: IndexedNote[]): SearchDoc[] {
  return notes.filter((n) => n.file !== 'MEMORY.md').map((n) => {
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
  });
}

// What an editor save writes: in a managed project mechanical defects are fixed silently; MEMORY.md and
// notes of unmanaged projects as typed.
export function savedText(paths: Paths, file: string, markdown: string, ctx: LintCtx): string {
  if (file === 'MEMORY.md' || !isWikiManaged(paths, ctx.project)) return markdown;
  return lintNote(file, markdown, ctx).fixed ?? markdown;
}

// The project's vault notes as MEMORY.md and the catalog list them.
export function indexNotesOf(notes: IndexedNote[], key: string): IndexNote[] {
  return notes.filter((n) => n.vaultKey === key && isVaultNote(n)).map((n) => ({
    name: n.meta.name || n.file.replace(/\.md$/i, ''),
    file: n.file,
    description: n.meta.description,
    summary: n.summary,
    type: n.meta.type,
    tags: n.meta.tags,
    recency: n.meta.modified ?? n.mtime,
  }));
}

type SearchOpts = NonNullable<Parameters<MemoryApi['search']>[1]>;

// One index per server; it follows the store's view, so unchanged notes cost a hash compare per query.
export function registerSearch(ctx: Ctx, store: Store): MemoryApi['search'] {
  const index = createSearchIndex();
  ctx.app.addHook('onClose', async () => index.close());
  const search = (q: string, opts: SearchOpts, marks: [string, string]) => {
    index.sync(store.searchDocs());
    return index.query(q, { ...opts, marks });
  };
  ctx.app.get<{ Querystring: { q?: string; limit?: string; project?: string } }>('/api/memory/search', async (req): Promise<MemorySearchHit[]> => {
    const { q = '', limit, project } = req.query;
    return search(q, { limit: limit ? Number(limit) : 20, project: project || null }, ['\u0001', '\u0002']).map(({ path: _path, ...hit }) => hit);
  });
  return (q, opts = {}) => search(q, opts, ['[', ']']);
}
