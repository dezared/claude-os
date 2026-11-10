import { PackageCheck } from 'lucide-react';
import { useApi } from '@/lib/api';
import { fmtDay, fmtInt, fmtTokens, toDay } from '@/lib/format';
import { locale, t } from '@/lib/i18n';
import { KIT_METRICS, KIT_TARGETS, type KitMetric, type KitMetricsRow, type KitMetricValue } from '../../../shared/projectKit.ts';
import { Section } from './analyticsParts';

const decimal = (v: number, digits: number) => v.toLocaleString(locale(), { maximumFractionDigits: digits });
const pct = (v: number) => t('an.percent', { n: decimal(v * 100, 0) });
const sec = (v: number) => t('an.kit.seconds', { n: decimal(v / 1000, 1) });
const perSession = (v: number) => decimal(v, 2);

const FORMAT: Record<KitMetric, (v: number) => string> = {
  startingContext: fmtTokens,
  cacheHit: pct,
  subagentShare: pct,
  skillsUsed: pct,
  visibleSkills: fmtInt,
  loopA50: sec,
  loopA90: sec,
  loopB50: sec,
  loopB90: sec,
  redStops: perSession,
  filesOverLimit: fmtInt,
  unpromotedMistakes: fmtInt,
  patternDebt: fmtInt,
  questions: perSession,
};

function label(m: KitMetric, level: string | null): string {
  const text = t(`an.kit.m.${m}` as const);
  if (m !== 'questions' || !level) return text;
  return `${text} · ${t(`settings.profile.level.${level as 'minimal' | 'balanced' | 'thorough'}` as const)}`;
}

function KitTable({ row }: { row: KitMetricsRow }) {
  const cell = (m: KitMetric, v: KitMetricValue['before']) => (v == null ? <span className="text-dim">—</span> : FORMAT[m](v));
  return (
    <div className="min-w-0">
      <h3 className="mb-1 flex flex-wrap items-baseline gap-2 text-xs">
        <span className="text-soft">{row.name}</span>
        <span className="text-dim">{t('an.kit.installed', { kit: row.kit, day: fmtDay(toDay(new Date(row.installedAt))) })}</span>
      </h3>
      <table className="w-full table-fixed text-xs">
        <thead className="text-[11px] text-dim">
          <tr>
            <th className="w-[40%] py-1 text-left font-normal">{t('an.kit.colMetric')}</th>
            <th className="py-1 text-right font-normal">{t('an.kit.colBefore')}</th>
            <th className="py-1 text-right font-normal">{t('an.kit.colAfter')}</th>
            <th className="py-1 text-right font-normal">{t('an.kit.colTarget')}</th>
          </tr>
        </thead>
        <tbody>
          {KIT_METRICS.map((m) => (
            <tr key={m} className="border-t border-line2">
              <td className="truncate py-1 pr-3 text-muted" title={label(m, row.questionLevel)}>{label(m, row.questionLevel)}</td>
              <td className="py-1 text-right">{cell(m, row.metrics[m].before)}</td>
              <td className="py-1 text-right">{cell(m, row.metrics[m].after)}</td>
              <td className="py-1 text-right text-dim">{KIT_TARGETS[m]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Whether the project kit pays off: one table per project that has it, nothing when none has. */
export function KitAnalytics({ from, to }: { from: string; to: string }) {
  // An apply or remove changes the rows at once (projectKit); the journal moves them later (tokens).
  const kit = useApi<KitMetricsRow[]>(`/api/analytics/kit?from=${from}&to=${to}`, ['tokens', 'projectKit']);
  if (!kit.data?.length) return null;
  return (
    <Section icon={PackageCheck} title={t('an.kit.title')} className="border-b border-line2" aside={<span className="text-xs text-dim">{t('an.kit.hint')}</span>}>
      <div className="grid gap-5 app:grid-cols-2">
        {kit.data.map((row) => <KitTable key={row.project} row={row} />)}
      </div>
    </Section>
  );
}
