import assert from 'node:assert/strict';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { OsPluginPlan, OsPluginsReport } from '../../shared/contract.ts';
import { sessionProfileBlock } from '../chat/profile.ts';
import { createSetupMcp } from '../chat/setupMcp.ts';
import { makeKit, type TestKit } from '../memory/testkit.ts';
import { registerTools } from './index.ts';
import { enableMovedPlugins, movedFailures } from './osPluginDefaults.ts';
import { MANIFEST, validateManifest } from './osPlugins.ts';

const REPO = join(import.meta.dirname, '..', '..');
const FLAGGED = ['ide-plus', 'kanban-plus', 'os-builder', 'project-kit', 'rg-context'];
let kit: TestKit;

beforeEach(() => {
  kit = makeKit();
  // A fresh install: the shipped plugins as they are in the repo, nothing enabled yet.
  cpSync(join(REPO, 'plugins'), kit.paths.plugins, { recursive: true });
  registerTools(kit.ctx);
  kit.ctx.settings!.setProfile({ name: 'Ann', language: 'en', questionLevel: 'balanced' });
});
afterEach(() => kit.close());

async function completeSetup(): Promise<{ text: string; isError: unknown }> {
  const server = createSetupMcp(kit.ctx, 'tab-setup');
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.instance.connect(a);
  const client = new Client({ name: 'test', version: '1' });
  await client.connect(b);
  try {
    const r = await client.callTool({ name: 'complete_setup', arguments: {} });
    return { text: (r.content as { text: string }[])[0].text, isError: r.isError };
  } finally {
    await client.close();
  }
}

const enabled = () => {
  const file = join(kit.paths.data, 'os-plugins.json');
  return existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort() : [];
};

describe('plugins enabled by the first-run setup', () => {
  it('the shipped plugins say which of them the setup enables', () => {
    for (const id of [...FLAGGED, 'agentation']) {
      const { errors, raw } = validateManifest(id, join(REPO, 'plugins', id));
      assert.deepEqual(errors, [], id);
      assert.equal(raw.enabledByDefault === true, id !== 'agentation', id);
    }
    const dir = join(kit.base, 'p', 'x');
    kit.write(join(dir, MANIFEST), JSON.stringify({ id: 'x', name: 'X', description: 'd', version: '1.0.0', author: 'a', enabledByDefault: 'yes', contains: { skills: [] } }));
    assert.match(validateManifest('x', dir).errors.join(';'), /enabledByDefault must be true or false/);
  });

  it('completing the setup enables every flagged plugin through the enable path and names them, missing dependencies or not', async () => {
    const r = await completeSetup();
    assert.equal(r.isError, undefined, r.text);
    assert.deepEqual(enabled(), FLAGGED, 'agentation and learn are not flagged');
    assert.equal(kit.ctx.settings!.setup().step, 'done');
    for (const name of ['IDE+', 'Claude OS builder', 'Project kit', 'rg-context']) assert.match(r.text, new RegExp(`Plugins enabled:.*${name.replace('+', '\\+')}`), name);
    assert.doesNotMatch(r.text, /not enabled/);
    assert.match(r.text, /Plugins off, enabled on request:\n- Agentation: Annotate Claude OS's own interface with element-bound fixes for Claude\.\n- Learn: Learn any skill with Claude: [^\n]*streak\.$/, 'the ones left off, each with its first sentence');
    assert.ok(existsSync(join(kit.paths.claudeDir, 'skills', 'rg-context', 'SKILL.md')), 'the skill is installed as the dialog installs it');
    assert.equal(existsSync(join(kit.paths.claudeDir, 'CLAUDE.md')), false, 'its CLAUDE.md block is left to the setup on the plugins screen');
    assert.deepEqual(kit.audits.filter((a) => a.action === 'os-plugin.enable').map((a) => a.target).sort(), FLAGGED);
    assert.ok(kit.topics.includes('osPlugins'));
  });

  it('a flagged plugin with errors is skipped and named; the setup still completes', async () => {
    kit.write(join(kit.paths.config, 'plugins', 'broken', MANIFEST), JSON.stringify({ id: 'broken', name: 'Broken', description: 'd', version: 'x', author: 'a', enabledByDefault: true, contains: { skills: [] } }));
    const r = await completeSetup();
    assert.equal(r.isError, undefined, r.text);
    assert.equal(kit.ctx.settings!.setup().step, 'done');
    assert.deepEqual(enabled(), FLAGGED);
    assert.match(r.text, /Plugins not enabled: Broken \([^)]*version must look like 1\.2\.3/);
  });

  it('a second completion does not enable again what the user disabled, and an install with plugin state is left alone', async () => {
    await completeSetup();
    const plan = (await kit.app.inject({ method: 'POST', url: '/api/os-plugins/os-builder/preview', payload: { action: 'disable' } })).json() as OsPluginPlan;
    assert.equal((await kit.app.inject({ method: 'POST', url: '/api/os-plugins/os-builder/disable', payload: { confirmed: true, sha: plan.sha } })).statusCode, 200);
    assert.equal((await kit.app.inject({ method: 'POST', url: '/api/setup/restart' })).statusCode, 200);

    const again = await completeSetup();
    assert.equal(again.isError, undefined, again.text);
    assert.deepEqual(enabled(), ['ide-plus', 'kanban-plus', 'project-kit', 'rg-context']);
    assert.doesNotMatch(again.text, /Plugins (enabled|not enabled)/);
    assert.match(again.text, /- Claude OS builder: /, 'what the user disabled is off too');
  });
});

describe('a feature that left the core for a plugin', () => {
  it('an install from before the move gets the plugin enabled once at start; disabled later, it stays off', async () => {
    const old = makeKit();
    try {
      cpSync(join(REPO, 'plugins'), old.paths.plugins, { recursive: true });
      old.write(join(old.paths.data, 'os-plugins.json'), '{}'); // the user has made plugin choices: not a first run
      registerTools(old.ctx);
      const state = () => Object.keys(JSON.parse(readFileSync(join(old.paths.data, 'os-plugins.json'), 'utf8')));
      assert.deepEqual(state(), ['kanban-plus']);
      assert.deepEqual(old.ctx.pluginServers!.views(), ['kanban'], 'its server part runs at once');
      const plan = (await old.app.inject({ method: 'POST', url: '/api/os-plugins/kanban-plus/preview', payload: { action: 'disable' } })).json() as OsPluginPlan;
      assert.ok(plan.changes.some((c) => c.kind === 'server'));
      assert.equal((await old.app.inject({ method: 'POST', url: '/api/os-plugins/kanban-plus/disable', payload: { confirmed: true, sha: plan.sha } })).statusCode, 200);
      assert.deepEqual(old.ctx.pluginServers!.views(), [], 'off: no tools, no routes');
      assert.equal((await old.app.inject({ url: '/api/plugins/kanban-plus/board' })).statusCode, 404);
      assert.deepEqual(await enableMovedPlugins({ stateFile: join(old.paths.data, 'os-plugins.json'), folders: () => [{ id: 'kanban-plus', dir: '' }], plan: () => { throw new Error('not again'); }, install: async () => {} }, old.paths.data, true), { enabled: [], failed: [] });
      assert.deepEqual(state(), []);
    } finally {
      await old.close();
    }
  });
});

describe('a moved plugin on an install without plugin state', () => {
  const moved = (k: TestKit) => JSON.parse(readFileSync(join(k.paths.data, 'os-plugins-moved.json'), 'utf8')) as string[];
  const startOld = async (prepare: (k: TestKit) => void, check: (k: TestKit) => Promise<void>) => {
    const old = makeKit();
    try {
      cpSync(join(REPO, 'plugins'), old.paths.plugins, { recursive: true });
      prepare(old);
      registerTools(old.ctx);
      // The start does not wait for it: done when the record is written, or after the attempt failed.
      for (let i = 0; i < 100 && !existsSync(join(old.paths.data, 'os-plugins-moved.json')); i++) await new Promise((done) => setTimeout(done, 20));
      await check(old);
    } finally {
      await old.close();
    }
  };

  it('an install that completed the setup gets it enabled though no state file was ever written', () => startOld(
    (k) => k.write(join(k.paths.config, 'settings.json'), JSON.stringify({ setup: { step: 'done', completedAt: 1, tabId: null } })),
    async (k) => {
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(k.paths.data, 'os-plugins.json'), 'utf8'))), ['kanban-plus']);
      assert.deepEqual(moved(k), ['kanban-plus']);
    },
  ));

  it('an install with a board folder gets it enabled too; a fresh one is left to the setup', async () => {
    await startOld((k) => k.write(join(k.paths.vault, 'kanban', 'OS-1.md'), '---\ntitle: a\n---\n'), async (k) => {
      assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(k.paths.data, 'os-plugins.json'), 'utf8'))), ['kanban-plus']);
    });
    assert.equal(existsSync(join(kit.paths.data, 'os-plugins.json')), false, 'the fresh install of beforeEach');
    assert.equal(existsSync(join(kit.paths.data, 'os-plugins-moved.json')), false);
  });

  it('a conflict leaves it unrecorded, so the next start tries again, and names the reason on its row', async () => {
    const using = { stateFile: join(kit.paths.data, 'os-plugins.json'), folders: () => [{ id: 'kanban-plus', dir: '' }], plan: () => ({ conflicts: ['skill x already exists'], manifest: {} as never }), install: async () => { throw new Error('not with a conflict'); } };
    assert.deepEqual(await enableMovedPlugins(using, kit.paths.data, true), { enabled: [], failed: [{ id: 'kanban-plus', reason: 'skill x already exists' }] });
    assert.deepEqual(JSON.parse(readFileSync(join(kit.paths.data, 'os-plugins-moved.json'), 'utf8')), []);
    assert.deepEqual(movedFailures(kit.paths.data), { 'kanban-plus': 'skill x already exists' });

    // The same through the server: a user copy of the plugin cannot run a server part, so the plan has a conflict.
    await startOld((k) => {
      k.write(join(k.paths.config, 'settings.json'), JSON.stringify({ setup: { step: 'done', completedAt: 1, tabId: null } }));
      cpSync(join(REPO, 'plugins', 'kanban-plus'), join(k.paths.config, 'plugins', 'kanban-plus'), { recursive: true });
    }, async (k) => {
      assert.deepEqual(moved(k), []);
      const row = ((await k.app.inject({ url: '/api/os-plugins' })).json() as OsPluginsReport).rows.find((r) => r.id === 'kanban-plus')!;
      assert.equal(row.enabled, false);
      assert.match(row.autoEnableFailed ?? '', /server part runs only from a plugin that ships/);
    });
  });
});

describe('the plugins hint of the root session', () => {
  it('names the shipped plugins that are off, from their manifests, and drops one once it is enabled', async () => {
    const root = () => sessionProfileBlock(kit.ctx, 'root');
    assert.match(root(), /- Agentation: Annotate/);
    assert.match(root(), /- rg-context: Context search/, 'nothing enabled yet');
    assert.match(root(), /Claude OS plugins screen/);
    assert.doesNotMatch(sessionProfileBlock(kit.ctx, 'work'), /Agentation/, 'a work tab does not get it');
    await completeSetup();
    assert.doesNotMatch(root(), /rg-context/);
    assert.match(root(), /- Agentation: /);
  });
});
