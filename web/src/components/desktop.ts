import { create } from 'zustand';
import type { PopoutRequest } from '@/lib/popout';
import type { Tab } from '@/lib/types';
import type { View } from '@/lib/store';

export interface DesktopApp {
  id: number;
  title: string;
  icon: string | null;
}

// desktop/preload.cjs. Absent in a plain browser: the page then behaves as a page.
export interface DesktopBridge {
  canFullscreen: boolean;
  onCloseRequest(cb: (req: { fromTray: boolean }) => void): () => void;
  answerClose(choice: 'dialog' | 'quit' | 'tray'): void;
  notify(notice: { title: string; body: string; tabId: string }): void;
  onOpenTab(cb: (tabId: string) => void): () => void;
  setLabels(labels: { open: string; quit: string; cut: string; copy: string; paste: string }): void;
  isFullscreen(): Promise<boolean>;
  setFullscreen(on: boolean): void;
  onFullscreen(cb: (on: boolean) => void): () => void;
  minimize(): void;
  currentApps(): Promise<DesktopApp[]>;
  onApps(cb: (apps: DesktopApp[]) => void): () => void;
  activateApp(id: number): void;
  // An app built before separate windows has none of these: see popoutBridge.
  showInMain?(view: View): void;
}

// The separate windows. Only what is asked for by kind and id: the address is built in the main process.
export interface PopoutBridge {
  openPopout(req: PopoutRequest): void;
  returnPopout(key?: string): void; // no key: the window asking
  popouts(): Promise<string[]>;
  onPopouts(cb: (keys: string[]) => void): () => void;
  onShowView(cb: (view: View | 'planner') => void): () => void;
  popoutPin(): Promise<boolean>;
  setPopoutPin(on: boolean): void;
  popoutWindow(action: 'minimize' | 'close'): void;
}

declare global {
  interface Window {
    claudeDesktop?: DesktopBridge;
  }
}

export const desktop = (): DesktopBridge | null => window.claudeDesktop ?? null;

export const popoutBridge = (): (DesktopBridge & PopoutBridge) | null => {
  const bridge = desktop() as (DesktopBridge & Partial<PopoutBridge>) | null;
  return bridge?.openPopout ? (bridge as DesktopBridge & PopoutBridge) : null;
};

/** What is out in a window of its own, as the main process says: `root`, `planner`, `tab:<id>`. */
export const usePopouts = create<{ keys: string[] }>(() => ({ keys: [] }));

export const popoutKey = (tab: Pick<Tab, 'id' | 'kind'>) => (tab.kind === 'root' ? 'root' : `tab:${tab.id}`);
export const popoutRequest = (tab: Pick<Tab, 'id' | 'kind'>): PopoutRequest => (tab.kind === 'root' ? { kind: 'root' } : { kind: 'tab', id: tab.id });

export type CloseChoice = 'ask' | 'tray' | 'stop';

interface Prefs {
  closeChoice: CloseChoice;
  notifications: boolean;
  fullscreenMode: boolean; // the off switch of the mode, not its current state
}

const KEY = 'claude-os.desktop';

function read(): Prefs {
  const prefs: Prefs = { closeChoice: 'ask', notifications: true, fullscreenMode: true };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    if (saved.closeChoice === 'tray' || saved.closeChoice === 'stop') prefs.closeChoice = saved.closeChoice;
    if (saved.notifications === false) prefs.notifications = false;
    if (saved.fullscreenMode === false) prefs.fullscreenMode = false;
  } catch {
    // Damaged preferences are the defaults.
  }
  return prefs;
}

export const useDesktopPrefs = create<Prefs>(read);

export function setDesktopPrefs(patch: Partial<Prefs>) {
  useDesktopPrefs.setState(patch);
  localStorage.setItem(KEY, JSON.stringify(useDesktopPrefs.getState()));
}

/** Tabs whose work closing the app would touch. A read-only tab watches a session that runs elsewhere. */
export function activeTabs(tabs: Tab[]): Tab[] {
  return tabs.filter((t) => t.kind !== 'readonly' && (t.status === 'working' || t.status === 'waiting_permission' || t.status === 'blocked' || t.attention || t.queued > 0));
}

export type TabMark = Pick<Tab, 'status' | 'attention'>;

/**
 * Tabs that started waiting for an answer: a blocked Claude cannot say so itself.
 * "Finished" is not read from here: a turn's end is not the end of the work, Claude says that through ui_action.
 */
export function tabNotices(before: Map<string, TabMark>, tabs: Tab[]): Tab[] {
  return tabs.filter((tab) => tab.kind !== 'readonly' && tab.attention && !before.get(tab.id)?.attention);
}
