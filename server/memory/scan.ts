// The note files the store sees, kept between scans: at tens of thousands of notes a scan rereads only what changed.
// The watcher names changed paths (reread one by one); a periodic stat pass heals missed events.
import { opendirSync, readdirSync, readFileSync, statSync, type Dir, type Stats } from 'node:fs';
import { basename, join, relative, sep } from 'node:path';
import { noteMeta, type NoteMeta } from './frontmatter.ts';
import { noteSummary } from './summary.ts';
import { parseFrontmatter, safely, sha256 } from './util.ts';
import { nextTurn } from './turns.ts';
import { extractLinks, normalizeName } from './wikilinks.ts';

export interface NoteFile {
  id: string;
  path: string;
  file: string;
  nameKey: string; // normalizeName(file): how links find it
  title: string;
  summary: string | null;
  content: string;
  sha: string; // of content
  meta: NoteMeta;
  mtime: number;
  size: number;
  links: string[];
  vaultKey: string | null; // vault projects/<key>
  isGlobal: boolean; // vault global/
  dir: string | null; // unconnected source: <claudeDir>/projects/<dir>/memory
}

export type Origin = Pick<NoteFile, 'vaultKey' | 'isGlobal' | 'dir'>;

export function readNoteFile(path: string, origin: Origin, stat?: Stats): NoteFile | null {
  return safely(() => {
    const st = stat ?? statSync(path);
    const content = readFileSync(path, 'utf8');
    const file = basename(path);
    const { data, body } = parseFrontmatter(content);
    const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
    return {
      id: sha256(path).slice(0, 16),
      path,
      file,
      nameKey: normalizeName(file),
      title: data.name || heading || file.replace(/\.md$/i, ''),
      summary: noteSummary(data.description, body),
      content,
      sha: sha256(content),
      meta: noteMeta(content),
      mtime: st.mtimeMs,
      size: st.size,
      links: extractLinks(content),
      ...origin,
    };
  }, null);
}

const isMd = (name: string) => name.toLowerCase().endsWith('.md');

export function listMd(dir: string, recursive: boolean): string[] {
  const out: string[] = [];
  for (const e of safely(() => readdirSync(dir, { withFileTypes: true }), [])) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDirectory() && recursive) out.push(...listMd(full, true));
    else if (isMd(e.name) && !e.isDirectory()) out.push(full);
  }
  return out;
}

export function subdirs(dir: string): string[] {
  return safely(() => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name), []);
}

export interface Places { vault: string; claudeProjects: string }

// One directory entry per step: a project folder of 100k notes is listed without holding the server.
function* entries(dir: string): Generator<void, { name: string; isDir: boolean }[]> {
  const out: { name: string; isDir: boolean }[] = [];
  const handle = safely<Dir | null>(() => opendirSync(dir), null);
  if (!handle) return out;
  try {
    for (let e = handle.readSync(); e; e = handle.readSync()) {
      out.push({ name: e.name, isDir: e.isDirectory() });
      yield;
    }
  } finally {
    handle.closeSync();
  }
  return out;
}

function* mdIn(dir: string, recursive: boolean): Generator<void, string[]> {
  const out: string[] = [];
  for (const e of yield* entries(dir)) {
    if (e.name.startsWith('.')) continue;
    const full = join(dir, e.name);
    if (e.isDir && recursive) out.push(...(yield* mdIn(full, true)));
    else if (isMd(e.name) && !e.isDir) out.push(full);
  }
  return out;
}

const dirsIn = function* (dir: string): Generator<void, string[]> {
  return (yield* entries(dir)).filter((e) => e.isDir).map((e) => e.name);
};

// Every note file of the scanned places with where it belongs.
function* listAll({ vault, claudeProjects }: Places): Generator<void, [string, Origin][]> {
  const out: [string, Origin][] = [];
  for (const key of yield* dirsIn(join(vault, 'projects'))) {
    if (key.startsWith('.')) continue;
    for (const p of yield* mdIn(join(vault, 'projects', key), false)) out.push([p, { vaultKey: key, isGlobal: false, dir: null }]);
  }
  for (const p of yield* mdIn(join(vault, 'global'), true)) out.push([p, { vaultKey: null, isGlobal: true, dir: null }]);
  for (const dir of yield* dirsIn(claudeProjects)) {
    for (const p of yield* mdIn(join(claudeProjects, dir, 'memory'), false)) out.push([p, { vaultKey: null, isGlobal: false, dir }]);
  }
  return out;
}

// Where a changed path belongs, as listAll would find it; null: not a note file of any scanned place.
export function originOf({ vault, claudeProjects }: Places, path: string): Origin | null {
  if (!isMd(path)) return null;
  const inside = (base: string) => {
    const parts = relative(base, path).split(sep);
    return parts[0] === '..' || parts.some((p) => p.startsWith('.')) ? null : parts;
  };
  const project = inside(join(vault, 'projects'));
  if (project?.length === 2) return { vaultKey: project[0], isGlobal: false, dir: null };
  if (inside(join(vault, 'global'))) return { vaultKey: null, isGlobal: true, dir: null };
  const old = inside(claudeProjects);
  return old?.length === 3 && old[1] === 'memory' ? { vaultKey: null, isGlobal: false, dir: old[0] } : null;
}

// What a stat pass found against `files`: a reread note, or null for a gone one, with the object it replaces.
// Applied only where the path still holds that object, so a pass that ran across a watcher reread loses nothing.
export type ScanDiff = Map<string, { old: NoteFile | undefined; next: NoteFile | null }>;

const sameOrigin = (a: Origin, b: Origin) => a.vaultKey === b.vaultKey && a.isGlobal === b.isGlobal && a.dir === b.dir;
const unchanged = (old: NoteFile | undefined, st: Stats, origin: Origin) => !!old && old.mtime === st.mtimeMs && old.size === st.size && sameOrigin(old, origin);

// Rereads only the files whose mtime, size or place moved; one file per step.
export function* statPass(places: Places, files: Map<string, NoteFile>): Generator<void, ScanDiff> {
  const diff: ScanDiff = new Map();
  const listed = new Set<string>();
  for (const [path, origin] of yield* listAll(places)) {
    listed.add(path);
    const old = files.get(path);
    const st = safely(() => statSync(path), null);
    yield;
    if (!st || unchanged(old, st, origin)) continue;
    const next = readNoteFile(path, origin, st);
    yield;
    if (next || old) diff.set(path, { old, next });
  }
  for (const [path, old] of files) if (!listed.has(path)) diff.set(path, { old, next: null });
  return diff;
}

// Runs every step now: a pass somebody waits for (a write asked for a rescan).
export function drain<T>(steps: Generator<void, T>): T {
  for (;;) {
    const r = steps.next();
    if (r.done) return r.value;
  }
}

// The first slice at least this many steps: a small vault is read before the store is created returns.
const FIRST_STEPS = 2_000;
// Short enough that a slice and the requests of the same turn stay under 50 ms.
const SLICE_MS = 10;

// Runs the steps in slices between requests, so a pass over 100k files never holds the server for long. `firstSteps`
// run before the call returns: 0 for steps that are each heavy.
export function sliced<T>(steps: Generator<void, T>, firstSteps = FIRST_STEPS): Promise<T> {
  return new Promise((resolve, reject) => {
    let count = 0;
    const run = (first: boolean) => {
      const end = performance.now() + SLICE_MS;
      try {
        for (;;) {
          const r = steps.next();
          if (r.done) return resolve(r.value);
          if (++count >= firstSteps) first = false;
          if (!first && performance.now() >= end) break;
        }
      } catch (err) {
        return reject(err);
      }
      nextTurn(() => run(false));
    };
    // Nothing now when each step is heavy: the caller returns first.
    if (firstSteps) run(true);
    else nextTurn(() => run(false));
  });
}
