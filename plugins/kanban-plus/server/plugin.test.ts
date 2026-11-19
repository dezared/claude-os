// Kanban+ as the Claude OS server runs it: loaded through the plugin host, its routes under /api/plugins/kanban-plus and its
// tools inside the claude-os MCP server of each session kind. Temp dirs only.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import type { Tab } from '../../../shared/contract.ts';
import { createPlannerMcp, createRootMcp, uiCommand } from '../../../server/chat/rootMcp.ts';
import { makeKit, session, until, type TestKit } from '../../../server/memory/testkit.ts';
import { createPluginServers, pluginHost } from '../../../server/tools/osPluginServers.ts';
import { activate, columnLabels } from './index.ts';
import type { Card, KanbanBoard } from './types.ts';

const ENTRY = join(import.meta.dirname, 'index.ts');
let kit: TestKit;
const tabs: Partial<Tab>[] = [];
const url = (path: string) => `/api/plugins/kanban-plus${path}`;

before(() => {
  kit = makeKit();
  kit.addProject('alpha', join(kit.base, 'alpha'));
  kit.addProject('os', kit.paths.repo); // the Claude OS project: where the server runs
  kit.ctx.db = new DatabaseSync(':memory:');
  kit.ctx.db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cost_usd REAL)');
  kit.ctx.chat = { list: () => tabs } as never;
  kit.ctx.pluginServers = createPluginServers(kit.ctx, () => [{ id: 'kanban-plus', file: ENTRY }]);
});
after(() => kit.close());

async function connect(server: McpSdkServerConfigWithInstance) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  return client;
}
const parsed = <T>(r: object) => JSON.parse((r as { content: { text: string }[] }).content[0].text) as T;

describe('kanban plus in the server', () => {
  it('concurrent writes over HTTP lose nothing and leave no temp files', async () => {
    const { app } = kit;
    const made = await Promise.all(Array.from({ length: 40 }, (_, i) => app.inject({ method: 'POST', url: url('/cards'), payload: { title: `c${i}` } })));
    assert.ok(made.every((r) => r.statusCode === 200));
    const list = async () => (await app.inject({ url: url('/board') })).json<{ path: string; cards: Card[]; prefixes: Record<string, string>; osProject: string }>();
    const first = await list();
    assert.equal(first.path, join(kit.paths.vault, 'kanban'));
    assert.deepEqual([first.prefixes.alpha, first.osProject], ['ALP', 'os']);
    const moves = first.cards.slice(0, 20).map((c, i) => app.inject({ method: 'POST', url: url(`/cards/${c.id}/move`), payload: { column: i % 2 ? 'doing' : 'done' } }));
    const edits = first.cards.slice(20, 30).map((c) => app.inject({ method: 'PATCH', url: url(`/cards/${c.id}`), payload: { description: 'x' } }));
    const gone = first.cards.slice(30, 35).map((c) => app.inject({ method: 'DELETE', url: url(`/cards/${c.id}`) }));
    assert.ok((await Promise.all([...moves, ...edits, ...gone])).every((r) => r.statusCode === 200));
    const { cards } = await list();
    assert.deepEqual([cards.length, cards.filter((c) => c.column === 'done').length, cards.filter((c) => c.description === 'x').length], [35, 10, 10]);
    const files = readdirSync(join(kit.paths.vault, 'kanban'));
    assert.deepEqual(files.filter((n) => n.endsWith('.tmp')), []);
    assert.ok(kit.topics.includes('osPluginData'));
    assert.ok(kit.audits.some((a) => a.action === 'kanban-plus.delete'));
    assert.equal((await app.inject({ method: 'POST', url: url('/cards'), payload: { title: 't', project: 'нет' } })).statusCode, 400);
    assert.equal((await app.inject({ url: url('/nothing') })).statusCode, 404);
  });

  it('a card opens with its log, its comments and the sessions it was worked in with what they spent', async () => {
    const { app } = kit;
    tabs.push({ id: 'tab-live', sessionId: 'sess-live', status: 'working' });
    kit.sessions.push(session('sess-live', 'alpha', '/a', { lastActivity: 5, tokens: { input: 10, output: 20, cacheWrite: 5, cacheRead: 1000 } }), session('sess-old', 'alpha', '/a', { lastActivity: 1 }));
    kit.ctx.db.prepare('INSERT INTO sessions VALUES (?, ?)').run('sess-live', 1.25);
    const card = (await app.inject({ method: 'POST', url: url('/cards'), payload: { title: 'детали', project: 'alpha', type: 'story' } })).json<Card>();
    await app.inject({ method: 'POST', url: url(`/cards/${card.id}/take`), payload: { agent: 'Claude', tab: 'tab-live' } });
    kit.ctx.pluginServers!.sessionStarted('tab-live', 'sess-old');
    await app.inject({ method: 'POST', url: url(`/cards/${card.id}/comments`), payload: { text: 'посмотрел' } });
    const detail = (await app.inject({ url: url(`/cards/${card.id}`) })).json<{ card: Card; log: { kind: string; by: string; session?: string }[]; sessions: { id: string; tokens: number; costUsd: number | null; tab: string | null; working: boolean }[] }>();
    assert.deepEqual([detail.card.agent, detail.card.sessions, detail.card.comments], ['Claude', ['sess-live', 'sess-old'], 1]);
    assert.deepEqual(detail.log.map((a) => [a.kind, a.by]), [['created', 'user'], ['moved', 'Claude'], ['taken', 'Claude'], ['comment', 'user']]);
    assert.equal(detail.log[2].session, 'sess-live');
    assert.deepEqual(detail.sessions.map((s) => [s.id, s.tokens, s.costUsd, s.tab, s.working]), [['sess-live', 35, 1.25, 'tab-live', true], ['sess-old', 0, null, null, false]]);
  });

  it('boards over HTTP: added with a project and a goal, renamed, an empty one removed', async () => {
    const { app } = kit;
    const made = (await app.inject({ method: 'POST', url: url('/boards'), payload: { name: 'Ноябрь', project: 'alpha', goal: 'релиз' } })).json<KanbanBoard>();
    assert.deepEqual(made, { id: 'B1', name: 'Ноябрь', project: 'alpha', goal: 'релиз' });
    assert.equal((await app.inject({ method: 'POST', url: url('/boards'), payload: {} })).statusCode, 400);
    assert.equal((await app.inject({ method: 'PATCH', url: url('/boards/B1'), payload: { name: 'Зима' } })).json<KanbanBoard>().name, 'Зима');
    const ids = (await app.inject({ url: url('/board') })).json<{ boards: KanbanBoard[] }>().boards.map((b) => b.id);
    assert.deepEqual(ids, ['epics', 'tasks', 'B1']);
    assert.equal((await app.inject({ method: 'DELETE', url: url('/boards/tasks') })).statusCode, 400);
    assert.equal((await app.inject({ method: 'DELETE', url: url('/boards/B1') })).statusCode, 200);
    assert.equal((await app.inject({ method: 'DELETE', url: url('/boards/B1') })).statusCode, 404);
    assert.ok(kit.audits.some((a) => a.action === 'kanban-plus.board.delete'));
  });

  it('an edit made in Obsidian reaches the screen: the folder is watched', async () => {
    const card = (await kit.app.inject({ method: 'POST', url: url('/cards'), payload: { title: 't' } })).json<Card>();
    await kit.app.inject({ url: url('/board') });
    await new Promise((r) => setTimeout(r, 400));
    kit.topics.length = 0;
    writeFileSync(card.path, readFileSync(card.path, 'utf8').replace('title: "t"', 'title: "другой"'));
    await until(() => kit.topics.includes('osPluginData'));
  });

  it('the root session adds, moves, takes and comments on cards through its tools', async () => {
    const client = await connect(createRootMcp(kit.ctx, {} as never, 'tab-root', 'Главная'));
    const call = (name: string, args: Record<string, unknown>) => client.callTool({ name, arguments: args });
    assert.equal((await call('add_kanban_card', { title: 't', project: 'нет-такого' })).isError, true);
    const one = parsed<Card>(await call('add_kanban_card', { title: 'Первая', project: 'alpha', priority: 'high', type: 'bug', labels: ['ui'] }));
    assert.deepEqual([one.column, one.type, one.labels], ['backlog', 'bug', ['ui']]);
    const taken = parsed<Card>(await call('take_kanban_card', { id: one.id }));
    assert.deepEqual([taken.agent, taken.agentTab, taken.column], ['Главная', 'tab-root', 'doing']);
    assert.equal(parsed<Card>(await call('move_kanban_card', { id: one.id, column: 'polish' })).column, 'polish');
    assert.equal(parsed<{ kind: string; by: string }>(await call('add_kanban_comment', { id: one.id, text: 'сделано' })).by, 'Главная');
    const detail = parsed<{ log: { kind: string }[] }>(await call('get_kanban_card', { id: one.id }));
    assert.deepEqual(detail.log.map((a) => a.kind), ['created', 'moved', 'taken', 'moved', 'comment']);
    assert.equal(parsed<Card>(await call('add_kanban_card', { title: 'Про ядро', project: 'os', level: 'root' })).level, 'root');
    const made = parsed<KanbanBoard>(await call('add_kanban_board', { name: 'Альфа', project: 'alpha' }));
    assert.equal(parsed<Card>(await call('update_kanban_card', { id: one.id, board: made.id, estimate: 3 })).board, made.id);
    assert.equal(parsed<KanbanBoard>(await call('update_kanban_board', { id: made.id, goal: 'релиз' })).goal, 'релиз');
    assert.deepEqual(parsed<Card[]>(await call('list_kanban_cards', { board: made.id })).map((c) => c.id), [one.id]);
    const boards = parsed<(KanbanBoard & { cards: number })[]>(await call('list_kanban_boards', {}));
    assert.deepEqual(boards.map((b) => [b.id, b.name, b.cards]).slice(0, 1), [['epics', 'Epics', 0]], 'a default board is named in the user\'s language');
    assert.equal(boards.find((b) => b.id === made.id)!.cards, 1);
    await client.close();
  });

  it('a work tab has the board tools too; ui_action may open the board as a view', async () => {
    const client = await connect(createPlannerMcp(kit.ctx, {} as never, { id: 'tab-w', title: 'Работа', project: 'alpha' }));
    const names = (await client.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('add_kanban_comment') && names.includes('take_kanban_card'));
    assert.ok(names.includes('add_kanban_board') && !names.some((n) => n.endsWith('_kanban_sprint')));
    await client.close();
    assert.deepEqual(uiCommand({ action: 'open', view: 'kanban', project: 'alpha' }, kit.projects, ['home', 'kanban']), { action: 'open', view: 'kanban', project: 'alpha' });
    assert.match(String(uiCommand({ action: 'open', view: 'kanban' }, kit.projects)), /view is one of/, 'without the plugin it is no view');
    assert.deepEqual(kit.ctx.pluginServers!.views(), ['kanban']);
    assert.deepEqual(kit.ctx.pluginServers!.dirs(), [join(kit.paths.vault, 'kanban')]);
  });

  it('the move tool names the columns in the user\'s language', () => {
    assert.match(columnLabels('ru'), /^backlog "Бэклог", todo "В работу"/);
    assert.equal(columnLabels('de'), columnLabels('en'));
  });
});

describe('the first activation of kanban plus', () => {
  it('copies the board folder to the backups once; the marker keeps a later activation from copying again', async () => {
    const fresh = makeKit();
    try {
      const board = join(fresh.paths.vault, 'kanban');
      fresh.write(join(board, 'OS-1.md'), '---\ntitle: "Было"\n---\n');
      const host = pluginHost(fresh.ctx, 'kanban-plus');
      mkdirSync(host.paths.data, { recursive: true });
      const backups = () => (existsSync(host.paths.backups) ? readdirSync(host.paths.backups).filter((n) => n.startsWith('kanban-before-kanban-plus-')) : []);

      activate(host).dispose?.();
      assert.equal(backups().length, 1);
      assert.equal(readFileSync(join(host.paths.backups, backups()[0], 'OS-1.md'), 'utf8'), '---\ntitle: "Было"\n---\n');
      assert.ok(existsSync(join(host.paths.data, 'backed-up')));

      writeFileSync(join(board, 'OS-1.md'), '---\ntitle: "Стало"\n---\n');
      activate(host).dispose?.();
      assert.equal(backups().length, 1, 'no second copy');
      assert.match(readFileSync(join(host.paths.backups, backups()[0], 'OS-1.md'), 'utf8'), /Было/);
    } finally {
      await fresh.close();
    }
  });

  it('a board from before boards is moved over at activation, after a copy', async () => {
    const fresh = makeKit();
    try {
      const board = join(fresh.paths.vault, 'kanban');
      fresh.write(join(board, '_board.json'), JSON.stringify({ prefixes: {}, counters: { '@sprint': 1 }, sprints: [{ id: 'S1', name: 'Спринт' }] }));
      fresh.write(join(board, 'TASK-1.md'), '---\ntitle: "В спринте"\nsprint: "S1"\n---\n');
      const host = pluginHost(fresh.ctx, 'kanban-plus');
      mkdirSync(host.paths.data, { recursive: true });
      activate(host).dispose?.();
      assert.ok(readdirSync(host.paths.backups).some((n) => n.startsWith('kanban-before-boards-')));
      assert.deepEqual(JSON.parse(readFileSync(join(board, '_board.json'), 'utf8')).boards.map((b: KanbanBoard) => b.id), ['epics', 'tasks', 'S1']);
      assert.match(readFileSync(join(board, 'TASK-1.md'), 'utf8'), /^board: "S1"$/m);
    } finally {
      await fresh.close();
    }
  });

  it('a board that is not there yet is not backed up, and the marker waits for one that is', async () => {
    const fresh = makeKit();
    try {
      const host = pluginHost(fresh.ctx, 'kanban-plus');
      mkdirSync(host.paths.data, { recursive: true });
      activate(host).dispose?.();
      assert.equal(existsSync(join(host.paths.data, 'backed-up')), false);
    } finally {
      await fresh.close();
    }
  });
});
