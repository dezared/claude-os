// The kanban board and the agents panel: temp dirs only, nothing touches the real ~/.claude.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import Fastify from 'fastify';
import type { AgentDetail, AgentsReport, KanbanCard, KanbanCardSessions, KanbanSprint, SessionInfo } from '../../shared/contract.ts';
import { createRootMcp } from '../chat/rootMcp.ts';
import type { BusEvents, Ctx, Paths } from '../context.ts';
import { createJournal } from '../journal/index.ts';
import { osChangeLevel } from '../journal/usage.ts';
import { initSchema } from '../journal/db.ts';
import { parseTools, registerAgents, resolveAgentRun } from './agents.ts';
import { createKanban, derivePrefix, kanbanDir, registerKanban } from './kanban.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'claude-os-boards-')));
after(() => rmSync(base, { recursive: true, force: true }));
const status = (code: number) => (e: Error & { statusCode?: number }) => e.statusCode === code;
const titles = (cards: KanbanCard[], column: string) => cards.filter((c) => c.column === column).map((c) => c.title);

describe('kanban storage', () => {
  const dir = join(base, 'kanban-store');
  const alpha = () => [{ key: 'alpha', name: 'alpha' }];
  const board = createKanban(dir, alpha);
  const snapshot = (d: string) => readdirSync(d).filter((n) => n.endsWith('.md') || n.endsWith('.json')).sort().map((n) => [n, readFileSync(join(d, n), 'utf8')]);

  it('adds to the backlog, orders within a column, and survives reading again', () => {
    board.add({ title: ' один ' });
    const two = board.add({ title: 'два', description: 'текст', project: 'alpha', priority: 'high' });
    assert.equal(board.add({ title: 'три' }).column, 'backlog');
    assert.deepEqual(titles(board.list(), 'backlog'), ['один', 'два', 'три']);
    assert.deepEqual([two.project, two.priority, two.description], ['alpha', 'high', 'текст']);
    assert.deepEqual(titles(createKanban(dir, () => []).list(), 'backlog'), ['один', 'два', 'три']);
  });

  it('gives ids like a tracker: a prefix per project, a number that goes on', () => {
    const d = join(base, 'kanban-ids');
    const b = createKanban(d, () => [{ key: 'claudeOS', name: 'claudeOS' }, { key: 'big-web', name: 'big-web' }, { key: 'x', name: 'fresnel' }]);
    assert.equal(b.add({ title: 'a', project: 'claudeOS' }).id, 'OS-1');
    assert.equal(b.add({ title: 'b', project: 'claudeOS' }).id, 'OS-2');
    assert.equal(b.add({ title: 'c', project: 'big-web' }).id, 'BW-1');
    assert.equal(b.add({ title: 'd', project: 'x' }).id, 'FRE-1');
    assert.equal(b.add({ title: 'e' }).id, 'TASK-1');
    b.remove('OS-2');
    assert.equal(b.add({ title: 'f', project: 'claudeOS' }).id, 'OS-3', 'a deleted id is not given again');
    assert.equal(derivePrefix('claudeOS', new Set(['OS'])), 'OS2');
  });

  it('a card is a Markdown file: fields above, the description below', () => {
    const d = join(base, 'kanban-file');
    const b = createKanban(d, alpha);
    const card = b.add({ title: 'Файл', description: '# Заголовок\n\n- пункт\n', project: 'alpha', priority: 'high', column: 'todo' });
    assert.equal(card.path, join(d, 'ALP-1.md'));
    const text = readFileSync(card.path, 'utf8');
    assert.match(text, /^---\ntitle: "Файл"\nproject: "alpha"\npriority: "high"\ncolumn: "todo"\n/);
    assert.ok(text.endsWith('---\n# Заголовок\n\n- пункт\n'));
  });

  it('what is edited in the file by hand is what the board reads, and a change keeps what it does not know', () => {
    const d = join(base, 'kanban-hand');
    const b = createKanban(d, alpha);
    const { id, path } = b.add({ title: 'Было', project: 'alpha' });
    const edited = readFileSync(path, 'utf8').replace('title: "Было"', 'title: Стало').replace('column: "backlog"', 'column: polish').replace(/\n---\n$/, '\ntags:\n  - важное\nfoo: bar\n---\n**жирный**\n');
    writeFileSync(path, edited);
    const read = b.list().find((c) => c.id === id)!;
    assert.deepEqual([read.title, read.column, read.description], ['Стало', 'polish', '**жирный**\n']);
    b.move(id, 'done');
    const after = readFileSync(path, 'utf8');
    assert.match(after, /tags:\n {2}- важное\nfoo: bar\n---\n\*\*жирный\*\*\n$/);
    assert.match(after, /column: "done"/);
    // A file made by hand, with no fields at all, is a card in the backlog; an unknown column does not lose it.
    writeFileSync(join(d, 'ALP-40.md'), '# Новая мысль\nтекст');
    writeFileSync(join(d, 'ALP-41.md'), '---\ncolumn: куда-то\n---\nтекст');
    writeFileSync(join(d, 'Заметка.md'), 'не карточка');
    const list = b.list();
    assert.deepEqual([list.find((c) => c.id === 'ALP-40')!.title, list.find((c) => c.id === 'ALP-40')!.column], ['Новая мысль', 'backlog']);
    assert.equal(list.find((c) => c.id === 'ALP-41')!.column, 'backlog');
    assert.equal(list.length, 3);
    assert.equal(b.add({ title: 'дальше', project: 'alpha' }).id, 'ALP-42');
  });

  it('moves between the five columns and reorders, before a card or to the end', () => {
    const [one, two, three] = board.list();
    board.move(three.id, 'backlog', one.id);
    assert.deepEqual(titles(board.list(), 'backlog'), ['три', 'один', 'два']);
    board.move(three.id, 'backlog');
    assert.deepEqual(titles(board.list(), 'backlog'), ['один', 'два', 'три']);
    assert.equal(board.move(one.id, 'doing').column, 'doing');
    board.move(two.id, 'doing', one.id);
    assert.deepEqual(titles(board.list(), 'doing'), ['два', 'один']);
    assert.deepEqual(titles(board.list(), 'backlog'), ['три']);
    // The end of a column stays that column's end, whatever stands after it.
    board.move(three.id, 'done');
    board.move(one.id, 'done');
    board.move(two.id, 'polish');
    assert.deepEqual(titles(board.list(), 'done'), ['три', 'один']);
    assert.deepEqual(titles(board.list(), 'polish'), ['два']);
    board.move(two.id, 'todo');
    assert.deepEqual(titles(board.list(), 'todo'), ['два']);
  });

  it('many moves into one gap keep the order: the ranks are renumbered when doubles run out', () => {
    const d = join(base, 'kanban-gap');
    const b = createKanban(d, alpha);
    const first = b.add({ title: 'первая' });
    const last = b.add({ title: 'последняя' });
    const moved = b.add({ title: 'ходит' });
    const other = b.add({ title: 'вторая' });
    for (let i = 0; i < 60; i++) b.move(i % 2 ? moved.id : other.id, 'backlog', last.id);
    assert.deepEqual(titles(b.list(), 'backlog'), [first.title, 'вторая', 'ходит', last.title]);
  });

  it('an agent takes a task: its name on the card, waiting cards go to work, back in the queue the mark goes', () => {
    const d = join(base, 'kanban-agent');
    const b = createKanban(d, alpha);
    const { id } = b.add({ title: 'задача', project: 'alpha' });
    const taken = b.take(id, 'Рефакторинг', 'tab-1');
    assert.deepEqual([taken.agent, taken.agentTab, taken.column], ['Рефакторинг', 'tab-1', 'doing']);
    assert.equal(b.list()[0].agent, 'Рефакторинг', 'it is in the file');
    assert.equal(b.move(id, 'polish').agent, 'Рефакторинг', 'a move forward keeps it');
    assert.equal(b.take(id, 'Второй').column, 'polish', 'taking a card further along leaves it there');
    assert.equal(b.move(id, 'todo').agent, undefined, 'back in the queue nobody works on it');
    assert.throws(() => b.take(id, ''), status(400));
    assert.equal(b.update(b.take(id, 'Третий').id, { agent: null }).agent, undefined);
  });

  it('a prefix changes in one place: every card takes it, old ids still find the card', () => {
    const d = join(base, 'kanban-prefix');
    const projects = () => [{ key: 'alpha', name: 'alpha' }, { key: 'beta', name: 'beta' }];
    const b = createKanban(d, projects);
    const one = b.add({ title: 'раз', project: 'alpha' });
    const two = b.add({ title: 'два', project: 'alpha' });
    const other = b.add({ title: 'чужая', project: 'beta' });
    assert.equal(b.prefixes().alpha, 'ALP');
    assert.equal(b.setPrefix('alpha', ' core '), 'CORE');
    assert.deepEqual(b.list().map((c) => c.id), ['CORE-1', 'CORE-2', other.id]);
    assert.ok(!existsSync(one.path));
    assert.equal(b.move(one.id, 'doing').id, 'CORE-1', 'the old id still finds it');
    assert.equal(b.move('core-2', 'doing').title, two.title, 'whatever the case');
    assert.equal(b.add({ title: 'три', project: 'alpha' }).id, 'CORE-3');
    assert.throws(() => b.setPrefix('alpha', 'BET'), status(409));
    assert.throws(() => b.setPrefix('alpha', '1X'), status(400));
    assert.throws(() => b.setPrefix('нет', 'NEW'), status(400));
    assert.equal(b.setPrefix(null, 'GEN'), 'GEN');
    assert.equal(b.add({ title: 'общая' }).id, 'GEN-1');
    // Moved to another project, a card takes that project's prefix too.
    const moved = b.update('CORE-3', { project: 'beta' });
    assert.match(moved.id, /^BET-/);
    assert.equal(b.move('CORE-3', 'done').id, moved.id);
  });

  it('old cards of data/kanban.json move over in order, with nothing lost, once', () => {
    const data = join(base, 'kanban-legacy');
    mkdirSync(data);
    const legacy = join(data, 'kanban.json');
    const old = [
      { id: 'uuid-1', title: 'первая', description: 'текст\nещё', project: 'alpha', priority: 'high', column: 'doing', created: 1000, updated: 2000 },
      { id: 'uuid-2', title: 'вторая', description: '', project: null, priority: 'low', column: 'todo', created: 3000, updated: 4000 },
      { id: 'uuid-3', title: 'третья', description: '', project: 'gone', priority: 'normal', column: 'done', level: 'root', created: 5000, updated: 6000 },
    ];
    writeFileSync(legacy, JSON.stringify({ cards: old }));
    const d = join(data, 'vault-kanban');
    const b = createKanban(d, alpha, { legacy });
    const cards = b.list();
    assert.deepEqual(cards.map((c) => [c.title, c.description, c.project, c.priority, c.column, c.level, c.created, c.updated]), old.map((c) => [c.title, c.description, c.project, c.priority, c.column, c.level, c.created, c.updated]));
    assert.deepEqual(cards.map((c) => c.id), ['ALP-1', 'TASK-1', 'GON-1']);
    assert.ok(!existsSync(legacy));
    assert.ok(existsSync(`${legacy}.migrated`), 'the old file is kept aside');
    assert.equal(b.move('uuid-2', 'backlog').id, 'TASK-1', 'an old id still finds it');
    assert.equal(createKanban(d, alpha, { legacy }).list().length, 3);
    // Interrupted halfway: the next start goes on and gives nothing twice.
    writeFileSync(legacy, JSON.stringify({ cards: [...old, { ...old[0], id: 'uuid-4', title: 'четвёртая' }] }));
    assert.deepEqual(createKanban(d, alpha, { legacy }).list().map((c) => c.title).sort(), ['вторая', 'первая', 'третья', 'четвёртая'].sort());
    // A damaged old file stops everything rather than losing it.
    writeFileSync(legacy, '{ not json');
    assert.throws(() => createKanban(d, alpha, { legacy }).list(), status(500));
    assert.equal(readFileSync(legacy, 'utf8'), '{ not json');
  });

  it('refuses bad input without touching the files', () => {
    const before = snapshot(dir);
    const { id } = board.list().find((c) => c.column === 'todo')!;
    for (const bad of ['', '   ', 5, null, 'x'.repeat(201)]) assert.throws(() => board.add({ title: bad }), status(400), String(bad));
    assert.throws(() => board.add({ title: 't', project: 'нет-такого' }), status(400));
    assert.throws(() => board.add({ title: 't', priority: 'срочно' }), status(400));
    assert.throws(() => board.add({ title: 't', column: 'куда-то' }), status(400));
    assert.throws(() => board.move(id, 'куда-то'), status(400));
    assert.throws(() => board.move('нет', 'todo'), status(404));
    assert.throws(() => board.move(id, 'todo', 'нет'), status(404));
    assert.throws(() => board.move(id, 'todo', board.list().find((c) => c.column === 'done')!.id), status(400));
    assert.throws(() => board.remove('нет'), status(404));
    assert.deepEqual(snapshot(dir), before);
  });

  it('updates fields, clears the project; deleting moves the file aside', () => {
    const card = board.add({ title: 'править', project: 'alpha' });
    const next = board.update(card.id, { title: 'правка', description: 'd', priority: 'low', project: null });
    assert.deepEqual([next.title, next.description, next.priority, next.project], ['правка', 'd', 'low', null]);
    board.remove(next.id);
    assert.ok(!board.list().some((c) => c.id === next.id));
    assert.ok(existsSync(join(dir, '.trash', `${next.id}.md`)));
  });

  it('a level goes only on a card of the Claude OS project, and leaves with the project; old cards stay as they are', () => {
    const data = join(base, 'kanban-levels');
    mkdirSync(data);
    const legacy = join(data, 'kanban.json');
    writeFileSync(legacy, JSON.stringify({ cards: [{ id: 'old', title: 'старая', description: '', project: 'os', priority: 'normal', column: 'todo', created: 1, updated: 1 }] }));
    const d = join(data, 'cards');
    const projects = () => [{ key: 'os', name: 'os' }, { key: 'alpha', name: 'alpha' }];
    const b = createKanban(d, projects, { osProject: () => 'os', legacy });
    assert.equal(b.list()[0].level, undefined, 'an old card loads without one');
    const one = b.add({ title: 'ядро', project: 'os', level: 'root' });
    assert.equal(one.level, 'root');
    assert.equal(b.add({ title: 'без', project: 'os' }).level, undefined);
    assert.throws(() => b.add({ title: 't', project: 'alpha', level: 'user' }), status(400));
    assert.throws(() => b.add({ title: 't', level: 'user' }), status(400));
    assert.throws(() => b.add({ title: 't', project: 'os', level: 'admin' }), status(400));
    assert.equal(b.update('old', { level: 'user' }).level, 'user');
    assert.throws(() => b.update('old', { level: 'admin' }), status(400));
    assert.equal(b.move(one.id, 'doing').level, 'root', 'a move keeps it');
    assert.equal('level' in b.update(one.id, { level: null }), false);
    assert.equal(b.update('old', { project: 'alpha' }).level, undefined, 'leaves with the project');
    assert.equal(b.list().find((c) => c.title === 'старая')!.level, undefined);
    assert.throws(() => createKanban(d, projects).update(one.id, { level: 'user' }), status(400), 'no Claude OS project known');
  });

  it('take records the session', () => {
    const d = join(base, 'kanban-sessions');
    const live: Record<string, string | null> = { 'tab-1': 'sess-a', 'tab-2': null };
    const b = createKanban(d, alpha, { sessionOf: (tab) => live[tab] ?? null });
    const { id } = b.add({ title: 'задача' });
    assert.deepEqual(b.take(id, 'Claude', 'tab-1').sessions, ['sess-a'], 'a waiting card, taken through a move');
    assert.deepEqual(b.take(id, 'Claude', 'tab-1').sessions, ['sess-a'], 'not twice');
    const other = b.add({ title: 'другая', column: 'doing' });
    assert.equal(b.take(other.id, 'Claude', 'tab-2').sessions, undefined, 'a tab with no session yet adds nothing');
    // The tab gets its session later, or a new one after /clear: every card it took appends it.
    assert.equal(b.recordSession('tab-2', 'sess-b'), true);
    assert.equal(b.recordSession('tab-2', 'sess-b'), false);
    assert.equal(b.recordSession('tab-x', 'sess-c'), false);
    assert.deepEqual(b.list().find((c) => c.id === other.id)!.sessions, ['sess-b']);
    for (let i = 0; i < 25; i++) b.recordSession('tab-1', `s${i}`);
    const sessions = b.list().find((c) => c.id === id)!.sessions!;
    assert.equal(sessions.length, 20);
    assert.deepEqual([sessions[0], sessions.at(-1)], ['s5', 's24'], 'the oldest go');
    assert.match(readFileSync(join(d, `${id}.md`), 'utf8'), /^sessions: \["s5",/m);
    assert.deepEqual(b.move(id, 'todo').sessions?.length, 20, 'released, the history stays');
    // A finished card is history: only cards in doing or polish take the tab's next session.
    b.move(other.id, 'done');
    const polished = b.add({ title: 'полировка', column: 'polish' });
    b.take(polished.id, 'Claude', 'tab-2');
    assert.equal(b.recordSession('tab-2', 'sess-d'), true);
    assert.deepEqual(b.list().find((c) => c.id === other.id)!.sessions, ['sess-b'], 'done: not appended');
    assert.deepEqual(b.list().find((c) => c.id === polished.id)!.sessions, ['sess-d']);
  });

  it('sprints: added, renamed, set on cards, removed with the field', () => {
    const d = join(base, 'kanban-sprints');
    const b = createKanban(d, alpha);
    const one = b.addSprint(' Ноябрь ');
    const two = b.addSprint('Декабрь');
    assert.deepEqual([one, two], [{ id: 'S1', name: 'Ноябрь' }, { id: 'S2', name: 'Декабрь' }]);
    assert.throws(() => b.addSprint(' '), status(400));
    assert.equal(b.updateSprint('S2', 'Зима').name, 'Зима');
    assert.throws(() => b.updateSprint('S9', 'x'), status(404));
    const card = b.add({ title: 'в спринте', sprint: 'S1' });
    assert.equal(card.sprint, 'S1');
    assert.throws(() => b.add({ title: 't', sprint: 'S9' }), status(400));
    assert.equal(b.move(card.id, 'doing', null, undefined, undefined, 'S2').sprint, 'S2');
    assert.equal(b.update(card.id, { sprint: null }).sprint, undefined);
    assert.equal(b.update(card.id, { sprint: 'S1' }).sprint, 'S1');
    assert.equal(b.add({ title: 'карточка' }).id, 'TASK-2', 'sprints do not take card numbers');
    b.removeSprint('S1');
    assert.deepEqual(b.sprints(), [{ id: 'S2', name: 'Зима' }]);
    assert.doesNotMatch(readFileSync(card.path, 'utf8'), /sprint:/, 'the card loses the field');
    assert.equal(b.list().find((c) => c.id === card.id)!.column, 'doing');
    assert.equal(b.addSprint('Новый').id, 'S3', 'a removed id is not given again');
    assert.throws(() => b.removeSprint('S1'), status(404));
  });

  it('unknown sprint falls back', () => {
    const d = join(base, 'kanban-sprint-unknown');
    const b = createKanban(d, alpha);
    b.addSprint('Ноябрь');
    const { id, path } = b.add({ title: 'правка в Obsidian', sprint: 'S1' });
    writeFileSync(path, readFileSync(path, 'utf8').replace('sprint: "S1"', 'sprint: S7'));
    const plain = b.add({ title: 'без спринта' });
    writeFileSync(join(d, 'TASK-9.md'), '---\ntitle: руками\n---\n');
    const cards = b.list();
    assert.equal(cards.length, 3, 'never lost');
    for (const c of cards) assert.equal(c.sprint, undefined, c.id);
    assert.equal(b.move(id, 'doing').sprint, undefined);
    assert.match(readFileSync(path, 'utf8'), /^sprint: "S7"$/m, 'an unrelated write keeps the id in the file');
    b.take(id, 'Claude', 'tab-1');
    b.recordSession('tab-1', 'sess-1');
    assert.match(readFileSync(path, 'utf8'), /^sprint: "S7"$/m);
    assert.equal(b.list().find((c) => c.id === id)!.sprint, undefined, 'still shown as no sprint');
    assert.equal(b.update(id, { sprint: 'S1' }).sprint, 'S1', 'a sprint set replaces it');
    assert.match(readFileSync(path, 'utf8'), /^sprint: "S1"$/m);
    assert.equal(plain.sprint, undefined);
  });

  it('a damaged board file is refused and left as it is', () => {
    const damaged = join(base, 'damaged');
    mkdirSync(damaged);
    writeFileSync(join(damaged, '_board.json'), '{ not json');
    const b = createKanban(damaged, () => []);
    assert.throws(() => b.add({ title: 't' }), status(500));
    assert.equal(readFileSync(join(damaged, '_board.json'), 'utf8'), '{ not json');
  });
});

test('kanban over HTTP: concurrent writes lose nothing and leave no temp files', async () => {
  const data = join(base, 'http-data');
  const vault = join(base, 'http-vault');
  const app = Fastify();
  const topics: string[] = [];
  const ctx = { app, paths: { data, vault }, journal: { listProjects: () => [{ key: 'alpha', name: 'alpha' }] }, audit: () => {}, invalidate: (...t: string[]) => topics.push(...t) };
  registerKanban(ctx as never);

  const made = await Promise.all(Array.from({ length: 60 }, (_, i) => app.inject({ method: 'POST', url: '/api/kanban/cards', payload: { title: `c${i}` } })));
  assert.ok(made.every((r) => r.statusCode === 200));
  const list = () => app.inject({ url: '/api/kanban' }).then((r) => r.json<{ path: string; cards: KanbanCard[]; prefixes: Record<string, string> }>());
  const first = await list();
  assert.equal(first.path, kanbanDir(ctx as never));
  assert.equal(new Set(first.cards.map((c) => c.id)).size, 60);
  assert.equal(first.prefixes.alpha, 'ALP');

  const moves = first.cards.slice(0, 30).map((c, i) => app.inject({ method: 'POST', url: `/api/kanban/cards/${c.id}/move`, payload: { column: i % 2 ? 'doing' : 'done' } }));
  const edits = first.cards.slice(30, 45).map((c) => app.inject({ method: 'PATCH', url: `/api/kanban/cards/${c.id}`, payload: { description: 'x' } }));
  const adds = Array.from({ length: 15 }, (_, i) => app.inject({ method: 'POST', url: '/api/kanban/cards', payload: { title: `n${i}` } }));
  const gone = first.cards.slice(45, 50).map((c) => app.inject({ method: 'DELETE', url: `/api/kanban/cards/${c.id}` }));
  const all = await Promise.all([...moves, ...edits, ...adds, ...gone]);
  assert.ok(all.every((r) => r.statusCode === 200));

  const { cards } = await list();
  assert.equal(cards.length, 70);
  assert.equal(cards.filter((c) => c.column === 'doing').length, 15);
  assert.equal(cards.filter((c) => c.column === 'done').length, 15);
  assert.equal(cards.filter((c) => c.description === 'x').length, 15);
  const files = readdirSync(kanbanDir(ctx as never));
  assert.equal(files.filter((n) => n.endsWith('.md')).length, 70);
  assert.deepEqual(files.filter((n) => n.endsWith('.tmp')), [], 'no temp file stays');
  assert.ok(topics.includes('kanban'));
  assert.equal((await app.inject({ method: 'POST', url: '/api/kanban/cards', payload: { title: 't', project: 'нет' } })).statusCode, 400);
  const taken = await app.inject({ method: 'POST', url: `/api/kanban/cards/${cards[0].id}/take`, payload: { agent: 'Claude', tab: 't1' } });
  assert.equal(taken.json<KanbanCard>().agent, 'Claude');
  const renamed = await app.inject({ method: 'PUT', url: '/api/kanban/prefix', payload: { project: null, prefix: 'gen' } });
  assert.equal(renamed.json<{ prefix: string }>().prefix, 'GEN');
  await app.close();
});

test('sessions endpoint lists live and ended', async () => {
  const app = Fastify();
  const session = (id: string, lastActivity: number) => ({ id, lastActivity, status: 'ended' }) as SessionInfo;
  const tabs = [{ id: 'tab-live', sessionId: 'now' }];
  const ctx = {
    app,
    paths: { data: join(base, 'card-sessions-data'), vault: join(base, 'card-sessions-vault') },
    journal: { listProjects: () => [], listSessions: () => [session('old', 1), session('a', 2), session('b', 3), session('c', 4), session('now', 5), session('other', 6)] },
    chat: { list: () => tabs },
    audit: () => {},
    invalidate: () => {},
  };
  registerKanban(ctx as never);
  const made = (await app.inject({ method: 'POST', url: '/api/kanban/cards', payload: { title: 't', column: 'doing' } })).json<KanbanCard>();
  const board = createKanban(kanbanDir(ctx as never), () => []);
  await app.inject({ method: 'POST', url: `/api/kanban/cards/${made.id}/take`, payload: { agent: 'Claude', tab: 'tab-live' } });
  for (const s of ['old', 'a', 'b', 'c']) board.recordSession('tab-live', s);
  const got = (await app.inject({ url: `/api/kanban/cards/${made.id}/sessions` })).json<KanbanCardSessions>();
  assert.equal(got.live?.id, 'tab-live');
  assert.deepEqual(got.ended.map((s) => s.id), ['c', 'b', 'a'], 'newest first, three, the live one apart');
  assert.deepEqual(board.list()[0].sessions, ['now', 'old', 'a', 'b', 'c'], 'take recorded the tab\'s session');
  // The tab is gone: no live tab, the history is still there.
  tabs.length = 0;
  const later = (await app.inject({ url: `/api/kanban/cards/${made.id}/sessions` })).json<KanbanCardSessions>();
  assert.equal(later.live, null);
  assert.deepEqual(later.ended.map((s) => s.id), ['now', 'c', 'b']);
  assert.equal((await app.inject({ url: '/api/kanban/cards/NOPE-1/sessions' })).statusCode, 404);
  await app.close();
});

test('sprints over HTTP', async () => {
  const app = Fastify();
  const ctx = { app, paths: { data: join(base, 'sprint-data'), vault: join(base, 'sprint-vault') }, journal: { listProjects: () => [] }, audit: () => {}, invalidate: () => {} };
  registerKanban(ctx as never);
  const made = (await app.inject({ method: 'POST', url: '/api/kanban/sprints', payload: { name: 'Ноябрь' } })).json<KanbanSprint>();
  assert.deepEqual(made, { id: 'S1', name: 'Ноябрь' });
  assert.equal((await app.inject({ method: 'POST', url: '/api/kanban/sprints', payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: 'PATCH', url: '/api/kanban/sprints/S1', payload: { name: 'Зима' } })).json<KanbanSprint>().name, 'Зима');
  const card = (await app.inject({ method: 'POST', url: '/api/kanban/cards', payload: { title: 't', sprint: 'S1' } })).json<KanbanCard>();
  assert.equal(card.sprint, 'S1');
  assert.equal((await app.inject({ method: 'POST', url: `/api/kanban/cards/${card.id}/move`, payload: { column: 'done', sprint: null } })).json<KanbanCard>().sprint, undefined);
  assert.deepEqual((await app.inject({ url: '/api/kanban' })).json<{ sprints: KanbanSprint[] }>().sprints, [{ id: 'S1', name: 'Зима' }]);
  assert.deepEqual((await app.inject({ url: '/api/kanban/sprints' })).json(), [{ id: 'S1', name: 'Зима' }]);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/kanban/sprints/S1' })).statusCode, 200);
  assert.equal((await app.inject({ method: 'DELETE', url: '/api/kanban/sprints/S1' })).statusCode, 404);
  await app.close();
});

test('an edit made in Obsidian reaches the screen: the folder is watched', async () => {
  const vault = join(base, 'watch-vault');
  const app = Fastify();
  const topics: string[] = [];
  const ctx = { app, paths: { data: join(base, 'watch-data'), vault }, journal: { listProjects: () => [] }, audit: () => {}, invalidate: (...t: string[]) => topics.push(...t) };
  registerKanban(ctx as never);
  const made = (await app.inject({ method: 'POST', url: '/api/kanban/cards', payload: { title: 't' } })).json<KanbanCard>();
  await app.inject({ url: '/api/kanban' });
  await new Promise((r) => setTimeout(r, 400));
  topics.length = 0;
  writeFileSync(made.path, readFileSync(made.path, 'utf8').replace('title: "t"', 'title: "другой"'));
  for (let i = 0; i < 80 && !topics.includes('kanban'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(topics.includes('kanban'));
  await app.close();
});

test('the root session adds, moves and takes cards through its tools', async () => {
  const vault = join(base, 'tool-vault');
  const topics: string[] = [];
  const ctx = { paths: { data: join(base, 'tool-data'), config: join(base, 'tool-config'), root: join(base, 'tool-root'), vault, repo: '/os' }, journal: { listProjects: () => [{ key: 'alpha', name: 'alpha' }, { key: 'os', name: 'os' }], projectForCwd: (cwd: string) => (cwd === '/os' ? 'os' : null) }, audit: () => {}, invalidate: (...t: string[]) => topics.push(...t) };
  const server = createRootMcp(ctx as never, {} as never, 'tab-root', 'Главная');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  const parsed = <T>(r: Awaited<ReturnType<typeof client.callTool>>) => JSON.parse((r.content as { text: string }[])[0].text) as T;

  assert.equal((await client.callTool({ name: 'add_kanban_card', arguments: { title: 't', project: 'нет-такого' } })).isError, true);
  const one = parsed<KanbanCard>(await client.callTool({ name: 'add_kanban_card', arguments: { title: 'Первая', project: 'alpha', priority: 'high' } }));
  const two = parsed<KanbanCard>(await client.callTool({ name: 'add_kanban_card', arguments: { title: 'Вторая', column: 'backlog' } }));
  assert.deepEqual([one.id, two.id, one.column], ['ALP-1', 'TASK-1', 'backlog']);
  assert.equal(parsed<KanbanCard>(await client.callTool({ name: 'move_kanban_card', arguments: { id: two.id, column: 'backlog', before: one.id } })).id, two.id);
  assert.deepEqual(parsed<KanbanCard[]>(await client.callTool({ name: 'list_kanban_cards', arguments: {} })).map((c) => c.title), ['Вторая', 'Первая']);
  assert.deepEqual(parsed<KanbanCard[]>(await client.callTool({ name: 'list_kanban_cards', arguments: { project: 'alpha' } })).map((c) => c.title), ['Первая']);
  assert.deepEqual(parsed<KanbanCard[]>(await client.callTool({ name: 'list_kanban_cards', arguments: { project: null } })).map((c) => c.title), ['Вторая']);
  assert.equal(parsed<KanbanCard>(await client.callTool({ name: 'move_kanban_card', arguments: { id: one.id, column: 'polish' } })).column, 'polish');
  assert.equal((await client.callTool({ name: 'move_kanban_card', arguments: { id: 'нет', column: 'doing' } })).isError, true);
  assert.equal(topics.filter((t) => t === 'kanban').length, 4);
  const taken = parsed<KanbanCard>(await client.callTool({ name: 'take_kanban_card', arguments: { id: two.id } }));
  assert.deepEqual([taken.agent, taken.agentTab, taken.column], ['Главная', 'tab-root', 'doing']);
  assert.equal(parsed<KanbanCard>(await client.callTool({ name: 'take_kanban_card', arguments: { id: two.id, agent: 'Ревьюер' } })).agent, 'Ревьюер');
  assert.equal(parsed<KanbanCard>(await client.callTool({ name: 'add_kanban_card', arguments: { title: 'Про ядро', project: 'os', level: 'root' } })).level, 'root');
  assert.equal((await client.callTool({ name: 'add_kanban_card', arguments: { title: 'Не там', project: 'alpha', level: 'root' } })).isError, true);

  const updated = parsed<KanbanCard>(await client.callTool({ name: 'update_kanban_card', arguments: { id: two.id, title: 'Вторая, правка', description: 'текст', priority: 'low' } }));
  assert.deepEqual([updated.id, updated.title, updated.description, updated.priority, updated.agent], [two.id, 'Вторая, правка', 'текст', 'low', 'Ревьюер']);
  assert.match(parsed<KanbanCard>(await client.callTool({ name: 'update_kanban_card', arguments: { id: two.id, project: 'alpha' } })).id, /^ALP-/);
  assert.equal((await client.callTool({ name: 'update_kanban_card', arguments: { id: 'нет', title: 'x' } })).isError, true);
  assert.equal((await client.callTool({ name: 'update_kanban_card', arguments: { id: one.id, sprint: 'S1' } })).isError, true, 'no such sprint yet');
  const sprint = parsed<KanbanSprint>(await client.callTool({ name: 'add_kanban_sprint', arguments: { name: 'Ноябрь' } }));
  assert.equal(parsed<KanbanCard>(await client.callTool({ name: 'update_kanban_card', arguments: { id: one.id, sprint: sprint.id } })).sprint, sprint.id);
  assert.equal(parsed<KanbanCard>(await client.callTool({ name: 'add_kanban_card', arguments: { title: 'Третья', sprint: sprint.id } })).sprint, sprint.id);
  assert.equal(parsed<KanbanCard>(await client.callTool({ name: 'move_kanban_card', arguments: { id: one.id, column: 'done', sprint: null } })).sprint, undefined);
  assert.equal(parsed<KanbanSprint>(await client.callTool({ name: 'update_kanban_sprint', arguments: { id: sprint.id, name: 'Зима' } })).name, 'Зима');
  assert.deepEqual(parsed<KanbanSprint[]>(await client.callTool({ name: 'list_kanban_sprints', arguments: {} })), [{ id: sprint.id, name: 'Зима' }]);
  await client.callTool({ name: 'remove_kanban_sprint', arguments: { id: sprint.id } });
  assert.deepEqual(parsed<KanbanSprint[]>(await client.callTool({ name: 'list_kanban_sprints', arguments: {} })), []);
  assert.ok(parsed<KanbanCard[]>(await client.callTool({ name: 'list_kanban_cards', arguments: {} })).every((c) => c.sprint === undefined));
  await client.close();
});

describe('agents', () => {
  const dir = join(base, 'agents');
  const claudeDir = join(dir, 'claude');
  const projectRoot = join(dir, 'alpha');
  const plugin = join(dir, 'plugin-install');
  const data = join(dir, 'data');
  const agent = (name: string, extra = '') => `---\nname: ${name}\ndescription: Does ${name}\n${extra}---\n\n# ${name}\n`;
  const put = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };

  put(join(claudeDir, 'agents/reviewer.md'), agent('reviewer', 'model: opus\ntools: Read, Grep\n'));
  put(join(claudeDir, 'agents/nested/writer.md'), agent('writer', 'tools:\n  - Edit\n  - Write\n'));
  put(join(claudeDir, 'agents/README.md'), '# not an agent\n');
  put(join(dir, 'shared-agent.md'), agent('linked'));
  symlinkSync(join(dir, 'shared-agent.md'), join(claudeDir, 'agents/linked.md'));
  put(join(projectRoot, '.claude/agents/reviewer.md'), agent('reviewer', 'model: sonnet\n'));
  put(join(plugin, 'agents/helper.md'), agent('helper'));
  put(join(claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'kit@market': [{ installPath: plugin, scope: 'user' }] } }));

  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, diff TEXT)');
  initSchema(db);
  const now = Date.now();
  const old = now - 90 * 86_400_000;
  db.exec(`INSERT INTO sessions (id, project, cwd) VALUES ('s-alpha', 'alpha', '${projectRoot}'), ('s-other', 'other', '/x'), ('s-gone', 'alpha', '${projectRoot}')`);
  db.exec("UPDATE sessions SET removed = 1 WHERE id = 's-gone'");
  const run = db.prepare('INSERT INTO subagents (session, id, agent_type, description, last_activity) VALUES (?, ?, ?, ?, ?)');
  run.run('s-alpha', 'a1', 'reviewer', 'review the queue', now);
  run.run('s-other', 'a2', 'reviewer', null, now);
  run.run('s-other', 'a3', 'reviewer', null, old);
  run.run('s-other', 'a4', 'kit:helper', null, now);
  run.run('s-other', 'a5', 'Explore', null, now);
  run.run('s-other', 'a6', null, null, now);
  run.run('s-gone', 'a7', 'reviewer', null, now);
  db.prepare("INSERT INTO usage_messages (message_id, session, agent_id, ts, day, model, is_subagent, input, output, cache_read, cache_write) VALUES ('m1', 's-alpha', 'a1', ?, '2026-11-05', 'x', 1, 1, 2, 1000, 4)").run(now);

  const app = Fastify();
  const topics: string[] = [];
  const ctx = {
    app, db,
    paths: { claudeDir, claudeJson: join(dir, 'claude.json'), data },
    journal: { listProjects: () => [{ key: 'alpha', name: 'Alpha', root: projectRoot }] },
    audit() {},
    invalidate: (...t: string[]) => topics.push(...t),
  };
  registerAgents(ctx as never);
  after(() => app.close());
  const report = () => app.inject({ url: '/api/agents' }).then((r) => r.json<AgentsReport>());
  const url = (id: string) => `/api/agents/${encodeURIComponent(id)}`;

  it('finds user, project and plugin agents and reads what the files state, nothing more', async () => {
    const { rows, projects } = await report();
    assert.deepEqual(rows.map((r) => r.id).sort(), ['plugin:kit:helper', 'project:alpha:reviewer', 'user:linked', 'user:reviewer', 'user:writer']);
    const user = rows.find((r) => r.id === 'user:reviewer')!;
    assert.deepEqual([user.scope, user.source, user.description, user.model, user.tools], ['user', null, 'Does reviewer', 'opus', ['Read', 'Grep']]);
    assert.deepEqual(rows.find((r) => r.id === 'user:writer')!.tools, ['Edit', 'Write']);
    const own = rows.find((r) => r.id === 'project:alpha:reviewer')!;
    assert.deepEqual([own.scope, own.source, own.model, own.tools], ['project', 'alpha', 'sonnet', null]);
    const helper = rows.find((r) => r.id === 'plugin:kit:helper')!;
    assert.deepEqual([helper.scope, helper.source, helper.readOnly, helper.model], ['plugin', 'kit', true, null]);
    assert.equal(rows.find((r) => r.id === 'user:linked')!.isSymlink, true);
    assert.deepEqual(projects.map((p) => [p.project, p.name, p.own, p.overrides]), [['alpha', 'Alpha', [], ['reviewer']]]);
  });

  it('counts only what the journal holds: runs by type, tokens, the project copy first', async () => {
    const r = await report();
    const of = (id: string) => r.rows.find((x) => x.id === id)!;
    assert.deepEqual([of('project:alpha:reviewer').runs, of('project:alpha:reviewer').runsAll, of('project:alpha:reviewer').tokens], [1, 1, 7], 'cache reads are not tokens spent; a removed session is gone');
    assert.deepEqual([of('user:reviewer').runs, of('user:reviewer').runsAll, of('user:reviewer').tokens], [1, 2, 0]);
    assert.equal(of('plugin:kit:helper').runs, 1);
    assert.deepEqual([of('user:writer').runs, of('user:writer').lastUsedAt], [0, null]);
    assert.deepEqual(r.other.map((o) => [o.name, o.runs]), [['Explore', 1]]);
    assert.equal(r.untyped, 1);
    assert.equal(r.byDay.length, r.windowDays);
    assert.equal(r.byDay.at(-1)!.runs, 4);
  });

  it('the page has the file, the runs and where they ran', async () => {
    const res = await app.inject({ url: url('project:alpha:reviewer') });
    const d = res.json<AgentDetail>();
    assert.match(d.content, /# reviewer/);
    assert.deepEqual([d.stats.total, d.stats.recent], [1, 1]);
    assert.deepEqual(d.stats.byProject, [{ key: 'alpha', name: 'Alpha', n: 1 }]);
    assert.deepEqual(d.recent.map((x) => [x.session, x.description, x.tokens]), [['s-alpha', 'review the queue', 7]]);
    assert.equal((await app.inject({ url: url('user:нет') })).statusCode, 404);
  });

  it('deleting needs a confirmation, backs the file up, leaves a linked target and plugins alone', async () => {
    const file = join(claudeDir, 'agents/nested/writer.md');
    assert.equal((await app.inject({ method: 'DELETE', url: url('user:writer'), payload: {} })).statusCode, 400);
    assert.ok(existsSync(file));
    const done = await app.inject({ method: 'DELETE', url: url('user:writer'), payload: { confirmed: true } });
    const { backup } = done.json<{ backup: string }>();
    assert.ok(!existsSync(file));
    assert.ok(backup.startsWith(join(data, 'backups')));
    assert.match(readFileSync(backup, 'utf8'), /# writer/);
    assert.ok(topics.includes('agents'));

    assert.equal((await app.inject({ method: 'DELETE', url: url('user:linked'), payload: { confirmed: true } })).json<{ backup: null }>().backup, null);
    assert.ok(!existsSync(join(claudeDir, 'agents/linked.md')));
    assert.ok(existsSync(join(dir, 'shared-agent.md')));

    assert.equal((await app.inject({ method: 'DELETE', url: url('plugin:kit:helper'), payload: { confirmed: true } })).statusCode, 403);
    assert.ok(existsSync(join(plugin, 'agents/helper.md')));
  });

  it('parses the forms of a tools line', () => {
    assert.equal(parseTools(undefined), null);
    assert.deepEqual(parseTools('Read, Grep'), ['Read', 'Grep']);
    assert.deepEqual(parseTools('[Read, "Grep"]'), ['Read', 'Grep']);
    assert.deepEqual(parseTools('- Read - Bash(git log:*)'), ['Read', 'Bash(git log:*)']);
  });

  it('a run goes to the agent that would have run', () => {
    const list = [{ name: 'a', scope: 'plugin', source: 'kit' }, { name: 'a', scope: 'user', source: null }, { name: 'a', scope: 'project', source: 'p' }] as const;
    assert.equal(resolveAgentRun('a', 'p', [...list])?.scope, 'project');
    assert.equal(resolveAgentRun('a', 'q', [...list])?.scope, 'user');
    assert.equal(resolveAgentRun('kit:a', 'p', [...list])?.scope, 'plugin');
    assert.equal(resolveAgentRun('b', 'p', [...list]), null);
  });
});

describe('sessions of the root folder and levels of change', () => {
  const dir = join(base, 'levels');
  const claudeDir = join(dir, 'claude');
  const repo = join(dir, 'claudeOS');
  const root = join(repo, 'root');
  const config = join(repo, 'config');
  const journalDir = join(claudeDir, 'projects', '-x');
  const assistant = (session: string, cwd: string, id: string, tools: { name: string; path?: string }[]) => JSON.stringify({
    type: 'assistant', uuid: id, sessionId: session, cwd, entrypoint: 'cli', timestamp: new Date().toISOString(),
    message: { id, model: 'claude-test', role: 'assistant', usage: { input_tokens: 1, output_tokens: 1 }, content: tools.map((t, i) => ({ type: 'tool_use', id: `${id}-${i}`, name: t.name, input: { file_path: t.path } })) },
  });
  mkdirSync(journalDir, { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'));
  mkdirSync(root, { recursive: true });
  mkdirSync(join(repo, 'server'));
  mkdirSync(config);

  const start = async (db: DatabaseSync) => {
    const paths = { repo, root, config, claudeDir, claudeJson: join(dir, 'claude.json'), claudeBin: '/nonexistent/claude', data: join(dir, 'data'), vault: join(dir, 'vault') } as Paths;
    const ctx = {
      journal: null,
      memory: { projectStats: () => ({ count: 0, connected: false, drift: 0 }), recentNotes: () => [] },
      app: Fastify(), db, paths, bus: new EventEmitter<BusEvents>(), broadcast() {}, invalidate() {}, audit() {}, onClientMessage() {}, onClientClose() {}, setBusy() {},
    } as unknown as Ctx;
    const journal = createJournal(ctx, { pollAgents: false, watch: false });
    await journal.start();
    await journal.indexer.backfillUsage();
    return { ctx, journal };
  };

  it('a session in claudeOS/root counts as Claude OS, with a tag, and its own key still names the folder', async () => {
    writeFileSync(join(journalDir, 'in-root.jsonl'), `${assistant('in-root', root, 'm1', [{ name: 'Edit', path: join(repo, 'server/a.ts') }, { name: 'Write', path: join(config, 'widgets.json') }, { name: 'Edit', path: join(repo, 'web/src/b.tsx') }, { name: 'Read', path: join(repo, 'server/c.ts') }, { name: 'Edit', path: join(repo, 'docs/d.md') }, { name: 'Edit', path: '/elsewhere/server/e.ts' }])}\n`);
    writeFileSync(join(journalDir, 'in-repo.jsonl'), `${assistant('in-repo', repo, 'm2', [{ name: 'Edit', path: join(config, 'settings.json') }])}\n`);
    writeFileSync(join(journalDir, 'other.jsonl'), `${assistant('other', join(dir, 'app'), 'm3', [{ name: 'Bash' }])}\n`);
    const db = new DatabaseSync(':memory:');
    const { ctx, journal } = await start(db);
    const sessions = ctx.journal.listSessions();
    const of = (id: string) => sessions.find((s) => s.id === id) as SessionInfo;
    assert.equal(of('in-root').project, 'claudeOS');
    assert.equal(of('in-root').rootFolder, true);
    assert.deepEqual(of('in-root').osChanges, { user: 1, root: 2 });
    assert.equal(of('in-repo').project, 'claudeOS');
    assert.equal(of('in-repo').rootFolder, undefined);
    assert.deepEqual(of('in-repo').osChanges, { user: 1, root: 0 });
    assert.equal(of('other').osChanges, undefined);
    assert.equal(of('other').project, 'app');

    const core = ctx.journal.listProjects().find((p) => p.key === 'claudeOS')!;
    assert.equal(core.sessionCount, 2, 'the root folder is counted in the project');
    assert.ok(!ctx.journal.listProjects(true).some((p) => p.root === root), 'and is not a project of its own');
    assert.equal(ctx.journal.projectForCwd(root), 'root', 'the folder keeps its key: the map and the notes go by it');
    await journal.stop();
    await ctx.app.close();
    db.close();
  });

  it('a database from before moves its root sessions over once and marks old edits', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, diff TEXT)');
    initSchema(db);
    const offset = Buffer.byteLength(readFileSync(join(journalDir, 'in-root.jsonl')));
    db.prepare("INSERT INTO sessions (id, project, cwd, last_activity) VALUES ('in-root', 'root', ?, 1)").run(root);
    db.prepare('INSERT INTO file_offsets (path, offset) VALUES (?, ?)').run(join(journalDir, 'in-root.jsonl'), offset); // read long ago
    db.exec("INSERT INTO journal_meta (k, v) VALUES ('projects_version', '2'), ('usage_backfill', '1')");
    const { ctx, journal } = await start(db);
    const s = ctx.journal.listSessions().find((x) => x.id === 'in-root')!;
    assert.equal(s.project, 'claudeOS');
    assert.deepEqual(s.osChanges, { user: 1, root: 2 });
    await journal.stop();
    await ctx.app.close();
    db.close();
  });

  it('what counts as which level', () => {
    const roots = { repo, config };
    assert.equal(osChangeLevel({ name: 'Edit', path: join(config, 'widgets.json') }, roots), 'user');
    for (const part of ['server/x.ts', 'web/src/x.tsx', 'shared/contract.ts', 'e2e/x.ts']) assert.equal(osChangeLevel({ name: 'Write', path: join(repo, part) }, roots), 'root');
    for (const call of [{ name: 'Read', path: join(repo, 'server/x.ts') }, { name: 'Edit', path: join(repo, 'docs/x.md') }, { name: 'Edit', path: join(repo, 'serverless/x.ts') }, { name: 'Bash', path: null }, { name: 'Edit', path: 'server/x.ts' }]) {
      assert.equal(osChangeLevel(call, roots), null, JSON.stringify(call));
    }
  });
});
