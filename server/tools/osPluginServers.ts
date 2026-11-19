// The server parts of enabled shipped plugins: loaded into this process, their routes under /api/plugins/<id>, their tools
// inside the claude-os MCP server of each session. Loaded synchronously, so a session started right after a boot has them.
// A server part changed on disk runs after a server restart, like the core.
import { tool } from '@anthropic-ai/claude-agent-sdk';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { z } from 'zod';
import type { Ctx } from '../context.ts';
import { httpError, parseFrontmatter, safely } from '../memory/util.ts';
import type { PluginServerStatus } from '../../shared/osPluginServer.ts';
import type { PluginHost, PluginRoute, PluginScope, PluginServer, PluginTool, PluginWho } from './pluginServerApi.ts';

const load = createRequire(import.meta.url);

export interface ActiveServer { id: string; file: string }

// In-process code runs with the server's own rights: only what ships with Claude OS may bring it.
export const serverProblem = (m: { server: string | null } | null, source: 'shipped' | 'user') => (m?.server && source !== 'shipped' ? ['a server part runs only from a plugin that ships with Claude OS'] : []);

/** The server parts of enabled plugins, from the shipped folder only: a user copy with the same id hides it. */
export const serversOf = (state: Record<string, { server?: string | null }>, folderOf: (id: string) => { dir: string; source: 'shipped' | 'user' }): ActiveServer[] => Object.entries(state).flatMap(([id, { server }]) => {
  const folder = folderOf(id);
  return server && folder.source === 'shipped' && existsSync(join(folder.dir, server)) ? [{ id, file: join(folder.dir, server) }] : [];
});

export interface PluginServersApi {
  tools(who: PluginWho): PluginTool[];
  allowed(scope: PluginScope): string[]; // bare tool names
  rules(scope: PluginScope): string[];
  dirs(): string[];
  views(): string[];
  has(toolName: string): boolean;
  sessionStarted(tabId: string, sessionId: string): void;
  status(id: string): PluginServerStatus | null;
}

function sessionsWithCost(ctx: Ctx, ids: string[]) {
  if (ids.length === 0) return [];
  const rows = safely(() => ctx.db.prepare(`SELECT id, cost_usd FROM sessions WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: string; cost_usd: number | null }[], []);
  return ctx.journal.listSessions().filter((s) => ids.includes(s.id)).map((s) => ({ ...s, costUsd: rows.find((r) => r.id === s.id)?.cost_usd ?? null }));
}

export function pluginHost(ctx: Ctx, id: string): PluginHost {
  const data = join(ctx.paths.data, 'os-plugin-data', id);
  return {
    id,
    paths: { vault: ctx.paths.vault, app: ctx.paths.data, data, backups: join(ctx.paths.data, 'backups') },
    tool,
    z,
    parseFrontmatter,
    projects: () => ctx.journal.listProjects(true).map((p) => ({ key: p.key, name: p.name })),
    osProject: () => safely(() => ctx.journal.projectForCwd(ctx.paths.repo), null),
    tabs: () => ctx.chat?.list() ?? [],
    sessions: (ids) => sessionsWithCost(ctx, ids),
    language: () => ctx.settings?.profile()?.language ?? 'en',
    invalidate: () => ctx.invalidate('osPluginData'),
    statusChanged: () => ctx.invalidate('osPlugins'),
    audit: (action, target, diff) => ctx.audit(`${id}.${action}`, target, diff),
  };
}

/** A route path like /cards/:id/move or /proxy/* against the rest of the URL, which the router has already decoded; the params, or null.
 * Decoding it again would turn an escaped % (a "100%" in the URL as 100%25) into a malformed escape. */
export function matchRoute(pattern: string, path: string): Record<string, string> | null {
  const want = pattern.split('/').filter(Boolean);
  const got = path.split('/').filter(Boolean);
  const rest = want.at(-1) === '*';
  if (rest ? got.length < want.length : want.length !== got.length) return null;
  const params: Record<string, string> = {};
  for (const [i, part] of want.entries()) {
    if (part === '*') params['*'] = got.slice(i).join('/');
    else if (part.startsWith(':')) params[part.slice(1)] = got[i];
    else if (part !== got[i]) return null;
  }
  return params;
}

function registerRoutes(ctx: Ctx, loaded: Map<string, PluginServer>) {
  ctx.app.route({
    method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    url: '/api/plugins/:id/*',
    handler: async (req) => {
      const { id, '*': rest } = req.params as { id: string; '*': string };
      const server = loaded.get(id);
      const found = (server?.routes ?? []).flatMap((r: PluginRoute) => {
        const params = r.method === req.method ? matchRoute(r.path, rest) : null;
        return params ? [{ r, params }] : [];
      })[0];
      if (!found) throw httpError(404, 'not found');
      return found.r.handler({ params: found.params, query: req.query as Record<string, string>, headers: req.headers, body: req.body ?? null });
    },
  });
}

export function createPluginServers(ctx: Ctx, active: () => ActiveServer[]): PluginServersApi {
  const loaded = new Map<string, PluginServer>();
  // A part that throws costs that plugin alone, never the server.
  function sync() {
    const want = active();
    for (const [id, server] of loaded) {
      if (want.some((a) => a.id === id)) continue;
      loaded.delete(id);
      safely(() => server.dispose?.(), undefined);
    }
    for (const { id, file } of want) {
      if (loaded.has(id)) continue;
      try {
        const mod = load(file) as { activate: (host: PluginHost) => PluginServer };
        const host = pluginHost(ctx, id);
        mkdirSync(host.paths.data, { recursive: true });
        loaded.set(id, mod.activate(host));
      } catch (err) {
        ctx.app.log.error({ err, plugin: id }, 'plugin server part failed to start');
      }
    }
  }
  sync();
  ctx.bus.on('os-plugins-changed', sync);
  ctx.app.addHook('onClose', async () => {
    for (const server of loaded.values()) safely(() => server.dispose?.(), undefined);
  });

  const all = () => [...loaded.values()];
  registerRoutes(ctx, loaded);
  // A session keeps the tools it started with: once the plugin is disabled (or reloaded), its old tools answer that it is off.
  const whileOn = (id: string, server: PluginServer, t: PluginTool): PluginTool => ({
    ...t,
    handler: (args, extra) => (loaded.get(id) === server ? t.handler(args, extra) : Promise.resolve({ content: [{ type: 'text', text: `The Claude OS plugin ${id} is off: its tools no longer work. The user enables it again on the plugins screen.` }], isError: true })),
  });

  return {
    tools: (who) => [...loaded].flatMap(([id, s]) => safely(() => (s.tools?.(who) ?? []).map((t) => whileOn(id, s, t)), [])),
    allowed: (scope) => all().flatMap((s) => s.allowed?.[scope] ?? []),
    rules: (scope) => all().flatMap((s) => s.rules?.[scope] ?? []),
    dirs: () => all().flatMap((s) => s.dirs ?? []),
    views: () => all().flatMap((s) => s.views ?? []),
    has: (name) => all().some((s) => safely(() => (s.tools?.({ scope: 'root', tab: null, project: null }) ?? []).some((t) => t.name === name), false)),
    sessionStarted: (tabId, sessionId) => {
      for (const s of all()) safely(() => s.sessionStarted?.(tabId, sessionId), undefined);
    },
    status: (id) => safely(() => loaded.get(id)?.status?.() ?? null, null),
  };
}
