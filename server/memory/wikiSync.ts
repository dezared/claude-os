// Keeps vault notes in the wiki format whoever writes them: the watcher fixes mechanical defects (with a backup),
// flags the rest through lint issues, logs every change in _log/<key>.md and regenerates MEMORY.md and _index/<key>.md.
// Only projects marked managed (isWikiManaged: after their migration) are written; the rest are left as they are.
// Old-place notes and notes nobody changed since the server started are never written.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import type { Ctx } from '../context.ts';
import { lintNote, slugOf } from './lint.ts';
import type { Store } from './store.ts';
import { isWikiManaged } from './wikiManaged.ts';
import { backupFile, safely, sha256 } from './util.ts';
import { appendLog, renderCatalog, renderMemoryIndex } from './wikiIndex.ts';

type LogEntry = Parameters<typeof appendLog>[2][number];

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
}

// projects/<key>/<file>.md, flat, as the store scans them; null for anything else.
function vaultNoteOf(vault: string, path: string): { key: string; file: string } | null {
  const parts = relative(join(vault, 'projects'), path).split(sep);
  if (parts.length !== 2 || parts[0] === '..' || parts.some((p) => p.startsWith('.'))) return null;
  return parts[1].toLowerCase().endsWith('.md') ? { key: parts[0], file: parts[1] } : null;
}

function notesAtStart(vault: string): Map<string, string> {
  const seen = new Map<string, string>();
  const dir = join(vault, 'projects');
  for (const key of safely(() => readdirSync(dir), [])) {
    for (const file of safely(() => readdirSync(join(dir, key)), [])) {
      const path = join(dir, key, file);
      if (vaultNoteOf(vault, path)) seen.set(path, '');
    }
  }
  return seen;
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

function regenerate(s: State, key: string): { memory: boolean; catalog: boolean } {
  const { vault } = s.ctx.paths;
  const dir = join(vault, 'projects', key);
  if (!existsSync(dir) || !isWikiManaged(s.ctx.paths, key)) return { memory: false, catalog: false };
  const notes = s.store.indexNotes(key);
  return {
    memory: writeOwn(s, join(dir, 'MEMORY.md'), renderMemoryIndex(key, notes), true),
    catalog: writeOwn(s, join(vault, '_index', `${key}.md`), renderCatalog(key, notes), false),
  };
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
  const touched = new Map<string, LogEntry[]>();
  let fixed = false;
  for (const path of new Set(paths)) fixed = pathChanged(s, path, touched) || fixed;
  if (fixed) s.store.touch();
  for (const [key, entries] of touched) {
    appendLog(s.ctx.paths.vault, key, entries);
    regenerate(s, key);
  }
}

export function createWikiSync(ctx: Ctx, store: Store): WikiSync {
  const s: State = { ctx, store, seen: notesAtStart(ctx.paths.vault) };
  return {
    changed: (paths) => changed(s, paths),
    regenerate: (key) => regenerate(s, key),
    log: (key, entries) => appendLog(ctx.paths.vault, key, entries),
    ownWrite: (path, text) => void s.seen.set(path, sha256(text)),
    forget: (path) => void s.seen.delete(path),
  };
}
