// Claude's agents: the .md files of ~/.claude/agents, of each project and of each plugin, with what the journals hold about their runs.
// A run is one row of the journal's `subagents` table, that is one agent-*.jsonl with the type named in its meta file.
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { watch } from 'chokidar';
import type { AgentDetail, AgentRow, AgentsReport, EntityStats } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { localDay } from '../journal/db.ts';
import { backupFile, httpError, parseFrontmatter, safely, sha256 } from '../memory/util.ts';
import { installedPlugins, knownProjects, readJson } from './shared.ts';

const WINDOW_DAYS = 30;
const DAY_MS = 86_400_000;
const MAX_DEPTH = 4;
const RECENT_RUNS = 20;

function agentFiles(dir: string, depth = 0): string[] {
  return safely(() => readdirSync(dir), []).filter((n) => !n.startsWith('.')).flatMap((name) => {
    const path = join(dir, name);
    if (name.endsWith('.md')) return [path];
    return depth < MAX_DEPTH && safely(() => statSync(path).isDirectory(), false) ? agentFiles(path, depth + 1) : [];
  });
}

// "a, b", "[a, b]" and a YAML list, which parseFrontmatter joins into "- a - b".
export function parseTools(raw: string | undefined): string[] | null {
  if (!raw) return null;
  return raw.replace(/^\[|\]$/g, '').split(/,|(?:^|\s)-\s/).map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

type Definition = Omit<AgentRow, 'runs' | 'runsAll' | 'tokens' | 'lastUsedAt'>;

// A readme next to the agents is not an agent: Claude Code wants a frontmatter with these fields too.
function readDefinition(path: string, scope: AgentRow['scope'], source: string | null, makeId: (name: string) => string): Definition | null {
  const { data } = parseFrontmatter(safely(() => readFileSync(path, 'utf8'), ''));
  if (!data.name && !data.description) return null;
  const name = data.name || basename(path, '.md');
  return {
    id: makeId(name),
    name,
    scope,
    source,
    description: data.description || null,
    model: data.model || null,
    tools: parseTools(data.tools),
    path,
    readOnly: scope === 'plugin',
    isSymlink: safely(() => lstatSync(path).isSymbolicLink(), false),
  };
}

function pluginAgentDirs(installPath: string): string[] {
  const manifest = readJson<{ agents?: string | string[] }>(join(installPath, '.claude-plugin', 'plugin.json'));
  const declared = manifest?.agents ? [manifest.agents].flat() : [];
  return [...new Set(['agents', ...declared].map((rel) => resolve(installPath, rel)))].filter((p) => p === installPath || p.startsWith(installPath + sep));
}

export function listDefinitions(ctx: Ctx): Definition[] {
  const out = new Map<string, Definition>();
  const put = (d: Definition | null) => {
    if (d && !out.has(d.id)) out.set(d.id, d);
  };
  for (const file of agentFiles(join(ctx.paths.claudeDir, 'agents'))) put(readDefinition(file, 'user', null, (n) => `user:${n}`));
  for (const { key, root } of knownProjects(ctx)) {
    const source = key ?? basename(root);
    for (const file of agentFiles(join(root, '.claude', 'agents'))) {
      put(readDefinition(file, 'project', source, (n) => {
        const id = `project:${source}:${n}`;
        return out.has(id) && out.get(id)!.path !== file ? `${id}~${sha256(root).slice(0, 4)}` : id;
      }));
    }
  }
  const seen = new Set<string>();
  for (const plugin of installedPlugins(ctx)) {
    if (seen.has(plugin.installPath)) continue;
    seen.add(plugin.installPath);
    for (const dir of pluginAgentDirs(plugin.installPath)) {
      const files = dir.endsWith('.md') ? [dir] : agentFiles(dir);
      for (const file of files) put(readDefinition(file, 'plugin', plugin.name, (n) => `plugin:${plugin.name}:${n}`));
    }
  }
  return [...out.values()];
}

// A plugin's agent runs as plugin:name; a plain name means what it means at run time: the project's own copy first.
export function resolveAgentRun<T extends Pick<AgentRow, 'name' | 'scope' | 'source'>>(type: string, project: string | null, agents: T[]): T | null {
  return agents.find((a) => a.scope === 'plugin' && `${a.source}:${a.name}` === type)
    ?? agents.find((a) => a.scope === 'project' && a.name === type && a.source === project)
    ?? agents.find((a) => a.scope === 'user' && a.name === type)
    ?? agents.find((a) => a.scope === 'plugin' && a.name === type)
    ?? null;
}

interface RunRow { session: string; type: string | null; project: string | null; description: string | null; at: number | null; tokens: number; }

export function createAgents(ctx: Ctx) {
  const { db } = ctx;

  const runs = () => db.prepare(`
    SELECT a.session, a.agent_type type, s.project, a.description, a.last_activity at, COALESCE(u.tokens, 0) tokens
    FROM subagents a
    LEFT JOIN sessions s ON s.id = a.session
    LEFT JOIN (SELECT session, agent_id, SUM(input + output + cache_write) tokens FROM usage_messages WHERE agent_id IS NOT NULL GROUP BY session, agent_id) u
      ON u.session = a.session AND u.agent_id = a.id
    WHERE COALESCE(s.removed, 0) = 0
    ORDER BY a.last_activity DESC
  `).all() as unknown as RunRow[];
  const journalSince = () => (db.prepare('SELECT MIN(ts) t FROM usage_messages').get() as { t: number | null }).t;
  const windowStart = () => Date.now() - WINDOW_DAYS * DAY_MS;

  function emptyDays(): Map<string, number> {
    const days = new Map<string, number>();
    for (let i = WINDOW_DAYS - 1; i >= 0; i--) days.set(localDay(Date.now() - i * DAY_MS), 0);
    return days;
  }

  function report(): AgentsReport {
    const defs = listDefinitions(ctx);
    const since = windowStart();
    const counts = new Map<string, { runs: number; runsAll: number; tokens: number; last: number | null }>();
    const other = new Map<string, AgentsReport['other'][number]>();
    const days = emptyDays();
    let untyped = 0;
    for (const r of runs()) {
      if (!r.type) {
        untyped++;
        continue;
      }
      const recent = (r.at ?? 0) >= since;
      if (recent) days.set(localDay(r.at!), (days.get(localDay(r.at!)) ?? 0) + 1);
      const def = resolveAgentRun(r.type, r.project, defs);
      if (!def) {
        const o = other.get(r.type) ?? { name: r.type, runs: 0, runsAll: 0, last: null };
        o.runs += recent ? 1 : 0;
        o.runsAll++;
        o.last = Math.max(o.last ?? 0, r.at ?? 0) || null;
        other.set(r.type, o);
        continue;
      }
      const c = counts.get(def.id) ?? { runs: 0, runsAll: 0, tokens: 0, last: null };
      c.runs += recent ? 1 : 0;
      c.runsAll++;
      c.tokens += recent ? r.tokens : 0;
      c.last = Math.max(c.last ?? 0, r.at ?? 0) || null;
      counts.set(def.id, c);
    }
    const rows = defs.map((d): AgentRow => {
      const c = counts.get(d.id);
      return { ...d, runs: c?.runs ?? 0, runsAll: c?.runsAll ?? 0, tokens: c?.tokens ?? 0, lastUsedAt: c?.last ?? null };
    });
    const names = new Map(safely(() => ctx.journal.listProjects(true), []).map((p) => [p.root, p.name]));
    const userNames = new Set(defs.filter((d) => d.scope === 'user').map((d) => d.name));
    const projects = knownProjects(ctx).flatMap((p) => {
      const source = p.key ?? basename(p.root);
      const own = defs.filter((d) => d.scope === 'project' && d.source === source).map((d) => d.name);
      if (own.length === 0) return [];
      return [{ project: p.key, name: names.get(p.root) ?? basename(p.root), root: p.root, own: own.filter((n) => !userNames.has(n)), overrides: own.filter((n) => userNames.has(n)) }];
    });
    return {
      windowDays: WINDOW_DAYS,
      journalSince: journalSince(),
      rows,
      byDay: [...days].map(([day, n]) => ({ day, runs: n })),
      other: [...other.values()].sort((a, b) => b.runs - a.runs || b.runsAll - a.runsAll),
      untyped,
      projects,
    };
  }

  function find(id: string): AgentRow {
    const row = report().rows.find((a) => a.id === id);
    if (!row) throw httpError(404, 'agent not found');
    return row;
  }

  function detail(id: string): AgentDetail {
    const defs = listDefinitions(ctx);
    const agent = find(id);
    const own = runs().filter((r) => r.type && resolveAgentRun(r.type, r.project, defs)?.id === id);
    const since = windowStart();
    const days = emptyDays();
    const perProject = new Map<string, number>();
    for (const r of own) {
      if ((r.at ?? 0) < since) continue;
      days.set(localDay(r.at!), (days.get(localDay(r.at!)) ?? 0) + 1);
      perProject.set(r.project ?? '', (perProject.get(r.project ?? '') ?? 0) + 1);
    }
    const projectName = new Map(safely(() => ctx.journal.listProjects(true), []).map((p) => [p.key, p.name]));
    const st = safely(() => statSync(agent.path), null);
    const stats: EntityStats = {
      windowDays: WINDOW_DAYS,
      journalSince: journalSince(),
      total: own.length,
      recent: agent.runs,
      last: agent.lastUsedAt,
      byDay: [...days].map(([day, n]) => ({ day, n })),
      byProject: [...perProject].filter(([key]) => key).map(([key, n]) => ({ key, name: projectName.get(key) ?? key, n })).sort((a, b) => b.n - a.n),
      byName: [],
      byModel: [],
      createdAt: st?.birthtimeMs || null,
      changedAt: st?.mtimeMs || null,
      meta: {},
      history: safely(() => db.prepare('SELECT at, action FROM audit_log WHERE target = ? ORDER BY id DESC LIMIT 20').all(agent.path) as unknown as EntityStats['history'], []),
    };
    return {
      agent,
      content: readFileSync(agent.path, 'utf8'),
      stats,
      recent: own.slice(0, RECENT_RUNS).map(({ session, project, description, at, tokens }) => ({ session, project, description, at, tokens })),
    };
  }

  // The same as a skill: a link loses only the link, a real file gets a copy in data/backups first.
  function remove(id: string, confirmed: unknown): { ok: true; backup: string | null } {
    if (confirmed !== true) throw httpError(400, 'confirmed: true is required');
    const agent = find(id);
    if (agent.readOnly) throw httpError(403, 'an agent of a plugin belongs to the plugin');
    let backup: string | null = null;
    if (agent.isSymlink) unlinkSync(agent.path);
    else {
      backup = backupFile(ctx.paths.data, agent.path);
      rmSync(agent.path);
    }
    ctx.audit('agent.delete', agent.path, null);
    ctx.invalidate('agents', 'overview');
    return { ok: true, backup };
  }

  return { report, detail, remove };
}

export function registerAgents(ctx: Ctx): void {
  const { app } = ctx;
  const agents = createAgents(ctx);
  app.get('/api/agents', async () => agents.report());
  app.get<{ Params: { id: string } }>('/api/agents/:id', async (req) => agents.detail(req.params.id));
  app.delete<{ Params: { id: string }; Body: { confirmed?: unknown } | null }>('/api/agents/:id', async (req) => agents.remove(req.params.id, req.body?.confirmed));

  const userDir = join(ctx.paths.claudeDir, 'agents');
  const watcher = watch(userDir, {
    ignoreInitial: true,
    depth: MAX_DEPTH,
    followSymlinks: false,
    ignored: (p) => relative(userDir, p).split(sep).some((part) => part.startsWith('.')),
  }).on('all', () => ctx.invalidate('agents'));
  app.addHook('onClose', () => watcher.close());
}
