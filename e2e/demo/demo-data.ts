// Made-up English data for the README screenshots and the demo GIF. Nothing here is a real project or a real session.
// The test fixtures stay as they are: this layer renames their projects and translates their strings on the way to the page.
import type { ChatEvent, SessionInfo, Tab } from '../../shared/contract.ts';
import { fixtureMcp } from '../fixture-features.ts';
import { tokens, type Fixture } from '../fixture-server.ts';

/** Fixture name -> demo name. Applied to every response; requests are mapped back, so the fixture keeps answering. */
export const NAMES: [string, string][] = [
  ['alpha-service', 'payments-api'],
  ['beta-web', 'web-dashboard'],
  ['gamma-tools', 'dev-tools'],
  ['delta-bot', 'support-bot'],
  ['epsilon-lab', 'ml-lab'],
  ['zeta-docs', 'docs-site'],
  ['eta-infra', 'infra'],
  ['/home/test', '/home/dev'],
];

/** Fixture strings in Russian -> English. Whole strings first, then substrings. */
export const TEXT: Record<string, string> = {
  'Главная': 'Home',
  'beta-web · задача 2': 'web-dashboard · dark mode',
  'Перенос очереди': 'Queue migration',
  'Перенос очереди на новый брокер': 'Move the job queue to the new broker',
  'проверь ретраи': 'check the retries',
  'Найти использования брокера': 'Find every use of the broker',
  'Правка вёрстки формы оплаты': 'Fix the checkout form layout',
  'Рефакторинг конфигурации': 'Refactor the configuration',
  'Обсудить задачу до кода': 'Talk a task through before code',
  'Проверить интерфейс': 'Review an interface',
  'Давно не нужен': 'Not needed for a while',
  'Диаграммы': 'Charts',
  'Диаграммы и графики': 'Charts and graphs',
  'Собрать заметки о выпуске этого проекта': 'Collect release notes for this project',
  'Выкатить': 'Deploy',
  'Терминал': 'Terminal',
  'Исправить ошибку git': 'Fix a git error',
  'Разложить заметку планера': 'Split a planner note',
  'Создать виджет': 'Create a widget',
  'Изменить виджет': 'Change a widget',
  'Изменить панель': 'Change a panel',
  'Найти IDE': 'Find IDEs',
  'Проверить настройку': 'Check the setup',
  'Установить Obsidian': 'Install Obsidian',
  'Подобрать иконки проектов': 'Pick project icons',
  'Спросить о CLAUDE.md': 'Ask about CLAUDE.md',
  'Спросить о настройке': 'Ask about a setting',
  'Обновить брокер': 'Upgrade the broker',
  'Обновить брокер\nдо конца месяца': 'Upgrade the broker\nbefore the end of the month',
  'До конца месяца': 'Before the end of the month',
  'Поправить форму оплаты': 'Fix the checkout form',
  'Купить домен': 'Renew the domain',
  'Ревьюер': 'Reviewer',
  'Контекстный поиск поверх ripgrep': 'Context search on top of ripgrep',
  'Ранжирует файлы': 'Ranks files by matches',
  'Строки в CLAUDE.md': 'Lines in CLAUDE.md',
  'Без этих строк Claude не пользуется скиллом.': 'Without these lines Claude does not use the skill.',
  'Проверяет дифф перед коммитом': 'Checks the diff before a commit',
  'Переносит очереди': 'Migrates queues',
  'Рисует графики': 'Draws charts',
  'Ретраи настроены верно, лимит пять попыток.': 'Retries are configured correctly: five attempts with backoff.',
  'Шаги скилла.': 'The steps of the skill.',
  'Текст заметки со [ссылкой](https://example.test).': 'A note with a [link](https://example.test).',
};

export const SUBSTRINGS: [string, string][] = [
  ['Спросить: ', 'Ask: '],
  ['обновить-брокер', 'upgrade-broker'],
  ['очередь', 'queue'],
];

const NOW = Date.now();
const H = 3_600_000;
const ev = (seq: number, minutesAgo: number, body: Record<string, unknown>) => ({ seq, at: NOW - minutesAgo * 60_000, ...body }) as ChatEvent;
const text = (t: string) => [{ type: 'text', text: t }];

/** The payments-api tab: a short refactor that stops at a permission prompt with the diff. */
function refactorChat(): ChatEvent[] {
  const file = '/home/test/alpha-service/src/config.ts';
  return [
    ev(1, 40, { e: 'init', sessionId: 's-tab', model: 'claude-opus-5-5', permissionMode: 'default', slashCommands: [{ name: 'compact', needsTerminal: false }, { name: 'review', needsTerminal: false }] }),
    ev(2, 39, { e: 'user', blocks: text('Move the database settings into one module and show me what changes.') }),
    ev(3, 39, { e: 'assistant', messageId: 'm1', model: 'claude-opus-5-5', blocks: [{ type: 'text', text: 'Let me find where the settings are read.' }, { type: 'tool_use', id: 'tu1', name: 'Grep', input: { pattern: 'DB_HOST' } }, { type: 'tool_use', id: 'tu2', name: 'Read', input: { file_path: file } }] }),
    ev(4, 38, { e: 'tool_result', toolUseId: 'tu1', text: 'src/config.ts:12: DB_HOST\nsrc/db.ts:4: DB_HOST', isError: false }),
    ev(5, 38, { e: 'tool_result', toolUseId: 'tu2', text: 'export const host = process.env.DB_HOST;', isError: false }),
    ev(6, 37, { e: 'assistant', messageId: 'm2', model: 'claude-opus-5-5', blocks: [{ type: 'tool_use', id: 'tu3', name: 'Bash', input: { command: 'npm test -- config' }, subagent: 'a7' }, { type: 'tool_use', id: 'tu4', name: 'Read', input: { file_path: '/home/test/alpha-service/src/db.ts' }, subagent: 'a7' }] }),
    ev(7, 37, { e: 'tool_result', toolUseId: 'tu3', text: 'PASS  config.test.ts (4 tests)', isError: false }),
    ev(8, 36, { e: 'assistant', messageId: 'm3', model: 'claude-opus-5-5', blocks: text('The settings are read in **two** places:\n\n- `src/config.ts`\n- `src/db.ts`\n\nI suggest one module that both import:\n\n```ts\nexport const db = { host: process.env.DB_HOST, port: Number(process.env.DB_PORT ?? 5432) };\n```') }),
    ev(9, 36, { e: 'result', usage: tokens(54, 2480, 183_721, 1_620_000), costUsd: 0.42, interrupted: false, error: null }),
    ev(10, 35, { e: 'user', blocks: text('Go ahead.') }),
    ev(11, 35, { e: 'status', status: 'waiting_permission' }),
    ev(12, 35, { e: 'permission', requestId: 'r1', tool: 'Edit', title: 'Edit src/config.ts', input: { file_path: file }, diff: '--- a/src/config.ts\n+++ b/src/config.ts\n@@ -10,3 +10,3 @@\n export const timeout = 30_000;\n-export const host = process.env.DB_HOST;\n+export { db } from "./settings";\n export const retries = 5;' }),
    ev(13, 34, { e: 'user', queued: true, blocks: text('And update the README while you are at it') }),
  ];
}

const session = (id: string, project: string, title: string, hoursAgo: number, status: SessionInfo['status'], size: number): SessionInfo => ({
  id, project, cwd: `/home/test/${project}`, kind: 'interactive', origin: 'external', name: null, title, lastPrompt: null,
  firstActivity: NOW - (hoursAgo + 2) * H, lastActivity: NOW - hoursAgo * H, status, pid: status === 'ended' ? null : 4000 + size,
  tokens: tokens(size * 3, size * 900, size * 40_000, size * 400_000), subagents: [],
});

/** More sessions, so the machine-wide list looks like a working week. */
function moreSessions(): SessionInfo[] {
  return [
    session('s-4', 'gamma-tools', 'Add a --json flag to the release CLI', 5, 'idle', 12),
    session('s-5', 'delta-bot', 'Answer refunds from the help-center articles', 9, 'ended', 30),
    session('s-6', 'epsilon-lab', 'Compare two embedding models on the eval set', 20, 'ended', 44),
    session('s-7', 'zeta-docs', 'Rewrite the quick start for v2', 28, 'ended', 9),
    session('s-8', 'eta-infra', 'Terraform: move the staging bucket to a new region', 50, 'ended', 18),
    session('s-9', 'alpha-service', 'Idempotency keys for card payments', 70, 'ended', 25),
  ];
}

const TOPICS = ['db-config', 'retry-policy', 'deploy-steps', 'api-auth', 'webhooks', 'rate-limits', 'error-codes', 'test-data', 'release-flow', 'feature-flags', 'caching', 'logging', 'migrations', 'on-call', 'pricing-rules', 'search-index', 'queues', 'secrets'];
const ASPECTS = ['decision', 'gotcha', 'how-to', 'owner', 'history', 'limits', 'checklist', 'links', 'faq'];

/** Memory notes get names a person would give them instead of note_<project>_<n>. */
function nameNotes(data: Fixture): void {
  data.graph.nodes.forEach((n, i) => {
    n.title = `${TOPICS[i % TOPICS.length]}-${ASPECTS[Math.floor(i / TOPICS.length) % ASPECTS.length]}`;
    n.file = `${n.title}.md`;
  });
}

/** Test-only names on the tools screens become ordinary ones. */
function tidyTools(data: Fixture): void {
  const rename: Record<string, string> = { broken: 'postgres', silent: 'github', 'old-thing': 'legacy-deploy', parked: 'sql-helper' };
  for (const row of fixtureMcp.rows) {
    const name = rename[row.name];
    if (!name) continue;
    row.name = name;
    for (const d of row.definitions) d.name = name;
    if (row.serverInfo) row.serverInfo = { ...row.serverInfo, name };
  }
  fixtureMcp.gone = [];
  for (const skill of data.skills) skill.name = rename[skill.name] ?? skill.name;
  const plans = data.skills.find((x) => x.name === 'writing-plans');
  if (plans) plans.description = 'Write a step-by-step plan before a large change';
}

/** Skill runs over 30 days for the usage chart; the test fixture has one day. */
export function skillRunsByDay(): { day: string; runs: number }[] {
  return Array.from({ length: 30 }, (_, i) => {
    const d = new Date(NOW - (29 - i) * 24 * H);
    return { day: d.toISOString().slice(0, 10), runs: Math.round(Math.abs(Math.sin(i * 1.3)) * 4) };
  });
}

/** Turns the default test fixture into the demo: English chat, more sessions, tidy widgets. */
export function toDemo(data: Fixture): void {
  nameNotes(data);
  tidyTools(data);
  data.history.t1 = refactorChat();
  data.sessions.push(...moreSessions());
  const tabs: Tab[] = data.tabs.filter((t) => t.id !== 't3');
  data.tabs = tabs;
  data.widgets = {
    defs: [{ id: 'w1', title: 'Open pull requests', type: 'command', command: 'gh pr list --json number --jq length', intervalSec: 300, approved: true, slot: 'bottom-right', height: 150 }],
    values: [{ id: 'w1', value: '4', updatedAt: NOW - 60_000, error: null }],
  };
  data.transcripts['s-live'] = [
    ev(1, 30, { e: 'user', blocks: text('check the retries') }),
    ev(2, 29, { e: 'assistant', messageId: 'x1', model: 'claude-opus-5-5', blocks: text('Retries are configured correctly: five attempts with backoff.') }),
  ];
}
