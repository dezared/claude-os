import { Bot, Check, Network, Waypoints, type LucideIcon } from 'lucide-react';
import { claudeItems } from '@/components/ContextMenu';
import type { MenuItem } from '@/home/ActionMenu';
import { api, setCached } from '@/lib/api';
import { screenItems } from '@/components/TitleBar';
import { t } from '@/lib/i18n';
import { askClaude } from '@/lib/microtask';
import { toastError } from '@/lib/store';
import type { Project, SettingsView, UniverseOptions } from '@/lib/types';

const CONFIG_NOTE = 'These options live in config/settings.json (../config/settings.json from the root session) under the key "universe": { limit, theme: default | ember | aurora | mono, colors: { bg, inner, outer } as #rrggbb, crossLinks, nesting }. The server picks up the file by itself.';

export function setUniverse(patch: Partial<UniverseOptions>) {
  return api<SettingsView>('/api/settings/universe', { method: 'PUT', body: patch }).then((next) => setCached<SettingsView>('/api/settings', () => next), toastError);
}

/** true keeps a project on the map, false keeps it off. The server's invalidation brings the new list. */
export function setOnMap(key: string, on: boolean | null) {
  void api(`/api/projects/${encodeURIComponent(key)}/map`, { method: 'POST', body: { on } }).catch(toastError);
}

/** Which projects stand on the map, left to Claude: the dialog goes through the usual path, nothing is sent before its button. */
export function askMapSetup(projects: Project[], limit: number) {
  const rows = projects.map((p) => `- ${p.key}: last activity ${p.lastActivity ? new Date(p.lastActivity).toISOString() : 'never'}, live sessions ${p.liveCount}, map choice ${p.mapPin === null ? 'automatic' : p.mapPin ? 'always on' : 'off'}`);
  askClaude({
    subject: {
      kind: 'project map',
      name: t('universe.menuName'),
      context: `The map holds up to ${limit} projects. Over the limit the most recently active stay. Use the set_project_map tool to keep a project on (true), off (false) or back to automatic (null). ${CONFIG_NOTE}\n\nProjects:\n${rows.join('\n')}`,
    },
    intent: 'change',
    title: t('universe.mapSetupTitle'),
    presets: [t('universe.mapSetupPreset')],
    placeholder: t('universe.mapSetupPlaceholder'),
  });
}

function toggle(id: string, label: string, on: boolean, icon: LucideIcon, onSelect: () => void): MenuItem {
  return { id, label, icon: on ? Check : icon, onSelect };
}

/** The main menu: a right click on the core or the menu key, the only menu on the map. The theme is in Settings, next to what it changes. */
export function coreMenu(ctx: { projects: Project[]; options: UniverseOptions; widget: MenuItem[] }): MenuItem[][] {
  const { options } = ctx;
  return [
    ctx.widget,
    [
      toggle('universe.crossLinks', t('universe.crossLinks'), options.crossLinks, Waypoints, () => void setUniverse({ crossLinks: !options.crossLinks })),
      toggle('universe.nesting', t('universe.nesting'), options.nesting, Network, () => void setUniverse({ nesting: !options.nesting })),
    ],
    [{ id: 'universe.mapSetup', label: t('universe.mapSetup'), icon: Bot, onSelect: () => askMapSetup(ctx.projects, options.limit) }, ...claudeItems({ kind: 'universe map', name: t('universe.menuName'), context: CONFIG_NOTE })],
    screenItems(),
  ];
}
