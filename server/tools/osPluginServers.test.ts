// The server part of a plugin: only from the shipped folder, its routes under /api/plugins/<id>, a broken one costs itself alone.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { OsPluginsReport } from '../../shared/contract.ts';
import { makeKit, type TestKit } from '../memory/testkit.ts';
import { registerTools } from './index.ts';
import { matchRoute } from './osPluginServers.ts';

let kit: TestKit;
const manifest = (id: string) => JSON.stringify({ id, name: id, description: 'd', version: '1.0.0', author: 'a', contains: { server: 'server/index.ts' } });
const SERVER = `export function activate(host) {
  return { routes: [{ method: 'GET', path: '/hello/:name', handler: (req) => ({ hi: req.params.name, id: host.id }) }], views: ['hello'], rules: { work: 'say hello' }, allowed: { work: ['hello_tool'] },
    tools: () => [host.tool('hello_tool', 'says hi', {}, async () => ({ content: [{ type: 'text', text: 'hi' }] }))] };
}`;

beforeEach(() => {
  kit = makeKit();
  kit.write(join(kit.paths.plugins, 'hello', 'plugin.json'), manifest('hello'));
  kit.write(join(kit.paths.plugins, 'hello', 'server', 'index.ts'), SERVER);
  kit.write(join(kit.paths.plugins, 'broken', 'plugin.json'), manifest('broken'));
  kit.write(join(kit.paths.plugins, 'broken', 'server', 'index.ts'), 'export function activate() { throw new Error("no"); }');
  kit.write(join(kit.paths.config, 'plugins', 'mine', 'plugin.json'), manifest('mine'));
  kit.write(join(kit.paths.config, 'plugins', 'mine', 'server', 'index.ts'), SERVER);
  registerTools(kit.ctx);
});
afterEach(() => kit.close());

async function enable(id: string) {
  const plan = (await kit.app.inject({ method: 'POST', url: `/api/os-plugins/${id}/preview`, payload: { action: 'enable' } })).json<{ sha: string; conflicts: string[] }>();
  return { plan, res: await kit.app.inject({ method: 'POST', url: `/api/os-plugins/${id}/enable`, payload: { confirmed: true, sha: plan.sha } }) };
}

describe('plugin server parts', () => {
  it('a shipped one serves its routes and gives its views and rules once enabled, and stops when disabled', async () => {
    assert.equal((await kit.app.inject({ url: '/api/plugins/hello/hello/x' })).statusCode, 404, 'off: nothing');
    assert.equal((await enable('hello')).res.statusCode, 200);
    assert.deepEqual((await kit.app.inject({ url: '/api/plugins/hello/hello/%D0%BC%D0%B8%D1%80' })).json(), { hi: 'мир', id: 'hello' });
    assert.equal((await kit.app.inject({ method: 'POST', url: '/api/plugins/hello/hello/x' })).statusCode, 404, 'the method counts');
    assert.deepEqual([kit.ctx.pluginServers!.views(), kit.ctx.pluginServers!.rules('work'), kit.ctx.pluginServers!.allowed('work')], [['hello'], ['say hello'], ['hello_tool']]);
    const plan = (await kit.app.inject({ method: 'POST', url: '/api/os-plugins/hello/preview', payload: { action: 'disable' } })).json<{ sha: string }>();
    await kit.app.inject({ method: 'POST', url: '/api/os-plugins/hello/disable', payload: { confirmed: true, sha: plan.sha } });
    assert.deepEqual(kit.ctx.pluginServers!.views(), []);
    assert.equal((await kit.app.inject({ url: '/api/plugins/hello/hello/x' })).statusCode, 404);
  });

  it('a user plugin cannot bring one: the row says why and enabling is refused', async () => {
    const rows = (await kit.app.inject({ url: '/api/os-plugins' })).json<OsPluginsReport>().rows;
    assert.match(rows.find((r) => r.id === 'mine')!.errors.join(';'), /ships with Claude OS/);
    assert.equal(rows.find((r) => r.id === 'hello')!.contains.server, 'server/index.ts');
    const { plan, res } = await enable('mine');
    assert.match(plan.conflicts.join(';'), /ships with Claude OS/);
    assert.equal(res.statusCode, 409);
  });

  it('one that throws on start costs itself alone', async () => {
    assert.equal((await enable('broken')).res.statusCode, 200);
    await enable('hello');
    assert.deepEqual(kit.ctx.pluginServers!.views(), ['hello']);
  });

  it('a percent in a path part arrives as it is; a malformed escape is a bad request, not a server error', async () => {
    await enable('hello');
    assert.deepEqual((await kit.app.inject({ url: '/api/plugins/hello/hello/100%25' })).json(), { hi: '100%', id: 'hello' }, 'decoded once, by the router');
    assert.equal((await kit.app.inject({ url: '/api/plugins/hello/hello/%E0%A4%A' })).statusCode, 400);
  });

  it('a session that got the tools before the plugin was disabled is told the plugin is off', async () => {
    await enable('hello');
    const [held] = kit.ctx.pluginServers!.tools({ scope: 'work', tab: 't1', project: null });
    const call = async () => (await held.handler({}, {})) as { content: { text: string }[]; isError?: boolean };
    assert.deepEqual((await call()).content[0].text, 'hi');
    const plan = (await kit.app.inject({ method: 'POST', url: '/api/os-plugins/hello/preview', payload: { action: 'disable' } })).json<{ sha: string }>();
    await kit.app.inject({ method: 'POST', url: '/api/os-plugins/hello/disable', payload: { confirmed: true, sha: plan.sha } });
    const off = await call();
    assert.equal(off.isError, true);
    assert.match(off.content[0].text, /plugin hello is off/);
  });

  it('matches a route by its parts', () => {
    assert.deepEqual(matchRoute('/cards/:id/move', 'cards/OS-1/move'), { id: 'OS-1' });
    assert.equal(matchRoute('/cards/:id', 'cards/OS-1/move'), null);
    assert.equal(matchRoute('/board', 'boards'), null);
    assert.deepEqual(matchRoute('/proxy/*', 'proxy/sessions/s1/events'), { '*': 'sessions/s1/events' });
    assert.equal(matchRoute('/proxy/*', 'proxy'), null);
    assert.equal(matchRoute('/proxy/*', 'other/sessions'), null);
  });
});
