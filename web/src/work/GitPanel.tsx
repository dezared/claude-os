import { ArrowDown, ArrowDownToLine, ArrowUp, CloudDownload, GitBranch, History, ListChecks, TriangleAlert, GitCompare as CompareIcon, Upload, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Empty, ErrorState, Skeleton, Spinner } from '@/components/states';
import { Button, IconButton, Segmented } from '@/components/ui';
import { api, useApi } from '@/lib/api';
import { cn, fmtAgo, shortPath } from '@/lib/format';
import { t } from '@/lib/i18n';
import { runMicrotask } from '@/lib/microtask';
import { toast } from '@/lib/store';
import type { GitBranch as Branch, GitStatus, Tab } from '@/lib/types';
import { BranchPopup, type BranchActions } from './git/BranchPopup';
import { CommitPane } from './git/CommitPane';
import { ComparePane } from './git/ComparePane';
import { BranchNameDialog, ConfirmDialog, FailureStrip, PushDialog, type AskRequest, type GitFailure, type GitOp } from './git/Dialogs';
import { DiffPane } from './git/DiffPane';
import { LogPane } from './git/LogPane';
import { changeRows } from './git/rows';

const DIRTY_REFUSAL = /would be overwritten|commit your changes or stash/i;
type View = 'commit' | 'log' | 'compare';
type NameForm = { kind: 'create'; from: Branch | null } | { kind: 'rename'; branch: Branch };

/** Opened from the work bar. Status is never asked for: it runs on opening, on the turn's end, on window focus and after every action. */
export function GitPanel({ tab, turnKey, onClose }: { tab: Tab; turnKey: unknown; onClose: () => void }) {
  const base = `/api/tabs/${encodeURIComponent(tab.id)}/git`;
  const q = useApi<GitStatus>(base);
  const [view, setView] = useState<View>('commit');
  const [compare, setCompare] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [pushing, setPushing] = useState(false);
  const [failure, setFailure] = useState<GitFailure | null>(null);
  const [nameForm, setNameForm] = useState<NameForm | null>(null);
  const [asking, setAsking] = useState<AskRequest | null>(null);
  const answer = useRef<((yes: boolean) => void) | null>(null);
  const [rev, setRev] = useState(0);
  const { refetch } = q;

  const refresh = useCallback(() => {
    refetch();
    setRev((r) => r + 1);
  }, [refetch]);

  useEffect(() => { refresh(); }, [turnKey, refresh]);
  useEffect(() => {
    window.addEventListener('focus', refresh);
    return () => window.removeEventListener('focus', refresh);
  }, [refresh]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('[role="dialog"]')) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const ask = useCallback((r: AskRequest) => new Promise<boolean>((resolve) => {
    answer.current = resolve;
    setAsking(r);
  }), []);
  const onAnswer = (yes: boolean) => {
    setAsking(null);
    answer.current?.(yes);
    answer.current = null;
  };

  const run = useCallback(async (op: GitOp) => {
    setBusy(op.path);
    setFailure(null);
    try {
      const res = await api<{ output?: string }>(`${base}/${op.path}`, { method: 'POST', body: op.body ?? {} });
      if (!op.quiet) {
        const line = res.output?.split('\n').filter(Boolean).at(-1);
        if (line) toast(line);
      }
      return true;
    } catch (e) {
      const error = (e as Error).message;
      setFailure({ action: op.action, permission: op.permission, error, retry: op.checkout && DIRTY_REFUSAL.test(error) ? op : undefined });
      return false;
    } finally {
      setBusy(null);
      refresh();
    }
  }, [base, refresh]);

  const stashRetry = async (f: GitFailure) => {
    if (!f.retry) return;
    const stashed = await run({ path: 'stash', body: { message: t('git.stashMessage', { action: f.action }), untracked: /untracked working tree files/i.test(f.error) }, action: 'git stash push', permission: t('git.permStash'), quiet: true });
    if (stashed) await run(f.retry);
  };

  const s = q.data;
  const repo = s?.isRepo ? s : null;
  const rows = useMemo(() => (repo ? changeRows(repo) : { changes: [], untracked: [] }), [repo]);
  const openRow = selected ? rows.changes.concat(rows.untracked).find((r) => r.path === selected) ?? null : null;
  const dirty = !!repo && rows.changes.length + rows.untracked.length > 0;

  const actions: BranchActions = {
    checkout: (b) => void run({ path: 'checkout', body: { branch: b.name }, action: b.kind === 'local' ? `git checkout ${b.name}` : `git checkout --track ${b.name}`, permission: t('git.permCheckout', { branch: b.name }), checkout: true, quiet: true }),
    create: (from) => setNameForm({ kind: 'create', from }),
    compare: (b) => {
      setCompare(b.name);
      setView('compare');
    },
    rename: (b) => setNameForm({ kind: 'rename', branch: b }),
    remove: async (b) => {
      if (await ask({ title: t('git.deleteTitle', { branch: b.name }), body: t('git.deleteBody'), action: t('git.deleteAction') })) {
        await run({ path: 'branch/delete', body: { branch: b.name }, action: `git branch -d ${b.name}`, permission: t('git.permDelete', { branch: b.name }), quiet: true });
      }
    },
    stash: () => void run({ path: 'stash', body: { message: t('git.stashManual') }, action: 'git stash push', permission: t('git.permStash') }),
    unstash: (x) => void run({ path: 'stash/pop', body: { ref: x.ref }, action: `git stash pop ${x.ref}`, permission: t('git.permUnstash', { ref: x.ref }) }),
  };

  const submitName = (name: string, checkout: boolean) => {
    const f = nameForm;
    setNameForm(null);
    if (f?.kind === 'rename') void run({ path: 'branch/rename', body: { from: f.branch.name, to: name }, action: `git branch -m ${f.branch.name} ${name}`, permission: t('git.permRename', { from: f.branch.name, to: name }), quiet: true });
    if (f?.kind === 'create') {
      const from = f.from?.name;
      void run({
        path: 'branch/create',
        body: { name, from, checkout },
        action: checkout ? `git checkout --no-track -b ${name}${from ? ` ${from}` : ''}` : `git branch --no-track ${name} ${from ?? 'HEAD'}`,
        permission: t('git.permBranch', { name, from: from ?? 'HEAD' }),
        checkout,
        quiet: true,
      });
    }
  };

  const fix = () => failure && runMicrotask({
    id: 'git-fix',
    project: tab.project,
    title: t('git.fixTab'),
    vars: { cwd: tab.cwd, action: failure.action, error: failure.error, permission: failure.permission },
  });

  const fileDiff = openRow ? `${base}/diff?path=${encodeURIComponent(openRow.path)}&area=${openRow.area}` : null;
  const shownView = view === 'compare' && !compare ? 'commit' : view;

  return (
    <div role="region" aria-label={t('git.title')} className="glass-solid enter-fade absolute inset-2 z-20 flex flex-col overflow-hidden rounded-2xl" data-testid="git-panel">
      <header className="flex flex-none items-center gap-2 border-b border-line2 py-1 pr-2 pl-3.5">
        <GitBranch size={14} className="flex-none text-accent" />
        {repo ? (
          <>
            <BranchPopup base={base} rev={rev} label={repo.branch ?? t('git.detached')} dirty={dirty} busy={!!busy} actions={actions} />
            {repo.upstream ? (
              <span className="flex min-w-0 items-center gap-1.5 text-xs text-dim">
                <span className="truncate font-mono">{repo.upstream}</span>
                <span className={cn('flex items-center gap-0.5', (repo.ahead ?? 0) > 0 && 'text-soft')} title={t('git.ahead')}><ArrowUp size={11} />{repo.ahead ?? 0}</span>
                <span className={cn('flex items-center gap-0.5', (repo.behind ?? 0) > 0 && 'text-accent')} title={t('git.behind')}><ArrowDown size={11} />{repo.behind ?? 0}</span>
              </span>
            ) : <span className="text-xs text-dim">{t('git.noUpstream')}</span>}
            <span className="min-w-0 flex-1 truncate text-right font-mono text-[11px] text-dim" title={repo.root}>{shortPath(repo.root)}</span>
          </>
        ) : <strong className="flex-1 text-[13px] font-medium">{t('git.title')}</strong>}
        <IconButton label={t('common.close')} onClick={onClose}><X size={14} /></IconButton>
      </header>

      {repo && (
        <div className="flex flex-none flex-wrap items-center gap-1.5 border-b border-line2 px-2.5 py-1">
          <Segmented
            ariaLabel={t('git.title')}
            value={shownView}
            onChange={setView}
            options={[
              { value: 'commit' as const, label: t('git.tabCommit'), icon: ListChecks },
              { value: 'log' as const, label: t('git.tabLog'), icon: History },
              ...(compare ? [{ value: 'compare' as const, label: t('git.tabCompare'), icon: CompareIcon }] : []),
            ]}
          />
          <span className="flex-1" />
          {q.error && <span className="flex min-w-0 items-center gap-1 truncate text-[11px] text-accent" title={q.error}><TriangleAlert size={11} className="flex-none" />{q.error}</span>}
          <span className="flex-none text-[11px] text-dim" title={repo.lastFetch ? new Date(repo.lastFetch).toLocaleString() : undefined} data-testid="git-last-fetch">
            {repo.lastFetch ? t('git.lastFetch', { ago: fmtAgo(repo.lastFetch) }) : t('git.neverFetched')}
          </span>
          <Button size="sm" title="git status" onClick={() => { setView('commit'); refresh(); }}>
            <GitBranch size={12} />{t('git.status')}
          </Button>
          <Button size="sm" disabled={!!busy} title="git fetch --all --prune" onClick={async () => { if (await run({ path: 'fetch', action: 'git fetch --all --prune', permission: t('git.permFetch'), quiet: true })) toast(t('git.fetched')); }}>
            {busy === 'fetch' ? <Spinner size={11} /> : <CloudDownload size={12} />}{t('git.fetch')}
          </Button>
          <Button size="sm" disabled={!!busy} title="git pull --ff-only" onClick={() => void run({ path: 'pull', action: 'git pull --ff-only', permission: t('git.permPull') })}>
            {busy === 'pull' ? <Spinner size={11} /> : <ArrowDownToLine size={12} />}{t('git.pull')}{(repo.behind ?? 0) > 0 ? ` ${repo.behind}` : ''}
          </Button>
          <Button size="sm" disabled={!!busy} title={t('git.pushTitle')} onClick={() => setPushing(true)}>
            <Upload size={12} />{t('git.push')}{(repo.ahead ?? 0) > 0 ? ` ${repo.ahead}` : ''}
          </Button>
        </div>
      )}

      {failure && <FailureStrip failure={failure} busy={!!busy} onFix={() => void fix()} onStashRetry={() => void stashRetry(failure)} onHide={() => setFailure(null)} />}

      {q.error && !s ? <ErrorState className="m-4" message={q.error} onRetry={refresh} /> : !s ? <Skeleton className="p-4" lines={8} /> : !repo ? (
        <Empty className="m-4" icon={GitBranch}>{s.isRepo === false && s.reason === 'git_missing' ? t('git.missing') : t('git.notRepo', { cwd: shortPath(tab.cwd) })}</Empty>
      ) : (
        <>
          <div className={cn('min-h-0 flex-1 grid-cols-[minmax(300px,380px)_minmax(0,1fr)]', shownView === 'commit' ? 'grid' : 'hidden')}>
            <CommitPane repo={repo} tab={tab} base={base} rows={rows} selected={selected} busy={!!busy} run={run} ask={ask} onOpen={setSelected} onPush={() => setPushing(true)} />
            <div className="min-h-0 min-w-0"><DiffPane url={fileDiff} file={openRow?.path ?? null} rev={rev} /></div>
          </div>
          {shownView === 'log' && <LogPane base={base} rev={rev} />}
          {shownView === 'compare' && compare && <ComparePane base={base} branch={compare} current={repo.branch ?? 'HEAD'} rev={rev} onClose={() => { setCompare(null); setView('commit'); }} />}
        </>
      )}

      {pushing && <PushDialog base={base} onClose={() => setPushing(false)} onDone={() => { setPushing(false); refresh(); }} onFail={setFailure} />}
      {asking && <ConfirmDialog ask={asking} onAnswer={onAnswer} />}
      {nameForm?.kind === 'create' && <BranchNameDialog title={t('git.newBranchTitle')} hint={t('git.newBranchFrom', { from: nameForm.from?.name ?? repo?.branch ?? 'HEAD' })} initial="" action={t('git.createAction')} withCheckout onClose={() => setNameForm(null)} onSubmit={submitName} />}
      {nameForm?.kind === 'rename' && <BranchNameDialog title={t('git.renameTitle', { branch: nameForm.branch.name })} initial={nameForm.branch.name} action={t('git.renameAction')} withCheckout={false} onClose={() => setNameForm(null)} onSubmit={submitName} />}
    </div>
  );
}
