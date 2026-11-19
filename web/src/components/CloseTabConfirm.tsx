import { create } from 'zustand';
import { t } from '@/lib/i18n';
import { closeTab } from '@/lib/tabs';
import type { Tab } from '@/lib/types';
import { ConfirmDialog } from '@/work/git/Dialogs';

const useAsking = create<{ tab: Tab | null }>(() => ({ tab: null }));

/** Closing stops the session: a turn in progress or subagents still out would be cut off. A read-only tab only watches. */
const busy = (tab: Tab) => tab.kind !== 'readonly' && (tab.status === 'working' || tab.subagents > 0);

/** Every way of closing a tab from the strip comes here: a busy tab asks first, any other closes at once. */
export function requestCloseTab(tab: Tab) {
  if (busy(tab)) useAsking.setState({ tab });
  else void closeTab(tab);
}

export function CloseTabConfirm() {
  const tab = useAsking((s) => s.tab);
  if (!tab) return null;
  return (
    <ConfirmDialog
      ask={{ title: t('tabs.closeBusyTitle'), body: t('tabs.closeBusyBody', { title: tab.title }), action: t('tabs.closeBusyAction') }}
      onAnswer={(yes) => {
        useAsking.setState({ tab: null });
        if (yes) void closeTab(tab);
      }}
    />
  );
}
