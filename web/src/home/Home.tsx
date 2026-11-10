import { Coins, FileDown, Layers, LayoutGrid, ListChecks, Sparkle, Wrench } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi } from '@/lib/api';
import { cn, isLive } from '@/lib/format';
import { serverText, t } from '@/lib/i18n';
import { runMicrotask } from '@/lib/microtask';
import type { MemoryGraph, Overview, Project, SessionInfo, SettingsView, Tab } from '@/lib/types';
import type { MenuItem } from './ActionMenu';
import { BottomStrip } from './BottomStrip';
import { ProgressCount, ProgressPanel, useProgressRows } from './ProgressPanel';
import { ProjectPopover } from './ProjectPopover';
import { ProjectsCount, ProjectsPanel } from './ProjectsPanel';
import { RemoveProjectDialog } from './RemoveProjectDialog';
import { RootChat } from './RootChat';
import { TokensHead, TokensPanel } from './TokensPanel';
import { NotesCount, UniverseHud, UniverseStatus, ViewControls } from './UniverseHud';
import { UniverseStage } from './UniverseStage';
import { HomeSlots, restoreItems, type PanelView, type Widgets } from './Widgets';
import { popoutItems, usePoppedOut } from '@/popout/PopoutButton';
import { EMPTY_HOME, type BuiltinId } from './slots';
import { MigrateDialog } from './MigrateDialog';
import { SetupModal } from './SetupModal';
import { chosenColors, makePalette } from './universe/colors';
import { orbitSession, RUNNING_SUBAGENT_MS, type OrbitSession } from './universe/orbits';
import { DEFAULT_MAP_LIMIT, mapKeys } from './universe/selection';
import type { Universe } from './universe/Universe';

const POPOVER_CLOSE_MS = 240;
const RUNNING_RECHECK_MS = 10_000;

function IndexBanner({ overview }: { overview: Overview | undefined }) {
  const index = overview?.index;
  if (!index || (!index.formatWarning && !index.indexing)) return null;
  const pct = index.filesTotal > 0 ? Math.min(100, (index.filesDone / index.filesTotal) * 100) : 0;
  return (
    <div className="flex w-full max-w-[520px] flex-col gap-1.5">
      {index.formatWarning && (
        <div role="alert" className="glass rounded-xl px-3.5 py-2 text-xs text-soft">
          {serverText(index.formatWarning, index.formatWarningKey, index.formatWarningParams)}
        </div>
      )}
      {index.indexing && (
        <div role="status" className="glass relative overflow-hidden rounded-xl px-3.5 py-1.5 text-xs text-muted">
          {t('index.catchingUp')} <span className="text-soft">{index.filesDone}</span> {t('index.of')} <span className="text-soft">{index.filesTotal}</span> {t('index.files')}
          <span className="absolute inset-x-0 bottom-0 h-px overflow-hidden">
            {index.filesTotal > 0 ? (
              <span className="block h-full origin-left bg-accent transition-transform duration-200" style={{ transform: `scaleX(${pct / 100})` }} />
            ) : (
              <span className="progress-indet block h-full w-1/3 bg-accent" />
            )}
          </span>
        </div>
      )}
    </div>
  );
}

export function Home({ visible }: { visible: boolean }) {
  const overview = useApi<Overview>('/api/overview', ['overview']);
  const graph = useApi<MemoryGraph>('/api/memory/graph', ['memory']);
  const sessions = useApi<SessionInfo[]>('/api/sessions', ['sessions']);
  const projects = useApi<Project[]>('/api/projects', ['projects']);
  const tabs = useApi<Tab[]>('/api/tabs', ['tabs']);
  const universe = useRef<Universe | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [highlight, setHighlight] = useState<Set<string> | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [migrate, setMigrate] = useState<string | null>(null);
  const onHighlight = useCallback((ids: Set<string> | null) => setHighlight(ids), []);
  const onUnsupported = useCallback(() => setUnsupported(true), []);
  const onFly = useCallback((key: string) => universe.current?.flyTo(key) ?? false, []);
  // Straight to the map: hovering down a list of a hundred projects must not render Home once per row.
  const onFocusProject = useCallback((key: string | null | undefined) => universe.current?.setFocus(key), []);
  const coreKey = graph.data?.coreProject ?? null;
  const rootKey = graph.data?.rootProject ?? null;
  const noted = useMemo(() => {
    const keys = new Set(graph.data?.nodes.map((n) => n.project));
    if (coreKey) keys.add(coreKey);
    return keys;
  }, [graph.data, coreKey]);

  // The root session's own folder is not a project of its own: it is part of the core.
  const liveSessions = useMemo(
    () => (sessions.data ?? []).filter((s) => isLive(s.status)).map((s) => (s.project === rootKey && coreKey ? { ...s, project: coreKey } : s)),
    [sessions.data, rootKey, coreKey],
  );
  // Nothing tells us a subagent stopped: silence does. The clock only ticks while one is still counted as running.
  const [clock, setClock] = useState(() => Date.now());
  useEffect(() => setClock(Date.now()), [liveSessions]);
  const counting = liveSessions.some((s) => s.subagents.some((a) => a.lastActivity != null && clock - a.lastActivity < RUNNING_SUBAGENT_MS));
  useEffect(() => {
    if (!counting) return;
    const timer = window.setInterval(() => setClock(Date.now()), RUNNING_RECHECK_MS);
    return () => window.clearInterval(timer);
  }, [counting]);
  const live = useMemo(() => {
    const m = new Map<string, OrbitSession[]>();
    const known = new Set(projects.data?.map((p) => p.key));
    if (coreKey) known.add(coreKey);
    for (const s of liveSessions) {
      if (!s.project || !known.has(s.project)) continue;
      const list = m.get(s.project);
      if (list) list.push(orbitSession(s, clock));
      else m.set(s.project, [orbitSession(s, clock)]);
    }
    return m;
  }, [liveSessions, projects.data, coreKey, clock]);
  const rootWorking = !!tabs.data?.some((x) => x.kind === 'root' && x.status === 'working') || !!sessions.data?.some((s) => s.project === rootKey && rootKey !== null && s.status === 'working');
  const coreNotes = useMemo(() => (graph.data?.nodes ?? []).filter((n) => n.project === coreKey || n.project === null).sort((a, b) => b.mtime - a.mtime), [graph.data, coreKey]);
  // Every project that could stand on the map counts here, so a limit changes no colour.
  const colored = useMemo(() => {
    const mapped = (projects.data ?? []).filter((p) => noted.has(p.key) || p.liveCount > 0 || p.pinned).map((p) => p.key);
    return [...new Set([...mapped, ...[...noted].filter((k): k is string => k !== null)])].sort();
  }, [projects.data, noted]);
  const palette = useMemo(() => makePalette(colored, coreKey, chosenColors(projects.data)), [colored, coreKey, projects.data]);
  const settings = useApi<SettingsView>('/api/settings', ['settings']);
  const limit = settings.data?.universe?.limit ?? DEFAULT_MAP_LIMIT;
  const known = !!graph.data && !!(projects.data || projects.error) && !!(settings.data || settings.error);
  const chosen = useMemo(() => (known ? mapKeys(projects.data ?? [], noted, coreKey, limit) : null), [known, projects.data, noted, coreKey, limit]);
  // The list is refetched with every session event; the map only hears about it when the answer changes.
  const chosenKey = chosen && [...chosen].sort().join('\0');
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const onMap = useMemo(() => chosen, [chosenKey]);

  // The popover stays while the pointer travels from the badge into it: leaving only starts a short timer.
  const [popover, setPopover] = useState<{ key: string; rect: DOMRect; focus: boolean; beside: boolean } | null>(null);
  const closeTimer = useRef<number | null>(null);
  const hold = useRef(false);
  const keepOpen = useCallback(() => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  }, []);
  const closeSoon = useCallback(() => {
    if (hold.current) return;
    keepOpen();
    closeTimer.current = window.setTimeout(() => {
      closeTimer.current = null;
      // The right-click menu of the popover is open: decide again when it is gone.
      if (document.querySelector('[data-context-menu]')) return closeSoon();
      // The pointer made it inside: stay. Asked of the browser, not inferred from enter and leave events.
      if (!document.querySelector('[data-project-popover]:hover')) setPopover(null);
    }, POPOVER_CLOSE_MS);
  }, [keepOpen]);
  const onBadge = useCallback((key: string | null, rect: DOMRect | null, viaKeyboard: boolean) => {
    if (key === null || !rect) return closeSoon();
    if (hold.current) return;
    keepOpen();
    setPopover({ key, rect, focus: viaKeyboard, beside: false });
  }, [closeSoon, keepOpen]);
  const onSessions = useCallback((key: string, rect: DOMRect) => {
    keepOpen();
    setPopover({ key, rect, focus: true, beside: true });
  }, [keepOpen]);
  const closePopover = useCallback(() => {
    keepOpen();
    hold.current = false;
    setPopover(null);
  }, [keepOpen]);
  useEffect(() => {
    if (!visible) closePopover();
  }, [visible, closePopover]);
  // Empty key: a core without a project of its own.
  const popoverKey = popover ? popover.key || coreKey : undefined;
  const anchoredKey = popover && !popover.beside ? (popoverKey ?? null) : undefined;
  const onAnchor = useMemo(() => (anchoredKey === undefined ? undefined : (el: HTMLElement | null) => universe.current?.anchorCard(el, anchoredKey)), [anchoredKey]);

  const [placing, setPlacing] = useState(false);
  const onPlaced = useCallback(() => setPlacing(false), []);
  useEffect(() => {
    if (!visible) setPlacing(false);
  }, [visible]);
  const widgets = useApi<Widgets>('/api/widgets', ['widgets']);
  const homeLayout = settings.data?.home ?? EMPTY_HOME;
  const widgetDefs = widgets.data?.defs;
  const rootTab = tabs.data?.find((x) => x.kind === 'root');
  // The one part of the screen that is no widget, and in a window of its own it is not on this screen at all: the way back is on the core.
  const rootOut = usePoppedOut(rootTab);
  const widgetMenu = useMemo<MenuItem[]>(() => [{ id: 'widget.create', label: t('widget.create'), icon: LayoutGrid, onSelect: () => setPlacing(true) }, { id: 'widget.createFromMd', label: t('widget.createFromMd'), icon: FileDown, onSelect: () => runMicrotask({ id: 'widget-create', project: coreKey, title: t('widget.createFromMd'), placeholder: t('widget.pasteMd') }) }, ...restoreItems(homeLayout, widgetDefs ?? []), ...(rootOut && rootTab ? popoutItems(rootTab) : [])], [homeLayout, widgetDefs, rootOut, rootTab, coreKey]);
  const progressRows = useProgressRows(tabs.data);
  const panels: Record<BuiltinId, PanelView> = {
    projects: { icon: Layers, fluid: true, head: () => <ProjectsCount coreKey={coreKey} />, body: <ProjectsPanel coreKey={coreKey} onMap={onMap} palette={palette} onFocusProject={onFocusProject} onFly={onFly} onSessions={onSessions} onMigrate={setMigrate} onRemove={setRemoving} /> },
    tokens: { icon: Coins, fluid: true, head: (collapsed) => <TokensHead collapsed={collapsed} />, body: <TokensPanel /> },
    stats: { icon: Wrench, bare: true, body: <BottomStrip overview={overview} /> },
    notes: { icon: Sparkle, bare: true, head: () => <NotesCount graph={graph} />, body: <UniverseHud graph={graph} universe={universe} onHighlight={onHighlight} /> },
    progress: { icon: ListChecks, auto: true, empty: progressRows.length === 0, head: () => <ProgressCount rows={progressRows} />, body: <ProgressPanel rows={progressRows} /> },
  };

  return (
    <>
      <UniverseStage visible={visible} graph={graph} highlight={highlight} orbit={popoverKey} live={live} onMap={onMap} colored={colored} corePulse={rootWorking} universe={universe} onUnsupported={onUnsupported} onBadge={onBadge} onCoreMenu={closePopover} widgetMenu={widgetMenu} />
      <div className={cn('home-layer', !visible && 'is-off')}>
        <HomeSlots
          panels={panels}
          before={<IndexBanner overview={overview.data} />}
          after={
            <>
              <UniverseStatus graph={graph} unsupported={unsupported} />
              {!rootOut && <RootChat />}
            </>
          }
          coreKey={coreKey}
          placing={placing}
          onPlaced={onPlaced}
        />
        <div className="home-view">
          <ViewControls graph={graph} universe={universe} />
        </div>
        {popover && (
          <ProjectPopover
            projectKey={popoverKey ?? null}
            isCore={popoverKey === coreKey}
            project={projects.data?.find((p) => p.key === popoverKey)}
            sessions={liveSessions.filter((s) => s.project === popoverKey)}
            coreNotes={coreNotes}
            color={palette.css(popoverKey ?? null)}
            anchor={popover.rect}
            beside={popover.beside}
            autoFocus={popover.focus}
            onEnter={keepOpen}
            onLeave={closeSoon}
            onHold={(on) => {
              hold.current = on;
            }}
            onClose={closePopover}
            onAnchor={onAnchor}
            onFly={onFly}
            mapped={popoverKey ? onMap?.has(popoverKey) : undefined}
            onMigrate={(key) => {
              closePopover();
              setMigrate(key);
            }}
            onRemove={(key) => {
              closePopover();
              setRemoving(key);
            }}
          />
        )}
      </div>
      {removing && <RemoveProjectDialog projectKey={removing} onClose={() => setRemoving(null)} />}
      <MigrateDialog project={migrate} onClose={() => setMigrate(null)} />
      <SetupModal visible={visible} />
    </>
  );
}
