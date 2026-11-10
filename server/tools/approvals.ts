import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Ctx } from '../context.ts';
import { sha256 } from '../memory/util.ts';
import { readJson } from './shared.ts';

// data/ is out of reach for Claude OS sessions: editing a config alone can never approve a command.
export function createApprovals(ctx: Ctx) {
  const file = join(ctx.paths.data, 'approved-commands.json');
  const read = () => readJson<string[]>(file) ?? [];
  return {
    isApproved: (command: string) => read().includes(sha256(command)),
    approve(command: string, target: string) {
      const hash = sha256(command);
      const all = read();
      if (all.includes(hash)) return;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify([...all, hash], null, 2) + '\n', { mode: 0o600 });
      ctx.audit('command.approve', target, `+ ${command}\nsha256 ${hash}`);
    },
  };
}

export type Approvals = ReturnType<typeof createApprovals>;
