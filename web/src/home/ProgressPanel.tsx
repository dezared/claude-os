import { X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ContextArea } from '@/components/ContextMenu';
import { api } from '@/lib/api';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import { tabTitle } from '@/lib/tabTitle';
import { toastError, useApp } from '@/lib/store';
import type { Tab, TabProgress, TaskState } from '@/lib/types';

const LEAVE_MS = 260; // .progress-row in styles.css

const LOOK: Record<TaskState, { text: string; fill: string }> = {
  working: { text: 'text-accent', fill: 'bg-accent' },
  waiting: { text: 'text-warn', fill: 'bg-warn' },
  done: { text: 'text-ok', fill: 'bg-ok' },
  failed: { text: 'text-bad', fill: 'bg-bad' },
};

export type ProgressRow = { tab: Tab; progress: TabProgress; leaving: boolean };

/** The tabs that reported, in the order of the tab strip. One that is gone stays a moment as `leaving`, so its row can fold away. */
export function useProgressRows(tabs: Tab[] | undefined): ProgressRow[] {
  const live = useMemo(() => (tabs ?? []).filter((x) => x.progress), [tabs]);
  const [gone, setGone] = useState<Tab[]>([]);
  const last = useRef(live);
  useEffect(() => {
    const left = last.current.filter((o) => !live.some((n) => n.id === o.id));
    last.current = live;
    if (left.length === 0) return;
    setGone((g) => [...g, ...left]);
    window.setTimeout(() => setGone((g) => g.filter((x) => !left.includes(x))), LEAVE_MS);
  }, [live]);
  return [...live.map((tab) => ({ tab, leaving: false })), ...gone.filter((o) => !live.some((n) => n.id === o.id)).map((tab) => ({ tab, leaving: true }))]
    .sort((a, b) => a.tab.order - b.tab.order)
    .map((r) => ({ ...r, progress: r.tab.progress! }));
}

function Row({ row: { tab, progress, leaving } }: { row: ProgressRow }) {
  const go = useApp((s) => s.go);
  const { percent, step, state } = progress;
  const dismiss = () => api(`/api/tabs/${encodeURIComponent(tab.id)}/progress`, { method: 'DELETE' }).catch(toastError);
  const title = tabTitle(tab, t('tabs.root'));
  return (
    <div data-progress-row={tab.id} data-state={state} data-own-menu className={cn('progress-row', leaving && 'is-leaving')}>
      <ContextArea className="min-h-0 overflow-hidden" items={() => [{ id: 'progress.dismiss', label: t('progress.dismiss'), icon: X, onSelect: dismiss }]}>
        <button type="button" disabled={leaving} onClick={() => go(tab.kind === 'root' ? { kind: 'home' } : { kind: 'tab', id: tab.id })} className="press block w-full rounded-lg px-1.5 py-1 text-left transition-colors duration-150 hover:bg-white/5">
          <span className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-soft" title={title}>{title}</span>
            <span aria-hidden className="progress-num flex-none text-[11px] text-muted" style={{ '--pct': percent } as CSSProperties} />
          </span>
          <span role="progressbar" aria-label={title} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent} className="mt-1 block h-1 overflow-hidden rounded-full bg-white/10">
            <i className={cn('progress-fill block h-full origin-left rounded-full', LOOK[state].fill)} style={{ '--ratio': percent / 100 } as CSSProperties} />
          </span>
          <span className="mt-0.5 flex items-baseline gap-2 text-[11px]">
            <span key={step} className="enter-fade min-w-0 flex-1 truncate text-dim" title={step ?? undefined}>{step}</span>
            <span key={state} data-progress-state className={cn('enter-fade flex flex-none items-center gap-1', LOOK[state].text)}>
              {state === 'working' && <i aria-hidden className="dot-working size-1.25 rounded-full bg-current" />}
              {t(`progress.${state}`)}
            </span>
          </span>
        </button>
      </ContextArea>
    </div>
  );
}

/** In the widget's title: how much of it is finished. */
export function ProgressCount({ rows }: { rows: ProgressRow[] }) {
  const live = rows.filter((r) => !r.leaving);
  return <span className="flex-none text-[11.5px] text-muted">{live.filter((r) => r.progress.state === 'done').length}/{live.length}</span>;
}

export function ProgressPanel({ rows }: { rows: ProgressRow[] }) {
  return (
    <div className="flex max-h-[26rem] min-h-0 flex-1 flex-col gap-0.5 overflow-auto px-1.5 pb-1.5">
      {rows.map((row) => <Row key={row.tab.id} row={row} />)}
    </div>
  );
}
