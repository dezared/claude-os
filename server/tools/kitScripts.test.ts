import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { KitConfig, KitHookMetric, KitStack } from '../../shared/projectKit.ts';

// The kit scripts are dependency-free .mjs files rendered into user projects; their contracts are typed here.
const KIT = fileURLToPath(new URL('../../plugins/project-kit/kit/claude/kit/', import.meta.url));
const load = (name: string) => import(`../../plugins/project-kit/kit/claude/kit/${name}.mjs`);

type Step = { name: string; run: string | null; cwd: string; builtin: 'size' | 'suppressions' | 'touchpoints' | null };
type StepResult = { code: number; output: string };
type Exec = (step: Step) => Promise<StepResult>;
type GateRun = { ok: boolean; failed: string | null; output: string; ms: number; notice: string | null };
type State = { green: string | null; head?: string | null; blocks: number; slow?: boolean };

const metrics = (await load('metrics')) as {
  appendMetric: (file: string, entry: KitHookMetric, maxBytes?: number) => void;
  projectRoot: (start: string) => string;
  metricsFile: (cwd: string) => string;
  readState: (root: string) => State;
};
const gate = (await load('gate')) as {
  gateSteps: (config: KitConfig, o?: { slow?: boolean; touchpoints?: number }) => Step[];
  runGate: (steps: Step[], exec: Exec) => Promise<{ ok: boolean; failed: string | null; output: string }>;
  runKitGate: (o: { root: string; config: KitConfig; exec?: Exec; now?: () => number }) => Promise<GateRun>;
  runCommand: (line: string, cwd: string, timeoutMs?: number) => Promise<{ code: number; output: string; timedOut: boolean }>;
  newSuppressions: (diff: string, stacks: KitStack[]) => string[];
  defaultBranch: (cwd: string) => string;
};
const size = (await load('size')) as {
  countLines: (text: string) => number;
  isUi: (path: string) => boolean;
  isCounted: (path: string, generated: string[]) => boolean;
  sizeViolations: (o: {
    counts: Record<string, number>;
    baseline: Record<string, number>;
    headBaseline: Record<string, number> | null;
    limits: { file: number; ui: number };
  }) => string[];
  tightenBaseline: (o: { counts: Record<string, number>; baseline: Record<string, number>; limits: { file: number; ui: number } }) => Record<string, number>;
};
const { protectReason } = (await load('hooks/protect-files')) as {
  protectReason: (filePath: string, projectDir: string, config: KitConfig) => string | null;
};
const { planAfterEdit } = (await load('hooks/after-edit')) as {
  planAfterEdit: (
    file: string,
    config: KitConfig,
    root?: string,
  ) => { cwd: string; format: string | null; lint: string | null; tests: string | null; deferred: boolean };
};
const { stopDecision } = (await load('hooks/stop-gate')) as {
  stopDecision: (state: State, fp: string, clean: boolean, head?: string) => 'skip' | 'run' | 'give-up';
};
const { briefingLines } = (await load('hooks/briefing')) as {
  briefingLines: (o: {
    base?: string;
    branch: string | null;
    dirty: number;
    branches: string[];
    worktrees: string[];
    openItems: number;
    plan: string | null;
    handoff: string | null;
  }) => string[];
};

// Split so that the Claude OS gate, which scans this repo for new suppressions, does not read the fixtures as ones.
const TS_IGNORE = '@ts' + '-ignore';

function kitConfig(over: Partial<KitConfig> = {}): KitConfig {
  return {
    kit: '0.1.0',
    stacks: [],
    commands: [],
    skipped: [],
    related: [],
    formatter: null,
    protected: [],
    limits: { file: 300, ui: 400, fn: 50, complexity: 10 },
    docsDir: 'docs',
    budgets: { afterEditMs: 10000, stopMs: 90000 },
    ...over,
  };
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

// A temp project with `files` and `.claude/kit/kit.json`; a git repo on main with one commit unless `noGit`.
function project(files: Record<string, string>, config: KitConfig | string = kitConfig(), noGit = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'kit-scripts-')));
  const all = { ...files, '.claude/kit/kit.json': typeof config === 'string' ? config : JSON.stringify(config) };
  for (const [name, text] of Object.entries(all)) {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), text);
  }
  if (!noGit) {
    git(root, 'init', '-q', '-b', 'main');
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init');
  }
  return { root, done: () => rmSync(root, { recursive: true, force: true }) };
}

// Runs a kit script as Claude Code runs a hook: JSON on stdin, cwd at the project, no inherited CLAUDE_PROJECT_DIR.
function run(script: string, root: string, input?: object) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: root };
  const options = { cwd: root, env, encoding: 'utf8' as const, input: input ? JSON.stringify(input) : '' };
  return spawnSync(process.execPath, [join(KIT, script)], options);
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `const a${i} = ${i};`).join('\n');
const diff = (file: string, line: string) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${line}\n`;

test('gate red on a new noqa and a new ts-ignore', () => {
  assert.equal(gate.newSuppressions(diff('a.py', '+x = 1  # noqa'), ['python']).length, 1);
  assert.equal(gate.newSuppressions(diff('a.ts', `+// ${TS_IGNORE}`), ['ts']).length, 1);
  assert.deepEqual(gate.newSuppressions(diff('a.ts', `-// ${TS_IGNORE}`), ['ts']), []);
  // The kit's own files name the patterns; other stacks' files and non-code files are not read.
  assert.deepEqual(gate.newSuppressions(diff('.claude/kit/gate.mjs', `+// ${TS_IGNORE}`), ['ts']), []);
  assert.deepEqual(gate.newSuppressions(diff('a.py', '+x = 1  # noqa'), ['ts']), []);
  assert.deepEqual(gate.newSuppressions(diff('notes.md', '+# noqa'), ['python']), []);
  assert.equal(gate.newSuppressions(diff('a.go', '+x := 1 //nolint'), []).length, 1, 'an unknown stack checks every stack');
});

test('size red on growth past the cap and on a raised cap, green on a lowered cap', () => {
  const limits = { file: 300, ui: 400 };
  assert.equal(size.sizeViolations({ counts: { 'a.ts': 301 }, baseline: {}, headBaseline: null, limits }).length, 1);
  assert.equal(size.sizeViolations({ counts: { 'a.ts': 321 }, baseline: { 'a.ts': 320 }, headBaseline: null, limits }).length, 1);
  const raised = size.sizeViolations({ counts: { 'a.ts': 320 }, baseline: { 'a.ts': 330 }, headBaseline: { 'a.ts': 320 }, limits });
  assert.equal(raised.length, 1);
  assert.match(raised[0], /320 -> 330/);
  assert.deepEqual(size.sizeViolations({ counts: { 'a.ts': 310 }, baseline: { 'a.ts': 310 }, headBaseline: { 'a.ts': 320 }, limits }), []);
  const added = size.sizeViolations({ counts: { 'b.ts': 350 }, baseline: { 'b.ts': 350 }, headBaseline: {}, limits });
  assert.equal(added.length, 1, 'the baseline may only lose entries');
});

test('tighten lowers and drops baseline caps, never raises or adds', () => {
  const limits = { file: 300, ui: 400 };
  const counts = { 'a.ts': 320, 'b.ts': 290, 'c.ts': 360, 'x.tsx': 390, 'new.ts': 500 };
  const baseline = { 'a.ts': 340, 'b.ts': 330, 'c.ts': 350, 'x.tsx': 450, 'gone.ts': 400 };
  assert.deepEqual(size.tightenBaseline({ counts, baseline, limits }), { 'a.ts': 320, 'c.ts': 350 });
  const p = project({ 'src/a.ts': lines(320), '.claude/kit/size-baseline.json': JSON.stringify({ 'src/a.ts': 340, 'src/b.ts': 330 }) });
  try {
    const out = spawnSync(process.execPath, [join(KIT, 'size.mjs'), '--tighten'], { cwd: p.root, encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(p.root, '.claude/kit/size-baseline.json'), 'utf8')), { 'src/a.ts': 320 });
    assert.match(out.stdout, /src\/b\.ts: 330 -> removed/);
  } finally {
    p.done();
  }
});

test('ui files get the ui limit', () => {
  assert.deepEqual(size.sizeViolations({ counts: { 'x.tsx': 350 }, baseline: {}, headBaseline: null, limits: { file: 300, ui: 400 } }), []);
  assert.equal(size.isUi('web/App.vue'), true);
  assert.equal(size.isUi('web/app.ts'), false);
  assert.equal(size.countLines('a\n\n  \nb\n'), 2);
  assert.equal(size.isCounted('src/a.ts', []), true);
  assert.equal(size.isCounted('src/a.test.ts', []), false);
  assert.equal(size.isCounted('tests/test_a.py', []), false);
  assert.equal(size.isCounted('dist/a.js', ['dist/']), false);
  assert.equal(size.isCounted('web/dist/a.js', ['dist/']), false);
  assert.equal(size.isCounted('README.md', []), false);
});

test('gate stops at the first red step and skips empty touchpoints', async () => {
  const command = (step: 'typecheck' | 'lint' | 'test', run: string) => ({ step, run, cwd: '.', from: 'package.json#scripts.x' });
  const config = kitConfig({ commands: [command('test', 'npm test'), command('lint', 'npm run lint'), command('typecheck', 'npm run typecheck')] });
  const names = (steps: Step[]) => steps.map((s) => s.name);
  assert.deepEqual(names(gate.gateSteps(config)), ['typecheck', 'lint', 'size', 'suppressions', 'unit']);
  assert.deepEqual(names(gate.gateSteps(config, { touchpoints: 2 })), ['typecheck', 'lint', 'size', 'suppressions', 'touchpoints', 'unit']);
  const ran: string[] = [];
  const result = await gate.runGate(gate.gateSteps(config), async (step) => {
    ran.push(step.name);
    return step.name === 'lint' ? { code: 1, output: 'lint failed\n' } : { code: 0, output: '' };
  });
  assert.deepEqual(result, { ok: false, failed: 'lint', output: 'lint failed\n' });
  assert.deepEqual(ran, ['typecheck', 'lint']);
});

test('the gate over 90 s moves unit tests to the test runner once', async () => {
  const config = kitConfig({ commands: [{ step: 'test', run: 'npm test', cwd: '.', from: 'package.json#scripts.test' }] });
  const p = project({ 'docs/rules/testing.md': '# Testing\n' }, config);
  try {
    const ran: string[] = [];
    const exec: Exec = async (step) => (ran.push(step.name), { code: 0, output: '' });
    const slowClock = () => {
      const ticks = [0, 95_000];
      return () => ticks.shift() ?? 95_000;
    };
    const first = await gate.runKitGate({ root: p.root, config, exec, now: slowClock() });
    assert.equal(first.ok, true);
    assert.match(first.notice ?? '', /test-runner/);
    assert.equal(metrics.readState(p.root).slow, true);
    const testing = () => readFileSync(join(p.root, 'docs/rules/testing.md'), 'utf8').trimEnd().split('\n');
    assert.equal(testing().length, 2);
    assert.ok(ran.includes('unit'));
    assert.equal(gate.gateSteps(config, { slow: metrics.readState(p.root).slow }).some((s) => s.name === 'unit'), false);
    ran.length = 0;
    const second = await gate.runKitGate({ root: p.root, config, exec, now: slowClock() });
    assert.equal(second.notice, null);
    assert.equal(testing().length, 2);
    assert.equal(ran.includes('unit'), false);
  } finally {
    p.done();
  }
});

// A step that outlives the deadline, with a child of its own holding the output pipe, as `npm test` has.
const HANG = `node -e "require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 15000)'], { stdio: 'inherit' }); setTimeout(() => {}, 60000)"`;
const tightBudget = { afterEditMs: 10000, stopMs: 1500 } as unknown as KitConfig['budgets'];

test('a gate step past the budget is stopped, marks the gate slow and says so in one line', () => {
  const config = kitConfig({ commands: [{ step: 'test', run: HANG, cwd: '.', from: 'package.json#scripts.test' }], budgets: tightBudget });
  const p = project({ 'docs/rules/testing.md': '# Testing\n' }, config);
  try {
    const started = Date.now();
    const out = run('gate.mjs', p.root);
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
    assert.equal(out.status, 1);
    const said = out.stdout.trimEnd().split('\n');
    assert.equal(said.length, 1, out.stdout);
    assert.match(said[0], /^gate: .*unit was stopped at the 1\.5 s limit; unit tests left the gate, run them through the test-runner agent\.$/);
    assert.equal(metrics.readState(p.root).slow, true);
    assert.match(readFileSync(join(p.root, 'docs/rules/testing.md'), 'utf8'), /unit was stopped/);
    const next = run('gate.mjs', p.root);
    assert.equal(next.status, 0, next.stdout);
    assert.match(next.stdout, /^gate: green/);
  } finally {
    p.done();
  }
});

test('a step whose parent exited while a grandchild holds the pipe ends at the deadline', async () => {
  const started = Date.now();
  const result = await gate.runCommand('sh -c "(sleep 8 &) ; exit 0"', tmpdir(), 1500);
  assert.ok(Date.now() - started < 4000, `took ${Date.now() - started} ms`);
  assert.equal(result.timedOut, true);
});

test('a project opened through a symlinked path keeps its env file protected', () => {
  const p = project({}, kitConfig(), true);
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'kit-link-')));
  try {
    const link = join(outside, 'link');
    symlinkSync(p.root, link);
    const input = JSON.stringify({ cwd: link, tool_input: { file_path: join(link, '.env') } });
    const out = spawnSync(process.execPath, [join(KIT, 'hooks/protect-files.mjs')], { cwd: link, env: { ...process.env, CLAUDE_PROJECT_DIR: link }, encoding: 'utf8', input });
    assert.equal(out.status, 2, out.stdout + out.stderr);
    assert.match(out.stderr, /^protect-files: \.env is protected/);
    assert.equal(protectReason(join(link, 'src/a.ts'), p.root, kitConfig()), null);
    assert.match(protectReason(join(link, '.env'), p.root, kitConfig()) ?? '', /^\.env is protected/);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    p.done();
  }
});

test('the stop hook does not block on a stopped gate step', () => {
  const typecheck = { step: 'typecheck' as const, run: HANG, cwd: '.', from: 'package.json#scripts.typecheck' };
  const config = kitConfig({ commands: [typecheck], budgets: tightBudget });
  const p = project({ 'docs/rules/testing.md': '# Testing\n' }, config);
  try {
    writeFileSync(join(p.root, 'a.txt'), 'changed\n');
    const first = run('hooks/stop-gate.mjs', p.root, { cwd: p.root });
    assert.equal(first.status, 0, first.stderr);
    assert.match(JSON.parse(first.stdout).systemMessage, /typecheck was stopped at the 1\.5 s limit/);
    assert.equal(metrics.readState(p.root).blocks, 0);
    // Already slow: the second stop says the step was stopped, in one line, and still does not block.
    const second = run('hooks/stop-gate.mjs', p.root, { cwd: p.root });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).systemMessage, 'gate: typecheck was stopped at the 1.5 s limit; run it through the test-runner agent.');
  } finally {
    p.done();
  }
});

test('the project root is the nearest folder with a kit up to the git top level', () => {
  const p = project({ 'README.md': '# parent\n', 'docs/a.md': 'x\n' });
  try {
    const app = join(p.root, 'app');
    mkdirSync(join(app, '.claude/kit'), { recursive: true });
    mkdirSync(join(app, 'src'));
    writeFileSync(join(app, '.claude/kit/kit.json'), JSON.stringify(kitConfig()));
    assert.equal(metrics.projectRoot(app), app);
    assert.equal(metrics.projectRoot(join(app, 'src')), app);
    assert.equal(metrics.projectRoot(join(p.root, 'docs')), p.root);
    // A kit above the git top level belongs to another project.
    const inner = join(p.root, 'inner');
    mkdirSync(inner);
    git(inner, 'init', '-q');
    assert.equal(metrics.projectRoot(inner), inner);
  } finally {
    p.done();
  }
});

test('a hook whose kit module is gone exits 0 with one warning', () => {
  const p = project({});
  try {
    cpSync(KIT, join(p.root, '.claude/kit'), { recursive: true, filter: (src) => !src.endsWith('kit.json') });
    rmSync(join(p.root, '.claude/kit/size.mjs'));
    for (const hook of ['protect-files', 'after-edit', 'stop-gate', 'briefing']) {
      const options = { cwd: p.root, encoding: 'utf8' as const, input: JSON.stringify({ cwd: p.root, tool_input: { file_path: join(p.root, 'a.ts') } }) };
      const out = spawnSync(process.execPath, [join(p.root, '.claude/kit/hooks', `${hook}.mjs`)], options);
      assert.equal(out.status, 0, `${hook}: ${out.stderr}`);
      const said = `${out.stdout}${out.stderr}`.trimEnd().split('\n');
      assert.equal(said.length, 1, `${hook}: ${said.join('\n')}`);
      assert.match(said[0], new RegExp(`^kit ${hook}: .*size\\.mjs`));
    }
  } finally {
    p.done();
  }
});

test('the gate finds a long file and a new suppression in a real repo', () => {
  const typecheck = { step: 'typecheck' as const, run: 'node -e "process.exit(process.argv.length)"', cwd: '.', from: 'PATH:node' };
  const config = kitConfig({ stacks: [{ stack: 'ts', dir: '.', runner: 'npm' }], commands: [typecheck] });
  const p = project({ 'src/a.ts': 'export const a = 1;\n', '.gitignore': 'dist/\n' }, config);
  try {
    const red = run('gate.mjs', p.root);
    assert.equal(red.status, 1, 'the quoted script is one argument and exits with argv length 1');
    assert.match(red.stdout, /^gate: red at typecheck/);
    writeFileSync(join(p.root, '.claude/kit/kit.json'), JSON.stringify({ ...config, commands: [{ ...typecheck, run: 'node -e "process.exit(process.argv.length - 1)"' }] }));
    const green = run('gate.mjs', p.root);
    assert.equal(green.status, 0, green.stdout + green.stderr);
    assert.match(green.stdout, /^gate: green/);
    writeFileSync(join(p.root, 'src/long.ts'), lines(301));
    mkdirSync(join(p.root, 'dist'));
    writeFileSync(join(p.root, 'dist/big.js'), lines(400));
    const long = run('gate.mjs', p.root);
    assert.equal(long.status, 1);
    assert.match(long.stdout, /gate: red at size\nsrc\/long\.ts: 301 lines/);
    rmSync(join(p.root, 'src/long.ts'));
    writeFileSync(join(p.root, 'src/a.ts'), `// ${TS_IGNORE}\nexport const a: number = '1';\n`);
    const suppressed = run('gate.mjs', p.root);
    assert.equal(suppressed.status, 1);
    assert.match(suppressed.stdout, /gate: red at suppressions\nsrc\/a\.ts: /);
    assert.equal(gate.defaultBranch(p.root), 'main');
  } finally {
    p.done();
  }
});

test('env files and the kit folder are protected', () => {
  const config = kitConfig({ protected: ['dist/', 'generated/**'] });
  const r = '/repo';
  for (const file of ['.env.local', '.claude/kit/kit.json', 'package-lock.json', 'web/yarn.lock', '.git/config', 'dist/a.js', 'generated/x/y.ts']) {
    assert.notEqual(protectReason(`${r}/${file}`, r, config), null, file);
  }
  assert.equal(protectReason(`${r}/src/a.ts`, r, config), null);
  assert.equal(protectReason('/elsewhere/.env', r, config), null);
});

test('after edit defers rust tests to stop', () => {
  const config = kitConfig({ stacks: [{ stack: 'rust', dir: '.', runner: null }], related: [{ dir: '.', mode: 'stop' }] });
  const plan = planAfterEdit('src/lib.rs', config, '/repo');
  assert.equal(plan.deferred, true);
  assert.equal(plan.tests, null);
});

test('after edit runs the related tests of the edited file', () => {
  const ts = kitConfig({
    stacks: [{ stack: 'ts', dir: 'web', runner: 'pnpm' }],
    related: [{ dir: 'web', mode: 'vitest' }],
    formatter: { step: 'format', run: 'pnpm exec prettier --write', cwd: 'web', from: 'web/.prettierrc' },
    commands: [{ step: 'lint', run: 'pnpm exec eslint .', cwd: 'web', from: 'web/package.json#scripts.lint' }],
  });
  assert.deepEqual(planAfterEdit('web/src/a b.ts', ts, '/repo'), {
    cwd: 'web',
    format: 'pnpm exec prettier --write "src/a b.ts"',
    lint: 'pnpm exec eslint "src/a b.ts"',
    tests: 'pnpm exec vitest related --run "src/a b.ts"',
    deferred: false,
  });
  assert.equal(planAfterEdit('README.md', ts, '/repo').tests, null);
  const go = kitConfig({ stacks: [{ stack: 'go', dir: '.', runner: null }], related: [{ dir: '.', mode: 'go' }] });
  assert.equal(planAfterEdit('pkg/x/a.go', go, '/repo').tests, 'go test ./pkg/x');
  const p = project({ 'src/a.ts': 'export const a = 1;\n', 'src/a.test.ts': "import { a } from './a.ts';\n" }, kitConfig(), true);
  try {
    const node = kitConfig({ stacks: [{ stack: 'ts', dir: '.', runner: 'npm' }], related: [{ dir: '.', mode: 'node-test' }] });
    assert.equal(planAfterEdit('src/a.ts', node, p.root).tests, 'node --test src/a.test.ts');
  } finally {
    p.done();
  }
});

test('three red stops give up', () => {
  assert.equal(stopDecision({ green: null, blocks: 3 }, 'b', false), 'give-up');
  assert.equal(stopDecision({ green: null, blocks: 2 }, 'b', false), 'run');
  assert.equal(stopDecision({ green: 'b', blocks: 0 }, 'b', false), 'skip');
  assert.equal(stopDecision({ green: null, blocks: 0 }, 'b', true), 'skip');
});

test('a non-git folder stops on the dirty flag that after edit sets', () => {
  const p = project({ 'notes.txt': 'x\n' }, kitConfig(), true);
  try {
    assert.equal(run('hooks/stop-gate.mjs', p.root, { cwd: p.root }).status, 0);
    assert.equal(run('hooks/after-edit.mjs', p.root, { cwd: p.root, tool_input: { file_path: join(p.root, 'notes.txt') } }).status, 0);
    const flag = join(p.root, '.claude/kit/state/dirty');
    assert.equal(existsSync(flag), true);
    writeFileSync(join(p.root, 'big.ts'), lines(301));
    const red = run('hooks/stop-gate.mjs', p.root, { cwd: p.root });
    assert.equal(red.status, 2);
    assert.match(red.stderr, /block 1 of 3[\s\S]*big\.ts: 301 lines/);
    rmSync(join(p.root, 'big.ts'));
    assert.equal(run('hooks/stop-gate.mjs', p.root, { cwd: p.root }).status, 0);
    assert.equal(existsSync(flag), false);
    assert.equal(metrics.readState(p.root).blocks, 0);
    const recorded = readFileSync(join(p.root, '.claude/kit/state/metrics.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(recorded.map((m) => [m.hook, m.ok]), [['stop-gate', true], ['after-edit', true], ['stop-gate', false], ['stop-gate', true]]);
  } finally {
    p.done();
  }
});

test('a hook with a broken kit json exits 0 with one warning', () => {
  const p = project({}, '{ broken');
  try {
    const out = run('hooks/protect-files.mjs', p.root, { cwd: p.root, tool_input: { file_path: join(p.root, 'src/a.ts') } });
    assert.equal(out.status, 0);
    const said = `${out.stdout}${out.stderr}`.trimEnd().split('\n');
    assert.equal(said.length, 1, said.join('\n'));
    assert.match(said[0], /^kit protect-files: /);
  } finally {
    p.done();
  }
});

test('env file edit is blocked through piped json', () => {
  const p = project({});
  try {
    const out = run('hooks/protect-files.mjs', p.root, { cwd: p.root, tool_input: { file_path: join(p.root, '.env') } });
    assert.equal(out.status, 2);
    assert.match(out.stderr, /^protect-files: \.env is protected/);
    assert.equal(run('hooks/protect-files.mjs', p.root, { cwd: p.root, tool_input: { file_path: join(p.root, 'a.ts') } }).status, 0);
    const recorded = readFileSync(metrics.metricsFile(p.root), 'utf8').trim().split('\n');
    assert.equal(recorded.length, 2);
    assert.equal(metrics.metricsFile(p.root), join(p.root, '.git/claude-kit/metrics.jsonl'));
  } finally {
    p.done();
  }
});

test('metrics stay under one megabyte', () => {
  const dir = mkdtempSync(join(tmpdir(), 'kit-metrics-'));
  try {
    const file = join(dir, 'state/metrics.jsonl');
    const entry = (ts: number): KitHookMetric => ({ hook: 'after-edit', ms: 1234, ok: true, ts });
    const each = Buffer.byteLength(`${JSON.stringify(entry(1_700_000_000_000))}\n`);
    const count = Math.ceil((1.2 * 1024 * 1024) / each);
    for (let i = 0; i < count; i++) metrics.appendMetric(file, entry(1_700_000_000_000 + i));
    assert.ok(statSync(file).size <= 1024 * 1024);
    const last = readFileSync(file, 'utf8').trimEnd().split('\n').at(-1) ?? '';
    assert.deepEqual(JSON.parse(last), entry(1_700_000_000_000 + count - 1));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('briefing fits in eight lines and reads the default branch', () => {
  const out = briefingLines({
    base: 'master',
    branch: 'master',
    dirty: 1,
    branches: ['master', 'feature/x'],
    worktrees: ['../wt'],
    openItems: 2,
    plan: 'docs/plans/2026-11-10-x.md',
    handoff: 'docs/handoff/2026-11-10.md',
  });
  assert.ok(out.length <= 8);
  assert.equal(out[0], 'branch master, 1 uncommitted path');
  assert.ok(out.some((l) => l.includes('feature/x')) && !out.some((l) => l.includes(' master,') && l.startsWith('branches')));
  const p = project({ 'docs/plans/README.md': '# Plans\n', 'docs/plans/2026-11-10-x.md': '- [ ] a\n- [x] b\n' });
  try {
    const said = run('hooks/briefing.mjs', p.root, { cwd: p.root });
    assert.equal(said.status, 0, said.stderr);
    assert.equal(said.stdout, 'branch main, 0 uncommitted paths\nlatest plan: docs/plans/2026-11-10-x.md, 1 open items\n');
  } finally {
    p.done();
  }
});

const has = (bin: string) => spawnSync(bin, ['version'], { stdio: 'ignore' }).error === undefined;

const LIVE: Record<string, { files: Record<string, string>; commands: KitConfig['commands']; stack: KitStack }> = {
  go: {
    stack: 'go',
    files: {
      'go.mod': 'module example.com/kitlive\n\ngo 1.21\n',
      'add.go': 'package kitlive\n\nfunc Add(a, b int) int { return a + b }\n',
      'add_test.go': 'package kitlive\n\nimport "testing"\n\nfunc TestAdd(t *testing.T) {\n\tif Add(1, 2) != 3 {\n\t\tt.Fatal("add")\n\t}\n}\n',
    },
    commands: [
      { step: 'typecheck', run: 'go vet ./...', cwd: '.', from: 'PATH:go' },
      { step: 'test', run: 'go test ./...', cwd: '.', from: 'PATH:go' },
    ],
  },
  cargo: {
    stack: 'rust',
    files: {
      'Cargo.toml': '[package]\nname = "kitlive"\nversion = "0.1.0"\nedition = "2021"\n',
      'src/lib.rs': 'pub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\n#[cfg(test)]\nmod tests {\n    #[test]\n    fn adds() {\n        assert_eq!(super::add(1, 2), 3);\n    }\n}\n',
      '.gitignore': 'target/\n',
    },
    commands: [
      { step: 'typecheck', run: 'cargo check', cwd: '.', from: 'PATH:cargo' },
      { step: 'test', run: 'cargo test', cwd: '.', from: 'PATH:cargo' },
    ],
  },
};

for (const [tool, live] of Object.entries(LIVE)) {
  test(`live gate on installed toolchains: ${tool}`, (t) => {
    if (!has(tool)) return t.skip(`${tool} not found`);
    const config = kitConfig({ stacks: [{ stack: live.stack, dir: '.', runner: null }], commands: live.commands, protected: ['target/'] });
    const p = project(live.files, config);
    try {
      const out = run('gate.mjs', p.root);
      assert.equal(out.status, 0, out.stdout + out.stderr);
    } finally {
      p.done();
    }
  });
}
