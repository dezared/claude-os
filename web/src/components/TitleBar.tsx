import { FileText, Library, AppWindow, ArrowLeft, ArrowRight, BarChart3, Bot, Boxes, Eye, History, Layers, ListChecks, Menu, MessagesSquare, NotebookPen, Orbit, Plus, RefreshCw, RotateCcw, Search, Settings, SquareKanban, Wrench, X } from 'lucide-react';
import { useCallback, useRef, useState } from 'react';
import { ActionMenu, type MenuItem } from '@/home/ActionMenu';
import { runSetupAgain } from '@/home/SetupModal';
import { useApi } from '@/lib/api';
import { cn, statusLabel } from '@/lib/format';
import { useApp } from '@/lib/store';
import { closeRootTab, closeTab, reopenClosedTab, reorderTabs, useClosedTabs, useRootTab } from '@/lib/tabs';
import type { Overview, Tab } from '@/lib/types';
import { popoutItems, rootPlaceItems, usePoppedOut } from '@/popout/PopoutButton';
import { ContextArea, useContextMenu } from './ContextMenu';
import { FullscreenButton, useCaptionRoom } from './DesktopHost';
import { LimitsBadge } from './LimitsBadge';
import { ServiceTasksButton } from './ServiceTasks';
import { StatusDot } from './StatusDot';
import { useTabStrip } from './useTabStrip';
import { t } from '@/lib/i18n';

function TabItem({
  tab,
  label = tab.title,
  index,
  selected,
  onDragStart,
  onDropOn,
  dragging,
  onClose,
}: {
  tab: Tab;
  label?: string;
  index: number;
  selected: boolean;
  onDragStart: () => void;
  onDropOn: () => void;
  dragging: boolean;
  onClose?: () => void; // the root session's tab: closing it only takes it off the strip
}) {
  const close = onClose ?? (() => void closeTab(tab));
  const go = useApp((s) => s.go);
  const [over, setOver] = useState(false);
  const popped = usePoppedOut(tab);
  return (
    <ContextArea items={() => popoutItems(tab)}>
    <div
      role="tab"
      tabIndex={0}
      aria-selected={selected}
      title={`${label} · ${statusLabel(tab.status)}${tab.kind === 'readonly' ? ` · ${t('nav.readOnlySuffix')}` : ''}${index >= 0 && index < 8 ? ` · Ctrl+${index + 2}` : ''}`}
      draggable={!onClose}
      onDragStart={(e) => {
        e.dataTransfer.effectAllowed = 'move';
        onDragStart();
      }}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        onDropOn();
      }}
      onClick={() => go({ kind: 'tab', id: tab.id })}
      onAuxClick={(e) => {
        if (e.button === 1) close();
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go({ kind: 'tab', id: tab.id });
        }
      }}
      className={cn(
        'tab-pill group flex max-w-52 flex-none items-center gap-2 pr-1 pl-2.5 whitespace-nowrap focus-visible:-outline-offset-2',
        selected ? 'is-selected text-fg' : 'text-muted hover:bg-white/[.06] hover:text-fg',
        dragging && 'opacity-40',
        over && !dragging && 'bg-raised',
      )}
    >
      {(tab.status === 'ended' || (tab.kind === 'document' && tab.status === 'idle')) && !tab.attention ? (
        tab.kind === 'readonly' ? <Eye size={12} className="flex-none text-dim" /> : tab.kind === 'document' ? <FileText size={12} className="flex-none text-dim" /> : <MessagesSquare size={12} className="flex-none text-dim" />
      ) : (
        <StatusDot status={tab.status} attention={tab.attention} />
      )}
      <span className="min-w-0 truncate">{label}</span>
      {popped && <AppWindow size={11} aria-label={t('popout.isOut')} className="flex-none text-accent" />}
      {tab.queued > 0 && <span className="font-mono text-[10px] text-dim" title={t('nav.queued', { n: tab.queued })}>+{tab.queued}</span>}
      <button
        type="button"
        aria-label={t('nav.closeTab', { title: label })}
        onClick={(e) => {
          e.stopPropagation();
          close();
        }}
        className="press flex size-5 flex-none items-center justify-center rounded text-dim opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-white/10 hover:text-fg focus-visible:opacity-100"
      >
        <X size={12} />
      </button>
    </div>
    </ContextArea>
  );
}

const menuScreens = [
  { kind: 'projects', label: 'nav.projects', icon: Layers },
  { kind: 'analytics', label: 'nav.analytics', icon: BarChart3 },
  { kind: 'kanban', label: 'nav.kanban', icon: SquareKanban },
  { kind: 'documents', label: 'documents.title', icon: Library },
  { kind: 'tools', label: 'nav.tools', icon: Wrench },
  { kind: 'os-plugins', label: 'tools.osPlugins', icon: Boxes },
  { kind: 'settings', label: 'nav.settings', icon: Settings },
] as const;

/** The app's main screens: this menu and the core's on the map. */
export function screenItems(): MenuItem[] {
  const { go, openPlanner } = useApp.getState();
  return [
    ...menuScreens.map(({ kind, label, icon }) => ({ id: kind, label: t(label), icon, onSelect: () => go({ kind }) })),
    { id: 'agents', label: t('tools.agents'), icon: Bot, onSelect: () => go({ kind: 'tools', pane: 'agents' }) },
    { id: 'planner', label: t('planner.title'), icon: NotebookPen, onSelect: () => openPlanner() },
  ];
}

function ScreensMenu() {
  const view = useApp((s) => s.view);
  const [open, setOpen] = useState(false);
  const current = menuScreens.some((s) => s.kind === view.kind);
  return (
    <ActionMenu
      label={t('nav.menu')}
      side="bottom"
      align="end"
      open={open}
      onOpenChange={setOpen}
      items={[...screenItems(), { id: 'setup.again', label: t('setup.modal.again'), icon: ListChecks, apart: true, onSelect: () => void runSetupAgain() }, { id: 'app.reload', label: t('nav.reload'), icon: RefreshCw, onSelect: () => window.location.reload() }]}
      trigger={
        <button
          type="button"
          aria-label={t('nav.menu')}
          aria-haspopup="menu"
          aria-expanded={open}
          title={t('nav.menu')}
          className={cn('press flex h-7 items-center rounded-md px-2', current ? 'bg-white/[.12] text-fg' : 'text-muted hover:bg-white/[.08] hover:text-fg')}
        >
          <Menu size={15} />
        </button>
      }
    />
  );
}

export function TitleBar() {
  const view = useApp((s) => s.view);
  const go = useApp((s) => s.go);
  const openNewTab = useApp((s) => s.openNewTab);
  const setPalette = useApp((s) => s.setPalette);
  const step = useApp((s) => s.step);
  const canBack = useApp((s) => s.historyAt > 0);
  const canForward = useApp((s) => s.historyAt < s.history.length - 1);
  const tabs = useApi<Tab[]>('/api/tabs', ['tabs']);
  const overview = useApi<Overview>('/api/overview', ['overview']);
  const dragId = useRef<string | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const caption = useCaptionRoom();
  const rootOut = usePoppedOut(tabs.data?.find((x) => x.kind === 'root'));
  const rootTabOpen = useRootTab((s) => s.open);
  // Empty strip, every tab on it and the logo alike. Asked at the click: the list changes without a render here.
  const reopenItems = (): MenuItem[] => (useClosedTabs.getState().items.length ? [{ id: 'tabs.reopen', label: t('tabs.reopen'), icon: RotateCcw, onSelect: () => void reopenClosedTab() }] : []);
  const stripMenu = useContextMenu(reopenItems);

  const work = (tabs.data ?? []).filter((t) => t.kind !== 'root').sort((a, b) => a.order - b.order);
  const root = (tabs.data ?? []).find((t) => t.kind === 'root');
  const version = overview.data?.claudeVersion;
  const rootOnStrip = !!root && rootTabOpen;
  // A new tab becomes active before it is on the list: it counts from the moment it can be scrolled to.
  const activeOnStrip = view.kind === 'tab' && (work.some((x) => x.id === view.id) || (rootOnStrip && root.id === view.id)) ? view.id : null;
  const { strip, row, edges } = useTabStrip(activeOnStrip);
  const tabCount = work.length + (rootOnStrip ? 1 : 0);
  const stripRef = useCallback(
    (el: HTMLDivElement | null) => {
      strip.current = el;
      return stripMenu(el);
    },
    [strip, stripMenu],
  );

  const drop = (target: Tab) => {
    const from = work.findIndex((t) => t.id === dragId.current);
    const to = work.findIndex((t) => t.id === target.id);
    setDragging(null);
    dragId.current = null;
    if (from < 0 || to < 0 || from === to) return;
    const next = work.slice();
    next.splice(to, 0, next.splice(from, 1)[0]);
    void reorderTabs(next);
  };

  return (
    <nav aria-label={t('nav.aria')} className={cn('titlebar flex h-11 flex-none items-stretch', caption && 'has-caption')}>
      {/* The logo is the way Home: it glows while Home is on screen. The root session's state and places ride on it. */}
      <ContextArea items={() => [...rootPlaceItems(root), ...reopenItems()]}>
        <button
          type="button"
          aria-label={t('nav.home')}
          aria-current={view.kind === 'home' ? 'page' : undefined}
          title={`${t('nav.home')} · Ctrl+1`}
          onClick={() => go({ kind: 'home' })}
          className={cn(
            'titlebar-logo press my-1.5 mr-1.5 ml-2 flex flex-none items-center gap-2 rounded-lg px-1.5 font-semibold tracking-[-.01em] whitespace-nowrap focus-visible:-outline-offset-2',
            view.kind === 'home' ? 'is-home text-fg' : 'text-muted hover:bg-white/[.06] hover:text-fg',
          )}
        >
          <Orbit size={15} className="text-accent" />
          <span className="hidden min-[900px]:inline">Claude OS</span>
          {root && root.status !== 'idle' && root.status !== 'ended' && <StatusDot status={root.status} attention={root.attention} />}
          {root?.attention && root.status === 'idle' && <StatusDot status={root.status} attention />}
          {rootOut && <AppWindow size={11} aria-label={t('popout.isOut')} className="flex-none text-accent" />}
        </button>
      </ContextArea>
      <div className="hidden flex-none items-center gap-0.5 pr-2 min-[560px]:flex">
        <button type="button" disabled={!canBack} aria-label={t('nav.back')} title={`${t('nav.back')} · Alt+←`} onClick={() => step(-1)} className="press flex size-7 items-center justify-center rounded-md text-muted enabled:hover:bg-white/[.08] enabled:hover:text-fg disabled:opacity-35">
          <ArrowLeft size={14} />
        </button>
        <button type="button" disabled={!canForward} aria-label={t('nav.forward')} title={`${t('nav.forward')} · Alt+→`} onClick={() => step(1)} className="press flex size-7 items-center justify-center rounded-md text-muted enabled:hover:bg-white/[.08] enabled:hover:text-fg disabled:opacity-35">
          <ArrowRight size={14} />
        </button>
      </div>
      <div
        ref={stripRef}
        role="tablist"
        aria-label={t('nav.tabs')}
        className={cn('tabstrip flex min-w-0 items-center overflow-x-auto py-1.5', edges.overflowing && 'is-overflowing', edges.before && 'fade-start', edges.after && 'fade-end')}
        onDragEnd={() => setDragging(null)}
      >
        <div ref={row} className="flex w-max flex-none items-center gap-1">
        {root && rootTabOpen && (
          <TabItem
            tab={root}
            label={t('root.caption')}
            index={-1}
            selected={view.kind === 'tab' && view.id === root.id}
            dragging={false}
            onDragStart={() => {}}
            onDropOn={() => {}}
            onClose={() => closeRootTab(root.id)}
          />
        )}
        {work.map((t, i) => (
          <TabItem
            key={t.id}
            tab={t}
            index={i}
            selected={view.kind === 'tab' && view.id === t.id}
            dragging={dragging === t.id}
            onDragStart={() => {
              dragId.current = t.id;
              setDragging(t.id);
            }}
            onDropOn={() => drop(t)}
          />
        ))}
        </div>
      </div>
      <span
        aria-hidden={!edges.overflowing}
        title={t('nav.tabsTotal', { n: tabCount })}
        className={cn('tabstrip-count no-drag font-mono text-[11px] text-dim', edges.overflowing && 'is-on')}
      >
        {tabCount}
      </span>
      <button
        type="button"
        aria-label={t('nav.newTab')}
        title={t('nav.newTab')}
        onClick={() => openNewTab()}
        className="press my-1.5 ml-1 flex w-8 flex-none items-center justify-center rounded-lg text-muted hover:bg-white/[.08] hover:text-fg focus-visible:-outline-offset-2"
      >
        <Plus size={15} />
      </button>
      {/* Empty space of the bar is what drags the window. */}
      <div className="min-w-2 flex-1 min-[560px]:min-w-8" />
      <div
        className={cn('titlebar-right flex flex-none items-center gap-0.5 pr-2 pl-2', caption?.on && 'is-clear')}
        style={caption ? ({ '--caption-w': `${caption.width}px` } as React.CSSProperties) : undefined}
      >
        {version && (
          <span className="mr-2 hidden text-xs whitespace-nowrap text-dim min-[1280px]:inline">
            Claude Code {version}
          </span>
        )}
        <LimitsBadge />
        <ServiceTasksButton />
        <button
          type="button"
          onClick={() => setPalette(true)}
          aria-label={t('nav.palette')}
          title={`${t('nav.palette')} · Ctrl+K`}
          className="press flex h-7 items-center gap-1.5 rounded-md px-2 text-muted hover:bg-white/[.08] hover:text-fg"
        >
          <Search size={13} />
          <kbd className="hidden font-sans text-[11px] min-[1100px]:inline">Ctrl K</kbd>
        </button>
        <button
          type="button"
          onClick={() => go({ kind: 'sessions' })}
          aria-label={t('nav.sessions')}
          aria-current={view.kind === 'sessions' ? 'page' : undefined}
          title={t('nav.sessions')}
          className={cn(
            'press flex h-7 items-center gap-1.5 rounded-md px-2',
            view.kind === 'sessions' ? 'bg-white/[.12] text-fg' : 'text-muted hover:bg-white/[.08] hover:text-fg',
          )}
        >
          <History size={14} />
          <span className="hidden min-[1500px]:inline">{t('nav.sessions')}</span>
        </button>
        <FullscreenButton />
        <ScreensMenu />
      </div>
    </nav>
  );
}
