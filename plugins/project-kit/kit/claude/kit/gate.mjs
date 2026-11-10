// One gate for the Stop hook and the user: typecheck, lint, size, new suppressions, touchpoints, unit tests.
// Stops at the first red step and prints only its output. Commands come from kit.json; the kit never adds flags.
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { gitPath, invoked, projectRoot, readKit, readState, saveState } from './metrics.mjs';
import { checkSize, STACK_FILES } from './size.mjs';
import { fsAt, readTouchpoints, touchpointGaps } from './touchpoints.mjs';

// Written so that a gate scanning this file's own repo for suppressions does not read the patterns as ones.
export const SUPPRESSIONS = {
  ts: /@ts-(?:ignore|expect-error)|eslint[-]disable|biome[-]ignore/,
  python: /#\s*noqa|#\s*type:\s*ignore/,
  go: /\/\/nolint/,
  rust: /#!?\[allow\(/,
};
const ALL_STACKS = Object.keys(SUPPRESSIONS);
// Git's empty tree: with no shared history every line counts as added.
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
const BUFFER = 256 * 1024 * 1024;

const tryGit = (args, cwd) => {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: BUFFER }).trim();
  } catch {
    return null;
  }
};

// origin's HEAD, else a local main, else master; never fetches.
export function defaultBranch(cwd) {
  const remote = tryGit(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd);
  if (remote) return remote.replace('refs/remotes/origin/', '');
  return ['main', 'master'].find((name) => tryGit(['rev-parse', '--verify', '--quiet', `refs/heads/${name}`], cwd) !== null) ?? 'main';
}

function suppressionBase(cwd) {
  const branch = defaultBranch(cwd);
  for (const ref of [branch, `origin/${branch}`, 'HEAD']) {
    const base = tryGit(['merge-base', 'HEAD', ref], cwd);
    if (base) return base;
  }
  return EMPTY_TREE;
}

function patternFor(file, stacks) {
  if (file.startsWith('.claude/kit/')) return null;
  const stack = (stacks.length ? stacks : ALL_STACKS).find((s) => STACK_FILES[s]?.test(file));
  return stack ? SUPPRESSIONS[stack] : null;
}

// `+++ b/<path>` names the new file; `+++ /dev/null` (deleted) names none.
const headerFile = (line, file) => (line.startsWith('+++ ') ? (line.startsWith('+++ b/') ? line.slice(6) : '') : file);

// Added lines of a unified diff that switch a type or lint check off, as `path: line`.
export function newSuppressions(diff, stacks) {
  const hits = [];
  let file = '';
  let header = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) [header, file] = [true, ''];
    else if (line.startsWith('@@')) header = false;
    else if (header) file = headerFile(line, file);
    else if (line.startsWith('+') && patternFor(file, stacks)?.test(line)) hits.push(`${file}: ${line.slice(1).trim()}`);
  }
  return hits;
}

// Untracked, non-ignored files count as fully added.
function untrackedAsDiff(cwd, stacks) {
  const paths = (tryGit(['ls-files', '--others', '--exclude-standard', '-z'], cwd) ?? '').split('\0').filter((p) => p && patternFor(p, stacks));
  return paths
    .map((p) => {
      const added = readFileSync(path.join(cwd, p), 'utf8').split('\n').map((l) => `+${l}`);
      return [`diff --git a/${p} b/${p}`, '--- /dev/null', `+++ b/${p}`, '@@ -0,0 +1 @@', ...added].join('\n');
    })
    .join('\n');
}

export function checkSuppressions(root, config) {
  if (!gitPath(root, '--git-dir')) return [];
  const stacks = config.stacks.map((s) => s.stack);
  // --relative: in a project inside a parent repo, only this project's changes and paths.
  const tracked = tryGit(['diff', '--relative', suppressionBase(root)], root) ?? '';
  return newSuppressions(`${tracked}\n${untrackedAsDiff(root, stacks)}`, stacks);
}

const command = (name) => (c) => ({ name: c.cwd === '.' ? name : `${name} (${c.cwd})`, run: c.run, cwd: c.cwd, builtin: null });
const builtin = (name) => ({ name, run: null, cwd: '.', builtin: name });

// A slow gate (state.slow) leaves the unit tests to the test-runner agent; an empty touchpoints list skips that step.
export function gateSteps(config, { slow = false, touchpoints = 0 } = {}) {
  const of = (step, name) => config.commands.filter((c) => c.step === step).map(command(name));
  return [
    ...of('typecheck', 'typecheck'),
    ...of('lint', 'lint'),
    builtin('size'),
    builtin('suppressions'),
    ...(touchpoints ? [builtin('touchpoints')] : []),
    ...(slow ? [] : of('test', 'unit')),
  ];
}

// Each step gets what is left of the budget (0: none); a step stopped at the deadline ends the gate with `timedOut`.
export async function runGate(steps, exec, budgetMs = 0) {
  const deadline = Date.now() + budgetMs;
  for (const step of steps) {
    const left = budgetMs ? deadline - Date.now() : 0;
    const { code, output, timedOut } = budgetMs && left <= 0 ? { timedOut: true } : await exec(step, left);
    if (timedOut) return { ok: false, failed: step.name, output: '', timedOut: true };
    if (code !== 0) return { ok: false, failed: step.name, output };
  }
  return { ok: true, failed: null, output: '' };
}

// Splits a command line on spaces, keeping "double quoted" parts whole.
export const argv = (line) => [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);

// SIGTERM lets a package manager pass the stop on to its scripts; one that ignores it is killed after this grace.
const KILL_GRACE_MS = 2000;

// A project command; a shell only on Windows, where npm and friends are .cmd files. `timedOut` when stopped at `timeoutMs`.
export function runCommand(line, cwd, timeoutMs = 0) {
  const win = process.platform === 'win32';
  const [bin, ...args] = win ? [line] : argv(line);
  return new Promise((resolve) => {
    const child = spawn(bin === 'node' ? process.execPath : bin, args, { cwd, shell: win });
    let output = '';
    let timedOut = false;
    const timer = timeoutMs > 0 ? setTimeout(() => {
      timedOut = true;
      // Exited already, with a background child still holding the pipes: no 'exit' or 'close' is left to end the step.
      if (child.exitCode !== null || child.signalCode !== null) return done({ code: child.exitCode ?? 1, output, timedOut });
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS).unref();
    }, timeoutMs) : undefined;
    const done = (result) => {
      clearTimeout(timer);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve(result);
    };
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => done({ code: 1, output: `${output}${error.message}\n`, timedOut: false }));
    // A stopped step ends at its exit: children it left behind may still hold the output pipes, and 'close' would wait for them.
    child.on('exit', () => {
      if (timedOut) done({ code: 1, output, timedOut });
    });
    child.on('close', (code) => done({ code: code ?? 1, output, timedOut }));
  });
}

const asResult = (lines) => ({ code: lines.length ? 1 : 0, output: lines.length ? `${lines.join('\n')}\n` : '' });

function touchpointLines(root, config) {
  try {
    return touchpointGaps(readTouchpoints(root, config), fsAt(root));
  } catch (error) {
    return [`touchpoints.json: ${error.message}`];
  }
}

const BUILTINS = { size: checkSize, suppressions: checkSuppressions, touchpoints: touchpointLines };

export const makeExec = (root, config) => (step, timeoutMs = 0) =>
  step.builtin ? Promise.resolve(asResult(BUILTINS[step.builtin](root, config))) : runCommand(step.run, path.join(root, step.cwd), timeoutMs);

// An unreadable list still runs the step, so the step reports why.
function touchpointCount(root, config) {
  try {
    return readTouchpoints(root, config).length;
  } catch {
    return 1;
  }
}

// One line to the user and to <docsDir>/rules/testing.md; later runs leave the unit tests out.
function markSlow(root, config, ms, stopped) {
  const limit = config.budgets.stopMs / 1000;
  const what = stopped ? `${stopped} was stopped at the ${limit} s limit` : `the gate took ${Math.round(ms / 1000)} s, over the ${limit} s budget`;
  const line = `${new Date().toISOString().slice(0, 10)}: ${what}; unit tests left the gate, run them through the test-runner agent.`;
  const file = path.join(root, config.docsDir, 'rules/testing.md');
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  mkdirSync(path.dirname(file), { recursive: true });
  appendFileSync(file, `${before && !before.endsWith('\n') ? '\n' : ''}- ${line}\n`);
  saveState(root, { slow: true });
  return `gate: ${line}`;
}

export async function runKitGate({ root, config, exec = makeExec(root, config), now = Date.now }) {
  const { slow } = readState(root);
  const steps = gateSteps(config, { slow, touchpoints: touchpointCount(root, config) });
  const started = now();
  const result = await runGate(steps, exec, config.budgets.stopMs);
  const ms = now() - started;
  return { ...result, ms, notice: gateNotice(root, config, { slow, ms, stopped: result.timedOut ? result.failed : null }) };
}

// The gate never runs past its budget: the first time over it, it turns slow; a step stopped later still gets one line.
function gateNotice(root, config, { slow, ms, stopped }) {
  if (!slow && (stopped || ms > config.budgets.stopMs)) return markSlow(root, config, ms, stopped);
  return stopped ? `gate: ${stopped} was stopped at the ${config.budgets.stopMs / 1000} s limit; run it through the test-runner agent.` : null;
}

async function main() {
  const root = projectRoot(process.cwd());
  const result = await runKitGate({ root, config: readKit(root) });
  if (result.notice) console.log(result.notice);
  if (result.timedOut) return 1;
  if (result.ok) {
    console.log(`gate: green (${(result.ms / 1000).toFixed(1)} s)`);
    return 0;
  }
  console.log(`gate: red at ${result.failed}`);
  console.log(result.output.trimEnd());
  return 1;
}

if (invoked(import.meta.url)) process.exitCode = await main();
