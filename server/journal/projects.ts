import { execFile, execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import type { DatabaseSync } from 'node:sqlite';
import type { Project, ProjectPatch, ProjectStructureNode } from '../../shared/contract.ts';
import { wouldLoop } from '../../shared/projectTree.ts';

// config/projects.json: { "/abs/path": { "root"?: "/abs/other", "name"?: "Title", "misc"?: true } }
// The longest path prefix of a cwd wins. `root` folds that path into another project.
export interface ProjectOverride { root?: string; name?: string; misc?: boolean; }
export type Overrides = Record<string, ProjectOverride>;

export function loadOverrides(configDir: string): Overrides {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(configDir, 'projects.json'), 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Overrides) : {};
  } catch {
    return {};
  }
}

export function within(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`);
}

export function gitRoot(cwd: string): string | null {
  const git = (...args: string[]) => execFileSync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', ...args], {
    encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  try {
    const common = git('--git-common-dir');
    if (common.endsWith('/.git')) return dirname(common); // worktrees of one repo share this
    return common.includes('/.git/modules/') ? git('--show-toplevel') : common; // submodule, bare repo
  } catch {
    return null;
  }
}

const execFileAsync = promisify(execFile);

/** gitRoot without blocking the server: the structure view asks about many folders at once. */
export async function gitRootAsync(cwd: string): Promise<string | null> {
  const git = async (...args: string[]) => (await execFileAsync('git', ['-C', cwd, 'rev-parse', '--path-format=absolute', ...args], { encoding: 'utf8', timeout: 3000 })).stdout.trim();
  try {
    const common = await git('--git-common-dir');
    if (common.endsWith('/.git')) return dirname(common);
    return common.includes('/.git/modules/') ? await git('--show-toplevel') : common;
  } catch {
    return null;
  }
}

export interface ProjectRow { key: string; name: string; root: string; has_git: number; pinned: number; removed_at: number | null; map_pin: number | null; description: string | null; color: string | null; parent: string | null; folder: number; }

const MAX_PROJECT_NAME = 80;
const MAX_PROJECT_DESCRIPTION = 4000;

/** What is wrong with a change to a project, in words for whoever sent it. Null when it can go in. */
export function projectPatchProblem(all: Project[], key: string, patch: ProjectPatch): string | null {
  const { name, description, color, parent, folder } = patch;
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > MAX_PROJECT_NAME)) return `name: a non-empty string up to ${MAX_PROJECT_NAME} characters`;
  if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > MAX_PROJECT_DESCRIPTION)) return `description: a string up to ${MAX_PROJECT_DESCRIPTION} characters or null`;
  if (color !== undefined && color !== null && !(typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color))) return 'color: #rrggbb or null';
  if (folder !== undefined && typeof folder !== 'boolean') return 'folder: true or false';
  if (parent !== undefined && parent !== null && parent !== '') {
    if (typeof parent !== 'string' || !all.some((p) => p.key === parent)) return `parent: no project ${String(parent)}`;
    if (parent === key || wouldLoop(all, key, parent)) return `parent: ${parent} already lives inside ${key}`;
  }
  return null;
}

export interface Projects {
  forCwd(cwd: string): string | null;
  rows(): (ProjectRow & { misc: boolean })[];
  forcedRoot(path: string): string | null; // the root config/projects.json folds this path into
}

export interface DirFacts {
  gitTop: string | null; // what gitRoot answers for the folder
  forcedRoot: string | null;
  hidden: boolean; // never a project: the root session's folder, service folders, temp
}

/** What a folder on disk is to Claude OS, by the same rules forCwd and the project list follow. */
export function classifyDir(dir: string, facts: DirFacts, rows: (ProjectRow & { misc: boolean })[], listed: Set<string>): Pick<ProjectStructureNode, 'kind' | 'project' | 'reason'> {
  if (facts.hidden) return { kind: 'hidden' };
  const own = rows.find((r) => r.root === dir);
  if (own) {
    const reason = facts.forcedRoot === dir ? 'override' : facts.gitTop === dir ? 'git' : own.pinned === 1 ? 'connected' : undefined;
    const kind = !listed.has(own.key) ? 'seen' : own.misc ? 'misc' : 'project';
    return reason ? { kind, project: own.key, reason } : { kind, project: own.key };
  }
  const owner = facts.forcedRoot && facts.forcedRoot !== dir ? facts.forcedRoot : facts.gitTop && facts.gitTop !== dir ? facts.gitTop : null;
  const reason = owner === null ? (facts.gitTop === dir ? 'git' : undefined) : owner === facts.forcedRoot ? 'override' : 'git';
  const into = owner === null ? undefined : rows.find((r) => r.root === owner);
  if (into) return { kind: 'inside', project: into.key, reason };
  return reason ? { kind: 'none', reason } : { kind: 'none' };
}

export function createProjects(db: DatabaseSync, overrides: Overrides, lookup = gitRoot, home = homedir()): Projects {
  const cache = new Map<string, string>();
  const getCwd = db.prepare('SELECT project FROM cwd_projects WHERE cwd = ?');
  const putCwd = db.prepare('INSERT OR REPLACE INTO cwd_projects (cwd, project) VALUES (?, ?)');
  const byRoot = db.prepare('SELECT key FROM projects WHERE root = ?');
  const keyTaken = db.prepare('SELECT 1 FROM projects WHERE key = ?');
  const insert = db.prepare('INSERT INTO projects (key, name, root, has_git, created_at) VALUES (?, ?, ?, ?, ?)');
  const all = db.prepare('SELECT key, name, root, has_git, pinned, removed_at, map_pin, description, color, parent, folder FROM projects');

  function overrideFor(path: string): ProjectOverride | null {
    let best: string | null = null;
    for (const p of Object.keys(overrides)) if (within(path, p) && (!best || p.length > best.length)) best = p;
    return best ? overrides[best] : null;
  }

  function resolveRoot(cwd: string): { root: string; hasGit: boolean } {
    const forced = overrideFor(cwd)?.root;
    if (forced) return { root: resolve(forced), hasGit: false };
    // Journals outlive worktrees: for a directory that is gone, ask git about the nearest one that still exists.
    let dir = cwd;
    while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir);
    const repo = lookup(dir);
    if (repo) return { root: repo, hasGit: true };
    if (dir === cwd) return { root: cwd, hasGit: false };
    let best: ProjectRow | null = null;
    for (const r of all.all() as unknown as ProjectRow[]) {
      if (within(cwd, r.root) && (!best || r.root.length > best.root.length)) best = r;
    }
    return best ? { root: best.root, hasGit: best.has_git === 1 } : { root: cwd, hasGit: false };
  }

  function newKey(root: string): string {
    const base = basename(root).replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^\.+/, '') || 'project';
    let key = base;
    for (let i = 2; keyTaken.get(key); i++) key = `${base}-${i}`;
    return key;
  }

  return {
    forCwd(cwd) {
      if (!cwd) return null;
      const hit = cache.get(cwd);
      if (hit) return hit;
      const stored = getCwd.get(cwd) as { project: string } | undefined;
      if (stored) {
        cache.set(cwd, stored.project);
        return stored.project;
      }
      const { root, hasGit } = resolveRoot(cwd);
      let key = (byRoot.get(root) as { key: string } | undefined)?.key;
      if (!key) {
        key = newKey(root);
        insert.run(key, basename(root) || root, root, hasGit ? 1 : 0, Date.now());
      }
      putCwd.run(cwd, key);
      cache.set(cwd, key);
      return key;
    },
    forcedRoot(path) {
      const forced = overrideFor(path)?.root;
      return forced ? resolve(forced) : null;
    },
    rows() {
      const rows = all.all() as unknown as ProjectRow[];
      return rows.map((r) => {
        const o = overrideFor(r.root);
        const parentOfOthers = r.has_git === 0 && (r.root === home || r.root === '/' || rows.some((x) => x.has_git === 1 && within(x.root, r.root)));
        return { ...r, name: o?.name ?? r.name, misc: o?.misc ?? parentOfOthers };
      });
    },
  };
}
