// Wiki migration of one project (spec §4): prepare backs up and stages the notes, one tab per batch rewrites them,
// the server verifies each batch and sends a fix-up turn with the exact list, the last batch builds the preview.
// Apply and undo live in wikiApply.ts. Before apply the project only gets its old-place notes copied in (at prepare).
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import type { WikiRunView } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import type { GuardMigration } from './guard.ts';
import type { LintCtx } from './lint.ts';
import type { Store } from './store.ts';
import { backupFile, httpError, safely, sha256 } from './util.ts';
import { copyProject } from './vault.ts';
import { applyRun, buildPreview, undoRun } from './wikiApply.ts';
import { batchDirOf, batchMap, checkKey, inputsOf, openRun, outNotes, projectDir, readAllRuns, runDirOf, saveRun, viewOf, type BatchState, type Mig, type RunFile } from './wikiRun.ts';
import type { WikiSync } from './wikiSync.ts';
import { verifyBatch } from './wikiVerify.ts';
import { normalizeName } from './wikilinks.ts';

export { migratedSources } from './wikiRun.ts';

const MAX_REWRITING = 4;
const MAX_FIXUPS = 2;
const IN_PROGRESS: WikiRunView['state'][] = ['rewriting', 'ready', 'failed'];

// Name order, greedy up to `max` bytes of source; a larger file is a batch of its own.
export function splitBatches(files: { file: string; bytes: number }[], max = 60_000): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  const flush = () => {
    if (cur.length) out.push(cur);
    cur = [];
    size = 0;
  };
  for (const f of [...files].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))) {
    if (size + f.bytes > max) flush();
    cur.push(f.file);
    size += f.bytes;
    if (f.bytes > max) flush();
  }
  flush();
  return out;
}

function rootOf(m: Mig, key: string): string {
  checkKey(key);
  const root = m.store.roots(true).get(key);
  if (!root) throw httpError(404, 'unknown project');
  return root;
}

const batchDir = (m: Mig, key: string, run: RunFile, n: number) => batchDirOf(m.ctx.paths, key, run.run!, n);
const projectCtx = (m: Mig, key: string) => m.store.lintCtx(join(projectDir(m, key), 'MEMORY.md'));

// Normalized names of vault notes outside the project: a new note must not take one.
function namesOutside(m: Mig, key: string): string[] {
  const own = projectDir(m, key) + sep;
  return [...projectCtx(m, key).names].filter(([, paths]) => paths.some((p) => !p.startsWith(own))).map(([name]) => name).sort();
}

// Names of the new notes written by the batches before `n`.
function namesBefore(m: Mig, key: string, run: RunFile, n: number): string[] {
  return run.batches.filter((b) => b.n < n).flatMap((b) => [...outNotes(batchDir(m, key, run, b.n)).keys()].map(normalizeName));
}

// Lint as the note will be judged in the project after apply; its links may point at the new names of the run so far,
// at the old names (apply rewrites them) and at global notes.
function batchLint(m: Mig, key: string, run: RunFile, n: number): (path: string) => LintCtx {
  const base = projectCtx(m, key);
  const known = new Set([...namesBefore(m, key, run, n + 1), ...Object.keys(run.inputs).map(normalizeName)]);
  const global = join(m.ctx.paths.vault, 'global') + sep;
  const resolves = (name: string) => known.has(normalizeName(name)) || (base.names.get(normalizeName(name)) ?? []).some((p) => p.startsWith(global));
  return (path) => ({ path: join(projectDir(m, key), basename(path)), project: key, names: new Map(), tags: base.tags, resolves });
}

function briefText(m: Mig, key: string, run: RunFile, b: BatchState): string {
  const dir = batchDir(m, key, run, b.n);
  const rules = safely(() => readFileSync(join(m.ctx.paths.root, 'NOTE_RULES.md'), 'utf8'), '').trim();
  const taken = [...namesOutside(m, key), ...namesBefore(m, key, run, b.n)];
  const example = { old: 'project.md', new: ['db-migrations.md', 'review-checklist.md'], primary: 'db-migrations.md', dropped: [{ what: 'the 2023 deploy steps', why: 'stale: the CI pipeline replaced them' }] };
  return [
    `# Wiki migration of ${key}, batch ${b.n}/${run.batches.length}`,
    '',
    '1. Read every input note listed below.',
    '2. Rewrite their facts as new notes that follow the note rules: English, one fact per note, duplicates merged.',
    `3. Write the new notes to ${join(dir, 'out')}/ and nothing anywhere else; the input notes stay as they are.`,
    '4. Keep code spans, URLs, paths and numbers verbatim. Drop an item only when code or git can tell it or it is stale, with the reason in "dropped".',
    `5. Write ${join(dir, 'map.json')} with one entry per input note, then reply done after map.json.`,
    '', '## Note rules', '', rules,
    '', '## Input notes', '', ...b.files.map((f) => `- ${join(projectDir(m, key), f)}`),
    '', '## map.json', '',
    'A JSON array with one entry per input file; file names are relative to out/. "primary" is the new note that old [[links]] to the input should open; it is null when "new" is empty and everything is dropped.',
    '```json', JSON.stringify([example]), '```',
    '', '## Names already taken in the vault (do not reuse)', '', taken.join(', ') || '(none)',
    '', `## Tags of ${key} (reuse them)`, '', projectCtx(m, key).tags.join(', ') || '(none yet)', '',
  ].join('\n');
}

function openBatch(m: Mig, key: string, run: RunFile, b: BatchState): void {
  const dir = batchDir(m, key, run, b.n);
  mkdirSync(join(dir, 'out'), { recursive: true });
  const brief = join(dir, 'brief.md');
  writeFileSync(brief, briefText(m, key, run, b));
  const total = run.batches.length;
  const tab = m.ctx.chat!.openWithPrompt(
    { project: key, cwd: rootOf(m, key), title: `Wiki migration: ${key} ${b.n}/${total}` },
    `Wiki migration of ${key}, batch ${b.n}/${total}. Read ${brief} and follow it.`,
    { focus: false },
  );
  b.tabId = tab.tabId;
  b.status = 'running';
}

// One batch at a time: the next pending one opens; when all are ok, the preview is built and the run is ready.
function advance(m: Mig, key: string, run: RunFile): void {
  if (run.batches.some((b) => b.status === 'running')) return;
  if (run.batches.some((b) => b.status === 'failed')) {
    run.state = 'failed';
    return;
  }
  const next = run.batches.find((b) => b.status === 'pending');
  if (next) return openBatch(m, key, run, next);
  Object.assign(run, buildPreview(m, key, run), { state: 'ready' });
}

function checkBatch(m: Mig, key: string, run: RunFile, b: BatchState): { errors: string[]; warnings: string[] } {
  const dir = batchDir(m, key, run, b.n);
  const { entries, error } = batchMap(dir);
  if (error) return { errors: [error], warnings: [] };
  const inputs = b.files.map((file) => ({ file, text: safely(() => readFileSync(join(projectDir(m, key), file), 'utf8'), '') }));
  const taken = new Set([...namesOutside(m, key), ...namesBefore(m, key, run, b.n)]);
  return verifyBatch({ inputs, map: entries, out: outNotes(dir), lintCtx: batchLint(m, key, run, b.n), taken });
}

// Records the result; a failed batch is marked failed unless it gets a fix-up turn.
function settle(m: Mig, key: string, run: RunFile, b: BatchState): boolean {
  Object.assign(b, checkBatch(m, key, run, b));
  b.status = b.errors.length ? 'failed' : 'ok';
  return b.status === 'ok';
}

// A failed batch gets up to MAX_FIXUPS turns in its tab with the exact list before it stays failed.
function turnFinished(m: Mig, tabId: string): void {
  for (const [key, run] of m.runs) {
    const b = run.run && run.state === 'rewriting' ? run.batches.find((x) => x.tabId === tabId && x.status === 'running') : undefined;
    if (!b) continue;
    if (!settle(m, key, run, b) && b.fixups < MAX_FIXUPS && m.ctx.chat) {
      b.fixups++;
      b.status = 'running';
      const list = b.errors.map((e) => `- ${e}`).join('\n');
      m.ctx.chat.get(tabId).send({ text: `Verification failed:\n${list}\nFix these in ${batchDir(m, key, run, b.n)} and reply done.` });
    }
    advance(m, key, run);
    return saveRun(m, key, run);
  }
}

function refusePrepare(m: Mig, key: string): void {
  if (IN_PROGRESS.includes(m.runs.get(key)?.state ?? 'undone') && m.runs.get(key)?.run) {
    throw httpError(409, `a wiki migration of ${key} is in progress: apply or discard it first`);
  }
  const rewriting = [...m.runs.values()].filter((r) => r.run && r.state === 'rewriting').length;
  if (rewriting >= MAX_REWRITING) throw httpError(409, `${MAX_REWRITING} wiki migrations are rewriting already; wait for one to finish`);
}

let runSeq = 0;

function prepare(m: Mig, key: string): WikiRunView {
  const root = rootOf(m, key);
  refusePrepare(m, key);
  const dir = projectDir(m, key);
  copyProject(m.ctx, m.store, key, root, dir); // notes only in the old place are rewritten too
  const files = inputsOf(m, key);
  if (files.length && !m.ctx.chat) throw httpError(503, 'the chat is not running');
  for (const e of safely(() => readdirSync(dir, { withFileTypes: true }), [])) if (e.isFile()) backupFile(m.ctx.paths.data, join(dir, e.name));
  const run: RunFile = {
    run: `${new Date().toISOString().replace(/[:.]/g, '-')}-${runSeq++}`,
    state: 'rewriting',
    inputs: Object.fromEntries(files.map((f) => [f, sha256(readFileSync(join(dir, f), 'utf8'))])),
    batches: splitBatches(files.map((file) => ({ file, bytes: statSync(join(dir, file)).size })))
      .map((list, i) => ({ n: i + 1, files: list, tabId: null, status: 'pending', errors: [], warnings: [], fixups: 0 })),
    preview: null,
    outs: {},
    migrated: m.runs.get(key)?.migrated ?? {},
  };
  mkdirSync(runDirOf(m.ctx.paths, key, run.run!), { recursive: true });
  advance(m, key, run);
  saveRun(m, key, run);
  return viewOf(key, run)!;
}

// Verifies every started batch again from disk (after a hand fix), then goes on as a finished turn would.
function verifyRun(m: Mig, key: string): WikiRunView {
  const run = openRun(m, key, IN_PROGRESS, 'verify');
  for (const b of run.batches) if (b.status !== 'pending') settle(m, key, run, b);
  run.state = 'rewriting';
  advance(m, key, run);
  saveRun(m, key, run);
  return viewOf(key, run)!;
}

// Before apply only: the staging dir goes, the project was never touched.
function discard(m: Mig, key: string): { ok: true } {
  const run = openRun(m, key, IN_PROGRESS, 'discard');
  rmSync(runDirOf(m.ctx.paths, key, run.run!), { recursive: true, force: true });
  saveRun(m, key, { run: null, state: 'undone', inputs: {}, batches: [], preview: null, outs: {}, migrated: run.migrated });
  return { ok: true };
}

function batchOfTab(m: Mig, tabId: string): { key: string; run: RunFile; b: BatchState } | null {
  for (const [key, run] of m.runs) {
    const b = run.run && IN_PROGRESS.includes(run.state) ? run.batches.find((x) => x.tabId === tabId) : undefined;
    if (b) return { key, run, b };
  }
  return null;
}

// The guard's view of the batch tabs: until their run is applied or discarded.
function guardOf(m: Mig): GuardMigration {
  return {
    tab(tabId) {
      const t = batchOfTab(m, tabId);
      return t && { key: t.key, batchDir: batchDir(m, t.key, t.run, t.b.n), inputs: t.b.files.map((f) => join(projectDir(m, t.key), f)) };
    },
    lintCtx(tabId, path) {
      const t = batchOfTab(m, tabId)!;
      return batchLint(m, t.key, t.run, t.b.n)(path);
    },
    // An edit of an input during rewriting or before apply would make apply refuse the run.
    inputOf(path) {
      const key = basename(dirname(path));
      const run = m.runs.get(key);
      if (!run?.run || !['rewriting', 'ready'].includes(run.state)) return null;
      return resolve(path) === resolve(projectDir(m, key), basename(path)) && Object.hasOwn(run.inputs, basename(path)) ? key : null;
    },
  };
}

export function registerWikiMigration(ctx: Ctx, store: Store, sync: WikiSync): GuardMigration {
  const m: Mig = { ctx, store, sync, runs: readAllRuns(ctx.paths) };
  ctx.bus.on('turn-finished', (tabId) => {
    try {
      turnFinished(m, tabId);
    } catch (err) {
      ctx.app.log.error(err);
    }
  });
  type P = { Params: { project: string } };
  ctx.app.post<P>('/api/memory/wiki/:project/prepare', async (req) => prepare(m, req.params.project));
  ctx.app.get<P>('/api/memory/wiki/:project', async (req) => viewOf(req.params.project, m.runs.get(req.params.project)));
  ctx.app.post<P>('/api/memory/wiki/:project/verify', async (req) => verifyRun(m, req.params.project));
  ctx.app.post<P & { Body: { connect?: unknown } }>('/api/memory/wiki/:project/apply', async (req) => applyRun(m, req.params.project, req.body?.connect === true));
  ctx.app.post<P>('/api/memory/wiki/:project/undo', async (req) => undoRun(m, req.params.project));
  ctx.app.delete<P>('/api/memory/wiki/:project', async (req) => discard(m, req.params.project));
  return guardOf(m);
}
