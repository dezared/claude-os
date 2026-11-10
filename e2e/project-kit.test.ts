// The project kit's entry points and its approval card: the real server, the fake CLI, a temp project. No tokens.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import type { KitPlan } from '../shared/projectKit.ts';
import type { OsPluginPlan, Project, Tab } from '../shared/contract.ts';
import { startServer, waitUntil, type TestServer } from '../server/chat/fixtures/harness.ts';

let srv: TestServer;
let browser: Browser;
let page: Page;
let project: Project;
let tab: Tab;
const errors: string[] = [];

const idle = () => waitUntil(async () => (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tab.id)?.status === 'idle', 'tab idle', 20_000);
const send = async (text: string) => {
  await srv.api('POST', `/api/tabs/${tab.id}/send`, { text });
  await idle();
};

before(async () => {
  srv = await startServer();
  const root = join(srv.dir, 'kitdemo');
  mkdirSync(root);
  writeFileSync(join(root, 'README.md'), '# kitdemo\n');
  project = (await srv.api<Project>('POST', '/api/projects/connect', { path: root })).body;
  const { sha } = (await srv.api<OsPluginPlan>('POST', '/api/os-plugins/project-kit/preview', { action: 'enable' })).body;
  assert.equal((await srv.api('POST', '/api/os-plugins/project-kit/enable', { confirmed: true, sha })).status, 200);
  tab = (await srv.api<Tab>('POST', '/api/tabs', { project: project.key, cwd: project.root, title: 'Kit' })).body;

  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  ctx.setDefaultTimeout(30_000);
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${srv.port}/auth?token=${readFileSync(join(srv.dataDir, 'token'), 'utf8').trim()}`);
});

after(async () => {
  await browser?.close();
  await srv?.destroy();
});

test('the project menu and the setup panel show the kit as not installed', async () => {
  await page.locator('aside').getByText('kitdemo', { exact: true }).first().click({ button: 'right' });
  await page.locator('[data-context-menu]').getByRole('menuitem', { name: 'Набор проекта… · не установлен' }).waitFor();
  await page.keyboard.press('Escape');

  await page.evaluate((id) => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'tab', id })), tab.id);
  await page.reload();
  await page.getByRole('radio', { name: 'Проект' }).click();
  const row = page.getByRole('button', { name: /Набор проекта…/ });
  await row.getByText('не установлен').waitFor();
  await row.click();
  await page.getByRole('dialog', { name: 'Набор проекта' }).getByText(`Install or update the project kit in the project at \`${project.root}\`.`).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click();
  assert.deepEqual(errors, []);
});

test('the kit_apply card shows the stored plan and Apply approves it before allowing', async () => {
  await send('MCP kit_plan {}');
  await page.getByText(/^MCP_RESULT/).last().waitFor();
  const chat = await page.evaluate(() => document.body.innerText);
  const planId = /plan ([\w-]+): install kit/.exec(chat)?.[1];
  assert.ok(planId, chat.slice(chat.indexOf('MCP_RESULT'), chat.indexOf('MCP_RESULT') + 1500));

  await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: `TOOL mcp__claude-os__kit_apply ${JSON.stringify({ planId })}` });
  await page.getByText(`План набора для ${project.root}`).waitFor();
  await page.getByText('.claude/kit/kit.json').first().waitFor();
  await page.getByText(/^Добавить · \d+$/).waitFor();
  assert.equal((await srv.api<KitPlan>('GET', `/api/project-kit/plans/${planId}`)).body.approved, false);
  // Only the open card's request approves: a made-up request id is refused.
  assert.equal((await srv.api('POST', `/api/project-kit/plans/${planId}/approve`, { requestId: 'made-up' })).status, 403);
  await page.getByRole('button', { name: 'Применить' }).click();
  await page.getByText('Разрешено').waitFor();
  await idle();
  assert.equal((await srv.api<KitPlan>('GET', `/api/project-kit/plans/${planId}`)).body.approved, true);
  assert.equal(existsSync(join(project.root, '.claude')), false, 'the fake CLI never runs the tool: nothing is written');
  assert.deepEqual(errors, []);
});
