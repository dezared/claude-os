import { ChevronRight, Folder, Layers, Sparkle } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { projectListTree, type ProjectListNode } from '../../../shared/projectListTree.ts';
import { useContextMenu } from '@/components/ContextMenu';
import { Fold } from '@/components/Motion';
import { ProjectIcon } from '@/components/ProjectIcon';
import { Skeleton } from '@/components/states';
import type { MenuItem } from '@/home/ActionMenu';
import { projectItems } from '@/home/ProjectMenu';
import { api, setCached } from '@/lib/api';
import { useFlip } from '@/lib/flip';
import { cn } from '@/lib/format';
import { t } from '@/lib/i18n';
import { toastError } from '@/lib/store';
import { openProject } from '@/lib/tabs';
import type { Project, ProjectPatch } from '@/lib/types';
import { KitBadge, type ProjectKit } from './ProjectKitBadge';

export async function patchProject(key: string, patch: ProjectPatch) {
  try {
    const next = await api<Project>(`/api/projects/${encodeURIComponent(key)}`, { method: 'PATCH', body: patch });
    setCached<Project[]>('/api/projects', (old) => old?.map((p) => (p.key === key ? next : p)) ?? []);
  } catch (e) {
    toastError(e);
  }
}

/** A folding arrow in the indent of a row: the row itself stays one button that selects. */
function Chevron({ open, label, depth, onToggle }: { open: boolean; label: string; depth: number; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      aria-expanded={open}
      onClick={onToggle}
      style={{ left: 2 + depth * 14 }}
      className="press absolute top-1/2 z-1 flex size-4 -translate-y-1/2 items-center justify-center rounded text-dim hover:bg-fg/[.08] hover:text-fg"
    >
      <ChevronRight size={11} className={cn('transition-transform duration-150 ease-[var(--ease-ui)]', open && 'rotate-90')} />
    </button>
  );
}

type Actions = { color: (key: string) => string; coreKey: string | null; onSelect: (key: string) => void; onMigrate: (key: string) => void; onRemove: (key: string) => void };

// The kind of a row is a right-click away: a folder holds projects, a project has a star of its own.
function kindItems(project: Project, coreKey: string | null): MenuItem[] {
  return project.key === coreKey ? [] : [{
    id: 'kind', apart: true, label: t(project.folder ? 'projectsScreen.makeProject' : 'projectsScreen.makeFolder'), icon: project.folder ? Layers : Folder,
    onSelect: () => void patchProject(project.key, { folder: !project.folder }),
  }];
}

function Row({ project, depth, selected, open, onToggle, a, kit }: { project: Project; depth: number; selected: boolean; open: boolean | null; onToggle: () => void; a: Actions; kit?: ProjectKit }) {
  const kind = kindItems(project, a.coreKey);
  const area = useContextMenu(() => [...projectItems(project, { onMigrate: () => a.onMigrate(project.key), onRemove: () => a.onRemove(project.key) }), ...kind]);
  return (
    <div ref={area} data-own-menu data-flip={project.key} className="relative">
      {open !== null && <Chevron open={open} depth={depth} label={t('projectsScreen.nested', { name: project.name })} onToggle={onToggle} />}
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={() => a.onSelect(project.key)}
        onDoubleClick={() => { if (!project.folder) void openProject(project.key); }}
        style={{ paddingLeft: 22 + depth * 14 }}
        title={project.root}
        className={cn('press flex w-full items-center gap-2 rounded-lg py-1.5 text-left transition-colors duration-150', kit ? 'pr-7' : 'pr-2', selected ? 'bg-fg/[.1] text-fg' : 'text-soft hover:bg-fg/[.05]')}
      >
        <ProjectIcon project={project.key} name={project.name} color={a.color(project.key)} size={16} folder={project.folder} dim={!project.folder && project.liveCount === 0} />
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        {project.liveCount > 0 && <span className="size-1.5 flex-none rounded-full bg-accent" aria-label={t('projects.active', { n: project.liveCount })} />}
      </button>
      {kit && <KitBadge kit={kit} className="absolute top-1/2 right-1 -translate-y-1/2" />}
    </div>
  );
}

/** A folder on disk that several projects share: it only folds them away, a click on it toggles. */
function FolderRow({ node, depth, open, onToggle }: { node: ProjectListNode; depth: number; open: boolean; onToggle: () => void }) {
  return (
    <div data-flip={node.id} className="relative">
      <Chevron open={open} depth={depth} label={t('projectsScreen.nested', { name: node.name })} onToggle={onToggle} />
      <button type="button" onClick={onToggle} style={{ paddingLeft: 22 + depth * 14 }} title={node.path} className="press flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left text-muted transition-colors duration-150 hover:bg-fg/[.05] hover:text-fg">
        <Folder size={15} className="flex-none text-dim" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
      </button>
    </div>
  );
}

const CLOSED_KEY = 'claude-os.projects.closed';

/** Which rows are folded, kept across reloads: the tree looks as it was left. */
function useClosed(): [Set<string>, (id: string) => void] {
  const [closed, setClosed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(CLOSED_KEY) ?? '[]') as string[]);
    } catch {
      return new Set();
    }
  });
  const toggle = (id: string) => setClosed((s) => {
    const n = new Set(s);
    if (!n.delete(id)) n.add(id);
    localStorage.setItem(CLOSED_KEY, JSON.stringify([...n]));
    return n;
  });
  return [closed, toggle];
}

type ListProps = { projects: Project[]; loaded: boolean; query: string; selected: string | undefined; a: Actions; kits: Map<string, ProjectKit> };

/** The projects as they lie on disk: folders they share and parents fold their projects away; a search shows a flat list of what matches. */
export function ProjectList({ projects, loaded, query, selected, a, kits }: ListProps) {
  const [closed, toggle] = useClosed();
  const list = useRef<HTMLDivElement>(null);
  useFlip(list);
  const tree = useMemo(() => projectListTree(projects), [projects]);
  const byKey = useMemo(() => new Map(projects.map((p) => [p.key, p])), [projects]);
  const q = query.trim().toLowerCase();
  const found = q ? projects.filter((p) => p.name.toLowerCase().includes(q) || p.root.toLowerCase().includes(q)) : null;
  const node = (n: ProjectListNode, depth: number) => {
    const open = !closed.has(n.id);
    const p = n.project ? byKey.get(n.project) : undefined;
    return (
      <div key={n.id} role="listitem">
        {p ? <Row project={p} depth={depth} selected={p.key === selected} open={n.children.length > 0 ? open : null} onToggle={() => toggle(n.id)} a={a} kit={kits.get(p.key)} /> : <FolderRow node={n} depth={depth} open={open} onToggle={() => toggle(n.id)} />}
        {n.children.length > 0 && <Fold show={open}>{n.children.map((c) => node(c, depth + 1))}</Fold>}
      </div>
    );
  };
  return (
    <div ref={list} role="list" aria-label={t('nav.projects')}>
      {!loaded && <Skeleton lines={8} />}
      {found ? found.map((p) => <div key={p.key} role="listitem"><Row project={p} depth={0} selected={p.key === selected} open={null} onToggle={() => {}} a={a} kit={kits.get(p.key)} /></div>) : tree.map((n) => node(n, 0))}
      {loaded && (found ?? projects).length === 0 && <p className="flex items-center gap-1.5 px-2 py-3 text-xs text-muted"><Sparkle size={11} />{t('projectsScreen.nothing')}</p>}
    </div>
  );
}
