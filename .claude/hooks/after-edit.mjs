// PostToolUse Edit|Write: lints the edited file and runs the unit tests that import it; prints failures only.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workTree } from './tree.mjs';

// Files that took 3 s or more alone in two runs (2026-11-10, 4 cores under load); they wait for the Stop gate.
export const SLOW_TESTS = [
  'server/chat/btw.test.ts',
  'server/chat/chat.test.ts',
  'server/chat/local-commands.test.ts',
  'server/chat/progress.test.ts',
  'server/chat/recovery.test.ts',
  'server/chat/service.test.ts',
  'server/memory/memory.test.ts',
  'server/memory/wikiSync.test.ts',
  'server/tools/features.test.ts',
  'server/tools/git.test.ts',
  'server/tools/kitApply.test.ts',
  'server/tools/kitPlan.test.ts',
  'server/tools/kitScripts.test.ts',
  'server/tools/osPlugins.test.ts',
  'server/tools/setupChecks.test.ts',
  'server/tools/tools.test.ts',
];
const MAX_TESTS = 3;
const MAX_LINES = 60;
const LINTED = /\.(ts|tsx|js|mjs|cjs)$/;
const TESTED = /^(server|shared|scripts)\/.*\.ts$/;
const TEST_DIRS = ['server', 'scripts'];
// Group 1 marks `import type`, which loads nothing at run time.
const FROM = /^\s*(?:import|export)\s+(type\s+)?[^'"]*?\bfrom\s+['"]([^'"]+)['"]/gm;
const BARE = /^\s*import\s+['"]([^'"]+)['"]/gm;
const DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g;

const posix = (p) => p.split(path.sep).join('/');
const clip = (text) => {
  const lines = text.trimEnd().split('\n');
  return lines.length <= MAX_LINES ? lines.join('\n') : [...lines.slice(0, MAX_LINES - 1), `... ${lines.length - MAX_LINES + 1} more lines`].join('\n');
};

function testFiles(projectDir) {
  return TEST_DIRS.filter((dir) => existsSync(path.join(projectDir, dir))).flatMap((dir) =>
    readdirSync(path.join(projectDir, dir), { recursive: true })
      .filter((name) => name.endsWith('.test.ts') && !name.includes('node_modules'))
      .map((name) => path.join(dir, name)),
  );
}

function valueImports(source) {
  const specs = [...source.matchAll(FROM)].filter((m) => !m[1]).map((m) => m[2]);
  for (const m of source.matchAll(BARE)) specs.push(m[1]);
  for (const m of source.matchAll(DYNAMIC)) specs.push(m[1]);
  return specs.filter((spec) => spec.startsWith('.'));
}

// One level: tests whose own value imports resolve to the file.
export function relatedTests(file, projectDir) {
  const root = path.resolve(projectDir);
  const target = path.resolve(root, file);
  return testFiles(root)
    .filter((test) => {
      const abs = path.join(root, test);
      return valueImports(readFileSync(abs, 'utf8')).some((spec) => path.resolve(path.dirname(abs), spec) === target);
    })
    .map(posix)
    .sort();
}

export function planTests(tests) {
  const deferred = tests.length > MAX_TESTS || tests.some((test) => SLOW_TESTS.includes(test));
  return { run: deferred ? [] : tests, deferred };
}

function node(args, cwd) {
  const result = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { code: result.status ?? 1, output: `${result.stdout ?? ''}${result.stderr ?? ''}${result.error?.message ?? ''}` };
}

function lint(rel, projectDir) {
  // The package's JS entry instead of the shell shim, so Windows needs no .cmd.
  const { code, output } = node([path.join(projectDir, 'node_modules/oxlint/bin/oxlint'), '--max-warnings', '0', rel], projectDir);
  return code === 0 ? null : `oxlint:\n${output}`;
}

function test(rel, projectDir) {
  if (!TESTED.test(rel)) return null;
  const tests = rel.endsWith('.test.ts') ? [rel] : relatedTests(rel, projectDir);
  const plan = planTests(tests);
  if (plan.deferred) console.log(`after-edit: ${tests.length} related test files, tests deferred to Stop`);
  if (!plan.run.length) return null;
  const args = ['--disable-warning=ExperimentalWarning', '--test', '--test-reporter=dot', ...plan.run];
  const { code, output } = node(args, projectDir);
  return code === 0 ? null : `tests (${plan.run.join(', ')}):\n${output}`;
}

function main() {
  const input = JSON.parse(readFileSync(0, 'utf8'));
  const projectDir = workTree(input);
  const rel = posix(path.relative(projectDir, path.resolve(projectDir, input.tool_input?.file_path ?? '')));
  if (rel.startsWith('..') || path.isAbsolute(rel) || !LINTED.test(rel)) return;
  const failures = [lint(rel, projectDir), test(rel, projectDir)].filter(Boolean);
  if (!failures.length) return;
  process.stderr.write(`after-edit: ${rel}\n${clip(failures.join('\n'))}\n`);
  process.exitCode = 2;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
