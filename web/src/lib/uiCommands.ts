// What a session asks the interface to do through the ui_action tool. A new action: a line in UiCommand and UI_ACTION_SET, and a case here.
import { desktop, useDesktopPrefs } from '@/components/desktop';
import { peekCached } from './api';
import { t } from './i18n';
import { useApp, type View } from './store';
import { tabTitle } from './tabTitle';
import { assertNever } from '../../../shared/contract.ts';
import type { Tab, UiCommand } from './types';

const viewOfTab = (tab: Tab | undefined, tabId: string): View => (tab?.kind === 'root' ? { kind: 'home' } : { kind: 'tab', id: tabId });

function notify(tabId: string, kind: 'done' | 'question', text: string | null) {
  const tab = peekCached<Tab[]>('/api/tabs')?.find((x) => x.id === tabId);
  const body = text ?? t(kind === 'question' ? 'desktop.ask' : 'desktop.done');
  const title = tab && tabTitle(tab, t('tabs.root'));
  const app = useApp.getState();
  const bridge = desktop();
  if (bridge && (document.hidden || !document.hasFocus())) {
    if (useDesktopPrefs.getState().notifications) bridge.notify({ title: title ?? 'Claude OS', body, tabId });
    return;
  }
  const place = viewOfTab(tab, tabId);
  if (JSON.stringify(app.view) === JSON.stringify(place)) return; // the answer is already on the screen
  app.toast(title ? `${title}: ${body}` : body, 'info', { label: t('ui.openTab'), onClick: () => useApp.getState().go(place) });
}

function open(view: Extract<UiCommand, { action: 'open' }>['view'], project: string | null) {
  const app = useApp.getState();
  if (view === 'planner') return app.openPlanner();
  if (view === 'projects') return app.go({ kind: 'projects', key: project ?? undefined });
  if (view === 'sessions') return app.go({ kind: 'sessions', project });
  if (view === 'kanban') return app.go({ kind: 'kanban', board: project ?? undefined });
  app.go({ kind: view });
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
