// The Projects screen's list as a tree: projects under the projects that hold them, and the folders on disk they share. Pure code.
import type { Project } from './contract.ts';
import { projectTree } from './projectTree.ts';

type ListProject = Pick<Project, 'key' | 'root' | 'misc'> & Partial<Pick<Project, 'parent' | 'folder'>>;

/** A project, or a folder on disk that two or more of them share. A folder's id is `dir:<path>`. */
export interface ProjectListNode { id: string; name: string; path: string; project: string | null; children: ProjectListNode[] }

interface Dir { dirs: Map<string, Dir>; items: ProjectListNode[]; leaves: number }

const newDir = (): Dir => ({ dirs: new Map(), items: [], leaves: 0 });
const clean = (root: string) => root.replaceAll('\\', '/').replace(/\/+$/, '');

function place(top: Dir, segments: string[], node: ProjectListNode) {
  let at = top;
  at.leaves++;
  for (const s of segments) {
    const next = at.dirs.get(s) ?? newDir();
    at.dirs.set(s, next);
    at = next;
    at.leaves++;
  }
  at.items.push(node);
}

/** A folder with one project in it adds nothing; a folder holding only one folder joins its name, as VS Code does. Folders first, then projects in the given order. */
function emit(d: Dir, path: string, order: Map<string, number>): ProjectListNode[] {
  const folders: ProjectListNode[] = [];
  const lifted: ProjectListNode[] = [];
  for (const [name, sub] of [...d.dirs].sort(([a], [b]) => a.localeCompare(b))) {
    let full = `${path}/${name}`;
    if (sub.leaves < 2) {
      lifted.push(...emit(sub, full, order));
      continue;
    }
    let label = path ? name : full;
    let at = sub;
    while (at.items.length === 0 && at.dirs.size === 1) {
      const [[next, inner]] = at.dirs;
      label += `/${next}`;
      full += `/${next}`;
      at = inner;
    }
    folders.push({ id: `dir:${full}`, name: label, path: full, project: null, children: emit(at, full, order) });
  }
  return [...folders, ...[...d.items, ...lifted].sort((a, b) => order.get(a.id)! - order.get(b.id)!)];
}

/** The folder every top-level project shares says nothing: the list starts below it. */
function belowShared(top: Dir): [Dir, string] {
  let path = '';
  while (top.items.length === 0 && top.dirs.size === 1) {
    const [[name, inner]] = top.dirs;
    path += `/${name}`;
    top = inner;
  }
  return [top, path];
}

/** The roots of the tree. A misc parent holds its projects here too: only the map keeps those apart. */
export function projectListTree(projects: ListProject[]): ProjectListNode[] {
  const parents = projectTree(projects.map((p) => ({ ...p, misc: false })));
  const roots = new Map(projects.map((p) => [p.key, clean(p.root)]));
  const nodes = new Map(projects.map((p) => [p.key, { id: p.key, name: p.key, path: roots.get(p.key)!, project: p.key, children: [] } as ProjectListNode]));
  const order = new Map(projects.map((p, i) => [p.key, i]));
  const groups = new Map<string | null, Dir>();
  for (const p of projects) {
    const parent = parents.get(p.key) ?? null;
    const base = parent ? roots.get(parent)! : '';
    const own = roots.get(p.key)!;
    const segments = own.startsWith(`${base}/`) ? own.slice(base.length + 1).split('/').slice(0, -1) : [];
    if (!groups.has(parent)) groups.set(parent, newDir());
    place(groups.get(parent)!, segments, nodes.get(p.key)!);
  }
  for (const [parent, group] of groups) if (parent) nodes.get(parent)!.children = emit(group, roots.get(parent)!, order);
  const [top, path] = belowShared(groups.get(null) ?? newDir());
  return emit(top, path, order);
}
