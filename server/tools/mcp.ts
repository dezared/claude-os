import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { McpServer } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { httpError, safely } from '../memory/util.ts';
import { installedPlugins, knownProjects, readClaudeJson, readJson } from './shared.ts';

const run = promisify(execFile);
const NAME = /^[A-Za-z0-9][\w.-]*$/;
const WRITE_SCOPES = new Set(['user', 'project', 'local']);
const MASK = '***';

export const SECRET_KEY = /token|secret|passw|pwd|api[-_]?key|auth|credential|bearer|private|cookie|session/i;
const TOKEN_VALUE = /^(sk|pk|ghp|gho|github_pat|glpat|xox[a-z]|ya29|AKIA|eyJ)[-_A-Za-z0-9.]{8,}$|^[A-Za-z0-9_+=.-]{32,}$/;

interface RawServer {
  type?: string;
  command?: string;
  args?: unknown[];
  url?: string;
  env?: Record<string, unknown>;
  headers?: Record<string, unknown>;
}

export function redactUrl(raw: string): string {
  const url = safely(() => new URL(raw), null);
  if (!url || !url.host) return TOKEN_VALUE.test(raw) ? MASK : raw.split('?')[0];
  const path = url.pathname.split('/').map((seg) => (TOKEN_VALUE.test(seg) ? MASK : seg)).join('/');
  const query = [...url.searchParams.keys()].map((k) => `${k}=${MASK}`).join('&');
  return `${url.protocol}//${url.host}${path}${query ? `?${query}` : ''}`;
}

export function maskArg(arg: string): string {
  return redactOne(arg);
}

function redactOne(arg: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(arg)) return redactUrl(arg);
  const kv = /^(-{0,2}[\w.-]+)=(.*)$/s.exec(arg);
  if (kv) {
    if (SECRET_KEY.test(kv[1]) || TOKEN_VALUE.test(kv[2])) return `${kv[1]}=${MASK}`;
    return `${kv[1]}=${redactOne(kv[2])}`;
  }
  const header = /^([\w-]+):\s*(.+)$/s.exec(arg);
  if (header && SECRET_KEY.test(header[1])) return `${header[1]}: ${MASK}`;
  return TOKEN_VALUE.test(arg) ? MASK : arg;
}

export function redactArgs(args: unknown[]): string[] {
  const out: string[] = [];
  let maskNext: false | 'all' | 'value' = false;
  for (const raw of args) {
    const arg = String(raw);
    if (maskNext === 'all') {
      out.push(MASK);
    } else if (maskNext === 'value') {
      // --env KEY=VALUE and --header "Name: value": the name is useful, the value is not ours to show.
      const m = /^([\w.-]+)\s*[=:]/.exec(arg);
      out.push(m ? `${m[1]}=${MASK}` : MASK);
    } else {
      out.push(redactOne(arg));
    }
    if (maskNext) {
      maskNext = false;
    } else if (/^-/.test(arg) && !arg.includes('=')) {
      if (/^(-e|--env|-H|--header)$/i.test(arg)) maskNext = 'value';
      else if (SECRET_KEY.test(arg)) maskNext = 'all';
    }
  }
  return out;
}

export function publicServer(name: string, scope: McpServer['scope'], project: string | null, raw: RawServer): McpServer {
  const transport = raw.type ?? (raw.command ? 'stdio' : raw.url ? 'http' : 'unknown');
  const summary = raw.command
    ? [String(raw.command), ...redactArgs(raw.args ?? [])].join(' ')
    : raw.url ? redactUrl(String(raw.url)) : '';
  return { name, scope, project, transport, summary, envKeys: [...Object.keys(raw.env ?? {}), ...Object.keys(raw.headers ?? {})], health: null };
}

// Only the Status line goes anywhere: the rest of the output prints env and header values.
export function parseHealth(stdout: string): string | null {
  const status = /^\s*Status:\s*(.+)$/m.exec(stdout)?.[1]?.trim();
  return status ? status.slice(0, 80) : null;
}

// Values the user just sent: a CLI error must not echo them back to the browser or the log.
function secretValues(config: RawServer): string[] {
  return [...Object.values(config.env ?? {}), ...Object.values(config.headers ?? {})].map(String).filter((v) => v.length >= 4);
}

interface Entry extends McpServer {
  cwd: string | null;
}

export function createMcp(ctx: Ctx) {
  const health = new Map<string, string>();
  const healthKey = (s: Pick<McpServer, 'name' | 'scope' | 'project'>) => `${s.scope}|${s.project ?? ''}|${s.name}`;

  function entries(): Entry[] {
    const json = readClaudeJson(ctx);
    const out: Entry[] = [];
    const push = (server: McpServer, cwd: string | null, path: string) => out.push({ ...server, file: path, health: health.get(healthKey(server)) ?? null, cwd });
    const known = knownProjects(ctx);
    const label = (root: string) => known.find((p) => p.root === root)?.key ?? root;

    for (const [name, raw] of Object.entries(json.mcpServers ?? {})) push(publicServer(name, 'user', null, raw as RawServer), null, ctx.paths.claudeJson);
    for (const [root, cfg] of Object.entries(json.projects ?? {})) {
      for (const [name, raw] of Object.entries(cfg.mcpServers ?? {})) push(publicServer(name, 'local', label(root), raw as RawServer), root, ctx.paths.claudeJson);
    }
    for (const { root } of known) {
      const file = readJson<{ mcpServers?: Record<string, RawServer> }>(join(root, '.mcp.json'));
      for (const [name, raw] of Object.entries(file?.mcpServers ?? {})) push(publicServer(name, 'project', label(root), raw), root, join(root, '.mcp.json'));
    }
    const seen = new Set<string>();
    for (const plugin of installedPlugins(ctx)) {
      if (seen.has(plugin.name)) continue;
      seen.add(plugin.name);
      const file = readJson<Record<string, unknown>>(join(plugin.installPath, '.mcp.json'));
      const manifest = readJson<{ mcpServers?: unknown }>(join(plugin.installPath, '.claude-plugin', 'plugin.json'));
      const servers = {
        ...((file?.mcpServers ?? file ?? {}) as Record<string, RawServer>),
        ...(typeof manifest?.mcpServers === 'object' ? (manifest.mcpServers as Record<string, RawServer>) : {}),
      };
      for (const [name, raw] of Object.entries(servers)) {
        if (raw && typeof raw === 'object') push(publicServer(`plugin:${plugin.name}:${name}`, 'plugin', null, raw), null, join(plugin.installPath, file ? '.mcp.json' : '.claude-plugin/plugin.json'));
      }
    }
    return out;
  }

  const strip = ({ cwd: _cwd, ...server }: Entry): McpServer => server;

  function list(): McpServer[] {
    return entries().map(strip);
  }

  function findEntry(name: string, scope?: string, project?: string): Entry {
    const entry = entries().find((e) => e.name === name && (!scope || e.scope === scope) && (!project || e.project === project));
    if (!entry) throw httpError(404, 'mcp server not found');
    return entry;
  }

  async function check(name: string, scope?: string, project?: string): Promise<McpServer> {
    const entry = findEntry(name, scope, project);
    let status: string;
    try {
      const { stdout } = await run(ctx.paths.claudeBin, ['mcp', 'get', name], { cwd: entry.cwd ?? ctx.paths.repo, timeout: 60_000, maxBuffer: 1024 * 1024 });
      status = parseHealth(stdout) ?? 'unknown';
    } catch (err) {
      const e = err as { stdout?: string; killed?: boolean };
      status = parseHealth(e.stdout ?? '') ?? (e.killed ? 'timeout' : 'error');
    }
    health.set(healthKey(entry), status);
    return { ...strip(entry), health: status };
  }

  function projectCwd(scope: string, project: unknown): string | undefined {
    if (scope === 'user') return ctx.paths.repo;
    const match = knownProjects(ctx).find((p) => p.key === project || p.root === project);
    if (!match) throw httpError(400, `scope ${scope} needs a known project`);
    return match.root;
  }

  async function add(body: { name?: unknown; scope?: unknown; json?: unknown; confirmed?: unknown; project?: unknown }): Promise<McpServer> {
    if (body.confirmed !== true) throw httpError(400, 'confirmed: true is required: an MCP server runs code on this machine');
    const { name, scope } = body;
    if (typeof name !== 'string' || !NAME.test(name)) throw httpError(400, 'bad server name');
    if (typeof scope !== 'string' || !WRITE_SCOPES.has(scope)) throw httpError(400, 'scope must be user, project or local');
    const parsed: unknown = typeof body.json === 'string' ? safely(() => JSON.parse(body.json as string), null) : body.json;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw httpError(400, 'json must be a JSON object');
    const config = parsed as RawServer;
    const cwd = projectCwd(scope, body.project);
    try {
      await run(ctx.paths.claudeBin, ['mcp', 'add-json', '--scope', scope, name, JSON.stringify(config)], { cwd, timeout: 30_000, maxBuffer: 1024 * 1024 });
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string };
      let message = (e.stderr || e.stdout || 'claude mcp add-json failed').trim().slice(0, 500);
      for (const v of secretValues(config)) message = message.replaceAll(v, MASK);
      throw httpError(422, message);
    }
    const server = publicServer(name, scope as McpServer['scope'], scope === 'user' ? null : (typeof body.project === 'string' ? body.project : null), config);
    ctx.audit('mcp.add', `${scope}:${name}`, JSON.stringify({ project: server.project, transport: server.transport, summary: server.summary, envKeys: server.envKeys }));
    ctx.invalidate('mcp', 'overview');
    return safely(() => strip(findEntry(name, scope, server.project ?? undefined)), server);
  }

  async function remove(name: string, scope?: string, project?: string): Promise<void> {
    if (!NAME.test(name)) throw httpError(400, 'bad server name');
    if (!scope || !WRITE_SCOPES.has(scope)) throw httpError(400, 'scope must be user, project or local');
    const entry = findEntry(name, scope, project);
    try {
      await run(ctx.paths.claudeBin, ['mcp', 'remove', '--scope', scope, name], { cwd: entry.cwd ?? ctx.paths.repo, timeout: 30_000 });
    } catch (err) {
      const e = err as { stderr?: string };
      throw httpError(422, (e.stderr || 'claude mcp remove failed').trim().slice(0, 500));
    }
    health.delete(healthKey(entry));
    ctx.audit('mcp.remove', `${scope}:${name}`, JSON.stringify({ project: entry.project }));
    ctx.invalidate('mcp', 'overview');
  }

  return { list, check, add, remove };
}
