import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { OsPluginPlan } from '../../shared/contract.ts';
import { makeKit, type TestKit } from '../memory/testkit.ts';
import { registerTools } from './index.ts';
import { MANIFEST } from './osPlugins.ts';

let kit: TestKit;
beforeEach(() => {
  kit = makeKit();
  registerTools(kit.ctx);
});
afterEach(() => kit.close());

type Method = 'GET' | 'POST' | 'PUT' | 'DELETE';
async function req(method: Method, url: string, payload?: unknown) {
  const res = await kit.app.inject({ method, url, ...(payload === undefined ? {} : { payload: payload as object }) });
  return { status: res.statusCode, body: res.body ? (res.json() as unknown) : null };
}

function plugin(id: string, permissions: string[], extra: object = {}) {
  const dir = join(kit.paths.config, 'plugins', id);
  kit.write(join(dir, MANIFEST), JSON.stringify({ id, name: id, description: 'd', version: '1.0.0', author: 't', contains: { ui: { entry: 'ui/index.js', permissions }, ...extra } }));
  kit.write(join(dir, 'ui', 'index.js'), 'export const activate = () => ({});\n');
  return dir;
}

async function enable(id: string) {
  const plan = (await req('POST', `/api/os-plugins/${id}/preview`, { action: 'enable' })).body as OsPluginPlan;
  const done = await req('POST', `/api/os-plugins/${id}/enable`, { confirmed: true, sha: plan.sha });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  return plan;
}

const dataDir = (id: string) => join(kit.paths.data, 'os-plugin-data', id);

describe('plugin data', () => {
  it('needs the data permission of that very plugin, enabled', async () => {
    plugin('keeper', ['data']);
    plugin('other', ['files.write']);
    assert.equal((await req('GET', '/api/os-plugins/keeper/data/')).status, 403);
    await enable('other');
    assert.equal((await req('PUT', '/api/os-plugins/other/data/a.json', { x: 1 })).status, 403);
    await enable('keeper');
    assert.equal((await req('PUT', '/api/os-plugins/keeper/data/a.json', { x: 1 })).status, 200);
    assert.equal((await req('GET', '/api/os-plugins/other/data/a.json')).status, 403, 'one plugin cannot read through another one');
  });

  it('writes, reads, lists and deletes JSON inside its own folder', async () => {
    plugin('keeper', ['data']);
    await enable('keeper');
    kit.topics.length = 0;
    assert.deepEqual((await req('GET', '/api/os-plugins/keeper/data/')).body, { entries: [] });
    assert.equal((await req('PUT', '/api/os-plugins/keeper/data/tracks/go/track.json', { title: 'Go' })).status, 200);
    assert.ok(kit.topics.flat().includes('osPluginData'));
    assert.deepEqual(JSON.parse(readFileSync(join(dataDir('keeper'), 'tracks/go/track.json'), 'utf8')), { title: 'Go' });
    assert.deepEqual((await req('GET', '/api/os-plugins/keeper/data/tracks/go/track.json')).body, { title: 'Go' });
    assert.deepEqual((await req('GET', '/api/os-plugins/keeper/data/tracks')).body, { entries: [{ name: 'go', dir: true }] });
    assert.equal((await req('GET', '/api/os-plugins/keeper/data/tracks/none.json')).status, 404);
    assert.equal((await req('DELETE', '/api/os-plugins/keeper/data/tracks/go')).status, 200);
    assert.equal(existsSync(join(dataDir('keeper'), 'tracks/go')), false);
  });

  it('refuses paths that leave the folder, hidden names and files that are not JSON', async () => {
    plugin('keeper', ['data']);
    await enable('keeper');
    for (const path of ['..%2Fx.json', 'a/..%2F..%2Fx.json', '.hidden.json', 'a/notes.txt', 'a/b c.json']) {
      assert.equal((await req('PUT', `/api/os-plugins/keeper/data/${path}`, {})).status, 400, path);
    }
    assert.equal((await req('DELETE', '/api/os-plugins/keeper/data/')).status, 400, 'the folder itself is not deleted');
  });

  it('the workspace is a folder named after the plugin in the home folder, made on a POST, for an enabled shipped permission holder only', async () => {
    const home = process.env.HOME;
    process.env.HOME = join(kit.paths.data, 'home');
    try {
      const shipped = join(kit.paths.plugins, 'keeper');
      kit.write(join(shipped, MANIFEST), JSON.stringify({ id: 'keeper', name: 'keeper', description: 'd', version: '1.0.0', author: 't', contains: { ui: { entry: 'ui/index.js', permissions: ['data'] } } }));
      kit.write(join(shipped, 'ui', 'index.js'), 'export const activate = () => ({});\n');
      assert.equal((await req('POST', '/api/os-plugins/keeper/workspace')).status, 403);
      await enable('keeper');
      assert.equal((await req('GET', '/api/os-plugins/keeper/workspace')).status, 404, 'looking creates nothing');
      assert.equal(existsSync(join(kit.paths.data, 'home', 'keeper')), false);
      const { body } = await req('POST', '/api/os-plugins/keeper/workspace');
      assert.deepEqual(body, { path: join(kit.paths.data, 'home', 'keeper') });
      assert.ok(existsSync(join(kit.paths.data, 'home', 'keeper')));
      const sub = await req('POST', '/api/os-plugins/keeper/workspace', { folder: 'go-course' });
      assert.deepEqual(sub.body, { path: join(kit.paths.data, 'home', 'keeper', 'go-course') }, 'a folder of its own inside the workspace');
      assert.ok(existsSync(join(kit.paths.data, 'home', 'keeper', 'go-course')));
      for (const folder of ['..', '../x', 'a/b', '.hidden', 7]) assert.equal((await req('POST', '/api/os-plugins/keeper/workspace', { folder })).status, 400, String(folder));

      plugin('mine', ['data']);
      await enable('mine');
      const user = await req('POST', '/api/os-plugins/mine/workspace');
      assert.equal(user.status, 403, 'a user plugin names any folder it likes: it gets none');
      assert.equal(existsSync(join(kit.paths.data, 'home', 'mine')), false);
    } finally {
      process.env.HOME = home;
    }
  });

  it('{pluginData} in an MCP config becomes the plugin data folder', async () => {
    kit.write(kit.paths.claudeBin, `#!/usr/bin/env node
const fs = require('node:fs');
const [, , , cmd, ...rest] = process.argv;
const file = ${JSON.stringify(kit.paths.claudeJson)};
const json = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
json.mcpServers ??= {};
if (cmd === 'add-json') json.mcpServers[rest[2]] = JSON.parse(rest[3]);
fs.writeFileSync(file, JSON.stringify(json));
`);
    chmodSync(kit.paths.claudeBin, 0o755);
    plugin('keeper', ['data'], { mcp: { keeper: { command: 'node', args: ['{pluginDir}/s.js'], env: { DATA: '{pluginData}' } } } });
    const plan = await enable('keeper');
    assert.ok(plan.changes.some((c) => c.kind === 'mcp'));
    const servers = (JSON.parse(readFileSync(kit.paths.claudeJson, 'utf8')) as { mcpServers: Record<string, { env: { DATA: string } }> }).mcpServers;
    assert.equal(servers.keeper.env.DATA, dataDir('keeper'));
  });
});
