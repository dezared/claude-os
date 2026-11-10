// The state of a project's wiki migration: data/wiki-migration/<key>.json, and its staging dir in the vault
// (vault/.wiki-migration/<key>/<run>/<n>/{brief.md, out/, map.json}, old files at <run>/old/).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { WikiPreview, WikiRunView } from '../../shared/contract.ts';
import type { Ctx, Paths } from '../context.ts';
import type { Store } from './store.ts';
import { httpError, safely, sha256 } from './util.ts';
import type { WikiSync } from './wikiSync.ts';
import { readMap, type MapEntry } from './wikiVerify.ts';

export type BatchState = WikiRunView['batches'][number] & { fixups: number };

export interface AppliedRun {
  at: number;
  moved: Record<string, string>; // inputs and MEMORY.md moved to movedTo: file -> sha
  migrated: Record<string, string>; // what this run added to RunFile.migrated
  created: Record<string, string>; // new note -> sha as written
  links: { path: string; before: string; after: string; backup: string }[]; // shas; backup holds the text before
  movedTo: string;
  wasManaged: boolean;
}

export interface RunFile {
  run: string | null; // null: no run (discarded), only `migrated` is kept
  state: WikiRunView['state'];
  inputs: Record<string, string>; // file -> sha at prepare
  batches: BatchState[];
  preview: WikiPreview | null;
  outs: Record<string, { n: number; sha: string }>; // new notes at preview time; apply writes only these
  migrated: Record<string, string>; // old-place files that must not come back: file -> sha, over all runs
  applied?: AppliedRun;
}

const stateDir = (paths: Pick<Paths, 'data'>) => join(paths.data, 'wiki-migration');
export const runDirOf = (paths: Pick<Paths, 'vault'>, key: string, run: string) => join(paths.vault, '.wiki-migration', key, run);
export const batchDirOf = (paths: Pick<Paths, 'vault'>, key: string, run: string, n: number) => join(runDirOf(paths, key, run), String(n));

export function readRun(paths: Pick<Paths, 'data'>, key: string): RunFile | null {
  return safely(() => JSON.parse(readFileSync(join(stateDir(paths), `${key}.json`), 'utf8')) as RunFile, null);
}

export function writeRun(paths: Pick<Paths, 'data'>, key: string, run: RunFile): void {
  mkdirSync(stateDir(paths), { recursive: true });
  writeFileSync(join(stateDir(paths), `${key}.json`), `${JSON.stringify(run, null, 2)}\n`);
}

export function readAllRuns(paths: Pick<Paths, 'data'>): Map<string, RunFile> {
  const keys = safely(() => readdirSync(stateDir(paths)), []).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  return new Map(keys.map((k) => [k, readRun(paths, k)]).filter((e): e is [string, RunFile] => e[1] !== null));
}

// file -> sha of the project's migrated originals: the copy paths, the drift count and the view skip them.
export function migratedSources(paths: Pick<Paths, 'data'>, key: string): Map<string, string> {
  return new Map(Object.entries(readRun(paths, key)?.migrated ?? {}));
}

// One read per project for a whole view rebuild.
export function migratedLookup(paths: Pick<Paths, 'data'>): (key: string | null) => Map<string, string> {
  const cache = new Map<string | null, Map<string, string>>();
  return (key) => cache.get(key) ?? cache.set(key, key === null ? new Map() : migratedSources(paths, key)).get(key)!;
}

export function isMigratedFile(paths: Pick<Paths, 'data'>, key: string, path: string): boolean {
  const sha = migratedSources(paths, key).get(basename(path));
  return sha !== undefined && sha === safely(() => sha256(readFileSync(path, 'utf8')), null);
}

// What the migration modules share: runs by project key, kept in memory and on disk.
export interface Mig {
  ctx: Ctx;
  store: Store;
  sync: WikiSync;
  runs: Map<string, RunFile>;
}

export function saveRun(m: Mig, key: string, run: RunFile): void {
  m.runs.set(key, run);
  writeRun(m.ctx.paths, key, run);
  m.ctx.invalidate('memory');
}

export function checkKey(key: string): void {
  if (!/^[^/\\]+$/.test(key) || key.startsWith('.')) throw httpError(400, 'bad project key');
}

// The project's run when it is in one of `states`, else 409.
export function openRun(m: Mig, key: string, states: WikiRunView['state'][], what: string): RunFile {
  checkKey(key);
  const run = m.runs.get(key);
  if (!run?.run || !states.includes(run.state)) throw httpError(409, `no wiki migration of ${key} to ${what}`);
  return run;
}

export function viewOf(key: string, run: RunFile | undefined): WikiRunView | null {
  if (!run?.run) return null;
  return { project: key, run: run.run, state: run.state, batches: run.batches.map(({ fixups: _f, ...b }) => b), preview: run.preview };
}

export const projectDir = (m: Mig, key: string) => join(m.ctx.paths.vault, 'projects', key);

// The notes a migration rewrites: every flat note of the project but the generated MEMORY.md.
export function inputsOf(m: Mig, key: string): string[] {
  return m.store.listMd(projectDir(m, key), false).map((p) => basename(p)).filter((f) => f !== 'MEMORY.md').sort();
}

// A batch's out/*.md: file -> text.
export function outNotes(batchDir: string): Map<string, string> {
  const dir = join(batchDir, 'out');
  const files = safely(() => readdirSync(dir, { withFileTypes: true }), []).filter((e) => e.isFile() && /\.md$/i.test(e.name) && !e.name.startsWith('.'));
  return new Map(files.map((e) => e.name).sort().map((f) => [f, readFileSync(join(dir, f), 'utf8')]));
}

export function batchMap(batchDir: string): { entries: MapEntry[]; error: string | null } {
  const path = join(batchDir, 'map.json');
  const text = safely(() => readFileSync(path, 'utf8'), null);
  return text === null ? { entries: [], error: `map.json is missing; write it to ${path}` } : readMap(text);
}
