// Answers for the second and third batch, with made-up data, for UI tests. Nothing here touches git, an IDE or Claude.
import type { AccountStatus, ClaudeMdReport, CommandInfo, EntityStats, Forecast, GitDiff, GitFile, GitPushPreview, GitStatus, HooksReport, IdeEntry, McpReport, McpServerDetails, Microtask, PluginsReport, ProjectIcons, ProjectIde, ProjectSetup, PromotePreview, SettingsView, UsageEntry, VaultStatus } from '../shared/contract.ts';
import { pluginRoute } from './fixture-plugins.ts';

const NOW = Date.now();
const H = 3_600_000;

const ides: IdeEntry[] = [
  { id: 'phpstorm-a1', catalogId: 'phpstorm', name: 'PhpStorm', family: 'jetbrains', exe: 'C:\\Program Files\\JetBrains\\PhpStorm\\bin\\phpstorm64.exe', side: 'windows', source: 'app_paths', approved: true },
  { id: 'vscode-b2', catalogId: 'vscode', name: 'VS Code', family: 'vscode', exe: '/mnt/c/Users/test/AppData/Local/Programs/Microsoft VS Code/bin/code', side: 'linux', source: 'path', approved: true },
  { id: 'visualstudio-c3', catalogId: 'visualstudio', name: 'Visual Studio Community 2022', family: 'visualstudio', exe: 'C:\\Program Files\\Microsoft Visual Studio\\2022\\Community\\Common7\\IDE\\devenv.exe', side: 'windows', source: 'vswhere', approved: true },
  { id: 'zed-manual', catalogId: 'zed', name: 'Zed', family: 'plain', exe: 'C:\\Tools\\Zed.exe', side: 'windows', source: 'manual', approved: false },
];

export const fixtureSettings: SettingsView = {
  platform: 'wsl', ides, scannedAt: NOW - 2 * H, scanning: false, scanError: null,
  obsidian: { installed: false, exe: null, dismissed: false, vaultWindows: '\\\\wsl.localhost\\Test\\home\\test\\claude-os\\vault' },
  projects: { 'alpha-service': { model: 'claude-sonnet-5-5', effort: 'low' } },
  universe: { limit: 100, theme: 'default', colors: {}, crossLinks: false, nesting: false },
  home: { slots: {}, hidden: [] },
  profile: null,
  setup: { step: 'checks', completedAt: null, tabId: null },
};

export const fixtureCommands: CommandInfo[] = [
  { name: 'compact', description: 'Clear the conversation but keep a summary in context', argumentHint: '[instructions]', source: 'builtin', needsTerminal: false },
  { name: 'config', description: 'Open the settings dialog', argumentHint: null, source: 'builtin', needsTerminal: true },
  { name: 'doctor', description: 'Health-check the setup', argumentHint: '[prompt-audit [<path>]]', source: 'builtin', needsTerminal: true },
  { name: 'focus', description: 'Toggle focus view', argumentHint: '[on|off]', source: 'builtin', needsTerminal: false },
  { name: 'plan', description: 'Enable plan mode', argumentHint: null, source: 'builtin', needsTerminal: true },
  { name: 'theme', description: 'Change the theme', argumentHint: null, source: 'builtin', needsTerminal: true },
  { name: 'brainstorm', description: 'Обсудить задачу до кода', argumentHint: null, source: 'skill', needsTerminal: false },
  { name: 'viz-kit:charts', description: 'Диаграммы и графики', argumentHint: '<data>', source: 'plugin', needsTerminal: false },
  { name: 'release-notes', description: 'Собрать заметки о выпуске этого проекта', argumentHint: null, source: 'project', needsTerminal: false },
  { name: 'review', description: 'Review the current diff', argumentHint: null, source: 'builtin', needsTerminal: false },
];

export const fixtureAccount: AccountStatus = {
  plan: 'Claude Ultra', planSource: 'cli', billing: 'subscription', source: 'usage', receivedAt: NOW - 40_000, error: null,
  windows: [
    { kind: 'session', label: null, percent: 34, resetsAt: NOW + 3 * H, severity: 'normal', active: false },
    { kind: 'weekly_all', label: null, percent: 62, resetsAt: NOW + 80 * H, severity: 'warning', active: true },
    { kind: 'weekly_scoped', label: 'Fable', percent: 0, resetsAt: NOW + 80 * H, severity: 'normal', active: false },
  ],
  events: [{ type: 'five_hour', status: 'allowed', utilization: 31, resetsAt: NOW + 3 * H, receivedAt: NOW - 3 * H }],
};

const staged: GitFile[] = [{ path: 'src/config.ts', oldPath: null, status: 'M' }, { path: 'src/settings.ts', oldPath: null, status: 'A' }];
const unstaged: GitFile[] = [{ path: 'README.md', oldPath: null, status: 'M' }, { path: 'src/db.ts', oldPath: null, status: 'D' }];
const untracked: GitFile[] = [{ path: 'docs/notes on retry.md', oldPath: null, status: '?' }, { path: 'assets/logo.png', oldPath: null, status: '?' }];
const commits = [
  { hash: 'a'.repeat(40), short: 'aaaaaaa', subject: 'Перенос очереди на новый брокер', author: 'Test', at: NOW - 3 * H },
  { hash: 'b'.repeat(40), short: 'bbbbbbb', subject: 'Лимит ретраев вынесен в настройки', author: 'Test', at: NOW - 30 * H },
];
export const fixtureGit: Extract<GitStatus, { isRepo: true }> = { isRepo: true, root: '/home/test/alpha-service', branch: 'feature/broker', upstream: 'origin/feature/broker', ahead: 2, behind: 0, staged, unstaged, untracked, truncated: false, commits, lastFetch: NOW - H };

const DIFF = `diff --git a/src/config.ts b/src/config.ts
--- a/src/config.ts
+++ b/src/config.ts
@@ -10,5 +10,6 @@ export const a = 1;
 export const a = 1;
-export const host = process.env.DB_HOST;
-export const port = 5432;
+export { db } from "./settings";
+export const port = Number(process.env.DB_PORT);
+export const retries = 5;
 export const c = 3;
 export const d = 4;`;

function diffFor(path: string): GitDiff {
  if (path.endsWith('.png')) return { path, binary: true, truncated: false, diff: '' };
  return { path, binary: false, truncated: path === 'README.md', diff: DIFF };
}

const push: GitPushPreview = { branch: 'feature/broker', upstream: 'origin/feature/broker', remote: 'origin', remoteBranch: 'feature/broker', ahead: 2, behind: 0, commits, remotes: ['origin'] };

const usage: UsageEntry[] = [
  { id: 1, session: 's-tab', project: 'alpha-service', tool: 'Skill', target: 'brainstorm', kind: 'skill', op: 'use', at: NOW - H },
  { id: 2, session: 's-tab', project: 'alpha-service', tool: 'Read', target: '/home/test/claude-os/vault/projects/alpha-service/note_1.md', kind: 'vault', op: 'read', at: NOW - H },
  { id: 3, session: 's-tab', project: 'alpha-service', tool: 'Write', target: '/home/test/claude-os/vault/projects/alpha-service/broker.md', kind: 'vault', op: 'write', at: NOW - H },
  { id: 4, session: 's-ended', project: 'beta-web', tool: 'Grep', target: '/home/test/.claude/projects/-home-test-beta-web/memory', kind: 'external', op: 'read', at: NOW - 26 * H },
];

const claudeMd: ClaudeMdReport = {
  files: [
    { scope: 'global', path: '/home/test/.claude/CLAUDE.md', exists: true, version: 'v1', updatedAt: NOW - 26 * H, content: '# Coding Behavior\n\n## Think Before Coding\n\nNever invent business rules, data or metrics.\n' },
    { scope: 'root', path: '/home/test/claude-os/root/CLAUDE.md', exists: true, version: 'v2', updatedAt: NOW - H, content: '# Роль\n\nКоординировать проекты и сессии.\n' },
    { scope: 'project', path: '/home/test/alpha-service/CLAUDE.md', exists: false, version: 'v3', updatedAt: null, content: '' },
  ],
};

const vault: VaultStatus = {
  path: '/home/test/claude-os/vault', exists: true,
  projects: [
    { project: 'alpha-service', name: 'alpha-service', to: '/home/test/claude-os/vault/projects/alpha-service', sources: ['/home/test/.claude/projects/-home-test-alpha-service/memory'], newFiles: ['MEMORY.md', 'broker.md', 'retry.md'], existing: 2, conflicts: ['setup.md'] },
    { project: 'beta-web', name: 'beta-web', to: '/home/test/claude-os/vault/projects/beta-web', sources: ['/home/test/.claude/projects/-home-test-beta-web/memory'], newFiles: ['forms.md'], existing: 0, conflicts: [] },
  ],
};

const microtasks: Microtask[] = [
  { id: 'git-fix', title: 'Fix a git failure', titleRu: 'Исправить ошибку git', input: null, prompt: 'In {cwd}: {action}\n{error}\nAuthorised: {permission}. No force push.' },
  { id: 'planner-file', title: 'File a planner note', titleRu: 'Разложить заметку планера', input: null, prompt: 'File note {id}, today {today}:\n{text}' },
  { id: 'widget-create', title: 'Create a widget', titleRu: 'Создать виджет', input: 'description', prompt: 'Add a widget: {description}' },
  { id: 'widget-change', title: 'Change a widget', titleRu: 'Изменить виджет', input: 'description', prompt: 'Change {title}: {widget}. Wanted: {description}' },
  { id: 'panel-change', title: 'Change a panel', titleRu: 'Изменить панель', input: 'description', prompt: 'Change {panel} in {file}. Wanted: {description}' },
  { id: 'ide-search', title: 'Find IDEs', titleRu: 'Найти IDE', input: null, prompt: 'Found: {found}.' },
  { id: 'project-check', title: 'Check setup', titleRu: 'Проверить настройку', input: null, prompt: 'Audit {root}.' },
  { id: 'obsidian-install', title: 'Install Obsidian', titleRu: 'Установить Obsidian', input: null, prompt: 'Install. Vault: {vault}' },
  { id: 'project-icons', title: 'Pick project icons', titleRu: 'Подобрать иконки проектов', input: null, prompt: 'Write names to {dir}/icons.json:\n{projects}' },
  ...['skills', 'mcp', 'hooks', 'plugins', 'vault', 'usage'].map((p) => ({ id: `admin-${p}`, title: `Ask about ${p}`, titleRu: `Спросить: ${p}`, input: null, prompt: 'Goal: {goal}.\n{context}' })),
  { id: 'admin-claude-md', title: 'Ask about CLAUDE.md', titleRu: 'Спросить о CLAUDE.md', input: null, prompt: 'Goal: {goal}. {path} {level}' },
  { id: 'admin-settings', title: 'Ask about the setting', titleRu: 'Спросить о настройке', input: null, prompt: 'Goal: {goal}. {section}\n{context}' },
];

const setup: ProjectSetup = {
  key: 'alpha-service', root: '/home/test/alpha-service',
  settings: [
    { scope: 'project', path: '/home/test/alpha-service/.claude/settings.json', exists: true, text: '{\n  "model": "opus",\n  "env": {\n    "API_TOKEN": "***"\n  }\n}\n', keys: ['model', 'env', 'hooks'], invalid: false },
    { scope: 'local', path: '/home/test/alpha-service/.claude/settings.local.json', exists: false, text: '{\n}\n', keys: [], invalid: false },
  ],
  hooks: [{ scope: 'project', event: 'PostToolUse', matcher: 'Edit', index: 0, summary: 'npm run lint --silent' }],
  mcp: [{ name: 'docs', scope: 'project', project: 'alpha-service', transport: 'http', summary: 'https://docs.example.test/mcp', envKeys: [], health: null }],
  skills: [{ id: 'project:alpha-service:release-notes', name: 'release-notes', scope: 'project', source: 'alpha-service', description: 'Заметки о выпуске', path: '/home/test/alpha-service/.claude/skills/release-notes', readOnly: false, disabled: false, isSymlink: false, usageCount: 2, lastUsedAt: NOW - H }],
};

export const fixtureMcp: McpReport = {
  windowDays: 30, journalSince: NOW - 60 * 24 * H, probing: false, probes: { global: { at: NOW - 60 * 60_000, error: null } },
  rows: [
    { name: 'plugin:figma:figma', where: { global: false, projects: [], plugin: 'figma', account: false }, definitions: [{ name: 'plugin:figma:figma', scope: 'plugin', project: null, transport: 'http', summary: 'https://mcp.figma.test/mcp', envKeys: ['Authorization'], health: null }], status: 'needs-auth', statusBy: [{ place: 'global', status: 'needs-auth', error: null }], error: null, serverInfo: null, tools: [], description: 'Figma design tools', note: null, calls: 0, toolsUsed: 0, lastCall: null },
    { name: 'broken', where: { global: true, projects: [], plugin: null, account: false }, definitions: [{ name: 'broken', scope: 'user', project: null, transport: 'stdio', summary: 'npx broken', envKeys: ['API_TOKEN'], health: null, file: '/home/test/.claude.json' }], status: 'failed', statusBy: [{ place: 'global', status: 'failed', error: 'spawn ENOENT' }], error: 'spawn ENOENT', serverInfo: null, tools: [], description: null, note: null, calls: 1, toolsUsed: 1, lastCall: NOW - 26 * H },
    { name: 'semble', where: { global: true, projects: [{ key: 'alpha-service', name: 'alpha-service' }], plugin: null, account: false }, definitions: [{ name: 'semble', scope: 'user', project: null, transport: 'stdio', summary: 'uvx semble', envKeys: [], health: null, file: '/home/test/.claude.json' }, { name: 'semble', scope: 'local', project: 'alpha-service', transport: 'stdio', summary: 'uvx semble --old', envKeys: [], health: null, file: '/home/test/.claude.json' }], status: 'connected', statusBy: [{ place: 'global', status: 'connected', error: null }], error: null, serverInfo: { name: 'semble', version: '0.7.2' }, tools: [{ name: 'search', description: null, readOnly: true, destructive: false }, { name: 'find_related', description: null, readOnly: false, destructive: false }], description: null, note: null, calls: 38, toolsUsed: 2, lastCall: NOW - H },
    { name: 'silent', where: { global: true, projects: [], plugin: null, account: false }, definitions: [{ name: 'silent', scope: 'user', project: null, transport: 'stdio', summary: 'npx silent', envKeys: [], health: null }], status: 'connected', statusBy: [{ place: 'global', status: 'connected', error: null }], error: null, serverInfo: { name: 'silent', version: '1.0.0' }, tools: [], description: null, note: null, calls: 0, toolsUsed: 0, lastCall: null },
  ],
  gone: [{ name: 'old_metabase', calls: 12, last: NOW - 26 * H }],
  projects: [{ project: 'alpha-service', name: 'alpha-service', root: '/home/test/alpha-service', own: ['docs'], overrides: ['semble'] }],
};

const mcpDetails: Record<string, McpServerDetails> = {
  semble: { name: 'semble', available: true, reason: null, instructions: 'Instant code search for any repository.', tools: [{ name: 'search', description: 'Search code by meaning.', readOnly: true, destructive: false }] },
  silent: { name: 'silent', available: true, reason: null, instructions: null, tools: [] },
};

const hooksFixture: HooksReport = {
  rows: [
    { scope: 'user', project: null, plugin: null, event: 'Stop', matcher: null, type: 'command', summary: 'notify --token=*** ok', file: '/home/test/.claude/settings.json' },
    { scope: 'plugin', project: null, plugin: 'superpowers', event: 'SessionStart', matcher: 'startup', type: 'command', summary: 'hooks/session-start', file: '/plugins/superpowers/hooks/hooks.json' },
    { scope: 'project', project: 'alpha-service', plugin: null, event: 'PostToolUse', matcher: 'Edit', type: 'command', summary: 'npm run lint', file: '/home/test/alpha-service/.claude/settings.json' },
  ],
  projects: [{ project: 'alpha-service', name: 'alpha-service', root: '/home/test/alpha-service', own: ['PostToolUse · Edit'], overrides: [] }],
};

const pluginsFixture: PluginsReport = {
  windowDays: 30,
  rows: [
    { id: 'superpowers@official', name: 'superpowers', marketplace: 'official', description: 'Core skills', version: '7.0.0', enabled: true, scopes: ['user'], projects: [], installedAt: NOW - 90 * H, updatedAt: NOW - 26 * H, skills: 14, skillsUsed: 6, runs: 80, mcp: 0, hooks: 1, agents: 2, commands: 3, latest: '7.1.0', update: true, marketplaceAt: NOW - H },
    { id: 'idle@official', name: 'idle-plugin', marketplace: 'official', description: null, version: '1.0.0', enabled: true, scopes: ['user'], projects: [], installedAt: null, updatedAt: null, skills: 3, skillsUsed: 0, runs: 0, mcp: 1, hooks: 0, agents: 0, commands: 0, latest: null, update: null, marketplaceAt: null },
    { id: 'local@official', name: 'local-only', marketplace: 'official', description: null, version: '2.0.0', enabled: false, scopes: ['project'], projects: [{ key: 'alpha-service', name: 'alpha-service' }], installedAt: null, updatedAt: null, skills: 0, skillsUsed: 0, runs: 0, mcp: 0, hooks: 0, agents: 0, commands: 0, latest: '2.0.0', update: false, marketplaceAt: null },
  ],
  projects: [{ project: 'alpha-service', name: 'alpha-service', root: '/home/test/alpha-service', own: ['local-only'], overrides: [] }],
};

const forecastFixture: Forecast = {
  basisDays: 14, activeDays: 9, dailyAverage: 11_000_000, today: 4_000_000, todayHours: Array.from({ length: 24 }, (_, h) => (h >= 9 && h < 14 ? 800_000 : 0)), todayProjected: 12_000_000, weekProjected: 77_000_000, monthProjected: 330_000_000,
  windows: [{ kind: 'weekly_all', label: null, percent: 41, resetsAt: NOW + 72 * H, projected: 72, hitsAt: null }],
};

const entityFixture = (type: string | null): EntityStats => ({
  windowDays: 30, journalSince: NOW - 60 * 24 * H, total: 40, recent: 12, last: NOW - H,
  byDay: Array.from({ length: 30 }, (_, i) => ({ day: `2026-10-${String(i + 1).padStart(2, '0')}`, n: i % 5 })),
  byProject: type === 'project' ? [] : [{ key: 'alpha-service', name: 'alpha-service', n: 12 }],
  byName: [{ name: 'search', n: 9 }],
  byModel: type === 'project' ? [{ name: 'claude-sonnet-5-5', n: 12 }] : [],
  createdAt: type === 'mcp' ? null : NOW - 400 * H,
  changedAt: type === 'skill' ? NOW - 30 * H : null,
  meta: type === 'skill' ? { author: 'Jane Doe' } : {},
  history: type === 'skill' ? [{ at: NOW - 30 * H, action: 'skill.update' }] : [],
});

/** Set by a test: what the recheck will find, as the real detection would after an install. */
export const obsidianProbe: { installed: boolean | null } = { installed: null };

export const fixtureIcons: ProjectIcons = { dir: '/home/test/claude-os/config/project-icons', icons: {}, chosen: {}, rejected: [], offerDismissed: true };

const promote: PromotePreview = { title: 'model', files: [{ path: '/home/test/alpha-service/.claude/settings.json', diff: '--- a/settings.json\n+++ b/settings.json\n@@ -1,3 +1,2 @@\n {\n-  "model": "opus",\n }' }, { path: '/home/test/.claude/settings.json', diff: '--- a/settings.json\n+++ b/settings.json\n@@ -1,2 +1,3 @@\n {\n+  "model": "opus",\n }' }], conflict: null };

/** The next git write fails with this text; set by a test. */
export const gitFailures: { next: string | null; path: string | null } = { next: null, path: null };

export function featureRoute(m: string, path: string, q: URLSearchParams, body: unknown): [number, unknown] | null {
  const plugins = pluginRoute(m, path, q, body, fixtureIcons);
  if (plugins) return plugins;
  if (path === '/api/account') return [200, fixtureAccount];
  if (path === '/api/settings' && m === 'GET') return [200, fixtureSettings];
  if (path === '/api/settings/universe' && m === 'PUT') {
    fixtureSettings.universe = { ...fixtureSettings.universe, ...(body as object) };
    return [200, fixtureSettings];
  }
  if (path === '/api/settings/home' && m === 'PUT') {
    fixtureSettings.home = body as SettingsView['home'];
    return [200, fixtureSettings];
  }
  if (path === '/api/settings/obsidian/dismiss') {
    fixtureSettings.obsidian.dismissed = true;
    return [200, fixtureSettings];
  }
  if (path === '/api/ides/scan') return [200, fixtureSettings];
  let match = /^\/api\/settings\/project\/([^/]+)$/.exec(path);
  if (match) {
    fixtureSettings.projects[decodeURIComponent(match[1])] = { ...fixtureSettings.projects[decodeURIComponent(match[1])], ...(body as object) };
    return [200, fixtureSettings];
  }
  if (/^\/api\/ides\/project\//.test(path)) {
    const ok = ides.filter((e) => e.approved);
    const res: ProjectIde = { chosen: ok[0], auto: true, marker: 'composer.json', others: ok.slice(1) };
    return [200, res];
  }
  if (path === '/api/ides/open') return [200, { ok: true }];
  if (path.startsWith('/api/settings/project/')) return [200, { ok: true }];
  if (/^\/api\/tabs\/[^/]+\/commands$/.test(path)) return [200, fixtureCommands];
  if (path === '/api/doctor') return [200, { output: 'Claude Code doctor\n\nNo installation issues found.', error: null }];

  match = /^\/api\/tabs\/([^/]+)\/git(\/.*)?$/.exec(path);
  if (match) {
    const sub = match[2] ?? '';
    if (match[1] === 't2' && !sub) return [200, { isRepo: false, reason: 'not_a_repo' } satisfies GitStatus];
    if (!sub) return [200, fixtureGit];
    if (sub === '/diff') return [200, diffFor(q.get('path') ?? '')];
    if (sub === '/push' && m === 'GET') return [200, push];
    if (sub === '/branches') return [200, { current: 'feature/broker', recent: [], local: [], remote: [], truncated: false }];
    if (sub === '/stash' && m === 'GET') return [200, []];
    if (sub === '/log') return [200, { commits: commits.map((c, i) => ({ ...c, parents: commits[i + 1] ? [commits[i + 1].hash] : [], refs: [] })), more: false }];
    if (/^\/commit\/[0-9a-f]+$/.test(sub) && m === 'GET') return [200, { files: staged }];
    if (/^\/commit\/[0-9a-f]+\/diff$/.test(sub)) return [200, diffFor(q.get('path') ?? '')];
    if (m === 'POST') {
      if (gitFailures.next && gitFailures.path === sub) {
        const error = gitFailures.next;
        gitFailures.next = null;
        return [422, { error }];
      }
      return [200, { ok: true, output: '' }];
    }
  }
  if (path === '/api/usage-log/status') return [200, { backfilling: false }];
  if (path === '/api/usage-log/skills') return [200, [{ name: 'brainstorm', reads: 4, writes: 0, last: NOW - H }]];
  if (path === '/api/usage-log') {
    const s = q.get('session');
    const k = q.get('kind');
    const pr = q.get('project');
    return [200, usage.filter((e) => (!s || e.session === s) && (!k || e.kind === k) && (!pr || e.project === pr))];
  }
  if (/^\/api\/memory\/notes\/[^/]+\/usage$/.test(path)) return [200, { reads: 5, writes: 1, last: NOW - H }];
  if (path === '/api/memory/vault') return [200, vault];
  if (path === '/api/memory/vault/copy') return [200, { ok: true, copied: 4, conflicts: 1 }];
  if (path === '/api/claude-md') return [200, claudeMd];
  if (path === '/api/claude-md/open') return [200, { ok: true }];
  if (path === '/api/claude-md/preview') return [200, { diff: '--- a/CLAUDE.md\n+++ b/CLAUDE.md\n@@ -1 +1 @@\n-old\n+new' }];
  if (path === '/api/claude-md' && m === 'PUT') return [200, claudeMd.files[0]];
  if (path === '/api/admin/mcp') return [200, fixtureMcp];
  if (path === '/api/admin/mcp/status') return [200, fixtureMcp];
  if (path === '/api/admin/mcp/details') return [200, mcpDetails[q.get('name') ?? ''] ?? { name: q.get('name'), available: false, reason: 'needs_login', instructions: null, tools: [] }];
  if (/^\/api\/mcp\/[^/]+\/login$/.test(path)) return [200, { ok: true, command: 'claude mcp login x' }];
  if (path === '/api/admin/hooks') return [200, hooksFixture];
  if (path === '/api/admin/plugins') return [200, pluginsFixture];
  if (path === '/api/admin/entity') return [200, entityFixture(q.get('type'))];
  if (path === '/api/admin/forecast') return [200, forecastFixture];
  if (path === '/api/project-icons') return [200, fixtureIcons];
  if (path === '/api/project-icons/dismiss-offer') {
    fixtureIcons.offerDismissed = true;
    return [200, fixtureIcons];
  }
  if (path === '/api/settings/obsidian/recheck') {
    if (obsidianProbe.installed !== null) fixtureSettings.obsidian.installed = obsidianProbe.installed;
    return [200, fixtureSettings];
  }
  if (path === '/api/microtasks') return [200, microtasks];
  if (path === '/api/app/status') return [200, { stale: false, busy: false, repo: '/home/test/claude-os' }];
  if (/^\/api\/projects\/[^/]+\/setup\/preview$/.test(path)) return [200, { diff: '--- a/settings.json\n+++ b/settings.json\n@@ -1 +1 @@\n-  "model": "opus"\n+  "model": "sonnet"' }];
  if (/^\/api\/projects\/[^/]+\/setup/.test(path)) return [200, setup];
  if (/^\/api\/projects\/[^/]+\/promote\/preview$/.test(path)) return [200, promote];
  if (/^\/api\/projects\/[^/]+\/promote$/.test(path)) return [200, setup];
  return null;
}
