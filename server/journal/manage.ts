// Project and session management: stop a session, remove a project from Claude's memory, connect a folder.
// Removal never deletes: everything goes to data/trash with a manifest, and the project's source folder is out of reach.
import { constants, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { access, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import type { Project, ProjectPatch, ProjectRemovalPreview, ProjectStructureNode, ProjectRemovalResult, RemovalItem, SessionInfo, SessionRemovalPreview, SessionRemovalResult, SessionStopResult } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { encodeDir } from '../memory/store.ts';
import { procStartOf, readRegistry } from './live.ts';
import { findJournal } from './parse.ts';
import { classifyDir, gitRootAsync, within, type Projects } from './projects.ts';
import { hiddenRoot } from './index.ts';

const MAX_DIRS = 40;
const STRUCTURE_DEPTH = 2;
const STRUCTURE_MAX_DIRS = 200;
const STRUCTURE_MAX_FOLDED = 20;
const STRUCTURE_BATCH = 16;

function httpError(statusCode: number, message: string, code?: string) {
  return Object.assign(new Error(message), { statusCode, code });
}

function measure(path: string): { files: number; bytes: number } {
  const st = lstatSync(path);
  if (!st.isDirectory()) return { files: 1, bytes: st.size };
  let files = 0;
  let bytes = 0;
  for (const name of readdirSync(path)) {
    const m = measure(join(path, name));
    files += m.files;
    bytes += m.bytes;
  }
  return { files, bytes };
}

// rename first; a copy when the trash is on another file system.
function move(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true });
  try {
    renameSync(from, to);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    cpSync(from, to, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
    rmSync(from, { recursive: true, force: true });
  }
}

// All or nothing: what already went to the trash comes back.
function moveAllToTrash(items: { kind: string; path: string; files: number; bytes: number }[], trash: string) {
  mkdirSync(trash, { recursive: true });
  const moved: { from: string; to: string; files: number; bytes: number }[] = [];
  try {
    items.forEach((item, i) => {
      const to = join(trash, `${i}-${item.kind}-${basename(item.path)}`);
      move(item.path, to);
      moved.push({ from: item.path, to, files: item.files, bytes: item.bytes });
    });
  } catch (err) {
    for (const m of moved.reverse()) move(m.to, m.from);
    rmSync(trash, { recursive: true, force: true });
    throw err;
  }
  return moved;
}

export interface ManageDeps {
  projects: Projects;
  listProjects(includeEmpty?: boolean): Project[];
  listSessions(): SessionInfo[];
  refreshLive(): void;
  dropCache(): void;
}

export function registerManage(ctx: Ctx, deps: ManageDeps): void {
  const { app, db, paths } = ctx;
  const claudeProjects = join(paths.claudeDir, 'projects');

  // ---------- Stop ----------

  app.post<{ Params: { id: string } }>('/api/sessions/:id/stop', async (req): Promise<SessionStopResult> => {
    deps.refreshLive();
    const id = req.params.id;
    const session = deps.listSessions().find((s) => s.id === id);
    if (!session) throw httpError(404, 'session not found');
    if (session.status === 'ended') throw httpError(409, 'the session has already ended', 'ended');
    if (ctx.chat?.stopSession(id)) {
      ctx.audit('session.stop', id, 'tab');
      return { ok: true, how: 'tab' };
    }
    // The registry can be stale and pids get reused: signal only what is verifiably this session, right now.
    const entry = readRegistry(paths.claudeDir).find((e) => e.sessionId === id && e.procStart && procStartOf(e.pid) === String(e.procStart));
    if (!entry || entry.pid === process.pid) throw httpError(409, 'this session has no process that can be verified, stop it where it runs', 'no_pid');
    process.kill(entry.pid, 'SIGTERM');
    ctx.audit('session.stop', id, `SIGTERM ${entry.pid}`);
    setTimeout(() => deps.refreshLive(), 500).unref();
    return { ok: true, how: 'signal' };
  });

  // ---------- Session removal ----------

  function sessionPreview(id: string): SessionRemovalPreview {
    deps.refreshLive();
    const session = deps.listSessions().find((s) => s.id === id);
    if (!session) throw httpError(404, 'session not found');
    const tabs = ctx.chat?.sessionTabs(id) ?? [];
    // A tab's process may not have reached the registry yet.
    const running = tabs.some((t) => t.kind !== 'readonly' && t.status !== 'idle' && t.status !== 'ended');
    // Named by id and found by findJournal, so never outside the projects dir. The folder holds subagents and tool results.
    const journal = findJournal(id, session.cwd || null, paths.claudeDir);
    const candidates = journal ? [{ kind: 'journal' as const, path: journal }, { kind: 'attachments' as const, path: journal.slice(0, -'.jsonl'.length) }] : [];
    return {
      id,
      live: session.status !== 'ended' || running,
      root: tabs.some((t) => t.kind === 'root'),
      tabs: tabs.filter((t) => t.kind !== 'root').length,
      items: candidates.filter((c) => existsSync(c.path)).map((c) => ({ ...c, ...measure(c.path) })),
      trash: join(paths.data, 'trash'),
    };
  }

  app.get<{ Params: { id: string } }>('/api/sessions/:id/removal', async (req) => sessionPreview(req.params.id));

  app.post<{ Params: { id: string }; Body: { confirm?: unknown } }>('/api/sessions/:id/remove', async (req): Promise<SessionRemovalResult> => {
    const id = req.params.id;
    const plan = sessionPreview(id);
    if (plan.root) throw httpError(403, 'the session of the Home tab cannot be removed', 'root');
    if (plan.live) throw httpError(409, 'the session is still running, stop it first', 'live');
    if (req.body?.confirm !== id) throw httpError(400, 'confirm must be the session id');

    const trash = join(paths.data, 'trash', `session-${id}-${Date.now()}`);
    const moved = moveAllToTrash(plan.items, trash);
    writeFileSync(join(trash, 'manifest.json'), JSON.stringify({ session: id, at: Date.now(), moved }, null, 2));
    ctx.chat?.closeSessionTabs(id);
    // As with a project: usage rows stay, the token totals must not change.
    db.prepare('UPDATE sessions SET removed = 1 WHERE id = ?').run(id);
    const forget = db.prepare('DELETE FROM file_offsets WHERE path = ? OR path LIKE ?');
    for (const m of moved) forget.run(m.from, `${m.from}/%`);
    deps.dropCache();
    ctx.audit('session.remove', id, JSON.stringify({ trash, moved: moved.map((m) => m.from) }));
    ctx.invalidate('sessions', 'projects', 'tabs', 'overview');
    return { ok: true, trash, moved: moved.length };
  });

  // ---------- Removal ----------

  function projectOr404(key: string): Project {
    if (!/^[^/\\]+$/.test(key) || key === '.' || key === '..') throw httpError(400, 'bad project key');
    if (key === deps.projects.forCwd(paths.repo)) throw httpError(403, 'Claude OS itself cannot be removed from memory', 'core');
    const p = deps.listProjects(true).find((x) => x.key === key);
    if (!p) throw httpError(404, 'unknown project');
    return p;
  }

  function cwdsOf(key: string, root: string): Set<string> {
    const rows = [
      ...db.prepare('SELECT cwd FROM cwd_projects WHERE project = ?').all(key),
      ...db.prepare("SELECT DISTINCT cwd FROM sessions WHERE project = ? AND cwd != ''").all(key),
    ] as unknown as { cwd: string }[];
    return new Set([root, ...rows.map((r) => r.cwd)]);
  }

  function preview(key: string): ProjectRemovalPreview {
    deps.refreshLive();
    const p = projectOr404(key);
    const insideSource = (path: string) => within(path, p.root) || within(p.root, path);
    const sessionProject = db.prepare('SELECT project FROM sessions WHERE id = ?');
    const items: RemovalItem[] = [];

    const add = (kind: RemovalItem['kind'], path: string, skipped: RemovalItem['skipped'] = null) => {
      if (!existsSync(path)) return;
      items.push({ kind, path, ...measure(path), skipped: skipped ?? (insideSource(path) ? 'inside_source' : null) });
    };

    const cwds = cwdsOf(key, p.root);
    for (const dir of new Set([...cwds].map(encodeDir))) {
      const full = join(claudeProjects, dir);
      if (!existsSync(full) || !lstatSync(full).isDirectory()) continue;
      // Encoding is lossy (/a/b_c and /a/b-c share a dir): a dir that also holds someone else's sessions stays.
      const foreign = readdirSync(full).some((f) => {
        if (!f.endsWith('.jsonl')) return false;
        const owner = (sessionProject.get(f.slice(0, -'.jsonl'.length)) as { project: string | null } | undefined)?.project;
        return owner != null && owner !== key;
      });
      add('journals', full, foreign ? 'shared_dir' : null);
    }
    add('vault', join(paths.vault, 'projects', key));
    add('state', join(paths.vault, '_state', `${key}.md`));

    let settingsKept: string | null = null;
    const settingsPath = join(p.root, '.claude/settings.local.json');
    try {
      const value = (JSON.parse(readFileSync(settingsPath, 'utf8')) as { autoMemoryDirectory?: unknown }).autoMemoryDirectory;
      if (typeof value === 'string' && within(resolve(value), paths.vault)) settingsKept = settingsPath;
    } catch { /* no settings: nothing stays behind */ }

    return {
      key,
      name: p.name,
      root: p.root,
      liveCount: p.liveCount,
      tabs: ctx.chat?.projectTabs(key) ?? 0,
      items,
      claudeJson: claudeJsonPlan(cwds),
      settingsKept,
      trash: join(paths.data, 'trash'),
    };
  }

  // Claude Code rewrites this file from memory: while any instance runs, an edit here would be overwritten or lost.
  function claudeJsonPlan(cwds: Set<string>): ProjectRemovalPreview['claudeJson'] {
    const path = paths.claudeJson;
    let parsed: { projects?: Record<string, unknown> };
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as typeof parsed;
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === 'ENOENT';
      return { path, keys: [], safe: false, reason: missing ? null : 'unreadable' };
    }
    const keys = Object.keys(parsed.projects ?? {}).filter((k) => cwds.has(k));
    const anyLive = deps.listSessions().some((s) => s.status !== 'ended');
    return { path, keys, safe: !anyLive, reason: anyLive ? 'live_sessions' : null };
  }

  function removeFromClaudeJson(plan: ProjectRemovalPreview['claudeJson'], manifest: Record<string, unknown>): ProjectRemovalResult['claudeJson'] {
    if (plan.keys.length === 0) return 'none';
    if (!plan.safe) return 'skipped';
    const before = statSync(plan.path);
    const parsed = JSON.parse(readFileSync(plan.path, 'utf8')) as { projects: Record<string, unknown> };
    const removed: Record<string, unknown> = {};
    for (const k of plan.keys) {
      removed[k] = parsed.projects[k];
      delete parsed.projects[k];
    }
    const tmp = `${plan.path}.claude-os-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(parsed, null, 2), { mode: before.mode });
    // Somebody wrote the file meanwhile: theirs wins, the entry stays.
    if (statSync(plan.path).mtimeMs !== before.mtimeMs) {
      rmSync(tmp, { force: true });
      return 'skipped';
    }
    renameSync(tmp, plan.path);
    manifest.claudeJsonEntries = removed;
    return 'removed';
  }

  app.get<{ Params: { key: string } }>('/api/projects/:key/removal', async (req) => preview(req.params.key));

  app.post<{ Params: { key: string }; Body: { confirm?: unknown } }>('/api/projects/:key/remove', async (req): Promise<ProjectRemovalResult> => {
    const key = req.params.key;
    const plan = preview(key);
    if (plan.liveCount > 0) throw httpError(409, 'the project has live sessions', 'live');
    if (req.body?.confirm !== plan.name) throw httpError(400, 'confirm must be the project name');

    const trash = join(paths.data, 'trash', `${key}-${Date.now()}`);
    const moved = moveAllToTrash(plan.items.filter((i) => !i.skipped), trash);
    const manifest: Record<string, unknown> = { key, name: plan.name, root: plan.root, at: Date.now(), moved, skipped: plan.items.filter((i) => i.skipped) };
    const claudeJson = removeFromClaudeJson(plan.claudeJson, manifest);
    manifest.claudeJson = claudeJson;
    writeFileSync(join(trash, 'manifest.json'), JSON.stringify(manifest, null, 2));

    ctx.chat?.closeProjectTabs(key);
    // Usage rows stay: token totals must not change. The sessions only leave the lists, until a new one appears here.
    db.prepare('UPDATE projects SET removed_at = ?, pinned = 0, map_pin = NULL WHERE key = ?').run(Date.now(), key);
    db.prepare('UPDATE sessions SET removed = 1 WHERE project = ?').run(key);
    const forget = db.prepare('DELETE FROM file_offsets WHERE path = ? OR path LIKE ?');
    for (const m of moved) forget.run(m.from, `${m.from}/%`);
    deps.dropCache();
    ctx.memory?.touch?.();
    ctx.audit('project.remove', key, JSON.stringify({ trash, moved: moved.map((m) => m.from), claudeJson }));
    ctx.invalidate('projects', 'sessions', 'memory', 'tabs', 'overview');
    return { ok: true, trash, moved: moved.length, claudeJson };
  });

  app.post<{ Params: { key: string }; Body: { on?: unknown } }>('/api/projects/:key/map', async (req): Promise<Project> => {
    const on = req.body?.on;
    if (on !== true && on !== false && on !== null) throw httpError(400, 'on must be true, false or null');
    const project = ctx.journal.setMapPin(req.params.key, on);
    if (!project) throw httpError(404, 'unknown project');
    return project;
  });

  app.patch<{ Params: { key: string }; Body: ProjectPatch }>('/api/projects/:key', async (req): Promise<Project> => {
    let project: Project | null;
    try {
      project = ctx.journal.updateProject(req.params.key, req.body ?? {});
    } catch (err) {
      throw httpError(400, (err as Error).message);
    }
    if (!project) throw httpError(404, 'unknown project');
    ctx.audit('project.update', req.params.key, JSON.stringify(req.body ?? {}));
    return project;
  });

  // ---------- Connect ----------

  const expand = (path: string) => (path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path);

  app.post<{ Body: { path?: unknown } }>('/api/projects/connect', async (req): Promise<Project> => {
    if (typeof req.body?.path !== 'string' || !req.body.path.trim()) throw httpError(400, 'path is required');
    const path = expand(req.body.path.trim());
    if (!isAbsolute(path)) throw httpError(400, 'the path must be absolute');
    const dir = resolve(path);
    let isDir = false;
    try { isDir = statSync(dir).isDirectory(); } catch { /* reported below */ }
    if (!isDir) throw httpError(400, 'no such directory');
    const key = deps.projects.forCwd(dir);
    const row = deps.projects.rows().find((r) => r.key === key);
    if (!key || !row || hiddenRoot(row.root, paths)) throw httpError(400, 'this directory cannot be a project');
    db.prepare('UPDATE projects SET pinned = 1, removed_at = NULL WHERE key = ?').run(key);
    ctx.audit('project.connect', row.root);
    ctx.invalidate('projects');
    return deps.listProjects(true).find((p) => p.key === key)!;
  });

  app.get<{ Querystring: { path?: string } }>('/api/fs/dirs', async (req): Promise<string[]> => {
    const raw = expand((req.query.path ?? '').trim());
    if (!isAbsolute(raw)) return [];
    const [parent, prefix] = raw.endsWith('/') ? [raw, ''] : [dirname(raw), basename(raw)];
    const needle = prefix.toLowerCase();
    try {
      return readdirSync(parent, { withFileTypes: true })
        .filter((e) => {
          if (!e.name.toLowerCase().startsWith(needle) || (e.name.startsWith('.') && !prefix.startsWith('.'))) return false;
          if (e.isDirectory()) return true;
          return e.isSymbolicLink() && statSync(join(parent, e.name), { throwIfNoEntry: false })?.isDirectory() === true;
        })
        .map((e) => join(parent, e.name))
        .sort((a, b) => a.localeCompare(b))
        .slice(0, MAX_DIRS);
    } catch {
      return [];
    }
  });

  // ---------- Structure ----------

  // All of it async and in batches: a root on a slow mount (drvfs, 9p) must not hold up every other request.
  const inBatches = async <T, R>(items: T[], fn: (item: T) => Promise<R>): Promise<R[]> => {
    const out: R[] = [];
    for (let i = 0; i < items.length; i += STRUCTURE_BATCH) out.push(...await Promise.all(items.slice(i, i + STRUCTURE_BATCH).map(fn)));
    return out;
  };
  // Symlinks are not followed: a link to a parent would loop, and a link elsewhere is not a folder of this tree.
  const subdirs = async (path: string): Promise<string[]> => {
    try {
      return (await readdir(path, { withFileTypes: true }))
        .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules')
        .map((e) => join(path, e.name))
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return [];
    }
  };
  const isDirAsync = async (path: string) => (await stat(path).catch(() => null))?.isDirectory() === true;

  app.get<{ Querystring: { root?: string } }>('/api/projects/structure', async (req): Promise<ProjectStructureNode> => {
    const asked = req.query.root?.trim();
    const own = ctx.settings?.profile()?.projectsDir;
    // The profile's folder may be gone since it was chosen: home is still a useful place to look.
    const raw = asked ? expand(asked) : own && await isDirAsync(own) ? own : homedir();
    if (!isAbsolute(raw)) throw httpError(400, 'the root must be absolute');
    const root = resolve(raw);
    try {
      if (!(await stat(root)).isDirectory()) throw httpError(400, 'not a directory');
      await access(root, constants.R_OK | constants.X_OK);
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode) throw err;
      const code = (err as NodeJS.ErrnoException).code;
      throw httpError(400, code === 'ENOENT' || code === 'ENOTDIR' ? 'no such directory' : `the directory cannot be read (${code ?? 'error'})`);
    }

    // Level by level, in name order: the cap cuts the same folders on every call.
    type Item = { path: string; parent: Item | null; gitTop: string | null; node?: ProjectStructureNode };
    const levels: Item[][] = [[{ path: root, parent: null, gitTop: null }]];
    let count = 1;
    let truncated = false;
    for (let depth = 1; depth <= STRUCTURE_DEPTH; depth++) {
      const parents = levels[depth - 1];
      const listings = await inBatches(parents, (it) => subdirs(it.path));
      const level: Item[] = [];
      parents.forEach((parent, i) => {
        const found = listings[i].slice(0, Math.max(0, STRUCTURE_MAX_DIRS - count));
        if (found.length < listings[i].length) truncated = true;
        count += found.length;
        level.push(...found.map((path) => ({ path, parent, gitTop: null })));
      });
      levels.push(level);
    }
    // Only a folder with its own .git can start another repo: the rest of a repo answers as its parent did.
    for (const level of levels) {
      await inBatches(level, async (it) => {
        const ownGit = !it.parent || await access(join(it.path, '.git')).then(() => true, () => false);
        it.gitTop = ownGit ? await gitRootAsync(it.path) : it.parent!.gitTop;
      });
    }

    const rows = deps.projects.rows();
    const listed = new Set(deps.listProjects().map((p) => p.key));
    const folded = db.prepare('SELECT cwd FROM cwd_projects WHERE project = ? AND cwd != ? ORDER BY cwd LIMIT ?');
    const inService = (path: string) => [paths.service, paths.setup].some((d) => Boolean(d) && within(path, d));
    for (const level of levels) {
      for (const it of level) {
        const node: ProjectStructureNode = {
          path: it.path,
          name: basename(it.path) || it.path,
          ...classifyDir(it.path, { gitTop: it.gitTop, forcedRoot: deps.projects.forcedRoot(it.path), hidden: hiddenRoot(it.path, paths) || inService(it.path) }, rows, listed),
        };
        if ((node.kind === 'project' || node.kind === 'misc') && node.project) {
          const cwds = (folded.all(node.project, it.path, STRUCTURE_MAX_FOLDED) as unknown as { cwd: string }[]).map((r) => r.cwd);
          if (cwds.length > 0) node.folded = cwds;
        }
        it.node = node;
        if (it.parent) (it.parent.node!.children ??= []).push(node);
      }
    }
    const top = levels[0][0].node!;
    if (truncated) top.truncated = true;
    return top;
  });
}
