import { readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { Analytics, AuditEntry, Overview, Project, SessionInfo, Topic } from '../../shared/contract.ts';
import type { Ctx, Paths } from '../context.ts';
import { getMeta, initSchema, setMeta } from './db.ts';
import { createIndexer, SKIP_DIRS, classifyJournal } from './indexer.ts';
import { computeLive, ignoredSessions, pollAgents, procStartOf, readRegistry, type AgentEntry, type LiveSession } from './live.ts';
import { registerManage } from './manage.ts';
import { findJournal, readTranscriptAsync } from './parse.ts';
import { createProjects, loadOverrides, projectPatchProblem, within } from './projects.ts';
import { parseRange, queryAnalytics, querySessions } from './queries.ts';
import { queryUsage, usageBySkill } from './usage.ts';

export { readTranscript, recordToChatEvents } from './parse.ts';

const LIVE_MS = 5_000;
const SWEEP_MS = 60_000;
const NOTIFY_MS = 1_000;
const NOTIFY_SCAN_MS = 5_000;
const LOST_MAX_AGE_MS = 14 * 86_400_000; // a dead registry file older than this is no news

function readJson(path: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function countOverview(claudeDir: string, claudeJson: string) {
  let skills = 0;
  try {
    skills = readdirSync(join(claudeDir, 'skills'), { withFileTypes: true })
      .filter((e) => (e.isDirectory() || e.isSymbolicLink()) && !e.name.startsWith('.')).length;
  } catch { /* no skills dir */ }
  const settings = readJson(join(claudeDir, 'settings.json'));
  const plugins = Object.values((settings.enabledPlugins ?? {}) as Record<string, unknown>).filter((v) => v === true).length;
  let hooks = 0;
  for (const matchers of Object.values((settings.hooks ?? {}) as Record<string, unknown>)) {
    if (!Array.isArray(matchers)) continue;
    for (const m of matchers) hooks += Array.isArray((m as { hooks?: unknown })?.hooks) ? (m as { hooks: unknown[] }).hooks.length : 1;
  }
  // Names only: env and header values stay in the file.
  const cj = readJson(claudeJson);
  const names = new Set(Object.keys((cj.mcpServers ?? {}) as object));
  for (const p of Object.values((cj.projects ?? {}) as Record<string, { mcpServers?: object }>)) {
    for (const n of Object.keys(p?.mcpServers ?? {})) names.add(n);
  }
  return { skills, plugins, hooks, mcpServers: names.size };
}

// Not projects: the root session's cwd and throwaway dirs. A fake claude dir under tmp (tests) keeps its tmp projects.
export function hiddenRoot(root: string, paths: Pick<Paths, 'root' | 'claudeDir'>): boolean {
  if (root === paths.root) return true;
  const tmp = ['/tmp', tmpdir()];
  return tmp.some((t) => within(root, t)) && !tmp.some((t) => within(paths.claudeDir, t));
}

export interface JournalOpts { pollAgents?: boolean; sweepMs?: number; watch?: boolean; }

export function createJournal(ctx: Ctx, opts: JournalOpts = {}) {
  const { db, paths } = ctx;
  initSchema(db);
  const projectsDir = join(paths.claudeDir, 'projects');
  const sessionsDir = join(paths.claudeDir, 'sessions');
  const projects = createProjects(db, loadOverrides(paths.config));

  // Version 2: every cwd used to create a project and gone worktrees became their own. Re-map once, keeping keys.
  if (getMeta(db, 'projects_version') !== '2') {
    db.exec('DELETE FROM cwd_projects');
    const setProject = db.prepare('UPDATE sessions SET project = ? WHERE id = ?');
    for (const s of db.prepare("SELECT id, cwd FROM sessions WHERE cwd != ''").all() as unknown as { id: string; cwd: string }[]) {
      setProject.run(projects.forCwd(s.cwd), s.id);
    }
    setMeta(db, 'projects_version', '2');
  }

  // The root session's folder is part of Claude OS: its sessions count there, and only a tag tells them apart.
  // forCwd itself keeps the folder's own key: the notes kept under it and the map's merge go by that key.
  // The service session's folder belongs to no project: no list or counter sees its sessions. The setup tab's folder belongs to none either.
  const inService = (cwd: string) => [paths.service, paths.setup].some((dir) => Boolean(dir) && within(cwd, dir));
  const sessionProject = (cwd: string) => (inService(cwd) ? null : projects.forCwd(within(cwd, paths.root) ? paths.repo : cwd));
  if (getMeta(db, 'root_sessions_folded') !== '1') {
    const setProject = db.prepare('UPDATE sessions SET project = ? WHERE id = ?');
    for (const s of db.prepare("SELECT id, cwd FROM sessions WHERE cwd != ''").all() as unknown as { id: string; cwd: string }[]) {
      if (within(s.cwd, paths.root)) setProject.run(sessionProject(s.cwd), s.id);
    }
    setMeta(db, 'root_sessions_folded', '1');
  }

  let live = new Map<string, LiveSession>();
  let agents: AgentEntry[] = [];
  let liveKey = '';
  let stopped = false;
  const timers: NodeJS.Timeout[] = [];
  const watchers: FSWatcher[] = [];
  let stopPoll: (() => void) | null = null;

  // Chatty files write many times a second: the UI hears about it at most once a NOTIFY_MS.
  let notifyTimer: NodeJS.Timeout | null = null;
  const notifyTopics = new Set<Topic>();
  function notify(delay: number, ...topics: Topic[]) {
    topics.forEach((t) => notifyTopics.add(t));
    notifyTimer ??= setTimeout(() => {
      notifyTimer = null;
      ctx.invalidate(...notifyTopics);
      notifyTopics.clear();
    }, delay);
    notifyTimer.unref();
  }

  // Row caches: many modules ask, the rows change only on commits and status changes.
  let sessionsCache: SessionInfo[] | null = null;
  let analyticsCache: { range: string; value: Analytics } | null = null;
  const dropCache = () => {
    sessionsCache = null;
    analyticsCache = null;
  };

  const indexer = createIndexer({
    db,
    projectsDir,
    usageRoots: { vault: paths.vault, claudeDir: paths.claudeDir },
    osRoots: paths.repo ? { repo: paths.repo, config: paths.config } : undefined,
    projectForCwd: sessionProject,
    onCommit(firstScan) {
      dropCache();
      notify(firstScan ? NOTIFY_SCAN_MS : NOTIFY_MS, 'sessions', 'projects', 'tokens', 'overview', 'usage');
    },
  });

  const upsertLive = db.prepare(`
    INSERT INTO sessions (id, project, cwd, kind, name, first_activity, last_activity, status, pid, version)
    VALUES (?, ?, COALESCE(?, ''), COALESCE(?, 'interactive'), ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      project = COALESCE(project, excluded.project),
      cwd = CASE WHEN cwd = '' THEN excluded.cwd ELSE cwd END,
      kind = CASE WHEN excluded.kind != 'interactive' THEN excluded.kind ELSE kind END,
      name = COALESCE(excluded.name, name),
      last_activity = MAX(COALESCE(last_activity, excluded.last_activity), COALESCE(excluded.last_activity, last_activity)),
      status = excluded.status, pid = excluded.pid, removed = 0
  `);
  const getProject = db.prepare('SELECT project FROM sessions WHERE id = ?');
  const markEnded = db.prepare("UPDATE sessions SET status = 'ended', pid = NULL WHERE status != 'ended'");

  function refreshLive() {
    if (stopped) return;
    const next = computeLive(readRegistry(paths.claudeDir), agents);
    const key = JSON.stringify([...next.values()].map((l) => [l.sessionId, l.status, l.pid, l.name]).sort());
    live = next;
    if (key === liveKey) return;
    liveKey = key;
    db.exec('BEGIN');
    try {
      markEnded.run();
      for (const l of next.values()) {
        upsertLive.run(
          l.sessionId, l.cwd && !(getProject.get(l.sessionId) as { project: string | null } | undefined)?.project ? sessionProject(l.cwd) : null, l.cwd, l.kind, l.name, l.startedAt, l.updatedAt,
          l.status, l.pid, l.version,
        );
      }
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
    dropCache();
    notify(150, 'sessions', 'projects');
    ctx.bus.emit('sessions-changed');
  }

  // Runs before the first refreshLive, which marks everything gone as ended. A session is lost if it was running at our
  // last look and is gone now, or if the CLI left its registry file behind: a clean exit removes that file.
  db.exec('CREATE TABLE IF NOT EXISTS lost_sessions (id TEXT PRIMARY KEY, found_at INTEGER NOT NULL, dismissed INTEGER NOT NULL DEFAULT 0)');
  function noteLostSessions() {
    const registry = readRegistry(paths.claudeDir);
    const alive = computeLive(registry, []);
    const seen = (db.prepare("SELECT id FROM sessions WHERE status != 'ended' AND removed = 0").all() as unknown as { id: string }[]).map((r) => r.id);
    const stale = registry.filter((e) => !ignoredSessions.has(e.sessionId) && (e.updatedAt ?? e.startedAt ?? 0) > Date.now() - LOST_MAX_AGE_MS && (!e.procStart || procStartOf(e.pid) !== String(e.procStart))).map((e) => e.sessionId);
    const add = db.prepare('INSERT OR IGNORE INTO lost_sessions (id, found_at) VALUES (?, ?)');
    for (const id of new Set([...seen, ...stale])) if (!alive.has(id)) add.run(id, Date.now());
  }
  const dismissLost = db.prepare('UPDATE lost_sessions SET dismissed = 1 WHERE id = ?');

  function listSessions(): SessionInfo[] {
    sessionsCache ??= querySessions(db, live, paths.root, paths.service);
    return sessionsCache;
  }

  function listProjects(includeEmpty = false): Project[] {
    const stats = new Map((db.prepare(`
      SELECT project, COUNT(*) n, MAX(last_activity) last, SUM(status != 'ended') live FROM sessions WHERE project IS NOT NULL AND removed = 0 GROUP BY project
    `).all() as unknown as { project: string; n: number; last: number | null; live: number }[]).map((r) => [r.project, r]));
    // A removed project's settings may still point at the vault: only a new session brings it back.
    const removed = new Set(projects.rows().filter((r) => r.removed_at !== null).map((r) => r.key));
    return projects.rows().filter((r) => !hiddenRoot(r.root, paths)).map((r) => {
      const s = stats.get(r.key);
      const mem = ctx.memory?.projectStats(r.key);
      return {
        key: r.key,
        name: r.name,
        root: r.root,
        misc: r.misc,
        sessionCount: s?.n ?? 0,
        liveCount: s?.live ?? 0,
        lastActivity: s?.last ?? null,
        memoryCount: mem?.count ?? 0,
        memoryConnected: mem?.connected ?? false,
        memoryDrift: mem?.drift ?? 0,
        pinned: r.pinned === 1,
        mapPin: r.map_pin === null ? null : r.map_pin === 1,
        description: r.description,
        color: r.color,
        parent: r.parent,
        folder: r.folder === 1,
      };
    }).filter((p) => includeEmpty || p.pinned || p.sessionCount > 0 || (!removed.has(p.key) && (p.memoryCount > 0 || p.memoryConnected))) // a cwd seen in passing is not a project
      .sort((a, b) => Number(a.folder) - Number(b.folder) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0)); // a plain folder is no place to start work
  }

  ctx.journal = {
    listProjects,
    listSessions,
    projectForCwd: (cwd) => projects.forCwd(cwd),
    setMapPin(key, on) {
      db.prepare('UPDATE projects SET map_pin = ? WHERE key = ?').run(on === null ? null : Number(on), key);
      ctx.invalidate('projects');
      return listProjects(true).find((p) => p.key === key) ?? null;
    },
    updateProject(key, patch) {
      const all = listProjects(true);
      if (!all.some((p) => p.key === key)) return null;
      const problem = projectPatchProblem(all, key, patch);
      if (problem) throw new Error(problem);
      // Claude OS itself: a fixed name, and always a project, never a plain folder.
      if ((patch.name !== undefined || patch.folder !== undefined) && paths.repo && key === projects.forCwd(paths.repo)) throw new Error('Claude OS keeps its name and stays a project');
      const columns: [string, string | number | null | undefined][] = [
        ['name', patch.name?.trim()],
        ['description', patch.description === undefined ? undefined : patch.description?.trim() || null],
        ['color', patch.color],
        ['parent', patch.parent],
        ['folder', patch.folder === undefined ? undefined : Number(patch.folder)],
      ];
      const set = columns.filter((c): c is [string, string | number | null] => c[1] !== undefined);
      if (set.length > 0) db.prepare(`UPDATE projects SET ${set.map(([c]) => `${c} = ?`).join(', ')} WHERE key = ?`).run(...set.map(([, v]) => v), key);
      ctx.invalidate('projects');
      return listProjects(true).find((p) => p.key === key) ?? null;
    },
    // listSessions leaves out whatever has no journal to resume from. A service job is nobody's conversation to continue.
    lostSessions() {
      const ids = new Set((db.prepare('SELECT id FROM lost_sessions WHERE dismissed = 0').all() as unknown as { id: string }[]).map((r) => r.id));
      const lost = ids.size ? listSessions().filter((s) => ids.has(s.id)) : [];
      // Back in a terminal, it is not lost any more; when that one ends, it ends.
      for (const s of lost) if (s.status !== 'ended') dismissLost.run(s.id);
      return lost.filter((s) => s.status === 'ended' && !s.serviceFolder && s.origin === 'external' && s.kind !== 'sdk' && findJournal(s.id, s.cwd || null, paths.claudeDir));
    },
    dismissLost(sessionId) {
      dismissLost.run(sessionId);
    },
    markOsSession(sessionId, source, detail) {
      db.prepare(`
        INSERT INTO sessions (id, origin, os_source, os_source_detail) VALUES (?, 'os', ?, ?) ON CONFLICT(id) DO UPDATE SET origin = 'os',
          os_source = COALESCE(NULLIF(os_source, ''), excluded.os_source, os_source), os_source_detail = COALESCE(os_source_detail, excluded.os_source_detail)
      `).run(sessionId, source ?? null, detail ?? null);
      dropCache();
      notify(NOTIFY_MS, 'sessions', 'tokens');
    },
  };

  ctx.bus.on('session-origin', (id) => ctx.journal.markOsSession(id));
  ctx.bus.on('rate-limit', (sessionId, raw) => {
    const r = raw as { rate_limit_info?: { rateLimitType?: unknown }; rateLimitType?: unknown } | null;
    const kind = String(r?.rate_limit_info?.rateLimitType ?? r?.rateLimitType ?? '');
    db.prepare('INSERT OR REPLACE INTO rate_limits (session, kind, received_at, raw) VALUES (?, ?, ?, ?)')
      .run(sessionId, kind, Date.now(), JSON.stringify(raw ?? null));
    dropCache();
    notify(NOTIFY_MS, 'tokens');
  });

  const { app } = ctx;
  registerManage(ctx, { projects, listProjects, listSessions, refreshLive, dropCache });
  app.get('/api/projects', async () => listProjects());
  app.get<{ Querystring: { project?: string; live?: string } }>('/api/sessions', async (req) => {
    let rows = listSessions();
    if (req.query.project) rows = rows.filter((s) => s.project === req.query.project);
    if (req.query.live === '1') rows = rows.filter((s) => s.status !== 'ended');
    return rows;
  });
  app.get<{ Params: { id: string } }>('/api/sessions/:id/transcript', async (req, reply) => {
    const row = db.prepare('SELECT cwd FROM sessions WHERE id = ?').get(req.params.id) as { cwd: string } | undefined;
    const path = findJournal(req.params.id, row?.cwd || null, paths.claudeDir);
    if (!path) return reply.code(404).send({ error: 'journal not found' });
    return readTranscriptAsync(path);
  });
  app.get<{ Querystring: { from?: string; to?: string } }>('/api/analytics', async (req, reply) => {
    const parsed = parseRange(req.query);
    if (!parsed) return reply.code(400).send({ error: 'bad range' });
    const { from, to } = parsed;
    const range = `${from}/${to}`;
    if (analyticsCache?.range !== range) {
      const names = new Map(projects.rows().map((p) => [p.key, p.name]));
      analyticsCache = { range, value: queryAnalytics(db, from, to, (key) => names.get(key) ?? key, paths.service, paths.root, paths.setup) };
    }
    return analyticsCache.value;
  });
  app.get('/api/index', async () => indexer.status());
  app.get<{ Querystring: { session?: string; project?: string; kind?: string; limit?: string } }>('/api/usage-log', async (req) =>
    queryUsage(db, { session: req.query.session, project: req.query.project, kind: req.query.kind, limit: Number(req.query.limit) || undefined }));
  app.get('/api/usage-log/skills', async () => usageBySkill(db));
  app.get('/api/usage-log/status', async () => ({ backfilling: indexer.isBackfilling() }));
  app.get('/api/overview', async (): Promise<Overview> => {
    const index = indexer.status();
    return {
      claudeVersion: index.claudeVersion,
      ...countOverview(paths.claudeDir, paths.claudeJson),
      apiConnected: false,
      recentNotes: ctx.memory?.recentNotes?.(8) ?? [],
      index,
    };
  });
  app.get('/api/audit', async (): Promise<AuditEntry[]> =>
    db.prepare('SELECT id, at, action, target, diff FROM audit_log ORDER BY id DESC LIMIT 200').all() as unknown as AuditEntry[]);

  function startWatchers() {
    const journals = watch(projectsDir, {
      ignoreInitial: true,
      followSymlinks: false,
      ignored: (p, st) => {
        const name = p.slice(p.lastIndexOf('/') + 1);
        if (SKIP_DIRS.has(name)) return true;
        return st?.isFile() === true && !name.endsWith('.jsonl') && !name.endsWith('.meta.json');
      },
    });
    const onFile = (p: string) => {
      if (p.endsWith('.meta.json')) indexer.refreshMeta(p);
      else if (classifyJournal(projectsDir, p)) indexer.enqueue(p);
    };
    journals.on('add', onFile).on('change', onFile).on('error', (e) => console.error('journal watch', e));
    watchers.push(journals);

    let liveTimer: NodeJS.Timeout | null = null;
    const onRegistry = (p: string) => {
      if (!/\/\d+\.json$/.test(p)) return;
      liveTimer ??= setTimeout(() => {
        liveTimer = null;
        refreshLive();
      }, 200);
    };
    const registry = watch(sessionsDir, { ignoreInitial: true, depth: 0, ignored: (p, st) => st?.isFile() === true && !/\/\d+\.json$/.test(p) });
    registry.on('add', onRegistry).on('change', onRegistry).on('unlink', onRegistry).on('error', (e) => console.error('sessions watch', e));
    watchers.push(registry);
  }

  return {
    indexer,
    refreshLive,
    start() {
      ctx.setBusy('journal', true);
      noteLostSessions();
      refreshLive(); // the first screen shows live sessions before any journal is read
      if (opts.watch !== false) startWatchers();
      if (opts.pollAgents !== false) {
        stopPoll = pollAgents(paths.claudeBin, (a) => {
          agents = a;
          refreshLive();
        });
      }
      const t = setInterval(refreshLive, LIVE_MS);
      t.unref();
      timers.push(t);
      const scan = indexer.sweep().catch((err) => console.error('journal scan', err)).finally(() => {
        ctx.setBusy('journal', false);
        // In the background on purpose: the first screen and the token numbers do not wait for it.
        void indexer.backfillUsage().then(() => {
          dropCache();
          ctx.invalidate('usage', 'sessions');
        }).catch((err) => console.error('usage backfill', err));
      });
      const sweepTimer = setInterval(() => void indexer.sweep().catch((err) => console.error('journal sweep', err)), opts.sweepMs ?? SWEEP_MS);
      sweepTimer.unref();
      timers.push(sweepTimer);
      return scan;
    },
    async stop() {
      stopped = true;
      stopPoll?.();
      timers.forEach(clearInterval);
      if (notifyTimer) clearTimeout(notifyTimer);
      await Promise.all(watchers.map((w) => w.close()));
      await indexer.stop();
    },
  };
}

export function registerJournal(ctx: Ctx): void {
  const journal = createJournal(ctx);
  ctx.app.addHook('onClose', () => journal.stop());
  setImmediate(() => void journal.start());
}
