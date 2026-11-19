// Sprints become boards: the folder of a board from before, moved over once, with a copy first and nothing lost. Temp dirs only.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, it } from 'node:test';
import { parseFrontmatter } from '../../../server/memory/util.ts';
import { createKanban } from './board.ts';
import { migrateToBoards } from './migrate.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'kanban-plus-migrate-')));
after(() => rmSync(base, { recursive: true, force: true }));

const BOARD = { prefixes: { '@general': 'TASK', alpha: 'OS' }, counters: { TASK: 5, OS: 5, '@sprint': 2 }, sprints: [{ id: 'S1', name: 'sizeMode+ (будущее)' }, { id: 'S2', name: 'Альфа', board: 'alpha', goal: 'релиз', state: 'active' }] };
const FILES: Record<string, string> = {
  'OS-5.md': '---\ntitle: "В спринте"\nproject: "alpha"\npriority: "low"\ncolumn: "backlog"\nrank: 11\nlevel: "root"\nsprint: "S1"\ncreated: "2026-11-12T12:00:41.916Z"\nupdated: "2026-11-12T12:00:41.916Z"\n---\nОписание\n',
  'OS-6.md': '---\ntitle: "Руками"\nproject: "alpha"\ntype: spike\nassignee: Анна\nestimate: 2h\nsprint: "S2"\ncolumn: "todo"\ntags:\n  - ui\n---\n',
  'OS-7.md': '---\ntitle: "Чужой спринт"\nproject: "alpha"\ncolumn: "todo"\nsprint: "S7"\n---\n',
  'TASK-1.md': '---\ntitle: "Общая"\npriority: "normal"\ncolumn: "doing"\nrank: 7\n---\n',
};

function oldFolder(name: string): { dir: string; backups: string } {
  const dir = join(base, name, 'kanban');
  mkdirSync(join(dir, '.activity'), { recursive: true });
  writeFileSync(join(dir, '_board.json'), JSON.stringify(BOARD, null, 1));
  for (const [file, text] of Object.entries(FILES)) writeFileSync(join(dir, file), text);
  writeFileSync(join(dir, '.activity', 'OS-5.jsonl'), '{"id":"a","at":1,"kind":"sprint","by":"user","to":"S1"}\n');
  return { dir, backups: join(base, name, 'backups') };
}

const read = (dir: string, file: string) => readFileSync(join(dir, file), 'utf8');

it('every sprint becomes a board beside the two defaults; its cards go with it, the rest stay as they are', () => {
  const { dir, backups } = oldFolder('one');
  assert.equal(migrateToBoards(dir, parseFrontmatter, backups), true);
  const state = JSON.parse(read(dir, '_board.json')) as Record<string, unknown>;
  assert.deepEqual(state.boards, [{ id: 'epics' }, { id: 'tasks' }, { id: 'S1', name: 'sizeMode+ (будущее)' }, { id: 'S2', name: 'Альфа', project: 'alpha', goal: 'релиз' }]);
  assert.equal(state.sprints, undefined);
  assert.deepEqual([state.prefixes, state.counters], [BOARD.prefixes, BOARD.counters]);
  const os5 = read(dir, 'OS-5.md');
  assert.match(os5, /^board: "S1"$/m);
  assert.doesNotMatch(os5, /^sprint:/m);
  for (const line of ['title: "В спринте"', 'level: "root"', 'rank: 11', 'created: "2026-11-12T12:00:41.916Z"']) assert.ok(os5.includes(line), line);
  assert.ok(os5.endsWith('---\nОписание\n'));
  const os6 = read(dir, 'OS-6.md');
  for (const line of ['type: spike', 'assignee: Анна', 'estimate: 2h', 'tags:\n  - ui', 'board: "S2"']) assert.ok(os6.includes(line), `${line} survives:\n${os6}`);
  assert.equal(read(dir, 'OS-7.md'), FILES['OS-7.md'], 'a sprint the board did not know stays in the file');
  assert.equal(read(dir, 'TASK-1.md'), FILES['TASK-1.md'], 'a card in no sprint is not rewritten');
  const b = createKanban(dir, { projects: () => [{ key: 'alpha', name: 'alpha' }], frontmatter: parseFrontmatter });
  assert.deepEqual(b.list().map((c) => [c.id, c.board, c.project]), [['TASK-1', 'tasks', null], ['OS-5', 'S1', 'alpha'], ['OS-6', 'S2', 'alpha'], ['OS-7', 'tasks', 'alpha']]);
  assert.equal(b.detail('OS-5').log.length, 1, 'the log stays');
});

it('the folder as it was is copied first, and a second start changes nothing', () => {
  const { dir, backups } = oldFolder('two');
  migrateToBoards(dir, parseFrontmatter, backups);
  const [copy] = readdirSync(backups);
  assert.match(copy, /^kanban-before-boards-/);
  for (const [file, text] of Object.entries(FILES)) assert.equal(read(join(backups, copy), file), text, file);
  assert.deepEqual(JSON.parse(read(join(backups, copy), '_board.json')), BOARD);
  assert.ok(existsSync(join(backups, copy, '.activity', 'OS-5.jsonl')));
  const after = Object.keys(FILES).map((f) => read(dir, f));
  assert.equal(migrateToBoards(dir, parseFrontmatter, backups), false);
  assert.deepEqual(Object.keys(FILES).map((f) => read(dir, f)), after);
  assert.equal(readdirSync(backups).length, 1);
});

it('no folder, or one that has boards already, is left alone', () => {
  assert.equal(migrateToBoards(join(base, 'none', 'kanban'), parseFrontmatter, join(base, 'none', 'backups')), false);
  assert.equal(existsSync(join(base, 'none')), false);
  const dir = join(base, 'fresh', 'kanban');
  const b = createKanban(dir, { projects: () => [], frontmatter: parseFrontmatter });
  b.add({ title: 'новая' });
  assert.equal(migrateToBoards(dir, parseFrontmatter, join(base, 'fresh', 'backups')), false, 'a new board file has its boards');
  assert.equal(existsSync(join(base, 'fresh', 'backups')), false);
});
