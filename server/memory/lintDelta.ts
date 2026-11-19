// Brings a lint index up to date with the notes that changed, as a full rebuild with the same cache would: the
// changed notes are judged again, and so are those whose names now resolve differently.
import { byFrequency, dropEntry, isFresh, isVaultNote, lintCtxIn, placeOf, relint, type IndexedNote, type LintCache, type LintIndex } from './noteIndex.ts';

export interface NoteChange { old: IndexedNote | undefined; next: IndexedNote | undefined }

export interface LintUpdate {
  vault: string;
  cache: LintCache;
  budgetMs: number;
  noteAt(path: string): IndexedNote | undefined; // the current note at a path
  before(a: IndexedNote, b: IndexedNote): boolean; // a comes first in the view's order
}

// Puts n into a list kept in the view's order; lists are short (one note per name, mostly).
export function insertOrdered<T>(list: T[], n: T, before: (a: T, b: T) => boolean): void {
  let i = list.length;
  while (i > 0 && before(n, list[i - 1])) i--;
  list.splice(i, 0, n);
}

function removeFrom<K, T>(map: Map<K, T[]>, key: K, item: T): void {
  const list = map.get(key);
  const at = list?.indexOf(item) ?? -1;
  if (at < 0) return;
  list!.splice(at, 1);
  if (!list!.length) map.delete(key);
}

function countTags(index: LintIndex, n: IndexedNote, sign: 1 | -1): void {
  const counts = index.tagCounts.get(n.vaultKey) ?? new Map<string, number>();
  index.tagCounts.set(n.vaultKey, counts);
  for (const t of n.meta.tags) {
    const c = (counts.get(t) ?? 0) + sign;
    if (c > 0) counts.set(t, c);
    else counts.delete(t);
  }
}

// The names of a note whose place changed: those links and the duplicate check resolve differently now.
function movedNames(change: NoteChange, cache: LintCache, changed: Set<string>): void {
  const { old, next } = change;
  const was = old && cache.places.get(old.path);
  const place = next && placeOf(next);
  if (was !== place) for (const p of [was, place]) if (p) changed.add(p.slice(0, p.indexOf('|')));
  if (old) cache.places.delete(old.path);
  if (next && place) cache.places.set(next.path, place);
}

// Vault names and tag counts follow the changes; returns the names whose notes changed place.
function updateNames(index: LintIndex, changes: NoteChange[], u: LintUpdate): Set<string> {
  const changed = new Set<string>();
  const tagged = new Set<string | null>();
  const ordered = (a: string, b: string) => u.before(u.noteAt(a)!, u.noteAt(b)!);
  for (const change of changes) {
    movedNames(change, u.cache, changed);
    const { old, next } = change;
    if (old && isVaultNote(old)) {
      removeFrom(index.names, old.nameKey, old.path);
      countTags(index, old, -1);
      tagged.add(old.vaultKey);
    }
    if (next && isVaultNote(next)) {
      const list = index.names.get(next.nameKey) ?? [];
      index.names.set(next.nameKey, list);
      insertOrdered(list, next.path, ordered);
      countTags(index, next, 1);
      tagged.add(next.vaultKey);
    }
  }
  for (const key of tagged) index.tags.set(key, byFrequency(index.tagCounts.get(key)!));
  return changed;
}

// The paths to judge again: changed vault notes and those depending on a moved name. Gone notes lose their issues.
function toJudge(index: LintIndex, changes: NoteChange[], cache: LintCache, changed: Set<string>): Set<string> {
  const paths = new Set<string>();
  for (const { old, next } of changes) {
    if (next && isVaultNote(next)) paths.add(next.path);
    else if (old) {
      index.issues.delete(old.id);
      dropEntry(cache, old.path);
    }
  }
  for (const name of changed) for (const p of cache.dependents.get(name) ?? []) paths.add(p);
  return paths;
}

// The jobs left over the budget: each judges the note then at its path.
export function updateLint(index: LintIndex, changes: NoteChange[], u: LintUpdate): (() => void)[] {
  const { vault, cache } = u;
  const changed = updateNames(index, changes, u);
  const deadline = performance.now() + u.budgetMs;
  const jobs: (() => void)[] = [];
  const judge = (path: string) => {
    const n = u.noteAt(path);
    if (n && isVaultNote(n)) index.issues.set(n.id, relint(n, lintCtxIn(vault, index, path), cache));
  };
  for (const path of toJudge(index, changes, cache, changed)) {
    const n = u.noteAt(path);
    if (!n || !isVaultNote(n)) continue;
    const cached = cache.entries.get(path);
    if (cached && isFresh(n, cache, changed)) index.issues.set(n.id, cached.codes);
    else if (performance.now() < deadline) judge(path);
    else {
      index.issues.set(n.id, cached?.codes ?? []);
      dropEntry(cache, path);
      jobs.push(() => judge(path));
    }
  }
  return jobs;
}
