// Before/after of the memory system by stage: each stage's tree is checked out into a temp git worktree and started as
// a real server over the same generated vault (memory-eval-vault.ts, fixed seed), in temp dirs only. Results go to a
// JSON file one run at a time, so an interrupted run resumes; `--report` prints the tables of docs/specs/2026-11-13-memory-compare.md.
// Usage: node --disable-warning=ExperimentalWarning scripts/memory-compare.ts [--sizes 10000,100000] [--runs 3] [--stages S0,S4]
//   [--model <e5 cache dir>] [--work /tmp/memcompare] [--keep-trees] | --report [results.json]
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { loadavg } from 'node:os';
import { join } from 'node:path';
import { PROJECTS, writeEvalVault } from './memory-eval-vault.ts';
import { burst, mapProbe, recall, searchLatency, startProbe } from './memory-compare-probes.ts';
import { freshData, runDirs, startServer, waitFor, type RunDirs } from './memory-compare-server.ts';
import { printReport } from './memory-compare-report.ts';

const REPO = join(import.meta.dirname, '..');
export const STAGES = [
  ['S0', '1355ba6', 'baseline'],
  ['S1', '0a25ecd', 'scale'],
  ['S2', 'fcf1d60', 'instant start'],
  ['S3', 'c5fd442', 'search by meaning'],
  ['S4', '4fffb30', 'incremental writes'],
] as const;
type Stage = (typeof STAGES)[number];
const SNAPSHOT_FROM = 2;
const SEMANTIC_FROM = 3;
// Vectors of a 100k vault take about 50 minutes to build on this machine: the search by meaning is measured on 20k.
const SEMANTIC_SUBSET = 20_000;
const PORT = 48991;
const PROJECT_KEYS = PROJECTS.map(([k]) => k);

const arg = (name: string, fallback: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const work = arg('--work', '/tmp/memcompare');
const resultsFile = join(work, 'results.json');
type Results = Record<string, unknown>;
const load = (): Results => (existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) as Results : {});
function save(key: string, value: unknown) {
  const all = load();
  all[key] = value;
  writeFileSync(resultsFile, `${JSON.stringify(all, null, 2)}\n`);
}

function sh(cmd: string, args: string[]) {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')}: ${r.stderr}`);
}

function tree([id, sha]: Stage): string {
  const dir = join(work, `tree-${id}`);
  if (!existsSync(dir)) {
    sh('git', ['-C', REPO, 'worktree', 'add', '--detach', dir, sha]);
    symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
  }
  return dir;
}

function template(notes: number): string {
  const dir = join(work, `vault-${notes}`);
  if (!existsSync(join(dir, '.done'))) {
    rmSync(dir, { recursive: true, force: true });
    writeEvalVault(dir, notes);
    writeFileSync(join(dir, '.done'), '');
  }
  return dir;
}

// A fresh vault copy at the same path every run, so a snapshot or vectors file of one run fits the next.
function freshRun(notes: number): RunDirs {
  const dirs = runDirs(join(work, 'run'));
  rmSync(dirs.base, { recursive: true, force: true });
  mkdirSync(dirs.base, { recursive: true });
  sh('cp', ['-a', template(notes), dirs.vault]);
  rmSync(join(dirs.vault, '.done'));
  freshData(dirs, PROJECT_KEYS);
  return dirs;
}

const snapshotWritten = (dirs: RunDirs) => async () => {
  const snap = join(dirs.data, 'memory-snapshot.ndjson');
  return existsSync(snap) && !existsSync(`${snap}.tmp`);
};

async function timingRun(stage: Stage, notes: number, run: number) {
  const dir = tree(stage);
  const dirs = freshRun(notes);
  const load1 = loadavg()[0];
  const cold = startServer(dir, dirs, PORT);
  const first = await startProbe(cold, notes);
  const fts = run === 0 ? await recall(cold) : null;
  const latency = await searchLatency(cold);
  const map = await mapProbe(cold);
  const hasSnapshot = STAGES.indexOf(stage) >= SNAPSHOT_FROM;
  if (hasSnapshot) await waitFor(snapshotWritten(dirs), performance.now(), 120_000, 200);
  await cold.stop();
  const warm = startServer(dir, dirs, PORT);
  const second = await startProbe(warm, notes);
  const writes = await burst(warm, dirs.vault);
  await warm.stop();
  return { load: [load1, loadavg()[0]], cold: first, warm: second, warmIsSnapshot: hasSnapshot, recall: fts, latency, map, writes };
}

type Semantic = { indexed: number; total: number };

// The search by meaning with every vector built: hybrid recall and latency. Vectors are built once per vault and
// reused (the vectors file format is the same in S3 and S4), so the build time is S4's.
async function semanticRun(stage: Stage, notes: number, model: string) {
  const vaultNotes = notes > SEMANTIC_SUBSET ? SEMANTIC_SUBSET : notes;
  const dirs = freshRun(vaultNotes);
  const root = join(dirs.data, 'memory-semantic');
  mkdirSync(root, { recursive: true });
  symlinkSync(model, join(root, 'model'));
  writeFileSync(join(root, 'installed'), 'memcompare\n');
  const cached = join(work, `vectors-${vaultNotes}.bin`);
  const reused = existsSync(cached);
  if (reused) copyFileSync(cached, join(root, 'vectors.bin'));
  const s = startServer(tree(stage), dirs, PORT);
  const start = await startProbe(s, vaultNotes);
  const built = await waitFor(async () => {
    const st = (await s.get('/api/memory/semantic')).json as Semantic;
    return st.total > 0 && st.indexed === st.total;
  }, s.spawnedAt, 4 * 3_600_000, 2000);
  const hybrid = await recall(s);
  const latency = await searchLatency(s);
  if (!reused) {
    await waitFor(async () => existsSync(join(root, 'vectors.bin')), performance.now(), 120_000, 500);
    await new Promise((r) => setTimeout(r, 3000));
    copyFileSync(join(root, 'vectors.bin'), cached);
  }
  const { rss } = s.rss();
  await s.stop();
  return { vaultNotes, reused, builtMs: built, start, recall: hybrid, latency, rss };
}

async function each(key: string, measure: () => Promise<unknown>) {
  if (key in load()) return;
  console.log(`${new Date().toISOString()} ${key}`);
  save(key, await measure());
}

async function main() {
  const sizes = arg('--sizes', '10000,100000').split(',').map(Number);
  const runs = Number(arg('--runs', '3'));
  const only = arg('--stages', STAGES.map(([id]) => id).join(',')).split(',');
  const model = arg('--model', '');
  mkdirSync(work, { recursive: true });
  const stages = STAGES.filter(([id]) => only.includes(id));
  for (const notes of sizes) for (const stage of stages) for (let run = 0; run < runs; run++) await each(`timing ${stage[0]} ${notes} ${run}`, () => timingRun(stage, notes, run));
  // S4 first: it builds the vectors S3 then reuses.
  const semantic = model ? [...stages].reverse().filter((st) => STAGES.indexOf(st) >= SEMANTIC_FROM) : [];
  for (const notes of sizes) for (const stage of semantic) await each(`semantic ${stage[0]} ${notes}`, () => semanticRun(stage, notes, model));
  if (!process.argv.includes('--keep-trees')) for (const [id] of stages) {
    if (existsSync(join(work, `tree-${id}`))) sh('git', ['-C', REPO, 'worktree', 'remove', '--force', join(work, `tree-${id}`)]);
  }
  rmSync(join(work, 'run'), { recursive: true, force: true });
}

if (process.argv.includes('--report')) printReport(JSON.parse(readFileSync(arg('--report', '') || resultsFile, 'utf8')) as Results);
else await main();
