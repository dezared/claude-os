import { AppWindow, ArrowUp, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useApi } from '@/lib/api';
import { askBtw, btwContext, closeBtw, handBtwOff, isBtwHandoff, openBtw, takeBtwHandoff, useBtw, type SideTurn } from '@/lib/btw';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import { usePresence } from '@/lib/motion';
import type { Tab } from '@/lib/types';
import { ClaudeMark } from './ClaudeMark';
import { useContextMenu } from './ContextMenu';
import { popoutBridge } from './desktop';
import { Markdown } from './Markdown';
import { IconButton } from './ui';

const TOP_BAR = 52; // the title bar stays reachable
// Where the window was left, for the next time it opens in this window of the app. null: the lower right corner.
let placed: { left: number; top: number } | null = null;

function fit(el: HTMLElement) {
  const wanted = placed ?? { left: innerWidth - el.offsetWidth - 16, top: innerHeight - el.offsetHeight - 72 };
  const left = Math.max(8, Math.min(wanted.left, innerWidth - el.offsetWidth - 8));
  const top = Math.max(Math.min(TOP_BAR, innerHeight - el.offsetHeight - 8), Math.min(wanted.top, innerHeight - el.offsetHeight - 8));
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

/** Anchored by the upper left corner, so the resize grip of the lower right corner stays under the pointer. */
function drag(e: ReactPointerEvent<HTMLElement>, el: HTMLElement | null) {
  if (e.button !== 0 || !el || (e.target as Element).closest('button')) return;
  const handle = e.currentTarget;
  const box = el.getBoundingClientRect();
  const dx = e.clientX - box.left;
  const dy = e.clientY - box.top;
  handle.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    placed = { left: ev.clientX - dx, top: ev.clientY - dy };
    fit(el);
  };
  const up = () => {
    handle.removeEventListener('pointermove', move);
    handle.removeEventListener('pointerup', up);
    handle.removeEventListener('pointercancel', up);
  };
  handle.addEventListener('pointermove', move);
  handle.addEventListener('pointerup', up);
  handle.addEventListener('pointercancel', up);
}

function Turn({ turn }: { turn: SideTurn }) {
  return (
    <div data-testid="btw-turn" className="enter-fade flex flex-col gap-1">
      <div className="self-end rounded-lg bg-fg/[.06] px-2.5 py-1 text-[12.5px] wrap-anywhere whitespace-pre-wrap text-soft">{turn.question}</div>
      {turn.answer && <div className="enter-fade selectable text-[13px]"><Markdown text={turn.answer} small /></div>}
      {!turn.done && !turn.answer && <div className="flex items-center gap-1.5 py-1 text-[11px] text-dim"><i className="dot-working block size-1.5 rounded-full bg-accent" />{t('btw.thinking')}</div>}
      {turn.error && <p role="alert" className="enter-fade wrap-anywhere text-xs text-accent">{turn.error}</p>}
    </div>
  );
}

const isHotkey = (e: KeyboardEvent) => e.code === 'Space' && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey;

/** Opens the window with Ctrl+Shift+Space from any screen; closes it with Esc unless something on top takes that key. */
function useBtwKeys(contextId: string | null) {
  const tabs = useApi<Tab[]>('/api/tabs', ['tabs']).data;
  const open = useBtw((s) => s.open);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isHotkey(e)) {
        e.preventDefault();
        openBtw(btwContext(tabs?.find((x) => x.id === contextId)));
        return;
      }
      if (!open || e.key !== 'Escape' || e.defaultPrevented || document.querySelector('[role="dialog"][data-state="open"]')) return;
      e.preventDefault();
      closeBtw();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [tabs, contextId, open]);
  return tabs;
}

/** The thread and the question field: the same in the floating window and in a window of its own. */
function BtwThread({ tabId }: { tabId: string | null }) {
  const { turns, opened } = useBtw();
  const [text, setText] = useState('');
  const box = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const last = turns.at(-1);
  useEffect(() => {
    box.current?.focus();
  }, [opened]);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' });
  }, [turns.length, last?.answer]);
  const send = () => {
    const question = text.trim();
    if (!question) return;
    setText('');
    void askBtw(question);
  };
  return (
    <>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto px-3 py-2">
        {turns.length === 0 && <p className="m-auto max-w-72 text-center text-xs text-dim">{t(tabId ? 'btw.emptyTab' : 'btw.empty')}</p>}
        {turns.map((c) => <Turn key={c.id} turn={c} />)}
        <div ref={end} />
      </div>
      <div className="flex-none px-2.5 pb-2.5">
        <div className="flex items-end gap-1 rounded-xl bg-fg/[.045] p-1 shadow-[inset_0_0_0_1px_var(--color-line2)] focus-within:shadow-[inset_0_0_0_1px_var(--color-line)]">
          <textarea
            ref={box}
            rows={1}
            aria-label={t('btw.placeholder')}
            placeholder={t('btw.placeholder')}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing) return;
              e.preventDefault();
              send();
            }}
            className="max-h-28 min-h-7 flex-1 resize-none bg-transparent px-2 py-1 text-[13px] leading-[1.5] wrap-anywhere text-fg outline-none [field-sizing:content] placeholder:text-dim"
          />
          <IconButton label={t('btw.send')} disabled={!text.trim()} onClick={send} className="size-7"><ArrowUp size={14} /></IconButton>
        </div>
      </div>
    </>
  );
}

/** Out to a window of its own, in the desktop app only: a page has no second window to offer. */
function popoutItems() {
  const windows = popoutBridge();
  if (!windows) return [];
  return [{ id: 'btw.popout', label: t('btw.popout'), icon: AppWindow, onSelect: () => {
    handBtwOff();
    windows.openPopout({ kind: 'btw' });
  } }];
}

/** Mounted once per window of the app. A small floating thread of side questions, opened by /btw or the hotkey. `contextId`: the tab in view. */
export function BtwWindow({ contextId }: { contextId: string | null }) {
  const { open, tabId } = useBtw();
  const tabs = useBtwKeys(contextId);
  const frame = useRef<HTMLElement>(null);
  const menu = useContextMenu(popoutItems);
  const shown = usePresence(open); // closed, it fades out where it stood before it unmounts

  useLayoutEffect(() => {
    const el = frame.current;
    if (!open || !el) return;
    fit(el);
    const refit = () => fit(el);
    window.addEventListener('resize', refit);
    return () => window.removeEventListener('resize', refit);
  }, [open]);

  if (!shown.mounted) return null;
  const where = tabId ? tabs?.find((x) => x.id === tabId)?.title : t('btw.noProject');
  return (
    <section
      ref={frame}
      role="dialog"
      aria-modal="false"
      aria-label={t('btw.title')}
      className={cn('glass-reading enter-fade fixed z-50 flex h-[min(420px,calc(100vh-64px))] min-h-64 w-[min(420px,calc(100vw-16px))] min-w-72 resize flex-col overflow-hidden rounded-2xl bg-panel-deep!', shown.leaving && 'is-leaving')}
    >
      <header ref={menu} aria-label={t('btw.drag')} onPointerDown={(e) => drag(e, frame.current)} className="flex flex-none cursor-grab touch-none items-center gap-2 py-1 pr-1.5 pl-3 select-none active:cursor-grabbing">
        <ClaudeMark size={12} />
        <strong className="flex-none text-[13px] font-medium">{t('btw.title')}</strong>
        <span className="min-w-0 flex-1 truncate text-[11px] text-dim" title={where}>{where}</span>
        <IconButton label={t('btw.close')} className="size-7" onClick={closeBtw}><X size={13} /></IconButton>
      </header>
      <BtwThread tabId={tabId} />
    </section>
  );
}

/** The thread in a window of the desktop app of its own: the window's bar is its header, closing the window ends it. */
export function BtwDocked() {
  const tabId = useBtw((s) => s.tabId);
  const where = useApi<Tab[]>('/api/tabs', ['tabs']).data?.find((x) => x.id === tabId)?.title;
  useEffect(() => {
    takeBtwHandoff();
    // Already open: the next thread sent out from the main window lands here.
    const onStorage = (e: StorageEvent) => {
      if (isBtwHandoff(e)) takeBtwHandoff();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return (
    <section aria-label={t('btw.title')} className="enter-fade flex min-h-0 flex-1 flex-col">
      <div className="flex-none truncate px-3 pt-1.5 text-[11px] text-dim">{tabId ? where : t('btw.noProject')}</div>
      <BtwThread tabId={tabId} />
    </section>
  );
}
