import { Columns2, FileDiff, Rows2 } from 'lucide-react';
import { memo, useEffect, useMemo } from 'react';
import { Empty, ErrorState, Skeleton } from '@/components/states';
import { Segmented } from '@/components/ui';
import { useApi } from '@/lib/api';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import { usePersisted } from '@/lib/store';
import type { GitDiff, GitFile } from '@/lib/types';
import { parseHunks, splitRows, type DiffLine } from '../gitDiff';

const lineTone = { add: 'bg-emerald-500/[.11] text-emerald-100', del: 'bg-rose-500/[.11] text-rose-100', ctx: 'text-muted' } as const;
export const statusTone: Record<string, string> = { A: 'text-emerald-300', M: 'text-amber-200', D: 'text-rose-300', R: 'text-sky-300', C: 'text-sky-300', U: 'text-accent', '?': 'text-dim', T: 'text-amber-200' };

function Num({ n }: { n: number | null }) {
  return <span className="w-10 flex-none pr-2 text-right text-dim/70 select-none">{n ?? ''}</span>;
}

function UnifiedLine({ l }: { l: DiffLine }) {
  return (
    <div className={cn('flex min-w-fit', lineTone[l.kind])}>
      <Num n={l.oldNo} />
      <Num n={l.newNo} />
      <span className="w-4 flex-none text-center opacity-60 select-none">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ''}</span>
      <span className="pr-3 whitespace-pre">{l.text || ' '}</span>
    </div>
  );
}

function SideCell({ l }: { l: DiffLine | null }) {
  return (
    <div className={cn('flex min-w-0 overflow-hidden', l ? lineTone[l.kind] : 'bg-white/[.02]')}>
      <Num n={l ? l.oldNo ?? l.newNo : null} />
      <span className="min-w-0 pr-2 whitespace-pre-wrap wrap-anywhere">{l ? l.text || ' ' : ''}</span>
    </div>
  );
}

const DiffBody = memo(function DiffBody({ diff, split }: { diff: string; split: boolean }) {
  const hunks = useMemo(() => parseHunks(diff), [diff]);
  if (hunks.length === 0) return <p className="p-4 text-xs text-dim">{t('git.noChanges')}</p>;
  return (
    <div className="selectable font-mono text-[12px] leading-[1.55]">
      {hunks.map((h, i) => (
        <section key={i}>
          <div className="sticky top-0 z-[1] border-y border-line2 bg-[#141418] px-3 py-0.5 text-[11px] text-dim">{h.header}</div>
          {split
            ? splitRows(h.lines).map((r, k) => (
              <div key={k} className="grid grid-cols-2 divide-x divide-line2">
                <SideCell l={r.left} />
                <SideCell l={r.right} />
              </div>
            ))
            : h.lines.map((l, k) => <UnifiedLine key={k} l={l} />)}
        </section>
      ))}
    </div>
  );
});

/** `url` answers GitDiff; `rev` changes whenever the tree may have changed. */
export function DiffPane({ url, file, badge, rev, emptyText }: { url: string | null; file: string | null; badge?: string; rev: number; emptyText?: string }) {
  const [split, setSplit] = usePersisted('claude-os.git.split', false);
  const q = useApi<GitDiff>(url);
  const { refetch } = q;
  useEffect(() => {
    if (rev > 0) refetch();
  }, [rev, refetch]);
  if (!url) return <div className="flex h-full items-center justify-center text-xs text-dim"><FileDiff size={15} className="mr-2" />{emptyText ?? t('git.pickFile')}</div>;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-none items-center gap-2 border-b border-line2 py-1 pr-2 pl-3">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-soft" title={file ?? undefined}>{file}</span>
        {badge && <span className="flex-none font-mono text-[11px] text-dim">{badge}</span>}
        <Segmented
          ariaLabel={t('git.diffMode')}
          value={split ? 'split' : 'unified'}
          onChange={(v) => setSplit(v === 'split')}
          options={[
            { value: 'unified', label: t('git.unified'), icon: Rows2 },
            { value: 'split', label: t('git.split'), icon: Columns2 },
          ]}
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto" data-testid="git-diff">
        {q.error && !q.data ? <ErrorState className="m-3" message={q.error} onRetry={q.refetch} /> : !q.data ? <Skeleton className="p-4" lines={6} /> : q.data.binary ? (
          <Empty className="m-3">{t('git.binary')}</Empty>
        ) : (
          <>
            {q.data.truncated && <p className="border-b border-line2 bg-accent-bg px-3 py-1 text-[11px] text-soft">{t('git.truncated')}</p>}
            <DiffBody diff={q.data.diff} split={split} />
          </>
        )}
      </div>
    </div>
  );
}

/** Status letter, file name, folder in dim. */
export function FileName({ f }: { f: { path: string; status: string } }) {
  const slash = f.path.lastIndexOf('/');
  return (
    <>
      <span className={cn('w-3 flex-none text-center', statusTone[f.status] ?? 'text-muted')}>{f.status}</span>
      <span className="min-w-0 truncate"><span className="text-soft">{f.path.slice(slash + 1)}</span>{slash > 0 && <span className="ml-1.5 text-dim">{f.path.slice(0, slash)}</span>}</span>
    </>
  );
}

export function FileLine({ f, active, onOpen }: { f: GitFile; active: boolean; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path} className={cn('press flex w-full min-w-0 items-baseline gap-1.5 rounded-md py-0.5 pl-2 text-left font-mono text-[11.5px]', active ? 'bg-white/[.1]' : 'hover:bg-raised')}>
      <FileName f={f} />
    </button>
  );
}
