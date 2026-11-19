// A generated vault for the memory evaluation: six projects of realistic one-fact notes (types, tags, wikilinks)
// around a set of needle notes whose facts exist nowhere else, plus near-miss distractors. Deterministic.
import { mkdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROJECTS: [string, number][] = [['payments', 35], ['game-client', 25], ['infra', 20], ['mobile', 10], ['data-pipeline', 6], ['docs-site', 4]];

const TOPICS: Record<string, string[]> = {
  payments: 'ledger payout refund chargeback invoice currency settlement wallet fee tax reconciliation webhook provider merchant balance withdrawal deposit fraud limit'.split(' '),
  'game-client': 'shader texture sprite fog tile matchmaking rating lobby replay input camera physics animation audio asset loader frame inventory'.split(' '),
  infra: 'redis postgres kafka nginx terraform kubernetes ingress certificate dns backup snapshot deploy rollout alert metric tracing vpn secret'.split(' '),
  mobile: 'push notification deeplink onboarding keychain biometric offline sync crash screen navigation permission widget badge cache'.split(' '),
  'data-pipeline': 'event dedup batch schema partition warehouse ingest backfill parquet stream consumer lag watermark join'.split(' '),
  'docs-site': 'page sidebar search build theme versioning redirect sitemap snippet diagram changelog'.split(' '),
};
const VERBS = 'retries times out caches validates migrates splits merges logs throttles locks rebuilds expires batches signs'.split(' ');
const ADJ = 'stale partial nightly cold warm shared legacy async manual flaky slow hot regional default fallback'.split(' ');
const FILLER = 'the a this each every one with without after before during only when because so but still also usually'.split(' ');
const TYPES = ['project', 'feedback', 'reference', 'project', 'user', 'project'];

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export interface Needle { project: string; name: string; description: string; body: string; type?: string; tags?: string[] }

export function noteText(n: Needle): string {
  const tags = n.tags ?? [n.name.split('-')[0]];
  return `---\nname: ${n.name}\ndescription: ${n.description}\nmetadata:\n  type: ${n.type ?? 'project'}\n  tags: [${tags.join(', ')}]\n---\n${n.body}\n`;
}

// One noise note: a topical sentence or three, a why and a how, sometimes a link to an older note of the project.
function noise(project: string, i: number, names: string[], rand: () => number): Needle {
  const words = TOPICS[project];
  const pick = <T>(list: T[]) => list[Math.floor(rand() * list.length)];
  const topic = () => pick(words);
  const sentence = () => `${pick(FILLER)} ${pick(ADJ)} ${topic()} ${pick(VERBS)} ${pick(FILLER)} ${topic()} ${pick(FILLER)} ${pick(ADJ)} ${topic()}`;
  const a = topic();
  const b = topic();
  const name = `${a}-${pick(ADJ)}-${b}-${i}`;
  const link = names.length && rand() < 0.3 ? ` See [[${names[Math.floor(rand() * names.length)]}]].` : '';
  const why = `**Why:** ${sentence()}. **How to apply:** ${sentence()}.`;
  const first = sentence();
  return {
    project, name, type: TYPES[i % TYPES.length], tags: [...new Set([a, b])].slice(0, 2),
    description: `How the ${pick(ADJ)} ${a} ${pick(VERBS)} the ${b} in ${project}`,
    body: `${first[0].toUpperCase()}${first.slice(1)}. ${sentence()}.${link}\n${why}`,
  };
}

export const NEEDLES: Needle[] = [
  { project: 'payments', name: 'ledger-rounding-rule', description: 'How ledger amounts are rounded before posting', body: 'Ledger amounts are rounded half-even (banker\'s rounding) to 4 decimal places before posting; half-up rounding drifted daily totals.\n**Why:** reconciliation mismatches in March. **How to apply:** use roundHalfEven(amount, 4) only.', tags: ['ledger'] },
  { project: 'payments', name: 'payout-batch-cutoff', description: 'When the daily payout batch closes', body: 'The daily payout batch closes at 16:45 UTC; requests after it go to the next business day.\n**Why:** the bank file deadline is 17:00 UTC. **How to apply:** show the cutoff in the payout form.', tags: ['payout'] },
  { project: 'payments', name: 'payout-retry-window', description: 'How long failed payouts are retried', body: 'A failed payout is retried until 18:00 UTC of the same day, then marked failed for manual review.\n**Why:** support asked for one review queue. **How to apply:** never retry overnight.', tags: ['payout'] },
  { project: 'payments', name: 'chargeback-webhook-retries', description: 'How chargeback webhooks are retried', body: 'Chargeback webhooks are retried on the schedule in [[retry-ladder-v3]]; after the last attempt the event goes to the dead-letter queue.\n**Why:** providers resend for 24 h anyway. **How to apply:** do not add a second retry layer.', tags: ['chargeback', 'webhook'] },
  { project: 'payments', name: 'retry-ladder-v3', description: 'Delays of the v3 retry ladder', body: 'Delays: 30 s, 2 min, 10 min, 1 h, 6 h; five attempts in total, no jitter.\n**Why:** v2 retried for days. **How to apply:** the ladder is a constant in retry.ts.', tags: ['webhook'] },
  { project: 'payments', name: 'zero-decimal-currencies', description: 'Currencies stored without minor units', body: 'JPY and KRW are stored with 0 minor units; their amounts must never be multiplied by 100.\n**Why:** a refund in yen was 100 times too large. **How to apply:** read minorUnits from the currency table.', tags: ['currency'] },
  { project: 'payments', name: 'review-findings-format', type: 'feedback', description: 'How the user wants code review findings', body: 'The user wants review findings as a numbered list, most severe first, with no praise.\n**Why:** they triage from the top. **How to apply:** every review, every project.', tags: ['review'] },
  { project: 'infra', name: 'redis-eviction-policy', description: 'Which eviction policy production Redis uses', body: 'Production Redis runs maxmemory-policy allkeys-lfu; volatile-lru evicted session keys too early under load.\n**Why:** logouts during the May sale. **How to apply:** keep sessions on the same cluster.', tags: ['redis'] },
  { project: 'infra', name: 'cache-cluster-eviction', description: 'Eviction on the separate cache cluster', body: 'The separate cache cluster (not production Redis) uses volatile-ttl, because every key there has a TTL.\n**Why:** cheap expiry. **How to apply:** only for the cache cluster.', tags: ['redis', 'cache'] },
  { project: 'infra', name: 'staging-db-snapshots', description: 'When staging database snapshots run and how long they are kept', body: 'Staging database snapshots run at 03:10 UTC and are kept for 9 days.\n**Why:** QA needs last week plus a weekend. **How to apply:** restore with snapshot-restore staging <date>.', tags: ['backup', 'postgres'] },
  { project: 'infra', name: 'production-db-snapshots', description: 'Retention of production database snapshots', body: 'Production database snapshots are kept for 35 days and copied to a second region.\n**Why:** the audit requires a month. **How to apply:** never shorten without the audit owner.', tags: ['backup', 'postgres'] },
  { project: 'infra', name: 'deploy-freeze-policy', description: 'Rules of a deploy freeze', body: 'Deploys are frozen during the periods listed in [[release-calendar-2026]]; a hotfix in a freeze needs two approvals.\n**Why:** incidents in last year\'s holidays. **How to apply:** check the calendar before a release.', tags: ['deploy'] },
  { project: 'infra', name: 'release-calendar-2026', description: 'Frozen periods of 2026', body: 'Frozen: 2026-12-18 to 2027-01-04, and the week of 2026-11-23 (Black Friday).\n**Why:** traffic peaks. **How to apply:** plan releases around these dates.', tags: ['deploy'] },
  { project: 'infra', name: 'vpn-split-tunnel', description: 'Which traffic goes through the VPN', body: 'Only 10.42.0.0/16 goes through the VPN split tunnel; everything else uses the local route.\n**Why:** video calls broke over the full tunnel. **How to apply:** add new internal ranges here first.', tags: ['vpn'] },
  { project: 'game-client', name: 'amd-shader-cache-corruption', description: 'Why the shader cache was corrupt on AMD GPUs', body: 'The shader cache was corrupt on AMD drivers 23.x because the cache key left out the driver build; the key now includes driverBuild.\n**Why:** players saw black textures after driver updates. **How to apply:** any new cache key includes the driver build.', tags: ['shader'] },
  { project: 'game-client', name: 'fog-of-war-tile-size', description: 'The tile size of the fog of war', body: 'Fog of war uses 32 px tiles; 16 px tiles doubled GPU memory on 4K maps.\n**Why:** out-of-memory crashes on 4 GB cards. **How to apply:** do not lower it without a memory test.', tags: ['fog', 'tile'] },
  { project: 'game-client', name: 'fog-of-war-history', description: 'Earlier fog of war designs', body: 'The first fog of war drew per-pixel masks; the tile grid replaced it in 2025.\n**Why:** fill rate. **How to apply:** history only.', tags: ['fog'] },
  { project: 'game-client', name: 'rating-k-factor', description: 'K-factor of the matchmaking rating update', body: 'Rating updates use a K-factor of 24 for players with fewer than 30 games and 16 after that.\n**Why:** new players settle faster. **How to apply:** constants in rating.ts.', tags: ['matchmaking', 'rating'] },
  { project: 'game-client', name: 'rating-prototype-notes', description: 'Notes from the 2024 rating prototype', body: 'The 2024 rating prototype used a K-factor of 40 for everyone; it was replaced because ratings swung too much.\n**Why:** history. **How to apply:** do not reuse.', tags: ['rating'] },
  { project: 'mobile', name: 'ios-push-token-refresh', description: 'When the app refreshes its iOS push token', body: 'The app refreshes the APNs token on every cold start and sends it to the server only when it changed, keyed by installation id.\n**Why:** stale tokens after restores from backup. **How to apply:** never cache the token across installs.', tags: ['push'] },
  { project: 'mobile', name: 'android-push-token', description: 'How the Android push token is kept current', body: 'On Android the FCM token is sent from onNewToken; there is no refresh on start.\n**Why:** FCM calls it reliably. **How to apply:** Android only.', tags: ['push'] },
  { project: 'data-pipeline', name: 'event-dedup-window', description: 'How long event deduplication remembers ids', body: 'Event deduplication keeps ids for the window set in [[pipeline-constants]].\n**Why:** producers resend after outages. **How to apply:** change the window only there.', tags: ['dedup', 'event'] },
  { project: 'data-pipeline', name: 'pipeline-constants', description: 'Shared constants of the pipeline', body: 'DEDUP_TTL = 72 h; MAX_BATCH = 5000 rows; LATE_EVENT_GRACE = 15 min.\n**Why:** one place for tuning. **How to apply:** constants.py, reviewed by the data team.', tags: ['batch'] },
  { project: 'data-pipeline', name: 'dedup-before-2026', description: 'How deduplication worked before 2026', body: 'Before 2026 deduplication kept ids for 24 h in Redis; it moved to the warehouse with a longer window.\n**Why:** history. **How to apply:** do not restore.', tags: ['dedup'] },
  { project: 'docs-site', name: 'search-provider', description: 'Which search the docs site uses', body: 'The docs site uses Pagefind, a static index built at deploy, instead of Algolia: no external service and no key in the client.\n**Why:** Algolia crawls missed versioned pages. **How to apply:** rebuild the index in the deploy job.', tags: ['search'] },
  { project: 'docs-site', name: 'algolia-evaluation', description: 'The 2025 Algolia evaluation', body: 'Algolia DocSearch was evaluated in 2025 and rejected: its crawler skipped versioned pages.\n**Why:** history. **How to apply:** none.', tags: ['search'] },
  { project: 'mobile', name: 'offline-sync-conflicts', description: 'How offline edits are merged on sync', body: 'Offline edits merge field by field with last-writer-wins per field, using the device clock corrected by the server offset.\n**Why:** whole-record wins lost data. **How to apply:** new fields need a per-field timestamp.', tags: ['offline', 'sync'] },
  { project: 'infra', name: 'tls-certificate-renewal', description: 'When TLS certificates are renewed', body: 'TLS certificates renew 21 days before expiry through cert-manager; an alert fires at 10 days.\n**Why:** a renewal once failed silently. **How to apply:** keep the alert.', tags: ['certificate'] },
];

export interface Question { project: string; q: string; expect: RegExp[]; hop?: boolean }

// Asked in a tab of `project`; the answer lives only in needle notes (a hop: behind a [[link]]).
export const QUESTIONS: Question[] = [
  { project: 'payments', q: 'How does the payments ledger round amounts, and to how many decimal places?', expect: [/half.?even|banker/i, /\b4\b|four/i] },
  { project: 'payments', q: 'What time does the daily payout batch close?', expect: [/16:45/] },
  { project: 'payments', q: 'How many times is a chargeback webhook retried, and what is the longest delay between attempts?', expect: [/\b5\b|five/i, /6\s?h|6 hours|six hours/i], hop: true },
  { project: 'payments', q: 'Which currencies are stored without minor units?', expect: [/JPY/, /KRW/] },
  { project: 'payments', q: 'How do I want code review findings formatted?', expect: [/numbered/i] },
  { project: 'infra', q: 'Which maxmemory policy does production Redis use, and why was the previous one dropped?', expect: [/allkeys-lfu/i] },
  { project: 'infra', q: 'How long are staging database snapshots kept?', expect: [/\b9\b|nine/i] },
  { project: 'infra', q: 'When is the year-end deploy freeze this year?', expect: [/12-18|december 18|18 december|dec(ember)? 18/i, /01-04|january 4|4 january|jan(uary)? 4/i], hop: true },
  { project: 'game-client', q: 'What caused the corrupt shader cache on AMD GPUs?', expect: [/driver ?build/i] },
  { project: 'game-client', q: 'What tile size does the fog of war use, and why not smaller?', expect: [/32/] },
  { project: 'game-client', q: 'What K-factor do rating updates use for new players today?', expect: [/24/] },
  { project: 'mobile', q: 'When does the app refresh its iOS push token?', expect: [/cold start/i] },
  { project: 'mobile', q: 'In the infra project, which subnet goes through the VPN?', expect: [/10\.42/] },
  { project: 'data-pipeline', q: 'How long does the event pipeline remember ids for deduplication?', expect: [/72/], hop: true },
  { project: 'docs-site', q: 'Which search engine does the docs site use instead of Algolia?', expect: [/pagefind/i] },
];

// Writes `total` notes over PROJECTS (by their weights) with the needles inside; returns the file count per project.
export function writeEvalVault(vault: string, total: number): Map<string, number> {
  const rand = rng(42);
  const weight = PROJECTS.reduce((s, [, w]) => s + w, 0);
  const counts = new Map<string, number>();
  const now = Date.now() / 1000;
  for (const [project, w] of PROJECTS) {
    const dir = join(vault, 'projects', project);
    mkdirSync(dir, { recursive: true });
    const own = NEEDLES.filter((n) => n.project === project);
    const size = Math.round((total * w) / weight) - own.length;
    const names: string[] = [];
    for (let i = 0; i < size; i++) {
      const n = noise(project, i, names, rand);
      if (names.length < 2000) names.push(n.name);
      const path = join(dir, `${n.name}.md`);
      writeFileSync(path, noteText(n));
      const t = now - (size - i) * 30;
      utimesSync(path, t, t);
    }
    for (const n of own) writeFileSync(join(dir, `${n.name}.md`), noteText(n));
    counts.set(project, size + own.length);
  }
  return counts;
}
