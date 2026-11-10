// Read-only analysers for the Tools panels. Numbers come from config files and the journals; what they cannot tell is left out.
import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { AdminProjectDiff, EntityStats, Forecast, HookAdminRow, HooksReport, LimitWindow, McpAdminRow, McpConnection, McpReport, McpServer, McpServerDetails, McpToolInfo, PluginAdminRow, PluginsReport, Skill, SkillAdminRow, SkillsReport } from '../../shared/contract.ts';
import { Inbox } from '../chat/inbox.ts';
import type { Ctx } from '../context.ts';
import { ignoredSessions } from '../journal/live.ts';
import { httpError, parseFrontmatter, safely, sha256, wslDistro } from '../memory/util.ts';
import { launchDetached } from './ide.ts';
import type { createMcp } from './mcp.ts';
import { platformKind, type PlatformKind } from './platform.ts';
import { maskValue } from './setup.ts';
import { installedPlugins, knownProjects, readClaudeJson, readJson } from './shared.ts';
import { validateCwd } from './actions.ts';
import type { createSkills } from './skills.ts';

const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const PROBE_LIMIT_MS = 40_000;
const PENDING_WAIT_MS = 30_000;
const HANDSHAKE_MS = 15_000;
const LOGIN_NAME = /^[\w.:\- ]+$/;
const FOLDER_GONE = 'folder_gone'; // the web side has the words
const WINDOWS_HOME = /^\/mnt\/[a-z]\/Users\/[^/]+\/?$/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const dayOf = (ts: number) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ---------- Pure parts, tested on fixtures ----------

/** Claude Code names a tool mcp__<server>__<tool>, with every other character of the server name replaced. */
export const mcpPrefix = (server: string) => server.replace(/[^a-zA-Z0-9_-]/g, '_');

export function parseMcpTool(tool: string): { server: string; tool: string } | null {
  const m = /^mcp__(.+?)__(.+)$/.exec(tool);
  return m ? { server: m[1], tool: m[2] } : null;
}

export function resolveSkillRun(target: string, project: string | null, skills: Skill[]): Skill | null {
  const qualified = skills.find((s) => s.source && s.scope === 'plugin' && `${s.source}:${s.name}` === target);
  if (qualified) return qualified;
  return skills.find((s) => s.scope === 'project' && s.name === target && s.source === project)
    ?? skills.find((s) => s.scope === 'user' && s.name === target)
    ?? skills.find((s) => s.scope === 'plugin' && s.name === target)
    ?? null;
}

// Connected somewhere outranks not loaded elsewhere: a folder long gone does not make a working server look broken.
const SEVERITY: McpConnection[] = ['needs-auth', 'failed', 'pending', 'connected', 'disabled', 'not-loaded', 'unchecked'];
export const worstStatus = (list: McpConnection[]): McpConnection => SEVERITY.find((s) => list.includes(s)) ?? 'unchecked';

export interface ProbedServer {
  name: string;
  status: Exclude<McpConnection, 'not-loaded' | 'unchecked'>;
  error?: string;
  source?: string;
  serverInfo?: { name: string; version: string };
  tools?: { name: string; description?: string; annotations?: { readOnly?: boolean; destructive?: boolean } }[];
  config?: Obj;
}

export function mergeMcpRows(
  servers: McpServer[],
  probes: Map<string, ProbedServer[]>,
  placeName: (key: string) => string,
  use: Map<string, { calls: number; tools: Set<string>; last: number | null }>,
  descriptions: Map<string, string>,
): McpAdminRow[] {
  const names = new Set(servers.map((s) => s.name));
  for (const list of probes.values()) for (const p of list) names.add(p.name);
  const rows: McpAdminRow[] = [];
  for (const name of names) {
    const definitions = servers.filter((s) => s.name === name);
    const plugin = /^plugin:([^:]+):/.exec(name)?.[1] ?? null;
    const seen = [...probes.entries()].map(([place, list]) => ({ place, hit: list.find((p) => p.name === name) }));
    const account = seen.some((x) => x.hit?.source === 'claudeai');
    const global = definitions.some((d) => d.scope === 'user');
    const statusBy: McpAdminRow['statusBy'] = [];
    for (const { place, hit } of seen) {
      const expected = place === 'global' ? global || plugin !== null || account : definitions.some((d) => d.project === place);
      if (hit) statusBy.push({ place, status: hit.status, error: hit.error?.slice(0, 300) ?? null });
      else if (expected) statusBy.push({ place, status: 'not-loaded', error: null });
    }
    const best = seen.map((x) => x.hit).find((h) => h?.status === 'connected') ?? seen.map((x) => x.hit).find(Boolean);
    const u = use.get(mcpPrefix(name));
    const projects = definitions.filter((d) => d.scope === 'local' || d.scope === 'project').map((d) => d.project ?? '');
    rows.push({
      name,
      where: { global, projects: [...new Set(projects)].map((key) => ({ key, name: placeName(key) })), plugin, account },
      definitions,
      status: worstStatus(statusBy.map((s) => s.status)),
      statusBy,
      error: statusBy.find((s) => s.error)?.error ?? null,
      serverInfo: best?.serverInfo ?? null,
      tools: (best?.tools ?? []).map(toolInfo),
      description: plugin ? descriptions.get(plugin) ?? null : null,
      note: null,
      calls: u?.calls ?? 0,
      toolsUsed: u?.tools.size ?? 0,
      lastCall: u?.last ?? null,
    });
  }
  return rows.sort((a, b) => SEVERITY.indexOf(a.status) - SEVERITY.indexOf(b.status) || b.calls - a.calls || a.name.localeCompare(b.name));
}

function toolInfo(t: { name: string; description?: string; annotations?: { readOnly?: boolean; destructive?: boolean } }): McpToolInfo {
  return { name: t.name, description: t.description?.trim().slice(0, 600) || null, readOnly: t.annotations?.readOnly === true, destructive: t.annotations?.destructive === true };
}

export function mcpLoginArgv(kind: PlatformKind, cwd: string, claudeBin: string, name: string, distro: string): { bin: string; args: string[] } | null {
  if (kind === 'wsl') return { bin: 'wt.exe', args: ['wsl.exe', '-d', distro, '--cd', cwd, '--', claudeBin, 'mcp', 'login', name] };
  if (kind === 'windows') return { bin: 'wt.exe', args: ['-d', cwd, claudeBin, 'mcp', 'login', name] };
  return null;
}

/** Straight extrapolation of a usage window. Too early in the window, the pace means nothing. */
export function windowForecast(w: LimitWindow, now: number): Forecast['windows'][number] | null {
  const span = w.kind === 'session' ? 5 * 3_600_000 : w.kind.startsWith('weekly') ? 7 * DAY_MS : null;
  if (!span || w.percent == null || !w.resetsAt || w.resetsAt <= now) return null;
  const elapsed = span - (w.resetsAt - now);
  const base = { kind: w.kind, label: w.label, percent: w.percent, resetsAt: w.resetsAt };
  if (elapsed < span * 0.05) return { ...base, projected: null, hitsAt: null };
  const projected = (w.percent / elapsed) * span;
  const hitsAt = w.percent >= 100 ? now : projected >= 100 && w.percent > 0 ? now + ((100 - w.percent) / w.percent) * elapsed : null;
  return { ...base, projected: Math.round(projected), hitsAt: hitsAt != null && hitsAt < w.resetsAt ? Math.round(hitsAt) : null };
}

const numeric = (v: string) => v.split('.').map((p) => Number.parseInt(p, 10));
export function isNewer(latest: string, installed: string): boolean {
  const [a, b] = [numeric(latest), numeric(installed)];
  if ([...a, ...b].some(Number.isNaN)) return latest !== installed;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return false;
}

export function hookRows(settings: unknown, base: Pick<HookAdminRow, 'scope' | 'project' | 'plugin' | 'file'>): HookAdminRow[] {
  const hooks = isObj(settings) && isObj(settings.hooks) ? settings.hooks : {};
  const out: HookAdminRow[] = [];
  for (const [event, list] of Object.entries(hooks)) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (!isObj(m) || !Array.isArray(m.hooks)) continue;
      for (const h of m.hooks.filter(isObj)) {
        out.push({ ...base, event, matcher: typeof m.matcher === 'string' && m.matcher ? m.matcher : null, type: String(h.type ?? 'command'), summary: String(maskValue(h.command ?? h.prompt ?? h.url ?? '', 'command')).slice(0, 400), changedAt: safely(() => Math.round(statSync(base.file).mtimeMs), null) });
      }
    }
  }
  return out;
}

// ---------- The module ----------

export function createAdmin(ctx: Ctx, skills: ReturnType<typeof createSkills>, mcp: ReturnType<typeof createMcp>, account: { status(force: boolean): Promise<{ windows: LimitWindow[] }> }) {
  const db = ctx.db;
  const windowStart = () => Date.now() - WINDOW_DAYS * DAY_MS;

  const places = () => {
    const names = new Map(safely(() => ctx.journal.listProjects(true), []).map((p) => [p.root, p.name]));
    return knownProjects(ctx).map((p) => ({ key: p.key, root: p.root, name: names.get(p.root) ?? basename(p.root) }));
  };
  const journalSince = () => (db.prepare('SELECT MIN(ts) t FROM usage_messages').get() as { t: number | null }).t;

  function skillsReport(): SkillsReport {
    const list = skills.list();
    const since = windowStart();
    const runs = db.prepare(`
      SELECT u.target, s.project, COUNT(*) n, SUM(u.ts >= ?) recent, MAX(u.ts) last
      FROM usage_log u LEFT JOIN sessions s ON s.id = u.session WHERE u.kind = 'skill' GROUP BY u.target, s.project
    `).all(since) as unknown as { target: string; project: string | null; n: number; recent: number; last: number | null }[];
    const counts = new Map<string, { runs: number; runsAll: number; last: number | null }>();
    const gone = new Map<string, { name: string; runs: number; last: number | null }>();
    const byProject = new Map<string, number>();
    for (const r of runs) {
      if (r.project) byProject.set(r.project, (byProject.get(r.project) ?? 0) + r.recent);
      const skill = resolveSkillRun(r.target, r.project, list);
      if (!skill) {
        if (r.recent > 0) {
          const g = gone.get(r.target) ?? { name: r.target, runs: 0, last: null };
          g.runs += r.recent;
          g.last = Math.max(g.last ?? 0, r.last ?? 0) || null;
          gone.set(r.target, g);
        }
        continue;
      }
      const c = counts.get(skill.id) ?? { runs: 0, runsAll: 0, last: null };
      c.runs += r.recent;
      c.runsAll += r.n;
      c.last = Math.max(c.last ?? 0, r.last ?? 0) || null;
      counts.set(skill.id, c);
    }
    const rows: SkillAdminRow[] = list.map((s) => {
      const c = counts.get(s.id);
      return { ...s, runs: c?.runs ?? 0, runsAll: c?.runsAll ?? 0, lastUsedAt: Math.max(s.lastUsedAt ?? 0, c?.last ?? 0) || null };
    });
    const daily = new Map<string, number>();
    for (const { ts } of db.prepare(`SELECT ts FROM usage_log WHERE kind = 'skill' AND ts >= ?`).all(since) as unknown as { ts: number }[]) daily.set(dayOf(ts), (daily.get(dayOf(ts)) ?? 0) + 1);
    const byDay: SkillsReport['byDay'] = [];
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) {
      const day = dayOf(Date.now() - i * DAY_MS);
      byDay.push({ day, runs: daily.get(day) ?? 0 });
    }
    const userNames = new Set(list.filter((s) => s.scope === 'user').map((s) => s.name));
    const projects = places().flatMap((p) => {
      const source = p.key ?? basename(p.root);
      const own = list.filter((s) => s.scope === 'project' && s.source === source).map((s) => s.name);
      const runsHere = p.key ? byProject.get(p.key) ?? 0 : 0;
      if (own.length === 0 && runsHere === 0) return [];
      return [{ project: p.key, name: p.name, root: p.root, own: own.filter((n) => !userNames.has(n)), overrides: own.filter((n) => userNames.has(n)), runs: runsHere }];
    }).sort((a, b) => b.own.length + b.overrides.length - a.own.length - a.overrides.length || b.runs - a.runs);
    return { windowDays: WINDOW_DAYS, journalSince: journalSince(), rows, byDay, gone: [...gone.values()].sort((a, b) => b.runs - a.runs), projects };
  }

  // ---------- MCP ----------

  const probeResults = new Map<string, ProbedServer[]>();
  const probeMeta: McpReport['probes'] = {};
  let probing = 0;

  // No strictMcpConfig, unlike the account probe: here the configured servers are the point. No prompt, so no LLM call.
  async function probeMcp(cwd: string): Promise<ProbedServer[]> {
    const input = new Inbox();
    const sessionId = randomUUID();
    ignoredSessions.add(sessionId);
    const q = query({ prompt: input, options: {
      pathToClaudeCodeExecutable: ctx.paths.claudeBin,
      cwd,
      settingSources: ['user', 'project', 'local'],
      settings: { disableAllHooks: true },
      persistSession: false,
      sessionId,
    } });
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Claude Code did not answer')), PROBE_LIMIT_MS); });
      const ask = async () => {
        const started = Date.now();
        let list = (await q.mcpServerStatus()) ?? [];
        while (list.some((s) => s.status === 'pending') && Date.now() - started < PENDING_WAIT_MS) {
          await new Promise((r) => setTimeout(r, 700));
          list = await q.mcpServerStatus();
        }
        return list as unknown as ProbedServer[];
      };
      return await Promise.race([ask(), timeout]);
    } finally {
      clearTimeout(timer);
      input.close();
      q.close();
      setTimeout(() => ignoredSessions.delete(sessionId), 30_000).unref();
    }
  }

  const rootOfPlace = (place: string) => (place === 'global' ? ctx.paths.root : knownProjects(ctx).find((p) => p.key === place || p.root === place)?.root ?? null);

  async function probePlace(place: string): Promise<void> {
    const cwd = rootOfPlace(place);
    if (!cwd) throw httpError(404, 'unknown project');
    // ~/.claude.json remembers folders long gone: nothing can load there, and the CLI would only fail to start.
    if (!existsSync(cwd)) {
      probeResults.set(place, []);
      probeMeta[place] = { at: Date.now(), error: FOLDER_GONE };
      ctx.invalidate('mcp');
      return;
    }
    probing++;
    ctx.setBusy('mcp-probe', true);
    ctx.invalidate('mcp');
    try {
      probeResults.set(place, await probeMcp(cwd));
      probeMeta[place] = { at: Date.now(), error: null };
    } catch (err) {
      probeMeta[place] = { at: Date.now(), error: (err as Error).message.split('\n')[0].slice(0, 200) };
      ctx.app.log.warn(err);
    } finally {
      probing--;
      if (probing === 0) ctx.setBusy('mcp-probe', false);
      ctx.invalidate('mcp');
    }
  }

  const pluginDescriptions = () => new Map(installedPlugins(ctx).flatMap((p) => {
    const d = readJson<{ description?: unknown }>(join(p.installPath, '.claude-plugin', 'plugin.json'))?.description;
    return typeof d === 'string' && d.trim() ? [[p.name, d.trim().slice(0, 600)] as [string, string]] : [];
  }));

  function mcpReport(): McpReport {
    const since = windowStart();
    const use = new Map<string, { calls: number; tools: Set<string>; last: number | null }>();
    for (const r of db.prepare(`
      SELECT name, COUNT(*) n, MAX(ts) last FROM tool_calls WHERE name LIKE 'mcp\\_\\_%' ESCAPE '\\' AND ts >= ? GROUP BY name
    `).all(since) as unknown as { name: string; n: number; last: number | null }[]) {
      const t = parseMcpTool(r.name);
      if (!t) continue;
      const u = use.get(t.server) ?? { calls: 0, tools: new Set<string>(), last: null };
      u.calls += r.n;
      u.tools.add(t.tool);
      u.last = Math.max(u.last ?? 0, r.last ?? 0) || null;
      use.set(t.server, u);
    }
    const servers = mcp.list();
    const placeList = places();
    const rows = mergeMcpRows(servers, probeResults, (key) => placeList.find((p) => p.key === key || p.root === key)?.name ?? basename(key), use, pluginDescriptions());
    const notes = readJson<{ mcpNotes?: Record<string, unknown> }>(join(ctx.paths.config, 'settings.json'))?.mcpNotes ?? {};
    for (const r of rows) {
      const note = notes[r.name];
      if (typeof note === 'string' && note.trim()) r.note = note.trim();
      for (const x of r.statusBy) if (x.status === 'not-loaded') x.error = probeMeta[x.place]?.error ?? null;
      r.error ??= r.statusBy.find((x) => x.error)?.error ?? null;
    }
    const known = new Set(rows.map((r) => mcpPrefix(r.name)));
    // claude-os is the app's own in-process server: not something to configure.
    const gone = [...use.entries()].filter(([name]) => !known.has(name) && name !== 'claude-os').map(([name, u]) => ({ name, calls: u.calls, last: u.last })).sort((a, b) => b.calls - a.calls);
    const globalByName = new Map(servers.filter((s) => s.scope === 'user').map((s) => [s.name, s.summary]));
    const projects = placeList.flatMap((p): AdminProjectDiff[] => {
      const own = servers.filter((s) => (s.scope === 'local' || s.scope === 'project') && (s.project === p.key || s.project === p.root));
      if (own.length === 0) return [];
      return [{ project: p.key, name: p.name, root: p.root, own: own.filter((s) => !globalByName.has(s.name)).map((s) => s.name), overrides: own.filter((s) => globalByName.has(s.name) && globalByName.get(s.name) !== s.summary).map((s) => s.name) }];
    }).sort((a, b) => b.own.length - a.own.length);
    return { windowDays: WINDOW_DAYS, journalSince: journalSince(), rows, gone, probes: probeMeta, probing: probing > 0, projects };
  }

  async function mcpStatus(project: unknown): Promise<McpReport> {
    if (project === '*') {
      const withServers = mcpReport().projects.flatMap((p) => (p.project ? [p.project] : [p.root]));
      await probePlace('global');
      for (const place of withServers) await probePlace(place);
    } else {
      await probePlace(typeof project === 'string' && project ? project : 'global');
    }
    return mcpReport();
  }

  // The status answer does not carry descriptions on every CLI version. A handshake with the server gives its own words.
  const detailsCache = new Map<string, McpServerDetails>();

  function rawConfig(name: string, place: string): Obj | null {
    const json = readClaudeJson(ctx);
    const user = json.mcpServers?.[name];
    if (place === 'global' && isObj(user)) return user;
    const root = rootOfPlace(place);
    if (root) {
      const local = json.projects?.[root]?.mcpServers?.[name];
      if (isObj(local)) return local;
      const shared = readJson<{ mcpServers?: Obj }>(join(root, '.mcp.json'))?.mcpServers?.[name];
      if (isObj(shared)) return shared;
    }
    return isObj(user) ? user : (probeResults.get(place)?.find((p) => p.name === name)?.config ?? null);
  }

  async function mcpDetails(name: unknown, placeRaw: unknown): Promise<McpServerDetails> {
    if (typeof name !== 'string' || !name) throw httpError(400, 'name is required');
    const place = typeof placeRaw === 'string' && placeRaw ? placeRaw : 'global';
    const none = (reason: McpServerDetails['reason']): McpServerDetails => ({ name, available: false, reason, instructions: null, tools: [] });
    const hit = probeResults.get(place)?.find((p) => p.name === name);
    if (hit?.status === 'needs-auth') return none('needs_login');
    if (hit && hit.status !== 'connected') return none('not_connected');
    const config = rawConfig(name, place);
    if (!config) return none('unsupported');
    const key = sha256(`${name}|${JSON.stringify(config)}`);
    const cached = detailsCache.get(key);
    if (cached) return cached;

    const type = String(config.type ?? (config.command ? 'stdio' : 'http'));
    const env = isObj(config.env) ? Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, String(v)])) : {};
    const headers = isObj(config.headers) ? Object.fromEntries(Object.entries(config.headers).map(([k, v]) => [k, String(v)])) : {};
    const client = new Client({ name: 'claude-os', version: '0.1.0' });
    let transport;
    if (type === 'stdio' && typeof config.command === 'string') {
      transport = new StdioClientTransport({ command: config.command, args: Array.isArray(config.args) ? config.args.map(String) : [], env: { ...getDefaultEnvironment(), ...env }, stderr: 'ignore', cwd: rootOfPlace(place) ?? ctx.paths.root });
    } else if (type === 'http' && typeof config.url === 'string') {
      transport = new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers } });
    } else return none('unsupported');
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), HANDSHAKE_MS); });
      const result = await Promise.race([(async () => {
        await client.connect(transport);
        const { tools } = await client.listTools();
        return { tools, instructions: client.getInstructions() ?? null };
      })(), timeout]);
      const details: McpServerDetails = {
        name, available: true, reason: null,
        instructions: result.instructions?.trim().slice(0, 2000) || null,
        tools: result.tools.map((t) => toolInfo({ name: t.name, description: t.description, annotations: { readOnly: t.annotations?.readOnlyHint, destructive: t.annotations?.destructiveHint } })),
      };
      detailsCache.set(key, details);
      return details;
    } catch (err) {
      // The message may quote the URL or an auth header: only the kind of failure leaves the server.
      return none(/401|403|unauthor/i.test((err as Error).message) ? 'needs_login' : 'error');
    } finally {
      clearTimeout(timer);
      await client.close().catch(() => {});
    }
  }

  async function mcpLogin(name: string, project: unknown): Promise<{ ok: true; command: string }> {
    if (!LOGIN_NAME.test(name)) throw httpError(400, 'bad server name');
    const place = typeof project === 'string' && project ? project : 'global';
    if (!mcpReport().rows.some((r) => r.name === name)) throw httpError(404, 'mcp server not found');
    const cwd = validateCwd(rootOfPlace(place) ?? ctx.paths.root);
    const command = `claude mcp login "${name}"`;
    const argv = mcpLoginArgv(platformKind(), cwd, ctx.paths.claudeBin, name, wslDistro());
    if (!argv) throw httpError(501, `run in a terminal: ${command}`);
    await launchDetached(argv.bin, argv.args);
    ctx.audit('mcp.login', name, cwd);
    return { ok: true, command };
  }

  // ---------- Hooks ----------

  function pluginHooks(installPath: string, name: string): HookAdminRow[] {
    const file = join(installPath, 'hooks', 'hooks.json');
    return hookRows(readJson(file), { scope: 'plugin', project: null, plugin: name, file });
  }

  const enabledMap = (file: string) => {
    const e = readJson<{ enabledPlugins?: unknown }>(file)?.enabledPlugins;
    return isObj(e) ? e : {};
  };

  function hooksReport(): HooksReport {
    const rows: HookAdminRow[] = [];
    for (const name of ['settings.json', 'settings.local.json']) {
      const file = join(ctx.paths.claudeDir, name);
      rows.push(...hookRows(readJson(file), { scope: 'user', project: null, plugin: null, file }));
    }
    const enabled = enabledMap(join(ctx.paths.claudeDir, 'settings.json'));
    const seen = new Set<string>();
    for (const p of installedPlugins(ctx)) {
      if (seen.has(p.id) || p.scope !== 'user' || enabled[p.id] !== true) continue;
      seen.add(p.id);
      rows.push(...pluginHooks(p.installPath, p.name));
    }
    const signature = (h: HookAdminRow) => `${h.event}|${h.matcher}|${h.summary}`;
    const globalSigs = new Set(rows.map(signature));
    const projects: AdminProjectDiff[] = [];
    for (const place of places()) {
      const own: string[] = [];
      const overrides: string[] = [];
      for (const [scope, name] of [['project', 'settings.json'], ['local', 'settings.local.json']] as const) {
        const file = join(place.root, '.claude', name);
        for (const h of hookRows(readJson(file), { scope, project: place.key ?? place.root, plugin: null, file })) {
          rows.push(h);
          (globalSigs.has(signature(h)) ? overrides : own).push(`${h.event}${h.matcher ? ` · ${h.matcher}` : ''}`);
        }
      }
      if (own.length || overrides.length) projects.push({ project: place.key, name: place.name, root: place.root, own, overrides });
    }
    return { rows, projects };
  }

  // ---------- Plugins ----------

  function pluginsReport(): PluginsReport {
    const pluginsDir = join(ctx.paths.claudeDir, 'plugins');
    const raw = readJson<{ plugins?: Record<string, { installPath?: string; scope?: string; projectPath?: string; version?: string; installedAt?: string; lastUpdated?: string; gitCommitSha?: string }[]> }>(join(pluginsDir, 'installed_plugins.json'))?.plugins ?? {};
    const known = readJson<Record<string, { installLocation?: string; lastUpdated?: string }>>(join(pluginsDir, 'known_marketplaces.json')) ?? {};
    const skillRows = skillsReport().rows;
    const servers = mcp.list();
    const enabled = enabledMap(join(ctx.paths.claudeDir, 'settings.json'));
    const placeList = places();
    const count = (dir: string) => safely(() => readdirSync(dir).filter((f) => f.endsWith('.md')).length, 0);
    const time = (s: string | undefined) => (s ? Date.parse(s) || null : null);

    const rows: PluginAdminRow[] = [];
    for (const [id, installs] of Object.entries(raw)) {
      if (!installs.length) continue;
      const [name, marketplace = null] = id.split('@');
      const latestInstall = [...installs].sort((a, b) => Number(b.scope === 'user') - Number(a.scope === 'user'))[0];
      const path = latestInstall.installPath ?? '';
      const manifest = readJson<{ description?: unknown; author?: unknown; homepage?: unknown; license?: unknown }>(join(path, '.claude-plugin', 'plugin.json'));
      const author = isObj(manifest?.author) ? manifest.author.name : manifest?.author;
      const brought = skillRows.filter((s) => s.scope === 'plugin' && s.source === name);
      const market = marketplace ? known[marketplace] : undefined;
      const marketDir = market?.installLocation ?? (marketplace ? join(pluginsDir, 'marketplaces', marketplace) : null);
      const catalog = marketDir ? readJson<{ plugins?: { name?: string; version?: string; source?: unknown }[] }>(join(marketDir, '.claude-plugin', 'marketplace.json')) : null;
      const entry = catalog?.plugins?.find((p) => p.name === name);
      let latest: string | null = typeof entry?.version === 'string' ? entry.version : null;
      if (!latest && marketDir && typeof entry?.source === 'string') {
        const v = readJson<{ version?: unknown }>(join(resolve(marketDir, entry.source), '.claude-plugin', 'plugin.json'))?.version;
        latest = typeof v === 'string' ? v : null;
      }
      const sha = isObj(entry?.source) && typeof entry.source.sha === 'string' ? entry.source.sha : null;
      let update: boolean | null = null;
      if (latest && latestInstall.version && latestInstall.version !== 'unknown') update = isNewer(latest, latestInstall.version);
      else if (sha && latestInstall.gitCommitSha) update = sha !== latestInstall.gitCommitSha;
      // A Windows home seen from WSL is a user-level install, not a project: no badge for it.
      const roots = installs.flatMap((i) => (i.projectPath && !WINDOWS_HOME.test(i.projectPath) ? [i.projectPath] : []));
      rows.push({
        id, name, marketplace,
        description: typeof manifest?.description === 'string' ? manifest.description.trim().slice(0, 400) : null,
        version: latestInstall.version ?? null,
        enabled: enabled[id] === true,
        scopes: [...new Set(installs.map((i) => i.scope ?? 'user'))],
        projects: [...new Set(roots)].map((root) => {
          const p = placeList.find((x) => x.root === root);
          return { key: p?.key ?? null, name: p?.name ?? basename(root) };
        }),
        installedAt: time(latestInstall.installedAt),
        updatedAt: time(latestInstall.lastUpdated),
        skills: brought.length,
        skillsUsed: brought.filter((s) => s.runs > 0).length,
        runs: brought.reduce((a, s) => a + s.runs, 0),
        mcp: servers.filter((s) => s.name.startsWith(`plugin:${name}:`)).length,
        hooks: pluginHooks(path, name).length,
        agents: count(join(path, 'agents')),
        commands: count(join(path, 'commands')),
        latest,
        update,
        marketplaceAt: time(market?.lastUpdated),
        author: typeof author === 'string' ? author : null,
        homepage: typeof manifest?.homepage === 'string' ? manifest.homepage : null,
        license: typeof manifest?.license === 'string' ? manifest.license : null,
      });
    }
    rows.sort((a, b) => Number(b.enabled) - Number(a.enabled) || b.runs - a.runs || a.name.localeCompare(b.name));
    const projects: AdminProjectDiff[] = [];
    for (const place of placeList) {
      const own = rows.filter((r) => Object.values(raw[r.id]).some((i) => i.projectPath === place.root)).map((r) => r.name);
      const overrides = new Set<string>();
      for (const file of ['settings.json', 'settings.local.json']) {
        for (const [id, on] of Object.entries(enabledMap(join(place.root, '.claude', file)))) {
          if (on !== (enabled[id] === true)) overrides.add(id.split('@')[0]);
        }
      }
      if (own.length || overrides.size) projects.push({ project: place.key, name: place.name, root: place.root, own, overrides: [...overrides] });
    }
    projects.sort((a, b) => b.own.length - a.own.length);
    return { windowDays: WINDOW_DAYS, rows, projects };
  }

  // ---------- One entity's page ----------

  function tally(uses: { ts: number | null; project?: string | null; n?: number }[]) {
    const since = windowStart();
    const placeList = places();
    const daily = new Map<string, number>();
    const perProject = new Map<string, number>();
    let [total, recent, last] = [0, 0, 0];
    for (const u of uses) {
      const n = u.n ?? 1;
      total += n;
      last = Math.max(last, u.ts ?? 0);
      if (!u.ts || u.ts < since) continue;
      recent += n;
      daily.set(dayOf(u.ts), (daily.get(dayOf(u.ts)) ?? 0) + n);
      if (u.project) perProject.set(u.project, (perProject.get(u.project) ?? 0) + n);
    }
    const byDay = Array.from({ length: WINDOW_DAYS }, (_, i) => dayOf(Date.now() - (WINDOW_DAYS - 1 - i) * DAY_MS)).map((day) => ({ day, n: daily.get(day) ?? 0 }));
    const byProject = [...perProject].map(([key, n]) => ({ key, name: placeList.find((p) => p.key === key)?.name ?? key, n })).sort((a, b) => b.n - a.n);
    return { windowDays: WINDOW_DAYS, journalSince: journalSince(), total, recent, last: last || null, byDay, byProject };
  }

  const countBy = (names: string[]) => [...names.reduce((m, name) => m.set(name, (m.get(name) ?? 0) + 1), new Map<string, number>())].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n);

  // The table is the app's own: a bare test database has none, and a page without history is still a page.
  const auditFor = (action: string, matches: (target: string) => boolean) =>
    safely(() => db.prepare(`SELECT at, action, target FROM audit_log WHERE action LIKE ? ORDER BY at DESC LIMIT 200`).all(`${action}.%`) as unknown as { at: number; action: string; target: string }[], [])
      .filter((r) => matches(r.target)).slice(0, 20).map(({ at, action: a }) => ({ at, action: a }));

  function skillStats(id: string): EntityStats {
    const list = skills.list();
    const skill = list.find((s) => s.id === id);
    if (!skill) throw httpError(404, 'skill not found');
    const rows = db.prepare(`SELECT u.target, s.project, u.ts FROM usage_log u LEFT JOIN sessions s ON s.id = u.session WHERE u.kind = 'skill' AND u.target IN (?, ?)`).all(skill.name, `${skill.source}:${skill.name}`) as unknown as { target: string; project: string | null; ts: number | null }[];
    const file = join(skill.path, 'SKILL.md');
    const stat = safely(() => statSync(file), null);
    const { data } = parseFrontmatter(safely(() => readFileSync(file, 'utf8'), ''));
    const real = safely(() => realpathSync(skill.path), skill.path);
    const base = resolve(skill.path, '..', '..');
    const ofThis = (target: string) => (target === real || target.startsWith(`${real}/`) || (target.startsWith(`${base}/`) && (target.endsWith(`/${skill.name}`) || target.endsWith(`/${skill.name}/SKILL.md`))));
    return {
      ...tally(rows.filter((r) => resolveSkillRun(r.target, r.project, list)?.id === id)),
      byName: [],
      byModel: [],
      createdAt: stat?.birthtimeMs ? Math.round(stat.birthtimeMs) : null,
      changedAt: stat ? Math.round(stat.mtimeMs) : null,
      meta: Object.fromEntries(['author', 'version', 'license', 'model', 'allowed-tools'].flatMap((k) => (data[k] ? [[k, data[k]]] : []))),
      history: auditFor('skill', ofThis),
    };
  }

  function mcpStats(name: string): EntityStats {
    const prefix = `mcp__${mcpPrefix(name)}__`;
    const rows = db.prepare(`SELECT t.name, t.ts, s.project FROM tool_calls t LEFT JOIN sessions s ON s.id = t.session WHERE t.name LIKE ? ESCAPE '\\'`).all(`${prefix.replace(/[\\%_]/g, '\\$&')}%`) as unknown as { name: string; ts: number | null; project: string | null }[];
    const since = windowStart();
    const shared = mcp.list().find((s) => s.name === name && s.scope === 'project')?.file;
    const stat = shared ? safely(() => statSync(shared), null) : null;
    return {
      ...tally(rows),
      byName: countBy(rows.filter((r) => r.ts && r.ts >= since).map((r) => r.name.slice(prefix.length))),
      byModel: [],
      createdAt: null,
      // ~/.claude.json changes all the time for other reasons: its date says nothing about one server.
      changedAt: stat ? Math.round(stat.mtimeMs) : null,
      meta: {},
      history: auditFor('mcp', (target) => target.endsWith(`:${name}`)),
    };
  }

  function projectStats(key: string): EntityStats {
    const since = windowStart();
    const tokens = db.prepare(`SELECT m.ts, m.model, m.input + m.output + m.cache_write n FROM usage_messages m JOIN sessions s ON s.id = m.session WHERE s.project = ?`).all(key) as unknown as { ts: number | null; model: string | null; n: number }[];
    const span = db.prepare(`SELECT MIN(first_activity) a, MAX(last_activity) b FROM sessions WHERE project = ?`).get(key) as { a: number | null; b: number | null };
    const calls = db.prepare(`SELECT t.name, COUNT(*) n FROM tool_calls t JOIN sessions s ON s.id = t.session WHERE s.project = ? AND t.ts >= ? GROUP BY t.name ORDER BY n DESC LIMIT 12`).all(key, since) as unknown as { name: string; n: number }[];
    const models = new Map<string, number>();
    for (const m of tokens) if (m.model && m.model !== '<synthetic>' && m.ts && m.ts >= since) models.set(m.model, (models.get(m.model) ?? 0) + m.n);
    const { byProject: _own, ...totals } = tally(tokens);
    return {
      ...totals,
      last: span.b ?? totals.last,
      byProject: [],
      byName: calls,
      byModel: [...models].map(([name, n]) => ({ name, n })).sort((a, b) => b.n - a.n),
      createdAt: span.a,
      changedAt: null,
      meta: {},
      history: [],
    };
  }

  function entityStats(type: unknown, id: unknown): EntityStats {
    if (typeof id !== 'string' || !id) throw httpError(400, 'id is required');
    if (type === 'skill') return skillStats(id);
    if (type === 'mcp') return mcpStats(id);
    if (type === 'project') return projectStats(id);
    throw httpError(400, 'type must be skill, mcp or project');
  }

  // ---------- Forecast ----------

  async function forecast(): Promise<Forecast> {
    const now = Date.now();
    const today = dayOf(now);
    const BASIS = 14;
    const first = dayOf(now - BASIS * DAY_MS);
    const days = db.prepare(`SELECT day, SUM(input + output + cache_write) t FROM usage_messages WHERE day >= ? AND day < ? GROUP BY day`).all(first, today) as unknown as { day: string; t: number }[];
    const total = days.reduce((a, d) => a + d.t, 0);
    const dailyAverage = total / BASIS;
    const midnight = new Date(now);
    midnight.setHours(0, 0, 0, 0);
    const hours = Array.from({ length: 24 }, () => 0);
    for (const r of db.prepare(`SELECT ts, input + output + cache_write t FROM usage_messages WHERE ts >= ?`).all(midnight.getTime()) as unknown as { ts: number; t: number }[]) {
      hours[new Date(r.ts).getHours()] += r.t;
    }
    const todayTotal = hours.reduce((a, b) => a + b, 0);
    const left = 1 - (now - midnight.getTime()) / DAY_MS;
    const { windows } = await account.status(false).catch(() => ({ windows: [] as LimitWindow[] }));
    return {
      basisDays: BASIS,
      activeDays: days.filter((d) => d.t > 0).length,
      dailyAverage: Math.round(dailyAverage),
      today: todayTotal,
      todayHours: hours,
      todayProjected: Math.round(todayTotal + dailyAverage * left),
      weekProjected: Math.round(dailyAverage * 7),
      monthProjected: Math.round(dailyAverage * 30),
      windows: windows.flatMap((w) => windowForecast(w, now) ?? []),
    };
  }

  return { skillsReport, mcpReport, mcpStatus, mcpDetails, mcpLogin, hooksReport, pluginsReport, entityStats, forecast };
}

export function registerAdmin(ctx: Ctx, admin: ReturnType<typeof createAdmin>): void {
  const { app } = ctx;
  app.get('/api/admin/skills', async () => admin.skillsReport());
  app.get('/api/admin/mcp', async () => admin.mcpReport());
  app.post<{ Body: { project?: unknown } | null }>('/api/admin/mcp/status', async (req) => admin.mcpStatus(req.body?.project));
  app.get<{ Querystring: { name?: string; place?: string } }>('/api/admin/mcp/details', async (req) => admin.mcpDetails(req.query.name, req.query.place));
  app.post<{ Params: { name: string }; Body: { project?: unknown } | null }>('/api/mcp/:name/login', async (req) => admin.mcpLogin(req.params.name, req.body?.project));
  app.get('/api/admin/hooks', async () => admin.hooksReport());
  app.get('/api/admin/plugins', async () => admin.pluginsReport());
  app.get<{ Querystring: { type?: string; id?: string } }>('/api/admin/entity', async (req) => admin.entityStats(req.query.type, req.query.id));
  app.get('/api/admin/forecast', async () => admin.forecast());
}
