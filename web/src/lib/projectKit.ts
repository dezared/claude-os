import type { KitStatusReport } from '../../../shared/projectKit.ts';
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
  return installed === report.kit.version ? `v${installed}` : t('kit.updateTo', { version: report.kit.version });
}

/** The project menu item's label; null hides the item. */
export function kitMenuLabel(projectKey: string): string | null {
  const status = kitStatusText(peekCached<KitStatusReport>(STATUS), projectKey);
  return status === null ? null : `${t('kit.menu')} · ${status}`;
}

/** The menu item and the setup panel start the same microtask; sent anywhere but a work tab of the project, it moves itself there. */
export const runKitTask = (project: string, root: string) => runMicrotask({ id: 'project-kit', project, title: t('kit.title'), vars: { root, project } });
