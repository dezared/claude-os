// What a tool call means for the usage log. No hooks: everything here comes from the journals.
import { join, relative, resolve, sep } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { UsageEntry, UsageTotals } from '../../shared/contract.ts';
import type { ToolCallFact } from './parse.ts';

export interface UsageRoots { vault: string; claudeDir: string; }
export interface UsageFact { target: string; kind: UsageEntry['kind']; op: UsageEntry['op']; }

const READS = new Set(['Read', 'Grep', 'Glob']);
const WRITES = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const within = (path: string, dir: string) => path === dir || path.startsWith(dir + sep);

// Only <claudeDir>/projects/<dir>/memory counts as memory: a source folder named `memory` is just code.
export function classifyUsage(call: Pick<ToolCallFact, 'name' | 'skill' | 'path'>, roots: UsageRoots): UsageFact | null {
  if (call.skill) return { target: call.skill, kind: 'skill', op: 'use' };
  const op = READS.has(call.name) ? 'read' : WRITES.has(call.name) ? 'write' : null;
  if (!op || !call.path || !call.path.startsWith('/')) return null;
  const path = resolve(call.path);
  if (within(path, resolve(roots.vault))) return { target: path, kind: 'vault', op };
  const parts = path.slice(resolve(join(roots.claudeDir, 'projects')).length + 1).split(sep);
  if (within(path, resolve(join(roots.claudeDir, 'projects'))) && parts[1] === 'memory') return { target: path, kind: 'external', op };
  return null;
}

export interface OsRoots { repo: string; config: string; }

const CORE_DIRS = new Set(['server', 'web', 'shared', 'e2e']);

// A change to Claude OS itself, as far as a tool call names a file: config/ is the user's level, the code is the root level.
// Bash writes name no file, and a worktree of the repository is another path: neither is counted.
export function osChangeLevel(call: Pick<ToolCallFact, 'name' | 'path'>, roots: OsRoots): 'user' | 'root' | null {
  if (!WRITES.has(call.name) || !call.path?.startsWith('/')) return null;
  const path = resolve(call.path);
  if (within(path, resolve(roots.config))) return 'user';
  if (!within(path, resolve(roots.repo))) return null;
  return CORE_DIRS.has(relative(resolve(roots.repo), path).split(sep)[0]) ? 'root' : null;
}

export const INSERT_USAGE = 'INSERT OR IGNORE INTO usage_log (tool_id, session, tool, target, kind, op, ts) VALUES (?, ?, ?, ?, ?, ?, ?)';

export interface UsageFilter { session?: string; project?: string; kind?: string; limit?: number; }

export function queryUsage(db: DatabaseSync, f: UsageFilter): UsageEntry[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.session) { where.push('u.session = ?'); args.push(f.session); }
  if (f.project) { where.push('s.project = ?'); args.push(f.project); }
  if (f.kind) { where.push('u.kind = ?'); args.push(f.kind); }
  const limit = Math.min(Math.max(Number(f.limit) || 200, 1), 1000);
  return db.prepare(`
    SELECT u.rowid id, u.session, s.project, u.tool, u.target, u.kind, u.op, u.ts at
    FROM usage_log u LEFT JOIN sessions s ON s.id = u.session
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY u.ts DESC LIMIT ?
  `).all(...args, limit) as unknown as UsageEntry[];
}

export function usageForPath(db: DatabaseSync, path: string): UsageTotals {
  const r = db.prepare(`
    SELECT COALESCE(SUM(op = 'read'), 0) reads, COALESCE(SUM(op = 'write'), 0) writes, MAX(ts) last FROM usage_log WHERE target = ?
  `).get(path) as unknown as UsageTotals;
  return r;
}

export function usageBySkill(db: DatabaseSync): (UsageTotals & { name: string })[] {
  return db.prepare(`
    SELECT target name, COUNT(*) reads, 0 writes, MAX(ts) last FROM usage_log WHERE kind = 'skill' GROUP BY target ORDER BY reads DESC
  `).all() as unknown as (UsageTotals & { name: string })[];
}
