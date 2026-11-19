import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { MemoryMigrationPlan, MemoryNote } from '../../shared/contract.ts';
import type { MemoryCount, MemoryHealth, MemoryMap, MemoryOverview } from '../../shared/memory.ts';
import { countSteps, healthSteps, overviewSteps, sampleSteps, type CatalogNote } from './catalog.ts';
import type { Ctx } from '../context.ts';
import { createScanner, listMd, subdirs } from './scanner.ts';
import { indexNotesSteps, lintCtxIn, savedText, searchDocsOf, newLintCache } from './noteIndex.ts';
import { backupFile, httpError, parseFrontmatter, safely, sha256, toWslUnc, unifiedDiff } from './util.ts';
import { derived, keepView } from './storeView.ts';
import { resolvePathIn, toNode, viewNoteCache, type View, type ViewNote } from './view.ts';
import { isMigratedFile } from './wikiRun.ts';

const ROOTS_TTL_MS = 5_000;
const JSONL_PEEK_BYTES = 256 * 1024;
const SETTINGS_FILE = '.claude/settings.local.json';

// How Claude Code names <claudeDir>/projects/<dir>. Not reversible, see decodeDirOnDisk.
export function encodeDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

export { noteSummary } from './summary.ts';

// Array.filter, an item per step.
function* keepIn<T>(items: T[], keep: (t: T) => boolean): Generator<void, T[]> {
  const out: T[] = [];
  for (const t of items) {
    if (keep(t)) out.push(t);
    yield;
  }
  return out;
}

const catalogNote = (n: ViewNote, v: View): CatalogNote => ({
  id: n.id, name: n.meta.name || n.file.replace(/\.md$/i, ''), project: n.project, connected: n.connected, type: n.meta.type,
  tags: n.meta.tags, summary: n.summary, mtime: n.meta.modified ?? n.mtime, issues: v.lint.issues.get(n.id) ?? [],
  degree: v.degree.get(n.id) ?? 0, description: n.meta.description,
});

export function createStore(ctx: Ctx) {
  const { paths } = ctx;
  const claudeProjects = join(paths.claudeDir, 'projects');
  const scanner = createScanner({ vault: paths.vault, claudeProjects }, join(paths.data, 'memory-snapshot.ndjson'));
  const lintCache = newLintCache();
  const cwdByDir = new Map<string, string>();
  const keyByDir = new Map<string, string>();

  // The journal may call projectStats from inside listProjects: the guard stops the cycle, the TTL keeps it cheap.
  let rootsCache = new Map<string, string>();
  let rootsAt = 0;
  let inRoots = false;
  function roots(force = false): Map<string, string> {
    if (inRoots || (!force && Date.now() - rootsAt < ROOTS_TTL_MS)) return rootsCache;
    inRoots = true;
    try {
      rootsCache = new Map(ctx.journal.listProjects(true).map((p) => [p.key, p.root]));
      rootsAt = Date.now();
    } catch {
      // the journal is still starting: keep what we have
    } finally {
      inRoots = false;
    }
    return rootsCache;
  }

  function cwdsInJournals(dir: string): string[] {
    const full = join(claudeProjects, dir);
    const files = safely(() => readdirSync(full).filter((f) => f.endsWith('.jsonl')), [])
      .map((f) => ({ f, m: safely(() => statSync(join(full, f)).mtimeMs, 0) }))
      .sort((a, b) => b.m - a.m)
      .slice(0, 5);
    const cwds = new Set<string>();
    for (const { f } of files) {
      const text = safely(() => {
        const fd = openSync(join(full, f), 'r');
        try {
          const buf = Buffer.alloc(JSONL_PEEK_BYTES);
          return buf.toString('utf8', 0, readSync(fd, buf, 0, JSONL_PEEK_BYTES, 0));
        } finally {
          closeSync(fd);
        }
      }, '');
      for (const m of text.matchAll(/"cwd":("(?:[^"\\]|\\.)*")/g)) cwds.add(safely(() => String(JSON.parse(m[1])), ''));
    }
    return [...cwds];
  }

  // Walks the real file system: only an existing path can match, so `_` and `/` ambiguity resolves itself.
  function decodeDirOnDisk(rest: string, base = '/'): string | null {
    if (rest === '') return base;
    for (const name of subdirs(base).sort((a, b) => b.length - a.length)) {
      const enc = '-' + encodeDir(name);
      if (rest === enc || rest.startsWith(enc + '-')) {
        const found = decodeDirOnDisk(rest.slice(enc.length), join(base, name));
        if (found) return found;
      }
    }
    return null;
  }

  function cwdForDir(dir: string): string | null {
    const cached = cwdByDir.get(dir);
    if (cached) return cached;
    const sessions = safely(() => ctx.journal.listSessions(), []);
    const cwd = sessions.find((s) => encodeDir(s.cwd) === dir)?.cwd
      ?? cwdsInJournals(dir).find((c) => encodeDir(c) === dir)
      ?? decodeDirOnDisk(dir);
    if (cwd) cwdByDir.set(dir, cwd);
    return cwd;
  }

  function keyForDir(dir: string): string | null {
    const cached = keyByDir.get(dir);
    if (cached) return cached;
    const cwd = cwdForDir(dir);
    const key = cwd ? safely(() => ctx.journal.projectForCwd(cwd), null) : null;
    if (key) keyByDir.set(dir, key);
    return key;
  }

  function readSettings(root: string): Record<string, unknown> | null {
    return safely(() => JSON.parse(readFileSync(join(root, SETTINGS_FILE), 'utf8')) as Record<string, unknown>, null);
  }

  // The vault dir the project's autoMemoryDirectory points at, or null.
  function connectedDir(key: string): string | null {
    const root = roots().get(key);
    if (!root) return null;
    const value = readSettings(root)?.autoMemoryDirectory;
    if (typeof value !== 'string') return null;
    const dir = resolve(value);
    return dir.startsWith(resolve(paths.vault) + '/') ? dir : null;
  }

  const viewNote = viewNoteCache();
  ctx.app.addHook('onClose', async () => scanner.close());
  // The map of a large vault is sampled in slices too, before anyone is told the view is ready.
  const kept = keepView(ctx, scanner, () => {
    roots();
    return { paths, keyForDir, connectedDir, viewNote, lintCache };
  }, () => map.prime());
  const { getView, viewBuild, notesBuild, ready } = kept;
  const derivedAt = { build: viewBuild, size: () => getView().notes.length };

  const lintCtx = (path: string) => lintCtxIn(paths.vault, getView().lint, path);
  const searchDocs = () => searchDocsOf(getView().notes);
  const indexNotesLater = (key: string) => indexNotesSteps(getView().notes, key);

  const resolveLinkPath = (fromPath: string, name: string) => resolvePathIn(getView(), fromPath, name);

  // Paths: only these changed (the watcher knows) and update the view; none: something did (a migration), find out
  // with a stat pass and build the view from scratch.
  function touch(changed?: string[]) {
    scanner.mark(changed);
    if (!changed) kept.rebuild();
  }


  function liveProjects(): Set<string> {
    const live = new Set<string>();
    for (const s of safely(() => ctx.journal.listSessions(), [])) if (s.project && s.status !== 'ended') live.add(s.project);
    return live;
  }

  // The root session's folder and this repository are one thing on the map and in the panel: the core.
  function folder(): (n: ViewNote) => ViewNote {
    const coreProject = safely(() => ctx.journal.projectForCwd(paths.repo), null);
    const rootProject = safely(() => ctx.journal.projectForCwd(paths.root), null);
    return (n) => (n.project === rootProject && coreProject ? { ...n, project: coreProject } : n);
  }

  // A representative subset at any vault size, chosen once per view; the counts are the whole vault.
  const map = derived(ctx, derivedAt, function* mapSteps(): Generator<void, { build: number; nodes: ViewNote[]; edges: [string, string][]; total: number; counts: MemoryCount[] }> {
    const build = viewBuild();
    const v = getView();
    const notes = v.notes.map(folder());
    yield;
    const shown = yield* sampleSteps(notes, v.edges, v.degree);
    const all = shown.size === notes.length;
    const nodes = all ? notes : yield* keepIn(notes, (n) => shown.has(n.id));
    const edges = all ? v.edges : yield* keepIn(v.edges, ([a, b]) => shown.has(a) && shown.has(b));
    return { build, nodes, edges, total: notes.length, counts: yield* countSteps(notes) };
  });

  function graph(): MemoryMap {
    const v = getView();
    const live = liveProjects();
    const { nodes, edges, total, counts } = map.get();
    return {
      nodes: nodes.map((n) => toNode(n, v, live)),
      edges,
      unresolved: v.unresolved,
      vaultPath: paths.vault,
      vaultExists: existsSync(paths.vault),
      coreProject: safely(() => ctx.journal.projectForCwd(paths.repo), null),
      rootProject: safely(() => ctx.journal.projectForCwd(paths.root), null),
      total,
      counts,
    };
  }

  // Every note but the generated MEMORY.md, for the Storage panel, with its figures; rebuilt with the view.
  const catalogOf = derived(ctx, derivedAt, function* catalogSteps(): Generator<void, { build: number; notes: CatalogNote[]; health: Map<string, MemoryHealth[]>; overview: MemoryOverview }> {
    const build = viewBuild();
    const v = getView();
    const fold = folder();
    const notes: CatalogNote[] = [];
    for (const n of v.notes) {
      if (n.file === 'MEMORY.md') continue;
      notes.push(catalogNote(fold(n), v));
      yield;
    }
    const health = yield* healthSteps(notes);
    return { build, notes, health, overview: yield* overviewSteps(notes, health) };
  });
  const catalog = () => catalogOf.get();

  function note(id: string): MemoryNote {
    const v = getView();
    const n = v.byId.get(id);
    if (!n) throw httpError(404, 'note not found');
    const markdown = safely(() => readFileSync(n.path, 'utf8'), null);
    if (markdown === null) {
      touch();
      throw httpError(404, 'note not found');
    }
    return {
      node: toNode(n, v, liveProjects()),
      path: n.path,
      markdown,
      version: sha256(markdown),
      obsidianUrl: n.connected ? `obsidian://open?path=${encodeURIComponent(toWslUnc(n.path))}` : null,
      backlinks: v.backlinks.get(id) ?? [],
    };
  }

  // Returns the current version on conflict so that the editor can offer a reload.
  function save(id: string, markdown: unknown, version: unknown): MemoryNote {
    if (typeof markdown !== 'string' || typeof version !== 'string') throw httpError(400, 'markdown and version are required');
    const current = note(id);
    if (!current.node.connected) throw httpError(403, 'read only: the note is outside the vault');
    if (current.version !== version) throw Object.assign(httpError(409, 'conflict: the note changed on disk'), { version: current.version });
    const text = savedText(paths, current.node.file, markdown, lintCtx(current.path)); // the remaining issues come back on the node
    if (text === current.markdown) return current;
    backupFile(paths.data, current.path);
    writeFileSync(current.path, text);
    ctx.audit('memory.save', current.path, unifiedDiff(current.markdown, text, current.node.file));
    touch([current.path]);
    ctx.invalidate('memory');
    return note(id);
  }

  function stats(key: string) {
    const v = getView();
    return {
      count: v.notes.filter((n) => n.project === key).length,
      connected: connectedDir(key) !== null,
      drift: v.drift.get(key) ?? 0,
    };
  }

  function recentNotes(limit: number) {
    return [...getView().notes].sort((a, b) => b.mtime - a.mtime).slice(0, limit)
      .map((n) => ({ id: n.id, title: n.title, mtime: n.mtime }));
  }

  function noteHead(id: string, lines = 5): string | null {
    const n = getView().byId.get(id);
    if (!n) return null;
    const body = parseFrontmatter(safely(() => readFileSync(n.path, 'utf8'), n.content)).body;
    return body.split('\n').filter((l) => l.trim()).slice(0, lines).join('\n').slice(0, 500);
  }

  // Where this project's memory lives today in the old location.
  function sourceDirFor(key: string, root: string): string {
    const own = encodeDir(root);
    if (existsSync(join(claudeProjects, own, 'memory'))) return join(claudeProjects, own, 'memory');
    const mapped = subdirs(claudeProjects).find((d) => existsSync(join(claudeProjects, d, 'memory')) && keyForDir(d) === key);
    return join(claudeProjects, mapped ?? own, 'memory');
  }

  // Every old location of this project: its root, plus any dir whose sessions belong to it (worktrees, subfolders).
  function sourceDirsFor(key: string, root: string): string[] {
    const own = join(claudeProjects, encodeDir(root), 'memory');
    const others = subdirs(claudeProjects).map((d) => join(claudeProjects, d, 'memory'))
      .filter((m) => m !== own && existsSync(m) && keyForDir(basename(dirname(m))) === key);
    return [...(existsSync(own) ? [own] : []), ...others];
  }

  function migrationPlan(key: string): MemoryMigrationPlan & { settingsBefore: string; settingsAfter: string } {
    if (!/^[^/\\]+$/.test(key) || key === '.' || key === '..') throw httpError(400, 'bad project key');
    const root = roots(true).get(key);
    if (!root) throw httpError(404, 'unknown project');
    const from = sourceDirFor(key, root);
    const to = join(paths.vault, 'projects', key);
    const settingsPath = join(root, SETTINGS_FILE);
    const settingsBefore = safely(() => readFileSync(settingsPath, 'utf8'), '');
    let parsed: unknown = {};
    if (settingsBefore.trim()) {
      try {
        parsed = JSON.parse(settingsBefore);
      } catch {
        throw httpError(409, `${settingsPath} is not valid JSON: fix it by hand first`);
      }
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw httpError(409, `${settingsPath} is not a JSON object`);
    const settingsAfter = JSON.stringify({ ...parsed, autoMemoryDirectory: to }, null, 2) + '\n';
    return {
      project: key,
      from,
      to,
      files: listMd(from, false).filter((p) => !isMigratedFile(paths, key, p)).map((p) => basename(p)).sort(),
      settingsPath,
      settingsDiff: unifiedDiff(settingsBefore, settingsAfter, SETTINGS_FILE),
      settingsBefore,
      settingsAfter,
    };
  }

  return { graph, catalog, note, save, searchDocs, searchChanges: kept.searchChanges, viewBuild, notesBuild, indexNotesLater, lintCtx, resolveLinkPath, stats, recentNotes, noteHead, touch, roots, connectedDir, migrationPlan, sourceDirsFor, listMd, complete: kept.complete, ready, noteFiles: () => scanner.current().notes };
}

export type Store = ReturnType<typeof createStore>;
