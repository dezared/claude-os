import { Bot, BookOpen, FileText, LayoutTemplate, Package, Plug, ScrollText, Sparkles, Webhook, Wrench, type LucideIcon } from 'lucide-react';
import { lazy, Suspense, type ComponentType } from 'react';
import { Breadcrumbs } from '@/components/Breadcrumbs';
import { Skeleton } from '@/components/states';
import { cn } from '@/lib/format';
import { t, type Key } from '@/lib/i18n';
import { useApp, type ToolsPane, type View } from '@/lib/store';
import { HooksPane } from './HooksPane';
import { McpPane } from './McpPane';
import { PluginsPane } from './PluginsPane';
import { SkillsPane } from './SkillsPane';

const VaultPane = lazy(() => import('./VaultPane').then((m) => ({ default: m.VaultPane })));
const ClaudeMdPane = lazy(() => import('./ClaudeMdPane').then((m) => ({ default: m.ClaudeMdPane })));
const AgentsPane = lazy(() => import('./AgentsPane').then((m) => ({ default: m.AgentsPane })));
const LogPane = lazy(() => import('./LogPane').then((m) => ({ default: m.LogPane })));
const KitsScreen = lazy(() => import('./KitsScreen').then((m) => ({ default: m.KitsScreen })));

// The kits keep their own view kind, so a link to one kit (`{ kind: 'kits', id }`) opens it here, under Tools.
type Pane = ToolsPane | 'kits';

const PANES: { id: Pane; label: Key | 'CLAUDE.md'; icon: LucideIcon }[] = [
  { id: 'skills', label: 'tools.skills', icon: Sparkles },
  { id: 'agents', label: 'tools.agents', icon: Bot },
  { id: 'mcp', label: 'tools.mcp', icon: Plug },
  { id: 'hooks', label: 'tools.hooks', icon: Webhook },
  { id: 'plugins', label: 'tools.plugins', icon: Package },
  { id: 'kits', label: 'kits.title', icon: LayoutTemplate },
  { id: 'claude-md', label: 'CLAUDE.md', icon: FileText },
  { id: 'vault', label: 'tools.vault', icon: BookOpen },
  { id: 'log', label: 'tools.log', icon: ScrollText },
];

const BODY: Record<Pane, ComponentType<{ kit?: string }>> = {
  skills: SkillsPane,
  agents: AgentsPane,
  mcp: McpPane,
  hooks: HooksPane,
  plugins: PluginsPane,
  kits: ({ kit }) => <KitsScreen selected={kit} />,
  'claude-md': ClaudeMdPane,
  vault: VaultPane,
  log: LogPane,
};

export function ToolsView({ view }: { view: Extract<View, { kind: 'tools' | 'kits' }> }) {
  const pane: Pane = view.kind === 'kits' ? 'kits' : view.pane ?? 'skills';
  const Body = BODY[pane];
  const go = useApp((s) => s.go);
  const current = PANES.find((p) => p.id === pane) ?? PANES[0];
  return (
    <div className="grid min-h-0 flex-1 grid-cols-[196px_minmax(0,1fr)]">
      <nav aria-label={t('tools.paneAria')} className="flex min-h-0 flex-col gap-0.5 overflow-auto border-r border-line2 p-2">
        <h1 className="flex items-center gap-2 px-2 pt-1 pb-2.5 text-sm font-medium"><Wrench size={15} className="text-dim" />{t('tools.title')}</h1>
        {PANES.map((p) => (
          <button
            key={p.id}
            type="button"
            aria-current={pane === p.id ? 'page' : undefined}
            onClick={() => go(p.id === 'kits' ? { kind: 'kits' } : { kind: 'tools', pane: p.id })}
            className={cn('press flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left', pane === p.id ? 'bg-fg/[.1] text-fg shadow-[inset_0_1px_0_rgba(255,255,255,.08)]' : 'text-muted hover:bg-raised hover:text-fg')}
          >
            <p.icon size={14} className={pane === p.id ? 'text-accent' : 'text-dim'} />
            {p.label === 'CLAUDE.md' ? p.label : t(p.label)}
          </button>
        ))}
      </nav>
      <div className="flex min-h-0 min-w-0 flex-col">
        <Breadcrumbs className="flex-none border-b border-line2 px-4 py-1.5" items={[{ label: t('nav.home'), view: { kind: 'home' } }, { label: t('tools.title'), view: { kind: 'tools' } }, { label: current.label === 'CLAUDE.md' ? current.label : t(current.label) }]} />
        <Suspense fallback={<Skeleton className="p-6" lines={8} />}>
          <div key={pane} className="enter-fade flex min-h-0 min-w-0 flex-1 flex-col">
            <Body kit={view.kind === 'kits' ? view.id : undefined} />
          </div>
        </Suspense>
      </div>
    </div>
  );
}
