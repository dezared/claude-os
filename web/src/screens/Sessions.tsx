import { Bot, ChevronRight, CircleCheck, CircleStop, Ellipsis, ExternalLink, Hourglass, History, List, Moon, Orbit, Radio, SquareTerminal, Trash2, TriangleAlert, Wrench, Zap, type LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useContextMenu } from '@/components/ContextMenu';
import { SubagentStrip } from '@/work/SubagentStrip';
import { SubagentDialog } from '@/work/SubagentView';
import { ProjectIcon } from '@/components/ProjectIcon';
import { ProjectSelect } from '@/components/ProjectSelect';
import { Boundary, Empty, Skeleton } from '@/components/states';
import { Button, Dialog, IconButton, Segmented } from '@/components/ui';
import { ActionMenu, type MenuItem } from '@/home/ActionMenu';
import { fmtSize } from '@/home/RemoveProjectDialog';
import { api, useApi } from '@/lib/api';
import { cn, fmtAgo, fmtInt, fmtTokens, isLive, shortPath, statusLabel, tokenSum } from '@/lib/format';
import { t, tn } from '@/lib/i18n';
import { askClaude } from '@/lib/microtask';
import { useProjectColors } from '@/lib/projectColors';
import { toast, toastError, useApp } from '@/lib/store';
import { detachTab } from '@/lib/ws';
import { AskClaude, Bar } from './admin/parts';
import { sessionStripe, SessionTags } from './SessionTags';
import { openSession } from '@/lib/tabs';
import type { AppStatus, Project, SessionInfo, SessionRemovalPreview, SessionRemovalResult, SessionStatus, Tab } from '@/lib/types';

const PAGE = 150;
const AGENTS_POLL_MS = 10_000;

const STATUS: Record<SessionStatus, { icon: LucideIcon; tone: string }> = {
  working: { icon: Zap, tone: 'text-accent' },
  idle: { icon: Moon, tone: 'text-ok' },
  waiting_permission: { icon: Hourglass, tone: 'text-warn' },
  blocked: { icon: Hourglass, tone: 'text-bad' },
  ended: { icon: CircleCheck, tone: 'text-dim' },
};

function Status({ status }: { status: SessionStatus }) {
  const { icon: Icon, tone } = STATUS[status];
  return <span className={cn('flex min-w-0 items-center gap-1.5 text-xs', tone)}><Icon size={12} className={cn('flex-none', status === 'working' && 'dot-working')} /><span className="truncate">{statusLabel(status)}</span></span>;
}

const titleOf = (s: SessionInfo) => s.title ?? s.name ?? s.lastPrompt ?? s.id;

/** The tab that can answer first: a read-only one only shows the session. */
const tabOf = (s: SessionInfo, tabs: Tab[]) => {
  const own = tabs.filter((t) => t.sessionId === s.id);
  return own.find((t) => t.kind !== 'readonly') ?? own[0];
};

const needsAnswer = (s: SessionInfo, tabs: Tab[]) => s.status === 'waiting_permission' || s.status === 'blocked' || !!tabOf(s, tabs)?.attention;

function wherePlace(tab: Tab | undefined) {
  if (tab?.kind === 'root') return t('sessions.whereHome');
  return tab && tab.kind !== 'readonly' ? t('sessions.whereTab', { title: tab.title }) : t('sessions.whereOutside');
}

function askToFix(s: SessionInfo) {
  const name = titleOf(s);
  const context = [
    `Session id: ${s.id}`,
    `Working directory: ${s.cwd}`,
    `Status: ${s.status}`,
    s.pid !== null && `Process id: ${s.pid}`,
    `Started from: ${s.origin === 'os' ? 'Claude OS' : 'a terminal'}`,
    s.lastActivity !== null && `Last activity: ${new Date(s.lastActivity).toISOString()}`,
  ].filter(Boolean).join('\n');
  askClaude({ subject: { kind: 'session', name, context, project: s.project }, title: t('sessions.fixTitle', { name }), presets: [t('sessions.fixStuck'), t('sessions.fixWhy')] });
}

function sessionItems(s: SessionInfo, tabs: Tab[], actions: { onStop: () => void; onDelete: () => void }): MenuItem[] {
  const live = isLive(s.status);
  const root = tabOf(s, tabs)?.kind === 'root';
  return [
    { id: 'session.open', label: t('sessions.openRecord'), icon: ExternalLink, onSelect: () => void openSession(s) },
    { id: 'session.stop', label: t('sessions.stop'), icon: CircleStop, disabled: !live, title: live ? undefined : t('sessions.alreadyEnded'), onSelect: actions.onStop },
    ...(live ? [{ id: 'session.fix', label: t('sessions.fix'), icon: Wrench, onSelect: () => askToFix(s) }] : []),
    { id: 'session.delete', label: t('sessions.delete'), icon: Trash2, danger: true, apart: true, disabled: live || root, title: live ? t('sessions.deleteStopFirst') : root ? t('sessions.deleteRootHint') : undefined, onSelect: actions.onDelete },
  ];
}

function StopDialog({ s, onClose }: { s: SessionInfo; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const stop = async () => {
    setBusy(true);
    try {
      await api(`/api/sessions/${encodeURIComponent(s.id)}/stop`, { method: 'POST' });
      toast(t('project.stopped'));
      onClose();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('project.stopTitle')}>
      <p className="mb-3 text-[13px] wrap-anywhere text-soft">{t('project.stopBody', { title: titleOf(s) })}</p>
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button variant="danger" disabled={busy} onClick={stop}><CircleStop size={13} /> {t('project.stopAction')}</Button>
      </div>
    </Dialog>
  );
}

function DeleteDialog({ s, tabs, onClose }: { s: SessionInfo; tabs: Tab[]; onClose: () => void }) {
  const preview = useApi<SessionRemovalPreview>(`/api/sessions/${encodeURIComponent(s.id)}/removal`);
  const [busy, setBusy] = useState(false);
  const remove = async () => {
    setBusy(true);
    try {
      await api<SessionRemovalResult>(`/api/sessions/${encodeURIComponent(s.id)}/remove`, { method: 'POST', body: { confirm: s.id } });
      // The server has closed them: the client lets go of what it held.
      for (const tab of tabs.filter((x) => x.sessionId === s.id)) {
        detachTab(tab.id);
        useApp.getState().forgetTab(tab.id);
      }
      toast(t('sessions.deleted'));
      onClose();
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('sessions.deleteTitle')} width={620}>
      <Boundary query={preview} skeleton={<Skeleton lines={4} />}>
        {(p) => (
          <div className="flex flex-col gap-3 text-[13px]">
            <div className="flex items-start gap-2 rounded-lg border border-[#c2410c]/60 bg-[#c2410c]/10 p-3 text-soft">
              <TriangleAlert size={15} className="mt-0.5 flex-none text-[#f97316]" />
              <p className="wrap-anywhere">{t('sessions.deleteLead', { title: titleOf(s) })}</p>
            </div>
            {p.items.length === 0 ? (
              <p className="text-muted">{t('sessions.deleteNothing')}</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {p.items.map((i) => (
                  <li key={i.path} className="rounded-lg bg-white/[.035] px-3 py-2">
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-soft">{t(i.kind === 'journal' ? 'sessions.deleteKind.journal' : 'sessions.deleteKind.attachments')}</span>
                      <span className="flex-none text-xs text-muted">{t('remove.files', { n: fmtInt(i.files) })} · {fmtSize(i.bytes)}</span>
                    </div>
                    <div className="selectable mt-0.5 font-mono text-[11.5px] wrap-anywhere text-dim">{i.path}</div>
                  </li>
                ))}
              </ul>
            )}
            <ul className="flex flex-col gap-1 text-xs text-muted">
              {p.tabs > 0 && <li>{t('sessions.deleteTabs', { n: fmtInt(p.tabs) })}</li>}
              <li>{t('sessions.deleteUsage')}</li>
              <li className="wrap-anywhere">{t('sessions.deleteTrash', { path: p.trash })}</li>
            </ul>
            {(p.live || p.root) && <p role="alert" className="text-[#f97316]">{t(p.root ? 'sessions.deleteRoot' : 'sessions.deleteLive')}</p>}
            <div className="flex justify-end gap-2">
              <Button onClick={onClose}>{t('common.cancel')}</Button>
              <Button variant="danger" disabled={busy || p.live || p.root} onClick={remove}><Trash2 size={13} /> {t('sessions.delete')}</Button>
            </div>
          </div>
        )}
      </Boundary>
    </Dialog>
  );
}

function RowMenu({ title, items }: { title: string; items: MenuItem[] }) {
  const [open, setOpen] = useState(false);
  const label = t('sessions.rowMenu', { title });
  return (
    <ActionMenu
      label={label}
      items={items}
      open={open}
      onOpenChange={setOpen}
      side="bottom"
      align="end"
      trigger={<IconButton label={label} className="mr-3 size-7 flex-none"><Ellipsis size={14} /></IconButton>}
    />
  );
}

function Row({ s, projects, repo, tabs, color, maxTokens, where, agentsNow, actions }: { s: SessionInfo; projects: Project[]; repo: string | null; tabs: Tab[]; color: (key: string | null) => string; maxTokens: number; where: boolean; agentsNow: number; actions: { onStop: () => void; onDelete: () => void } }) {
  const [open, setOpen] = useState(false);
  const [watching, setWatching] = useState(false);
  const title = titleOf(s);
  const projectName = projects.find((p) => p.key === s.project)?.name ?? s.project ?? (s.serviceFolder ? 'Claude OS' : shortPath(s.cwd));
  const repoProject = projects.find((p) => p.root === repo)?.key ?? null;
  const items = sessionItems(s, tabs, actions);
  const menuArea = useContextMenu(items);
  return (
    <div ref={menuArea} className={cn('border-b border-line2', sessionStripe(s, repoProject))}>
      <div className="group flex items-center transition-colors duration-100 hover:bg-white/[.045]">
        <button
          type="button"
          aria-expanded={s.subagents.length > 0 ? open : undefined}
          aria-label={open ? t('sessions.hideAgents') : t('sessions.showAgents')}
          disabled={s.subagents.length === 0}
          onClick={() => setOpen(!open)}
          className="press flex h-9 w-8 flex-none items-center justify-center text-dim enabled:hover:text-fg disabled:opacity-0"
        >
          <ChevronRight size={12} className={cn('transition-transform duration-150', open && 'rotate-90')} />
        </button>
        <button
          type="button"
          onClick={() => void openSession(s)}
          title={where ? t('sessions.goAnswer') : t('sessions.openRecord')}
          className="press grid min-w-0 flex-1 grid-cols-[minmax(0,1fr)_180px_120px_92px_84px_70px] items-center gap-3 py-2 pr-3 text-left focus-visible:-outline-offset-2"
        >
          <span className="min-w-0">
            <span className="flex min-w-0 items-center gap-1.5"><span className="min-w-0 truncate">{title}</span><SessionTags s={s} repoProject={repoProject} /></span>
            {where && <span className="mt-0.5 block text-xs text-warn">{wherePlace(tabOf(s, tabs))}</span>}
          </span>
          <span className="flex min-w-0 items-center gap-2 text-xs text-muted" title={s.cwd}>
            <ProjectIcon project={s.project} name={projectName} color={color(s.project)} size={15} dim={!isLive(s.status)} />
            <span className="truncate">{projectName}</span>
          </span>
          <Status status={s.status} />
          <span className="flex min-w-0 items-center gap-1 text-xs text-dim">
            {s.origin === 'os' ? <Orbit size={11} className="flex-none" /> : <SquareTerminal size={11} className="flex-none" />}
            <span className="truncate">{s.origin === 'os' ? t('sessions.fromOs') : t('sessions.fromTerminal')}</span>
          </span>
          <span className="text-right text-xs text-muted" title={t('sessions.tokensTitle', { n: fmtInt(s.tokens.cacheRead) })}>
            {fmtTokens(tokenSum(s.tokens))}
            <Bar className="mt-0.5" value={tokenSum(s.tokens)} max={maxTokens} color={color(s.project)} />
          </span>
          <span className="text-right text-xs text-dim">{fmtAgo(s.lastActivity)}</span>
        </button>
        <span className="flex w-11 flex-none justify-center">
          {agentsNow > 0 && (
            <button
              type="button"
              aria-expanded={watching}
              title={t('sessions.agentsNow', { n: fmtInt(agentsNow) })}
              onClick={() => setWatching(!watching)}
              className="press inline-flex items-center gap-1 rounded-full bg-accent-bg px-1.5 py-0.5 text-[11px] text-accent"
            >
              <Bot size={11} />{fmtInt(agentsNow)}
            </button>
          )}
        </span>
        <RowMenu title={title} items={items} />
      </div>
      {watching && <SubagentStrip sessionId={s.id} className="mr-[52px] mb-2 ml-8" />}
      {open && (
        <div className="enter-fade pb-2 pl-8">
          {s.subagents.map((a) => (
            <div key={a.id} className="grid grid-cols-[14px_minmax(0,1fr)_64px_70px] items-center gap-3 py-1 pr-5 text-xs">
              <Bot size={12} className="text-dim" />
              <span className="min-w-0 truncate text-muted" title={a.description ?? undefined}>
                <span className="text-soft">{a.agentType ?? t('side.agent')}</span>
                {a.description && ` · ${a.description}`}
              </span>
              <span className="text-right text-muted">{fmtTokens(a.tokens)}</span>
              <span className="text-right text-dim">{fmtAgo(a.lastActivity)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function SessionsView({ project: initialProject }: { project: string | null }) {
  const sessions = useApi<SessionInfo[]>('/api/sessions', ['sessions']);
  const projects = useApi<Project[]>('/api/projects', ['projects']);
  const tabsQuery = useApi<Tab[]>('/api/tabs', ['tabs']);
  const tabs = useMemo(() => tabsQuery.data ?? [], [tabsQuery.data]);
  const { color } = useProjectColors();
  const [project, setProject] = useState<string | null>(initialProject);
  const [scope, setScope] = useState<'live' | 'all' | 'waiting'>('all');
  const [limit, setLimit] = useState(PAGE);
  const [stopping, setStopping] = useState<SessionInfo | null>(null);
  const [deleting, setDeleting] = useState<SessionInfo | null>(null);
  const agentsNow = useApi<Record<string, number>>('/api/sessions/active-subagents', ['sessions']);
  const status = useApi<AppStatus>('/api/app/status');
  const anyAgents = Object.keys(agentsNow.data ?? {}).length > 0;
  const refetchAgents = agentsNow.refetch;
  // A subagent that goes silent writes nothing, so no topic says it stopped.
  useEffect(() => {
    if (!anyAgents) return;
    const timer = setInterval(() => {
      if (!document.hidden) refetchAgents();
    }, AGENTS_POLL_MS);
    return () => clearInterval(timer);
  }, [anyAgents, refetchAgents]);

  const list = useMemo(() => {
    const items = (sessions.data ?? []).filter((s) => (!project || s.project === project) && (scope === 'all' || (scope === 'live' ? isLive(s.status) : needsAnswer(s, tabs))));
    return items.sort((a, b) => Number(isLive(b.status)) - Number(isLive(a.status)) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  }, [sessions.data, project, scope, tabs]);

  const liveCount = sessions.data?.filter((s) => isLive(s.status)).length ?? 0;
  const waiting = sessions.data?.filter((s) => needsAnswer(s, tabs)).length ?? 0;
  const maxTokens = Math.max(1, ...list.slice(0, limit).map((s) => tokenSum(s.tokens)));
  const sortedProjects = (projects.data ?? []).slice().sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-none flex-wrap items-center gap-3 border-b border-line2 px-5 py-2.5">
        <h1 className="flex items-center gap-2 text-sm font-medium"><History size={15} className="text-dim" />{t('sessions.title')}</h1>
        {sessions.data && (
          <span className="text-xs text-dim">
            {t('sessions.count', { n: fmtInt(sessions.data.length), sessions: tn('unit.session', sessions.data.length), live: fmtInt(liveCount) })}
          </span>
        )}
        {waiting > 0 && (
          <button
            type="button"
            title={t('sessions.showWaiting')}
            onClick={() => {
              // All of them: a project filter must not hide one that needs an answer.
              setProject(null);
              setScope('waiting');
            }}
            className="press inline-flex items-center gap-1 rounded-md px-1 text-xs text-warn underline-offset-2 hover:underline"
          >
            <Hourglass size={11} />{t('adm.sessionsWaiting', { n: fmtInt(waiting) })}
          </button>
        )}
        <span className="flex-1" />
        <Segmented
          ariaLabel={t('sessions.whichAria')}
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: t('sessions.all'), icon: List },
            { value: 'live', label: t('sessions.live'), icon: Radio },
            { value: 'waiting', label: t('sessions.waiting'), icon: Hourglass },
          ]}
        />
        <ProjectSelect ariaLabel={t('sessions.filterAria')} className="w-52 text-xs" value={project} onChange={setProject} projects={sortedProjects} extra={[{ value: null, label: t('sessions.allProjects') }]} />
        <AskClaude task="admin-usage" vars={{ context: list.slice(0, 15).map((s) => `- ${s.title ?? s.name ?? s.id}: ${s.project ?? 'no project'}, ${s.status}, ${tokenSum(s.tokens)} tokens`).join('\n') }} />
      </header>
      <div className="min-h-0 flex-1 overflow-auto">
        <Boundary
          query={sessions}
          skeleton={<Skeleton className="p-5" lines={10} />}
          empty={(d) =>
            d.length === 0 ? (
              <div className="p-5">
                <Empty icon={History}>{t('sessions.none')}</Empty>
              </div>
            ) : list.length === 0 ? (
              <div className="p-5">
                <Empty icon={Radio}>{t(scope === 'waiting' && !project ? 'sessions.noneWaiting' : 'sessions.noneFiltered')}</Empty>
              </div>
            ) : null
          }
        >
          {() => (
            <div className="min-w-[860px]">
              <div className="sheet-bar sticky top-0 z-10 grid grid-cols-[minmax(0,1fr)_180px_120px_92px_84px_70px] gap-3 border-b border-line2 py-1.5 pr-[96px] pl-8 text-[11px] text-dim">
                <span>{t('sessions.colSession')}</span>
                <span>{t('sessions.colProject')}</span>
                <span>{t('sessions.colStatus')}</span>
                <span>{t('sessions.colOrigin')}</span>
                <span className="text-right">{t('sessions.colTokens')}</span>
                <span className="text-right">{t('sessions.colActivity')}</span>
              </div>
              {list.slice(0, limit).map((s) => (
                <Row key={s.id} s={s} projects={projects.data ?? []} repo={status.data?.repo ?? null} tabs={tabs} color={color} maxTokens={maxTokens} where={scope === 'waiting'} agentsNow={agentsNow.data?.[s.id] ?? 0} actions={{ onStop: () => setStopping(s), onDelete: () => setDeleting(s) }} />
              ))}
              {list.length > limit && (
                <div className="p-3 text-center">
                  <Button onClick={() => setLimit((l) => l + PAGE)}>{t('sessions.more', { n: fmtInt(list.length - limit) })}</Button>
                </div>
              )}
            </div>
          )}
        </Boundary>
      </div>
      {stopping && <StopDialog s={stopping} onClose={() => setStopping(null)} />}
      {deleting && <DeleteDialog s={deleting} tabs={tabs} onClose={() => setDeleting(null)} />}
      <SubagentDialog />
    </div>
  );
}
