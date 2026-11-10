// Measures the prompt-token cost of each project's MEMORY.md: one tiny SDK query per project.
// Usage: node --disable-warning=ExperimentalWarning scripts/memory-token-probe.ts <label> [--project <key>]
//        node --disable-warning=ExperimentalWarning scripts/memory-token-probe.ts --compare <a> <b>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { query } from '@anthropic-ai/claude-agent-sdk';

export interface ProbeEntry {
  tokens: number;
  lines: number;
  bytes: number;
}
export interface Probe {
  label: string;
  projects: Record<string, ProbeEntry>;
}

export function memorySize(text: string): { lines: number; bytes: number } {
  return { lines: text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0), bytes: Buffer.byteLength(text) };
}

export function compareProbes(a: Probe, b: Probe): string {
  const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
  const rows = [['project', a.label, b.label, 'delta', 'lines', 'bytes', ''].join('\t')];
  for (const key of [...new Set([...Object.keys(a.projects), ...Object.keys(b.projects)])].sort()) {
    const x = a.projects[key];
    const y = b.projects[key];
    if (!x || !y) {
      rows.push([key, x?.tokens ?? '-', y?.tokens ?? '-', '-', '-', '-', ''].join('\t'));
      continue;
    }
    const delta = y.tokens - x.tokens;
    rows.push(
      [key, x.tokens, y.tokens, signed(delta), signed(y.lines - x.lines), signed(y.bytes - x.bytes), delta > 0 ? 'GREW' : ''].join('\t'),
    );
  }
  return rows.join('\n');
}

const base = () => `http://127.0.0.1:${process.env.CLAUDE_OS_PORT ?? 47821}`;
const probePath = (label: string) => join('data', 'wiki-migration', `probe-${label}.json`);

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(base() + path);
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return (await res.json()) as T;
}

async function measure(root: string, vaultDir: string): Promise<number> {
  let tokens = 0;
  const q = query({
    prompt: 'reply ok',
    options: { cwd: root, settings: { autoMemoryDirectory: vaultDir }, maxTurns: 1, settingSources: ['user', 'project', 'local'] },
  });
  for await (const msg of q) {
    if (msg.type === 'result') {
      const u = msg.usage as { input_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
      tokens = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
    }
  }
  return tokens;
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--compare') {
    const [a, b] = [args[1], args[2]].map((l) => JSON.parse(readFileSync(probePath(l!), 'utf8')) as Probe);
    console.log(compareProbes(a!, b!));
    return;
  }
  const label = args[0];
  if (!label || label.startsWith('--')) throw new Error('usage: memory-token-probe.ts <label> [--project <key>] | --compare <a> <b>');
  const only = args.includes('--project') ? args[args.indexOf('--project') + 1] : null;
  const projects = await getJson<{ key: string; root: string }[]>('/api/projects');
  const { vaultPath } = await getJson<{ vaultPath: string }>('/api/memory/graph');
  const probe: Probe = { label, projects: {} };
  for (const p of projects) {
    if (only && p.key !== only) continue;
    const dir = join(vaultPath, 'projects', p.key);
    const memory = join(dir, 'MEMORY.md');
    if (!existsSync(memory)) continue;
    const tokens = await measure(p.root, dir);
    probe.projects[p.key] = { tokens, ...memorySize(readFileSync(memory, 'utf8')) };
    console.log(`${p.key}\t${tokens}`);
  }
  mkdirSync(join('data', 'wiki-migration'), { recursive: true });
  writeFileSync(probePath(label), JSON.stringify(probe, null, 2) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
