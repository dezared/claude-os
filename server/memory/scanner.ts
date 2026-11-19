// Keeps the store's note files current. A start loads the snapshot of the last run and checks it against the disk
// in short slices, so the server answers at once at 100k notes; until that check is done the scan is not
// complete and nothing generated (MEMORY.md, _index) may be written from it.
import { drain, originOf, readNoteFile, sliced, statPass, type NoteFile, type Places, type ScanDiff } from './scan.ts';
import { readSnapshot, writeSnapshot } from './snapshot.ts';

// The store reads note files through this module only.
export { drain, listMd, sliced, subdirs, type NoteFile } from './scan.ts';

// How often a stat pass over every note heals missed watcher events (inotify limits, a watcher not ready yet):
// cheap next to a full read, but not free at 60k files, so a large vault heals less often.
const healMs = (files: number) => (files > 5_000 ? 60_000 : 15_000);
// A snapshot only saves rereads at the next start: written after the start pass and then at most this often.
const SAVE_MS = 10 * 60_000;
// The changed paths of this many recent versions are kept, so the store updates its view by them, not from scratch.
const LOG_MAX = 64;

export interface Scanner {
  // Paths: reread just these; none: a stat pass over everything.
  mark(paths?: string[]): void;
  current(): { notes: NoteFile[]; version: number };
  // The paths changed after `version`, and those of them added to the list (they moved to its end), or null when
  // that is not known (before the start pass, or too long ago).
  changedSince(version: number): Changes | null;
  file(path: string): NoteFile | undefined;
  oldPlace(): boolean; // some note lives in an old place (<claudeDir>/projects/<dir>/memory)
  // Every file of the vault was checked against the disk at least once since the start.
  complete(): boolean;
  ready: Promise<void>;
  close(): Promise<void>;
}

export interface Changes { changed: Set<string>; inserted: Set<string> }

interface State {
  places: Places;
  snapshotPath: string | null;
  files: Map<string, NoteFile>;
  version: number;
  complete: boolean;
  full: boolean; // a stat pass over everything was asked for
  closed: boolean;
  saved: number; // the version the snapshot on disk holds
  saving: Promise<unknown> | null;
  timers: Set<NodeJS.Timeout>;
  dirty: Set<string>;
  log: { version: number; paths: string[]; inserted: string[] }[];
  floor: number; // changedSince knows every change after this version
  list: { notes: NoteFile[]; version: number } | null;
  oldPlace: number; // notes in an old place, counted by put() after the start pass
}

function put(s: State, path: string, next: NoteFile | null): boolean {
  if (s.files.get(path)?.dir) s.oldPlace--;
  if (next?.dir) s.oldPlace++;
  if (!next) return s.files.delete(path);
  s.files.set(path, next);
  return true;
}

function record(s: State, paths: string[], inserted: string[]) {
  s.version++;
  s.log.push({ version: s.version, paths, inserted });
  if (s.log.length > LOG_MAX) s.floor = s.log.shift()!.version;
}

function later(s: State, fn: () => void, ms: number) {
  const t = setTimeout(() => {
    s.timers.delete(t);
    if (!s.closed) fn();
  }, ms);
  t.unref();
  s.timers.add(t);
}

function apply(s: State, diff: ScanDiff): boolean {
  const changed: string[] = [];
  const inserted: string[] = [];
  for (const [path, { old, next }] of diff) {
    if (s.files.get(path) !== old) continue;
    put(s, path, next);
    changed.push(path);
    if (!old && next) inserted.push(path);
  }
  if (changed.length) record(s, changed, inserted);
  return changed.length > 0;
}

// One changed path; anything that is not a note file (a folder, say) asks for a full pass.
function rescan(s: State, path: string): boolean {
  const origin = originOf(s.places, path);
  if (!origin) {
    s.full = true;
    return false;
  }
  return put(s, path, readNoteFile(path, origin));
}

function save(s: State) {
  if (!s.snapshotPath || s.saving || s.closed || s.saved === s.version) return;
  const at = s.version;
  s.saving = writeSnapshot(s.snapshotPath, s.places, [...s.files.values()], () => s.closed)
    .then((done) => void (done && (s.saved = at)), () => {})
    .finally(() => (s.saving = null));
}

function heal(s: State) {
  sliced(statPass(s.places, s.files)).then((diff) => apply(s, diff), () => {}).finally(() => later(s, () => heal(s), healMs(s.files.size)));
}

function* start(s: State): Generator<void, void> {
  if (s.snapshotPath) {
    try {
      s.files = yield* readSnapshot(s.snapshotPath, s.places);
      s.version++;
    } catch {
      s.files = new Map(); // none yet, another version or broken: read the vault instead
    }
  }
  const changed = apply(s, yield* statPass(s.places, s.files));
  if (!changed && s.version > 0) s.saved = s.version;
  s.log = [];
  s.floor = s.version;
  s.oldPlace = 0;
  for (const n of s.files.values()) if (n.dir) s.oldPlace++;
  s.complete = true;
}

function current(s: State): { notes: NoteFile[]; version: number } {
  if (s.complete) {
    const fresh = [...s.dirty].filter((p) => !s.files.has(p));
    const changed = [...s.dirty].filter((p) => rescan(s, p));
    s.dirty.clear();
    if (changed.length) record(s, changed, fresh.filter((p) => s.files.has(p)));
    if (s.full) {
      s.full = false;
      apply(s, drain(statPass(s.places, s.files)));
    }
  }
  // One list per version: the store asks for it on every lint context and search.
  if (s.list?.version !== s.version) s.list = { notes: [...s.files.values()], version: s.version };
  return s.list;
}

function changedSince(s: State, version: number): Changes | null {
  if (!s.complete || version < s.floor) return null;
  const since = s.log.filter((e) => e.version > version);
  return { changed: new Set(since.flatMap((e) => e.paths)), inserted: new Set(since.flatMap((e) => e.inserted)) };
}

export function createScanner(places: Places, snapshotPath: string | null): Scanner {
  const s: State = {
    places, snapshotPath, files: new Map(), version: 0, complete: false, full: false, closed: false, saved: -1, saving: null,
    timers: new Set(), dirty: new Set(), log: [], floor: Infinity, list: null, oldPlace: 0,
  };
  const periodic = () => {
    save(s);
    later(s, periodic, SAVE_MS);
  };
  const ready = sliced(start(s)).then(() => {
    save(s);
    later(s, () => heal(s), healMs(s.files.size));
    later(s, periodic, SAVE_MS);
  });
  return {
    mark(paths) {
      if (paths) for (const p of paths) s.dirty.add(p);
      else s.full = true;
    },
    current: () => current(s),
    changedSince: (version) => changedSince(s, version),
    file: (path) => s.files.get(path),
    oldPlace: () => s.oldPlace > 0,
    complete: () => s.complete,
    ready,
    async close() {
      s.closed = true;
      for (const t of s.timers) clearTimeout(t);
      await s.saving;
    },
  };
}
