// Interface code of enabled Claude OS plugins: loaded and dropped while the app runs, through a few named places in the file panel, the composer and the burger menu.
import type { LucideIcon } from 'lucide-react';
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { create } from 'zustand';
import { HtmlFrame } from '@/components/HtmlFrame';
import { Fold, Pop, Roll } from '@/components/Motion';
import { Empty, ErrorState, Skeleton } from '@/components/states';
import type { MenuItem } from '@/home/ActionMenu';
import { BTW_COMMAND, OFF_CHAT, SECRET_COMMAND } from '../../../shared/commands.ts';
import { api, useApi } from './api';
import { useFlip } from './flip';
import { highlightCode } from './highlight';
import { locale, t } from './i18n';
import { LEAVE_MS, reducedMotion, usePresence } from './motion';
import { toast, toastError, useApp } from './store';
import { openTabWithPrompt } from './tabs';
import type { CommandInfo, OsPluginUi, ProjectFile } from './types';
import type { MentionSource } from '@/work/mentionSources';
import { pluginHost } from './pluginHost';

export interface FileViewProps {
  tabId: string;
  path: string;
  file: ProjectFile;
  line: number | null;
  /** Only where the pane around the view can change its width. */
  setPaneWidth?: (px: number) => void;
}

/** Runs in the browser when `/name args` is sent from a composer; nothing reaches Claude. */
export interface PluginCommand {
  name: string;
  description?: string;
  argumentHint?: string;
  run: (args: string, where: { tabId: string }) => void | Promise<void>;
}

/** A full screen of a plugin, opened from the burger menu and the command palette; with perProject also from each project's page. */
export interface PluginScreen {
  id: string; // also the view a session opens with ui_action, when the plugin's server part names it
  title: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  component: React.ComponentType<{ arg?: string }>; // arg: what the screen opens on, a project key for perProject
  perProject?: boolean;
}

/** What a plugin's `activate(host)` returns. */
export interface UiContribution {
  fileIcon?: (entry: { name: string; path: string; dir: boolean; expanded: boolean }) => React.ReactNode;
  fileMenu?: (entry: { path: string; dir: boolean }, where: { tabId: string }) => MenuItem[];
  fileView?: React.ComponentType<FileViewProps>;
  /** fileView also takes this file when the app sees bytes it cannot show as text, or more of them than it reads. */
  opensMedia?: (path: string) => boolean;
  commands?: PluginCommand[];
  /** Mounted once per window for as long as the plugin is active, above every screen. Renders null when it has nothing to show. Disabled, it stays LEAVE_MS more with `leaving` for its exit. */
  overlay?: React.ComponentType<{ leaving?: boolean }>;
  /** A small state mark in the composer's foot, next to the focus mark. */
  composerMark?: React.ComponentType;
  screens?: PluginScreen[];
  /** A section of the composer's @ menu. */
  mentions?: MentionSource;
  dispose?: () => void;
}

const openChat = (req: { cwd: string; title?: string; prompt: string }) => openTabWithPrompt(req).catch(toastError);
const motion = { Pop, Fold, Roll, useFlip, usePresence };
const host = { React, ReactDOM, api, useApi, highlight: highlightCode, toast, toastError, lang: locale, openChat, HtmlFrame, motion };
// The rest of what a plugin screen needs to look like the app (pluginHost.ts), made on first use.
const fullHost = () => ({ ...host, ...pluginHost() });

const loaded = new Map<string, UiContribution>();
const pending = new Set<string>();
const failed = new Set<string>();
let wanted: OsPluginUi[] = [];

// `waiting`: wanted plugins neither loaded nor failed yet, so a screen of one of them can wait instead of saying it is gone.
const useContributions = create<{ list: UiContribution[]; waiting: number }>(() => ({ list: [], waiting: 0 }));
// Overlays of plugins just disabled, kept for their exit under the key they had.
type LeavingOverlay = { key: string; Part: NonNullable<UiContribution['overlay']> };
const useLeaving = create<{ list: LeavingOverlay[] }>(() => ({ list: [] }));
export const useUiPlugins = () => useContributions((s) => s.list);
const publish = () => useContributions.setState({
  list: wanted.flatMap((p) => loaded.get(p.url) ?? []),
  waiting: wanted.filter((p) => !loaded.has(p.url) && !failed.has(p.url)).length,
});

function drop(contribution: UiContribution) {
  try {
    contribution.dispose?.();
  } catch (e) {
    console.error(e);
  }
}

function sync(next: OsPluginUi[]) {
  wanted = next;
  for (const [url, contribution] of loaded) {
    if (next.some((p) => p.url === url)) continue;
    loaded.delete(url);
    drop(contribution);
    const Part = contribution.overlay;
    if (Part && !reducedMotion()) {
      useLeaving.setState((s) => ({ list: [...s.list, { key: url, Part }] }));
      window.setTimeout(() => useLeaving.setState((s) => ({ list: s.list.filter((l) => l.Part !== Part) })), LEAVE_MS);
    }
  }
  publish();
  for (const plugin of next) {
    if (loaded.has(plugin.url) || pending.has(plugin.url)) continue;
    pending.add(plugin.url);
    import(/* @vite-ignore */ plugin.url)
      .then((mod: { activate: (h: ReturnType<typeof fullHost>) => UiContribution }) => {
        const contribution = mod.activate(fullHost());
        if (wanted.some((p) => p.url === plugin.url)) loaded.set(plugin.url, contribution);
        else drop(contribution); // switched off while it was loading
        publish();
      })
      .catch((e: Error) => {
        console.error(e);
        failed.add(plugin.url);
        publish();
        toast(t('osp.uiFailed', { name: plugin.name }), 'error');
      })
      .finally(() => pending.delete(plugin.url));
  }
}

export function useUiPluginLoader() {
  const list = useApi<OsPluginUi[]>('/api/os-plugins/ui', ['osPlugins']).data;
  React.useEffect(() => {
    if (list) sync(list);
  }, [list]);
}

/** A plugin that throws here costs its own icon or menu items, not the file tree. */
export function pluginFileIcon(list: UiContribution[], entry: Parameters<NonNullable<UiContribution['fileIcon']>>[0]): React.ReactNode {
  for (const c of list) {
    try {
      const icon = c.fileIcon?.(entry);
      if (icon) return icon;
    } catch (e) {
      console.error(e);
    }
  }
  return null;
}

export function pluginFileMenu(list: UiContribution[], entry: { path: string; dir: boolean }, where: { tabId: string }): MenuItem[] {
  return list.flatMap((c) => {
    try {
      return c.fileMenu?.(entry, where) ?? [];
    } catch (e) {
      console.error(e);
      return [];
    }
  });
}

export const pluginOpensMedia = (list: UiContribution[], path: string) => list.some((c) => {
  try {
    return !!c.fileView && !!c.opensMedia?.(path);
  } catch (e) {
    console.error(e);
    return false;
  }
});

/** A view that crashes falls back to the plain one instead of taking the panel down. */
export class PluginBoundary extends React.Component<{ fallback: React.ReactNode; children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: Error) {
    console.error(error);
  }
  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// What Claude OS answers itself keeps its meaning. A plugin can take over a name the CLI or a skill lists, not these.
const CORE_COMMANDS = new Set(['focus', 'view', BTW_COMMAND, SECRET_COMMAND, ...Object.keys(OFF_CHAT)]);

export const pluginCommands = (list: UiContribution[]): PluginCommand[] => list.flatMap((c) => c.commands ?? []).filter((c) => !CORE_COMMANDS.has(c.name));

export function withPluginCommands(listed: CommandInfo[], list: UiContribution[]): CommandInfo[] {
  const own = pluginCommands(list);
  if (own.length === 0) return listed;
  const rows: CommandInfo[] = own.map((c) => ({ name: c.name, description: c.description ?? null, argumentHint: c.argumentHint ?? null, source: 'plugin', needsTerminal: false }));
  return [...listed.filter((c) => !own.some((o) => o.name === c.name.replace(/^\//, ''))), ...rows].sort((a, b) => a.name.localeCompare(b.name));
}

const contributionKey = (c: UiContribution) => [...loaded].find(([, value]) => value === c)?.[0];

function PluginSlot({ pick }: { pick: (c: UiContribution) => React.ComponentType | undefined }) {
  return useUiPlugins().flatMap((c) => {
    const Part = pick(c);
    return Part ? <PluginBoundary key={contributionKey(c)} fallback={null}><Part /></PluginBoundary> : [];
  });
}

/** The same key while an overlay leaves: React keeps its instance, and it fades out instead of being cut. */
export function PluginOverlays() {
  const list = useUiPlugins();
  const leaving = useLeaving((s) => s.list);
  const live = list.flatMap((c) => (c.overlay ? [{ key: contributionKey(c) ?? '', Part: c.overlay }] : []));
  const rows = [...live.map((l) => ({ ...l, leaving: false })), ...leaving.filter((l) => !live.some((x) => x.key === l.key)).map((l) => ({ ...l, leaving: true }))];
  return rows.map(({ key, Part, leaving: gone }) => <PluginBoundary key={key} fallback={null}><Part leaving={gone} /></PluginBoundary>);
}
export const PluginComposerMarks = () => <PluginSlot pick={(c) => c.composerMark} />;

const screensOf = (list: UiContribution[]) => list.flatMap((c) => c.screens ?? []);

/** Burger menu items for the screens plugins add; read when the menu renders. */
export function pluginScreenItems(): MenuItem[] {
  const { go } = useApp.getState();
  return screensOf(useContributions.getState().list).map((s) => ({ id: `plugin:${s.id}`, label: s.title, icon: s.icon as LucideIcon, onSelect: () => go({ kind: 'plugin', screen: s.id }) }));
}

/** Read outside React too: a menu is built when it opens. */
export const pluginScreens = (): PluginScreen[] => screensOf(useContributions.getState().list);
export const pluginMentions = (): MentionSource[] => useContributions.getState().list.flatMap((c) => (c.mentions ? [c.mentions] : []));

export function usePluginScreens(): PluginScreen[] {
  const list = useUiPlugins();
  return React.useMemo(() => screensOf(list), [list]);
}

/** A plugin's screen: waits while plugins load, then says so if the plugin is gone (disabled, or the view was remembered). */
export function PluginScreenView({ id, arg }: { id: string; arg?: string }) {
  const screen = usePluginScreens().find((s) => s.id === id);
  const waiting = useContributions((s) => s.waiting);
  const listed = useApi<OsPluginUi[]>('/api/os-plugins/ui', ['osPlugins']).data;
  if (screen) {
    const Screen = screen.component;
    return <PluginBoundary fallback={<ErrorState className="p-6" message={t('osp.screenFailed')} />}><Screen arg={arg} /></PluginBoundary>;
  }
  if (!listed || waiting > 0) return <Skeleton className="p-6" lines={8} />;
  return <Empty className="p-6">{t('osp.screenGone')}</Empty>;
}
