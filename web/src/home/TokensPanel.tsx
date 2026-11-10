import { ArrowUpRight, Bot, Sparkles, Split } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ContextArea } from '@/components/ContextMenu';
import { Boundary, Empty, Skeleton } from '@/components/states';
import { SectionTitle } from '@/components/ui';
import { useApi } from '@/lib/api';
import { cn, fmtDay, fmtInt, fmtTokens, tokenSum, toDay } from '@/lib/format';
import { prettyModel } from '@/lib/model-name';
import { useApp } from '@/lib/store';
import type { Analytics, DayTokens, Skill } from '@/lib/types';
import { t } from '@/lib/i18n';
import { skillMenu } from '@/screens/admin/menus';

function DayBars({ days }: { days: DayTokens[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = useMemo(() => days.map(tokenSum), [days]);
  const max = Math.max(1, ...values);
  const today = toDay(new Date());
  const shown = hover != null ? days[hover] : null;
  return (
    <div>
      <div className="relative flex h-18 items-end gap-0.75" onPointerLeave={() => setHover(null)}>
        {values.map((v, i) => (
          <div key={days[i].day} className="relative flex h-full min-w-0 flex-1 items-end" onPointerEnter={() => setHover(i)}>
            <i
              className={cn(
                'block min-h-px w-full rounded-t-[2px] transition-colors duration-100',
                i === values.length - 1 ? 'bg-accent' : hover === i ? 'bg-white/60' : 'bg-white/20',
              )}
              style={{ height: `${(v / max) * 100}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-between text-[11px] text-dim">
        {shown ? (
          <span className="text-muted">
            {fmtDay(shown.day)} · {fmtTokens(tokenSum(shown))}
          </span>
        ) : (
          <>
            <span>{fmtDay(days[0].day)}</span>
            <span>{days.at(-1)?.day === today ? t('tokens.today') : fmtDay(days.at(-1)!.day)}</span>
          </>
        )}
      </div>
    </div>
  );
}

function MainVsSub({ a }: { a: Analytics }) {
  const main = tokenSum(a.main);
  const sub = tokenSum(a.subagents);
  const total = main + sub;
  if (total === 0) return null;
  return (
    <section>
      <SectionTitle><Split size={11} className="mr-1 inline align-[-1px] text-[#8da9c9]" />{t('tokens.mainVsSub')}</SectionTitle>
      <div className="mb-2 flex h-1.5 gap-0.5">
        <i className="block rounded-l-[2px] bg-accent" style={{ width: `${(main / total) * 100}%` }} />
        <i className="block flex-1 rounded-r-[2px] bg-white/25" />
      </div>
      <div className="flex justify-between text-[11.5px]">
        <span className="text-muted">
          <span className="text-dim">{t('tokens.main')}</span> {fmtTokens(main)}
        </span>
        <span className="text-muted">
          <span className="text-dim">{t('tokens.sub')}</span> {fmtTokens(sub)}
        </span>
      </div>
    </section>
  );
}

function TopSkills() {
  const skills = useApi<Skill[]>('/api/skills', ['skills']);
  return (
    <section>
      <SectionTitle><Sparkles size={11} className="mr-1 inline align-[-1px] text-[#e6c07b]" />{t('tokens.skillRuns')}</SectionTitle>
      <Boundary query={skills} skeleton={<Skeleton lines={3} />}>
        {(list) => {
          const top = list.filter((s) => s.usageCount > 0).sort((a, b) => b.usageCount - a.usageCount).slice(0, 3);
          if (top.length === 0) return <Empty>{t('tokens.noSkillRuns')}</Empty>;
          const max = top[0].usageCount;
          return top.map((s, i) => (
            <div key={s.id} className="mb-2 grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-0.5">
              <ContextArea items={() => skillMenu(s)}><span className="truncate text-soft">{s.name}</span></ContextArea>
              <span className="text-[11.5px] text-muted">{fmtInt(s.usageCount)}</span>
              <div className="col-span-2 h-0.5 rounded-[1px] bg-white/10">
                <i className={cn('block h-full rounded-[1px]', i === 0 ? 'bg-accent' : 'bg-white/45')} style={{ width: `${(s.usageCount / max) * 100}%` }} />
              </div>
            </div>
          ));
        }}
      </Boundary>
    </section>
  );
}

/** In the widget's title: the way to the full picture, or the total when the widget is collapsed. */
export function TokensHead({ collapsed }: { collapsed: boolean }) {
  const analytics = useApi<Analytics>('/api/analytics', ['tokens']);
  const go = useApp((s) => s.go);
  if (collapsed) return analytics.data ? <span className="flex-none text-[11.5px] text-muted">{fmtTokens(tokenSum(analytics.data.total))}</span> : null;
  return (
    <button type="button" onClick={() => go({ kind: 'analytics' })} className="press flex flex-none items-center gap-0.5 rounded px-1 text-[11.5px] text-muted hover:text-fg">
      {t('nav.analytics')}
      <ArrowUpRight size={12} />
    </button>
  );
}

export function TokensPanel() {
  const analytics = useApi<Analytics>('/api/analytics', ['tokens']);

  return (
    <aside className="flex min-h-0 w-full flex-1 flex-col">
        <div className="panel-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-auto px-3.5 pb-3.5">
          <section>
            <Boundary query={analytics} skeleton={<Skeleton lines={3} />}>
              {(a) => {
                const total = tokenSum(a.total);
                return (
                  <>
                    <div className="text-[26px] leading-[1.15] font-semibold tracking-[-.025em] [font-variant-numeric:normal]">{fmtTokens(total)}</div>
                    <div className="mb-2.5 text-[11px] text-muted">
                      {fmtDay(a.from)} – {fmtDay(a.to)} · {t('tokens.rangeLabel')}
                    </div>
                    {a.byDay.length > 0 ? <DayBars days={a.byDay} /> : <Empty>{t('tokens.noRange')}</Empty>}
                  </>
                );
              }}
            </Boundary>
          </section>

          {analytics.data && (
            <>
              <section>
                <SectionTitle><Bot size={11} className="mr-1 inline align-[-1px] text-[#8fb8a0]" />{t('tokens.modelOutput')}</SectionTitle>
                {analytics.data.byModel.length === 0 ? (
                  <Empty>{t('tokens.noModels')}</Empty>
                ) : (
                  analytics.data.byModel
                    .slice()
                    .sort((x, y) => y.output - x.output)
                    .slice(0, 4)
                    .map((m) => (
                      <div key={m.name} className="flex items-center gap-2 py-0.5">
                        <span className="min-w-0 flex-1 truncate text-soft">{prettyModel(m.name)}</span>
                        <span className="text-[11.5px] text-muted">{fmtTokens(m.output)}</span>
                      </div>
                    ))
                )}
              </section>
              <MainVsSub a={analytics.data} />
            </>
          )}
          <TopSkills />
        </div>
    </aside>
  );
}
