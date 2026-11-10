import { ChevronDown, ChevronUp, Ellipsis, Eraser, Maximize2, Minimize2 } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useContextMenu } from '@/components/ContextMenu';
import { Button, Dialog, IconButton } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { emptyChat, useChat, type ChatState } from '@/lib/chat';
import { cn } from '@/lib/format';
import { toastError, useApp } from '@/lib/store';
import type { Tab } from '@/lib/types';
import { attachTab } from '@/lib/ws';
import { rootPlaceItems } from '@/popout/PopoutButton';
import { Composer } from '@/work/Composer';
import { ModeControl } from '@/work/ModeControl';
import { SubagentStrip } from '@/work/SubagentStrip';
import { SubagentDialog } from '@/work/SubagentView';
import { Transcript } from '@/work/Transcript';
import { StatusPill } from '@/work/WorkView';
import { t } from '@/lib/i18n';
import { ActionMenu, type MenuItem } from './ActionMenu';

const LEAVE_MS = 240; // .root-panel in styles.css

export function RootChat() {
  const tabs = useApi<Tab[]>('/api/tabs', ['tabs']);
  const root = tabs.data?.find((t) => t.kind === 'root');
  const chat = useChat((s) => (root ? s.tabs[root.id] : undefined)) ?? emptyChat();
  const draft = useApp((s) => s.rootDraft);
  const setDraft = useApp((s) => s.setRootDraft);
  // The reply lives above the field and leaves the sphere visible: closed, normal or expanded.
  const [panel, setPanel] = useState<'closed' | 'open' | 'large'>('closed');
  const [leaving, setLeaving] = useState(false);
  const [gone, setGone] = useState<ChatState | null>(null); // what /clear just wiped, on screen until the panel has left
  const [confirmReset, setConfirmReset] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const onHome = useApp((s) => s.view.kind === 'home'); // Home stays mounted under the other screens

  useEffect(() => {
    if (root) void attachTab(root.id);
  }, [root?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pending = chat.items.some((i) => i.k === 'request' && i.decision === null);
  const count = chat.items.length;

  const hasContent = count > 0 || chat.streamOrder.length > 0;
  const status = root ? chat.status ?? root.status : null;
  const working = status === 'working';
  // Any turn, whoever started it, and any question from Claude shows the conversation.
  useEffect(() => {
    if (!pending && !working) return;
    setPanel((p) => (p === 'closed' ? 'open' : p));
  }, [pending, working]);

  // Coming back to the app shows where the last session stopped.
  const shownHistory = useRef(false);
  useEffect(() => {
    if (!chat.loaded || shownHistory.current) return;
    shownHistory.current = true;
    if (hasContent) setPanel((p) => (p === 'closed' ? 'open' : p));
  }, [chat.loaded, hasContent]);

  const leaveTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const leave = () => {
    setLeaving(true);
    clearTimeout(leaveTimer.current);
    leaveTimer.current = setTimeout(() => {
      setLeaving(false);
      setGone(null);
      setPanel('closed');
    }, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : LEAVE_MS);
  };
  useEffect(() => () => clearTimeout(leaveTimer.current), []);

  const previous = useRef(chat);
  useLayoutEffect(() => {
    const was = previous.current;
    previous.current = chat;
    if (chat.clearedSeq === was.clearedSeq || was.items.length === 0) return;
    setGone(was);
    leave();
  }); // eslint-disable-line react-hooks/exhaustive-deps

  const reset = () => {
    setConfirmReset(false);
    if (root) api(`/api/tabs/${encodeURIComponent(root.id)}/reset`, { method: 'POST' }).catch(toastError);
  };

  const shown = gone ?? chat;
  const panelVisible = (hasContent || gone !== null || working) && panel !== 'closed';

  // On the surface: the mode and the reply. Where else this chat can live and clearing it are one menu away, the same by ⋯ and by the right button.
  const moreItems = (): MenuItem[] => [
    ...rootPlaceItems(root),
    { id: 'root.reset', label: t('root.reset'), icon: Eraser, danger: true, apart: true, onSelect: () => setConfirmReset(true) },
  ];
  const menuArea = useContextMenu(moreItems);

  return (
    <div ref={menuArea} className="home-chat flex flex-col justify-end">
      {panelVisible && (
        <div className={cn('glass-strong root-panel flex min-h-0 flex-col rounded-2xl', panel === 'large' && 'is-large', leaving && 'is-leaving')}>
          <div className="flex flex-none items-center gap-2 border-b border-line2 py-1 pr-1 pl-3">
            <span className="min-w-0 truncate text-xs font-medium">{t('root.caption')}</span>
            {status && status !== 'idle' && <StatusPill status={status} />}
            <span className="flex-1" />
            <IconButton label={panel === 'large' ? t('root.shrink') : t('root.expand')} className="size-6" onClick={() => setPanel(panel === 'large' ? 'open' : 'large')}>
              {panel === 'large' ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
            </IconButton>
            <IconButton label={t('root.collapse')} className="size-6" onClick={leave}>
              <ChevronDown size={13} />
            </IconButton>
          </div>
          <Transcript chat={shown} tabId={root?.id ?? null} sessionId={chat.sessionId ?? root?.sessionId} scrollKey={root?.id ?? null} working={working} small />
        </div>
      )}
      <Dialog open={confirmReset} onOpenChange={setConfirmReset} title={t('root.resetTitle')} description={t('root.resetText')}>
        <div className="flex justify-end gap-2">
          <Button onClick={() => setConfirmReset(false)}>{t('common.cancel')}</Button>
          <Button variant="danger" onClick={reset}>{t('root.resetConfirm')}</Button>
        </div>
      </Dialog>
      <SubagentStrip sessionId={chat.sessionId ?? root?.sessionId} tasks={chat.tasks} enabled={onHome} className="glass-strong mb-1.5 flex-none" />
      {root ? (
        <Composer
          tab={root}
          chat={chat}
          compact
          underClass="u-on-sky"
          placeholder={t('root.placeholder')}
          prefill={draft}
          onPrefillUsed={() => setDraft(null)}
          onSubmit={() => setPanel((p) => (p === 'closed' ? 'open' : p))}
          caption={
            <>
              {/* Off Home the same session may be open in its tab, and that tab answers /mode. */}
              {onHome && <ModeControl tab={root} chat={chat} />}
              {hasContent && !panelVisible && (
                <button type="button" onClick={() => setPanel('open')} className="press flex items-center gap-1 rounded hover:text-fg">
                  <ChevronUp size={12} /> {t('root.show')}
                </button>
              )}
              <ActionMenu
                label={t('root.more')}
                side="bottom"
                align="end"
                open={menuOpen}
                onOpenChange={setMenuOpen}
                items={moreItems()}
                trigger={
                  <button type="button" aria-label={t('root.more')} title={t('root.more')} aria-haspopup="menu" aria-expanded={menuOpen} className="press order-last ml-auto flex items-center rounded hover:text-fg">
                    <Ellipsis size={14} />
                  </button>
                }
              />
            </>
          }
        />
      ) : (
        <div className="glass rounded-2xl px-3.5 py-2.5 text-muted">
          {tabs.error ? t('root.unavailable', { error: tabs.error }) : tabs.data ? t('root.noTab') : t('root.connecting')}
        </div>
      )}
      {onHome && <SubagentDialog />}
    </div>
  );
}
