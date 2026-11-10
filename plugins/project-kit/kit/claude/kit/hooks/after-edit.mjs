// PostToolUse Edit|Write: formats the edited file, lints it and runs its related tests within the edit budget; prints failures only.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// Kit modules load at run time, so a missing one is one warning line and exit 0 (fail-open), not a crash.
async function load(hook, specs) {
  try {
    return await Promise.all(specs.map((spec) => import(spec)));
  } catch (error) {
    console.log(`kit ${hook}: ${String(error?.message ?? error).replace(/\s*\n\s*/g, ' ')}`);
    return specs.map(() => ({ invoked: () => false }));
  }
}

const [{ dirtyFlag, failOpen, gitPath, invoked, projectPath, projectRoot, readInput, readKit }, { runCommand }, { isTest, projectFiles, STACK_FILES }] = await load('after-edit', ['../metrics.mjs', '../gate.mjs', '../size.mjs']);

const MAX_TESTS = 3;
const MAX_LINES = 60;
// The stack a formatter serves, read from its command.
const FORMATTERS = [
  [/\b(prettier|biome)\b/, 'ts'],
  [/\b(ruff|black)\b/, 'python'],
  [/\b(gofmt|goimports)\b/, 'go'],
  [/\brustfmt\b/, 'rust'],
];
// Linters that take one file; anything else (a package script, a crate-wide tool) waits for the Stop gate.
const PER_FILE_LINT = /^((npx|bunx|yarn|pnpm exec|uv run|poetry run)\s+)?(eslint|oxlint|biome (lint|check)|ruff check)\b/;
const EXEC = { npm: 'npx', pnpm: 'pnpm exec', yarn: 'yarn', bun: 'bunx', uv: 'uv run', poetry: 'poetry run' };
// Group 1 marks `import type`, which loads nothing at run time.
const FROM = /^\s*(?:import|export)\s+(type\s+)?[^'"]*?\bfrom\s+['"]([^'"]+)['"]/gm;
const BARE = /^\s*import\s+['"]([^'"]+)['"]/gm;
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

const posix = (p) => p.split(path.sep).join('/');
const quote = (p) => (/\s/.test(p) ? `"${p}"` : p);
const inDir = (file, dir) => dir === '.' || file.startsWith(`${dir}/`);
const within = (file, dir) => (dir === '.' ? file : file.slice(dir.length + 1));
const cmd = (...parts) => parts.filter(Boolean).join(' ');
const deepest = (items) => items.sort((a, b) => b.dir.length - a.dir.length)[0] ?? null;

function valueImports(source) {
  const specs = [...source.matchAll(FROM)].filter((m) => !m[1]).map((m) => m[2]);
  for (const m of source.matchAll(BARE)) specs.push(m[1]);
  for (const m of source.matchAll(DYNAMIC)) specs.push(m[1]);
  return specs.filter((spec) => spec.startsWith('.'));
}

// One level: test files whose own value imports resolve to the file (paths relative to the root).
export function relatedNodeTests(file, root, dir) {
  const target = path.resolve(root, file);
  return projectFiles(root)
    .filter((t) => inDir(t, dir) && isTest(t) && STACK_FILES.ts.test(t))
    .filter((t) => valueImports(readFileSync(path.join(root, t), 'utf8')).some((s) => path.resolve(root, path.dirname(t), s) === target))
    .sort();
}

function nodeTests(file, root, dir) {
  const tests = isTest(file) ? [file] : relatedNodeTests(file, root, dir);
  if (tests.length > MAX_TESTS) return { tests: null, deferred: true };
  return { tests: tests.length ? cmd('node --test', ...tests.map((t) => quote(within(t, dir)))) : null, deferred: false };
}

function pytestByName(file, root, dir, exec) {
  const name = path.posix.basename(file).startsWith('test_') ? path.posix.basename(file) : `test_${path.posix.basename(file)}`;
  const tests = projectFiles(root).filter((t) => inDir(t, dir) && path.posix.basename(t) === name);
  return { tests: tests.length ? cmd(exec, 'pytest -q', ...tests.map((t) => quote(within(t, dir)))) : null, deferred: false };
}

function testsFor(mode, file, stack, root) {
  const exec = EXEC[stack.runner] ?? (stack.stack === 'ts' ? 'npx' : '');
  const rel = quote(within(file, stack.dir));
  const dir = path.posix.dirname(within(file, stack.dir));
  const plans = {
    vitest: () => cmd(exec, 'vitest related --run', rel),
    jest: () => cmd(exec, 'jest --findRelatedTests', rel),
    testmon: () => cmd(exec, 'pytest --testmon -q'),
    go: () => (dir === '.' ? 'go test .' : `go test ./${dir}`),
  };
  if (mode === 'stop') return { tests: null, deferred: true };
  if (mode === 'node-test') return nodeTests(file, root, stack.dir);
  if (mode === 'pytest-name') return pytestByName(file, root, stack.dir, exec);
  return { tests: plans[mode]?.() ?? null, deferred: false };
}

function formatFor(config, stack, file) {
  const f = config.formatter;
  const serves = f && f.cwd === stack.dir && FORMATTERS.some(([re, s]) => s === stack.stack && re.test(f.run));
  return serves ? cmd(f.run, quote(within(file, stack.dir))) : null;
}

// A per-file linter's whole-tree target `.` is replaced by the edited file; other arguments stay as detected.
function lintFor(config, stack, file) {
  const lint = config.commands.find((c) => c.step === 'lint' && c.cwd === stack.dir && PER_FILE_LINT.test(c.run));
  if (!lint) return null;
  return cmd(...lint.run.split(/\s+/).filter((w) => w !== '.' && w !== './'), quote(within(file, stack.dir)));
}

// Commands run in `cwd` (the stack's folder) and name the file relative to it.
export function planAfterEdit(file, config, root = process.cwd()) {
  const stack = deepest(config.stacks.filter((s) => STACK_FILES[s.stack]?.test(file) && inDir(file, s.dir)));
  if (!stack) return { cwd: '.', format: null, lint: null, tests: null, deferred: false };
  const mode = deepest(config.related.filter((r) => inDir(file, r.dir)))?.mode ?? 'none';
  return { cwd: stack.dir, format: formatFor(config, stack, file), lint: lintFor(config, stack, file), ...testsFor(mode, file, stack, root) };
}

function clip(text) {
  const lines = text.trimEnd().split('\n');
  return lines.length <= MAX_LINES ? lines.join('\n') : [...lines.slice(0, MAX_LINES - 1), `... ${lines.length - MAX_LINES + 1} more lines`].join('\n');
}

// Format, lint, tests in order inside one budget; past it the rest waits for the Stop gate.
async function runPlan(plan, root, budget) {
  const deadline = Date.now() + budget;
  const failures = [];
  for (const [label, line] of [['format', plan.format], ['lint', plan.lint], ['tests', plan.tests]].filter(([, l]) => l)) {
    const left = deadline - Date.now();
    const result = left > 0 ? await runCommand(line, path.join(root, plan.cwd), left) : { timedOut: true };
    if (result.timedOut) {
      console.log(`after-edit: over ${budget / 1000} s at ${label}, deferred to Stop`);
      break;
    }
    if (result.code !== 0) failures.push(`${label} (${line}):\n${result.output}`);
  }
  if (plan.deferred) console.log('after-edit: related tests deferred to Stop');
  return failures;
}

async function main() {
  const input = readInput();
  const root = projectRoot(input.cwd);
  const config = readKit(root);
  const inside = projectPath(root, input.tool_input?.file_path ?? '');
  if (inside === null) return 0;
  const rel = posix(inside);
  if (!gitPath(root, '--git-dir')) {
    mkdirSync(path.dirname(dirtyFlag(root)), { recursive: true });
    writeFileSync(dirtyFlag(root), `${Date.now()}\n`);
  }
  const failures = await runPlan(planAfterEdit(rel, config, root), root, config.budgets.afterEditMs);
  if (!failures.length) return 0;
  process.stderr.write(`after-edit: ${rel}\n${clip(failures.join('\n'))}\n`);
  return 2;
}

if (invoked(import.meta.url)) await failOpen('after-edit', main);
