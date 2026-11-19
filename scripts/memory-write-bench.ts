// Measures note writes into a large generated vault in a temp dir (never the user's): the longest event-loop stall
// during a burst of writes, and how long until each written note is found by a search.
// Usage: node --disable-warning=ExperimentalWarning scripts/memory-write-bench.ts [notes, default 100000] [projects, default 4] [writes, default 50]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { registerMemory, type MemoryApiExt } from '../server/memory/index.ts';
import { makeKit, type TestKit } from '../server/memory/testkit.ts';
import { setWikiManaged } from '../server/memory/wikiManaged.ts';
import { generateVault } from './memory-bench.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const fresh = (i: number) => `---\nname: burst-${i}\ndescription: Burst note ${i} about the payout ledger (wq${i}y)\nmetadata:\n  type: project\n  tags: [burst]\n---\n`
  + `Written during the burst; links [[bench0-note-${i}]].\n`;

type Get = (url: string) => Promise<unknown>;

// Each request in a turn of its own, as requests over HTTP arrive: inject alone runs a loop of them back to back.
const getter = (kit: TestKit): Get => async (url) => {
  await new Promise((r) => setImmediate(r));
  return (await kit.app.inject({ method: 'GET', url })).json() as unknown;
};

// The search index and the deferred lint finish in the background; the burst starts on a settled server.
async function settle(kit: TestKit, get: Get, total: number, projects: number) {
  registerMemory(kit.ctx);
  await (kit.ctx.memory as MemoryApiExt).ready;
  const per = Math.ceil(total / projects);
  const indexed = async (i: number) => ((await get(`/api/memory/search?q=zq${i}x&limit=20`)) as unknown[]).length >= projects;
  while (!(await indexed(0)) || !(await indexed(per - 1))) await sleep(100);
  await sleep(3000);
  await get('/api/memory/graph');
  await get('/api/memory/overview');
}

// The interface refetches what an invalidation names; a client searches for every note written and not found yet.
function client(kit: TestKit, get: Get, written: Map<number, number>) {
  const found = new Map<number, number>();
  let seen = kit.topics.length;
  let stop = false;
  const done = (async () => {
    while (!stop) {
      if (kit.topics.length > seen) {
        seen = kit.topics.length;
        await get('/api/memory/graph');
        await get('/api/memory/overview');
      }
      await Promise.all([...written.keys()].filter((i) => !found.has(i)).map(async (i) => {
        if (((await get(`/api/memory/search?q=wq${i}y`)) as unknown[]).length) found.set(i, performance.now() - written.get(i)!);
      }));
      await sleep(20);
    }
  })();
  return { found, stop: () => ((stop = true), done) };
}

async function burst(kit: TestKit, get: Get, writes: number) {
  const stall = monitorEventLoopDelay({ resolution: 5 });
  stall.enable();
  const written = new Map<number, number>();
  const c = client(kit, get, written);
  const dir = join(kit.paths.vault, 'projects', 'bench0');
  for (let i = 0; i < writes; i++) {
    writeFileSync(join(dir, `burst-${i}.md`), fresh(i));
    written.set(i, performance.now());
    await sleep(20);
  }
  const deadline = performance.now() + 15_000;
  while (c.found.size < writes && performance.now() < deadline) await sleep(50);
  await sleep(1000);
  await c.stop();
  stall.disable();
  return { maxStall: stall.max / 1e6, times: [...c.found.values()].sort((a, b) => a - b) };
}

async function main() {
  const total = Number(process.argv[2] ?? 100_000);
  const projects = Number(process.argv[3] ?? 4);
  const writes = Number(process.argv[4] ?? 50);
  const kit = makeKit();
  try {
    for (let p = 0; p < projects; p++) {
      kit.addProject(`bench${p}`, join(kit.base, 'work', `bench${p}`));
      generateVault(kit, `bench${p}`, Math.ceil(total / projects));
      setWikiManaged(kit.paths, `bench${p}`, true);
    }
    const get = getter(kit);
    await settle(kit, get, total, projects);
    const { maxStall, times } = await burst(kit, get, writes);
    const ms = (v: number | undefined) => (v === undefined ? '-' : `${v.toFixed(0)} ms`);
    console.log(`${total} notes, ${writes} writes: max stall ${ms(maxStall)} | searchable median ${ms(times[Math.floor(times.length / 2)])}`
      + ` max ${ms(times.at(-1))} (${times.length}/${writes} found)`);
  } finally {
    await kit.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
