// Keeps vault notes in the wiki format whoever writes them: the watcher fixes mechanical defects (with a backup),
// flags the rest through lint issues, logs every change in _log/<key>.md and regenerates MEMORY.md and _index/<key>.md.
// Only projects marked managed (isWikiManaged: after their migration) are written; the rest are left as they are.
// Old-place notes and notes nobody changed since the server started are never written.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { Ctx } from '../context.ts';
import { lintNote, slugOf } from './lint.ts';
import type { Store } from './store.ts';
import { isWikiManaged } from './wikiManaged.ts';
import { drain, sliced } from './scan.ts';
import { backupFile, safely, sha256 } from './util.ts';
import { appendLog, catalogSteps, memoryIndexSteps, type IndexNote } from './wikiIndex.ts';

type LogEntry = Parameters<typeof appendLog>[2][number];

// Up to this many notes in the vault a watcher batch, MEMORY.md and _index are done before changed() returns; above,
// in turns: linting a batch of 15 notes held the server for 40-80 ms, rendering the catalog of 25k notes for 100 ms.
const CHANGE_NOW = 5_000;

export interface WikiSync {
  // Paths from the watcher (any, also outside the vault); only projects/<key>/*.md are acted on.
  changed(paths: string[]): void;
  // Managed projects only. Reads the store's current view: touch() the store after writing notes.
  regenerate(key: string): { memory: boolean; catalog: boolean };
  log(key: string, entries: LogEntry[]): void;
  // A write the server made: its watcher event is not linted, logged or regenerated again.
  ownWrite(path: string, text: string): void;
  // A note the server moved away: its watcher event is not logged as a delete.
  forget(path: string): void;
}

interface State {
  ctx: Ctx;
  store: Store;
  // path -> sha of the content last written or handled here; '' for notes present at start, not read yet.
  seen: Map<string, string>;
  // Per project: the latest regeneration (an older one in slices does not write), one in slices running, another asked.
  regen: Map<string, { gen: number; running: boolean; again: boolean }>;
}

// projects/<key>/<file>.md, flat, as the store scans them; null for anything else.
function vaultNoteOf(vault: string, path: string): { key: string; file: string } | null {
  const parts = relative(join(vault, 'projects'), path).split(sep);
  if (parts.length !== 2 || parts[0] === '..' || parts.some((p) => p.startsWith('.'))) return null;
  return parts[1].toLowerCase().endsWith('.md') ? { key: parts[0], file: parts[1] } : null;
}

// The vault's project notes as the start pass found them: listed again by the scanner, not read here.
function notesAtStart(s: State): void {
  for (const n of s.store.noteFiles()) if (n.vaultKey !== null && n.dir === null && !s.seen.has(n.path)) s.seen.set(n.path, '');
}

function writeOwn(s: State, path: string, text: string, backup: boolean): boolean {
  if ((safely(() => readFileSync(path, 'utf8'), null) ?? '') === text) return false;
  if (backup) backupFile(s.ctx.paths.data, path);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  s.seen.set(path, sha256(text));
  return true;
}

// The log line for one changed note; a fix is written back here.
function noteChanged(s: State, path: string, file: string, text: string | null): LogEntry | null {
  const stem = file.replace(/\.md$/i, '');
  if (text === null) return s.seen.delete(path) ? { op: 'delete', name: stem } : null;
  const op = s.seen.has(path) ? 'update' : 'add';
  s.seen.set(path, sha256(text));
  const { fixed, fixes } = lintNote(file, text, s.store.lintCtx(path));
  if (fixed === null) return { op, name: stem };
  writeOwn(s, path, fixed, true);
  return { op: 'fix', name: slugOf(stem) || stem, reason: fixes.join(' ') };
}

// A view the start pass has not checked yet may miss notes: MEMORY.md and _index wait for the full one.
const regenerable = (s: State, key: string) =>
  s.store.complete() && existsSync(join(s.ctx.paths.vault, 'projects', key)) && isWikiManaged(s.ctx.paths, key);

const regenOf = (s: State, key: string) => s.regen.get(key) ?? s.regen.set(key, { gen: 0, running: false, again: false }).get(key)!;

function* regenerateSteps(s: State, key: string, list: Generator<void, IndexNote[]>, latest: () => boolean): Generator<void, { memory: boolean; catalog: boolean }> {
  const { vault } = s.ctx.paths;
  const notes = yield* list;
  const memory = yield* memoryIndexSteps(key, notes);
  const catalog = yield* catalogSteps(key, notes);
  // A newer regeneration ran meanwhile: what it wrote stands. Each file in its own step: comparing and writing a
  // 2 MB catalog takes a slice of its own.
  if (!latest()) return { memory: false, catalog: false };
  const wroteMemory = writeOwn(s, join(vault, 'projects', key, 'MEMORY.md'), memory, true);
  yield;
  if (!latest()) return { memory: wroteMemory, catalog: false };
  return { memory: wroteMemory, catalog: writeOwn(s, join(vault, '_index', `${key}.md`), catalog, false) };
}

function regenerate(s: State, key: string): { memory: boolean; catalog: boolean } {
  if (!regenerable(s, key)) return { memory: false, catalog: false };
  const r = regenOf(s, key);
  const gen = ++r.gen;
  return drain(regenerateSteps(s, key, s.store.indexNotesLater(key), () => r.gen === gen));
}

// After a change: a small project at once, a large one in slices, one run per project at a time.
function regenerateSoon(s: State, key: string): void {
  if (!regenerable(s, key)) return;
  const r = regenOf(s, key);
  if (s.store.noteFiles().length <= CHANGE_NOW && !r.running) return void regenerate(s, key);
  if (r.running) return void (r.again = true);
  r.running = true;
  const gen = ++r.gen;
  sliced(regenerateSteps(s, key, s.store.indexNotesLater(key), () => r.gen === gen), 0).catch((err) => s.ctx.app.log.error(err)).finally(() => {
    r.running = false;
    if (!r.again) return;
    r.again = false;
    regenerateSoon(s, key);
  });
}

// Adds the path's log line to its project; true when a fix was written. Unchanged and own writes are skipped.
function pathChanged(s: State, path: string, touched: Map<string, LogEntry[]>): boolean {
  const at = vaultNoteOf(s.ctx.paths.vault, path);
  if (!at || !isWikiManaged(s.ctx.paths, at.key)) return false;
  const text = safely(() => readFileSync(path, 'utf8'), null);
  if (text !== null && s.seen.get(path) === sha256(text)) return false;
  const entries = touched.get(at.key) ?? [];
  touched.set(at.key, entries);
  if (at.file === 'MEMORY.md') return false; // someone else's edit: regenerated with the project
  const entry = noteChanged(s, path, at.file, text);
  if (entry) entries.push(entry);
  return entry?.op === 'fix';
}

function changed(s: State, paths: string[]): void {
  if (!s.store.complete()) {
    // Handled once the start pass is done: a fix and the regeneration both read the whole vault.
    void s.store.ready.then(() => changed(s, paths));
    return;
  }
  const steps = changedSteps(s, paths);
  if (s.store.noteFiles().length <= CHANGE_NOW) drain(steps);
  else sliced(steps, 0).catch((err) => s.ctx.app.log.error(err));
}

function* changedSteps(s: State, paths: string[]): Generator<void, void> {
  const touched = new Map<string, LogEntry[]>();
  const fixed: string[] = [];
  for (const path of new Set(paths)) {
    if (pathChanged(s, path, touched)) fixed.push(path);
    yield;
  }
  // Only the fixed notes are reread: a stat pass over 100k notes held the server for a third of a second.
  if (fixed.length) s.store.touch(fixed);
  for (const [key, entries] of touched) {
    appendLog(s.ctx.paths.vault, key, entries);
    regenerateSoon(s, key);
  }
}

export function createWikiSync(ctx: Ctx, store: Store): WikiSync {
  const s: State = { ctx, store, seen: new Map(), regen: new Map() };
  if (store.complete()) notesAtStart(s);
  else void store.ready.then(() => notesAtStart(s));
  return {
    changed: (paths) => changed(s, paths),
    regenerate: (key) => regenerate(s, key),
    log: (key, entries) => appendLog(ctx.paths.vault, key, entries),
    ownWrite: (path, text) => void s.seen.set(path, sha256(text)),
    forget: (path) => void s.seen.delete(path),
  };
}
