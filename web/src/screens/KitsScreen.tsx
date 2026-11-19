import { History, LayoutTemplate, MousePointerClick, Plus, Power, Settings2, Wrench } from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { ClaudeMark } from '@/components/ClaudeMark';
import { ContextArea } from '@/components/ContextMenu';
import { Boundary, Skeleton } from '@/components/states';
import { Segmented } from '@/components/ui';
import type { MenuItem } from '@/home/ActionMenu';
import { spendNote } from '@/lib/account';
import { useFlip } from '@/lib/flip';
import { cn, fmtDateTime, toDay } from '@/lib/format';
import { t } from '@/lib/i18n';
import { configureKit, createKit, kitDescription, kitUpdatable, meanAfter, useKitSets, type KitSet } from '@/lib/kitSets';
import { useApp } from '@/lib/store';
import type { KitMetric } from '../../../shared/projectKit.ts';
import { Tag } from './admin/parts';
import { Section } from './analyticsParts';
import { FORMAT, KitAnalytics } from './KitAnalytics';
import { Better, Glossary, HowToRead, metricTip, type Explained } from './KitGuide';
import { HistoryList, KitDetail } from './KitDetail';

type Range = '30' | '90' | '365';

const TILE = 'press group relative flex min-h-44 flex-col gap-2 rounded-xl border p-4 text-left transition-[border-color,background-color,box-shadow] duration-150';
const openPlugin = (id: string) => useApp.getState().go({ kind: 'entity', type: 'os-plugin', id });
const select = (id?: string) => useApp.getState().go({ kind: 'kits', id });

function useRange(range: Range) {
  return useMemo(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - Number(range) + 1);
    return { from: toDay(start), to: toDay(end) };
  }, [range]);
}

function State({ set }: { set: KitSet }) {
  const p = set.plugin;
  if (p.errors.length > 0) return <Tag tone="bad">{t('osp.invalid')}</Tag>;
  if (!p.enabled) return <Tag>{t('adm.pluginOff')}</Tag>;
  if (kitUpdatable(p)) return <Tag tone="accent">{t('osp.update')}</Tag>;
  return <Tag tone="ok">{t('adm.pluginOn')}</Tag>;
}

/** A labelled number with a caption under it: which way is better, or why there is no number yet. */
function Figure({ label, value, caption, title }: { label: string; value: string | null; caption: ReactNode; title: string }) {
  return (
    <div className="min-w-0 rounded-lg bg-fg/[.035] px-2 py-1.5" title={title}>
      <div className="truncate text-[10.5px] text-dim">{label}</div>
      <div className={cn('motion-fade truncate font-medium tracking-[-.02em]', value == null ? 'text-[12px] leading-[22px] text-dim' : 'text-[15px] text-soft')} key={value}>{value ?? t('kits.noData')}</div>
      <div className="truncate">{caption}</div>
    </div>
  );
}

const TILE_METRICS: { m: KitMetric & Explained; key: 'kits.tile.cache' | 'kits.tile.gate' | 'kits.tile.redStops' }[] = [
  { m: 'cacheHit', key: 'kits.tile.cache' },
  { m: 'loopB50', key: 'kits.tile.gate' },
  { m: 'redStops', key: 'kits.tile.redStops' },
];

function tileItems(set: KitSet): MenuItem[] {
  const p = set.plugin;
  return [
    { id: 'kits.configure', label: t('kits.configure'), icon: Settings2, title: spendNote(), onSelect: () => configureKit(set) },
    ...(kitUpdatable(p) ? [{ id: 'osp.update', label: t('osp.update'), icon: Wrench, onSelect: () => openPlugin(p.id) }] : []),
    { id: 'kits.plugin', label: p.enabled ? t('kits.pluginPage') : t('osp.enable'), icon: Power, disabled: !p.enabled && p.errors.length > 0, onSelect: () => openPlugin(p.id) },
  ];
}

function Tile({ set, on }: { set: KitSet; on: boolean }) {
  const p = set.plugin;
  const c = set.contents;
  const last = set.history[0];
  const parts = [c.claudeMd && 'CLAUDE.md', ...(['rules', 'agents', 'skills', 'checks', 'hooks'] as const).filter((k) => c[k].length).map((k) => `${t(`kits.part.${k}`)} ${c[k].length}`)].filter(Boolean);
  return (
    <ContextArea items={tileItems(set)} className="contents">
      <button
        type="button"
        data-flip={set.id}
        aria-pressed={on}
        onClick={() => select(on ? undefined : set.id)}
        className={cn(TILE, on ? 'border-accent bg-accent-bg' : 'border-line2 bg-card hover:border-line hover:bg-fg/[.03]', !p.enabled && 'opacity-80')}
      >
        <span className="flex items-center gap-2">
          <LayoutTemplate size={16} className={set.isDefault ? 'text-accent' : 'text-dim'} />
          <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{p.name}</span>
          {set.isDefault && <Tag tone="accent">{t('kits.default')}</Tag>}
          <State set={set} />
        </span>
        <span className="line-clamp-2 text-xs text-muted">{kitDescription(p) ?? ''}</span>
        <span className="truncate text-[11px] text-dim" title={parts.join(' · ')}>{parts.join(' · ')}</span>
        <span className="mt-auto grid grid-cols-2 gap-1.5 pt-1">
          <Figure label={t('kits.tile.projects')} title={t('kits.tile.projectsTip')} value={String(set.projects.length)} caption={<span className="text-[10.5px] text-dim">{t('kits.tile.projectsCaption')}</span>} />
          {TILE_METRICS.map(({ m, key }) => {
            const v = meanAfter(set.metrics, m);
            return <Figure key={m} label={t(key)} title={`${t(`an.kit.m.${m}`)}\n\n${metricTip(m)}${v == null ? `\n\n${t('kits.noDataTip')}` : ''}`} value={v == null ? null : FORMAT[m](v)} caption={<Better m={m} />} />;
          })}
        </span>
        <span className="truncate text-[10.5px] text-dim">
          {last ? t('kits.tile.last', { when: fmtDateTime(last.at), version: last.version }) : t('kits.tile.version', { version: p.version ?? '?' })}
        </span>
      </button>
    </ContextArea>
  );
}

function CreateTile({ sets }: { sets: KitSet[] }) {
  return (
    <button type="button" data-flip="create" title={spendNote()} onClick={() => createKit(sets)} className={cn(TILE, 'items-center justify-center border-dashed border-line text-muted hover:border-dim hover:text-fg')}>
      <Plus size={18} />
      <span className="flex items-center gap-1.5 text-[13px]">{t('kits.create')}<ClaudeMark size={11} /></span>
      <span className="max-w-60 text-center text-[11px] text-dim">{t('kits.createHint')}</span>
    </button>
  );
}

/** The project kits: a tile per kit (up to five), the selected one opened below, and the history of every apply. */
export function KitsScreen({ selected }: { selected?: string }) {
  const [range, setRange] = useState<Range>('30');
  const { from, to } = useRange(range);
  const [guide, setGuide] = useState(false);
  const q = useKitSets(from, to);
  const grid = useRef<HTMLDivElement>(null);
  useFlip(grid);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-none border-b border-line2 px-5 py-2">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 py-1">
          <h1 className="flex items-center gap-2 text-sm font-medium"><LayoutTemplate size={15} className="text-dim" />{t('kits.title')}</h1>
          <p className="min-w-60 flex-1 text-xs text-muted">{t('kits.subtitle')}</p>
          <HowToRead open={guide} onToggle={() => setGuide(!guide)} />
          <Segmented ariaLabel={t('an.periodAria')} value={range} onChange={setRange} options={[{ value: '30', label: t('an.d30') }, { value: '90', label: t('an.d90') }, { value: '365', label: t('an.year') }]} />
        </div>
        <Glossary show={guide} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        <Boundary query={q} errorClassName="m-5" skeleton={<Skeleton className="p-5" lines={8} />}>
          {(v) => {
            const set = v.sets.find((s) => s.id === selected) ?? null;
            const nameOf = (key: string) => v.projects.find((p) => p.key === key)?.name ?? key;
            return (
              <div className="flex flex-col gap-4 p-5">
                <div ref={grid} className="relative grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-3">
                  {v.sets.map((s) => <Tile key={s.id} set={s} on={s.id === selected} />)}
                  {v.canCreate && <CreateTile sets={v.sets} />}
                </div>
                {set ? <KitDetail key={set.id} set={set} all={v.projects} /> : (
                  <>
                    {v.sets.length > 0 && <p className="motion-fade flex items-center gap-2 text-xs text-dim"><MousePointerClick size={13} />{t('kits.pickHint')}</p>}
                    <Section icon={History} title={t('kits.history')} className="motion-fade rounded-xl border border-line2 bg-card"><HistoryList items={v.history} nameOf={nameOf} /></Section>
                    <KitAnalytics from={from} to={to} />
                  </>
                )}
              </div>
            );
          }}
        </Boundary>
      </div>
    </div>
  );
}
