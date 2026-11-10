// Project kit apply: writes an approved plan in a fixed order, each file backed up and audited, then runs the gate once.
// The gate is the only point where project code runs.
import { mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, sep } from 'node:path';
import type { KitLock } from '../../shared/projectKit.ts';
import type { Ctx } from '../context.ts';
import { backupFile, safely, sha256, unifiedDiff } from '../memory/util.ts';
import { saveSnapshot } from './kitMerge.ts';
import { LOCK, noSettings, readLock, readText, symlinkIn, type PlanResult } from './kitPlan.ts';
import { treeHash } from './osPluginManifest.ts';

export type StoredPlan = PlanResult & { tabId: string | null };
export interface ApplyDeps { data: string; audit: Ctx['audit']; gate: (root: string) => Promise<string> }

/** The stale-plan check: any target, the lock or the kit templates changed since the plan was made. */
export function staleReason(hashes: Record<string, string | null>, root: string): string | null {
  for (const [path, hash] of Object.entries(hashes)) {
    const text = isAbsolute(path) ? null : readText(root, path);
    const now = isAbsolute(path) ? treeHash(path) : text === null ? null : sha256(text);
    if (now !== hash) return `stale plan: ${path} changed; call kit_plan again`;
  }
  return null;
}

// Docs, then rules, skills and agents, then kit scripts, kit.json, the lock, .gitignore, and settings last:
// the hooks that protect the kit's files start working only once those files are in place.
function rank(path: string): number {
  if (/^\.claude\/settings(\.local)?\.json$/.test(path)) return 6;
  if (path === '.gitignore') return 5;
  if (path === LOCK) return 4;
  if (path === '.claude/kit/kit.json') return 3;
  if (path.startsWith('.claude/kit/')) return 2;
  return path.startsWith('.claude/') ? 1 : 0;
}

// Remove runs the other way round, settings first, and drops the lock last.
function writeOrder(paths: string[], remove: boolean): string[] {
  const order = [...paths].sort((a, b) => rank(a) - rank(b));
  if (!remove) return order;
  return [...order.filter((p) => p !== LOCK).reverse(), ...order.filter((p) => p === LOCK)];
}

// A removed kit leaves no empty folders behind; the project root itself stays.
function pruneDirs(root: string, dir: string): void {
  for (let d = dir; d.startsWith(`${root}${sep}`) && safely(() => readdirSync(d).length === 0, false); d = dirname(d)) rmdirSync(d);
}

function writeOne(root: string, path: string, content: string | null, deps: ApplyDeps): void {
  // A symlink can appear after the plan without changing any hash; the write must not follow it.
  const link = symlinkIn(root, path);
  if (link) throw new Error(`${path}: ${link} is a symlink; call kit_plan again`);
  const abs = join(root, path);
  const before = readText(root, path);
  backupFile(deps.data, abs);
  if (content === null) {
    rmSync(abs, { force: true });
    pruneDirs(root, dirname(abs));
  } else {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  deps.audit('project.kit.apply', abs, unifiedDiff(before ?? '', content ?? '', path));
}

function entriesAfter(old: KitLock | null, next: KitLock | null, written: Set<string>): KitLock['files'] {
  const files: KitLock['files'] = {};
  const paths = new Set([...Object.keys(old?.files ?? {}), ...Object.keys(next?.files ?? {})]);
  for (const path of paths) {
    const entry = (written.has(path) ? next : old)?.files[path];
    if (entry) files[path] = entry;
  }
  return files;
}

/** The lock for a partial apply: written files take their new entries, the rest keep the old ones. */
function partialLock(root: string, planned: string | null, written: Set<string>): string | null {
  const old = readLock(root);
  const next = planned === null ? null : (JSON.parse(planned) as KitLock);
  const base = old ?? next;
  if (!base) return null;
  const settings = (written.has(base.settings.file) ? next : old)?.settings ?? noSettings(base.settings.file);
  return `${JSON.stringify({ ...base, files: entriesAfter(old, next, written), settings }, null, 2)}\n`;
}

/** Writes an approved, fresh plan; on an error the lock still records what was written, then the error goes on. */
export async function applyKit(stored: StoredPlan, deps: ApplyDeps): Promise<{ written: string[]; gate: string }> {
  const { plan, writes } = stored;
  for (const content of stored.renders.values()) saveSnapshot(deps.data, plan.kit, content);
  const written: string[] = [];
  try {
    for (const path of writeOrder([...writes.keys()], plan.action === 'remove')) {
      writeOne(plan.root, path, writes.get(path) ?? null, deps);
      written.push(path);
    }
  } catch (err) {
    if (writes.has(LOCK) && !written.includes(LOCK)) {
      safely(() => writeOne(plan.root, LOCK, partialLock(plan.root, writes.get(LOCK) ?? null, new Set(written)), deps), undefined);
    }
    throw err;
  }
  return { written, gate: plan.action === 'remove' ? '' : await deps.gate(plan.root) };
}
