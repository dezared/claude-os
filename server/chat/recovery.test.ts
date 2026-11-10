// What survives a restart or a reboot: temp dirs and the fake CLI only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import type { ChatEvent, RecoveryItem, SessionInfo, Tab } from '../../shared/contract.ts';
import { startServer, waitUntil, type TestServer } from './fixtures/harness.ts';

const REPO = resolve(import.meta.dirname, '../..');
type TabItem = Extract<RecoveryItem, { kind: 'tab' }>;

const recovery = async (srv: TestServer) => (await srv.api<RecoveryItem[]>('GET', '/api/recovery')).body;
const spawns = (srv: TestServer) => srv.log().filter((l) => l.kind === 'spawn');
const userMessages = (srv: TestServer) => srv.log().filter((l) => l.kind === 'user').map((l) => String(l.content));
const settle = () => new Promise((r) => setTimeout(r, 1000));

async function midTurn(srv: TestServer, queued: string[]) {
  const workDir = mkdtempSync(join(srv.dir, 'w-'));
  const client = await srv.connect();
  const tab = (await srv.api<Tab>('POST', '/api/tabs', { cwd: workDir, title: 'Выживет' })).body;
  client.subscribe(tab.id);
  await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'SLOW' });
  await client.waitEvent(tab.id, 'delta');
  for (const text of queued) await srv.api('POST', `/api/tabs/${tab.id}/send`, { text });
  const sessionId = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)!.sessionId;
  await client.close();
  return { tab, sessionId: sessionId! };
}

function journalOf(srv: TestServer, id: string, cwd: string) {
  const dir = join(srv.configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString();
  const line = (r: object) => JSON.stringify({ ...r, uuid: crypto.randomUUID(), sessionId: id, cwd, timestamp: stamp });
  writeFileSync(join(dir, `${id}.jsonl`), [
    line({ type: 'ai-title', aiTitle: 'работа в терминале' }),
    line({ type: 'user', message: { role: 'user', content: 'работа в терминале' } }),
    line({ type: 'assistant', message: { id: `msg_${id}`, type: 'message', role: 'assistant', model: 'fake', content: [{ type: 'text', text: 'ок' }], usage: { input_tokens: 1, output_tokens: 1 } } }),
  ].join('\n') + '\n');
}

function registryFile(srv: TestServer, pid: number, entry: object) {
  mkdirSync(join(srv.configDir, 'sessions'), { recursive: true });
  writeFileSync(join(srv.configDir, 'sessions', `${pid}.json`), JSON.stringify({ pid, startedAt: Date.now(), updatedAt: Date.now(), status: 'busy', kind: 'interactive', ...entry }));
}

describe('killed mid-turn', () => {
  it('tabs, the interrupted list and the queue survive, and no turn starts by itself', async () => {
    const srv = await startServer();
    try {
      const { tab, sessionId } = await midTurn(srv, ['первое в очереди', 'второе в очереди']);
      await srv.stop('SIGKILL');
      const before = spawns(srv).length;
      await srv.restart();

      const tabs = (await srv.api<Tab[]>('GET', '/api/tabs')).body;
      const restored = tabs.find((t) => t.id === tab.id)!;
      assert.equal(restored.title, 'Выживет');
      assert.equal(restored.sessionId, sessionId);
      assert.equal(restored.status, 'idle');
      assert.equal(restored.queued, 0);

      const [item, ...rest] = await recovery(srv) as TabItem[];
      assert.deepEqual(rest, []);
      assert.equal(item.tabId, tab.id);
      assert.ok(item.interruptedAt);
      assert.deepEqual(item.queued.map((q) => q.text), ['первое в очереди', 'второе в очереди']);

      await settle();
      assert.equal(spawns(srv).length, before, 'no process was started');
      assert.deepEqual(userMessages(srv), ['SLOW'], 'nothing was sent');
      assert.equal(restored.status, (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)!.status);

      // A decision can wait through another restart.
      await srv.restart();
      const again = (await recovery(srv))[0] as TabItem;
      assert.equal(again.interruptedAt, item.interruptedAt);
      assert.equal(again.queued.length, 2);
      assert.equal(spawns(srv).length, before);

      // An ordinary message does not drag the waiting ones after it.
      const client = await srv.connect();
      client.subscribe(tab.id);
      await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'новое' });
      await client.waitEvent(tab.id, 'result');
      await settle();
      assert.deepEqual(userMessages(srv), ['SLOW', 'новое']);
      const after = (await recovery(srv))[0] as TabItem;
      assert.equal(after.interruptedAt, null, 'the tab went on, so the cut-off turn is settled');
      assert.equal(after.queued.length, 2);
      assert.match((spawns(srv).at(-1)!.argv as string[]).join(' '), new RegExp(`--resume[ =]${sessionId}`));

      // Each waiting message goes out or goes away only when told.
      assert.equal((await srv.api('POST', `/api/recovery/tabs/${tab.id}/queue/${after.queued[0].id}/send`)).status, 200);
      await waitUntil(() => userMessages(srv).includes('первое в очереди'), 'the message is sent');
      assert.equal((await srv.api('DELETE', `/api/recovery/tabs/${tab.id}/queue/${after.queued[1].id}`)).status, 200);
      assert.deepEqual(await recovery(srv), []);
      await client.close();
      await srv.restart();
      assert.deepEqual(await recovery(srv), []);
      assert.ok(!userMessages(srv).includes('второе в очереди'));
    } finally {
      await srv.destroy();
    }
  });

  it('closing keeps the tab and any waiting message; a closed entry stays closed', async () => {
    const srv = await startServer();
    try {
      const { tab } = await midTurn(srv, ['ждёт решения']);
      await srv.stop('SIGKILL');
      await srv.restart();
      assert.equal((await srv.api('POST', `/api/recovery/tabs/${tab.id}/dismiss`)).status, 200);
      const [item] = await recovery(srv) as TabItem[];
      assert.equal(item.interruptedAt, null);
      assert.equal(item.queued.length, 1, 'closing the entry does not throw his words away');
      assert.ok((await srv.api<Tab[]>('GET', '/api/tabs')).body.some((t) => t.id === tab.id));
      await srv.restart();
      assert.equal(((await recovery(srv))[0] as TabItem).interruptedAt, null);

      assert.equal((await srv.api('DELETE', `/api/tabs/${tab.id}`)).status, 200);
      assert.deepEqual(await recovery(srv), []);
      await srv.restart();
      assert.deepEqual(await recovery(srv), [], 'a closed tab takes its queue with it');
    } finally {
      await srv.destroy();
    }
  });

  it('the app\'s own stop and restart keep them too: it used to drop the queue and forget the turn', async () => {
    const srv = await startServer();
    try {
      const { tab } = await midTurn(srv, ['пережить остановку']);
      await srv.api('POST', '/api/app/shutdown');
      await srv.restart();
      const [item] = await recovery(srv) as TabItem[];
      assert.equal(item.tabId, tab.id);
      assert.ok(item.interruptedAt);
      assert.deepEqual(item.queued.map((q) => q.text), ['пережить остановку']);
      const history = (await srv.api<ChatEvent[]>('GET', `/api/tabs/${tab.id}/history`)).body;
      assert.equal(history.at(-1)!.e, 'interrupted');
      assert.deepEqual(userMessages(srv), ['SLOW']);
    } finally {
      await srv.destroy();
    }
  });
});

describe('sessions of a plain terminal', () => {
  it('one cut off appears in the list, opens through resume, and starts nothing by itself', async () => {
    const srv = await startServer();
    try {
      const cwd = mkdtempSync(join(srv.dir, 'term-'));
      const id = crypto.randomUUID();
      journalOf(srv, id, cwd);
      registryFile(srv, 999_999, { sessionId: id, cwd, procStart: 'gone' });
      // Same evidence, but not for the list: a hidden service job, and a session far in the past.
      const service = crypto.randomUUID();
      journalOf(srv, service, join(REPO, 'service'));
      registryFile(srv, 999_998, { sessionId: service, cwd: join(REPO, 'service'), procStart: 'gone' });
      const old = crypto.randomUUID();
      journalOf(srv, old, cwd);
      registryFile(srv, 999_997, { sessionId: old, cwd, procStart: 'gone', startedAt: 1000, updatedAt: 1000 });
      await srv.restart();

      await waitUntil(async () => (await recovery(srv)).length > 0, 'the session is listed');
      await waitUntil(async () => (await srv.api<SessionInfo[]>('GET', '/api/sessions')).body.some((s) => s.id === old), 'the old one is indexed');
      const list = await recovery(srv);
      assert.deepEqual(list.map((r) => r.sessionId), [id]);
      assert.equal(list[0].title, 'работа в терминале');
      assert.equal(spawns(srv).length, 0);

      const created = await srv.api<Tab>('POST', '/api/tabs', { resumeSessionId: id, cwd });
      assert.equal(created.status, 200);
      assert.equal(created.body.kind, 'work');
      assert.equal(created.body.cwd, cwd);
      assert.deepEqual(await recovery(srv), [], 'it has a tab now');
      await settle();
      assert.equal(spawns(srv).length, 0, 'opening it spends nothing');

      const client = await srv.connect();
      client.subscribe(created.body.id);
      await srv.api('POST', `/api/tabs/${created.body.id}/send`, { text: 'дальше' });
      await client.waitEvent(created.body.id, 'result');
      assert.match((spawns(srv).at(-1)!.argv as string[]).join(' '), new RegExp(`--resume[ =]${id}`));
      await client.close();

      // Continued once: closing that tab later does not bring it back.
      await srv.api('DELETE', `/api/tabs/${created.body.id}`);
      await srv.restart();
      await settle();
      assert.deepEqual(await recovery(srv), []);
    } finally {
      await srv.destroy();
    }
  });

  it('one that was running at the last look and is gone counts too, and can be closed for good', async () => {
    const srv = await startServer();
    const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      const cwd = mkdtempSync(join(srv.dir, 'term-'));
      const id = crypto.randomUUID();
      journalOf(srv, id, cwd);
      const stat = readFileSync(`/proc/${sleeper.pid}/stat`, 'latin1');
      const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      registryFile(srv, sleeper.pid!, { sessionId: id, cwd, procStart });
      await waitUntil(async () => (await srv.api<SessionInfo[]>('GET', '/api/sessions?live=1')).body.some((s) => s.id === id), 'the session is seen running', 15_000);
      assert.deepEqual(await recovery(srv), [], 'alive: nothing to recover');

      await srv.stop('SIGKILL');
      await new Promise<void>((r) => { sleeper.once('exit', () => r()); sleeper.kill('SIGKILL'); });
      rmSync(join(srv.configDir, 'sessions', `${sleeper.pid}.json`)); // no file left behind: only our own last look knows
      await srv.restart();
      await waitUntil(async () => (await recovery(srv)).some((r) => r.sessionId === id), 'the session is listed');

      assert.equal((await srv.api('POST', `/api/recovery/sessions/${id}/dismiss`)).status, 200);
      assert.deepEqual(await recovery(srv), []);
      await srv.restart();
      await settle();
      assert.deepEqual(await recovery(srv), []);
    } finally {
      sleeper.kill('SIGKILL');
      await srv.destroy();
    }
  });
});

describe('a restart ordered from the root session', () => {
  it('the tabs that were working get one message and go on; the others stay quiet', async () => {
    const srv = await startServer();
    try {
      const { tab } = await midTurn(srv, []);
      const quietDir = mkdtempSync(join(srv.dir, 'q-'));
      const quiet = (await srv.api<Tab>('POST', '/api/tabs', { cwd: quietDir, title: 'Без дела' })).body;
      await srv.api('POST', `/api/tabs/${quiet.id}/send`, { text: 'Привет' });
      await waitUntil(() => userMessages(srv).includes('Привет') && srv.log().some((l) => l.kind === 'result' || l.kind === 'user'), 'the quiet tab had its turn');
      await settle();
      const root = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.kind === 'root')!;
      const before = userMessages(srv).length;
      await srv.api('POST', `/api/tabs/${root.id}/send`, { text: 'MCP restart_claude_os {}' });
      await waitUntil(() => userMessages(srv).filter((m) => m.startsWith('The Claude OS server was restarted')).length === 2, 'both working tabs go on', 30_000);
      const messages = userMessages(srv).slice(before);
      assert.equal(messages.filter((m) => m === 'Привет').length, 0, 'an old message is not sent again');
      assert.equal(srv.log().filter((l) => l.kind === 'spawn' && l.cwd === quietDir).length, 1, 'the quiet tab started nothing');
      const tabs = (await srv.api<Tab[]>('GET', '/api/tabs')).body;
      assert.ok(tabs.some((t) => t.id === tab.id));
      await settle();
      assert.deepEqual((await recovery(srv)).filter((r) => r.kind === 'tab' && r.interruptedAt !== null && r.tabId === root.id), [], 'nothing left to decide about the root tab');
    } finally {
      await srv.api('POST', '/api/app/shutdown').catch(() => {}); // the restarted process is no child of the harness
      await srv.destroy();
    }
  });
});

describe('a restart from the stale server bar', () => {
  const continued = (srv: TestServer) => userMessages(srv).filter((m) => m.startsWith('The Claude OS server was restarted')).length;
  const pidOf = (srv: TestServer) => fetch(`http://127.0.0.1:${srv.port}/health`).then((r) => r.json() as Promise<{ pid: number }>).then((h) => h.pid).catch(() => 0);

  it('restart route plans continue', async () => {
    const srv = await startServer({ FAKE_CLAUDE_LINGER_MS: '60000' }); // a process that does not end on its own
    try {
      await midTurn(srv, []);
      const idle = (await srv.api<Tab>('POST', '/api/tabs', { cwd: mkdtempSync(join(srv.dir, 'i-')) })).body;
      await srv.api('POST', `/api/tabs/${idle.id}/send`, { text: 'Привет' });
      await waitUntil(() => srv.log().filter((l) => l.kind === 'spawn').length === 2 && srv.log().some((l) => l.kind === 'user' && l.content === 'Привет'), 'the idle tab has a process');
      await settle();
      const old = spawns(srv).at(-1)!.pid as number;
      assert.equal((await srv.api('POST', '/api/app/restart')).status, 200);
      await waitUntil(() => continued(srv) === 1, 'the working tab goes on', 30_000);
      assert.throws(() => process.kill(old, 0), 'the old server ended its children before it left');
    } finally {
      await srv.api('POST', '/api/app/shutdown').catch(() => {});
      await srv.destroy();
    }
  });

  it('continue retries while the old child is alive', async () => {
    const srv = await startServer();
    const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      const { tab, sessionId } = await midTurn(srv, []);
      const stat = readFileSync(`/proc/${sleeper.pid}/stat`, 'latin1');
      registryFile(srv, sleeper.pid!, { sessionId, cwd: (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)!.cwd, procStart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] });
      const first = await pidOf(srv);
      assert.equal((await srv.api('POST', '/api/app/restart')).status, 200);
      await waitUntil(async () => ![0, first].includes(await pidOf(srv)), 'the new process answers', 20_000);
      await new Promise((r) => setTimeout(r, 2500)); // the first try is 1.5 s after boot
      assert.equal(continued(srv), 0, 'not sent while the session still looks alive');
      sleeper.kill('SIGKILL');
      await waitUntil(() => continued(srv) === 1, 'sent once the old process is gone', 12_000);
    } finally {
      sleeper.kill('SIGKILL');
      await srv.api('POST', '/api/app/shutdown').catch(() => {});
      await srv.destroy();
    }
  });

  it('the retries stop once the user went on himself', async () => {
    const srv = await startServer();
    const sleeper = spawn('sleep', ['60'], { stdio: 'ignore' });
    try {
      const { tab, sessionId } = await midTurn(srv, []);
      const stat = readFileSync(`/proc/${sleeper.pid}/stat`, 'latin1');
      registryFile(srv, sleeper.pid!, { sessionId, cwd: (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)!.cwd, procStart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] });
      const first = await pidOf(srv);
      assert.equal((await srv.api('POST', '/api/app/restart')).status, 200);
      await waitUntil(async () => ![0, first].includes(await pidOf(srv)), 'the new process answers', 20_000);
      await new Promise((r) => setTimeout(r, 2500));
      sleeper.kill('SIGKILL');
      assert.equal((await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'сам продолжил' })).status, 200);
      await waitUntil(() => userMessages(srv).includes('сам продолжил'), 'his message is sent');
      await new Promise((r) => setTimeout(r, 4000)); // past the next retries
      assert.equal(continued(srv), 0, 'no second answer to the same thing');
    } finally {
      sleeper.kill('SIGKILL');
      await srv.api('POST', '/api/app/shutdown').catch(() => {});
      await srv.destroy();
    }
  });
});
