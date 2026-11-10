// The server runs its TypeScript directly and serves dist/web from disk, so a page can be newer than the process behind it.
// The newest source file tells a process that its code has been replaced.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

export function newestCode(dirs: string[]): number {
  let newest = 0;
  for (const dir of dirs) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'fixtures') newest = Math.max(newest, newestCode([path]));
      } else if (e.name.endsWith('.ts') && !e.name.endsWith('.test.ts')) {
        newest = Math.max(newest, statSync(path).mtimeMs);
      }
    }
  }
  return newest;
}
