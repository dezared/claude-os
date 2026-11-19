import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import { inFolder, type FileRoot } from '../../shared/files.ts';
import { listDir, registerProjectFiles, rootCrumbs, treeRoot } from './projectFiles.ts';

const dir = mkdtempSync(join(tmpdir(), 'claude-os-tree-root-'));
const project = join(dir, 'proj');
const cwd = join(project, '.worktrees', 'task');
const other = join(dir, 'other');
mkdirSync(join(cwd, 'src'), { recursive: true });
mkdirSync(other);
writeFileSync(join(project, 'top.md'), 'x');
writeFileSync(join(other, 'secret.txt'), 'x');
symlinkSync(other, join(project, 'out'));
after(() => rmSync(dir, { recursive: true, force: true }));
// The checks below are about where the panel stands; the way up and the crumbs have tests of their own.
const where = ({ path, cwd, top }: FileRoot) => ({ path, cwd, top });

test('no root: the tab cwd, and up reaches the project root that holds it', () => {
  assert.deepEqual(where(treeRoot(cwd, [project], undefined)), { path: cwd, cwd, top: project });
  assert.deepEqual(where(treeRoot(cwd, [project], '')), { path: cwd, cwd, top: project });
});

test('a cwd that is a root of its own cannot go up', () => {
  assert.deepEqual(where(treeRoot(project, [project], undefined)), { path: project, cwd: project, top: project });
  assert.equal(treeRoot(cwd, [], undefined).top, cwd);
});

test('a parent inside a readable root is listed from there', async () => {
  const root = treeRoot(cwd, [project], project);
  assert.deepEqual(where(root), { path: project, cwd, top: project });
  assert.ok((await listDir(root.path)).some((e) => e.name === 'top.md'));
  assert.equal(treeRoot(cwd, [project], join(cwd, 'src')).path, join(cwd, 'src'));
});

test('the way up and the crumbs come from the server, in the separators of its OS', () => {
  const root = treeRoot(cwd, [project], undefined);
  assert.equal(root.parent, dirname(cwd));
  assert.deepEqual(root.crumbs.at(-1), { name: 'task', path: cwd, reach: true });
  assert.equal(treeRoot(cwd, [project], project).parent, null);
  assert.deepEqual(rootCrumbs('C:\\Users\\me\\proj\\src', 'C:\\Users\\me\\proj', 'C:\\Users\\me', win32), {
    parent: 'C:\\Users\\me\\proj',
    crumbs: [
      { name: '~', path: 'C:\\Users\\me', reach: false },
      { name: 'proj', path: 'C:\\Users\\me\\proj', reach: true },
      { name: 'src', path: 'C:\\Users\\me\\proj\\src', reach: true },
    ],
  });
  assert.deepEqual(rootCrumbs('D:\\work', 'D:\\work', 'C:\\Users\\me', win32), {
    parent: null,
    crumbs: [{ name: 'D:\\', path: 'D:\\', reach: false }, { name: 'work', path: 'D:\\work', reach: true }],
  });
  assert.deepEqual(rootCrumbs('/srv/a', '/srv', '/home/me').crumbs.map((c) => c.name), ['/', 'srv', 'a']);
});

test('a path inside a folder takes the folder\'s separator', () => {
  assert.equal(inFolder('C:\\proj', 'src/a.ts'), 'C:\\proj\\src\\a.ts');
  assert.equal(inFolder('D:\\', 'a.ts'), 'D:\\a.ts');
  assert.equal(inFolder('/home/me/proj', 'src/a.ts'), '/home/me/proj/src/a.ts');
  assert.equal(inFolder('/', 'etc'), '/etc');
});

test('a folder outside every root, a relative one or a file is refused', () => {
  assert.throws(() => treeRoot(cwd, [project], dir), { statusCode: 403 });
  assert.throws(() => treeRoot(cwd, [project], other), { statusCode: 403 });
  assert.throws(() => treeRoot(cwd, [project], 'proj'), { statusCode: 400 });
  assert.throws(() => treeRoot(cwd, [project], join(project, 'top.md')), { statusCode: 400 });
  assert.throws(() => treeRoot(cwd, [project], join(project, 'missing')), { statusCode: 404 });
});

test('a symlink inside a root that leads out of it is refused', () => {
  assert.throws(() => treeRoot(cwd, [project], join(project, 'out')), { statusCode: 403 });
});

test('over HTTP: the tree lists from a root the tab may read, and says how far up it goes', async () => {
  const app = Fastify();
  const ctx = { app, paths: { data: join(dir, 'data'), vault: join(dir, 'vault') }, journal: { listProjects: () => [{ key: 'p', root: project }] }, audit: () => {} };
  registerProjectFiles(ctx as never, () => cwd, () => false);
  // /tmp is a read-only root too: a temp project may go up to it.
  const top = dir.startsWith('/tmp/') ? '/tmp' : project;
  assert.deepEqual(where((await app.inject({ url: '/api/tabs/t/tree/root' })).json()), { path: cwd, cwd, top });
  const names = (url: string) => app.inject({ url }).then((r) => r.json<{ path: string }[]>().map((e) => e.path));
  assert.deepEqual(await names(`/api/tabs/t/tree?root=${encodeURIComponent(project)}`), ['.worktrees', 'top.md']);
  assert.deepEqual(await names(`/api/tabs/t/tree?root=${encodeURIComponent(project)}&path=.worktrees`), ['.worktrees/task']);
  assert.deepEqual(await names('/api/tabs/t/tree'), ['src']);
  assert.equal((await app.inject({ url: `/api/tabs/t/tree?root=${encodeURIComponent('/etc')}` })).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/tabs/t/tree/root?root=${encodeURIComponent('/etc')}` })).statusCode, 403);
  assert.equal((await app.inject({ url: `/api/tabs/t/tree?root=${encodeURIComponent(project)}&path=..` })).statusCode, 400);
  await app.close();
});
