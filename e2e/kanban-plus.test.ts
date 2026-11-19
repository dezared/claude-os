// The Kanban+ plugin's screen, its real interface code from plugins/kanban-plus/ui, against the fixture server's board.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { defaultFixture, startFixture, type FixtureServer } from './fixture-server.ts';

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
});

async function open(view: unknown = { kind: 'plugin', screen: 'kanban' }): Promise<Page> {
  fx = await startFixture(defaultFixture());
  ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU', reducedMotion: 'reduce' });
  await ctx.addInitScript((v) => {
    if (!localStorage.getItem('claude-os.view')) localStorage.setItem('claude-os.view', v);
  }, JSON.stringify(view));
  ctx.setDefaultTimeout(60_000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  return page;
}

const column = (page: Page, name: string) => page.getByRole('region', { name: `Колонка ${name}` });
const card = (page: Page, id: string) => page.locator(`.kp-board [data-card="${id}"]`);
const calls = (path: RegExp) => fx!.calls.filter((c) => path.test(c.path));
const menu = (page: Page) => page.locator('[data-context-menu]');

async function until(cond: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(await cond());
}

const side = (page: Page) => page.getByRole('navigation', { name: 'Доски' });

test('the board opens from the burger: the boards on the left, the tasks board with five columns on the right', async () => {
  const page = await open({ kind: 'sessions' });
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Kanban+' }).click();
  for (const name of ['Эпики', 'Задачи', 'sizeMode+ (будущее)']) await side(page).getByRole('button', { name }).waitFor();
  assert.equal(await side(page).locator('[aria-current="page"]').getAttribute('data-board'), 'tasks');
  await page.getByRole('heading', { name: 'Задачи', level: 1 }).waitFor();
  for (const name of ['Бэклог', 'В работу', 'В работе', 'Полировка', 'Готово']) await column(page, name).waitFor();
  const broker = card(page, 'AS-1');
  await broker.getByText('Обновить брокер').waitFor();
  await broker.locator('.kp-label').getByText('infra').waitFor();
  await card(page, 'TASK-3').locator('[data-card-agent]').getByText('Ревьюер').waitFor();
  assert.equal(await card(page, 'AS-2').count(), 0, 'an epic is on the epics board');
  assert.equal(await card(page, 'BW-9').count(), 0, 'a card of another board');
  assert.ok(await broker.locator('xpath=..').evaluate((el) => el.closest('li')!.classList.contains('kp-enter')), 'a card enters with its motion');
  await page.screenshot({ path: '/tmp/b4-n-kanban-dark.png' });
});

test('a card is made with N into the board on screen; a field changes in its dialog and a comment lands in its thread', async () => {
  const page = await open({ kind: 'plugin', screen: 'kanban', arg: 'alpha-service' });
  await card(page, 'AS-1').waitFor();
  await until(async () => (await card(page, 'BW-7').count()) === 0); // the project from the page is the filter
  await page.keyboard.press('n');
  const dialog = page.getByRole('dialog', { name: 'Новая карточка' });
  await dialog.getByLabel('Название').fill('Проверить ретраи');
  await dialog.getByRole('button', { name: 'Создать' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual((({ project, board }) => ({ project, board }))(calls(/\/cards$/)[0].body as { project: string; board: string }), { project: 'alpha-service', board: 'tasks' });
  await page.locator('[data-card]').filter({ hasText: 'Проверить ретраи' }).click();
  const detail = page.getByRole('dialog', { name: /AS-101/ });
  await detail.getByRole('combobox', { name: 'Приоритет' }).click();
  await page.getByRole('option', { name: 'Срочно' }).click();
  await until(() => calls(/\/cards\/AS-101$/).some((c) => (c.body as { priority?: string }).priority === 'urgent'));
  await detail.getByLabel('Новый комментарий').fill('Ретраи **проверены**');
  await detail.getByRole('button', { name: 'Отправить', exact: true }).click();
  await detail.locator('.kp-comment').getByText('проверены').waitFor();
  await detail.getByRole('radio', { name: /События/ }).click();
  await detail.getByText('прокомментировал').waitFor();
  await detail.getByText(/создал в колонке/).waitFor();
});

test('drag and the keyboard move cards; Enter opens one, Delete asks first', async () => {
  const page = await open();
  await card(page, 'AS-1').dragTo(column(page, 'В работе').locator('ul'));
  await until(() => calls(/\/move$/).some((c) => (c.body as { column: string }).column === 'doing'));
  await column(page, 'В работе').locator('[data-card="AS-1"]').waitFor();
  await card(page, 'BW-7').focus();
  await page.keyboard.press('Shift+ArrowRight');
  await column(page, 'В работе').locator('[data-card="BW-7"]').waitFor();
  await until(async () => page.evaluate(() => document.activeElement?.getAttribute('data-card') === 'BW-7'));
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: /BW-7/ }).waitFor();
  await page.keyboard.press('Escape');
  await card(page, 'BW-7').focus();
  await page.keyboard.press('Delete');
  const confirm = page.getByRole('dialog', { name: 'Удалить BW-7?' });
  await confirm.getByRole('button', { name: 'Удалить' }).click();
  await card(page, 'BW-7').waitFor({ state: 'detached' });
});

test('boards: a card dropped on one moves there; a board is renamed from its menu; Claude is asked for a new one', async () => {
  const page = await open();
  await card(page, 'AS-1').waitFor();
  await card(page, 'AS-1').dragTo(side(page).getByRole('button', { name: /sizeMode\+/ }));
  await until(() => calls(/\/cards\/AS-1$/).some((c) => (c.body as { board?: string }).board === 'S1'));
  await card(page, 'AS-1').waitFor({ state: 'detached' });
  await side(page).getByRole('button', { name: /sizeMode\+/ }).click();
  await page.getByRole('heading', { name: 'sizeMode+ (будущее)', level: 1 }).waitFor();
  await card(page, 'AS-1').waitFor();
  await card(page, 'BW-9').waitFor();
  await page.keyboard.press('[');
  await page.getByRole('heading', { name: 'Задачи', level: 1 }).waitFor();
  await side(page).getByRole('button', { name: 'Эпики' }).click();
  await card(page, 'AS-2').waitFor();
  await side(page).getByRole('button', { name: /sizeMode\+/ }).click({ button: 'right' });
  assert.equal(await menu(page).getByRole('menuitem', { name: 'Удалить доску' }).isDisabled(), true, 'a board with cards stays');
  await menu(page).getByRole('menuitem', { name: 'Изменить доску' }).click();
  const dialog = page.getByRole('dialog', { name: 'Доска' });
  await dialog.getByLabel('Название').fill('Полный экран');
  await dialog.getByLabel('Цель').fill('к релизу');
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(calls(/\/boards\/S1$/)[0].body, { name: 'Полный экран', goal: 'к релизу', project: null });
  await side(page).getByRole('button', { name: /Полный экран/ }).waitFor();
  await side(page).getByRole('button', { name: 'Попросить Claude' }).click();
  await page.getByRole('dialog').getByText('Доска для багов').waitFor();
});

test('the list view: one list per column, a row dragged onto another list moves to that column', async () => {
  const page = await open();
  await card(page, 'AS-1').waitFor();
  await page.keyboard.press('2');
  const done = page.getByRole('region', { name: 'Готово' });
  await done.waitFor();
  await page.locator('.kp-list [data-card="AS-1"]').dragTo(done);
  await until(() => calls(/\/move$/).some((c) => (c.body as { column: string }).column === 'done'));
  await done.getByRole('button', { name: 'Готово' }).click(); // the done list starts folded
  await done.locator('[data-card="AS-1"]').waitFor();
});

test('search and filters narrow the board; the keys help lists the shortcuts', async () => {
  const page = await open();
  await card(page, 'TASK-3').waitFor();
  await page.keyboard.press('/');
  await page.keyboard.type('брокер');
  await card(page, 'TASK-3').waitFor({ state: 'detached' });
  await card(page, 'AS-1').waitFor();
  await page.getByRole('button', { name: 'Сбросить' }).click();
  await page.getByRole('group', { name: 'Тип' }).getByRole('button', { name: 'Баг' }).click();
  await card(page, 'BW-7').waitFor();
  assert.equal(await page.locator('.kp-board [data-card]').count(), 1);
  await page.getByRole('button', { name: 'Сбросить' }).click();
  await page.getByRole('combobox', { name: 'Проект' }).click();
  await page.getByRole('option', { name: 'Без проекта' }).click();
  await card(page, 'AS-1').waitFor({ state: 'detached' });
  await card(page, 'TASK-3').waitFor();
  await page.locator('body').click({ position: { x: 5, y: 500 } });
  await page.keyboard.press('Shift+?');
  await page.getByRole('dialog', { name: 'Горячие клавиши' }).getByText('Передвинуть карточку в фокусе').waitFor();
});

test('values written by hand that the board has no names for show as written, on the tile and in the card, in the light theme', async () => {
  const page = await open();
  await page.evaluate(() => localStorage.setItem('claude-os.theme', 'light'));
  await page.reload();
  const tile = card(page, 'TASK-5');
  for (const text of ['spike', 'frontend', '2h', 'Анна']) await tile.getByText(text, { exact: true }).waitFor();
  await page.screenshot({ path: '/tmp/b4-n-kanban-light.png' });
  await tile.click();
  const detail = page.getByRole('dialog', { name: /TASK-5 · spike/ });
  await detail.getByRole('combobox', { name: 'Тип' }).getByText('spike').waitFor();
  await detail.getByRole('combobox', { name: 'Исполнитель' }).getByText('Анна').waitFor();
  assert.equal(await detail.getByLabel('Метки').inputValue(), 'frontend');
  assert.equal(await detail.getByLabel('Оценка').inputValue(), '2h');
  await page.screenshot({ path: '/tmp/b4-n-kanban-card-light.png' });
  assert.equal(calls(/\/cards\/TASK-5$/).length, 0, 'showing a value sends nothing');
});

test('the id prefix of the project filtered by changes from the board menu', async () => {
  const page = await open({ kind: 'plugin', screen: 'kanban', arg: 'alpha-service' });
  await card(page, 'AS-1').waitFor();
  await page.getByRole('button', { name: 'Меню доски' }).click();
  await menu(page).getByRole('menuitem', { name: 'Префикс номеров' }).click();
  const dialog = page.getByRole('dialog', { name: /Префикс номеров/ });
  await dialog.getByLabel('Префикс номеров').fill('core');
  await dialog.getByText('CORE-21').waitFor();
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await until(() => calls(/\/prefix$/).length === 1);
  assert.deepEqual(calls(/\/prefix$/)[0].body, { project: 'alpha-service', prefix: 'CORE' });
});
