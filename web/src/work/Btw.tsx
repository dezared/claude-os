import { X } from 'lucide-react';
import { useEffect, type RefObject } from 'react';
import { create } from 'zustand';
import { ClaudeMark } from '@/components/ClaudeMark';
import { Markdown } from '@/components/Markdown';
import { IconButton } from '@/components/ui';
import { spendNote } from '@/lib/account';
import { serverText, t } from '@/lib/i18n';
import type { BtwEvent } from '@/lib/types';

interface Card {
  id: string;
  tabId: string;
  question: string;
  answer: string;
  done: boolean;
  error: string | null;
}

// Outside the composer: switching tabs must not lose an answer that is still coming.
const useBtw = create<{ cards: Card[] }>(() => ({ cards: [] }));
const aborts = new Map<string, AbortController>();

function patch(id: string, change: Partial<Card> | ((c: Card) => Partial<Card>)) {
  useBtw.setState((s) => ({ cards: s.cards.map((c) => (c.id === id ? { ...c, ...(typeof change === 'function' ? change(c) : change) } : c)) }));
}

export async function askBtw(tabId: string, question: string) {
  const id = crypto.randomUUID();
  const abort = new AbortController();
  aborts.set(id, abort);
  useBtw.setState((s) => ({ cards: [...s.cards, { id, tabId, question, answer: '', done: false, error: null }] }));
  const onLine = (line: string) => {
    if (!line.trim()) return;
    const e = JSON.parse(line) as BtwEvent;
    patch(id, 'text' in e ? (c) => ({ answer: c.answer + e.text }) : { done: true, error: e.error && serverText(e.error, e.key, e.params) });
  };
  try {
    const res = await fetch(`/api/tabs/${encodeURIComponent(tabId)}/btw`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: abort.signal,
    });
    if (!res.ok || !res.body) {
      const body = (await res.json().catch(() => null)) as { error?: string; key?: string } | null;
      throw new Error(body?.error ? serverText(body.error, body.key) : `HTTP ${res.status}`);
    }
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let rest = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const lines = (rest + value).split('\n');
      rest = lines.pop() ?? '';
      lines.forEach(onLine);
    }
    patch(id, (c) => (c.done ? {} : { done: true, error: t('api.offline') }));
  } catch (err) {
    if (!abort.signal.aborted) patch(id, { done: true, error: (err as Error).message });
  } finally {
    aborts.delete(id);
  }
}

/** Closing is stopping: the aborted request ends the child on the server. */
function closeBtw(id: string) {
  aborts.get(id)?.abort();
  useBtw.setState((s) => ({ cards: s.cards.filter((c) => c.id !== id) }));
}

/** Answers on the side, above the input. They are not part of the conversation and leave with their ✕ or Esc. */
export function BtwCards({ tabId, box, hint }: { tabId: string; box: RefObject<HTMLTextAreaElement | null>; hint: boolean }) {
  const all = useBtw((s) => s.cards);
  const cards = all.filter((c) => c.tabId === tabId);
  const last = cards.at(-1)?.id;

  useEffect(() => {
    if (!last) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="dialog"]')) return;
      if (!box.current?.checkVisibility({ visibilityProperty: true })) return; // the home composer stays mounted under other screens
      e.preventDefault();
      closeBtw(last);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [last, box]);

  if (cards.length === 0 && !hint) return null;
  return (
    <div className="mb-2 flex flex-col gap-1.5" role="group" aria-label={t('btw.aria')}>
      {cards.map((c) => (
        <div key={c.id} data-testid="btw-card" className="enter-fade rounded-lg border border-line2 bg-card py-1.5 pr-1 pl-2.5 text-xs">
          <div className="flex items-center gap-2">
            {!c.done && <i className="dot-working block size-1.5 flex-none rounded-full bg-accent" />}
            <span className="min-w-0 flex-1 truncate text-dim" title={c.question}>{c.question}</span>
            <IconButton label={t('btw.close')} className="size-6" onClick={() => closeBtw(c.id)}><X size={11} /></IconButton>
          </div>
          {c.answer && <div className="selectable max-h-52 overflow-auto pr-1.5"><Markdown text={c.answer} small /></div>}
          {c.error && <p role="alert" className="pr-1.5 wrap-anywhere text-accent">{c.error}</p>}
        </div>
      ))}
      {hint && <div className="flex flex-wrap items-center gap-x-2 pl-1 text-[11px] text-dim"><ClaudeMark size={11} /><span>{t('btw.hint')}</span><span>{spendNote()}</span></div>}
      {!hint && cards.some((c) => !c.done) && <div className="flex items-center gap-1.5 pl-1 text-[11px] text-dim"><ClaudeMark size={11} />{spendNote()}</div>}
    </div>
  );
}
