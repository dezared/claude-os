import { AppWindow, PanelTop, PanelTopClose } from 'lucide-react';
import { popoutBridge, popoutKey, popoutRequest, usePopouts } from '@/components/desktop';
import { IconButton } from '@/components/ui';
import type { MenuItem } from '@/home/ActionMenu';
import { t } from '@/lib/i18n';
import { openRootTab } from '@/lib/tabs';
import type { Tab } from '@/lib/types';

/** Whether this tab has a window of its own. */
export const usePoppedOut = (tab: Pick<Tab, 'id' | 'kind'> | undefined) => usePopouts((s) => Boolean(tab && s.keys.includes(popoutKey(tab))));

/** The right click on a tab. Nothing in a plain browser: there is no window to open. */
export function popoutItems(tab: Pick<Tab, 'id' | 'kind'>): MenuItem[] {
  const windows = popoutBridge();
  if (!windows) return [];
  const key = popoutKey(tab);
  return usePopouts.getState().keys.includes(key)
    ? [{ id: 'popout.return', label: t('popout.return'), icon: PanelTopClose, onSelect: () => windows.returnPopout(key) }]
    : [{ id: 'popout.open', label: t('popout.open'), icon: AppWindow, onSelect: () => windows.openPopout(popoutRequest(tab)) }];
}

/** Where the root session can go besides Home: its own tab in the strip and, in the desktop app, its own window. */
export function rootPlaceItems(root: Pick<Tab, 'id' | 'kind'> | undefined): MenuItem[] {
  if (!root) return [];
  return [{ id: 'root.openTab', label: t('root.openTab'), icon: PanelTop, onSelect: () => openRootTab(root.id) }, ...popoutItems(root)];
}

/** In the chat's header: out to a window, and back. */
export function PopoutButton({ tab, className }: { tab: Pick<Tab, 'id' | 'kind'>; className?: string }) {
  const windows = popoutBridge();
  const out = usePoppedOut(tab);
  if (!windows) return null;
  return (
    <IconButton label={out ? t('popout.return') : t('popout.open')} aria-pressed={out} className={className} onClick={() => (out ? windows.returnPopout(popoutKey(tab)) : windows.openPopout(popoutRequest(tab)))}>
      {out ? <PanelTopClose size={14} className="text-accent" /> : <AppWindow size={14} />}
    </IconButton>
  );
}
