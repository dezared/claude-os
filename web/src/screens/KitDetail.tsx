import { ArrowUpCircle, ChartNoAxesColumn, History, LayoutTemplate, ListTree, Power, Table2, Trash2, Wrench } from 'lucide-react';
import { useRef, useState } from 'react';
import { ClaudeMark } from '@/components/ClaudeMark';
import { Fold } from '@/components/Motion';
import { Button, Select } from '@/components/ui';
import { spendNote } from '@/lib/account';
import { useFlip } from '@/lib/flip';
import { fmtDateTime } from '@/lib/format';
import { t } from '@/lib/i18n';
import { configureKit, kitDescription, kitUpdatable, type KitSet } from '@/lib/kitSets';
import { runKitTask } from '@/lib/projectKit';
import { useApp } from '@/lib/store';
import type { KitContents, KitHistoryEntry, KitProjectRow } from '../../../shared/projectKit.ts';
import { Section } from './analyticsParts';
import { BeforeAfter, Legend } from './KitCharts';
import { KitTable } from './KitAnalytics';

const openPlugin = (id: string) => useApp.getState().go({ kind: 'entity', type: 'os-plugin', id });

const PARTS = ['rules', 'agents', 'skills', 'checks', 'hooks'] as const;

function Contents({ c }: { c: KitContents }) {
  return (
    <dl className="grid gap-x-4 gap-y-1.5 text-xs app:grid-cols-[auto_1fr]">
      {c.claudeMd && <><dt className="text-dim">CLAUDE.md</dt><dd className="text-muted">{t('kits.claudeMd')}</dd></>}
      {PARTS.filter((k) => c[k].length > 0).map((k) => (
        <div key={k} className="contents">
          <dt className="text-dim">{t(`kits.part.${k}`)}</dt>
          <dd className="font-mono text-[11.5px] text-muted">{c[k].join(', ')}</dd>
        </div>
      ))}
      {c.docs.length > 0 && <><dt className="text-dim">{t('kits.part.docs')}</dt><dd className="text-muted">{t('kits.docsCount', { n: c.docs.length })}</dd></>}
    </dl>
  );
}

function ProjectRow({ p, set }: { p: KitProjectRow; set: KitSet }) {
  const latest = set.plugin.installedVersion ?? set.plugin.version;
  const behind = set.plugin.enabled && !!latest && p.kit?.version !== latest;
  return (
    <li data-flip={p.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-line2 py-1.5 text-xs first:border-t-0">
      <span className="min-w-0 flex-1 truncate text-soft">{p.name}</span>
      <span className="text-dim">v{p.kit?.version}{p.installedAt ? ` · ${t('kits.since', { day: fmtDateTime(p.installedAt) })}` : ''}</span>
      {set.plugin.enabled && (
        <span className="flex gap-1">
          <Button size="sm" variant={behind ? 'primary' : 'outline'} title={spendNote()} onClick={() => runKitTask(p.key, p.root, set.id)}>
            <ArrowUpCircle size={12} />{behind ? t('kit.updateTo', { version: latest }) : t('kits.reapply')}
          </Button>
          <Button size="sm" title={spendNote()} onClick={() => runKitTask(p.key, p.root, set.id, 'remove')}><Trash2 size={12} />{t('kits.remove')}</Button>
        </span>
      )}
    </li>
  );
}

function Projects({ set, all }: { set: KitSet; all: KitProjectRow[] }) {
  const list = useRef<HTMLUListElement>(null);
  useFlip(list);
  const others = all.filter((p) => p.kit?.id !== set.id);
  const add = (key: string | null) => {
    const p = others.find((o) => o.key === key);
    if (p) runKitTask(p.key, p.root, set.id);
  };
  return (
    <div>
      {set.projects.length === 0 ? <p className="text-xs text-dim">{t(set.plugin.enabled ? 'kits.noProjects' : 'kits.noProjectsOff')}</p> : (
        <ul ref={list} className="relative">{set.projects.map((p) => <ProjectRow key={p.key} p={p} set={set} />)}</ul>
      )}
      {set.plugin.enabled && others.length > 0 && (
        <div className="mt-2 max-w-xs">
          <Select
            ariaLabel={t('kits.applyTo')}
            value={null}
            onChange={add}
            options={[{ value: null, label: t('kits.applyTo') }, ...others.map((p) => ({ value: p.key, label: p.kit ? t('kits.switchFrom', { name: p.name, kit: p.kit.id }) : p.name }))]}
          />
        </div>
      )}
    </div>
  );
}

const ACTION_KEY = { install: 'kits.h.install', update: 'kits.h.update', remove: 'kits.h.remove' } as const;

export function HistoryList({ items, nameOf }: { items: KitHistoryEntry[]; nameOf: (key: string) => string }) {
  if (items.length === 0) return <p className="text-xs text-dim">{t('kits.noHistory')}</p>;
  return (
    <ol className="text-xs">
      {items.slice(0, 30).map((h) => (
        <li key={`${h.at}-${h.project}`} className="motion-fade flex gap-3 border-t border-line2 py-1 first:border-t-0">
          <span className="w-32 flex-none text-dim">{fmtDateTime(h.at)}</span>
          <span className="min-w-0 flex-1 truncate text-muted">{t(ACTION_KEY[h.action], { project: nameOf(h.project), kit: h.kit, version: h.version })}</span>
          <span className="flex-none text-dim">{t('kits.files', { n: h.files })}</span>
        </li>
      ))}
    </ol>
  );
}

function Metrics({ set }: { set: KitSet }) {
  const [table, setTable] = useState(false);
  const toggle = <Button size="sm" onClick={() => setTable(!table)}>{table ? <ChartNoAxesColumn size={12} /> : <Table2 size={12} />}{table ? t('kits.asCharts') : t('kits.asTable')}</Button>;
  return (
    <Section icon={ChartNoAxesColumn} title={t('kits.metrics')} className="border-t border-line2" aside={set.metrics.length > 0 && <div className="flex items-center gap-3">{!table && <Legend />}{toggle}</div>}>
      {set.metrics.length > 0 && <p className="-mt-1.5 mb-3 text-xs text-muted">{t('kits.metricsHint')}</p>}
      {set.metrics.length === 0 ? <p className="text-xs text-dim">{t(set.projects.length ? 'kits.noMetrics' : 'kits.noMetricsNoProjects')}</p> : table ? (
        <div className="motion-fade grid gap-5 app:grid-cols-2">{set.metrics.map((row) => <KitTable key={row.project} row={row} />)}</div>
      ) : <div className="motion-fade"><BeforeAfter rows={set.metrics} /></div>}
    </Section>
  );
}

/** The selected kit under the tiles: what it writes, its projects with their actions, its metrics and its history. */
export function KitDetail({ set, all }: { set: KitSet; all: KitProjectRow[] }) {
  const p = set.plugin;
  const nameOf = (key: string) => all.find((x) => x.key === key)?.name ?? key;
  const [history, setHistory] = useState(false);
  return (
    <div className="motion-fade rounded-xl border border-line2 bg-card">
      <header className="flex flex-wrap items-center gap-3 px-5 pt-4">
        <LayoutTemplate size={16} className="text-accent" />
        <h2 className="text-sm font-medium">{p.name}</h2>
        <span className="text-xs text-dim">{p.version ? `v${p.version}` : ''}</span>
        <span className="flex-1" />
        <Button size="sm" title={spendNote()} onClick={() => configureKit(set)}><ClaudeMark size={12} />{t('kits.configure')}</Button>
        {!p.enabled && <Button size="sm" variant="primary" disabled={p.errors.length > 0} onClick={() => openPlugin(p.id)}><Power size={12} />{t('osp.enable')}</Button>}
        {kitUpdatable(p) && <Button size="sm" variant="primary" onClick={() => openPlugin(p.id)}><Wrench size={12} />{t('osp.update')}</Button>}
      </header>
      {kitDescription(p) && <p className="px-5 pt-1 text-xs text-muted">{kitDescription(p)}</p>}
      <Fold show={p.errors.length > 0}><p className="px-5 pt-2 text-xs text-bad">{p.errors.join('; ')}</p></Fold>
      <div className="grid app:grid-cols-2">
        <Section icon={ListTree} title={t('kits.contents')}><Contents c={set.contents} /></Section>
        <Section icon={LayoutTemplate} title={t('kits.projects', { n: set.projects.length })}><Projects set={set} all={all} /></Section>
      </div>
      <Metrics set={set} />
      <Section icon={History} title={t('kits.historyCount', { n: set.history.length })} className="border-t border-line2" aside={set.history.length > 0 && <Button size="sm" aria-expanded={history} onClick={() => setHistory(!history)}>{history ? t('kits.hide') : t('kits.show')}</Button>}>
        {set.history.length === 0 ? <HistoryList items={[]} nameOf={nameOf} /> : <Fold show={history}><HistoryList items={set.history} nameOf={nameOf} /></Fold>}
      </Section>
    </div>
  );
}
