// The structure of projects: a choice by hand first, then the folders on disk. Pure code, server and web share it.
import type { Project } from './contract.ts';

type TreeProject = Pick<Project, 'key' | 'root' | 'misc'> & Partial<Pick<Project, 'parent' | 'folder'>>;

const prefixOf = (root: string) => `${root.replaceAll('\\', '/').replace(/\/+$/, '')}/`;

function rawParents(projects: TreeProject[]): Map<string, string> {
  const known = new Set(projects.map((p) => p.key));
  const shelves = projects.filter((p) => !p.misc).map((p) => ({ key: p.key, prefix: prefixOf(p.root) })).sort((a, b) => b.prefix.length - a.prefix.length);
  const out = new Map<string, string>();
  for (const p of projects) {
    if (p.parent === '') continue;
    if (p.parent && p.parent !== p.key && known.has(p.parent)) {
      out.set(p.key, p.parent);
      continue;
    }
    const path = prefixOf(p.root);
    const shelf = shelves.find((x) => x.key !== p.key && path.startsWith(x.prefix));
    if (shelf) out.set(p.key, shelf.key);
  }
  return out;
}

/** Whether `parent` already lives inside `key`: such a choice would make a circle. */
export function wouldLoop(projects: TreeProject[], key: string, parent: string): boolean {
  const parents = rawParents(projects.filter((p) => p.key !== key).concat(projects.filter((p) => p.key === key).map((p) => ({ ...p, parent: '' }))));
  const seen = new Set<string>();
  for (let at: string | undefined = parent; at && !seen.has(at); at = parents.get(at)) {
    if (at === key) return true;
    seen.add(at);
  }
  return false;
}

/** child key -> key of its parent, folders included: the list of projects. A circle left over from older data is cut where it closes. */
export function projectTree(projects: TreeProject[]): Map<string, string> {
  const parents = rawParents(projects);
  for (const key of parents.keys()) {
    const seen = new Set([key]);
    for (let at = parents.get(key); at; at = parents.get(at)) {
      if (seen.has(at)) {
        parents.delete(key);
        break;
      }
      seen.add(at);
    }
  }
  return parents;
}

/** child key -> nearest parent that is a real project: the map. A folder has no star, its projects go to whoever holds it. */
export function projectParents(projects: TreeProject[]): Map<string, string> {
  const tree = projectTree(projects);
  const folders = new Set(projects.filter((p) => p.folder).map((p) => p.key));
  const out = new Map<string, string>();
  for (const p of projects) {
    let at = tree.get(p.key);
    while (at && folders.has(at)) at = tree.get(at);
    if (at) out.set(p.key, at);
  }
  return out;
}
