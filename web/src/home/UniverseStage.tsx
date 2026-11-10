import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { openContextMenu, useContextMenu } from '@/components/ContextMenu';
import type { MenuItem } from './ActionMenu';
import { useApi, type Query } from '@/lib/api';
import { cn, fmtInt } from '@/lib/format';
import { t, tn } from '@/lib/i18n';
import { useApp } from '@/lib/store';
import type { MemoryGraph, MemoryNode, Project, ProjectIcons, SettingsView, UniverseOptions } from '@/lib/types';
import { chosenColors, skyColors } from './universe/colors';
import { coreMenu } from './universe/menu';
import type { OrbitSession } from './universe/orbits';
import { DEFAULT_MAP_LIMIT, projectParents } from './universe/selection';
import { Universe } from './universe/Universe';

function Tip({ node, projectName }: { node: MemoryNode; projectName: (key: string | null) => string }) {
  return (
    <>
      <b className="block font-medium wrap-anywhere text-fg">{node.title}</b>
      {node.summary && <span className="mt-0.5 block text-[12px] leading-snug wrap-anywhere text-soft">{node.summary}</span>}
      <small className="mt-1 block text-[11px] text-muted">
        {projectName(node.project)} · {fmtInt(node.degree)} {tn('unit.link', node.degree)}
        {!node.connected && ` · ${t('universe.readOnly')}`}
      </small>
    </>
  );
}

const DEFAULT_UNIVERSE: UniverseOptions = { limit: DEFAULT_MAP_LIMIT, theme: 'default', colors: {}, crossLinks: false, nesting: false };

/** Fills the window behind everything, title bar included. Off Home it keeps a dimmed still frame. */
export function UniverseStage({
  visible,
  graph,
  highlight,
  orbit,
  live,
  onMap,
  colored,
  corePulse,
  universe,
  onUnsupported,
  onBadge,
  onCoreMenu,
  widgetMenu,
}: {
  visible: boolean;
  graph: Query<MemoryGraph>;
  highlight: Set<string> | null;
  orbit: string | null | undefined;
  live: Map<string, OrbitSession[]>;
  onMap: Set<string> | null; // null until it is known
  colored: string[];
  corePulse: boolean;
  universe: RefObject<Universe | null>;
  onUnsupported: () => void;
  onBadge: (key: string | null, rect: DOMRect | null, viaKeyboard: boolean) => void;
  onCoreMenu: () => void;
  widgetMenu: MenuItem[]; // part of the core's menu; without WebGL there is no core and the stage is just empty space that offers it
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const stageArea = useContextMenu(widgetMenu);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const projects = useApi<Project[]>('/api/projects', ['projects']);
  const icons = useApi<ProjectIcons>('/api/project-icons', ['projects']);
  const settings = useApi<SettingsView>('/api/settings', ['settings']);
  const options = settings.data?.universe ?? DEFAULT_UNIVERSE;
  const noteId = useApp((s) => s.noteId);
  const menu = useRef<() => MenuItem[][]>(() => []);
  menu.current = () => coreMenu({ projects: projects.data ?? [], options, widget: widgetMenu });
  const [hover, setHover] = useState<MemoryNode | null>(null);

  const projectName = useMemo(() => {
    const names = new Map((projects.data ?? []).map((p) => [p.key, p.name]));
    return (key: string | null) => (key == null ? t('universe.globalGroup') : (names.get(key) ?? key));
  }, [projects.data]);

  useEffect(() => {
    const gl = canvasRef.current ? Universe.supported(canvasRef.current) : null;
    if (!gl) {
      onUnsupported();
      return;
    }
    const u = new Universe(canvasRef.current!, gl, stageRef.current!, labelsRef.current!, {
      onHover: setHover,
      onOpen: (node) => useApp.getState().openNote(node.id),
      onBadge,
      onMenu: (x, y) => {
        onCoreMenu(); // the core's popover would stand under the menu
        openContextMenu(x, y, menu.current());
      },
    });
    universe.current = u;
    return () => {
      u.destroy();
      universe.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Off the map means off the map: a project's stars and its links go together.
  const mapGraph = useMemo(() => {
    if (!graph.data || !onMap) return null;
    const core = graph.data.coreProject ?? null;
    const nodes = graph.data.nodes.filter((n) => n.project === null || n.project === core || onMap.has(n.project));
    if (nodes.length === graph.data.nodes.length) return graph.data;
    const ids = new Set(nodes.map((n) => n.id));
    return { ...graph.data, nodes, edges: graph.data.edges.filter(([a, b]) => ids.has(a) && ids.has(b)) };
  }, [graph.data, onMap]);
  useEffect(() => {
    if (mapGraph) universe.current?.setGraph(mapGraph);
  }, [mapGraph, universe]);
  useEffect(() => universe.current?.setNames(projectName), [projectName, universe]);
  const mapped = useMemo(() => [...(onMap ?? [])].sort(), [onMap]);
  const liveOnMap = useMemo(() => (onMap ? new Map([...live].filter(([key]) => onMap.has(key))) : live), [live, onMap]);
  useEffect(() => universe.current?.setProjects(liveOnMap, mapped, colored), [liveOnMap, mapped, colored, universe]);
  const chosen = useMemo(() => chosenColors(projects.data), [projects.data]);
  useEffect(() => universe.current?.setChosenColors(chosen), [chosen, universe]);
  const lookKey = JSON.stringify([options.theme, options.colors, options.crossLinks, options.nesting, (projects.data ?? []).map((p) => [p.key, p.root, p.misc, p.parent, p.folder])]);
  useEffect(() => {
    universe.current?.setLook(skyColors(options), options.crossLinks, options.nesting ? projectParents(projects.data ?? []) : new Map());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lookKey, universe]);
  useEffect(() => universe.current?.setCorePulse(corePulse), [corePulse, universe]);
  const iconData = icons.data;
  useEffect(() => {
    if (iconData) universe.current?.setIcons(iconData.icons, iconData.chosen);
  }, [iconData, universe]);
  // A modal or a large panel over the map: nothing moves behind it. Portals land right under body.
  useEffect(() => {
    const check = () => universe.current?.setCovered(noteId !== null || !!document.querySelector('[data-covers-map]'));
    const watcher = new MutationObserver(check);
    watcher.observe(document.body, { childList: true });
    check();
    return () => watcher.disconnect();
  }, [noteId, universe]);
  useEffect(() => universe.current?.setEmphasis(orbit), [orbit, universe]);
  useEffect(() => universe.current?.setVisible(visible), [visible, universe]);
  useEffect(() => universe.current?.setSelected(noteId), [noteId, universe]);
  useEffect(() => universe.current?.setHighlight(highlight), [highlight, universe]);

  const count = graph.data?.nodes.length ?? 0;
  // The card belongs to the star, not to the pointer: the map places it from here on, every frame, without React.
  const tipRef = useRef<HTMLDivElement>(null);
  const tipOn = hover && visible ? hover.id : null;
  useEffect(() => {
    universe.current?.anchorTip(tipRef.current);
    return () => universe.current?.anchorTip(null);
  }, [tipOn, universe]);

  return (
    <div
      ref={(el) => {
        stageRef.current = el;
        return stageArea(el);
      }}
      className={cn('universe-stage', !visible && 'is-still')}
    >
      <canvas
        ref={canvasRef}
        data-universe
        tabIndex={visible ? 0 : -1}
        aria-label={t('universe.aria', { n: fmtInt(count), notes: tn('unit.note', count) })}
        className="absolute inset-0 size-full cursor-grab touch-none outline-none"
      />
      <div ref={labelsRef} className={cn('u-labels', !visible && 'hidden')} />
      {hover && visible && (
        <div ref={tipRef} aria-live="polite" role="tooltip" className="u-tip">
          <Tip node={hover} projectName={projectName} />
        </div>
      )}
    </div>
  );
}
