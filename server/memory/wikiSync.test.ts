import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { MemoryGraph, MemoryNote } from '../../shared/contract.ts';
import { registerMemory } from './index.ts';
import { createStore, encodeDir } from './store.ts';
import { makeKit, until, type TestKit } from './testkit.ts';
import { safely } from './util.ts';
import { isWikiManaged, setWikiManaged } from './wikiManaged.ts';
import { createWikiSync } from './wikiSync.ts';

let kit: TestKit;
beforeEach(() => { kit = makeKit(); });
afterEach(() => kit.close());

const DEBOUNCE_MS = 300;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const read = (path: string) => safely(() => readFileSync(path, 'utf8'), null);
const notePath = (key: string, file: string) => join(kit.paths.vault, 'projects', key, file);
const logOf = (key: string) => read(join(kit.paths.vault, '_log', `${key}.md`)) ?? '';
const catalogOf = (key: string) => join(kit.paths.vault, '_index', `${key}.md`);
const wikiNote = (name: string, description: string, body: string) =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: project\n  tags: [infra]\n---\n${body}\n`;

// Backups are data/backups/<stamp>/<absolute path>.
function backupsOf(path: string): string[] {
  const dir = join(kit.paths.data, 'backups');
  return safely(() => readdirSync(dir), []).map((stamp) => read(join(dir, stamp, path))).filter((t) => t !== null);
}

// The vault must exist before registerMemory for its watcher to start; chokidar needs a moment to be ready.
// Project p is managed (migrated) unless the test says otherwise.
async function start(managed = true): Promise<void> {
  mkdirSync(join(kit.paths.vault, 'projects', 'p'), { recursive: true });
  if (managed) setWikiManaged(kit.paths, 'p', true);
  registerMemory(kit.ctx);
  await sleep(DEBOUNCE_MS);
}

test('a terminal write with a wrong name is fixed once, backed up and logged', async () => {
  await start();
  const original = wikiNote('foo', 'Which broker carries events', 'Events go through RabbitMQ.');
  const path = kit.write(notePath('p', 'event-broker.md'), original);
  await until(() => read(path)!.includes('name: event-broker'));
  assert.equal(read(path), original.replace('name: foo', 'name: event-broker'));
  assert.deepEqual(backupsOf(path), [original]);
  await until(() => logOf('p').includes('fix event-broker name-mismatch'));
});

test('own fix does not fire again', async () => {
  await start();
  const path = kit.write(notePath('p', 'event-broker.md'), wikiNote('foo', 'Which broker carries events', 'Events go through RabbitMQ.'));
  await until(() => logOf('p').includes('fix event-broker'));
  const mtime = statSync(path).mtimeMs;
  await sleep(DEBOUNCE_MS * 2 + 200);
  assert.equal(statSync(path).mtimeMs, mtime);
  const lines = logOf('p').trim().split('\n');
  assert.equal(lines.length, 1, logOf('p'));
  assert.match(lines[0], /^\d{4}-\d{2}-\d{2} fix event-broker name-mismatch$/);
});

test('a flagged note is not rewritten', async () => {
  await start();
  const russian = wikiNote('ru-note', 'Как генерируются миграции', 'Миграции генерируются через diff и проверяются вручную.');
  const path = kit.write(notePath('p', 'ru-note.md'), russian);
  await until(() => logOf('p').includes('add ru-note'));
  assert.equal(read(path), russian);
  assert.deepEqual(backupsOf(path), []);
  const graph = (await kit.app.inject({ url: '/api/memory/graph' })).json() as MemoryGraph;
  assert.ok(graph.nodes.find((n) => n.file === 'ru-note.md')!.issues.includes('not-english'));
});

test('MEMORY.md is regenerated when a note changes and when someone edits it', async () => {
  await start();
  const memory = notePath('p', 'MEMORY.md');
  kit.write(notePath('p', 'broker.md'), wikiNote('broker', 'Which broker carries events', 'Events go through RabbitMQ.'));
  const generated = '## project\n- [broker](broker.md) — Which broker carries events\n';
  await until(() => read(memory) === generated);
  assert.match(read(catalogOf('p'))!, /- \[\[projects\/p\/broker\|broker\]\] — Which broker carries events #infra/);

  writeFileSync(memory, '- hand edit\n');
  await until(() => read(memory) === generated);
  assert.ok(backupsOf(memory).includes('- hand edit\n'));
  assert.doesNotMatch(logOf('p'), /MEMORY/);
});

test('generated files are written only when their content changes', async () => {
  mkdirSync(join(kit.paths.vault, 'projects', 'p'), { recursive: true });
  kit.write(notePath('p', 'broker.md'), wikiNote('broker', 'Which broker carries events', 'Events go through RabbitMQ.'));
  setWikiManaged(kit.paths, 'p', true);
  const sync = createWikiSync(kit.ctx, createStore(kit.ctx));
  assert.deepEqual(sync.regenerate('p'), { memory: true, catalog: true });
  assert.deepEqual(sync.regenerate('p'), { memory: false, catalog: false });
  assert.deepEqual(sync.regenerate('missing'), { memory: false, catalog: false });
  assert.equal(existsSync(join(kit.paths.vault, 'projects', 'missing')), false, 'no project dir is created');

  await kit.close();
  kit = makeKit();
  await start();
  const memory = notePath('p', 'MEMORY.md');
  const note = kit.write(notePath('p', 'broker.md'), wikiNote('broker', 'Which broker carries events', 'Events go through RabbitMQ.'));
  await until(() => existsSync(memory) && existsSync(catalogOf('p')));
  const before = [statSync(memory).mtimeMs, statSync(catalogOf('p')).mtimeMs];
  writeFileSync(note, wikiNote('broker', 'Which broker carries events', 'Events go through Kafka now.'));
  await until(() => logOf('p').includes('update broker'));
  assert.deepEqual([statSync(memory).mtimeMs, statSync(catalogOf('p')).mtimeMs], before);
  assert.deepEqual(backupsOf(memory), [], 'nothing to back up: MEMORY.md did not exist and was never rewritten');
});

test('old-place notes are never written', async () => {
  const root = join(kit.base, 'proj');
  kit.addProject('p', root);
  const old = join(kit.paths.claudeDir, 'projects', encodeDir(root), 'memory');
  mkdirSync(old, { recursive: true });
  await start();
  const bad = 'name: x\nno frontmatter here, trailing spaces   \r\n';
  const path = kit.write(join(old, 'Bad_Name.md'), bad);
  await until(() => kit.topics.includes('memory'));
  await sleep(DEBOUNCE_MS * 2);
  createWikiSync(kit.ctx, createStore(kit.ctx)).changed([path]);
  assert.equal(read(path), bad);
  assert.equal(existsSync(join(kit.paths.vault, '_log')), false);
  assert.equal(existsSync(notePath('p', 'MEMORY.md')), false);
});

test('a forgotten note logs no delete when it goes', () => {
  const kept = kit.write(notePath('p', 'kept-note.md'), wikiNote('kept-note', 'Kept question', 'Kept fact.'));
  const moved = kit.write(notePath('p', 'moved-note.md'), wikiNote('moved-note', 'Moved question', 'Moved fact.'));
  setWikiManaged(kit.paths, 'p', true);
  const sync = createWikiSync(kit.ctx, createStore(kit.ctx));
  sync.forget(moved);
  rmSync(moved);
  rmSync(kept);
  sync.changed([moved, kept]);
  assert.deepEqual(logOf('p').trim().split('\n').map((l) => l.replace(/^\S+ /, '')), ['delete kept-note']);
});

test('existing notes are untouched until they change', async () => {
  const a = kit.write(notePath('p', 'alpha-note.md'), wikiNote('wrong', 'Alpha question', 'Alpha fact.'));
  const b = kit.write(notePath('p', 'beta-note.md'), wikiNote('also-wrong', 'Beta question', 'Beta fact.'));
  const memory = kit.write(notePath('p', 'MEMORY.md'), '- hand written index\n');
  const before = [read(a), read(b), read(memory)];
  setWikiManaged(kit.paths, 'p', true);
  registerMemory(kit.ctx);
  await sleep(DEBOUNCE_MS * 3);
  assert.deepEqual([read(a), read(b), read(memory)], before);
  assert.equal(existsSync(join(kit.paths.vault, '_log')), false);
  assert.equal(existsSync(join(kit.paths.vault, '_index')), false);

  writeFileSync(a, wikiNote('wrong', 'Alpha question', 'Alpha fact, revised.'));
  await until(() => read(a)!.includes('name: alpha-note'));
  await until(() => read(memory)!.includes('[also-wrong](beta-note.md)'));
  assert.equal(read(b), before[1], 'an unchanged note stays as it is, even in the regenerated index');
  assert.match(read(memory)!, /\[alpha-note\]\(alpha-note\.md\) — Alpha question/);
});

test('editor save fixes silently and returns the remaining issues', async () => {
  const path = kit.write(notePath('p', 'migrations.md'), wikiNote('migrations', 'How migrations are generated', 'By the diff tool.'));
  await start();
  const graph = (await kit.app.inject({ url: '/api/memory/graph' })).json() as MemoryGraph;
  const id = graph.nodes.find((n) => n.file === 'migrations.md')!.id;
  const { version } = (await kit.app.inject({ url: `/api/memory/notes/${id}` })).json() as MemoryNote;

  const edited = wikiNote('Migrations_Old', 'How migrations are generated', 'Миграции генерируются через diff и проверяются вручную.');
  const res = await kit.app.inject({ method: 'PUT', url: `/api/memory/notes/${id}`, payload: { markdown: edited, version } });
  assert.equal(res.statusCode, 200);
  const saved = res.json() as MemoryNote;
  const fixed = edited.replace('name: Migrations_Old', 'name: migrations');
  assert.equal(saved.markdown, fixed);
  assert.equal(read(path), fixed);
  assert.ok(saved.node.issues.includes('not-english'));
  assert.equal(saved.node.issues.includes('name-mismatch'), false);
  assert.ok(read(notePath('p', 'MEMORY.md'))!.includes('[migrations](migrations.md)'), 'regenerated before the response');
  assert.match(logOf('p'), /update migrations/);

  await sleep(DEBOUNCE_MS * 2 + 200);
  assert.equal(logOf('p').trim().split('\n').length, 1, 'the watcher event of the save is not logged again');
});

test('a project is unmanaged by default and the marker persists', () => {
  assert.equal(isWikiManaged(kit.paths, 'p'), false);
  assert.equal(isWikiManaged(kit.paths, null), false);
  setWikiManaged(kit.paths, 'p', true);
  assert.equal(isWikiManaged(kit.paths, 'p'), true);
  assert.equal(isWikiManaged(kit.paths, 'q'), false);
  setWikiManaged(kit.paths, 'p', false);
  assert.equal(isWikiManaged(kit.paths, 'p'), false);
});

test('an unmanaged project is never written: no fix, no backup, no log, no generated files', async () => {
  const memory = kit.write(notePath('p', 'MEMORY.md'), '- hand written index\n');
  await start(false);
  const original = wikiNote('foo', 'Which broker carries events', 'Events go through RabbitMQ.');
  const path = kit.write(notePath('p', 'event-broker.md'), original);
  writeFileSync(memory, '- hand edit\n');
  await until(() => kit.topics.includes('memory'));
  await sleep(DEBOUNCE_MS * 2);
  const sync = createWikiSync(kit.ctx, createStore(kit.ctx));
  sync.changed([path, memory]);
  assert.deepEqual(sync.regenerate('p'), { memory: false, catalog: false });
  assert.equal(read(path), original);
  assert.equal(read(memory), '- hand edit\n');
  assert.equal(existsSync(join(kit.paths.data, 'backups')), false);
  assert.equal(existsSync(join(kit.paths.vault, '_log')), false);
  assert.equal(existsSync(join(kit.paths.vault, '_index')), false);
  const graph = (await kit.app.inject({ url: '/api/memory/graph' })).json() as MemoryGraph;
  assert.deepEqual(graph.nodes.find((n) => n.file === 'event-broker.md')!.issues, [], 'issues are still computed (name-mismatch is a fix, not an issue)');
});

test('an editor save in an unmanaged project writes the text as typed and still returns the issues', async () => {
  const path = kit.write(notePath('p', 'migrations.md'), wikiNote('migrations', 'How migrations are generated', 'By the diff tool.'));
  await start(false);
  const graph = (await kit.app.inject({ url: '/api/memory/graph' })).json() as MemoryGraph;
  const id = graph.nodes.find((n) => n.file === 'migrations.md')!.id;
  const { version } = (await kit.app.inject({ url: `/api/memory/notes/${id}` })).json() as MemoryNote;
  const edited = wikiNote('Migrations_Old', 'How migrations are generated', 'Миграции генерируются через diff и проверяются вручную.');
  const saved = (await kit.app.inject({ method: 'PUT', url: `/api/memory/notes/${id}`, payload: { markdown: edited, version } })).json() as MemoryNote;
  assert.equal(read(path), edited);
  assert.equal(saved.markdown, edited);
  assert.ok(saved.node.issues.includes('not-english'));
  assert.equal(existsSync(notePath('p', 'MEMORY.md')), false);
  assert.equal(existsSync(join(kit.paths.vault, '_log')), false);
});
