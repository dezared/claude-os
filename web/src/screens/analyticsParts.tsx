import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn, fmtDay, fmtInt, fmtTokens } from '@/lib/format';
import type { DayTokens } from '@/lib/types';
import { t } from '@/lib/i18n';

export const metricKey = { sum: 'an.sum', input: 'an.input', output: 'an.output', cacheWrite: 'an.cacheWrite', cacheRead: 'an.cacheRead' } as const;

export function Section({ title, aside, children, className, icon: Icon }: { title: string; aside?: ReactNode; children: ReactNode; className?: string; icon?: LucideIcon }) {
  return (
    <section className={cn('min-w-0 px-5 py-4', className)}>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-1.5 text-[12px] font-medium text-soft">
          {Icon && <Icon size={13} className="text-dim" />}
          {title}
        </h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

export function HourChart({ hours }: { hours: number[] }) {
  const max = Math.max(1, ...hours);
  const now = new Date().getHours();
  return (
    <div>
      <div className="relative flex h-48 items-end gap-0.5 border-b border-line">
        <span className="absolute inset-x-0 top-0 h-px bg-line2" />
        <span className="absolute inset-x-0 top-1/2 h-px bg-line2" />
        <span className="absolute top-0.5 left-0 text-[10px] text-dim">{fmtTokens(max)}</span>
        {hours.map((v, h) => (
          <div key={h} className="flex h-full min-w-0 flex-1 items-end" title={t('an.hourTip', { h: String(h).padStart(2, '0'), value: fmtTokens(v) })}>
            <i className={cn('mx-auto block min-h-px w-[min(100%,24px)] rounded-t-[3px]', h === now ? 'bg-accent' : 'bg-white/22')} style={{ height: `${(v / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="mt-1 flex text-[10px] text-dim">
        {hours.map((_, h) => <span key={h} className="min-w-0 flex-1 text-center">{h % 3 === 0 ? String(h).padStart(2, '0') : ''}</span>)}
      </div>
    </div>
  );
}

export function DayTable({ days }: { days: DayTokens[] }) {
  return (
    <div className="max-h-72 overflow-auto">
      <table className="w-full text-xs">
        <thead className="sheet-bar sticky top-0 text-[11px] text-dim">
          <tr>
            <th className="py-1 text-left font-normal">{t('an.day')}</th>
            {(['input', 'output', 'cacheWrite', 'cacheRead'] as const).map((k) => (
              <th key={k} className="py-1 text-right font-normal">{t(metricKey[k])}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {days.slice().reverse().map((d) => (
            <tr key={d.day} className="border-t border-line2">
              <td className="py-1 text-muted">{fmtDay(d.day)}</td>
              <td className="py-1 text-right">{fmtInt(d.input)}</td>
              <td className="py-1 text-right">{fmtInt(d.output)}</td>
              <td className="py-1 text-right">{fmtInt(d.cacheWrite)}</td>
              <td className="py-1 text-right text-dim">{fmtInt(d.cacheRead)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
