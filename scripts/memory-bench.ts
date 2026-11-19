// Measures the memory module at wiki scale on a generated vault in a temp dir (never the user's vault).
// Usage: node --disable-warning=ExperimentalWarning scripts/memory-bench.ts [notes per project, default 60000] [projects, default 1]
import { utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { registerMemory } from '../server/memory/index.ts';
import { makeKit, until, type TestKit } from '../server/memory/testkit.ts';
import { setWikiManaged } from '../server/memory/wikiManaged.ts';

const WORDS = ('migration review doctrine queue worker redis cache payout ledger bonus combo event admin mock deploy staging rollback '
  + 'websocket token limit retry backoff schema index query lock deadlock audit wallet withdraw deposit rate fee currency report '
  + 'cron job metric alert trace span log level config secret vault map scene token grid fog light sprite asset upload').split(' ');
const TYPES = ['user', 'feedback', 'project', 'reference'];
// A long tail of made-up words after the topical ones, picked with a skew like real prose: a common word is in
// many notes, most words in few.
const SYLLABLES = ['ka', 'lo', 'mi', 'ner', 'tus', 'pra', 'vel', 'dor', 'sin', 'qua', 'ber', 'fi'];
const VOCAB = [...WORDS, ...Array.from({ length: 4000 }, (_, i) => SYLLABLES[i % 12] + SYLLABLES[Math.floor(i / 12) % 12] + SYLLABLES[Math.floor(i / 144) % 12])];

// Deterministic pseudo-random, so two runs measure the same vault.
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function noteText(key: string, i: number, total: number, rand: () => number): string {
  const pick = () => VOCAB[Math.floor(rand() ** 3 * VOCAB.length)];
  const sentence = (n: number) => Array.from({ length: n }, pick).join(' ');
  const links = rand() < 0.4 ? ` Related: [[${key}-note-${Math.floor(rand() * Math.min(total, 500))}]].` : '';
  const tags = [...new Set([pick(), pick()])].join(', ');
  return `---\nname: ${key}-note-${i}\ndescription: How the ${sentence(6)} works in ${key} (zq${i}x)\nmetadata:\n  type: ${TYPES[i % 4]}\n  tags: [${tags}]\n---\n`
    + `The ${sentence(40)}.\n\n**Why:** ${sentence(20)}.\n**How to apply:** ${sentence(20)}.${links}\n`;
}

export function generateVault(kit: TestKit, key: string, count: number): void {
  const dir = join(kit.paths.vault, 'projects', key);
  kit.write(join(dir, 'MEMORY.md'), '');
  const rand = rng(count + key.length);
  const now = Date.now() / 1000;
  for (let i = 0; i < count; i++) {
    const path = join(dir, `${key}-note-${i}.md`);
    writeFileSync(path, noteText(key, i, count, rand));
    const t = now - (count - i) * 60;
    utimesSync(path, t, t);
  }
}

async function time<T>(label: string, fn: () => Promise<T> | T): Promise<T> {
  const start = performance.now();
  const out = await fn();
  console.log(`${label.padEnd(36)} ${(performance.now() - start).toFixed(1).padStart(9)} ms`);
  return out;
}

type Get = (url: string) => Promise<{ body: string }>;

// The reads a user makes: the map, searches, the Storage panel.
async function queries(get: Get, key: string) {
  const graph = await time('graph, cold', () => get('/api/memory/graph'));
  console.log(`  graph payload ${(graph.body.length / 1024).toFixed(0)} KB, ${JSON.parse(graph.body).nodes.length} nodes`);
  await time('graph, warm', () => get('/api/memory/graph'));
  await time('search, first (index build)', () => get('/api/memory/search?q=migration%20review'));
  for (const q of ['migration review', 'payout ledger rollback', 'websocket', 'zzzz nothing']) {
    await time(`search "${q}"`, () => get(`/api/memory/search?q=${encodeURIComponent(q)}`));
  }
  await time('storage overview', () => get('/api/memory/overview'));
  await time('storage overview, warm', () => get('/api/memory/overview'));
  await time('storage list, newest 50', () => get('/api/memory/list'));
  await time('storage list, query + filter', () => get(`/api/memory/list?q=payout&project=${key}&type=feedback`));
}

async function main() {
  const perProject = Number(process.argv[2] ?? 60_000);
  const projects = Number(process.argv[3] ?? 1);
  const kit = makeKit();
  try {
    const keys = Array.from({ length: projects }, (_, i) => `bench${i}`);
    await time(`generate ${perProject} x ${projects}`, () => {
      for (const key of keys) {
        kit.addProject(key, join(kit.base, 'work', key));
        generateVault(kit, key, perProject);
        setWikiManaged(kit.paths, key, true);
      }
    });
    const get = (url: string) => kit.app.inject({ method: 'GET', url });
    // The longest the server could not answer anything: the cold build, index steps, rebuilds.
    const stall = monitorEventLoopDelay({ resolution: 10 });
    const stalled = (label: string) => {
      console.log(`  longest stall ${label}: ${(stall.max / 1e6).toFixed(0)} ms`);
      stall.reset();
    };
    stall.enable();
    await time('register', () => registerMemory(kit.ctx));
    await new Promise((r) => setTimeout(r, 3000)); // the watcher gets ready
    const indexed = async (i: number) => (JSON.parse((await get(`/api/memory/search?q=zq${i}x`)).body) as unknown[]).length > 0;
    await time('search index complete', async () => {
      // The queue is written from its end: the first note is the last one in.
      while (!(await indexed(0))) await new Promise((r) => setTimeout(r, 50));
    });
    stalled('during start and index build');
    await queries(get, keys[0]);
    const one = join(kit.paths.vault, 'projects', keys[0], `${keys[0]}-note-7.md`);
    const seen = kit.topics.length;
    writeFileSync(one, noteText(keys[0], 7, perProject, rng(1)).replace('The ', 'The changed '));
    await time('watcher sees the change', () => until(() => kit.topics.length > seen, 20_000));
    await time('one note changed: search', () => get('/api/memory/search?q=changed'));
    await time('one note changed: graph', () => get('/api/memory/graph'));
    stalled('after start');
    const rss = process.memoryUsage();
    console.log(`rss ${(rss.rss / 1048576).toFixed(0)} MB, heap ${(rss.heapUsed / 1048576).toFixed(0)} MB`);
  } finally {
    await kit.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
