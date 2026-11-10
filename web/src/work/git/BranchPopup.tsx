import * as Popover from '@radix-ui/react-popover';
import { ArchiveRestore, ArrowDown, ArrowUp, Check, ChevronDown, ChevronRight, GitBranchPlus, GitCompare, Archive, Pencil, Trash2, ArrowRightLeft } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ErrorState, Skeleton } from '@/components/states';
import { Input } from '@/components/ui';
import { useApi } from '@/lib/api';
import { cn, fmtAgo } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { GitBranch, GitBranches, GitStash } from '@/lib/types';

export interface BranchActions {
  checkout: (b: GitBranch) => void;
  create: (from: GitBranch | null) => void;
  compare: (b: GitBranch) => void;
  rename: (b: GitBranch) => void;
  remove: (b: GitBranch) => void;
  stash: () => void;
  unstash: (s: GitStash) => void;
}

function MenuItem({ icon, children, onClick, disabled, danger, autoFocus, title }: { icon?: ReactNode; children: ReactNode; onClick?: () => void; disabled?: boolean; danger?: boolean; autoFocus?: boolean; title?: string }) {
  return (
    <button type="button" autoFocus={autoFocus} disabled={disabled} title={title} onClick={onClick} className={cn('press flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1 text-left text-xs enabled:hover:bg-raised disabled:opacity-40', danger ? 'text-rose-300' : 'text-soft enabled:hover:text-fg')}>
      <span className="flex w-3.5 flex-none justify-center text-dim">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </button>
  );
}

function Counts({ b }: { b: GitBranch }) {
  if (b.gone) return <span className="flex-none text-[10.5px] text-dim">{t('git.upstreamGone')}</span>;
  return (
    <>
      {b.ahead > 0 && <span className="flex flex-none items-center text-[10.5px] text-soft" title={t('git.ahead')}><ArrowUp size={10} />{b.ahead}</span>}
      {b.behind > 0 && <span className="flex flex-none items-center text-[10.5px] text-accent" title={t('git.behind')}><ArrowDown size={10} />{b.behind}</span>}
    </>
  );
}

type Picked = { kind: 'branch'; b: GitBranch } | { kind: 'stash' } | null;

/** The branch name in the header opens it. Search, then groups; a click on a branch opens its actions beside the list. */
export function BranchPopup({ base, rev, label, dirty, busy, actions }: { base: string; rev: number; label: string; dirty: boolean; busy: boolean; actions: BranchActions }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Picked>(null);
  const [cursor, setCursor] = useState(0);
  const branches = useApi<GitBranches>(open ? `${base}/branches` : null);
  const stashes = useApi<GitStash[]>(open ? `${base}/stash` : null);
  const refetchBranches = branches.refetch;
  const refetchStashes = stashes.refetch;

  useEffect(() => {
    if (!open) return;
    refetchBranches();
    refetchStashes();
  }, [open, rev, refetchBranches, refetchStashes]);
  useEffect(() => {
    if (open) return;
    setQuery('');
    setPicked(null);
  }, [open]);
  useEffect(() => setCursor(0), [query]);

  const data = branches.data;
  const groups = useMemo(() => {
    if (!data) return [];
    const q = query.trim().toLowerCase();
    const match = (b: GitBranch) => !q || b.name.toLowerCase().includes(q);
    const local = [...data.local].sort((a, b) => Number(b.current) - Number(a.current));
    const recent = data.recent.flatMap((name) => data.local.filter((b) => b.name === name));
    return [
      { key: 'recent', title: t('git.recentBranches'), items: recent.filter(match) },
      { key: 'local', title: t('git.local'), items: local.filter(match) },
      { key: 'remote', title: t('git.remotes'), items: data.remote.filter(match) },
    ].filter((g) => g.items.length > 0);
  }, [data, query]);
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);

  const close = (then: () => void) => {
    setOpen(false);
    then();
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setCursor((c) => Math.max(0, Math.min(flat.length - 1, c + (e.key === 'ArrowDown' ? 1 : -1))));
    } else if (e.key === 'Enter' && flat[cursor]) {
      e.preventDefault();
      setPicked({ kind: 'branch', b: flat[cursor] });
    }
  };
  const stashList = stashes.data ?? [];
  let index = -1;

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <button type="button" aria-label={t('git.branchMenu')} className="press flex min-w-0 items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-raised aria-expanded:bg-raised">
          <strong className="max-w-72 truncate font-mono text-[13px] font-medium" title={label}>{label}</strong>
          <ChevronDown size={12} className="flex-none text-dim" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} aria-label={t('git.branchMenu')} data-testid="git-branches" className="enter-pop popover z-50 flex max-h-[70vh] rounded-xl outline-none">
          <div className="flex w-[340px] min-h-0 flex-col p-1">
            <Input autoFocus aria-label={t('git.searchBranches')} placeholder={t('git.searchBranches')} spellCheck={false} className="mb-1 py-1 font-mono text-xs" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={onKey} />
            <MenuItem icon={<GitBranchPlus size={12} />} onClick={() => close(() => actions.create(null))} disabled={busy}>{t('git.newBranch')}</MenuItem>
            <MenuItem icon={<Archive size={12} />} onClick={() => close(actions.stash)} disabled={busy || !dirty}>{t('git.stashChanges')}</MenuItem>
            <button type="button" onClick={() => setPicked({ kind: 'stash' })} className={cn('press flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-xs text-soft hover:bg-raised hover:text-fg', picked?.kind === 'stash' && 'bg-raised')}>
              <span className="flex w-3.5 flex-none justify-center text-dim"><ArchiveRestore size={12} /></span>
              <span className="flex-1">{t('git.unstash')}</span>
              {stashList.length > 0 && <span className="text-[10.5px] text-dim">{stashList.length}</span>}
              <ChevronRight size={11} className="text-dim" />
            </button>
            <div className="my-1 border-t border-line2" />
            <div className="min-h-0 flex-1 overflow-auto">
              {branches.error && !data ? <ErrorState message={branches.error} onRetry={branches.refetch} /> : !data ? <Skeleton lines={5} /> : flat.length === 0 ? <p className="px-2 py-1.5 text-xs text-dim">{t('git.noBranches')}</p> : groups.map((g) => (
                <section key={g.key} className="mb-1">
                  <h4 className="px-2 pt-1 pb-0.5 text-[10.5px] text-dim">{g.title}</h4>
                  {g.items.map((b) => {
                    index += 1;
                    const here = index;
                    const active = picked?.kind === 'branch' && picked.b.name === b.name;
                    return (
                      <button key={`${g.key}:${b.name}`} type="button" aria-current={b.current || undefined} title={b.upstream ? `${b.name} → ${b.upstream}\n${b.subject}` : `${b.name}\n${b.subject}`} onClick={() => setPicked({ kind: 'branch', b })} onMouseEnter={() => setCursor(here)} className={cn('press flex w-full min-w-0 items-center gap-1.5 rounded-md px-2 py-0.5 text-left font-mono text-[11.5px]', active || cursor === here ? 'bg-raised text-fg' : 'text-soft')}>
                        <span className="flex w-3.5 flex-none justify-center">{b.current && <Check size={12} className="text-accent" aria-label={t('git.current')} />}</span>
                        <span className={cn('min-w-0 flex-1 truncate', b.current && 'font-medium text-fg')}>{b.name}</span>
                        <Counts b={b} />
                        <ChevronRight size={11} className="flex-none text-dim" />
                      </button>
                    );
                  })}
                </section>
              ))}
              {data?.truncated && <p className="px-2 py-1 text-[11px] text-accent">{t('git.listTruncated')}</p>}
            </div>
          </div>
          {picked && (
            <div className="flex w-60 min-h-0 flex-col overflow-auto border-l border-line2 p-1" data-testid="git-branch-actions">
              {picked.kind === 'stash' ? (
                stashList.length === 0 ? <p className="px-2 py-1 text-xs text-dim">{t('git.noStash')}</p> : stashList.map((s, i) => (
                  <MenuItem key={s.ref} autoFocus={i === 0} disabled={busy} title={`${s.ref}: ${s.subject}`} icon={<ArchiveRestore size={12} />} onClick={() => close(() => actions.unstash(s))}>
                    <span className="block truncate">{s.subject}</span>
                    <span className="block text-[10.5px] text-dim">{s.ref} · {fmtAgo(s.at)}</span>
                  </MenuItem>
                ))
              ) : (
                <>
                  <div className="truncate px-2 pt-1 pb-1 font-mono text-[11px] text-dim" title={picked.b.name}>{picked.b.name}</div>
                  {!picked.b.current && <MenuItem autoFocus disabled={busy} icon={<ArrowRightLeft size={12} />} onClick={() => close(() => actions.checkout(picked.b))}>{t('git.checkout')}</MenuItem>}
                  <MenuItem autoFocus={picked.b.current} disabled={busy} icon={<GitBranchPlus size={12} />} onClick={() => close(() => actions.create(picked.b))}>{t('git.newFromHere')}</MenuItem>
                  {!picked.b.current && <MenuItem icon={<GitCompare size={12} />} onClick={() => close(() => actions.compare(picked.b))}>{t('git.compareCurrent')}</MenuItem>}
                  {picked.b.kind === 'local' && <MenuItem disabled={busy} icon={<Pencil size={12} />} onClick={() => close(() => actions.rename(picked.b))}>{t('git.rename')}</MenuItem>}
                  {picked.b.kind === 'local' && !picked.b.current && <MenuItem danger disabled={busy} icon={<Trash2 size={12} />} onClick={() => close(() => actions.remove(picked.b))}>{t('git.delete')}</MenuItem>}
                </>
              )}
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
