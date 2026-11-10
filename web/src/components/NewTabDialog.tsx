import { useEffect, useState } from 'react';
import { api, useApi } from '@/lib/api';
import { cn, fmtAgo } from '@/lib/format';
import { t } from '@/lib/i18n';
import { efforts, modelGroups } from '@/lib/models';
import { toastError, useApp } from '@/lib/store';
import { createTab, openSession } from '@/lib/tabs';
import type { Project, SessionInfo, Tab } from '@/lib/types';
import { ProjectSelect } from './ProjectSelect';
import { Empty, ErrorState } from './states';
import { StatusDot } from './StatusDot';
import { Button, Checkbox, Dialog, Field, Input, Select, Textarea } from './ui';

const RECENT = 10;
const sessionTitle = (s: SessionInfo) => s.title ?? s.name ?? s.lastPrompt ?? s.id;

/** Claude decides where it goes: an existing project, a new one or a past session. The answer comes to a service card.
 *  The server fills the quick-start template: only that job gets the tools to resume a session and create a project. */
function QuickStart({ onDone }: { onDone: () => void }) {
  const [request, setRequest] = useState('');
  const [busy, setBusy] = useState(false);
  const start = async () => {
    const text = request.trim();
    if (!text || busy) return;
    setBusy(true);
    try {
      await api('/api/service/tasks', { method: 'POST', body: { title: text.slice(0, 80), microtask: 'quick-start', vars: { request: text }, source: 'microtask', sourceDetail: 'quick-start' } });
      onDone();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="flex flex-col gap-2">
      <Field label={t('newTab.quick')} hint={t('newTab.quickHint')}>
        <Textarea
          rows={2}
          autoFocus
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void start();
            }
          }}
        />
      </Field>
      <div className="flex justify-end">
        <Button variant="primary" disabled={!request.trim() || busy} onClick={() => void start()}>
          {t('newTab.quickStart')}
        </Button>
      </div>
    </div>
  );
}

// Running in a terminal: attaching would make a second writer. One of our tabs holding it just gets focus.
const liveElsewhere = (s: SessionInfo, tabs: Tab[]) => s.status !== 'ended' && !tabs.some((x) => x.sessionId === s.id && x.kind !== 'readonly');

function RecentRow({ s, busyElsewhere, where, onPick }: { s: SessionInfo; busyElsewhere: boolean; where: string; onPick: () => void }) {
  return (
    <li>
      <button
        type="button"
        disabled={busyElsewhere}
        title={busyElsewhere ? t('newTab.liveElsewhere') : sessionTitle(s)}
        onClick={onPick}
        className={cn('press flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left', busyElsewhere ? 'opacity-50' : 'hover:bg-white/[.06]')}
      >
        <StatusDot status={s.status} className="flex-none" />
        <span className="min-w-0 flex-1 truncate text-[13px] text-soft">{sessionTitle(s)}</span>
        <span className="max-w-40 flex-none truncate text-[11px] text-dim">{busyElsewhere ? t('newTab.liveShort') : `${where} · ${fmtAgo(s.lastActivity)}`}</span>
      </button>
    </li>
  );
}

/** The latest sessions on the machine, no service ones, narrowed by a search; a click resumes or focuses one. */
function RecentSessions({ projects, onPick }: { projects: Project[]; onPick: () => void }) {
  const sessions = useApi<SessionInfo[]>('/api/sessions', ['sessions']);
  const tabs = useApi<Tab[]>('/api/tabs', ['tabs']).data ?? [];
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const recent = (sessions.data ?? [])
    .filter((s) => !s.serviceFolder && (!needle || [s.title, s.name, s.lastPrompt, s.cwd].some((x) => x?.toLowerCase().includes(needle))))
    .sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0))
    .slice(0, RECENT);
  return (
    <section aria-label={t('newTab.recent')} className="flex flex-col gap-1.5 border-t border-line2 pt-3">
      <div className="flex items-center gap-2">
        <span className="flex-none text-xs text-muted">{t('newTab.recent')}</span>
        <Input className="h-7 py-1 text-[12.5px]" type="search" aria-label={t('newTab.recentSearch')} placeholder={t('newTab.recentSearch')} value={query} onChange={(e) => setQuery(e.target.value)} />
      </div>
      {sessions.error && !sessions.data ? (
        <ErrorState message={sessions.error} onRetry={sessions.refetch} />
      ) : sessions.data && recent.length === 0 ? (
        <div className="px-1 py-1 text-xs text-dim">{t('newTab.recentNone')}</div>
      ) : (
        <ul className="-mx-1 flex max-h-60 flex-col overflow-y-auto">
          {recent.map((s) => (
            <RecentRow
              key={s.id}
              s={s}
              busyElsewhere={liveElsewhere(s, tabs)}
              where={projects.find((p) => p.key === s.project)?.name ?? s.cwd.split('/').pop() ?? ''}
              onPick={() => {
                onPick();
                void openSession(s);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

export function NewTabDialog() {
  const open = useApp((s) => s.newTabOpen);
  const preset = useApp((s) => s.newTabProject);
  const close = useApp((s) => s.closeNewTab);
  const projects = useApi<Project[]>('/api/projects', ['projects']);
  const models = useApi<{ id: string; label: string }[]>('/api/models');

  const [project, setProject] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [worktree, setWorktree] = useState(false);
  const [model, setModel] = useState<string | null>(null);
  const [effort, setEffort] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setProject(preset);
      setTitle('');
      setWorktree(false);
    }
  }, [open, preset]);

  const list = (projects.data ?? []).slice().sort((a, b) => Number(a.misc) - Number(b.misc) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0));
  // A plain folder is never the default: a session there belongs to no project.
  const selected = project ?? list.find((p) => !p.folder)?.key ?? null;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected) return;
    setBusy(true);
    const tab = await createTab({
      project: selected,
      title: title.trim() || undefined,
      worktree: worktree || undefined,
      model: model ?? undefined,
      effort: effort ?? undefined,
    });
    setBusy(false);
    if (tab) close();
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()} title={t('nav.newTab')} description={t('newTab.description')}>
      <div className="flex flex-col gap-3">
        <QuickStart onDone={close} />
        {projects.error && !projects.data ? (
          <ErrorState message={projects.error} onRetry={projects.refetch} />
        ) : projects.data && list.length === 0 ? (
          <Empty>{t('newTab.noProjects')}</Empty>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3 border-t border-line2 pt-3">
            <Field label={t('newTab.project')}>
              <ProjectSelect
                className="w-full"
                ariaLabel={t('newTab.project')}
                value={selected}
                onChange={setProject}
                disabled={!projects.data}
                projects={list}
                label={(p) => (p.misc ? t('newTab.misc', { name: p.name }) : p.name)}
              />
            </Field>
            <Field label={t('newTab.title')} hint={t('newTab.titleHint')}>
              <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder={list.find((p) => p.key === selected)?.name ?? ''} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t('newTab.model')}>
                <Select
                  className="w-full"
                  ariaLabel={t('newTab.model')}
                  value={model}
                  onChange={setModel}
                  options={[{ value: null, label: t('newTab.fromSettings') }]}
                  groups={modelGroups(models.data ?? [])}
                />
              </Field>
              <Field label={t('newTab.effort')}>
                <Select className="w-full" ariaLabel={t('newTab.effort')} value={effort} onChange={setEffort} options={efforts()} />
              </Field>
            </div>
            <Checkbox checked={worktree} onChange={setWorktree}>
              {t('newTab.worktree')}
            </Checkbox>
            <div className="mt-1 flex justify-end gap-2">
              <Button onClick={close}>{t('common.cancel')}</Button>
              <Button type="submit" variant="primary" disabled={!selected || busy}>
                {t('newTab.open')}
              </Button>
            </div>
          </form>
        )}
        <RecentSessions projects={list} onPick={close} />
      </div>
    </Dialog>
  );
}
