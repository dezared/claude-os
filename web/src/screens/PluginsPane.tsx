import { ArrowUpCircle, Bot, CirclePower, Moon, Package, Plug, Sparkles, Terminal, Webhook } from 'lucide-react';
import { useState } from 'react';
import { ContextArea } from '@/components/ContextMenu';
import { Boundary, Empty, Skeleton } from '@/components/states';
import { useApi } from '@/lib/api';
import { cn, fmtAgo, fmtInt } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useApp } from '@/lib/store';
import type { PluginAdminRow, PluginsReport } from '@/lib/types';
import { analyzeItem, pluginMenu } from './admin/menus';
import { Bar, PanelBar, ProjectGroups, Stat, StatStrip, Tag, type Scope } from './admin/parts';

function Brings({ icon: Icon, n, label }: { icon: typeof Plug; n: number; label: string }) {
  if (n === 0) return null;
  return <span title={label} className="inline-flex items-center gap-1 text-[11px] text-muted"><Icon size={11} className="text-dim" />{fmtInt(n)}</span>;
}

export function PluginRow({ p, maxRuns }: { p: PluginAdminRow; maxRuns: number }) {
  const open = () => useApp.getState().go({ kind: 'entity', type: 'plugin', id: p.id });
  return (
    <ContextArea items={() => pluginMenu(p)}>
    <div onClick={open} className={cn('grid cursor-pointer grid-cols-[minmax(0,1.3fr)_minmax(0,1.5fr)_150px_110px_90px] items-center gap-4 border-b border-line2 px-5 py-2 hover:bg-white/[.04]', !p.enabled && p.projects.length === 0 && 'opacity-60')}>
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <button type="button" className="press truncate rounded text-left text-soft">{p.name}</button>
          {p.version && <span className="flex-none font-mono text-[11px] text-dim">{p.version}</span>}
        </div>
        <div className="truncate text-[11px] text-dim" title={p.description ?? undefined}>{p.description ?? p.marketplace}</div>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {p.enabled ? <Tag tone="ok">{t('adm.pluginOn')}</Tag> : p.projects.length === 0 && <Tag>{t('adm.pluginOff')}</Tag>}
        {p.update === true && <Tag tone="accent" title={p.latest ?? undefined}>{p.latest ? t('adm.updateTo', { v: p.latest }) : t('adm.updateAvailable')}</Tag>}
        {p.projects.slice(0, 2).map((x) => <Tag key={x.name}>{x.name}</Tag>)}
        {p.projects.length > 2 && <span className="text-[11px] text-dim" title={p.projects.map((x) => x.name).join(', ')}>{t('adm.more', { n: p.projects.length - 2 })}</span>}
      </div>
      <span className="flex items-center gap-2.5">
        <Brings icon={Sparkles} n={p.skills} label={t('adm.bringsSkills')} />
        <Brings icon={Plug} n={p.mcp} label={t('adm.bringsMcp')} />
        <Brings icon={Webhook} n={p.hooks} label={t('adm.bringsHooks')} />
        <Brings icon={Bot} n={p.agents} label={t('adm.bringsAgents')} />
        <Brings icon={Terminal} n={p.commands} label={t('adm.bringsCommands')} />
      </span>
      <span className="text-right text-xs" title={t('adm.skillsUsedOf', { used: fmtInt(p.skillsUsed), n: fmtInt(p.skills) })}>
        <span className={p.runs > 0 ? 'text-soft' : 'text-dim'}>{p.skills > 0 ? `${fmtInt(p.skillsUsed)} / ${fmtInt(p.skills)}` : '–'}</span>
        <Bar className="mt-0.5" value={p.runs} max={maxRuns} color="var(--color-accent)" />
      </span>
      <span className="text-right text-[11px] text-dim">{p.updatedAt ? fmtAgo(p.updatedAt) : ''}</span>
    </div>
    </ContextArea>
  );
}

export function PluginsPane() {
  const q = useApi<PluginsReport>('/api/admin/plugins', ['skills', 'settings']);
  const [scope, setScope] = useState<Scope>('global');
  const items = () => {
    const r = q.data;
    if (!r) return [];
    const enabled = r.rows.filter((p) => p.enabled);
    const idle = enabled.filter((p) => p.skills > 0 && p.runs === 0);
    const updates = r.rows.filter((p) => p.update === true);
    const context = [`${r.rows.length} plugins, ${enabled.length} enabled globally.`, `Updates known: ${updates.map((p) => `${p.name} ${p.version} -> ${p.latest ?? '?'}`).join(', ') || 'none'}.`, `Enabled with no skill run in ${r.windowDays} days: ${idle.map((p) => p.name).join(', ') || 'none'}.`, `All: ${r.rows.map((p) => `${p.id} ${p.version ?? ''}`).join(', ')}.`].join('\n');
    return [analyzeItem(t('ent.analyzePlugins'), 'plugin list', 'Claude Code plugins', context, [t('ent.presetPluginsIdle'), t('ent.presetPluginsUpdate'), t('ent.presetPluginsOverlap')])];
  };
  return (
    <ContextArea items={items} className="min-h-0 flex-1 overflow-auto">
      <Boundary query={q} skeleton={<Skeleton className="p-5" lines={8} />}>
        {(r) => {
          const enabled = r.rows.filter((p) => p.enabled);
          const updates = r.rows.filter((p) => p.update === true);
          const unknown = r.rows.filter((p) => p.update === null).length;
          const idle = enabled.filter((p) => p.skills > 0 && p.runs === 0);
          const skills = r.rows.reduce((a, p) => a + p.skills, 0);
          const maxRuns = Math.max(1, ...r.rows.map((p) => p.runs));
          return (
            <>
              <PanelBar scope={scope} onScope={setScope} />
              {scope === 'projects' ? (
                <ProjectGroups rows={r.projects} unit={t('adm.unitPlugins')} empty={t('adm.noProjectPlugins')}>
                  {(d) => r.rows.filter((p) => d.own.includes(p.name) || d.overrides.includes(p.name)).map((p) => <PluginRow key={p.id} p={p} maxRuns={maxRuns} />)}
                </ProjectGroups>
              ) : r.rows.length === 0 ? <Empty className="m-5" icon={Package}>{t('adm.noPlugins')}</Empty> : (
                <>
                  <StatStrip cols={5}>
                    <Stat hero icon={Package} tone="accent" label={t('adm.pluginsTotal')} value={fmtInt(r.rows.length)} />
                    <Stat icon={CirclePower} tone="ok" label={t('adm.pluginsEnabled')} value={fmtInt(enabled.length)} hint={t('adm.pluginsEnabledHint')} />
                    <Stat icon={Sparkles} label={t('adm.pluginsSkills')} value={fmtInt(skills)} />
                    <Stat icon={Moon} label={t('adm.pluginsIdle', { n: r.windowDays })} value={fmtInt(idle.length)} hint={t('adm.pluginsIdleHint')} />
                    <Stat icon={ArrowUpCircle} tone={updates.length ? 'accent' : undefined} label={t('adm.updates')} value={fmtInt(updates.length)} hint={unknown > 0 ? t('adm.updatesUnknown', { n: fmtInt(unknown) }) : t('adm.updatesLocal')} />
                  </StatStrip>
                  <div className="sheet-bar sticky top-11 z-[5] grid grid-cols-[minmax(0,1.3fr)_minmax(0,1.5fr)_150px_110px_90px] gap-4 border-b border-line2 px-5 py-1.5 text-[11px] text-dim">
                    <span>{t('adm.colPlugin')}</span>
                    <span>{t('adm.colState')}</span>
                    <span>{t('adm.colBrings')}</span>
                    <span className="text-right">{t('adm.colSkillsUsed', { n: r.windowDays })}</span>
                    <span className="text-right">{t('adm.colUpdated')}</span>
                  </div>
                  {r.rows.map((p) => <PluginRow key={p.id} p={p} maxRuns={maxRuns} />)}
                </>
              )}
            </>
          );
        }}
      </Boundary>
    </ContextArea>
  );
}
