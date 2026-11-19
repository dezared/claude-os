import { Hourglass, Square } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import type { ChatState } from '@/lib/chat';
import { cn, fmtTokens } from '@/lib/format';
import { t } from '@/lib/i18n';
import { toastError } from '@/lib/store';

// The server reports usage only when a turn ends, so the live counter estimates it from the text of the turn.
const CHARS_PER_TOKEN = 4;
const VERB_MS = 3200;

interface TurnFacts { since: number | null; tokens: number; waitingOn: string | null; }

function turnFacts(chat: ChatState): TurnFacts {
  const start = chat.items.findLastIndex((x) => x.k === 'user');
  const blocks = chat.items.slice(start + 1).flatMap((item) => (item.k === 'assistant' ? item.blocks : []));
  let chars = chat.streamOrder.reduce((n, id) => n + (chat.stream[id]?.length ?? 0), 0);
  let waitingOn: string | null = null;
  for (const b of blocks) {
    if (b.type === 'text' || b.type === 'thinking') chars += b.text.length;
    if (b.type !== 'tool_use') continue;
    chars += JSON.stringify(b.input ?? '').length;
    if (!chat.results[b.id]) waitingOn = b.name.split('__').pop() ?? b.name;
  }
  return {
    since: start >= 0 ? chat.items[start].at : null,
    tokens: Math.round(chars / CHARS_PER_TOKEN),
    // Text streaming in means the model is writing, whatever call is still open.
    waitingOn: chat.streamOrder.length > 0 ? null : waitingOn,
  };
}

function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

function useVerb(): string {
  const verbs = t('chat.verbs').split('|');
  const [i, setI] = useState(() => Math.floor(Math.random() * verbs.length));
  useEffect(() => {
    const id = setInterval(() => setI((x) => (x + 1 + Math.floor(Math.random() * (verbs.length - 1))) % verbs.length), VERB_MS);
    return () => clearInterval(id);
  }, [verbs.length]);
  return verbs[i % verbs.length];
}

/** The live line of a running turn: what Claude is up to, how long, and how much it has written. */
export function TurnStatus({ chat, tabId, readOnly }: { chat: ChatState; tabId: string | null; readOnly: boolean }) {
  const now = useNow(1000);
  const verb = useVerb();
  const { since, tokens, waitingOn } = turnFacts(chat);
  const waiting = waitingOn !== null;
  return (
    // Sticky: the only way to stop a turn stays in reach when the conversation is scrolled up.
    <div role="status" data-testid="turn-status" className="enter-fade sticky bottom-2 flex h-7 w-fit items-center gap-2 rounded-full border border-line2 bg-card pr-1 pl-2.5 text-xs text-muted shadow-md">
      {waiting ? <Hourglass size={11} className="hourglass-turn flex-none text-warn" /> : <i className="dot-working block size-1.5 flex-none rounded-full bg-accent" />}
      <span key={waiting ? 'wait' : verb} className={cn('enter-fade font-medium', waiting ? 'text-shimmer is-waiting' : 'text-shimmer')}>
        {waiting ? t('chat.waitingOn', { tool: waitingOn }) : `${verb}…`}
      </span>
      <span className="text-dim tabular-nums" title={t('chat.turnTitle')}>
        {since != null && fmtElapsed(now - since)}
        {tokens > 0 && ` · ↓ ${t('chat.tokens', { n: fmtTokens(tokens) })}`}
      </span>
      {tabId && !readOnly && (
        <button
          type="button"
          aria-label={t('composer.interrupt')}
          title={t('composer.interrupt')}
          onClick={() => api(`/api/tabs/${encodeURIComponent(tabId)}/interrupt`, { method: 'POST' }).catch(toastError)}
          className="press flex h-5 items-center gap-1 rounded-full bg-accent-bg px-2 text-[11px] font-medium text-accent hover:bg-accent hover:text-on-accent"
        >
          <Square size={8} fill="currentColor" />
          {t('composer.stop')}
        </button>
      )}
    </div>
  );
}
