import { Bot, Boxes, FolderGit2, Package, Plug, Sparkles, Webhook, type LucideIcon } from 'lucide-react';
import { lazy, Suspense, type ComponentType, type ReactNode } from 'react';
import { Breadcrumbs, type Crumb } from '@/components/Breadcrumbs';
import { ContextArea, claudeItems } from '@/components/ContextMenu';
import { Skeleton } from '@/components/states';
import type { MenuItem } from '@/home/ActionMenu';
import { useApi } from '@/lib/api';
import { t, type Key } from '@/lib/i18n';
import type { EntityType, ToolsPane } from '@/lib/store';
import type { Project } from '@/lib/types';

export interface EntityPageProps {
  type: EntityType;
  id: string;
  project?: string;
}

// One line per page, lazy so a screen stays out of the first bundle: `skill: lazy(() => import('./SkillPage'))`.
const PAGES: Partial<Record<EntityType, ComponentType<EntityPageProps>>> = {
  'os-plugin': lazy(() => import('./OsPlugins')),
  project: lazy(() => import('./ProjectPage')),
  skill: lazy(() => import('./SkillPage')),
  plugin: lazy(() => import('./PluginPage')),
  mcp: lazy(() => import('./McpPage')),
  hook: lazy(() => import('./HookPage')),
  agent: lazy(() => import('./AgentsPane')),
};

const META: Record<EntityType, { label: Key; icon: LucideIcon; pane?: ToolsPane; paneLabel?: Key }> = {
  project: { label: 'entity.project', icon: FolderGit2 },
  skill: { label: 'entity.skill', icon: Sparkles, pane: 'skills', paneLabel: 'tools.skills' },
  plugin: { label: 'entity.plugin', icon: Package, pane: 'plugins', paneLabel: 'tools.plugins' },
  mcp: { label: 'entity.mcp', icon: Plug, pane: 'mcp', paneLabel: 'tools.mcp' },
  hook: { label: 'entity.hook', icon: Webhook, pane: 'hooks', paneLabel: 'tools.hooks' },
  agent: { label: 'entity.agent', icon: Bot, pane: 'agents', paneLabel: 'tools.agents' },
  'os-plugin': { label: 'tools.osPlugins', icon: Boxes },
};

/** The frame of every entity page: crumbs, title, right-click menu of the entity. `context` is what Claude gets told about it; `menu` goes first and replaces generic Claude items with the same id. */
export function EntityShell({ type, id, project, title, context, menu, actions, children }: EntityPageProps & { title?: string; context?: string; menu?: MenuItem[]; actions?: ReactNode; children?: ReactNode }) {
  const projects = useApi<Project[]>('/api/projects', ['projects']);
  const nameOf = (key: string) => projects.data?.find((p) => p.key === key)?.name ?? key;
  const meta = META[type];
  const name = title ?? (type === 'project' ? nameOf(id) : id);
  const crumbs: Crumb[] = [
    { label: t('nav.home'), view: { kind: 'home' } },
    ...(meta.pane && meta.paneLabel
      ? [
          { label: t('nav.tools'), view: { kind: 'tools' } } as Crumb,
          { label: t(meta.paneLabel), view: { kind: 'tools', pane: meta.pane } } as Crumb,
        ]
      : type === 'os-plugin' ? [{ label: t('tools.osPlugins'), view: { kind: 'os-plugins' } } as Crumb] : []),
    { label: name },
  ];
  return (
    <ContextArea items={[...(menu ?? []), ...claudeItems({ kind: type, name, context, project: type === 'project' ? id : project })]} className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="mx-auto w-full max-w-5xl px-7 py-5">
        <Breadcrumbs items={crumbs} className="mb-3 -ml-1" />
        <header className="mb-4 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h1 className="flex items-center gap-2 text-base font-medium wrap-anywhere"><meta.icon size={15} className="flex-none text-dim" />{name}</h1>
            <p className="mt-0.5 text-xs text-muted">
              {t(meta.label)}
              {project && ` · ${nameOf(project)}`}
            </p>
          </div>
          {actions}
        </header>
        {children}
      </div>
    </ContextArea>
  );
}

function Blank(props: EntityPageProps) {
  return <EntityShell {...props}><p className="text-xs text-muted">{t('entity.noDetails')}</p></EntityShell>;
}

export function EntityPage(props: EntityPageProps) {
  const Page = PAGES[props.type] ?? Blank;
  return (
    <Suspense fallback={<Skeleton className="p-6" lines={8} />}>
      <Page {...props} />
    </Suspense>
  );
}
