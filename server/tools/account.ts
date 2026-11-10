// Plan and limits. The CLI gets them from claude.ai with its own login: Claude OS never reads credentials and sends no prompt.
import type { DatabaseSync } from 'node:sqlite';
import type { AccountStatus, LimitWindow } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { probeCli } from '../chat/probe.ts';
import { safely } from '../memory/util.ts';
import { readJson } from './shared.ts';

const LIVE_TTL_MS = 60_000;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const ms = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
};
const pct = (v: unknown): number | null => (typeof v === 'number' ? v : null);

// The server's rows when it sends them: which meters apply and their order are its business. Older answers have named windows.
export function limitWindows(rateLimits: unknown): LimitWindow[] {
  if (!isObj(rateLimits)) return [];
  if (Array.isArray(rateLimits.limits)) {
    return rateLimits.limits.filter(isObj).map((r) => {
      const scope = isObj(r.scope) ? r.scope : null;
      const model = isObj(scope?.model) ? scope.model : null;
      const surface = isObj(scope?.surface) ? scope.surface : null;
      return {
        kind: String(r.kind ?? ''),
        label: typeof model?.display_name === 'string' ? model.display_name : typeof surface?.display_name === 'string' ? surface.display_name : null,
        percent: pct(r.percent),
        resetsAt: ms(r.resets_at),
        severity: typeof r.severity === 'string' ? r.severity : null,
        active: r.is_active === true,
      };
    });
  }
  const out: LimitWindow[] = [];
  for (const [key, kind, label] of [['five_hour', 'session', null], ['seven_day', 'weekly_all', null], ['seven_day_opus', 'weekly_scoped', 'Opus'], ['seven_day_sonnet', 'weekly_scoped', 'Sonnet']] as const) {
    const w = rateLimits[key];
    if (isObj(w)) out.push({ kind, label, percent: pct(w.utilization), resetsAt: ms(w.resets_at), severity: null, active: false });
  }
  return out;
}

function headline(list: LimitWindow[]): LimitWindow[] {
  if (list.some((w) => w.active) || list.length === 0) return list;
  const top = list.reduce((a, b) => ((b.percent ?? -1) > (a.percent ?? -1) ? b : a));
  return list.map((w) => ({ ...w, active: w === top }));
}

function readEvents(db: DatabaseSync | null): AccountStatus['events'] {
  if (!db) return [];
  const rows = safely(() => db.prepare(`
    SELECT r.kind, r.received_at at, r.raw FROM rate_limits r JOIN sessions s ON s.id = r.session AND s.origin = 'os'
    ORDER BY r.received_at DESC LIMIT 12
  `).all() as unknown as { kind: string; at: number; raw: string }[], []);
  const seen = new Set<string>();
  const out: AccountStatus['events'] = [];
  for (const r of rows) {
    if (seen.has(r.kind)) continue;
    seen.add(r.kind);
    const info = (safely(() => JSON.parse(r.raw) as { rate_limit_info?: Obj }, {}) as { rate_limit_info?: Obj }).rate_limit_info ?? {};
    const resets = typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null;
    // The SDK does not state the scale here. The unified limit headers are 0..1 fractions; the usage answer is in percents.
    const u = typeof info.utilization === 'number' ? (info.utilization <= 1 ? info.utilization * 100 : info.utilization) : null;
    out.push({ type: r.kind, status: typeof info.status === 'string' ? info.status : null, utilization: u, resetsAt: resets, receivedAt: r.at });
  }
  return out;
}

export function createAccount(ctx: Ctx) {
  let live: { at: number; plan: string | null; billing: AccountStatus['billing']; windows: LimitWindow[]; available: boolean } | null = null;
  let error: string | null = null;
  let inflight: Promise<void> | null = null;

  function fetchLive(): Promise<void> {
    inflight ??= probeCli(ctx, ctx.paths.root, false, async (q) => {
      const account = await q.accountInfo();
      const usage = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
      return { account, usage };
    }).then(({ account, usage }) => {
      const firstParty = !account.apiProvider || account.apiProvider === 'firstParty';
      const plan = account.subscriptionType ?? usage.subscription_type ?? null;
      const billing: AccountStatus['billing'] = !firstParty || account.apiKeySource ? 'api' : plan ? 'subscription' : 'unknown';
      live = { at: Date.now(), plan, billing, windows: limitWindows(usage.rate_limits), available: usage.rate_limits_available };
      error = null;
    }).catch((err: Error) => {
      error = err.message.split('\n')[0];
      ctx.app.log.warn(err);
    }).finally(() => {
      inflight = null;
    });
    return inflight;
  }

  // What the CLI itself wrote last. No token, no secret: only the fields named here leave the file.
  function fromDisk() {
    const json = readJson<{ oauthAccount?: { planDisplayName?: unknown; billingType?: unknown }; cachedUsageUtilization?: { fetchedAtMs?: unknown; utilization?: unknown } }>(ctx.paths.claudeJson);
    const plan = typeof json?.oauthAccount?.planDisplayName === 'string' ? json.oauthAccount.planDisplayName : null;
    const billing: AccountStatus['billing'] = /subscription/.test(String(json?.oauthAccount?.billingType ?? '')) ? 'subscription' : 'unknown';
    const cache = json?.cachedUsageUtilization;
    return { plan, billing, windows: limitWindows(cache?.utilization), at: typeof cache?.fetchedAtMs === 'number' ? cache.fetchedAtMs : null };
  }

  async function status(force: boolean): Promise<AccountStatus> {
    const fresh = live && Date.now() - live.at < (force ? 5000 : LIVE_TTL_MS);
    if (!fresh) await fetchLive();
    const events = readEvents(ctx.db ?? null);
    if (live && (live.windows.length > 0 || !live.available)) {
      return { plan: live.plan, planSource: 'cli', billing: live.billing, windows: headline(live.windows), source: 'usage', receivedAt: live.at, error, events };
    }
    const disk = fromDisk();
    const plan = live?.plan ?? disk.plan;
    const planSource = live?.plan ? 'cli' : disk.plan ? 'claude_json' : null;
    const billing = live?.billing ?? disk.billing;
    if (disk.windows.length > 0) return { plan, planSource, billing, windows: headline(disk.windows), source: 'cache', receivedAt: disk.at, error, events };
    return { plan, planSource, billing, windows: [], source: events.length > 0 ? 'events' : 'none', receivedAt: events[0]?.receivedAt ?? null, error, events };
  }

  return { status };
}
