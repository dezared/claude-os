import { useState, type CSSProperties } from 'react';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { KitMetric, KitMetricsRow } from '../../../shared/projectKit.ts';
import { FORMAT, label } from './KitAnalytics';
import { Better, goal, metricTip } from './KitGuide';

// Two series, before and after the install: blue and the accent, checked for colour-blind separation and contrast on both
// themes (dataviz validator). The dark accent is a step deeper than --color-accent, which is too light for a chart mark.
const BEFORE = 'bg-[#3987e5] light:bg-[#2a78d6]';
const AFTER = 'bg-[#d0683f] light:bg-[#c2603b]';

/** The metrics with a value on both sides of the install: the rest came with the kit and have no "before". */
export const COMPARED = ['startingContext', 'cacheHit', 'subagentShare', 'questions'] as const satisfies KitMetric[];

// Up to this many projects a chart prints each value over its bar; more would collide, the hover still names them.
const LABELLED = 4;

export function Legend() {
  return (
    <div className="flex items-center gap-3 text-[11px] text-muted">
      <span className="flex items-center gap-1.5"><i className={cn('size-2 rounded-[2px]', BEFORE)} />{t('an.kit.colBefore')}</span>
      <span className="flex items-center gap-1.5"><i className={cn('size-2 rounded-[2px]', AFTER)} />{t('an.kit.colAfter')}</span>
    </div>
  );
}

function Bar({ value, max, tone, text }: { value: number | null; max: number; tone: string; text?: string }) {
  if (value == null) return <span className="mb-px block h-px w-[min(45%,14px)] bg-line" />;
  const share = Math.max(value / max, 0.01);
  return (
    <span className="relative flex h-full w-[min(45%,14px)] items-end">
      {text && <span className="motion-fade absolute left-1/2 -translate-x-1/2 text-[10px] whitespace-nowrap text-muted" style={{ bottom: `calc(${share * 100}% + 2px)` }}>{text}</span>}
      <i className={cn('kit-bar block h-full w-full rounded-t-[3px]', tone)} style={{ '--kit-bar': share } as CSSProperties} />
    </span>
  );
}

/** One metric, one axis: a pair of bars per project, before and after; the hover names the project and both values. */
function MetricChart({ metric, rows }: { metric: (typeof COMPARED)[number]; rows: KitMetricsRow[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = rows.map((r) => r.metrics[metric]);
  const max = Math.max(...values.flatMap((v) => [v.before ?? 0, v.after ?? 0]), Number.EPSILON);
  const fmt = (v: number | null) => (v == null ? '—' : FORMAT[metric](v));
  const hot = hover == null ? null : rows[hover];
  const empty = values.every((v) => v.before == null && v.after == null);
  const text = (v: number | null) => (rows.length <= LABELLED && v != null ? fmt(v) : undefined);
  return (
    <figure className="min-w-0">
      <figcaption className="mb-1.5 text-[11.5px]" title={metricTip(metric)}>
        <span className="flex items-baseline justify-between gap-2">
          <span className="truncate text-soft">{label(metric, null)}</span>
          <span className="flex flex-none items-baseline gap-2"><Better m={metric} /><span className="text-[10.5px] text-dim">{t('kits.target', { target: goal(metric) })}</span></span>
        </span>
        <span className="block truncate text-[11px] text-dim">{t(`kits.about.${metric}` as const)}</span>
      </figcaption>
      <div className="relative h-28 border-b border-line" onPointerLeave={() => setHover(null)}>
        <span className="absolute inset-x-0 top-0 h-px bg-line2" />
        {!empty && <span className="absolute top-0.5 left-0 text-[10px] text-dim">{FORMAT[metric](max)}</span>}
        {empty && <span className="motion-fade absolute inset-0 flex items-center justify-center text-[11px] text-dim">{t('kits.chartEmpty')}</span>}
        <div className="absolute inset-0 flex items-end gap-2 pt-4">
          {values.map((v, i) => (
            <div key={rows[i].project} className={cn('flex h-full min-w-0 flex-1 items-end justify-center gap-0.5 rounded-t transition-colors duration-100', hover === i && 'bg-fg/[.04]')} onPointerEnter={() => setHover(i)}>
              <Bar value={v.before} max={max} tone={BEFORE} text={text(v.before)} />
              <Bar value={v.after} max={max} tone={AFTER} text={text(v.after)} />
            </div>
          ))}
        </div>
        {hot && hover != null && (
          <div role="tooltip" className="popover motion-fade pointer-events-none absolute top-1 z-10 w-40 rounded-lg px-2.5 py-2 text-xs" style={hover < rows.length / 2 ? { left: `calc(${((hover + 1) / rows.length) * 100}% + 4px)` } : { right: `calc(${((rows.length - hover) / rows.length) * 100}% + 4px)` }}>
            <div className="mb-1 truncate text-soft">{hot.name}</div>
            <div className="flex justify-between gap-3 text-dim"><span>{t('an.kit.colBefore')}</span><span className="text-muted">{fmt(hot.metrics[metric].before)}</span></div>
            <div className="flex justify-between gap-3 text-dim"><span>{t('an.kit.colAfter')}</span><span className="text-muted">{fmt(hot.metrics[metric].after)}</span></div>
          </div>
        )}
      </div>
      <div className="mt-1 flex gap-2 text-[10px] text-dim">
        {rows.map((r) => <span key={r.project} className="min-w-0 flex-1 truncate text-center" title={r.name}>{r.name}</span>)}
      </div>
    </figure>
  );
}

/** Small multiples, one per compared metric, so each keeps its own scale. */
export function BeforeAfter({ rows }: { rows: KitMetricsRow[] }) {
  return (
    <div className="grid gap-x-6 gap-y-5 app:grid-cols-2">
      {COMPARED.map((m) => <MetricChart key={m} metric={m} rows={rows} />)}
    </div>
  );
}
