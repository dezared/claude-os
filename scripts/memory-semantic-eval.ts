// Recall@5 of memory search, FTS alone against FTS fused with the search by meaning, on the generated eval vault in a temp
// dir (never the user's vault). Queries say what a needle note says in other words, in English and in Russian. Offline: the
// model must already be in <model dir> (the cache folder the engine downloads into); no Claude call.
// Usage: node --disable-warning=ExperimentalWarning scripts/memory-semantic-eval.ts <model dir> [notes, default 2000]
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SEMANTIC_MODEL, type SemanticStatus } from '../shared/memorySemantic.ts';
import { registerMemory } from '../server/memory/index.ts';
import { createVectors } from '../server/memory/semantic/vectors.ts';
import { makeKit } from '../server/memory/testkit.ts';
import { writeEvalVault } from './memory-eval-vault.ts';

// [project, the note that answers, the query]
export type Probe = [string, string, string];
export const PARAPHRASED: Probe[] = [
  ['payments', 'ledger-rounding-rule', 'precision of monetary values in bookkeeping entries'],
  ['payments', 'payout-batch-cutoff', 'deadline for same-day money transfers to sellers'],
  ['payments', 'zero-decimal-currencies', 'yen amounts without cents'],
  ['payments', 'review-findings-format', 'how should I present problems found when checking a pull request'],
  ['payments', 'retry-ladder-v3', 'backoff intervals between repeated delivery attempts'],
  ['infra', 'redis-eviction-policy', 'which keys get dropped when the in-memory store runs out of RAM'],
  ['infra', 'staging-db-snapshots', 'retention of test environment database backups'],
  ['infra', 'release-calendar-2026', 'no shipping to production over the new year holidays'],
  ['infra', 'vpn-split-tunnel', 'which internal network addresses are routed over the corporate tunnel'],
  ['infra', 'tls-certificate-renewal', 'when https certs get refreshed before they lapse'],
  ['game-client', 'amd-shader-cache-corruption', 'black textures on radeon graphics cards after updating drivers'],
  ['game-client', 'fog-of-war-tile-size', 'grid cell size of the hidden map overlay'],
  ['game-client', 'rating-k-factor', 'how fast skill score changes for beginners'],
  ['mobile', 'ios-push-token-refresh', 'apple notification device token renewal on app launch'],
  ['mobile', 'offline-sync-conflicts', 'merging edits made without internet connection'],
  ['data-pipeline', 'pipeline-constants', 'tuning values like maximum rows per chunk'],
  ['docs-site', 'search-provider', 'static site full text lookup without a hosted service'],
];
export const RUSSIAN: Probe[] = [
  ['payments', 'ledger-rounding-rule', 'как округляются суммы в бухгалтерской книге'], // shippable-allow: Russian queries of the eval
  ['payments', 'payout-batch-cutoff', 'во сколько закрывается ежедневная пачка выплат'], // shippable-allow: Russian queries of the eval
  ['payments', 'zero-decimal-currencies', 'валюты без копеек'], // shippable-allow: Russian queries of the eval
  ['payments', 'review-findings-format', 'в каком виде присылать замечания ревью'], // shippable-allow: Russian queries of the eval
  ['payments', 'retry-ladder-v3', 'задержки между повторными попытками'], // shippable-allow: Russian queries of the eval
  ['infra', 'redis-eviction-policy', 'политика вытеснения ключей в редисе'], // shippable-allow: Russian queries of the eval
  ['infra', 'staging-db-snapshots', 'сколько хранятся снимки базы на стейджинге'], // shippable-allow: Russian queries of the eval
  ['infra', 'release-calendar-2026', 'когда запрещены релизы в конце года'], // shippable-allow: Russian queries of the eval
  ['infra', 'vpn-split-tunnel', 'какая подсеть идёт через впн'], // shippable-allow: Russian queries of the eval
  ['infra', 'tls-certificate-renewal', 'когда продлеваются сертификаты'], // shippable-allow: Russian queries of the eval
  ['game-client', 'amd-shader-cache-corruption', 'почему ломался кэш шейдеров на видеокартах амд'], // shippable-allow: Russian queries of the eval
  ['game-client', 'fog-of-war-tile-size', 'размер клетки тумана войны'], // shippable-allow: Russian queries of the eval
  ['game-client', 'rating-k-factor', 'коэффициент изменения рейтинга для новичков'], // shippable-allow: Russian queries of the eval
  ['mobile', 'ios-push-token-refresh', 'когда обновляется токен пушей на айфоне'], // shippable-allow: Russian queries of the eval
  ['mobile', 'offline-sync-conflicts', 'как сливаются правки, сделанные без сети'], // shippable-allow: Russian queries of the eval
  ['data-pipeline', 'pipeline-constants', 'общие константы конвейера данных'], // shippable-allow: Russian queries of the eval
  ['docs-site', 'search-provider', 'какой поиск на сайте документации'], // shippable-allow: Russian queries of the eval
];

export const KEYWORDS: Probe[] = [
  ['payments', 'payout-batch-cutoff', 'payout batch cutoff'],
  ['infra', 'redis-eviction-policy', 'redis maxmemory policy'],
  ['infra', 'staging-db-snapshots', 'staging snapshots kept'],
  ['game-client', 'fog-of-war-tile-size', 'fog of war tile size'],
  ['docs-site', 'search-provider', 'docs search Algolia'],
];

type Find = (q: string, project: string) => Promise<string[]>;

async function recall(probes: Probe[], find: Find): Promise<{ at5: number; misses: string[] }> {
  let found = 0;
  const misses: string[] = [];
  for (const [project, name, q] of probes) {
    if ((await find(q, project)).slice(0, 5).includes(name)) found++;
    else misses.push(name);
  }
  return { at5: found / probes.length, misses };
}

// Brute force over 100k random vectors: the cost of one query and the memory the store takes.
function bruteForce() {
  const vs = createVectors(SEMANTIC_MODEL.dims);
  const v = new Float32Array(SEMANTIC_MODEL.dims);
  for (let n = 0; n < 100_000; n++) {
    for (let i = 0; i < v.length; i++) v[i] = Math.random() - 0.5;
    vs.set({ path: `/vault/projects/p${n % 6}/note-${n}.md`, sha: 'x'.repeat(64), project: `p${n % 6}` }, v);
  }
  const times = Array.from({ length: 20 }, () => {
    const start = performance.now();
    vs.top(v, 20, null);
    return performance.now() - start;
  }).sort((a, b) => a - b);
  console.log(`100k vectors: ${(vs.bytes() / 1e6).toFixed(1)} MB of rows, file ${(vs.serialize(SEMANTIC_MODEL.id).length / 1e6).toFixed(1)} MB, top-20 median ${times[10].toFixed(1)} ms`);
}

async function build(modelDir: string, total: number) {
  const kit = makeKit();
  writeEvalVault(kit.paths.vault, total);
  const root = join(kit.paths.data, 'memory-semantic');
  mkdirSync(root, { recursive: true });
  symlinkSync(modelDir, join(root, 'model'));
  writeFileSync(join(root, 'installed'), 'eval\n');
  registerMemory(kit.ctx);
  const started = performance.now();
  let s: SemanticStatus;
  do {
    await new Promise((r) => setTimeout(r, 1000));
    s = (await kit.app.inject({ method: 'GET', url: '/api/memory/semantic' })).json() as SemanticStatus;
  } while (!(s.total > 0 && s.indexed === s.total));
  console.log(`built ${s.indexed} vectors in ${((performance.now() - started) / 1000).toFixed(0)} s (with a 5 s start delay)`);
  return kit;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const modelDir = process.argv[2];
  if (!modelDir) throw new Error('usage: memory-semantic-eval.ts <model dir> [notes]');
  bruteForce();
  const kit = await build(modelDir, Number(process.argv[3] ?? 2000));
  const fts: Find = async (q, project) => kit.ctx.memory.search(q, { project }).map((h) => h.name);
  const hybrid: Find = async (q, project) => (await kit.ctx.memory.find(q, { project })).map((h) => h.name);
  const start = performance.now();
  await hybrid('warm the engine', 'infra');
  console.log(`first query ${(performance.now() - start).toFixed(0)} ms`);
  console.log('| queries | n | FTS recall@5 | hybrid recall@5 |\n| --- | --- | --- | --- |');
  for (const [label, probes] of [['keywords', KEYWORDS], ['English paraphrase', PARAPHRASED], ['Russian', RUSSIAN]] as const) {
    const a = await recall(probes, fts);
    const b = await recall(probes, hybrid);
    console.log(`| ${label} | ${probes.length} | ${(a.at5 * 100).toFixed(0)}% | ${(b.at5 * 100).toFixed(0)}% |`);
    if (b.misses.length) console.log(`  hybrid misses: ${b.misses.join(', ')}`);
  }
  const t = performance.now();
  for (const [project, , q] of RUSSIAN) await hybrid(q, project);
  console.log(`hybrid query median-ish: ${((performance.now() - t) / RUSSIAN.length).toFixed(1)} ms each`);
  await kit.close();
}
