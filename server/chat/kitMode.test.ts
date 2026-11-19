// kit_plan over the real server and the fake CLI: a tab that starts in the user's auto mode leaves it for the Default mode.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { OsPluginPlan, Project, Tab } from '../../shared/contract.ts';
import { startServer, type Client, type TestServer } from './fixtures/harness.ts';

let srv: TestServer;
let client: Client;
let project: Project;

before(async () => {
  srv = await startServer();
  client = await srv.connect();
  const root = join(srv.dir, 'kitdemo');
  mkdirSync(root);
  writeFileSync(join(root, 'README.md'), '# kitdemo\n');
  project = (await srv.api<Project>('POST', '/api/projects/connect', { path: root })).body;
  const { sha } = (await srv.api<OsPluginPlan>('POST', '/api/os-plugins/project-kit/preview', { action: 'enable' })).body;
  assert.equal((await srv.api('POST', '/api/os-plugins/project-kit/enable', { confirmed: true, sha })).status, 200);
});

after(async () => {
  await client.close();
  await srv.destroy();
});

test('kit_plan in a tab running in auto mode switches the running process to the Default mode', async () => {
  const tab = (await srv.api<Tab>('POST', '/api/tabs', { project: project.key, cwd: project.root, title: 'Kit' })).body;
  client.subscribe(tab.id);
  await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'MCP kit_plan {}' });
  const answer = await client.waitEvent(tab.id, 'assistant', (a) => JSON.stringify(a.blocks).includes('MCP_RESULT'));
  assert.match(JSON.stringify(answer.blocks), /this tab was switched from auto to the Default mode/);

  const events = client.events(tab.id);
  const init = events.find((e) => e.e === 'init');
  assert.equal(init?.e === 'init' && init.permissionMode, 'auto');
  assert.ok(events.some((e) => e.e === 'mode' && e.mode === 'default'));
  assert.ok(events.some((e) => e.e === 'warning' && e.key === 'kitAskMode'));
  assert.ok(srv.log().some((l) => l.kind === 'control' && l.subtype === 'set_permission_mode' && (l.request as { mode?: string }).mode === 'default'));
  const tabs = (await srv.api<Tab[]>('GET', '/api/tabs')).body;
  assert.equal(tabs.find((t) => t.id === tab.id)?.permissionMode, 'default');
});
