import { ArrowDown, ArrowUp, BookOpenText } from 'lucide-react';
import { Fold } from '@/components/Motion';
import { Button } from '@/components/ui';
import { t } from '@/lib/i18n';
import type { KitMetric } from '../../../shared/projectKit.ts';

/** The metrics the kits screen shows outside the full table, and which way is better for each (server/tools/kitMetrics.ts). */
export const EXPLAINED = { startingContext: 'lower', cacheHit: 'higher', subagentShare: 'lower', questions: 'lower', loopB50: 'lower', redStops: 'lower' } as const;
export type Explained = keyof typeof EXPLAINED;

export const goal = (m: KitMetric) => t(`kits.goal.${m}` as const);

/** The tooltip of a metric: what it counts, which way is better and its target. */
export const metricTip = (m: Explained) => `${t(`kits.about.${m}` as const)}\n\n${t(`kits.better.${EXPLAINED[m]}` as const)} · ${t('kits.target', { target: goal(m) })}`;

export function Better({ m }: { m: Explained }) {
  const Icon = EXPLAINED[m] === 'lower' ? ArrowDown : ArrowUp;
  return <span className="inline-flex flex-none items-center gap-0.5 text-[10.5px] text-dim"><Icon size={10} />{t(`kits.better.${EXPLAINED[m]}` as const)}</span>;
}

export function HowToRead({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return <Button size="sm" aria-expanded={open} onClick={onToggle}><BookOpenText size={12} />{t('kits.howToRead')}</Button>;
}

/** A plain-language glossary of the numbers, folded until asked for. */
export function Glossary({ show }: { show: boolean }) {
  return (
    <Fold show={show} className="pt-2">
      <dl className="grid gap-x-6 gap-y-2.5 rounded-xl border border-line2 bg-card p-4 text-xs app:grid-cols-2">
        {(Object.keys(EXPLAINED) as Explained[]).map((m) => (
          <div key={m} className="min-w-0">
            <dt className="flex flex-wrap items-baseline gap-x-2 text-soft">{t(`an.kit.m.${m}` as const)}<Better m={m} /><span className="text-[10.5px] text-dim">{t('kits.target', { target: goal(m) })}</span></dt>
            <dd className="mt-0.5 text-muted">{t(`kits.about.${m}` as const)}</dd>
          </div>
        ))}
      </dl>
    </Fold>
  );
}
