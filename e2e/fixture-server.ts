// Fake backend for UI tests: serves dist/web and answers the REST and WebSocket contract with synthetic data.
// Nothing here talks to Claude. Project and note names are made up on purpose.
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { extname, join, normalize } from 'node:path';
import type { Page } from 'playwright';
import { WebSocketServer, type WebSocket } from 'ws';
import { boardRoutes } from './fixture-boards.ts';
import { featureRoute } from './fixture-features.ts';
import { plannerRoutes } from './fixture-planner.ts';
import type {
  ActionDef, Analytics, ChatEvent, ClientMessage, McpServer, MemoryGraph, MemoryNode, MemoryNote, Overview, Project, ProjectStructureNode,
  ServerMessage, SessionInfo, Skill, Tab, TokenCounts, WidgetDef, WidgetValue, WikiRunView,
} from '../shared/contract.ts';

const DIST = process.env.CLAUDE_OS_WEB_DIST ?? join(import.meta.dirname, '..', 'dist', 'web');
const MIME: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.svg': 'image/svg+xml' };
const NOW = Date.now();
const H = 3_600_000;

/** The way Home: the Claude OS logo in the title bar. aria-current="page" while Home is on screen. */
export const homeButton = (page: Page) => page.getByRole('navigation', { name: 'Вкладки и разделы' }).getByRole('button', { name: 'Главная', exact: true });

export const tokens = (input: number, output: number, cacheWrite: number, cacheRead: number): TokenCounts => ({ input, output, cacheWrite, cacheRead });

function day(offset: number): string {
  const d = new Date(NOW - offset * 24 * H);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function syntheticGraph(count: number, projects: string[]): MemoryGraph {
  let seed = 11;
  const rnd = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
  const nodes: MemoryNode[] = Array.from({ length: count }, (_, i) => {
    const project = projects[Math.floor(rnd() ** 1.6 * projects.length)];
    return {
      id: `n${i}`,
      title: `note_${project}_${i}`,
      file: `note_${i}.md`,
      project,
      connected: i % 5 !== 0,
      degree: 0,
      live: project === projects[0],
      mtime: NOW - i * H,
      summary: i % 3 === 0 ? `About ${project} note ${i}` : null,
      issues: [],
    };
  });
  const edges: [string, string][] = [];
  for (let i = 1; i < count; i++) {
    if (rnd() < 0.7) {
      const j = Math.max(0, i - 1 - Math.floor(rnd() * 8));
      edges.push([nodes[i].id, nodes[j].id]);
      nodes[i].degree++;
      nodes[j].degree++;
    }
  }
  return { nodes, edges, unresolved: 3, vaultPath: '/home/test/vault', vaultExists: true, coreProject: projects.at(-1) ?? null };
}

export interface Fixture {
  projects: Project[];
  sessions: SessionInfo[];
  tabs: Tab[];
  graph: MemoryGraph;
  analytics: Analytics;
  overview: Overview;
  skills: Skill[];
  mcp: McpServer[];
  actions: ActionDef[];
  widgets: { defs: WidgetDef[]; values: WidgetValue[] };
  history: Record<string, ChatEvent[]>;
  transcripts: Record<string, ChatEvent[]>;
  audit: { id: number; at: number; action: string; target: string; diff: string | null }[];
  /** Wiki migration runs by project key; a missing key is no run. */
  wiki: Record<string, WikiRunView>;
}

export function defaultFixture(): Fixture {
  const names = ['alpha-service', 'beta-web', 'gamma-tools', 'delta-bot', 'epsilon-lab', 'zeta-docs', 'eta-infra'];
  const projects: Project[] = names.map((name, i) => ({
    key: name, name, root: `/home/test/${name}`, misc: false,
    sessionCount: 40 - i * 5, liveCount: i < 2 ? 1 : 0, lastActivity: NOW - i * i * 6 * H,
    memoryCount: Math.max(1, 34 - i * 6), memoryConnected: i === 0, memoryDrift: i === 0 ? 2 : 0, pinned: false, mapPin: null, description: null, color: null, parent: null, folder: false,
  }));
  projects.push({ key: 'projects', name: 'projects', root: '/home/test/projects', misc: true, sessionCount: 3, liveCount: 0, lastActivity: NOW - 200 * H, memoryCount: 0, memoryConnected: false, memoryDrift: 0, pinned: false, mapPin: null, description: null, color: null, parent: null, folder: false });

  const byDay = Array.from({ length: 30 }, (_, i) => {
    const wave = Math.abs(Math.sin(i * 1.7)) * 9_000_000;
    return { day: day(29 - i), ...tokens(Math.round(wave * 0.02), Math.round(wave * 0.12), Math.round(wave), Math.round(wave * 9)) };
  });
  const sum = (k: keyof TokenCounts) => byDay.reduce((s, d) => s + d[k], 0);
  const total = tokens(sum('input'), sum('output'), sum('cacheWrite'), sum('cacheRead'));
  const part = (k: number) => tokens(Math.round(total.input * k), Math.round(total.output * k), Math.round(total.cacheWrite * k), Math.round(total.cacheRead * k));

  const sessions: SessionInfo[] = [
    { id: 's-live', project: 'alpha-service', cwd: '/home/test/alpha-service', kind: 'interactive', origin: 'external', name: null, title: 'Перенос очереди на новый брокер', lastPrompt: 'проверь ретраи', firstActivity: NOW - 3 * H, lastActivity: NOW - 30_000, status: 'working', pid: 1234, tokens: tokens(120, 40_230, 1_204_000, 18_400_000), subagents: [{ id: 'a1', agentType: 'Explore', description: 'Найти использования брокера', lastActivity: NOW - 60_000, tokens: 880_000 }] },
    { id: 's-ended', project: 'beta-web', cwd: '/home/test/beta-web', kind: 'interactive', origin: 'external', name: null, title: 'Правка вёрстки формы оплаты', lastPrompt: null, firstActivity: NOW - 40 * H, lastActivity: NOW - 26 * H, status: 'ended', pid: null, tokens: tokens(80, 12_000, 300_000, 2_400_000), subagents: [] },
    { id: 's-tab', project: 'alpha-service', cwd: '/home/test/alpha-service', kind: 'sdk', origin: 'os', name: null, title: 'Рефакторинг конфигурации', lastPrompt: null, firstActivity: NOW - 2 * H, lastActivity: NOW - 600_000, status: 'waiting_permission', pid: 2222, tokens: tokens(54, 32_474, 183_721, 1_620_000), subagents: [] },
  ];

  const tabs: Tab[] = [
    { id: 'root', kind: 'root', project: null, cwd: '/home/test/root', sessionId: null, title: 'Главная', order: 0, model: null, effort: null, worktree: false, status: 'idle', attention: false, queued: 0 },
    { id: 't1', kind: 'work', project: 'alpha-service', cwd: '/home/test/alpha-service', sessionId: 's-tab', title: 'alpha-service', order: 1, model: null, effort: null, worktree: false, status: 'waiting_permission', attention: true, queued: 1 },
    { id: 't2', kind: 'work', project: 'beta-web', cwd: '/home/test/beta-web', sessionId: null, title: 'beta-web · задача 2', order: 2, model: 'claude-sonnet-5-5', effort: 'high', worktree: true, status: 'idle', attention: false, queued: 0 },
    { id: 't3', kind: 'readonly', project: 'alpha-service', cwd: '/home/test/alpha-service', sessionId: 's-live', title: 'Перенос очереди', order: 3, model: null, effort: null, worktree: false, status: 'working', attention: false, queued: 0 },
  ];

  const ev = (seq: number, body: Record<string, unknown>) => ({ seq, at: NOW - (40 - seq) * 60_000, ...body }) as ChatEvent;
  const t1History: ChatEvent[] = [
    ev(1, { e: 'init', sessionId: 's-tab', model: 'claude-opus-5-5', permissionMode: 'auto', slashCommands: [{ name: 'compact', needsTerminal: false }, { name: 'config', needsTerminal: true }, { name: 'review', needsTerminal: false }] }),
    ev(2, { e: 'user', blocks: [{ type: 'text', text: 'Вынеси настройки подключения в отдельный модуль и покажи, что поменяется.' }] }),
    ev(3, { e: 'assistant', messageId: 'm1', model: 'claude-opus-5-5', blocks: [{ type: 'text', text: 'Посмотрю, где читаются настройки.' }, { type: 'tool_use', id: 'tu1', name: 'Grep', input: { pattern: 'DB_HOST' } }, { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: '/home/test/alpha-service/src/config.ts' } }] }),
    ev(4, { e: 'tool_result', toolUseId: 'tu1', text: 'src/config.ts:12: DB_HOST\nsrc/db.ts:4: DB_HOST', isError: false }),
    ev(5, { e: 'tool_result', toolUseId: 'tu2', text: 'export const host = process.env.DB_HOST;', isError: false }),
    ev(6, { e: 'assistant', messageId: 'm2', model: 'claude-opus-5-5', blocks: [{ type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: 'npm test -- config' }, subagent: 'a7' }, { type: 'tool_use', id: 'tu4', name: 'Read', input: { file_path: '/home/test/alpha-service/src/db.ts' }, subagent: 'a7' }] }),
    ev(7, { e: 'tool_result', toolUseId: 'tu3', text: 'FAIL: 1 test failed', isError: true }),
    ev(8, { e: 'assistant', messageId: 'm3', model: 'claude-opus-5-5', blocks: [{ type: 'text', text: 'Настройки читаются в **двух** местах:\n\n- `src/config.ts`\n- `src/db.ts`\n\nПредлагаю оставить один модуль.\n\n```ts\nexport const db = { host: process.env.DB_HOST };\n```' }] }),
    ev(9, { e: 'result', usage: tokens(54, 2480, 183_721, 1_620_000), costUsd: 0.42, interrupted: false, error: null }),
    ev(10, { e: 'user', blocks: [{ type: 'text', text: 'Давай.' }] }),
    ev(11, { e: 'status', status: 'waiting_permission' }),
    ev(12, { e: 'permission', requestId: 'r1', tool: 'Edit', title: 'Правка src/config.ts', input: { file_path: '/home/test/alpha-service/src/config.ts' }, diff: '--- a/src/config.ts\n+++ b/src/config.ts\n@@ -10,3 +10,3 @@\n export const a = 1;\n-export const host = process.env.DB_HOST;\n+export { db } from "./settings";\n export const c = 3;' }),
    ev(13, { e: 'user', queued: true, blocks: [{ type: 'text', text: 'И заодно обнови README' }] }),
  ];

  const graph = syntheticGraph(162, names);
  const note = graph.nodes[1];
  graph.nodes[1].issues = ['not-english', 'tags-count'];
  graph.nodes[2].issues = ['not-english'];
  return {
    projects,
    sessions,
    tabs,
    graph,
    analytics: {
      from: day(29), to: day(0), total, main: part(0.17), subagents: part(0.83), osShare: part(0.04), byDay,
      byProject: names.map((name, i) => ({ name, messages: 900 - i * 100, ...part(0.5 / (i + 1)) })),
      byModel: [{ name: 'claude-opus-5-5', messages: 4000, ...part(0.96) }, { name: 'claude-sonnet-5-5', messages: 120, ...part(0.03) }, { name: 'claude-fable-5-1', messages: 40, ...part(0.01) }],
      bySource: [{ name: 'root', messages: 90, ...part(0.03) }, { name: 'service', messages: 30, ...part(0.008) }, { name: 'widget', messages: 5, ...part(0.002) }],
      topSessions: sessions.slice(0, 2).map((s, i) => ({ name: s.title ?? s.id, messages: 200 - i, sessionId: s.id, project: s.project, ...part(0.1 / (i + 1)) })),
      rateLimits: [],
      costEquivalentUsd: 412.5,
    },
    overview: {
      claudeVersion: '2.1.318', skills: 6, plugins: 3, hooks: 0, mcpServers: 2, apiConnected: false,
      recentNotes: [{ id: note.id, title: note.title, mtime: note.mtime }, { id: graph.nodes[2].id, title: graph.nodes[2].title, mtime: graph.nodes[2].mtime }],
      index: { filesTotal: 800, filesDone: 800, indexing: false, unknownRecordShare: 0, formatWarning: null, claudeVersion: '2.1.318' },
    },
    skills: [
      { id: 'user:brainstorm', name: 'brainstorm', scope: 'user', source: null, description: 'Обсудить задачу до кода', path: '/home/test/.claude/skills/brainstorm', readOnly: false, disabled: false, isSymlink: false, usageCount: 13, lastUsedAt: NOW - 5 * H },
      { id: 'user:design-review', name: 'design-review', scope: 'user', source: null, description: 'Проверить интерфейс', path: '/home/test/.claude/skills/design-review', readOnly: false, disabled: false, isSymlink: true, usageCount: 8, lastUsedAt: NOW - 30 * H },
      { id: 'user:writing-plans', name: 'writing-plans', scope: 'user', source: null, description: null, path: '/home/test/.claude/skills/writing-plans', readOnly: false, disabled: false, isSymlink: false, usageCount: 6, lastUsedAt: NOW - 90 * H },
      { id: 'user:old-thing', name: 'old-thing', scope: 'user', source: null, description: 'Давно не нужен', path: '/home/test/.claude/skills/old-thing', readOnly: false, disabled: false, isSymlink: false, usageCount: 0, lastUsedAt: null },
      { id: 'user:parked', name: 'parked', scope: 'user', source: null, description: null, path: '/home/test/.claude/skills-disabled/parked', readOnly: false, disabled: true, isSymlink: false, usageCount: 0, lastUsedAt: null },
      { id: 'plugin:charts', name: 'charts', scope: 'plugin', source: 'viz-kit', description: 'Диаграммы', path: '/home/test/.claude/plugins/viz-kit/skills/charts', readOnly: true, disabled: false, isSymlink: false, usageCount: 5, lastUsedAt: NOW - 50 * H },
    ],
    mcp: [
      { name: 'filesystem', scope: 'user', project: null, transport: 'stdio', summary: 'npx -y fs-server /home/test', envKeys: ['FS_TOKEN'], health: null },
      { name: 'docs', scope: 'project', project: 'beta-web', transport: 'http', summary: 'https://docs.example.test/mcp', envKeys: [], health: 'connected' },
    ],
    actions: [
      { id: 'user:deploy', title: 'Выкатить', command: 'deploy.sh {cwd}', cwd: null, confirm: false, builtin: false, approved: false },
      { id: 'builtin:shell', title: 'Терминал', command: 'wt.exe wsl.exe --cd <cwd>', cwd: '{cwd}', confirm: false, builtin: true, approved: true },
      { id: 'builtin:terminal', title: 'Терминал', command: 'wt.exe wsl claude --resume {sessionId}', cwd: '{cwd}', confirm: false, builtin: true, approved: true },
    ],
    widgets: {
      defs: [
        { id: 'w1', title: 'Открытые тикеты', type: 'command', command: 'tickets --count', intervalSec: 300, approved: true, slot: 'bottom-right', height: 150 },
        { id: 'w2', title: 'Новая команда', type: 'command', command: 'curl -s https://example.test/x', intervalSec: 60, approved: false, slot: 'bottom-right', height: 150 },
        { id: 'w3', title: 'Старый без места', type: 'file', path: '/home/test/x', approved: true },
      ],
      values: [{ id: 'w1', value: '12', updatedAt: NOW - 60_000, error: null }],
    },
    history: { root: [], t1: t1History, t2: [] },
    transcripts: {
      's-live': [
        ev(1, { e: 'user', blocks: [{ type: 'text', text: 'проверь ретраи' }] }),
        ev(2, { e: 'assistant', messageId: 'x1', model: 'claude-opus-5-5', blocks: [{ type: 'text', text: 'Ретраи настроены верно, лимит пять попыток.' }, { type: 'tool_use', id: 'x2', name: 'AskUserQuestion', input: {} }] }),
      ],
      's-ended': [ev(1, { e: 'user', blocks: [{ type: 'text', text: 'поправь форму' }] })],
    },
    audit: [{ id: 1, at: NOW - 3 * H, action: 'skill.save', target: '/home/test/.claude/skills/brainstorm/SKILL.md', diff: '-old\n+new' }],
    wiki: {},
  };
}

export function emptyFixture(): Fixture {
  const base = defaultFixture();
  return {
    ...base,
    projects: [], sessions: [], skills: [], mcp: [], audit: [],
    tabs: [base.tabs[0]],
    graph: { nodes: [], edges: [], unresolved: 0, vaultPath: '/home/test/vault', vaultExists: false, coreProject: null },
    widgets: { defs: [], values: [] },
    overview: { ...base.overview, skills: 0, plugins: 0, hooks: 0, mcpServers: 0, recentNotes: [] },
    analytics: { ...base.analytics, total: tokens(0, 0, 0, 0), main: tokens(0, 0, 0, 0), subagents: tokens(0, 0, 0, 0), osShare: tokens(0, 0, 0, 0), byDay: [], byProject: [], byModel: [], bySource: [], topSessions: [], costEquivalentUsd: null },
    history: { root: [] },
    transcripts: {},
  };
}

export interface FixtureServer {
  url: string;
  data: Fixture;
  /** Every mutating request and its parsed body, for assertions. */
  calls: { method: string; path: string; body: unknown }[];
  subscribes: { tabId: string; lastSeq: number }[];
  /** Path regex -> [status, body]: forces an error response. */
  failures: Map<RegExp, [number, unknown]>;
  push: (msg: ServerMessage) => void;
  dropSockets: () => void;
  close: () => Promise<void>;
}

export async function startFixture(data: Fixture = defaultFixture()): Promise<FixtureServer> {
  const calls: FixtureServer['calls'] = [];
  const subscribes: FixtureServer['subscribes'] = [];
  const failures: FixtureServer['failures'] = new Map();
  const sockets = new Set<WebSocket>();
  const planner = plannerRoutes();
  const boards = boardRoutes();
  const push = (msg: ServerMessage) => {
    for (const ws of sockets) ws.send(JSON.stringify(msg));
  };

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<unknown>((resolve) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        try {
          resolve(raw ? JSON.parse(raw) : undefined);
        } catch {
          resolve(raw);
        }
      });
    });

  const notes = new Map<string, MemoryNote>();
  const noteFor = (id: string): MemoryNote | null => {
    const node = data.graph.nodes.find((n) => n.id === id);
    if (!node) return null;
    let n = notes.get(id);
    if (!n) {
      n = { node, path: `/home/test/vault/projects/${node.project}/${node.file}`, markdown: `# ${node.title}\n\nТекст заметки со [ссылкой](https://example.test).\n\n<script>window.__xss = 1</script>`, version: 'v1', obsidianUrl: node.connected ? `obsidian://open?path=${node.file}` : null, backlinks: [] };
      notes.set(id, n);
    }
    return n;
  };

  const route = async (req: IncomingMessage, res: ServerResponse, path: string, search: URLSearchParams) => {
    const m = req.method ?? 'GET';
    const body = m === 'GET' ? undefined : await readBody(req);
    if (m !== 'GET') calls.push({ method: m, path, body });
    for (const [re, [status, payload]] of failures) if (re.test(path)) return json(res, status, payload);

    const extra = featureRoute(m, path, search, body) ?? planner(m, path, search, body) ?? boards(m, path, body);
    if (extra) {
      if (path.startsWith('/api/service/tasks/') || path.endsWith('/decompose')) push({ t: 'invalidate', topics: ['service'] });
      return json(res, extra[0], extra[1]);
    }

    let match: RegExpExecArray | null;
    if (path === '/api/projects/structure') {
      // The home folder: every project root, one folder that is nothing yet, a subfolder folded into a project, cut at the cap.
      const node = (dir: string): ProjectStructureNode => {
        const p = data.projects.find((x) => x.root === dir);
        const own: ProjectStructureNode = { path: dir, name: dir.split('/').at(-1)!, kind: p ? (p.misc ? 'misc' : 'project') : 'none', ...(p ? { project: p.key, reason: p.pinned ? 'connected' : 'git' } : {}) };
        return p?.key === 'alpha-service' ? { ...own, children: [{ path: `${dir}/src`, name: 'src', kind: 'inside', project: p.key, reason: 'git' }] } : own;
      };
      const dirs = [...new Set([...data.projects.map((p) => p.root).filter((r) => r.startsWith('/home/test/')), '/home/test/fresh-folder'])].sort();
      return json(res, 200, { path: '/home/test', name: 'test', kind: 'none', children: dirs.map(node), truncated: true } satisfies ProjectStructureNode);
    }
    if (path === '/api/projects') return json(res, 200, data.projects);
    if (path === '/api/sessions') return json(res, 200, search.get('project') ? data.sessions.filter((s) => s.project === search.get('project')) : data.sessions);
    if (path === '/api/sessions/active-subagents') return json(res, 200, {});
    if (path === '/api/open-terminal/preview') return json(res, 200, { command: `wt.exe wsl.exe -- claude --resume ${search.get('sessionId')} --fork-session`, fork: true, holder: 'tab' });
    if ((match = /^\/api\/sessions\/([^/]+)\/transcript$/.exec(path))) return json(res, 200, data.transcripts[match[1]] ?? []);
    if (path === '/api/analytics') return json(res, 200, data.analytics);
    if (path === '/api/index') return json(res, 200, data.overview.index);
    if (path === '/api/overview') return json(res, 200, data.overview);
    if (path === '/api/audit') return json(res, 200, data.audit);
    if (path === '/api/models') return json(res, 200, [{ id: 'default', label: 'Default (recommended)' }, { id: 'opus', label: 'Opus 5.5' }, { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' }, { id: 'claude-opus-4-8', label: 'Opus 4.8' }, { id: 'claude-sonnet-5', label: 'Sonnet 5' }]);
    if (path === '/api/service/tasks') return json(res, 200, m === 'POST' ? { id: 'st1' } : []);
    if (path === '/api/tabs' && m === 'GET') return json(res, 200, data.tabs);
    if (path === '/api/tabs' && m === 'POST') {
      const r = body as { project?: string; title?: string; cwd?: string; readonly?: boolean; resumeSessionId?: string };
      const tab: Tab = { id: `t${data.tabs.length + 10}`, kind: r.readonly ? 'readonly' : 'work', project: r.project ?? null, cwd: r.cwd || `/home/test/${r.project}`, sessionId: r.resumeSessionId ?? null, title: r.title ?? r.project ?? 'сессия', order: data.tabs.length, model: null, effort: null, worktree: false, status: r.readonly ? 'ended' : 'idle', attention: false, queued: 0 };
      data.tabs.push(tab);
      data.history[tab.id] = [];
      return json(res, 200, tab);
    }
    if ((match = /^\/api\/tabs\/([^/]+)\/history$/.exec(path))) return json(res, 200, data.history[match[1]] ?? []);
    if ((match = /^\/api\/tabs\/([^/]+)\/files$/.exec(path))) return json(res, 200, ['src/config.ts', 'src/db.ts', 'README.md'].filter((f) => f.includes(search.get('q') ?? '')));
    if (/^\/api\/tabs\/[^/]+\/(send|interrupt|respond\/[^/]+)$/.test(path)) return json(res, 200, { ok: true });
    if ((match = /^\/api\/tabs\/([^/]+)\/progress$/.exec(path))) {
      const tab = data.tabs.find((t) => t.id === match![1]);
      if (tab) delete tab.progress;
      push({ t: 'invalidate', topics: ['tabs'] });
      return json(res, 200, { ok: true });
    }
    if ((match = /^\/api\/tabs\/([^/]+)$/.exec(path))) {
      const id = match[1];
      const tab = data.tabs.find((t) => t.id === id);
      if (m === 'PATCH' && tab) {
        Object.assign(tab, body);
        return json(res, 200, tab);
      }
      if (m === 'DELETE') {
        data.tabs = data.tabs.filter((t) => t.id !== id);
        return json(res, 200, { ok: true });
      }
    }
    if ((match = /^\/api\/sessions\/([^/]+)\/stop$/.exec(path)) && m === 'POST') {
      const s = data.sessions.find((x) => x.id === decodeURIComponent(match![1]));
      if (!s) return json(res, 404, { error: 'нет такой сессии' });
      if (s.pid === null && s.origin !== 'os') return json(res, 409, { error: 'no process', code: 'no_pid' });
      s.status = 'ended';
      push({ t: 'invalidate', topics: ['sessions'] });
      return json(res, 200, { ok: true, how: 'signal' });
    }
    if ((match = /^\/api\/sessions\/([^/]+)\/removal$/.exec(path))) {
      const s = data.sessions.find((x) => x.id === decodeURIComponent(match![1]));
      if (!s) return json(res, 404, { error: 'нет такой сессии' });
      return json(res, 200, {
        id: s.id, live: s.status !== 'ended', root: false, tabs: data.tabs.filter((t) => t.sessionId === s.id).length,
        items: [{ kind: 'journal', path: `/home/test/.claude/projects/-home-test-${s.project}/${s.id}.jsonl`, files: 1, bytes: 2048 }],
        trash: '/home/test/claude-os/data/trash',
      });
    }
    if ((match = /^\/api\/sessions\/([^/]+)\/remove$/.exec(path)) && m === 'POST') {
      const id = decodeURIComponent(match[1]);
      if ((body as { confirm?: string }).confirm !== id) return json(res, 400, { error: 'confirm must be the session id' });
      data.sessions = data.sessions.filter((x) => x.id !== id);
      data.tabs = data.tabs.filter((t) => t.sessionId !== id);
      push({ t: 'invalidate', topics: ['sessions', 'tabs'] });
      return json(res, 200, { ok: true, trash: `/home/test/claude-os/data/trash/session-${id}-1`, moved: 1 });
    }
    if (path === '/api/projects/connect' && m === 'POST') {
      const dir = (body as { path: string }).path;
      const key = dir.split('/').at(-1)!;
      const p: Project = { key, name: key, root: dir, misc: false, sessionCount: 0, liveCount: 0, lastActivity: null, memoryCount: 0, memoryConnected: false, memoryDrift: 0, pinned: true, mapPin: null, description: null, color: null, parent: null, folder: false };
      data.projects.unshift(p);
      push({ t: 'invalidate', topics: ['projects'] });
      return json(res, 200, p);
    }
    if ((match = /^\/api\/projects\/([^/]+)\/map$/.exec(path)) && m === 'POST') {
      const p = data.projects.find((x) => x.key === decodeURIComponent(match![1]));
      if (!p) return json(res, 404, { error: 'unknown project' });
      p.mapPin = (body as { on: boolean | null }).on;
      push({ t: 'invalidate', topics: ['projects'] });
      return json(res, 200, p);
    }
    if ((match = /^\/api\/projects\/([^/]+)$/.exec(path)) && m === 'PATCH') {
      const p = data.projects.find((x) => x.key === decodeURIComponent(match![1]));
      if (!p) return json(res, 404, { error: 'unknown project' });
      Object.assign(p, body);
      push({ t: 'invalidate', topics: ['projects'] });
      return json(res, 200, p);
    }
    if (path === '/api/fs/dirs') return json(res, 200, ['/home/test/fresh-folder', '/home/test/fresh-other']);
    if ((match = /^\/api\/projects\/([^/]+)\/removal$/.exec(path))) {
      const p = data.projects.find((x) => x.key === decodeURIComponent(match![1]));
      if (!p) return json(res, 404, { error: 'unknown project' });
      return json(res, 200, {
        key: p.key, name: p.name, root: p.root, liveCount: p.liveCount, tabs: 0,
        items: [
          { kind: 'journals', path: `/home/test/.claude/projects/-home-test-${p.key}`, files: 12, bytes: 4_500_000, skipped: null },
          { kind: 'vault', path: `/home/test/vault/projects/${p.key}`, files: 3, bytes: 9000, skipped: null },
        ],
        claudeJson: { path: '/home/test/.claude.json', keys: [p.root], safe: false, reason: 'live_sessions' },
        settingsKept: null,
        trash: '/home/test/claude-os/data/trash',
      });
    }
    if ((match = /^\/api\/projects\/([^/]+)\/remove$/.exec(path)) && m === 'POST') {
      const key = decodeURIComponent(match[1]);
      const p = data.projects.find((x) => x.key === key)!;
      if ((body as { confirm: string }).confirm !== p.name) return json(res, 400, { error: 'confirm must be the project name' });
      data.projects = data.projects.filter((x) => x.key !== key);
      data.graph.nodes = data.graph.nodes.filter((n) => n.project !== key);
      push({ t: 'invalidate', topics: ['projects', 'memory'] });
      return json(res, 200, { ok: true, trash: `/home/test/claude-os/data/trash/${key}-1`, moved: 2, claudeJson: 'skipped' });
    }
    if ((match = /^\/api\/memory\/wiki\/([^/]+)(?:\/(prepare|verify|apply|undo))?$/.exec(path))) {
      // Prepare starts one batch in tab t1 (a project without notes is ready at once); apply and undo only flip the state, undo keeps one changed note.
      const key = decodeURIComponent(match[1]);
      const run = data.wiki[key] as WikiRunView | undefined;
      const set = (r: WikiRunView) => {
        data.wiki[key] = r;
        push({ t: 'invalidate', topics: ['memory'] });
        return json(res, 200, r);
      };
      if (m === 'GET') return json(res, 200, run ?? null);
      if (m === 'DELETE') {
        delete data.wiki[key];
        push({ t: 'invalidate', topics: ['memory'] });
        return json(res, 200, { ok: true });
      }
      const empty = { lines: 0, bytes: 0, tokens: 0 };
      if (match[2] === 'prepare' && !data.graph.nodes.some((n) => n.project === key)) return set({ project: key, run: 'r1', state: 'ready', batches: [], preview: { files: [], warnings: [], linkDiff: '', memory: { before: empty, after: empty }, notesAfter: 0 } });
      if (match[2] === 'prepare') return set({ project: key, run: 'r1', state: 'rewriting', batches: [{ n: 1, files: ['project.md'], tabId: 't1', status: 'running', errors: [], warnings: [] }, { n: 2, files: ['state.md'], tabId: null, status: 'pending', errors: [], warnings: [] }], preview: null });
      if (!run) return json(res, 409, { error: `no wiki migration of ${key}` });
      if (match[2] === 'verify') return set(run);
      if (match[2] === 'apply') return set({ ...run, state: 'applied' });
      data.wiki[key] = { ...run, state: 'undone' };
      push({ t: 'invalidate', topics: ['memory'] });
      return json(res, 200, { restored: ['MEMORY.md', 'project.md'], kept: ['db-host-config.md'], conflicts: ['state.md'] });
    }
    if (path === '/api/memory/graph') return json(res, 200, data.graph);
    if (path === '/api/memory/search') {
      // A substring stands in for FTS; the snippet carries the real markers and brackets that must stay literal.
      const q = (search.get('q') ?? '').trim().toLowerCase();
      if (q.length < 2) return json(res, 200, []);
      const hits = data.graph.nodes.flatMap((n) => {
        const text = `${n.summary ?? 'A fact'} [v2] in ${n.title}`;
        const at = text.toLowerCase().indexOf(q);
        if (at < 0) return [];
        const snippet = `${text.slice(0, at)}\u0001${text.slice(at, at + q.length)}\u0002${text.slice(at + q.length)}`;
        return [{ id: n.id, name: n.title, project: n.project, type: 'project', description: n.summary, snippet }];
      });
      return json(res, 200, hits.slice(0, Math.min(20, Number(search.get('limit') ?? 20))));
    }
    if ((match = /^\/api\/memory\/notes\/([^/]+)$/.exec(path))) {
      const n = noteFor(decodeURIComponent(match[1]));
      if (!n) return json(res, 404, { error: 'нет такой заметки' });
      if (m === 'PUT') {
        const r = body as { markdown: string; version: string };
        if (r.version !== n.version) return json(res, 409, { error: 'conflict' });
        n.markdown = r.markdown;
        n.version = `${n.version}x`;
      }
      return json(res, 200, n);
    }
    if ((match = /^\/api\/memory\/migrate\/([^/]+)$/.exec(path))) {
      if (m === 'POST') return json(res, 200, { ok: true, copied: 2 });
      return json(res, 200, { project: match[1], from: '/home/test/.claude/projects/x/memory', to: `/home/test/vault/projects/${match[1]}`, files: ['MEMORY.md', 'note_1.md'], settingsPath: `/home/test/${match[1]}/.claude/settings.local.json`, settingsDiff: '+  "autoMemoryDirectory": "/home/test/vault/projects/x"' });
    }
    if (path === '/api/skills' && m === 'GET') return json(res, 200, data.skills);
    if (path === '/api/admin/skills') return json(res, 200, { windowDays: 30, journalSince: null, rows: data.skills.map((x) => ({ ...x, runs: x.usageCount, runsAll: x.usageCount })), byDay: [{ day: '2026-11-05', runs: 2 }], gone: [], projects: [...new Set(data.skills.filter((x) => x.scope === 'project').map((x) => x.source!))].map((key) => ({ project: key, name: key, root: `/home/test/${key}`, own: data.skills.filter((x) => x.scope === 'project' && x.source === key).map((x) => x.name), overrides: [], runs: 0 })) });
    if (path === '/api/skills/preview') return json(res, 200, { diff: '--- a/SKILL.md\n+++ b/SKILL.md\n@@ -1 +1 @@\n-old\n+new' });
    if (path === '/api/skills' && m === 'POST') return json(res, 200, data.skills[0]);
    if ((match = /^\/api\/skills\/([^/]+)(\/toggle)?$/.exec(path))) {
      const s = data.skills.find((x) => x.id === decodeURIComponent(match![1]));
      if (!s) return json(res, 404, { error: 'нет такого скилла' });
      if (m === 'GET') return json(res, 200, { skill: s, content: `---\nname: ${s.name}\ndescription: ${s.description}\n---\n\n# ${s.name}\n\nШаги скилла.\n` });
      return json(res, 200, s);
    }
    if (path === '/api/mcp' && m === 'GET') return json(res, 200, data.mcp);
    if ((match = /^\/api\/mcp\/([^/]+)\/check$/.exec(path))) return json(res, 200, { ...data.mcp[0], health: 'connected' });
    if (path.startsWith('/api/mcp')) return json(res, 200, { ok: true, ...data.mcp[0] });
    if (path === '/api/actions') return json(res, 200, data.actions);
    if ((match = /^\/api\/actions\/([^/]+)\/approve$/.exec(path))) {
      const a = data.actions.find((x) => x.id === decodeURIComponent(match![1]))!;
      a.approved = true;
      return json(res, 200, a);
    }
    if (/^\/api\/actions\/[^/]+\/run$/.test(path)) return json(res, 200, { ok: true, output: '' });
    if (path.startsWith('/api/widgets')) {
      if (m === 'GET') return json(res, 200, data.widgets);
      const id = decodeURIComponent(path.split('/')[3] ?? '');
      if (m === 'POST' && !id) {
        const def = { ...(body as WidgetDef), id: `w${data.widgets.defs.length + 1}-new`, approved: true } as WidgetDef;
        data.widgets.defs.push(def);
        return json(res, 200, def);
      }
      if (m === 'PUT') {
        const def = data.widgets.defs.find((d) => d.id === id)!;
        const { slot, height } = body as { slot: WidgetDef['slot']; height?: number };
        def.height = height ?? def.height ?? def.box?.h;
        def.slot = slot;
        delete def.box;
        return json(res, 200, def);
      }
      if (m === 'DELETE') data.widgets.defs = data.widgets.defs.filter((d) => d.id !== id);
      return json(res, 200, { ok: true });
    }
    return json(res, 404, { error: 'not found' });
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname.startsWith('/api/')) {
      route(req, res, url.pathname, url.searchParams).catch((e: Error) => json(res, 500, { error: e.message }));
      return;
    }
    const file = join(DIST, normalize(url.pathname));
    const target = url.pathname !== '/' && existsSync(file) ? file : join(DIST, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' });
    res.end(readFileSync(target));
  });

  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('close', () => sockets.delete(ws));
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw)) as ClientMessage;
      if (msg.t === 'subscribe') subscribes.push({ tabId: msg.tabId, lastSeq: msg.lastSeq });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    data,
    calls,
    subscribes,
    failures,
    push,
    dropSockets: () => {
      for (const ws of sockets) ws.terminate();
    },
    close: () =>
      new Promise((resolve) => {
        for (const ws of sockets) ws.terminate();
        wss.close();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
