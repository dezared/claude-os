// The kanban board and Claude's agents, with made-up data, for UI tests. State lives per fixture server.
import type { AgentDetail, AgentRow, AgentsReport, KanbanCard, KanbanSprint, ServiceTask } from '../shared/contract.ts';

const NOW = Date.now();
const H = 3_600_000;
const CARDS = '/home/test/claude-os/vault/kanban';

const AGENT: Omit<AgentRow, 'id' | 'name' | 'scope' | 'source' | 'path'> = { description: null, model: null, tools: null, readOnly: false, isSymlink: false, runs: 0, runsAll: 0, tokens: 0, lastUsedAt: null };

export function boardRoutes() {
  let seq = 0;
  const prefixes: Record<string, string> = { '@general': 'TASK', 'alpha-service': 'AS', 'beta-web': 'BW' };
  const sprints: KanbanSprint[] = []; // none at first: the board shows no switcher
  let tasks: ServiceTask[] = []; // the dialog of a planner note; nothing else here keeps a service task
  let cards: KanbanCard[] = [
    { id: 'AS-1', path: `${CARDS}/AS-1.md`, title: 'Обновить брокер', description: 'До конца месяца', project: 'alpha-service', priority: 'high', column: 'todo', created: NOW, updated: NOW },
    { id: 'BW-7', path: `${CARDS}/BW-7.md`, title: 'Поправить форму оплаты', description: '', project: 'beta-web', priority: 'normal', column: 'todo', created: NOW, updated: NOW },
    { id: 'TASK-3', path: `${CARDS}/TASK-3.md`, title: 'Купить домен', description: '', project: null, priority: 'low', column: 'doing', agent: 'Ревьюер', created: NOW, updated: NOW },
  ];
  let agents: AgentRow[] = [
    { ...AGENT, id: 'user:reviewer', name: 'reviewer', scope: 'user', source: null, description: 'Проверяет дифф перед коммитом', model: 'claude-opus-5-5', tools: ['Read', 'Grep'], path: '/home/test/.claude/agents/reviewer.md', runs: 12, runsAll: 40, tokens: 90_000, lastUsedAt: NOW - H },
    { ...AGENT, id: 'project:alpha-service:migrator', name: 'migrator', scope: 'project', source: 'alpha-service', description: 'Переносит очереди', path: '/home/test/alpha-service/.claude/agents/migrator.md', runs: 2, runsAll: 2, tokens: 5000, lastUsedAt: NOW - 3 * H },
    { ...AGENT, id: 'plugin:viz-kit:plotter', name: 'plotter', scope: 'plugin', source: 'viz-kit', description: 'Рисует графики', path: '/home/test/.claude/plugins/viz-kit/agents/plotter.md', readOnly: true },
  ];
  const report = (): AgentsReport => ({
    windowDays: 30,
    journalSince: NOW - 200 * H,
    rows: agents,
    byDay: [{ day: '2026-11-05', runs: 14 }],
    other: [{ name: 'Explore', runs: 7, runsAll: 30, last: NOW - H }],
    untyped: 2,
    projects: agents.some((a) => a.scope === 'project') ? [{ project: 'alpha-service', name: 'alpha-service', root: '/home/test/alpha-service', own: ['migrator'], overrides: [] }] : [],
  });
  const detail = (a: AgentRow): AgentDetail => ({
    agent: a,
    content: `---\nname: ${a.name}\n---\n\n# Инструкция ${a.name}\n`,
    stats: { windowDays: 30, journalSince: NOW - 200 * H, total: a.runsAll, recent: a.runs, last: a.lastUsedAt, byDay: [{ day: '2026-11-05', n: a.runs }], byProject: [{ key: 'alpha-service', name: 'alpha-service', n: a.runs }], byName: [], byModel: [], createdAt: NOW - 100 * H, changedAt: NOW - 5 * H, meta: {}, history: [] },
    recent: [{ session: 's-live', project: 'alpha-service', description: 'Проверить ретраи', at: NOW - H, tokens: 1200 }],
  });

  return (m: string, path: string, body: unknown): [number, unknown] | null => {
    if (m === 'POST' && /^\/api\/planner\/[^/]+\/decompose$/.test(path)) {
      tasks = [{ id: 'dec1', title: 'Обновить брокер', project: null, status: 'question', answer: null, error: null, questions: ['Что важнее?', 'К какому сроку?'], modal: true, created: NOW }];
      return [200, tasks[0]];
    }
    if (path === '/api/service/tasks' && m === 'GET' && tasks.length) return [200, tasks];
    if (path === '/api/service/tasks/dec1/answer') {
      tasks = tasks.map((x) => ({ ...x, status: 'done', questions: null, answer: 'AS-2 Брокер: обновить' }));
      return [200, tasks[0]];
    }
    if (path === '/api/service/tasks/dec1/interrupt' || (path === '/api/service/tasks/dec1' && m === 'DELETE')) {
      tasks = [];
      return [200, { ok: true }];
    }
    if (path === '/api/kanban' && m === 'GET') return [200, { path: CARDS, cards, osProject: 'claudeOS', prefixes, sprints }];
    if (path === '/api/kanban/sprints' && m === 'POST') {
      const sprint = { id: `S${sprints.length + 1}`, name: String((body as { name: string }).name) };
      sprints.push(sprint);
      return [200, sprint];
    }
    const sprintOne = /^\/api\/kanban\/sprints\/([^/]+)$/.exec(path);
    const at = sprintOne ? sprints.findIndex((x) => x.id === decodeURIComponent(sprintOne[1])) : -1;
    if (sprintOne && at < 0) return [404, { error: 'no sprint' }];
    if (sprintOne && m === 'PATCH') {
      sprints[at] = { ...sprints[at], name: String((body as { name: string }).name) };
      return [200, sprints[at]];
    }
    if (sprintOne && m === 'DELETE') {
      const [gone] = sprints.splice(at, 1);
      cards = cards.map(({ sprint, ...c }) => (sprint === gone.id ? c : { ...c, ...(sprint ? { sprint } : {}) }));
      return [200, { ok: true }];
    }
    if (/^\/api\/kanban\/cards\/[^/]+\/sessions$/.test(path)) return [200, { live: null, ended: [] }];
    if (path === '/api/kanban/cards' && m === 'POST') {
      const r = body as Partial<KanbanCard>;
      const id = `${prefixes[String(r.project ?? '@general')] ?? 'NEW'}-${100 + ++seq}`;
      const card: KanbanCard = { id, path: `${CARDS}/${id}.md`, title: String(r.title).trim(), description: r.description ?? '', project: r.project ?? null, priority: r.priority ?? 'normal', column: r.column ?? 'backlog', ...(r.level ? { level: r.level } : {}), created: NOW, updated: NOW };
      cards = [...cards, card];
      return [200, card];
    }
    const move = /^\/api\/kanban\/cards\/([^/]+)\/move$/.exec(path);
    if (move) {
      const id = decodeURIComponent(move[1]);
      const { column, before } = body as { column: KanbanCard['column']; before: string | null };
      const card = cards.find((c) => c.id === id)!;
      const rest = cards.filter((c) => c.id !== id);
      const last = rest.findLastIndex((c) => c.column === column);
      rest.splice(before ? rest.findIndex((c) => c.id === before) : last >= 0 ? last + 1 : rest.length, 0, { ...card, column });
      cards = rest;
      return [200, { ...card, column }];
    }
    const take = /^\/api\/kanban\/cards\/([^/]+)\/take$/.exec(path);
    if (take) {
      const id = decodeURIComponent(take[1]);
      const { agent, tab } = body as { agent: string; tab?: string };
      cards = cards.map((c) => (c.id === id ? { ...c, agent, agentTab: tab, column: c.column === 'backlog' || c.column === 'todo' ? 'doing' : c.column } : c));
      return [200, cards.find((c) => c.id === id)];
    }
    if (path === '/api/kanban/prefix' && m === 'PUT') {
      const { project, prefix } = body as { project: string | null; prefix: string };
      prefixes[project ?? '@general'] = prefix;
      return [200, { prefix, prefixes }];
    }
    const one = /^\/api\/kanban\/cards\/([^/]+)$/.exec(path);
    if (one && m === 'PATCH') {
      const id = decodeURIComponent(one[1]);
      cards = cards.map((c) => (c.id === id ? { ...c, ...(body as object) } : c));
      return [200, cards.find((c) => c.id === id)];
    }
    if (one && m === 'DELETE') {
      cards = cards.filter((c) => c.id !== decodeURIComponent(one[1]));
      return [200, { ok: true }];
    }
    if (path === '/api/agents') return [200, report()];
    const agent = /^\/api\/agents\/([^/]+)$/.exec(path);
    if (agent) {
      const a = agents.find((x) => x.id === decodeURIComponent(agent[1]));
      if (!a) return [404, { error: 'agent not found' }];
      if (m === 'DELETE') {
        agents = agents.filter((x) => x !== a);
        return [200, { ok: true, backup: null }];
      }
      return [200, detail(a)];
    }
    return null;
  };
}
