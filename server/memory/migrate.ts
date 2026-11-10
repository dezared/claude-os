import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Ctx } from '../context.ts';
import type { Store } from './store.ts';
import { backupFile, httpError, sha256 } from './util.ts';

export interface MigrationResult {
  ok: true;
  copied: number;
  skipped: string[]; // already in the vault with other content: the vault copy wins and stays
}

// Copy, verify, and only then touch the project settings. Source files stay where they are.
export function migrate(ctx: Ctx, store: Store, key: string): MigrationResult {
  const plan = store.migrationPlan(key);
  mkdirSync(plan.to, { recursive: true });
  mkdirSync(join(ctx.paths.vault, 'global'), { recursive: true });
  mkdirSync(join(ctx.paths.vault, '_state'), { recursive: true });

  const created: string[] = [];
  const skipped: string[] = [];
  try {
    for (const file of plan.files) {
      const src = join(plan.from, file);
      const dst = join(plan.to, file);
      const expected = sha256(readFileSync(src, 'utf8'));
      if (existsSync(dst)) {
        if (sha256(readFileSync(dst, 'utf8')) !== expected) skipped.push(file);
        continue;
      }
      copyFileSync(src, dst);
      created.push(dst);
      if (sha256(readFileSync(dst, 'utf8')) !== expected) throw new Error(`copy verification failed: ${file}`);
    }
  } catch (err) {
    for (const p of created) rmSync(p, { force: true });
    throw httpError(500, `migration aborted, settings untouched: ${(err as Error).message}`);
  }

  if (plan.settingsDiff) {
    backupFile(ctx.paths.data, plan.settingsPath);
    mkdirSync(dirname(plan.settingsPath), { recursive: true });
    writeFileSync(plan.settingsPath, plan.settingsAfter);
    if (readFileSync(plan.settingsPath, 'utf8') !== plan.settingsAfter) throw httpError(500, 'settings verification failed');
  }
  ctx.audit('memory.migrate', plan.settingsPath, [`copied ${created.length} of ${plan.files.length} from ${plan.from} to ${plan.to}`, plan.settingsDiff].filter(Boolean).join('\n'));
  store.touch();
  ctx.invalidate('memory', 'projects');
  return { ok: true, copied: created.length, skipped };
}
