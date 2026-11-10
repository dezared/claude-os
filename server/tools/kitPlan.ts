// Project kit plans: what installing, updating or removing the kit would do to one project, file by file.
// Nothing is written here. The plan carries the hash of every target, so an apply after a change on disk is refused.
import { randomUUID } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { QuestionLevel } from '../../shared/contract.ts';
import type { KitAnswers, KitCommand, KitDetection, KitFileAction, KitLock, KitLockEntry, KitOwner, KitPlan, KitPlanFile } from '../../shared/projectKit.ts';
import { httpError, safely, sha256, unifiedDiff } from '../memory/util.ts';
import { kitDetect, onPath } from './kitDetect.ts';
import { EXEC, type Which } from './kitDetectStacks.ts';
import { decideFile, readSnapshot, type KitDecision } from './kitMerge.ts';
import { renderKit, type KitRender } from './kitRender.ts';
import { kitSettings, mergeGitignore, mergeSettings, unmergeGitignore, unmergeSettings } from './kitSettings.ts';
import { treeHash } from './osPluginManifest.ts';

export const LOCK = '.claude/kit/lock.json';
const GATE = 'node .claude/kit/gate.mjs';
const CLAUDE_MD = 'CLAUDE.md';
const MAX_LINES = 60;
const AGENTS_NOTE = 'AGENTS.md is over 60 lines: its facts were merged and the import dropped';

export interface PlanInput {
  root: string;
  project: string;
  kit: { dir: string; version: string };
  data: string;
  action: 'install' | 'remove';
  answers: KitAnswers;
  claudeMd?: string;
  rules?: Record<string, string>;
  level: QuestionLevel | null;
  /** Tool lookup; tests stub it so plans do not depend on the machine. */
  which?: Which;
}

/** `writes`: path to new content, null to delete. `renders`: the kit renders the lock points at, kept as merge bases. */
export interface PlanResult { plan: KitPlan; hashes: Record<string, string | null>; writes: Map<string, string | null>; renders: Map<string, string> }

export const readText = (root: string, path: string) => safely(() => readFileSync(join(root, path), 'utf8'), null);

export function readLock(root: string): KitLock | null {
  const text = readText(root, LOCK);
  const lock = text === null ? null : safely(() => JSON.parse(text) as KitLock, null);
  return lock && typeof lock.files === 'object' && lock.settings ? lock : null;
}

/** The answered package manager takes the place of the detected one in every TS folder, before anything is rendered. */
export function withPackageManager(d: KitDetection, pm: string, which: Which): KitDetection {
  const was = new Map(d.stacks.flatMap((s) => (s.stack === 'ts' && s.runner ? [[s.dir, s.runner] as const] : [])));
  const swap = (c: KitCommand): KitCommand => {
    const old = was.get(c.cwd) ?? '';
    const prefixes = [[`${old} run `, `${pm} run `], [`${EXEC[old]} `, `${EXEC[pm]} `]];
    const hit = old ? prefixes.find(([from]) => c.run.startsWith(from)) : undefined;
    return hit ? { ...c, run: hit[1] + c.run.slice(hit[0].length) } : c;
  };
  const all = [...d.commands, ...(d.formatter ? [d.formatter] : [])];
  // A command the swap touched needs the answered manager on this machine, like any detected command.
  const lost = which(pm) ? [] : all.filter((c) => swap(c) !== c);
  const keep = (c: KitCommand) => (lost.includes(c) ? [] : [swap(c)]);
  return {
    ...d,
    stacks: d.stacks.map((s) => (s.stack === 'ts' && was.has(s.dir) ? { ...s, runner: pm } : s)),
    commands: d.commands.flatMap(keep),
    skipped: [...d.skipped, ...lost.map((c) => ({ step: c.step, skipped: `${pm} not found` }))],
    formatter: d.formatter ? (keep(d.formatter)[0] ?? null) : null,
    ambiguities: d.ambiguities.filter((a) => a !== 'package-managers'),
  };
}

function detect(root: string, pm: string | undefined, which: Which): KitDetection {
  if (pm === undefined) return kitDetect(root, which);
  if (!Object.hasOwn(EXEC, pm)) throw httpError(400, `answers.packageManager must be one of ${Object.keys(EXEC).join(', ')}`);
  // Detected as if every package manager were installed, so the swapped commands exist; the swap checks the answered one.
  return withPackageManager(kitDetect(root, (bin) => Object.hasOwn(EXEC, bin) || which(bin)), pm, which);
}

/** What the kit flow may ask at this level; a question already answered is not asked again. */
export function askFor(level: QuestionLevel | null, d: KitDetection, answers: KitAnswers = {}): string[] {
  if (level !== 'balanced' && level !== 'thorough') return [];
  const lines: Record<KitDetection['ambiguities'][number], string | null> = {
    'package-managers': answers.packageManager ? null : 'Lockfiles of more than one package manager were found: which package manager runs the commands? Set answers.packageManager (npm, pnpm, yarn or bun).',
    // The split has no answer of its own: the round that sends any answer settles it.
    monorepo: Object.keys(answers).length ? null : `Several stacks: ${d.stacks.map((s) => `${s.dir} (${s.stack})`).join(', ')}; the gate runs each one's commands in its folder. Is this split right?`,
    authors: answers.scope ? null : 'More than one git author in 90 days: put the kit\'s hooks in the shared .claude/settings.json (answers.scope "project") or only on this machine in .claude/settings.local.json ("local")?',
  };
  const out = d.ambiguities.flatMap((a) => lines[a] ?? []);
  return level === 'thorough' ? [...out, ...thoroughLines(d, answers)] : out;
}

function thoroughLines(d: KitDetection, answers: KitAnswers): string[] {
  const out: string[] = [];
  if (!answers.limits) out.push('Size limits: strict 300/50/10 or relaxed 400/80/15 (file lines, function lines, complexity)? Set answers.limits.');
  if (!answers.protected) out.push(`Protected paths beyond ${d.generated.join(', ') || 'the generated folders'}? Set answers.protected to a list of globs.`);
  return out;
}

const lineCount = (text: string) => text.replace(/\n$/, '').split('\n').length;

function commandsSection(text: string): string[] {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => /^#{1,6}\s+commands\s*$/i.test(l));
  if (start < 0) return [];
  const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

// What a source file states as a command: a code span, or a whole line (a fenced block line, a list item, a `$ ` prompt).
function sourceCommands(text: string): string[] {
  const spans = [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1].trim());
  const lines = text.split('\n').map((l) => l.trim().replace(/^(?:[-*>]\s+|\d+\.\s+|\$\s+)/, ''));
  return [...spans, ...lines].filter(Boolean);
}

/** The server's check of a drafted CLAUDE.md: the line limit, and no command in Commands that the project does not have. */
export function validateClaudeMd(draft: string, d: KitDetection, sources: string[]): string | null {
  const n = lineCount(draft);
  if (n > MAX_LINES) return `CLAUDE.md has ${n} lines; the limit is ${MAX_LINES}`;
  const known = new Set([...d.commands.map((c) => c.run), ...(d.formatter ? [d.formatter.run] : []), GATE, ...sources.flatMap(sourceCommands)]);
  const real = (span: string) => known.has(span.trim());
  const bad = commandsSection(draft).find((line) => [...line.matchAll(/`([^`]+)`/g)].some((m) => !real(m[1])));
  return bad === undefined ? null : `not a detected command: ${bad}`;
}

interface Acc { root: string; files: KitPlanFile[]; writes: Map<string, string | null>; lock: Record<string, KitLockEntry>; renders: Map<string, string> }
// `write` undefined: listed only; null: deleted.
interface Entry { path: string; owner: KitOwner; action: KitFileAction; reason?: string | null; disk: string | null; write?: string | null }

/** The first part of `path` under `root` that is a symlink: the kit never writes through one, it may lead out of the project. */
export function symlinkIn(root: string, path: string): string | null {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const rel = parts.slice(0, i).join('/');
    if (safely(() => lstatSync(join(root, rel)).isSymbolicLink(), false)) return rel;
  }
  return null;
}

// A write through a symlink becomes a skip, and the lock keeps what it had for that path.
function linked(acc: Acc, path: string, owner: KitOwner, prev: KitLockEntry | null = null): boolean {
  const link = symlinkIn(acc.root, path);
  if (!link) return false;
  if (prev) acc.lock[path] = prev;
  acc.files.push({ path, owner, action: 'skip', reason: `${link} is a symlink`, diff: '' });
  return true;
}

function push(acc: Acc, e: Entry): void {
  if (e.write !== undefined && linked(acc, e.path, e.owner)) return;
  const diff = e.write === undefined ? '' : unifiedDiff(e.disk ?? '', e.write ?? '', e.path);
  acc.files.push({ path: e.path, owner: e.owner, action: e.action, reason: e.reason ?? null, diff });
  if (e.write !== undefined) acc.writes.set(e.path, e.write);
}

interface Known { lock: KitLock | null; data: string }

// Kept, skipped and conflicting files keep their entry; a write records what was written and the render behind it.
function lockEntry(prev: KitLockEntry | null, d: KitDecision | null, r: { owner: 'kit' | 'seed'; content: string }): KitLockEntry | null {
  if (d === null || d.action === 'skip' || d.action === 'needs-merge') return prev;
  return d.content === null ? null : { wrote: sha256(d.content), render: sha256(r.content), owner: r.owner };
}

// The next version merges against the render the lock names, so it is stored under this version too.
function snapshotOf(d: KitDecision | null, base: string | null, render: string): string | null {
  if (d?.action === 'skip') return null;
  return d?.action === 'needs-merge' ? base : render;
}

function baseOf(k: Known, prev: KitLockEntry | null): string | null {
  return prev && k.lock ? readSnapshot(k.data, k.lock.kit, prev.render) : null;
}

// The lock entry and the merge base an apply records for one rendered file.
// Only kit files have a snapshot: seeds are never merged.
function record(acc: Acc, path: string, entry: KitLockEntry | null, snapshot: string | null): void {
  if (entry) acc.lock[path] = entry;
  if (entry && snapshot !== null) acc.renders.set(path, snapshot);
}

function planRendered(acc: Acc, path: string, r: { owner: 'kit' | 'seed'; content: string }, k: Known): void {
  const prev = k.lock?.files[path] ?? null;
  if (linked(acc, path, r.owner, prev)) return;
  const disk = readText(acc.root, path);
  const base = r.owner === 'kit' ? baseOf(k, prev) : null;
  const d = decideFile({ owner: r.owner, lock: prev, disk, render: r.content, base });
  record(acc, path, lockEntry(prev, d, r), r.owner === 'kit' ? snapshotOf(d, base, r.content) : null);
  if (d) push(acc, { path, owner: r.owner, action: d.action, reason: d.reason, disk, write: d.content ?? undefined });
}

function claudeMdDraft(root: string, draft: string, d: KitDetection): { text: string; reason: string | null } {
  const agents = readText(root, 'AGENTS.md');
  const long = agents !== null && lineCount(agents) > MAX_LINES;
  const text = long ? draft.replace(/^@AGENTS\.md[ \t]*\n(?:[ \t]*\n)?/m, '') : draft;
  const problem = validateClaudeMd(text, d, d.instructions.map((p) => readText(root, p) ?? ''));
  if (problem) throw httpError(422, problem);
  return { text, reason: long ? AGENTS_NOTE : null };
}

interface Inputs { o: PlanInput; d: KitDetection; lock: KitLock | null; render: KitRender }

// Existing instructions make CLAUDE.md a migration that Claude drafts; without the draft the entry only says so.
function planClaudeMd(acc: Acc, p: Inputs, k: Known): void {
  if (linked(acc, CLAUDE_MD, 'seed', p.lock?.files[CLAUDE_MD])) return;
  const migrate = !p.lock?.files[CLAUDE_MD] && p.d.instructions.length > 0;
  const disk = readText(acc.root, CLAUDE_MD);
  const template = p.render.get(CLAUDE_MD);
  if (p.o.claudeMd === undefined) {
    if (migrate) push(acc, { path: CLAUDE_MD, owner: 'seed', action: 'migrate', reason: `draft it from ${p.d.instructions.join(', ')} and call kit_plan again with claudeMd`, disk });
    else if (template) planRendered(acc, CLAUDE_MD, template, k);
    return;
  }
  const draft = claudeMdDraft(acc.root, p.o.claudeMd, p.d);
  if (!migrate) return planRendered(acc, CLAUDE_MD, { owner: 'seed', content: draft.text }, k);
  acc.lock[CLAUDE_MD] = { wrote: sha256(draft.text), render: sha256(draft.text), owner: 'seed' };
  push(acc, { path: CLAUDE_MD, owner: 'seed', action: 'migrate', reason: draft.reason, disk, write: draft.text });
}

// Migrated rules and personal lines: written once if absent, never tracked by the lock.
function planRules(acc: Acc, rules: Record<string, string>, docsDir: string, render: KitRender): void {
  const target = new RegExp(`^(\\.claude|${docsDir})/rules/[\\w-]+\\.md$`);
  for (const [path, text] of Object.entries(rules)) {
    if (!(target.test(path) || path === 'CLAUDE.local.md') || render.has(path)) {
      throw httpError(422, `rules: ${path} is not a migration target; use .claude/rules/<name>.md, ${docsDir}/rules/<name>.md or CLAUDE.local.md`);
    }
    const disk = readText(acc.root, path);
    if (disk === null) push(acc, { path, owner: 'seed', action: 'add', disk, write: text });
    else push(acc, { path, owner: 'seed', action: 'keep', reason: 'exists', disk });
  }
}

// Seeds are the user's once written; a lock from before entries had an owner takes it from the current render.
const isSeed = (path: string, prev: KitLockEntry, render: KitRender) => (prev.owner ?? render.get(path)?.owner) === 'seed';

// Files the previous version wrote that this one no longer has: gone when untouched, kept when edited; seeds always stay.
function planDropped(acc: Acc, lock: KitLock | null, render: KitRender): void {
  for (const [path, prev] of Object.entries(lock?.files ?? {})) {
    const disk = render.has(path) || isSeed(path, prev, render) ? null : readText(acc.root, path);
    if (disk === null) continue;
    if (sha256(disk) === prev.wrote) push(acc, { path, owner: 'kit', action: 'remove', reason: 'no longer part of the kit', disk, write: null });
    else push(acc, { path, owner: 'kit', action: 'keep', reason: 'edited, and no longer part of the kit', disk });
  }
}

function planChanged(acc: Acc, path: string, next: string | null): void {
  const disk = readText(acc.root, path);
  if (next === disk) return;
  const action = next === null ? 'remove' : disk === null ? 'add' : 'update';
  push(acc, { path, owner: path === LOCK ? 'kit' : 'merged', action, disk, write: next });
}

function planUnmerge(acc: Acc, added: KitLock['settings']): void {
  const disk = readText(acc.root, added.file);
  if (disk === null) return;
  const next = unmergeSettings(disk, added);
  planChanged(acc, added.file, next.trim() === '{}' ? null : next);
}

export const noSettings = (file: string): KitLock['settings'] => ({ file, allow: [], deny: [], ask: [], hooks: [] });

function planSettings(acc: Acc, d: KitDetection, answers: KitAnswers, lock: KitLock | null): KitLock['settings'] {
  const kit = kitSettings(d, answers);
  const prev = lock?.settings.file === kit.file ? lock.settings : null;
  // A changed scope moves the kit's entries: out of the old file, into the new one.
  if (lock && !prev) planUnmerge(acc, lock.settings);
  if (linked(acc, kit.file, 'merged')) return prev ?? noSettings(kit.file);
  const disk = readText(acc.root, kit.file);
  const merged = mergeSettings(disk, kit, prev);
  if ('invalid' in merged) {
    push(acc, { path: kit.file, owner: 'merged', action: 'skip', reason: merged.invalid, disk });
    return prev ?? noSettings(kit.file);
  }
  planChanged(acc, kit.file, merged.content);
  return merged.added;
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function planInstall(acc: Acc, p: Inputs): void {
  const k: Known = { lock: p.lock, data: p.o.data };
  planClaudeMd(acc, p, k);
  for (const [path, r] of p.render) if (path !== CLAUDE_MD) planRendered(acc, path, r, k);
  planRules(acc, p.o.rules ?? {}, p.d.docsDir, p.render);
  planDropped(acc, p.lock, p.render);
  planChanged(acc, '.gitignore', mergeGitignore(readText(acc.root, '.gitignore'), p.d.docsDir));
  const settings = planSettings(acc, p.d, p.o.answers, p.lock);
  const baseline = Object.keys(safely(() => JSON.parse(p.render.get('.claude/kit/size-baseline.json')?.content ?? '{}') as object, {})).length;
  const files = Object.fromEntries(Object.entries(acc.lock).sort(([a], [b]) => (a < b ? -1 : 1)));
  const lock: KitLock = { kit: p.o.kit.version, installedAt: p.lock?.installedAt ?? Date.now(), sizeAtInstall: p.lock?.sizeAtInstall ?? baseline, files, settings };
  planChanged(acc, LOCK, json(lock));
}

// Remove takes kit files the user did not edit and the kit's entries in the shared files; seeds stay.
function planRemove(acc: Acc, lock: KitLock | null, render: KitRender): void {
  if (!lock) return;
  for (const [path, prev] of Object.entries(lock.files)) {
    const disk = isSeed(path, prev, render) ? null : readText(acc.root, path);
    if (disk === null) continue;
    if (sha256(disk) === prev.wrote) push(acc, { path, owner: 'kit', action: 'remove', disk, write: null });
    else push(acc, { path, owner: 'kit', action: 'keep', reason: 'edited by the user', disk });
  }
  const gitignore = readText(acc.root, '.gitignore');
  if (gitignore !== null) planChanged(acc, '.gitignore', unmergeGitignore(gitignore) || null);
  planUnmerge(acc, lock.settings);
  planChanged(acc, LOCK, null);
}

function hashesOf(root: string, kitDir: string, paths: string[]): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const path of new Set([...paths, LOCK])) {
    const text = readText(root, path);
    out[path] = text === null ? null : sha256(text);
  }
  // An absolute key is the kit's template folder: a changed kit makes the plan stale too.
  out[kitDir] = treeHash(kitDir);
  return out;
}

/** Detects, renders and decides every file; returns the plan and what an approved apply would write. */
export function planKit(o: PlanInput): PlanResult {
  const d = detect(o.root, o.answers.packageManager, o.which ?? onPath);
  const lock = readLock(o.root);
  const render = renderKit(o.kit, o.root, d, o.answers);
  const acc: Acc = { root: o.root, files: [], writes: new Map(), lock: {}, renders: new Map() };
  const action = o.action === 'remove' ? 'remove' : lock ? 'update' : 'install';
  if (action === 'remove') planRemove(acc, lock, render);
  else planInstall(acc, { o, d, lock, render });
  const plan: KitPlan = {
    planId: randomUUID(),
    project: o.project,
    root: o.root,
    kit: o.kit.version,
    action,
    files: acc.files,
    skipped: d.skipped,
    ask: action === 'remove' ? [] : askFor(o.level, d, o.answers),
    empty: acc.files.every((f) => f.action === 'keep' || f.action === 'skip'),
    approved: false,
  };
  return { plan, hashes: hashesOf(o.root, o.kit.dir, acc.files.map((f) => f.path)), writes: acc.writes, renders: acc.renders };
}
