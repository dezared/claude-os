// Second and third batch: everything here runs in temp dirs, with temp repos and a local bare remote.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, afterEach, beforeEach, describe, it, test } from 'node:test';
import type { IdeEntry, ProjectSetup, PromotePreview, VaultStatus } from '../../shared/contract.ts';
import { classifyUsage, queryUsage, usageForPath, INSERT_USAGE } from '../journal/usage.ts';
import { initSchema } from '../journal/db.ts';
import { createIndexer } from '../journal/indexer.ts';
import { parseToolCalls } from '../journal/parse.ts';
import { registerMemory } from '../memory/index.ts';
import { makeKit, type TestKit } from '../memory/testkit.ts';
import { limitWindows } from './account.ts';
import { toCommandInfo } from './commands.ts';
import { gitCommit, gitCommitDiff, gitCommitFiles, gitDiff, gitPush, gitPushPreview, gitStage, gitStatus, gitUnstage, parseStatusV2, validateRepoPath, validateSha } from './git.ts';
import { chooseIde, ideArgv, obsidianState, projectIde, resolveLinuxIdes, resolveWindowsIdes } from './ide.ts';
import { registerTools } from './index.ts';
import { windowsScanScript, shellArgv } from './platform.ts';
import { maskValue, restoreMasked } from './setup.ts';
import { createSettings } from './settings.ts';
import { createApprovals } from './approvals.ts';

describe('git', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-os-git-')));
  const repo = join(dir, 'repo');
  const bare = join(dir, 'remote.git');
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses paths outside the repo and strange commits', () => {
    for (const bad of ['../x', 'a/../../x', '/etc/passwd', '', 'a\0b', 5, null, '..', 'a/..', '.git/config', '.git', 'a\\..\\b']) {
      assert.throws(() => validateRepoPath(bad), (e: Error & { statusCode?: number }) => e.statusCode === 400, String(bad));
    }
    assert.equal(validateRepoPath('src/a b.ts'), 'src/a b.ts');
    assert.equal(validateRepoPath('-rf'), '-rf'); // goes after `--`
    for (const bad of ['HEAD', '--all', 'abc', 'a'.repeat(65), '../x']) assert.throws(() => validateSha(bad));
    assert.equal(validateSha('abcdef1'), 'abcdef1');
  });

  it('parses status v2 with renames and spaces', () => {
    const s = parseStatusV2(['# branch.head main', '# branch.upstream origin/main', '# branch.ab +2 -1', '1 M. N... 100644 100644 100644 a b my file.ts', '1 .M N... 100644 100644 100644 a b y.ts', '2 R. N... 100644 100644 100644 a b R100 new.ts', 'old.ts', '? un tracked.txt', ''].join('\0'));
    assert.equal(s.branch, 'main');
    assert.equal(s.ahead, 2);
    assert.equal(s.behind, 1);
    assert.deepEqual(s.staged.map((f) => f.path), ['my file.ts', 'new.ts']);
    assert.equal(s.staged[1].oldPath, 'old.ts');
    assert.deepEqual(s.unstaged.map((f) => f.path), ['y.ts']);
    assert.deepEqual(s.untracked.map((f) => f.path), ['un tracked.txt']);
  });

  it('non-repo: honest state; the whole cycle against a local bare remote', async () => {
    const plain = join(dir, 'plain');
    mkdirSync(plain);
    assert.deepEqual(await gitStatus(plain), { isRepo: false, reason: 'not_a_repo' });

    g(dir, 'init', '--bare', '-b', 'main', bare);
    mkdirSync(repo);
    g(repo, 'init', '-b', 'main');
    g(repo, 'config', 'user.email', 't@e.st');
    g(repo, 'config', 'user.name', 'T');
    writeFileSync(join(repo, 'a b.txt'), 'one\n');
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0, 1, 2, 0]));
    let st = await gitStatus(repo);
    assert.ok(st.isRepo);
    assert.deepEqual(st.untracked.map((f) => f.path), ['a b.txt', 'bin.dat']);
    assert.deepEqual(st.commits, []);
    assert.equal((await gitDiff(repo, 'bin.dat', 'untracked')).binary, true);
    assert.match((await gitDiff(repo, 'a b.txt', 'untracked')).diff, /^\+one$/m);
    await assert.rejects(gitDiff(repo, '../x', 'unstaged'));

    await gitStage(repo, ['a b.txt']);
    st = await gitStatus(repo);
    assert.ok(st.isRepo);
    assert.deepEqual(st.staged.map((f) => f.path), ['a b.txt']);
    await gitUnstage(repo, ['a b.txt']); // no HEAD yet
    st = await gitStatus(repo);
    assert.ok(st.isRepo);
    assert.equal(st.staged.length, 0);
    await gitStage(repo, ['a b.txt']);
    await gitCommit(repo, 'first');
    assert.equal(g(repo, 'log', '-1', '--format=%B').trim(), 'first', 'nothing added to the message');

    await assert.rejects(gitCommit(repo, ' '), /message/);
    // No upstream: git's own words reach the user, nothing is created on any remote.
    g(repo, 'remote', 'add', 'origin', bare);
    await assert.rejects(gitPush(repo, { branch: 'main', remote: null, ahead: 0 }), /no upstream/);
    assert.equal(g(bare, 'for-each-ref').length, 0);
    g(repo, 'push', '-u', 'origin', 'main');

    writeFileSync(join(repo, 'a b.txt'), 'two\n');
    assert.match((await gitDiff(repo, 'a b.txt', 'unstaged')).diff, /^\+two$/m);
    await gitStage(repo, ['a b.txt']);
    assert.match((await gitDiff(repo, 'a b.txt', 'staged')).diff, /^-one$/m);
    await gitUnstage(repo, ['a b.txt']);
    await gitStage(repo, ['a b.txt']);
    await gitCommit(repo, 'second');

    const pre = await gitPushPreview(repo);
    assert.equal(pre.remote, 'origin');
    assert.equal(pre.remoteBranch, 'main');
    assert.equal(pre.ahead, 1);
    assert.deepEqual(pre.commits.map((c) => c.subject), ['second']);
    await assert.rejects(gitPush(repo, { branch: 'main', remote: 'origin', ahead: 7 }), /changed/);
    await gitPush(repo, { branch: 'main', remote: 'origin', ahead: 1 });
    assert.equal(g(bare, 'log', '-1', '--format=%s', 'main'), 'second');

    const hash = g(repo, 'rev-parse', 'HEAD');
    assert.deepEqual((await gitCommitFiles(repo, hash)).files.map((f) => [f.status, f.path]), [['M', 'a b.txt']]);
    assert.match((await gitCommitDiff(repo, hash, 'a b.txt')).diff, /^\+two$/m);

    // A rejected, non-fast-forward push is reported verbatim and forces nothing.
    const other = join(dir, 'other');
    g(dir, 'clone', '-q', bare, other);
    g(other, 'config', 'user.email', 't@e.st');
    g(other, 'config', 'user.name', 'T');
    writeFileSync(join(other, 'z'), 'z');
    g(other, 'add', 'z');
    g(other, 'commit', '-qm', 'theirs');
    g(other, 'push', '-q');
    writeFileSync(join(repo, 'y'), 'y');
    await gitStage(repo, ['y']);
    await gitCommit(repo, 'ours');
    await assert.rejects(gitPush(repo, { branch: 'main', remote: 'origin', ahead: 1 }), /rejected|fetch first|non-fast-forward/);
    assert.equal(g(bare, 'log', '-1', '--format=%s', 'main'), 'theirs');
  });

  it('a failing hook comes back verbatim', async () => {
    const hook = join(repo, '.git/hooks/pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho "lint says no: 42" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    writeFileSync(join(repo, 'h'), 'h');
    await gitStage(repo, ['h']);
    await assert.rejects(gitCommit(repo, 'nope'), /lint says no: 42/);
    rmSync(hook);
  });

  it('caps huge diffs and does not run repo-configured diff programs', async () => {
    writeFileSync(join(repo, 'big.txt'), 'x\n'.repeat(400_000));
    assert.equal((await gitDiff(repo, 'big.txt', 'untracked')).truncated, true);
    const marker = join(dir, 'ext-ran');
    g(repo, 'config', 'diff.external', `sh -c 'touch ${marker}'`);
    await gitDiff(repo, 'h', 'staged');
    assert.equal(existsSync(marker), false);
    g(repo, 'config', '--unset', 'diff.external');
    await gitDiff(repo, 'big.txt', 'staged');
  });

  it('source has no force, reset or clean', () => {
    const src = readFileSync(join(import.meta.dirname, 'git.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /--force|'-f'|'reset'|'clean'|--no-verify/);
  });

  it('symlink out of the repo is not followed in an untracked diff', async () => {
    const secret = join(dir, 'outside.txt');
    writeFileSync(secret, 'SECRET');
    symlinkSync(secret, join(repo, 'link'));
    const d = await gitDiff(repo, 'link', 'untracked');
    assert.doesNotMatch(d.diff, /SECRET/);
  });
});

describe('usage extraction', () => {
  const roots = { vault: '/r/vault', claudeDir: '/h/.claude' };
  it('classifies skills, vault, external memory, and nothing else', () => {
    assert.deepEqual(classifyUsage({ name: 'Skill', skill: 'a:b', path: null }, roots), { target: 'a:b', kind: 'skill', op: 'use' });
    assert.deepEqual(classifyUsage({ name: 'Read', skill: null, path: '/r/vault/projects/p/n.md' }, roots), { target: '/r/vault/projects/p/n.md', kind: 'vault', op: 'read' });
    assert.deepEqual(classifyUsage({ name: 'Write', skill: null, path: '/h/.claude/projects/-x/memory/n.md' }, roots), { target: '/h/.claude/projects/-x/memory/n.md', kind: 'external', op: 'write' });
    assert.equal(classifyUsage({ name: 'Grep', skill: null, path: '/h/.claude/projects/-x/memory' }, roots)?.op, 'read');
    assert.equal(classifyUsage({ name: 'Read', skill: null, path: '/repo/server/memory/store.ts' }, roots), null, 'code in a folder named memory');
    assert.equal(classifyUsage({ name: 'Read', skill: null, path: '/h/.claude/projects/-x/abc.jsonl' }, roots), null);
    assert.equal(classifyUsage({ name: 'Bash', skill: null, path: '/r/vault/x' }, roots), null);
    assert.equal(classifyUsage({ name: 'Read', skill: null, path: 'vault/x.md' }, roots), null);
  });

  it('parse keeps the path; indexer logs new lines; backfill finds old ones without touching offsets', async () => {
    const calls = parseToolCalls({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'r', name: 'Read', input: { file_path: '/a' } }, { type: 'tool_use', id: 'g', name: 'Grep', input: { path: '/b', pattern: 'x' } }] } });
    assert.deepEqual(calls.map((c) => c.path), ['/a', '/b']);

    const base = mkdtempSync(join(tmpdir(), 'claude-os-usage-'));
    const db = new DatabaseSync(':memory:');
    initSchema(db);
    const projectsDir = join(base, 'projects');
    const session = 'aaaa-bbbb';
    mkdirSync(join(projectsDir, '-p'), { recursive: true });
    const mem = join(projectsDir, '-p', 'memory', 'n.md');
    const line = (id: string, name: string, input: object) => JSON.stringify({ type: 'assistant', timestamp: '2026-11-05T10:00:00Z', cwd: '/p', message: { id: `m${id}`, model: 'x', usage: { input_tokens: 1 }, content: [{ type: 'tool_use', id, name, input }] } }) + '\n';
    const journal = join(projectsDir, '-p', `${session}.jsonl`);
    writeFileSync(journal, line('t1', 'Read', { file_path: mem }) + line('t2', 'Read', { file_path: '/p/src/a.ts' }) + line('t3', 'Skill', { skill: 'foo' }));
    const roots2 = { vault: join(base, 'vault'), claudeDir: base };
    const indexer = createIndexer({ db, projectsDir, projectForCwd: () => 'p', onCommit: () => {}, usageRoots: roots2 });
    await indexer.sweep();
    assert.deepEqual(queryUsage(db, { session }).map((e) => e.target).sort(), ['foo', mem].sort());
    assert.deepEqual({ ...usageForPath(db, mem) }, { reads: 1, writes: 0, last: Date.parse('2026-11-05T10:00:00Z') });

    // As if these records were indexed before the table existed.
    db.exec('DELETE FROM usage_log');
    const offsets = db.prepare('SELECT offset FROM file_offsets').all();
    await indexer.backfillUsage();
    assert.deepEqual(queryUsage(db, { session, kind: 'external' }).map((e) => e.target), [mem]);
    assert.deepEqual(queryUsage(db, { session, kind: 'skill' }).map((e) => e.target), ['foo']);
    assert.deepEqual(db.prepare('SELECT offset FROM file_offsets').all(), offsets);
    db.prepare(INSERT_USAGE).run('t1', session, 'Read', mem, 'external', 'read', 1); // idempotent by tool id
    assert.equal(queryUsage(db, { session }).length, 2);
    db.close();
    rmSync(base, { recursive: true, force: true });
  });
});

describe('IDEs', () => {
  const scan = {
    where: { 'notepad++.exe': ['C:\\NPP\\notepad++.exe'] },
    appPaths: { 'phpstorm64.exe': '"C:\\JB\\PhpStorm\\bin\\phpstorm64.exe"'.replaceAll('"', '') },
    uninstall: [{ n: 'Microsoft Visual Studio Code (User)', l: 'C:\\VSC\\', i: 'C:\\VSC\\Code.exe,0' }, { n: 'Unrelated', l: null, i: null }],
    vswhere: [{ name: 'Visual Studio Community 2022', path: 'C:\\VS\\devenv.exe' }],
    files: ['C:\\Users\\u\\AppData\\Local\\JetBrains\\Toolbox\\apps\\rider\\bin\\rider64.exe', 'C:\\JB\\PhpStorm\\bin\\phpstorm64.exe'],
    obsidianHandler: null,
  };
  const found = resolveWindowsIdes(scan);

  it('resolves a Windows scan, no duplicates', () => {
    assert.deepEqual(found.map((e) => e.catalogId).sort(), ['notepadpp', 'phpstorm', 'rider', 'visualstudio', 'vscode']);
    assert.equal(found.find((e) => e.catalogId === 'visualstudio')?.name, 'Visual Studio Community 2022');
    assert.equal(found.find((e) => e.catalogId === 'rider')?.source, 'toolbox');
    assert.equal(found.filter((e) => e.catalogId === 'phpstorm').length, 1);
  });

  it('obsidian: a stale link handler does not count as installed', () => {
    assert.deepEqual(obsidianState({ files: [], obsidianHandler: null }), { installed: false, exe: null });
    assert.deepEqual(obsidianState({ files: [], obsidianHandler: { exe: 'C:\\O\\Obsidian.exe', exists: false } }), { installed: false, exe: null });
    assert.deepEqual(obsidianState({ files: [], obsidianHandler: { exe: 'C:\\O\\Obsidian.exe', exists: true } }), { installed: true, exe: 'C:\\O\\Obsidian.exe' });
    assert.equal(obsidianState({ files: ['C:\\P\\Obsidian.exe'], obsidianHandler: null }).installed, true);
  });

  it('the scan script holds no input from a request and only reads', () => {
    const script = windowsScanScript(['a.exe'], ["C:\\it's"]);
    assert.ok(script.includes("'C:\\it''s'"));
    assert.doesNotMatch(script, /Set-Item|New-Item|Remove-|Invoke-WebRequest/);
  });

  it('WSL: a wrapper on the PATH replaces the same VS Code, other Windows hits on PATH are dropped', () => {
    const all = resolveLinuxIdes([{ name: 'code', path: '/mnt/c/VSC/bin/code' }, { name: 'phpstorm', path: '/mnt/c/JB/phpstorm' }, { name: 'zed', path: '/usr/bin/zed' }], found);
    assert.equal(all.filter((e) => e.catalogId === 'vscode').length, 1);
    assert.equal(all.find((e) => e.catalogId === 'vscode')?.side, 'linux');
    assert.equal(all.find((e) => e.catalogId === 'phpstorm')?.side, 'windows');
    assert.equal(all.find((e) => e.catalogId === 'zed')?.exe, '/usr/bin/zed');
  });

  it('marker files choose among the installed only', () => {
    const ids = (files: string[], list: IdeEntry[] = found) => chooseIde(files, list).ide?.catalogId;
    assert.equal(ids(['composer.json', 'package.json']), 'phpstorm');
    assert.equal(ids(['App.sln']), 'visualstudio');
    assert.equal(ids(['x.csproj'], found.filter((e) => e.catalogId !== 'visualstudio')), 'rider');
    assert.equal(ids(['package.json']), 'vscode');
    assert.equal(ids(['go.mod'], found), 'vscode', 'GoLand is not installed');
    assert.equal(chooseIde(['composer.json'], found).marker, 'composer.json');
    assert.equal(chooseIde([], found).marker, null);
    assert.equal(chooseIde(['composer.json'], []).ide, null);
  });

  it('project choice: a manual choice wins, an unapproved entry never does', () => {
    const dir = mkdtempSync(join(tmpdir(), 'claude-os-ide-'));
    writeFileSync(join(dir, 'composer.json'), '{}');
    const rider = found.find((e) => e.catalogId === 'rider')!;
    assert.equal(projectIde(dir, found, null).chosen?.catalogId, 'phpstorm');
    assert.equal(projectIde(dir, found, null).auto, true);
    assert.equal(projectIde(dir, found, rider.id).chosen?.id, rider.id);
    assert.equal(projectIde(dir, found, rider.id).auto, false);
    const unapproved = found.map((e) => (e.id === rider.id ? { ...e, approved: false } : e));
    assert.equal(projectIde(dir, unapproved, rider.id).chosen?.catalogId, 'phpstorm');
    rmSync(dir, { recursive: true, force: true });
  });

  it('argv: WSL paths are converted, the VS Code family uses the remote form', () => {
    const opts = { kind: 'wsl' as const, distro: 'Ubuntu', toWin: (p: string) => `W:${p}`, toLinux: (p: string) => `L:${p}` };
    assert.deepEqual(ideArgv({ exe: 'C:\\PS\\phpstorm64.exe', side: 'windows', family: 'jetbrains' }, '/home/x', opts), { bin: 'L:C:\\PS\\phpstorm64.exe', args: ['W:/home/x'] });
    assert.deepEqual(ideArgv({ exe: 'C:\\VSC\\Code.exe', side: 'windows', family: 'vscode' }, '/home/my x', opts), { bin: 'L:C:\\VSC\\Code.exe', args: ['--folder-uri', 'vscode-remote://wsl+Ubuntu/home/my%20x'] });
    assert.deepEqual(ideArgv({ exe: '/mnt/c/VSC/bin/code', side: 'linux', family: 'vscode' }, '/home/x', opts), { bin: '/mnt/c/VSC/bin/code', args: ['/home/x'] });
    assert.deepEqual(ideArgv({ exe: 'C:\\VSC\\Code.exe', side: 'windows', family: 'vscode' }, 'C:\\x', { kind: 'windows' }), { bin: 'C:\\VSC\\Code.exe', args: ['C:\\x'] });
  });

  it('terminal: a plain shell at the folder, without claude', () => {
    assert.deepEqual(shellArgv('wsl', '/p', 'U'), { bin: 'wt.exe', args: ['wsl.exe', '-d', 'U', '--cd', '/p'] });
    assert.deepEqual(shellArgv('windows', 'C:\\p'), { bin: 'wt.exe', args: ['-d', 'C:\\p'] });
  });
});

describe('small parsers', () => {
  it('limits: the server rows when present, named windows otherwise', () => {
    const rows = limitWindows({ five_hour: null, limits: [{ kind: 'weekly_all', group: 'weekly', percent: 9, severity: 'normal', resets_at: '2026-11-09T18:00:00+00:00', scope: null, is_active: true }, { kind: 'weekly_scoped', percent: 0, severity: 'normal', resets_at: null, scope: { model: { display_name: 'Fable' } }, is_active: false }] });
    assert.deepEqual(rows.map((r) => [r.kind, r.label, r.percent, r.active]), [['weekly_all', null, 9, true], ['weekly_scoped', 'Fable', 0, false]]);
    assert.deepEqual(limitWindows({ five_hour: { utilization: 3, resets_at: null }, seven_day: null }).map((r) => [r.kind, r.percent]), [['session', 3]]);
    assert.deepEqual(limitWindows(null), []);
  });

  it('commands: source, cleaned description, terminal flag, builtin wins a shared name', () => {
    const list = toCommandInfo([
      { name: 'mine', description: 'My skill (user)', argumentHint: '' },
      { name: 'clean', description: 'Project thing (project)', argumentHint: '<x>' },
      { name: 'superpowers:plan', description: 'Plan', argumentHint: '' },
      { name: 'config', description: 'Dialog', argumentHint: '', builtin: true },
      { name: 'dup', description: 'skill', argumentHint: '' },
      { name: 'dup', description: 'real', argumentHint: '', builtin: true },
      { name: 'thing', description: 'x', argumentHint: '' },
    ], [{ name: 'thing', scope: 'project', source: 'p' }], ['thing']);
    const by = Object.fromEntries(list.map((c) => [c.name, c]));
    assert.equal(by.mine.source, 'skill');
    assert.equal(by.mine.description, 'My skill');
    assert.equal(by.clean.source, 'project');
    assert.equal(by.clean.argumentHint, '<x>');
    assert.equal(by['superpowers:plan'].source, 'plugin');
    assert.equal(by.config.source, 'builtin');
    assert.equal(by.config.needsTerminal, true);
    assert.equal(by.dup.description, 'real');
    assert.equal(by.thing.source, 'project');
    assert.equal(by.thing.needsTerminal, true);
  });

  it('masking: secrets never leave, a masked value survives a save', () => {
    const original = { env: { API: 'plain-looking' }, apiKeyHelper: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'notify --token=abcdef ok' }] }] }, model: 'opus' };
    const masked = maskValue(original) as typeof original;
    const text = JSON.stringify(masked);
    assert.doesNotMatch(text, /plain-looking|abcdef/);
    assert.equal(masked.model, 'opus');
    assert.deepEqual(restoreMasked(masked, original), original);
    const edited = { ...masked, model: 'sonnet', env: { API: '***', NEW: 'v' } };
    assert.deepEqual(restoreMasked(edited, original), { ...original, model: 'sonnet', env: { API: 'plain-looking', NEW: 'v' } });
  });
});

let kit: TestKit;
const req = async <T = Record<string, unknown>>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
  const res = await kit.app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
  return { status: res.statusCode, body: res.json() as T, text: res.body };
};

describe('vault copy', () => {
  beforeEach(() => { kit = makeKit(); });
  afterEach(() => kit.close());

  const oldDir = (root: string) => join(kit.paths.claudeDir, 'projects', root.replace(/[^a-zA-Z0-9]/g, '-'), 'memory');

  it('copies, verifies, skips existing, keeps sources; audit; drift keeps showing', async () => {
    const root = join(kit.base, 'pr');
    kit.addProject('pr', root);
    kit.write(join(oldDir(root), 'MEMORY.md'), 'index');
    kit.write(join(oldDir(root), 'a.md'), 'old a');
    kit.write(join(oldDir(root), 'b.md'), 'theirs');
    kit.write(join(kit.paths.vault, 'projects/pr/b.md'), 'mine');
    registerMemory(kit.ctx);

    const before = await req<VaultStatus>('GET', '/api/memory/vault');
    assert.deepEqual(before.body.projects[0].newFiles, ['MEMORY.md', 'a.md']);
    assert.deepEqual(before.body.projects[0].conflicts, ['b.md']);
    assert.equal(existsSync(join(kit.paths.vault, 'projects/pr/a.md')), false, 'preview writes nothing');

    const { dir, copied } = kit.ctx.memory.prepareSessionDir('pr');
    assert.equal(dir, join(kit.paths.vault, 'projects/pr'));
    assert.equal(copied, 2);
    assert.equal(readFileSync(join(dir, 'a.md'), 'utf8'), 'old a');
    assert.equal(readFileSync(join(dir, 'b.md'), 'utf8'), 'mine', 'an existing vault note stays');
    assert.equal(readFileSync(join(oldDir(root), 'a.md'), 'utf8'), 'old a', 'sources stay');
    assert.equal(kit.audits.filter((a) => a.action === 'memory.copy').length, 1);
    assert.equal(kit.ctx.memory.prepareSessionDir('pr').copied, 0);
    assert.equal(kit.audits.filter((a) => a.action === 'memory.copy').length, 1, 'nothing to report the second time');
    assert.equal(existsSync(join(root, '.claude/settings.local.json')), false, 'project settings untouched');

    // A terminal session writes a new note to the old place: read-only, counted as drift, not duplicated.
    kit.write(join(oldDir(root), 'fresh.md'), 'from a terminal');
    kit.ctx.memory.touch?.();
    await new Promise((r) => setTimeout(r, 2100)); // view TTL
    const stats = kit.ctx.memory.projectStats('pr');
    assert.equal(stats.drift, 1);
    const graph = await req<{ nodes: { file: string; connected: boolean }[] }>('GET', '/api/memory/graph');
    const files = graph.body.nodes.filter((n) => n.file === 'a.md');
    assert.equal(files.length, 1);
    assert.equal(files[0].connected, true);
    assert.equal(graph.body.nodes.find((n) => n.file === 'fresh.md')?.connected, false);

    const bulk = await req<{ copied: number; conflicts: number }>('POST', '/api/memory/vault/copy');
    assert.equal(bulk.body.copied, 1);
    assert.equal(bulk.body.conflicts, 1);
  });

  it('a project with old notes elsewhere (a worktree dir) is covered too; nothing to copy still gives a dir', () => {
    const root = join(kit.base, 'qq');
    kit.addProject('qq', root);
    registerMemory(kit.ctx);
    assert.deepEqual(kit.ctx.memory.prepareSessionDir('qq'), { dir: join(kit.paths.vault, 'projects/qq'), copied: 0 });
    assert.ok(existsSync(join(kit.paths.vault, 'projects/qq')));
  });
});

describe('settings and project setup', () => {
  beforeEach(() => { kit = makeKit(); });
  afterEach(() => kit.close());

  it('universe options: defaults, a patch survives other keys, a hand-edited file cannot break the map', () => {
    const s = createSettings(kit.ctx, createApprovals(kit.ctx), async () => ({ ides: [], obsidianInstalled: false, obsidianExe: null }));
    const file = join(kit.paths.config, 'settings.json');
    assert.deepEqual(s.view().universe, { limit: 100, theme: 'default', colors: {}, crossLinks: false, nesting: false });
    assert.equal(s.setUniverse({ limit: 7, theme: 'ember' }).universe.limit, 7);
    const after = s.setUniverse({ colors: { bg: '#102030' }, nesting: true }).universe;
    assert.deepEqual(after, { limit: 7, theme: 'ember', colors: { bg: '#102030' }, crossLinks: false, nesting: true });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).universe, after);
    assert.throws(() => s.setUniverse({ limit: 0 }), /bad limit/);
    assert.throws(() => s.setUniverse({ limit: 2000 }), /bad limit/);
    assert.throws(() => s.setUniverse({ theme: 'neon' as 'ember' }), /bad theme/);
    assert.throws(() => s.setUniverse({ colors: { bg: 'url(x)' } }), /bad colour/);
    writeFileSync(file, JSON.stringify({ universe: { limit: 'many', theme: 'neon', colors: { bg: 'red', inner: '#aabbcc' }, crossLinks: 1 } }));
    assert.deepEqual(s.view().universe, { limit: 100, theme: 'default', colors: { inner: '#aabbcc' }, crossLinks: false, nesting: false });
  });

  it('home layout: empty by default, written next to the other keys, a hand-edited file cannot break the screen', () => {
    const s = createSettings(kit.ctx, createApprovals(kit.ctx), async () => ({ ides: [], obsidianInstalled: false, obsidianExe: null }));
    const file = join(kit.paths.config, 'settings.json');
    assert.deepEqual(s.view().home, { slots: {}, hidden: [] });
    s.setUniverse({ limit: 7 });
    const home = { slots: { left: ['projects', 'w1'], right: [] }, hidden: ['tokens'] };
    assert.deepEqual(s.setHome(home).home, home);
    const stored = JSON.parse(readFileSync(file, 'utf8'));
    assert.deepEqual(stored.home, home);
    assert.equal(stored.universe.limit, 7);
    assert.throws(() => s.setHome({ slots: { middle: ['projects'] } } as never), /bad slots/);
    assert.throws(() => s.setHome({ slots: { left: 'projects' } } as never), /bad slots/);
    assert.throws(() => s.setHome({} as never), /bad slots/);
    assert.throws(() => s.setHome({ slots: {}, hidden: 'x' } as never), /bad hidden/);
    const full = { slots: { left: ['projects'] }, hidden: ['stats'], collapsed: ['projects'], heights: { projects: 400 }, removed: ['tokens'] };
    assert.deepEqual(s.setHome(full).home, full, 'collapsed, heights and removed are kept');
    assert.deepEqual(s.setHome({ slots: {}, hidden: [], collapsed: [], heights: {}, removed: [] }).home, { slots: {}, hidden: [] }, 'empty ones leave no trace in the file');
    assert.deepEqual(s.setHome({ slots: {}, collapsed: ['a', 5, 'a'], heights: { a: 1, b: 'x', c: 100 } } as never).home, { slots: {}, hidden: [], collapsed: ['a'], heights: { c: 100 } }, 'a bad value is dropped');
    writeFileSync(file, JSON.stringify({ home: { slots: { left: ['a', 5, 'a'], right: ['a', 'b'], middle: ['c'], top: 'd' }, hidden: 'all' } }));
    assert.deepEqual(s.view().home, { slots: { left: ['a'], right: ['b'] }, hidden: [] });
    writeFileSync(file, JSON.stringify({ home: 'none' }));
    assert.deepEqual(s.view().home, { slots: {}, hidden: [] });
  });

  it('scan results are approved, an entry written into the config is not; defaults validate', async () => {
    const approvals = createApprovals(kit.ctx);
    const entry: IdeEntry = { id: 'code-1', catalogId: 'vscode', name: 'VS Code', family: 'vscode', exe: '/bin/true', side: 'linux', source: 'path', approved: true };
    const s = createSettings(kit.ctx, approvals, async () => ({ ides: [entry], obsidianInstalled: false, obsidianExe: null }));
    kit.addProject('pr', join(kit.base, 'pr'));
    const after = await s.scan();
    assert.equal(after.ides[0].approved, true);
    assert.equal(after.obsidian.installed, false);
    assert.equal(after.obsidian.dismissed, false);
    assert.equal(s.dismissObsidian().obsidian.dismissed, true);

    const file = join(kit.paths.config, 'settings.json');
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    raw.ides.list.push({ id: 'evil-1', catalogId: 'evil', name: 'Evil', family: 'plain', exe: '/bin/sh', side: 'linux', source: 'path' });
    writeFileSync(file, JSON.stringify(raw));
    assert.equal(s.view().ides.find((e) => e.id === 'evil-1')?.approved, false);
    await assert.rejects(s.open({ ide: 'evil-1', cwd: kit.base }), /approval/);
    assert.throws(() => s.setProject('pr', { ide: 'evil-1' }), /unknown ide/);
    s.approve('evil-1');
    assert.equal(s.view().ides.find((e) => e.id === 'evil-1')?.approved, true);

    assert.throws(() => s.setProject('pr', { effort: 'huge' }));
    assert.throws(() => s.setProject('pr', { model: 'a b; rm' }));
    s.setProject('pr', { model: 'claude-sonnet-5-5', effort: 'low' });
    assert.deepEqual(s.projectDefaults('pr'), { model: 'claude-sonnet-5-5', effort: 'low' });
    assert.deepEqual(s.projectDefaults('none'), { model: null, effort: null });
  });

  function setupProject() {
    const root = join(kit.base, 'pr');
    kit.addProject('pr', root);
    kit.write(join(root, '.claude/settings.json'), JSON.stringify({ model: 'opus', env: { SECRET_THING: 'hunter2-value' }, hooks: { Stop: [{ matcher: 'x', hooks: [{ type: 'command', command: 'notify' }] }] } }));
    kit.write(join(root, '.claude/settings.local.json'), JSON.stringify({ autoMemoryDirectory: '/somewhere', theme: 'dark' }));
    kit.write(join(root, '.claude/skills/front/SKILL.md'), '---\nname: front\ndescription: d\n---\n');
    kit.write(join(kit.paths.claudeDir, 'settings.json'), JSON.stringify({ model: 'sonnet' }));
    registerMemory(kit.ctx);
    registerTools(kit.ctx);
    return root;
  }

  it('shows origins, no secrets; edit with preview, backup and audit', async () => {
    const root = setupProject();
    const res = await req<ProjectSetup>('GET', '/api/projects/pr/setup');
    assert.doesNotMatch(res.text, /hunter2-value/);
    assert.deepEqual(res.body.settings.map((f) => [f.scope, f.exists]), [['project', true], ['local', true]]);
    assert.equal(res.body.hooks[0].event, 'Stop');
    assert.deepEqual(res.body.skills.map((s) => s.name), ['front']);

    const edited = res.body.settings[0].text.replace('"opus"', '"haiku"');
    const pre = await req<{ diff: string }>('POST', '/api/projects/pr/setup/preview', { scope: 'project', text: edited });
    assert.match(pre.body.diff, /\+\s+"model": "haiku"/);
    assert.doesNotMatch(pre.text, /hunter2-value/);
    assert.equal((await req('POST', '/api/projects/pr/setup/preview', { scope: 'project', text: 'nope' })).status, 400);
    assert.equal(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).model, 'opus', 'preview writes nothing');

    assert.equal((await req('PUT', '/api/projects/pr/setup/project', { text: edited })).status, 200);
    const saved = JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8'));
    assert.equal(saved.model, 'haiku');
    assert.equal(saved.env.SECRET_THING, 'hunter2-value', 'the masked value is restored');
    const audit = kit.audits.find((a) => a.action === 'project.settings')!;
    assert.doesNotMatch(audit.diff ?? '', /hunter2-value/);
    assert.ok(existsSync(join(kit.paths.data, 'backups')));
  });

  it('promote: key conflict refused, key and hook move with both diffs, skill moves and refuses a name clash', async () => {
    const root = setupProject();
    const global = () => JSON.parse(readFileSync(join(kit.paths.claudeDir, 'settings.json'), 'utf8'));

    const clash = await req<PromotePreview>('POST', '/api/projects/pr/promote/preview', { kind: 'key', scope: 'project', key: 'model' });
    assert.match(clash.body.conflict ?? '', /already set/);
    assert.equal((await req('POST', '/api/projects/pr/promote', { kind: 'key', scope: 'project', key: 'model', confirmed: true })).status, 409);
    assert.match((await req<PromotePreview>('POST', '/api/projects/pr/promote/preview', { kind: 'key', scope: 'local', key: 'autoMemoryDirectory' })).body.conflict ?? '', /belongs/);

    assert.equal((await req('POST', '/api/projects/pr/promote', { kind: 'key', scope: 'local', key: 'theme' })).status, 400, 'needs confirmed');
    const pv = await req<PromotePreview>('POST', '/api/projects/pr/promote/preview', { kind: 'key', scope: 'local', key: 'theme' });
    assert.equal(pv.body.files.length, 2);
    assert.equal((await req('POST', '/api/projects/pr/promote', { kind: 'key', scope: 'local', key: 'theme', confirmed: true })).status, 200);
    assert.equal(global().theme, 'dark');
    assert.equal(JSON.parse(readFileSync(join(root, '.claude/settings.local.json'), 'utf8')).theme, undefined);

    const hook = await req('POST', '/api/projects/pr/promote/preview', { kind: 'hook', scope: 'project', event: 'Stop', index: 0 });
    assert.equal(hook.status, 200);
    assert.equal((await req('POST', '/api/projects/pr/promote', { kind: 'hook', scope: 'project', event: 'Stop', index: 0, confirmed: true })).status, 200);
    assert.equal(global().hooks.Stop[0].hooks[0].command, 'notify');
    assert.equal(JSON.parse(readFileSync(join(root, '.claude/settings.json'), 'utf8')).hooks, undefined);

    kit.write(join(kit.paths.claudeDir, 'skills/front/SKILL.md'), 'taken');
    assert.equal((await req('POST', '/api/projects/pr/promote', { kind: 'skill', name: 'front', confirmed: true })).status, 409);
    rmSync(join(kit.paths.claudeDir, 'skills/front'), { recursive: true });
    assert.equal((await req('POST', '/api/projects/pr/promote', { kind: 'skill', name: 'front', confirmed: true })).status, 200);
    assert.ok(existsSync(join(kit.paths.claudeDir, 'skills/front/SKILL.md')));
    assert.equal(existsSync(join(root, '.claude/skills/front')), false);
  });

  it('promote: a symlinked skill stays a symlink with a working target', async () => {
    const root = setupProject();
    const shared = join(kit.base, 'shared/linked');
    kit.write(join(shared, 'SKILL.md'), '---\nname: linked\ndescription: d\n---\n');
    symlinkSync('../../../shared/linked', join(root, '.claude/skills/linked'));
    assert.equal((await req('POST', '/api/projects/pr/promote', { kind: 'skill', name: 'linked', confirmed: true })).status, 200);
    const moved = join(kit.paths.claudeDir, 'skills/linked');
    assert.ok(lstatSync(moved).isSymbolicLink());
    assert.equal(readlinkSync(moved), shared);
    assert.ok(existsSync(join(moved, 'SKILL.md')));
  });

  it('promote: MCP goes through `claude mcp` add then remove, secrets stay out of the preview', async () => {
    const root = setupProject();
    kit.write(join(root, '.mcp.json'), JSON.stringify({ mcpServers: { db: { command: 'db-server', env: { DB_TOKEN: 'tok-secret-value' } } } }));
    const log = join(kit.base, 'claude.log');
    kit.write(kit.paths.claudeBin, `#!/bin/bash\nnode -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@" >> "${log}"\n`);
    chmodSync(kit.paths.claudeBin, 0o755);
    const pre = await req<PromotePreview>('POST', '/api/projects/pr/promote/preview', { kind: 'mcp', name: 'db', scope: 'project' });
    assert.doesNotMatch(pre.text, /tok-secret-value/);
    assert.equal((await req('POST', '/api/projects/pr/promote', { kind: 'mcp', name: 'db', scope: 'project', confirmed: true })).status, 200);
    const lines = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as string[]);
    assert.deepEqual(lines[0].slice(0, 5), ['mcp', 'add-json', '--scope', 'user', 'db']);
    assert.ok(lines[0][5].includes('tok-secret-value'), 'the real value goes to the CLI');
    assert.deepEqual(lines[1], ['mcp', 'remove', '--scope', 'project', 'db']);
    assert.ok(!kit.audits.some((a) => (a.diff ?? '').includes('tok-secret-value')));
  });
});

test('microtask templates are complete', async () => {
  const { listMicrotasks } = await import('./microtasks.ts');
  const list = listMicrotasks({ paths: { root: join(import.meta.dirname, '../../root') } } as never);
  assert.deepEqual(list.map((m) => m.id).sort(), ['admin-claude-md', 'admin-hooks', 'admin-mcp', 'admin-plugins', 'admin-settings', 'admin-skills', 'admin-usage', 'admin-vault', 'crash-fix', 'git-fix', 'ide-search', 'obsidian-install', 'panel-change', 'planner-decompose', 'planner-file', 'project-check', 'project-icons', 'project-kit', 'quick-start', 'widget-change', 'widget-create']);
  assert.equal(list.find((m) => m.id === 'widget-create')?.input, 'description');
  assert.ok(list.every((m) => m.title && m.titleRu && m.prompt.length > 40));
  assert.match(list.find((m) => m.id === 'git-fix')!.prompt, /no force push/);
});

test('note rules stay small', () => {
  const words = readFileSync(join(import.meta.dirname, '../../root/NOTE_RULES.md'), 'utf8').split(/\s+/).filter(Boolean).length;
  assert.ok(words <= 150, `${words} words`);
});
