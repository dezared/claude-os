import { spendNote } from '@/lib/account';
import { Archive, CalendarDays, FilePlus2, Lock, Moon, Play, Repeat, Search, Sparkles, Trophy } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { ClaudeMark } from '@/components/ClaudeMark';
import { ContextArea } from '@/components/ContextMenu';
import { Diff } from '@/components/Diff';
import { Markdown } from '@/components/Markdown';
import { Boundary, Empty, ErrorState, Skeleton } from '@/components/states';
import { Button, Dialog, Field, Input, Segmented, Textarea } from '@/components/ui';
import { api, invalidateTopics, useApi } from '@/lib/api';
import { cn, fmtAgo, fmtDay, fmtInt, shortPath } from '@/lib/format';
import { toast, toastError, useApp } from '@/lib/store';
import type { AdminProjectDiff, Skill, SkillAdminRow, SkillsReport, UsageTotals } from '@/lib/types';
import { t } from '@/lib/i18n';
import { analyzeItem, skillMenu, skillView, writeSkill } from './admin/menus';
import { Bar, MiniBars, PanelBar, ProjectGroups, ScopeSource, SectionHead, Stat, StatStrip, type Scope } from './admin/parts';

function templateFor(name: string, description: string): string {
  return `---
name: ${name}
description: ${description || t('skills.templateWhen')}
---

# ${name}

${t('skills.templateBody')}
`;
}

const inProject = (s: Skill, p: AdminProjectDiff) => s.scope === 'project' && s.source === (p.project ?? p.root.split('/').at(-1));

/** The diff is always shown before anything is written. */
function DiffConfirm({
  title,
  body,
  actionLabel,
  onClose,
  onConfirm,
}: {
  title: string;
  body: { id?: string; name?: string; content: string };
  actionLabel: string;
  onClose: () => void;
  onConfirm: () => Promise<void>;
}) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ diff: string }>('/api/skills/preview', { method: 'POST', body })
      .then((r) => setDiff(r.diff))
      .catch((e: Error) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={title} description={t('skills.backupNote')} width={720}>
      {error && <ErrorState message={error} className="mb-3" />}
      {!diff && !error && <Skeleton lines={6} />}
      {diff !== null && <Diff diff={diff} maxHeight={440} />}
      <div className="mt-3 flex justify-end gap-2">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="primary"
          disabled={diff === null || busy}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onConfirm();
            } catch (e) {
              setError((e as Error).message);
              setBusy(false);
            }
          }}
        >
          {actionLabel}
        </Button>
      </div>
    </Dialog>
  );
}

export function SkillEditor({ id, onSaved }: { id: string; onSaved: (s: Skill) => void }) {
  const q = useApi<{ skill: Skill; content: string }>(`/api/skills/${encodeURIComponent(id)}`, ['skills']);
  const [draft, setDraft] = useState<string | null>(null);
  const [mode, setMode] = useState<'edit' | 'split' | 'preview'>('split');
  const [confirm, setConfirm] = useState(false);
  const [toggling, setToggling] = useState(false);
  const logged = useApi<(UsageTotals & { name: string })[]>('/api/usage-log/skills', ['usage']);

  useEffect(() => setDraft(null), [id]);

  return (
    <Boundary query={q} skeleton={<Skeleton className="p-5" lines={10} />}>
      {({ skill, content }) => {
        const text = draft ?? content;
        const dirty = draft !== null && draft !== content;
        const showEdit = !skill.readOnly && mode !== 'preview';
        const showPreview = skill.readOnly || mode !== 'edit';
        return (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex flex-none flex-wrap items-center gap-2 border-b border-line2 px-4 py-2">
              <div className="min-w-0 flex-1">
                <h2 className="flex items-center gap-2 truncate font-mono text-[13px] font-medium">
                  {skill.name}
                  {skill.readOnly && <Lock size={11} className="text-dim" aria-label={t('work.readOnly')} />}
                  {skill.disabled && <span className="font-sans text-[11px] font-normal text-accent">{t('skills.disabled')}</span>}
                </h2>
                <p className="truncate font-mono text-[11px] text-dim" title={skill.path}>
                  {shortPath(skill.path)}
                  {skill.isSymlink && ` · ${t('skills.symlink')}`}
                </p>
              </div>
              <span className="text-xs text-dim">
                {t('skills.runs', { n: fmtInt(skill.usageCount) })} · {skill.lastUsedAt ? fmtAgo(skill.lastUsedAt) : t('skills.neverRun')}
                {' · '}{t('skills.logCalls', { n: fmtInt((logged.data ?? []).filter((x) => x.name === skill.name || x.name === `${skill.source}:${skill.name}`).reduce((a, x) => a + x.reads, 0)) })}
              </span>
              {!skill.readOnly && (
                <>
                  <Segmented
                    ariaLabel={t('skills.modeAria')}
                    value={mode}
                    onChange={setMode}
                    options={[
                      { value: 'edit', label: t('skills.modeText') },
                      { value: 'split', label: t('skills.modeSplit') },
                      { value: 'preview', label: t('skills.modePreview') },
                    ]}
                  />
                  <Button
                    disabled={toggling}
                    onClick={async () => {
                      setToggling(true);
                      try {
                        const next = await api<Skill>(`/api/skills/${encodeURIComponent(id)}/toggle`, { method: 'POST' });
                        invalidateTopics(['skills']);
                        onSaved(next);
                        toast(next.disabled ? t('skills.toggledOff') : t('skills.toggledOn'));
                      } catch (e) {
                        toastError(e);
                      } finally {
                        setToggling(false);
                      }
                    }}
                  >
                    {skill.disabled ? t('skills.enable') : t('skills.disable')}
                  </Button>
                  <Button variant="primary" disabled={!dirty} onClick={() => setConfirm(true)}>
                    {t('skills.save')}
                  </Button>
                </>
              )}
            </div>
            {skill.readOnly && <p className="flex-none border-b border-line2 px-4 py-1.5 text-xs text-dim">{t('skills.pluginReadOnly', { source: skill.source ?? '' })}</p>}
            <div className={cn('grid min-h-0 flex-1', showEdit && showPreview && 'grid-cols-2')}>
              {showEdit && (
                <Textarea
                  aria-label={t('skills.textAria')}
                  value={text}
                  spellCheck={false}
                  onChange={(e) => setDraft(e.target.value)}
                  className="h-full rounded-none border-0 border-r border-line2 bg-black/30 px-4 py-3 font-mono text-[12.5px] leading-[1.6] focus:border-line2"
                />
              )}
              {showPreview && (
                <div className="min-h-0 overflow-auto px-4 py-3">
                  <Markdown text={text.replace(/^---\n[\s\S]*?\n---\n?/, '')} small />
                </div>
              )}
            </div>
            {confirm && (
              <DiffConfirm
                title={t('skills.saveTitle', { name: skill.name })}
                body={{ id, content: text }}
                actionLabel={t('skills.write')}
                onClose={() => setConfirm(false)}
                onConfirm={async () => {
                  const next = await api<Skill>(`/api/skills/${encodeURIComponent(id)}`, { method: 'PUT', body: { content: text } });
                  setConfirm(false);
                  setDraft(null);
                  invalidateTopics(['skills']);
                  onSaved(next);
                  toast(t('skills.saved'));
                }}
              />
            )}
          </div>
        );
      }}
    </Boundary>
  );
}

function NewSkill({ onClose, onCreated }: { onClose: () => void; onCreated: (s: Skill) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [step, setStep] = useState<'form' | 'diff'>('form');
  const valid = /^[a-z0-9][a-z0-9-_]*$/.test(name);
  const content = templateFor(name, description.trim());
  if (step === 'diff') {
    return (
      <DiffConfirm
        title={t('skills.createTitle', { name })}
        body={{ name, content }}
        actionLabel={t('skills.create')}
        onClose={onClose}
        onConfirm={async () => {
          const skill = await api<Skill>('/api/skills', { method: 'POST', body: { name, content } });
          invalidateTopics(['skills']);
          onCreated(skill);
          onClose();
        }}
      />
    );
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t('skills.newTitle')} description={t('skills.newDesc')}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (valid) setStep('diff');
        }}
      >
        <Field label={t('skills.name')} hint={t('skills.nameHint')}>
          <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} className="font-mono text-xs" spellCheck={false} />
        </Field>
        <Field label={t('skills.description')} hint={t('skills.descriptionHint')}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={!valid}>
            {t('common.next')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/** One skill, here and on every page that lists skills. */
export function SkillRow({ s, maxRuns }: { s: SkillAdminRow; maxRuns: number }) {
  return (
    <ContextArea items={() => skillMenu(s)}>
      <button
        type="button"
        onClick={() => useApp.getState().go(skillView(s))}
        title={s.description ?? s.name}
        className={cn('press grid w-full grid-cols-[minmax(0,1.1fr)_minmax(0,1.6fr)_120px_90px_72px] items-center gap-4 border-b border-line2 px-5 py-1.5 text-left hover:bg-white/[.04]', s.disabled && 'opacity-50')}
      >
        <span className="truncate text-soft">{s.name}</span>
        <span className="truncate text-xs text-dim">{s.description}</span>
        <span className="flex min-w-0"><ScopeSource scope={s.scope} source={s.source} /></span>
        <span className="text-right text-xs text-dim">{s.lastUsedAt ? fmtAgo(s.lastUsedAt) : t('skills.neverRun')}</span>
        <span className="text-right text-xs" title={t('adm.allTime', { n: fmtInt(s.usageCount) })}>
          <span className={s.runs > 0 ? 'text-soft' : 'text-dim'}>{fmtInt(s.runs)}</span>
          <Bar className="mt-0.5" value={s.runs} max={maxRuns} color="var(--color-accent)" />
        </span>
      </button>
    </ContextArea>
  );
}

export function SkillsPane() {
  const report = useApi<SkillsReport>('/api/admin/skills', ['skills', 'usage']);
  const [scope, setScope] = useState<Scope>('global');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<'all' | SkillAdminRow['scope']>('all');
  const [creating, setCreating] = useState(false);

  const rows = report.data?.rows ?? [];
  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return rows
      .filter((s) => (filter === 'all' || s.scope === filter) && (!needle || `${s.name} ${s.description ?? ''} ${s.source ?? ''}`.toLowerCase().includes(needle)))
      .sort((a, b) => b.runs - a.runs || b.usageCount - a.usageCount || a.name.localeCompare(b.name));
  }, [rows, q, filter]);

  const open = (s: Skill) => useApp.getState().go(skillView(s));
  const actions = <Button onClick={() => writeSkill()} title={spendNote()}><ClaudeMark size={12} />{t('skills.viaClaude')}</Button>;

  const items = () => {
    const r = report.data;
    const all = r?.rows ?? [];
    const used = all.filter((s) => s.runs > 0).sort((a, b) => b.runs - a.runs);
    const idle = all.filter((s) => !s.disabled && s.runs === 0 && s.scope !== 'plugin').map((s) => s.name);
    const context = [
      `${all.length} skills, ${used.length} used in the last ${r?.windowDays ?? 30} days.`,
      `Most used: ${used.slice(0, 8).map((s) => `${s.name} (${s.runs})`).join(', ') || 'none'}.`,
      `Global or project skills not run in that time: ${idle.slice(0, 40).join(', ') || 'none'}.`,
    ].join('\n');
    return [
      { id: 'skills.write', label: t('ent.writeSkill'), icon: Sparkles, onSelect: () => writeSkill() },
      { id: 'skills.template', label: t('skills.fromTemplate'), icon: FilePlus2, onSelect: () => setCreating(true) },
      analyzeItem(t('ent.analyzeSkills'), 'skill list', 'Claude Code skills', context, [t('ent.presetSkillsIdle'), t('ent.presetSkillsDuplicates'), t('ent.presetSkillsMissing')]),
    ];
  };

  return (
    <ContextArea items={items} className="min-h-0 flex-1 overflow-auto">
      <Boundary
        query={report}
        skeleton={<Skeleton className="p-5" lines={8} />}
        empty={(r) => (r.rows.length === 0 ? <div className="flex flex-col items-start gap-3 p-5"><Empty icon={Sparkles}>{t('skills.none')}</Empty>{actions}</div> : null)}
      >
        {(r) => {
          const active = r.rows.filter((s) => !s.disabled);
          const used = active.filter((s) => s.runs > 0);
          const runs = active.reduce((a, s) => a + s.runs, 0);
          const top = used.slice().sort((a, b) => b.runs - a.runs).slice(0, 8);
          const candidates = active.filter((s) => s.runs === 0 && s.scope !== 'plugin').sort((a, b) => (a.lastUsedAt ?? 0) - (b.lastUsedAt ?? 0) || a.name.localeCompare(b.name));
          const counts = (sc: SkillAdminRow['scope']) => r.rows.filter((s) => s.scope === sc);
          const scopes = [['user', t('adm.scopeUser')], ['project', t('adm.scopeProject')], ['plugin', t('adm.scopePlugins')]] as const;
          const maxTop = top[0]?.runs ?? 1;
          return (
            <>
              <PanelBar scope={scope} onScope={setScope}>
                {actions}
              </PanelBar>
              {scope === 'projects' ? (
                <ProjectGroups
                  rows={r.projects.filter((p) => r.rows.some((s) => inProject(s, p)))}
                  unit={t('adm.unitSkills')}
                  empty={t('adm.noProjectSkills')}
                  menu={(p) => [{ id: 'skills.writeHere', label: t('ent.writeSkillHere'), icon: Sparkles, onSelect: () => writeSkill({ key: p.project, name: p.name, root: p.root }) }]}
                >
                  {(p) => r.rows.filter((s) => inProject(s, p)).map((s) => <SkillRow key={s.id} s={s} maxRuns={maxTop} />)}
                </ProjectGroups>
              ) : (
                <>
                  <StatStrip cols={5}>
                    <Stat hero icon={Sparkles} tone="accent" label={t('adm.skillsTotal')} value={fmtInt(r.rows.length)} hint={r.rows.length - active.length > 0 ? t('adm.skillsDisabled', { n: fmtInt(r.rows.length - active.length) }) : undefined} />
                    <Stat icon={Play} tone="ok" label={t('adm.usedIn', { n: r.windowDays })} value={fmtInt(used.length)} hint={t('adm.ofActive', { n: fmtInt(active.length) })} />
                    <Stat icon={Moon} label={t('adm.notUsedIn', { n: r.windowDays })} value={fmtInt(active.length - used.length)} hint={r.journalSince ? t('adm.journalSince', { at: fmtAgo(r.journalSince) }) : undefined} />
                    <Stat icon={Repeat} label={t('adm.runsIn', { n: r.windowDays })} value={fmtInt(runs)} hint={t('adm.fromJournals')} />
                    <div className="min-w-0 border-b border-line2 px-5 py-3">
                      {scopes.map(([sc, label]) => (
                        <button key={sc} type="button" onClick={() => setFilter(filter === sc ? 'all' : sc)} className={cn('press flex w-full items-center justify-between gap-2 rounded py-px text-left text-xs', filter === sc ? 'text-fg' : 'text-muted hover:text-fg')}>
                          <span>{label}</span>
                          <span className="text-soft">{fmtInt(counts(sc).length)}</span>
                        </button>
                      ))}
                    </div>
                  </StatStrip>
                  <div className="grid border-b border-line2 app:grid-cols-[1fr_1fr_1fr]">
                    <section className="min-w-0 border-b border-line2 px-5 py-4 app:border-r app:border-b-0">
                      <SectionHead icon={Trophy} title={t('adm.topRuns')} />
                      {top.length === 0 ? <p className="text-xs text-muted">{t('an.noneUsed')}</p> : top.map((s) => (
                        <ContextArea key={s.id} items={() => skillMenu(s)}>
                          <button type="button" onClick={() => open(s)} title={s.description ?? s.name} className="press mb-1.5 block w-full rounded text-left hover:text-accent">
                            <span className="flex items-baseline justify-between gap-3 text-xs"><span className="truncate text-soft">{s.name}</span><span className="flex-none text-muted">{fmtInt(s.runs)}</span></span>
                            <Bar className="mt-0.5" value={s.runs} max={maxTop} color="var(--color-accent)" />
                          </button>
                        </ContextArea>
                      ))}
                    </section>
                    <section className="min-w-0 border-b border-line2 px-5 py-4 app:border-r app:border-b-0">
                      <SectionHead icon={Archive} title={t('adm.candidates')} aside={<span className="text-[11px] text-dim">{fmtInt(candidates.length)}</span>} />
                      {candidates.length === 0 ? <p className="text-xs text-muted">{t('an.allUsed')}</p> : (
                        <div className="max-h-48 overflow-auto pr-1">
                          {candidates.map((s) => (
                            <ContextArea key={s.id} items={() => skillMenu(s)}>
                              <button type="button" onClick={() => open(s)} title={s.description ?? s.name} className="press flex w-full items-baseline justify-between gap-3 rounded py-0.5 text-left text-xs text-muted hover:text-fg">
                                <span className="truncate">{s.name}</span>
                                <span className="flex-none text-[11px] text-dim">{s.lastUsedAt ? fmtAgo(s.lastUsedAt) : t('skills.neverRun')}</span>
                              </button>
                            </ContextArea>
                          ))}
                        </div>
                      )}
                      <p className="mt-2 text-[11px] text-dim">{t('adm.candidatesHint')}</p>
                    </section>
                    <section className="min-w-0 px-5 py-4">
                      <SectionHead icon={CalendarDays} title={t('adm.runsByDay')} />
                      <MiniBars values={r.byDay.map((d) => d.runs)} labels={r.byDay.map((d) => `${fmtDay(d.day)}: ${d.runs}`)} height={72} accentLast />
                      {r.gone.length > 0 && <p className="mt-3 text-[11px] leading-[1.45] text-dim" title={r.gone.map((g) => `${g.name}: ${g.runs}`).join(', ')}>{t('adm.gone', { n: fmtInt(r.gone.length) })}</p>}
                    </section>
                  </div>
                  <div className="sheet-bar sticky top-11 z-[5] flex flex-wrap items-center gap-2 border-b border-line2 px-5 py-2">
                    <div className="relative w-64">
                      <Search size={12} className="pointer-events-none absolute top-2.25 left-2.5 z-10 text-dim" />
                      <Input aria-label={t('skills.searchAria')} value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('common.search')} className="py-1 pl-7 text-xs" />
                    </div>
                    <Segmented ariaLabel={t('adm.scope')} value={filter} onChange={setFilter} options={[{ value: 'all', label: t('usage.all') }, ...scopes.map(([value, label]) => ({ value, label }))]} />
                    <span className="flex-1" />
                    <span className="text-[11px] text-dim">{t('adm.listed', { n: fmtInt(filtered.length) })}</span>
                  </div>
                  {filtered.length === 0 ? <Empty className="m-5">{t('common.nothingFound')}</Empty> : filtered.map((s) => <SkillRow key={s.id} s={s} maxRuns={maxTop} />)}
                </>
              )}
            </>
          );
        }}
      </Boundary>
      {creating && <NewSkill onClose={() => setCreating(false)} onCreated={open} />}
    </ContextArea>
  );
}
