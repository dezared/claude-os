import { DEFAULT_KIT, type KitStatusReport } from '../../../shared/projectKit.ts';
import { peekCached, useApi } from './api';
import { t } from './i18n';
import { runMicrotask } from './microtask';

/** The tool whose permission card shows the stored kit plan instead of its raw input. */
export { KIT_APPLY_TOOL } from '../../../shared/projectKit.ts';

const STATUS = '/api/project-kit/status';

/** Mounted once in App: menus are built on a right click and read the status synchronously from this cache. */
export const useKitStatus = () => useApi<KitStatusReport>(STATUS, ['projectKit']);

/** `not installed`, `v<x>` or `update to v<y>`; null while no kit plugin is enabled. */
export function kitStatusText(report: KitStatusReport | undefined, project: string): string | null {
  if (!report?.kit) return null;
  const installed = report.projects[project] ?? null;
  if (installed === null) return t('kit.notInstalled');
  const enabled = report.kits.find((k) => k.id === installed.id);
  return !enabled || enabled.version === installed.version ? `v${installed.version}` : t('kit.updateTo', { version: enabled.version });
}

/** The project menu item's label; null hides the item. */
export function kitMenuLabel(projectKey: string): string | null {
  const status = kitStatusText(peekCached<KitStatusReport>(STATUS), projectKey);
  return status === null ? null : `${t('kit.menu')} · ${status}`;
}

/**
 * The menu item, the setup panel and the kits screen start the same microtask; sent anywhere but a work tab of the project,
 * it moves itself there. Without a kit it is the one the project has, else the default one.
 */
export function runKitTask(project: string, root: string, kit?: string, action: 'install' | 'remove' = 'install') {
  const report = peekCached<KitStatusReport>(STATUS);
  const id = kit ?? report?.projects[project]?.id ?? report?.kit?.id ?? DEFAULT_KIT;
  runMicrotask({ id: 'project-kit', project, title: t(action === 'remove' ? 'kit.removeTitle' : 'kit.title'), vars: { root, project, kit: id, action } });
}
