import { Activity, Bot, CalendarClock, Coins, History as HistoryIcon, Layers, MessageSquarePlus, Package, Plug, Sparkles, SquareKanban, Webhook, Library } from 'lucide-react';
import { Skeleton } from '@/components/states';
import { Button } from '@/components/ui';
import { useApi } from '@/lib/api';
import { fmtAgo, fmtInt, fmtTokens } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useApp } from '@/lib/store';
import { createTab, openSession } from '@/lib/tabs';
import { KitStatusRow } from '@/work/KitStatusRow';
import type { AgentsReport, EntityStats, HooksReport, McpReport, PluginsReport, Project, SessionInfo, SkillsReport } from '@/lib/types';
import { Facts, Section, UsageSections, when } from './admin/entityParts';
import { writeSkill } from './admin/menus';
import { ModelChip, Stat, StatStrip } from './admin/parts';
import { AgentRowItem } from './AgentsPane';
import { EntityShell, type EntityPageProps } from './EntityPage';
import { HookLine } from './HooksPane';
import { ServerRow } from './McpPane';
import { PluginRow } from './PluginsPane';
import { SessionTags } from './SessionTags';
import { SkillRow } from './SkillsPane';

const TAGGED_SESSIONS = 10;

function Tools({ p }: { p: Project }) {
  const skills = useApi<SkillsReport>('/api/admin/skills', ['skills', 'usage']);
  const mcp = useApi<McpReport>('/api/admin/mcp', ['mcp']);
  const hooks = useApi<HooksReport>('/api/admin/hooks', ['settings', 'skills']);
  const plugins = useApi<PluginsReport>('/api/admin/plugins', ['skills', 'settings']);
  const agents = useApi<AgentsReport>('/api/agents', ['agents', 'sessions']);
  const ownAgents = (agents.data?.rows ?? []).filter((a) => a.scope === 'project' && a.source === p.key);
  const ownSkills = (skills.data?.rows ?? []).filter((s) => s.scope === 'project' && s.source === p.key);
  const servers = (mcp.data?.rows ?? []).filter((r) => r.definitions.some((d) => d.project === p.key || d.project === p.root));
  const ownHooks = (hooks.data?.rows ?? []).filter((h) => h.project === p.key || h.project === p.root);
  const diff = plugins.data?.projects.find((x) => x.project === p.key);
  const ownPlugins = (plugins.data?.rows ?? []).filter((x) => diff && (diff.own.includes(x.name) || diff.overrides.includes(x.name)));
  const maxRuns = Math.max(1, ...ownSkills.map((s) => s.runs));
  const maxCalls = Math.max(1, ...servers.map((r) => r.calls));
  const maxPluginRuns = Math.max(1, ...ownPlugins.map((x) => x.runs));
  return (
    <>
      {ownSkills.length > 0 && <Section title={t('tools.skills')} icon={Sparkles}><div className="border-t border-line2">{ownSkills.map((s) => <SkillRow key={s.id} s={s} maxRuns={maxRuns} />)}</div></Section>}
      {ownAgents.length > 0 && <Section title={t('tools.agents')} icon={Bot}><div className="border-t border-line2">{ownAgents.map((a) => <AgentRowItem key={a.id} a={a} maxRuns={Math.max(1, ...ownAgents.map((x) => x.runs))} />)}</div></Section>}
      {servers.length > 0 && <Section title={t('tools.mcp')} icon={Plug}><div className="border-t border-line2">{servers.map((r) => <ServerRow key={r.name} row={r} maxCalls={maxCalls} />)}</div></Section>}
      {ownHooks.length > 0 && <Section title={t('tools.hooks')} icon={Webhook}><div className="border-t border-line2">{ownHooks.map((h, i) => <HookLine key={i} h={h} />)}</div></Section>}
      {ownPlugins.length > 0 && <Section title={t('tools.plugins')} icon={Package}><div className="border-t border-line2">{ownPlugins.map((x) => <PluginRow key={x.id} p={x} maxRuns={maxPluginRuns} />)}</div></Section>}
    </>
  );
}

/** Only where there is something to tell: sessions from claudeOS/root, or those that changed Claude OS itself. */
function TaggedSessions({ p }: { p: Project }) {
  const sessions = useApi<SessionInfo[]>(`/api/sessions?project=${encodeURIComponent(p.key)}`, ['sessions']);
  const tagged = (sessions.data ?? []).filter((s) => s.rootFolder || s.osChanges).sort((a, b) => (b.lastActivity ?? 0) - (a.lastActivity ?? 0)).slice(0, TAGGED_SESSIONS);
  if (tagged.length === 0) return null;
  return (
    <Section title={t('ent.osSessions')} icon={Layers}>
      <div className="border-t border-line2">
        {tagged.map((s) => (
          <button key={s.id} type="button" onClick={() => void openSession(s)} className="press flex w-full items-center gap-2 border-b border-line2 py-1.5 text-left text-xs hover:bg-white/[.04]">
            <span className="min-w-0 flex-1 truncate text-soft">{s.title ?? s.name ?? s.lastPrompt ?? s.id}</span>
            <SessionTags s={s} />
            <span className="w-20 flex-none text-right text-dim">{fmtAgo(s.lastActivity)}</span>
          </button>
        ))}
      </div>
    </Section>
  );
}

function Body({ p }: { p: Project }) {
  const stats = useApi<EntityStats>(`/api/admin/entity?type=project&id=${encodeURIComponent(p.key)}`, ['tokens', 'projects']);
  const s = stats.data;
  return (
    <>
      <Facts rows={[
        [t('ent.folder'), <code className="font-mono text-[11.5px]">{p.root}</code>],
        [t('ent.firstSession'), when(s?.createdAt)],
        [t('ent.lastActivity'), when(p.lastActivity)],
        [t('ent.memory'), p.memoryCount > 0 || p.memoryConnected ? t(p.memoryConnected ? 'ent.memoryConnected' : 'ent.memoryLocal', { n: fmtInt(p.memoryCount) }) : null],
      ]} />
      <div className="mb-5 max-w-sm empty:hidden"><KitStatusRow project={p.key} root={p.root} /></div>
      <div className="mb-5 border-t border-line2">
        <StatStrip cols={4}>
          <Stat icon={Layers} tone="accent" label={t('ent.sessions')} value={fmtInt(p.sessionCount)} hint={p.liveCount > 0 ? t('ent.liveNow', { n: fmtInt(p.liveCount) }) : undefined} />
          <Stat icon={Coins} label={t('ent.tokensIn', { n: s?.windowDays ?? 30 })} value={s ? fmtTokens(s.recent) : '–'} hint={t('ent.tokensHint')} />
          <Stat icon={Activity} label={t('ent.tokensAll')} value={s ? fmtTokens(s.total) : '–'} hint={s?.journalSince ? t('adm.journalSince', { at: fmtAgo(s.journalSince) }) : undefined} />
          <Stat icon={CalendarClock} label={t('ent.lastActivity')} value={p.lastActivity ? fmtAgo(p.lastActivity) : '–'} />
        </StatStrip>
      </div>
      {s && <UsageSections stats={s} format={fmtTokens} chartTitle={t('ent.tokensByDay')} byNameTitle={t('ent.toolCalls')} />}
      {s && s.byModel.length > 0 && (
        <Section title={t('ent.models')}>
          <div className="flex flex-wrap gap-3 text-xs">{s.byModel.map((m) => <span key={m.name} className="flex items-center gap-1.5 text-muted"><ModelChip id={m.name} />{fmtTokens(m.n)}</span>)}</div>
        </Section>
      )}
      <TaggedSessions p={p} />
      <Tools p={p} />
    </>
  );
}

export default function ProjectPage(props: EntityPageProps) {
  const projects = useApi<Project[]>('/api/projects', ['projects']);
  const p = projects.data?.find((x) => x.key === props.id);
  const go = useApp((s) => s.go);
  const context = p ? `Folder: ${p.root}\n${p.sessionCount} sessions, ${p.liveCount} live.` : undefined;
  return (
    <EntityShell
      {...props}
      context={context}
      menu={p ? [{ id: 'project.skill', label: t('ent.writeSkill'), icon: Sparkles, onSelect: () => writeSkill({ key: p.key, name: p.name, root: p.root }) }] : undefined}
      actions={p && (
        <div className="flex flex-none gap-2">
          <Button onClick={() => go({ kind: 'kanban', board: p.key })}><SquareKanban size={12} />{t('nav.kanban')}</Button>
          <Button onClick={() => go({ kind: 'documents', project: p.key })}><Library size={12} />{t('documents.title')}</Button>
          <Button onClick={() => go({ kind: 'sessions', project: p.key })}><HistoryIcon size={12} />{t('ent.sessions')}</Button>
          <Button onClick={() => void createTab({ project: p.key })}><MessageSquarePlus size={12} />{t('ent.newTab')}</Button>
        </div>
      )}
    >
      {p ? <Body key={p.key} p={p} /> : projects.data ? <p className="text-xs text-muted">{t('entity.noDetails')}</p> : <Skeleton lines={6} />}
    </EntityShell>
  );
}
