import { useState } from 'react';
import { create } from 'zustand';
import type { AskRequest, MicrotaskRequest } from './microtask';
import { inPopout } from './popout';

export type View =
  | { kind: 'home' }
  | { kind: 'tab'; id: string }
  | { kind: 'sessions'; project?: string | null }
  | { kind: 'analytics' }
  | { kind: 'projects'; key?: string }
  | { kind: 'tools'; pane?: ToolsPane }
  | { kind: 'os-plugins' }
  | { kind: 'settings'; section?: SettingsSection }
  | { kind: 'entity'; type: EntityType; id: string; project?: string }
  | { kind: 'kanban'; board?: string }
  | { kind: 'documents'; project?: string | null; pane?: 'documents' | 'knowledge' };

export type EntityType = 'project' | 'skill' | 'plugin' | 'mcp' | 'hook' | 'os-plugin' | 'agent';
export type ToolsPane = 'skills' | 'agents' | 'mcp' | 'hooks' | 'plugins' | 'claude-md' | 'vault' | 'log';
export type SettingsSection = 'general' | 'profile' | 'widgets' | 'ides' | 'projects' | 'claude' | 'notes' | 'voice' | 'about';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
  action?: { label: string; onClick: () => void };
}

interface AppState {
  view: View;
  connection: 'connecting' | 'online' | 'offline';
  unauthorized: boolean;
  paletteOpen: boolean;
  newTabOpen: boolean;
  newTabProject: string | null;
  connectOpen: boolean;
  noteId: string | null;
  rootDraft: string | null;
  microtask: MicrotaskRequest | null;
  ask: AskRequest | null;
  plannerOpen: boolean;
  plannerNote: string | null;
  toasts: Toast[];
  history: View[];
  historyAt: number;
  setMicrotask: (req: MicrotaskRequest | null) => void;
  setAsk: (req: AskRequest | null) => void;
  openPlanner: (noteId?: string) => void;
  closePlanner: () => void;
  go: (view: View) => void;
  step: (by: -1 | 1) => void;
  forgetTab: (id: string) => void;
  setConnection: (c: AppState['connection']) => void;
  setUnauthorized: () => void;
  setPalette: (open: boolean) => void;
  setConnectOpen: (open: boolean) => void;
  openNewTab: (project?: string | null) => void;
  closeNewTab: () => void;
  openNote: (id: string | null) => void;
  setRootDraft: (draft: string | null) => void;
  toast: (text: string, kind?: Toast['kind'], action?: Toast['action']) => void;
  dismissToast: (id: number) => void;
}

const VIEW_KEY = 'claude-os.view';
const HISTORY_LIMIT = 100;
const sameView = (a: View, b: View) => JSON.stringify(a) === JSON.stringify(b);

function restoreView(): View {
  try {
    const raw = localStorage.getItem(VIEW_KEY);
    if (!raw) return { kind: 'home' };
    const view = JSON.parse(raw) as View | { kind: 'tools'; pane: 'os-plugins' };
    return view.kind === 'tools' && (view.pane as string) === 'os-plugins' ? { kind: 'os-plugins' } : view as View; // where it was before it became its own screen
  } catch {
    return { kind: 'home' };
  }
}

let toastId = 1;

const firstView = restoreView();

export const useApp = create<AppState>((set, get) => ({
  view: firstView,
  connection: 'connecting',
  unauthorized: false,
  paletteOpen: false,
  newTabOpen: false,
  newTabProject: null,
  connectOpen: false,
  noteId: null,
  rootDraft: null,
  microtask: null,
  ask: null,
  plannerOpen: false,
  plannerNote: null,
  toasts: [],
  history: [firstView],
  historyAt: 0,
  setMicrotask: (microtask) => set({ microtask }),
  setAsk: (ask) => set({ ask }),
  openPlanner: (noteId) => set({ plannerOpen: true, plannerNote: noteId ?? null }),
  closePlanner: () => set({ plannerOpen: false, plannerNote: null }),
  go: (view) => {
    // A window of one chat has no screens: where it wants to go opens in the main window.
    if (inPopout) return window.claudeDesktop?.showInMain?.(view);
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    const { history, historyAt } = get();
    if (sameView(history[historyAt], view)) return set({ view });
    const next = [...history.slice(0, historyAt + 1), view].slice(-HISTORY_LIMIT);
    set({ view, history: next, historyAt: next.length - 1 });
  },
  step: (by) => {
    const { history, historyAt } = get();
    const view = history[historyAt + by];
    if (!view) return;
    localStorage.setItem(VIEW_KEY, JSON.stringify(view));
    set({ view, historyAt: historyAt + by });
  },
  // A closed tab is not a place to go back to. Runs after the view has moved off it.
  forgetTab: (id) => {
    const { history, historyAt } = get();
    const kept: View[] = [];
    let at = 0;
    history.forEach((v, i) => {
      const gone = v.kind === 'tab' && v.id === id;
      if (!gone && !(kept.length > 0 && sameView(kept[kept.length - 1], v))) kept.push(v);
      if (i === historyAt) at = Math.max(0, kept.length - 1);
    });
    set({ history: kept.length > 0 ? kept : [get().view], historyAt: at });
  },
  setConnection: (connection) => {
    if (get().connection !== connection) set({ connection });
  },
  setUnauthorized: () => set({ unauthorized: true }),
  setPalette: (paletteOpen) => set({ paletteOpen }),
  setConnectOpen: (connectOpen) => set({ connectOpen }),
  openNewTab: (project = null) => set({ newTabOpen: true, newTabProject: project }),
  closeNewTab: () => set({ newTabOpen: false }),
  openNote: (noteId) => set({ noteId }),
  setRootDraft: (rootDraft) => set({ rootDraft }),
  toast: (text, kind = 'info', action) => {
    const id = toastId++;
    set((s) => ({ toasts: [...s.toasts.slice(-3), { id, text, kind, action }] }));
    setTimeout(() => get().dismissToast(id), kind === 'error' ? 8000 : 4000);
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

// In a separate window `view` follows the main window: the planner there needs to know the active project.
if (inPopout) window.addEventListener('storage', (e) => {
  if (e.key === VIEW_KEY) useApp.setState({ view: restoreView() });
});

/** A small UI preference that survives a restart: collapsed panels and the like. */
export function usePersisted(key: string, initial: boolean): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => {
    const saved = localStorage.getItem(key);
    return saved === null ? initial : saved === '1';
  });
  return [value, (v) => {
    localStorage.setItem(key, v ? '1' : '0');
    setValue(v);
  }];
}

export const toast = (text: string, kind?: Toast['kind']) => useApp.getState().toast(text, kind);
export const toastError = (err: unknown) => toast((err as Error).message ?? String(err), 'error');
