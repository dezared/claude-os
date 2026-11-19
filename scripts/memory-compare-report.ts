// The tables of docs/specs/2026-11-13-memory-compare.md from the results memory-compare.ts writes: one row per
// metric and vault size, one column per stage, the median of the runs. A missing measurement prints n/a.
type Json = Record<string, unknown>;
type Pick = (run: Json) => number | null | undefined;

const STAGE_IDS = ['S0', 'S1', 'S2', 'S3', 'S4'];
const SIZES = [10_000, 100_000];
const NA = 'n/a';

const at = (o: unknown, path: string): unknown => path.split('.').reduce<unknown>((v, k) => (v as Json | null | undefined)?.[k], o);
const num = (path: string): Pick => (run) => at(run, path) as number | null | undefined;

function median(values: number[]): number | null {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.floor(v.length / 2)];
}

const runsOf = (results: Json, stage: string, size: number) => Object.entries(results)
  .filter(([k]) => k.startsWith(`timing ${stage} ${size} `)).map(([, v]) => v as Json);

const ms = (v: number) => (v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${v.toFixed(0)} ms`);
const mb = (v: number) => `${v.toFixed(0)} MB`;
const kb = (v: number) => (v >= 1_048_576 ? `${(v / 1_048_576).toFixed(1)} MB` : `${(v / 1024).toFixed(0)} KB`);
const pct = (v: number) => `${(v * 100).toFixed(0)}%`;
const int = (v: number) => v.toFixed(0);

interface Row { label: string; pick: Pick; fmt: (v: number) => string; from?: number; why?: string }

function cell(results: Json, row: Row, stage: string, size: number): string {
  if (row.from !== undefined && STAGE_IDS.indexOf(stage) < row.from) return `${NA}${row.why ? ` (${row.why})` : ''}`;
  const runs = runsOf(results, stage, size);
  if (!runs.length) return 'not run';
  const values = runs.map(row.pick).filter((v): v is number => typeof v === 'number');
  const m = median(values);
  return m === null ? NA : row.fmt(m);
}

function table(results: Json, title: string, rows: Row[]) {
  const out = [`**${title}**`, '', `| metric | notes | ${STAGE_IDS.join(' | ')} |`, `|---|---|${STAGE_IDS.map(() => '---').join('|')}|`];
  for (const row of rows) for (const size of SIZES) out.push(`| ${row.label} | ${size / 1000}k | ${STAGE_IDS.map((s) => cell(results, row, s, size)).join(' | ')} |`);
  console.log(`${out.join('\n')}\n`);
}

const START: Row[] = [
  { label: 'server up (/health)', pick: num('cold.health'), fmt: ms },
  { label: 'first map answer, cold', pick: num('cold.firstAnswer'), fmt: ms },
  { label: 'first map answer, warm snapshot', pick: num('warm.firstAnswer'), fmt: ms, from: 2, why: 'no snapshot' },
  { label: 'view complete, cold', pick: num('cold.complete'), fmt: ms },
  { label: 'view complete, warm snapshot', pick: num('warm.complete'), fmt: ms, from: 2, why: 'no snapshot' },
  { label: 'search finds every needle, cold', pick: num('cold.searchReady'), fmt: ms },
  { label: 'search finds every needle, warm', pick: num('warm.searchReady'), fmt: ms, from: 2, why: 'no snapshot' },
  { label: 'max event-loop stall in start, cold', pick: num('cold.maxStall'), fmt: ms },
  { label: 'max event-loop stall in start, warm', pick: num('warm.maxStall'), fmt: ms, from: 2, why: 'no snapshot' },
  { label: 'RSS after start, cold', pick: num('cold.rss'), fmt: mb },
  { label: 'peak RSS in start, cold', pick: num('cold.peakRss'), fmt: mb },
];
// S0 and S1 have no snapshot: their second start reads every file again, shown apart so "warm" never means two things.
const SECOND: Row[] = [
  { label: 'server up, 2nd start', pick: num('warm.health'), fmt: ms },
  { label: 'first map answer, 2nd start', pick: num('warm.firstAnswer'), fmt: ms },
  { label: 'view complete, 2nd start (S0–S1 read every file, S2+ snapshot)', pick: num('warm.complete'), fmt: ms },
  { label: 'max stall, 2nd start', pick: num('warm.maxStall'), fmt: ms },
];
const SEARCH: Row[] = [
  { label: 'memory_search median', pick: num('latency.median'), fmt: ms },
  { label: 'memory_search p90', pick: num('latency.p90'), fmt: ms },
  { label: 'memory_search max', pick: num('latency.max'), fmt: ms },
  { label: 'recall@5 keywords', pick: num('recall.keywords'), fmt: pct },
  { label: 'recall@5 English paraphrase', pick: num('recall.paraphrase'), fmt: pct },
  { label: 'recall@5 Russian', pick: num('recall.russian'), fmt: pct },
];
const MAP: Row[] = [
  { label: 'map answer (warm)', pick: num('map.graphMs'), fmt: ms },
  { label: 'map answer size', pick: num('map.graphBytes'), fmt: kb },
  { label: 'map nodes sent', pick: num('map.graphNodes'), fmt: int },
  { label: 'overview answer', pick: num('map.overviewMs'), fmt: ms, from: 1, why: 'no route' },
  { label: 'overview size', pick: num('map.overviewBytes'), fmt: kb, from: 1, why: 'no route' },
];
const WRITES: Row[] = [
  { label: 'max event-loop stall in the burst', pick: num('writes.maxStall'), fmt: ms },
  { label: 'written note searchable, median', pick: num('writes.searchable.median'), fmt: ms },
  { label: 'written note searchable, max', pick: num('writes.searchable.max'), fmt: ms },
  { label: 'notes found of 50 (30 s)', pick: num('writes.found'), fmt: int },
  { label: 'RSS after the burst', pick: num('writes.rss'), fmt: mb },
];

function semantic(results: Json) {
  const out = ['**Search by meaning (vectors fully built)**', '', '| stage | vault | vectors | recall@5 keywords | English paraphrase | Russian | search median / p90 / max | server RSS |', '|---|---|---|---|---|---|---|---|'];
  for (const [key, v] of Object.entries(results).filter(([k]) => k.startsWith('semantic '))) {
    const r = v as Json;
    const [, stage, size] = key.split(' ');
    const built = r.reused ? 'reused from S4' : `built in ${ms(r.builtMs as number)}`;
    const lat = ['median', 'p90', 'max'].map((k) => ms(at(r, `latency.${k}`) as number)).join(' / ');
    out.push(`| ${stage} | ${(r.vaultNotes as number) / 1000}k${Number(size) !== r.vaultNotes ? ` (for ${Number(size) / 1000}k)` : ''} | ${built} | ${pct(at(r, 'recall.keywords') as number)} | ${pct(at(r, 'recall.paraphrase') as number)} | ${pct(at(r, 'recall.russian') as number)} | ${lat} | ${mb(r.rss as number)} |`);
  }
  console.log(`${out.join('\n')}\n`);
}

export function printReport(results: Json): void {
  const loads = Object.entries(results).filter(([k]) => k.startsWith('timing ')).flatMap(([, v]) => (v as Json).load as number[]);
  console.log(`load average (1 min) during the runs: ${Math.min(...loads).toFixed(2)}–${Math.max(...loads).toFixed(2)}, median ${median(loads)?.toFixed(2)}\n`);
  table(results, 'Start (from process spawn)', START);
  table(results, 'Second start', SECOND);
  table(results, 'Search (FTS; no model installed)', SEARCH);
  table(results, 'Map and overview', MAP);
  table(results, 'Burst of 50 writes, one every 20 ms', WRITES);
  semantic(results);
}
