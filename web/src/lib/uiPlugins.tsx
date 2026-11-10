// Interface code of enabled Claude OS plugins: loaded and dropped while the app runs, through a few named places in the file panel.
import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { create } from 'zustand';
import type { MenuItem } from '@/home/ActionMenu';
import { BTW_COMMAND, OFF_CHAT } from '../../../shared/commands.ts';
import { api, useApi } from './api';
import { highlightCode } from './highlight';
import { locale, t } from './i18n';
import { toast, toastError } from './store';
import type { CommandInfo, OsPluginUi, ProjectFile } from './types';

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

/** What a plugin's `activate(host)` returns. */
export interface UiContribution {
  fileIcon?: (entry: { name: string; path: string; dir: boolean; expanded: boolean }) => React.ReactNode;
  fileMenu?: (entry: { path: string; dir: boolean }, where: { tabId: string }) => MenuItem[];
  fileView?: React.ComponentType<FileViewProps>;
  /** fileView also takes this file when the app sees bytes it cannot show as text, or more of them than it reads. */
  opensMedia?: (path: string) => boolean;
  commands?: PluginCommand[];
  /** Mounted once per window for as long as the plugin is active, above every screen. Renders null when it has nothing to show. */
  overlay?: React.ComponentType;
  /** A small state mark in the composer's foot, next to the focus mark. */
  composerMark?: React.ComponentType;
  dispose?: () => void;
}

const host = { React, ReactDOM, api, highlight: highlightCode, toast, toastError, lang: locale };

const loaded = new Map<string, UiContribution>();
const pending = new Set<string>();
let wanted: OsPluginUi[] = [];

const useContributions = create<{ list: UiContribution[] }>(() => ({ list: [] }));
export const useUiPlugins = () => useContributions((s) => s.list);
const publish = () => useContributions.setState({ list: wanted.flatMap((p) => loaded.get(p.url) ?? []) });

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
  }
  publish();
  for (const plugin of next) {
    if (loaded.has(plugin.url) || pending.has(plugin.url)) continue;
    pending.add(plugin.url);
    import(/* @vite-ignore */ plugin.url)
      .then((mod: { activate: (h: typeof host) => UiContribution }) => {
        const contribution = mod.activate(host);
        if (wanted.some((p) => p.url === plugin.url)) loaded.set(plugin.url, contribution);
        else drop(contribution); // switched off while it was loading
        publish();
      })
      .catch((e: Error) => {
        console.error(e);
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
const CORE_COMMANDS = new Set(['focus', 'view', BTW_COMMAND, ...Object.keys(OFF_CHAT)]);

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

export const PluginOverlays = () => <PluginSlot pick={(c) => c.overlay} />;
export const PluginComposerMarks = () => <PluginSlot pick={(c) => c.composerMark} />;
