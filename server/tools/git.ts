// Direct git, argv only. Reads never take locks or run repo-configured programs. Writes are limited to the one action
// the click asked for. No force, no reset, no clean, anywhere. Paths are literal: a file named `*` is that one file.
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, openSync, readFileSync, readSync, closeSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, normalize, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import type { GitAmendInfo, GitBranch, GitBranches, GitCommit, GitCompare, GitDiff, GitFile, GitLog, GitLogCommit, GitPushPreview, GitRefLabel, GitStash, GitStatus } from '../../shared/contract.ts';
import { httpError, safely } from '../memory/util.ts';

const run = promisify(execFile);

const READ_FLAGS = ['--no-pager', '--no-optional-locks', '--literal-pathspecs', '-c', 'core.fsmonitor=false', '-c', 'core.pager=cat', '-c', 'color.ui=false'];
const DIFF_FLAGS = ['--no-ext-diff', '--no-textconv', '--no-color'];
const ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C.UTF-8' };
const WRITE_ENV = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C.UTF-8' };
const MAX_LIST = 2000;
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_PATHS = MAX_LIST;
const COMMITS = 30;
const SHA = /^[0-9a-f]{7,64}$/;
const FETCH_TIMEOUT = 120_000;
const PUSH_TIMEOUT = 300_000;
const MAX_LOG = 2000;
const RECENT_BRANCHES = 5;
const STASH_REF = /^stash@\{\d{1,6}\}$/;

export function validateRepoPath(path: unknown): string {
  if (typeof path !== 'string' || path === '' || path.length > 4096 || path.includes('\0') || isAbsolute(path)) throw httpError(400, 'bad path');
  const clean = normalize(path);
  if (clean === '..' || clean.startsWith(`..${sep}`) || path.split(/[\\/]/).includes('..') || clean === '.git' || clean.startsWith(`.git${sep}`)) throw httpError(400, 'bad path');
  return clean;
}

export function validateSha(hash: unknown): string {
  if (typeof hash !== 'string' || !SHA.test(hash)) throw httpError(400, 'bad commit');
  return hash;
}

// What `git check-ref-format --branch` refuses, plus a leading dash: a name never reaches argv as an option.
export function validateBranchName(name: unknown): string {
  if (typeof name !== 'string' || name === '' || name.length > 255 || name === 'HEAD' || name === '@') throw httpError(400, 'bad branch name');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x20\x7f~^:?*[\\]|\.\.|@\{|\/\/|^[-/.]|\/\.|\.lock(\/|$)|[/.]$/.test(name)) throw httpError(400, 'bad branch name');
  return name;
}

async function read(cwd: string, args: string[], maxBuffer = MAX_BUFFER): Promise<string> {
  const { stdout } = await run('git', [...READ_FLAGS, '-C', cwd, ...args], { env: ENV, timeout: 20_000, maxBuffer, encoding: 'utf8' });
  return stdout;
}

async function write(cwd: string, args: string[], timeout = 120_000): Promise<string> {
  try {
    const { stdout, stderr } = await run('git', ['--no-pager', '--literal-pathspecs', '-C', cwd, ...args], { env: WRITE_ENV, timeout, maxBuffer: MAX_BUFFER, encoding: 'utf8' });
    return (stdout + stderr).trim();
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    // Verbatim: a hook's output or git's own hint is exactly what the user needs to read.
    throw httpError(422, `${e.stderr ?? ''}${e.stdout ?? ''}`.trim() || e.message);
  }
}

// Talks to a remote: argv with no shell, like the others. spawn, not execFile, because only spawn gives the child its own
// session: no terminal, so ssh cannot ask for anything, and the timer takes the whole group, helpers holding the pipes too.
function remote(cwd: string, args: string[], timeout: number): Promise<string> {
  return new Promise((done, fail) => {
    const group = process.platform !== 'win32';
    const child = spawn('git', ['--no-pager', '--literal-pathspecs', '-C', cwd, ...args], { env: WRITE_ENV, detached: group, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    const keep = (chunk: Buffer) => {
      if (out.length < MAX_BUFFER) out += chunk.toString('utf8');
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => {
      fail(httpError(422, `git ${args[0]}: no answer in ${Math.round(timeout / 1000)} s. The remote is unreachable or is waiting for credentials.\n${out}`.trim()));
      try {
        if (group && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch { /* already gone */ }
    }, timeout);
    child.on('error', (err) => {
      clearTimeout(timer);
      fail(httpError(422, err.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) done(out.trim());
      else fail(httpError(422, out.trim() || `git ${args[0]} failed`));
    });
  });
}

export function parseStatusV2(raw: string) {
  const out = { branch: null as string | null, upstream: null as string | null, ahead: null as number | null, behind: null as number | null, staged: [] as GitFile[], unstaged: [] as GitFile[], untracked: [] as GitFile[], truncated: false };
  const parts = raw.split('\0');
  const push = (list: GitFile[], f: GitFile) => {
    if (list.length < MAX_LIST) list.push(f);
    else out.truncated = true;
  };
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      const v = line.slice(14);
      out.branch = v === '(detached)' ? null : v;
    } else if (line.startsWith('# branch.upstream ')) out.upstream = line.slice(18);
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) { out.ahead = Number(m[1]); out.behind = Number(m[2]); }
    } else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      const fields = line.split(' ');
      const xy = fields[1];
      const renamed = line[0] === '2';
      const path = fields.slice(renamed ? 9 : 8).join(' ');
      const oldPath = renamed ? parts[++i] : null;
      if (xy[0] !== '.') push(out.staged, { path, oldPath, status: xy[0] });
      if (xy[1] !== '.') push(out.unstaged, { path, oldPath, status: xy[1] });
    } else if (line.startsWith('u ')) {
      push(out.unstaged, { path: line.split(' ').slice(10).join(' '), oldPath: null, status: 'U' });
    } else if (line.startsWith('? ')) {
      push(out.untracked, { path: line.slice(2), oldPath: null, status: '?' });
    }
  }
  return out;
}

export function parseLog(raw: string): GitCommit[] {
  return raw.split('\0\n').concat().map((rec) => rec.split('\0')).filter((f) => f.length >= 5 && f[0]).map(([hash, short, subject, author, at]) => ({ hash: hash.trim(), short, subject, author, at: Number(at) * 1000 }));
}

const LOG_FORMAT = '--format=%H%x00%h%x00%s%x00%an%x00%at%x00';

function capDiff(raw: string, path: string, overflow = false): GitDiff {
  const binary = /^Binary files .* differ$/m.test(raw.slice(0, 4096)) || /^GIT binary patch$/m.test(raw.slice(0, 4096));
  const truncated = overflow || raw.length > MAX_DIFF_BYTES;
  return { path, binary, truncated, diff: binary ? '' : truncated ? raw.slice(0, MAX_DIFF_BYTES) : raw };
}

async function diffCommand(cwd: string, args: string[], path: string): Promise<GitDiff> {
  try {
    return capDiff(await read(cwd, args), path);
  } catch (err) {
    const e = err as { code?: string; stdout?: string };
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return capDiff(e.stdout ?? '', path, true);
    throw httpError(422, (err as Error).message);
  }
}

async function toplevel(cwd: string): Promise<string | null> {
  try {
    return (await read(cwd, ['rev-parse', '--show-toplevel'])).trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw Object.assign(new Error('git missing'), { gitMissing: true });
    return null;
  }
}

async function needRoot(cwd: string): Promise<string> {
  const root = await toplevel(cwd);
  if (!root) throw httpError(409, 'not a git repository');
  return root;
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  let root: string | null;
  try {
    root = await toplevel(cwd);
  } catch {
    return { isRepo: false, reason: 'git_missing' };
  }
  if (!root) return { isRepo: false, reason: 'not_a_repo' };
  const status = parseStatusV2(await read(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']));
  const commits = await read(root, ['log', `-n${COMMITS}`, LOG_FORMAT]).then(parseLog, () => []); // no commits yet
  return { isRepo: true, root, ...status, commits, lastFetch: await lastFetch(root) };
}

async function lastFetch(root: string): Promise<number | null> {
  const file = await read(root, ['rev-parse', '--git-path', 'FETCH_HEAD']).then((v) => v.trim(), () => '');
  return file ? safely(() => statSync(resolve(root, file)).mtimeMs, null) : null;
}

// Reading an untracked file ourselves: nothing about it is in git yet. A symlink out of the repo is not followed.
function untrackedDiff(root: string, path: string): GitDiff {
  const full = join(root, path);
  const st = safely(() => lstatSync(full), null);
  if (!st) throw httpError(404, 'file not found');
  if (st.isSymbolicLink()) return { path, binary: false, truncated: false, diff: `+-> ${safely(() => readlinkSync(full), '?')}` };
  const realRoot = realpathSync(root);
  if (!realpathSync(full).startsWith(realRoot + sep)) throw httpError(400, 'bad path');
  if (st.isDirectory()) return { path, binary: true, truncated: false, diff: '' };
  const fd = openSync(full, 'r');
  try {
    const buf = Buffer.alloc(Math.min(st.size, MAX_DIFF_BYTES));
    const n = readSync(fd, buf, 0, buf.length, 0);
    if (buf.subarray(0, n).includes(0)) return { path, binary: true, truncated: false, diff: '' };
    const lines = buf.toString('utf8', 0, n).split('\n');
    if (lines.at(-1) === '') lines.pop();
    return { path, binary: false, truncated: st.size > MAX_DIFF_BYTES, diff: [`--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)].join('\n') };
  } finally {
    closeSync(fd);
  }
}

export async function gitDiff(cwd: string, rawPath: unknown, area: unknown): Promise<GitDiff> {
  const root = await needRoot(cwd);
  const path = validateRepoPath(rawPath);
  if (area === 'untracked') return untrackedDiff(root, path);
  if (area !== 'staged' && area !== 'unstaged' && area !== 'head') throw httpError(400, 'bad area');
  return diffCommand(root, ['diff', ...DIFF_FLAGS, ...(area === 'staged' ? ['--cached'] : area === 'head' ? ['HEAD'] : []), '--', path], path);
}

export function parseNameStatus(raw: string): GitFile[] {
  const parts = raw.split('\0').filter(Boolean);
  const out: GitFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (status[0] === 'R' || status[0] === 'C') {
      out.push({ status: status[0], oldPath: parts[++i], path: parts[++i] });
    } else out.push({ status: status[0], oldPath: null, path: parts[++i] });
  }
  return out;
}

export async function gitCommitFiles(cwd: string, hash: unknown): Promise<{ files: GitFile[]; message: string }> {
  const root = await needRoot(cwd);
  const sha = validateSha(hash);
  const raw = await read(root, ['show', ...DIFF_FLAGS, '--first-parent', '-m', '--format=', '--name-status', '-z', sha, '--']);
  const message = await read(root, ['show', '-s', '--format=%B', sha, '--']);
  return { files: parseNameStatus(raw).slice(0, MAX_LIST), message: message.trim() };
}

export async function gitCommitDiff(cwd: string, hash: unknown, rawPath: unknown): Promise<GitDiff> {
  const root = await needRoot(cwd);
  const path = validateRepoPath(rawPath);
  return diffCommand(root, ['show', ...DIFF_FLAGS, '--first-parent', '-m', '--format=', validateSha(hash), '--', path], path);
}

function validatePaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_PATHS) throw httpError(400, 'paths are required');
  return paths.map(validateRepoPath);
}

export async function gitStage(cwd: string, paths: unknown): Promise<string> {
  const root = await needRoot(cwd);
  return write(root, ['add', '--', ...validatePaths(paths)]);
}

export async function gitUnstage(cwd: string, paths: unknown): Promise<string> {
  const root = await needRoot(cwd);
  const list = validatePaths(paths);
  const hasHead = await read(root, ['rev-parse', '--verify', '-q', 'HEAD']).then(() => true, () => false);
  return write(root, hasHead ? ['restore', '--staged', '--', ...list] : ['rm', '--cached', '-q', '--', ...list]);
}

async function headPushed(root: string): Promise<boolean> {
  return read(root, ['branch', '-r', '--contains', 'HEAD', '--format=%(refname)']).then((v) => v.trim() !== '', () => false);
}

export async function gitAmendInfo(cwd: string): Promise<GitAmendInfo> {
  const root = await needRoot(cwd);
  const message = await read(root, ['show', '-s', '--format=%B', 'HEAD', '--']).catch(() => {
    throw httpError(409, 'there is no commit to amend');
  });
  return { message: message.trim(), pushed: await headPushed(root) };
}

export async function gitCommit(cwd: string, message: unknown, opts: { amend?: unknown; pushedConfirmed?: unknown } = {}): Promise<string> {
  if (typeof message !== 'string' || !message.trim() || message.length > 64 * 1024) throw httpError(400, 'a commit message is required');
  const root = await needRoot(cwd);
  if (opts.amend === true && opts.pushedConfirmed !== true && await headPushed(root)) throw httpError(409, 'this commit is already on a remote: confirm the amend first');
  // Whatever the repo's own hooks and config do, stays: this is the console command, nothing added to the message.
  return write(root, ['commit', ...(opts.amend === true ? ['--amend'] : []), '-m', message]);
}

export async function gitFetch(cwd: string, timeout = FETCH_TIMEOUT): Promise<string> {
  return remote(await needRoot(cwd), ['fetch', '--all', '--prune'], timeout);
}

export async function gitPull(cwd: string, timeout = FETCH_TIMEOUT): Promise<string> {
  return remote(await needRoot(cwd), ['pull', '--ff-only'], timeout);
}

async function refExists(root: string, full: string): Promise<boolean> {
  return read(root, ['rev-parse', '--verify', '-q', `${full}^{commit}`]).then(() => true, () => false);
}

async function resolveBranch(root: string, raw: unknown): Promise<{ name: string; kind: 'local' | 'remote'; full: string }> {
  const name = validateBranchName(raw);
  if (await refExists(root, `refs/heads/${name}`)) return { name, kind: 'local', full: `refs/heads/${name}` };
  if (await refExists(root, `refs/remotes/${name}`)) return { name, kind: 'remote', full: `refs/remotes/${name}` };
  throw httpError(404, `no such branch: ${name}`);
}

const REF_FORMAT = '--format=%(refname)%00%(objectname:short)%00%(committerdate:unix)%00%(upstream:short)%00%(upstream:track)%00%(HEAD)%00%(contents:subject)';

export function parseBranches(raw: string): GitBranch[] {
  const out: GitBranch[] = [];
  for (const line of raw.split('\n')) {
    const [ref, short, at, upstream, track, head, subject] = line.split('\0');
    if (!ref || ref.endsWith('/HEAD')) continue;
    const local = ref.startsWith('refs/heads/');
    out.push({
      name: ref.slice(local ? 11 : 13),
      kind: local ? 'local' : 'remote',
      current: head === '*',
      short,
      at: Number(at) * 1000,
      subject: subject ?? '',
      upstream: upstream || null,
      ahead: Number(/ahead (\d+)/.exec(track)?.[1] ?? 0),
      behind: Number(/behind (\d+)/.exec(track)?.[1] ?? 0),
      gone: track === '[gone]',
    });
  }
  return out;
}

export function recentBranches(reflog: string, known: Set<string>, current: string | null): string[] {
  const out: string[] = [];
  for (const line of reflog.split('\n')) {
    const m = /^checkout: moving from (\S+) to /.exec(line);
    if (m && m[1] !== current && known.has(m[1]) && !out.includes(m[1])) out.push(m[1]);
    if (out.length === RECENT_BRANCHES) break;
  }
  return out;
}

export async function gitBranches(cwd: string): Promise<GitBranches> {
  const root = await needRoot(cwd);
  const all = parseBranches(await read(root, ['for-each-ref', '--sort=refname', `--count=${MAX_LIST}`, REF_FORMAT, 'refs/heads', 'refs/remotes']));
  const local = all.filter((b) => b.kind === 'local');
  const current = local.find((b) => b.current)?.name ?? null;
  const reflog = await read(root, ['reflog', 'show', '-n300', '--format=%gs', 'HEAD']).catch(() => '');
  return { current, recent: recentBranches(reflog, new Set(local.map((b) => b.name)), current), local, remote: all.filter((b) => b.kind === 'remote'), truncated: all.length >= MAX_LIST };
}

export async function gitCheckout(cwd: string, branch: unknown): Promise<string> {
  const root = await needRoot(cwd);
  const b = await resolveBranch(root, branch);
  return write(root, b.kind === 'local' ? ['checkout', b.name, '--'] : ['checkout', '--track', b.name, '--']);
}

export async function gitCreateBranch(cwd: string, name: unknown, from: unknown, checkout: unknown): Promise<string> {
  const root = await needRoot(cwd);
  const next = validateBranchName(name);
  const start = from === undefined || from === null ? [] : [(await resolveBranch(root, from)).full];
  // --no-track: a push from a new branch must not land on the branch it started from.
  return write(root, checkout === false ? ['branch', '--no-track', next, ...(start.length ? start : ['HEAD'])] : ['checkout', '--no-track', '-b', next, ...start, '--']);
}

export async function gitRenameBranch(cwd: string, from: unknown, to: unknown): Promise<string> {
  const root = await needRoot(cwd);
  const b = await resolveBranch(root, from);
  if (b.kind !== 'local') throw httpError(400, 'only a local branch can be renamed');
  return write(root, ['branch', '-m', b.name, validateBranchName(to)]);
}

export async function gitDeleteBranch(cwd: string, branch: unknown): Promise<string> {
  const root = await needRoot(cwd);
  const b = await resolveBranch(root, branch);
  if (b.kind !== 'local') throw httpError(400, 'only a local branch can be deleted');
  return write(root, ['branch', '-d', b.name]);
}

export async function gitCompare(cwd: string, ref: unknown): Promise<GitCompare> {
  const root = await needRoot(cwd);
  const b = await resolveBranch(root, ref);
  const [incoming, outgoing, files] = await Promise.all([
    read(root, ['log', '-n200', LOG_FORMAT, `HEAD..${b.full}`]).then(parseLog),
    read(root, ['log', '-n200', LOG_FORMAT, `${b.full}..HEAD`]).then(parseLog),
    read(root, ['diff', ...DIFF_FLAGS, '--name-status', '-z', 'HEAD', b.full, '--']).then(parseNameStatus),
  ]);
  return { ref: b.name, incoming, outgoing, files: files.slice(0, MAX_LIST) };
}

export async function gitCompareDiff(cwd: string, ref: unknown, rawPath: unknown): Promise<GitDiff> {
  const root = await needRoot(cwd);
  const b = await resolveBranch(root, ref);
  const path = validateRepoPath(rawPath);
  return diffCommand(root, ['diff', ...DIFF_FLAGS, 'HEAD', b.full, '--', path], path);
}

export function parseRefLabels(raw: string): GitRefLabel[] {
  const out: GitRefLabel[] = [];
  for (const item of raw.split(', ')) {
    const ref = item.startsWith('HEAD -> ') ? item.slice(8) : item.replace(/^tag: /, '');
    if (ref === 'HEAD') out.push({ name: 'HEAD', kind: 'head' });
    else if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice(11), kind: item.startsWith('HEAD -> ') ? 'head' : 'local' });
    else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) out.push({ name: ref.slice(13), kind: 'remote' });
    else if (ref.startsWith('refs/tags/')) out.push({ name: ref.slice(10), kind: 'tag' });
  }
  return out;
}

const FULL_LOG_FORMAT = '--format=%H%x00%h%x00%s%x00%an%x00%at%x00%P%x00%D%x00';

export function parseFullLog(raw: string): GitLogCommit[] {
  return raw.split('\0\n').map((rec) => rec.split('\0')).filter((f) => f.length >= 7 && f[0]).map(([hash, short, subject, author, at, parents, refs]) => ({
    hash: hash.trim(), short, subject, author, at: Number(at) * 1000, parents: parents ? parents.split(' ') : [], refs: parseRefLabels(refs),
  }));
}

export async function gitLog(cwd: string, rawLimit: unknown): Promise<GitLog> {
  const root = await needRoot(cwd);
  const limit = Math.min(Math.max(Number(rawLimit) || 200, 1), MAX_LOG);
  const commits = await read(root, ['log', `-n${limit + 1}`, '--date-order', '--decorate=full', FULL_LOG_FORMAT, '--branches', '--remotes', '--tags', 'HEAD', '--']).then(parseFullLog, () => []); // no commits yet
  return { commits: commits.slice(0, limit), more: commits.length > limit };
}

// To the last commit, this one file. A file new to the index only leaves the index: its content stays on disk.
export async function gitRollback(cwd: string, rawPath: unknown): Promise<string> {
  const root = await needRoot(cwd);
  const path = validateRepoPath(rawPath);
  const type = await read(root, ['cat-file', '-t', `HEAD:${path}`]).then((v) => v.trim(), () => null);
  if (type === 'tree') throw httpError(400, 'a folder cannot be rolled back, only a file');
  if (type) return write(root, ['restore', '--source=HEAD', '--staged', '--worktree', '--', path]);
  const indexed = (await read(root, ['ls-files', '--cached', '-z', '--', path])).split('\0').includes(path);
  if (!indexed) throw httpError(409, 'this file is not in git: there is nothing to roll back to');
  return gitUnstage(cwd, [path]);
}

export function ignoreLine(path: string): string {
  return `/${path.replace(/[\\*?[]/g, '\\$&').replace(/ $/, '\\ ')}`;
}

export async function gitIgnore(cwd: string, rawPath: unknown): Promise<string> {
  const root = await needRoot(cwd);
  const path = validateRepoPath(rawPath);
  if (/[\r\n]/.test(path)) throw httpError(400, 'bad path');
  const untracked = (await read(root, ['ls-files', '--others', '--exclude-standard', '-z', '--', path])).split('\0').includes(path);
  if (!untracked) throw httpError(409, 'only an untracked file can be added to .gitignore');
  const file = join(root, '.gitignore');
  if (safely(() => lstatSync(file).isSymbolicLink(), false)) throw httpError(409, '.gitignore is a symlink: edit it by hand');
  const old = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const line = ignoreLine(path);
  if (!old.split(/\r?\n/).includes(line)) appendFileSync(file, `${old && !old.endsWith('\n') ? '\n' : ''}${line}\n`);
  return line;
}

export function parseStashes(raw: string): GitStash[] {
  return raw.split('\n').filter(Boolean).map((l) => l.split('\0')).map(([ref, subject, at]) => ({ ref, subject, at: Number(at) * 1000 }));
}

export async function gitStashList(cwd: string): Promise<GitStash[]> {
  return parseStashes(await read(await needRoot(cwd), ['stash', 'list', '--format=%gd%x00%gs%x00%at']));
}

export async function gitStashPush(cwd: string, message: unknown, untracked: unknown): Promise<string> {
  if (typeof message !== 'string' || !message.trim() || message.length > 500) throw httpError(400, 'a stash message is required');
  return write(await needRoot(cwd), ['stash', 'push', ...(untracked === true ? ['--include-untracked'] : []), '-m', message]);
}

export async function gitStashPop(cwd: string, ref: unknown): Promise<string> {
  if (typeof ref !== 'string' || !STASH_REF.test(ref)) throw httpError(400, 'bad stash');
  return write(await needRoot(cwd), ['stash', 'pop', ref]);
}

export async function gitPushPreview(cwd: string): Promise<GitPushPreview> {
  const root = await needRoot(cwd);
  const s = parseStatusV2(await read(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no']));
  const remote = s.branch ? await read(root, ['config', '--get', `branch.${s.branch}.remote`]).then((v) => v.trim() || null, () => null) : null;
  const merge = s.branch ? await read(root, ['config', '--get', `branch.${s.branch}.merge`]).then((v) => v.trim() || null, () => null) : null;
  const commits = await read(root, ['log', '-n50', LOG_FORMAT, ...(s.upstream ? [`${s.upstream}..HEAD`] : ['HEAD', '--not', '--remotes'])]).then(parseLog, () => []);
  const remotes = await read(root, ['remote']).then((v) => v.split('\n').filter(Boolean), () => []);
  return { branch: s.branch, upstream: s.upstream, remote, remoteBranch: merge?.replace(/^refs\/heads\//, '') ?? null, ahead: s.ahead ?? 0, behind: s.behind ?? 0, commits, remotes };
}

export async function gitPush(cwd: string, confirmed: { branch?: unknown; remote?: unknown; ahead?: unknown; publish?: unknown }): Promise<string> {
  const root = await needRoot(cwd);
  const p = await gitPushPreview(cwd);
  if (confirmed.branch !== p.branch || confirmed.remote !== p.remote || confirmed.ahead !== p.ahead) throw httpError(409, 'the branch changed after the confirmation was shown');
  // The push dialog named this remote and the new branch on it, and the click was on that.
  if (confirmed.publish !== undefined) {
    if (!p.branch || p.upstream || typeof confirmed.publish !== 'string' || !p.remotes.includes(confirmed.publish) || confirmed.publish.startsWith('-')) throw httpError(409, 'the branch changed after the confirmation was shown');
    return remote(root, ['push', '--set-upstream', confirmed.publish, `HEAD:refs/heads/${validateBranchName(p.branch)}`], PUSH_TIMEOUT);
  }
  // No upstream: git's own message says what to do, and autoSetupRemote must not quietly create a remote branch.
  if (!p.branch || !p.remote || !p.remoteBranch) return write(root, ['-c', 'push.default=simple', '-c', 'push.autoSetupRemote=false', 'push']);
  if (p.remote.startsWith('-') || p.branch.startsWith('-')) throw httpError(400, 'bad remote or branch name');
  return remote(root, ['push', p.remote, `HEAD:refs/heads/${p.remoteBranch}`], PUSH_TIMEOUT);
}
