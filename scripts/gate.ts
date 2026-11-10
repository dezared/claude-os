import { execFileSync, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mergeBase } from './check-lint-ratchet.ts';

export type GateStep = { name: string; run: string[] };
type StepResult = { code: number; output: string };

const NODE = ['node', '--disable-warning=ExperimentalWarning'];

// One gate for the Stop hook, pre-push and any CI: cheap checks first, the unit suite last.
export const GATE_STEPS: GateStep[] = [
  { name: 'typecheck', run: ['npm', 'run', 'typecheck'] },
  { name: 'lint', run: ['npm', 'run', 'lint'] }, // the script carries --max-warnings 0
  { name: 'lint-ratchet', run: ['npm', 'run', 'check:lint-ratchet'] },
  { name: 'shippable', run: ['npm', 'run', 'check:shippable'] },
  { name: 'touchpoints', run: ['npm', 'run', 'check:touchpoints'] },
  { name: 'suppressions', run: [...NODE, 'scripts/gate.ts', 'suppressions'] },
  {
    name: 'unit',
    run: [...NODE, '--test', '--test-reporter=dot', 'server/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
];

export async function runGate(
  steps: GateStep[],
  exec: (step: GateStep) => Promise<StepResult>,
): Promise<{ ok: boolean; failed: string | null; output: string }> {
  for (const step of steps) {
    const { code, output } = await exec(step);
    if (code !== 0) return { ok: false, failed: step.name, output };
  }
  return { ok: true, failed: null, output: '' };
}

const SUPPRESSION = /@ts-ignore|@ts-expect-error|@ts-nocheck|oxlint-disable|eslint-disable/;
const CODE_FILE = /\.(ts|tsx|js|mjs|cjs)$/;
// The gate's own files name the words it looks for.
const EXEMPT = new Set(['scripts/gate.ts', 'scripts/gate.test.ts']);

const watched = (path: string) => CODE_FILE.test(path) && !EXEMPT.has(path);
// `+++ b/<path>` names the new file; `+++ /dev/null` (deleted) names none.
const headerFile = (line: string, file: string) =>
  line.startsWith('+++ ') ? (line.startsWith('+++ b/') ? line.slice(6) : '') : file;
const suppresses = (line: string, file: string) => line.startsWith('+') && watched(file) && SUPPRESSION.test(line);

// Added lines of a unified diff that switch a type or lint check off, as `path: line`.
export function newSuppressions(diff: string): string[] {
  const hits: string[] = [];
  let file = '';
  let header = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) [header, file] = [true, ''];
    else if (line.startsWith('@@')) header = false;
    else if (header) file = headerFile(line, file);
    else if (suppresses(line, file)) hits.push(`${file}: ${line.slice(1).trim()}`);
  }
  return hits;
}

// Untracked, non-ignored files count as fully added.
function untrackedAsDiff(cwd: string): string {
  const paths = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z'], { cwd, encoding: 'utf8' })
    .split('\0')
    .filter(watched);
  return paths
    .map((path) => {
      const added = readFileSync(`${cwd}/${path}`, 'utf8').split('\n').map((l) => `+${l}`);
      return [`diff --git a/${path} b/${path}`, '--- /dev/null', `+++ b/${path}`, '@@ -0,0 +1 @@', ...added].join('\n');
    })
    .join('\n');
}

function checkSuppressions(): number {
  const cwd = process.cwd();
  const tracked = execFileSync('git', ['diff', mergeBase(cwd)], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  const hits = newSuppressions(`${tracked}\n${untrackedAsDiff(cwd)}`);
  for (const hit of hits) console.log(hit);
  if (hits.length) console.error(`suppressions: ${hits.length} new since the merge base; fix the code instead`);
  return hits.length ? 1 : 0;
}

function exec(step: GateStep): Promise<StepResult> {
  const [command, ...args] = step.run;
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: process.platform === 'win32' && command === 'npm' });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('error', (error) => resolve({ code: 1, output: `${output}${error.message}\n` }));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
  });
}

async function main() {
  if (process.argv[2] === 'suppressions') {
    process.exitCode = checkSuppressions();
    return;
  }
  const started = Date.now();
  const result = await runGate(GATE_STEPS, exec);
  if (result.ok) {
    console.log(`gate: green (${((Date.now() - started) / 1000).toFixed(1)} s)`);
    return;
  }
  console.log(`gate: red at ${result.failed}`);
  console.log(result.output.trimEnd());
  process.exitCode = 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
