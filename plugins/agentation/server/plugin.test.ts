// agentation as the Claude OS server runs it: the real daemon on a free port with the in-memory store, so neither the
// user's port 4747 nor their ~/.agentation is touched, and the session tools reading what the toolbar sent.
import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { createPlannerMcp, createRootMcp } from '../../../server/chat/rootMcp.ts';
import { makeKit, until, type TestKit } from '../../../server/memory/testkit.ts';
import { createPluginServers, type PluginServersApi } from '../../../server/tools/osPluginServers.ts';

const ENTRY = join(import.meta.dirname, 'index.ts');
let kit: TestKit;
let port: number;
let base: string;
let on = true;
let servers: PluginServersApi;

function freePort() {
  return new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port: p } = s.address() as { port: number };
      s.close(() => resolve(p));
    });
  });
}
const healthy = () => fetch(`${base}/health`).then((r) => r.ok, () => false);

before(async () => {
  port = await freePort();
  base = `http://127.0.0.1:${port}`;
  process.env.CLAUDE_OS_AGENTATION_PORT = String(port);
  process.env.AGENTATION_STORE = 'memory';
  kit = makeKit();
  kit.addProject('alpha', join(kit.base, 'alpha'));
  kit.addProject('os', kit.paths.repo);
  servers = createPluginServers(kit.ctx, () => (on ? [{ id: 'agentation', file: ENTRY }] : []));
  kit.ctx.pluginServers = servers;
});
after(async () => {
  on = false;
  kit.ctx.bus.emit('os-plugins-changed');
  kit.close();
  delete process.env.CLAUDE_OS_AGENTATION_PORT;
  delete process.env.AGENTATION_STORE;
});

async function connect(server: McpSdkServerConfigWithInstance) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  return client;
}
const text = (r: object) => (r as { content: { text: string }[] }).content[0].text;

async function post(path: string, body: object) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return (await res.json()) as { id: string };
}

describe('agentation in the server', () => {
  it('runs its daemon while enabled, shows its state, and gives the note tools to the root and Claude OS work tabs only', async () => {
    await until(() => servers.status('agentation')?.state === 'running', 15000);
    assert.deepEqual(servers.status('agentation'), { state: 'running', detail: null, external: false });
    assert.ok(kit.topics.includes('osPlugins'), 'the plugins screen is told');

    const page = 'http://127.0.0.1:47821/?popout=tab&id=t1';
    const session = await post('/sessions', { url: page });
    const note = await post(`/sessions/${session.id}/annotations`, { comment: 'The button moved', element: 'button', elementPath: 'main > button', x: 1, y: 1, timestamp: Date.now(), url: page });
    const elsewhere = await post('/sessions', { url: 'http://localhost:5173/' });
    await post(`/sessions/${elsewhere.id}/annotations`, { comment: 'Another project', element: 'div', elementPath: 'div', x: 1, y: 1, timestamp: Date.now(), url: 'http://localhost:5173/' });

    const other = await connect(createPlannerMcp(kit.ctx, {} as never, { id: 'tab-a', title: 'A', project: 'alpha' }));
    assert.ok(!(await other.listTools()).tools.some((t) => t.name.startsWith('agentation_')), 'another project does not get them');

    const work = await connect(createPlannerMcp(kit.ctx, {} as never, { id: 'tab-os', title: 'OS', project: 'os' }));
    const pending = JSON.parse(text(await work.callTool({ name: 'agentation_get_all_pending', arguments: {} }))) as { count: number; annotations: { id: string; comment: string }[] };
    assert.equal(pending.count, 1, 'a note on another site is not Claude OS work');
    assert.deepEqual(pending.annotations.map((a) => [a.id, a.comment]), [[note.id, 'The button moved']]);
    const theirs = JSON.parse(text(await work.callTool({ name: 'agentation_get_pending', arguments: { sessionId: elsewhere.id } }))) as { count: number };
    assert.equal(theirs.count, 0);
    assert.match(text(await work.callTool({ name: 'agentation_acknowledge', arguments: { annotationId: note.id } })), /"acknowledged": true/);

    const root = await connect(createRootMcp(kit.ctx, {} as never, 'tab-root', 'Root'));
    await root.callTool({ name: 'agentation_resolve', arguments: { annotationId: note.id, summary: 'moved it back' } });
    const stored = (await (await fetch(`${base}/annotations/${note.id}`)).json()) as { status: string; thread: { content: string }[] };
    assert.equal(stored.status, 'resolved');
    assert.deepEqual(stored.thread.map((m) => m.content), ['Resolved: moved it back']);
    const gone = await root.callTool({ name: 'agentation_reply', arguments: { annotationId: 'nope', message: 'x' } });
    assert.equal((gone as { isError?: boolean }).isError, true);
    assert.deepEqual(servers.allowed('work').filter((t) => t.startsWith('agentation_')).includes('agentation_dismiss'), false, 'a dismissal asks first');
  });

  it('the daemon answers under the Claude OS origin: plain requests and the event stream', async () => {
    const health = await kit.app.inject({ url: '/api/plugins/agentation/proxy/health' });
    assert.equal(health.statusCode, 200);
    assert.equal(health.json<{ status: string }>().status, 'ok');
    const made = await kit.app.inject({ method: 'POST', url: '/api/plugins/agentation/proxy/sessions', payload: { url: 'http://127.0.0.1:47821/' } });
    assert.equal(made.statusCode, 201);
    const id = made.json<{ id: string }>().id;
    assert.equal((await kit.app.inject({ url: `/api/plugins/agentation/proxy/sessions/${id}` })).json<{ url: string }>().url, 'http://127.0.0.1:47821/');
    assert.equal((await kit.app.inject({ url: '/api/plugins/agentation/proxy/sessions/nope' })).statusCode, 404);
    const address = await kit.app.listen({ port: 0, host: '127.0.0.1' });
    const first = await new Promise<{ type: string | undefined; text: string }>((resolve, reject) => {
      const req = get(`${address}/api/plugins/agentation/proxy/sessions/${id}/events`, (res) => res.once('data', (chunk: Buffer) => {
        req.destroy(); // the page went away: the stream to the daemon goes with it
        resolve({ type: res.headers['content-type'], text: chunk.toString() });
      }));
      req.on('error', reject);
    });
    assert.deepEqual(first, { type: 'text/event-stream', text: ': connected\n\n' });
  });

  it('disabling stops the daemon; a port held by something else fails with the reason and is retried', async () => {
    on = false;
    kit.ctx.bus.emit('os-plugins-changed');
    for (let i = 0; i < 100 && (await healthy()); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(await healthy(), false);
    assert.equal(servers.status('agentation'), null);

    const squatter = createServer((_req, res) => res.writeHead(404).end());
    await new Promise<void>((r) => squatter.listen(port, r));
    on = true;
    kit.ctx.bus.emit('os-plugins-changed');
    await until(() => servers.status('agentation')?.state === 'failed', 15000);
    assert.deepEqual(servers.status('agentation'), { state: 'failed', detail: `port ${port} is taken by another program`, external: false });
    await new Promise((r) => squatter.close(r));
    await until(() => servers.status('agentation')?.state === 'running', 15000);
  });
});
