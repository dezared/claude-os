import { Eye, GitBranch, MessagesSquare, Play, Plus, TriangleAlert } from 'lucide-react';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { ErrorState, Skeleton } from '@/components/states';
import { Button, Select } from '@/components/ui';
import { api, setCached, useApi } from '@/lib/api';
import { applyEvents, emptyChat, useChat } from '@/lib/chat';
import { useChatWidthClass } from '@/lib/chatWidth';
import { cn, fmtAgo, fmtInt, fmtTokens, isLive, shortPath, statusLabel, tokenSum } from '@/lib/format';
import { prettyModel } from '@/lib/model-name';
import { efforts, modelGroups } from '@/lib/models';
import { t } from '@/lib/i18n';
import { toastError, useApp } from '@/lib/store';
import { closeTab, createTab } from '@/lib/tabs';
import type { ChatEvent, SessionInfo, Tab } from '@/lib/types';
import { attachTab } from '@/lib/ws';
import { PopoutButton } from '@/popout/PopoutButton';
import { StatusDot } from '@/components/StatusDot';
import { ActionBar, ActionButton, findTerminalAction, useActions } from './Actions';
import { Composer } from './Composer';
import { FilesPanel } from './FilesPanel';
import { IdeButton } from './IdeButton';
import { SidePanel } from './SidePanel';
import { useTabCommand } from './tabCommands';
import { SubagentStrip } from './SubagentStrip';
import { SubagentDialog } from './SubagentView';
import { Transcript } from './Transcript';

const GitPanel = lazy(() => import('./GitPanel').then((m) => ({ default: m.GitPanel })));
const DocumentTab = lazy(() => import('@/documents/DocumentTab').then((m) => ({ default: m.DocumentTab })));

export function StatusPill({ status }: { status: Tab['status'] }) {
  return (
    <span className={cn('flex flex-none items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] whitespace-nowrap', status === 'ended' ? 'bg-raised text-muted' : 'bg-accent-bg text-accent')}>
      <StatusDot status={status} />
      {statusLabel(status)}
    </span>
  );
}

function ModelEffort({ tab, model }: { tab: Tab; model: string | null }) {
  const models = useApi<{ id: string; label: string }[]>('/api/models');
  const patch = async (body: { model?: string | null; effort?: string | null }) => {
    try {
      const next = await api<Tab>(`/api/tabs/${encodeURIComponent(tab.id)}`, { method: 'PATCH', body });
      setCached<Tab[]>('/api/tabs', (old) => (old ?? []).map((t) => (t.id === next.id ? next : t)));
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <>
      <Select ariaLabel={t('work.modelAria')} className="max-w-36 flex-none text-xs" value={tab.model} onChange={(v) => patch({ model: v })} options={[{ value: null, label: model ? prettyModel(model) : t('work.modelFromSettings') }]} groups={modelGroups(models.data ?? [])} />
      <Select ariaLabel={t('work.effortAria')} className="max-w-36 flex-none text-xs" value={tab.effort} onChange={(v) => patch({ effort: v })} options={efforts().map((o) => (o.value === null ? { ...o, label: t('work.effortFromSettings') } : o))} />
    </>
  );
}

function NeighbourWarning({ tab, tabs }: { tab: Tab; tabs: Tab[] }) {
  if (tab.worktree || !tab.project) return null;
  const busy = tabs.filter((t) => t.id !== tab.id && t.project === tab.project && !t.worktree && t.status === 'working');
  if (busy.length === 0) return null;
  return (
    <div role="status" className="flex flex-none items-center gap-2 border-b border-line2 bg-[#241511] px-5 py-1 text-xs text-soft">
      <TriangleAlert size={12} className="text-accent" />
      {t('work.neighbour', { title: busy[0].title })}
    </div>
  );
}

function LiveTab({ tab, tabs }: { tab: Tab; tabs: Tab[] }) {
  const chat = useChat((s) => s.tabs[tab.id]) ?? emptyChat();
  const width = useChatWidthClass();
  useEffect(() => {
    void attachTab(tab.id);
  }, [tab.id]);

  const status = chat.status ?? tab.status;
  const [gitOpen, setGitOpen] = useState(false);
  const closeGit = useMemo(() => () => setGitOpen(false), []);
  useTabCommand(tab.id, 'git', () => setGitOpen(true));

  return (
    <div className="relative min-h-0 flex-1 overflow-auto app:grid app:grid-cols-[auto_minmax(0,1fr)_320px] app:overflow-hidden">
      {gitOpen && (
        <Suspense fallback={null}>
          <GitPanel tab={tab} turnKey={status} onClose={closeGit} />
        </Suspense>
      )}
      {tab.kind === 'root' ? <span /> : <FilesPanel tab={tab} turnKey={status} />}
      <section className="flex h-[70vh] min-w-0 flex-col border-b border-line2 app:h-auto app:min-h-0 app:border-r app:border-b-0">
        <div className="work-bar">
          <strong className="max-w-56 min-w-0 flex-none truncate text-[13px] font-medium" title={tab.kind === 'root' ? t('root.caption') : tab.title}>{tab.kind === 'root' ? t('root.caption') : tab.title}</strong>
          <StatusPill status={status} />
          {tab.worktree && (
            <span className="flex flex-none items-center gap-1 text-[11px] text-muted" title={t('work.worktreeTitle')}>
              <GitBranch size={11} /> worktree
            </span>
          )}
          <span className="min-w-0 flex-1 basis-0 truncate font-mono text-[11px] text-dim" title={tab.cwd}>{shortPath(tab.cwd)}</span>
          <ModelEffort tab={tab} model={chat.model} />
          <Button className="flex-none" aria-pressed={gitOpen} onClick={() => setGitOpen(!gitOpen)}><GitBranch size={12} />{t('git.button')}</Button>
          <IdeButton tab={tab} />
          <PopoutButton tab={tab} />
          <ActionBar tab={tab} />
        </div>
        <NeighbourWarning tab={tab} tabs={tabs} />
        {chat.error && !chat.loaded ? (
          <div className="flex-1 p-5">
            <ErrorState message={t('work.historyFailed', { error: chat.error })} onRetry={() => void attachTab(tab.id, true)} />
          </div>
        ) : !chat.loaded ? (
          <div className={cn('mx-auto w-full flex-1 px-5 py-6', width)}>
            <Skeleton lines={6} />
          </div>
        ) : (
          <Transcript
            chat={chat}
            tabId={tab.id}
            sessionId={chat.sessionId ?? tab.sessionId}
            scrollKey={tab.id}
            working={status === 'working'}
            empty={<div className="flex flex-col items-center gap-2.5 py-20 text-center text-muted"><MessagesSquare size={22} className="text-dim" />{t('work.notStarted', { cwd: shortPath(tab.cwd) })}</div>}
          />
        )}
        <div className="flex-none px-5 pt-3 pb-4">
          <SubagentStrip sessionId={chat.sessionId ?? tab.sessionId} tasks={chat.tasks} className={cn('mx-auto mb-2 w-full', width)} />
          <Composer tab={tab} chat={chat} placeholder={tab.kind === 'root' ? t('root.placeholder') : t('work.messagePlaceholder', { title: tab.title })} />
        </div>
      </section>
      <SidePanel tab={tab} chat={chat} />
      <SubagentDialog />
    </div>
  );
}

/** Someone else's session: what is known about it, with no way to write into it. */
function SessionFacts({ session }: { session: SessionInfo }) {
  return (
    <dl className="flex flex-none flex-wrap items-baseline gap-x-5 gap-y-1 border-b border-line2 px-5 py-2 text-xs">
      {session.lastPrompt && (
        <div className="flex w-full min-w-0 items-baseline gap-1.5">
          <dt className="flex-none text-dim">{t('work.factPrompt')}</dt>
          <dd className="min-w-0 truncate text-soft" title={session.lastPrompt}>{session.lastPrompt}</dd>
        </div>
      )}
      <div className="flex gap-1.5"><dt className="text-dim">{t('work.factTokens')}</dt><dd className="text-soft" title={fmtInt(tokenSum(session.tokens))}>{fmtTokens(tokenSum(session.tokens))}</dd></div>
      <div className="flex gap-1.5"><dt className="text-dim">{t('work.factAgents')}</dt><dd className="text-soft">{fmtInt(session.subagents.length)}</dd></div>
      <div className="flex gap-1.5"><dt className="text-dim">{t('work.factActivity')}</dt><dd className="text-soft">{fmtAgo(session.lastActivity)}</dd></div>
      {session.pid != null && <div className="flex gap-1.5"><dt className="text-dim">pid</dt><dd className="font-mono text-soft">{session.pid}</dd></div>}
    </dl>
  );
}

function ReadonlyTab({ tab }: { tab: Tab }) {
  const sessions = useApi<SessionInfo[]>('/api/sessions', ['sessions']);
  const session = sessions.data?.find((s) => s.id === tab.sessionId);
  const transcript = useApi<ChatEvent[]>(tab.sessionId ? `/api/sessions/${encodeURIComponent(tab.sessionId)}/transcript` : null, ['sessions']);
  const chat = useMemo(() => (transcript.data ? applyEvents(emptyChat(), transcript.data) : null), [transcript.data]);
  const width = useChatWidthClass();
  const actions = useActions();
  const terminal = findTerminalAction(actions.data);
  const status = session?.status ?? tab.status;
  const ended = !isLive(status);

  const continueHere = async () => {
    const next = await createTab({ resumeSessionId: tab.sessionId ?? undefined, project: tab.project ?? undefined, cwd: tab.cwd });
    if (next) await closeTab(tab, false); // moved, not closed: nothing to bring back
    useApp.getState().go(next ? { kind: 'tab', id: next.id } : { kind: 'tab', id: tab.id });
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto app:grid app:grid-cols-[minmax(0,1fr)_320px] app:overflow-hidden">
      <section className="flex h-[70vh] min-w-0 flex-col border-b border-line2 app:h-auto app:min-h-0 app:border-r app:border-b-0">
        <div className="work-bar">
          <strong className="max-w-56 min-w-0 flex-none truncate text-[13px] font-medium" title={tab.title}>{tab.title}</strong>
          <StatusPill status={status} />
          <span className="flex flex-none items-center gap-1 rounded-full bg-raised px-2 py-0.5 text-[11px] whitespace-nowrap text-muted"><Eye size={11} />{t('work.readOnly')}</span>
          <span className="min-w-0 flex-1 basis-0 truncate font-mono text-[11px] text-dim" title={tab.cwd}>{shortPath(tab.cwd)}</span>
          {ended && tab.sessionId && (
            <Button variant="primary" className="flex-none" onClick={continueHere}>
              <Play size={12} />
              {t('work.continueHere')}
            </Button>
          )}
          <PopoutButton tab={tab} />
          <Button variant={ended && tab.sessionId ? 'outline' : 'primary'} className="flex-none" onClick={() => void createTab({ project: tab.project ?? undefined, cwd: tab.cwd })}>
            <Plus size={12} />
            {t('work.newSessionHere')}
          </Button>
          {terminal && <ActionButton action={terminal} tab={tab} label={t('composer.openTerminal')} />}
        </div>
        <p className="flex-none border-b border-line2 px-5 py-1.5 text-xs text-dim">
          {ended
            ? t('work.endedHint')
            : t('work.liveHint')}
        </p>
        {session && <SessionFacts session={session} />}
        {!tab.sessionId ? (
          <div className="p-5 text-dim">{t('work.noSession')}</div>
        ) : transcript.error && !transcript.data ? (
          <div className="p-5">
            <ErrorState message={t('work.transcriptFailed', { error: transcript.error })} onRetry={transcript.refetch} />
          </div>
        ) : !chat ? (
          <div className={cn('mx-auto w-full px-5 py-6', width)}>
            <Skeleton lines={6} />
          </div>
        ) : (
          <Transcript chat={chat} tabId={null} filesTab={tab.id} sessionId={tab.sessionId} scrollKey={tab.id} readOnly empty={<div className="flex flex-col items-center gap-2.5 py-20 text-center text-muted"><MessagesSquare size={22} className="text-dim" />{t('work.emptyTranscript')}</div>} />
        )}
        <SubagentStrip sessionId={ended ? null : tab.sessionId} className={cn('mx-auto mb-3 w-[calc(100%-40px)] flex-none', width)} />
      </section>
      <SidePanel tab={tab} chat={chat ?? emptyChat()} />
      <SubagentDialog />
    </div>
  );
}

export function WorkView({ activeId }: { activeId: string | null }) {
  const tabs = useApi<Tab[]>('/api/tabs', ['tabs']);
  if (!activeId) return null;
  const tab = tabs.data?.find((t) => t.id === activeId);
  if (!tab) {
    if (tabs.data) return <div className="p-6 text-dim">{t('work.tabGone')}</div>;
    if (tabs.error) return <div className="p-6"><ErrorState message={tabs.error} onRetry={tabs.refetch} /></div>;
    return <Skeleton className="p-6" lines={6} />;
  }
  if (tab.kind === 'document') return <Suspense fallback={<Skeleton className="p-6" lines={8} />}><DocumentTab key={tab.id} tab={tab} /></Suspense>;
  return tab.kind === 'readonly' ? <ReadonlyTab key={tab.id} tab={tab} /> : <LiveTab key={tab.id} tab={tab} tabs={tabs.data ?? []} />;
}
