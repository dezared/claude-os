// The commit tree: one row per file, as in an IDE. A checkbox is the file's state in the index, so a terminal agrees with it.
import type { GitFile } from '../../../../shared/contract.ts';

export type RowState = 'on' | 'off' | 'partial';
export type DiffArea = 'staged' | 'unstaged' | 'untracked' | 'head';
export interface FileRow { path: string; oldPath: string | null; status: string; state: RowState; area: DiffArea; }

export function changeRows(s: { staged: GitFile[]; unstaged: GitFile[]; untracked: GitFile[]; commits: unknown[] }): { changes: FileRow[]; untracked: FileRow[] } {
  const byPath = new Map<string, FileRow>();
  for (const f of s.staged) byPath.set(f.path, { path: f.path, oldPath: f.oldPath, status: f.status, state: 'on', area: 'staged' });
  for (const f of s.unstaged) {
    const had = byPath.get(f.path);
    if (had) byPath.set(f.path, { ...had, state: 'partial', area: s.commits.length > 0 ? 'head' : 'unstaged' });
    else byPath.set(f.path, { path: f.path, oldPath: f.oldPath, status: f.status, state: 'off', area: 'unstaged' });
  }
  return {
    changes: [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path)),
    untracked: s.untracked.map((f) => ({ path: f.path, oldPath: null, status: '?', state: 'off', area: 'untracked' })),
  };
}

export function groupState(rows: FileRow[]): RowState {
  if (rows.every((r) => r.state === 'on')) return 'on';
  return rows.every((r) => r.state === 'off') ? 'off' : 'partial';
}

// A staged rename leaves the index only together with its old path.
export function unstagePaths(rows: FileRow[]): string[] {
  return rows.flatMap((r) => (r.oldPath ? [r.path, r.oldPath] : [r.path]));
}
