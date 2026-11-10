// A project's own data through the real server: what is written comes back, what is wrong is refused.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { Project } from '../../shared/contract.ts';
import { startServer, type TestServer } from './fixtures/harness.ts';

let srv: TestServer;
let parent: Project;
let child: Project;

before(async () => {
  srv = await startServer();
  mkdirSync(join(srv.dir, 'box', 'inner'), { recursive: true });
  parent = (await srv.api<Project>('POST', '/api/projects/connect', { path: join(srv.dir, 'box') })).body;
  child = (await srv.api<Project>('POST', '/api/projects/connect', { path: join(srv.dir, 'box', 'inner') })).body;
});

after(async () => {
  await srv?.destroy();
});

const patch = (key: string, body: object) => srv.api<Project & { error?: string }>('PATCH', `/api/projects/${encodeURIComponent(key)}`, body);

test('a new project has no data of its own', () => {
  assert.deepEqual([child.description, child.color, child.parent, child.folder], [null, null, null, false]);
});

test('changes come back whole and stay in the list', async () => {
  const done = await patch(parent.key, { name: 'Коробка', description: ' Что внутри ', color: '#112233', folder: true });
  assert.equal(done.status, 200);
  assert.deepEqual([done.body.name, done.body.description, done.body.color, done.body.folder], ['Коробка', 'Что внутри', '#112233', true]);
  const listed = (await srv.api<Project[]>('GET', '/api/projects')).body.find((p) => p.key === parent.key)!;
  assert.deepEqual([listed.name, listed.description, listed.color, listed.folder, listed.root], ['Коробка', 'Что внутри', '#112233', true, parent.root]);
  const cleared = await patch(parent.key, { description: null, color: null, folder: false });
  assert.deepEqual([cleared.body.description, cleared.body.color, cleared.body.folder, cleared.body.name], [null, null, false, 'Коробка']);
});

test('structure: top level by hand and back; a circle is refused, whatever the folders say', async () => {
  assert.equal((await patch(child.key, { parent: '' })).body.parent, '');
  assert.equal((await patch(child.key, { parent: null })).body.parent, null);
  const circle = await patch(parent.key, { parent: child.key });
  assert.equal(circle.status, 400);
  assert.match(circle.body.error ?? '', /inside/);
});

test('a wrong value and an unknown project', async () => {
  assert.equal((await patch(child.key, { color: 'синий' })).status, 400);
  assert.equal((await patch(child.key, { parent: 'нет-такого' })).status, 400);
  assert.equal((await patch('нет-такого', { folder: true })).status, 404);
});
