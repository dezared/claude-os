import { Folder, FolderPlus, FolderTree, Layers, MessageSquarePlus, MoreHorizontal, RotateCcw, Sparkle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { projectTree } from '../../../shared/projectTree.ts';
import { ClaudeMark } from '@/components/ClaudeMark';
import { useContextMenu } from '@/components/ContextMenu';
import { Markdown } from '@/components/Markdown';
import { ProjectIcon } from '@/components/ProjectIcon';
import { ProjectSelect } from '@/components/ProjectSelect';
import { Empty, ErrorState, Skeleton } from '@/components/states';
import { Button, IconButton, Input, Segmented, Textarea } from '@/components/ui';
import { iconMenuItem } from '@/components/IconPicker';
import { ActionMenu } from '@/home/ActionMenu';
import { MigrateDialog } from '@/home/MigrateDialog';
import { projectItems } from '@/home/ProjectMenu';
import { RemoveProjectDialog } from '@/home/RemoveProjectDialog';
import { SWATCHES } from '@/home/universe/colors';
import { setOnMap } from '@/home/universe/menu';
import { api, setCached, useApi } from '@/lib/api';
import { cn, fmtAgo, fmtInt } from '@/lib/format';
import { t, type Key } from '@/lib/i18n';
import { askClaude } from '@/lib/microtask';
import { useProjectColors } from '@/lib/projectColors';
import { toast, toastError, useApp } from '@/lib/store';
import { openProject } from '@/lib/tabs';
import type { MemoryGraph, Project, ProjectIcons, ProjectPatch, ProjectStructureNode } from '@/lib/types';
import { Facts } from './admin/entityParts';
import { projectView } from './admin/menus';

async function patchProject(key: string, patch: ProjectPatch) {
  try {
    const next = await api<Project>(`/api/projects/${encodeURIComponent(key)}`, { method: 'PATCH', body: patch });
    setCached<Project[]>('/api/projects', (old) => old?.map((p) => (p.key === key ? next : p)) ?? []);
  } catch (e) {
    toastError(e);
  }
}

/** Parents first, each followed by its children: the tree the list draws, with the depth of every row. */
export function treeRows(projects: Project[]): { project: Project; depth: number }[] {
  const parents = projectTree(projects);
  const children = new Map<string | null, Project[]>();
  for (const p of projects) {
    const parent = parents.get(p.key) ?? null;
    children.set(parent, [...(children.get(parent) ?? []), p]);
  }
  const out: { project: Project; depth: number }[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const project of children.get(parent) ?? []) {
      out.push({ project, depth });
      walk(project.key, depth + 1);
    }
  };
  walk(null, 0);
  return out;
}

function Row({ project, depth, selected, color, onSelect, onMigrate, onRemove }: { project: Project; depth: number; selected: boolean; color: string; onSelect: () => void; onMigrate: () => void; onRemove: () => void }) {
  const area = useContextMenu(() => projectItems(project, { onMigrate, onRemove }));
  return (
    <div ref={area} data-own-menu>
      <button
        type="button"
        aria-current={selected ? 'true' : undefined}
        onClick={onSelect}
        onDoubleClick={() => { if (!project.folder) void openProject(project.key); }}
        style={{ paddingLeft: 10 + depth * 16 }}
        title={project.root}
        className={cn('press flex w-full items-center gap-2 rounded-lg py-1.5 pr-2 text-left transition-colors duration-150', selected ? 'bg-white/[.1] text-fg' : 'text-soft hover:bg-white/[.05]')}
      >
        {project.folder ? <Folder size={15} className="flex-none" style={{ color }} /> : <ProjectIcon project={project.key} name={project.name} color={color} size={15} dim={project.liveCount === 0} />}
        <span className="min-w-0 flex-1 truncate">{project.name}</span>
        {project.liveCount > 0 && <span className="size-1.5 flex-none rounded-full bg-accent" aria-label={t('projects.active', { n: project.liveCount })} />}
      </button>
    </div>
  );
}

/** Text that reads as text until clicked: nothing to look at when there is nothing to change. */
function Description({ project }: { project: Project }) {
  const [draft, setDraft] = useState<string | null>(null);
  const box = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (draft !== null) box.current?.focus();
  }, [draft === null]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => {
    if (draft !== null && draft.trim() !== (project.description ?? '')) void patchProject(project.key, { description: draft.trim() || null });
    setDraft(null);
  };
  if (draft !== null) {
    return (
      <Textarea
        ref={box}
        rows={4}
        value={draft}
        aria-label={t('projectsScreen.description')}
        placeholder={t('projectsScreen.descriptionPlaceholder')}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            setDraft(null);
          } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) save();
        }}
      />
    );
  }
  return (
    <button type="button" onClick={() => setDraft(project.description ?? '')} aria-label={t('projectsScreen.description')} className="press block w-full rounded-lg px-2 py-1.5 -mx-2 text-left transition-colors duration-150 hover:bg-white/[.04]">
      {project.description ? <Markdown text={project.description} /> : <span className="text-xs text-dim">{t('projectsScreen.descriptionPlaceholder')}</span>}
    </button>
  );
}

function ColorRow({ project, color }: { project: Project; color: string }) {
  return (
    <div role="group" aria-label={t('projectsScreen.color')} className="flex flex-wrap items-center gap-1">
      {SWATCHES.map((hex) => (
        <button
          key={hex}
          type="button"
          aria-label={hex}
          aria-pressed={project.color === hex}
          onClick={() => void patchProject(project.key, { color: hex })}
          style={{ background: hex }}
          className={cn('press size-4.5 rounded-full transition-transform duration-150 hover:scale-115', project.color === hex && 'ring-2 ring-white/70 ring-offset-1 ring-offset-bg')}
        />
      ))}
      <label title={t('projectsScreen.colorOwn')} className="press relative ml-1 size-4.5 cursor-pointer overflow-hidden rounded-full border border-line">
        <input
          type="color"
          aria-label={t('projectsScreen.colorOwn')}
          // Fires on every step of the drag: only the closed picker's value is worth a request.
          defaultValue={project.color ?? '#888888'}
          key={project.color ?? ''}
          onBlur={(e) => { if (e.target.value !== (project.color ?? '#888888')) void patchProject(project.key, { color: e.target.value }); }}
          className="absolute -inset-1 size-7 cursor-pointer opacity-0"
        />
        <i aria-hidden className="block size-full" style={{ background: project.color && !SWATCHES.includes(project.color) ? project.color : 'conic-gradient(#f87171,#fbbf24,#4ade80,#60a5fa,#c084fc,#f87171)' }} />
      </label>
      {project.color && <IconButton label={t('projectsScreen.colorReset')} className="ml-1 size-5" onClick={() => void patchProject(project.key, { color: null })}><RotateCcw size={11} /></IconButton>}
      <span aria-hidden className="ml-2 size-2 rounded-full" style={{ background: color }} />
    </div>
  );
}

function Setting({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-line2 py-2.5">
      <div className="w-36 flex-none text-xs text-muted" title={hint}>{label}</div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Details({ project, projects, color, coreKey, onSelect, onMigrate, onRemove }: { project: Project; projects: Project[]; color: (key: string) => string; coreKey: string | null; onSelect: (key: string) => void; onMigrate: () => void; onRemove: () => void }) {
  const icons = useApi<ProjectIcons>('/api/project-icons', ['projects']);
  const [menu, setMenu] = useState(false);
  const tree = useMemo(() => projectTree(projects), [projects]);
  const go = useApp((s) => s.go);
  const inside = (key: string): boolean => {
    for (let at = tree.get(key); at; at = tree.get(at)) if (at === project.key) return true;
    return false;
  };
  const parentChoices = projects.filter((p) => p.key !== project.key && !inside(p.key) && !p.misc);
  const children = projects.filter((p) => tree.get(p.key) === project.key);
  const isCore = project.key === coreKey;
  const ask = () => askClaude({
    subject: {
      kind: 'project',
      name: project.name,
      project: project.key,
      context: [
        `Key: ${project.key}. Folder: ${project.root}.`,
        `Now: ${JSON.stringify({ name: project.name, description: project.description, color: project.color, parent: project.parent, folder: project.folder, map: project.mapPin, icon: icons.data?.chosen[project.key] ?? null })}`,
        `Other projects: ${projects.filter((p) => p.key !== project.key).map((p) => p.key).join(', ')}`,
        isCore
          ? 'This is Claude OS itself: its name is fixed and it is always a project, never a plain folder. Tools: update_project(project, description?, parent?) for the description and the structure (parent: a key, "" for top level, null to let folders decide).'
          : 'Tools: update_project(project, name?, description?, color?, parent?, folder?) for the name, the description, the colour, the structure (parent: a key, "" for top level, null to let folders decide) and the "only a folder" mark. set_project_map(project, on) for the star map.',
        `The icon: "${project.key}": "<name>" in ${icons.data?.dir ?? 'config/project-icons'}/icons.json, the format is in root/reference/icons.md.`,
      ].join('\n'),
    },
    intent: 'change',
    title: t('claude.changeTitle', { name: project.name }),
    presets: [t('projectsScreen.presetDescribe'), t('projectsScreen.presetLook'), t('projectsScreen.presetStructure')],
    placeholder: t('ask.changePlaceholder'),
  });

  return (
    <div key={project.key} className="enter-fade mx-auto w-full max-w-3xl px-7 py-5">
      <header className="mb-3 flex items-start gap-3">
        <button type="button" aria-label={t('icons.pick')} title={t('icons.pick')} onClick={() => iconMenuItem(project).onSelect?.()} className="press mt-0.5 flex-none rounded-md transition-transform duration-150 hover:scale-110">
          {project.folder ? <Folder size={26} style={{ color: color(project.key) }} /> : <ProjectIcon project={project.key} name={project.name} color={color(project.key)} size={26} />}
        </button>
        <div className="min-w-0 flex-1">
          <NameField project={project} fixed={isCore} />
          <p className="truncate font-mono text-[11.5px] text-muted" title={project.root}>{project.root}</p>
        </div>
        <div className="flex flex-none items-center gap-1.5">
          {!project.folder && <Button onClick={() => void openProject(project.key)}><MessageSquarePlus size={12} />{t('projectsScreen.open')}</Button>}
          <Button onClick={ask}><ClaudeMark size={12} />{t('projectsScreen.withClaude')}</Button>
          <ActionMenu
            label={t('nav.menu')}
            side="bottom"
            align="end"
            open={menu}
            onOpenChange={setMenu}
            items={projectItems(project, { onMigrate, onRemove })}
            trigger={<button type="button" aria-label={t('nav.menu')} aria-haspopup="menu" aria-expanded={menu} className="press flex size-7 items-center justify-center rounded-md text-muted hover:bg-white/[.08] hover:text-fg"><MoreHorizontal size={14} /></button>}
          />
        </div>
      </header>

      <Description project={project} />

      <div className="mt-3 border-t border-line2">
        {!isCore && (
          <Setting label={t('projectsScreen.kind')} hint={t('projectsScreen.kindHint')}>
            <Segmented
              ariaLabel={t('projectsScreen.kind')}
              value={project.folder ? 'folder' : 'project'}
              onChange={(v) => void patchProject(project.key, { folder: v === 'folder' })}
              options={[{ value: 'project', label: t('projectsScreen.kindProject') }, { value: 'folder', label: t('projectsScreen.kindFolder') }]}
            />
          </Setting>
        )}
        <Setting label={t('projectsScreen.parent')} hint={t('projectsScreen.parentHint')}>
          <ProjectSelect
            ariaLabel={t('projectsScreen.parent')}
            projects={parentChoices}
            extra={[{ value: 'auto', label: t('projectsScreen.parentAuto') }, { value: 'top', label: t('projectsScreen.parentTop') }]}
            value={project.parent === null ? 'auto' : project.parent === '' ? 'top' : project.parent}
            onChange={(v) => void patchProject(project.key, { parent: v === 'auto' || v === null ? null : v === 'top' ? '' : v })}
          />
        </Setting>
        {!isCore && !project.folder && (
          <Setting label={t('projectsScreen.map')} hint={t('projectsScreen.mapHint')}>
            <Segmented
              ariaLabel={t('projectsScreen.map')}
              value={project.mapPin === null ? 'auto' : project.mapPin ? 'on' : 'off'}
              onChange={(v) => setOnMap(project.key, v === 'auto' ? null : v === 'on')}
              options={[{ value: 'auto', label: t('projectsScreen.mapAuto') }, { value: 'on', label: t('projectsScreen.mapOn') }, { value: 'off', label: t('projectsScreen.mapOff') }]}
            />
          </Setting>
        )}
        {!isCore && <Setting label={t('projectsScreen.color')}><ColorRow project={project} color={color(project.key)} /></Setting>}
      </div>

      {children.length > 0 && (
        <section className="mt-4">
          <h2 className="mb-1 text-xs font-medium text-muted">{t('projectsScreen.children')}</h2>
          <div className="flex flex-wrap gap-1.5">
            {children.map((c) => (
              <button key={c.key} type="button" onClick={() => onSelect(c.key)} className="press flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-xs text-soft transition-colors duration-150 hover:bg-white/[.06]">
                {c.folder ? <Folder size={13} style={{ color: color(c.key) }} /> : <ProjectIcon project={c.key} name={c.name} color={color(c.key)} size={13} />}
                {c.name}
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="mt-4">
        <Facts rows={[
          [t('ent.sessions'), project.sessionCount > 0 ? <button type="button" className="press text-soft hover:text-fg" onClick={() => go({ kind: 'sessions', project: project.key })}>{fmtInt(project.sessionCount)}{project.liveCount > 0 ? ` · ${t('ent.liveNow', { n: fmtInt(project.liveCount) })}` : ''}</button> : null],
          [t('ent.lastActivity'), project.lastActivity ? fmtAgo(project.lastActivity) : null],
          [t('ent.memory'), project.memoryCount > 0 || project.memoryConnected ? t(project.memoryConnected ? 'ent.memoryConnected' : 'ent.memoryLocal', { n: fmtInt(project.memoryCount) }) : null],
          [t('projectsScreen.more'), <button type="button" className="press text-soft hover:text-fg" onClick={() => go(projectView(project.key))}>{t('projectsScreen.moreLink')}</button>],
        ]} />
      </div>
    </div>
  );
}

/** The name of Claude OS itself is fixed: it reads as a plain heading. */
function NameField({ project, fixed }: { project: Project; fixed: boolean }) {
  const [draft, setDraft] = useState<string | null>(null);
  const save = () => {
    if (draft?.trim() && draft.trim() !== project.name) void patchProject(project.key, { name: draft.trim() });
    setDraft(null);
  };
  if (draft !== null) {
    return (
      <Input
        autoFocus
        value={draft}
        aria-label={t('projectsScreen.name')}
        className="h-7 text-base font-medium"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') save();
          else if (e.key === 'Escape') {
            e.stopPropagation();
            setDraft(null);
          }
        }}
      />
    );
  }
  if (fixed) return <h1 className="text-base font-medium wrap-anywhere">{project.name}</h1>;
  return <h1 className="cursor-text text-base font-medium wrap-anywhere" title={t('projectsScreen.nameHint')} onClick={() => setDraft(project.name)}>{project.name}</h1>;
}

const KIND_LABEL: Partial<Record<ProjectStructureNode['kind'], Key>> = { project: 'projectsScreen.kindProject', misc: 'projects.misc', hidden: 'projectsScreen.structHidden', seen: 'projectsScreen.structSeen' };
const REASON_LABEL: Record<NonNullable<ProjectStructureNode['reason']>, Key> = { git: 'projectsScreen.reasonGit', override: 'projectsScreen.reasonOverride', connected: 'projectsScreen.reasonConnected' };

async function connectFolder(path: string) {
  try {
    const p = await api<Project>('/api/projects/connect', { method: 'POST', body: { path } });
    toast(t('connect.done', { name: p.name }));
  } catch (e) {
    toastError(e);
  }
}

function StructureRow({ node, depth, byKey, coreKey, color }: { node: ProjectStructureNode; depth: number; byKey: Map<string, Project>; coreKey: string | null; color: (key: string) => string }) {
  const project = node.project ? byKey.get(node.project) : undefined;
  const badge = node.kind === 'inside' ? t('projectsScreen.structInside', { name: project?.name ?? node.project ?? '' })
    : node.kind === 'project' && project?.folder ? t('projectsScreen.kindFolder')
    : KIND_LABEL[node.kind] && t(KIND_LABEL[node.kind]!);
  return (
    <>
      <div role="listitem" title={node.path} style={{ paddingLeft: 8 + depth * 16 }} className="group flex min-h-7 items-center gap-2 rounded-md pr-1 hover:bg-white/[.04]">
        {project && node.kind === 'project' && !project.folder
          ? <ProjectIcon project={project.key} name={project.name} color={color(project.key)} size={14} />
          : <Folder size={14} className="flex-none text-muted" />}
        <span className={cn('min-w-0 truncate text-sm', node.kind === 'none' || node.kind === 'hidden' ? 'text-muted' : 'text-soft')}>{node.name}</span>
        {badge && <span title={node.reason && t(REASON_LABEL[node.reason])} className="flex-none rounded border border-line px-1.5 text-[10.5px] text-muted">{badge}</span>}
        {!badge && node.reason === 'git' && <span className="flex-none text-[10.5px] text-dim">git</span>}
        <span className="flex-1" />
        {(node.kind === 'none' || node.kind === 'seen') && <Button size="sm" variant="ghost" onClick={() => void connectFolder(node.path)}>{t('connect.submit')}</Button>}
        {node.kind === 'project' && project && !project.folder && project.key !== coreKey && (
          <Button size="sm" variant="ghost" className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100" onClick={() => void patchProject(project.key, { folder: true })}>{t('projectsScreen.makeFolder')}</Button>
        )}
      </div>
      {node.folded?.map((cwd) => (
        <p key={cwd} title={t('projectsScreen.structFolded')} style={{ paddingLeft: 30 + depth * 16 }} className="truncate font-mono text-[11px] text-dim">{cwd}</p>
      ))}
      {node.children?.map((c) => <StructureRow key={c.path} node={c} depth={depth + 1} byKey={byKey} coreKey={coreKey} color={color} />)}
    </>
  );
}

/** Folders on disk, two levels down, as Claude OS sees them: what is a project, what folds into one, what is nothing yet. */
function Structure({ projects, coreKey, color }: { projects: Project[]; coreKey: string | null; color: (key: string) => string }) {
  const tree = useApi<ProjectStructureNode>('/api/projects/structure', ['projects']);
  const byKey = useMemo(() => new Map(projects.map((p) => [p.key, p])), [projects]);
  return (
    <div className="enter-fade mx-auto w-full max-w-3xl px-7 py-5">
      <h1 className="text-base font-medium">{t('projectsScreen.structure')}</h1>
      <p className="mb-3 truncate font-mono text-[11.5px] text-muted" title={tree.data?.path}>{tree.data?.path}</p>
      {tree.error && !tree.data && <ErrorState message={tree.error} onRetry={tree.refetch} />}
      {!tree.data && !tree.error && <Skeleton lines={8} />}
      {tree.data && (tree.data.children?.length ? (
        <div role="list" aria-label={t('projectsScreen.structure')}>
          {tree.data.children.map((c) => <StructureRow key={c.path} node={c} depth={0} byKey={byKey} coreKey={coreKey} color={color} />)}
          {tree.data.truncated && <p role="listitem" title={t('projectsScreen.structureTruncated')} className="px-2 text-sm text-dim">…</p>}
        </div>
      ) : <Empty>{t('projectsScreen.structureEmpty')}</Empty>)}
    </div>
  );
}

export function ProjectsView({ selected }: { selected?: string }) {
  const projects = useApi<Project[]>('/api/projects', ['projects']);
  const graph = useApi<MemoryGraph>('/api/memory/graph', ['memory']);
  const { color } = useProjectColors();
  const go = useApp((s) => s.go);
  const [query, setQuery] = useState('');
  const [migrate, setMigrate] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [structure, setStructure] = useState(false);
  const list = projects.data ?? [];
  const q = query.trim().toLowerCase();
  const rows = useMemo(() => treeRows(list).filter(({ project }) => !q || project.name.toLowerCase().includes(q) || project.root.toLowerCase().includes(q)), [list, q]);
  const current = list.find((p) => p.key === selected) ?? rows[0]?.project;
  const select = (key: string) => {
    setStructure(false);
    go({ kind: 'projects', key });
  };
  const coreKey = graph.data?.coreProject ?? null;

  return (
    <div className="flex min-h-0 flex-1">
      <aside aria-label={t('nav.projects')} className="flex w-72 flex-none flex-col border-r border-line2">
        <div className="flex flex-none items-center gap-2 px-3.5 pt-4 pb-2">
          <Layers size={14} className="text-accent" />
          <h1 className="flex-1 text-sm font-medium">{t('nav.projects')}</h1>
          <IconButton label={t('projectsScreen.structure')} aria-pressed={structure} className={cn('size-6', structure && 'bg-white/[.1] text-fg')} onClick={() => setStructure((v) => !v)}><FolderTree size={13} /></IconButton>
          <IconButton label={t('connect.action')} className="size-6" onClick={() => useApp.getState().setConnectOpen(true)}><FolderPlus size={13} /></IconButton>
        </div>
        {list.length > 8 && (
          <div className="flex-none px-3 pb-2">
            <Input value={query} aria-label={t('projectsScreen.search')} placeholder={t('projectsScreen.search')} onChange={(e) => setQuery(e.target.value)} />
          </div>
        )}
        <div role="list" className="min-h-0 flex-1 overflow-auto px-2 pb-3">
          {!projects.data && <Skeleton lines={8} />}
          {rows.map(({ project, depth }) => (
            <Row key={project.key} project={project} depth={q ? 0 : depth} selected={!structure && project.key === current?.key} color={color(project.key)} onSelect={() => select(project.key)} onMigrate={() => setMigrate(project.key)} onRemove={() => setRemoving(project.key)} />
          ))}
          {projects.data && rows.length === 0 && <p className="flex items-center gap-1.5 px-2 py-3 text-xs text-muted"><Sparkle size={11} />{t('projectsScreen.nothing')}</p>}
        </div>
      </aside>
      <div className="min-w-0 flex-1 overflow-auto">
        {structure ? (
          <Structure projects={list} coreKey={coreKey} color={color} />
        ) : current ? (
          <Details project={current} projects={list} color={color} coreKey={coreKey} onSelect={select} onMigrate={() => setMigrate(current.key)} onRemove={() => setRemoving(current.key)} />
        ) : (
          projects.data && <Empty>{t('projectsScreen.nothing')}</Empty>
        )}
      </div>
      {removing && <RemoveProjectDialog projectKey={removing} onClose={() => setRemoving(null)} />}
      <MigrateDialog project={migrate} onClose={() => setMigrate(null)} />
    </div>
  );
}
