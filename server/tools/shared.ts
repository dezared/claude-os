import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ctx } from '../context.ts';
import { safely } from '../memory/util.ts';

export function readJson<T>(path: string): T | null {
  return safely(() => JSON.parse(readFileSync(path, 'utf8')) as T, null);
}

export interface ClaudeJson {
  mcpServers?: Record<string, unknown>;
  projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
  skillUsage?: Record<string, { usageCount?: number; lastUsedAt?: number }>;
}

export function readClaudeJson(ctx: Ctx): ClaudeJson {
  return readJson<ClaudeJson>(ctx.paths.claudeJson) ?? {};
}

export interface PluginInstall {
  id: string; // name@marketplace
  name: string;
  installPath: string;
  scope: string;
  projectPath: string | null;
}

export function installedPlugins(ctx: Ctx): PluginInstall[] {
  const file = readJson<{ plugins?: Record<string, { installPath?: string; scope?: string; projectPath?: string }[]> }>(
    join(ctx.paths.claudeDir, 'plugins', 'installed_plugins.json'),
  );
  const out: PluginInstall[] = [];
  for (const [id, installs] of Object.entries(file?.plugins ?? {})) {
    for (const i of installs) {
      if (i.installPath) out.push({ id, name: id.split('@')[0], installPath: i.installPath, scope: i.scope ?? 'user', projectPath: i.projectPath ?? null });
    }
  }
  // A plugin can be installed twice in different versions: readers keep the first one, the user-level install.
  return out.sort((a, b) => Number(b.scope === 'user') - Number(a.scope === 'user'));
}

// Project roots known to anyone: journal first, then ~/.claude.json. Windows mounts are never touched.
export function knownProjects(ctx: Ctx): { key: string | null; root: string }[] {
  const out = new Map<string, string | null>();
  for (const p of safely(() => ctx.journal.listProjects(), [])) out.set(p.root, p.key);
  for (const root of Object.keys(readClaudeJson(ctx).projects ?? {})) if (!out.has(root)) out.set(root, null);
  return [...out].filter(([root]) => !root.startsWith('/mnt/')).map(([root, key]) => ({ key, root }));
}
