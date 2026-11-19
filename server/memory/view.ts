// The store's view of the notes: what links, lint and the map are built from, and the helpers that build it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { MemoryNode } from '../../shared/contract.ts';
import type { Paths } from '../context.ts';
import type { NoteFile } from './scan.ts';
import { lintIndexSteps, type LintCache, type LintIndex } from './noteIndex.ts';
import { nextTurn } from './turns.ts';
import { migratedLookup } from './wikiRun.ts';
import { normalizeName, resolveLinkIn } from './wikilinks.ts';

// A view build lints new notes for this long; the rest is linted between requests (a cold start at 60k notes).
const LINT_BUDGET_MS = 150;
// Deferred jobs run this long per turn of the event loop; the search index writes in steps of its own beside them.
const JOB_STEP_MS = 10;

export interface ViewNote extends NoteFile {
  project: string | null;
  connected: boolean;
}

export interface View {
  notes: ViewNote[];
  byId: Map<string, ViewNote>;
  byName: Map<string, ViewNote[]>; // normalizeName(file) -> notes
  lint: LintIndex;
  edges: [string, string][];
  backlinks: Map<string, string[]>;
  degree: Map<string, number>;
  unresolved: number;
  drift: Map<string, number>;
  version: number; // the scan it was built from
  // What a view update needs to take a note's links back without relinking every note.
  out: Map<string, (string | null)[]>; // note id -> what each of its links resolves to: a note id, or null
  linkers: Map<string, Set<string>>; // link name -> ids of the notes that link to it
  pairs: Map<string, number>; // pairKey -> links between the two notes, either way
}

// Runs queued jobs in short steps between requests; a new start drops what an older one left, an add keeps it.
export function backgroundJobs(onDone: () => void) {
  let timer: { cancel(): void } | null = null;
  let jobs: (() => void)[] = [];
  const stop = () => {
    timer?.cancel();
    timer = null;
  };
  const step = () => {
    const end = performance.now() + JOB_STEP_MS;
    while (jobs.length && performance.now() < end) jobs.pop()!();
    timer = jobs.length ? nextTurn(step) : null;
    if (!timer) onDone();
  };
  const run = () => {
    if (!timer && jobs.length) timer = nextTurn(step);
  };
  return {
    stop,
    start(next: (() => void)[]) {
      stop();
      jobs = next;
      run();
    },
    add(more: (() => void)[]) {
      jobs.push(...more);
      run();
    },
  };
}

// The same object while the file and its place stay: a rebuild at 60k notes copies nothing it need not.
export function viewNoteCache() {
  const known = new WeakMap<NoteFile, ViewNote>();
  return (n: NoteFile, project: string | null, connected: boolean): ViewNote => {
    const had = known.get(n);
    if (had?.project === project && had.connected === connected) return had;
    const made = { ...n, project, connected };
    known.set(n, made);
    return made;
  };
}

// The vault path a [[name]] in the note at fromPath opens, as the graph resolves it.
export function resolvePathIn(v: Pick<View, 'notes' | 'byName'>, fromPath: string, name: string): string | null {
  const from = v.notes.find((n) => n.path === fromPath);
  return from ? resolveLinkIn(v.byName, from, normalizeName(name))?.path ?? null : null;
}

export interface Links {
  edges: [string, string][];
  pairs: Map<string, number>;
  degree: Map<string, number>;
  backlinks: Map<string, string[]>;
  unresolved: number;
}

export const pairKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export const targetsOf = (n: ViewNote, byName: Map<string, ViewNote[]>): (string | null)[] =>
  n.links.map((name) => resolveLinkIn(byName, n, name)?.id ?? null);

function bump(degree: Map<string, number>, id: string, by: number): void {
  const d = (degree.get(id) ?? 0) + by;
  if (d) degree.set(id, d);
  else degree.delete(id);
}

function backlink(backlinks: Map<string, string[]>, target: string, from: string, sign: 1 | -1): void {
  const back = backlinks.get(target);
  if (sign > 0) {
    if (back) back.push(from);
    else backlinks.set(target, [from]);
    return;
  }
  back?.splice(back.indexOf(from), 1);
  if (back && !back.length) backlinks.delete(target);
}

// Adds (1) or takes back (-1) what one note's links give the view; the first and the last link of a pair move the
// degree. `pair` hears every pair touched with its new count.
export type PairFn = (key: string, a: string, b: string, count: number) => void;
export function contribute({ acc, pair }: { acc: Links; pair: PairFn }, from: string, targets: (string | null)[], sign: 1 | -1): void {
  for (const target of targets) {
    if (target === null) {
      acc.unresolved += sign;
      continue;
    }
    if (target === from) continue;
    backlink(acc.backlinks, target, from, sign);
    const key = pairKey(from, target);
    const count = (acc.pairs.get(key) ?? 0) + sign;
    if (count > 0) acc.pairs.set(key, count);
    else acc.pairs.delete(key);
    if ((sign > 0 && count === 1) || (sign < 0 && count === 0)) {
      bump(acc.degree, from, sign);
      bump(acc.degree, target, sign);
    }
    pair(key, from, target, count);
  }
}

export function addLinker(linkers: Map<string, Set<string>>, n: ViewNote): void {
  for (const name of n.links) {
    const set = linkers.get(name);
    if (set) set.add(n.id);
    else linkers.set(name, new Set([n.id]));
  }
}

// One note per step, so the first view of a 100k-note vault is built between requests.
export function* linkSteps(notes: ViewNote[], drift: Map<string, number>): Generator<void, Omit<View, 'lint' | 'version'>> {
  const byName = new Map<string, ViewNote[]>();
  const byId = new Map<string, ViewNote>();
  for (const n of notes) {
    byId.set(n.id, n);
    const name = n.nameKey;
    const list = byName.get(name);
    if (list) list.push(n);
    else byName.set(name, [n]);
    yield;
  }
  const acc: Links = { edges: [], pairs: new Map(), degree: new Map(), backlinks: new Map(), unresolved: 0 };
  const out = new Map<string, (string | null)[]>();
  const linkers = new Map<string, Set<string>>();
  const to = { acc, pair: (_key: string, a: string, b: string, count: number) => void (count === 1 && acc.edges.push([a, b])) };
  for (const n of notes) {
    const targets = targetsOf(n, byName);
    out.set(n.id, targets);
    addLinker(linkers, n);
    contribute(to, n.id, targets, 1);
    yield;
  }
  const { edges, degree, backlinks, unresolved, pairs } = acc;
  return { notes, byId, byName, edges, backlinks, degree, unresolved, drift, out, linkers, pairs };
}

// A note in the old place: read only, and left out once its copy lives in the project's vault dir.
function oldPlace(d: ViewDeps, n: NoteFile, dir: string, drift: Map<string, number>): ViewNote | null {
  const project = d.keyForDir(dir);
  // Claude OS sessions write to the vault without touching the project's settings, so a vault dir counts too.
  const ownDir = project ? join(d.paths.vault, 'projects', project) : null;
  const vaultDir = project ? d.connectedDir(project) ?? (ownDir && existsSync(ownDir) ? ownDir : null) : null;
  if (project && vaultDir) {
    // Already copied notes live in the vault. What is missing there is drift: still shown, read only.
    if (existsSync(join(vaultDir, n.file))) return null;
    drift.set(project, (drift.get(project) ?? 0) + 1);
  }
  return d.viewNote(n, project, false);
}

export interface ViewDeps {
  paths: Paths;
  keyForDir(dir: string): string | null;
  connectedDir(key: string): string | null;
  viewNote(n: NoteFile, project: string | null, connected: boolean): ViewNote;
  lintCache: LintCache;
}

type Placed = { notes: ViewNote[]; drift: Map<string, number> };

// One scan note as the view shows it, or null. A migrated original stays out: its rewrite lives in the vault now.
function placer(d: ViewDeps): Placed & { place(n: NoteFile): void } {
  const migrated = migratedLookup(d.paths);
  const out: Placed = { notes: [], drift: new Map() };
  return {
    ...out,
    place(n) {
      if (n.dir && migrated(d.keyForDir(n.dir)).get(n.file) === n.sha) return;
      const placed = n.dir ? oldPlace(d, n, n.dir, out.drift) : d.viewNote(n, n.vaultKey, true);
      if (placed) out.notes.push(placed);
    },
  };
}

// The notes of one scan as the view shows them, with the drift of the old places; a note per step.
export function* placeSteps(d: ViewDeps, scan: { notes: NoteFile[] }): Generator<void, Placed> {
  const p = placer(d);
  for (const n of scan.notes) {
    yield;
    p.place(n);
  }
  return { notes: p.notes, drift: p.drift };
}

// The same in one go, for a view update: steps cost more than placing a note.
export function placeAll(d: ViewDeps, scan: { notes: NoteFile[] }): Placed {
  const p = placer(d);
  for (const n of scan.notes) p.place(n);
  return { notes: p.notes, drift: p.drift };
}

// The notes of one scan as the view holds them, a note per step.
export function* buildView(d: ViewDeps, scan: { notes: NoteFile[]; version: number }): Generator<void, View> {
  const { paths, lintCache } = d;
  const { notes, drift } = yield* placeSteps(d, scan);
  const links = yield* linkSteps(notes, drift);
  return { ...links, version: scan.version, lint: yield* lintIndexSteps(paths.vault, notes, links.byName, { cache: lintCache, budgetMs: LINT_BUDGET_MS }) };
}

// A view note as the map and the note route send it.
export function toNode(n: ViewNote, v: View, live: Set<string>): MemoryNode {
  return {
    id: n.id,
    title: n.title,
    file: n.file,
    project: n.project,
    connected: n.connected,
    degree: v.degree.get(n.id) ?? 0,
    live: n.project !== null && live.has(n.project),
    mtime: n.mtime,
    summary: n.summary,
    issues: v.lint.issues.get(n.id) ?? [],
    type: n.meta.type, tags: n.meta.tags, modified: n.meta.modified,
  };
}
