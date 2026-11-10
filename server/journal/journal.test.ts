import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, it } from 'node:test';
import Fastify from 'fastify';
import type { Analytics, ChatEvent, IndexStatus, Overview, Project, SessionInfo } from '../../shared/contract.ts';
import type { BusEvents, Ctx, Paths } from '../context.ts';
import { createJournal, hiddenRoot } from './index.ts';
import { computeLive, mapStatus, procStartOf, type RegistryEntry } from './live.ts';
import { KNOWN_TYPES, LineSplitter, parseLine, parseRecord, parseTitles, parseToolCalls, parseUsage, readTranscript, recordToChatEvents } from './parse.ts';
import { classifyDir, createProjects, gitRoot, gitRootAsync } from './projects.ts';
import { initSchema } from './db.ts';
import { keepPastedTags, stripPastedTags } from '../../shared/pasted.ts';

const assistant = (id: string, usage: object | null, extra: object = {}, content: unknown[] = [], model = 'claude-test') => ({
  parentUuid: null, isSidechain: false, type: 'assistant', uuid: `u-${Math.random()}`, timestamp: '2026-10-20T10:00:00.000Z',
  cwd: '/nonexistent/app', entrypoint: 'cli', version: '9.9.9', sessionId: 'S',
  message: { id, model, role: 'assistant', content, usage }, ...extra,
});
const usage = (i: number, o: number, w: number, r: number) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: w, cache_read_input_tokens: r });
const lines = (...recs: unknown[]) => recs.map((r) => JSON.stringify(r)).join('\n') + '\n';

function tmp() { return mkdtempSync(join(tmpdir(), 'journal-test-')); }

describe('parse', () => {
  it('usage skips synthetic and reads every field', () => {
    assert.equal(parseUsage(assistant('m', usage(1, 2, 3, 4), {}, [], '<synthetic>')), null);
    assert.deepEqual(parseUsage(assistant('m', usage(1, 2, 3, 4))), { messageId: 'm', model: 'claude-test', input: 1, output: 2, cacheRead: 4, cacheWrite: 3 });
  });

  it('every type seen on the machine is known, others count as unknown', () => {
    for (const t of ['assistant', 'user', 'system', 'attachment', 'queue-operation', 'api-request', 'api-request-blob', 'api-request-shape',
      'last-prompt', 'mode', 'permission-mode', 'atis-latch', 'ai-title', 'tools-used', 'file-history-snapshot', 'file-history-delta',
      'session-owner', 'bridge-session', 'frame-link', 'cost-state', 'artifact-comment-monitor', 'artifact-autoreact-ledger']) {
      assert.ok(KNOWN_TYPES.has(t), t);
    }
    assert.equal(parseRecord({ type: 'brand-new' }).known, false);
    assert.equal(parseRecord({ noType: 1 }).known, false);
  });

  it('an assistant record that lost its usage counts as unknown', () => {
    const f = parseRecord(assistant('m', null));
    assert.equal(f.known, false);
    assert.equal(f.type, 'assistant:no-usage');
    assert.equal(parseRecord(assistant('m', null, {}, [], '<synthetic>')).known, true);
  });

  it('tool calls include the skill name', () => {
    const rec = assistant('m', usage(0, 0, 0, 0), {}, [
      { type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'foo:bar' } },
      { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } },
      { type: 'thinking', thinking: '' },
    ]);
    assert.deepEqual(parseToolCalls(rec), [{ id: 't1', name: 'Skill', skill: 'foo:bar', path: null }, { id: 't2', name: 'Bash', skill: null, path: null }]);
  });

  it('parseLine does not need JSON for api-request and big user lines, and survives garbage', () => {
    const api = Buffer.from('{"type":"api-request-blob","broken json');
    assert.equal(parseLine(api, 0, api.length).known, true);
    const big = Buffer.from(`{"parentUuid":null,"type":"user","message":{"content":"${'x'.repeat(10_000)}`);
    assert.deepEqual([parseLine(big, 0, big.length).type, parseLine(big, 0, big.length).known], ['user', true]);
    const bad = Buffer.from('{not json');
    assert.deepEqual([parseLine(bad, 0, bad.length).type, parseLine(bad, 0, bad.length).known], ['<invalid-json>', false]);
  });

  it('splitter holds an unterminated tail across chunks', () => {
    const got: string[] = [];
    const s = new LineSplitter();
    const on = (b: Buffer, st: number, e: number) => got.push(b.toString('utf8', st, e));
    s.feed(Buffer.from('a\nbb'), on);
    assert.equal(s.pendingBytes, 2);
    s.feed(Buffer.from('b\n\nc'), on);
    assert.deepEqual(got, ['a', 'bbb']);
    assert.equal(s.pendingBytes, 1);
  });

  it('chat events: blocks, tool results, hidden meta records', () => {
    const a = recordToChatEvents(assistant('m', usage(0, 0, 0, 0), {}, [{ type: 'thinking', thinking: '' }, { type: 'text', text: 'hi' }]));
    assert.deepEqual(a, [{ e: 'assistant', messageId: 'm', blocks: [{ type: 'text', text: 'hi' }], model: 'claude-test' }]);
    const u = recordToChatEvents({ type: 'user', message: { content: [
      { type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'out' }], is_error: true }, { type: 'text', text: 'next' },
    ] } });
    assert.deepEqual(u, [{ e: 'tool_result', toolUseId: 't', text: 'out', isError: true }, { e: 'user', blocks: [{ type: 'text', text: 'next' }] }]);
    assert.deepEqual(recordToChatEvents({ type: 'user', isMeta: true, message: { content: 'hidden' } }), []);
    assert.deepEqual(recordToChatEvents({ type: 'attachment', attachment: {} }), []);
  });

  it('chat events: text injected by Claude Code is not shown as a user message', () => {
    const user = (content: string) => recordToChatEvents({ type: 'user', message: { content } });
    const typed = (text: string) => [{ e: 'user', blocks: [{ type: 'text', text }] }];
    const notification = '<task-notification>\n<task-id>a1</task-id>\n<status>completed</status>\n<summary>Agent "x" finished</summary>\n<result>long report</result>\n</task-notification>';
    assert.deepEqual(user(notification), [{ e: 'warning', text: 'Agent "x" finished' }]);
    assert.deepEqual(user('<task-notification><task-id>a1</task-id></task-notification>'), []);
    assert.deepEqual(user('<command-name>/loop</command-name>\n<command-message>loop</command-message>\n<command-args>5m</command-args>'), typed('/loop 5m'));
    assert.deepEqual(user('<command-message>init</command-message>\n<command-name>/init</command-name>'), typed('/init'));
    assert.deepEqual(user('<local-command-stdout>\x1b[2mdone\x1b[22m</local-command-stdout>'), [{ e: 'warning', text: 'done' }]);
    assert.deepEqual(user('<local-command-stdout></local-command-stdout>'), []);
    assert.deepEqual(user('<bash-input>ls</bash-input>'), typed('! ls'));
    assert.deepEqual(user('<bash-stdout>a</bash-stdout><bash-stderr>b</bash-stderr>'), [{ e: 'warning', text: 'a\nb' }]);
    assert.deepEqual(user('[Request interrupted by user for tool use]'), [{ e: 'warning', text: 'Interrupted', key: 'interrupted' }]);
    // What the person pasted stays theirs, even a pasted notification.
    assert.deepEqual(user(`Вот:\n\n<pasted_content id="d3">\n${notification}\n</pasted_content id="d3">`), typed(`Вот:\n\n${notification}`));
    assert.deepEqual(user('разбери тег <task-notification> в логе'), typed('разбери тег <task-notification> в логе'));
  });
});

describe('live status', () => {
  const entry = (o: Partial<RegistryEntry>): RegistryEntry => ({ pid: 1, sessionId: 's', cwd: '/x', procStart: '100', status: 'busy', ...o });

  it('a dead pid claiming busy is not live, nor is a reused pid', () => {
    assert.equal(computeLive([entry({})], [], () => null).size, 0);
    assert.equal(computeLive([entry({})], [], () => '999').size, 0);
    assert.equal(computeLive([entry({ procStart: undefined })], [], () => '100').size, 0);
    assert.equal(computeLive([entry({})], [], () => '100').get('s')?.status, 'working');
  });

  it('an agents entry with no running process is not live: no pid, a dead pid, a pid reused by something else', () => {
    const parked = { sessionId: 'bg', kind: 'background', state: 'blocked', cwd: '/x' };
    assert.equal(computeLive([], [parked], () => '100', () => true).size, 0);
    assert.equal(computeLive([], [{ ...parked, pid: 7 }], () => null, () => true).size, 0);
    assert.equal(computeLive([], [{ ...parked, pid: 7 }], () => '100', () => false).size, 0);
    const running = computeLive([], [{ ...parked, pid: 7 }], () => '100', () => true);
    assert.equal(running.get('bg')?.status, 'blocked');
    assert.equal(running.get('bg')?.pid, 7);
  });

  it('a terminal session in the registry stays live whatever the agents view says, and takes its blocked state from it', () => {
    assert.equal(computeLive([entry({ status: 'idle' })], [], () => '100', () => false).get('s')?.status, 'idle');
    const blocked = computeLive([entry({ status: 'idle' })], [{ sessionId: 's', state: 'blocked' }], () => '100', () => false);
    assert.equal(blocked.get('s')?.status, 'blocked');
    assert.equal(blocked.get('s')?.pid, 1);
    const both =computeLive([entry({ status: 'idle' })], [{ sessionId: 's', pid: 1, status: 'busy' }, { sessionId: 'gone', pid: 2, status: 'busy' }], (p) => (p === 1 ? '100' : null));
    assert.equal(both.get('s')?.status, 'idle'); // the registry is fresher
    assert.equal(both.has('gone'), false);
  });

  it('maps raw states', () => {
    assert.deepEqual(['busy', 'idle', 'blocked', 'waiting_permission', undefined].map((s) => mapStatus(s)), ['working', 'idle', 'blocked', 'waiting_permission', 'idle']);
  });

  it('procStartOf reads the real field 22 of this process', () => {
    const expected = execFileSync('sh', ['-c', `awk '{print $22}' /proc/${process.pid}/stat`], { encoding: 'utf8' }).trim();
    assert.equal(procStartOf(process.pid), expected);
    assert.equal(procStartOf(2 ** 30), null);
  });
});

describe('projects', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  let base: string;
  let db: DatabaseSync;
  before(() => {
    base = tmp();
    db = new DatabaseSync(':memory:');
    initSchema(db);
    mkdirSync(join(base, 'repo/sub'), { recursive: true });
    git(join(base, 'repo'), 'init', '-q');
    git(join(base, 'repo'), 'commit', '-q', '--allow-empty', '-m', 'x');
    git(join(base, 'repo'), 'worktree', 'add', '-q', join(base, 'wt'));
    mkdirSync(join(base, 'clone'));
    git(join(base, 'clone'), 'init', '-q');
    mkdirSync(join(base, 'other/repo'), { recursive: true });
    git(join(base, 'other/repo'), 'init', '-q');
    mkdirSync(join(base, 'plain'));
  });
  after(() => { db.close(); rmSync(base, { recursive: true, force: true }); });

  it('resolves git roots, worktrees, clones, plain dirs, misc parents, collisions', () => {
    const p = createProjects(db, {});
    const repo = p.forCwd(join(base, 'repo'));
    assert.equal(repo, 'repo');
    assert.equal(p.forCwd(join(base, 'repo/sub')), repo);
    assert.equal(p.forCwd(join(base, 'wt')), repo, 'a worktree belongs to its repo');
    assert.equal(p.forCwd(join(base, 'clone')), 'clone');
    assert.equal(p.forCwd(join(base, 'other/repo')), 'repo-2', 'same short name gets a suffix');
    assert.equal(p.forCwd(join(base, 'plain')), 'plain');
    assert.equal(p.forCwd(base), base.split('/').at(-1), 'parent without a repo');
    const rows = new Map(p.rows().map((r) => [r.key, r]));
    assert.equal(rows.get(base.split('/').at(-1)!)?.misc, true);
    assert.equal(rows.get('plain')?.misc, false);
    p.forCwd(join(base, 'plain/nested'));
    assert.equal(p.rows().find((r) => r.key === 'plain')?.misc, false, 'a plain project with a nested cwd is not a parent of repos');
    assert.equal(rows.get('repo')?.misc, false);
  });

  it('keys survive a restart and a vanished directory lands in its old project', () => {
    const again = createProjects(db, {});
    assert.equal(again.forCwd(join(base, 'other/repo')), 'repo-2');
    assert.equal(again.forCwd(join(base, 'repo/deleted/worktree')), 'repo');
  });

  it('a gone worktree belongs to the repo above it even before that repo is known', () => {
    const fresh = new DatabaseSync(':memory:');
    initSchema(fresh);
    const p = createProjects(fresh, {});
    assert.equal(p.forCwd(join(base, 'clone/.claude/worktrees/agent-x')), 'clone');
    assert.deepEqual(p.rows().map((r) => r.key), ['clone']);
    fresh.close();
  });

  it('does not spawn git twice for one cwd', () => {
    let calls = 0;
    const p = createProjects(db, {}, () => { calls++; return null; });
    mkdirSync(join(base, 'fresh'));
    p.forCwd(join(base, 'fresh'));
    p.forCwd(join(base, 'fresh'));
    assert.equal(calls, 1);
  });

  it('overrides can fold a path into a root, rename, set misc', () => {
    mkdirSync(join(base, 'fold'));
    const p = createProjects(db, { [join(base, 'fold')]: { root: join(base, 'plain') }, [join(base, 'plain')]: { name: 'Plain!', misc: true } });
    assert.equal(p.forCwd(join(base, 'fold')), 'plain');
    const row = p.rows().find((r) => r.key === 'plain')!;
    assert.deepEqual([row.name, row.misc], ['Plain!', true]);
  });

  it('the async git lookup agrees with the sync one', async () => {
    for (const dir of ['repo', 'repo/sub', 'wt', 'clone', 'plain']) assert.equal(await gitRootAsync(join(base, dir)), gitRoot(join(base, dir)), dir);
    assert.equal(await gitRootAsync(join(base, 'wt')), join(base, 'repo'), 'a worktree answers with its repo');
  });

  it('classifies a folder: listed, misc, seen, folded by git or by an override, hidden, nothing yet', () => {
    const row = (key: string, root: string, extra: object = {}) => ({ key, name: key, root, has_git: 0, pinned: 0, removed_at: null, map_pin: null, description: null, color: null, parent: null, folder: 0, misc: false, ...extra });
    const rows = [row('repo', '/w/repo', { has_git: 1 }), row('w', '/w', { misc: true }), row('pin', '/w/pin', { pinned: 1 }), row('old', '/w/old'), row('forced', '/w/forced')];
    const listed = new Set(['repo', 'w', 'pin', 'forced']);
    const facts = (gitTop: string | null = null, forcedRoot: string | null = null, hidden = false) => ({ gitTop, forcedRoot, hidden });
    assert.deepEqual(classifyDir('/w/repo', facts('/w/repo'), rows, listed), { kind: 'project', project: 'repo', reason: 'git' });
    assert.deepEqual(classifyDir('/w/repo/sub', facts('/w/repo'), rows, listed), { kind: 'inside', project: 'repo', reason: 'git' });
    assert.deepEqual(classifyDir('/w', facts(), rows, listed), { kind: 'misc', project: 'w' });
    assert.deepEqual(classifyDir('/w/pin', facts(), rows, listed), { kind: 'project', project: 'pin', reason: 'connected' });
    assert.deepEqual(classifyDir('/w/old', facts(), rows, listed), { kind: 'seen', project: 'old' });
    assert.deepEqual(classifyDir('/w/forced', facts(null, '/w/forced'), rows, listed), { kind: 'project', project: 'forced', reason: 'override' });
    assert.deepEqual(classifyDir('/w/fold', facts(null, '/w/forced'), rows, listed), { kind: 'inside', project: 'forced', reason: 'override' });
    assert.deepEqual(classifyDir('/w/root', facts(null, null, true), rows, listed), { kind: 'hidden' });
    assert.deepEqual(classifyDir('/w/new-repo', facts('/w/new-repo'), rows, listed), { kind: 'none', reason: 'git' });
    assert.deepEqual(classifyDir('/w/plain', facts(), rows, listed), { kind: 'none' });
  });
});

describe('hidden project roots', () => {
  it('hides the root session cwd and temp dirs unless the claude dir is itself under tmp', () => {
    const paths = { root: '/repo/root', claudeDir: '/home/x/.claude' };
    assert.equal(hiddenRoot('/repo/root', paths), true);
    assert.equal(hiddenRoot('/tmp/x/smoke-repo', paths), true);
    assert.equal(hiddenRoot(join(tmpdir(), 'x'), paths), true);
    assert.equal(hiddenRoot('/home/x/app', paths), false);
    assert.equal(hiddenRoot('/tmp/x/app', { root: '/repo/root', claudeDir: '/tmp/fake/.claude' }), false);
  });
});

describe('watcher', () => {
  it('picks up journal appends and registry changes through chokidar, debounces invalidation', async () => {
    const dir = tmp();
    const claudeDir = join(dir, 'claude');
    const file = join(claudeDir, 'projects/-w/w1.jsonl');
    mkdirSync(join(claudeDir, 'projects/-w'), { recursive: true });
    mkdirSync(join(claudeDir, 'sessions'));
    writeFileSync(file, lines(assistant('w1', usage(1, 1, 1, 1))));
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY, at INTEGER, action TEXT, target TEXT, diff TEXT)');
    const topics: string[] = [];
    const ctx = {
      memory: null, app: Fastify(), db, bus: new EventEmitter<BusEvents>(), setBusy() {},
      paths: { claudeDir, claudeJson: join(dir, 'c.json'), config: join(dir, 'config'), claudeBin: '/nonexistent', root: '/nonexistent/claude-os/root' } as Paths,
      invalidate(...t: string[]) { topics.push(...t); },
    } as unknown as Ctx;
    const journal = createJournal(ctx, { pollAgents: false });
    await journal.start();
    await new Promise((r) => setTimeout(r, 300)); // chokidar's own initial crawl
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(cond());
    };
    const count = () => db.prepare('SELECT COUNT(*) n FROM usage_messages').get()!.n as number;
    assert.equal(count(), 1);
    appendFileSync(file, lines(assistant('w2', usage(1, 1, 1, 1))));
    await until(() => count() === 2);
    const lived = new Promise<void>((r) => ctx.bus.once('sessions-changed', r));
    writeFileSync(join(claudeDir, 'sessions/7.json'), JSON.stringify({ pid: process.pid, sessionId: 'w1', cwd: '/nonexistent/w', status: 'busy', procStart: procStartOf(process.pid) }));
    await lived;
    assert.equal(ctx.journal.listSessions().find((s) => s.id === 'w1')?.status, 'working');
    await until(() => topics.includes('tokens'));
    await journal.stop();
    await ctx.app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('index end to end', () => {
  let dir: string;
  let ctx: Ctx;
  let db: DatabaseSync;
  let journal: ReturnType<typeof createJournal>;
  const invalidated: string[] = [];
  const main = () => join(dir, 'claude/projects/-app/sess-1.jsonl');
  const get = async <T>(url: string): Promise<T> => {
    const res = await ctx.app.inject({ method: 'GET', url });
    assert.equal(res.statusCode, 200, `${url}: ${res.body}`);
    return JSON.parse(res.body) as T;
  };

  before(async () => {
    dir = tmp();
    const claudeDir = join(dir, 'claude');
    mkdirSync(join(claudeDir, 'projects/-app/sess-1/subagents/workflows/wf'), { recursive: true });
    mkdirSync(join(claudeDir, 'sessions'));
    mkdirSync(join(claudeDir, 'skills/one'), { recursive: true });
    mkdirSync(join(claudeDir, 'skills/two'));
    writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({
      enabledPlugins: { 'a@b': true, 'c@d': false },
      hooks: { Stop: [{ hooks: [{ type: 'command', command: 'x' }, { type: 'command', command: 'y' }] }] },
    }));
    writeFileSync(join(dir, 'claude.json'), JSON.stringify({ mcpServers: { a: { env: { SECRET: 'nope' } } }, projects: { '/x': { mcpServers: { a: {}, b: {} } } } }));
    // A secret next to the registry: were it opened, this body would parse into a live session.
    writeFileSync(join(claudeDir, 'sessions/4242.abc.key'), JSON.stringify({ pid: process.pid, sessionId: 'from-key-file', cwd: '/x', status: 'busy', procStart: procStartOf(process.pid) }));
    writeFileSync(join(claudeDir, 'sessions/999999.json'), JSON.stringify({ pid: 2 ** 30, sessionId: 'dead-session', cwd: '/nonexistent/app', status: 'busy', procStart: '1' }));

    writeFileSync(main(), lines(
      { type: 'user', message: { content: 'first prompt' }, uuid: 'p1', timestamp: '2026-10-20T09:00:00.000Z', cwd: '/nonexistent/app', entrypoint: 'cli', version: '9.9.9' },
      assistant('m1', usage(10, 5, 100, 1000), { apiBlockIndex: 0 }, [{ type: 'text', text: 'one' }]),
      // One response, a second record with larger output and smaller input: MAX per field.
      assistant('m1', usage(7, 50, 100, 1000), { apiBlockIndex: 1 }, [{ type: 'tool_use', id: 't1', name: 'Skill', input: { skill: 'foo:bar' } }]),
      assistant('syn', usage(1000, 1000, 1000, 1000), { timestamp: '2026-10-20T11:00:00.000Z' }, [{ type: 'text', text: 'x' }], '<synthetic>'),
      { type: 'ai-title', aiTitle: 'A title', sessionId: 'sess-1' },
      { type: 'last-prompt', lastPrompt: 'first prompt', sessionId: 'sess-1' },
      { type: 'last-prompt', leafUuid: 'no-prompt-here', sessionId: 'sess-1' },
      { type: 'cost-state', totalCostUSD: 1.5, sessionId: 'sess-1' },
      { type: 'api-request-blob', hash: 'h', message: { content: 'x'.repeat(100) } },
      { type: 'future-record', foo: 1 },
    ));
    writeFileSync(join(claudeDir, 'projects/-app/sess-1/subagents/agent-a1.jsonl'), lines(
      assistant('m2', usage(1, 2, 3, 4), { agentId: 'a1', isSidechain: true, timestamp: '2026-10-21T10:00:00.000Z' }),
      assistant('m1', usage(0, 0, 0, 0), { agentId: 'a1', isSidechain: true }), // fork copy of a main message stays main
    ));
    writeFileSync(join(claudeDir, 'projects/-app/sess-1/subagents/agent-a1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'look around' }));
    writeFileSync(join(claudeDir, 'projects/-app/sess-1/subagents/workflows/wf/journal.jsonl'), lines({ type: 'started' }));

    db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, diff TEXT)');
    const paths = { claudeDir, claudeJson: join(dir, 'claude.json'), config: join(dir, 'config'), claudeBin: '/nonexistent/claude', root: '/nonexistent/claude-os/root', service: '/nonexistent/claude-os/service', setup: '/nonexistent/claude-os/setup' } as Paths;
    ctx = {
      journal: null, memory: {
        projectStats: (key: string) => ({ count: key === 'noted' ? 3 : 0, connected: key === 'noted', drift: key === 'noted' ? 1 : 0 }),
        recentNotes: () => [{ id: 'n', title: 'Note', mtime: 5 }],
      },
      app: Fastify(), db, paths, bus: new EventEmitter<BusEvents>(), broadcast() {},
      invalidate(...t: string[]) { invalidated.push(...t); }, audit() {}, onClientMessage() {}, onClientClose() {}, setBusy() {},
    } as unknown as Ctx;
    journal = createJournal(ctx, { pollAgents: false, watch: false });
    await journal.start();
  });

  after(async () => {
    await journal.stop();
    await ctx.app.close();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const totals = () => db.prepare('SELECT COUNT(*) n, SUM(input) i, SUM(output) o, SUM(cache_write) w, SUM(cache_read) r FROM usage_messages').get() as Record<string, number>;

  it('one row per message.id, MAX per field, no synthetic, subagent separate', async () => {
    assert.deepEqual({ ...totals() }, { n: 2, i: 11, o: 52, w: 103, r: 1004 });
    const a = await get<Analytics>('/api/analytics?from=2026-10-20&to=2026-10-22');
    assert.deepEqual(a.total, { input: 11, output: 52, cacheWrite: 103, cacheRead: 1004 });
    assert.deepEqual(a.main, { input: 10, output: 50, cacheWrite: 100, cacheRead: 1000 });
    assert.deepEqual(a.subagents, { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 });
    assert.deepEqual(a.byDay.map((d) => d.day), ['2026-10-20', '2026-10-21', '2026-10-22']);
    assert.equal(a.byDay[2].output, 0);
    assert.deepEqual(a.byModel.map((m) => m.name), ['claude-test']);
    assert.equal(a.costEquivalentUsd, 1.5);
    assert.equal(a.topSessions[0].name, 'A title');
  });

  it('skips files that are not transcripts, indexes tool calls and subagent meta', async () => {
    assert.deepEqual({ ...db.prepare("SELECT name, skill FROM tool_calls").get() as object }, { name: 'Skill', skill: 'foo:bar' });
    const [s] = (await get<SessionInfo[]>('/api/sessions')).filter((x) => x.id === 'sess-1');
    assert.equal(s.title, 'A title');
    assert.equal(s.lastPrompt, 'first prompt');
    assert.equal(s.status, 'ended');
    assert.deepEqual(s.subagents.map((x) => [x.id, x.agentType, x.description, x.tokens]), [['a1', 'Explore', 'look around', 6]]);
  });

  it('counts unknown records and warns only when the share spikes', async () => {
    const unknown = db.prepare('SELECT type, count FROM unknown_records').all().map((r) => ({ ...r }));
    assert.deepEqual(unknown, [{ type: 'future-record', count: 1 }]);
    assert.equal((await get<IndexStatus>('/api/index')).formatWarning, null);
    assert.equal((await get<IndexStatus>('/api/index')).claudeVersion, '9.9.9');
    const spike = join(dir, 'claude/projects/-app/spike.jsonl');
    writeFileSync(spike, lines(...Array.from({ length: 300 }, () => ({ type: 'new-format' }))));
    await journal.indexer.sweep();
    const st = await get<IndexStatus>('/api/index');
    assert.ok(st.unknownRecordShare > 0.05);
    assert.match(st.formatWarning ?? '', /9\.9\.9/);
    db.exec('DELETE FROM record_stats');
    rmSync(spike);
  });

  it('a partial last line waits for its newline, then counts once', async () => {
    const line = JSON.stringify(assistant('m3', usage(100, 0, 0, 0)));
    appendFileSync(main(), line.slice(0, 40));
    await journal.indexer.sweep();
    assert.equal(totals().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM unknown_records WHERE type = '<invalid-json>'").get()!.n, 0);
    appendFileSync(main(), `${line.slice(40)}\n`);
    journal.indexer.enqueue(main());
    await journal.indexer.idle();
    assert.equal(totals().n, 3);
    assert.equal(totals().i, 111);
  });

  it('re-reading everything changes nothing, and rows survive deleted journals', async () => {
    const before = { ...totals() };
    db.exec('DELETE FROM file_offsets');
    await journal.indexer.sweep();
    assert.deepEqual({ ...totals() }, before);
    renameSync(main(), `${main()}.gone`);
    await journal.indexer.sweep();
    assert.deepEqual({ ...totals() }, before);
    assert.ok((await get<SessionInfo[]>('/api/sessions')).some((s) => s.id === 'sess-1'));
    const missing = await ctx.app.inject({ method: 'GET', url: '/api/sessions/sess-1/transcript' });
    assert.equal(missing.statusCode, 404);
    renameSync(`${main()}.gone`, main());
  });

  it('dead pid in the registry is not reported live', async () => {
    assert.deepEqual(await get<SessionInfo[]>('/api/sessions?live=1'), []);
    assert.ok(!(await get<SessionInfo[]>('/api/sessions')).some((s) => s.id === 'dead-session'));
    assert.ok(!(await get<SessionInfo[]>('/api/sessions')).some((s) => s.id === 'from-key-file'));
  });

  it('a finished process without a prompt or tokens is not listed', async () => {
    db.prepare("INSERT INTO sessions (id, cwd) VALUES ('empty-proc', '/nonexistent/app')").run();
    assert.ok(!(await get<SessionInfo[]>('/api/sessions')).some((s) => s.id === 'empty-proc'));
    db.prepare("DELETE FROM sessions WHERE id = 'empty-proc'").run();
  });

  it('a live pid with a matching procStart shows as working, then ended once its file goes', async () => {
    const file = join(dir, 'claude/sessions/1.json');
    writeFileSync(file, JSON.stringify({ pid: process.pid, sessionId: 'sess-1', cwd: '/nonexistent/app', status: 'busy', procStart: procStartOf(process.pid), kind: 'bg' }));
    journal.refreshLive();
    const [s] = await get<SessionInfo[]>('/api/sessions?live=1');
    assert.deepEqual([s.id, s.status, s.pid, s.kind], ['sess-1', 'working', process.pid, 'background']);
    assert.equal((await get<Project[]>('/api/projects'))[0].liveCount, 1);
    rmSync(file);
    journal.refreshLive();
    assert.deepEqual(await get<SessionInfo[]>('/api/sessions?live=1'), []);
    assert.equal(db.prepare("SELECT status FROM sessions WHERE id = 'sess-1'").get()!.status, 'ended');
  });

  it('transcript merges split messages, numbers from 1, hides rows without text', async () => {
    const ev = await get<ChatEvent[]>('/api/sessions/sess-1/transcript');
    assert.deepEqual(ev.map((e) => e.seq), ev.map((_, i) => i + 1));
    assert.equal(ev[0].e, 'user');
    const a = ev[1];
    assert.ok(a.e === 'assistant');
    assert.deepEqual(a.blocks.map((b) => b.type), ['text', 'tool_use']);
    assert.deepEqual(readTranscript('sess-1', null, join(dir, 'claude')).map((e) => e.e), ev.map((e) => e.e));
    assert.deepEqual(readTranscript('../../secrets', null, join(dir, 'claude')), []);
  });

  it('marks OS sessions, retains their rate limits, ignores others', async () => {
    ctx.journal.markOsSession('sess-1');
    ctx.bus.emit('rate-limit', 'sess-1', { rate_limit_info: { rateLimitType: 'five_hour', status: 'allowed' } });
    ctx.bus.emit('rate-limit', 'other', { rate_limit_info: { rateLimitType: 'five_hour' } });
    const a = await get<Analytics>('/api/analytics?from=2026-10-20&to=2026-10-22');
    assert.equal(a.osShare.input, 111);
    assert.deepEqual(a.rateLimits.map((r) => r.sessionId), ['sess-1']);
    assert.ok((await get<SessionInfo[]>('/api/sessions')).find((s) => s.id === 'sess-1')?.origin === 'os');
  });

  it('Claude OS own tokens by source: explicit marks, root, service and setup by cwd, user tabs left out', async () => {
    const { root, service, setup } = ctx.paths;
    ctx.journal.markOsSession('src-widget', 'widget', 'w1');
    ctx.journal.markOsSession('src-micro', 'microtask', 'explain');
    ctx.journal.markOsSession('src-doc', ''); // a document tab in the root folder: the user's work
    db.prepare(`INSERT INTO sessions (id, cwd, origin) VALUES
      ('src-root', ?, 'os'), ('src-svc', ?, 'os'), ('src-setup', ?, 'os'), ('src-work', '/nonexistent/app', 'os'), ('src-ext', ?, 'external'), ('src-olddoc', ?, 'os')`).run(join(root, 'x'), service, setup, root, root);
    db.prepare("UPDATE sessions SET cwd = ? WHERE id = 'src-micro'").run(service); // a microtask runs in the service session
    db.prepare("UPDATE sessions SET cwd = ? WHERE id = 'src-doc'").run(root);
    // Marked before the source was recorded, and still held by a document tab.
    db.exec("CREATE TABLE tabs (id TEXT PRIMARY KEY, kind TEXT NOT NULL, session_id TEXT); INSERT INTO tabs VALUES ('t-doc', 'document', 'src-olddoc'), ('t-view', 'readonly', 'src-root')");
    const seed = db.prepare("INSERT INTO usage_messages (message_id, session, day, model, is_subagent, input, output, cache_read, cache_write) VALUES (?, ?, '2026-09-10', 'm', 0, ?, 0, 0, 0)");
    for (const [id, input] of [['src-widget', 5], ['src-micro', 40], ['src-root', 30], ['src-svc', 20], ['src-setup', 3], ['src-work', 1000], ['src-ext', 7], ['src-doc', 500], ['src-olddoc', 600]] as const) seed.run(`msg-${id}`, id, input);
    const a = await get<Analytics>('/api/analytics?from=2026-09-10&to=2026-09-10');
    db.exec('DROP TABLE tabs');
    assert.deepEqual(a.bySource.map((s) => [s.name, s.input, s.messages]), [['microtask', 40, 1], ['root', 30, 1], ['service', 20, 1], ['widget', 5, 1], ['setup', 3, 1]]);
    assert.equal(db.prepare("SELECT os_source_detail d FROM sessions WHERE id = 'src-widget'").get()!.d, 'w1');
    ctx.journal.markOsSession('src-widget');
    ctx.journal.markOsSession('src-widget', '');
    assert.equal(db.prepare("SELECT os_source s FROM sessions WHERE id = 'src-widget'").get()!.s, 'widget', 'a later mark without a source, or as user work, keeps it');
    ctx.journal.markOsSession('src-doc', 'crash-fix');
    assert.equal(db.prepare("SELECT os_source s FROM sessions WHERE id = 'src-doc'").get()!.s, 'crash-fix', 'user work learns its source');
    db.exec("DELETE FROM usage_messages WHERE session LIKE 'src-%'; DELETE FROM sessions WHERE id LIKE 'src-%'");
  });

  it('project stats come from memory, overview counts match the fixtures', async () => {
    ctx.journal.projectForCwd('/nonexistent/noted');
    ctx.journal.projectForCwd('/nonexistent/passing');
    ctx.journal.projectForCwd(ctx.paths.root);
    const listed = await get<Project[]>('/api/projects');
    assert.deepEqual(listed.map((x) => x.key).sort(), ['app', 'noted'], 'no 0-session rows without memory, no root session cwd');
    const p = listed.find((x) => x.key === 'noted')!;
    assert.deepEqual([p.sessionCount, p.memoryCount, p.memoryConnected, p.memoryDrift], [0, 3, true, 1]);
    const o = await get<Overview>('/api/overview');
    assert.deepEqual([o.skills, o.plugins, o.hooks, o.mcpServers], [2, 1, 2, 2]);
    assert.deepEqual(o.recentNotes, [{ id: 'n', title: 'Note', mtime: 5 }]);
    assert.ok(!JSON.stringify(o).includes('nope'));
  });

  it('rejects bad input', async () => {
    assert.equal((await ctx.app.inject({ url: '/api/analytics?from=x&to=y' })).statusCode, 400);
    assert.equal((await ctx.app.inject({ url: '/api/analytics?from=2026-13-40&to=2026-13-41' })).statusCode, 400);
    assert.equal((await ctx.app.inject({ url: '/api/sessions/..%2F..%2Fx/transcript' })).statusCode, 404);
  });
});

describe('parseTitles', () => {
  it('a last prompt that is a pasted block reads as its text, also when the clip cut the tag', () => {
    assert.equal(parseTitles({ type: 'last-prompt', lastPrompt: 'look: <pasted lines="2">\na\nb\n</pasted> ok' })?.lastPrompt, 'look: a\nb ok');
    assert.equal(parseTitles({ type: 'last-prompt', lastPrompt: '<pasted lines="900">\nfirst line' })?.lastPrompt, 'first line');
  });

  it('an edit of a queued message keeps the tags of the pasted blocks it left alone', () => {
    const raw = 'look: <pasted lines="2">\na\nb\n</pasted> and <pasted lines="2">\nc\nd\n</pasted> ok';
    assert.equal(keepPastedTags(raw, stripPastedTags(raw)), raw, 'unchanged: the same text');
    assert.equal(keepPastedTags(raw, 'see: a\nb and c\nd!'), 'see: <pasted lines="2">\na\nb\n</pasted> and <pasted lines="2">\nc\nd\n</pasted>!');
    assert.equal(keepPastedTags(raw, 'look: a\nb and c\nX ok'), 'look: <pasted lines="2">\na\nb\n</pasted> and c\nX ok', 'a changed block stays plain');
  });
});
