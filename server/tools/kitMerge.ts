// Project kit updates: what to do with one rendered file given the lock and the disk, and the three-way merge behind it.
// Snapshots of past renders are the merge base; they live per machine, the lock is shared through git.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { KitFileAction, KitLockEntry } from '../../shared/projectKit.ts';
import { sha256 } from '../memory/util.ts';

export interface KitDecision { action: KitFileAction; content: string | null; reason: string | null }

/** `git merge-file -p`: exit 0 is clean, above 0 counts conflicts, below 0 (or no git) is an error and treated as a conflict. */
export function mergeThree(current: string, base: string, next: string): { clean: boolean; content: string } {
  const dir = mkdtempSync(join(tmpdir(), 'kit-merge-'));
  try {
    const files = Object.entries({ current, base, next }).map(([name, text]) => {
      writeFileSync(join(dir, name), text);
      return join(dir, name);
    });
    const args = ['merge-file', '-p', '-L', 'yours', '-L', 'previous kit', '-L', 'new kit', ...files];
    const run = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { clean: run.status === 0, content: run.stdout ?? '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function snapshotPath(data: string, version: string, renderSha: string): string {
  return join(data, 'project-kit', version, renderSha);
}

/** Stores a kit render under its own hash, so the next version can merge against it. */
export function saveSnapshot(data: string, version: string, content: string): string {
  const path = snapshotPath(data, version, sha256(content));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** The render with that hash, or null when this machine never stored it (or the copy no longer matches). */
export function readSnapshot(data: string, version: string, renderSha: string): string | null {
  const path = snapshotPath(data, version, renderSha);
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf8');
  return sha256(content) === renderSha ? content : null;
}

// A kit file whose render changed: replace it only when the disk is exactly the previous render.
function updateKitFile(lock: KitLockEntry, disk: string, render: string, base: string | null): KitDecision {
  if (sha256(disk) === lock.render) return { action: 'update', content: render, reason: null };
  if (base === null) return { action: 'needs-merge', content: null, reason: 'no base snapshot on this machine' };
  const merged = mergeThree(disk, base, render);
  if (merged.clean) return { action: 'merge', content: merged.content, reason: null };
  return { action: 'needs-merge', content: null, reason: 'local edits conflict with the new kit version' };
}

/**
 * The plan entry for one rendered file, or null when there is nothing to do.
 * `base` is the snapshot of the render recorded in the lock, when this machine has it.
 */
export function decideFile(o: { owner: 'kit' | 'seed'; lock: KitLockEntry | null; disk: string | null; render: string; base: string | null }): KitDecision | null {
  if (!o.lock) {
    return o.disk === null ? { action: 'add', content: o.render, reason: null } : { action: 'keep', content: null, reason: 'exists and is not the kit\'s' };
  }
  if (o.disk === null) return { action: 'skip', content: null, reason: 'deleted by the user' };
  // Seeds are written once; a kit file whose render did not change is left alone, edited or not.
  if (o.owner === 'seed' || o.lock.render === sha256(o.render)) return null;
  return updateKitFile(o.lock, o.disk, o.render, o.base);
}
