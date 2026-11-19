// Updates a view by the notes that changed since it was built: at 100k notes a full rebuild after one write held the
// server for about a second, an update costs what changed. The maps are updated in place; the result equals a full
// rebuild up to the order of edges and backlinks (viewDelta.test.ts).
import type { NoteFile } from './scan.ts';
import type { Changes } from './scanner.ts';
import { insertOrdered, updateLint } from './lintDelta.ts';
import { sha256 } from './util.ts';
import { addLinker, contribute, pairKey, placeAll, targetsOf, type Links, type View, type ViewDeps, type ViewNote } from './view.ts';

export interface ViewChange { old: ViewNote | undefined; next: ViewNote | undefined }

// As readNoteFile makes it.
const idOf = (path: string) => sha256(path).slice(0, 16);

// What a [[name]] resolution reads of a candidate note.
const resolvedAs = (n: ViewNote | undefined) => (n ? `${n.nameKey}|${n.dir}|${n.vaultKey}|${n.isGlobal}|${n.project}` : '');

// The notes that differ: those at the changed paths, and every old-place note (its place follows the vault's files).
// `placed.next`: the notes now at the changed paths, when only those were placed again.
function changesOf(prev: View, placed: Placed, changed: Set<string>): ViewChange[] {
  let next = placed.next;
  const paths = new Set(changed);
  if (!next) {
    next = new Map();
    for (const n of placed.notes) if (n.dir !== null || changed.has(n.path)) next.set(n.path, n);
    for (const n of prev.notes) if (n.dir !== null) paths.add(n.path);
    for (const p of next.keys()) paths.add(p);
  }
  const out: ViewChange[] = [];
  for (const p of paths) {
    const old = prev.byId.get(idOf(p));
    const now = next.get(p);
    if (old !== now) out.push({ old, next: now });
  }
  return out;
}

// a comes before b in the view's order; positions are looked up only for names shared by several notes.
function orderIn(notes: ViewNote[]): (a: ViewNote, b: ViewNote) => boolean {
  const at = new Map<ViewNote, number>();
  const pos = (n: ViewNote) => at.get(n) ?? at.set(n, notes.indexOf(n)).get(n)!;
  return (a, b) => pos(a) < pos(b);
}

// byId and byName follow the changes; returns the names whose resolution may have changed.
function rename(v: View, changes: ViewChange[], before: (a: ViewNote, b: ViewNote) => boolean): Set<string> {
  const names = new Set<string>();
  for (const { old, next } of changes) {
    if (old) {
      v.byId.delete(old.id);
      const list = v.byName.get(old.nameKey)!;
      list.splice(list.indexOf(old), 1);
      if (!list.length) v.byName.delete(old.nameKey);
    }
    if (next) {
      v.byId.set(next.id, next);
      const list = v.byName.get(next.nameKey) ?? [];
      v.byName.set(next.nameKey, list);
      insertOrdered(list, next, before);
      // Among several notes of one name the first match wins: a note that moved in the order may win now.
      if (list.length > 1) names.add(next.nameKey);
    }
    if (resolvedAs(old) !== resolvedAs(next)) for (const n of [old, next]) if (n) names.add(n.nameKey);
  }
  return names;
}

function dropLinker(linkers: Map<string, Set<string>>, n: ViewNote): void {
  for (const name of n.links) {
    const set = linkers.get(name);
    set?.delete(n.id);
    if (set && !set.size) linkers.delete(name);
  }
}

function takeBack(v: View, to: Parameters<typeof contribute>[0], old: ViewNote): void {
  contribute(to, old.id, v.out.get(old.id) ?? [], -1);
  v.out.delete(old.id);
  dropLinker(v.linkers, old);
}

// Takes back the links of the changed notes and of every note linking to a name in `names`, then adds them as
// they resolve now. Returns the edges and the unresolved count.
function relink(v: View, changes: ViewChange[], names: Set<string>): Pick<View, 'edges' | 'unresolved'> {
  const acc: Links = { edges: v.edges, pairs: v.pairs, degree: v.degree, backlinks: v.backlinks, unresolved: v.unresolved };
  const touched = new Map<string, [number, string, string]>(); // pair -> its count before, its notes
  let sign: 1 | -1 = -1;
  const to = { acc, pair: (key: string, a: string, b: string, count: number) => void (touched.has(key) || touched.set(key, [count - sign, a, b])) };
  const changedIds = new Set(changes.flatMap(({ old, next }) => [old?.id, next?.id]));
  const redo = [...names].flatMap((name) => [...(v.linkers.get(name) ?? [])]).filter((id) => !changedIds.has(id));
  for (const { old } of changes) if (old) takeBack(v, to, old);
  for (const id of new Set(redo)) contribute(to, id, v.out.get(id) ?? [], -1);
  sign = 1;
  const add = (n: ViewNote) => {
    const targets = targetsOf(n, v.byName);
    v.out.set(n.id, targets);
    contribute(to, n.id, targets, 1);
  };
  for (const { next } of changes) if (next) addLinker(v.linkers, next);
  for (const { next } of changes) if (next) add(next);
  for (const id of new Set(redo)) add(v.byId.get(id)!);
  return { edges: edgesAfter(v, touched), unresolved: acc.unresolved };
}

// The edges with the pairs that lost their last link out and those that got their first one in.
function edgesAfter(v: View, touched: Map<string, [number, string, string]>): [string, string][] {
  const removed = new Set<string>();
  const added: [string, string][] = [];
  for (const [key, [before, a, b]] of touched) {
    const now = v.pairs.get(key) ?? 0;
    if (before > 0 && now === 0) removed.add(key);
    else if (before === 0 && now > 0) added.push([a, b]);
  }
  if (!removed.size && !added.length) return v.edges;
  return [...(removed.size ? v.edges.filter(([a, b]) => !removed.has(pairKey(a, b))) : v.edges), ...added];
}

// Above this many changed paths one pass over the notes beats finding each of them.
const PATCH_MAX = 200;

type Place = (f: NoteFile) => ViewNote;

// The notes that stayed in their place, the changed ones replaced, in one pass.
function kept(prev: View, at: UpdateAt, place: Place): ViewNote[] {
  const { changed, inserted } = at.changes;
  const notes: ViewNote[] = [];
  for (const n of prev.notes) {
    if (inserted.has(n.path)) continue;
    const f = changed.has(n.path) ? at.fileAt(n.path) : null;
    if (f === null) notes.push(n);
    else if (f) notes.push(place(f));
  }
  return notes;
}

// The same for a few changes: a copy with each changed note found and replaced or cut out.
function patched(prev: View, at: UpdateAt, place: Place): ViewNote[] {
  const notes = prev.notes.slice();
  for (const path of at.changes.changed) {
    const old = prev.byId.get(idOf(path));
    if (!old) continue;
    const i = notes.indexOf(old);
    const f = at.changes.inserted.has(path) ? undefined : at.fileAt(path);
    if (f) notes[i] = place(f);
    else notes.splice(i, 1);
  }
  return notes;
}

// The view's notes without placing every scan note again (30 ms at 100k): the scanner keeps its order, so notes that
// stayed keep theirs and the ones added since come last, in the scan's order. Old-place notes depend on the vault's
// files, not on their own: with any of them every note is placed again.
function placeQuick(d: ViewDeps, prev: View, scan: { notes: NoteFile[] }, at: UpdateAt): Placed {
  if (at.oldPlace) return placeAll(d, scan);
  const { changed, inserted } = at.changes;
  const next = new Map<string, ViewNote>();
  const place = (f: NoteFile) => next.set(f.path, d.viewNote(f, f.vaultKey, true)).get(f.path)!;
  const notes = changed.size > PATCH_MAX ? kept(prev, at, place) : patched(prev, at, place);
  let added = 0;
  for (const p of inserted) if (at.fileAt(p)) added++;
  for (let i = scan.notes.length - added; i < scan.notes.length; i++) notes.push(place(scan.notes[i]));
  return { notes, drift: new Map(), next };
}

type Placed = ReturnType<typeof placeAll> & { next?: Map<string, ViewNote> };

interface UpdateAt { changes: Changes; fileAt(path: string): NoteFile | undefined; oldPlace: boolean; budgetMs: number }

export interface ViewUpdate { view: View; changes: ViewChange[]; jobs: (() => void)[] }

// `changes`: what the scanner reread since prev was built. Lint runs for budgetMs; the rest comes back as jobs.
export function updateView(d: ViewDeps, prev: View, scan: { notes: NoteFile[]; version: number }, at: UpdateAt): ViewUpdate {
  const placed = placeQuick(d, prev, scan, at);
  const { notes, drift } = placed;
  const changes = changesOf(prev, placed, at.changes.changed);
  const before = orderIn(notes);
  const names = rename(prev, changes, before);
  const links = relink(prev, changes, names);
  const jobs = updateLint(prev.lint, changes, {
    vault: d.paths.vault, cache: d.lintCache, budgetMs: at.budgetMs, noteAt: (p) => prev.byId.get(idOf(p)), before,
  });
  return { view: { ...prev, ...links, notes, drift, version: scan.version }, changes, jobs };
}
