import { ArrowDownToLine, ArrowUpFromLine, BarChart3, Bot, CalendarDays, ChartNoAxesColumn, CircleDollarSign, Clock, Cpu, DatabaseZap, FolderKanban, Gauge, GitFork, HardDriveUpload, Layers, ListOrdered, Table2, TrendingUp, type LucideIcon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { ProjectIcon } from '@/components/ProjectIcon';
import { Boundary, Empty, Skeleton } from '@/components/states';
import { Button, Segmented } from '@/components/ui';
import { useAccount, useShowCost } from '@/lib/account';
import { useApi } from '@/lib/api';
import { cn, fmtDateTime, fmtDay, fmtInt, fmtTokens, fmtUsd, toDay, tokenSum } from '@/lib/format';
import { prettyModel } from '@/lib/model-name';
import { useProjectColors } from '@/lib/projectColors';
import { openSession } from '@/lib/tabs';
import type { Analytics, DayTokens, Forecast, LimitWindow, NamedTokens, OsSource, TokenCounts } from '@/lib/types';
import { t, type Key } from '@/lib/i18n';
import { SERVICE_TOKENS_NAME } from '../../../shared/contract.ts';
import { AskClaude, ModelChip, modelColor } from './admin/parts';
import { DayTable, HourChart, metricKey, Section } from './analyticsParts';
import { KitAnalytics } from './KitAnalytics';

type Range = '1' | '7' | '30' | '90' | '365';
type Metric = 'sum' | 'input' | 'output' | 'cacheWrite' | 'cacheRead';

function metricValue(t: TokenCounts, m: Metric): number {
  return m === 'sum' ? tokenSum(t) : t[m];
}

function DayChart({ days, metric }: { days: DayTokens[]; metric: Metric }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = useMemo(() => days.map((d) => metricValue(d, metric)), [days, metric]);
  const max = Math.max(1, ...values);
  const today = toDay(new Date());
  const hot = hover != null ? days[hover] : null;
  const maxIndex = values.indexOf(Math.max(...values));
  const labelEvery = Math.max(1, Math.ceil(days.length / 8));

  return (
    <div className="relative">
      <div className="relative h-48 border-b border-line" onPointerLeave={() => setHover(null)}>
        <span className="absolute inset-x-0 top-0 h-px bg-line2" />
        <span className="absolute inset-x-0 top-1/2 h-px bg-line2" />
        <span className="absolute top-0.5 left-0 text-[10px] text-dim">{fmtTokens(max)}</span>
        <div className="absolute inset-0 flex items-end gap-0.5">
          {values.map((v, i) => (
            <div key={days[i].day} className="relative flex h-full min-w-0 flex-1 items-end" onPointerEnter={() => setHover(i)}>
              <i
                className={cn(
                  'mx-auto block min-h-px w-[min(100%,18px)] rounded-t-[3px] transition-colors duration-100',
                  days[i].day === today ? 'bg-accent' : hover === i ? 'bg-white/60' : 'bg-white/22',
                )}
                style={{ height: `${(v / max) * 100}%` }}
              />
            </div>
          ))}
        </div>
        {hot && hover != null && (
          <div
            role="tooltip"
            className="popover pointer-events-none absolute top-1 z-10 w-44 rounded-lg px-2.5 py-2 text-xs"
            style={hover < days.length / 2 ? { left: `calc(${((hover + 1) / days.length) * 100}% + 6px)` } : { right: `calc(${((days.length - hover) / days.length) * 100}% + 6px)` }}
          >
            <div className="mb-1 text-soft">{fmtDay(hot.day)}</div>
            {(['input', 'output', 'cacheWrite', 'cacheRead'] as const).map((k) => (
              <div key={k} className="flex justify-between gap-3 text-dim">
                <span>{t(metricKey[k])}</span>
                <span className="text-muted">{fmtTokens(hot[k])}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="mt-1 flex text-[10px] text-dim">
        {days.map((d, i) => (
          <span key={d.day} className="min-w-0 flex-1 overflow-visible whitespace-nowrap">
            {i % labelEvery === 0 ? fmtDay(d.day) : ''}
          </span>
        ))}
      </div>
      {values[maxIndex] > 0 && <p className="mt-2 text-xs text-dim">{t('an.peak', { day: fmtDay(days[maxIndex].day), value: fmtTokens(values[maxIndex]) })}</p>}
    </div>
  );
}

function RankTable({ rows, label, onRow, nameOf, emptyText, lead, colorOf, barColor }: { rows: NamedTokens[]; label: string; onRow?: (r: NamedTokens) => void; nameOf?: (r: NamedTokens) => string; emptyText: string; lead?: (r: NamedTokens) => ReactNode; colorOf?: (r: NamedTokens) => string; barColor?: (r: NamedTokens) => string }) {
  const [all, setAll] = useState(false);
  if (rows.length === 0) return <Empty>{emptyText}</Empty>;
  const sorted = rows.slice().sort((a, b) => tokenSum(b) - tokenSum(a));
  const shown = all ? sorted : sorted.slice(0, 10);
  const max = Math.max(1, tokenSum(sorted[0]));
  return (
    <>
      <table className="w-full table-fixed text-xs">
        <thead className="text-[11px] text-dim">
          <tr>
            <th className="w-[38%] py-1 text-left font-normal">{label}</th>
            <th className="py-1 text-right font-normal">{t('an.input')}</th>
            <th className="py-1 text-right font-normal">{t('an.output')}</th>
            <th className="py-1 text-right font-normal">{t('an.cacheWrite')}</th>
            <th className="py-1 text-right font-normal">{t('an.cacheRead')}</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => {
            const name = nameOf?.(r) ?? r.name;
            return (
              <tr key={`${r.name}${i}`} className="border-t border-line2 align-top">
                <td className="py-1.5 pr-3">
                  <span className="flex min-w-0 items-center gap-2">
                    {lead?.(r)}
                    {onRow ? (
                      <button type="button" onClick={() => onRow(r)} title={name} className="press block min-w-0 flex-1 truncate rounded text-left text-soft hover:text-accent">{name}</button>
                    ) : !lead || colorOf ? (
                      <span className="block min-w-0 flex-1 truncate text-soft" title={name}>{name}</span>
                    ) : null}
                  </span>
                  <div className="mt-1 h-1 rounded-[2px] bg-line2">
                    <i className="block h-full rounded-[2px]" style={{ width: `${(tokenSum(r) / max) * 100}%`, background: colorOf?.(r) ?? barColor?.(r) ?? 'rgba(255,255,255,.45)' }} />
                  </div>
                </td>
                <td className="py-1.5 text-right text-muted">{fmtTokens(r.input)}</td>
                <td className="py-1.5 text-right text-muted">{fmtTokens(r.output)}</td>
                <td className="py-1.5 text-right text-muted">{fmtTokens(r.cacheWrite)}</td>
                <td className="py-1.5 text-right text-dim">{fmtTokens(r.cacheRead)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {sorted.length > 10 && (
        <Button size="sm" variant="ghost" className="mt-2" onClick={() => setAll(!all)}>
          {all ? t('an.showTop') : t('an.showAll', { n: fmtInt(sorted.length) })}
        </Button>
      )}
    </>
  );
}

function Split({ a }: { a: Analytics }) {
  const main = tokenSum(a.main);
  const sub = tokenSum(a.subagents);
  const total = main + sub;
  const os = tokenSum(a.osShare);
  const totalAll = tokenSum(a.total);
  if (total === 0) return <Empty>{t('an.noTokens')}</Empty>;
  const mainPct = (main / total) * 100;
  const fmtPct = (x: number) => t('an.percent', { n: x < 1 && x > 0 ? '<1' : Math.round(x) });
  return (
    <div>
      <div className="flex h-3 gap-0.5" role="img" aria-label={t('an.mainPct', { main: fmtPct(mainPct), sub: fmtPct(100 - mainPct) })}>
        <i className="block rounded-l-[3px] bg-accent" style={{ width: `${mainPct}%` }} />
        <i className="block flex-1 rounded-r-[3px] bg-white/22" />
      </div>
      <div className="mt-1.5 flex justify-between text-xs">
        <span>
          <span className="text-dim">{t('an.mainSession')}</span> {fmtTokens(main)} · {fmtPct(mainPct)}
        </span>
        <span>
          <span className="text-dim">{t('an.subagents')}</span> {fmtTokens(sub)} · {fmtPct(100 - mainPct)}
        </span>
      </div>
      <p className="mt-3 text-xs text-dim">
        {t('an.osShare')} <span className="text-muted">{fmtTokens(os)}</span> · {t('an.osShareOf', { pct: fmtPct(totalAll > 0 ? (os / totalAll) * 100 : 0) })}
      </p>
    </div>
  );
}

const sourceKey: Record<OsSource, Key> = { root: 'an.src.root', service: 'an.src.service', microtask: 'an.src.microtask', widget: 'an.src.widget', 'crash-fix': 'an.src.crash-fix', ask: 'an.src.ask', setup: 'an.src.setup' };

/** Claude OS's own load: what it spent for itself, apart from the user's work in its tabs. */
function OsOwn({ a }: { a: Analytics }) {
  const own = a.bySource.reduce((n, s) => n + tokenSum(s), 0);
  const all = tokenSum(a.total);
  const pct = (x: number) => t('an.percent', { n: x < 1 && x > 0 ? '<1' : Math.round(x) });
  return (
    <Section icon={Bot} title={t('an.osOwn')} className="border-b border-line2" aside={own > 0 && <span className="text-xs text-dim">{t('an.osOwnTotal', { n: fmtTokens(own), pct: pct(all > 0 ? (own / all) * 100 : 0) })}</span>}>
      <RankTable
        rows={a.bySource}
        label={t('an.colSource')}
        emptyText={t('an.noOsOwn')}
        nameOf={(r) => {
          const key = sourceKey[r.name as OsSource];
          return `${key ? t(key) : r.name} · ${pct(all > 0 ? (tokenSum(r) / all) * 100 : 0)}`;
        }}
      />
    </Section>
  );
}

function windowLabel(w: { kind: string; label: string | null }): string {
  const base = w.kind === 'session' ? t('limits.session') : w.kind === 'weekly_all' ? t('limits.weekly') : w.kind === 'weekly_scoped' ? t('limits.weeklyScoped') : w.kind;
  return w.label ? `${base} · ${w.label}` : base;
}

function Limits({ windows, forecast }: { windows: LimitWindow[]; forecast: Forecast['windows'] }) {
  if (windows.length === 0) return <Empty>{t('limits.noWindows')}</Empty>;
  return (
    <div className="flex flex-col gap-3">
      {windows.map((w, i) => {
        const f = forecast.find((x) => x.kind === w.kind && x.label === w.label);
        const percent = w.percent ?? 0;
        const projected = f?.projected ?? null;
        const over = projected != null && projected >= 100;
        return (
          <div key={`${w.kind}${w.label}${i}`}>
            <div className="mb-1 flex items-baseline justify-between gap-3 text-xs">
              <span className="min-w-0 truncate text-soft">{windowLabel(w)}</span>
              <span className="flex-none text-muted">{w.percent == null ? t('common.noData') : `${Math.round(percent)} %`}</span>
            </div>
            <div className="relative h-1.5 overflow-hidden rounded-[3px] bg-white/10">
              {projected != null && <i className={cn('absolute inset-y-0 left-0 block rounded-[3px]', over ? 'bg-bad/35' : 'bg-white/20')} style={{ width: `${Math.min(100, projected)}%` }} />}
              <i className={cn('absolute inset-y-0 left-0 block rounded-[3px]', over ? 'bg-bad' : percent >= 70 ? 'bg-warn' : 'bg-accent')} style={{ width: `${Math.min(100, percent)}%` }} />
            </div>
            <div className="mt-1 flex flex-wrap justify-between gap-x-3 text-[11px] text-dim">
              <span>{w.resetsAt ? t('limits.resets', { at: fmtDateTime(w.resetsAt) }) : ''}</span>
              {f?.hitsAt ? <span className="text-bad">{t('an.limitHits', { at: fmtDateTime(f.hitsAt) })}</span> : projected != null ? <span>{t('an.limitProjected', { n: projected })}</span> : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ForecastRow({ f, weekly }: { f: Forecast; weekly: Forecast['windows'][number] | null }) {
  const cell = (label: string, value: string, hint?: string, tone?: string) => (
    <div className="min-w-0 border-r border-line2 px-5 py-3 last:border-r-0">
      <small className="block truncate text-[11.5px] text-muted">{label}</small>
      <b className={cn('mt-0.5 block text-lg leading-snug font-medium tracking-[-.02em]', tone)}>{value}</b>
      {hint && <small className="block truncate text-[11px] text-dim" title={hint}>{hint}</small>}
    </div>
  );
  return (
    <section aria-label={t('an.forecast')} className="border-b border-line2 bg-white/[.018]">
      <div className="flex flex-wrap items-center gap-2 px-5 pt-3">
        <h2 className="flex items-center gap-1.5 text-[12px] font-medium text-soft"><TrendingUp size={13} className="text-dim" />{t('an.forecast')}</h2>
        <span className="text-[11px] text-dim">{t('an.forecastBasis', { n: f.basisDays, avg: fmtTokens(f.dailyAverage), active: f.activeDays })}</span>
      </div>
      <div className="grid grid-cols-2 app:grid-cols-4">
        {cell(t('an.fcToday'), `≈ ${fmtTokens(f.todayProjected)}`, t('an.fcTodayNow', { n: fmtTokens(f.today) }))}
        {cell(t('an.fcWeek'), `≈ ${fmtTokens(f.weekProjected)}`)}
        {cell(t('an.fcMonth'), `≈ ${fmtTokens(f.monthProjected)}`)}
        {weekly?.projected != null
          ? cell(t('an.fcWeekly'), `≈ ${weekly.projected} %`, weekly.hitsAt ? t('an.limitHits', { at: fmtDateTime(weekly.hitsAt) }) : t('limits.resets', { at: fmtDateTime(weekly.resetsAt) }), weekly.hitsAt ? 'text-bad' : undefined)
          : cell(t('an.fcWeekly'), t('common.noData'), weekly ? t('an.fcTooEarly') : t('an.fcNoLimit'))}
      </div>
    </section>
  );
}

function Stat({ label, value, hint, hero, icon: Icon }: { label: string; value: string; hint?: string; hero?: boolean; icon: LucideIcon }) {
  return (
    <div className="min-w-0 border-r border-line2 px-5 py-4 last:border-r-0">
      <small className="flex items-center gap-1.5 text-[11.5px] text-muted">
        <Icon size={12} className={hero ? 'text-accent' : 'text-dim'} />
        <span className="truncate">{label}</span>
      </small>
      <b className={cn('mt-0.5 block tracking-[-.025em] [font-variant-numeric:normal]', hero ? 'text-[32px] leading-tight font-semibold' : 'text-xl leading-snug font-medium')}>{value}</b>
      {hint && <small className="block text-[11px] text-dim">{hint}</small>}
    </div>
  );
}

export function AnalyticsView() {
  const [range, setRange] = useState<Range>('30');
  const [metric, setMetric] = useState<Metric>('sum');
  const [tableView, setTableView] = useState(false);

  const { from, to } = useMemo(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - Number(range) + 1);
    return { from: toDay(start), to: toDay(end) };
  }, [range]);
  const analytics = useApi<Analytics>(`/api/analytics?from=${from}&to=${to}`, ['tokens']);
  const forecast = useApi<Forecast>('/api/admin/forecast', ['tokens', 'account']);
  const account = useAccount();
  const { color, keyOf } = useProjectColors();
  const showCost = useShowCost();
  const windows = account.data?.windows ?? [];
  const fc = forecast.data;
  const weekly = fc?.windows.find((w) => w.kind === 'weekly_all') ?? fc?.windows.find((w) => w.kind.startsWith('weekly')) ?? null;

  return (
    <div className="min-h-0 flex-1 overflow-auto">
      <header className="sheet-bar sticky top-0 z-20 flex flex-wrap items-center gap-3 border-b border-line2 px-5 py-2">
        <h1 className="flex items-center gap-2 text-sm font-medium"><BarChart3 size={15} className="text-dim" />{t('an.title')}</h1>
        <span className="text-xs text-dim">{t('an.subtitle')}</span>
        <span className="flex-1" />
        <Segmented
          ariaLabel={t('an.periodAria')}
          value={range}
          onChange={setRange}
          options={[
            { value: '1', label: t('an.today') },
            { value: '7', label: t('an.d7') },
            { value: '30', label: t('an.d30') },
            { value: '90', label: t('an.d90') },
            { value: '365', label: t('an.year') },
          ]}
        />
        {analytics.data && (
          <AskClaude
            task="admin-usage"
            vars={{ context: [
              `Range ${analytics.data.from} to ${analytics.data.to}: ${tokenSum(analytics.data.total)} tokens.`,
              `Projects: ${analytics.data.byProject.slice(0, 8).map((p) => `${p.name} ${tokenSum(p)}`).join(', ')}.`,
              `Models: ${analytics.data.byModel.map((m) => `${prettyModel(m.name)} ${tokenSum(m)}`).join(', ')}.`,
              `Subagents: ${tokenSum(analytics.data.subagents)}, main: ${tokenSum(analytics.data.main)}.`,
            ].join('\n') }}
          />
        )}
      </header>

      <div>
        <Boundary query={analytics} errorClassName="m-5" skeleton={<Skeleton className="p-5" lines={10} />}>
          {(a) => (
            <>
              <div className={cn('grid grid-cols-2 border-b border-line2', showCost ? 'app:grid-cols-[1.4fr_repeat(5,1fr)]' : 'app:grid-cols-[1.4fr_repeat(4,1fr)]')}>
                <Stat hero icon={Layers} label={a.from === a.to ? t('an.tokensDay', { day: fmtDay(a.from) }) : t('an.tokensRange', { from: fmtDay(a.from), to: fmtDay(a.to) })} value={fmtTokens(tokenSum(a.total))} hint={t('tokens.rangeLabel')} />
                <Stat icon={ArrowDownToLine} label={t('an.input')} value={fmtTokens(a.total.input)} />
                <Stat icon={ArrowUpFromLine} label={t('an.output')} value={fmtTokens(a.total.output)} />
                <Stat icon={HardDriveUpload} label={t('an.cacheWrite')} value={fmtTokens(a.total.cacheWrite)} />
                <Stat icon={DatabaseZap} label={t('an.cacheRead')} value={fmtTokens(a.total.cacheRead)} hint={t('an.notInSum')} />
                {showCost && <Stat icon={CircleDollarSign} label={t('an.cost')} value={a.costEquivalentUsd != null ? fmtUsd(a.costEquivalentUsd) : t('common.noData')} hint={t('an.costHint')} />}
              </div>

              {fc && (fc.activeDays > 0 || fc.windows.length > 0) && <ForecastRow f={fc} weekly={weekly} />}

              <Section
                className="border-b border-line2"
                icon={range === '1' ? Clock : CalendarDays}
                title={range === '1' ? t('an.byHour') : t('an.byDay')}
                aside={
                  <div className="flex flex-wrap items-center gap-2">
                    {range !== '1' && (
                      <Segmented
                        ariaLabel={t('an.metricAria')}
                        value={metric}
                        onChange={setMetric}
                        options={(Object.keys(metricKey) as Metric[]).map((m) => ({ value: m, label: t(metricKey[m]) }))}
                      />
                    )}
                    <Segmented
                      ariaLabel={t('an.viewAria')}
                      value={tableView ? 'table' : 'chart'}
                      onChange={(v) => setTableView(v === 'table')}
                      options={[
                        { value: 'chart', label: t('an.chart'), icon: ChartNoAxesColumn },
                        { value: 'table', label: t('an.table'), icon: Table2 },
                      ]}
                    />
                  </div>
                }
              >
                {a.byDay.every((d) => tokenSum(d) + d.cacheRead === 0) ? <Empty>{t('tokens.noRange')}</Empty> : tableView ? <DayTable days={a.byDay} /> : range === '1' && fc ? <HourChart hours={fc.todayHours} /> : <DayChart days={a.byDay} metric={metric} />}
              </Section>

              <div className="grid border-b border-line2 app:grid-cols-2">
                <Section icon={FolderKanban} title={t('an.byProject')} className="border-b border-line2 app:border-r app:border-b-0">
                  <RankTable
                    rows={a.byProject}
                    label={t('an.colProject')}
                    nameOf={(r) => (r.name === SERVICE_TOKENS_NAME ? t('an.service') : r.name)}
                    emptyText={t('an.noProjects')}
                    lead={(r) => { const key = keyOf(r.name); return <ProjectIcon project={key} name={r.name} color={color(key)} size={15} />; }}
                    colorOf={(r) => color(keyOf(r.name))}
                  />
                </Section>
                <div className="min-w-0">
                  <Section icon={Cpu} title={t('an.byModel')} className="border-b border-line2">
                    <RankTable rows={a.byModel} label={t('an.colModel')} nameOf={(r) => prettyModel(r.name)} emptyText={t('tokens.noModels')} lead={(r) => <ModelChip id={r.name} />} barColor={(r) => modelColor(r.name)} />
                  </Section>
                  <Section icon={GitFork} title={t('tokens.mainVsSub')}>
                    <Split a={a} />
                  </Section>
                </div>
              </div>

              <div className="grid border-b border-line2 app:grid-cols-[1.6fr_1fr]">
                <Section icon={ListOrdered} title={t('an.topSessions')} className="border-b border-line2 app:border-r app:border-b-0">
                  <RankTable
                    rows={a.topSessions}
                    label={t('an.colSession')}
                    emptyText={t('an.noSessions')}
                    nameOf={(r) => (r.name === (r as Analytics['topSessions'][number]).sessionId ? r.name.slice(0, 8) : r.name)}
                    onRow={(r) => {
                      const s = r as Analytics['topSessions'][number];
                      void openSession({ id: s.sessionId, project: s.project, cwd: '' });
                    }}
                    lead={(r) => <i className="block size-2 flex-none rounded-full" style={{ background: color((r as Analytics['topSessions'][number]).project) }} />}
                    colorOf={(r) => color((r as Analytics['topSessions'][number]).project)}
                  />
                </Section>
                <Section icon={Gauge} title={t('an.limits')}>
                  <Limits windows={windows} forecast={fc?.windows ?? []} />
                </Section>
              </div>

              <OsOwn a={a} />
            </>
          )}
        </Boundary>
        <KitAnalytics from={from} to={to} />
      </div>
    </div>
  );
}
