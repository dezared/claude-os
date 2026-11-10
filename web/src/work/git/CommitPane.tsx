import * as Popover from '@radix-ui/react-popover';
import { Code2, Ellipsis, EyeOff, FileDiff, GitCommitHorizontal, Undo2, Upload } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Empty } from '@/components/states';
import { Button, Checkbox, Textarea } from '@/components/ui';
import { api } from '@/lib/api';
import { cn, fmtInt } from '@/lib/format';
import { t } from '@/lib/i18n';
import { toastError } from '@/lib/store';
import type { GitAmendInfo, GitStatus, Tab } from '@/lib/types';
import type { AskRequest, GitOp } from './Dialogs';
import { FileName } from './DiffPane';
import { groupState, unstagePaths, type FileRow, type RowState } from './rows';

type Repo = Extract<GitStatus, { isRepo: true }>;

/** Shows the click at once; the next status, whatever it says, replaces it. */
function TriState({ state, stamp, label, disabled, onChange }: { state: RowState; stamp: unknown; label: string; disabled: boolean; onChange: () => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<RowState | null>(null);
  useEffect(() => setPending(null), [state, stamp]);
  const shown = pending ?? state;
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = shown === 'partial';
  }, [shown]);
  return <input ref={ref} type="checkbox" aria-label={label} title={label} className="size-3.5 flex-none accent-accent" disabled={disabled} checked={shown === 'on'} onChange={() => { setPending(state === 'on' ? 'off' : 'on'); onChange(); }} />;
}

function MenuLine({ icon, children, onClick, danger }: { icon: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button type="button" onClick={onClick} className={cn('press flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs hover:bg-raised', danger ? 'text-rose-300' : 'text-soft hover:text-fg')}>
      <span className="flex-none text-dim">{icon}</span>{children}
    </button>
  );
}

function Row({ row, stamp, active, busy, menuOpen, setMenu, onOpen, onToggle, children }: {
  row: FileRow; stamp: unknown; active: boolean; busy: boolean; menuOpen: boolean; setMenu: (open: boolean) => void; onOpen: () => void; onToggle: () => void; children: ReactNode;
}) {
  const on = row.state === 'on';
  return (
    <div className={cn('group flex items-center gap-1.5 rounded-md pl-1.5', active ? 'bg-white/[.1]' : 'hover:bg-raised')} onContextMenu={(e) => { e.preventDefault(); setMenu(true); }}>
      <TriState state={row.state} stamp={stamp} disabled={busy} label={`${on ? t('git.unstage') : t('git.stage')}: ${row.path}`} onChange={onToggle} />
      <button type="button" onClick={onOpen} title={row.oldPath ? `${row.oldPath} → ${row.path}` : row.path} className="press flex min-w-0 flex-1 items-baseline gap-1.5 py-0.5 text-left font-mono text-[11.5px]">
        <FileName f={row} />
      </button>
      <Popover.Root open={menuOpen} onOpenChange={setMenu}>
        <Popover.Trigger asChild>
          <button type="button" aria-label={t('git.fileMenu', { path: row.path })} title={t('git.fileMenuShort')} className={cn('press inline-flex size-5.5 flex-none items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg focus-visible:opacity-100 group-hover:opacity-100', menuOpen ? 'opacity-100' : 'opacity-0')}>
            <Ellipsis size={13} />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content align="end" sideOffset={4} aria-label={t('git.fileMenuShort')} className="enter-pop popover z-50 w-56 rounded-xl p-1 outline-none">
            {children}
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}

export function CommitPane({ repo, tab, base, rows, selected, busy, run, ask, onOpen, onPush }: {
  repo: Repo; tab: Tab; base: string; rows: { changes: FileRow[]; untracked: FileRow[] }; selected: string | null; busy: boolean;
  run: (op: GitOp) => Promise<boolean>; ask: (r: AskRequest) => Promise<boolean>; onOpen: (path: string | null) => void; onPush: () => void;
}) {
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState<GitAmendInfo | null>(null);
  const [draft, setDraft] = useState('');
  const [menu, setMenu] = useState<string | null>(null);

  const stage = (paths: string[]) => run({ path: 'stage', body: { paths }, action: `git add -- ${paths.join(' ')}`, permission: t('git.permStage', { n: paths.length }), quiet: true });
  const unstage = (paths: string[]) => run({ path: 'unstage', body: { paths }, action: `git restore --staged -- ${paths.join(' ')}`, permission: t('git.permUnstage', { n: paths.length }), quiet: true });
  const toggle = (list: FileRow[], state: RowState) => (state === 'on' ? unstage(unstagePaths(list)) : stage(list.map((r) => r.path)));

  const toggleAmend = async (on: boolean) => {
    if (!on) {
      setAmend(null);
      setMessage(draft);
      return;
    }
    try {
      const info = await api<GitAmendInfo>(`${base}/amend`);
      setDraft(message);
      setMessage(info.message);
      setAmend(info);
    } catch (e) {
      toastError(e);
    }
  };

  const commit = async (thenPush: boolean) => {
    const msg = message.trim();
    if (amend?.pushed && !await ask({ title: t('git.amendTitle'), body: t('git.amendPushed'), action: t('git.amendAction') })) return;
    const ok = await run(amend
      ? { path: 'commit', body: { message: msg, amend: true, pushedConfirmed: amend.pushed }, action: `git commit --amend -m "${msg}"`, permission: t('git.permAmend'), quiet: true }
      : { path: 'commit', body: { message: msg }, action: `git commit -m "${msg}"`, permission: t('git.permCommit'), quiet: true });
    if (!ok) return;
    setMessage('');
    setDraft('');
    setAmend(null);
    if (thenPush) onPush();
  };

  const rollback = async (row: FileRow) => {
    const isNew = row.status === 'A' || row.status === 'R' || row.status === 'C';
    const yes = await ask({ title: t('git.rollbackTitle'), body: t(isNew ? 'git.rollbackNew' : 'git.rollbackBody', { path: row.path }), action: t('git.rollbackAction') });
    if (yes) await run({ path: 'rollback', body: { path: row.path }, action: `git restore --source=HEAD --staged --worktree -- ${row.path}`, permission: t('git.permRollback', { path: row.path }), quiet: true });
  };
  const openIde = async (row: FileRow) => {
    try {
      await api('/api/ides/open', { method: 'POST', body: { project: tab.project ?? undefined, file: `${repo.root}/${row.path}` } });
    } catch (e) {
      toastError(e);
    }
  };

  const group = (title: string, list: FileRow[], untracked: boolean) => {
    if (list.length === 0) return null;
    const state = groupState(list);
    return (
      <section className="mb-2">
        <div className="mb-0.5 flex items-center gap-1.5 pl-1.5 text-[11px] text-dim">
          <TriState state={state} stamp={repo} disabled={busy} label={`${state === 'on' ? t('git.unstageAll') : t('git.stageAll')}: ${title}`} onChange={() => void toggle(list, state)} />
          <span>{title} <b className="font-medium text-muted">{fmtInt(list.length)}</b></span>
        </div>
        {list.map((row) => {
          const gone = row.status === 'D';
          const pick = (then: () => void) => () => { setMenu(null); then(); };
          return (
            <Row key={row.path} row={row} stamp={repo} active={selected === row.path} busy={busy} menuOpen={menu === row.path} setMenu={(o) => setMenu(o ? row.path : null)} onOpen={() => onOpen(row.path)} onToggle={() => void toggle([row], row.state)}>
              <MenuLine icon={<FileDiff size={12} />} onClick={pick(() => onOpen(row.path))}>{t('git.showDiff')}</MenuLine>
              {!gone && <MenuLine icon={<Code2 size={12} />} onClick={pick(() => void openIde(row))}>{t('git.openIde')}</MenuLine>}
              {untracked
                ? <MenuLine icon={<EyeOff size={12} />} onClick={pick(() => void run({ path: 'ignore', body: { path: row.path }, action: `.gitignore + ${row.path}`, permission: t('git.permIgnore', { path: row.path }), quiet: true }))}>{t('git.addIgnore')}</MenuLine>
                : <MenuLine danger icon={<Undo2 size={12} />} onClick={pick(() => void rollback(row))}>{t('git.rollback')}</MenuLine>}
            </Row>
          );
        })}
      </section>
    );
  };

  const canCommit = !busy && !!message.trim() && (!!amend || repo.staged.length > 0);
  return (
    <div className="flex min-h-0 flex-col border-r border-line2">
      <div className="min-h-0 flex-1 overflow-auto p-2">
        {repo.truncated && <p className="mb-2 text-[11px] text-accent">{t('git.listTruncated')}</p>}
        {group(t('git.changes'), rows.changes, false)}
        {group(t('git.untracked'), rows.untracked, true)}
        {rows.changes.length + rows.untracked.length === 0 && <Empty className="mb-2.5">{t('git.clean')}</Empty>}
      </div>
      <div className="flex-none border-t border-line2 p-2.5">
        <Textarea aria-label={t('git.message')} rows={3} placeholder={t('git.messagePlaceholder')} value={message} onChange={(e) => setMessage(e.target.value)} className="mb-1.5 text-xs" spellCheck={false} />
        <div className="mb-2 text-xs">
          <Checkbox checked={!!amend} onChange={(v) => void toggleAmend(v)}>{t('git.amend')}</Checkbox>
          {amend?.pushed && <p className="mt-1 text-[11px] leading-[1.4] text-accent">{t('git.amendPushed')}</p>}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="primary" className="flex-1" disabled={!canCommit} onClick={() => void commit(false)}>
            <GitCommitHorizontal size={13} />{t('git.commit', { n: repo.staged.length })}
          </Button>
          <Button disabled={!canCommit} onClick={() => void commit(true)}><Upload size={12} />{t('git.commitPush')}</Button>
        </div>
      </div>
    </div>
  );
}
