// Only temp dirs: claudeDir, the vault and data all live under mkdtemp. Nothing here reaches real data.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, beforeEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import type { Analytics, Project, ProjectRemovalPreview, ProjectStructureNode, ProjectRemovalResult, SessionInfo, SessionRemovalPreview, SessionRemovalResult } from '../../shared/contract.ts';
import type { BusEvents, ChatApi, Ctx, Paths } from '../context.ts';
import { noteSummary } from '../memory/store.ts';
import { createJournal } from './index.ts';
import { procStartOf } from './live.ts';

const record = (id: string, session: string, cwd: string, ts = '2026-10-20T10:00:00.000Z') => JSON.stringify({
  parentUuid: null, isSidechain: false, type: 'assistant', uuid: id, timestamp: ts, cwd, entrypoint: 'cli', version: '9.9.9', sessionId: session,
  message: { id, model: 'claude-test', role: 'assistant', content: [], usage: { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } },
}) + '\n';

describe('manage', () => {
  let dir: string;
  let source: string;
  let paths: Paths;
  let db: DatabaseSync;
  let ctx: Ctx;
  let journal: ReturnType<typeof createJournal>;
  const audits: string[] = [];
  const req = async <T>(method: 'GET' | 'POST' | 'PATCH', url: string, body?: object) => {
    const r = await ctx.app.inject({ method, url, ...(body ? { payload: body } : {}) });
    return { status: r.statusCode, body: JSON.parse(r.body || 'null') as T };
  };
  const dirFor = (cwd: string) => join(paths.claudeDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));

  function addJournal(cwd: string, session: string, id = `m-${session}`) {
    mkdirSync(dirFor(cwd), { recursive: true });
    writeFileSync(join(dirFor(cwd), `${session}.jsonl`), record(id, session, cwd));
  }

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'manage-test-'));
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  beforeEach(async () => {
    const base = mkdtempSync(join(dir, 'run-'));
    source = join(base, 'src', 'alpha');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'code.txt'), 'source stays');
    paths = {
      repo: join(base, 'repo'), data: join(base, 'data'), config: join(base, 'config'), plugins: join(base, 'plugins'), root: join(base, 'root'),
      service: join(base, 'service'), setup: join(base, 'setup'), claudeDir: join(base, 'claude'), claudeJson: join(base, 'claude', '.claude.json'), claudeBin: '/nonexistent/claude',
      vault: join(base, 'vault'), newProjectsDir: join(base, 'new'),
    };
    mkdirSync(join(paths.claudeDir, 'projects'), { recursive: true });
    mkdirSync(paths.data, { recursive: true });
    addJournal(source, 's1');
    mkdirSync(join(dirFor(source), 'memory'), { recursive: true });
    writeFileSync(join(dirFor(source), 'memory', 'note.md'), 'hello');
    db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, diff TEXT)');
    audits.length = 0;
    const app = Fastify();
    app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _r, reply) => {
      reply.code(err.statusCode ?? 500).send({ error: err.message, code: err.code });
    });
    ctx = {
      journal: null, memory: { projectStats: () => ({ count: 0, connected: false, drift: 0 }), recentNotes: () => [] },
      app, db, paths, bus: new EventEmitter<BusEvents>(), broadcast() {}, invalidate() {},
      audit(action: string) { audits.push(action); }, onClientMessage() {}, onClientClose() {}, setBusy() {},
    } as unknown as Ctx;
    journal = createJournal(ctx, { pollAgents: false, watch: false });
    await journal.start();
  });

  const close = async () => {
    await journal.stop();
    await ctx.app.close();
    db.close();
  };
  const keyOf = async () => (await req<Project[]>('GET', '/api/projects')).body.find((p) => p.root === source)!.key;

  function register(pid: number, sessionId: string, cwd: string, procStart: string | null) {
    mkdirSync(join(paths.claudeDir, 'sessions'), { recursive: true });
    writeFileSync(join(paths.claudeDir, 'sessions', `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, status: 'busy', procStart, updatedAt: Date.now() }));
  }

  it('removal preview lists exact paths and sizes and leaves everything in place', async () => {
    const key = await keyOf();
    mkdirSync(join(paths.vault, 'projects', key), { recursive: true });
    writeFileSync(join(paths.vault, 'projects', key, 'a.md'), 'abc');
    mkdirSync(join(paths.vault, '_state'), { recursive: true });
    writeFileSync(join(paths.vault, '_state', `${key}.md`), 'state');
    const { body: p } = await req<ProjectRemovalPreview>('GET', `/api/projects/${key}/removal`);
    assert.deepEqual(p.items.map((i) => [i.kind, i.path, i.skipped]), [
      ['journals', dirFor(source), null],
      ['vault', join(paths.vault, 'projects', key), null],
      ['state', join(paths.vault, '_state', `${key}.md`), null],
    ]);
    assert.equal(p.items[0].files, 2);
    assert.equal(p.items[1].bytes, 3);
    assert.ok(existsSync(dirFor(source)));
    await close();
  });

  it('Claude OS itself cannot be removed: preview and removal are refused, nothing moves', async () => {
    mkdirSync(paths.repo, { recursive: true });
    addJournal(paths.repo, 'core-session');
    await journal.indexer.sweep();
    const key = (await req<Project[]>('GET', '/api/projects')).body.find((p) => p.root === paths.repo)!.key;
    const preview = await req<{ code: string }>('GET', `/api/projects/${key}/removal`);
    assert.equal(preview.status, 403);
    assert.equal(preview.body.code, 'core');
    const removal = await req<{ code: string }>('POST', `/api/projects/${key}/remove`, { confirm: key });
    assert.equal(removal.status, 403);
    assert.equal(removal.body.code, 'core');
    assert.ok(existsSync(dirFor(paths.repo)));
    assert.equal(audits.includes('project.remove'), false);
    await close();
  });

  it('removal moves to the trash with a manifest, keeps the source and the token totals, a new session brings it back', async () => {
    const key = await keyOf();
    writeFileSync(paths.claudeJson, JSON.stringify({ keep: 1, projects: { [source]: { a: 1 }, '/other': { b: 2 } } }));
    const totalBefore = (await req<Analytics>('GET', '/api/analytics?from=2026-10-20&to=2026-10-20')).body.total;

    assert.equal((await req('POST', `/api/projects/${key}/remove`, { confirm: 'wrong' })).status, 400);
    assert.ok(existsSync(dirFor(source)), 'a wrong confirmation touches nothing');

    const { status, body } = await req<ProjectRemovalResult>('POST', `/api/projects/${key}/remove`, { confirm: 'alpha' });
    assert.equal(status, 200);
    assert.equal(body.claudeJson, 'removed');
    assert.ok(!existsSync(dirFor(source)));
    assert.equal(readFileSync(join(source, 'code.txt'), 'utf8'), 'source stays');
    const manifest = JSON.parse(readFileSync(join(body.trash, 'manifest.json'), 'utf8')) as { moved: { from: string; to: string }[]; claudeJsonEntries: object };
    assert.equal(manifest.moved[0].from, dirFor(source));
    assert.ok(existsSync(join(manifest.moved[0].to, 's1.jsonl')));
    assert.deepEqual(manifest.claudeJsonEntries, { [source]: { a: 1 } });
    assert.deepEqual(JSON.parse(readFileSync(paths.claudeJson, 'utf8')), { keep: 1, projects: { '/other': { b: 2 } } });
    assert.ok(audits.includes('project.remove'));

    assert.ok(!(await req<Project[]>('GET', '/api/projects')).body.some((p) => p.key === key));
    assert.ok(!(await req<SessionInfo[]>('GET', '/api/sessions')).body.some((s) => s.id === 's1'));
    assert.deepEqual((await req<Analytics>('GET', '/api/analytics?from=2026-10-20&to=2026-10-20')).body.total, totalBefore);

    await journal.indexer.sweep();
    assert.ok(!(await req<Project[]>('GET', '/api/projects')).body.some((p) => p.key === key), 'the indexer does not recreate it');

    addJournal(source, 's2');
    await journal.indexer.sweep();
    const back = (await req<Project[]>('GET', '/api/projects')).body.find((p) => p.key === key);
    assert.equal(back?.sessionCount, 1, 'only the new session counts');
    await close();
  });

  it('removal is refused while a session is live', async () => {
    const key = await keyOf();
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    await new Promise((r) => child.once('spawn', r));
    try {
      register(child.pid!, 's1', source, procStartOf(child.pid!));
      const r = await req<{ code: string }>('POST', `/api/projects/${key}/remove`, { confirm: 'alpha' });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'live');
      assert.ok(existsSync(dirFor(source)));
    } finally {
      child.kill();
    }
    await close();
  });

  it('a directory shared through lossy encoding stays, and claude.json is skipped while anything runs', async () => {
    const twin = source.replace(/alpha$/, 'al_pha');
    mkdirSync(twin, { recursive: true });
    // Same encoded dir as a sibling project: a foreign session lives inside it.
    const shared = join(dirFor(source), 'foreign.jsonl');
    writeFileSync(shared, record('m-foreign', 'foreign', twin));
    await journal.indexer.sweep();
    const key = await keyOf();
    const { body: p } = await req<ProjectRemovalPreview>('GET', `/api/projects/${key}/removal`);
    assert.equal(p.items[0].skipped, 'shared_dir');

    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    await new Promise((r) => child.once('spawn', r));
    try {
      writeFileSync(paths.claudeJson, JSON.stringify({ projects: { [source]: {} } }));
      register(child.pid!, 'other-live', '/nonexistent/elsewhere', procStartOf(child.pid!));
      const { body: q } = await req<ProjectRemovalPreview>('GET', `/api/projects/${key}/removal`);
      assert.deepEqual(q.claudeJson, { path: paths.claudeJson, keys: [source], safe: false, reason: 'live_sessions' });
    } finally {
      child.kill();
    }
    await close();
  });

  it('stop: SIGTERM only for a verified registry entry; a wrong procStart or no pid is 409', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    await new Promise((r) => child.once('spawn', r));
    const exited = new Promise<NodeJS.Signals | null>((r) => child.once('exit', (_c, sig) => r(sig)));
    const start = procStartOf(child.pid!)!;
    register(child.pid!, 's1', source, start);
    assert.equal((await req<SessionInfo[]>('GET', '/api/sessions')).body.length, 1);
    journal.refreshLive();
    const r = await req<{ how: string }>('POST', '/api/sessions/s1/stop');
    assert.equal(r.status, 200);
    assert.equal(r.body.how, 'signal');
    assert.equal(await exited, 'SIGTERM');
    assert.ok(audits.includes('session.stop'));

    const ended = await req<{ code: string }>('POST', '/api/sessions/s1/stop');
    assert.equal(ended.status, 409);
    await close();
  });

  it('stop: a live session whose procStart no longer matches is not signalled', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    await new Promise((r) => child.once('spawn', r));
    try {
      register(child.pid!, 's1', source, 'not-the-real-start');
      db.prepare("UPDATE sessions SET status = 'blocked' WHERE id = 's1'").run();
      const r = await req('POST', '/api/sessions/s1/stop');
      assert.equal(r.status, 409);
      assert.equal(child.exitCode, null);
      assert.equal(child.signalCode, null);
    } finally {
      child.kill();
    }
    await close();
  });

  it('stop: a process registered under another session is never a target', async () => {
    // Live through the agents view, whose pid is only a claim: no registry entry of its own vouches for it.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'fake-claude-process'], { stdio: 'ignore' });
    await new Promise((r) => child.once('spawn', r));
    const bin = join(paths.data, 'fake-claude');
    writeFileSync(bin, `#!/bin/sh\necho '${JSON.stringify([{ sessionId: 's1', pid: child.pid, state: 'blocked', cwd: source }])}'\n`, { mode: 0o755 });
    const app = Fastify();
    app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _r, reply) => {
      reply.code(err.statusCode ?? 500).send({ error: err.message, code: err.code });
    });
    const second = createJournal({ ...ctx, app, paths: { ...paths, claudeBin: bin } }, { watch: false });
    try {
      await second.start();
      register(child.pid!, 'someone-else', source, procStartOf(child.pid!));
      let status = 'ended';
      for (let i = 0; i < 100 && status === 'ended'; i++) {
        await new Promise((r) => setTimeout(r, 50));
        second.refreshLive();
        const r = await app.inject({ method: 'GET', url: '/api/sessions' });
        status = (JSON.parse(r.body) as SessionInfo[]).find((s) => s.id === 's1')?.status ?? 'ended';
      }
      assert.equal(status, 'blocked');
      const r = await app.inject({ method: 'POST', url: '/api/sessions/s1/stop' });
      assert.equal(r.statusCode, 409);
      assert.equal((JSON.parse(r.body) as { code: string }).code, 'no_pid');
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(child.signalCode, null);
      assert.equal(child.exitCode, null);
    } finally {
      child.kill();
      await second.stop();
      await app.close();
    }
    await close();
  });

  it('a registry entry without a running process does not make the session live', async () => {
    register(process.pid + 1_000_000, 's1', source, 'gone');
    journal.refreshLive();
    const s = (await req<SessionInfo[]>('GET', '/api/sessions')).body.find((x) => x.id === 's1');
    assert.equal(s?.status, 'ended');
    assert.equal(s?.pid, null);
    assert.equal((await req<Project[]>('GET', '/api/projects')).body.find((p) => p.root === source)?.liveCount, 0);
    await close();
  });

  it('session removal: preview lists exact paths, moves to the trash, keeps the token totals', async () => {
    const attachments = join(dirFor(source), 's1');
    mkdirSync(join(attachments, 'subagents'), { recursive: true });
    writeFileSync(join(attachments, 'subagents', 'agent-a.jsonl'), '{}\n');
    addJournal(source, 's2');
    await journal.indexer.sweep();
    const totalBefore = (await req<Analytics>('GET', '/api/analytics?from=2026-10-20&to=2026-10-20')).body.total;

    const { body: p } = await req<SessionRemovalPreview>('GET', '/api/sessions/s1/removal');
    assert.deepEqual(p.items.map((i) => [i.kind, i.path, i.files]), [['journal', join(dirFor(source), 's1.jsonl'), 1], ['attachments', attachments, 1]]);
    assert.equal(p.live, false);
    assert.equal(p.root, false);
    assert.ok(existsSync(attachments), 'the preview moves nothing');

    assert.equal((await req('POST', '/api/sessions/s1/remove', { confirm: 'wrong' })).status, 400);
    assert.ok(existsSync(join(dirFor(source), 's1.jsonl')), 'a wrong confirmation touches nothing');

    const { status, body } = await req<SessionRemovalResult>('POST', '/api/sessions/s1/remove', { confirm: 's1' });
    assert.equal(status, 200);
    assert.equal(body.moved, 2);
    assert.ok(!existsSync(join(dirFor(source), 's1.jsonl')));
    assert.ok(!existsSync(attachments));
    assert.ok(existsSync(join(dirFor(source), 's2.jsonl')), 'the neighbour in the same folder stays');
    assert.equal(readFileSync(join(source, 'code.txt'), 'utf8'), 'source stays');
    const manifest = JSON.parse(readFileSync(join(body.trash, 'manifest.json'), 'utf8')) as { moved: { from: string; to: string }[] };
    assert.equal(manifest.moved[0].from, join(dirFor(source), 's1.jsonl'));
    assert.ok(existsSync(manifest.moved[0].to));
    assert.ok(audits.includes('session.remove'));

    const ids = async () => (await req<SessionInfo[]>('GET', '/api/sessions')).body.map((s) => s.id);
    assert.deepEqual(await ids(), ['s2']);
    await journal.indexer.sweep();
    assert.deepEqual(await ids(), ['s2'], 'the indexer does not bring it back');
    assert.deepEqual((await req<Analytics>('GET', '/api/analytics?from=2026-10-20&to=2026-10-20')).body.total, totalBefore);
    assert.equal((await req('POST', '/api/sessions/s1/remove', { confirm: 's1' })).status, 404);
    await close();
  });

  it('session removal is refused while it runs, and goes through once it has stopped', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    await new Promise((r) => child.once('spawn', r));
    const exited = new Promise((r) => child.once('exit', r));
    register(child.pid!, 's1', source, procStartOf(child.pid!));
    try {
      const r = await req<{ code: string }>('POST', '/api/sessions/s1/remove', { confirm: 's1' });
      assert.equal(r.status, 409);
      assert.equal(r.body.code, 'live');
      assert.equal((await req<SessionRemovalPreview>('GET', '/api/sessions/s1/removal')).body.live, true);
      assert.ok(existsSync(join(dirFor(source), 's1.jsonl')));
      assert.equal(child.signalCode, null, 'removal never signals');
      assert.equal((await req('POST', '/api/sessions/s1/stop')).status, 200);
      await exited;
      rmSync(join(paths.claudeDir, 'sessions', `${child.pid}.json`));
      assert.equal((await req('POST', '/api/sessions/s1/remove', { confirm: 's1' })).status, 200);
      assert.ok(!existsSync(join(dirFor(source), 's1.jsonl')));
    } finally {
      child.kill();
    }
    await close();
  });

  it('session removal closes its tabs, and refuses the session of the root tab', async () => {
    const closed: string[] = [];
    let tabs = [{ kind: 'readonly', status: 'ended' }];
    ctx.chat = { stopSession: () => false, sessionTabs: () => tabs, closeSessionTabs: (id: string) => closed.push(id), projectTabs: () => 0, closeProjectTabs() {} } as unknown as ChatApi;
    assert.equal((await req<SessionRemovalPreview>('GET', '/api/sessions/s1/removal')).body.tabs, 1);

    tabs = [{ kind: 'work', status: 'working' }];
    assert.equal((await req('POST', '/api/sessions/s1/remove', { confirm: 's1' })).status, 409, 'a turn in a tab counts as running');

    tabs = [{ kind: 'root', status: 'idle' }];
    const root = await req<{ code: string }>('POST', '/api/sessions/s1/remove', { confirm: 's1' });
    assert.equal(root.status, 403);
    assert.equal(root.body.code, 'root');
    assert.ok(existsSync(join(dirFor(source), 's1.jsonl')));
    assert.deepEqual(closed, []);

    tabs = [{ kind: 'work', status: 'idle' }];
    assert.equal((await req('POST', '/api/sessions/s1/remove', { confirm: 's1' })).status, 200);
    assert.deepEqual(closed, ['s1']);
    await close();
  });

  it('stop goes through the chat manager for a Claude OS tab', async () => {
    const child = spawn('sleep', ['30'], { stdio: 'ignore' });
    await new Promise((r) => child.once('spawn', r));
    try {
      register(child.pid!, 's1', source, procStartOf(child.pid!));
      const stopped: string[] = [];
      ctx.chat = { stopSession: (id: string) => { stopped.push(id); return true; }, projectTabs: () => 0, closeProjectTabs() {} } as unknown as ChatApi;
      const r = await req<{ how: string }>('POST', '/api/sessions/s1/stop');
      assert.equal(r.body.how, 'tab');
      assert.deepEqual(stopped, ['s1']);
      assert.equal(child.signalCode, null, 'no signal on top of it');
    } finally {
      child.kill();
    }
    await close();
  });

  it('connect pins a folder through the usual resolution; a bad path is refused', async () => {
    const empty = join(dir, 'fresh-folder');
    mkdirSync(join(empty, 'sub'), { recursive: true });
    assert.ok(!(await req<Project[]>('GET', '/api/projects')).body.some((p) => p.root === empty));
    const { status, body } = await req<Project>('POST', '/api/projects/connect', { path: empty });
    assert.equal(status, 200);
    assert.equal(body.pinned, true);
    assert.equal(body.sessionCount, 0);
    assert.ok((await req<Project[]>('GET', '/api/projects')).body.some((p) => p.key === body.key), 'listed with no sessions or notes');
    assert.equal((await req('POST', '/api/projects/connect', { path: 'relative/dir' })).status, 400);
    assert.equal((await req('POST', '/api/projects/connect', { path: join(dir, 'missing') })).status, 400);
    await close();
  });

  it('the map choice of a project is stored, goes back to automatic, and refuses nonsense', async () => {
    const folder = join(dir, 'map-folder');
    mkdirSync(folder, { recursive: true });
    const { body: p } = await req<Project>('POST', '/api/projects/connect', { path: folder });
    assert.equal(p.mapPin, null);
    const map = (on: unknown, key = p.key) => req<Project>('POST', `/api/projects/${encodeURIComponent(key)}/map`, { on });
    assert.equal((await map(false)).body.mapPin, false);
    assert.equal((await req<Project[]>('GET', '/api/projects')).body.find((x) => x.key === p.key)?.mapPin, false);
    assert.equal((await map(true)).body.mapPin, true);
    assert.equal((await map(null)).body.mapPin, null);
    assert.equal((await map('yes')).status, 400);
    assert.equal((await map(true, 'no-such')).status, 404);
    await close();
  });

  it('core project name and kind cannot change', async () => {
    mkdirSync(paths.repo, { recursive: true });
    addJournal(paths.repo, 'core-session');
    await journal.indexer.sweep();
    const key = (await req<Project[]>('GET', '/api/projects')).body.find((p) => p.root === paths.repo)!.key;
    const patch = (body: object) => req<Project & { error: string }>('PATCH', `/api/projects/${key}`, body);
    assert.equal((await patch({ name: 'Other' })).status, 400);
    assert.equal((await patch({ folder: true })).status, 400);
    assert.equal((await patch({ name: 'Other', description: 'x' })).status, 400, 'nothing of a refused patch goes in');
    // update_project of the MCP server goes the same way.
    assert.throws(() => ctx.journal.updateProject(key, { folder: true }), /Claude OS/);
    const { status, body } = await patch({ description: 'the core' });
    assert.equal(status, 200);
    assert.deepEqual([body.name, body.folder, body.description], ['repo', false, 'the core']);
    await close();
  });

  it('folders come after projects in the list, the rest by last activity', async () => {
    const alpha = await keyOf();
    const fresh = join(dir, `fresh-${Date.now()}`);
    mkdirSync(fresh);
    const { body: other } = await req<Project>('POST', '/api/projects/connect', { path: fresh });
    const order = async () => (await req<Project[]>('GET', '/api/projects')).body.map((p) => p.key);
    assert.deepEqual(await order(), [alpha, other.key]);
    assert.equal((await req('PATCH', `/api/projects/${alpha}`, { folder: true })).status, 200);
    assert.deepEqual(await order(), [other.key, alpha]);
    await close();
  });

  it('the structure of a folder: projects, what folds into them, plain folders, two levels down', async () => {
    const tree = mkdtempSync(join(dir, 'tree-'));
    const git = (cwd: string) => execFileSync('git', ['-C', cwd, 'init', '-q'], { stdio: 'ignore' });
    mkdirSync(join(tree, 'repo', 'sub', 'deep'), { recursive: true });
    git(join(tree, 'repo'));
    mkdirSync(join(tree, 'plain', 'nested', 'deeper'), { recursive: true });
    git(join(tree, 'plain', 'nested'));
    mkdirSync(join(tree, '.hidden-dot'));
    writeFileSync(join(tree, 'file.txt'), '');
    const { body: repo } = await req<Project>('POST', '/api/projects/connect', { path: join(tree, 'repo', 'sub') });
    assert.equal(repo.root, join(tree, 'repo'), 'a subfolder connects its repo');

    const get = async (root: string) => req<ProjectStructureNode>('GET', `/api/projects/structure?root=${encodeURIComponent(root)}`);
    const { status, body } = await get(tree);
    assert.equal(status, 200);
    const flat = (n: ProjectStructureNode, out: Record<string, object> = {}) => {
      out[n.path.slice(tree.length) || '/'] = { kind: n.kind, project: n.project, reason: n.reason, ...(n.folded ? { folded: n.folded } : {}) };
      n.children?.forEach((c) => flat(c, out));
      return out;
    };
    assert.deepEqual(flat(body), {
      '/': { kind: 'none', project: undefined, reason: undefined },
      '/plain': { kind: 'none', project: undefined, reason: undefined },
      '/plain/nested': { kind: 'none', project: undefined, reason: 'git' },
      '/repo': { kind: 'project', project: repo.key, reason: 'git', folded: [join(tree, 'repo', 'sub')] },
      '/repo/sub': { kind: 'inside', project: repo.key, reason: 'git' },
    });
    assert.equal(body.children?.[0].name, 'plain');

    await req('POST', '/api/projects/connect', { path: join(tree, 'plain') });
    assert.deepEqual(flat((await get(tree)).body)['/plain'], { kind: 'project', project: 'plain', reason: 'connected' });

    mkdirSync(paths.service, { recursive: true });
    const run = dirname(paths.service);
    assert.equal((await get(run)).body.children?.find((c) => c.path === paths.service)?.kind, 'hidden');
    assert.equal((await get('relative/dir')).status, 400);
    assert.equal((await get(join(tree, 'missing'))).status, 400);
    await close();
  });

  it('the structure: the cap of 200 folders says so, a symlink is not followed, a gone profile folder falls back to home, an unreadable root is a 400', async () => {
    const wide = mkdtempSync(join(dir, 'wide-'));
    for (let i = 0; i < 205; i++) mkdirSync(join(wide, `d${String(i).padStart(3, '0')}`));
    const elsewhere = mkdtempSync(join(dir, 'elsewhere-'));
    mkdirSync(join(elsewhere, 'inner'));
    symlinkSync(elsewhere, join(wide, 'a-link'));
    const get = async (query: string) => req<ProjectStructureNode & { error: string }>('GET', `/api/projects/structure${query}`);
    const { status, body } = await get(`?root=${encodeURIComponent(wide)}`);
    assert.equal(status, 200);
    assert.equal(body.children?.length, 199, 'the root counts too');
    assert.equal(body.truncated, true);
    assert.ok(!body.children?.some((c) => c.name === 'a-link'));
    assert.equal((await get(`?root=${encodeURIComponent(join(wide, 'd000'))}`)).body.truncated, undefined);

    const home = mkdtempSync(join(dir, 'home-'));
    const realHome = process.env.HOME;
    process.env.HOME = home;
    try {
      (ctx as { settings?: unknown }).settings = { profile: () => ({ projectsDir: join(dir, 'gone') }) };
      assert.equal((await get('')).body.path, home);
      (ctx as { settings?: unknown }).settings = { profile: () => ({ projectsDir: wide }) };
      assert.equal((await get('')).body.path, wide);
    } finally {
      process.env.HOME = realHome;
    }

    const locked = mkdtempSync(join(dir, 'locked-'));
    mkdirSync(join(locked, 'inside'));
    chmodSync(locked, 0o000);
    try {
      if (process.getuid?.() !== 0) {
        const refused = await get(`?root=${encodeURIComponent(join(locked, 'inside'))}`);
        assert.equal(refused.status, 400);
        assert.match(refused.body.error, /cannot be read/);
      }
    } finally {
      chmodSync(locked, 0o700);
    }
    await close();
  });

  it('directory completion lists only directories', async () => {
    const base = join(dir, 'fs');
    mkdirSync(join(base, 'alpha'), { recursive: true });
    mkdirSync(join(base, 'alps'), { recursive: true });
    mkdirSync(join(base, '.hidden'), { recursive: true });
    writeFileSync(join(base, 'alfile'), '');
    assert.deepEqual((await req<string[]>('GET', `/api/fs/dirs?path=${encodeURIComponent(join(base, 'al'))}`)).body, [join(base, 'alpha'), join(base, 'alps')]);
    assert.deepEqual((await req<string[]>('GET', `/api/fs/dirs?path=${encodeURIComponent(`${base}/`)}`)).body.length, 2);
    assert.deepEqual((await req<string[]>('GET', '/api/fs/dirs?path=relative')).body, []);
    assert.equal(readdirSync(base).length, 4);
    await close();
  });
});

describe('note summary', () => {
  it('prefers the description, then the first line that says something; never invents', () => {
    assert.equal(noteSummary('  Short  text ', 'body'), 'Short text');
    assert.equal(noteSummary(undefined, '# Title\n\n---\n\n- **Real** point with [[link|name]]\n'), 'Real point with name');
    assert.equal(noteSummary('', '# Only a heading\n\n```\ncode\n```'), null);
    assert.equal(noteSummary(undefined, '# Only a heading\n'), null);
    assert.ok(noteSummary('x'.repeat(500), '')!.length <= 220);
  });
});
