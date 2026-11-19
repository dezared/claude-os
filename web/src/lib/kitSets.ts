import type { OsPluginRow, OsPluginsReport } from '../../../shared/contract.ts';
import { KIT_SETS_MAX, type KitContents, type KitHistoryEntry, type KitMetric, type KitMetricsRow, type KitProjectRow, type KitSetsReport } from '../../../shared/projectKit.ts';
import { useApi } from './api';
import { locale, t } from './i18n';
import { runMicrotask } from './microtask';

/** One tile of the kits screen: the plugin, what it writes, the projects that have it, their metrics and its history. */
export interface KitSet {
  id: string;
  plugin: OsPluginRow;
  contents: KitContents;
  isDefault: boolean;
  projects: KitProjectRow[];
  metrics: KitMetricsRow[];
  history: KitHistoryEntry[];
}

export interface KitSetsView { sets: KitSet[]; projects: KitProjectRow[]; history: KitHistoryEntry[]; canCreate: boolean }

/** The three sources joined by kit id; `from`/`to` bound the metrics, as on the Analytics screen. */
export function useKitSets(from: string, to: string) {
  const kits = useApi<KitSetsReport>('/api/project-kit/kits', ['projectKit', 'osPlugins']);
  const plugins = useApi<OsPluginsReport>('/api/os-plugins', ['osPlugins']);
  const metrics = useApi<KitMetricsRow[]>(`/api/analytics/kit?from=${from}&to=${to}`, ['tokens', 'projectKit']);
  const data = kits.data && plugins.data ? joinSets(kits.data, plugins.data.rows, metrics.data ?? []) : undefined;
  const refetch = () => {
    kits.refetch();
    plugins.refetch();
  };
  return { data, error: kits.error ?? plugins.error, loading: kits.loading || plugins.loading, refetch };
}

export function joinSets(r: KitSetsReport, plugins: OsPluginRow[], metrics: KitMetricsRow[]): KitSetsView {
  const sets = r.kits.flatMap(({ id, contents }) => {
    const plugin = plugins.find((p) => p.id === id);
    if (!plugin) return [];
    const projects = r.projects.filter((p) => p.kit?.id === id);
    const keys = new Set(projects.map((p) => p.key));
    return [{ id, plugin, contents, isDefault: r.default === id, projects, metrics: metrics.filter((m) => keys.has(m.project)), history: r.history.filter((h) => h.kit === id) }];
  });
  // The default first, then the enabled ones, then by name: the order the tiles keep while nothing changes.
  sets.sort((a, b) => Number(b.isDefault) - Number(a.isDefault) || Number(b.plugin.enabled) - Number(a.plugin.enabled) || a.plugin.name.localeCompare(b.plugin.name));
  return { sets: sets.slice(0, KIT_SETS_MAX), projects: r.projects, history: r.history, canCreate: sets.length < KIT_SETS_MAX };
}

export const kitDescription = (p: OsPluginRow) => (locale() === 'ru' ? p.descriptionRu ?? p.description : p.description);

/** Needs the plugin screen's Update: the folder changed since it was enabled, or its manifest names a newer version. */
export const kitUpdatable = (p: OsPluginRow) => p.enabled && p.errors.length === 0 && (p.changed || (!!p.version && p.installedVersion !== p.version));

/** The mean of the projects' values after the install; null when no project has one yet. */
export function meanAfter(rows: KitMetricsRow[], m: KitMetric): number | null {
  const values = rows.flatMap((r) => (r.metrics[m].after == null ? [] : [r.metrics[m].after]));
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

/** A new kit: Claude copies the shipped one into a plugin folder of the user's and shapes it from the description. */
export function createKit(sets: KitSet[]) {
  runMicrotask({ id: 'kit-create', title: t('kits.create'), placeholder: t('kits.createPlaceholder'), vars: { kits: sets.map((s) => s.id).join(', ') || 'none' } });
}

/** Changing a kit: a shipped one is copied to the user's plugins first, so an app update never overwrites the change. */
export function configureKit(set: KitSet) {
  const p = set.plugin;
  runMicrotask({ id: 'kit-change', title: t('kits.configureTitle', { name: p.name }), placeholder: t('kits.configurePlaceholder'), vars: { kit: set.id, name: p.name, path: p.path, source: p.source === 'shipped' ? 'shipped with Claude OS' : "the user's own" } });
}
