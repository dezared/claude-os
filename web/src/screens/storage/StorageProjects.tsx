import { FolderTree, MoreHorizontal } from 'lucide-react';
import { useRef, useState } from 'react';
import { useContextMenu } from '@/components/ContextMenu';
import { ProjectIcon } from '@/components/ProjectIcon';
import { IconButton } from '@/components/ui';
import { ActionMenu } from '@/home/ActionMenu';
import { useFlip } from '@/lib/flip';
import { cn, fmtInt } from '@/lib/format';
import { t } from '@/lib/i18n';
import { useProjectColors } from '@/lib/projectColors';
import type { MemoryHealth, MemoryProjectStats } from '@/lib/types';
import { MigrateCell } from '../WikiMigration';
import { SectionHead, Tag } from '../admin/parts';
import { storageMenu } from './actions';

export const NOTE_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
/** One colour per note type, the same in the bar and in the list. */
export const TYPE_COLOR: Record<string, string> = { user: 'var(--color-c-violet)', feedback: 'var(--color-c-gold)', project: 'var(--color-c-blue)', reference: 'var(--color-c-green)' };
const HEALTH_SHOWN: MemoryHealth[] = ['malformed', 'broken', 'duplicate', 'orphan'];

export interface Filter { project?: string | null; health?: MemoryHealth }

/** Notes changed per week, oldest first: bars grow from the baseline, the last one is this week. */
function Growth({ weeks, week, month }: { weeks: number[]; week: number; month: number }) {
  const max = Math.max(1, ...weeks);
  return (
    <span className="flex items-center gap-2" title={t('storage.growthHint', { week: fmtInt(week), month: fmtInt(month) })}>
      <span aria-hidden className="flex h-4 items-end gap-px">
        {weeks.map((n, i) => (
          <i key={i} className="storage-bar-y block w-1 rounded-[1px] bg-accent/70" style={{ height: `${Math.max(n > 0 ? 12 : 4, (n / max) * 100)}%`, opacity: n > 0 ? 1 : 0.25 }} />
        ))}
      </span>
      <span className={cn('text-[11px]', week > 0 ? 'text-soft' : 'text-dim')}>{week > 0 ? `+${fmtInt(week)}` : '0'}</span>
    </span>
  );
}

/** How the notes split between the four types, as one bar. */
function Types({ types, total }: { types: Record<string, number>; total: number }) {
  const keys: ((typeof NOTE_TYPES)[number] | '')[] = [...NOTE_TYPES, ''];
  const parts = keys.map((k) => [k, types[k] ?? 0] as const).filter(([, n]) => n > 0);
  const label = (k: (typeof NOTE_TYPES)[number] | '') => (k === '' ? t('storage.noType') : t(`universe.noteType.${k}`));
  const title = parts.map(([k, n]) => `${label(k)}: ${fmtInt(n)}`).join('\n');
  return (
    <span title={title} className="flex h-1.5 w-full overflow-hidden rounded-full bg-fg/[.07]">
      {parts.map(([k, n]) => <i key={k || 'none'} className="storage-bar-x block h-full" style={{ width: `${(n / Math.max(1, total)) * 100}%`, background: TYPE_COLOR[k] ?? 'var(--color-dim)' }} />)}
    </span>
  );
}

function HealthChips({ s, onFilter }: { s: MemoryProjectStats; onFilter: (f: Filter) => void }) {
  const shown = HEALTH_SHOWN.filter((h) => s.health[h] > 0);
  if (!shown.length) return <span className="text-[11px] text-ok">{t('storage.healthy')}</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {shown.map((h) => (
        <button key={h} type="button" onClick={() => onFilter({ project: s.project, health: h })} className="press motion-fade rounded-[5px]" title={t(`storage.h.${h}Hint`)}>
          <Tag tone={h === 'orphan' ? undefined : 'warn'}>{t(`storage.h.${h}`)} {fmtInt(s.health[h])}</Tag>
        </button>
      ))}
    </span>
  );
}

function Row({ s, name, vaultPath, onFilter, onMigrate }: { s: MemoryProjectStats; name: string; vaultPath: string; onFilter: (f: Filter) => void; onMigrate: (key: string) => void }) {
  const { color } = useProjectColors();
  const [menu, setMenu] = useState(false);
  const items = storageMenu(s, vaultPath);
  return (
      <tr ref={useContextMenu(items)} data-flip={s.project ?? ''} className="group border-t border-line2">
        <td className="truncate py-1.5 pr-3">
          <button type="button" onClick={() => onFilter({ project: s.project })} className="press inline-flex max-w-full items-center gap-2 text-soft hover:text-fg">
            {s.project === null ? <FolderTree size={14} className="flex-none text-dim" /> : <ProjectIcon project={s.project} name={name} color={color(s.project)} size={15} />}
            <span className="truncate">{name}</span>
          </button>
        </td>
        <td className="py-1.5 pr-4 text-right whitespace-nowrap">
          <span className="text-soft">{fmtInt(s.notes)}</span>
          {s.outside > 0 && <span className="ml-1.5 text-[11px] text-dim" title={t('storage.outsideHint')}>{t('storage.outside', { n: fmtInt(s.outside) })}</span>}
        </td>
        <td className="py-1.5 pr-4"><Growth weeks={s.weeks} week={s.added7} month={s.added30} /></td>
        <td className="py-1.5 pr-4"><Types types={s.types} total={s.notes} /></td>
        <td className="truncate py-1.5 pr-4 text-[11px] text-muted" title={s.tags.map(([tag, n]) => `${tag} ${n}`).join('\n')}>{s.tags.slice(0, 3).map(([tag]) => `#${tag}`).join(' ')}</td>
        <td className="py-1.5 pr-2"><HealthChips s={s} onFilter={onFilter} /></td>
        <td className="py-1.5 text-right whitespace-nowrap">
          {s.project !== null && <MigrateCell project={s.project} onOpen={() => onMigrate(s.project!)} />}
          {items.length > 0 && (
            <ActionMenu open={menu} onOpenChange={setMenu} label={t('storage.actions', { name })} items={items} side="bottom" align="end"
              trigger={<IconButton label={t('storage.actions', { name })} className={cn('ml-1 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100', menu && 'opacity-100')}><MoreHorizontal size={14} /></IconButton>} />
          )}
        </td>
      </tr>
  );
}

/** Every project's notes at a glance: size, growth, types, tags and what needs care. A health chip filters the list below. */
export function StorageProjects({ projects, nameOf, vaultPath, onFilter, onMigrate, aside }: {
  projects: MemoryProjectStats[];
  nameOf: (key: string | null) => string;
  vaultPath: string;
  onFilter: (f: Filter) => void;
  onMigrate: (key: string) => void;
  aside?: React.ReactNode;
}) {
  const body = useRef<HTMLTableSectionElement>(null);
  useFlip(body); // a project that grows past another slides to its new place
  return (
    <section className="max-w-6xl">
      <SectionHead icon={FolderTree} title={t('storage.projectsTitle')} aside={aside} />
      <table aria-label={t('storage.projectsTitle')} className="w-full table-fixed text-xs">
        <thead className="text-[11px] text-dim">
          <tr>
            <th className="w-56 py-1 text-left font-normal">{t('vault.colProject')}</th>
            <th className="w-36 py-1 pr-4 text-right font-normal">{t('storage.colNotes')}</th>
            <th className="w-36 py-1 text-left font-normal">{t('storage.colGrowth')}</th>
            <th className="w-32 py-1 pr-4 text-left font-normal">{t('storage.colTypes')}</th>
            <th className="py-1 text-left font-normal">{t('storage.colTags')}</th>
            <th className="w-64 py-1 text-left font-normal">{t('storage.colHealth')}</th>
            <th className="w-40 py-1"><span className="sr-only">{t('storage.colActions')}</span></th>
          </tr>
        </thead>
        <tbody ref={body} className="relative">
          {projects.map((s) => <Row key={s.project ?? ''} s={s} name={nameOf(s.project)} vaultPath={vaultPath} onFilter={onFilter} onMigrate={onMigrate} />)}
        </tbody>
      </table>
    </section>
  );
}
