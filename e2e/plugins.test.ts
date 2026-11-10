// The Claude OS plugins pane and the icon picker against e2e/fixture-server.ts: no real server, no Claude. Set CLAUDE_OS_WEB_DIST to test another build.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { fixtureIcons } from './fixture-features.ts';
import { fixtureOsPlugins, resetOsPlugins } from './fixture-plugins.ts';
import { startFixture, type FixtureServer } from './fixture-server.ts';

let browser: Browser;
let ctx: BrowserContext | null = null;
let fx: FixtureServer | null = null;
let errors: string[] = [];

before(async () => {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});
after(() => browser.close());
afterEach(async () => {
  assert.deepEqual(errors, []);
  await ctx?.close();
  await fx?.close();
  ctx = null;
  fx = null;
  errors = [];
  fixtureIcons.icons = {};
  fixtureIcons.chosen = {};
  resetOsPlugins();
});

async function open(view: unknown, locale = 'ru-RU'): Promise<Page> {
  fx = await startFixture();
  ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale, reducedMotion: 'reduce' });
  await ctx.addInitScript((v) => localStorage.setItem('claude-os.view', v), JSON.stringify(view));
  ctx.setDefaultTimeout(60000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  return page;
}

const sent = () => fx!.calls.filter((c) => c.path.endsWith('/send')).length;
const rightClick = (target: Locator) => target.evaluate((el) => {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 4, clientY: r.top + 4 }));
});

test('plugins screen: apart from Tools, in the burger menu, an old saved place still leads here', async () => {
  const page = await open({ kind: 'tools', pane: 'os-plugins' });
  await page.getByRole('heading', { name: 'Плагины Claude OS' }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: 'Раздел инструментов' }).count(), 0, 'a saved view from before the move opens the new screen');

  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('menuitem', { name: 'Инструменты' }).click();
  const nav = page.getByRole('navigation', { name: 'Раздел инструментов' });
  await nav.getByRole('button', { name: 'Плагины', exact: true }).waitFor();
  assert.equal(await nav.getByRole('button', { name: 'Плагины Claude OS' }).count(), 0);
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('menuitem', { name: 'Плагины Claude OS' }).click();
  await page.getByRole('heading', { name: 'Плагины Claude OS' }).waitFor();
});

test('plugins screen: a bad manifest cannot be enabled, the dialog lists what changes and where', async () => {
  const page = await open({ kind: 'os-plugins' });
  await page.getByText('All three kinds').waitFor();
  await page.getByText('version must look like 1.2.3').waitFor();
  await page.getByText('ошибка в манифесте').waitFor();
  const buttons = page.getByRole('button', { name: 'Включить', exact: true });
  assert.equal(await buttons.count(), 3);
  assert.equal(await buttons.nth(1).isDisabled(), true);

  await buttons.first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('/home/test/.claude/skills/helper').waitFor();
  await dialog.getByText('/home/test/.claude/settings.json').waitFor();
  await dialog.getByText('notify done').waitFor();
  await dialog.getByText('/home/test/.claude.json (mcpServers)').waitFor();
  assert.ok(!fx!.calls.some((c) => c.path.endsWith('/enable')), 'nothing is enabled before the button');

  await dialog.getByRole('button', { name: 'Включить' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(fx!.calls.find((c) => c.path === '/api/os-plugins/full/enable')?.body, { confirmed: true, sha: 'sha-enable' });
  await page.getByText('включён', { exact: true }).waitFor();

  await page.getByRole('button', { name: 'Отключить', exact: true }).click();
  await dialog.getByText('будет убран').first().waitFor();
  await dialog.getByRole('button', { name: 'Отключить' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(fx!.calls.find((c) => c.path === '/api/os-plugins/full/disable')?.body, { confirmed: true, sha: 'sha-disable' });
});

test('plugins screen: icon, version and description in the row; dependencies in the dialog; the setup goes to a new tab only with the button', async () => {
  const page = await open({ kind: 'os-plugins' });
  await page.getByText('Контекстный поиск поверх ripgrep').waitFor();
  await page.getByText('1.1.0').first().waitFor();
  assert.equal(await page.locator('img[src^="data:image/svg+xml"]').count(), 1, 'the manifest icon, through an img');

  await page.getByRole('button', { name: 'Включить', exact: true }).nth(2).click();
  const dialog = page.getByRole('dialog');
  const deps = dialog.getByRole('region', { name: 'Зависимости' });
  await deps.getByText('Строки в CLAUDE.md').waitFor();
  await deps.getByText('Настройка в конфиге').waitFor();
  await deps.getByText('нет', { exact: true }).waitFor();
  await dialog.getByRole('alert').getByText('Настоятельно рекомендуем').waitFor();
  await page.screenshot({ path: process.env.PLUGIN_SHOT_DIALOG ?? '/tmp/cos-plugins-dialog.png' });

  await dialog.getByRole('checkbox').uncheck();
  await dialog.getByText('Без настройки плагин будет работать').waitFor();
  await dialog.getByRole('checkbox').check();
  assert.equal(sent(), 0);
  await dialog.getByRole('button', { name: 'Включить и настроить' }).click();
  await dialog.waitFor({ state: 'detached' });
  for (let i = 0; i < 100 && sent() === 0; i++) await page.waitForTimeout(50);
  assert.equal(sent(), 1, 'one request to Claude after enabling');
  const send = fx!.calls.find((c) => c.path.endsWith('/send'))!;
  assert.match((send.body as { text: string }).text, /os-plugin:rg-context:claude-md:start/);
  const tab = fx!.calls.find((c) => c.path === '/api/tabs' && c.method === 'POST');
  assert.deepEqual(tab?.body, { cwd: '/home/test/claude-os', title: 'rg-context: setup', source: 'setup', sourceDetail: 'rg-context' });
});

test('plugins screen: what is still missing can be set up from the row, not before the button', async () => {
  fixtureOsPlugins.rows = fixtureOsPlugins.rows.map((r) => (r.id === 'rg-context' ? { ...r, enabled: true, installedVersion: r.version } : r));
  const page = await open({ kind: 'os-plugins' });
  await page.getByText('не настроен', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Настроить' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Строки в CLAUDE.md').waitFor();
  assert.equal(sent(), 0);
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(sent(), 0);
});

test('plugins screen: a changed folder offers an update, with its own dialog and hash', async () => {
  fixtureOsPlugins.rows = fixtureOsPlugins.rows.map((r) => (r.id === 'full' ? { ...r, enabled: true, installedVersion: '0.9.0', changed: true } : r));
  const page = await open({ kind: 'os-plugins' });
  await page.getByText('изменён после включения').waitFor();
  await page.getByRole('button', { name: 'Обновить', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: 'Обновить full' }).waitFor();
  await dialog.getByRole('button', { name: 'Обновить', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(fx!.calls.find((c) => c.path === '/api/os-plugins/full/update')?.body, { confirmed: true, sha: 'sha-update' });
  await page.getByRole('button', { name: 'Обновить', exact: true }).waitFor({ state: 'detached' });
});

test('plugins screen: right click, write through Claude sends nothing by itself, no samples anywhere', async () => {
  const page = await open({ kind: 'os-plugins' });
  await rightClick(page.getByText('All three kinds'));
  const menu = page.getByRole('menu');
  for (const name of ['Открыть страницу', 'Включить', 'Скопировать путь к папке', 'Изменить с Claude', 'Вопрос Claude', 'Написать плагин через Claude']) await menu.getByRole('menuitem', { name }).waitFor();
  await menu.getByRole('menuitem', { name: 'Написать плагин через Claude' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText(/config\/plugins\/<id>/).waitFor();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await page.getByRole('button', { name: 'Написать плагин через Claude' }).click();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  assert.equal(sent(), 0);

  assert.equal(await page.getByRole('region', { name: 'Примеры' }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Добавить' }).count(), 0);

  await rightClick(page.getByText('All three kinds'));
  await page.getByRole('menuitem', { name: 'Открыть страницу' }).click();
  await page.getByRole('heading', { name: 'full' }).waitFor();
  await page.getByText('/home/test/claude-os/config/plugins/full').waitFor();
  await page.getByRole('button', { name: 'Включить', exact: true }).waitFor();
});

test('english strings exist for the screen, and a row falls back to the English text', async () => {
  const page = await open({ kind: 'os-plugins' }, 'en-US');
  await page.getByRole('button', { name: 'Write a plugin with Claude' }).waitFor();
  await page.getByRole('heading', { name: 'Claude OS plugins' }).waitFor();
  await page.getByText('Context search on top of ripgrep').waitFor();
  await page.getByRole('button', { name: 'Enable', exact: true }).nth(2).click();
  await page.getByRole('dialog').getByText('Lines in CLAUDE.md').waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
});

test('icon picker: from the right-click menu of a project, stored per project, shown in its colour, can be removed', async () => {
  const page = await open({ kind: 'home' });
  const row = page.locator('[data-widget="projects"] .group').filter({ hasText: 'alpha-service' }).first();
  await row.waitFor();
  await rightClick(row);
  await page.getByRole('menuitem', { name: 'Выбрать иконку' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'si:gitlab' }).waitFor();
  await dialog.getByRole('textbox').fill('map');
  await dialog.getByRole('button', { name: 'si:gitlab' }).waitFor({ state: 'detached' });
  await dialog.getByRole('button', { name: 'map', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(fx!.calls.find((c) => c.path === '/api/project-icons/alpha-service')?.body, { icon: 'map' });
  assert.equal(fixtureIcons.chosen['alpha-service'], 'map');

  // An img can run nothing; the library ink gives way to the colour of the project.
  const img = row.locator('img[src^="data:image/svg+xml"]');
  await img.waitFor();
  const src = decodeURIComponent((await img.getAttribute('src'))!);
  assert.doesNotMatch(src, /#e4e4e7/);
  assert.match(src, /stroke="rgb\(/);

  await rightClick(row);
  await page.getByRole('menuitem', { name: 'Выбрать иконку' }).click();
  await dialog.getByRole('button', { name: 'Подобрать через Claude' }).waitFor();
  await dialog.getByRole('button', { name: 'Убрать выбор' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(fixtureIcons.chosen['alpha-service'], undefined);
  await img.waitFor({ state: 'detached' });

  await rightClick(row);
  await page.getByRole('menuitem', { name: 'Выбрать иконку' }).click();
  await dialog.getByRole('button', { name: 'Подобрать через Claude' }).click();
  await dialog.getByText(/config\/project-icons\/icons\.json/).waitFor();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  assert.equal(sent(), 0);
});
