import { existsSync, openSync, readFileSync, readSync, closeSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { MemoryGraph, MemoryMigrationPlan, MemoryNode, MemoryNote } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { noteMeta, type NoteMeta } from './frontmatter.ts';
import { buildLintIndex, indexNotesOf, lintCtxIn, savedText, searchDocsOf, type LintIndex } from './noteIndex.ts';
import { backupFile, httpError, parseFrontmatter, safely, sha256, toWslUnc, unifiedDiff } from './util.ts';
import { extractLinks, normalizeName, resolveLinkIn } from './wikilinks.ts';
import { isMigratedFile, migratedLookup } from './wikiRun.ts';

interface NoteFile {
  id: string;
  path: string;
  file: string;
  title: string;
  summary: string | null;
  content: string;
  sha: string; // of content
  meta: NoteMeta;
  mtime: number;
  links: string[];
  vaultKey: string | null; // vault projects/<key>
  isGlobal: boolean; // vault global/
  dir: string | null; // unconnected source: <claudeDir>/projects/<dir>/memory
}

interface ViewNote extends NoteFile {
  project: string | null;
  connected: boolean;
}

interface View {
  notes: ViewNote[];
  byId: Map<string, ViewNote>;
  byName: Map<string, ViewNote[]>; // normalizeName(file) -> notes
  lint: LintIndex;
  edges: [string, string][];
  backlinks: Map<string, string[]>;
  degree: Map<string, number>;
  unresolved: number;
  drift: Map<string, number>;
}

const SCAN_TTL_MS = 15_000; // watcher misses (inotify limits) heal by themselves
const VIEW_TTL_MS = 2_000;
const ROOTS_TTL_MS = 5_000;
const JSONL_PEEK_BYTES = 256 * 1024;
const SETTINGS_FILE = '.claude/settings.local.json';

// How Claude Code names <claudeDir>/projects/<dir>. Not reversible, see decodeDirOnDisk.
export function encodeDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-');
}

const SUMMARY_CHARS = 220;

// Frontmatter description, otherwise the first line of body that says something: headings, rules, fences and tables do not.
export function noteSummary(description: string | undefined, body: string): string | null {
  const clip = (s: string) => {
    const line = s.replace(/\s+/g, ' ').trim();
    return line.length > SUMMARY_CHARS ? `${line.slice(0, SUMMARY_CHARS - 1).trimEnd()}…` : line;
  };
  if (description?.trim()) return clip(description);
  let fenced = false;
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) fenced = !fenced;
    if (fenced || !line || /^(#|---|\*\*\*|___|```|~~~|\||<!--)/.test(line)) continue;
    const text = line.replace(/^(?:[-*+]|\d+\.|>)\s+/, '').replace(/\*\*|__|`/g, '').replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, a: string, b?: string) => b ?? a).trim();
    if (/[\p{L}\p{N}]/u.test(text)) return clip(text);
  }
  return null;
}

export function createStore(ctx: Ctx) {
  const { paths } = ctx;
  const claudeProjects = join(paths.claudeDir, 'projects');
  let scan: NoteFile[] | null = null;
  let scannedAt = 0;
  let view: View | null = null;
  let viewAt = 0;
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

  function readNoteFile(path: string, extra: Pick<NoteFile, 'vaultKey' | 'isGlobal' | 'dir'>): NoteFile | null {
    return safely(() => {
      const content = readFileSync(path, 'utf8');
      const file = basename(path);
      const { data, body } = parseFrontmatter(content);
      const heading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
      return {
        id: sha256(path).slice(0, 16),
        path,
        file,
        title: data.name || heading || file.replace(/\.md$/i, ''),
        summary: noteSummary(data.description, body),
        content,
        sha: sha256(content),
        meta: noteMeta(content),
        mtime: statSync(path).mtimeMs,
        links: extractLinks(content),
        ...extra,
      };
    }, null);
  }

  function listMd(dir: string, recursive: boolean): string[] {
    const out: string[] = [];
    for (const e of safely(() => readdirSync(dir, { withFileTypes: true }), [])) {
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory() && recursive) out.push(...listMd(full, true));
      else if (e.name.toLowerCase().endsWith('.md') && !e.isDirectory()) out.push(full);
    }
    return out;
  }

  function subdirs(dir: string): string[] {
    return safely(() => readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name), []);
  }

  function scanFiles(): NoteFile[] {
    const out: (NoteFile | null)[] = [];
    for (const key of subdirs(join(paths.vault, 'projects'))) {
      if (key.startsWith('.')) continue;
      for (const p of listMd(join(paths.vault, 'projects', key), false)) out.push(readNoteFile(p, { vaultKey: key, isGlobal: false, dir: null }));
    }
    for (const p of listMd(join(paths.vault, 'global'), true)) out.push(readNoteFile(p, { vaultKey: null, isGlobal: true, dir: null }));
    for (const dir of subdirs(claudeProjects)) {
      for (const p of listMd(join(claudeProjects, dir, 'memory'), false)) out.push(readNoteFile(p, { vaultKey: null, isGlobal: false, dir }));
    }
    return out.filter((n) => n !== null);
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

  function getView(): View {
    if (view && Date.now() - viewAt < VIEW_TTL_MS) return view;
    if (!scan || Date.now() - scannedAt > SCAN_TTL_MS) {
      scan = scanFiles();
      scannedAt = Date.now();
    }
    roots();
    const drift = new Map<string, number>();
    const notes: ViewNote[] = [];
    const migrated = migratedLookup(paths);
    // A migrated original stays out: its rewrite lives in the vault now.
    for (const n of scan.filter((s) => !s.dir || migrated(keyForDir(s.dir)).get(s.file) !== s.sha)) {
      if (!n.dir) {
        notes.push({ ...n, project: n.vaultKey, connected: true });
        continue;
      }
      const project = keyForDir(n.dir);
      // Claude OS sessions write to the vault without touching the project's settings, so a vault dir counts too.
      const ownDir = project ? join(paths.vault, 'projects', project) : null;
      const vaultDir = project ? connectedDir(project) ?? (ownDir && existsSync(ownDir) ? ownDir : null) : null;
      if (project && vaultDir) {
        // Already copied notes live in the vault. What is missing there is drift: still shown, read only.
        if (existsSync(join(vaultDir, n.file))) continue;
        drift.set(project, (drift.get(project) ?? 0) + 1);
      }
      notes.push({ ...n, project, connected: false });
    }
    const links = buildLinks(notes, drift);
    const next = { ...links, lint: buildLintIndex(paths.vault, notes, links.byName) };
    view = next;
    viewAt = Date.now();
    return next;
  }

  const lintCtx = (path: string) => lintCtxIn(paths.vault, getView().lint, path);
  const searchDocs = () => searchDocsOf(getView().notes);
  const indexNotes = (key: string) => indexNotesOf(getView().notes, key);

  const resolveLinkPath = (fromPath: string, name: string) => resolvePathIn(getView(), fromPath, name);

  function touch() {
    scan = null;
    view = null;
  }

  function toNode(n: ViewNote, v: View, live: Set<string>): MemoryNode {
    return {
      id: n.id,
      title: n.title,
      file: n.file,
      project: n.project,
      connected: n.connected,
      degree: v.degree.get(n.id) ?? 0,
      live: n.project !== null && live.has(n.project),
      mtime: n.mtime,
      summary: n.summary,
      issues: v.lint.issues.get(n.id) ?? [],
    };
  }

  function liveProjects(): Set<string> {
    const live = new Set<string>();
    for (const s of safely(() => ctx.journal.listSessions(), [])) if (s.project && s.status !== 'ended') live.add(s.project);
    return live;
  }

  function graph(): MemoryGraph {
    const v = getView();
    const live = liveProjects();
    const coreProject = safely(() => ctx.journal.projectForCwd(paths.repo), null);
    const rootProject = safely(() => ctx.journal.projectForCwd(paths.root), null);
    return {
      // The root session's folder and this repository are one thing on the map: the core.
      nodes: v.notes.map((n) => toNode(n.project === rootProject && coreProject ? { ...n, project: coreProject } : n, v, live)),
      edges: v.edges,
      unresolved: v.unresolved,
      vaultPath: paths.vault,
      vaultExists: existsSync(paths.vault),
      coreProject,
      rootProject,
    };
  }

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
    touch();
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

  return { graph, note, save, searchDocs, indexNotes, lintCtx, resolveLinkPath, stats, recentNotes, noteHead, touch, roots, connectedDir, migrationPlan, sourceDirsFor, listMd };
}

// The vault path a [[name]] in the note at fromPath opens, as the graph resolves it.
function resolvePathIn(v: Pick<View, 'notes' | 'byName'>, fromPath: string, name: string): string | null {
  const from = v.notes.find((n) => n.path === fromPath);
  return from ? resolveLinkIn(v.byName, from, normalizeName(name))?.path ?? null : null;
}

function buildLinks(notes: ViewNote[], drift: Map<string, number>): Omit<View, 'lint'> {
  const byName = new Map<string, ViewNote[]>();
  const byId = new Map<string, ViewNote>();
  for (const n of notes) {
    byId.set(n.id, n);
    const name = normalizeName(n.file);
    const list = byName.get(name);
    if (list) list.push(n);
    else byName.set(name, [n]);
  }
  const edges: [string, string][] = [];
  const seen = new Set<string>();
  const degree = new Map<string, number>();
  const backlinks = new Map<string, string[]>();
  let unresolved = 0;
  for (const n of notes) {
    for (const name of n.links) {
      const target = resolveLinkIn(byName, n, name);
      if (!target) {
        unresolved++;
        continue;
      }
      if (target.id === n.id) continue;
      const back = backlinks.get(target.id);
      if (back) back.push(n.id);
      else backlinks.set(target.id, [n.id]);
      const pair = n.id < target.id ? `${n.id}|${target.id}` : `${target.id}|${n.id}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      edges.push([n.id, target.id]);
      degree.set(n.id, (degree.get(n.id) ?? 0) + 1);
      degree.set(target.id, (degree.get(target.id) ?? 0) + 1);
    }
  }
  return { notes, byId, byName, edges, backlinks, degree, unresolved, drift };
}

export type Store = ReturnType<typeof createStore>;
