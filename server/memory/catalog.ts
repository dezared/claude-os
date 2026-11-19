// The vault at any size, as the map and the Storage panel need it: a representative subset for the map,
// per-project figures, and a filtered, paged list. Pure: the store hands in its view.
import { drain } from './scan.ts';
import { MEMORY_HEALTH, MEMORY_MAP_CAP, MEMORY_WEEKS, type MemoryCount, type MemoryHealth, type MemoryNoteList, type MemoryNoteRow, type MemoryOverview, type MemoryProjectStats } from '../../shared/memory.ts';

export interface CatalogNote {
  id: string;
  name: string;
  project: string | null;
  connected: boolean;
  type: string | null;
  tags: string[];
  summary: string | null;
  mtime: number;
  issues: string[];
  degree: number;
  description: string | null;
}

export interface SampleNote { id: string; project: string | null; mtime: number }

// A small project keeps this many notes on the map, so every project stays visible; fewer when many projects share it (shares).
const MIN_SHARE = 24;
const DAY_MS = 86_400_000;
const TOP_TAGS = 12;

function groupBy<T>(items: T[], key: (t: T) => string | null): Map<string | null, T[]> {
  const out = new Map<string | null, T[]>();
  for (const it of items) {
    const k = key(it);
    const list = out.get(k);
    if (list) list.push(it);
    else out.set(k, [it]);
  }
  return out;
}

// Notes per project, the largest first; a note per step.
export function* countSteps(notes: { project: string | null }[]): Generator<void, MemoryCount[]> {
  const counts = new Map<string | null, number>();
  for (const n of notes) {
    counts.set(n.project, (counts.get(n.project) ?? 0) + 1);
    yield;
  }
  return [...counts].map(([project, count]) => ({ project, notes: count })).sort((a, b) => b.notes - a.notes);
}

export const countsOf = (notes: { project: string | null }[]): MemoryCount[] => drain(countSteps(notes));

// Every project gets its minimum first, the rest follows the square root of a project's size: a 60k project still dominates,
// a 50-note one is not a dot. The minimums take at most half the cap, so with many projects each gets less; the sum stays under the cap.
function shares(groups: Map<string | null, SampleNote[]>, cap: number): Map<string | null, number> {
  const weight = (n: number) => Math.sqrt(n);
  const least = Math.min(MIN_SHARE, Math.floor(cap / 2 / groups.size));
  const base = new Map([...groups].map(([k, g]) => [k, Math.min(g.length, least)]));
  const rest = cap - [...base.values()].reduce((s, n) => s + n, 0);
  const sum = [...groups.values()].reduce((s, g) => s + weight(g.length), 0);
  return new Map([...groups].map(([k, g]) => [k, Math.min(g.length, base.get(k)! + Math.floor((rest * weight(g.length)) / sum))]));
}

// The k highest by key, highest first, ties in group order (as a stable sort of the whole group puts them). A full
// sort of every note per map at 100k notes held the server for a quarter of a second.
function* top(group: SampleNote[], key: (n: SampleNote) => number, k: number): Generator<void, { id: string; key: number }[]> {
  const keys = new Float64Array(group.length);
  for (let i = 0; i < group.length; i++) {
    keys[i] = key(group[i]);
    yield;
  }
  const least = k < keys.length ? keys.slice().sort()[keys.length - k] : -Infinity;
  const at: number[] = [];
  for (let i = 0; i < keys.length; i++) if (keys[i] >= least) at.push(i);
  return at.sort((a, b) => keys[b] - keys[a] || a - b).map((i) => ({ id: group[i].id, key: keys[i] }));
}

// Hubs first (most links), then the newest, then neighbours of what is in, then the newest again.
function* pickProject(group: SampleNote[], quota: number, degree: Map<string, number>, adjacent: Map<string, string[]>): Generator<void, string[]> {
  const picked = new Set<string>();
  // No pick can reach past twice the quota: a fill skips at most what is already picked.
  const byRecent = yield* top(group, (n) => n.mtime, quota * 2);
  const hubs = (yield* top(group, (n) => degree.get(n.id) ?? 0, quota * 2)).filter((n) => n.key > 0);
  const fill = (ids: Iterable<string>, upTo: number) => {
    for (const id of ids) {
      if (picked.size >= upTo) return;
      picked.add(id);
    }
  };
  const own = new Set<string>();
  for (const n of group) {
    own.add(n.id);
    yield;
  }
  fill(hubs.map((n) => n.id), Math.ceil(quota * 0.4));
  fill(byRecent.map((n) => n.id), Math.ceil(quota * 0.8));
  fill([...picked].flatMap((id) => adjacent.get(id) ?? []).filter((id) => own.has(id)), quota);
  fill(byRecent.map((n) => n.id), quota);
  return [...picked];
}

type Edges = [string, string][];

// The ids drawn on the map; everything when the vault fits under the cap. A note or a link per step.
export function* sampleSteps(notes: SampleNote[], edges: Edges, degree: Map<string, number>, cap = MEMORY_MAP_CAP): Generator<void, Set<string>> {
  if (notes.length <= cap) return new Set(notes.map((n) => n.id));
  const adjacent = new Map<string, string[]>();
  const link = (from: string, to: string) => {
    const list = adjacent.get(from);
    if (list) list.push(to);
    else adjacent.set(from, [to]);
  };
  for (const [a, b] of edges) {
    link(a, b);
    link(b, a);
    yield;
  }
  const groups = groupBy(notes, (n) => n.project);
  const quota = shares(groups, cap);
  const shown = new Set<string>();
  for (const [k, g] of groups) for (const id of yield* pickProject(g, quota.get(k) ?? 0, degree, adjacent)) shown.add(id);
  return shown;
}

export const sampleMap = (notes: SampleNote[], edges: Edges, degree: Map<string, number>, cap = MEMORY_MAP_CAP): Set<string> =>
  drain(sampleSteps(notes, edges, degree, cap));

const dupKey = (n: CatalogNote) => (n.description?.trim() ? `${n.project ?? ''}|${n.description.toLowerCase().replace(/\s+/g, ' ').trim()}` : null);

// The health marks of every note; a description shared by two notes of one project marks both as duplicates.
// A note per step.
export function* healthSteps(notes: CatalogNote[]): Generator<void, Map<string, MemoryHealth[]>> {
  const keys: (string | null)[] = [];
  for (const n of notes) {
    keys.push(dupKey(n));
    yield;
  }
  const dups = new Map<string, number>();
  for (const k of keys) {
    if (k) dups.set(k, (dups.get(k) ?? 0) + 1);
    yield;
  }
  const health = new Map<string, MemoryHealth[]>();
  for (let i = 0; i < notes.length; i++) {
    health.set(notes[i].id, marksOf(notes[i], (dups.get(keys[i] ?? '') ?? 0) > 1));
    yield;
  }
  return health;
}

export const healthOf = (notes: CatalogNote[]): Map<string, MemoryHealth[]> => drain(healthSteps(notes));

// A soft body-length flag is no defect; an unresolved link is its own mark.
function marksOf(n: CatalogNote, sharedDescription: boolean): MemoryHealth[] {
  const marks: MemoryHealth[] = [];
  if (n.issues.some((c) => c !== 'link-unresolved' && c !== 'body-soft')) marks.push('malformed');
  if (n.issues.includes('link-unresolved')) marks.push('broken');
  if (sharedDescription || n.issues.includes('name-duplicate')) marks.push('duplicate');
  if (n.connected && n.degree === 0) marks.push('orphan');
  return marks;
}

function* projectStats(project: string | null, notes: CatalogNote[], health: Map<string, MemoryHealth[]>, now: number): Generator<void, MemoryProjectStats> {
  const weeks = Array.from({ length: MEMORY_WEEKS }, () => 0);
  const types: Record<string, number> = {};
  const tags = new Map<string, number>();
  const marks = Object.fromEntries(MEMORY_HEALTH.map((h) => [h, 0])) as Record<MemoryHealth, number>;
  for (const n of notes) {
    const week = Math.floor((now - n.mtime) / DAY_MS / 7);
    if (week >= 0 && week < MEMORY_WEEKS) weeks[MEMORY_WEEKS - 1 - week]++;
    const type = n.type ?? '';
    types[type] = (types[type] ?? 0) + 1;
    for (const t of n.tags) tags.set(t, (tags.get(t) ?? 0) + 1);
    for (const h of health.get(n.id) ?? []) marks[h]++;
    yield;
  }
  const top = [...tags].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_TAGS);
  const within = (days: number) => notes.filter((n) => now - n.mtime <= days * DAY_MS).length;
  return { project, notes: notes.length, outside: notes.filter((n) => !n.connected).length, added7: within(7), added30: within(30), weeks, types, tags: top, health: marks };
}

// A note per step.
export function* overviewSteps(notes: CatalogNote[], health: Map<string, MemoryHealth[]>, now = Date.now()): Generator<void, MemoryOverview> {
  const projects: MemoryProjectStats[] = [];
  for (const [k, list] of groupBy(notes, (n) => n.project)) {
    projects.push(yield* projectStats(k, list, health, now));
  }
  return { total: notes.length, projects: projects.sort((a, b) => b.notes - a.notes) };
}

export const overviewOf = (notes: CatalogNote[], health: Map<string, MemoryHealth[]>, now = Date.now()): MemoryOverview => drain(overviewSteps(notes, health, now));

export interface ListQuery {
  project?: string | null; // undefined: every project; null: global notes
  type?: string;
  tag?: string;
  health?: MemoryHealth;
  offset: number;
  limit: number;
}

// `ranked`: query hits in relevance order with their snippets; null lists the newest first.
export function listOf(notes: CatalogNote[], health: Map<string, MemoryHealth[]>, q: ListQuery, ranked: Map<string, string> | null): MemoryNoteList {
  const keep = (n: CatalogNote) => (q.project === undefined || n.project === q.project)
    && (!q.type || n.type === q.type)
    && (!q.tag || n.tags.includes(q.tag))
    && (!q.health || (health.get(n.id) ?? []).includes(q.health));
  let rows: CatalogNote[];
  if (ranked) {
    const byId = new Map(notes.map((n) => [n.id, n]));
    rows = [...ranked.keys()].map((id) => byId.get(id)).filter((n): n is CatalogNote => !!n && keep(n));
  } else rows = notes.filter(keep).sort((a, b) => b.mtime - a.mtime);
  const page = rows.slice(q.offset, q.offset + q.limit).map((n): MemoryNoteRow => ({
    id: n.id, name: n.name, project: n.project, connected: n.connected, type: n.type, tags: n.tags, summary: n.summary, mtime: n.mtime,
    health: health.get(n.id) ?? [], snippet: ranked?.get(n.id) ?? null,
  }));
  return { total: rows.length, rows: page };
}
