// Project kit stack detection: reads a project's files and returns its stacks and commands, each naming its source.
// It runs no project code; the only process it starts is `git log`, to count recent authors.
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { KIT_STEPS, type KitAmbiguity, type KitCommand, type KitDetection, type KitSkipped } from '../../shared/projectKit.ts';
import { safely } from '../memory/util.ts';
import { detectGo, detectPython, detectRust, detectTs, makeTargets, type StackFound, type Which } from './kitDetectStacks.ts';

const DETECTORS = [detectTs, detectPython, detectGo, detectRust];
// Folders that never hold a stack of their own: dependencies and build output.
const NOT_STACKS = new Set(['node_modules', 'dist', 'build', 'target', 'vendor', '__pycache__']);
const INSTRUCTIONS_BEFORE = ['CLAUDE.md', 'AGENTS.md', '.cursorrules'];
const INSTRUCTIONS_AFTER = ['.github/copilot-instructions.md', 'CLAUDE.local.md'];
// A published docs site owns `docs/`, so the kit's own docs go elsewhere.
const SITE_MARKERS = ['mkdocs.yml', 'mkdocs.yaml', 'docusaurus.config.js', 'docusaurus.config.ts', 'docusaurus.config.mjs', 'docusaurus.config.cjs', '.vitepress', 'docs/.vitepress'];

/** Whether a program is on PATH, the way plugin dependencies are checked. */
export function onPath(bin: string): boolean {
  const names = process.platform === 'win32' ? [`${bin}.exe`, `${bin}.cmd`, bin] : [bin];
  return (process.env.PATH ?? '').split(delimiter).some((p) => p && names.some((n) => existsSync(join(p, n))));
}

/** The root and its first-level folders, which is where a monorepo keeps its parts. */
function stackDirs(root: string): string[] {
  const entries = safely(() => readdirSync(root, { withFileTypes: true }), []);
  const subs = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && !NOT_STACKS.has(e.name)).map((e) => e.name);
  return ['.', ...subs.sort()];
}

interface Unit { stacks: StackFound[]; commands: KitCommand[]; skipped: KitSkipped[] }

/** Make, just or task targets replace the inferred command for the same step when their tool is found. */
function applyTargets(unit: Unit, targets: { bin: string; commands: KitCommand[] }, which: Which): void {
  for (const t of targets.commands) {
    if (which(targets.bin)) {
      unit.commands = [...unit.commands.filter((c) => c.step !== t.step), t];
      unit.skipped = unit.skipped.filter((s) => s.step !== t.step);
    } else if (!unit.commands.some((c) => c.step === t.step) && !unit.skipped.some((s) => s.step === t.step)) {
      unit.skipped.push({ step: t.step, skipped: `${targets.bin} not found` });
    }
  }
}

function unitOf(root: string, dir: string, which: Which): Unit | null {
  const stacks = DETECTORS.flatMap((detect) => detect({ root, dir, which }) ?? []);
  const targets = makeTargets(root, dir);
  if (!stacks.length && !(dir === '.' && targets)) return null;
  const unit: Unit = { stacks, commands: stacks.flatMap((s) => s.commands), skipped: stacks.flatMap((s) => s.skipped) };
  if (targets) applyTargets(unit, targets, which);
  unit.commands.sort((a, b) => KIT_STEPS.indexOf(a.step) - KIT_STEPS.indexOf(b.step));
  return unit;
}

function inGit(root: string): boolean {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return true;
    if (dirname(dir) === dir) return false;
  }
}

function authors(root: string): number {
  const run = () => execFileSync('git', ['log', '--since=90.days', '--format=%ae'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
  return new Set(safely(run, '').split('\n').filter(Boolean)).size;
}

function ambiguities(root: string, stacks: StackFound[], git: boolean): KitAmbiguity[] {
  const out: KitAmbiguity[] = [];
  if (stacks.some((s) => s.managers > 1)) out.push('package-managers');
  if (new Set(stacks.map((s) => s.dir)).size > 1) out.push('monorepo');
  if (git && authors(root) > 1) out.push('authors');
  return out;
}

/** Instruction files of other tools and earlier setups, in the order a migration reads them (spec section 4). */
export function migrationSources(root: string): string[] {
  const mdc = safely(() => readdirSync(join(root, '.cursor', 'rules')), [] as string[]).filter((n) => n.endsWith('.mdc')).sort();
  const found = (files: string[]) => files.filter((f) => existsSync(join(root, f)));
  return [...found(INSTRUCTIONS_BEFORE), ...mdc.map((n) => `.cursor/rules/${n}`), ...found(INSTRUCTIONS_AFTER)];
}

const unique = (skipped: KitSkipped[]) => skipped.filter((s, i) => skipped.findIndex((o) => o.step === s.step && o.skipped === s.skipped) === i);

/** Stacks, commands and open questions for a project; every path in the result is relative to `root`. */
export function kitDetect(root: string, which: Which = onPath): KitDetection {
  const units = stackDirs(root).flatMap((dir) => unitOf(root, dir, which) ?? []);
  const stacks = units.flatMap((u) => u.stacks);
  const git = inGit(root);
  return {
    stacks: stacks.map(({ stack, dir, runner }) => ({ stack, dir, runner })),
    commands: units.flatMap((u) => u.commands),
    skipped: unique(units.flatMap((u) => u.skipped)),
    related: stacks.map((s) => ({ dir: s.dir, mode: s.related })),
    formatter: stacks.find((s) => s.formatter)?.formatter ?? null,
    docsDir: SITE_MARKERS.some((m) => existsSync(join(root, m))) ? 'dev-docs' : 'docs',
    generated: stacks.flatMap((s) => s.generated),
    instructions: migrationSources(root),
    ambiguities: ambiguities(root, stacks, git),
    git,
  };
}
