import { basename } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { SERVICE_TOKENS_NAME, type Analytics, type OsSource, type DayTokens, type NamedTokens, type SessionInfo, type SessionStatus, type SubagentInfo, type TokenCounts } from '../../shared/contract.ts';
import { localDay } from './db.ts';
import type { LiveSession } from './live.ts';
import { within } from './projects.ts';

const SUMS = `COALESCE(SUM(u.input), 0) input, COALESCE(SUM(u.output), 0) output,
  COALESCE(SUM(u.cache_write), 0) cacheWrite, COALESCE(SUM(u.cache_read), 0) cacheRead`;

const zero = (): TokenCounts => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
function add(to: TokenCounts, r: TokenCounts): void {
  to.input += r.input;
  to.output += r.output;
  to.cacheWrite += r.cacheWrite;
  to.cacheRead += r.cacheRead;
}
const total = (t: TokenCounts) => t.input + t.output + t.cacheWrite;

interface SessionRow {
  id: string; project: string | null; cwd: string; kind: string; origin: string; name: string | null; title: string | null;
  last_prompt: string | null; first_activity: number | null; last_activity: number | null; status: string; pid: number | null;
}

export function querySessions(db: DatabaseSync, live: Map<string, LiveSession>, rootDir?: string, serviceDir?: string): SessionInfo[] {
  const rows = db.prepare('SELECT * FROM sessions WHERE removed = 0 ORDER BY last_activity DESC').all() as unknown as SessionRow[];
  const tokens = new Map<string, TokenCounts>();
  const agentTokens = new Map<string, number>();
  const usage = db.prepare(`SELECT u.session s, u.agent_id a, ${SUMS} FROM usage_messages u GROUP BY u.session, u.agent_id`).all() as unknown as (TokenCounts & { s: string; a: string | null })[];
  for (const r of usage) {
    let t = tokens.get(r.s);
    if (!t) tokens.set(r.s, t = zero());
    add(t, r);
    if (r.a) agentTokens.set(`${r.s}/${r.a}`, r.input + r.output + r.cacheWrite);
  }
  const agents = new Map<string, SubagentInfo[]>();
  const agentRows = db.prepare(`
    SELECT session s, id, agent_type agentType, description, last_activity lastActivity FROM subagents ORDER BY last_activity DESC
  `).all() as unknown as (Omit<SubagentInfo, 'tokens'> & { s: string })[];
  for (const { s, ...a } of agentRows) {
    const info = { ...a, tokens: agentTokens.get(`${s}/${a.id}`) ?? 0 };
    const list = agents.get(s);
    if (list) list.push(info);
    else agents.set(s, [info]);
  }
  const changes = new Map<string, { user: number; root: number }>();
  for (const c of db.prepare('SELECT session s, level, COUNT(*) n FROM os_changes GROUP BY session, level').all() as unknown as { s: string; level: 'user' | 'root'; n: number }[]) {
    const counted = changes.get(c.s) ?? { user: 0, root: 0 };
    counted[c.level] = c.n;
    changes.set(c.s, counted);
  }
  // A finished process that spent nothing and never wrote a journal is not a session to the user: there is nothing to open.
  const journals = new Set((db.prepare('SELECT path FROM file_offsets').all() as unknown as { path: string }[]).map((f) => basename(f.path, '.jsonl')));
  return rows.filter((r) => (live.has(r.id) || tokens.has(r.id) || journals.has(r.id))).map((r) => {
    const l = live.get(r.id);
    return {
      id: r.id,
      project: r.project,
      cwd: r.cwd,
      kind: r.kind,
      origin: r.origin === 'os' ? 'os' : 'external',
      name: r.name,
      title: r.title,
      lastPrompt: r.last_prompt,
      firstActivity: r.first_activity,
      lastActivity: r.last_activity,
      status: (l?.status ?? 'ended') as SessionStatus,
      pid: l?.pid ?? null,
      tokens: tokens.get(r.id) ?? zero(),
      subagents: agents.get(r.id) ?? [],
      ...(rootDir && (r.cwd === rootDir || r.cwd.startsWith(`${rootDir}/`)) ? { rootFolder: true } : {}),
      ...(serviceDir && within(r.cwd, serviceDir) ? { serviceFolder: true } : {}),
      ...(changes.has(r.id) ? { osChanges: changes.get(r.id) } : {}),
    };
  });
}

export function defaultRange(now = Date.now()): { from: string; to: string } {
  return { from: localDay(now - 29 * 86_400_000), to: localDay(now) };
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_RANGE_DAYS = 3660;

/** The range of an analytics request, the last 30 days by default; null when it is not a real one. */
export function parseRange(q: { from?: string; to?: string }): { from: string; to: string } | null {
  const dflt = defaultRange();
  const from = q.from ?? dflt.from;
  const to = q.to ?? dflt.to;
  if (!DAY_RE.test(from) || !DAY_RE.test(to) || from > to) return null;
  if (daysBetween(from, from).length !== 1 || daysBetween(to, to).length !== 1 || (Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS) return null;
  return { from, to };
}

export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  // Noon keeps the step safe across DST changes.
  const end = new Date(`${to}T12:00:00`);
  for (let d = new Date(`${from}T12:00:00`); d <= end; d.setDate(d.getDate() + 1)) days.push(localDay(d.getTime()));
  return days;
}

export function queryAnalytics(db: DatabaseSync, from: string, to: string, projectName: (key: string) => string, serviceDir?: string, rootDir?: string, setupDir?: string): Analytics {
  // One aggregate per (day, session, model, side); every breakdown is folded from it.
  const rows = db.prepare(`
    SELECT u.day, u.session, u.model, u.is_subagent sub, ${SUMS}, COUNT(*) messages
    FROM usage_messages u WHERE u.day BETWEEN ? AND ? GROUP BY u.day, u.session, u.model, u.is_subagent
  `).all(from, to) as unknown as (TokenCounts & { day: string; session: string; model: string | null; sub: number; messages: number })[];
  const sessions = new Map((db.prepare(`
    SELECT id, project, origin, cwd, os_source source, COALESCE(title, name, last_prompt, id) label FROM sessions
  `).all() as unknown as { id: string; project: string | null; origin: string; cwd: string; source: OsSource | '' | null; label: string }[]).map((s) => [s.id, s]));
  // A document tab works in the root folder too: the session it holds is the user's, whatever its folder.
  const hasTabs = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'tabs'").get();
  const userTabs = new Set(hasTabs ? (db.prepare("SELECT session_id s FROM tabs WHERE kind IN ('work', 'document') AND session_id IS NOT NULL").all() as unknown as { s: string }[]).map((r) => r.s) : []);
  // '' was marked as the user's work. Sessions marked before the source was recorded are told by their folder.
  const sourceOf = (s: { id: string; origin: string; cwd: string; source: OsSource | '' | null } | undefined): OsSource | null => {
    if (!s || s.origin !== 'os') return null;
    if (s.source !== null) return s.source || null;
    if (rootDir && within(s.cwd, rootDir) && !userTabs.has(s.id)) return 'root';
    if (serviceDir && within(s.cwd, serviceDir)) return 'service';
    if (setupDir && within(s.cwd, setupDir)) return 'setup';
    return null;
  };

  const out = { all: zero(), main: zero(), sub: zero(), os: zero() };
  const days = new Map<string, TokenCounts>();
  const folded = (m: Map<string, NamedTokens>, key: string, name: string) => {
    let t = m.get(key);
    if (!t) m.set(key, t = { ...zero(), name, messages: 0 });
    return t;
  };
  const byProject = new Map<string, NamedTokens>();
  const byModel = new Map<string, NamedTokens>();
  const bySession = new Map<string, NamedTokens>();
  const bySource = new Map<string, NamedTokens>();
  for (const r of rows) {
    const s = sessions.get(r.session);
    add(out.all, r);
    add(r.sub ? out.sub : out.main, r);
    if (s?.origin === 'os') add(out.os, r);
    let d = days.get(r.day);
    if (!d) days.set(r.day, d = zero());
    add(d, r);
    // Service jobs count in every total under their own name, and are no conversation to list among the sessions.
    const service = Boolean(serviceDir && s && within(s.cwd, serviceDir));
    const source = sourceOf(s);
    for (const t of [
      ...(source ? [folded(bySource, source, source)] : []),
      service ? folded(byProject, SERVICE_TOKENS_NAME, SERVICE_TOKENS_NAME) : folded(byProject, s?.project ?? '', s?.project ? projectName(s.project) : '—'),
      folded(byModel, r.model ?? '', r.model ?? '—'),
      ...(service ? [] : [folded(bySession, r.session, s?.label ?? r.session)]),
    ]) {
      add(t, r);
      t.messages += r.messages;
    }
  }
  const ranked = (m: Map<string, NamedTokens>) => [...m.entries()].sort((a, b) => total(b[1]) - total(a[1]));

  const rateLimits = db.prepare(`
    SELECT r.session sessionId, r.received_at receivedAt, r.raw FROM rate_limits r
    JOIN sessions s ON s.id = r.session AND s.origin = 'os' ORDER BY r.received_at DESC LIMIT 20
  `).all() as unknown as { sessionId: string; receivedAt: number; raw: string }[];

  // cost-state is cumulative per session, so a session counts where its last activity falls.
  const cost = db.prepare(`
    SELECT SUM(cost_usd) c FROM sessions WHERE cost_usd IS NOT NULL AND last_activity BETWEEN ? AND ?
  `).get(new Date(`${from}T00:00:00`).getTime(), new Date(`${to}T23:59:59.999`).getTime()) as { c: number | null };

  return {
    from,
    to,
    total: out.all,
    main: out.main,
    subagents: out.sub,
    osShare: out.os,
    byDay: daysBetween(from, to).map((day): DayTokens => ({ day, ...(days.get(day) ?? zero()) })),
    byProject: ranked(byProject).map(([, t]) => t),
    byModel: ranked(byModel).map(([, t]) => t),
    bySource: ranked(bySource).map(([, t]) => t),
    topSessions: ranked(bySession).slice(0, 20).map(([id, t]) => ({ ...t, sessionId: id, project: sessions.get(id)?.project ?? null })),
    rateLimits: rateLimits.map((r) => ({ sessionId: r.sessionId, receivedAt: r.receivedAt, raw: JSON.parse(r.raw) as unknown })),
    costEquivalentUsd: cost.c,
  };
}
