// The agents panel and the sessions of the root folder: temp dirs only, nothing touches the real ~/.claude.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, describe, it } from 'node:test';
import Fastify from 'fastify';
import type { AgentDetail, AgentsReport, SessionInfo } from '../../shared/contract.ts';
import type { BusEvents, Ctx, Paths } from '../context.ts';
import { createJournal } from '../journal/index.ts';
import { osChangeLevel } from '../journal/usage.ts';
import { initSchema } from '../journal/db.ts';
import { parseTools, registerAgents, resolveAgentRun } from './agents.ts';

const base = realpathSync(mkdtempSync(join(tmpdir(), 'claude-os-boards-')));
after(() => rmSync(base, { recursive: true, force: true }));

describe('agents', () => {
  const dir = join(base, 'agents');
  const claudeDir = join(dir, 'claude');
  const projectRoot = join(dir, 'alpha');
  const plugin = join(dir, 'plugin-install');
  const data = join(dir, 'data');
  const agent = (name: string, extra = '') => `---\nname: ${name}\ndescription: Does ${name}\n${extra}---\n\n# ${name}\n`;
  const put = (path: string, text: string) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  };

  put(join(claudeDir, 'agents/reviewer.md'), agent('reviewer', 'model: opus\ntools: Read, Grep\n'));
  put(join(claudeDir, 'agents/nested/writer.md'), agent('writer', 'tools:\n  - Edit\n  - Write\n'));
  put(join(claudeDir, 'agents/README.md'), '# not an agent\n');
  put(join(dir, 'shared-agent.md'), agent('linked'));
  symlinkSync(join(dir, 'shared-agent.md'), join(claudeDir, 'agents/linked.md'));
  put(join(projectRoot, '.claude/agents/reviewer.md'), agent('reviewer', 'model: sonnet\n'));
  put(join(plugin, 'agents/helper.md'), agent('helper'));
  put(join(claudeDir, 'plugins/installed_plugins.json'), JSON.stringify({ plugins: { 'kit@market': [{ installPath: plugin, scope: 'user' }] } }));

  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, diff TEXT)');
  initSchema(db);
  const now = Date.now();
  const old = now - 90 * 86_400_000;
  db.exec(`INSERT INTO sessions (id, project, cwd) VALUES ('s-alpha', 'alpha', '${projectRoot}'), ('s-other', 'other', '/x'), ('s-gone', 'alpha', '${projectRoot}')`);
  db.exec("UPDATE sessions SET removed = 1 WHERE id = 's-gone'");
  const run = db.prepare('INSERT INTO subagents (session, id, agent_type, description, last_activity) VALUES (?, ?, ?, ?, ?)');
  run.run('s-alpha', 'a1', 'reviewer', 'review the queue', now);
  run.run('s-other', 'a2', 'reviewer', null, now);
  run.run('s-other', 'a3', 'reviewer', null, old);
  run.run('s-other', 'a4', 'kit:helper', null, now);
  run.run('s-other', 'a5', 'Explore', null, now);
  run.run('s-other', 'a6', null, null, now);
  run.run('s-gone', 'a7', 'reviewer', null, now);
  db.prepare("INSERT INTO usage_messages (message_id, session, agent_id, ts, day, model, is_subagent, input, output, cache_read, cache_write) VALUES ('m1', 's-alpha', 'a1', ?, '2026-11-05', 'x', 1, 1, 2, 1000, 4)").run(now);

  const app = Fastify();
  const topics: string[] = [];
  const ctx = {
    app, db,
    paths: { claudeDir, claudeJson: join(dir, 'claude.json'), data },
    journal: { listProjects: () => [{ key: 'alpha', name: 'Alpha', root: projectRoot }] },
    audit() {},
    invalidate: (...t: string[]) => topics.push(...t),
  };
  registerAgents(ctx as never);
  after(() => app.close());
  const report = () => app.inject({ url: '/api/agents' }).then((r) => r.json<AgentsReport>());
  const url = (id: string) => `/api/agents/${encodeURIComponent(id)}`;

  it('finds user, project and plugin agents and reads what the files state, nothing more', async () => {
    const { rows, projects } = await report();
    assert.deepEqual(rows.map((r) => r.id).sort(), ['plugin:kit:helper', 'project:alpha:reviewer', 'user:linked', 'user:reviewer', 'user:writer']);
    const user = rows.find((r) => r.id === 'user:reviewer')!;
    assert.deepEqual([user.scope, user.source, user.description, user.model, user.tools], ['user', null, 'Does reviewer', 'opus', ['Read', 'Grep']]);
    assert.deepEqual(rows.find((r) => r.id === 'user:writer')!.tools, ['Edit', 'Write']);
    const own = rows.find((r) => r.id === 'project:alpha:reviewer')!;
    assert.deepEqual([own.scope, own.source, own.model, own.tools], ['project', 'alpha', 'sonnet', null]);
    const helper = rows.find((r) => r.id === 'plugin:kit:helper')!;
    assert.deepEqual([helper.scope, helper.source, helper.readOnly, helper.model], ['plugin', 'kit', true, null]);
    assert.equal(rows.find((r) => r.id === 'user:linked')!.isSymlink, true);
    assert.deepEqual(projects.map((p) => [p.project, p.name, p.own, p.overrides]), [['alpha', 'Alpha', [], ['reviewer']]]);
  });

  it('counts only what the journal holds: runs by type, tokens, the project copy first', async () => {
    const r = await report();
    const of = (id: string) => r.rows.find((x) => x.id === id)!;
    assert.deepEqual([of('project:alpha:reviewer').runs, of('project:alpha:reviewer').runsAll, of('project:alpha:reviewer').tokens], [1, 1, 7], 'cache reads are not tokens spent; a removed session is gone');
    assert.deepEqual([of('user:reviewer').runs, of('user:reviewer').runsAll, of('user:reviewer').tokens], [1, 2, 0]);
    assert.equal(of('plugin:kit:helper').runs, 1);
    assert.deepEqual([of('user:writer').runs, of('user:writer').lastUsedAt], [0, null]);
    assert.deepEqual(r.other.map((o) => [o.name, o.runs]), [['Explore', 1]]);
    assert.equal(r.untyped, 1);
    assert.equal(r.byDay.length, r.windowDays);
    assert.equal(r.byDay.at(-1)!.runs, 4);
  });

  it('the page has the file, the runs and where they ran', async () => {
    const res = await app.inject({ url: url('project:alpha:reviewer') });
    const d = res.json<AgentDetail>();
    assert.match(d.content, /# reviewer/);
    assert.deepEqual([d.stats.total, d.stats.recent], [1, 1]);
    assert.deepEqual(d.stats.byProject, [{ key: 'alpha', name: 'Alpha', n: 1 }]);
    assert.deepEqual(d.recent.map((x) => [x.session, x.description, x.tokens]), [['s-alpha', 'review the queue', 7]]);
    assert.equal((await app.inject({ url: url('user:нет') })).statusCode, 404);
  });

  it('deleting needs a confirmation, backs the file up, leaves a linked target and plugins alone', async () => {
    const file = join(claudeDir, 'agents/nested/writer.md');
    assert.equal((await app.inject({ method: 'DELETE', url: url('user:writer'), payload: {} })).statusCode, 400);
    assert.ok(existsSync(file));
    const done = await app.inject({ method: 'DELETE', url: url('user:writer'), payload: { confirmed: true } });
    const { backup } = done.json<{ backup: string }>();
    assert.ok(!existsSync(file));
    assert.ok(backup.startsWith(join(data, 'backups')));
    assert.match(readFileSync(backup, 'utf8'), /# writer/);
    assert.ok(topics.includes('agents'));

    assert.equal((await app.inject({ method: 'DELETE', url: url('user:linked'), payload: { confirmed: true } })).json<{ backup: null }>().backup, null);
    assert.ok(!existsSync(join(claudeDir, 'agents/linked.md')));
    assert.ok(existsSync(join(dir, 'shared-agent.md')));

    assert.equal((await app.inject({ method: 'DELETE', url: url('plugin:kit:helper'), payload: { confirmed: true } })).statusCode, 403);
    assert.ok(existsSync(join(plugin, 'agents/helper.md')));
  });

  it('parses the forms of a tools line', () => {
    assert.equal(parseTools(undefined), null);
    assert.deepEqual(parseTools('Read, Grep'), ['Read', 'Grep']);
    assert.deepEqual(parseTools('[Read, "Grep"]'), ['Read', 'Grep']);
    assert.deepEqual(parseTools('- Read - Bash(git log:*)'), ['Read', 'Bash(git log:*)']);
  });

  it('a run goes to the agent that would have run', () => {
    const list = [{ name: 'a', scope: 'plugin', source: 'kit' }, { name: 'a', scope: 'user', source: null }, { name: 'a', scope: 'project', source: 'p' }] as const;
    assert.equal(resolveAgentRun('a', 'p', [...list])?.scope, 'project');
    assert.equal(resolveAgentRun('a', 'q', [...list])?.scope, 'user');
    assert.equal(resolveAgentRun('kit:a', 'p', [...list])?.scope, 'plugin');
    assert.equal(resolveAgentRun('b', 'p', [...list]), null);
  });
});

describe('sessions of the root folder and levels of change', () => {
  const dir = join(base, 'levels');
  const claudeDir = join(dir, 'claude');
  const repo = join(dir, 'claudeOS');
  const root = join(repo, 'root');
  const config = join(repo, 'config');
  const journalDir = join(claudeDir, 'projects', '-x');
  const assistant = (session: string, cwd: string, id: string, tools: { name: string; path?: string }[]) => JSON.stringify({
    type: 'assistant', uuid: id, sessionId: session, cwd, entrypoint: 'cli', timestamp: new Date().toISOString(),
    message: { id, model: 'claude-test', role: 'assistant', usage: { input_tokens: 1, output_tokens: 1 }, content: tools.map((t, i) => ({ type: 'tool_use', id: `${id}-${i}`, name: t.name, input: { file_path: t.path } })) },
  });
  mkdirSync(journalDir, { recursive: true });
  mkdirSync(join(claudeDir, 'sessions'));
  mkdirSync(root, { recursive: true });
  mkdirSync(join(repo, 'server'));
  mkdirSync(config);

  const start = async (db: DatabaseSync) => {
    const paths = { repo, root, config, claudeDir, claudeJson: join(dir, 'claude.json'), claudeBin: '/nonexistent/claude', data: join(dir, 'data'), vault: join(dir, 'vault') } as Paths;
    const ctx = {
      journal: null,
      memory: { projectStats: () => ({ count: 0, connected: false, drift: 0 }), recentNotes: () => [] },
      app: Fastify(), db, paths, bus: new EventEmitter<BusEvents>(), broadcast() {}, invalidate() {}, audit() {}, onClientMessage() {}, onClientClose() {}, setBusy() {},
    } as unknown as Ctx;
    const journal = createJournal(ctx, { pollAgents: false, watch: false });
    await journal.start();
    await journal.indexer.backfillUsage();
    return { ctx, journal };
  };

  it('a session in claudeOS/root counts as Claude OS, with a tag, and its own key still names the folder', async () => {
    writeFileSync(join(journalDir, 'in-root.jsonl'), `${assistant('in-root', root, 'm1', [{ name: 'Edit', path: join(repo, 'server/a.ts') }, { name: 'Write', path: join(config, 'widgets.json') }, { name: 'Edit', path: join(repo, 'web/src/b.tsx') }, { name: 'Read', path: join(repo, 'server/c.ts') }, { name: 'Edit', path: join(repo, 'docs/d.md') }, { name: 'Edit', path: '/elsewhere/server/e.ts' }])}\n`);
    writeFileSync(join(journalDir, 'in-repo.jsonl'), `${assistant('in-repo', repo, 'm2', [{ name: 'Edit', path: join(config, 'settings.json') }])}\n`);
    writeFileSync(join(journalDir, 'other.jsonl'), `${assistant('other', join(dir, 'app'), 'm3', [{ name: 'Bash' }])}\n`);
    const db = new DatabaseSync(':memory:');
    const { ctx, journal } = await start(db);
    const sessions = ctx.journal.listSessions();
    const of = (id: string) => sessions.find((s) => s.id === id) as SessionInfo;
    assert.equal(of('in-root').project, 'claudeOS');
    assert.equal(of('in-root').rootFolder, true);
    assert.deepEqual(of('in-root').osChanges, { user: 1, root: 2 });
    assert.equal(of('in-repo').project, 'claudeOS');
    assert.equal(of('in-repo').rootFolder, undefined);
    assert.deepEqual(of('in-repo').osChanges, { user: 1, root: 0 });
    assert.equal(of('other').osChanges, undefined);
    assert.equal(of('other').project, 'app');

    const core = ctx.journal.listProjects().find((p) => p.key === 'claudeOS')!;
    assert.equal(core.sessionCount, 2, 'the root folder is counted in the project');
    assert.ok(!ctx.journal.listProjects(true).some((p) => p.root === root), 'and is not a project of its own');
    assert.equal(ctx.journal.projectForCwd(root), 'root', 'the folder keeps its key: the map and the notes go by it');
    await journal.stop();
    await ctx.app.close();
    db.close();
  });

  it('a database from before moves its root sessions over once and marks old edits', async () => {
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL, diff TEXT)');
    initSchema(db);
    const offset = Buffer.byteLength(readFileSync(join(journalDir, 'in-root.jsonl')));
    db.prepare("INSERT INTO sessions (id, project, cwd, last_activity) VALUES ('in-root', 'root', ?, 1)").run(root);
    db.prepare('INSERT INTO file_offsets (path, offset) VALUES (?, ?)').run(join(journalDir, 'in-root.jsonl'), offset); // read long ago
    db.exec("INSERT INTO journal_meta (k, v) VALUES ('projects_version', '2'), ('usage_backfill', '1')");
    const { ctx, journal } = await start(db);
    const s = ctx.journal.listSessions().find((x) => x.id === 'in-root')!;
    assert.equal(s.project, 'claudeOS');
    assert.deepEqual(s.osChanges, { user: 1, root: 2 });
    await journal.stop();
    await ctx.app.close();
    db.close();
  });

  it('what counts as which level', () => {
    const roots = { repo, config };
    assert.equal(osChangeLevel({ name: 'Edit', path: join(config, 'widgets.json') }, roots), 'user');
    for (const part of ['server/x.ts', 'web/src/x.tsx', 'shared/contract.ts', 'e2e/x.ts']) assert.equal(osChangeLevel({ name: 'Write', path: join(repo, part) }, roots), 'root');
    for (const call of [{ name: 'Read', path: join(repo, 'server/x.ts') }, { name: 'Edit', path: join(repo, 'docs/x.md') }, { name: 'Edit', path: join(repo, 'serverless/x.ts') }, { name: 'Bash', path: null }, { name: 'Edit', path: 'server/x.ts' }]) {
      assert.equal(osChangeLevel(call, roots), null, JSON.stringify(call));
    }
  });
});
