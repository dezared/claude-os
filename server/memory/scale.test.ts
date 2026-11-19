import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { MemoryNoteList, MemoryOverview, MemoryMap } from '../../shared/memory.ts';
import { healthOf, listOf, sampleMap, type CatalogNote } from './catalog.ts';
import { registerMemory, type MemoryApiExt } from './index.ts';
import { buildLintIndex, newLintCache, type IndexedNote } from './noteIndex.ts';
import { createSearchIndex } from './search.ts';
import { createStore } from './store.ts';
import { makeKit, type TestKit } from './testkit.ts';
import { setWikiManaged } from './wikiManaged.ts';
import { createWikiSync } from './wikiSync.ts';

let kit: TestKit;
beforeEach(() => { kit = makeKit(); });
afterEach(() => kit.close());

const wiki = (name: string, o: { description?: string; tags?: string; body?: string; type?: string } = {}) =>
  `---\nname: ${name}\ndescription: ${o.description ?? `What ${name} is about`}\nmetadata:\n  type: ${o.type ?? 'project'}\n  tags: [${o.tags ?? 'db'}]\n---\n${o.body ?? `The fact of ${name}.`}\n`;
const notePath = (key: string, file: string) => join(kit.paths.vault, 'projects', key, file);
const get = async <T>(url: string) => (await kit.app.inject({ method: 'GET', url })).json() as T;
const issuesOf = (store: ReturnType<typeof createStore>, file: string) => store.graph().nodes.find((n) => n.file === file)!.issues;

test('a touched path is reread alone; a deleted one leaves; a folder event rescans', () => {
  const a = kit.write(notePath('p', 'alpha.md'), wiki('alpha'));
  const store = createStore(kit.ctx);
  assert.equal(store.graph().total, 1);
  const b = kit.write(notePath('p', 'beta.md'), wiki('beta'));
  store.touch([b]);
  assert.deepEqual(store.graph().nodes.map((n) => n.file).sort(), ['alpha.md', 'beta.md']);
  rmSync(a);
  store.touch([a]);
  assert.deepEqual(store.graph().nodes.map((n) => n.file), ['beta.md']);
  kit.write(notePath('q', 'gamma.md'), wiki('gamma'));
  store.touch([join(kit.paths.vault, 'projects', 'q')]);
  assert.equal(store.graph().total, 2);
});

test('cached lint follows the names it depends on, not only the note text', () => {
  kit.write(notePath('p', 'alpha.md'), wiki('alpha', { body: 'See [[beta]].' }));
  const store = createStore(kit.ctx);
  assert.deepEqual(issuesOf(store, 'alpha.md'), ['link-unresolved']);
  const beta = kit.write(notePath('p', 'beta.md'), wiki('beta'));
  store.touch([beta]);
  assert.deepEqual(issuesOf(store, 'alpha.md'), [], 'the link resolves now, though alpha did not change');
  const twin = kit.write(notePath('q', 'alpha.md'), wiki('alpha'));
  store.touch([twin]);
  assert.ok(store.graph().nodes.filter((n) => n.file === 'alpha.md').every((n) => n.issues.includes('name-duplicate')));
  rmSync(twin);
  store.touch([twin]);
  assert.deepEqual(issuesOf(store, 'alpha.md'), []);
});

test('lint over budget is deferred to jobs that fill the issues in', () => {
  const notes: IndexedNote[] = ['one', 'two'].map((name) => {
    const path = join(kit.paths.vault, 'projects', 'p', `${name}.md`);
    return {
      id: name, path, file: `${name}.md`, nameKey: name, content: '---\nname: x\n---\nbody', sha: name, mtime: 0, summary: null,
      meta: { name, description: null, type: null, tags: [], modified: null, body: 'body', hasFrontmatter: true },
      project: 'p', vaultKey: 'p', isGlobal: false, dir: null, links: [],
    };
  });
  const cache = newLintCache();
  const index = buildLintIndex(kit.paths.vault, notes, new Map(notes.map((n) => [n.nameKey, [n]])), { cache, budgetMs: 0 });
  assert.equal(index.pending.length, 2);
  assert.deepEqual(index.issues.get('one'), []);
  for (const job of index.pending) job();
  assert.ok(index.issues.get('one')!.includes('no-description'));
  const again = buildLintIndex(kit.paths.vault, notes, new Map(notes.map((n) => [n.nameKey, [n]])), { cache, budgetMs: 0 });
  assert.equal(again.pending.length, 0, 'the jobs filled the cache');
});

test('the map sample keeps every project, its hubs and its newest notes, under the cap', () => {
  const notes = [
    ...Array.from({ length: 3000 }, (_, i) => ({ id: `big${i}`, project: 'big', mtime: i })),
    ...Array.from({ length: 200 }, (_, i) => ({ id: `mid${i}`, project: 'mid', mtime: i })),
    ...Array.from({ length: 10 }, (_, i) => ({ id: `small${i}`, project: null, mtime: i })),
  ];
  const edges: [string, string][] = Array.from({ length: 30 }, (_, i) => ['big5', `big${100 + i}`]);
  const degree = new Map<string, number>([['big5', 30], ...edges.map(([, b]): [string, number] => [b, 1])]);
  const shown = sampleMap(notes, edges, degree, 300);
  assert.ok(shown.size <= 300, `${shown.size}`);
  assert.ok(shown.has('big5'), 'the hub');
  assert.ok(shown.has('big2999') && shown.has('mid199'), 'the newest');
  assert.equal([...shown].filter((id) => id.startsWith('small')).length, 10, 'a small project whole');
  assert.ok([...shown].filter((id) => id.startsWith('big')).length > [...shown].filter((id) => id.startsWith('mid')).length);
  assert.equal(sampleMap(notes.slice(0, 50), [], new Map(), 300).size, 50, 'under the cap: everything');
});

test('map sample: many small projects and one large never pass the cap, and each keeps a share', () => {
  const notes = [
    ...Array.from({ length: 70 }, (_, p) => Array.from({ length: 30 }, (_, i) => ({ id: `p${p}-${i}`, project: `p${p}`, mtime: i }))).flat(),
    ...Array.from({ length: 20_000 }, (_, i) => ({ id: `big${i}`, project: 'big', mtime: i })),
  ];
  for (const cap of [1500, 1000, 50]) {
    const shown = sampleMap(notes, [], new Map(), cap);
    assert.ok(shown.size <= cap, `${shown.size} > ${cap}`);
    if (cap >= 1000) assert.ok(Array.from({ length: 70 }, (_, p) => p).every((p) => [...shown].some((id) => id.startsWith(`p${p}-`))), 'every small project is on the map');
    if (cap >= 1000) assert.ok([...shown].filter((id) => id.startsWith('big')).length > 30, 'the large one still leads');
  }
});

test('graph: a large vault is drawn as a subset with the full counts', async () => {
  kit.write(notePath('big', 'n0.md'), wiki('n0'));
  for (let i = 1; i < 1600; i++) writeFileSync(notePath('big', `n${i}.md`), wiki(`n${i}`));
  kit.write(notePath('small', 'one.md'), wiki('one'));
  registerMemory(kit.ctx);
  await (kit.ctx.memory as MemoryApiExt).ready; // more files than the start pass reads before it yields
  const map = await get<MemoryMap>('/api/memory/graph');
  assert.equal(map.total, 1601);
  assert.ok(map.nodes.length <= 1500);
  assert.deepEqual(map.counts, [{ project: 'big', notes: 1600 }, { project: 'small', notes: 1 }]);
  assert.ok(map.nodes.some((n) => n.project === 'small'));
});

test('until the start pass is done a large vault is no source for MEMORY.md or a migration', async () => {
  kit.addProject('big', join(kit.base, 'work', 'big'));
  setWikiManaged(kit.paths, 'big', true);
  const memory = kit.write(notePath('big', 'MEMORY.md'), 'kept\n');
  for (let i = 0; i < 1500; i++) writeFileSync(notePath('big', `n${i}.md`), wiki(`n${i}`));
  const store = createStore(kit.ctx);
  const sync = createWikiSync(kit.ctx, store);
  assert.equal(store.complete(), false);
  assert.deepEqual(sync.regenerate('big'), { memory: false, catalog: false });
  assert.equal(readFileSync(memory, 'utf8'), 'kept\n');
  await store.ready;
  assert.deepEqual(sync.regenerate('big'), { memory: true, catalog: true });
  assert.match(readFileSync(memory, 'utf8'), /\+\d+ more notes/);
});

test('a migration asked for during the start pass is refused, not run on a partial view', async () => {
  for (let i = 0; i < 1500; i++) kit.write(notePath('big', `n${i}.md`), wiki(`n${i}`));
  registerMemory(kit.ctx);
  const res = await kit.app.inject({ method: 'POST', url: '/api/memory/wiki/big/prepare' });
  assert.equal(res.statusCode, 503);
  await (kit.ctx.memory as MemoryApiExt).ready;
});

test('health marks: malformed, broken link, duplicate description, orphan', () => {
  const base: CatalogNote = { id: '', name: '', project: 'p', connected: true, type: 'project', tags: [], summary: null, mtime: 0, issues: [], degree: 1, description: null };
  const notes = [
    { ...base, id: 'a', issues: ['bad-type', 'body-soft'] },
    { ...base, id: 'b', issues: ['link-unresolved', 'body-soft'] },
    { ...base, id: 'c', description: 'Same  question' },
    { ...base, id: 'd', description: 'same question' },
    { ...base, id: 'e', project: 'q', description: 'same question' },
    { ...base, id: 'f', degree: 0 },
    { ...base, id: 'g', degree: 0, connected: false },
  ];
  const h = healthOf(notes);
  assert.deepEqual(Object.fromEntries(h), { a: ['malformed'], b: ['broken'], c: ['duplicate'], d: ['duplicate'], e: [], f: ['orphan'], g: [] });
  const list = listOf(notes, h, { health: 'duplicate', offset: 0, limit: 1 }, null);
  assert.equal(list.total, 2);
  assert.equal(list.rows.length, 1);
});

test('overview and list: counts per project, filters, a query ranks', async () => {
  kit.write(notePath('p', 'broker.md'), wiki('broker', { body: 'Events go through RabbitMQ.', tags: 'queue', type: 'reference' }));
  kit.write(notePath('p', 'deploy.md'), wiki('deploy', { body: 'Deploys run on Fridays.', tags: 'ops, queue' }));
  kit.write(notePath('q', 'theme.md'), wiki('theme', { description: 'Which theme the user prefers', type: 'user', tags: 'ui' }));
  kit.write(notePath('q', 'bad.md'), 'no frontmatter at all');
  registerMemory(kit.ctx);

  const o = await get<MemoryOverview>('/api/memory/overview');
  assert.equal(o.total, 4);
  const p = o.projects.find((x) => x.project === 'p')!;
  assert.equal(p.notes, 2);
  assert.equal(p.added7, 2);
  assert.equal(p.weeks.at(-1), 2);
  assert.deepEqual(p.types, { reference: 1, project: 1 });
  assert.deepEqual(p.tags[0], ['queue', 2]);
  assert.equal(o.projects.find((x) => x.project === 'q')!.health.malformed, 1);

  const all = await get<MemoryNoteList>('/api/memory/list');
  assert.equal(all.total, 4);
  assert.deepEqual((await get<MemoryNoteList>('/api/memory/list?project=p&tag=ops')).rows.map((r) => r.name), ['deploy']);
  assert.deepEqual((await get<MemoryNoteList>('/api/memory/list?health=malformed')).rows.map((r) => r.name), ['bad']);
  const hit = await get<MemoryNoteList>('/api/memory/list?q=rabbitmq');
  assert.deepEqual(hit.rows.map((r) => r.name), ['broker']);
  assert.ok(hit.rows[0].snippet!.includes('\u0001RabbitMQ\u0002'));
  assert.equal((await get<MemoryNoteList>('/api/memory/list?q=rabbitmq&type=user')).total, 0);
  assert.equal((await get<MemoryNoteList>('/api/memory/list?limit=1&offset=1')).rows.length, 1);
});

test('a planned sync writes in steps; queries see the rows written so far', () => {
  const index = createSearchIndex();
  try {
    const docs = Array.from({ length: 300 }, (_, i) => ({
      id: `d${i}`, path: `/v/d${i}.md`, project: 'p', type: 'project', name: `d${i}`, description: null, tags: [], body: 'shared word', mtime: i, sha: `${i}`,
    }));
    assert.deepEqual(index.plan(docs), { added: 300, changed: 0, removed: 0 });
    assert.equal(index.pending(), 300);
    while (!index.step(0.01)) assert.ok(index.pending() < 300);
    assert.equal(index.query('shared', { limit: 20 }).length, 20);
    assert.deepEqual(index.plan(docs.slice(1)), { added: 0, changed: 0, removed: 1 });
    assert.equal(index.step(), true);
  } finally {
    index.close();
  }
});
