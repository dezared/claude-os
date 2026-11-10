import { api } from './api';
import { fillPrompt } from './microtask';
import { t } from './i18n';
import { toastError, useApp } from './store';
import { createTab } from './tabs';
import type { AppStatus, Microtask } from './types';

const PENDING = 'claude-os:crash-fix';

export interface Crash {
  where: string;
  error: string;
}

export const describeError = (err: unknown): string => (err instanceof Error ? err.stack || err.message : String(err));

/** The page may not survive the moment of the crash, so the request waits out the reload in sessionStorage. */
export function reloadAndFix(crash: Crash) {
  sessionStorage.setItem(PENDING, JSON.stringify(crash));
  location.reload();
}

/** Runs before anything renders: the screen that broke may break again, and the fix must still go out. */
export async function sendPendingFix() {
  const raw = sessionStorage.getItem(PENDING);
  if (!raw) return;
  sessionStorage.removeItem(PENDING);
  try {
    const crash = JSON.parse(raw) as Crash;
    const [status, templates] = await Promise.all([api<AppStatus>('/api/app/status'), api<Microtask[]>('/api/microtasks')]);
    const template = templates.find((m) => m.id === 'crash-fix');
    if (!template) throw new Error(t('crash.noTemplate'));
    const tab = await createTab({ cwd: status.repo, title: t('crash.tabTitle'), source: 'crash-fix' });
    if (tab) await api(`/api/tabs/${encodeURIComponent(tab.id)}/send`, { method: 'POST', body: { text: fillPrompt(template.prompt, { repo: status.repo, where: crash.where, error: crash.error }) } });
  } catch (err) {
    toastError(err);
  }
}

/** Restarts the server on the code now on disk and reloads the page once the new process answers. */
export async function restartServer() {
  const before = await api<{ pid: number }>('/health').catch(() => null);
  await api('/api/app/restart', { method: 'POST' });
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const now = await fetch('/health').then((r) => (r.ok ? (r.json() as Promise<{ pid: number }>) : null)).catch(() => null);
    if (now && now.pid !== before?.pid) return location.reload();
  }
  throw new Error(t('crash.restartFailed'));
}

/** What no boundary sees: errors in event handlers and promises. Offered as a toast, the screen itself still works. */
export function watchUncaughtErrors() {
  const report = (err: unknown) => {
    const text = err instanceof Error ? err.message : String(err);
    if (text.includes('ResizeObserver')) return; // the browser's own notice, harmless
    useApp.getState().toast(text, 'error', {
      label: t('crash.fix'),
      onClick: () => reloadAndFix({ where: t('crash.whereBackground'), error: describeError(err) }),
    });
  };
  window.addEventListener('error', (e) => report(e.error ?? e.message));
  window.addEventListener('unhandledrejection', (e) => report(e.reason));
}
