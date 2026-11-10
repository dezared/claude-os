import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import type { MemoryGraph, MemoryMigrationPlan, MemoryNote } from '../../shared/contract.ts';
import { encodeDir } from './store.ts';
import { makeKit, session, until, type TestKit } from './testkit.ts';
import { renderState } from './state.ts';
import { parseFrontmatter, sha256, unifiedDiff } from './util.ts';
import { extractLinks, normalizeName } from './wikilinks.ts';
import { registerMemory, type MemoryApiExt } from './index.ts';

let kit: TestKit;
beforeEach(() => { kit = makeKit(); });
afterEach(() => kit.close());

const json = async <T>(method: 'GET' | 'PUT' | 'POST', url: string, body?: unknown) => {
  const res = await kit.app.inject({ method, url, ...(body ? { payload: body as object } : {}) });
  return { status: res.statusCode, body: res.json() as T };
};
const memDir = (dir: string) => join(kit.paths.claudeDir, 'projects', dir, 'memory');
const api = () => kit.ctx.memory as MemoryApiExt;

test('normalizeName treats - and _ as one character', () => {
  assert.equal(normalizeName('project_combo-bonus'), normalizeName('project-combo_bonus'));
  assert.equal(normalizeName('Folder/Note.md'), 'note');
});

test('extractLinks handles aliases and sections, skips code and frontmatter', () => {
  const md = '---\nname: x\nrelated: "[[in-front]]"\n---\n[[a_b]] [[c|alias]] [[d#part]] `[[inline]]`\n```\n[[fenced]]\n```\n[[a-b]]';
  assert.deepEqual(extractLinks(md), ['a-b', 'c', 'd']);
});

test('parseFrontmatter reads quoted values and block scalars', () => {
  const { data, body } = parseFrontmatter('---\nname: "a: b"\ndescription: >\n  one\n  two\nmetadata:\n  type: x\n---\nbody');
  assert.equal(data.name, 'a: b');
  assert.equal(data.description, 'one two');
  assert.equal(body, 'body');
});

test('unifiedDiff produces hunks with line numbers', () => {
  const diff = unifiedDiff('a\nb\nc\n', 'a\nB\nc\n', 'f');
  assert.match(diff, /@@ -1,4 \+1,4 @@/);
  assert.match(diff, /-b\n\+B/);
  assert.equal(unifiedDiff('same', 'same'), '');
});

test('graph: real links only, across - and _, unresolved counted not drawn, degree, live', async () => {
  const root = join(kit.base, 'work', 'my_proj');
  kit.addProject('my_proj', root);
  kit.sessions.push(session('s1', 'my_proj', root));
  const dir = encodeDir(root);
  kit.write(join(memDir(dir), 'one_note.md'), '---\nname: First\n---\nsee [[two-note]] and [[missing]]');
  kit.write(join(memDir(dir), 'two-note.md'), '# Second\nback to [[one-note]]');
  kit.write(join(memDir(dir), 'three.md'), 'no links');
  registerMemory(kit.ctx);

  const { body } = await json<MemoryGraph>('GET', '/api/memory/graph');
  assert.equal(body.nodes.length, 3);
  assert.equal(body.edges.length, 1, 'a mutual link is one edge');
  assert.equal(body.unresolved, 1);
  assert.equal(body.vaultExists, false);
  const first = body.nodes.find((n) => n.title === 'First')!;
  const second = body.nodes.find((n) => n.title === 'Second')!;
  assert.equal(first.degree, 1);
  assert.equal(first.project, 'my_proj');
  assert.equal(first.connected, false);
  assert.equal(first.live, true);
  assert.equal(body.nodes.find((n) => n.title === 'three')!.degree, 0);

  const note = await json<MemoryNote>('GET', `/api/memory/notes/${first.id}`);
  assert.deepEqual(note.body.backlinks, [second.id]);
  assert.equal(note.body.obsidianUrl, null);
  assert.equal(existsSync(kit.paths.vault), false, 'reading never creates the vault');
});

test('a link resolves inside its own project first, an ambiguous foreign link stays unresolved', async () => {
  kit.write(join(memDir('-a'), 'x.md'), '[[shared]] [[only-b]] [[twice]]');
  kit.write(join(memDir('-a'), 'shared.md'), 'a');
  kit.write(join(memDir('-b'), 'shared.md'), 'b');
  kit.write(join(memDir('-b'), 'only_b.md'), 'b');
  kit.write(join(memDir('-b'), 'twice.md'), 'b');
  kit.write(join(memDir('-c'), 'twice.md'), 'c');
  registerMemory(kit.ctx);
  const { body } = await json<MemoryGraph>('GET', '/api/memory/graph');
  const byFile = (dirNote: string) => body.nodes.filter((n) => n.file === dirNote);
  assert.equal(body.edges.length, 2);
  assert.equal(body.unresolved, 1);
  const shared = byFile('shared.md');
  assert.equal(shared.filter((n) => n.degree === 1).length, 1);
});

test('directory maps to a project through a journal cwd, with no session in the index', async () => {
  const root = join(kit.base, 'weird_name');
  kit.addProject('weird', root);
  const dir = encodeDir(root);
  kit.write(join(memDir(dir), 'n.md'), 'x');
  kit.write(join(kit.paths.claudeDir, 'projects', dir, 'abc.jsonl'), `${JSON.stringify({ cwd: root, type: 'user' })}\n`);
  registerMemory(kit.ctx);
  const { body } = await json<MemoryGraph>('GET', '/api/memory/graph');
  assert.equal(body.nodes[0].project, 'weird');
});

test('directory without journals decodes through the real file system', async () => {
  const root = join(kit.base, 'a_b', 'c-d');
  kit.addProject('cd', root);
  kit.write(join(memDir(encodeDir(root)), 'n.md'), 'x');
  registerMemory(kit.ctx);
  const { body } = await json<MemoryGraph>('GET', '/api/memory/graph');
  assert.equal(body.nodes[0].project, 'cd');
});

test('a stub journal leaves notes visible with project null', async () => {
  const empty = makeKit({ listProjects: () => [], listSessions: () => [], projectForCwd: () => null });
  empty.write(join(empty.paths.claudeDir, 'projects', '-gone', 'memory', 'n.md'), 'x');
  registerMemory(empty.ctx);
  const { nodes } = (await empty.app.inject({ url: '/api/memory/graph' })).json() as MemoryGraph;
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].project, null);
  await empty.close();
});

test('a journal calling projectStats from listProjects does not recurse forever', async () => {
  let calls = 0;
  const looping = makeKit();
  looping.addProject('p', join(looping.base, 'p'));
  const list = looping.ctx.journal.listProjects;
  looping.ctx.journal.listProjects = () => {
    calls++;
    return list().map((p) => ({ ...p, memoryCount: looping.ctx.memory.projectStats(p.key).count }));
  };
  registerMemory(looping.ctx);
  assert.equal(looping.ctx.journal.listProjects()[0].memoryCount, 0);
  assert.ok(calls <= 3, `listProjects called ${calls} times`);
  await looping.close();
});

test('save: version conflict 409, read only 403, backup and audit on success', async () => {
  const vaultNote = kit.write(join(kit.paths.vault, 'projects', 'p', 'v.md'), 'old\n');
  kit.write(join(memDir('-x'), 'ro.md'), 'read only');
  registerMemory(kit.ctx);
  const { body: graph } = await json<MemoryGraph>('GET', '/api/memory/graph');
  const v = graph.nodes.find((n) => n.file === 'v.md')!;
  const ro = graph.nodes.find((n) => n.file === 'ro.md')!;
  assert.equal(v.connected, true);

  const note = await json<MemoryNote>('GET', `/api/memory/notes/${v.id}`);
  assert.equal(note.body.version, sha256('old\n'));
  assert.ok(note.body.obsidianUrl?.startsWith('obsidian://open?path='));
  assert.ok(decodeURIComponent(note.body.obsidianUrl!).includes('\\\\wsl.localhost\\'));
  assert.ok(decodeURIComponent(note.body.obsidianUrl!).endsWith('\\projects\\p\\v.md'));

  const stale = await json<{ error: string; version: string }>('PUT', `/api/memory/notes/${v.id}`, { markdown: 'new\n', version: 'stale' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.version, sha256('old\n'));
  assert.equal(readFileSync(vaultNote, 'utf8'), 'old\n');

  const denied = await json('PUT', `/api/memory/notes/${ro.id}`, { markdown: 'x', version: sha256('read only') });
  assert.equal(denied.status, 403);
  assert.equal(readFileSync(join(memDir('-x'), 'ro.md'), 'utf8'), 'read only');

  const saved = await json<MemoryNote>('PUT', `/api/memory/notes/${v.id}`, { markdown: 'new\n', version: note.body.version });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.version, sha256('new\n'));
  assert.equal(readFileSync(vaultNote, 'utf8'), 'new\n');
  assert.equal(kit.audits.length, 1);
  assert.equal(kit.audits[0].action, 'memory.save');
  assert.match(kit.audits[0].diff!, /-old\n\+new/);
  const backups = join(kit.paths.data, 'backups');
  assert.ok(existsSync(backups));
});

test('migration: plan changes nothing, then copy, verify, merge settings, keep sources', async () => {
  const root = join(kit.base, 'proj');
  kit.addProject('proj', root);
  const from = memDir(encodeDir(root));
  kit.write(join(from, 'MEMORY.md'), 'index [[fact]]');
  kit.write(join(from, 'fact.md'), 'fact');
  const settings = kit.write(join(root, '.claude/settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, other: 1 }));
  registerMemory(kit.ctx);

  const before = readFileSync(settings, 'utf8');
  const { body: plan } = await json<MemoryMigrationPlan>('GET', '/api/memory/migrate/proj');
  assert.deepEqual(plan.files, ['MEMORY.md', 'fact.md']);
  assert.equal(plan.to, join(kit.paths.vault, 'projects', 'proj'));
  assert.match(plan.settingsDiff, /\+.*autoMemoryDirectory/);
  assert.equal(existsSync(kit.paths.vault), false, 'the plan does not create the vault');
  assert.equal(readFileSync(settings, 'utf8'), before);
  assert.ok(!('settingsAfter' in plan));

  const res = await json<{ ok: boolean; copied: number; skipped: string[] }>('POST', '/api/memory/migrate/proj');
  assert.equal(res.status, 200);
  assert.equal(res.body.copied, 2);
  assert.equal(readFileSync(join(plan.to, 'fact.md'), 'utf8'), 'fact');
  assert.ok(existsSync(join(from, 'fact.md')), 'source stays');
  const merged = JSON.parse(readFileSync(settings, 'utf8'));
  assert.equal(merged.autoMemoryDirectory, plan.to);
  assert.deepEqual(merged.permissions, { allow: ['Bash(ls)'] });
  assert.equal(merged.other, 1);
  assert.ok(kit.audits.some((a) => a.action === 'memory.migrate' && a.diff?.includes('autoMemoryDirectory')));

  // Connected now: notes come from the vault, old copies are not shown twice.
  const { body: graph } = await json<MemoryGraph>('GET', '/api/memory/graph');
  assert.equal(graph.nodes.length, 2);
  assert.ok(graph.nodes.every((n) => n.connected && n.project === 'proj'));
  assert.equal(graph.edges.length, 1);
  assert.deepEqual(kit.ctx.memory.projectStats('proj'), { count: 2, connected: true, drift: 0 });
  assert.equal(kit.ctx.memory.vaultDirFor('proj'), plan.to);
  assert.match(kit.ctx.memory.stateNote('proj')!, /working memory/);

  // Terminal session wrote to the old place: drift, then the same button moves it over.
  kit.write(join(from, 'new-from-terminal.md'), 'drift');
  await until(() => kit.ctx.memory.projectStats('proj').drift === 1, 20000);
  const again = await json<{ copied: number }>('POST', '/api/memory/migrate/proj');
  assert.equal(again.body.copied, 1);
  await until(() => kit.ctx.memory.projectStats('proj').drift === 0, 20000);
});

test('migration does not overwrite a differing vault note and refuses broken settings', async () => {
  const root = join(kit.base, 'proj');
  kit.addProject('proj', root);
  const from = memDir(encodeDir(root));
  kit.write(join(from, 'a.md'), 'source');
  const vaultCopy = kit.write(join(kit.paths.vault, 'projects', 'proj', 'a.md'), 'edited in vault');
  const settings = kit.write(join(root, '.claude/settings.local.json'), '{ broken');
  registerMemory(kit.ctx);

  const refused = await json('POST', '/api/memory/migrate/proj');
  assert.equal(refused.status, 409);
  assert.equal(readFileSync(settings, 'utf8'), '{ broken');

  kit.write(settings, '{}');
  const ok = await json<{ copied: number; skipped: string[] }>('POST', '/api/memory/migrate/proj');
  assert.equal(ok.body.copied, 0);
  assert.deepEqual(ok.body.skipped, ['a.md']);
  assert.equal(readFileSync(vaultCopy, 'utf8'), 'edited in vault');
});

test('unknown project and path-like keys are refused', async () => {
  registerMemory(kit.ctx);
  assert.equal((await json('GET', '/api/memory/migrate/nope')).status, 404);
  assert.equal((await json('POST', `/api/memory/migrate/${encodeURIComponent('../evil')}`)).status, 400);
  assert.equal((await json('GET', '/api/memory/notes/deadbeef')).status, 404);
});

test('state: only for connected projects, never creates the vault, capped at 1000 chars', async () => {
  const root = join(kit.base, 'proj');
  kit.addProject('proj', root);
  registerMemory(kit.ctx);
  await api().refreshStates();
  assert.equal(existsSync(kit.paths.vault), false);
  assert.equal(kit.ctx.memory.stateNote('proj'), null);

  kit.sessions.push(session('11111111-aaaa', 'proj', root, { title: 'Правка', lastPrompt: 'сделай', status: 'working', lastActivity: 5 }));
  await json('POST', '/api/memory/migrate/proj');
  const text = kit.ctx.memory.stateNote('proj')!;
  assert.match(text, /Правка \(working\)/);
  assert.match(text, /last prompt: сделай/);

  const long = renderState('p', Array.from({ length: 9 }, (_, i) => session(`s${i}`, 'p', '/', { title: 'т'.repeat(80), lastPrompt: 'п'.repeat(200) })), { branch: 'main', changed: Array.from({ length: 50 }, (_, i) => `M ${'f'.repeat(60)}${i}`) });
  assert.ok(long.length <= 1000);
  assert.match(renderState('p', [], { branch: 'dev', changed: ['M a.ts'] }), /Branch: dev[\s\S]*M a\.ts/);
});

const vaultNote = (key: string, file: string, text: string) => kit.write(join(kit.paths.vault, 'projects', key, file), text);
const wikiNote = (name: string, description: string, body: string, type = 'project') =>
  `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: ${type}\n  tags: [infra]\n---\n${body}\n`;

test('search ranks by name and returns short snippets', async () => {
  const filler = 'Unrelated words about the build and the deploy pipeline. '.repeat(20);
  vaultNote('p', 'queue-notes.md', wikiNote('queue-notes', 'How jobs are queued', `${filler}Redis holds the jobs. Redis again. ${filler}`));
  vaultNote('p', 'redis-setup.md', wikiNote('redis-setup', 'How the cache is configured', 'One port, no auth.', 'reference'));
  vaultNote('p', 'MEMORY.md', '- [redis-setup](redis-setup.md) — redis redis redis\n');
  registerMemory(kit.ctx);

  const hits = kit.ctx.memory.search('redis');
  assert.deepEqual(hits.map((h) => h.name), ['redis-setup', 'queue-notes'], 'name outranks body, MEMORY.md is not indexed');
  assert.deepEqual(Object.keys(hits[0]).sort(), ['description', 'id', 'name', 'path', 'project', 'snippet', 'type']);
  assert.equal(hits[0].project, 'p');
  assert.equal(hits[0].type, 'reference');
  assert.equal(hits[0].description, 'How the cache is configured');
  assert.equal(hits[0].path, join(kit.paths.vault, 'projects', 'p', 'redis-setup.md'));
  assert.ok(hits[1].snippet.length <= 160);
  assert.match(hits[1].snippet, /\[Redis\]/);
  assert.equal(kit.ctx.memory.search('   ').length, 0);

  const graph = (await json<MemoryGraph>('GET', '/api/memory/graph')).body;
  assert.equal(hits[0].id, graph.nodes.find((n) => n.file === 'redis-setup.md')!.id, 'hit ids are graph node ids');

  const res = await json<Record<string, unknown>[]>('GET', '/api/memory/search?q=redis');
  assert.equal(res.status, 200);
  assert.equal(res.body.length, 2);
  assert.deepEqual(Object.keys(res.body[0]).sort(), ['description', 'id', 'name', 'project', 'snippet', 'type']);
  assert.ok(String(res.body[1].snippet).includes('\u0001Redis\u0002'));
  assert.equal((await json<unknown[]>('GET', '/api/memory/search?q=redis&limit=1')).body.length, 1);
  assert.deepEqual((await json<unknown[]>('GET', '/api/memory/search')).body, []);
});

test('search filters by project and boosts the caller\'s', async () => {
  const text = wikiNote('deploy-steps', 'How a release is deployed', 'Tag, build, deploy.');
  vaultNote('a', 'deploy-steps.md', text);
  const older = vaultNote('b', 'deploy-steps.md', text);
  utimesSync(older, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000));
  registerMemory(kit.ctx);

  assert.deepEqual(kit.ctx.memory.search('deploy').map((h) => h.project), ['a', 'b'], 'no boost: newer first');
  assert.deepEqual(kit.ctx.memory.search('deploy', { boost: 'b' }).map((h) => h.project), ['b', 'a']);
  assert.deepEqual(kit.ctx.memory.search('deploy', { project: 'b' }).map((h) => h.project), ['b']);
  assert.equal(kit.ctx.memory.search('deploy', { limit: 1 }).length, 1);
  const res = await json<{ project: string }[]>('GET', '/api/memory/search?q=deploy&project=a');
  assert.deepEqual(res.body.map((h) => h.project), ['a']);
});

test('search sees an edit after the watcher or TTL rescan', () => {
  const path = vaultNote('p', 'broker.md', wikiNote('broker', 'Which broker carries events', 'Events go through RabbitMQ.'));
  registerMemory(kit.ctx);
  assert.equal(kit.ctx.memory.search('rabbitmq').length, 1);
  assert.equal(kit.ctx.memory.search('kafka').length, 0);

  writeFileSync(path, wikiNote('broker', 'Which broker carries events', 'Events go through Kafka now.'));
  vaultNote('p', 'topics.md', wikiNote('topics', 'Kafka topic naming', 'One topic per aggregate.'));
  kit.ctx.memory.touch!();
  assert.deepEqual(kit.ctx.memory.search('kafka').map((h) => h.name).sort(), ['broker', 'topics']);
  assert.equal(kit.ctx.memory.search('rabbitmq').length, 0);

  rmSync(path);
  kit.ctx.memory.touch!();
  assert.deepEqual(kit.ctx.memory.search('kafka').map((h) => h.name), ['topics']);
});

test('graph nodes carry lint issue codes for vault notes only', async () => {
  const russian = wikiNote('ru-note', 'Как генерируются миграции', 'Миграции генерируются через diff и проверяются вручную.');
  vaultNote('p', 'ru-note.md', russian);
  vaultNote('p', 'good-note.md', wikiNote('good-note', 'How migrations are generated', 'By the diff tool, see [[ru-note]].'));
  vaultNote('p', 'MEMORY.md', '- [ru-note](ru-note.md) — Как генерируются миграции\n');
  kit.write(join(memDir('-old'), 'ru-note.md'), russian);
  registerMemory(kit.ctx);

  const { body } = await json<MemoryGraph>('GET', '/api/memory/graph');
  const issues = (file: string, connected: boolean) => body.nodes.find((n) => n.file === file && n.connected === connected)!.issues;
  assert.ok(issues('ru-note.md', true).includes('not-english'));
  assert.deepEqual(issues('good-note.md', true), []);
  assert.deepEqual(issues('MEMORY.md', true), []);
  assert.deepEqual(issues('ru-note.md', false), [], 'old-place notes are never linted');

  const note = await json<MemoryNote>('GET', `/api/memory/notes/${body.nodes.find((n) => n.file === 'ru-note.md' && n.connected)!.id}`);
  assert.ok(note.body.node.issues.includes('not-english'));
});

test('a new file in a memory dir invalidates memory; journals beside it do not', async () => {
  const dir = join(kit.paths.claudeDir, 'projects', '-p');
  kit.write(join(dir, 'memory', 'a.md'), 'a');
  registerMemory(kit.ctx);
  await new Promise((r) => setTimeout(r, 300)); // chokidar scan
  kit.write(join(dir, 'x.jsonl'), '{}');
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(kit.topics.includes('memory'), false);
  kit.write(join(dir, 'memory', 'b.md'), 'b');
  await until(() => kit.topics.includes('memory'));
  const { body } = await json<MemoryGraph>('GET', '/api/memory/graph');
  assert.equal(body.nodes.length, 2);
});
