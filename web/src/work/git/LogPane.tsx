import { memo, useEffect, useMemo, useState } from 'react';
import { ErrorState, Skeleton, Spinner } from '@/components/states';
import { Button } from '@/components/ui';
import { useApi } from '@/lib/api';
import { cn, fmtAgo } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { GitFile, GitLog, GitLogCommit, GitRefLabel } from '@/lib/types';
import { DiffPane, FileLine } from './DiffPane';
import { buildGraph, type GraphRow } from './graph';

const PAGE = 200;
const ROW = 24;
const LANE = 10;
const MAX_LANES = 8;
const LANE_COLORS = ['#d97757', '#7fb3a6', '#7aa2c9', '#c9a86a', '#a8a8b0', '#c98a8a'];
const color = (lane: number) => LANE_COLORS[lane % LANE_COLORS.length];
const x = (lane: number) => lane * LANE + 7;

const labelTone: Record<GitRefLabel['kind'], string> = {
  head: 'border-accent-deep bg-accent-bg text-accent',
  local: 'border-emerald-500/30 text-emerald-200',
  remote: 'border-sky-500/30 text-sky-200',
  tag: 'border-amber-500/30 text-amber-200',
};

function Graph({ row, lanes }: { row: GraphRow; lanes: number }) {
  const mid = ROW / 2;
  return (
    <svg width={lanes * LANE + 4} height={ROW} className="flex-none" aria-hidden="true">
      {row.top.map((e, i) => <line key={`t${i}`} x1={x(e.from)} y1={0} x2={x(e.to)} y2={mid} stroke={color(e.from)} strokeWidth={1.3} />)}
      {row.bottom.map((e, i) => <line key={`b${i}`} x1={x(e.from)} y1={mid} x2={x(e.to)} y2={ROW} stroke={color(e.to)} strokeWidth={1.3} />)}
      <circle cx={x(row.lane)} cy={mid} r={3} fill={color(row.lane)} />
    </svg>
  );
}

const LogRow = memo(function LogRow({ c, row, lanes, active, onOpen }: { c: GitLogCommit; row: GraphRow; lanes: number; active: boolean; onOpen: (hash: string) => void }) {
  return (
    <button type="button" aria-pressed={active} onClick={() => onOpen(c.hash)} style={{ height: ROW }} className={cn('press flex w-full min-w-0 items-center gap-1.5 pr-2 pl-1 text-left text-[12px]', active ? 'bg-white/[.1]' : 'hover:bg-raised')}>
      <Graph row={row} lanes={lanes} />
      {c.refs.map((r) => <span key={`${r.kind}${r.name}`} title={r.name} className={cn('max-w-32 flex-none truncate rounded border px-1 font-mono text-[10px] leading-[1.45]', labelTone[r.kind])}>{r.name}</span>)}
      <span className="min-w-0 flex-1 truncate text-soft" title={c.subject}>{c.subject}</span>
      <span className="w-24 flex-none truncate text-right text-[11px] text-dim" title={c.author}>{c.author}</span>
      <span className="w-16 flex-none truncate text-right text-[11px] text-dim" title={new Date(c.at).toLocaleString()}>{fmtAgo(c.at)}</span>
    </button>
  );
});

function CommitDetail({ base, c, rev }: { base: string; c: GitLogCommit; rev: number }) {
  const q = useApi<{ files: GitFile[]; message?: string }>(`${base}/commit/${c.hash}`);
  const [path, setPath] = useState<string | null>(null);
  useEffect(() => setPath(q.data?.files[0]?.path ?? null), [q.data]);
  const url = path ? `${base}/commit/${c.hash}/diff?path=${encodeURIComponent(path)}` : null;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex max-h-[40%] flex-none flex-col overflow-auto border-b border-line2 p-2.5">
        <pre className="selectable mb-1 font-sans text-[12.5px] leading-[1.45] whitespace-pre-wrap wrap-anywhere text-soft">{q.data?.message || c.subject}</pre>
        <div className="mb-1.5 flex flex-wrap gap-x-2 font-mono text-[10.5px] text-dim">
          <span className="selectable">{c.short}</span>
          <span>{c.author}</span>
          <span>{new Date(c.at).toLocaleString()}</span>
        </div>
        {q.error && !q.data && <ErrorState message={q.error} onRetry={q.refetch} />}
        {!q.data && !q.error && <Spinner size={12} />}
        {q.data?.files.map((f) => <FileLine key={f.path} f={f} active={path === f.path} onOpen={() => setPath(f.path)} />)}
      </div>
      <div className="min-h-0 flex-1"><DiffPane url={url} file={path} badge={c.short} rev={rev} /></div>
    </div>
  );
}

export function LogPane({ base, rev }: { base: string; rev: number }) {
  const [limit, setLimit] = useState(PAGE);
  const [hash, setHash] = useState<string | null>(null);
  const q = useApi<GitLog>(`${base}/log?limit=${limit}`);
  const { refetch } = q;
  useEffect(() => {
    if (rev > 0) refetch();
  }, [rev, refetch]);
  const commits = useMemo(() => q.data?.commits ?? [], [q.data]);
  const graph = useMemo(() => buildGraph(commits), [commits]);
  const lanes = Math.min(MAX_LANES, Math.max(1, ...graph.map((r) => r.width)));
  const open = commits.find((c) => c.hash === hash) ?? null;
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
      <div className="min-h-0 overflow-auto border-r border-line2" data-testid="git-log">
        {q.error && !q.data ? <ErrorState className="m-3" message={q.error} onRetry={refetch} /> : !q.data ? <Skeleton className="p-3" lines={10} /> : commits.length === 0 ? <p className="p-3 text-xs text-dim">{t('git.noCommits')}</p> : (
          <>
            {commits.map((c, i) => <LogRow key={c.hash} c={c} row={graph[i]} lanes={lanes} active={hash === c.hash} onOpen={setHash} />)}
            {q.data.more && <div className="p-2 text-center"><Button size="sm" onClick={() => setLimit(limit + PAGE)}>{t('git.loadMore')}</Button></div>}
          </>
        )}
      </div>
      <div className="min-h-0 min-w-0">{open ? <CommitDetail key={open.hash} base={base} c={open} rev={rev} /> : <DiffPane url={null} file={null} rev={0} emptyText={t('git.pickCommit')} />}</div>
    </div>
  );
}
