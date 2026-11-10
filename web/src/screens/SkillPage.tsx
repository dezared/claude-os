import { CalendarClock, FileText, Pencil, Play, Repeat } from 'lucide-react';
import { useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { Skeleton } from '@/components/states';
import { Button } from '@/components/ui';
import { useApi } from '@/lib/api';
import { fmtAgo, fmtInt } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useProjectColors } from '@/lib/projectColors';
import type { EntityStats, Skill, SkillAdminRow, SkillsReport } from '@/lib/types';
import { Facts, Section, UsageSections, when } from './admin/entityParts';
import { skillContext, skillMenu } from './admin/menus';
import { Stat, StatStrip } from './admin/parts';
import { EntityShell, type EntityPageProps } from './EntityPage';
import { SkillEditor } from './SkillsPane';

function Body({ row }: { row: SkillAdminRow }) {
  const { nameOf } = useProjectColors();
  const [editing, setEditing] = useState(false);
  const stats = useApi<EntityStats>(`/api/admin/entity?type=skill&id=${encodeURIComponent(row.id)}`, ['skills', 'usage', 'audit']);
  const file = useApi<{ skill: Skill; content: string }>(editing ? null : `/api/skills/${encodeURIComponent(row.id)}`, ['skills']);
  const s = stats.data;
  const scope = row.scope === 'user' ? t('ent.scopeGlobalHint') : row.scope === 'project' ? t('ent.scopeProjectHint', { name: nameOf(row.source) }) : t('ent.scopePluginHint', { name: row.source ?? '' });
  return (
    <>
      {row.description && <p className="selectable mb-4 max-w-3xl text-[13px] leading-[1.55] text-soft">{row.description}</p>}
      <Facts rows={[
        [t('ent.scope'), scope],
        [t('ent.path'), <code className="font-mono text-[11.5px]">{row.path}{row.isSymlink ? ` · ${t('skills.symlink')}` : ''}</code>],
        [t('ent.state'), row.disabled ? t('skills.disabled') : null],
        [t('ent.created'), when(s?.createdAt)],
        [t('ent.changed'), when(s?.changedAt)],
        ...Object.entries(s?.meta ?? {}).map(([k, v]): [string, string] => [k, v]),
      ]} />
      <div className="mb-5 border-t border-line2">
        <StatStrip cols={4}>
          <Stat icon={Play} tone="accent" label={t('adm.runsIn', { n: s?.windowDays ?? 30 })} value={fmtInt(row.runs)} hint={t('adm.fromJournals')} />
          <Stat icon={Repeat} label={t('ent.runsAll')} value={fmtInt(row.runsAll)} hint={s?.journalSince ? t('adm.journalSince', { at: fmtAgo(s.journalSince) }) : undefined} />
          <Stat icon={FileText} label={t('ent.cliCount')} value={fmtInt(row.usageCount)} hint={t('ent.cliCountHint')} />
          <Stat icon={CalendarClock} label={t('ent.lastUsed')} value={row.lastUsedAt ? fmtAgo(row.lastUsedAt) : t('skills.neverRun')} />
        </StatStrip>
      </div>
      {s && <UsageSections stats={s} chartTitle={t('adm.runsByDay')} />}
      <Section
        title="SKILL.md"
        aside={row.readOnly ? undefined : <Button size="sm" onClick={() => setEditing(!editing)}><Pencil size={11} />{editing ? t('ent.stopEditing') : t('ent.edit')}</Button>}
      >
        {editing ? (
          <div className="h-[560px] overflow-hidden rounded-md border border-line2"><SkillEditor id={row.id} onSaved={() => {}} /></div>
        ) : file.data ? (
          <div className="rounded-md border border-line2 px-4 py-3"><Markdown text={file.data.content.replace(/^---\n[\s\S]*?\n---\n?/, '')} small /></div>
        ) : <Skeleton lines={5} />}
      </Section>
    </>
  );
}

export default function SkillPage(props: EntityPageProps) {
  const report = useApi<SkillsReport>('/api/admin/skills', ['skills', 'usage']);
  const rows = report.data?.rows ?? [];
  // A plain name comes from where only the name is known; a project's own copy wins over the others, as at run time.
  const named = rows.filter((s) => s.name === props.id);
  const row = rows.find((s) => s.id === props.id) ?? named.find((s) => s.scope === 'project' && s.source === props.project) ?? named.find((s) => s.scope === 'user') ?? named[0];
  return (
    <EntityShell {...props} title={row?.name} context={row && skillContext(row)} menu={row && skillMenu(row, { page: true })}>
      {row ? <Body key={row.id} row={row} /> : report.data ? <p className="text-xs text-muted">{t('entity.noDetails')}</p> : <Skeleton lines={6} />}
    </EntityShell>
  );
}
