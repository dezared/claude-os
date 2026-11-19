// The store's current view and the build counters its caches and the search index follow. A full build at the
// start and when settings may have moved (in slices, readers keep the current view); after a note write an update
// by the changed paths, so a write into 100k notes costs what it changed.
import type { Ctx } from '../context.ts';
import { searchDocOf } from './noteIndex.ts';
import type { SearchDoc } from './search.ts';
import { drain, sliced, type Changes, type NoteFile, type Scanner } from './scanner.ts';
import { backgroundJobs, buildView, type View, type ViewDeps, type ViewNote } from './view.ts';
import { updateView } from './viewDelta.ts';

// Drift and connections follow project settings, which no watcher sees; note changes update the view at once.
const VIEW_TTL_MS = 15_000;
// An update lints the changed notes this long; the rest runs as deferred jobs.
const UPDATE_LINT_MS = 20;
// Up to this many notes what is derived from the view (the map sample, the catalog) is rebuilt at once.
const DERIVE_NOW = 5_000;

type Scan = { notes: NoteFile[]; version: number };

interface Kept {
  ctx: Ctx;
  scanner: Scanner;
  steps(scan: Scan): Generator<void, View>;
  deps(): ViewDeps;
  lintLater: ReturnType<typeof backgroundJobs>;
  view: View | null;
  viewAt: number;
  builds: number; // view rebuilds and updates
  noteBuilds: number; // those whose notes changed: the search index syncs only after one
  // What the search index has not taken yet: changed paths with their note (null: gone), or everything.
  searchFull: boolean;
  searchChanged: Map<string, ViewNote | null>;
  starting: boolean; // a large vault: until its first full view is built in slices, readers see an empty one
  refreshing: Promise<void> | null;
}

function publish(k: Kept, next: View): View {
  // The same note objects (viewNoteCache) mean the same search rows: a replan of 100k rows took ~150 ms.
  const { view } = k;
  if (!view || view.notes.length !== next.notes.length || view.notes.some((n, i) => n !== next.notes[i])) {
    k.noteBuilds++;
    k.searchFull = true;
    k.searchChanged.clear();
  }
  k.view = next;
  k.viewAt = Date.now();
  k.builds++;
  k.lintLater.start(next.lint.pending);
  return next;
}

function update(k: Kept, prev: View, scan: Scan, since: Changes): View {
  const { view, changes, jobs } = updateView(k.deps(), prev, scan, { changes: since, fileAt: k.scanner.file, oldPlace: k.scanner.oldPlace(), budgetMs: UPDATE_LINT_MS });
  k.view = view;
  k.viewAt = Date.now();
  k.builds++;
  if (changes.length) k.noteBuilds++;
  for (const { old, next } of changes) k.searchChanged.set((next ?? old)!.path, next ?? null);
  k.lintLater.add(jobs);
  return view;
}

// An aged view (settings drift has no watcher) is rebuilt in slices while readers keep the current one: at 100k
// notes a rebuild in one go held the server for about a second.
function refresh(k: Kept): void {
  k.viewAt = Date.now();
  k.refreshing ??= sliced(k.steps(k.scanner.current())).then((v) => {
    if (k.view?.version !== v.version) return;
    publish(k, v);
    k.ctx.invalidate('memory');
  }).catch((err) => k.ctx.app.log.error(err)).finally(() => (k.refreshing = null));
}

function getView(k: Kept): View {
  if (k.starting) return k.view ?? publish(k, drain(k.steps({ notes: [], version: -1 })));
  const scan = k.scanner.current();
  const { view } = k;
  if (!view) return publish(k, drain(k.steps(scan)));
  if (view.version !== scan.version) {
    const changed = k.scanner.changedSince(view.version);
    return changed ? update(k, view, scan, changed) : publish(k, drain(k.steps(scan)));
  }
  if (Date.now() - k.viewAt >= VIEW_TTL_MS) refresh(k);
  return view;
}

// The changes since the last call, or null when the index must diff every note (the first sync, a full rebuild).
function searchChanges(k: Kept): { docs: SearchDoc[]; removes: string[] } | null {
  getView(k);
  const full = k.searchFull;
  const taken = [...k.searchChanged];
  k.searchFull = false;
  k.searchChanged.clear();
  if (full) return null;
  const keep = (n: ViewNote | null): n is ViewNote => !!n && n.file !== 'MEMORY.md';
  return { docs: taken.map(([, n]) => n).filter(keep).map(searchDocOf), removes: taken.filter(([, n]) => !keep(n)).map(([p]) => p) };
}

export function keepView(ctx: Ctx, scanner: Scanner, deps: () => ViewDeps, afterStart: () => Promise<unknown>) {
  const k: Kept = {
    ctx, scanner, deps, steps: (scan) => buildView(deps(), scan), view: null, viewAt: 0, builds: 0, noteBuilds: 0, searchFull: true,
    searchChanged: new Map(), starting: !scanner.complete(), refreshing: null,
    // Deferred lint fills the issues of the current view in place; the caches follow once it is done.
    lintLater: backgroundJobs(() => {
      k.builds++;
      ctx.invalidate('memory');
    }),
  };
  ctx.app.addHook('onClose', async () => k.lintLater.stop());
  const ready = k.starting ? scanner.ready.then(() => sliced(k.steps(scanner.current()))).then((v) => {
    publish(k, v);
    k.starting = false;
    return afterStart();
  }).then(() => ctx.invalidate('memory', 'projects')) : Promise.resolve();
  return {
    getView: () => getView(k),
    viewBuild: () => (getView(k), k.builds),
    notesBuild: () => (getView(k), k.noteBuilds),
    searchChanges: () => searchChanges(k),
    // Something no changed path tells (a migration's lookup): the next reader builds the view from scratch.
    rebuild: () => void (k.view = null),
    complete: () => !k.starting,
    ready,
  };
}

// Something derived from the view, rebuilt when its build moved: at once for a small vault; for a large one readers
// keep the last result while the next is made in slices (at 100k notes the map sample and the catalog took about
// 140 ms each), then the interface is told to fetch again.
export function derived<T extends { build: number }>(ctx: Ctx, at: { build(): number; size(): number }, steps: () => Generator<void, T>) {
  let cache: T | null = null;
  let running: Promise<void> | null = null;
  const keep = (r: T) => (cache = !cache || cache.build <= r.build ? r : cache);
  return {
    get(): T {
      if (cache?.build === at.build()) return cache;
      if (!cache || at.size() <= DERIVE_NOW) return keep(drain(steps()));
      running ??= sliced(steps(), 0).then((r) => {
        keep(r);
        ctx.invalidate('memory');
      }).catch((err) => ctx.app.log.error(err)).finally(() => (running = null));
      return cache;
    },
    prime: () => sliced(steps()).then(keep),
  };
}
