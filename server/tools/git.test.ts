// Every write here lands in a temp repo with a local bare remote.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { buildGraph } from '../../web/src/work/git/graph.ts';
import { changeRows } from '../../web/src/work/git/rows.ts';
import { gitAmendInfo, gitBranches, gitCheckout, gitCommit, gitCommitFiles, gitCompare, gitCompareDiff, gitCreateBranch, gitDeleteBranch, gitDiff, gitFetch, gitIgnore, gitLog, gitPull, gitPush, gitPushPreview, gitRenameBranch, gitRollback, gitStage, gitStashList, gitStashPop, gitStashPush, gitStatus, ignoreLine, parseRefLabels, recentBranches, validateBranchName } from './git.ts';

describe('git tools', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-os-gittools-')));
  const bare = join(dir, 'remote.git');
  const repo = join(dir, 'repo');
  const other = join(dir, 'other');
  const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const write = (name: string, text: string, cwd = repo) => writeFileSync(join(cwd, name), text);
  const identity = (cwd: string) => {
    g(cwd, 'config', 'user.email', 't@e.st');
    g(cwd, 'config', 'user.name', 'T');
    g(cwd, 'config', 'credential.helper', '');
    g(cwd, 'config', 'core.autocrlf', 'false');
    g(cwd, 'config', 'core.eol', 'lf');
  };
  const commitAll = (msg: string, cwd = repo) => {
    g(cwd, 'add', '-A');
    g(cwd, 'commit', '-qm', msg);
  };

  before(() => {
    g(dir, 'init', '-q', '--bare', '-b', 'main', bare);
    mkdirSync(repo);
    g(repo, 'init', '-q', '-b', 'main');
    identity(repo);
    write('a.txt', 'one\n');
    write('b.txt', 'bee\n');
    commitAll('first');
    g(repo, 'remote', 'add', 'origin', bare);
    g(repo, 'push', '-q', '-u', 'origin', 'main');
    g(dir, 'clone', '-q', '-c', 'core.autocrlf=false', bare, other);
    identity(other);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  it('branch names: no options, no ref syntax', () => {
    for (const bad of ['-D', '--force', 'a b', 'a..b', 'a~1', 'a^', 'a:b', 'a?', 'a*', 'a[', 'a\\b', '/a', 'a/', 'a//b', '.a', 'a/.b', 'a.lock', 'a.lock/b', 'a.', 'HEAD', '@', 'a@{1}', '', 5, null, 'x\ny', 'a'.repeat(256)]) {
      assert.throws(() => validateBranchName(bad), (e: Error & { statusCode?: number }) => e.statusCode === 400, String(bad));
    }
    for (const ok of ['main', 'feature/x-1', 'fix_2.0', 'ветка', 'a@b']) assert.equal(validateBranchName(ok), ok);
  });

  it('fetch: --all --prune, last fetch time, deleted remote branches go', async () => {
    g(other, 'push', '-q', 'origin', 'HEAD:refs/heads/gone-soon');
    g(other, 'push', '-q', 'origin', 'HEAD:refs/heads/remote-only');
    await gitFetch(repo);
    let b = await gitBranches(repo);
    assert.deepEqual(b.remote.map((r) => r.name), ['origin/gone-soon', 'origin/main', 'origin/remote-only']);
    g(other, 'push', '-q', 'origin', ':refs/heads/gone-soon');
    await gitFetch(repo);
    b = await gitBranches(repo);
    assert.deepEqual(b.remote.map((r) => r.name), ['origin/main', 'origin/remote-only']);
    const st = await gitStatus(repo);
    assert.ok(st.isRepo);
    assert.ok(st.lastFetch && Date.now() - st.lastFetch < 60_000);
  });

  it('fetch does not hang on a credential prompt: a 401 fails at once, a dead remote at the timeout', async () => {
    const server = createServer((_req, res) => res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="x"' }).end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const auth = join(dir, 'auth');
    g(dir, 'init', '-q', auth);
    g(auth, 'config', 'credential.helper', '');
    g(auth, 'remote', 'add', 'origin', `http://127.0.0.1:${(server.address() as AddressInfo).port}/x.git`);
    const t0 = Date.now();
    await assert.rejects(gitFetch(auth, 15_000), /terminal prompts disabled|could not read Username|Authentication failed/);
    assert.ok(Date.now() - t0 < 10_000);
    server.close();

    const stuck = join(dir, 'stuck');
    g(dir, 'init', '-q', stuck);
    g(stuck, 'config', 'protocol.ext.allow', 'always');
    g(stuck, 'remote', 'add', 'origin', 'ext::sleep 60');
    const t1 = Date.now();
    await assert.rejects(gitFetch(stuck, 700), /no answer in/);
    assert.ok(Date.now() - t1 < 5_000, 'the timer ends the request, not the process that outlives it');
  });

  it('pull is --ff-only: a clean update passes, diverged history is refused verbatim', async () => {
    write('c.txt', 'c\n', other);
    commitAll('theirs', other);
    g(other, 'push', '-q');
    await gitFetch(repo);
    const b = await gitBranches(repo);
    assert.equal(b.local.find((x) => x.name === 'main')?.behind, 1);
    await gitPull(repo);
    assert.equal(g(repo, 'log', '-1', '--format=%s'), 'theirs');

    write('d.txt', 'd\n', other);
    commitAll('theirs 2', other);
    g(other, 'push', '-q');
    write('e.txt', 'e\n');
    commitAll('ours');
    const head = g(repo, 'rev-parse', 'HEAD');
    await assert.rejects(gitPull(repo), /Not possible to fast-forward|fatal/);
    assert.equal(g(repo, 'rev-parse', 'HEAD'), head);
    const after = await gitBranches(repo);
    const main = after.local.find((x) => x.name === 'main');
    assert.equal(main?.ahead, 1);
    assert.equal(main?.behind, 1);
    assert.equal(main?.current, true);
    assert.equal(main?.upstream, 'origin/main');
    g(repo, 'merge', '-q', '--no-edit', 'origin/main');
    g(repo, 'push', '-q');
  });

  it('branches: new, checkout, recent, rename, delete -d; a refusal stays verbatim', async () => {
    await gitCreateBranch(repo, 'feature/one', undefined, true);
    assert.equal(g(repo, 'branch', '--show-current'), 'feature/one');
    assert.throws(() => g(repo, 'rev-parse', '--abbrev-ref', '@{u}'), 'no upstream on a new branch');
    write('f1.txt', 'x\n');
    commitAll('on one');
    await gitCheckout(repo, 'main');
    await gitCreateBranch(repo, 'side', 'feature/one', false);
    assert.equal(g(repo, 'branch', '--show-current'), 'main', 'not checked out on request');
    assert.equal(g(repo, 'rev-parse', 'side'), g(repo, 'rev-parse', 'feature/one'));

    await gitCheckout(repo, 'origin/remote-only');
    assert.equal(g(repo, 'branch', '--show-current'), 'remote-only');
    assert.equal(g(repo, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/remote-only');
    await gitCheckout(repo, 'main');
    const b = await gitBranches(repo);
    assert.equal(b.current, 'main');
    assert.deepEqual(b.recent, ['remote-only', 'feature/one']);

    await assert.rejects(gitCheckout(repo, 'no-such'), /no such branch/);
    await assert.rejects(gitCheckout(repo, '--orphan'), /bad branch name/);
    await assert.rejects(gitCreateBranch(repo, 'main', undefined, true), /already exists/);
    await gitRenameBranch(repo, 'side', 'side2');
    await assert.rejects(gitRenameBranch(repo, 'side2', 'main'), /already exists/);
    await assert.rejects(gitRenameBranch(repo, 'origin/main', 'x'), /only a local/);
    assert.equal(g(repo, 'rev-parse', 'side2'), g(repo, 'rev-parse', 'feature/one'));

    await assert.rejects(gitDeleteBranch(repo, 'side2'), /not fully merged/);
    assert.ok(g(repo, 'rev-parse', 'side2'), 'an unmerged branch survives');
    await assert.rejects(gitDeleteBranch(repo, 'main'), /checked out|Cannot delete/);
    await assert.rejects(gitDeleteBranch(repo, 'origin/main'), /only a local/);
    await gitDeleteBranch(repo, 'remote-only');
    assert.ok(!g(repo, 'branch', '--list', 'remote-only'));
  });

  it('compare with current: commits both ways and files', async () => {
    const c = await gitCompare(repo, 'feature/one');
    assert.deepEqual(c.incoming.map((x) => x.subject), ['on one']);
    assert.deepEqual(c.outgoing, []);
    assert.deepEqual(c.files.map((f) => [f.status, f.path]), [['A', 'f1.txt']]);
    assert.match((await gitCompareDiff(repo, 'feature/one', 'f1.txt')).diff, /^\+x$/m);
    await assert.rejects(gitCompare(repo, '--all'), /bad branch/);
    await assert.rejects(gitCompareDiff(repo, 'main', '../x'), /bad path/);
  });

  it('log: labels, parents, limit, full message of a commit', async () => {
    g(repo, 'tag', 'v1');
    const log = await gitLog(repo, 3);
    assert.equal(log.commits.length, 3);
    assert.equal(log.more, true);
    const all = (await gitLog(repo, 2000)).commits;
    const head = all.find((c) => c.refs.some((r) => r.kind === 'head'))!;
    assert.deepEqual(head.refs.find((r) => r.kind === 'head')?.name, 'main');
    assert.ok(head.refs.some((r) => r.kind === 'tag' && r.name === 'v1'));
    assert.ok(all.some((c) => c.refs.some((r) => r.kind === 'remote' && r.name === 'origin/main')));
    assert.ok(all.some((c) => c.refs.some((r) => r.kind === 'local' && r.name === 'feature/one')));
    assert.ok(all.some((c) => c.parents.length === 2), 'a merge has two parents');
    assert.equal(all.at(-1)?.parents.length, 0);
    assert.equal((await gitCommitFiles(repo, head.hash)).message, g(repo, 'log', '-1', '--format=%B'));
    assert.deepEqual(parseRefLabels('HEAD -> refs/heads/m, tag: refs/tags/t, refs/remotes/o/m, refs/remotes/o/HEAD, refs/heads/x'), [
      { name: 'm', kind: 'head' }, { name: 't', kind: 'tag' }, { name: 'o/m', kind: 'remote' }, { name: 'x', kind: 'local' },
    ]);
    const empty = join(dir, 'empty');
    g(dir, 'init', '-q', empty);
    assert.deepEqual((await gitLog(empty, 10)).commits, []);
    assert.deepEqual((await gitBranches(empty)).local, []);
  });

  it('amend: asks when the commit is on a remote, no trailers either way', async () => {
    g(repo, 'status');
    let info = await gitAmendInfo(repo);
    assert.equal(info.pushed, true);
    const pushedHead = g(repo, 'rev-parse', 'HEAD');
    await assert.rejects(gitCommit(repo, 'rewrite', { amend: true }), /confirm the amend/);
    assert.equal(g(repo, 'rev-parse', 'HEAD'), pushedHead);

    write('g.txt', 'g\n');
    await gitStage(repo, ['g.txt']);
    await gitCommit(repo, 'plain message');
    assert.equal(g(repo, 'log', '-1', '--format=%B'), 'plain message');
    info = await gitAmendInfo(repo);
    assert.deepEqual(info, { message: 'plain message', pushed: false });
    await gitCommit(repo, 'plain message, amended', { amend: true });
    assert.equal(g(repo, 'log', '-1', '--format=%B'), 'plain message, amended');
    assert.equal(g(repo, 'log', '-1', '--format=%(trailers)'), '');
    assert.equal(g(repo, 'rev-list', '--count', `${pushedHead}..HEAD`), '1');
    await gitPush(repo, { branch: 'main', remote: 'origin', ahead: 1 });
    await gitCommit(repo, 'rewritten after push', { amend: true, pushedConfirmed: true });
    await assert.rejects(gitPush(repo, { branch: 'main', remote: 'origin', ahead: 1 }), /rejected|fetch first|non-fast-forward/);
    assert.equal(g(bare, 'log', '-1', '--format=%s', 'main'), 'plain message, amended', 'the remote is untouched: no force');
    g(repo, 'pull', '-q', '--no-rebase', '--no-edit');
    g(repo, 'push', '-q');
  });

  it('push: a new branch reaches a remote only by the explicit publish', async () => {
    await gitCreateBranch(repo, 'to-publish', undefined, true);
    write('p.txt', 'p\n');
    commitAll('publish me');
    const p = await gitPushPreview(repo);
    assert.equal(p.upstream, null);
    assert.deepEqual(p.remotes, ['origin']);
    assert.deepEqual(p.commits.map((c) => c.subject), ['publish me']);
    await assert.rejects(gitPush(repo, { branch: 'to-publish', remote: null, ahead: 0 }), /no upstream/);
    assert.equal(g(bare, 'branch', '--list', 'to-publish'), '');
    await assert.rejects(gitPush(repo, { branch: 'to-publish', remote: null, ahead: 0, publish: 'elsewhere' }), /changed/);
    await gitPush(repo, { branch: 'to-publish', remote: null, ahead: 0, publish: 'origin' });
    assert.equal(g(bare, 'log', '-1', '--format=%s', 'to-publish'), 'publish me');
    assert.equal(g(repo, 'rev-parse', '--abbrev-ref', '@{u}'), 'origin/to-publish');
    await gitCheckout(repo, 'main');
  });

  it('rollback: only the named file, and glob characters mean themselves', async () => {
    write('a.txt', 'changed a\n');
    write('b.txt', 'changed b\n');
    write('*', 'star\n');
    write('kept.txt', 'kept\n');
    await gitStage(repo, ['*']);
    g(repo, 'commit', '-qm', 'add star');
    write('*', 'star changed\n');
    await gitRollback(repo, '*');
    assert.equal(readFileSync(join(repo, '*'), 'utf8'), 'star\n');
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'changed a\n', 'a neighbour stays');

    await gitStage(repo, ['a.txt']);
    write('a.txt', 'changed again\n');
    await gitRollback(repo, 'a.txt');
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'one\n');
    assert.equal(g(repo, 'diff', '--cached', '--name-only'), '', 'and the index with it');
    assert.equal(readFileSync(join(repo, 'b.txt'), 'utf8'), 'changed b\n');
    await gitRollback(repo, 'b.txt');

    write('fresh.txt', 'mine\n');
    await gitStage(repo, ['fresh.txt']);
    write('fresh.txt', 'mine, edited\n');
    await gitRollback(repo, 'fresh.txt');
    assert.equal(readFileSync(join(repo, 'fresh.txt'), 'utf8'), 'mine, edited\n', 'a new file leaves the index, its content stays');
    assert.match(g(repo, 'status', '--porcelain', '--', 'fresh.txt'), /^\?\?/);

    await assert.rejects(gitRollback(repo, 'kept.txt'), /not in git/);
    assert.ok(existsSync(join(repo, 'kept.txt')));
    await assert.rejects(gitRollback(repo, '../x'), /bad path/);
    mkdirSync(join(repo, 'dir'));
    write('dir/x', 'x\n');
    commitAll('dir and more');
    write('dir/x', 'y\n');
    await assert.rejects(gitRollback(repo, 'dir'), /folder/);
    assert.equal(readFileSync(join(repo, 'dir/x'), 'utf8'), 'y\n');
    g(repo, 'checkout', '-q', '--', 'dir/x');
  });

  it('.gitignore: untracked only, anchored, escaped, once', async () => {
    assert.equal(ignoreLine('a/b*.log'), '/a/b\\*.log');
    write('tmp 1.log', 'x');
    write('w[1].log', 'x');
    await gitIgnore(repo, 'tmp 1.log');
    await gitIgnore(repo, 'w[1].log');
    const lines = readFileSync(join(repo, '.gitignore'), 'utf8').split('\n');
    assert.deepEqual(lines, ['/tmp 1.log', '/w\\[1].log', '']);
    assert.equal(g(repo, 'status', '--porcelain', '--', 'tmp 1.log', 'w[1].log'), '');
    await assert.rejects(gitIgnore(repo, 'tmp 1.log'), /only an untracked/);
    await assert.rejects(gitIgnore(repo, 'a.txt'), /only an untracked/);
    await assert.rejects(gitIgnore(repo, '../x'), /bad path/);
    commitAll('ignore');
  });

  it('a dirty tree: the refusal comes back verbatim, stash then checkout works, unstash brings it back', async () => {
    write('a.txt', 'on b\n');
    commitAll('a differs');
    await gitCreateBranch(repo, 'old-a', 'origin/main', false);
    write('a.txt', 'dirty\n');
    await assert.rejects(gitCheckout(repo, 'old-a'), /would be overwritten by checkout/);
    assert.equal(g(repo, 'branch', '--show-current'), 'main');
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'dirty\n');

    await gitStashPush(repo, 'before old-a', false);
    const list = await gitStashList(repo);
    assert.equal(list.length, 1);
    assert.equal(list[0].ref, 'stash@{0}');
    assert.match(list[0].subject, /before old-a/);
    await gitCheckout(repo, 'old-a');
    assert.equal(g(repo, 'branch', '--show-current'), 'old-a');
    await gitCheckout(repo, 'main');
    await gitStashPop(repo, 'stash@{0}');
    assert.equal(readFileSync(join(repo, 'a.txt'), 'utf8'), 'dirty\n');
    assert.deepEqual(await gitStashList(repo), []);
    g(repo, 'checkout', '-q', '--', 'a.txt');

    write('u.txt', 'u\n');
    await gitStashPush(repo, 'with untracked', true);
    assert.equal(existsSync(join(repo, 'u.txt')), false);
    await gitStashPop(repo, 'stash@{0}');
    assert.equal(existsSync(join(repo, 'u.txt')), true);
    rmSync(join(repo, 'u.txt'));

    for (const bad of ['stash@{0}; x', '--all', 'HEAD', 5]) await assert.rejects(gitStashPop(repo, bad), /bad stash/);
    await assert.rejects(gitStashPush(repo, '', false), /message/);
  });

  it('a partly staged file: the head diff covers both parts; symlink .gitignore is refused', async () => {
    write('b.txt', 'bee\nstaged\n');
    await gitStage(repo, ['b.txt']);
    write('b.txt', 'bee\nstaged\nworking\n');
    const d = await gitDiff(repo, 'b.txt', 'head');
    assert.match(d.diff, /^\+staged$/m);
    assert.match(d.diff, /^\+working$/m);
    const st = await gitStatus(repo);
    assert.ok(st.isRepo);
    const row = changeRows(st).changes.find((r) => r.path === 'b.txt');
    assert.equal(row?.state, 'partial');
    g(repo, 'restore', '--staged', '--worktree', '--source=HEAD', '--', 'b.txt');

    const linked = join(dir, 'linked');
    g(dir, 'init', '-q', linked);
    writeFileSync(join(dir, 'outside-ignore'), '');
    symlinkSync(join(dir, 'outside-ignore'), join(linked, '.gitignore'));
    writeFileSync(join(linked, 'f'), 'f');
    await assert.rejects(gitIgnore(linked, 'f'), /symlink/);
    assert.equal(readFileSync(join(dir, 'outside-ignore'), 'utf8'), '');
  });

  it('source: no force delete, no force push, no hard reset', () => {
    const src = readFileSync(join(import.meta.dirname, 'git.ts'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(src, /--force|'-f'|'-D'|'-M'|'-B'|'reset'|'clean'|--hard|--no-verify|Co-authored/);
  });

  it('recent branches come from the reflog, newest first, without the current one or deleted ones', () => {
    const reflog = ['checkout: moving from b to main', 'commit: x', 'checkout: moving from gone to b', 'checkout: moving from main to gone', 'checkout: moving from c to main', 'checkout: moving from b to c'].join('\n');
    assert.deepEqual(recentBranches(reflog, new Set(['main', 'b', 'c']), 'main'), ['b', 'c']);
  });

  it('graph: a straight line stays in one lane, a merge opens and closes a second one', () => {
    const c = (hash: string, ...parents: string[]) => ({ hash, parents });
    const line = buildGraph([c('c', 'b'), c('b', 'a'), c('a')]);
    assert.deepEqual(line.map((r) => r.lane), [0, 0, 0]);
    assert.equal(line[2].bottom.length, 0, 'a root ends its lane');

    const merge = buildGraph([c('m', 'a', 'b'), c('b', 'r'), c('a', 'r'), c('r')]);
    assert.deepEqual(merge[0].bottom.map((e) => [e.from, e.to]), [[0, 0], [0, 1]]);
    assert.equal(merge[1].lane, 1);
    assert.equal(merge[2].lane, 0);
    assert.deepEqual(merge[2].bottom.map((e) => [e.from, e.to]), [[0, 1], [1, 1]]);
    assert.equal(merge[3].lane, 1);
    assert.equal(merge[3].width, 2);
    assert.equal(merge[3].bottom.length, 0);
  });
});
