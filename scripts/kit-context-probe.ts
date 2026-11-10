// Measures what the project kit adds to the starting context: a temp copy of a kit fixture, one tiny haiku query
// before and one after the kit is applied through the engine (stub gate). Needs no running server; costs two calls.
// Usage: node --disable-warning=ExperimentalWarning scripts/kit-context-probe.ts [fixture] [--keep]
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { applyKit } from '../server/tools/kitApply.ts';
import { copyFixture } from '../server/tools/kitFixtures.ts';
import { planKit } from '../server/tools/kitPlan.ts';

const PLUGIN = join(import.meta.dirname, '..', 'plugins', 'project-kit');

export function contextDelta(before: number, after: number): number {
  return after - before;
}

// Project and local settings only: the user's own setup is the same on both sides, so it would only add noise.
// One turn is one model call, so its usage is the starting context; the SDK throws when that turn tried a tool.
async function measure(cwd: string): Promise<number> {
  let tokens = 0;
  const q = query({
    prompt: 'Reply with the single word ok. Do not use any tools.',
    options: { cwd, model: 'haiku', maxTurns: 1, persistSession: false, settingSources: ['project', 'local'], settings: { autoMemoryEnabled: false } },
  });
  try {
    for await (const msg of q) {
      if (msg.type === 'result') {
        const u = msg.usage as { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
        tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
      }
    }
  } catch (err) {
    if (!tokens) throw err;
  }
  return tokens;
}

async function install(root: string, data: string): Promise<string[]> {
  const { version } = JSON.parse(readFileSync(join(PLUGIN, 'plugin.json'), 'utf8')) as { version: string };
  const kit = { dir: join(PLUGIN, 'kit'), version };
  const plan = planKit({ root, project: 'probe', kit, data, action: 'install', answers: {}, level: 'minimal' });
  const { written } = await applyKit({ ...plan, tabId: null }, { data, audit: () => {}, gate: async () => 'gate: skipped by the probe' });
  return written;
}

async function main() {
  const args = process.argv.slice(2);
  const fixture = args.find((a) => !a.startsWith('--')) ?? 'ts-npm-vitest';
  const root = copyFixture(fixture);
  const data = mkdtempSync(join(tmpdir(), 'kit-probe-data-'));
  try {
    const before = await measure(root);
    const written = await install(root, data);
    const after = await measure(root);
    console.log(`fixture\t${fixture}\nwritten\t${written.length}\nbefore\t${before}\nafter\t${after}\ndelta\t${contextDelta(before, after)}`);
    if (args.includes('--keep')) console.log(`kept\t${root}`);
  } finally {
    rmSync(data, { recursive: true, force: true });
    if (!args.includes('--keep')) rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
