// Which projects stand on the map, and which of them live inside another. Pure code, no browser needed.
import type { Project } from '../../lib/types';

export const DEFAULT_MAP_LIMIT = 100;
export const MAX_MAP_LIMIT = 200;

type MapProject = Pick<Project, 'key' | 'liveCount' | 'lastActivity' | 'pinned' | 'mapPin'> & Partial<Pick<Project, 'folder'>>;

/**
 * Hand-picked projects always stay and count toward the limit; the rest of it goes by last activity, live sessions first.
 * A project taken off by hand stays off, whatever happens in it. A folder is not a star. The core is not one of the projects.
 */
export function mapKeys(projects: MapProject[], noted: Iterable<string | null>, coreKey: string | null, limit: number): Set<string> {
  const notes = new Set(noted);
  const known = new Set(projects.map((p) => p.key));
  const rows: MapProject[] = [
    ...projects,
    // Notes in a folder the journal has no project for still have a place, if there is room.
    ...[...notes].filter((k): k is string => k !== null && !known.has(k)).map((key) => ({ key, liveCount: 0, lastActivity: null, pinned: false, mapPin: null })),
  ].filter((p: MapProject) => p.key !== coreKey && !p.folder);
  const forced = rows.filter((p) => p.mapPin === true);
  const auto = rows
    .filter((p) => p.mapPin == null && (notes.has(p.key) || p.liveCount > 0 || p.pinned))
    .sort((a, b) => Number(b.liveCount > 0) - Number(a.liveCount > 0) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0) || a.key.localeCompare(b.key));
  const keys = new Set([...forced, ...auto.slice(0, Math.max(0, limit - forced.length))].map((p) => p.key));
  if (coreKey) keys.add(coreKey);
  return keys;
}

export { projectParents } from '../../../../shared/projectTree.ts';
