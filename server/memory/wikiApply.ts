// Preview, apply and undo of a project's wiki migration. Apply is all or nothing: any error puts back every file it
// touched. Undo restores the old notes and the old links, and keeps what was edited since apply.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { WikiPreview, WikiRunView, WikiSize } from '../../shared/contract.ts';
import { noteMeta } from './frontmatter.ts';
import { migrate } from './migrate.ts';
import { noteSummary } from './store.ts';
import { backupFile, httpError, safely, sha256, unifiedDiff } from './util.ts';
import { renderMemoryIndex, type IndexNote } from './wikiIndex.ts';
import { isWikiManaged, setWikiManaged } from './wikiManaged.ts';
import { batchDirOf, batchMap, inputsOf, openRun, outNotes, projectDir, runDirOf, saveRun, viewOf, type AppliedRun, type Mig, type RunFile } from './wikiRun.ts';
import { rewriteLinks, type MapEntry } from './wikiVerify.ts';
import { extractLinks, normalizeName } from './wikilinks.ts';

type LinkChange = { path: string; before: string; after: string };

interface Plan {
  entries: MapEntry[];
  raw: Map<string, { n: number; text: string }>; // new note -> its batch and the text in out/
  notes: Map<string, string>; // new note -> the text apply writes
  links: LinkChange[];
  warnings: string[];
}

const read = (path: string) => safely(() => readFileSync(path, 'utf8'), null);
const stem = (file: string) => file.replace(/\.md$/i, '');
const rel = (m: Mig, path: string) => relative(m.ctx.paths.vault, path);

export function sizeOf(text: string): WikiSize {
  const bytes = Buffer.byteLength(text);
  const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  return { lines, bytes, tokens: Math.ceil(bytes / 4) };
}

function runOutputs(m: Mig, key: string, run: RunFile): Pick<Plan, 'entries' | 'raw'> {
  const entries: MapEntry[] = [];
  const raw: Plan['raw'] = new Map();
  for (const b of run.batches) {
    const dir = batchDirOf(m.ctx.paths, key, run.run!, b.n);
    entries.push(...batchMap(dir).entries);
    for (const [file, text] of outNotes(dir)) raw.set(file, { n: b.n, text });
  }
  return { entries: entries.sort((a, b) => (a.old < b.old ? -1 : a.old > b.old ? 1 : 0)), raw };
}

// Vault notes a link rewrite may touch: every project's flat notes and global/, without the generated MEMORY.md.
function vaultNotes(m: Mig): string[] {
  const projects = join(m.ctx.paths.vault, 'projects');
  const keys = safely(() => readdirSync(projects, { withFileTypes: true }), []).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => e.name);
  return [...keys.flatMap((k) => m.store.listMd(join(projects, k), false)), ...m.store.listMd(join(m.ctx.paths.vault, 'global'), true)]
    .filter((p) => basename(p) !== 'MEMORY.md');
}

// The [[links]] of one note that open an input: old name -> the primary's name; a dropped target is a warning.
type Scope = { inputs: Set<string>; renames: Map<string, string> };

function linkRenames(m: Mig, path: string, text: string, { inputs, renames }: Scope): { own: Map<string, string>; lost: string[] } {
  const own = new Map<string, string>();
  const lost: string[] = [];
  for (const name of extractLinks(text)) {
    const target = m.store.resolveLinkPath(path, name);
    if (!target || !inputs.has(target)) continue;
    const to = renames.get(name);
    if (to) own.set(name, to);
    else lost.push(`${rel(m, path)}: [[${name}]] will open no note: ${basename(target)} is dropped`);
  }
  return { own, lost };
}

// Every vault note outside the inputs whose link opens an input, in any project: it gets the input's primary name.
function linkChanges(m: Mig, key: string, run: RunFile, renames: Map<string, string>): Pick<Plan, 'links' | 'warnings'> {
  m.store.touch();
  const inputs = new Set(Object.keys(run.inputs).map((f) => join(projectDir(m, key), f)));
  const links: LinkChange[] = [];
  const warnings: string[] = [];
  for (const path of vaultNotes(m).filter((p) => !inputs.has(p))) {
    const before = read(path);
    if (before === null) continue;
    const { own, lost } = linkRenames(m, path, before, { inputs, renames });
    warnings.push(...lost);
    const after = rewriteLinks(before, own);
    if (after !== before) links.push({ path, before, after });
  }
  return { links, warnings };
}

function planOf(m: Mig, key: string, run: RunFile): Plan {
  const { entries, raw } = runOutputs(m, key, run);
  const renames = new Map(entries.filter((e) => e.primary).map((e) => [normalizeName(e.old), stem(e.primary!)]));
  // A new note's link to an old name opens its primary too, unless a new note took that name.
  const newNames = new Set([...raw.keys()].map(normalizeName));
  const forNew = new Map([...renames].filter(([old]) => !newNames.has(old)));
  const notes = new Map([...raw].map(([file, { text }]) => [file, rewriteLinks(text, forNew)]));
  return { entries, raw, notes, ...linkChanges(m, key, run, renames) };
}

// The old-place copies of the project's notes (the first source dir wins): file -> sha.
function oldPlaceShas(m: Mig, key: string): Map<string, string> {
  const root = m.store.roots(true).get(key);
  const out = new Map<string, string>();
  for (const dir of root ? m.store.sourceDirsFor(key, root) : []) {
    for (const p of m.store.listMd(dir, false)) if (!out.has(basename(p))) out.set(basename(p), sha256(read(p) ?? ''));
  }
  return out;
}

// An old-place copy that differs from the vault note it was copied to is hidden after apply too: the vault copy won.
function differingOldCopies(m: Mig, key: string, run: RunFile): string[] {
  const old = oldPlaceShas(m, key);
  return Object.entries(run.inputs).filter(([f, sha]) => old.has(f) && old.get(f) !== sha)
    .map(([f]) => `${f}: the old-place copy differs from the vault note; the vault note is migrated and the old copy stays hidden`);
}

function indexNote(file: string, text: string): IndexNote {
  const meta = noteMeta(text);
  return { name: meta.name || stem(file), file, description: meta.description, summary: noteSummary(meta.description ?? undefined, meta.body), type: meta.type, tags: meta.tags, recency: meta.modified ?? 0 };
}

const linkDiffOf = (m: Mig, links: LinkChange[]) => links.map((l) => unifiedDiff(l.before, l.after, rel(m, l.path))).join('\n');

// Notes written to the project after prepare: apply keeps them as they are.
const addedSince = (m: Mig, key: string, run: RunFile) => inputsOf(m, key).filter((f) => !Object.hasOwn(run.inputs, f));

export function buildPreview(m: Mig, key: string, run: RunFile): Pick<RunFile, 'preview' | 'outs'> {
  const plan = planOf(m, key, run);
  const drift = m.store.stats(key).drift;
  const added = addedSince(m, key, run);
  const kept = added.map((f) => [f, read(join(projectDir(m, key), f)) ?? ''] as const);
  const after = renderMemoryIndex(key, [...plan.notes, ...kept].map(([file, text]) => indexNote(file, text)));
  const preview: WikiPreview = {
    files: plan.entries.map((e) => ({ old: e.old, new: e.new, dropped: e.dropped })),
    warnings: [
      ...run.batches.flatMap((b) => b.warnings),
      ...plan.warnings,
      ...differingOldCopies(m, key, run),
      ...added.map((f) => `${f}: added after prepare, kept as is`),
      ...(drift ? [`${drift} notes of ${key} are only in the old place: copy them to the vault and prepare again, or they stay out of the migration`] : []),
    ],
    linkDiff: linkDiffOf(m, plan.links),
    memory: { before: sizeOf(read(join(projectDir(m, key), 'MEMORY.md')) ?? ''), after: sizeOf(after) },
    notesAfter: plan.notes.size + added.length,
  };
  return { preview, outs: Object.fromEntries([...plan.raw].map(([file, { n, text }]) => [file, { n, sha: sha256(text) }])) };
}

// The vault must still be what the preview showed: same inputs, no note in the way of a new one, same outputs.
function refuseChanged(m: Mig, key: string, run: RunFile, plan: Plan): void {
  const dir = projectDir(m, key);
  const shaOf = (path: string) => safely(() => sha256(readFileSync(path, 'utf8')), null);
  const changed = Object.entries(run.inputs).filter(([f, sha]) => shaOf(join(dir, f)) !== sha).map(([f]) => f);
  if (changed.length) throw httpError(409, `notes of ${key} changed since prepare: ${changed.join(', ')}; discard the run and prepare again`);
  const names = new Set([...plan.notes.keys()].map(normalizeName));
  const inTheWay = addedSince(m, key, run).filter((f) => names.has(normalizeName(f)));
  if (inTheWay.length) throw httpError(409, `notes of ${key} added since prepare take the names of new notes: ${inTheWay.join(', ')}; rename or remove them, or discard the run and prepare again`);
  const outs = new Set([...Object.keys(run.outs), ...plan.raw.keys()]);
  const stale = [...outs].filter((f) => run.outs[f]?.sha !== safely(() => sha256(plan.raw.get(f)!.text), null));
  if (stale.length) throw httpError(409, `new notes changed since the preview: ${stale.join(', ')}; verify again`);
}

// What apply touched, to put back on any error: moves (from, to) and files with their text before (null: absent).
interface Txn {
  key: string;
  wasManaged: boolean;
  moved: [string, string][];
  files: Map<string, string | null>;
}

const remember = (t: Txn, path: string) => void (t.files.has(path) || t.files.set(path, read(path)));

function put(t: Txn, path: string, text: string): void {
  remember(t, path);
  writeFileSync(path, text);
}

function rollback(m: Mig, t: Txn): void {
  for (const [path, text] of [...t.files].reverse()) safely(() => (text === null ? rmSync(path) : writeFileSync(path, text)), undefined);
  for (const [from, to] of [...t.moved].reverse()) {
    safely(() => renameSync(to, from), undefined);
    const text = read(from);
    if (text !== null) m.sync.ownWrite(from, text); // back as it was: no watcher line
  }
  setWikiManaged(m.ctx.paths, t.key, t.wasManaged);
  m.store.touch();
}

function moveOld(m: Mig, run: RunFile, t: Txn, old: string): Record<string, string> {
  const dir = projectDir(m, t.key);
  mkdirSync(old, { recursive: true });
  const moved: Record<string, string> = {};
  for (const file of [...Object.keys(run.inputs), ...(existsSync(join(dir, 'MEMORY.md')) ? ['MEMORY.md'] : [])]) {
    moved[file] = sha256(readFileSync(join(dir, file), 'utf8'));
    renameSync(join(dir, file), join(old, file));
    m.sync.forget(join(dir, file));
    t.moved.push([join(dir, file), join(old, file)]);
  }
  return moved;
}

function applySteps(m: Mig, run: RunFile, plan: Plan, t: Txn): AppliedRun {
  const dir = projectDir(m, t.key);
  const old = join(runDirOf(m.ctx.paths, t.key, run.run!), 'old');
  const moved = moveOld(m, run, t, old);
  const links = plan.links.map((l) => {
    const backup = backupFile(m.ctx.paths.data, l.path)!;
    put(t, l.path, l.after);
    m.sync.ownWrite(l.path, l.after);
    return { path: l.path, before: sha256(l.before), after: sha256(l.after), backup };
  });
  mkdirSync(dir, { recursive: true });
  const created: Record<string, string> = {};
  for (const [file, text] of [...plan.notes].sort()) {
    put(t, join(dir, file), text);
    m.sync.ownWrite(join(dir, file), text);
    created[file] = sha256(text);
  }
  setWikiManaged(m.ctx.paths, t.key, true);
  m.store.touch();
  remember(t, join(dir, 'MEMORY.md'));
  remember(t, join(m.ctx.paths.vault, '_index', `${t.key}.md`));
  m.sync.regenerate(t.key);
  return { at: Date.now(), moved, migrated: {}, created, links, movedTo: old, wasManaged: t.wasManaged };
}

export function applyRun(m: Mig, key: string, connect: boolean): WikiRunView {
  const run = openRun(m, key, ['ready'], 'apply');
  const plan = planOf(m, key, run);
  refuseChanged(m, key, run, plan);
  if (connect) m.store.migrationPlan(key); // broken settings refuse before anything moves
  const oldPlace = oldPlaceShas(m, key);
  const t: Txn = { key, wasManaged: isWikiManaged(m.ctx.paths, key), moved: [], files: new Map() };
  const before = structuredClone(run);
  try {
    const applied = applySteps(m, run, plan, t);
    // The old-place copy is what must not come back; without one, the vault note's sha stands in.
    applied.migrated = Object.fromEntries(Object.entries(applied.moved).map(([f, sha]) => [f, oldPlace.get(f) ?? sha]));
    Object.assign(run, { applied, state: 'applied', migrated: { ...run.migrated, ...applied.migrated } });
    saveRun(m, key, run); // before connect: its copy must already skip the migrated originals
    if (connect) migrate(m.ctx, m.store, key);
  } catch (err) {
    rollback(m, t);
    saveRun(m, key, before);
    throw err;
  }
  const summary = `run ${run.run}: ${Object.keys(run.inputs).length} notes -> ${plan.notes.size} notes, links rewritten in ${plan.links.length} notes${connect ? ', terminal sessions connected' : ''}`;
  m.sync.log(key, [{ op: 'migrate', name: key, reason: summary }]);
  m.ctx.audit('memory.wiki', projectDir(m, key), [summary, linkDiffOf(m, plan.links)].filter(Boolean).join('\n'));
  m.store.touch(); // the view skips the migrated originals from now on
  m.ctx.invalidate('memory', 'projects');
  return viewOf(key, run)!;
}

type UndoResult = { restored: string[]; kept: string[]; conflicts: string[] };

// MEMORY.md is the server's: the old one comes back over the generated one. Any other file in the way is a conflict.
function restoreFile(m: Mig, from: string, to: string, out: UndoResult): void {
  const text = read(from);
  if (text === null || (basename(to) !== 'MEMORY.md' && existsSync(to))) return void out.conflicts.push(rel(m, to));
  writeFileSync(to, text);
  m.sync.ownWrite(to, text);
  out.restored.push(basename(to));
}

function revertLink(m: Mig, l: AppliedRun['links'][number], out: UndoResult): void {
  const now = read(l.path);
  const before = read(l.backup);
  if (now === null || before === null || sha256(now) !== l.after) return void out.conflicts.push(rel(m, l.path));
  writeFileSync(l.path, before);
  m.sync.ownWrite(l.path, before);
  out.restored.push(rel(m, l.path));
}

function undoFiles(m: Mig, key: string, a: AppliedRun): UndoResult {
  const dir = projectDir(m, key);
  const out: UndoResult = { restored: [], kept: [], conflicts: [] };
  for (const [file, sha] of Object.entries(a.created)) {
    const text = read(join(dir, file));
    if (text !== null && sha256(text) === sha) rmSync(join(dir, file));
    else if (text !== null) out.kept.push(file);
  }
  for (const file of Object.keys(a.moved)) restoreFile(m, join(a.movedTo, file), join(dir, file), out);
  for (const l of a.links) revertLink(m, l, out);
  if (!a.wasManaged) {
    if (!a.moved['MEMORY.md']) rmSync(join(dir, 'MEMORY.md'), { force: true });
    rmSync(join(m.ctx.paths.vault, '_index', `${key}.md`), { force: true });
  }
  return out;
}

export function undoRun(m: Mig, key: string): UndoResult {
  const run = openRun(m, key, ['applied'], 'undo');
  const a = run.applied!;
  const out = undoFiles(m, key, a);
  setWikiManaged(m.ctx.paths, key, a.wasManaged);
  m.store.touch();
  m.sync.regenerate(key);
  run.migrated = Object.fromEntries(Object.entries(run.migrated).filter(([f, sha]) => a.migrated[f] !== sha));
  run.state = 'undone';
  const summary = `undo run ${run.run}: restored ${out.restored.length}, kept ${out.kept.join(', ') || 'none'}, conflicts ${out.conflicts.join(', ') || 'none'}`;
  m.sync.log(key, [{ op: 'migrate', name: key, reason: summary }]);
  m.ctx.audit('memory.wiki', projectDir(m, key), summary);
  saveRun(m, key, run);
  m.store.touch(); // the view skips the migrated originals from now on
  m.ctx.invalidate('memory', 'projects');
  return out;
}
