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
  await page.getByRole('dialog', { name: 'Набор проекта' }).getByText(`Project kit \`project-kit\`, action \`install\`, in the project at \`${project.root}\`.`).waitFor();
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

test('the kits screen sits in Tools, not in the menu, and shows the kit, its project and its actions', async () => {
  // An installed kit as the engine leaves it: the lock is what the screen reads.
  mkdirSync(join(project.root, '.claude', 'kit'), { recursive: true });
  writeFileSync(join(project.root, '.claude', 'kit', 'lock.json'), JSON.stringify({ kit: '1.0.0', installedAt: Date.now(), sizeAtInstall: 0, files: {}, settings: { file: '.claude/settings.json', allow: [], deny: [], ask: [], hooks: [] } }));
  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'home' })));
  await page.reload();
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  const menu = page.getByRole('menu');
  await menu.getByRole('menuitem', { name: 'Инструменты' }).waitFor();
  assert.equal(await menu.getByRole('menuitem', { name: 'Наборы проектов' }).count(), 0);
  assert.equal(await menu.getByRole('menuitem', { name: 'Агенты', exact: true }).count(), 0);
  await menu.getByRole('menuitem', { name: 'Инструменты' }).click();
  const nav = page.getByRole('navigation', { name: 'Раздел инструментов' });
  await nav.getByRole('button', { name: 'Наборы проектов' }).click();
  assert.equal(await nav.getByRole('button', { name: 'Наборы проектов' }).getAttribute('aria-current'), 'page');

  // The numbers come with a plain-language glossary, folded until asked for.
  await page.getByRole('button', { name: 'Как читать цифры' }).click();
  await page.getByText('Сколько токенов Claude получает в начале сессии', { exact: false }).first().waitFor();
  await page.screenshot({ path: '/tmp/claudeos-kits-guide.png' });
  await page.getByRole('button', { name: 'Как читать цифры' }).click();

  const tile = page.getByRole('button', { name: /Project kit/ }).first();
  await tile.getByText('по умолчанию').waitFor();
  await tile.getByText('включён').waitFor();
  await tile.getByText(/Правила 4 · Агенты 3 · Скиллы 5 · Проверки 4 · Хуки 4/).waitFor();
  await tile.getByText('нет данных').first().waitFor(); // no session after the install: said in words, not a bare dash
  await page.getByText('Применений пока не было.').waitFor();
  await page.screenshot({ path: '/tmp/claudeos-kits-overview.png' });
  await tile.click();
  await page.getByRole('heading', { name: 'Что ставит' }).waitFor();
  await page.getByText('reviewer, scout, test-runner').waitFor();
  await page.getByRole('heading', { name: 'Проекты · 1' }).waitFor();
  await page.getByText('v1.0.0', { exact: false }).first().waitFor();
  // The lock alone gives the project a metrics row: one before/after chart per compared metric, and its table view.
  const start = page.locator('figure').filter({ hasText: 'Стартовый контекст' });
  await start.waitFor();
  await start.getByText('меньше — лучше').waitFor();
  await start.getByText('цель < 20 тыс. токенов').waitFor();
  assert.equal(await page.locator('figure').count(), 4);
  await page.getByRole('button', { name: 'Таблицей' }).click();
  await page.getByRole('columnheader', { name: 'Цель' }).waitFor();
  await page.getByRole('button', { name: 'Графиками' }).click();

  // Remove goes through the same microtask as the project menu, with the kit and the action filled in.
  await page.getByRole('button', { name: 'Удалить', exact: true }).click();
  await page.getByRole('dialog', { name: 'Набор проекта' }).getByText(`Project kit \`project-kit\`, action \`remove\`, in the project at \`${project.root}\`.`).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click();

  await page.getByRole('button', { name: /Настроить через Claude/ }).click();
  const change = page.getByRole('dialog', { name: 'Настроить набор проектов' });
  await change.getByText('Change the Claude OS project kit "Project kit" (plugin `project-kit`, shipped with Claude OS', { exact: false }).waitFor();
  await change.getByRole('button', { name: 'Отмена' }).click();

  await page.getByRole('button', { name: /Создать набор/ }).click();
  await page.getByRole('dialog', { name: 'Создать набор проектов' }).getByText('The kits there now: project-kit.', { exact: false }).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click();
  await page.screenshot({ path: '/tmp/claudeos-kits-dark.png' });
  await page.evaluate(() => localStorage.setItem('claude-os.theme', 'light'));
  await page.reload();
  await page.getByRole('heading', { name: 'Что ставит' }).waitFor();
  await page.screenshot({ path: '/tmp/claudeos-kits-light.png' });
  await page.evaluate(() => localStorage.setItem('claude-os.theme', 'dark'));
  await page.reload();
  await page.getByRole('heading', { name: 'Что ставит' }).waitFor();

  // The agents stay one Ctrl+K away.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('Агенты');
  await page.getByRole('option', { name: /Агенты/ }).first().waitFor();
  await page.keyboard.press('Escape');
  assert.deepEqual(errors, []);
});
