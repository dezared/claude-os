import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

// The hooks are dependency-free .mjs outside the typed tree; their contracts are typed here.
const hook = (name: string) => import(`../.claude/hooks/${name}.mjs`);
type ToolInput = { file_path: string; content?: string; old_string?: string; new_string?: string; replace_all?: boolean };
const { protectReason, ratchetReason } = (await hook('protect-files')) as {
  protectReason: (filePath: string, projectDir: string) => string | null;
  ratchetReason: (toolInput: ToolInput, tree: string) => Promise<string | null>;
};
const { workTree } = (await hook('tree')) as { workTree: (input: { cwd?: string }) => string };
const { planTests, relatedTests } = (await hook('after-edit')) as {
  relatedTests: (file: string, projectDir: string) => string[];
  planTests: (tests: string[]) => { run: string[]; deferred: boolean };
};
const { fingerprint, stopDecision } = (await hook('stop-gate')) as {
  fingerprint: (o: { head: string; diff: string; untracked: { path: string; content: Buffer }[] }) => string;
  stopDecision: (
    state: { green: string | null; head?: string; blocks: number },
    fp: string,
    clean: boolean,
    head: string,
  ) => 'skip' | 'run' | 'give-up';
};
const { briefingLines } = (await hook('briefing')) as {
  briefingLines: (o: {
    branch: string;
    dirty: number;
    branches: string[];
    worktrees: string[];
    openItems: number;
    plan: string | null;
    handoff: string | null;
  }) => string[];
};

const p = '/repo';
const HOOKS = fileURLToPath(new URL('../.claude/hooks/', import.meta.url));

// A temp repo on main with one commit holding `files`, and a worktree of it on branch `task`.
function tempRepo(files: Record<string, string>) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'hooks-repo-')));
  const main = join(dir, 'main');
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  for (const [name, text] of Object.entries(files)) writeFileSync(join(main, name), text);
  git(main, 'add', '-A');
  git(main, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const tree = join(dir, 'main/.worktrees/w');
  git(main, 'worktree', 'add', '-q', '-b', 'task', tree);
  return { dir, main, tree, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// Runs a hook as Claude Code does: JSON on stdin, CLAUDE_PROJECT_DIR at the main checkout.
function runHook(name: string, input: object, projectDir: string) {
  const env = { ...process.env, CLAUDE_PROJECT_DIR: projectDir };
  return spawnSync(process.execPath, [join(HOOKS, `${name}.mjs`)], { input: JSON.stringify(input), env, encoding: 'utf8' });
}

test('blocks edits under data and env files', () => {
  assert.notEqual(protectReason(`${p}/data/x`, p), null);
  assert.notEqual(protectReason(`${p}/.env.local`, p), null);
  assert.equal(protectReason(`${p}/server/x.ts`, p), null);
  assert.notEqual(protectReason(`${p}/server/../data/x`, p), null);
});

test('blocks edits to local settings and CLAUDE.local.md', () => {
  for (const file of ['.claude/settings.json', '.claude/settings.local.json', 'CLAUDE.local.md']) {
    assert.notEqual(protectReason(`${p}/${file}`, p), null, file);
  }
  assert.equal(protectReason(`${p}/.claude/rules/x.md`, p), null);
});

test('the work tree is the git root of the session cwd, not CLAUDE_PROJECT_DIR', () => {
  const repo = tempRepo({});
  try {
    mkdirSync(join(repo.tree, 'server'));
    assert.equal(workTree({ cwd: join(repo.tree, 'server') }), repo.tree);
    assert.equal(workTree({ cwd: repo.main }), repo.main);
  } finally {
    repo.done();
  }
});

test('blocks data/ inside the worktree a session runs in', () => {
  const repo = tempRepo({});
  try {
    const input = (file: string) => ({ cwd: repo.tree, tool_name: 'Write', tool_input: { file_path: file, content: '' } });
    const inTree = runHook('protect-files', input(join(repo.tree, 'data/x.json')), repo.main);
    assert.equal(inTree.status, 2);
    assert.match(inTree.stderr, /data\/x\.json is protected/);
    assert.equal(runHook('protect-files', input(join(repo.main, 'data/x.json')), repo.main).status, 2);
    assert.equal(runHook('protect-files', input(join(repo.tree, 'server/x.ts')), repo.main).status, 0);
  } finally {
    repo.done();
  }
});

test('blocks an edit that loosens .oxlintrc.json against HEAD', async () => {
  const config = `{\n  "rules": {\n    "complexity": ["error", { "max": 10 }]\n  }\n}\n`;
  const repo = tempRepo({ '.oxlintrc.json': config });
  try {
    const file = join(repo.tree, '.oxlintrc.json');
    const edit = (to: number) => ({ file_path: file, old_string: '"max": 10', new_string: `"max": ${to}` });
    assert.match((await ratchetReason(edit(11), repo.tree)) ?? '', /complexity: max 10 -> 11/);
    assert.equal(await ratchetReason(edit(9), repo.tree), null);
    assert.match((await ratchetReason({ file_path: file, content: '{ "plugins": ["oxc"] }' }, repo.tree)) ?? '', /dropped unicorn/);
    assert.match((await ratchetReason({ file_path: file, content: '{' }, repo.tree)) ?? '', /not valid JSON/);
    assert.equal(await ratchetReason({ file_path: join(repo.tree, 'x.json'), content: '{' }, repo.tree), null);
    const hookRun = runHook('protect-files', { cwd: repo.tree, tool_name: 'Edit', tool_input: edit(12) }, repo.main);
    assert.equal(hookRun.status, 2);
    assert.match(hookRun.stderr, /complexity: max 10 -> 12/);
  } finally {
    repo.done();
  }
});

test('briefing describes the worktree a session runs in', () => {
  const repo = tempRepo({});
  try {
    const out = runHook('briefing', { cwd: repo.tree, hook_event_name: 'SessionStart' }, repo.main);
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^branch task,/);
  } finally {
    repo.done();
  }
});

test('finds tests that import the edited file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-related-'));
  try {
    mkdirSync(join(dir, 'server'));
    writeFileSync(join(dir, 'server/a.ts'), 'export const a = 1;\n');
    writeFileSync(join(dir, 'server/a.test.ts'), "import { test } from 'node:test';\nimport { a } from './a.ts';\n");
    writeFileSync(join(dir, 'server/types.test.ts'), "import type { A } from './a.ts';\n");
    assert.deepEqual(relatedTests(join(dir, 'server/a.ts'), dir), ['server/a.test.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('defers more than three tests or a slow one', () => {
  assert.equal(planTests(['a.test.ts', 'b.test.ts', 'c.test.ts', 'd.test.ts']).deferred, true);
  assert.equal(planTests(['server/chat/chat.test.ts']).deferred, true);
  assert.deepEqual(planTests(['a.test.ts', 'b.test.ts']), { run: ['a.test.ts', 'b.test.ts'], deferred: false });
});

test("fingerprint changes when an untracked file's content changes", () => {
  const base = { head: 'h', diff: '' };
  const one = fingerprint({ ...base, untracked: [{ path: 'x.ts', content: Buffer.from('1') }] });
  const two = fingerprint({ ...base, untracked: [{ path: 'x.ts', content: Buffer.from('2') }] });
  assert.notEqual(one, two);
});

test('skips a clean tree only at the HEAD of the last green run', () => {
  assert.equal(stopDecision({ green: 'a', head: 'h1', blocks: 0 }, 'b', true, 'h1'), 'skip');
  // An edit and a commit in one turn: clean, but HEAD moved past the last green run.
  assert.equal(stopDecision({ green: 'a', head: 'h1', blocks: 0 }, 'b', true, 'h2'), 'run');
  assert.equal(stopDecision({ green: null, blocks: 0 }, 'b', true, 'h1'), 'run');
});

test('skips when the tree equals the last green one', () => {
  assert.equal(stopDecision({ green: 'a', head: 'h1', blocks: 0 }, 'a', false, 'h1'), 'skip');
  assert.equal(stopDecision({ green: 'a', head: 'h1', blocks: 0 }, 'b', false, 'h1'), 'run');
  assert.equal(stopDecision({ green: null, blocks: 3 }, 'b', false, 'h1'), 'give-up');
});

test('briefing fits in eight lines and names stray branches', () => {
  const lines = briefingLines({
    branch: 'main',
    dirty: 2,
    branches: ['main', 'task/x'],
    worktrees: [],
    openItems: 3,
    plan: 'docs/plans/p.md',
    handoff: null,
  });
  assert.ok(lines.length <= 8);
  assert.ok(lines.some((line) => line.includes('task/x')));
});
