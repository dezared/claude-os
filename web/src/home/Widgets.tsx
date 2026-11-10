import { ChevronDown, ChevronUp, ClipboardCopy, Code, Eye, LayoutGrid, ShieldAlert, Trash2, type LucideIcon } from 'lucide-react';
import * as React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from 'react';
import { claudeItems, useContextMenu } from '@/components/ContextMenu';
import { Markdown } from '@/components/Markdown';
import { Button, Dialog, IconButton } from '@/components/ui';
import { api, invalidateTopics, setCached, useApi } from '@/lib/api';
import { cn, fmtAgo, fmtInt } from '@/lib/format';
import { locale, t } from '@/lib/i18n';
import { askClaude, type AskSubject } from '@/lib/microtask';
import { toast, toastError } from '@/lib/store';
import { openTabWithPrompt } from '@/lib/tabs';
import type { AppStatus, HomeLayout, HomeSlot, SettingsView, WidgetAction, WidgetDef, WidgetValue, WidgetView } from '@/lib/types';
import { PluginBoundary } from '@/lib/uiPlugins';
import type { MenuItem } from './ActionMenu';
import { panelChangeItem } from './Customize';
import { BUILTIN_SLOT, EMPTY_HOME, measureZones, moved, NEIGHBOUR, sameStacks, SLOTS, stacks, zoneAt, type BuiltinId, type Zone } from './slots';

const HOLD_MS = 260;
const HOLD_SLOP = 6;
const GRIP_SLOP = 4;
const MIN_HEIGHT = 64;
const KEY_STEP = 16;
const HEAD_HEIGHT = 32; // .widget-head in styles.css
const MOVE_MS = 240;
const LEAVE_MS = 160;
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'; // --ease-drawer

export type Widgets = { defs: WidgetDef[]; values: WidgetValue[] };
/** A built-in's view. `bare` draws its own glass and shows the title only when collapsed; `fluid` gives up height to its neighbours and scrolls inside; `empty` takes it off the screen for now, its place in the layout kept; `auto` always follows its content, no height of its own. */
export type PanelView = { body: ReactNode; icon: LucideIcon; head?: (collapsed: boolean) => ReactNode; bare?: boolean; fluid?: boolean; empty?: boolean; auto?: boolean };
type Size = { width: number; height: number };
type Arrow = 'ArrowLeft' | 'ArrowRight' | 'ArrowUp' | 'ArrowDown';

const windowSize = (): Size => ({ width: window.innerWidth, height: window.innerHeight });
const isArrow = (key: string): key is Arrow => key === 'ArrowLeft' || key === 'ArrowRight' || key === 'ArrowUp' || key === 'ArrowDown';
const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

const BUILTIN_FILE: Record<BuiltinId, string> = { projects: 'web/src/home/ProjectsPanel.tsx', tokens: 'web/src/home/TokensPanel.tsx', stats: 'web/src/home/BottomStrip.tsx', notes: 'web/src/home/UniverseHud.tsx', progress: 'web/src/home/ProgressPanel.tsx' };
const BUILTIN_TITLE: Record<BuiltinId, () => string> = { projects: () => t('projects.title'), tokens: () => t('tokens.title'), stats: () => t('custom.stats'), notes: () => t('widget.notes'), progress: () => t('progress.title') };
const isBuiltin = (id: string): id is BuiltinId => id in BUILTIN_SLOT;
const PATHS_OF_THIS_PC = /\/home\/|[A-Z]:\\/;

export const widgetTitle = (id: string, defs: WidgetDef[]) => (isBuiltin(id) ? BUILTIN_TITLE[id]() : defs.find((d) => d.id === id)?.title);

/** The entry as it is in config/widgets.json: without what the server adds for the interface. */
function entryOf(def: WidgetDef) {
  const { approved: _approved, iconSvg: _iconSvg, ...entry } = def;
  return entry;
}

function subject(def: WidgetDef): AskSubject {
  const entry = entryOf(def);
  return {
    kind: 'widget',
    name: def.title,
    context: `Its entry in \`../config/widgets.json\` now:\n${JSON.stringify(entry)}\n\nEdit only this entry: keep its id and slot, give it a short title in the user's language. A number or a line of text: the simplest type that shows it, as described in your CLAUDE.md. Anything with structure (progress, a status, a list, a chart, a button), or an entry with a \`view\`: load the claude-os-widgets skill first and build it as data plus its own view in \`../config/widgets/\`. A new or changed command or view stays pending until the user approves it on the widget: say so if that happens.`,
  };
}

function fill(def: WidgetDef) {
  askClaude({ subject: subject(def), intent: 'change', title: t('widget.fillTitle'), placeholder: t('widget.fillPlaceholder') });
}

type ViewSource = { file: string; sha: string; text: string };

/** A new tab in the root of the Claude OS repository, to work on the widget together with the user. */
function develop(def: WidgetDef, cwd: string) {
  const prompt = `Develop the Claude OS widget "${def.title}" together with the user. The working directory is the root of the Claude OS repository. The widget's entry in \`config/widgets.json\` now:\n${JSON.stringify(entryOf(def))}\n\nFirst read \`plugins/os-builder/skills/claude-os-widgets/SKILL.md\` and follow it. Keep its id and slot, keep \`icon\` (a Lucide name) and \`description\` (what it shows, Markdown) filled in. A new or changed command or view stays pending until the user approves it on the widget: say so if that happens. Start by asking the user what to change.`;
  openTabWithPrompt({ cwd, prompt, title: def.title, source: 'widget', sourceDetail: def.id }).catch(toastError);
}

/** A fence longer than any run of backticks inside, so the code cannot close it. */
function fenced(lang: string, text: string): string {
  const longest = Math.max(2, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const fence = '`'.repeat(longest + 1);
  return `${fence}${lang}\n${text.replace(/\n$/, '')}\n${fence}`;
}

/** Everything another Claude OS needs to build the same widget: the user passes the file on, the receiver creates from it. */
function widgetMarkdown(def: WidgetDef, view: ViewSource | null): string {
  const head = [`title: ${JSON.stringify(def.title)}`, def.icon && `icon: ${def.icon}`, `type: ${def.type}`, def.type === 'command' && `intervalSec: ${def.intervalSec}`, def.slot && `slot: ${def.slot}`].filter(Boolean);
  const parts = [`---\n${head.join('\n')}\n---`];
  if (def.description) parts.push(def.description);
  if (def.type === 'command') parts.push(`## Command\n\n${fenced('sh', def.command)}`);
  if (def.type === 'file') parts.push(`## File\n\n${fenced('json', JSON.stringify({ path: def.path, ...(def.pointer ? { pointer: def.pointer } : {}) }, null, 2))}`);
  if (def.type === 'note') parts.push(`## Note\n\n${def.noteId}`);
  if (def.type === 'block' && def.content) parts.push(`## Content\n\n${fenced('md', def.content)}`);
  if (def.action) parts.push(`## Action\n\n${fenced('json', JSON.stringify(def.action, null, 2))}`);
  if (view) parts.push(`## View \`${view.file}\`\n\n${fenced('js', view.text)}`);
  return parts.join('\n\n') + '\n';
}

async function copyAsMarkdown(def: WidgetDef) {
  try {
    const view = def.view?.sha ? await api<ViewSource>(`/api/widgets/${encodeURIComponent(def.id)}/view/source`) : null;
    const text = widgetMarkdown(def, view);
    await navigator.clipboard.writeText(text);
    toast(t(PATHS_OF_THIS_PC.test(text) ? 'widget.copiedPaths' : 'widget.copied'));
  } catch (e) {
    toastError(e);
  }
}

/** One approval for what a widget runs: its command on the PC and its view in the interface, each shown as it will run. */
function ApproveWidget({ def, onClose }: { def: WidgetDef; onClose: () => void }) {
  const [busy, setBusy] = useState(false);
  const [source, setSource] = useState<ViewSource | null>(null);
  const command = def.type === 'command' ? def : null;
  useEffect(() => {
    if (!def.view?.sha) return;
    api<ViewSource>(`/api/widgets/${encodeURIComponent(def.id)}/view/source`).then(setSource, toastError);
  }, [def.id, def.view?.sha]);
  const code = 'selectable mb-3 overflow-auto rounded-md border border-line2 bg-bg p-3 font-mono text-xs text-soft';
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()} title={t(def.view ? 'widget.approveWidgetTitle' : 'widget.approveTitle')} description={t('widget.approveDesc', { title: def.title })}>
      {command && (
        <>
          <p className="mb-2 text-muted">{t('widget.approveBody', { n: fmtInt(command.intervalSec) })}</p>
          <pre className={code}>{command.command}</pre>
        </>
      )}
      {def.view && (
        <>
          <p className="mb-2 text-muted">{t('widget.approveView', { file: def.view.file })}</p>
          <pre className={cn(code, 'max-h-72')}>{source?.text ?? '…'}</pre>
        </>
      )}
      <div className="flex justify-end gap-2">
        <Button onClick={onClose}>{t('common.cancel')}</Button>
        <Button
          variant="primary"
          disabled={busy || (!!def.view && !source)}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/api/widgets/${encodeURIComponent(def.id)}/approve`, { method: 'POST', body: { command: command?.command, view: source?.sha } });
              onClose();
            } catch (e) {
              toastError(e);
            } finally {
              setBusy(false);
            }
          }}
        >
          {t('widget.approveAction')}
        </Button>
      </div>
    </Dialog>
  );
}

/** The widget's button: a new tab in its folder that starts with its prompt. */
function ActionButton({ action, title, value }: { action: WidgetAction; title: string; value: WidgetValue | undefined }) {
  const [busy, setBusy] = useState(false);
  const ready = !action.readyWhen || (!value?.error && !!value?.value?.includes(action.readyWhen));
  async function run() {
    setBusy(true);
    try {
      await openTabWithPrompt({ cwd: action.cwd, prompt: action.prompt, title });
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Button size="sm" variant={ready ? 'primary' : 'outline'} disabled={!ready || busy} onClick={() => void run()} title={action.prompt} className="mt-2 self-start">
      {action.label}
    </Button>
  );
}

/** What a widget's own view gets: its value as the command, file or note gave it, and its button if it has one. */
export interface WidgetViewProps {
  title: string;
  value: string | null;
  error: string | null;
  updatedAt: number | null;
  action?: WidgetAction;
  /** Opens a tab in action.cwd and sends action.prompt. */
  run?: () => Promise<void>;
}

/** What config/widgets/<file>.js gets in activate(host): React comes from the app, the module has no build. */
const viewHost = { React, api, toast, toastError, lang: locale, openTab: openTabWithPrompt };
type ViewModule = { activate: (host: typeof viewHost) => ComponentType<WidgetViewProps> };
const views = new Map<string, Promise<ComponentType<WidgetViewProps>>>();

/** One import per version of the code: the hash in the address is what the user approved. */
function loadView(id: string, sha: string): Promise<ComponentType<WidgetViewProps>> {
  const url = `/api/widgets/${encodeURIComponent(id)}/view?v=${sha}`;
  let found = views.get(url);
  if (!found) {
    found = import(/* @vite-ignore */ url).then((mod: ViewModule) => mod.activate(viewHost));
    found.catch(() => views.delete(url));
    views.set(url, found);
  }
  return found;
}

function useWidgetView(id: string, view: WidgetView): { View?: ComponentType<WidgetViewProps>; error?: string } | null {
  const [state, setState] = useState<{ sha: string; View?: ComponentType<WidgetViewProps>; error?: string } | null>(null);
  useEffect(() => {
    const { sha } = view;
    if (!view.approved || !sha) return;
    let live = true;
    loadView(id, sha).then(
      (View) => live && setState({ sha, View }),
      (e: Error) => live && setState({ sha, error: e.message }),
    );
    return () => {
      live = false;
    };
  }, [id, view.sha, view.approved]);
  return state?.sha === view.sha ? state : null;
}

function Pending({ onApprove }: { onApprove: () => void }) {
  return (
    <button type="button" onClick={onApprove} className="press flex items-center gap-1 rounded text-[12px] text-accent hover:text-accent-hover">
      <ShieldAlert size={12} />
      {t('widget.pending')}
    </button>
  );
}

/** A widget that draws itself with its own code. Nothing of it runs before the approval: not the command, not the view. */
function OwnView({ def, value, onApprove }: { def: WidgetDef & { view: WidgetView }; value: WidgetValue | undefined; onApprove: () => void }) {
  const loaded = useWidgetView(def.id, def.view);
  const failed = (error: string) => <span className="text-[12px] text-bad" title={error}>{t('widget.viewFailed', { file: def.view.file })}</span>;
  if (!def.view.sha) return <span className="text-[12px] text-bad">{t('widget.viewNoFile', { file: def.view.file })}</span>;
  if (!def.view.approved || (def.type === 'command' && !def.approved)) return <Pending onApprove={onApprove} />;
  if (loaded?.error) return failed(loaded.error);
  if (!loaded?.View) return null;
  const { View } = loaded;
  const { action, title } = def;
  const run = action ? () => openTabWithPrompt({ cwd: action.cwd, prompt: action.prompt, title }).catch(toastError) : undefined;
  return (
    <PluginBoundary fallback={failed('render')}>
      <View title={title} value={value?.value ?? null} error={value?.error ?? null} updatedAt={value?.updatedAt ?? null} action={action} run={run} />
    </PluginBoundary>
  );
}

function BlockBody({ def, value, onApprove }: { def: WidgetDef; value: WidgetValue | undefined; onApprove: () => void }) {
  if (def.view) return <OwnView def={def as WidgetDef & { view: WidgetView }} value={value} onApprove={onApprove} />;
  return <BlockText def={def} value={value} onApprove={onApprove} />;
}

function BlockText({ def, value, onApprove }: { def: WidgetDef; value: WidgetValue | undefined; onApprove: () => void }) {
  if (!def.action) return <BlockValue def={def} value={value} onApprove={onApprove} />;
  return (
    <div className="flex flex-col">
      <BlockValue def={def} value={value} onApprove={onApprove} />
      <ActionButton action={def.action} title={def.title} value={value} />
    </div>
  );
}

function BlockValue({ def, value, onApprove }: { def: WidgetDef; value: WidgetValue | undefined; onApprove: () => void }) {
  if (def.type === 'block') {
    if (def.content) return <Markdown small text={def.content} />;
    return (
      <button type="button" onClick={() => fill(def)} className="press size-full rounded-lg text-center text-[12px] text-muted hover:text-fg">
        {t('custom.widgetHint')}
      </button>
    );
  }
  if (def.type === 'command' && !def.approved) return <Pending onApprove={onApprove} />;
  if (value?.error) return <span className="text-[12px] text-accent" title={value.error}>{t('widget.error')}</span>;
  return (
    <div className="text-[13px] whitespace-pre-wrap wrap-anywhere text-soft" title={value?.updatedAt ? t('widget.updated', { ago: fmtAgo(value.updatedAt) }) : undefined}>
      {value?.value ?? '–'}
    </div>
  );
}

/** The whole layout is written at once: what stands in a slot only means something next to its neighbours. */
function saveHome(home: HomeLayout) {
  setCached<SettingsView>('/api/settings', (old) => ({ ...(old as SettingsView), home }));
  api('/api/settings/home', { method: 'PUT', body: home }).catch((e) => {
    toastError(e);
    invalidateTopics(['settings']);
  });
}

function place(id: string, slot: HomeSlot, height?: number) {
  setCached<Widgets>('/api/widgets', (old) => ({
    defs: (old?.defs ?? []).map((d) => {
      if (d.id !== id) return d;
      const { box, ...rest } = d;
      const kept = height ?? d.height ?? box?.h;
      return { ...rest, slot, ...(kept === undefined ? {} : { height: kept }) } as WidgetDef;
    }),
    values: old?.values ?? [],
  }));
  api(`/api/widgets/${encodeURIComponent(id)}/place`, { method: 'PUT', body: height === undefined ? { slot } : { slot, height } }).catch((e) => {
    toastError(e);
    invalidateTopics(['widgets']);
  });
}

function deleteEntry(id: string) {
  setCached<Widgets>('/api/widgets', (old) => ({ defs: (old?.defs ?? []).filter((d) => d.id !== id), values: old?.values ?? [] }));
  api(`/api/widgets/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch((e) => {
    toastError(e);
    invalidateTopics(['widgets']);
  });
}

/** Into the trash: off the screen, in the list in Settings, its place in the layout kept for when it comes back. */
export function trashWidget(home: HomeLayout, id: string, title: string) {
  saveHome({ ...home, hidden: [...home.hidden, id] });
  toast(t('widget.trashed', { title }));
}

export const restoreWidget = (home: HomeLayout, id: string) => saveHome({ ...home, hidden: home.hidden.filter((x) => x !== id) });

/** Out of the trash for good. A block loses its entry; a built-in has none, so the layout remembers it is gone. */
export function purgeWidget(home: HomeLayout, id: string) {
  const without = (list: string[] = []) => list.filter((x) => x !== id);
  const { [id]: _height, ...heights } = home.heights ?? {};
  const slots = Object.fromEntries(Object.entries(home.slots).map(([slot, list]) => [slot, without(list)]));
  saveHome({ ...home, slots, hidden: without(home.hidden), collapsed: without(home.collapsed), heights, removed: isBuiltin(id) ? [...(home.removed ?? []), id] : home.removed });
  if (!isBuiltin(id)) deleteEntry(id);
}

const setCollapsed = (home: HomeLayout, id: string, on: boolean) => saveHome({ ...home, collapsed: on ? [...(home.collapsed ?? []), id] : (home.collapsed ?? []).filter((x) => x !== id) });

/** widget.restore on the core: what is in the trash has no place of its own to be right-clicked. */
export function restoreItems(home: HomeLayout, defs: WidgetDef[]): MenuItem[] {
  return home.hidden.flatMap((id) => {
    const title = widgetTitle(id, defs);
    return title === undefined ? [] : [{ id: `widget.restore.${id}`, label: t('widget.restore', { title }), icon: Eye, onSelect: () => restoreWidget(home, id) }];
  });
}

/** Press and hold anywhere on a widget, or just pull its title; before that the press stays an ordinary click, scroll or text selection. */
type Lift = (e: ReactPointerEvent<HTMLElement>, id: string) => void;

/** Every widget, a block or a built-in: the same title, collapse, height, menu and way of moving. */
function Frame({
  id,
  title,
  icon: Icon,
  iconSvg,
  description,
  tipOnly,
  onDevelop,
  head,
  bare,
  fluid,
  height,
  collapsed,
  items,
  home,
  onSize,
  lift,
  onArrow,
  refocus,
  children,
}: {
  id: string;
  title: string;
  icon?: LucideIcon;
  iconSvg?: string;
  description?: string;
  /** The description stays in the title's tooltip, never a line in the body. */
  tipOnly?: boolean;
  onDevelop?: () => void;
  head?: (collapsed: boolean) => ReactNode;
  bare?: boolean;
  fluid?: boolean;
  height: number | undefined;
  collapsed: boolean;
  items: MenuItem[];
  home: HomeLayout;
  onSize?: (height: number) => void;
  lift: Lift;
  onArrow: (id: string, title: string, key: Arrow) => void;
  refocus: RefObject<string | null>;
  children: ReactNode;
}) {
  const own = useRef<HTMLDivElement | null>(null);
  const clicked = useRef(false);
  const draft = useRef<number | null>(null);
  const toggle = () => setCollapsed(home, id, !collapsed);
  const leave = () => {
    const el = own.current;
    const done = () => trashWidget(home, id, title);
    if (!el || calm()) return done();
    el.animate([{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.96)' }], { duration: LEAVE_MS, easing: 'ease-in', fill: 'forwards' }).onfinish = done;
  };
  const menu: MenuItem[] = [
    ...items,
    { id: 'widget.collapse', label: t(collapsed ? 'widget.expand' : 'widget.collapse', { title }), icon: collapsed ? ChevronDown : ChevronUp, onSelect: toggle },
    { id: 'widget.remove', label: t('widget.remove', { title }), icon: Trash2, danger: true, apart: true, onSelect: leave },
  ];
  // Inside a row with a menu of its own the row is the subject, not the panel around it.
  const area = useContextMenu((e) => ((e.target as Element).closest('[data-own-menu]') ? null : menu));
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      own.current = el;
      return area(el);
    },
    [area],
  );
  // A move between slots makes a new element: the keyboard stays with the widget.
  useLayoutEffect(() => {
    if (refocus.current !== id) return;
    refocus.current = null;
    own.current?.focus();
  });
  const inline = !!description && !bare && !tipOnly;
  const limit = (h: number) => Math.round(Math.max(MIN_HEIGHT, Math.min(h, window.innerHeight * 0.9)));

  // While the hand is on it the widget follows the hand; the store hears about it once, at the end.
  const grab = (e: ReactPointerEvent<HTMLDivElement>) => {
    const box = own.current;
    if (e.button !== 0 || !box) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const from = { y: e.clientY, h: box.offsetHeight };
    let last: number | null = null;
    el.setPointerCapture(e.pointerId);
    box.classList.add('is-sizing');
    const onMove = (m: PointerEvent) => {
      last = limit(from.h + m.clientY - from.y);
      box.style.height = `${last}px`;
    };
    const onUp = () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointercancel', onUp);
      box.classList.remove('is-sizing');
      if (last !== null) onSize?.(last);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onUp);
  };

  return (
    <div
      ref={setRef}
      role="group"
      aria-label={title}
      aria-description={t('widget.keys')}
      data-widget={id}
      tabIndex={0}
      style={height === undefined ? undefined : { height: collapsed ? HEAD_HEIGHT : height }}
      onPointerDown={(e) => lift(e, id)}
      onFocus={(e) => {
        clicked.current = e.currentTarget.matches(':active');
      }}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') return toggle();
        // Only if the keyboard brought the focus: after a click the arrows still fly the camera.
        if (!isArrow(e.key) || clicked.current) return;
        e.preventDefault();
        e.stopPropagation();
        if (!e.shiftKey) {
          if (!e.repeat) onArrow(id, title, e.key);
        } else if (onSize && !collapsed && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
          // Shift with up and down is the height: on the keyboard's own rhythm, saved when the key is let go.
          draft.current = limit(e.currentTarget.offsetHeight + (e.key === 'ArrowDown' ? KEY_STEP : -KEY_STEP));
          e.currentTarget.classList.add('is-sizing');
          e.currentTarget.style.height = `${draft.current}px`;
        }
      }}
      onKeyUp={(e) => {
        if (draft.current === null) return;
        e.currentTarget.classList.remove('is-sizing');
        onSize?.(draft.current);
        draft.current = null;
      }}
      className={cn('home-widget outline-none focus-visible:ring-1 focus-visible:ring-accent', collapsed && 'is-collapsed', bare ? 'is-bare' : 'glass rounded-2xl', fluid && height === undefined && 'is-fluid', height !== undefined && 'has-height')}
    >
      <div
        data-widget-grip
        title={description && (collapsed || !inline) ? `${title}\n\n${description}` : title}
        onClick={(e) => {
          if (collapsed && !(e.target as Element).closest('button, a')) toggle();
        }}
        className={cn('widget-head group', bare && 'glass rounded-2xl')}
      >
        {iconSvg ? <span aria-hidden data-widget-icon className="widget-icon flex-none text-accent" style={{ maskImage: `url("data:image/svg+xml;utf8,${encodeURIComponent(iconSvg)}")` }} /> : Icon && <Icon size={13} data-widget-icon className="flex-none text-accent" />}
        <h2 className="min-w-0 flex-1 truncate text-[12px] font-medium text-soft">{title}</h2>
        {head?.(collapsed)}
        {onDevelop && (
          <IconButton label={t('widget.develop')} className="widget-dev size-6 flex-none" onClick={onDevelop}>
            <Code size={13} />
          </IconButton>
        )}
        <IconButton label={t(collapsed ? 'widget.expand' : 'widget.collapse', { title })} aria-expanded={!collapsed} className="widget-toggle size-6 flex-none" onClick={toggle}>
          <ChevronUp size={13} className={cn('transition-transform duration-200', collapsed && 'rotate-180')} />
        </IconButton>
      </div>
      <div className="widget-body">
        <div className="widget-body-inner">
          {inline && <Markdown small text={description!} className="widget-desc" />}
          {children}
        </div>
      </div>
      {onSize && !collapsed && (
        <div onPointerDown={grab} data-widget-resize aria-hidden className="absolute right-0 bottom-0 size-4 cursor-ns-resize touch-none">
          <svg viewBox="0 0 16 16" className="size-full text-dim">
            <path d="M12 7 7 12M12 10.5 10.5 12" stroke="currentColor" strokeLinecap="round" fill="none" />
          </svg>
        </div>
      )}
    </div>
  );
}

type Target = { slot: HomeSlot; line: { top: number; left: number; width: number } | null };

/** The slots while something looks for a place. A drag renders this once per slot it crosses, not once per pointer move. */
function ZoneMarks({ zones, target }: { zones: Zone[]; target: Target | null }) {
  return (
    <div data-widget-zones aria-hidden className="pointer-events-none fixed inset-0 z-[46]">
      {zones.map((z) => (
        <div key={z.slot} data-zone={z.slot} className={cn('home-zone', target?.slot === z.slot && 'is-target')} style={{ left: z.left, top: z.top, width: z.right - z.left, height: z.bottom - z.top }}>
          <span>{t(`slot.${z.slot}`)}</span>
        </div>
      ))}
      {target?.line && <div className="home-zone-line" style={target.line} />}
    </div>
  );
}

/** A new block: choose the slot it stands in. */
function Placer({ onPlace, onCancel }: { onPlace: (slot: HomeSlot) => void; onCancel: () => void }) {
  const [zones] = useState(() => measureZones(document.querySelector('.home-layer')!));
  const [target, setTarget] = useState<Target | null>(null);
  const place = useRef(onPlace);
  const cancel = useRef(onCancel);
  place.current = onPlace;
  cancel.current = onCancel;

  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Enter') return;
      e.preventDefault();
      e.stopPropagation();
      if (e.key === 'Escape') cancel.current();
      else place.current('right');
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div
      data-widget-placer
      style={{ pointerEvents: 'auto' }}
      className="fixed inset-0 z-[45] cursor-pointer touch-none"
      onContextMenu={(e) => {
        e.preventDefault();
        onCancel();
      }}
      onPointerMove={(e) => {
        const { slot } = zoneAt(zones, e.clientX, e.clientY);
        if (slot !== target?.slot) setTarget({ slot, line: null });
      }}
      onClick={(e) => onPlace(zoneAt(zones, e.clientX, e.clientY).slot)}
    >
      <div role="status" className="popover fixed top-14 left-1/2 z-[47] -translate-x-1/2 rounded-xl px-3.5 py-2 text-[13px] whitespace-nowrap text-soft">
        {t('widget.placeHint')}
      </div>
      <ZoneMarks zones={zones} target={target} />
    </div>
  );
}

/** Keeps a drag's own click from reaching a project row or a button under the hand. */
function swallowClick() {
  const stop = (e: MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
  };
  window.addEventListener('click', stop, { capture: true, once: true });
  setTimeout(() => window.removeEventListener('click', stop, { capture: true }), 0);
}

/**
 * The home screen's slots and everything that stands in them. No widget has a place in pixels: dropping one always lands in a slot.
 * A drag moves a copy of the widget with a bare transform and writes nothing until the drop, and `data-covers-map` pauses the map under it.
 */
export function HomeSlots({ panels, before, after, coreKey, placing, onPlaced }: { panels: Record<BuiltinId, PanelView>; before: ReactNode; after: ReactNode; coreKey: string | null; placing: boolean; onPlaced: () => void }) {
  const widgets = useApi<Widgets>('/api/widgets', ['widgets']);
  const settings = useApi<SettingsView>('/api/settings', ['settings']);
  const status = useApi<AppStatus>('/api/app/status');
  const [approve, setApprove] = useState<WidgetDef | null>(null);
  const [size, setSize] = useState(windowSize);
  const [zones, setZones] = useState<Zone[] | null>(null);
  const [target, setTarget] = useState<Target | null>(null);
  const [said, setSaid] = useState('');
  const refocus = useRef<string | null>(null);

  useEffect(() => {
    const onResize = () => setSize(windowSize());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const defs = widgets.data?.defs ?? [];
  const home = settings.data?.home ?? EMPTY_HOME;
  const osRoot = status.data?.repo; // the Claude OS repository itself: config/ and plugins/ are right under it
  const all = stacks(home, defs, size);
  const shown = (slot: HomeSlot) => all[slot].filter((id) => !home.hidden.includes(id) && !(isBuiltin(id) && panels[id].empty));

  // Whatever changes the order, whoever changed it: each widget glides from where it stood. The old places are read before React touches the page.
  const order = SLOTS.map((slot) => shown(slot).join('\0')).join('\n');
  const seen = useRef(order);
  const first = useRef<Map<string, DOMRect> | null>(null);
  const landing = useRef<{ id: string; rect: DOMRect } | null>(null);
  if (seen.current !== order) {
    seen.current = order;
    first.current = new Map([...document.querySelectorAll<HTMLElement>('.home-layer [data-widget]')].map((el) => [el.dataset.widget!, el.getBoundingClientRect()]));
  }
  useLayoutEffect(() => {
    const from = first.current;
    const landed = landing.current;
    first.current = null;
    landing.current = null;
    if (!from?.size || calm()) return;
    const options = { duration: MOVE_MS, easing: EASE };
    for (const el of document.querySelectorAll<HTMLElement>('.home-layer [data-widget]')) {
      const id = el.dataset.widget!;
      const was = landed?.id === id ? landed.rect : from.get(id);
      const now = el.getBoundingClientRect();
      if (!was) el.animate([{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }], options);
      else if (Math.abs(was.left - now.left) > 1 || Math.abs(was.top - now.top) > 1) el.animate([{ transform: `translate(${was.left - now.left}px,${was.top - now.top}px)` }, { transform: 'none' }], options);
    }
  }, [order]);

  const moveTo = (id: string, to: HomeSlot, before: string | null) => {
    const next = moved(all, id, to, before);
    if (sameStacks(all, next)) return false;
    saveHome({ ...home, slots: next });
    const def = defs.find((d) => d.id === id);
    if (def && (def.slot !== to || def.box)) place(id, to);
    return true;
  };

  const lift: Lift = (e, id) => {
    const start = e.target as Element;
    if (e.button !== 0 || start.closest('[data-widget-resize], input, textarea, select')) return;
    const el = e.currentTarget;
    const pointer = e.pointerId;
    const from = { x: e.clientX, y: e.clientY };
    const eager = !!start.closest('[data-widget-grip]') && !start.closest('button, a');
    let at = from;

    const disarm = () => {
      window.clearTimeout(timer);
      window.removeEventListener('pointermove', onArmed);
      window.removeEventListener('pointerup', disarm);
      window.removeEventListener('pointercancel', disarm);
    };
    const onArmed = (m: PointerEvent) => {
      at = { x: m.clientX, y: m.clientY };
      const far = Math.hypot(at.x - from.x, at.y - from.y);
      if (far <= (eager ? GRIP_SLOP : HOLD_SLOP)) return;
      disarm();
      if (eager) begin();
    };
    const timer = eager ? 0 : window.setTimeout(() => {
      disarm();
      begin();
    }, HOLD_MS);
    window.addEventListener('pointermove', onArmed);
    window.addEventListener('pointerup', disarm);
    window.addEventListener('pointercancel', disarm);

    const begin = () => {
      const layer = el.closest('.home-layer');
      if (!layer) return;
      const dropZones = measureZones(layer);
      const rect = el.getBoundingClientRect();
      const others = new Map(SLOTS.map((slot) => [slot, shown(slot).filter((x) => x !== id).map((x) => ({ id: x, r: layer.querySelector(`[data-widget="${CSS.escape(x)}"]`)!.getBoundingClientRect() }))]));

      const ghost = el.cloneNode(true) as HTMLElement;
      for (const a of ['data-widget', 'role', 'tabindex', 'aria-label', 'aria-description']) ghost.removeAttribute(a);
      ghost.setAttribute('aria-hidden', 'true');
      ghost.setAttribute('data-covers-map', '');
      ghost.classList.add('widget-ghost');
      ghost.style.cssText += `left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;`;

      document.body.classList.add('widget-dragging');
      document.body.append(ghost);
      el.classList.add('is-lifted');
      getSelection()?.removeAllRanges();
      el.setPointerCapture(pointer);
      setZones(dropZones);

      let slot: HomeSlot | null = null;
      let before: string | null = null;
      const follow = (x: number, y: number) => {
        ghost.style.transform = `translate(${x - from.x}px,${y - from.y}px)`;
        const zone = zoneAt(dropZones, x, y);
        const list = others.get(zone.slot) ?? [];
        const next = list.find((o) => y < o.r.top + o.r.height / 2) ?? null;
        if (zone.slot === slot && (next?.id ?? null) === before) return;
        slot = zone.slot;
        before = next?.id ?? null;
        const last = list.at(-1);
        const lineTop = next ? next.r.top - 6 : last ? last.r.bottom + 4 : null;
        setTarget({ slot, line: lineTop === null ? null : { top: lineTop, left: zone.left, width: zone.right - zone.left } });
      };
      const onMove = (m: PointerEvent) => follow(m.clientX, m.clientY);
      const end = (drop: boolean) => {
        el.removeEventListener('pointermove', onMove);
        el.removeEventListener('pointerup', onUp);
        el.removeEventListener('pointercancel', onLost);
        el.removeEventListener('lostpointercapture', onLost);
        window.removeEventListener('keydown', onEscape, true);
        if (drop) landing.current = { id, rect: ghost.getBoundingClientRect() };
        ghost.remove();
        el.classList.remove('is-lifted');
        document.body.classList.remove('widget-dragging');
        setZones(null);
        setTarget(null);
        if (drop && slot) moveTo(id, slot, before);
      };
      const onUp = () => {
        swallowClick();
        end(true);
      };
      const onLost = () => end(false);
      const onEscape = (k: globalThis.KeyboardEvent) => {
        if (k.key !== 'Escape') return;
        k.preventDefault();
        k.stopPropagation();
        end(false);
      };
      el.addEventListener('pointermove', onMove);
      el.addEventListener('pointerup', onUp);
      el.addEventListener('pointercancel', onLost);
      el.addEventListener('lostpointercapture', onLost);
      window.addEventListener('keydown', onEscape, true);
      follow(at.x, at.y);
    };
  };

  const onArrow = (id: string, title: string, key: Arrow) => {
    const slot = SLOTS.find((s) => all[s].includes(id));
    if (!slot) return;
    const list = shown(slot);
    const i = list.indexOf(id);
    let to = slot;
    let before: string | null;
    if (key === 'ArrowUp' && i > 0) before = list[i - 1];
    else if (key === 'ArrowDown' && i < list.length - 1) before = list[i + 2] ?? null;
    else {
      const next = NEIGHBOUR[slot][key];
      if (!next) return;
      to = next;
      before = key === 'ArrowDown' ? (shown(next)[0] ?? null) : null;
    }
    refocus.current = id;
    if (moveTo(id, to, before)) setSaid(t('widget.moved', { title, slot: t(`slot.${to}`) }));
  };

  const create = async (slot: HomeSlot) => {
    onPlaced();
    try {
      const def = await api<WidgetDef>('/api/widgets', { method: 'POST', body: { title: t('widget.newTitle'), type: 'block', slot } });
      setCached<Widgets>('/api/widgets', (old) => ({ defs: [...(old?.defs ?? []).filter((d) => d.id !== def.id), def], values: old?.values ?? [] }));
      fill(def);
    } catch (e) {
      toastError(e);
    }
  };

  const renderWidget = (id: string, slot: HomeSlot) => {
    const shared = { home, lift, onArrow, refocus, collapsed: !!home.collapsed?.includes(id) };
    if (isBuiltin(id)) {
      const { body, empty: _empty, auto, ...view } = panels[id];
      const title = BUILTIN_TITLE[id]();
      const file = BUILTIN_FILE[id];
      const items = [panelChangeItem(title, file, coreKey), ...claudeItems({ kind: 'panel', name: title, context: `A built-in panel of the Claude OS home screen, a core component: \`${file}\`.` }).filter((i) => i.id === 'claude.ask')];
      const onSize = view.bare || auto ? undefined : (height: number) => saveHome({ ...home, heights: { ...home.heights, [id]: height } });
      return <Frame key={id} id={id} title={title} description={t(`widget.about.${id}`)} tipOnly {...view} {...shared} items={items} height={auto ? undefined : home.heights?.[id]} onSize={onSize}>{body}</Frame>;
    }
    const def = defs.find((d) => d.id === id)!;
    const height = def.height ?? (def.box ? Math.max(MIN_HEIGHT, def.box.h) : undefined);
    return (
      <Frame
        key={id}
        id={id}
        title={def.title}
        icon={LayoutGrid}
        iconSvg={def.iconSvg}
        description={def.description}
        onDevelop={osRoot ? () => develop(def, osRoot) : undefined}
        {...shared}
        items={[...claudeItems(subject(def)), { id: 'widget.copyMd', label: t('widget.copyMd'), icon: ClipboardCopy, onSelect: () => void copyAsMarkdown(def) }]}
        height={height}
        onSize={(h) => place(id, slot, h)}
      >
        <div className="selectable min-h-0 flex-1 overflow-auto px-3 pb-3">
          <BlockBody def={def} value={widgets.data?.values.find((v) => v.id === id)} onApprove={() => setApprove(def)} />
        </div>
      </Frame>
    );
  };

  const renderSlot = (slot: HomeSlot) => (
    <div data-slot={slot} className="home-slot">
      {shown(slot).map((id) => renderWidget(id, slot))}
    </div>
  );

  // Until the layout is known nothing stands anywhere: a moved panel must not start out in its old place.
  const known = !!(settings.data || settings.error);
  return (
    <>
      <div className="home-center">
        {before}
        {known && renderSlot('top')}
        {after}
      </div>
      {known && (
        <div className="home-col" data-col="left">
          {renderSlot('left')}
          {renderSlot('bottom-left')}
        </div>
      )}
      {known && (
        <div className="home-col" data-col="right">
          {renderSlot('right')}
          {renderSlot('bottom-right')}
        </div>
      )}
      <div role="status" className="sr-only">{said}</div>
      {zones && <ZoneMarks zones={zones} target={target} />}
      {placing && <Placer onPlace={create} onCancel={onPlaced} />}
      {approve && <ApproveWidget def={approve} onClose={() => setApprove(null)} />}
    </>
  );
}
