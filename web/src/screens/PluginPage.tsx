import { ArrowUpCircle, Bot, Play, Plug, Sparkles, Terminal, Webhook } from 'lucide-react';
import { Skeleton } from '@/components/states';
import { useApi } from '@/lib/api';
import { fmtInt } from '@/lib/format';
import { t } from '@/lib/i18n';
import type { HooksReport, McpReport, PluginAdminRow, PluginsReport, SkillsReport } from '@/lib/types';
import { Facts, Section, when } from './admin/entityParts';
import { pluginContext, pluginMenu } from './admin/menus';
import { Stat, StatStrip, Tag } from './admin/parts';
import { EntityShell, type EntityPageProps } from './EntityPage';
import { HookLine } from './HooksPane';
import { ServerRow } from './McpPane';
import { SkillRow } from './SkillsPane';

function Body({ p, windowDays }: { p: PluginAdminRow; windowDays: number }) {
  const skills = useApi<SkillsReport>(p.skills > 0 ? '/api/admin/skills' : null, ['skills', 'usage']);
  const hooks = useApi<HooksReport>(p.hooks > 0 ? '/api/admin/hooks' : null, ['settings', 'skills']);
  const mcp = useApi<McpReport>(p.mcp > 0 ? '/api/admin/mcp' : null, ['mcp']);
  const ownSkills = (skills.data?.rows ?? []).filter((s) => s.scope === 'plugin' && s.source === p.name).sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
  const ownHooks = (hooks.data?.rows ?? []).filter((h) => h.plugin === p.name);
  const ownServers = (mcp.data?.rows ?? []).filter((r) => r.where.plugin === p.name);
  const maxRuns = Math.max(1, ...ownSkills.map((s) => s.runs));
  const maxCalls = Math.max(1, ...ownServers.map((r) => r.calls));
  return (
    <>
      {p.description && <p className="selectable mb-4 max-w-3xl text-[13px] leading-[1.55] text-soft">{p.description}</p>}
      <Facts rows={[
        [t('ent.scope'), p.enabled ? t('ent.scopeGlobalHint') : p.projects.length > 0 ? p.projects.map((x) => x.name).join(', ') : t('adm.pluginOff')],
        [t('ent.version'), p.version],
        [t('adm.updates'), p.update === true ? <Tag tone="accent">{p.latest ? t('adm.updateTo', { v: p.latest }) : t('adm.updateAvailable')}</Tag> : null],
        [t('ent.marketplace'), p.marketplace],
        [t('ent.author'), p.author],
        [t('ent.license'), p.license],
        [t('ent.homepage'), p.homepage],
        [t('ent.installed'), when(p.installedAt)],
        [t('ent.updated'), when(p.updatedAt)],
      ]} />
      <div className="mb-5 border-t border-line2">
        <StatStrip cols={4}>
          <Stat icon={Play} tone="accent" label={t('adm.runsIn', { n: windowDays })} value={fmtInt(p.runs)} hint={t('adm.fromJournals')} />
          <Stat icon={Sparkles} label={t('adm.colSkillsUsed', { n: windowDays })} value={`${fmtInt(p.skillsUsed)} / ${fmtInt(p.skills)}`} />
          <Stat icon={Plug} label={t('adm.bringsMcp')} value={fmtInt(p.mcp)} />
          <Stat icon={Webhook} label={t('adm.bringsHooks')} value={fmtInt(p.hooks)} />
          {p.agents > 0 && <Stat icon={Bot} label={t('adm.bringsAgents')} value={fmtInt(p.agents)} />}
          {p.commands > 0 && <Stat icon={Terminal} label={t('adm.bringsCommands')} value={fmtInt(p.commands)} />}
          {p.update === true && <Stat icon={ArrowUpCircle} tone="accent" label={t('adm.updates')} value={p.latest ?? '?'} />}
        </StatStrip>
      </div>
      {ownSkills.length > 0 && <Section title={t('tools.skills')} icon={Sparkles}><div className="border-t border-line2">{ownSkills.map((s) => <SkillRow key={s.id} s={s} maxRuns={maxRuns} />)}</div></Section>}
      {ownServers.length > 0 && <Section title={t('tools.mcp')} icon={Plug}><div className="border-t border-line2">{ownServers.map((r) => <ServerRow key={r.name} row={r} maxCalls={maxCalls} />)}</div></Section>}
      {ownHooks.length > 0 && <Section title={t('tools.hooks')} icon={Webhook}><div className="border-t border-line2">{ownHooks.map((h, i) => <HookLine key={i} h={h} />)}</div></Section>}
    </>
  );
}

export default function PluginPage(props: EntityPageProps) {
  const report = useApi<PluginsReport>('/api/admin/plugins', ['skills', 'settings']);
  const rows = report.data?.rows ?? [];
  const p = rows.find((x) => x.id === props.id) ?? rows.find((x) => x.name === props.id);
  return (
    <EntityShell {...props} title={p?.name} context={p && pluginContext(p)} menu={p && pluginMenu(p, { page: true })}>
      {p ? <Body key={p.id} p={p} windowDays={report.data!.windowDays} /> : report.data ? <p className="text-xs text-muted">{t('entity.noDetails')}</p> : <Skeleton lines={6} />}
    </EntityShell>
  );
}
