// Answers for the icon library and the Claude OS plugins pane, with made-up data. Nothing here installs anything.
import { LIBRARY_ICON_INK, type IconLibrary, type OsPluginDependency, type OsPluginPlan, type OsPluginRow, type OsPluginSetup, type OsPluginsReport, type ProjectIcons } from '../shared/contract.ts';

const svgOf = (ink: string) => `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" fill="none" stroke="${ink}"><circle cx="12" cy="12" r="9"/></svg>`;
const iconLibrary: IconLibrary = { total: 2, items: [{ name: 'map', svg: svgOf(LIBRARY_ICON_INK) }, { name: 'si:gitlab', svg: svgOf(LIBRARY_ICON_INK) }] };

const CLAUDE_MD_BLOCK = '<!-- os-plugin:rg-context:claude-md:start -->\nUse the rg-context skill.\n<!-- os-plugin:rg-context:claude-md:end -->';
const setup: OsPluginSetup = { cwd: '/home/test/claude-os', title: 'rg-context: setup', prompt: `The Claude OS plugin "rg-context" needs the following.\n\n${CLAUDE_MD_BLOCK}` };
const dependency: OsPluginDependency = { id: 'claude-md', kind: 'config', level: 'required', title: 'Lines in CLAUDE.md', titleRu: 'Строки в CLAUDE.md', why: 'Without these lines Claude does not use the skill.', whyRu: 'Без этих строк Claude не пользуется скиллом.', target: '/home/test/.claude/CLAUDE.md', block: CLAUDE_MD_BLOCK, state: 'missing' };
const SEARCH_ICON = svgOf(LIBRARY_ICON_INK);
const depPlugin: OsPluginRow = { id: 'rg-context', name: 'rg-context', description: 'Context search on top of ripgrep', descriptionRu: 'Контекстный поиск поверх ripgrep', features: ['Ranks files'], featuresRu: ['Ранжирует файлы'], icon: SEARCH_ICON, version: '1.1.0', author: 'Claude OS', path: '/home/test/claude-os/config/plugins/rg-context', source: 'user', contains: { skills: ['rg-context'], hooks: [], mcp: [], ui: null, kit: null }, dependencies: [dependency], setup, errors: [], enabled: false, installedVersion: null, installedAt: null, changed: false };
const samplePlugin: OsPluginRow = { ...depPlugin, descriptionRu: null, features: [], featuresRu: [], icon: null, dependencies: [], setup: null };
const brokenPlugin: OsPluginRow = { ...samplePlugin, id: 'broken', name: 'broken', description: null, version: null, author: null, path: '/home/test/claude-os/config/plugins/broken', contains: { skills: [], hooks: [], mcp: [], ui: null, kit: null }, errors: ['version must look like 1.2.3'] };
const fullPlugin: OsPluginRow = { ...samplePlugin, id: 'full', name: 'full', description: 'All three kinds', path: '/home/test/claude-os/config/plugins/full', contains: { skills: ['helper'], hooks: [{ event: 'Stop', matcher: null, command: 'notify done' }], mcp: [{ name: 'docs', summary: 'npx docs', envKeys: [] }], ui: null, kit: null } };

const planFor = (row: OsPluginRow, action: OsPluginPlan['action']): OsPluginPlan => {
  const verb = action === 'disable' ? 'remove' : 'add';
  return {
    id: row.id, action, version: row.version, sha: `sha-${action}`, conflicts: [],
    dependencies: action === 'disable' ? [] : row.dependencies,
    setup: action === 'disable' ? null : row.setup,
    changes: [
      { kind: 'skill', action: verb, name: 'helper', where: '/home/test/.claude/skills/helper', detail: 'SKILL.md' },
      { kind: 'hook', action: verb, name: 'Stop', where: '/home/test/.claude/settings.json', detail: 'notify done' },
      { kind: 'mcp', action: verb, name: 'docs', where: '/home/test/.claude.json (mcpServers)', detail: 'npx docs' },
    ],
  };
};

export const fixtureOsPlugins: OsPluginsReport = { dir: '/home/test/claude-os/config/plugins', rows: [] };
export function resetOsPlugins() {
  fixtureOsPlugins.rows = [{ ...fullPlugin }, brokenPlugin, { ...depPlugin }];
}
resetOsPlugins();

export function pluginRoute(m: string, path: string, q: URLSearchParams, body: unknown, icons: ProjectIcons): [number, unknown] | null {
  if (path === '/api/os-plugins') return [200, fixtureOsPlugins];
  if (path === '/api/os-plugins/ui') return [200, []];
  let match = /^\/api\/os-plugins\/([^/]+)\/(preview|enable|disable|update)$/.exec(path);
  if (match) {
    const row = fixtureOsPlugins.rows.find((r) => r.id === match![1]);
    if (!row) return [404, { error: 'plugin not found' }];
    if (match[2] === 'preview') return [200, planFor(row, (body as { action: OsPluginPlan['action'] }).action)];
    row.enabled = match[2] !== 'disable';
    row.installedVersion = row.enabled ? row.version : null;
    row.changed = false;
    return [200, fixtureOsPlugins];
  }
  if (path === '/api/project-icons/library') {
    const text = q.get('q');
    return [200, text ? { total: 1, items: iconLibrary.items.filter((i) => i.name.includes(text)) } : iconLibrary];
  }
  match = /^\/api\/project-icons\/([^/]+)$/.exec(path);
  if (match && m === 'PUT') {
    const key = decodeURIComponent(match[1]);
    const icon = (body as { icon: string | null }).icon;
    if (icon) {
      icons.chosen[key] = icon;
      icons.icons[key] = svgOf(LIBRARY_ICON_INK);
    } else {
      delete icons.chosen[key];
      delete icons.icons[key];
    }
    return [200, icons];
  }
  return null;
}
