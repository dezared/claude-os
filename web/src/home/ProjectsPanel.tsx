import { ChevronRight, FolderPlus, History, Sparkle, TriangleAlert } from 'lucide-react';
import { memo, useState } from 'react';
import { useContextMenu } from '@/components/ContextMenu';
import { ProjectIcon } from '@/components/ProjectIcon';
import { Boundary, Empty } from '@/components/states';
import { useApi } from '@/lib/api';
import { cn, fmtAgo } from '@/lib/format';
import { t, tn } from '@/lib/i18n';
import { useApp } from '@/lib/store';
import { openProject } from '@/lib/tabs';
import type { Project } from '@/lib/types';
import { projectItems } from './ProjectMenu';
import type { Palette } from './universe/colors';

function ProjectRow({
  p,
  mapped,
  color,
  onFocus,
  onFly,
  onSessions,
  onMigrate,
  onRemove,
}: {
  p: Project;
  mapped: boolean;
  color: string;
  onFocus: (key: string | null | undefined) => void;
  onFly: (key: string) => boolean;
  onSessions: (key: string, rect: DOMRect) => void;
  onMigrate: (key: string) => void;
  onRemove: (key: string) => void;
}) {
  const live = p.liveCount > 0;
  const area = useContextMenu((e) => {
    const rect = (e.target as Element).closest('.group')?.getBoundingClientRect();
    return projectItems(p, {
      onSessions: rect && (() => onSessions(p.key, rect)),
      onFly: mapped ? () => onFly(p.key) : undefined,
      mapped,
      onMigrate: () => onMigrate(p.key),
      onRemove: () => onRemove(p.key),
    });
  });
  return (
    <div
      ref={area}
      data-own-menu
      onPointerEnter={() => mapped && onFocus(p.key)}
      onPointerLeave={() => mapped && onFocus(undefined)}
      onFocus={() => mapped && onFocus(p.key)}
      onBlur={() => mapped && onFocus(undefined)}
      className="group relative -mx-1.5 flex items-center rounded-lg transition-colors duration-150 hover:bg-raised"
    >
      <button
        type="button"
        onClick={() => void openProject(p.key)}
        title={`${p.root} · ${p.sessionCount} ${tn('unit.session', p.sessionCount)}${live ? `, ${t('projects.active', { n: p.liveCount })}` : ''}`}
        className="press flex min-w-0 flex-1 items-center gap-2.5 rounded-lg py-1.5 pr-1.5 pl-2 text-left focus-visible:-outline-offset-2"
      >
        <ProjectIcon project={p.key} name={p.name} color={color} size={16} dim={!live} />
        <span className={cn('min-w-0 flex-1 truncate', live ? 'text-fg' : 'text-soft')}>{p.name}</span>
        {p.memoryDrift > 0 && (
          <span title={t('memory.drift', { n: p.memoryDrift })} className="flex flex-none items-center gap-0.5 text-[11px] text-accent">
            <TriangleAlert size={11} />
            {p.memoryDrift}
          </span>
        )}
        {p.memoryCount > 0 && (
          <span title={t('projects.notes', { n: p.memoryCount, notes: tn('unit.note', p.memoryCount) })} className="flex flex-none items-center gap-0.5 text-[11.5px] text-muted">
            <Sparkle size={10} className="text-dim" />
            {p.memoryCount}
          </span>
        )}
        <span className={cn('w-13 flex-none text-right text-[11.5px] whitespace-nowrap', live ? 'text-soft' : 'text-dim')}>
          {live ? t('projects.sessionsShort', { n: p.liveCount }) : p.lastActivity != null ? fmtAgo(p.lastActivity) : ''}
        </span>
      </button>
    </div>
  );
}

function byActivity(a: Project, b: Project) {
  return Number(b.liveCount > 0) - Number(a.liveCount > 0) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || a.name.localeCompare(b.name);
}

export const ProjectsPanel = memo(function ProjectsPanel({
  coreKey,
  onMap,
  palette,
  onFocusProject,
  onFly,
  onSessions,
  onMigrate,
  onRemove,
}: {
  coreKey: string | null;
  onMap: Set<string> | null;
  palette: Palette;
  onFocusProject: (key: string | null | undefined) => void;
  onFly: (key: string) => boolean;
  onSessions: (key: string, rect: DOMRect) => void;
  onMigrate: (key: string) => void;
  onRemove: (key: string) => void;
}) {
  const projects = useApi<Project[]>('/api/projects', ['projects']);
  const go = useApp((s) => s.go);
  const setConnectOpen = useApp((s) => s.setConnectOpen);
  const [miscOpen, setMiscOpen] = useState(false);
  const row = (p: Project) => (
    <ProjectRow key={p.key} p={p} mapped={!!onMap?.has(p.key)} color={palette.css(p.key)} onFocus={onFocusProject} onFly={onFly} onSessions={onSessions} onMigrate={onMigrate} onRemove={onRemove} />
  );

  return (
    <aside className="flex min-h-0 flex-1 flex-col">
        <div className="panel-scroll min-h-0 flex-1 overflow-auto px-3 pb-2">
          <Boundary query={projects} empty={(d) => (d.length === 0 ? <Empty>{t('projects.empty')}</Empty> : null)}>
            {(all) => {
              const main = all.filter((p) => !p.misc && p.key !== coreKey).sort(byActivity);
              const misc = all.filter((p) => p.misc && p.key !== coreKey).sort(byActivity);
              return (
                <>
                  {main.map(row)}
                  {misc.length > 0 && (
                    <>
                      <button
                        type="button"
                        aria-expanded={miscOpen}
                        onClick={() => setMiscOpen(!miscOpen)}
                        className="press -mx-1.5 mt-1 flex w-[calc(100%+12px)] items-center gap-2 rounded-lg px-2 py-1.5 text-left text-muted hover:bg-raised hover:text-fg"
                      >
                        <ChevronRight size={12} className={cn('flex-none transition-transform duration-150', miscOpen && 'rotate-90')} />
                        <span className="flex-1">{t('projects.misc')}</span>
                        <span className="text-[11.5px]">{misc.length}</span>
                      </button>
                      {miscOpen && misc.map(row)}
                    </>
                  )}
                </>
              );
            }}
          </Boundary>
        </div>
        <div className="flex-none border-t border-line2 p-1.5">
          <button type="button" onClick={() => setConnectOpen(true)} className="press flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-muted hover:bg-raised hover:text-fg">
            <FolderPlus size={13} className="text-[#8fb8a0]" />
            {t('connect.action')}
          </button>
          <button type="button" onClick={() => go({ kind: 'sessions' })} className="press flex w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-muted hover:bg-raised hover:text-fg">
            <History size={13} className="text-[#8da9c9]" />
            {t('projects.allSessions')}
          </button>
        </div>
    </aside>
  );
});

/** The count in the widget's title. */
export function ProjectsCount({ coreKey }: { coreKey: string | null }) {
  const projects = useApi<Project[]>('/api/projects', ['projects']);
  // Claude OS is the core of the map, not one of the projects on it.
  return <span className="flex-none text-[11.5px] text-dim">{projects.data ? projects.data.filter((p) => p.key !== coreKey).length : null}</span>;
}
