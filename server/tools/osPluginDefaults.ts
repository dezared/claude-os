// The first-run setup enables the plugins whose manifest says "enabledByDefault": finishing the setup is the user's consent,
// so each plan is installed as the enable dialog installs it, without the dialog.
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Paths } from '../context.ts';
import { safely } from '../memory/util.ts';
import { text, validateManifest, type Manifest } from './osPluginManifest.ts';
import { readJson } from './shared.ts';

export interface DefaultPlugins { enabled: string[]; skipped: { name: string; reason: string }[] }

/** What osPlugins.ts lends for this: its own plan and install, so the writes, backups, audit and invalidation are the same. */
export interface PluginInstaller<P extends { conflicts: string[]; manifest: Manifest }> {
  stateFile: string;
  folders(): { id: string; dir: string }[];
  plan(id: string): P;
  install(plan: P): Promise<unknown>;
}

/** Why the plugin was not enabled, or null when it was. */
async function enableOne<P extends { conflicts: string[]; manifest: Manifest }>(using: PluginInstaller<P>, id: string): Promise<string | null> {
  try {
    const plan = using.plan(id); // throws with the manifest errors
    if (plan.conflicts.length) return plan.conflicts.join('; ');
    // As with the Enable button, a missing dependency does not hold the plugin back: its row offers the setup afterwards.
    await using.install(plan);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

export async function enableDefaultPlugins<P extends { conflicts: string[]; manifest: Manifest }>(using: PluginInstaller<P>): Promise<DefaultPlugins> {
  const out: DefaultPlugins = { enabled: [], skipped: [] };
  // The state file appears with the first enabled plugin and stays after the last is disabled: once it exists,
  // the user has made choices here (or the setup already ran), and none of them is undone.
  if (existsSync(using.stateFile)) return out;
  for (const { id, dir } of using.folders()) {
    const { raw } = validateManifest(id, dir);
    if (raw.enabledByDefault !== true) continue;
    const name = text(raw.name) ?? id;
    const reason = await enableOne(using, id);
    if (reason) out.skipped.push({ name, reason });
    else out.enabled.push(name);
  }
  return out;
}

// Features that left the core for a shipped plugin. An install from before the move gets the plugin enabled once, so the
// feature does not vanish with the update; data/os-plugins-moved.json remembers it, and a later "disable" sticks.
const MOVED_TO_PLUGINS = ['kanban-plus'];

export interface MovedPlugins { enabled: string[]; failed: { id: string; reason: string }[] }

const failedFile = (data: string) => join(data, 'os-plugins-moved-failed.json');
/** Moved plugins the last start could not enable, and why: their rows on the plugins screen say so. */
export const movedFailures = (data: string): Record<string, string> => readJson<Record<string, string>>(failedFile(data)) ?? {};

// `existing`: a durable sign that this install ran before the move (the setup was completed, or the board folder is there).
// The plugin state file alone is not enough: it appears only with the first enabled plugin, and an old install may never have had one.
export async function enableMovedPlugins<P extends { conflicts: string[]; manifest: Manifest }>(using: PluginInstaller<P>, data: string, existing: boolean): Promise<MovedPlugins> {
  const out: MovedPlugins = { enabled: [], failed: [] };
  if (!existing && !existsSync(using.stateFile)) return out; // a new install: the first-run setup enables what ships enabled
  const file = join(data, 'os-plugins-moved.json');
  const done = readJson<string[]>(file) ?? [];
  const todo = MOVED_TO_PLUGINS.filter((id) => !done.includes(id) && using.folders().some((f) => f.id === id));
  if (todo.length === 0) return out;
  for (const id of todo) {
    if (id in (readJson<Record<string, unknown>>(using.stateFile) ?? {})) continue;
    const reason = await enableOne(using, id);
    if (reason) out.failed.push({ id, reason });
    else out.enabled.push(id);
  }
  // Only what is on now is remembered: a failed one is tried again at the next start.
  const failed = out.failed.map((f) => f.id);
  writeFileSync(file, JSON.stringify([...done, ...todo.filter((id) => !failed.includes(id))]));
  writeFileSync(failedFile(data), JSON.stringify(Object.fromEntries(out.failed.map((f) => [f.id, f.reason]))));
  return out;
}

/** The shipped plugins that are off, one line each with the first sentence of the description, read from disk on every call. */
export function offPluginLines(paths: Pick<Paths, 'plugins' | 'data'>): string[] {
  // The state file of osPlugins.ts: what is enabled, by id.
  const on = readJson<Record<string, unknown>>(join(paths.data, 'os-plugins.json')) ?? {};
  return safely(() => readdirSync(paths.plugins), []).filter((id) => !id.startsWith('.') && !(id in on)).sort().flatMap((id) => {
    const { manifest } = validateManifest(id, join(paths.plugins, id));
    return manifest ? [`- ${manifest.name}: ${manifest.description.split(/(?<=\.)\s/)[0]}`] : [];
  });
}

// For the root session: a few lines, so Claude can offer a plugin when the user asks for what it does.
export function offPluginsHint(paths: Pick<Paths, 'plugins' | 'data'>): string {
  const lines = offPluginLines(paths);
  return lines.length ? ['# Plugins that ship off', 'When the user asks for what one of these does, offer it: the user enables it on the Claude OS plugins screen.', ...lines].join('\n') : '';
}
