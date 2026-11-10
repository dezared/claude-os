import { CalendarClock, FolderTree, Plug, Repeat, Wrench } from 'lucide-react';
import { Skeleton } from '@/components/states';
import { useApi } from '@/lib/api';
import { fmtAgo, fmtInt } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useProjectColors } from '@/lib/projectColors';
import { useApp } from '@/lib/store';
import type { EntityStats, McpAdminRow, McpReport } from '@/lib/types';
import { Facts, Section, UsageSections, when } from './admin/entityParts';
import { mcpContext, mcpMenu, projectView } from './admin/menus';
import { McpStatus, Stat, StatStrip } from './admin/parts';
import { EntityShell, type EntityPageProps } from './EntityPage';
import { Details } from './McpPane';

function Places({ row }: { row: McpAdminRow }) {
  const go = useApp((s) => s.go);
  const statusAt = (place: string) => row.statusBy.find((x) => x.place === place)?.status;
  const global = statusAt('global');
  return (
    <Section title={t('ent.mcpPlaces')} icon={FolderTree}>
      {row.where.global && (
        <div className="flex items-center gap-3 border-b border-line2 py-1.5 text-xs">
          <span className="w-52 flex-none truncate text-soft">{t('ent.allProjects')}</span>
          <span className="w-24 flex-none text-dim">{t('adm.scopeGlobal')}</span>
          {global && <McpStatus status={global} />}
        </div>
      )}
      {row.definitions.filter((d) => d.project).map((d) => {
        const key = d.project!;
        const name = row.where.projects.find((p) => p.key === key)?.name ?? key;
        const status = statusAt(key);
        return (
          <div key={`${d.scope}:${key}`} className="flex items-center gap-3 border-b border-line2 py-1.5 text-xs">
            <button type="button" onClick={() => go(projectView(key))} className="press w-52 flex-none truncate rounded text-left text-soft hover:text-accent">{name}</button>
            <span className="w-24 flex-none text-dim">{d.scope === 'local' ? t('adm.scopeLocal') : t('adm.scopeShared')}</span>
            {status && <McpStatus status={status} />}
          </div>
        );
      })}
      {!row.where.global && row.where.projects.length === 0 && <p className="text-xs text-muted">{row.where.plugin ? t('ent.scopePluginHint', { name: row.where.plugin }) : t('adm.whereAccount')}</p>}
    </Section>
  );
}

function Body({ row }: { row: McpAdminRow }) {
  const stats = useApi<EntityStats>(`/api/admin/entity?type=mcp&id=${encodeURIComponent(row.name)}`, ['mcp', 'tokens', 'audit']);
  const s = stats.data;
  return (
    <>
      <Facts rows={[
        [t('adm.colStatus'), <McpStatus status={row.status} />],
        [t('ent.serverInfo'), row.serverInfo ? `${row.serverInfo.name} ${row.serverInfo.version}` : null],
        [t('mcp.transport'), row.definitions[0]?.transport],
        [t('ent.changed'), when(s?.changedAt)],
      ]} />
      <div className="mb-5 border-t border-line2">
        <StatStrip cols={4}>
          <Stat icon={Repeat} tone="accent" label={t('adm.callsIn', { n: s?.windowDays ?? 30 })} value={fmtInt(row.calls)} hint={t('adm.fromJournals')} />
          <Stat icon={Plug} label={t('ent.callsAll')} value={s ? fmtInt(s.total) : '–'} hint={s?.journalSince ? t('adm.journalSince', { at: fmtAgo(s.journalSince) }) : undefined} />
          <Stat icon={Wrench} label={t('ent.toolsUsed')} value={fmtInt(row.toolsUsed)} hint={row.tools.length > 0 ? t('adm.toolsShort', { n: fmtInt(row.tools.length) }) : undefined} />
          <Stat icon={CalendarClock} label={t('ent.lastCall')} value={row.lastCall ? fmtAgo(row.lastCall) : t('adm.noCalls')} />
        </StatStrip>
      </div>
      <Places row={row} />
      {s && <UsageSections stats={s} chartTitle={t('ent.callsByDay')} byNameTitle={t('ent.callsByTool')} />}
      <Details row={row} className="flex flex-col gap-4" />
    </>
  );
}

export default function McpPage(props: EntityPageProps) {
  const report = useApi<McpReport>('/api/admin/mcp', ['mcp']);
  const { nameOf } = useProjectColors();
  const row = report.data?.rows.find((r) => r.name === props.id);
  return (
    <EntityShell {...props} context={row && mcpContext(row)} menu={row && mcpMenu(row, { page: true, nameOf })}>
      {row ? <Body key={row.name} row={row} /> : report.data ? <p className="text-xs text-muted">{t('entity.noDetails')}</p> : <Skeleton lines={6} />}
    </EntityShell>
  );
}
