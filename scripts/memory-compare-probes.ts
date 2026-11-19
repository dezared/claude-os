// The probes memory-compare.ts runs against one server process. Every probe goes through HTTP routes all five stages
// have, or answers null when a route is missing (404), so a missing number is never made up.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { NEEDLES, QUESTIONS } from './memory-eval-vault.ts';
import { KEYWORDS, PARAPHRASED, RUSSIAN, type Probe } from './memory-semantic-eval.ts';
import { waitFor, type Server } from './memory-compare-server.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Hit = { name: string };
const searchUrl = (q: string, project: string | null, limit = 20) => `/api/memory/search?q=${encodeURIComponent(q)}&limit=${limit}${project ? `&project=${project}` : ''}`;
const count = (json: unknown) => {
  const g = json as { total?: number; nodes?: unknown[] };
  return g.total ?? g.nodes?.length ?? 0;
};

export interface StartResult { health: number | null; firstAnswer: number | null; complete: number | null; searchReady: number | null; maxStall: number; rss: number; peakRss: number }

// From spawn: the first /health, the first map answer, the map holding every note, every needle found by search.
export async function startProbe(s: Server, notes: number): Promise<StartResult> {
  const t0 = s.spawnedAt;
  const health = await waitFor(async () => (await s.get('/health')).status === 200, t0, 60_000, 10);
  await s.stall(); // the window starts once the server is up: module loading is the same in every stage
  let full = false;
  const firstAnswer = await waitFor(async () => {
    const a = await s.get('/api/memory/graph');
    full = a.status === 200 && count(a.json) >= notes;
    return a.status === 200;
  }, t0, 300_000, 10);
  // A stage that builds the whole view on the first request is complete with its first answer.
  const complete = full ? firstAnswer : await waitFor(async () => count((await s.get('/api/memory/graph')).json) >= notes, t0, 300_000, 50);
  const searchReady = await waitFor(async () => {
    const found = await Promise.all(NEEDLES.map(async (n) => ((await s.get(searchUrl(n.name.replaceAll('-', ' '), n.project))).json as Hit[]).some((h) => h.name === n.name)));
    return found.every(Boolean);
  }, t0, 600_000, 250);
  await sleep(1000);
  const maxStall = await s.stall();
  const { rss, peak } = s.rss();
  return { health, firstAnswer, complete, searchReady, maxStall, rss, peakRss: peak };
}

// The query set of the latency probe: Claude's eval questions and the keyword probes.
export const LATENCY_QUERIES: [string, string][] = [...QUESTIONS.map((q) => [q.q, q.project] as [string, string]), ...KEYWORDS.map(([p, , q]) => [q, p] as [string, string])];

export interface Spread { median: number; p90: number; max: number }
export const spread = (values: number[]): Spread => {
  const v = [...values].sort((a, b) => a - b);
  return { median: v[Math.floor(v.length / 2)], p90: v[Math.min(v.length - 1, Math.floor(v.length * 0.9))], max: v.at(-1)! };
};

export async function searchLatency(s: Server, rounds = 3): Promise<Spread> {
  const times: number[] = [];
  for (let r = 0; r < rounds; r++) for (const [q, project] of LATENCY_QUERIES) times.push((await s.get(searchUrl(q, project, 5))).ms);
  return spread(times);
}

export type Recall = Record<'keywords' | 'paraphrase' | 'russian', number>;

async function recallOf(s: Server, probes: Probe[]): Promise<number> {
  let found = 0;
  for (const [project, name, q] of probes) if (((await s.get(searchUrl(q, project, 5))).json as Hit[]).slice(0, 5).some((h) => h.name === name)) found++;
  return found / probes.length;
}

export const recall = async (s: Server): Promise<Recall> => ({
  keywords: await recallOf(s, KEYWORDS), paraphrase: await recallOf(s, PARAPHRASED), russian: await recallOf(s, RUSSIAN),
});

export interface MapResult { graphMs: number; graphBytes: number; graphNodes: number; overviewMs: number | null; overviewBytes: number | null }

// Warm answers: the median of three, after the start settled.
export async function mapProbe(s: Server): Promise<MapResult> {
  const graphs = [await s.get('/api/memory/graph'), await s.get('/api/memory/graph'), await s.get('/api/memory/graph')];
  const overviews = [await s.get('/api/memory/overview'), await s.get('/api/memory/overview'), await s.get('/api/memory/overview')];
  const g = graphs.sort((a, b) => a.ms - b.ms)[1];
  const o = overviews.sort((a, b) => a.ms - b.ms)[1];
  const nodes = (g.json as { nodes: unknown[] }).nodes.length;
  return { graphMs: g.ms, graphBytes: g.bytes, graphNodes: nodes, overviewMs: o.status === 200 ? o.ms : null, overviewBytes: o.status === 200 ? o.bytes : null };
}

const fresh = (i: number) => `---\nname: burst-${i}\ndescription: Burst note ${i} about the payout ledger (wq${i}y)\nmetadata:\n  type: project\n  tags: [burst]\n---\n`
  + `Written during the burst; links [[ledger-rounding-rule]].\n`;

export interface BurstResult { maxStall: number; found: number; searchable: Spread | null; rss: number; peakRss: number }

// 50 new notes, one every 20 ms, while a client refetches the map (and the overview where it exists) on every
// invalidation and searches for every written note not found yet, as memory-write-bench.ts does in process.
export async function burst(s: Server, vault: string, writes = 50): Promise<BurstResult> {
  let refetch = false;
  const close = await s.socket((topics) => void (refetch ||= topics.includes('memory')));
  const written = new Map<number, number>();
  const found = new Map<number, number>();
  let stop = false;
  const client = (async () => {
    while (!stop) {
      if (refetch) {
        refetch = false;
        await Promise.all([s.get('/api/memory/graph'), s.get('/api/memory/overview')]);
      }
      await Promise.all([...written.keys()].filter((i) => !found.has(i)).map(async (i) => {
        if (((await s.get(searchUrl(`wq${i}y`, null))).json as Hit[]).length) found.set(i, performance.now() - written.get(i)!);
      }));
      await sleep(20);
    }
  })();
  await s.stall();
  for (let i = 0; i < writes; i++) {
    writeFileSync(join(vault, 'projects', 'payments', `burst-${i}.md`), fresh(i));
    written.set(i, performance.now());
    await sleep(20);
  }
  await waitFor(async () => found.size >= writes, performance.now(), 30_000, 50);
  await sleep(1000);
  stop = true;
  await client;
  close();
  const maxStall = await s.stall();
  const { rss, peak } = s.rss();
  return { maxStall, found: found.size, searchable: found.size ? spread([...found.values()]) : null, rss, peakRss: peak };
}
