import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import type { Ctx, MemoryApi } from '../context.ts';
import { migrate } from './migrate.ts';
import { registerSearch } from './noteIndex.ts';
import { createGuard } from './guard.ts';
import { gitInfo, renderState } from './state.ts';
import { createStore } from './store.ts';
import { httpError, safely } from './util.ts';
import { copyPreview, copyProject, vaultStatus } from './vault.ts';
import { registerWikiMigration } from './wikiMigration.ts';
import { createWikiSync } from './wikiSync.ts';
import { usageForPath } from '../journal/usage.ts';

// Extras for sibling modules and tests, beyond the shared MemoryApi.
export interface MemoryApiExt extends MemoryApi {
  noteHead(id: string, lines?: number): string | null;
  refreshStates(): Promise<void>;
}

const STATE_THROTTLE_MS = 30_000;
const STATE_STALE_MS = 60_000;
const MAX_STATE_CHARS = 1000;

export function registerMemory(ctx: Ctx): void {
  const store = createStore(ctx);
  const search = registerSearch(ctx, store);
  const sync = createWikiSync(ctx, store);
  const syncPaths = (paths: string[]) => {
    try {
      sync.changed(paths);
    } catch (err) {
      ctx.app.log.error(err);
    }
  };
  const { watchVault, close } = watchMemory(ctx, (paths) => {
    store.touch();
    syncPaths(paths);
    ctx.invalidate('memory', 'projects');
  });
  const stateDir = join(ctx.paths.vault, '_state');
  const statePath = (key: string) => join(stateDir, `${key}.md`);

  // Only connected projects: a project without a vault dir must not create the vault implicitly.
  async function refreshStates(): Promise<void> {
    const sessions = safely(() => ctx.journal.listSessions(), []);
    for (const [key, root] of store.roots(true)) {
      if (!store.connectedDir(key)) continue;
      const text = renderState(key, sessions.filter((s) => s.project === key), await gitInfo(root));
      if (safely(() => readFileSync(statePath(key), 'utf8'), null) === text) continue;
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(statePath(key), text);
    }
  }

  let stateTimer: NodeJS.Timeout | null = null;
  function scheduleStates() {
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      refreshStates().catch((err) => ctx.app.log.error(err));
    }, STATE_THROTTLE_MS);
    stateTimer.unref();
  }
  ctx.bus.on('sessions-changed', scheduleStates);

  const api: MemoryApiExt = {
    projectStats: (key) => store.stats(key),
    vaultDirFor: (key) => store.connectedDir(key),
    prepareSessionDir(key) {
      const dir = store.connectedDir(key) ?? join(ctx.paths.vault, 'projects', key);
      const root = store.roots().get(key) ?? store.roots(true).get(key);
      const copied = root ? copyProject(ctx, store, key, root, dir).copied : 0;
      mkdirSync(dir, { recursive: true });
      watchVault();
      return { dir, copied };
    },
    stateNote(key) {
      if (!store.connectedDir(key)) return null;
      const mtime = safely(() => statSync(statePath(key)).mtimeMs, 0);
      if (Date.now() - mtime > STATE_STALE_MS) scheduleStates();
      return safely(() => readFileSync(statePath(key), 'utf8').slice(0, MAX_STATE_CHARS), null);
    },
    search,
    recentNotes: (limit) => store.recentNotes(limit),
    touch: () => store.touch(),
    noteHead: (id, lines) => store.noteHead(id, lines),
    guardTool: createGuard(ctx, store, registerWikiMigration(ctx, store, sync)).check,
    refreshStates,
  };
  ctx.memory = api;

  const { app } = ctx;
  app.get('/api/memory/graph', async () => store.graph());
  app.get<{ Params: { id: string } }>('/api/memory/notes/:id', async (req) => store.note(req.params.id));
  app.put<{ Params: { id: string }; Body: { markdown?: unknown; version?: unknown } }>('/api/memory/notes/:id', async (req, reply) => {
    try {
      const saved = store.save(req.params.id, req.body?.markdown, req.body?.version);
      if (saved.version !== req.body?.version) syncPaths([saved.path]); // MEMORY.md and the log are current in the response
      return saved;
    } catch (err) {
      const e = err as Error & { statusCode?: number; version?: string };
      if (e.statusCode === 409) return reply.code(409).send({ error: e.message, version: e.version });
      throw err;
    }
  });
  app.get<{ Params: { project: string } }>('/api/memory/migrate/:project', async (req) => {
    const { settingsBefore: _b, settingsAfter: _a, ...plan } = store.migrationPlan(req.params.project);
    return plan;
  });
  app.post<{ Params: { project: string } }>('/api/memory/migrate/:project', async (req) => {
    const result = migrate(ctx, store, req.params.project);
    watchVault();
    await refreshStates().catch((err) => app.log.error(err));
    return result;
  });

  app.get<{ Params: { id: string } }>('/api/memory/notes/:id/usage', async (req) => usageForPath(ctx.db, store.note(req.params.id).path));
  app.get('/api/memory/vault', async () => vaultStatus(ctx, store));
  // Copies only: project settings stay, terminal sessions keep writing to the old place.
  app.post('/api/memory/vault/copy', async () => {
    let copied = 0;
    let conflicts = 0;
    for (const p of vaultStatus(ctx, store).projects) {
      const root = store.roots().get(p.project);
      if (!root) continue;
      const r = copyProject(ctx, store, p.project, root, p.to);
      copied += r.copied;
      conflicts += r.conflicts.length;
    }
    watchVault();
    ctx.invalidate('memory', 'projects');
    return { ok: true, copied, conflicts };
  });
  app.get<{ Params: { project: string } }>('/api/memory/vault/:project', async (req) => {
    const root = store.roots(true).get(req.params.project);
    if (!root) throw httpError(404, 'unknown project');
    return copyPreview(ctx, store, req.params.project, root, store.connectedDir(req.params.project) ?? join(ctx.paths.vault, 'projects', req.params.project));
  });

  watchVault();

  app.addHook('onClose', async () => {
    if (stateTimer) clearTimeout(stateTimer);
    await close();
  });
}

// Changed paths over a 300 ms debounce: the vault without its generated and private dirs, and the old-place memory dirs.
function watchMemory(ctx: Ctx, onChange: (paths: string[]) => void): { watchVault(): void; close(): Promise<void> } {
  const watchers: FSWatcher[] = [];
  const pending = new Set<string>();
  let timer: NodeJS.Timeout | null = null;
  const changed = (_event: string, path: string) => {
    pending.add(path);
    timer ??= setTimeout(() => {
      timer = null;
      const paths = [...pending];
      pending.clear();
      onChange(paths);
    }, 300);
    timer.unref();
  };

  let vaultWatched = false;
  function watchVault() {
    if (vaultWatched || !existsSync(ctx.paths.vault)) return;
    vaultWatched = true;
    const vault = ctx.paths.vault;
    const ownTop = ['kanban', '_index', '_log']; // the board watches its own folder; the index and the log are generated
    watchers.push(watch(vault, {
      ignoreInitial: true,
      ignored: (p) => relative(vault, p).split(sep).some((part, i) => part === '_state' || part.startsWith('.') || (i === 0 && ownTop.includes(part))),
    }).on('all', changed));
  }

  // Only <dir>/memory: the journals next to it change all the time and belong to the journal module.
  const base = join(ctx.paths.claudeDir, 'projects');
  if (existsSync(base)) {
    watchers.push(watch(base, {
      ignoreInitial: true,
      depth: 2,
      ignored: (p) => {
        const parts = relative(base, p).split(sep);
        return parts.length >= 2 && parts[1] !== 'memory';
      },
    }).on('all', changed));
  }

  return {
    watchVault,
    async close() {
      if (timer) clearTimeout(timer);
      await Promise.all(watchers.map((w) => w.close()));
    },
  };
}
