import { ChevronRight, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { ErrorState, Skeleton, Spinner } from '@/components/states';
import { IconButton } from '@/components/ui';
import { useApi } from '@/lib/api';
import { cn, fmtAgo, fmtInt } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { GitCommit, GitCompare, GitFile } from '@/lib/types';
import { DiffPane, FileLine } from './DiffPane';

type Open = { kind: 'file'; path: string } | { kind: 'commit'; hash: string; short: string; path: string };

function CommitRow({ c, base, open, onOpen }: { c: GitCommit; base: string; open: Open | null; onOpen: (o: Open) => void }) {
  const [expanded, setExpanded] = useState(false);
  const files = useApi<{ files: GitFile[] }>(expanded ? `${base}/commit/${c.hash}` : null);
  return (
    <div>
      <button type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)} className="press flex w-full items-baseline gap-1.5 rounded-md py-0.5 pr-1 pl-1 text-left hover:bg-raised">
        <ChevronRight size={10} className={cn('flex-none translate-y-px text-dim transition-transform duration-150', expanded && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate text-[12px] text-soft" title={c.subject}>{c.subject}</span>
        <span className="flex-none text-[11px] text-dim">{fmtAgo(c.at)}</span>
      </button>
      {expanded && (
        <div className="mb-1 ml-3">
          <div className="px-2 pb-0.5 font-mono text-[10.5px] text-dim">{c.short} · {c.author}</div>
          {!files.data && !files.error && <Spinner className="ml-2" size={12} />}
          {files.error && <p className="px-2 text-[11px] text-accent">{files.error}</p>}
          {files.data?.files.map((f) => <FileLine key={f.path} f={f} active={open?.kind === 'commit' && open.hash === c.hash && open.path === f.path} onOpen={() => onOpen({ kind: 'commit', hash: c.hash, short: c.short, path: f.path })} />)}
        </div>
      )}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="mb-3">
      <h4 className="mb-0.5 truncate px-1 text-[11px] text-dim" title={title}>{title} <b className="font-medium text-muted">{fmtInt(count)}</b></h4>
      {children}
    </section>
  );
}

/** Commits both ways and the files that differ between the tips, against the branch checked out now. */
export function ComparePane({ base, branch, current, rev, onClose }: { base: string; branch: string; current: string; rev: number; onClose: () => void }) {
  const q = useApi<GitCompare>(`${base}/compare?ref=${encodeURIComponent(branch)}`);
  const [open, setOpen] = useState<Open | null>(null);
  const { refetch } = q;
  useEffect(() => {
    if (rev > 0) refetch();
  }, [rev, refetch]);
  useEffect(() => setOpen(null), [branch]);
  const c = q.data;
  const url = !open ? null : open.kind === 'file'
    ? `${base}/compare/diff?ref=${encodeURIComponent(branch)}&path=${encodeURIComponent(open.path)}`
    : `${base}/commit/${open.hash}/diff?path=${encodeURIComponent(open.path)}`;
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(300px,420px)_minmax(0,1fr)]">
      <div className="flex min-h-0 flex-col border-r border-line2" data-testid="git-compare">
        <div className="flex flex-none items-center gap-2 border-b border-line2 py-1 pr-1 pl-3">
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-soft" title={`${branch} / ${current}`}>{branch} <span className="text-dim">/</span> {current}</span>
          <IconButton label={t('common.close')} className="size-6" onClick={onClose}><X size={12} /></IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-2">
          {q.error && !c ? <ErrorState message={q.error} onRetry={refetch} /> : !c ? <Skeleton lines={6} /> : c.incoming.length + c.outgoing.length + c.files.length === 0 ? <p className="px-1 text-xs text-dim">{t('git.compareSame')}</p> : (
            <>
              <Section title={t('git.onlyIn', { branch })} count={c.incoming.length}>
                {c.incoming.map((x) => <CommitRow key={x.hash} c={x} base={base} open={open} onOpen={setOpen} />)}
              </Section>
              <Section title={t('git.onlyIn', { branch: current })} count={c.outgoing.length}>
                {c.outgoing.map((x) => <CommitRow key={x.hash} c={x} base={base} open={open} onOpen={setOpen} />)}
              </Section>
              <Section title={t('git.filesDiffer')} count={c.files.length}>
                {c.files.map((f) => <FileLine key={f.path} f={f} active={open?.kind === 'file' && open.path === f.path} onOpen={() => setOpen({ kind: 'file', path: f.path })} />)}
              </Section>
            </>
          )}
        </div>
      </div>
      <div className="min-h-0 min-w-0"><DiffPane url={url} file={open?.path ?? null} badge={open?.kind === 'commit' ? open.short : undefined} rev={rev} /></div>
    </div>
  );
}
