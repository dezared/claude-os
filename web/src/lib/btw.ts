// /btw: a side question in a small window over the app. The thread lives here, outside any screen: switching tabs
// or screens must not lose an answer that is still coming. Each question is a new throwaway copy on the server; the
// thread so far travels with it, so follow-ups continue without anything being kept there.
import { create } from 'zustand';
import { serverText, t } from './i18n';
import type { BtwEvent, BtwTurn } from '../../../shared/btw.ts';
import type { Tab } from './types';

export interface SideTurn {
  id: string;
  question: string;
  answer: string;
  done: boolean;
  error: string | null;
}

interface BtwState {
  open: boolean;
  tabId: string | null; // the work tab whose conversation each question copies; null: the root folder, no project
  turns: SideTurn[];
  opened: number; // bumps on every open, so the window takes the focus again
}

export const useBtw = create<BtwState>(() => ({ open: false, tabId: null, turns: [], opened: 0 }));
const aborts = new Map<string, AbortController>();

/** Only a work or document tab gives a side question its conversation; Home, the root chat and read-only tabs give none. */
export function btwContext(tab: Pick<Tab, 'id' | 'kind'> | undefined): string | null {
  return tab && (tab.kind === 'work' || tab.kind === 'document') ? tab.id : null;
}

function patch(id: string, change: Partial<SideTurn> | ((c: SideTurn) => Partial<SideTurn>)) {
  useBtw.setState((s) => ({ turns: s.turns.map((c) => (c.id === id ? { ...c, ...(typeof change === 'function' ? change(c) : change) } : c)) }));
}

/** Closing is stopping: an aborted request ends its child on the server. */
function stopAll() {
  for (const abort of aborts.values()) abort.abort();
  aborts.clear();
}

/** Opens the window; another context than the open thread's starts a new thread. With a question, asks it at once. */
export function openBtw(tabId: string | null, question?: string) {
  const s = useBtw.getState();
  if (s.tabId !== tabId) stopAll();
  useBtw.setState({ open: true, tabId, turns: s.tabId === tabId ? s.turns : [], opened: s.opened + 1 });
  if (question) void askBtw(question);
}

export function closeBtw() {
  stopAll();
  useBtw.setState({ open: false, turns: [] });
}

async function readStream(res: Response, onLine: (line: string) => void) {
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let rest = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    const lines = (rest + value).split('\n');
    rest = lines.pop() ?? '';
    lines.forEach(onLine);
  }
}

export async function askBtw(question: string) {
  const { tabId, turns } = useBtw.getState();
  // What was answered so far; one still coming or failed is not part of the thread.
  const history: BtwTurn[] = turns.filter((c) => c.done && !c.error && c.answer).map((c) => ({ question: c.question, answer: c.answer }));
  const id = crypto.randomUUID();
  const abort = new AbortController();
  aborts.set(id, abort);
  useBtw.setState((s) => ({ turns: [...s.turns, { id, question, answer: '', done: false, error: null }] }));
  const onLine = (line: string) => {
    if (!line.trim()) return;
    const e = JSON.parse(line) as BtwEvent;
    patch(id, 'text' in e ? (c) => ({ answer: c.answer + e.text }) : { done: true, error: e.error && serverText(e.error, e.key, e.params) });
  };
  try {
    const res = await fetch(tabId ? `/api/tabs/${encodeURIComponent(tabId)}/btw` : '/api/btw', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, history }),
      signal: abort.signal,
    });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => null)) as { error?: string; key?: string } | null;
      throw new Error(body?.error ? serverText(body.error, body.key) : `HTTP ${res.status}`);
    }
    await readStream(res, onLine);
    patch(id, (c) => (c.done ? {} : { done: true, error: t('api.offline') }));
  } catch (err) {
    if (!abort.signal.aborted) patch(id, { done: true, error: (err as Error).message });
  } finally {
    aborts.delete(id);
  }
}

// A window of its own starts with an empty page: the thread so far crosses over through the storage both windows share.
const HANDOFF_KEY = 'claude-os.btw-handoff';

/** Leaves the answered part of the thread for the separate window, then closes this one. An answer still coming stops. */
export function handBtwOff() {
  const { tabId, turns } = useBtw.getState();
  localStorage.setItem(HANDOFF_KEY, JSON.stringify({ tabId, turns: turns.filter((c) => c.done) }));
  closeBtw();
}

/** The separate window takes the thread that was left for it, if any; without one it keeps what it has. Either way it is open. */
export function takeBtwHandoff() {
  const raw = localStorage.getItem(HANDOFF_KEY);
  localStorage.removeItem(HANDOFF_KEY);
  let left: { tabId: string | null; turns: SideTurn[] } | null = null;
  try {
    if (raw) left = JSON.parse(raw) as { tabId: string | null; turns: SideTurn[] };
  } catch {
    // A damaged handoff is no handoff.
  }
  if (left) stopAll();
  useBtw.setState((s) => ({ open: true, opened: s.opened + 1, ...(left && { tabId: left.tabId, turns: left.turns }) }));
}

export const isBtwHandoff = (e: StorageEvent) => e.key === HANDOFF_KEY && e.newValue !== null;
