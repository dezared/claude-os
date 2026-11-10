// Project kit metrics (spec section 7): SQL over the journal plus a few small files in the project. No Claude call.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { QuestionLevel } from '../../shared/contract.ts';
import type { KitConfig, KitHook, KitHookMetric, KitLock, KitMetricValue, KitMetricsRow } from '../../shared/projectKit.ts';
import type { Ctx } from '../context.ts';
import { parseRange } from '../journal/queries.ts';
import { safely } from '../memory/util.ts';

const DAY_MS = 86_400_000;
const BEFORE_MS = 14 * DAY_MS;
const SKILLS_MS = 30 * DAY_MS;
const DEBT_MS = 21 * DAY_MS;

type KitProject = { key: string; name: string; root: string; lock: KitLock };
/** Milliseconds, `to` excluded. */
interface Span { from: number; to: number }
interface JournalNumbers { sessions: number; startingContext: number | null; cacheHit: number | null; subagentShare: number | null; questions: number | null }

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readText(path) ?? 'null');
  } catch {
    return null;
  }
}

function listDir(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => !name.startsWith('.'));
  } catch {
    return [];
  }
}

export function kitProjects(projects: { key: string; name: string; root: string }[]): KitProject[] {
  return projects.flatMap(({ key, name, root }) => {
    const lock = readJson(join(root, '.claude', 'kit', 'lock.json')) as KitLock | null;
    return typeof lock?.installedAt === 'number' ? [{ key, name, root, lock }] : [];
  });
}

const ratio = (part: number | null, whole: number | null): number | null => (whole ? (part ?? 0) / whole : null);

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Nearest rank: the smallest sample with at least q of the samples at or below it.
function percentile(values: number[], q: number): number | null {
  if (values.length === 0) return null;
  return [...values].sort((a, b) => a - b)[Math.ceil(q * values.length) - 1];
}

function journalNumbers(db: DatabaseSync, key: string, s: Span): JournalNumbers {
  // Tokens are input + output + cache_write, as everywhere in the analytics; the cache hit is over everything sent.
  const t = db.prepare(`
    SELECT COUNT(DISTINCT u.session) sessions,
      SUM(CASE WHEN u.is_subagent = 0 THEN u.cache_read END) hit,
      SUM(CASE WHEN u.is_subagent = 0 THEN u.input + u.cache_read + u.cache_write END) sent,
      SUM(CASE WHEN u.is_subagent = 1 THEN u.input + u.output + u.cache_write END) sub,
      SUM(u.input + u.output + u.cache_write) total
    FROM usage_messages u JOIN sessions s ON s.id = u.session
    WHERE s.project = ? AND u.ts >= ? AND u.ts < ?
  `).get(key, s.from, s.to) as { sessions: number; hit: number | null; sent: number | null; sub: number | null; total: number | null };
  // With one MIN() SQLite takes the other columns from the row that holds the minimum: the session's first main message.
  const starts = db.prepare(`
    SELECT MIN(u.ts) ts, u.input + u.cache_read + u.cache_write n
    FROM usage_messages u JOIN sessions s ON s.id = u.session
    WHERE s.project = ? AND u.is_subagent = 0 GROUP BY u.session HAVING ts >= ? AND ts < ?
  `).all(key, s.from, s.to) as unknown as { n: number }[];
  const asked = db.prepare(`
    SELECT COUNT(*) n FROM tool_calls c JOIN sessions s ON s.id = c.session
    WHERE s.project = ? AND c.name = 'AskUserQuestion' AND c.ts >= ? AND c.ts < ?
  `).get(key, s.from, s.to) as { n: number };
  return {
    sessions: t.sessions,
    startingContext: median(starts.map((r) => r.n)),
    cacheHit: ratio(t.hit, t.sent),
    subagentShare: ratio(t.sub, t.total),
    questions: ratio(asked.n, t.sessions),
  };
}

function skillsUsed(db: DatabaseSync, key: string, names: string[], s: Span): number | null {
  if (names.length === 0) return null;
  const used = new Set((db.prepare(`
    SELECT DISTINCT c.skill FROM tool_calls c JOIN sessions s ON s.id = c.session
    WHERE s.project = ? AND c.skill IS NOT NULL AND c.ts >= ? AND c.ts < ?
  `).all(key, s.from, s.to) as unknown as { skill: string }[]).map((r) => r.skill));
  return names.filter((n) => used.has(n)).length / names.length;
}

function projectSkills(root: string): { name: string; hidden: boolean }[] {
  const dir = join(root, '.claude', 'skills');
  return listDir(dir).flatMap((name) => {
    const text = readText(join(dir, name, 'SKILL.md'));
    if (text === null) return [];
    const front = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? '';
    return [{ name, hidden: /^disable-model-invocation:\s*true\s*$/m.test(front) }];
  });
}

// The nearest `.git` upward, as git finds it: a project may sit inside a parent repo.
function dotGitOf(root: string): string | null {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.git'))) return join(dir, '.git');
    if (dirname(dir) === dir) return null;
  }
}

function gitCommonDir(root: string): string | null {
  const dotGit = dotGitOf(root);
  if (!dotGit) return null;
  if (safely(() => statSync(dotGit).isDirectory(), false)) return dotGit;
  // A worktree or a submodule: `.git` names its git dir, whose `commondir` leads to the shared one.
  const dir = resolve(dirname(dotGit), (readText(dotGit) ?? '').replace(/^gitdir:/, '').trim());
  const common = readText(join(dir, 'commondir'));
  return common ? resolve(dir, common.trim()) : dir;
}

// The kit hooks append their runs outside the tracked tree: the git common dir, or the kit folder without git.
function hookRuns(root: string, s: Span): KitHookMetric[] {
  const git = gitCommonDir(root);
  const file = git ? join(git, 'claude-kit', 'metrics.jsonl') : join(root, '.claude', 'kit', 'state', 'metrics.jsonl');
  return (readText(file) ?? '').split('\n').flatMap((line) => {
    try {
      const m = JSON.parse(line) as KitHookMetric;
      return m.ts >= s.from && m.ts < s.to ? [m] : [];
    } catch {
      return [];
    }
  });
}

// A ledger's markdown table: lowercased header cells and the body rows; `\|` stays inside a cell.
function ledgerTable(path: string): { header: string[]; rows: string[][] } {
  const cells = (line: string) => line.trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim());
  const [head = [], ...body] = (readText(path) ?? '').split('\n').filter((l) => l.trim().startsWith('|')).map(cells);
  return { header: head.map((h) => h.toLowerCase()), rows: body.filter((r) => !r.every((c) => /^:?-+:?$/.test(c))) };
}

// The ledger says: at Seen 2 a mistake gets enforcement, named in its Fix cell.
function unpromotedMistakes(path: string): number | null {
  const { header, rows } = ledgerTable(path);
  const [seen, fix] = [header.indexOf('seen'), header.indexOf('fix')];
  if (seen < 0 || fix < 0) return null;
  return rows.filter((r) => Number(r[seen]) >= 2 && !r[fix]).length;
}

function patternDebt(path: string, now: number): number | null {
  const { header, rows } = ledgerTable(path);
  const [first, form] = [header.indexOf('first seen'), header.indexOf('proposed form')];
  if (first < 0 || form < 0) return null;
  return rows.filter((r) => now - Date.parse(r[first]) > DEBT_MS && !r[form]).length;
}

function dayEnd(day: string): number {
  const d = new Date(`${day}T00:00:00`);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/** Before: the 14 days before the install. After: from the install or the range start, whichever is later, to the range end. */
export function kitMetrics(db: DatabaseSync, p: KitProject, range: { from: string; to: string }, level: QuestionLevel | null): KitMetricsRow {
  const { key, root, lock } = p;
  const before = journalNumbers(db, key, { from: lock.installedAt - BEFORE_MS, to: lock.installedAt });
  const span = { from: Math.max(lock.installedAt, new Date(`${range.from}T00:00:00`).getTime()), to: dayEnd(range.to) };
  const after = journalNumbers(db, key, span);
  const both = (k: keyof JournalNumbers): KitMetricValue => ({ before: before[k], after: after[k] });
  // The rest has no history from before the install: the hooks, skills and ledgers came with the kit.
  const now = (v: number | null): KitMetricValue => ({ before: null, after: v });
  const runs = hookRuns(root, span);
  const ms = (hook: KitHook) => runs.filter((m) => m.hook === hook).map((m) => m.ms);
  const skills = projectSkills(root);
  const docs = (readJson(join(root, '.claude', 'kit', 'kit.json')) as Partial<KitConfig> | null)?.docsDir ?? 'docs';
  const baseline = readJson(join(root, '.claude', 'kit', 'size-baseline.json'));
  return {
    project: key,
    name: p.name,
    kit: lock.kit,
    installedAt: lock.installedAt,
    questionLevel: level,
    metrics: {
      startingContext: both('startingContext'),
      cacheHit: both('cacheHit'),
      subagentShare: both('subagentShare'),
      skillsUsed: now(skillsUsed(db, key, skills.map((s) => s.name), { from: Math.max(lock.installedAt, span.to - SKILLS_MS), to: span.to })),
      visibleSkills: now(skills.filter((s) => !s.hidden).length + listDir(join(root, '.claude', 'agents')).filter((f) => f.endsWith('.md')).length),
      loopA50: now(percentile(ms('after-edit'), 0.5)),
      loopA90: now(percentile(ms('after-edit'), 0.9)),
      loopB50: now(percentile(ms('stop-gate'), 0.5)),
      loopB90: now(percentile(ms('stop-gate'), 0.9)),
      redStops: now(ratio(runs.filter((m) => m.hook === 'stop-gate' && !m.ok).length, after.sessions)),
      filesOverLimit: { before: lock.sizeAtInstall, after: baseline && typeof baseline === 'object' ? Object.keys(baseline).length : null },
      unpromotedMistakes: now(unpromotedMistakes(join(root, docs, 'rules', 'common-mistakes.md'))),
      patternDebt: now(patternDebt(join(root, docs, 'rules', 'pattern-candidates.md'), Date.now())),
      questions: both('questions'),
    },
  };
}

/** GET /api/analytics/kit, cached per range like /api/analytics until the journal moves; the returned call drops the cache (a kit apply). */
export function registerKitMetrics(ctx: Ctx): () => void {
  let cache: { range: string; value: KitMetricsRow[] } | null = null;
  const drop = () => {
    cache = null;
  };
  ctx.bus.on('sessions-changed', drop);
  ctx.bus.on('turn-finished', drop);
  ctx.app.get<{ Querystring: { from?: string; to?: string } }>('/api/analytics/kit', async (req, reply) => {
    const range = parseRange(req.query);
    if (!range) return reply.code(400).send({ error: 'bad range' });
    const id = `${range.from}/${range.to}`;
    if (cache?.range !== id) {
      const level = ctx.settings?.profile()?.questionLevel ?? null;
      cache = { range: id, value: kitProjects(ctx.journal.listProjects(true)).map((p) => kitMetrics(ctx.db, p, range, level)) };
    }
    return cache.value;
  });
  return drop;
}
