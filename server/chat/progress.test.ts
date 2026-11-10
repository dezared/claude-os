// report_progress and what the home widget is told: temp dirs and the fake CLI only.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createSdkMcpServer } from '@anthropic-ai/claude-agent-sdk';
import { Client as McpClient } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Tab } from '../../shared/contract.ts';
import { startServer, waitUntil, type Client, type TestServer } from './fixtures/harness.ts';
import { progressTool } from './rootMcp.ts';

describe('report_progress: the tool itself', () => {
  it('is loaded with the prompt, answers "ok", and speaks for the tab it was made for', async () => {
    const calls: unknown[][] = [];
    const ctx = { chat: { reportProgress: (...a: unknown[]) => calls.push(a) } };
    const server = createSdkMcpServer({ name: 'claude-os', tools: [progressTool(ctx as never, 'tab-7')] });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.instance.connect(a);
    const client = new McpClient({ name: 'test', version: '1' });
    await client.connect(b);
    const { tools } = await client.listTools();
    const found = tools.find((t) => t.name === 'report_progress')!;
    assert.equal(found._meta?.['anthropic/alwaysLoad'], true);
    const answer = await client.callTool({ name: 'report_progress', arguments: { percent: 40, step: 'тесты' } });
    assert.deepEqual(answer.content, [{ type: 'text', text: 'ok' }]);
    assert.deepEqual(calls, [['tab-7', { percent: 40, step: 'тесты' }]]);
    await client.close();
  });
});

describe('report_progress: the tab', () => {
  let srv: TestServer;
  let ws: Client;
  let cwd: string;
  before(async () => {
    srv = await startServer();
    ws = await srv.connect();
    cwd = srv.dir;
  });
  after(async () => {
    await ws.close();
    await srv.destroy();
  });

  const tab = async (id: string) => (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === id);
  const open = async () => {
    const made = (await srv.api<Tab>('POST', '/api/tabs', { cwd, title: 'работа' })).body;
    ws.subscribe(made.id);
    return made.id;
  };
  const turns = (id: string) => ws.events(id).filter((e) => e.e === 'result').length;
  const send = async (id: string, text: string) => {
    const was = turns(id);
    await srv.api('POST', `/api/tabs/${id}/send`, { text });
    await waitUntil(() => turns(id) > was, `the turn "${text}" to end`);
  };
  const report = (id: string, args: object) => send(id, `MCP report_progress ${JSON.stringify(args)}`);

  it('every session has the rule and may call the tool without a prompt; a tab that never reported has no bar', async () => {
    const id = await open();
    await send(id, 'привет');
    assert.equal((await tab(id))!.progress, undefined);
    const argv = srv.log().filter((l) => l.kind === 'spawn').map((l) => (l.argv as string[]).join(' '));
    assert.match(argv.at(-1)!, /allowedTools=[^ ]*mcp__claude-os__report_progress/);
    assert.match(JSON.stringify(srv.log().filter((l) => l.kind === 'initialize').at(-1)), /silently at step boundaries/);
    assert.equal(ws.events(id).some((e) => e.e === 'permission'), false);
  });

  it('a turn over without "done" waits for an answer, whatever was said; 100 or "done" is done', async () => {
    const id = await open();
    await report(id, { percent: 40, step: 'тесты', status: 'working' });
    assert.deepEqual({ ...(await tab(id))!.progress, at: 0 }, { percent: 40, step: 'тесты', state: 'waiting', at: 0 });
    await report(id, { percent: 70, status: 'done' });
    const done = (await tab(id))!.progress!;
    assert.equal(done.state, 'done');
    assert.equal(done.percent, 100, '"done" fills the bar');
    assert.equal(done.step, null);
  });

  it('while the turn runs it is working, even after "done"; a permission request is waiting', async () => {
    const id = await open();
    await report(id, { percent: 100, status: 'done' });
    await srv.api('POST', `/api/tabs/${id}/send`, { text: 'SLOW' });
    await waitUntil(async () => (await tab(id))!.progress?.state === 'working', 'working during a turn');
    await srv.api('POST', `/api/tabs/${id}/interrupt`);
    await waitUntil(async () => (await tab(id))!.status === 'idle', 'the turn to stop');
    assert.equal((await tab(id))!.progress!.state, 'done');

    const was = turns(id);
    await srv.api('POST', `/api/tabs/${id}/send`, { text: 'TOOL Bash {"command":"ls"}' });
    const asked = await ws.waitEvent(id, 'permission');
    assert.equal((await tab(id))!.progress!.state, 'waiting');
    await srv.api('POST', `/api/tabs/${id}/respond/${asked.requestId}`, { kind: 'permission', allow: false });
    await waitUntil(() => turns(id) > was, 'the answer to end the turn');
  });

  it('the percent goes back only for a reason: "restart", or a new turn after finished work', async () => {
    const id = await open();
    await report(id, { percent: 60 });
    await report(id, { percent: 30 });
    assert.equal((await tab(id))!.progress!.percent, 60, 'no slip back');
    await report(id, { percent: 30, restart: true });
    assert.equal((await tab(id))!.progress!.percent, 30);
    await report(id, { percent: 250 });
    assert.equal((await tab(id))!.progress!.percent, 100, 'out of range is clamped, not refused');
    await report(id, { percent: 10 });
    assert.equal((await tab(id))!.progress!.percent, 10, 'the next job after finished work');
  });

  it('a process that dies mid-turn is a failure until the next turn, even if Claude said nothing', async () => {
    const id = await open();
    await report(id, { percent: 50 });
    await send(id, 'CRASH');
    assert.equal((await tab(id))!.progress!.state, 'failed');
    assert.equal((await tab(id))!.progress!.percent, 50);
    await send(id, 'дальше');
    assert.equal((await tab(id))!.progress!.state, 'waiting');
  });

  it('survives a restart; a turn cut by it is a failure; dismissed and closed tabs leave the list', async () => {
    const kept = await open();
    await report(kept, { percent: 80, step: 'сборка', status: 'done' });
    const cut = await open();
    await report(cut, { percent: 25 });
    const dismissed = await open();
    await report(dismissed, { percent: 5 });
    const closed = await open();
    await report(closed, { percent: 5 });
    await srv.api('POST', `/api/tabs/${cut}/send`, { text: 'SLOW' });
    await waitUntil(async () => (await tab(cut))!.status === 'working', 'the turn to start');

    await ws.close();
    await srv.restart();
    ws = await srv.connect();

    const after = (await tab(kept))!.progress!;
    assert.equal(after.state, 'done');
    assert.equal(after.percent, 100);
    const interrupted = (await tab(cut))!.progress!;
    assert.equal(interrupted.state, 'failed');
    assert.equal(interrupted.percent, 25);

    assert.equal((await srv.api('DELETE', `/api/tabs/${dismissed}/progress`)).status, 200);
    assert.equal((await tab(dismissed))!.progress, undefined);
    await srv.api('DELETE', `/api/tabs/${closed}`);
    await srv.restart();
    assert.equal((await tab(closed)), undefined);
    assert.equal((await tab(dismissed))!.progress, undefined, 'dismissed for good');
    assert.equal((await tab(kept))!.progress!.percent, 100);
  });

  it('/clear starts over: a new conversation has reported nothing', async () => {
    ws = await srv.connect();
    const id = await open();
    await report(id, { percent: 40 });
    await srv.api('POST', `/api/tabs/${id}/reset`);
    assert.equal((await tab(id))!.progress, undefined);
  });
});
