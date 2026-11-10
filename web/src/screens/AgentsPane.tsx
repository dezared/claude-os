import { Bot, CalendarClock, CalendarDays, Coins, FileText, History, Moon, Package, Play, Repeat, Search, Sparkles, Telescope, Trash2, Trophy } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ClaudeMark } from '@/components/ClaudeMark';
import { claudeItems, ContextArea } from '@/components/ContextMenu';
import { Markdown } from '@/components/Markdown';
import { Boundary, Empty, Skeleton } from '@/components/states';
import { Button, Input, Segmented } from '@/components/ui';
import type { MenuItem } from '@/home/ActionMenu';
import { spendNote } from '@/lib/account';
import { useApi } from '@/lib/api';
import { cn, fmtAgo, fmtDay, fmtInt, fmtTokens } from '@/lib/format';
import { t } from '@/lib/i18n';
import { askClaude } from '@/lib/microtask';
import { useProjectColors } from '@/lib/projectColors';
import { useApp, type View } from '@/lib/store';
import { openSession } from '@/lib/tabs';
import type { AgentDetail, AgentRow, AgentsReport } from '@/lib/types';
import { Facts, Section, UsageSections, when } from './admin/entityParts';
import { analyzeItem } from './admin/menus';
import { Bar, MiniBars, ModelChip, PanelBar, ProjectGroups, ScopeSource, SectionHead, Stat, StatStrip, Tag, type Scope } from './admin/parts';
import { confirmRemoveAgent } from './admin/RemoveDialogs';
import { EntityShell, type EntityPageProps } from './EntityPage';

const agentView = (a: Pick<AgentRow, 'id' | 'scope' | 'source'>): View => ({ kind: 'entity', type: 'agent', id: a.id, ...(a.scope === 'project' && a.source ? { project: a.source } : {}) });

function agentContext(a: AgentRow): string {
  const scope = a.scope === 'user' ? 'global, available in every project' : a.scope === 'project' ? `only in project ${a.source}` : `from plugin ${a.source}, read only`;
  return [
    `Scope: ${scope}.`,
    `File: ${a.path}`,
    a.description && `Description: ${a.description}`,
    a.model && `Model: ${a.model}`,
    a.tools && `Tools: ${a.tools.join(', ')}`,
    `Runs seen in the journals: ${a.runsAll}.`,
  ].filter(Boolean).join('\n');
}

function agentMenu(a: AgentRow, { page }: { page?: boolean } = {}): MenuItem[] {
  const [change, ask] = claudeItems(
    { kind: 'Claude Code agent', name: a.name, context: agentContext(a), project: a.scope === 'project' ? a.source : null },
    { changePresets: [t('agents.presetSharpen'), t('agents.presetModel'), t('agents.presetTools'), t('agents.presetToGlobal'), t('agents.presetToProject')], askPresets: [t('ask.presetWhat'), t('agents.presetDuplicates'), t('ask.presetProblems')] },
  );
  const { go } = useApp.getState();
  return [
    ...(page ? [] : [{ id: 'entity.open', label: t('ent.open'), icon: FileText, onSelect: () => go(agentView(a)) }]),
    ...(a.readOnly ? (a.source ? [{ id: 'agent.plugin', label: t('ent.openPlugin', { name: a.source }), icon: Package, onSelect: () => go({ kind: 'entity', type: 'plugin', id: a.source! }) }] : []) : [change]),
    ask,
    ...(a.readOnly ? [] : [{ id: 'agent.delete', label: t('ent.delete'), icon: Trash2, danger: true, onSelect: () => confirmRemoveAgent(a) }]),
  ];
}

function createAgent(project?: { key: string | null; name: string; root: string }) {
  const context = project
    ? `Write a new Claude Code agent for this project only, as a markdown file with frontmatter in ${project.root}/.claude/agents.`
    : "Write a new Claude Code agent as a markdown file with frontmatter in ~/.claude/agents, unless the request clearly belongs to one project; then use that project's .claude/agents and say so.";
  askClaude({ subject: { kind: 'agent set', name: project?.name ?? 'global', context, project: project?.key }, intent: 'change', title: t('agents.create'), presets: [t('agents.presetCreateReview'), t('agents.presetCreateTests')], placeholder: t('agents.whatFor') });
}

function findAgents(rows: AgentRow[]) {
  const installed = rows.map((a) => `- ${a.name} (${a.scope}${a.source ? `: ${a.source}` : ''}): ${a.runsAll} runs. ${a.description ?? ''}`).join('\n');
  askClaude({
    subject: { kind: 'agent set', name: 'installed agents', context: `Find which agents would improve development here and say where each comes from. Change nothing until asked.\nInstalled:\n${installed || 'none'}` },
    title: t('agents.find'),
    presets: [t('agents.presetFindWork'), t('agents.presetFindExisting'), t('agents.presetFindIdle')],
    placeholder: t('agents.findPlaceholder'),
  });
}

/** One agent, here and on the page of a project. */
export function AgentRowItem({ a, maxRuns }: { a: AgentRow; maxRuns: number }) {
  return (
    <ContextArea items={() => agentMenu(a)}>
      <button
        type="button"
        onClick={() => useApp.getState().go(agentView(a))}
        title={a.description ?? a.name}
        className="press grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1.5fr)_110px_110px_120px_90px_72px] items-center gap-4 border-b border-line2 px-5 py-1.5 text-left hover:bg-white/[.04]"
      >
        <span className="truncate text-soft">{a.name}</span>
        <span className="truncate text-xs text-dim">{a.description}</span>
        <span className="min-w-0 truncate text-xs text-muted">{a.model ? <ModelChip id={a.model} /> : t('agents.modelInherit')}</span>
        <span className="truncate text-xs text-muted" title={a.tools?.join(', ')}>{a.tools ? t('agents.toolsCount', { n: fmtInt(a.tools.length) }) : t('agents.toolsAll')}</span>
        <span className="flex min-w-0"><ScopeSource scope={a.scope} source={a.source} /></span>
        <span className="text-right text-xs text-dim">{a.lastUsedAt ? fmtAgo(a.lastUsedAt) : t('agents.neverRun')}</span>
        <span className="text-right text-xs" title={t('adm.allTime', { n: fmtInt(a.runsAll) })}>
          <span className={a.runs > 0 ? 'text-soft' : 'text-dim'}>{fmtInt(a.runs)}</span>
          <Bar className="mt-0.5" value={a.runs} max={maxRuns} color="var(--color-accent)" />
        </span>
      </button>
    </ContextArea>
  );
}

const inProject = (a: AgentRow, p: AgentsReport['projects'][number]) => a.scope === 'project' && a.source === (p.project ?? p.root.split('/').at(-1));

export function AgentsPane() {
  const report = useApi<AgentsReport>('/api/agents', ['agents', 'sessions']);
  const [scope, setScope] = useState<Scope>('global');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | AgentRow['scope']>('all');
  const rows = report.data?.rows;
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows ?? [])
      .filter((a) => (filter === 'all' || a.scope === filter) && (!needle || `${a.name} ${a.description ?? ''} ${a.source ?? ''}`.toLowerCase().includes(needle)))
      .sort((a, b) => b.runs - a.runs || b.runsAll - a.runsAll || a.name.localeCompare(b.name));
  }, [rows, q, filter]);

  const actions = (
    <>
      <Button onClick={() => findAgents(rows ?? [])} title={spendNote()}><Telescope size={12} />{t('agents.find')}</Button>
      <Button onClick={() => createAgent()} title={spendNote()}><ClaudeMark size={12} />{t('agents.create')}</Button>
    </>
  );

  const items = (): MenuItem[] => {
    const all = rows ?? [];
    const context = `${all.length} agents, runs in the last ${report.data?.windowDays ?? 30} days:\n${all.map((a) => `- ${a.name} (${a.scope}): ${a.runs}`).join('\n')}`;
    return [
      { id: 'agents.create', label: t('agents.create'), icon: Sparkles, onSelect: () => createAgent() },
      { id: 'agents.find', label: t('agents.find'), icon: Telescope, onSelect: () => findAgents(all) },
      analyzeItem(t('agents.analyze'), 'agent list', 'Claude Code agents', context, [t('agents.presetFindIdle'), t('agents.presetDuplicates')]),
    ];
  };

  return (
    <ContextArea items={items} className="min-h-0 flex-1 overflow-auto">
      <Boundary
        query={report}
        errorClassName="m-5"
        skeleton={<Skeleton className="p-5" lines={8} />}
        empty={(r) => (r.rows.length === 0 && r.other.length === 0 ? <div className="flex flex-col items-start gap-3 p-5"><Empty className="self-stretch" icon={Bot}>{t('agents.none')}</Empty><div className="flex gap-2">{actions}</div></div> : null)}
      >
        {(r) => {
          const used = r.rows.filter((a) => a.runs > 0);
          const runs = r.rows.reduce((n, a) => n + a.runs, 0);
          const tokens = r.rows.reduce((n, a) => n + a.tokens, 0);
          const top = used.slice().sort((a, b) => b.runs - a.runs).slice(0, 8);
          const maxTop = top[0]?.runs ?? 1;
          const scopes = [['user', t('adm.scopeUser')], ['project', t('adm.scopeProject')], ['plugin', t('adm.scopePlugins')]] as const;
          return (
            <>
              <PanelBar scope={scope} onScope={setScope}>{actions}</PanelBar>
              {scope === 'projects' ? (
                <ProjectGroups
                  rows={r.projects}
                  unit={t('agents.unit')}
                  empty={t('agents.noProject')}
                  menu={(p) => [{ id: 'agents.createHere', label: t('agents.createHere'), icon: Sparkles, onSelect: () => createAgent({ key: p.project, name: p.name, root: p.root }) }]}
                >
                  {(p) => r.rows.filter((a) => inProject(a, p)).map((a) => <AgentRowItem key={a.id} a={a} maxRuns={maxTop} />)}
                </ProjectGroups>
              ) : (
                <>
                  <StatStrip cols={4}>
                    <Stat hero icon={Bot} tone="accent" label={t('agents.total')} value={fmtInt(r.rows.length)} />
                    <Stat icon={Play} tone="ok" label={t('adm.usedIn', { n: r.windowDays })} value={fmtInt(used.length)} hint={r.journalSince ? t('adm.journalSince', { at: fmtAgo(r.journalSince) }) : undefined} />
                    <Stat icon={Repeat} label={t('adm.runsIn', { n: r.windowDays })} value={fmtInt(runs)} hint={t('agents.runsHint')} />
                    <Stat icon={Coins} label={t('agents.tokensIn', { n: r.windowDays })} value={fmtTokens(tokens)} hint={t('agents.tokensHint')} />
                  </StatStrip>
                  <div className="grid border-b border-line2 app:grid-cols-[1fr_1fr_1fr]">
                    <section className="min-w-0 border-b border-line2 px-5 py-4 app:border-r app:border-b-0">
                      <SectionHead icon={Trophy} title={t('agents.top')} />
                      {top.length === 0 ? <p className="text-xs text-muted">{t('agents.noneUsed')}</p> : top.map((a) => (
                        <ContextArea key={a.id} items={() => agentMenu(a)}>
                          <button type="button" onClick={() => useApp.getState().go(agentView(a))} title={a.description ?? a.name} className="press mb-1.5 block w-full rounded text-left hover:text-accent">
                            <span className="flex items-baseline justify-between gap-3 text-xs"><span className="truncate text-soft">{a.name}</span><span className="flex-none text-muted">{fmtInt(a.runs)}</span></span>
                            <Bar className="mt-0.5" value={a.runs} max={maxTop} color="var(--color-accent)" />
                          </button>
                        </ContextArea>
                      ))}
                    </section>
                    <section className="min-w-0 border-b border-line2 px-5 py-4 app:border-r app:border-b-0">
                      <SectionHead icon={Moon} title={t('agents.other')} aside={<span className="text-[11px] text-dim">{fmtInt(r.other.length)}</span>} />
                      <div className="max-h-48 overflow-auto pr-1">
                        {r.other.map((o) => (
                          <div key={o.name} className="flex items-baseline justify-between gap-3 py-0.5 text-xs text-muted" title={t('adm.allTime', { n: fmtInt(o.runsAll) })}>
                            <span className="truncate">{o.name}</span>
                            <span className="flex-none text-[11px] text-dim">{fmtInt(o.runs)}</span>
                          </div>
                        ))}
                      </div>
                      <p className="mt-2 text-[11px] text-dim">{t('agents.otherHint')}</p>
                      {r.untyped > 0 && <p className="mt-1 text-[11px] text-dim">{t('agents.untyped', { n: fmtInt(r.untyped) })}</p>}
                    </section>
                    <section className="min-w-0 px-5 py-4">
                      <SectionHead icon={CalendarDays} title={t('adm.runsByDay')} />
                      <MiniBars values={r.byDay.map((d) => d.runs)} labels={r.byDay.map((d) => `${fmtDay(d.day)}: ${d.runs}`)} height={72} accentLast />
                    </section>
                  </div>
                  <div className="sheet-bar sticky top-11 z-[5] flex flex-wrap items-center gap-2 border-b border-line2 px-5 py-2">
                    <div className="relative w-64">
                      <Search size={12} className="pointer-events-none absolute top-2.25 left-2.5 z-10 text-dim" />
                      <Input aria-label={t('common.search')} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.search')} className="py-1 pl-7 text-xs" />
                    </div>
                    <Segmented ariaLabel={t('adm.scope')} value={filter} onChange={setFilter} options={[{ value: 'all', label: t('usage.all') }, ...scopes.map(([value, label]) => ({ value, label }))]} />
                    <span className="flex-1" />
                    <span className="text-[11px] text-dim">{t('adm.listed', { n: fmtInt(filtered.length) })}</span>
                  </div>
                  {filtered.length === 0 ? <Empty className="m-5">{t('common.nothingFound')}</Empty> : filtered.map((a) => <AgentRowItem key={a.id} a={a} maxRuns={maxTop} />)}
                </>
              )}
            </>
          );
        }}
      </Boundary>
    </ContextArea>
  );
}

function Body({ d }: { d: AgentDetail }) {
  const { nameOf } = useProjectColors();
  const { agent: a, stats: s, recent } = d;
  const scope = a.scope === 'user' ? t('ent.scopeGlobalHint') : a.scope === 'project' ? t('ent.scopeProjectHint', { name: nameOf(a.source) }) : t('ent.scopePluginHint', { name: a.source ?? '' });
  return (
    <>
      {a.description && <p className="selectable mb-4 max-w-3xl text-[13px] leading-[1.55] text-soft">{a.description}</p>}
      <Facts rows={[
        [t('ent.scope'), scope],
        [t('ent.path'), <code className="font-mono text-[11.5px]">{a.path}{a.isSymlink ? ` · ${t('skills.symlink')}` : ''}</code>],
        [t('agents.model'), a.model ? <ModelChip id={a.model} /> : t('agents.modelInherit')],
        [t('agents.tools'), a.tools ? <span className="flex flex-wrap gap-1">{a.tools.map((x) => <Tag key={x}>{x}</Tag>)}</span> : t('agents.toolsAll')],
        [t('ent.created'), when(s.createdAt)],
        [t('ent.changed'), when(s.changedAt)],
      ]} />
      <div className="mb-5 border-t border-line2">
        <StatStrip cols={4}>
          <Stat icon={Play} tone="accent" label={t('adm.runsIn', { n: s.windowDays })} value={fmtInt(a.runs)} hint={t('agents.runsHint')} />
          <Stat icon={Repeat} label={t('ent.runsAll')} value={fmtInt(a.runsAll)} hint={s.journalSince ? t('adm.journalSince', { at: fmtAgo(s.journalSince) }) : undefined} />
          <Stat icon={Coins} label={t('agents.tokensIn', { n: s.windowDays })} value={fmtTokens(a.tokens)} hint={t('agents.tokensHint')} />
          <Stat icon={CalendarClock} label={t('ent.lastUsed')} value={a.lastUsedAt ? fmtAgo(a.lastUsedAt) : t('agents.neverRun')} />
        </StatStrip>
      </div>
      <UsageSections stats={s} chartTitle={t('adm.runsByDay')} />
      {recent.length > 0 && (
        <Section title={t('agents.recent')} icon={History}>
          <div className="border-t border-line2">
            {recent.map((r, i) => (
              <button key={i} type="button" onClick={() => void openSession({ id: r.session, project: r.project, cwd: '' })} className="press grid w-full grid-cols-[minmax(0,1fr)_120px_64px_80px] items-center gap-3 border-b border-line2 py-1 text-left text-xs hover:bg-white/[.04]">
                <span className="truncate text-soft">{r.description ?? r.session}</span>
                <span className="truncate text-muted">{r.project ? nameOf(r.project) : ''}</span>
                <span className="text-right text-muted">{fmtTokens(r.tokens)}</span>
                <span className="text-right text-dim">{r.at ? fmtAgo(r.at) : ''}</span>
              </button>
            ))}
          </div>
        </Section>
      )}
      <Section title={t('agents.file')} icon={FileText}>
        <div className={cn('rounded-md border border-line2 px-4 py-3')}><Markdown text={d.content.replace(/^---\n[\s\S]*?\n---\n?/, '')} small /></div>
      </Section>
    </>
  );
}

export default function AgentPage(props: EntityPageProps) {
  const q = useApi<AgentDetail>(`/api/agents/${encodeURIComponent(props.id)}`, ['agents', 'sessions']);
  const a = q.data?.agent;
  return (
    <EntityShell {...props} title={a?.name} context={a && agentContext(a)} menu={a && agentMenu(a, { page: true })}>
      {q.data ? <Body d={q.data} /> : q.error ? <p className="text-xs text-muted">{t('entity.noDetails')}</p> : <Skeleton lines={6} />}
    </EntityShell>
  );
}
