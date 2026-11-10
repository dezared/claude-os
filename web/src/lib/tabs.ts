import { create } from 'zustand';
import { api, ApiError, peekCached, setCached } from './api';
import { toastError, useApp } from './store';
import { detachTab } from './ws';
import type { NewTabRequest, SessionInfo, Tab } from './types';

// The root session's own place in the tab strip: nothing on the server changes, its chat stays on Home as well.
const ROOT_TAB_KEY = 'claude-os.rootTab';
export const useRootTab = create<{ open: boolean }>(() => ({ open: localStorage.getItem(ROOT_TAB_KEY) === '1' }));

function setRootTab(open: boolean) {
  localStorage.setItem(ROOT_TAB_KEY, open ? '1' : '0');
  useRootTab.setState({ open });
}

export function openRootTab(id: string) {
  setRootTab(true);
  useApp.getState().go({ kind: 'tab', id });
}

export function closeRootTab(id: string) {
  setRootTab(false);
  remember({ root: true });
  const { view, go, forgetTab } = useApp.getState();
  if (view.kind === 'tab' && view.id === id) go({ kind: 'home' });
  forgetTab(id);
}

// Ctrl+Shift+T. What it takes to open the same conversation again; a session's history is in its journal, so closing loses nothing.
type ClosedTab = { root: true } | ({ root?: false; draft: string } & Pick<Tab, 'id' | 'kind' | 'sessionId' | 'project' | 'cwd' | 'title' | 'model' | 'effort' | 'worktree'>);

const CLOSED_KEY = 'claude-os.closedTabs';
const CLOSED_LIMIT = 20;
const DRAFT_KEY = 'claude-os.draft.'; // Composer.tsx

function readClosed(): ClosedTab[] {
  try {
    const saved = JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '[]') as unknown;
    return Array.isArray(saved) ? (saved as ClosedTab[]) : [];
  } catch {
    return [];
  }
}

export const useClosedTabs = create<{ items: ClosedTab[] }>(() => ({ items: readClosed() }));

function saveClosed(items: ClosedTab[]) {
  localStorage.setItem(CLOSED_KEY, JSON.stringify(items));
  useClosedTabs.setState({ items });
}

function remember(closed: ClosedTab) {
  saveClosed([...useClosedTabs.getState().items, closed].slice(-CLOSED_LIMIT));
}

/** The tab closed last, in the state it was left: its session, its unsent text. */
export async function reopenClosedTab() {
  const items = useClosedTabs.getState().items;
  const closed = items.at(-1);
  if (!closed) return;
  saveClosed(items.slice(0, -1));
  const { go } = useApp.getState();
  if (closed.root) {
    const root = cachedTabs().find((t) => t.kind === 'root');
    if (root) openRootTab(root.id);
    return;
  }
  // Opened again some other way in the meantime: that tab is the answer.
  const open = closed.sessionId ? cachedTabs().find((t) => t.sessionId === closed.sessionId && t.kind === closed.kind) : undefined;
  if (open) return go({ kind: 'tab', id: open.id });
  const req: NewTabRequest = {
    project: closed.project ?? undefined,
    cwd: closed.cwd,
    title: closed.title,
    model: closed.model ?? undefined,
    effort: closed.effort ?? undefined,
    ...(closed.sessionId ? { resumeSessionId: closed.sessionId, readonly: closed.kind === 'readonly' } : { worktree: closed.worktree }),
  };
  let tab: Tab | null;
  try {
    tab = await api<Tab>('/api/tabs', { method: 'POST', body: req });
    setCached<Tab[]>('/api/tabs', (old) => [...(old ?? []).filter((t) => t.id !== tab!.id), tab!]);
  } catch (err) {
    // A terminal took the session in the meantime: it can be read until that one ends.
    if (!(err instanceof ApiError && (err.body as { key?: string } | null)?.key === 'sessionAlive')) return toastError(err);
    tab = await createTab({ ...req, readonly: true }, false);
  }
  if (!tab) return;
  if (closed.draft) localStorage.setItem(DRAFT_KEY + tab.id, closed.draft);
  go({ kind: 'tab', id: tab.id });
}

// Only reads: menus call it while rendering, and setCached would wake every subscriber in the middle of that.
export function cachedTabs(): Tab[] {
  return peekCached<Tab[]>('/api/tabs') ?? [];
}

export async function createTab(req: NewTabRequest, focus = true): Promise<Tab | null> {
  try {
    const tab = await api<Tab>('/api/tabs', { method: 'POST', body: req });
    setCached<Tab[]>('/api/tabs', (old) => [...(old ?? []).filter((t) => t.id !== tab.id), tab]);
    if (focus) useApp.getState().go({ kind: 'tab', id: tab.id });
    return tab;
  } catch (err) {
    toastError(err);
    return null;
  }
}

/** A new tab in cwd that starts with prompt: what a widget's button does. */
export async function openTabWithPrompt(req: { cwd: string; prompt: string; title?: string } & Pick<NewTabRequest, 'source' | 'sourceDetail'>) {
  const tab = await createTab({ cwd: req.cwd, title: req.title, source: req.source, sourceDetail: req.sourceDetail });
  if (tab) await api(`/api/tabs/${encodeURIComponent(tab.id)}/send`, { method: 'POST', body: { text: req.prompt } });
}

async function sessionList(path: string): Promise<SessionInfo[]> {
  try {
    return await api<SessionInfo[]>(path);
  } catch (err) {
    toastError(err);
    return [];
  }
}

export async function openProject(project: string) {
  const existing = cachedTabs()
    .filter((t) => t.kind === 'work' && t.project === project)
    .sort((a, b) => a.order - b.order)[0];
  if (existing) {
    useApp.getState().go({ kind: 'tab', id: existing.id });
    return;
  }
  // Running elsewhere: it opens for reading, a second writer would break it. A new session is one click from there.
  const live = await sessionList(`/api/sessions?project=${encodeURIComponent(project)}&live=1`);
  const newest = live.sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))[0];
  if (newest) await openSession(newest);
  else await createTab({ project });
}

/** A session on the machine: focus its tab. A finished one of ours resumes in full; anything else opens for reading. */
export async function openSession(s: Pick<SessionInfo, 'id' | 'project' | 'cwd'>) {
  const tabs = cachedTabs().filter((t) => t.sessionId === s.id);
  // The tab that can answer comes first. The root tab's chat lives on Home.
  const existing = tabs.find((t) => t.kind !== 'readonly') ?? tabs[0];
  if (existing) useApp.getState().go(existing.kind === 'root' ? { kind: 'home' } : { kind: 'tab', id: existing.id });
  else {
    const info = (await sessionList('/api/sessions')).find((x) => x.id === s.id);
    const ours = info?.origin === 'os' && info.status === 'ended';
    await createTab({ resumeSessionId: s.id, readonly: !ours, project: s.project ?? undefined, cwd: s.cwd });
  }
}

export async function closeTab(tab: Tab, reopenable = true) {
  try {
    await api(`/api/tabs/${encodeURIComponent(tab.id)}`, { method: 'DELETE' });
    // Read from the cached row: the session id may have been given to the tab after this object was rendered.
    const row = cachedTabs().find((t) => t.id === tab.id) ?? tab;
    if (reopenable) {
      const { id, kind, sessionId, project, cwd, title, model, effort, worktree } = row;
      remember({ id, kind, sessionId, project, cwd, title, model, effort, worktree, draft: localStorage.getItem(DRAFT_KEY + id) ?? '' });
    }
    detachTab(tab.id);
    let rest: Tab[] = [];
    setCached<Tab[]>('/api/tabs', (old) => {
      rest = (old ?? []).filter((t) => t.id !== tab.id);
      return rest;
    });
    const { view, go } = useApp.getState();
    if (view.kind === 'tab' && view.id === tab.id) {
      const work = rest.filter((t) => t.kind !== 'root').sort((a, b) => a.order - b.order);
      const next = work.filter((t) => t.order < tab.order).at(-1) ?? work[0];
      go(next ? { kind: 'tab', id: next.id } : { kind: 'home' });
    }
    useApp.getState().forgetTab(tab.id);
  } catch (err) {
    toastError(err);
  }
}

export async function reorderTabs(ordered: Tab[]) {
  const changed = ordered.map((t, i) => ({ ...t, order: i + 1 })).filter((t, i) => t.order !== ordered[i].order);
  setCached<Tab[]>('/api/tabs', (old) => (old ?? []).map((t) => changed.find((c) => c.id === t.id) ?? t));
  try {
    await Promise.all(changed.map((t) => api(`/api/tabs/${encodeURIComponent(t.id)}`, { method: 'PATCH', body: { order: t.order } })));
  } catch (err) {
    toastError(err);
  }
}
