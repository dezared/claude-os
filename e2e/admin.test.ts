// Admin panels against e2e/fixture-server.ts: no real server, no Claude. Set CLAUDE_OS_WEB_DIST to test another build.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { fixtureAccount, fixtureIcons, fixtureSettings, obsidianProbe } from './fixture-features.ts';
import { resetOsPlugins } from './fixture-plugins.ts';
import { defaultFixture, emptyFixture, startFixture, type Fixture, type FixtureServer } from './fixture-server.ts';

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
  fixtureSettings.obsidian.dismissed = false;
  fixtureSettings.obsidian.installed = false;
  obsidianProbe.installed = null;
  fixtureIcons.icons = {};
  fixtureIcons.chosen = {};
  resetOsPlugins();
  fixtureIcons.offerDismissed = true;
  fixtureAccount.billing = 'subscription';
});

async function open(view: unknown, locale = 'ru-RU', data?: Fixture | boolean): Promise<Page> {
  fx = await startFixture(data === true ? emptyFixture() : data || undefined);
  ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale, reducedMotion: 'reduce' });
  await ctx.addInitScript((v) => localStorage.setItem('claude-os.view', v), JSON.stringify(view));
  ctx.setDefaultTimeout(20000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  return page;
}

const sent = () => fx!.calls.filter((c) => c.path.endsWith('/send')).length;
const menu = (page: Page) => page.locator('[data-context-menu]');
const items = (page: Page) => menu(page).getByRole('menuitem').allTextContents();
const withProjectSkill = () => {
  const data = defaultFixture();
  data.skills.push({ id: 'project:alpha-service:release-notes', name: 'release-notes', scope: 'project', source: 'alpha-service', description: 'Заметки о выпуске', path: '/home/test/alpha-service/.claude/skills/release-notes', readOnly: false, disabled: false, isSymlink: false, usageCount: 2, lastUsedAt: null });
  return data;
};

test('tools: a panel per subject, statistics first, questions only open a dialog', async () => {
  const page = await open({ kind: 'tools', pane: 'skills' });
  const nav = page.getByRole('navigation', { name: 'Раздел инструментов' });
  for (const name of ['Скиллы', 'MCP-серверы', 'Хуки', 'Плагины', 'CLAUDE.md', 'Хранилище', 'Журнал']) await nav.getByRole('button', { name, exact: true }).waitFor();

  await page.getByText('Скиллов всего').waitFor();
  await page.getByText('Чаще всего').waitFor();
  await page.getByText('Кандидаты на отключение').waitFor();

  // The tool panes ask through the right click, anywhere on the pane; presets and free text, wrapped with the list as context.
  for (const [pane, item, preset, context] of [
    ['Скиллы', 'Анализ скиллов через Claude', 'Какие скиллы можно убрать?', /skills, \d+ used/],
    ['MCP-серверы', 'Анализ серверов через Claude', 'Какие серверы можно отключить?', /semble: connected/],
    ['Хуки', 'Анализ хуков через Claude', 'Что делают мои хуки?', /npm run lint/],
    ['Плагины', 'Анализ плагинов через Claude', 'Какие плагины можно отключить?', /superpowers@official/],
  ] as const) {
    await nav.getByRole('button', { name: pane, exact: true }).click();
    assert.equal(await page.getByRole('button', { name: 'Спросить Claude' }).count(), 0, pane);
    await page.locator('.sheet-bar').first().click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: item }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('button', { name: preset }).click();
    await dialog.getByText(context).waitFor();
    await dialog.getByRole('button', { name: 'Отмена' }).click();
  }

  for (const pane of ['CLAUDE.md', 'Хранилище']) {
    await nav.getByRole('button', { name: pane, exact: true }).click();
    await page.getByRole('button', { name: 'Спросить Claude' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('radio', { name: 'Очистить' }).click();
    await dialog.getByText(/find what is not needed/).waitFor();
    await dialog.getByText(/Входит в|подписк|API/).waitFor();
    assert.equal(await dialog.getByText(/тратит токены/i).count(), 0);
    await dialog.getByRole('button', { name: 'Отмена' }).click();
  }
  assert.equal(sent(), 0);
});

test('MCP: real statuses, what it gives, where active, a login action, masked config', async () => {
  const page = await open({ kind: 'tools', pane: 'mcp' });
  await page.getByText('Нужен вход: 1').waitFor();
  await page.getByText('spawn ENOENT').first().waitFor();

  // Opening the panel asks the CLI; reading alone starts nothing else.
  for (let i = 0; i < 100 && !fx!.calls.some((c) => c.path === '/api/admin/mcp/status'); i++) await page.waitForTimeout(50);

  await page.getByRole('button', { name: 'Войти: figma' }).click();
  await page.getByText(/Открыт терминал/).waitFor();
  assert.ok(fx!.calls.some((c) => c.path === `/api/mcp/${encodeURIComponent('plugin:figma:figma')}/login`));

  await page.getByRole('button', { name: /Подробнее о сервере semble/ }).click();
  await page.getByText('Instant code search for any repository.').waitFor();
  await page.getByText('Search code by meaning.').waitFor();
  await page.getByText('только чтение').first().waitFor();
  await page.getByText('uvx semble --old').waitFor();
  await page.getByRole('button', { name: /Подробнее о сервере semble/ }).click();

  await page.getByRole('button', { name: /Подробнее о сервере silent/ }).click();
  await page.getByText('Сервер не передал описание.').waitFor();
  await page.getByRole('button', { name: /Подробнее о сервере silent/ }).click();

  await page.getByRole('button', { name: /Подробнее о сервере broken/ }).click();
  await page.getByText('переменные: API_TOKEN').waitFor();

  await page.getByText(/old_metabase \(12\)/).waitFor();

  await page.getByRole('radio', { name: 'По проектам' }).click();
  await page.getByText('отличается от глобальной: 1').waitFor();
  await page.getByRole('button', { name: 'Проверить', exact: true }).waitFor();
  assert.equal((fx!.calls.find((c) => c.path === '/api/admin/mcp/status')?.body as { project?: string }).project, '*');
});

test('hooks and plugins: by event and scope, updates, what differs per project', async () => {
  const page = await open({ kind: 'tools', pane: 'hooks' });
  await page.getByText('Хуков всего').waitFor();
  await page.getByText('По событиям').waitFor();
  await page.getByText(/notify --token=\*\*\*/).waitFor();
  await page.getByText('запуски хуков журналы не считают').waitFor();
  await page.getByRole('radio', { name: 'По проектам' }).click();
  // Per project: the same row as the main view, under the project's head.
  const group = page.getByRole('region', { name: 'alpha-service' });
  await group.getByText('PostToolUse').waitFor();
  await group.getByText('Edit', { exact: true }).waitFor();
  await group.getByText('npm run lint').waitFor();

  await page.getByRole('navigation', { name: 'Раздел инструментов' }).getByRole('button', { name: 'Плагины', exact: true }).click();
  await page.getByText('есть 7.1.0').waitFor();
  await page.getByText('неизвестно: 1').waitFor();
  await page.getByText('6 / 14').waitFor();
  await page.getByText('Без запусков за 30 дней').waitFor();
  await page.getByRole('radio', { name: 'По проектам' }).click();
  await page.getByRole('region', { name: 'alpha-service' }).getByRole('button', { name: 'local-only' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'superpowers' }).count(), 0);
});

test('skills: one button on top; a right click opens the page, updates, deletes with a confirmation, asks', async () => {
  const page = await open({ kind: 'tools', pane: 'skills' });
  await page.getByText('Скиллов всего').waitFor();
  await page.getByRole('button', { name: 'Создать через Claude' }).waitFor();
  for (const gone of ['Из шаблона', 'Спросить Claude', 'Через Claude']) assert.equal(await page.getByRole('button', { name: gone, exact: true }).count(), 0, gone);

  const row = page.getByRole('button', { name: /^old-thing/ }).last();
  await row.click({ button: 'right' });
  assert.deepEqual(await items(page), ['Открыть страницу', 'Обновить через Claude', 'Вопрос Claude', 'Удалить…', 'Написать скилл через Claude', 'Из шаблона', 'Анализ скиллов через Claude']);

  await menu(page).getByRole('menuitem', { name: 'Удалить…' }).click();
  let dialog = page.getByRole('dialog', { name: 'Удалить скилл old-thing?' });
  await dialog.getByText('/home/test/.claude/skills/old-thing').waitFor();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  const deletes = () => fx!.calls.filter((c) => c.method === 'DELETE');
  assert.equal(deletes().length, 0, 'nothing is deleted without the dialog');

  await row.click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Удалить…' }).click();
  dialog = page.getByRole('dialog', { name: 'Удалить скилл old-thing?' });
  await dialog.getByRole('button', { name: 'Удалить' }).click();
  await page.getByText('Скилл old-thing удалён').waitFor();
  assert.equal(deletes()[0].path, `/api/skills/${encodeURIComponent('user:old-thing')}`);
  assert.deepEqual(deletes()[0].body, { confirmed: true });

  // A plugin's skill is not ours to change: it leads to the plugin, nothing to delete.
  await page.getByRole('button', { name: /^charts/ }).last().click({ button: 'right' });
  assert.deepEqual((await items(page)).slice(0, 3), ['Открыть страницу', 'Открыть плагин viz-kit', 'Вопрос Claude']);
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Создать через Claude' }).click();
  dialog = page.getByRole('dialog', { name: 'Написать скилл через Claude' });
  await dialog.getByText(/global skill in ~\/\.claude\/skills/).waitFor();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  assert.equal(sent(), 0);
});

test('skills: the page says the scope, the file, the statistics; what is not known is not there', async () => {
  const page = await open({ kind: 'tools', pane: 'skills' }, 'ru-RU', withProjectSkill());
  await page.getByRole('button', { name: /^brainstorm/ }).last().click();
  await page.locator('header').getByRole('heading', { name: 'brainstorm' }).waitFor();
  await page.getByText('Глобально: во всех проектах').waitFor();
  await page.getByText('/home/test/.claude/skills/brainstorm').waitFor();
  await page.getByText('Jane Doe').waitFor();
  await page.getByText('skill.update').waitFor();
  await page.getByText('Запусков за всё время').waitFor();
  await page.getByText('Шаги скилла.').waitFor();

  await page.locator('header').getByRole('heading', { name: 'brainstorm' }).click({ button: 'right' });
  assert.deepEqual(await items(page), ['Обновить через Claude', 'Вопрос Claude', 'Удалить…']);
  await menu(page).getByRole('menuitem', { name: 'Обновить через Claude' }).click();
  await page.getByRole('dialog', { name: 'Изменить с Claude: brainstorm' }).getByText(/Scope: global, available in every project/).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click();

  await page.getByRole('navigation', { name: 'Путь' }).getByRole('button', { name: 'Скиллы' }).click();
  await page.getByRole('radio', { name: 'По проектам' }).click();
  const group = page.getByRole('region', { name: 'alpha-service' });
  const row = group.getByRole('button', { name: /^release-notes/ });
  await row.waitFor();
  assert.equal(await page.getByRole('button', { name: /^brainstorm/ }).count(), 0);
  await group.getByRole('button', { name: 'alpha-service', exact: true }).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Написать скилл для этого проекта' }).click();
  await page.getByRole('dialog').getByText(/\/home\/test\/alpha-service\/\.claude\/skills/).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click();
  await row.click();
  await page.getByText('Только в проекте alpha-service').waitFor();
  assert.equal(sent(), 0);
});

test('MCP: a right click deletes with the file named, moves and changes through Claude, adds through Claude', async () => {
  const page = await open({ kind: 'tools', pane: 'mcp' });
  await page.getByText('Нужен вход: 1').waitFor();
  await page.getByRole('button', { name: 'Добавить через Claude' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Спросить Claude' }).count(), 0);

  const row = page.getByRole('button', { name: 'semble', exact: false }).filter({ hasText: 'semble 0.7.2' });
  await row.click({ button: 'right' });
  const list = await items(page);
  for (const item of ['Открыть страницу', 'Посмотреть по проектам', 'Обновить или изменить через Claude', 'Перенести между областями через Claude', 'Вопрос Claude', 'Удалить…', 'Добавить через Claude', 'Добавить вручную']) assert.ok(list.includes(item), item);

  await menu(page).getByRole('menuitem', { name: 'Удалить…' }).click();
  let dialog = page.getByRole('dialog', { name: 'Удалить semble?' });
  assert.equal(await dialog.getByText('/home/test/.claude.json').count(), 2, 'each definition names its file');
  await dialog.getByText(/claude mcp remove/).waitFor();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  assert.equal(fx!.calls.filter((c) => c.method === 'DELETE').length, 0);

  await row.click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Удалить…' }).click();
  dialog = page.getByRole('dialog', { name: 'Удалить semble?' });
  await dialog.getByRole('button', { name: 'Удалить' }).last().click();
  await page.getByText('Сервер semble удалён').waitFor();
  const del = fx!.calls.find((c) => c.method === 'DELETE')!;
  assert.equal(del.path, '/api/mcp/semble');
  await dialog.getByRole('button', { name: 'Отмена' }).click();

  await row.click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Обновить или изменить через Claude' }).click();
  dialog = page.getByRole('dialog', { name: 'Изменить с Claude: semble' });
  await dialog.getByRole('button', { name: 'Запиши, что этому серверу нужен включённый VPN' }).click();
  await dialog.getByText(/uvx semble --old/).waitFor();
  await dialog.getByRole('button', { name: 'Отмена' }).click();

  await row.click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Перенести между областями через Claude' }).click();
  dialog = page.getByRole('dialog', { name: 'Перенести semble' });
  await dialog.getByRole('button', { name: 'Вынеси из проекта в глобальную область' }).waitFor();
  await dialog.getByRole('button', { name: 'Убери из глобальной области и оставь только в проекте' }).waitFor();
  await dialog.getByRole('button', { name: 'Отмена' }).click();

  await page.getByRole('button', { name: 'Добавить через Claude' }).click();
  dialog = page.getByRole('dialog', { name: 'Добавить через Claude' });
  await dialog.getByRole('button', { name: 'Напиши новый сервер как часть Claude OS' }).waitFor();
  await dialog.getByRole('button', { name: 'Отмена' }).click();

  // A plugin's server has no delete and no move.
  await page.getByRole('button', { name: 'figma', exact: false }).filter({ hasText: 'figma' }).last().click({ button: 'right' });
  const plugin = await items(page);
  assert.ok(!plugin.includes('Удалить…') && !plugin.includes('Перенести между областями через Claude'));
  await menu(page).getByRole('menuitem', { name: 'Посмотреть по проектам' }).click();
  await page.getByRole('region', { name: 'alpha-service' }).getByRole('button', { name: /semble/ }).first().waitFor();
  assert.equal(sent(), 0);
});

test('pages: an MCP server by project, a plugin, a hook, a project; absent data stays absent', async () => {
  const page = await open({ kind: 'entity', type: 'mcp', id: 'semble' });
  await page.getByRole('heading', { name: 'semble' }).waitFor();
  await page.getByText('Все проекты').waitFor();
  await page.getByText('Вызовы по инструментам').waitFor();
  await page.getByText('Instant code search for any repository.').waitFor();
  await page.getByText('uvx semble --old').waitFor();
  assert.equal(await page.getByText('Создан', { exact: true }).count(), 0);
  await page.locator('.sheet').getByRole('button', { name: 'alpha-service', exact: true }).first().click();

  await page.getByRole('heading', { name: 'alpha-service' }).waitFor();
  assert.deepEqual(await page.getByRole('navigation', { name: 'Путь' }).locator('button, span').allTextContents(), ['Главная', 'alpha-service']);
  await page.getByText('/home/test/alpha-service', { exact: true }).waitFor();
  await page.getByText('Токены за 30 дней').waitFor();
  await page.getByText('Частые инструменты').waitFor();
  await page.getByRole('button', { name: 'local-only' }).waitFor();
  await page.getByText('npm run lint').click();

  await page.getByRole('heading', { name: 'PostToolUse · Edit' }).waitFor();
  await page.getByText('Только в проекте alpha-service, настройка в репозитории').waitFor();
  await page.getByText('/home/test/alpha-service/.claude/settings.json').waitFor();
  await page.getByText('запуски хуков журналы не считают').waitFor();
  assert.equal(await page.getByText('Файл настроек изменён').count(), 0);
  await page.getByRole('heading', { name: 'PostToolUse · Edit' }).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Вопрос Claude' }).click();
  await page.getByRole('dialog').getByText(/Settings file: \/home\/test\/alpha-service/).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click();

  assert.equal(sent(), 0);
});

test('plugin page: what the manifest and the report hold, and no empty lines', async () => {
  const page = await open({ kind: 'entity', type: 'plugin', id: 'superpowers@official' });
  await page.getByRole('heading', { name: 'superpowers' }).waitFor();
  await page.getByText('Core skills').waitFor();
  await page.getByText('есть 7.1.0').first().waitFor();
  await page.getByText('Глобально: во всех проектах').waitFor();
  await page.getByRole('heading', { name: 'superpowers' }).click({ button: 'right' });
  assert.deepEqual(await items(page), ['Обновить через Claude', 'Вопрос Claude']);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByText('Автор', { exact: true }).count(), 0);
});

test('analytics: Today, labelled forecast, weekly limit; no tools content; no dollars on a subscription', async () => {
  const page = await open({ kind: 'analytics' });
  await page.getByRole('radio', { name: 'Сегодня' }).click();
  await page.getByText('По часам').waitFor();
  await page.getByText('Прогноз, оценка').waitFor();
  await page.getByText(/Прямая экстраполяция/).waitFor();
  await page.getByText('≈ 72 %').first().waitFor();
  await page.getByText('Недельный лимит к сбросу').waitFor();
  for (const gone of ['Журнал обращений', 'Журнал действий', 'Кандидаты на отключение']) assert.equal(await page.getByText(gone).count(), 0, gone);
  assert.equal(await page.getByText('Стоимость').count(), 0);
  assert.equal(await page.getByText(/\$\d/).count(), 0);
  await page.getByRole('radio', { name: '30 дней' }).click();
  await page.getByText('По дням').waitFor();
});

test('settings: menu of sections, one at a time, everything reachable', async () => {
  const page = await open({ kind: 'settings' });
  const nav = page.getByRole('navigation', { name: 'Разделы настроек' });
  await page.getByRole('radio', { name: 'EN' }).waitFor();

  await nav.getByRole('button', { name: 'IDE и программы' }).click();
  await page.getByText('Visual Studio Community 2022').waitFor();
  assert.equal(await page.getByRole('radio', { name: 'EN' }).count(), 0);

  await nav.getByRole('button', { name: 'Проекты' }).click();
  await page.getByRole('combobox', { name: 'Усилие' }).waitFor();
  await page.getByRole('button', { name: 'Подобрать недостающие' }).click();
  await page.getByRole('dialog').getByText(/config\/project-icons/).waitFor();
  await page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click();
  assert.equal(sent(), 0);

  await nav.getByRole('button', { name: 'Claude', exact: true }).click();
  await page.getByText('Оплата').waitFor();
  await nav.getByRole('button', { name: 'Заметки и Obsidian' }).click();
  await page.getByText('Перенос заметок').waitFor();
  await nav.getByRole('button', { name: 'О программе' }).click();
  await page.getByText('simple-icons, lucide').waitFor();
});

test('project icons: the offer sends nothing by itself and goes away', async () => {
  fixtureIcons.offerDismissed = false;
  const page = await open({ kind: 'sessions' });
  const offer = page.getByRole('complementary', { name: 'Иконки проектов' });
  await offer.getByRole('button', { name: 'Подобрать' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Отмена' }).click();
  assert.equal(sent(), 0);
  await offer.waitFor({ state: 'detached' });
  assert.ok(fx!.calls.some((c) => c.path === '/api/project-icons/dismiss-offer'));
});

test('a served project icon is shown as an image, not as markup', async () => {
  fixtureIcons.icons = { 'alpha-service': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="#5fb98a"/></svg>' };
  const page = await open({ kind: 'sessions' });
  const img = page.locator('.sheet img[src^="data:image/svg+xml"]').first();
  await img.waitFor();
  assert.equal(await img.evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0), true);
  assert.equal(await page.locator('.sheet svg circle[fill="#5fb98a"]').count(), 0);
});

test('obsidian notice: one line, path behind a detail, gone on focus once installed, no restart', async () => {
  const page = await open({ kind: 'sessions' });
  const notice = page.getByRole('complementary', { name: 'Obsidian не найден' });
  await notice.getByText('Скачать с obsidian.md').waitFor();
  const box = await notice.boundingBox();
  assert.ok(box && box.height <= 40, `height ${box?.height}`);
  assert.equal(await notice.getByText(fixtureSettings.obsidian.vaultWindows).count(), 0);
  await notice.getByRole('button', { name: 'Куда указать' }).click();
  await notice.getByText(fixtureSettings.obsidian.vaultWindows).waitFor();

  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  for (let i = 0; i < 100 && !fx!.calls.some((c) => c.path === '/api/settings/obsidian/recheck'); i++) await page.waitForTimeout(20);
  await notice.waitFor({ state: 'visible' });

  obsidianProbe.installed = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await notice.waitFor({ state: 'detached' });
});

test('an empty machine: skills say so, with a way to create one', async () => {
  const page = await open({ kind: 'tools', pane: 'skills' }, 'ru-RU', true);
  await page.getByText('Скиллов пока нет.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Создать через Claude' }).waitFor();
});

test('english is complete on the new screens', async () => {
  const page = await open({ kind: 'tools', pane: 'mcp' }, 'en-US');
  await page.getByText('Need login: 1').waitFor();
  await page.getByRole('button', { name: 'Add with Claude' }).waitFor();
  await page.getByRole('navigation', { name: /tools/i }).getByRole('button', { name: 'Hooks' }).click();
  await page.getByText('Hooks in total').waitFor();
  assert.equal(await page.locator('.sheet').getByText(/[А-Яа-я]{4,}/).count(), 0);
});
