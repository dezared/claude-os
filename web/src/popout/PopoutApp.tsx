import { Eye, MessagesSquare, Minus, PanelTopClose, Pin, PinOff, WifiOff, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Unauthorized } from '@/App';
import { AskClaudeDialog } from '@/components/AskClaudeDialog';
import { ContextMenuHost } from '@/components/ContextMenu';
import { popoutBridge } from '@/components/desktop';
import { MicrotaskDialog } from '@/components/MicrotaskDialog';
import { ModalServiceTasks, ServiceTaskList } from '@/components/ServiceTasks';
import { ErrorState, Skeleton } from '@/components/states';
import { StatusDot } from '@/components/StatusDot';
import { Toasts } from '@/components/Toasts';
import { Tooltips } from '@/components/Tooltips';
import { IconButton } from '@/components/ui';
import { useApi } from '@/lib/api';
import { applyEvents, emptyChat, useChat } from '@/lib/chat';
import { statusLabel } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { PopoutRequest } from '@/lib/popout';
import { useApp } from '@/lib/store';
import type { ChatEvent, Tab } from '@/lib/types';
import { PluginOverlays, useUiPluginLoader } from '@/lib/uiPlugins';
import { attachTab } from '@/lib/ws';
import { Planner } from '@/notes/PlannerPanel';
import { Composer } from '@/work/Composer';
import { SubagentStrip } from '@/work/SubagentStrip';
import { SubagentDialog } from '@/work/SubagentView';
import { FileViewer } from '@/work/FileViewer';
import { Transcript } from '@/work/Transcript';

/** The window's own frame: it has no other. The bar drags it, and in a plain browser only the title is left. */
function WindowBar({ title, status, children, closeLabel }: { title: string; status?: ReactNode; children?: ReactNode; closeLabel?: string }) {
  const windows = popoutBridge();
  const [pinned, setPinned] = useState<boolean | null>(null);
  useEffect(() => {
    void windows?.popoutPin().then(setPinned).catch(() => {});
  }, [windows]);
  useEffect(() => {
    document.title = title;
  }, [title]);
  const pin = (on: boolean) => {
    setPinned(on);
    windows?.setPopoutPin(on);
  };
  return (
    <header className="popout-bar flex h-9 flex-none items-center gap-1.5 border-b border-line2 pr-1 pl-3 select-none">
      {status}
      <strong className="min-w-0 flex-1 truncate text-[12.5px] font-medium" title={title}>{title}</strong>
      {children}
      {windows && (
        <>
          {pinned !== null && (
            <IconButton label={pinned ? t('popout.unpin') : t('popout.pin')} aria-pressed={pinned} className="no-drag" onClick={() => pin(!pinned)}>
              {pinned ? <Pin size={13} className="text-accent" /> : <PinOff size={13} />}
            </IconButton>
          )}
          {/* A chat goes on in the main window. The planner is one list either way: closing it is all there is. */}
          {!closeLabel && <IconButton label={t('popout.return')} className="no-drag" onClick={() => windows.returnPopout()}><PanelTopClose size={13} /></IconButton>}
          <IconButton label={t('popout.minimize')} className="no-drag" onClick={() => windows.popoutWindow('minimize')}><Minus size={13} /></IconButton>
          <IconButton label={closeLabel ?? t('popout.close')} className="no-drag" onClick={() => windows.popoutWindow('close')}><X size={14} /></IconButton>
        </>
      )}
    </header>
  );
}

function LiveChat({ tab, title }: { tab: Tab; title: string }) {
  const chat = useChat((s) => s.tabs[tab.id]) ?? emptyChat();
  useEffect(() => {
    void attachTab(tab.id);
  }, [tab.id]);
  const status = chat.status ?? tab.status;
  return (
    <>
      <WindowBar title={title} status={<StatusDot status={status} attention={tab.attention} />}>
        {status !== 'idle' && <span className="flex-none text-[11px] whitespace-nowrap text-muted">{statusLabel(status)}</span>}
      </WindowBar>
      {chat.error && !chat.loaded ? (
        <div className="flex-1 p-3"><ErrorState message={t('work.historyFailed', { error: chat.error })} onRetry={() => void attachTab(tab.id, true)} /></div>
      ) : !chat.loaded ? (
        <div className="flex-1 p-3"><Skeleton lines={6} /></div>
      ) : (
        <Transcript
          chat={chat}
          tabId={tab.id}
          sessionId={chat.sessionId ?? tab.sessionId}
          scrollKey={tab.id}
          working={status === 'working'}
          small
          empty={<div className="flex flex-col items-center gap-2.5 py-16 text-center text-muted"><MessagesSquare size={20} className="text-dim" />{t('popout.empty')}</div>}
        />
      )}
      <div className="flex-none px-2.5 pt-2 pb-2.5">
        <SubagentStrip sessionId={chat.sessionId ?? tab.sessionId} tasks={chat.tasks} className="mb-1.5 w-full" />
        <Composer tab={tab} chat={chat} placeholder={tab.kind === 'root' ? t('root.placeholder') : t('work.messagePlaceholder', { title: tab.title })} />
      </div>
      <SubagentDialog />
    </>
  );
}

/** Someone else's session: its journal, with no way to write into it. */
function ReadonlyChat({ tab }: { tab: Tab }) {
  const transcript = useApi<ChatEvent[]>(tab.sessionId ? `/api/sessions/${encodeURIComponent(tab.sessionId)}/transcript` : null, ['sessions']);
  const chat = useMemo(() => (transcript.data ? applyEvents(emptyChat(), transcript.data) : null), [transcript.data]);
  return (
    <>
      <WindowBar title={tab.title} status={<Eye size={12} className="flex-none text-dim" />} />
      {transcript.error && !transcript.data ? (
        <div className="flex-1 p-3"><ErrorState message={t('work.transcriptFailed', { error: transcript.error })} onRetry={transcript.refetch} /></div>
      ) : !chat ? (
        <div className="flex-1 p-3"><Skeleton lines={6} /></div>
      ) : (
        <Transcript chat={chat} tabId={null} filesTab={tab.id} sessionId={tab.sessionId} scrollKey={tab.id} readOnly small empty={<div className="py-16 text-center text-muted">{t('work.emptyTranscript')}</div>} />
      )}
    </>
  );
}

function ChatWindow({ route }: { route: Exclude<PopoutRequest, { kind: 'planner' | 'service' }> }) {
  const tabs = useApi<Tab[]>('/api/tabs', ['tabs']);
  const tab = tabs.data?.find((x) => (route.kind === 'root' ? x.kind === 'root' : x.id === route.id));
  const gone = Boolean(tabs.data && !tab);
  // The tab was closed elsewhere: nothing is left for this window to show.
  useEffect(() => {
    if (gone) popoutBridge()?.popoutWindow('close');
  }, [gone]);
  if (tab?.kind === 'readonly') return <ReadonlyChat key={tab.id} tab={tab} />;
  if (tab) return <LiveChat key={tab.id} tab={tab} title={tab.kind === 'root' ? t('root.caption') : tab.title} />;
  return (
    <>
      <WindowBar title="Claude OS" />
      {tabs.error ? <div className="p-3"><ErrorState message={tabs.error} onRetry={tabs.refetch} /></div> : gone ? <div className="p-3 text-dim">{t('work.tabGone')}</div> : <Skeleton className="p-3" lines={6} />}
    </>
  );
}

/** One chat, the planner or the service tasks, on a route of its own. No title bar with tabs, no map and so no WebGL: Home is never rendered here. */
export function PopoutApp({ route }: { route: PopoutRequest }) {
  const unauthorized = useApp((s) => s.unauthorized);
  const connection = useApp((s) => s.connection);
  useUiPluginLoader();
  if (unauthorized) return <Unauthorized />;
  return (
    <div className="app-root popout-window flex h-full min-h-0 flex-col">
      {route.kind === 'planner' ? (
        <>
          <WindowBar title={t('planner.title')} closeLabel={t('popout.closePlanner')} />
          <Planner focus={null} />
        </>
      ) : route.kind === 'service' ? (
        <>
          <WindowBar title={t('service.region')} closeLabel={t('service.closeWindow')} />
          <ServiceTaskList />
        </>
      ) : (
        <ChatWindow route={route} />
      )}
      {connection === 'offline' && (
        <div role="status" className="flex flex-none items-center gap-2 border-t border-line2 bg-[#2a170f] px-3 py-1 text-xs text-soft">
          <WifiOff size={12} className="text-accent" />
          {t('app.offline')}
        </div>
      )}
      <MicrotaskDialog />
      <AskClaudeDialog />
      <ModalServiceTasks />
      <FileViewer />
      <ContextMenuHost />
      <Toasts />
      <Tooltips />
      <PluginOverlays />
    </div>
  );
}
