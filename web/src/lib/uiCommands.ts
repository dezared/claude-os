// What a session asks the interface to do through the ui_action tool. A new action: a line in UiCommand and UI_ACTION_SET, and a case here.
import { desktop, useDesktopPrefs } from '@/components/desktop';
import { peekCached } from './api';
import { browserNotify } from './browserNotify';
import { t } from './i18n';
import { useApp, type View } from './store';
import { tabTitle } from './tabTitle';
import { assertNever, UI_VIEW_SET, type UiView } from '../../../shared/contract.ts';
import type { Tab, UiCommand } from './types';

const viewOfTab = (tab: Tab | undefined, tabId: string): View => (tab?.kind === 'root' ? { kind: 'home' } : { kind: 'tab', id: tabId });

// Away from the window or the tab: the system notification of the desktop window or of the browser, when allowed.
function notifyAway(tabId: string, title: string, body: string, place: View): boolean {
  if (!document.hidden && document.hasFocus()) return false;
  const bridge = desktop();
  if (bridge) {
    if (useDesktopPrefs.getState().notifications) bridge.notify({ title, body, tabId });
    return true;
  }
  return useDesktopPrefs.getState().notifications && browserNotify(title, body, tabId, () => useApp.getState().go(place));
}

function notify(tabId: string, kind: 'done' | 'question', text: string | null) {
  const tab = peekCached<Tab[]>('/api/tabs')?.find((x) => x.id === tabId);
  const body = text ?? t(kind === 'question' ? 'desktop.ask' : 'desktop.done');
  const title = tab && tabTitle(tab, t('tabs.root'));
  const place = viewOfTab(tab, tabId);
  if (notifyAway(tabId, title ?? 'Claude OS', body, place)) return;
  const app = useApp.getState();
  if (JSON.stringify(app.view) === JSON.stringify(place)) return; // the answer is already on the screen
  app.toast(title ? `${title}: ${body}` : body, 'info', { label: t('ui.openTab'), onClick: () => useApp.getState().go(place) });
}

const isCoreView = (view: string): view is Exclude<UiView, 'planner' | 'projects' | 'sessions'> => view in UI_VIEW_SET;

function open(view: Extract<UiCommand, { action: 'open' }>['view'], project: string | null) {
  const app = useApp.getState();
  if (view === 'planner') return app.openPlanner();
  if (view === 'projects') return app.go({ kind: 'projects', key: project ?? undefined });
  if (view === 'sessions') return app.go({ kind: 'sessions', project });
  if (isCoreView(view)) return app.go({ kind: view });
  // A plugin's screen, which its server part named: it opens on the project, when one is given.
  app.go({ kind: 'plugin', screen: view, ...(project ? { arg: project } : {}) });
}

export function runUiCommand(tabId: string, command: UiCommand) {
  switch (command.action) {
    case 'notify':
      return notify(tabId, command.kind, command.text);
    case 'toast':
      return useApp.getState().toast(command.text);
    case 'open':
      return open(command.view, command.project);
    default:
      return assertNever(command);
  }
}
