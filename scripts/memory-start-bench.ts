// Measures a server start over a large generated vault in a temp dir (never the user's): cold, with a warm snapshot,
// and with a warm snapshot after files changed while the server was down. Each start runs in a fresh process.
// Usage: node --disable-warning=ExperimentalWarning scripts/memory-start-bench.ts [notes, default 100000] [projects, default 4]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { registerMemory, type MemoryApiExt } from '../server/memory/index.ts';
import { makeKit, until, type TestKit } from '../server/memory/testkit.ts';
import { setWikiManaged } from '../server/memory/wikiManaged.ts';
import { generateVault } from './memory-bench.ts';

const keys = (projects: number) => Array.from({ length: projects }, (_, i) => `bench${i}`);

// A kit whose vault and data are the shared bench dir, so starts after the first find its snapshot.
function kitOver(base: string, projects: number): TestKit {
  const kit = makeKit();
  Object.assign(kit.paths, { vault: join(base, 'vault'), data: join(base, 'data'), claudeDir: join(base, 'claude') });
  for (const key of keys(projects)) kit.addProject(key, join(kit.base, 'work', key));
  return kit;
}

async function child(base: string, projects: number) {
  const kit = kitOver(base, projects);
  const get = async (url: string) => (await kit.app.inject({ method: 'GET', url })).json() as { total?: number };
  const stall = monitorEventLoopDelay({ resolution: 5 });
  stall.enable();
  // Every gap over 50 ms with when it happened, to find what held the loop.
  const gaps: string[] = [];
  let tick = performance.now();
  const watch = setInterval(() => {
    const now = performance.now();
    if (now - tick > 55) gaps.push(`${(tick - t0).toFixed(0)}+${(now - tick - 5).toFixed(0)}`);
    tick = now;
  }, 5);
  const t0 = performance.now();
  registerMemory(kit.ctx);
  const register = performance.now() - t0;
  const first = await get('/api/memory/graph');
  const firstAt = performance.now() - t0;
  await (kit.ctx.memory as MemoryApiExt).ready;
  const completeAt = performance.now() - t0;
  const full = await get('/api/memory/graph');
  const viewAt = performance.now() - t0;
  const searching = performance.now();
  await kit.app.inject({ method: 'GET', url: '/api/memory/search?q=payout%20ledger' });
  const firstSearch = performance.now() - searching;
  const needle = async () => ((await kit.app.inject({ method: 'GET', url: '/api/memory/search?q=zq0x' })).json() as unknown[]).length > 0;
  while (!(await needle())) await new Promise((r) => setTimeout(r, 50));
  const indexAt = performance.now() - t0;
  await new Promise((r) => setTimeout(r, 1000));
  // The snapshot is written after the start pass; a close abandons a write in flight, so the next start waits for it.
  const snap = join(base, 'data', 'memory-snapshot.ndjson');
  await until(() => existsSync(snap) && !existsSync(`${snap}.tmp`), 60_000);
  clearInterval(watch);
  stall.disable();
  const rss = process.memoryUsage().rss / 1048576;
  const closing = performance.now();
  await kit.app.close();
  rmSync(kit.base, { recursive: true, force: true });
  console.log(JSON.stringify({
    register, firstAt, firstTotal: first.total, completeAt, viewAt, firstSearch, total: full.total, indexAt,
    maxStall: stall.max / 1e6, gaps: gaps.slice(0, 12), rss, close: performance.now() - closing,
  }));
}

function start(label: string, base: string, projects: number) {
  const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), '--child', base, String(projects)], { encoding: 'utf8' });
  const out = run.stdout.trim().split('\n').pop() ?? '';
  if (run.status !== 0 || !out.startsWith('{')) throw new Error(`${label}: ${run.stderr}`);
  const r = JSON.parse(out) as Record<string, number> & { gaps: string[] };
  const ms = (v: number) => `${v.toFixed(0)} ms`;
  console.log(`${label.padEnd(28)} register ${ms(r.register)} | first answer ${ms(r.firstAt)} (${r.firstTotal} notes) | complete ${ms(r.completeAt)}`
    + ` | view ${ms(r.viewAt)} (${r.total}) | first search ${ms(r.firstSearch)} | search index ${ms(r.indexAt)} | max stall ${ms(r.maxStall)} | rss ${r.rss.toFixed(0)} MB | close ${ms(r.close)}`);
  if (r.gaps.length) console.log(`  stalls over 50 ms (at+length): ${r.gaps.join(' ')}`);
}

// Edits made while the server is down: some notes changed, some new, some deleted.
function offlineEdits(base: string, perProject: number) {
  const dir = join(base, 'vault', 'projects', 'bench0');
  for (let i = 1; i <= 200; i++) writeFileSync(join(dir, `bench0-note-${i}.md`), `---\nname: bench0-note-${i}\ndescription: edited ${i}\nmetadata:\n  type: project\n  tags: [edit]\n---\nEdited while the server was down.\n`);
  for (let i = 0; i < 100; i++) writeFileSync(join(dir, `fresh-${i}.md`), `---\nname: fresh-${i}\ndescription: fresh ${i}\nmetadata:\n  type: project\n  tags: [edit]\n---\nNew.\n`);
  for (let i = 0; i < 100; i++) rmSync(join(dir, `bench0-note-${perProject - 1 - i}.md`));
}

async function main() {
  const total = Number(process.argv[2] ?? 100_000);
  const projects = Number(process.argv[3] ?? 4);
  const base = mkdtempSync(join(tmpdir(), 'claude-os-start-bench-'));
  try {
    const kit = kitOver(base, projects);
    const perProject = Math.ceil(total / projects);
    const t = performance.now();
    for (const key of keys(projects)) {
      generateVault(kit, key, perProject);
      setWikiManaged(kit.paths, key, true);
    }
    console.log(`generated ${perProject * projects} notes in ${projects} projects: ${((performance.now() - t) / 1000).toFixed(1)} s`);
    await kit.app.close();
    rmSync(kit.base, { recursive: true, force: true });
    start('cold (no snapshot)', base, projects);
    start('warm snapshot', base, projects);
    start('warm snapshot, 2nd run', base, projects);
    offlineEdits(base, perProject);
    start('warm, 400 files changed', base, projects);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--child') await child(process.argv[3]!, Number(process.argv[4]));
else if (import.meta.url === `file://${process.argv[1]}`) await main();
