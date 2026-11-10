// Stack detectors for kitDetect. Each reads the files of one folder and returns commands that name their source:
// `<file>#<key>` for something written in the project, `PATH:<bin>` for a tool the stack implies. Nothing is invented.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { KitCommand, KitSkipped, KitStack, KitStep, RelatedMode } from '../../shared/projectKit.ts';
import { safely } from '../memory/util.ts';

export type Which = (bin: string) => boolean;
export interface Probe { root: string; dir: string; which: Which }

export interface StackFound {
  stack: KitStack;
  dir: string;
  runner: string | null;
  commands: KitCommand[];
  skipped: KitSkipped[];
  related: RelatedMode;
  formatter: KitCommand | null;
  generated: string[];
  /** How many package managers or runners the lockfiles point at; more than one is an ambiguity. */
  managers: number;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export const inDir = (dir: string, file: string) => (dir === '.' ? file : `${dir}/${file}`);
const has = (p: Probe, file: string) => existsSync(join(p.root, p.dir, file));
const read = (p: Probe, file: string) => safely(() => readFileSync(join(p.root, p.dir, file), 'utf8'), null);

function found(p: Probe, stack: KitStack, runner: string | null): StackFound {
  return { stack, dir: p.dir, runner, commands: [], skipped: [], related: 'none', formatter: null, generated: [], managers: 1 };
}

/** Adds the command when its binary is found, else records the step as skipped with the reason. */
function need(f: StackFound, which: Which, bin: string, cmd: Omit<KitCommand, 'cwd'>): void {
  const full: KitCommand = { step: cmd.step, run: cmd.run, cwd: f.dir, from: cmd.from };
  if (!which(bin)) f.skipped.push({ step: cmd.step, skipped: `${bin} not found` });
  else if (cmd.step === 'format') f.formatter = full;
  else f.commands.push(full);
}

// npm comes last: a stray package-lock.json from a one-off `npm install` is the usual cause of two lockfiles.
const LOCKFILES = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']] as const;
export const EXEC: Record<string, string> = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx' };
const SCRIPTS: [string, KitStep][] = [['typecheck', 'typecheck'], ['lint', 'lint'], ['test:unit', 'test'], ['test', 'test'], ['build', 'build'], ['e2e', 'e2e']];
const PRETTIER = ['.prettierrc', '.prettierrc.json', '.prettierrc.yaml', '.prettierrc.yml', '.prettierrc.toml', '.prettierrc.js', '.prettierrc.cjs', '.prettierrc.mjs', 'prettier.config.js', 'prettier.config.cjs', 'prettier.config.mjs', 'prettier.config.ts'];
const BIOME = ['biome.json', 'biome.jsonc'];

function managers(p: Probe, pkg: Obj): string[] {
  const locked = [...new Set(LOCKFILES.filter(([file]) => has(p, file)).map(([, pm]) => pm))];
  if (locked.length) return locked;
  const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : '';
  return [declared in EXEC ? declared : 'npm'];
}

function depField(pkg: Obj, name: string): string | null {
  return ['devDependencies', 'dependencies'].find((field) => isObj(pkg[field]) && name in pkg[field]) ?? null;
}

function tsRelated(pkg: Obj, scripts: Obj): RelatedMode {
  if (depField(pkg, 'vitest')) return 'vitest';
  if (depField(pkg, 'jest')) return 'jest';
  return typeof scripts.test === 'string' && scripts.test.includes('node --test') ? 'node-test' : 'none';
}

/** Prettier or Biome, only when the project configures one and declares it as a dependency. */
function tsFormatter(p: Probe, f: StackFound, pkg: Obj): void {
  const tools: [boolean, string, string][] = [
    [PRETTIER.some((c) => has(p, c)) || 'prettier' in pkg, 'prettier', 'prettier --write'],
    [BIOME.some((c) => has(p, c)), '@biomejs/biome', 'biome format --write'],
  ];
  const pm = f.runner ?? 'npm';
  for (const [configured, dep, args] of tools) {
    if (!configured) continue;
    const field = depField(pkg, dep);
    if (!field) f.skipped.push({ step: 'format', skipped: `${dep} not found` });
    else return need(f, p.which, pm, { step: 'format', run: `${EXEC[pm]} ${args}`, from: `${inDir(p.dir, 'package.json')}#${field}.${dep}` });
  }
}

export function detectTs(p: Probe): StackFound | null {
  const pkg = safely<unknown>(() => JSON.parse(read(p, 'package.json') ?? ''), null);
  if (!isObj(pkg)) return null;
  const pms = managers(p, pkg);
  const pm = pms[0];
  const f = found(p, 'ts', pm);
  f.managers = pms.length;
  const file = inDir(p.dir, 'package.json');
  const scripts = isObj(pkg.scripts) ? pkg.scripts : {};
  const taken = new Set<KitStep>();
  for (const [name, step] of SCRIPTS) {
    if (typeof scripts[name] !== 'string' || taken.has(step)) continue;
    taken.add(step);
    need(f, p.which, pm, { step, run: `${pm} run ${name}`, from: `${file}#scripts.${name}` });
  }
  const ts = depField(pkg, 'typescript');
  if (ts && !taken.has('typecheck')) need(f, p.which, pm, { step: 'typecheck', run: `${EXEC[pm]} tsc --noEmit`, from: `${file}#${ts}.typescript` });
  f.related = tsRelated(pkg, scripts);
  tsFormatter(p, f, pkg);
  f.generated = [inDir(p.dir, 'node_modules/'), inDir(p.dir, 'dist/')];
  return f;
}

/** Table names in a TOML file, `[a.b]` and `[[a.b]]` alike. */
export function tomlTables(text: string): Set<string> {
  return new Set([...text.matchAll(/^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/gm)].map((m) => m[1].replace(/["']/g, '')));
}

/** Package names listed in a requirements file, lowercased; options and comments are ignored. */
export function requirementNames(text: string): Set<string> {
  return new Set(text.split('\n').flatMap((line) => /^\s*([A-Za-z0-9][\w.-]*)/.exec(line)?.[1].toLowerCase() ?? []));
}

const PY_TOOLS: [string, KitStep, string][] = [['mypy', 'typecheck', 'mypy .'], ['pyright', 'typecheck', 'pyright'], ['ruff', 'lint', 'ruff check'], ['pytest', 'test', 'pytest']];
const PY_RUNNERS = [['uv.lock', 'uv'], ['poetry.lock', 'poetry']] as const;
const hasTool = (tables: Set<string>, tool: string) => [...tables].some((t) => t === `tool.${tool}` || t.startsWith(`tool.${tool}.`));

type Requirement = { file: string; text: string; names: Set<string> };

function requirements(p: Probe): Requirement[] {
  const files = safely(() => readdirSync(join(p.root, p.dir)), [] as string[]).filter((n) => /^requirements.*\.txt$/.test(n)).sort();
  return files.map((n) => {
    const text = read(p, n) ?? '';
    return { file: inDir(p.dir, n), text, names: requirementNames(text) };
  });
}

/** A Python tool counts when pyproject.toml has its `[tool.*]` table or a requirements file lists it. */
function pySource(p: Probe, tables: Set<string>, reqs: Requirement[], tool: string): string | null {
  if (hasTool(tables, tool)) return `${inDir(p.dir, 'pyproject.toml')}#tool.${tool}`;
  const listed = reqs.find((r) => r.names.has(tool));
  return listed ? `${listed.file}#${tool}` : null;
}

function pyTools(p: Probe, f: StackFound, tables: Set<string>, reqs: Requirement[]): void {
  const prefix = f.runner ? `${f.runner} run ` : '';
  const taken = new Set<KitStep>();
  for (const [tool, step, args] of PY_TOOLS) {
    const from = pySource(p, tables, reqs, tool);
    if (!from || taken.has(step)) continue;
    taken.add(step);
    need(f, p.which, f.runner ?? tool, { step, run: prefix + args, from });
  }
  if (hasTool(tables, 'ruff')) need(f, p.which, f.runner ?? 'ruff', { step: 'format', run: `${prefix}ruff format`, from: `${inDir(p.dir, 'pyproject.toml')}#tool.ruff` });
}

export function detectPython(p: Probe): StackFound | null {
  const pyproject = read(p, 'pyproject.toml');
  const reqs = requirements(p);
  if (pyproject === null && !reqs.length && !has(p, 'setup.cfg')) return null;
  const runners = PY_RUNNERS.filter(([lock]) => has(p, lock)).map(([, runner]) => runner);
  const f = found(p, 'python', runners[0] ?? null);
  f.managers = runners.length;
  pyTools(p, f, tomlTables(pyproject ?? ''), reqs);
  const testmon = /pytest-testmon/.test((pyproject ?? '') + reqs.map((r) => r.text).join('\n'));
  const testable = f.commands.some((c) => c.step === 'test');
  f.related = !testable ? 'none' : testmon ? 'testmon' : 'pytest-name';
  f.generated = [inDir(p.dir, '__pycache__/')];
  return f;
}

const GOLANGCI = ['.golangci.yml', '.golangci.yaml', '.golangci.toml', '.golangci.json'];

export function detectGo(p: Probe): StackFound | null {
  if (!has(p, 'go.mod')) return null;
  const f = found(p, 'go', null);
  need(f, p.which, 'go', { step: 'typecheck', run: 'go vet ./...', from: 'PATH:go' });
  if (GOLANGCI.some((c) => has(p, c))) need(f, p.which, 'golangci-lint', { step: 'lint', run: 'golangci-lint run', from: 'PATH:golangci-lint' });
  need(f, p.which, 'go', { step: 'test', run: 'go test ./...', from: 'PATH:go' });
  need(f, p.which, 'gofmt', { step: 'format', run: 'gofmt -w', from: 'PATH:gofmt' });
  f.related = 'go';
  return f;
}

export function detectRust(p: Probe): StackFound | null {
  if (!has(p, 'Cargo.toml')) return null;
  const f = found(p, 'rust', null);
  need(f, p.which, 'cargo', { step: 'typecheck', run: 'cargo check', from: 'PATH:cargo' });
  need(f, p.which, 'cargo-clippy', { step: 'lint', run: 'cargo clippy -- -D warnings', from: 'PATH:cargo-clippy' });
  need(f, p.which, 'cargo', { step: 'test', run: 'cargo test', from: 'PATH:cargo' });
  if (has(p, 'rustfmt.toml') || has(p, '.rustfmt.toml')) need(f, p.which, 'rustfmt', { step: 'format', run: 'rustfmt', from: 'PATH:rustfmt' });
  // Crate-wide tests are too slow for an edit, so they wait for the Stop gate.
  f.related = 'stop';
  f.generated = [inDir(p.dir, 'target/')];
  return f;
}

const TARGET_FILES = [['Makefile', 'make'], ['justfile', 'just'], ['Taskfile.yml', 'task']] as const;
// `check` stands for typecheck only when there is no `typecheck` target; the first match per step wins.
const TARGETS: [string, KitStep][] = [['typecheck', 'typecheck'], ['check', 'typecheck'], ['lint', 'lint'], ['test', 'test'], ['build', 'build']];

/** Target names in a Makefile, justfile or Taskfile.yml. */
export function targetNames(file: string, text: string): Set<string> {
  const pattern = file === 'Taskfile.yml' ? /^ {2}([\w:-]+):/gm
    : file === 'justfile' ? /^@?([A-Za-z_][\w-]*)[^:=\n]*:(?!=)/gm
    : /^([\w.-]+(?:[ \t]+[\w.-]+)*)[ \t]*:(?!=)/gm;
  return new Set([...text.matchAll(pattern)].flatMap((m) => m[1].split(/\s+/)));
}

/** The task runner file of a folder and the commands its named targets give; the first file found wins. */
export function makeTargets(root: string, dir: string): { bin: string; commands: KitCommand[] } | null {
  for (const [file, bin] of TARGET_FILES) {
    const text = safely(() => readFileSync(join(root, dir, file), 'utf8'), null);
    if (text === null) continue;
    const names = targetNames(file, text);
    const commands: KitCommand[] = [];
    for (const [name, step] of TARGETS) {
      if (names.has(name) && !commands.some((c) => c.step === step)) commands.push({ step, run: `${bin} ${name}`, cwd: dir, from: `${inDir(dir, file)}#${name}` });
    }
    return { bin, commands };
  }
  return null;
}
