// The Kanban+ plugin's routes with made-up cards, for UI tests against the fixture server. The interface is the real one from
// plugins/kanban-plus/ui; what the server part stores is covered by its own unit tests.
import type { Activity, Card, KanbanBoard } from '../plugins/kanban-plus/server/types.ts';

const NOW = Date.now();
const CARDS = '/home/test/claude-os/vault/kanban';
const BASE = '/api/plugins/kanban-plus';
export const KANBAN_UI = { id: 'kanban-plus', name: 'Kanban+', url: '/api/os-plugins/kanban-plus/fixture/ui/index.js' };

const card = (c: Partial<Card> & Pick<Card, 'id' | 'title' | 'project' | 'column'>): Card => ({ path: `${CARDS}/${c.id}.md`, description: '', type: 'task', board: c.type === 'epic' ? 'epics' : 'tasks', priority: 'normal', labels: [], comments: 0, created: NOW, updated: NOW, ...c });

type Answer = [number, unknown] | null;

export function kanbanRoutes() {
  let seq = 0;
  const prefixes: Record<string, string> = { '@general': 'TASK', 'alpha-service': 'AS', 'beta-web': 'BW' };
  const boards: KanbanBoard[] = [{ id: 'epics' }, { id: 'tasks' }, { id: 'S1', name: 'sizeMode+ (будущее)' }];
  let boardSeq = 0;
  const logs = new Map<string, Activity[]>();
  let cards: Card[] = [
    card({ id: 'AS-1', title: 'Обновить брокер', description: 'До конца месяца', project: 'alpha-service', priority: 'high', column: 'todo', type: 'story', labels: ['infra'], estimate: 3 }),
    card({ id: 'BW-7', title: 'Поправить форму оплаты', project: 'beta-web', column: 'todo', type: 'bug' }),
    card({ id: 'TASK-3', title: 'Купить домен', project: null, priority: 'low', column: 'doing', agent: 'Ревьюер' }),
    // Edited by hand in Obsidian, in values the board has no names for.
    card({ id: 'TASK-5', title: 'Разобрать заметки', project: null, column: 'polish', asWritten: { type: 'spike', labels: 'frontend', estimate: '2h', assignee: 'Мария' } }),
    card({ id: 'AS-2', title: 'Платёжный шлюз', project: 'alpha-service', column: 'doing', type: 'epic' }),
    card({ id: 'BW-9', title: 'Полноэкранный режим', project: 'beta-web', column: 'backlog', board: 'S1' }),
  ];
  const find = (id: string) => cards.find((c) => c.id === decodeURIComponent(id));
  const log = (id: string, entry: Omit<Activity, 'id' | 'at'>) => logs.set(id, [...(logs.get(id) ?? []), { id: `a${++seq}`, at: Date.now(), ...entry }]);
  const replace = (id: string, next: Card) => {
    cards = cards.map((c) => (c.id === id ? next : c));
    return next;
  };

  function patch(c: Card, body: Record<string, unknown>): Card {
    const next: Card = { ...c, ...(body as Partial<Card>), updated: Date.now() };
    if (body.assignee === null) {
      delete next.assignee;
      delete next.agent;
      delete next.agentTab;
    }
    if (body.board === null) next.board = next.type === 'epic' ? 'epics' : 'tasks';
    if (body.estimate === null) delete next.estimate;
    log(c.id, { kind: 'edited', by: 'user', fields: Object.keys(body) });
    return replace(c.id, next);
  }

  function move(c: Card, body: { column: Card['column']; before: string | null }): Card {
    const rest = cards.filter((x) => x.id !== c.id);
    const last = rest.findLastIndex((x) => x.column === body.column);
    const moved = { ...c, column: body.column };
    rest.splice(body.before ? rest.findIndex((x) => x.id === body.before) : last >= 0 ? last + 1 : rest.length, 0, moved);
    cards = rest;
    if (c.column !== body.column) log(c.id, { kind: 'moved', by: 'user', from: c.column, to: body.column });
    return moved;
  }

  function add(body: Partial<Card>): Card {
    const id = `${prefixes[String(body.project ?? '@general')] ?? 'NEW'}-${100 + ++seq}`;
    const made = card({ id, title: String(body.title).trim(), project: body.project ?? null, column: 'backlog', ...body });
    cards = [...cards, made];
    log(id, { kind: 'created', by: 'user', to: made.column });
    return made;
  }

  function boardRoute(m: string, path: string, body: unknown): Answer {
    if (path === `${BASE}/boards` && m === 'POST') {
      const made = { id: `B${++boardSeq}`, ...(body as Omit<KanbanBoard, 'id'>) };
      boards.push(made);
      return [200, made];
    }
    const one = new RegExp(`^${BASE}/boards/([^/]+)$`).exec(path);
    const at = one ? boards.findIndex((x) => x.id === decodeURIComponent(one[1])) : -1;
    if (!one) return null;
    if (at < 0) return [404, { error: 'no board' }];
    if (m === 'PATCH') {
      const { project, goal, ...rest } = body as Partial<KanbanBoard> & { project?: string | null; goal?: string | null };
      const next: KanbanBoard = { ...boards[at], ...rest, ...(project ? { project } : {}), ...(goal ? { goal } : {}) };
      if (!project) delete next.project;
      if (!goal) delete next.goal;
      return [200, (boards[at] = next)];
    }
    if (cards.some((c) => c.board === boards[at].id)) return [409, { error: 'the board has cards' }];
    boards.splice(at, 1);
    return [200, { ok: true }];
  }

  function cardRoute(m: string, path: string, body: unknown): Answer {
    const sub = new RegExp(`^${BASE}/cards/([^/]+)(?:/(move|take|comments))?$`).exec(path);
    if (!sub) return null;
    const c = find(sub[1]);
    if (!c) return [404, { error: 'no card' }];
    if (sub[2] === 'move') return [200, move(c, body as { column: Card['column']; before: string | null })];
    if (sub[2] === 'take') {
      const { agent, tab } = body as { agent: string; tab?: string };
      log(c.id, { kind: 'taken', by: agent, tab });
      return [200, replace(c.id, { ...c, agent, agentTab: tab, column: c.column === 'backlog' || c.column === 'todo' ? 'doing' : c.column })];
    }
    if (sub[2] === 'comments') {
      log(c.id, { kind: 'comment', by: 'user', text: String((body as { text: string }).text) });
      replace(c.id, { ...c, comments: c.comments + 1 });
      return [200, logs.get(c.id)!.at(-1)];
    }
    if (m === 'GET') return [200, { card: c, log: logs.get(c.id) ?? [], sessions: [] }];
    if (m === 'PATCH') return [200, patch(c, body as Record<string, unknown>)];
    cards = cards.filter((x) => x !== c);
    return [200, { ok: true }];
  }

  return (m: string, path: string, body: unknown): Answer => {
    if (path === `${BASE}/board`) return [200, { path: CARDS, cards, osProject: 'claudeOS', prefixes, boards }];
    if (path === `${BASE}/cards` && m === 'POST') return [200, add(body as Partial<Card>)];
    if (path === `${BASE}/prefix` && m === 'PUT') {
      const { project, prefix } = body as { project: string | null; prefix: string };
      prefixes[project ?? '@general'] = prefix;
      return [200, { prefix, prefixes }];
    }
    return boardRoute(m, path, body) ?? cardRoute(m, path, body);
  };
}
