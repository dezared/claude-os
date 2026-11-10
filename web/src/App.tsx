import { KeyRound, WifiOff } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { AskClaudeDialog } from './components/AskClaudeDialog';
import { CommandPalette } from './components/CommandPalette';
import { ConnectFolderDialog } from './components/ConnectFolderDialog';
import { ContextMenuHost } from './components/ContextMenu';
import { ScreenBoundary } from './components/CrashCard';
import { DesktopBar, DesktopHost } from './components/DesktopHost';
import { IconPicker } from './components/IconPicker';
import { MicrotaskDialog } from './components/MicrotaskDialog';
import { NewTabDialog } from './components/NewTabDialog';
import { ObsidianNotice } from './components/ObsidianNotice';
import { ProjectIconsOffer } from './components/ProjectIcon';
import { Skeleton } from './components/states';
import { TitleBar } from './components/TitleBar';
import { Toasts } from './components/Toasts';
import { Tooltips } from './components/Tooltips';
import { Home } from './home/Home';
import { NotePanel } from './home/NotePanel';
import { PlannerPanel } from './notes/PlannerPanel';
import { RecoveryList } from './components/RecoveryList';
import { ServiceTasks } from './components/ServiceTasks';
import { RemoveDialogs } from './screens/admin/RemoveDialogs';
import { useApi } from './lib/api';
import { restartServer } from './lib/crash';
import { cn } from './lib/format';
import { t } from './lib/i18n';
import { useKitStatus } from './lib/projectKit';
import { toastError, useApp } from './lib/store';
import { reopenClosedTab } from './lib/tabs';
import type { AppStatus, Tab } from './lib/types';
import { PluginOverlays, useUiPluginLoader } from './lib/uiPlugins';
import { FileViewer } from './work/FileViewer';
import { WorkView } from './work/WorkView';

// Second-level screens stay out of the first-paint bundle.
const SessionsView = lazy(() => import('./screens/Sessions').then((m) => ({ default: m.SessionsView })));
const AnalyticsView = lazy(() => import('./screens/Analytics').then((m) => ({ default: m.AnalyticsView })));
const ToolsView = lazy(() => import('./screens/Tools').then((m) => ({ default: m.ToolsView })));
const OsPluginsView = lazy(() => import('./screens/OsPlugins').then((m) => ({ default: m.OsPluginsView })));
const SettingsView = lazy(() => import('./screens/SettingsScreen').then((m) => ({ default: m.SettingsView })));
const EntityPage = lazy(() => import('./screens/EntityPage').then((m) => ({ default: m.EntityPage })));
const KanbanBoard = lazy(() => import('./screens/KanbanBoard').then((m) => ({ default: m.KanbanBoard })));
const DocumentsScreen = lazy(() => import('./documents/DocumentsScreen').then((m) => ({ default: m.DocumentsScreen })));
const ProjectsView = lazy(() => import('./screens/ProjectsScreen').then((m) => ({ default: m.ProjectsView })));

// Moving the screen behind an open modal would leave it talking about a place no longer in view.
const stepHistory = (by: -1 | 1) => {
  if (!document.querySelector('[role="dialog"][data-state="open"]')) useApp.getState().step(by);
};

function useShortcuts() {
  const tabs = useApi<Tab[]>('/api/tabs', ['tabs']).data;
  useEffect(() => {
    const onMouse = (e: MouseEvent) => {
      if (e.button !== 3 && e.button !== 4) return;
      e.preventDefault();
      if (e.type === 'mouseup') stepHistory(e.button === 3 ? -1 : 1);
    };
    window.addEventListener('mousedown', onMouse);
    window.addEventListener('mouseup', onMouse);
    return () => {
      window.removeEventListener('mousedown', onMouse);
      window.removeEventListener('mouseup', onMouse);
    };
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && (e.code === 'ArrowLeft' || e.code === 'ArrowRight')) {
        e.preventDefault();
        stepHistory(e.code === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const app = useApp.getState();
      if (e.shiftKey && e.code === 'KeyT') {
        e.preventDefault();
        void reopenClosedTab();
        return;
      }
      if (e.code === 'KeyK') {
        e.preventDefault();
        app.setPalette(!app.paletteOpen);
        return;
      }
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1];
      if (!digit) return;
      e.preventDefault();
      const n = Number(digit);
      if (n === 1) return app.go({ kind: 'home' });
      const work = (tabs ?? []).filter((t) => t.kind !== 'root').sort((a, b) => a.order - b.order);
      const tab = work[n - 2];
      if (tab) app.go({ kind: 'tab', id: tab.id });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabs]);
}

/** The page is newer than the server process behind it: routes and fields it expects may not exist yet. */
function StaleServerBar() {
  const status = useApi<AppStatus>('/api/app/status');
  const [restarting, setRestarting] = useState(false);
  useEffect(() => {
    const check = () => status.refetch();
    const timer = setInterval(check, 60_000);
    window.addEventListener('focus', check);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', check);
    };
  }, [status.refetch]);
  if (!status.data?.stale) return null;
  const restart = () => {
    setRestarting(true);
    restartServer().catch((err) => {
      setRestarting(false);
      toastError(err);
    });
  };
  // Home lets clicks through the chrome to the canvas: the bar takes its own back.
  return (
    <div role="status" style={{ pointerEvents: 'auto' }} className="flex flex-none items-center gap-3 border-b border-line2 bg-[#2a170f] px-4 py-1 text-xs text-soft">
      <span className="min-w-0 truncate">{status.data.busy ? t('crash.staleBusy') : t('crash.staleHint')}</span>
      <button type="button" disabled={restarting} onClick={restart} className="press ml-auto flex-none rounded border border-line px-2 py-0.5 hover:text-fg disabled:opacity-60">{restarting ? t('crash.restarting') : t('crash.restart')}</button>
    </div>
  );
}

export function Unauthorized() {
  return (
    <div className="flex h-full items-center justify-center p-8">
      <div role="alert" className="max-w-md">
        <KeyRound size={18} className="mb-3 text-accent" />
        <h1 className="mb-2 text-base font-medium">{t('app.unauthorizedTitle')}</h1>
        <p className="text-muted">
          {t('app.unauthorizedBody')} <code className="selectable font-mono text-soft">/auth?token=…</code>, {t('app.unauthorizedToken')} <code className="selectable font-mono text-soft">data/token</code>.
        </p>
      </div>
    </div>
  );
}

export function App() {
  const view = useApp((s) => s.view);
  const unauthorized = useApp((s) => s.unauthorized);
  const connection = useApp((s) => s.connection);
  useShortcuts();
  useUiPluginLoader();
  useKitStatus(); // the project menus read it on a right click
  const home = view.kind === 'home' && !unauthorized;
  useEffect(() => {
    document.body.classList.toggle('on-home', home);
  }, [home]);

  if (unauthorized) return <Unauthorized />;

  return (
    <div className={cn('app-root flex h-full min-h-0 flex-col', view.kind === 'home' && 'on-home')}>
      <TitleBar />
      {connection === 'offline' && (
        <div role="status" className="flex flex-none items-center gap-2 border-b border-line2 bg-[#2a170f] px-4 py-1 text-xs text-soft">
          <WifiOff size={12} className="text-accent" />
          {t('app.offline')}
        </div>
      )}
      <StaleServerBar />
      <ObsidianNotice />
      <ProjectIconsOffer />
      <main className="relative flex min-h-0 flex-1 flex-col">
        {/* Home stays mounted so switching is instant and the universe keeps its pose. Its own boundary: a broken Home must not take every other screen with it. */}
        <ScreenBoundary resetKey="home" where="home" hidden={view.kind !== 'home'}>
          <Home visible={view.kind === 'home'} />
        </ScreenBoundary>
        <ScreenBoundary resetKey={JSON.stringify(view)} where={view.kind}>
        {view.kind === 'tab' && (
          <div className="work-base">
            <WorkView activeId={view.id} />
          </div>
        )}
        {(view.kind === 'sessions' || view.kind === 'analytics' || view.kind === 'tools' || view.kind === 'os-plugins' || view.kind === 'settings' || view.kind === 'entity' || view.kind === 'kanban' || view.kind === 'documents' || view.kind === 'projects') && (
          <div className="sheet">
            <Suspense fallback={<Skeleton className="p-6" lines={8} />}>
              {view.kind === 'sessions' && <SessionsView project={view.project ?? null} />}
              {view.kind === 'analytics' && <AnalyticsView />}
              {view.kind === 'tools' && <ToolsView pane={view.pane ?? 'skills'} />}
              {view.kind === 'os-plugins' && <OsPluginsView />}
              {view.kind === 'settings' && <SettingsView section={view.section ?? 'general'} />}
              {view.kind === 'entity' && <EntityPage type={view.type} id={view.id} project={view.project} />}
              {view.kind === 'kanban' && <KanbanBoard board={view.board} />}
              {view.kind === 'documents' && <DocumentsScreen project={view.project} pane={view.pane} />}
              {view.kind === 'projects' && <ProjectsView selected={view.key} />}
            </Suspense>
          </div>
        )}
        </ScreenBoundary>
        <NotePanel />
        <PlannerPanel />
        <RecoveryList />
      </main>
      <DesktopBar />
      <CommandPalette />
      <NewTabDialog />
      <ConnectFolderDialog />
      <MicrotaskDialog />
      <AskClaudeDialog />
      <RemoveDialogs />
      <IconPicker />
      <FileViewer />
      <DesktopHost />
      <ContextMenuHost />
      <ServiceTasks />
      <Toasts />
      <Tooltips />
      <PluginOverlays />
    </div>
  );
}
