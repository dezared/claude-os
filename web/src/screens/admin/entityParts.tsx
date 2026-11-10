import { CalendarDays, FolderTree, History, ListOrdered, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { fmtAgo, fmtDateTime, fmtDay, fmtInt } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { EntityStats } from '@/lib/types';
import { useApp } from '@/lib/store';
import { Bar, MiniBars, SectionHead } from './parts';
import { projectView } from './menus';

/** Label and value lines. A value that is not known takes its label with it. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="mb-4 grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
      {rows.filter(([, v]) => v !== null && v !== undefined && v !== false && v !== '').map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-dim">{label}</dt>
          <dd className="selectable min-w-0 wrap-anywhere text-soft">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export const when = (ts: number | null | undefined) => (ts ? `${fmtDateTime(ts)} (${fmtAgo(ts)})` : null);

export function Section({ title, icon, aside, children }: { title: string; icon?: LucideIcon; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-5">
      <SectionHead title={title} icon={icon} aside={aside} />
      {children}
    </section>
  );
}

function Ranked({ rows, format }: { rows: { name: string; n: number; onClick?: () => void }[]; format: (n: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return (
    <div className="grid max-w-2xl gap-1.5">
      {rows.map((r) => (
        <div key={r.name} className="grid grid-cols-[170px_minmax(0,1fr)_64px] items-center gap-3 text-xs">
          {r.onClick ? <button type="button" onClick={r.onClick} className="press truncate rounded text-left text-muted hover:text-fg">{r.name}</button> : <span className="truncate text-muted" title={r.name}>{r.name}</span>}
          <Bar value={r.n} max={max} color="var(--color-accent)" />
          <span className="text-right text-soft">{format(r.n)}</span>
        </div>
      ))}
    </div>
  );
}

/** What the journals say about one entity: by day, by project, by tool. Sections with nothing to say are left out. */
export function UsageSections({ stats, format = fmtInt, byNameTitle, chartTitle }: { stats: EntityStats; format?: (n: number) => string; byNameTitle?: string; chartTitle: string }) {
  const go = useApp((s) => s.go);
  return (
    <>
      {stats.recent > 0 && (
        <Section title={chartTitle} icon={CalendarDays}>
          <div className="max-w-2xl"><MiniBars values={stats.byDay.map((d) => d.n)} labels={stats.byDay.map((d) => `${fmtDay(d.day)}: ${format(d.n)}`)} height={56} accentLast /></div>
        </Section>
      )}
      {stats.byProject.length > 0 && (
        <Section title={t('ent.byProject')} icon={FolderTree}>
          <Ranked format={format} rows={stats.byProject.map((p) => ({ name: p.name, n: p.n, onClick: p.key ? () => go(projectView(p.key!)) : undefined }))} />
        </Section>
      )}
      {byNameTitle && stats.byName.length > 0 && (
        <Section title={byNameTitle} icon={ListOrdered}>
          <Ranked format={fmtInt} rows={stats.byName} />
        </Section>
      )}
      {stats.history.length > 0 && (
        <Section title={t('ent.history')} icon={History}>
          {stats.history.map((h, i) => (
            <div key={i} className="flex gap-3 py-0.5 text-xs">
              <span className="w-40 flex-none text-dim">{fmtDateTime(h.at)}</span>
              <span className="font-mono text-[11.5px] text-muted">{h.action}</span>
            </div>
          ))}
        </Section>
      )}
    </>
  );
}
