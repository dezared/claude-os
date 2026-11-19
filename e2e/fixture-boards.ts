// Claude's agents and the planner's service task, with made-up data, for UI tests; the Kanban+ board is fixture-kanban.ts. State lives per fixture server.
import type { AgentDetail, AgentRow, AgentsReport, ServiceTask } from '../shared/contract.ts';
import { kanbanRoutes } from './fixture-kanban.ts';

const NOW = Date.now();
const H = 3_600_000;

const AGENT: Omit<AgentRow, 'id' | 'name' | 'scope' | 'source' | 'path'> = { description: null, model: null, tools: null, readOnly: false, isSymlink: false, runs: 0, runsAll: 0, tokens: 0, lastUsedAt: null };

export function boardRoutes() {
  const kanban = kanbanRoutes();
  let tasks: ServiceTask[] = []; // the dialog of a planner note; nothing else here keeps a service task
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
    const board = kanban(m, path, body);
    if (board) return board;
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
