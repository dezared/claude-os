import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, test } from 'node:test';
import Fastify from 'fastify';
import type { KitLock } from '../../shared/projectKit.ts';
import { initSchema, localDay } from '../journal/db.ts';
import { kitMetrics, kitProjects, registerKitMetrics } from './kitMetrics.ts';

const DAY = 86_400_000;
const installedAt = new Date(2026, 9, 20, 12).getTime();
const RANGE = { from: '2026-10-01', to: '2026-10-31' };

const base = mkdtempSync(join(tmpdir(), 'cos-kit-metrics-'));
after(() => rmSync(base, { recursive: true, force: true }));

let n = 0;
function project(files: Record<string, string> = {}, key = 'alpha') {
  const root = join(base, `p${n++}`);
  const lock: KitLock = { kit: '1.0.0', installedAt, sizeAtInstall: 4, files: {}, settings: { file: '.claude/settings.json', allow: [], deny: [], ask: [], hooks: [] } };
  for (const [path, text] of Object.entries({ '.claude/kit/lock.json': JSON.stringify(lock), ...files })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { key, name: key.toUpperCase(), root, lock };
}

function journal() {
  const db = new DatabaseSync(':memory:');
  initSchema(db);
  let id = 0;
  return {
    db,
    session(sid: string, key = 'alpha') {
      db.prepare('INSERT INTO sessions (id, project) VALUES (?, ?)').run(sid, key);
    },
    message(sid: string, ts: number, t: { input?: number; output?: number; read?: number; write?: number; sub?: boolean }) {
      db.prepare('INSERT INTO usage_messages (message_id, session, agent_id, ts, day, model, is_subagent, input, output, cache_read, cache_write) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(`m${id++}`, sid, t.sub ? 'a1' : null, ts, localDay(ts), 'claude-opus', t.sub ? 1 : 0, t.input ?? 0, t.output ?? 0, t.read ?? 0, t.write ?? 0);
    },
    tool(sid: string, ts: number, name: string, skill: string | null = null) {
      db.prepare('INSERT INTO tool_calls (id, name, skill, session, ts) VALUES (?, ?, ?, ?, ?)').run(`t${id++}`, name, skill, sid, ts);
    },
  };
}

test('before and after split at installedAt', () => {
  const j = journal();
  j.session('s1');
  j.message('s1', installedAt - 3 * DAY, { input: 100, read: 900 });
  j.session('s2');
  j.message('s2', installedAt + 2 * DAY, { input: 50, read: 950 });
  j.message('s2', installedAt - 20 * DAY, { input: 1000 }); // older than the 14 days before
  const row = kitMetrics(j.db, project(), RANGE, null);
  assert.equal(row.kit, '1.0.0');
  assert.equal(row.installedAt, installedAt);
  assert.deepEqual(row.metrics.cacheHit, { before: 0.9, after: 0.95 });

  j.session('b1', 'beta');
  j.message('b1', installedAt + DAY, { input: 10, read: 90 });
  assert.deepEqual(kitMetrics(j.db, project({}, 'beta'), RANGE, null).metrics.cacheHit, { before: null, after: 0.9 });
  // A range that starts after the install narrows the after side only.
  assert.equal(kitMetrics(j.db, project(), { from: '2026-10-25', to: '2026-10-31' }, null).metrics.cacheHit.after, null);
});

test('cache hit counts main messages only', () => {
  const j = journal();
  j.session('s1');
  j.message('s1', installedAt + DAY, { input: 100, read: 900 });
  j.message('s1', installedAt + DAY + 1000, { input: 1000, sub: true });
  const { metrics } = kitMetrics(j.db, project(), RANGE, null);
  assert.equal(metrics.cacheHit.after, 0.9);
  assert.equal(metrics.subagentShare.after, 1000 / 1100);
});

test('starting context is the median of first main messages', () => {
  const j = journal();
  for (const [sid, first] of [['s1', 10_000], ['s2', 30_000], ['s3', 20_000]] as const) {
    j.session(sid);
    j.message(sid, installedAt + DAY - 5000, { input: 1, sub: true }); // a subagent message first is not the start
    j.message(sid, installedAt + DAY, { input: first - 3000, read: 2000, write: 1000 });
    j.message(sid, installedAt + DAY + 5000, { input: 500_000 });
  }
  assert.equal(kitMetrics(j.db, project(), RANGE, null).metrics.startingContext.after, 20_000);
});

test('loop times are p50 and p90 of the hook metrics', () => {
  const j = journal();
  j.session('s1');
  j.message('s1', installedAt + DAY, { input: 1 });
  j.session('s2');
  j.message('s2', installedAt + DAY, { input: 1 });
  const at = installedAt + DAY;
  const lines = [
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((s) => ({ hook: 'after-edit', ms: s * 1000, ok: true, ts: at })),
    { hook: 'stop-gate', ms: 20_000, ok: true, ts: at },
    { hook: 'stop-gate', ms: 40_000, ok: true, ts: at },
    { hook: 'stop-gate', ms: 60_000, ok: false, ts: at },
    { hook: 'stop-gate', ms: 999_000, ok: false, ts: installedAt - DAY }, // before the install
  ].map((m) => JSON.stringify(m));
  const text = `${lines.join('\n')}\nnot json\n`;
  const git = project({ '.git/claude-kit/metrics.jsonl': text, '.git/HEAD': 'ref: refs/heads/main\n' });
  const { metrics } = kitMetrics(j.db, git, RANGE, null);
  assert.deepEqual(
    [metrics.loopA50, metrics.loopA90, metrics.loopB50, metrics.loopB90],
    [{ before: null, after: 5000 }, { before: null, after: 9000 }, { before: null, after: 40_000 }, { before: null, after: 60_000 }],
  );
  assert.deepEqual(metrics.redStops, { before: null, after: 0.5 });
  // A folder without git keeps the metrics inside the kit folder.
  const plain = project({ '.claude/kit/state/metrics.jsonl': text });
  assert.equal(kitMetrics(j.db, plain, RANGE, null).metrics.loopA90.after, 9000);
  assert.equal(kitMetrics(j.db, project(), RANGE, null).metrics.loopA50.after, null);
});

test('a project nested in a parent git repo reads the hook metrics of that repo', () => {
  const j = journal();
  j.session('s1');
  j.message('s1', installedAt + DAY, { input: 1 });
  const parent = mkdtempSync(join(tmpdir(), 'cos-kit-parent-'));
  try {
    const root = join(parent, 'app');
    const lock: KitLock = { kit: '1.0.0', installedAt, sizeAtInstall: 0, files: {}, settings: { file: '.claude/settings.json', allow: [], deny: [], ask: [], hooks: [] } };
    const files = {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.git/claude-kit/metrics.jsonl': `${JSON.stringify({ hook: 'after-edit', ms: 3000, ok: true, ts: installedAt + DAY })}\n`,
      'app/.claude/kit/lock.json': JSON.stringify(lock),
    };
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(parent, path)), { recursive: true });
      writeFileSync(join(parent, path), text);
    }
    assert.equal(kitMetrics(j.db, { key: 'app', name: 'App', root, lock }, RANGE, null).metrics.loopA50.after, 3000);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('ledger debts count rows by the spec rules', () => {
  const day = (ago: number) => localDay(Date.now() - ago * DAY);
  const p = project({
    '.claude/kit/kit.json': JSON.stringify({ docsDir: 'dev-docs' }),
    '.claude/kit/size-baseline.json': JSON.stringify({ 'src/a.ts': 420, 'src/b.ts': 350 }),
    'dev-docs/rules/common-mistakes.md': [
      '# Mistake ledger', '', '| Mistake | Seen | Last | Fix |', '| --- | --- | --- | --- |',
      '| Seen twice, nothing enforces it | 2 | 2026-11-01 |  |',
      '| Seen three times, a lint rule now | 3 | 2026-11-01 | `no-foo` in .oxlintrc.json |',
      '| Seen once | 1 | 2026-11-01 | |',
      '| A pipe \\| inside, seen four times | 4 | 2026-11-01 | |',
    ].join('\n'),
    'dev-docs/rules/pattern-candidates.md': [
      '| First seen | Pattern | Count | Minutes each | Proposed form | Status |', '| --- | --- | --- | --- | --- | --- |',
      `| ${day(30)} | Old, no form | 3 | 10 |  | open |`,
      `| ${day(30)} | Old, with a form | 3 | 10 | a skill | open |`,
      `| ${day(5)} | New, no form | 2 | 10 |  | open |`,
    ].join('\n'),
  });
  const { metrics } = kitMetrics(journal().db, p, RANGE, null);
  assert.deepEqual(metrics.unpromotedMistakes, { before: null, after: 2 });
  assert.deepEqual(metrics.patternDebt, { before: null, after: 1 });
  assert.deepEqual(metrics.filesOverLimit, { before: 4, after: 2 });
  // No ledgers: nothing to count, not zero.
  assert.equal(kitMetrics(journal().db, project(), RANGE, null).metrics.unpromotedMistakes.after, null);
});

test('skills used, visible skills and questions per session', () => {
  const j = journal();
  const p = project({
    '.claude/skills/spec/SKILL.md': '---\nname: spec\ndisable-model-invocation: true\n---\nBody\n',
    '.claude/skills/mine/SKILL.md': '---\nname: mine\n---\nBody\n',
    '.claude/skills/empty/notes.txt': 'not a skill',
    '.claude/agents/reviewer.md': '---\nname: reviewer\n---\n',
  });
  for (const sid of ['s1', 's2']) {
    j.session(sid);
    j.message(sid, installedAt + DAY, { input: 1 });
  }
  j.tool('s1', installedAt + DAY, 'Skill', 'spec');
  j.tool('s1', installedAt + DAY, 'Skill', 'superpowers:brainstorming');
  j.tool('s1', installedAt + DAY, 'AskUserQuestion');
  j.tool('s2', installedAt + DAY, 'AskUserQuestion');
  j.session('s0');
  j.message('s0', installedAt - DAY, { input: 1 });
  const row = kitMetrics(j.db, p, RANGE, 'minimal');
  assert.equal(row.questionLevel, 'minimal');
  assert.deepEqual(row.metrics.skillsUsed, { before: null, after: 0.5 });
  assert.deepEqual(row.metrics.visibleSkills, { before: null, after: 2 });
  assert.deepEqual(row.metrics.questions, { before: 0, after: 1 });
});

test('a project without a lock is not listed', () => {
  const kit = project();
  const bare = join(base, 'bare');
  mkdirSync(bare, { recursive: true });
  const broken = project({ '.claude/kit/lock.json': '{ not json' }, 'broken');
  const listed = kitProjects([{ key: 'alpha', name: 'Alpha', root: kit.root }, { key: 'bare', name: 'Bare', root: bare }, { key: 'broken', name: 'Broken', root: broken.root }]);
  assert.deepEqual(listed.map((p) => p.key), ['alpha']);
  assert.equal(listed[0].lock.installedAt, installedAt);
});

test('the route rejects a bad range', async () => {
  const j = journal();
  const p = project();
  const app = Fastify();
  const bus = new EventEmitter();
  const ctx = { app, db: j.db, bus, journal: { listProjects: () => [{ ...p, misc: false }] }, settings: { profile: () => ({ questionLevel: 'balanced' }) } };
  registerKitMetrics(ctx as never);
  assert.equal((await app.inject({ url: '/api/analytics/kit?from=x&to=y' })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/analytics/kit?from=2026-10-31&to=2026-10-01' })).statusCode, 400);
  assert.equal((await app.inject({ url: '/api/analytics/kit?from=2026-13-40&to=2026-13-41' })).statusCode, 400);

  const url = `/api/analytics/kit?from=${RANGE.from}&to=${RANGE.to}`;
  const first = (await app.inject({ url })).json();
  assert.deepEqual(first.map((r: { project: string; questionLevel: string }) => [r.project, r.questionLevel]), [['alpha', 'balanced']]);
  assert.equal(first[0].metrics.cacheHit.after, null);
  // Cached per range until the journal moves.
  j.session('s1');
  j.message('s1', installedAt + DAY, { input: 10, read: 90 });
  assert.equal((await app.inject({ url })).json()[0].metrics.cacheHit.after, null);
  bus.emit('turn-finished', 'tab');
  assert.equal((await app.inject({ url })).json()[0].metrics.cacheHit.after, 0.9);
  await app.close();
});
