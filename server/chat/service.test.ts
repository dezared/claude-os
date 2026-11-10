// The hidden service session: temp dirs and the fake CLI only.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import type { Analytics, PlannerNote, Project, ServiceTask, SessionInfo, Tab } from '../../shared/contract.ts';
import { SERVICE_TOKENS_NAME } from '../../shared/contract.ts';
import { startServer, waitUntil, type TestServer } from './fixtures/harness.ts';

const REPO = resolve(import.meta.dirname, '../..');
const SERVICE_DIR = join(REPO, 'service');

type Listing = { dir: string; notes: PlannerNote[] };
const note = async (srv: TestServer, id: string) => (await srv.api<Listing>('GET', '/api/planner')).body.notes.find((n) => n.id === id);
const add = async (srv: TestServer, text: string) => (await srv.api<PlannerNote>('POST', '/api/planner', { text })).body;
const spawns = (srv: TestServer) => srv.log().filter((l) => l.kind === 'spawn');

describe('service session: doing the job', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startServer({ FAKE_CLAUDE_SERVICE: 'do' });
    mkdirSync(srv.configDir, { recursive: true });
    writeFileSync(join(srv.configDir, 'settings.json'), JSON.stringify({ model: 'fake-chosen', env: { A_PROXY: 'x' }, hooks: { Stop: [] }, enabledPlugins: { 'p@m': true } }));
  });
  after(() => srv.destroy());

  it('starts nothing until the first job', async () => {
    const created = await add(srv, 'Только записать');
    assert.equal(created.filed, false);
    assert.equal(spawns(srv).length, 0);
  });

  it('files through file_planner_note in a process of its own, away from the root session', async () => {
    const created = await add(srv, 'Купить домен');
    const started = await srv.api<PlannerNote>('POST', `/api/planner/${encodeURIComponent(created.id)}/file`);
    assert.equal(started.status, 200);
    assert.ok(started.body.job, 'the answer says the job is on');

    await waitUntil(async () => (await note(srv, created.id))?.filed === true, 'the note is filed');
    await waitUntil(async () => !(await note(srv, created.id))?.job, 'the job is over');
    const filed = (await note(srv, created.id))!;
    assert.equal(filed.title, 'Разложено');
    assert.equal(filed.topic, 'Фейк');
    assert.equal(filed.text, '- [ ] первый\n- [ ] второй');
    assert.ok(filed.path.startsWith(join(srv.dataDir, 'planner', 'general') + '/'));

    const [spawn] = spawns(srv);
    assert.equal(spawn.cwd, SERVICE_DIR);
    const argv = spawn.argv as string[];
    const joined = argv.join(' ');
    assert.match(joined, /--setting-sources[ =]project(\s|$)/, 'no user settings: hooks, plugins, MCP servers and CLAUDE.md stay out');
    assert.match(joined, /--tools[ =]Read(\s|$)/);
    assert.match(joined, /mcp__claude-os__file_planner_note/);
    assert.doesNotMatch(joined, /Note rules/, 'no note rules appended');
    assert.match(joined, /fake-chosen/, 'the owner\'s model still applies');
    assert.match(joined, /A_PROXY/, 'and how he reaches the API');
    assert.doesNotMatch(joined, /enabledPlugins/);
    assert.ok(existsSync(join(SERVICE_DIR, 'CLAUDE.md')));
    assert.ok(srv.log().filter((l) => l.kind === 'user').every((l) => /Its id is/.test(String(l.content))), 'the root session got nothing');
  });

  it('is in no tab list or project counter, the sessions list marks it, and its tokens are counted under their own name', async () => {
    const tabs = (await srv.api<Tab[]>('GET', '/api/tabs')).body;
    assert.deepEqual(tabs.map((t) => t.kind), ['root']);
    const today = new Date().toLocaleDateString('sv');
    let analytics: Analytics;
    await waitUntil(async () => {
      analytics = (await srv.api<Analytics>('GET', `/api/analytics?from=${today}&to=${today}`)).body;
      return analytics.total.input > 0;
    }, 'tokens indexed');
    assert.deepEqual(analytics!.byProject.map((p) => p.name), [SERVICE_TOKENS_NAME]);
    assert.equal(analytics!.byProject[0].input, analytics!.total.input);
    assert.equal(analytics!.osShare.input, analytics!.total.input, 'Claude OS spent them');
    assert.deepEqual(analytics!.bySource.map((s) => [s.name, s.input]), [['service', analytics!.total.input]], 'its own load, told by the folder');
    assert.deepEqual(analytics!.topSessions, [], 'not a conversation');

    const listed = (await srv.api<SessionInfo[]>('GET', '/api/sessions')).body;
    assert.ok(listed.length > 0 && listed.every((s) => s.serviceFolder === true && s.project === null), 'shown, marked, in no project');
    assert.deepEqual((await srv.api<Project[]>('GET', '/api/projects')).body.filter((p) => p.root === SERVICE_DIR || p.sessionCount > 0), []);
  });

  it('does not answer to the tab routes', async () => {
    const db = new DatabaseSync(join(srv.dataDir, 'claude-os.db'), { readOnly: true });
    const row = db.prepare("SELECT id FROM tabs WHERE kind = 'service'").get() as { id: string };
    db.close();
    assert.equal((await srv.api('GET', `/api/tabs/${row.id}/history`)).status, 404);
    assert.equal((await srv.api('POST', `/api/tabs/${row.id}/send`, { text: 'x' })).status, 404);
    assert.equal((await srv.api('DELETE', `/api/tabs/${row.id}`)).status, 404);
  });

  it('takes jobs one at a time, each in a new conversation', async () => {
    const before = spawns(srv).length;
    const notes = [await add(srv, 'Первая'), await add(srv, 'Вторая')];
    for (const n of notes) await srv.api('POST', `/api/planner/${encodeURIComponent(n.id)}/file`);
    for (const n of notes) await waitUntil(async () => (await note(srv, n.id))?.filed === true, `${n.title} is filed`);
    const fresh = spawns(srv).slice(before);
    assert.equal(fresh.length, 2);
    for (const s of fresh) assert.doesNotMatch((s.argv as string[]).join(' '), /--resume/);
  });

  it('one job: splits the note into items through its version, names it, files it, and can be run again', async () => {
    const created = await add(srv, 'Сделать раз и сделать два');
    await srv.api('POST', `/api/planner/${encodeURIComponent(created.id)}/file`);
    await waitUntil(async () => (await note(srv, created.id))?.filed === true, 'filed');
    await waitUntil(async () => !(await note(srv, created.id))?.job, 'the job is over');
    const done = (await note(srv, created.id))!;
    assert.equal(done.text, '- [ ] первый\n- [ ] второй');
    assert.equal(done.title, 'Разложено');
    const before = spawns(srv).length;
    await srv.api('POST', `/api/planner/${encodeURIComponent(created.id)}/file`);
    await waitUntil(async () => spawns(srv).length > before, 'it goes to Claude again');
    await waitUntil(async () => !(await note(srv, created.id))?.job, 'and is over');
  });

  it('refuses a template that is not a service job', async () => {
    const { servicePrompt, MICROTASK_ROUTES } = await import('../tools/microtasks.ts');
    assert.equal(MICROTASK_ROUTES['widget-create'], 'owner');
    const ctx = { paths: { root: join(REPO, 'root') } } as never;
    assert.throws(() => servicePrompt(ctx, 'widget-create', {}), /no service template/);
    assert.match(servicePrompt(ctx, 'planner-file', { id: 'x', text: 'про {today}', today: '2026-11-06' }), /про \{today\}/);
  });

  it('quick-start is a service job whose session alone can resume and create', async () => {
    const { servicePrompt, MICROTASK_ROUTES, MICROTASK_TOOLS } = await import('../tools/microtasks.ts');
    const { createServiceTaskMcp, SERVICE_TASK_TOOLS } = await import('./rootMcp.ts');
    const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
    const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');
    assert.equal(MICROTASK_ROUTES['quick-start'], 'service');
    const prompt = servicePrompt({ paths: { root: join(REPO, 'root') } } as never, 'quick-start', { request: 'бот для заметок' });
    assert.match(prompt, /бот для заметок/);
    for (const name of ['open_session', 'resume_session', 'create_project']) assert.match(prompt, new RegExp(name), `the template names ${name}`);
    const extra = ['resume_session', 'create_project'];
    assert.deepEqual(MICROTASK_TOOLS['quick-start'], extra);
    for (const name of extra) assert.ok(!SERVICE_TASK_TOOLS.includes(`mcp__claude-os__${name}`), `${name} is not on every task`);
    const listed = async (tools?: readonly string[]) => {
      const server = createServiceTaskMcp({ paths: { data: srv.dataDir, config: srv.configDir, root: join(REPO, 'root') } } as never, {} as never, tools);
      const [a, b] = InMemoryTransport.createLinkedPair();
      await server.instance.connect(a);
      const client = new Client({ name: 'test', version: '1' });
      await client.connect(b);
      const names = (await client.listTools()).tools.map((x) => x.name);
      await client.close();
      return names;
    };
    const plain = await listed();
    for (const name of ['list_projects', 'list_sessions', 'open_session']) assert.ok(plain.includes(name), `every task has ${name}`);
    for (const name of extra) assert.ok(!plain.includes(name), `a plain task lacks ${name}`);
    const quick = await listed(MICROTASK_TOOLS['quick-start']);
    for (const name of extra) assert.ok(quick.includes(name), `quick-start has ${name}`);
  });
});

describe('service session: when it does not work out', () => {
  it('a job that ends without the tool leaves the note unfiled and says so', async () => {
    const srv = await startServer({ FAKE_CLAUDE_SERVICE: 'idle' });
    try {
      const created = await add(srv, 'Не разложится');
      await srv.api('POST', `/api/planner/${encodeURIComponent(created.id)}/file`);
      await waitUntil(async () => (await note(srv, created.id))?.job?.state === 'failed', 'the job fails');
      const failed = (await note(srv, created.id))!;
      assert.equal(failed.filed, false);
      assert.match(failed.job!.error!, /without filing/);
    } finally {
      await srv.destroy();
    }
  });

  it('a tool that would need a prompt is refused at once: nobody is there to answer', async () => {
    const srv = await startServer({ FAKE_CLAUDE_SERVICE: 'ask' });
    try {
      const created = await add(srv, 'Просит разрешение');
      await srv.api('POST', `/api/planner/${encodeURIComponent(created.id)}/file`);
      await waitUntil(async () => (await note(srv, created.id))?.job?.state === 'failed', 'the job fails');
      const answer = srv.log().find((l) => l.kind === 'permission-answer')!.answer as { behavior: string };
      assert.equal(answer.behavior, 'deny');
    } finally {
      await srv.destroy();
    }
  });

  it('a turn that hangs is stopped, and the next job still runs', async () => {
    const srv = await startServer({ FAKE_CLAUDE_SERVICE: 'do', FAKE_CLAUDE_SERVICE_GATE: '/nonexistent/gate', CLAUDE_OS_SERVICE_JOB_MS: '300' });
    try {
      const notes = [await add(srv, 'Зависнет'), await add(srv, 'Тоже')];
      for (const n of notes) await srv.api('POST', `/api/planner/${encodeURIComponent(n.id)}/file`);
      for (const n of notes) await waitUntil(async () => (await note(srv, n.id))?.job?.state === 'failed', `${n.title} fails`);
      assert.match((await note(srv, notes[0].id))!.job!.error!, /too long/);
      assert.equal(spawns(srv).length, 2);
    } finally {
      await srv.destroy();
    }
  });

  it('a server restart mid-filing leaves the note unfiled, with no stale job, and it can be retried', async () => {
    const gate = `/tmp/claude-os-service-gate-${process.pid}`;
    const srv = await startServer({ FAKE_CLAUDE_SERVICE: 'do', FAKE_CLAUDE_SERVICE_GATE: gate });
    try {
      const created = await add(srv, 'Переживёт рестарт');
      await srv.api('POST', `/api/planner/${encodeURIComponent(created.id)}/file`);
      await waitUntil(() => spawns(srv).length === 1 && srv.log().some((l) => l.kind === 'user'), 'the job is at Claude');
      assert.equal((await note(srv, created.id))?.job?.state, 'running');

      await srv.restart();
      const after = (await note(srv, created.id))!;
      assert.equal(after.filed, false);
      assert.equal(after.job, undefined);
      assert.ok(after.path.startsWith(join(srv.dataDir, 'planner', 'inbox') + '/'));
      assert.deepEqual((await srv.api<Tab[]>('GET', '/api/tabs')).body.map((t) => t.kind), ['root']);
      assert.deepEqual((await srv.api('GET', '/api/recovery')).body, [], 'its cut-off job is no conversation to continue');

      writeFileSync(gate, '');
      await srv.api('POST', `/api/planner/${encodeURIComponent(created.id)}/file`);
      await waitUntil(async () => (await note(srv, created.id))?.filed === true, 'the retry files it');
      const last = spawns(srv).at(-1)!;
      assert.doesNotMatch((last.argv as string[]).join(' '), /--resume/, 'a new conversation');
    } finally {
      rmSync(gate, { force: true });
      await srv.destroy();
    }
  });
});

describe('editing over the API', () => {
  let srv: TestServer;
  before(async () => { srv = await startServer({ FAKE_CLAUDE_SERVICE: 'do' }); });
  after(() => srv.destroy());

  it('saves by version, refuses a stale one, and filing in between is not a conflict', async () => {
    const created = await add(srv, '- [ ] Текст');
    const url = `/api/planner/${encodeURIComponent(created.id)}`;
    await srv.api('POST', `${url}/file`);
    await waitUntil(async () => (await note(srv, created.id))?.filed === true, 'filed');

    const saved = await srv.api<PlannerNote>('PUT', url, { text: 'Новый текст', version: created.version });
    assert.equal(saved.status, 200);
    assert.ok(saved.body.path.startsWith(join(srv.dataDir, 'planner', 'general') + '/'), 'written where the note is now');
    assert.match(readFileSync(saved.body.path, 'utf8'), /Новый текст$/);

    assert.equal((await srv.api('PUT', url, { text: 'Старая правка', version: created.version })).status, 409);
    assert.equal((await srv.api<PlannerNote>('GET', url)).body.text, 'Новый текст');
    for (const bad of ['', '   ']) assert.equal((await srv.api('PUT', url, { text: bad, version: saved.body.version })).status, 400);
  });

  it('never reaches outside the planner folder', async () => {
    for (const bad of ['..%2F..%2Ftoken', '%2e%2e%2ftoken', 'a%2Fb', 'token']) {
      const res = await srv.api('PUT', `/api/planner/${bad}`, { text: 'x', version: 'y' });
      assert.ok(res.status === 400 || res.status === 404, `${bad}: ${res.status}`);
    }
    assert.notEqual(readFileSync(join(srv.dataDir, 'token'), 'utf8'), 'x');
  });
});

describe('tasks from the user', () => {
  type TaskList = ServiceTask[];
  const tasks = async (srv: TestServer) => (await srv.api<TaskList>('GET', '/api/service/tasks')).body;
  const start = async (srv: TestServer, prompt: string) => (await srv.api<ServiceTask>('POST', '/api/service/tasks', { title: 'Тест', prompt })).body;
  const status = async (srv: TestServer, id: string) => (await tasks(srv)).find((t) => t.id === id)?.status;

  it('runs in the service session, answers into the list, and the card can be closed', async () => {
    const srv = await startServer({ FAKE_CLAUDE_SERVICE: 'do' });
    try {
      const task = await start(srv, 'Что такое виджет?');
      await waitUntil(async () => (await status(srv, task.id)) === 'done', 'done');
      const [done] = await tasks(srv);
      assert.equal(done.answer, 'Ответ служебной сессии');
      const [spawn] = spawns(srv);
      assert.equal(spawn.cwd, SERVICE_DIR);
      assert.match((spawn.argv as string[]).join(' '), /--tools[ =]Read,Glob,Grep,Edit,Write(\s|$)/);
      assert.match((spawn.argv as string[]).join(' '), /mcp__claude-os__ask_owner/);
      assert.equal((await srv.api('DELETE', `/api/service/tasks/${task.id}`)).status, 200);
      assert.deepEqual(await tasks(srv), []);
      assert.equal((await srv.api('POST', '/api/service/tasks', { prompt: ' ' })).status, 400);
    } finally {
      await srv.destroy();
    }
  });

  it('a task sent by a microtask counts as the microtask in the analytics, not as the service', async () => {
    const srv = await startServer({ FAKE_CLAUDE_SERVICE: 'do' });
    try {
      const task = (await srv.api<ServiceTask>('POST', '/api/service/tasks', { title: 'Тест', prompt: 'Вопрос', source: 'microtask', sourceDetail: 'explain' })).body;
      await waitUntil(async () => (await status(srv, task.id)) === 'done', 'done');
      assert.ok(!('source' in (await tasks(srv))[0]), 'not in the card');
      const today = new Date().toLocaleDateString('sv');
      let analytics: Analytics;
      await waitUntil(async () => {
        analytics = (await srv.api<Analytics>('GET', `/api/analytics?from=${today}&to=${today}`)).body;
        return analytics.total.input > 0;
      }, 'tokens indexed');
      assert.deepEqual(analytics!.bySource.map((s) => s.name), ['microtask']);
      const db = new DatabaseSync(join(srv.dataDir, 'claude-os.db'), { readOnly: true });
      try {
        assert.deepEqual({ ...db.prepare("SELECT os_source s, os_source_detail d FROM sessions WHERE origin = 'os'").get() }, { s: 'microtask', d: 'explain' });
      } finally {
        db.close();
      }
    } finally {
      await srv.destroy();
    }
  });

  it('a template grants its extra tools to its own job only: a free prompt never gets them', async () => {
    const srv = await startServer({ FAKE_CLAUDE_SERVICE: 'do' });
    try {
      const plain = await start(srv, 'create_project please');
      await waitUntil(async () => (await status(srv, plain.id)) === 'done', 'plain done');
      const plainArgv = (spawns(srv).at(-1)!.argv as string[]).join(' ');
      assert.doesNotMatch(plainArgv, /mcp__claude-os__(create_project|resume_session)/);
      const quick = (await srv.api<ServiceTask>('POST', '/api/service/tasks', { title: 'бот', microtask: 'quick-start', vars: { request: 'бот для заметок' } })).body;
      await waitUntil(async () => (await status(srv, quick.id)) === 'done', 'quick done');
      const quickArgv = (spawns(srv).at(-1)!.argv as string[]).join(' ');
      assert.match(quickArgv, /mcp__claude-os__create_project/);
      assert.match(quickArgv, /mcp__claude-os__resume_session/);
      assert.equal(quick.continuable, false, 'quick start opened the tab itself: no "continue in a tab"');
      assert.equal(plain.continuable, undefined);
      assert.equal((await srv.api('POST', '/api/service/tasks', { microtask: 'widget-create', vars: {} })).status, 400, 'only service templates');
      assert.equal((await srv.api('POST', '/api/service/tasks', { microtask: 'no-such', vars: {} })).status, 400, 'unknown template');
    } finally {
      await srv.destroy();
    }
  });

  it('a filing job right after it still gets the narrow tools; both get the profile block', async () => {
    const srv = await startServer({ FAKE_CLAUDE_SERVICE: 'do' });
    try {
      assert.equal((await srv.api('PUT', '/api/settings/profile', { name: 'Ann', language: 'de', projectsDir: srv.dir, questionLevel: 'balanced' })).status, 200);
      const task = await start(srv, 'Вопрос');
      await waitUntil(async () => (await status(srv, task.id)) === 'done', 'done');
      const created = await add(srv, 'Заметка');
      await srv.api('POST', `/api/planner/${encodeURIComponent(created.id)}/file`);
      await waitUntil(async () => (await note(srv, created.id))?.filed === true, 'filed');
      assert.match((spawns(srv).at(-1)!.argv as string[]).join(' '), /--tools[ =]Read(\s|$)/);
      const inits = srv.log().filter((l) => l.kind === 'initialize').map((l) => JSON.stringify(l));
      assert.equal(inits.length, 2);
      assert.ok(inits.every((i) => i.includes("The user's name is Ann.")), inits.join('\n'));
    } finally {
      await srv.destroy();
    }
  });

  it('asks one round of questions, ends its turn, and the answer resumes the same conversation', async () => {
    const srv = await startServer({ FAKE_CLAUDE_SERVICE: 'do' });
    try {
      const task = await start(srv, 'ASK про цвет');
      await waitUntil(async () => (await status(srv, task.id)) === 'question', 'it asks');
      const [asking] = await tasks(srv);
      assert.deepEqual(asking.questions, ['Какой цвет?', 'Какой размер?']);
      const sessionId = srv.log().find((l) => l.kind === 'spawn');
      assert.ok(sessionId);
      assert.equal((await srv.api('POST', `/api/service/tasks/${task.id}/answer`, { text: ' ' })).status, 400);
      await srv.api('POST', `/api/service/tasks/${task.id}/answer`, { text: 'Синий, большой' });
      await waitUntil(async () => (await status(srv, task.id)) === 'done', 'finished');
      const [done] = await tasks(srv);
      assert.equal(done.questions, null);
      assert.equal(done.answer, 'Сделано: Синий, большой');
      assert.match((spawns(srv).at(-1)!.argv as string[]).join(' '), /--resume/);
      assert.equal((await srv.api('POST', `/api/service/tasks/${task.id}/answer`, { text: 'ещё' })).status, 409);
    } finally {
      await srv.destroy();
    }
  });

  it('writes in config/ by itself, and is refused anywhere else and for commands', async () => {
    const srv = await startServer({ FAKE_CLAUDE_SERVICE: 'do' });
    try {
      const inside = await start(srv, `WRITECONFIG Путь: ${join(srv.dir, 'config', 'widgets.json')}`);
      await waitUntil(async () => (await status(srv, inside.id)) === 'done', 'done');
      const outside = await start(srv, 'WRITEOUTSIDE');
      await waitUntil(async () => (await status(srv, outside.id)) === 'done', 'done');
      const command = await start(srv, 'BASH');
      await waitUntil(async () => (await status(srv, command.id)) === 'done', 'done');
      const answers = srv.log().filter((l) => l.kind === 'permission-answer').map((l) => (l.answer as { behavior: string }).behavior);
      assert.deepEqual(answers, ['allow', 'deny', 'deny']);
    } finally {
      await srv.destroy();
    }
  });

  it('a restart in the middle says so and offers the retry, starting nothing by itself', async () => {
    const gate = `/tmp/claude-os-task-gate-${process.pid}`;
    const srv = await startServer({ FAKE_CLAUDE_SERVICE: 'do', FAKE_CLAUDE_SERVICE_GATE: gate });
    try {
      const task = await start(srv, 'Вопрос');
      await waitUntil(async () => (await status(srv, task.id)) === 'running', 'running');
      await srv.restart();
      assert.equal(await status(srv, task.id), 'failed');
      const count = spawns(srv).length;
      writeFileSync(gate, '');
      await srv.api('POST', `/api/service/tasks/${task.id}/retry`);
      await waitUntil(async () => (await status(srv, task.id)) === 'done', 'done after retry');
      assert.equal(spawns(srv).length, count + 1);
    } finally {
      rmSync(gate, { force: true });
      await srv.destroy();
    }
  });
});
