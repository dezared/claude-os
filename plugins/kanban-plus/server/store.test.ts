// Kanban+ storage: the built-in board's tests, carried over with the plugin, and what Kanban+ adds. Temp dirs only.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { parseFrontmatter } from '../../../server/memory/util.ts';
import { createKanban } from './board.ts';
import { derivePrefix } from './cardFile.ts';
import type { BoardOptions, BoardProject } from './store.ts';
import type { Card } from './types.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'kanban-plus-')));
after(() => rmSync(base, { recursive: true, force: true }));
const status = (code: number) => (e: Error & { statusCode?: number }) => e.statusCode === code;
const titles = (cards: Card[], column: string) => cards.filter((c) => c.column === column).map((c) => c.title);
const kb = (dir: string, projects: () => BoardProject[], options: Partial<BoardOptions> = {}) => createKanban(dir, { projects, frontmatter: parseFrontmatter, ...options });

describe('kanban storage', () => {
  const dir = join(base, 'kanban-store');
  const alpha = () => [{ key: 'alpha', name: 'alpha' }];
  const board = kb(dir, alpha);
  const snapshot = (d: string) => readdirSync(d).filter((n) => n.endsWith('.md') || n.endsWith('.json')).sort().map((n) => [n, readFileSync(join(d, n), 'utf8')]);

  it('adds to the backlog, orders within a column, and survives reading again', () => {
    board.add({ title: ' один ' });
    const two = board.add({ title: 'два', description: 'текст', project: 'alpha', priority: 'high' });
    assert.equal(board.add({ title: 'три' }).column, 'backlog');
    assert.deepEqual(titles(board.list(), 'backlog'), ['один', 'два', 'три']);
    assert.deepEqual([two.project, two.priority, two.description], ['alpha', 'high', 'текст']);
    assert.deepEqual(titles(kb(dir, () => []).list(), 'backlog'), ['один', 'два', 'три']);
  });

  it('gives ids like a tracker: a prefix per project, a number that goes on', () => {
    const d = join(base, 'kanban-ids');
    const b = kb(d, () => [{ key: 'claudeOS', name: 'claudeOS' }, { key: 'big-web', name: 'big-web' }, { key: 'x', name: 'fresnel' }]);
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
    const b = kb(d, alpha);
    const card = b.add({ title: 'Файл', description: '# Заголовок\n\n- пункт\n', project: 'alpha', priority: 'high', column: 'todo' });
    assert.equal(card.path, join(d, 'ALP-1.md'));
    const text = readFileSync(card.path, 'utf8');
    assert.match(text, /^---\ntitle: "Файл"\nproject: "alpha"\npriority: "high"\ncolumn: "todo"\n/);
    assert.ok(text.endsWith('---\n# Заголовок\n\n- пункт\n'));
  });

  it('what is edited in the file by hand is what the board reads, and a change keeps what it does not know', () => {
    const d = join(base, 'kanban-hand');
    const b = kb(d, alpha);
    const { id, path } = b.add({ title: 'Было', project: 'alpha' });
    const edited = readFileSync(path, 'utf8').replace('title: "Было"', 'title: Стало').replace('column: "backlog"', 'column: polish').replace(/\n---\n$/, '\ntags:\n  - важное\nfoo: bar\n---\n**жирный**\n');
    writeFileSync(path, edited);
    const read = b.list().find((c) => c.id === id)!;
    assert.deepEqual([read.title, read.column, read.description], ['Стало', 'polish', '**жирный**\n']);
    b.move(id, { column: 'done' });
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

  it('values written by hand that the board does not understand are shown and kept word for word through a move and an edit', () => {
    const d = join(base, 'kanban-obsidian');
    const b = kb(d, alpha);
    const { id, path } = b.add({ title: 'Руками', project: 'alpha' });
    const hand = ['type: spike', 'labels: frontend', 'estimate: 2h', 'assignee: Pavel'];
    writeFileSync(path, readFileSync(path, 'utf8').replace(/\n---\n$/, `\n${hand.join('\n')}\n---\n`));
    const read = b.list().find((c) => c.id === id)!;
    assert.deepEqual(read.asWritten, { type: 'spike', labels: 'frontend', estimate: '2h', assignee: 'Pavel' });
    assert.deepEqual([read.type, read.labels, read.estimate, read.assignee], ['task', [], undefined, undefined], 'the typed fields do not pretend');
    b.move(id, { column: 'doing' });
    b.update(id, { title: 'Руками 2', priority: 'high' });
    const after = readFileSync(path, 'utf8');
    for (const line of hand) assert.ok(after.split('\n').includes(line), `${line} survives:\n${after}`);
    assert.match(after, /column: "doing"/);
    // Set on the board, a field is the board's again; the others stay as written.
    b.update(id, { estimate: 3, labels: ['ui'] });
    const set = readFileSync(path, 'utf8');
    assert.match(set, /estimate: 3\n/);
    assert.match(set, /labels: \["ui"\]/);
    assert.doesNotMatch(set, /2h|labels: frontend/);
    assert.deepEqual(b.list().find((c) => c.id === id)!.asWritten, { type: 'spike', assignee: 'Pavel' });
    b.update(id, { assignee: 'user', type: 'bug' });
    assert.equal(b.list().find((c) => c.id === id)!.asWritten, undefined);
    assert.doesNotMatch(readFileSync(path, 'utf8'), /spike|Pavel/);
  });

  it('moves between the five columns and reorders, before a card or to the end', () => {
    const [one, two, three] = board.list();
    board.move(three.id, { column: 'backlog', before: one.id });
    assert.deepEqual(titles(board.list(), 'backlog'), ['три', 'один', 'два']);
    board.move(three.id, { column: 'backlog' });
    assert.deepEqual(titles(board.list(), 'backlog'), ['один', 'два', 'три']);
    assert.equal(board.move(one.id, { column: 'doing' }).column, 'doing');
    board.move(two.id, { column: 'doing', before: one.id });
    assert.deepEqual(titles(board.list(), 'doing'), ['два', 'один']);
    assert.deepEqual(titles(board.list(), 'backlog'), ['три']);
    // The end of a column stays that column's end, whatever stands after it.
    board.move(three.id, { column: 'done' });
    board.move(one.id, { column: 'done' });
    board.move(two.id, { column: 'polish' });
    assert.deepEqual(titles(board.list(), 'done'), ['три', 'один']);
    assert.deepEqual(titles(board.list(), 'polish'), ['два']);
    board.move(two.id, { column: 'todo' });
    assert.deepEqual(titles(board.list(), 'todo'), ['два']);
  });

  it('many moves into one gap keep the order: the ranks are renumbered when doubles run out', () => {
    const d = join(base, 'kanban-gap');
    const b = kb(d, alpha);
    const first = b.add({ title: 'первая' });
    const last = b.add({ title: 'последняя' });
    const moved = b.add({ title: 'ходит' });
    const other = b.add({ title: 'вторая' });
    for (let i = 0; i < 60; i++) b.move(i % 2 ? moved.id : other.id, { column: 'backlog', before: last.id });
    assert.deepEqual(titles(b.list(), 'backlog'), [first.title, 'вторая', 'ходит', last.title]);
  });

  it('an agent takes a task: its name on the card, waiting cards go to work, back in the queue the mark goes', () => {
    const d = join(base, 'kanban-agent');
    const b = kb(d, alpha);
    const { id } = b.add({ title: 'задача', project: 'alpha' });
    const taken = b.take(id, 'Рефакторинг', { by: 'Рефакторинг', tab: 'tab-1' });
    assert.deepEqual([taken.agent, taken.agentTab, taken.column], ['Рефакторинг', 'tab-1', 'doing']);
    assert.equal(b.list()[0].agent, 'Рефакторинг', 'it is in the file');
    assert.equal(b.move(id, { column: 'polish' }).agent, 'Рефакторинг', 'a move forward keeps it');
    assert.equal(b.take(id, 'Второй', { by: 'Второй' }).column, 'polish', 'taking a card further along leaves it there');
    assert.equal(b.move(id, { column: 'todo' }).agent, undefined, 'back in the queue nobody works on it');
    assert.throws(() => b.take(id, '', { by: '' }), status(400));
    assert.equal(b.update(b.take(id, 'Третий', { by: 'Третий' }).id, { agent: null }).agent, undefined);
  });

  it('a prefix changes in one place: every card takes it, old ids still find the card', () => {
    const d = join(base, 'kanban-prefix');
    const projects = () => [{ key: 'alpha', name: 'alpha' }, { key: 'beta', name: 'beta' }];
    const b = kb(d, projects);
    const one = b.add({ title: 'раз', project: 'alpha' });
    const two = b.add({ title: 'два', project: 'alpha' });
    const other = b.add({ title: 'чужая', project: 'beta' });
    assert.equal(b.prefixes().alpha, 'ALP');
    assert.equal(b.setPrefix('alpha', ' core '), 'CORE');
    assert.deepEqual(b.list().map((c) => c.id), ['CORE-1', 'CORE-2', other.id]);
    assert.ok(!existsSync(one.path));
    assert.equal(b.move(one.id, { column: 'doing' }).id, 'CORE-1', 'the old id still finds it');
    assert.equal(b.move('core-2', { column: 'doing' }).title, two.title, 'whatever the case');
    assert.equal(b.add({ title: 'три', project: 'alpha' }).id, 'CORE-3');
    assert.throws(() => b.setPrefix('alpha', 'BET'), status(409));
    assert.throws(() => b.setPrefix('alpha', '1X'), status(400));
    assert.throws(() => b.setPrefix('нет', 'NEW'), status(400));
    assert.equal(b.setPrefix(null, 'GEN'), 'GEN');
    assert.equal(b.add({ title: 'общая' }).id, 'GEN-1');
    // Moved to another project, a card takes that project's prefix too.
    const moved = b.update('CORE-3', { project: 'beta' });
    assert.match(moved.id, /^BET-/);
    assert.equal(b.move('CORE-3', { column: 'done' }).id, moved.id);
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
    const b = kb(d, alpha, { legacy });
    const cards = b.list();
    assert.deepEqual(cards.map((c) => [c.title, c.description, c.project, c.priority, c.column, c.level, c.created, c.updated]), old.map((c) => [c.title, c.description, c.project, c.priority, c.column, c.level, c.created, c.updated]));
    assert.deepEqual(cards.map((c) => c.id), ['ALP-1', 'TASK-1', 'GON-1']);
    assert.ok(!existsSync(legacy));
    assert.ok(existsSync(`${legacy}.migrated`), 'the old file is kept aside');
    assert.equal(b.move('uuid-2', { column: 'backlog' }).id, 'TASK-1', 'an old id still finds it');
    assert.equal(kb(d, alpha, { legacy }).list().length, 3);
    // Interrupted halfway: the next start goes on and gives nothing twice.
    writeFileSync(legacy, JSON.stringify({ cards: [...old, { ...old[0], id: 'uuid-4', title: 'четвёртая' }] }));
    assert.deepEqual(kb(d, alpha, { legacy }).list().map((c) => c.title).sort(), ['вторая', 'первая', 'третья', 'четвёртая'].sort());
    // A damaged old file stops everything rather than losing it.
    writeFileSync(legacy, '{ not json');
    assert.throws(() => kb(d, alpha, { legacy }).list(), status(500));
    assert.equal(readFileSync(legacy, 'utf8'), '{ not json');
  });

  it('refuses bad input without touching the files', () => {
    const before = snapshot(dir);
    const { id } = board.list().find((c) => c.column === 'todo')!;
    for (const bad of ['', '   ', 5, null, 'x'.repeat(201)]) assert.throws(() => board.add({ title: bad }), status(400), String(bad));
    assert.throws(() => board.add({ title: 't', project: 'нет-такого' }), status(400));
    assert.throws(() => board.add({ title: 't', priority: 'срочно' }), status(400));
    assert.throws(() => board.add({ title: 't', column: 'куда-то' }), status(400));
    assert.throws(() => board.move(id, { column: 'куда-то' }), status(400));
    assert.throws(() => board.move('нет', { column: 'todo' }), status(404));
    assert.throws(() => board.move(id, { column: 'todo', before: 'нет' }), status(404));
    assert.throws(() => board.move(id, { column: 'todo', before: board.list().find((c) => c.column === 'done')!.id }), status(400));
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
    const b = kb(d, projects, { osProject: () => 'os', legacy });
    assert.equal(b.list()[0].level, undefined, 'an old card loads without one');
    const one = b.add({ title: 'ядро', project: 'os', level: 'root' });
    assert.equal(one.level, 'root');
    assert.equal(b.add({ title: 'без', project: 'os' }).level, undefined);
    assert.throws(() => b.add({ title: 't', project: 'alpha', level: 'user' }), status(400));
    assert.throws(() => b.add({ title: 't', level: 'user' }), status(400));
    assert.throws(() => b.add({ title: 't', project: 'os', level: 'admin' }), status(400));
    assert.equal(b.update('old', { level: 'user' }).level, 'user');
    assert.throws(() => b.update('old', { level: 'admin' }), status(400));
    assert.equal(b.move(one.id, { column: 'doing' }).level, 'root', 'a move keeps it');
    assert.equal('level' in b.update(one.id, { level: null }), false);
    assert.equal(b.update('old', { project: 'alpha' }).level, undefined, 'leaves with the project');
    assert.equal(b.list().find((c) => c.title === 'старая')!.level, undefined);
    assert.throws(() => kb(d, projects).update(one.id, { level: 'user' }), status(400), 'no Claude OS project known');
  });

  it('take records the session', () => {
    const d = join(base, 'kanban-sessions');
    const live: Record<string, string | null> = { 'tab-1': 'sess-a', 'tab-2': null };
    const b = kb(d, alpha, { sessionOf: (tab) => live[tab] ?? null });
    const { id } = b.add({ title: 'задача' });
    assert.deepEqual(b.take(id, 'Claude', { by: 'Claude', tab: 'tab-1' }).sessions, ['sess-a'], 'a waiting card, taken through a move');
    assert.deepEqual(b.take(id, 'Claude', { by: 'Claude', tab: 'tab-1' }).sessions, ['sess-a'], 'not twice');
    const other = b.add({ title: 'другая', column: 'doing' });
    assert.equal(b.take(other.id, 'Claude', { by: 'Claude', tab: 'tab-2' }).sessions, undefined, 'a tab with no session yet adds nothing');
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
    assert.deepEqual(b.move(id, { column: 'todo' }).sessions?.length, 20, 'released, the history stays');
    // A finished card is history: only cards in doing or polish take the tab's next session.
    b.move(other.id, { column: 'done' });
    const polished = b.add({ title: 'полировка', column: 'polish' });
    b.take(polished.id, 'Claude', { by: 'Claude', tab: 'tab-2' });
    assert.equal(b.recordSession('tab-2', 'sess-d'), true);
    assert.deepEqual(b.list().find((c) => c.id === other.id)!.sessions, ['sess-b'], 'done: not appended');
    assert.deepEqual(b.list().find((c) => c.id === polished.id)!.sessions, ['sess-d']);
  });

  it('boards: two by default, more added, renamed, set on cards; only an empty one that is not a default is removed', () => {
    const d = join(base, 'kanban-boards');
    const b = kb(d, alpha);
    assert.deepEqual(b.boards(), [{ id: 'epics' }, { id: 'tasks' }]);
    const one = b.addBoard({ name: ' Ноябрь ', project: 'alpha', goal: 'релиз' });
    assert.deepEqual(one, { id: 'B1', name: 'Ноябрь', project: 'alpha', goal: 'релиз' });
    assert.throws(() => b.addBoard({ name: ' ' }), status(400));
    assert.throws(() => b.addBoard({ name: 'x', project: 'нет' }), status(400));
    assert.deepEqual(b.updateBoard('B1', { name: 'Зима', project: null, goal: '' }), { id: 'B1', name: 'Зима' });
    assert.equal(b.updateBoard('tasks', { name: 'Мои задачи' }).name, 'Мои задачи', 'a default board is renamed too');
    assert.throws(() => b.updateBoard('B9', { name: 'x' }), status(404));
    const task = b.add({ title: 'задача' });
    const epic = b.add({ title: 'эпик', type: 'epic' });
    assert.deepEqual([task.board, epic.board], ['tasks', 'epics'], 'a card with no board goes onto the default of its type');
    const card = b.add({ title: 'на доске', board: 'B1' });
    assert.equal(card.board, 'B1');
    assert.match(readFileSync(card.path, 'utf8'), /^board: "B1"$/m);
    assert.throws(() => b.add({ title: 't', board: 'B9' }), status(400));
    assert.equal(b.move(card.id, { column: 'doing', board: 'tasks' }).board, 'tasks');
    assert.equal(b.update(card.id, { board: 'B1' }).board, 'B1');
    assert.deepEqual(b.detail(card.id).log.filter((a) => a.kind === 'board').map((a) => [a.from, a.to]), [['B1', 'tasks'], ['tasks', 'B1']]);
    assert.deepEqual(b.list({ board: 'B1' }).map((c) => c.id), [card.id]);
    assert.equal(b.add({ title: 'карточка' }).id, 'TASK-4', 'boards do not take card numbers');
    assert.throws(() => b.removeBoard('B1'), status(409), 'a board with cards stays');
    assert.throws(() => b.removeBoard('tasks'), status(400), 'a default board stays');
    b.update(card.id, { board: null });
    assert.equal(b.list().find((c) => c.id === card.id)!.board, 'tasks', 'null: the default board');
    b.removeBoard('B1');
    assert.deepEqual(b.boards().map((x) => x.id), ['epics', 'tasks']);
    assert.equal(b.addBoard({ name: 'Новая' }).id, 'B2', 'a removed id is not given again');
    assert.throws(() => b.removeBoard('B1'), status(404));
  });

  it('a board the board file does not know shows the card on its default board and stays in the file', () => {
    const d = join(base, 'kanban-board-unknown');
    const b = kb(d, alpha);
    b.addBoard({ name: 'Ноябрь' });
    const { id, path } = b.add({ title: 'правка в Obsidian', board: 'B1' });
    writeFileSync(path, readFileSync(path, 'utf8').replace('board: "B1"', 'board: B7'));
    writeFileSync(join(d, 'TASK-9.md'), '---\ntitle: руками\n---\n');
    const cards = b.list();
    assert.equal(cards.length, 2, 'never lost');
    for (const c of cards) assert.equal(c.board, 'tasks', c.id);
    b.move(id, { column: 'doing' });
    b.take(id, 'Claude', { by: 'Claude', tab: 'tab-1' });
    b.recordSession('tab-1', 'sess-1');
    assert.match(readFileSync(path, 'utf8'), /^board: "B7"$/m, 'an unrelated write keeps the id in the file');
    assert.equal(b.update(id, { board: 'B1' }).board, 'B1', 'a board set replaces it');
    assert.match(readFileSync(path, 'utf8'), /^board: "B1"$/m);
  });

  it('a damaged board file is refused and left as it is', () => {
    const damaged = join(base, 'damaged');
    mkdirSync(damaged);
    writeFileSync(join(damaged, '_board.json'), '{ not json');
    const b = kb(damaged, () => []);
    assert.throws(() => b.add({ title: 't' }), status(500));
    assert.equal(readFileSync(join(damaged, '_board.json'), 'utf8'), '{ not json');
  });
});

describe('what Kanban+ adds', () => {
  const alpha = () => [{ key: 'alpha', name: 'alpha' }];

  it('a card of the built-in board reads as it was, and a write keeps every field', () => {
    const d = join(base, 'plus-builtin');
    mkdirSync(d);
    writeFileSync(join(d, '_board.json'), JSON.stringify({ prefixes: { alpha: 'OS' }, counters: { OS: 5 } }));
    const old = '---\ntitle: "Размер окна"\nproject: "alpha"\npriority: "high"\ncolumn: "todo"\nrank: 3\nlevel: "root"\nagent: "Claude"\nagent_tab: "t1"\nsessions: ["s1"]\ncreated: "2026-11-10T10:00:00.000Z"\nupdated: "2026-11-11T10:00:00.000Z"\ntags:\n  - ui\n---\nОписание\n';
    writeFileSync(join(d, 'OS-5.md'), old);
    const b = kb(d, alpha);
    const [card] = b.list();
    assert.deepEqual([card.id, card.title, card.type, card.priority, card.column, card.level, card.agent, card.agentTab, card.board, card.sessions, card.labels, card.comments], ['OS-5', 'Размер окна', 'task', 'high', 'todo', 'root', 'Claude', 't1', 'tasks', ['s1'], [], 0]);
    b.update('OS-5', { description: 'Описание\n' });
    const text = readFileSync(join(d, 'OS-5.md'), 'utf8');
    for (const line of ['title: "Размер окна"', 'level: "root"', 'agent_tab: "t1"', 'sessions: ["s1"]', 'tags:\n  - ui']) assert.ok(text.includes(line), line);
    assert.doesNotMatch(text, /^type:/m, 'a task stays without the new key');
    assert.equal(b.add({ title: 'next', project: 'alpha' }).id, 'OS-6');
  });

  it('type, labels, estimate and the assignee are fields of the file', () => {
    const b = kb(join(base, 'plus-fields'), alpha);
    const card = b.add({ title: 'баг', type: 'bug', priority: 'urgent', labels: [' UI ', 'ui', 'api x'], estimate: 2.5 });
    assert.deepEqual([card.type, card.priority, card.labels, card.estimate], ['bug', 'urgent', ['ui', 'api-x'], 2.5]);
    assert.match(readFileSync(card.path, 'utf8'), /^type: "bug"\n(.|\n)*^labels: \["ui","api-x"\]\n(.|\n)*^estimate: 2.5$/m);
    assert.equal(b.update(card.id, { estimate: null }).estimate, undefined);
    assert.throws(() => b.update(card.id, { type: 'saga' }), status(400));
    assert.throws(() => b.update(card.id, { estimate: -1 }), status(400));
    assert.throws(() => b.update(card.id, { labels: 'ui' }), status(400));
    const mine = b.update(card.id, { assignee: 'user' });
    assert.equal(mine.assignee, 'user');
    const taken = b.take(card.id, 'Claude', { by: 'Claude', tab: 't1' });
    assert.deepEqual([taken.agent, taken.assignee], ['Claude', undefined], 'an agent replaces the user');
    const back = b.update(card.id, { assignee: 'user' });
    assert.deepEqual([back.agent, back.assignee], [undefined, 'user'], 'and the user the agent');
    assert.deepEqual([b.update(card.id, { assignee: null }).assignee, b.list()[0].agent], [undefined, undefined]);
    assert.throws(() => b.update(card.id, { assignee: 'bob' }), status(400));
  });

  it('the log says who did what, from which tab and session, and keeps the comments', () => {
    const d = join(base, 'plus-log');
    const b = kb(d, alpha, { sessionOf: (tab) => (tab === 't1' ? 'sess-1' : null) });
    const card = b.add({ title: 'журнал' });
    b.update(card.id, { title: 'журнал 2', priority: 'high' });
    b.take(card.id, 'Рефакторинг', { by: 'Рефакторинг', tab: 't1' });
    b.move(card.id, { column: 'polish' }, { by: 'Рефакторинг', tab: 't1' });
    b.comment(card.id, 'Готово, **тесты** зелёные', { by: 'Рефакторинг', tab: 't1' });
    b.comment(card.id, 'Спасибо');
    assert.throws(() => b.comment(card.id, '  '), status(400));
    const { log } = b.detail(card.id);
    assert.deepEqual(log.map((a) => [a.kind, a.by]), [['created', 'user'], ['edited', 'user'], ['moved', 'Рефакторинг'], ['taken', 'Рефакторинг'], ['moved', 'Рефакторинг'], ['comment', 'Рефакторинг'], ['comment', 'user']]);
    assert.deepEqual(log[1].fields, ['title', 'priority']);
    assert.deepEqual([log[2].from, log[2].to, log[3].tab, log[3].session], ['backlog', 'doing', 't1', 'sess-1']);
    assert.equal(b.list()[0].comments, 2);
    assert.ok(!readdirSync(d).some((n) => n.endsWith('.jsonl')), 'the log is out of sight of Obsidian');
    // A new prefix renames the card, and its log goes along.
    b.setPrefix(null, 'GEN');
    assert.equal(b.detail('GEN-1').log.length, 7);
    assert.equal(b.detail(card.id).card.id, 'GEN-1', 'the old id still finds it');
  });
});
