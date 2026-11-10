// Copying old notes into the vault. Never deletes, never overwrites: the old location keeps working for terminal sessions.
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { VaultCopyPreview, VaultStatus } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import type { Store } from './store.ts';
import { safely, sha256 } from './util.ts';
import { migratedSources } from './wikiRun.ts';

export function copyPreview(ctx: Ctx, store: Store, key: string, root: string, to: string): VaultCopyPreview {
  const sources = store.sourceDirsFor(key, root);
  const preview: VaultCopyPreview = { project: key, name: safely(() => ctx.journal.listProjects(true).find((p) => p.key === key)?.name, undefined) ?? key, to, sources, newFiles: [], existing: 0, conflicts: [] };
  const taken = new Map<string, string>();
  const migrated = migratedSources(ctx.paths, key); // rewritten by the wiki migration: never copied back
  for (const dir of sources) {
    for (const path of store.listMd(dir, false)) {
      const file = basename(path);
      const hash = sha256(readFileSync(path, 'utf8'));
      if (migrated.get(file) === hash) continue;
      const dst = join(to, file);
      const there = taken.get(file) ?? (existsSync(dst) ? sha256(readFileSync(dst, 'utf8')) : null);
      if (there === null) {
        preview.newFiles.push(file);
        taken.set(file, hash);
      } else if (there === hash) preview.existing++;
      else if (!preview.conflicts.includes(file)) preview.conflicts.push(file);
    }
  }
  preview.newFiles.sort();
  return preview;
}

export function copyProject(ctx: Ctx, store: Store, key: string, root: string, to: string): { copied: number; conflicts: string[] } {
  const created: string[] = [];
  const conflicts: string[] = [];
  const sources = store.sourceDirsFor(key, root);
  const migrated = migratedSources(ctx.paths, key);
  const kept = (src: string) => migrated.get(basename(src)) !== sha256(readFileSync(src, 'utf8')); // not a migrated original
  try {
    for (const dir of sources) {
      for (const src of store.listMd(dir, false).filter(kept)) {
        const dst = join(to, basename(src));
        const hash = sha256(readFileSync(src, 'utf8'));
        if (existsSync(dst)) {
          if (sha256(readFileSync(dst, 'utf8')) !== hash) conflicts.push(basename(src));
          continue;
        }
        mkdirSync(to, { recursive: true });
        copyFileSync(src, dst);
        created.push(dst);
        if (sha256(readFileSync(dst, 'utf8')) !== hash) throw new Error(`copy verification failed: ${basename(src)}`);
      }
    }
  } catch (err) {
    for (const p of created) rmSync(p, { force: true }); // only what this run created; sources are untouched
    throw err;
  }
  if (created.length > 0) {
    ctx.audit('memory.copy', to, `copied ${created.length} from ${sources.join(', ')}${conflicts.length ? `\nkept in the vault, differ: ${conflicts.join(', ')}` : ''}`);
    store.touch();
    ctx.invalidate('memory', 'projects');
  }
  return { copied: created.length, conflicts };
}

export function vaultStatus(ctx: Ctx, store: Store): VaultStatus {
  const projects: VaultCopyPreview[] = [];
  for (const [key, root] of store.roots(true)) {
    const p = copyPreview(ctx, store, key, root, store.connectedDir(key) ?? join(ctx.paths.vault, 'projects', key));
    if (p.sources.length > 0) projects.push(p);
  }
  projects.sort((a, b) => b.newFiles.length - a.newFiles.length || a.name.localeCompare(b.name));
  return { path: ctx.paths.vault, exists: existsSync(ctx.paths.vault), projects };
}
