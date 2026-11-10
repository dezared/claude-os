// The kanban board, the agents panel and the marks of Claude OS sessions, against e2e/fixture-server.ts.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { defaultFixture, homeButton, startFixture, type Fixture, type FixtureServer } from './fixture-server.ts';

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

async function open(view: unknown, data: Fixture = defaultFixture(), locale = 'ru-RU'): Promise<Page> {
  fx = await startFixture(data);
  ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale, reducedMotion: 'reduce' });
  await ctx.addInitScript((v) => {
    if (!localStorage.getItem('claude-os.view')) localStorage.setItem('claude-os.view', v);
  }, JSON.stringify(view));
  ctx.setDefaultTimeout(60_000); // the map renders in software here: a loaded machine stalls the page for many seconds
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  return page;
}

const column = (page: Page, name: string) => page.getByRole('region', { name: `Колонка: ${name}` });
const card = (page: Page, title: string) => page.locator('[data-card]').filter({ hasText: title });
const titles = (page: Page, name: string) => column(page, name).locator('[data-card] span.wrap-anywhere').allTextContents();
const moves = () => fx!.calls.filter((c) => c.path.endsWith('/move')).map((c) => [c.path.split('/')[4], c.body]);
const menu = (page: Page) => page.locator('[data-context-menu]');

async function until(cond: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(await cond());
}

test('kanban opens from the burger and from Ctrl+K', async () => {
  const page = await open({ kind: 'sessions' });
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Канбан' }).click();
  await card(page, 'Обновить брокер').waitFor();

  await homeButton(page).click();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('Канбан');
  await page.keyboard.press('Enter');
  await card(page, 'Обновить брокер').waitFor();
});

test('a card is created by hand, on the board of a project too, and survives a reload', async () => {
  const page = await open({ kind: 'kanban', board: 'alpha-service' });
  await card(page, 'Обновить брокер').waitFor();
  assert.equal(await card(page, 'Поправить форму оплаты').count(), 0, 'another project stays off this board');
  await page.getByRole('button', { name: 'Карточка', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новая карточка' });
  assert.equal(await dialog.getByRole('button', { name: 'Создать' }).isDisabled(), true);
  await dialog.getByLabel('Заголовок').fill('Новая задача');
  await dialog.getByLabel('Описание').fill('Что сделать');
  await dialog.getByRole('radio', { name: 'высокий' }).click();
  await dialog.getByRole('button', { name: 'Создать' }).click();
  await card(page, 'Новая задача').waitFor();
  const made = fx!.calls.find((c) => c.path === '/api/kanban/cards')!.body as Record<string, unknown>;
  assert.deepEqual([made.title, made.description, made.project, made.priority], ['Новая задача', 'Что сделать', 'alpha-service', 'high']);
  await page.reload();
  await card(page, 'Новая задача').waitFor();
});

test('drag and drop moves between columns and reorders', async () => {
  const page = await open({ kind: 'kanban' });
  await card(page, 'Обновить брокер').waitFor();
  await card(page, 'Обновить брокер').dragTo(column(page, 'В работе').locator('ul'), { targetPosition: { x: 40, y: 300 } });
  await until(() => moves().length === 1);
  assert.deepEqual(moves()[0], ['AS-1', { column: 'doing', before: null }]);
  assert.deepEqual(await titles(page, 'В работе'), ['Купить домен', 'Обновить брокер']);

  await card(page, 'Обновить брокер').dragTo(card(page, 'Купить домен'), { targetPosition: { x: 20, y: 2 } });
  await until(() => moves().length === 2);
  assert.deepEqual(moves()[1], ['AS-1', { column: 'doing', before: 'TASK-3' }]);
  assert.deepEqual(await titles(page, 'В работе'), ['Обновить брокер', 'Купить домен']);
  await page.reload();
  await card(page, 'Обновить брокер').waitFor();
  assert.deepEqual(await titles(page, 'В работе'), ['Обновить брокер', 'Купить домен']);
});

test('the keyboard reaches everything: moves keep focus, Enter opens, Delete asks', async () => {
  const page = await open({ kind: 'kanban' });
  const first = card(page, 'Обновить брокер');
  await first.focus();
  await page.keyboard.press('Shift+ArrowDown');
  await until(() => moves().length === 1);
  assert.deepEqual(moves()[0], ['AS-1', { column: 'todo', before: null }]);
  assert.deepEqual(await titles(page, 'В работу'), ['Поправить форму оплаты', 'Обновить брокер']);
  await page.keyboard.press('Shift+ArrowUp');
  await until(() => moves().length === 2);
  assert.deepEqual(moves()[1], ['AS-1', { column: 'todo', before: 'BW-7' }]);

  await page.keyboard.press('Shift+ArrowRight');
  await until(async () => (await titles(page, 'В работе')).includes('Обновить брокер'));
  await until(() => first.evaluate((el) => el === document.activeElement));
  assert.deepEqual(moves()[2], ['AS-1', { column: 'doing', before: null }]);
  await page.keyboard.press('Shift+ArrowLeft');
  await until(async () => (await titles(page, 'В работу')).includes('Обновить брокер'));
  await until(() => first.evaluate((el) => el === document.activeElement));

  await page.keyboard.press('Enter');
  const editing = page.getByRole('dialog', { name: 'Карточка' });
  await editing.getByLabel('Заголовок').fill('Брокер: обновить');
  await editing.getByRole('button', { name: 'Сохранить' }).click();
  await card(page, 'Брокер: обновить').waitFor();

  await card(page, 'Брокер: обновить').focus();
  await page.keyboard.press('Delete');
  const asking = page.getByRole('dialog', { name: 'Удалить карточку?' });
  await asking.getByRole('button', { name: 'Удалить' }).click();
  await until(async () => (await card(page, 'Брокер: обновить').count()) === 0);
});

test('a late answer about an earlier move does not take the keyboard off the card', async () => {
  const page = await open({ kind: 'kanban' });
  const first = card(page, 'Обновить брокер');
  await first.focus();
  await page.route('**/api/kanban', async (route) => {
    const answer = await route.fetch(); // read now, delivered late: this is what makes it stale
    await new Promise((r) => setTimeout(r, 400));
    await route.fulfill({ response: answer });
  });
  const asked = page.waitForRequest((r) => r.method() === 'GET' && r.url().endsWith('/api/kanban'));
  await page.keyboard.press('Shift+ArrowDown');
  await asked; // the answer to this is on its way and knows nothing about the next move
  await page.keyboard.press('Shift+ArrowRight');
  await until(() => moves().length === 2);
  await new Promise((r) => setTimeout(r, 1500));
  assert.ok((await titles(page, 'В работе')).includes('Обновить брокер'));
  assert.ok(await first.evaluate((el) => el === document.activeElement));
});

test('right click: a card goes to a new session of its project; the board goes to Claude', async () => {
  const page = await open({ kind: 'kanban' });
  await card(page, 'Обновить брокер').click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'В новую сессию проекта' }).click();
  await until(() => fx!.calls.some((c) => /^\/api\/tabs\/[^/]+\/send$/.test(c.path)));
  const tab = fx!.calls.find((c) => c.path === '/api/tabs' && c.method === 'POST')!.body as { project: string; title: string };
  assert.deepEqual([tab.project, tab.title], ['alpha-service', 'Обновить брокер']);
  const sent = fx!.calls.find((c) => /^\/api\/tabs\/[^/]+\/send$/.test(c.path))!.body as { text: string };
  assert.match(sent.text, /^AS-1: Обновить брокер\n\nДо конца месяца\n\nCard file: .*AS-1\.md/);
  const took = fx!.calls.find((c) => c.path.endsWith('/take'))!;
  assert.equal(took.path, '/api/kanban/cards/AS-1/take');
  assert.equal((took.body as { agent: string }).agent, 'Claude');

  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Канбан' }).click();
  await card(page, 'Купить домен').click({ button: 'right' });
  const noProject = menu(page).getByRole('menuitem', { name: 'В новую сессию проекта' });
  assert.equal(await noProject.isDisabled(), true, 'a card with no project has no session to go to');
  await page.keyboard.press('Escape');

  await page.getByRole('region', { name: 'Колонка: Готово' }).click({ button: 'right', position: { x: 60, y: 300 } });
  await menu(page).getByRole('menuitem', { name: 'Разложить через Claude' }).click();
  const ask = page.getByRole('dialog', { name: 'Разложить через Claude' });
  await ask.getByRole('button', { name: 'Разбей большие карточки на части' }).click();
  await ask.getByText(/add_kanban_card/).first().waitFor();
  const before = fx!.calls.length;
  await ask.getByRole('button', { name: 'Отправить' }).click();
  await until(() => fx!.calls.slice(before).some((c) => c.path === '/api/service/tasks' && c.method === 'POST'));
});

test('five columns; a card shows its id and the agent that took it', async () => {
  const page = await open({ kind: 'kanban' });
  await card(page, 'Обновить брокер').waitFor();
  for (const name of ['Бэклог', 'В работу', 'В работе', 'Полировка', 'Готово']) await column(page, name).waitFor();
  assert.equal(await card(page, 'Обновить брокер').locator('[data-card-id]').textContent(), 'AS-1');
  assert.equal(await card(page, 'Купить домен').locator('[data-card-agent]').textContent(), 'Ревьюер');
  assert.equal(await card(page, 'Обновить брокер').locator('[data-card-agent]').count(), 0);

  await card(page, 'Обновить брокер').click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Упомянуть в чате через @' }).waitFor();
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Карточка', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Новая карточка' });
  await dialog.getByLabel('Заголовок').fill('В бэклог');
  await dialog.getByLabel('Описание').fill('**важно**');
  await dialog.getByRole('radio', { name: 'Просмотр' }).click();
  await dialog.locator('strong').getByText('важно').waitFor();
  await dialog.getByRole('button', { name: 'Создать' }).click();
  await column(page, 'Бэклог').locator('[data-card]').filter({ hasText: 'В бэклог' }).waitFor();
});

test('sprints filter the board, a card changes sprint from its menu; grouping by project draws lanes', async () => {
  const page = await open({ kind: 'kanban' });
  await card(page, 'Обновить брокер').waitFor();
  const switcher = page.getByRole('radiogroup', { name: 'Спринт' });
  assert.equal(await switcher.count(), 0, 'no sprints, no switcher');
  const sprint = await (await page.request.post(`${fx!.url}/api/kanban/sprints`, { data: { name: 'Ноябрь' } })).json() as { id: string };
  await page.request.patch(`${fx!.url}/api/kanban/cards/AS-1`, { data: { sprint: sprint.id } });
  await page.reload();
  await switcher.getByRole('radio', { name: 'Ноябрь' }).click();
  await until(async () => (await page.locator('[data-card]').count()) === 1);
  await card(page, 'Обновить брокер').waitFor();
  await switcher.getByRole('radio', { name: 'Без спринта' }).click();
  await until(async () => (await page.locator('[data-card]').count()) === 2);
  assert.equal(await card(page, 'Обновить брокер').count(), 0);
  await card(page, 'Купить домен').click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Спринт → Ноябрь' }).click();
  await until(() => fx!.calls.some((c) => c.path === '/api/kanban/cards/TASK-3' && (c.body as { sprint?: string }).sprint === sprint.id));
  await until(async () => (await card(page, 'Купить домен').count()) === 0);
  await switcher.getByRole('radio', { name: 'Все' }).click();
  await until(async () => (await page.locator('[data-card]').count()) === 3);

  await page.getByRole('heading', { level: 1 }).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Группировать по проектам' }).click();
  const lane = (name: string) => page.getByRole('region', { name: `Проект: ${name}` });
  await lane('alpha-service').getByRole('region', { name: 'Колонка: В работу' }).locator('[data-card]').filter({ hasText: 'Обновить брокер' }).waitFor();
  await lane('beta-web').locator('[data-card]').filter({ hasText: 'Поправить форму оплаты' }).waitFor();
  await lane('Без проекта').locator('[data-card]').filter({ hasText: 'Купить домен' }).waitFor();
  assert.equal(await lane('alpha-service').locator('[data-card]').count(), 1);
  await page.getByRole('heading', { level: 1 }).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Не группировать по проектам' }).click();
  await until(async () => (await lane('alpha-service').count()) === 0);
});

test('sprints are made from the board menu, renamed and removed from the menu of their segment', async () => {
  const page = await open({ kind: 'kanban' });
  await card(page, 'Обновить брокер').waitFor();
  const switcher = page.getByRole('radiogroup', { name: 'Спринт' });
  assert.equal(await switcher.count(), 0, 'nothing on the surface until there is a sprint');

  await page.getByRole('heading', { level: 1 }).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Новый спринт' }).click();
  const create = page.getByRole('dialog', { name: 'Новый спринт' });
  await create.getByLabel('Название спринта').fill('Ноябрь');
  await create.getByRole('button', { name: 'Создать' }).click();
  await switcher.getByRole('radio', { name: 'Ноябрь' }).waitFor();
  await create.waitFor({ state: 'detached' });
  assert.deepEqual(fx!.calls.filter((c) => c.path === '/api/kanban/sprints').map((c) => [c.method, c.body]), [['POST', { name: 'Ноябрь' }]]);

  await switcher.getByRole('radio', { name: 'Ноябрь' }).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Переименовать' }).click();
  const rename = page.getByRole('dialog', { name: 'Переименовать спринт' });
  const field = rename.getByLabel('Название спринта');
  assert.equal(await field.inputValue(), 'Ноябрь');
  await field.fill('Декабрь');
  await field.press('Enter');
  await switcher.getByRole('radio', { name: 'Декабрь' }).waitFor();
  assert.equal(await switcher.getByRole('radio', { name: 'Ноябрь' }).count(), 0);

  // The segments that are not a sprint have no sprint items.
  await switcher.getByRole('radio', { name: 'Все' }).click({ button: 'right' });
  await menu(page).waitFor();
  assert.equal(await menu(page).getByRole('menuitem', { name: 'Удалить спринт' }).count(), 0);
  await page.keyboard.press('Escape');

  await switcher.getByRole('radio', { name: 'Декабрь' }).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Удалить спринт' }).click();
  const confirm = page.getByRole('dialog', { name: 'Удалить спринт «Декабрь»?' });
  await confirm.getByText('Карточки останутся на доске, без спринта.').waitFor();
  await confirm.getByRole('button', { name: 'Удалить спринт' }).click();
  await switcher.waitFor({ state: 'detached' });
  assert.ok(fx!.calls.some((c) => c.path === '/api/kanban/sprints/S1' && c.method === 'DELETE'));
  assert.equal(await page.locator('[data-card]').count(), 3, 'the cards stay');
});

test('the @ menu: the section on top, Space opens it, the search finds by id and title with the own project first, files below', async () => {
  const data = defaultFixture();
  const page = await open({ kind: 'tab', id: data.tabs.find((t) => t.project === 'beta-web')!.id }, data);
  const box = page.getByRole('textbox', { name: /beta-web/ }).first();
  await box.click();
  await box.pressSequentially('@');
  const list = page.getByRole('listbox', { name: 'Элементы и файлы' });
  const options = list.getByRole('option');
  await options.first().getByText('Задача канбана').waitFor();
  await list.getByRole('option', { name: 'src/config.ts' }).waitFor();
  assert.equal(await options.first().getAttribute('aria-selected'), 'true');

  await page.keyboard.press('Space');
  const inside = page.getByRole('listbox', { name: 'Задача канбана' });
  await inside.getByRole('option', { name: /BW-7/ }).waitFor();
  assert.match((await inside.getByRole('option').first().textContent())!, /BW-7/, 'the project of this tab comes first');
  assert.equal(await box.inputValue(), '@');

  await page.keyboard.type('брокер');
  await inside.getByRole('option', { name: /AS-1/ }).waitFor();
  await until(async () => (await inside.getByRole('option').count()) === 1);

  // Back and by id: typed right in the menu, without opening the section.
  await box.fill('');
  await box.pressSequentially('@as-');
  const found = page.getByRole('listbox', { name: 'Элементы и файлы' });
  await found.getByRole('option', { name: /AS-1/ }).click();
  assert.equal(await box.inputValue(), '@/home/test/claude-os/vault/kanban/AS-1.md (AS-1: Обновить брокер) ');

  // Backspace on the empty search goes back to the top of the menu, Enter there sends nothing.
  await box.fill('');
  await box.pressSequentially('@');
  await page.keyboard.press('Space');
  await inside.getByRole('option').first().waitFor();
  await page.keyboard.press('Backspace');
  await page.getByRole('listbox', { name: 'Элементы и файлы' }).waitFor();
  assert.equal(await box.inputValue(), '@');
  assert.equal(fx!.calls.some((c) => c.path.endsWith('/send')), false);
});

test('a planner note goes to Claude in a dialog: questions in it, it stays until done, closing while working asks first', async () => {
  const page = await open({ kind: 'sessions' });
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('menuitem', { name: /Планер|Планнер/ }).click();
  const note = page.locator('[data-planner-note]').filter({ hasText: 'Обновить брокер' });
  await note.locator('button[aria-expanded]').click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Разложить на задачи канбана' }).click();

  const dialog = page.getByRole('dialog', { name: 'Разбор на задачи с Claude' });
  await dialog.getByText('Что важнее?').waitFor();
  assert.equal(await page.getByTestId('service-task').count(), 1, 'one card, in the dialog');
  assert.equal(await page.getByRole('complementary', { name: 'Задачи служебной сессии' }).count(), 0, 'nothing floats beside it');
  assert.equal(await page.getByRole('button', { name: 'Задачи служебной сессии' }).count(), 0, 'and the title bar has no button for it');

  await page.keyboard.press('Escape');
  await dialog.getByRole('alert').getByText('Закрыть окно значит прервать').waitFor();
  await dialog.getByRole('button', { name: 'Продолжить' }).click();
  await dialog.getByRole('alert').waitFor({ state: 'detached' });

  await dialog.getByRole('textbox').fill('Важнее брокер');
  await dialog.getByRole('button', { name: 'Ответить' }).click();
  await until(() => fx!.calls.some((c) => c.path.endsWith('/answer')));
  await dialog.getByText('AS-2 Брокер').waitFor();
  await dialog.getByRole('button', { name: 'Открыть доску' }).click();
  await dialog.waitFor({ state: 'detached' });
  await card(page, 'Обновить брокер').waitFor();
});

test('interrupting: the job is stopped on the server and the dialog goes', async () => {
  const page = await open({ kind: 'sessions' });
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('menuitem', { name: /Планер|Планнер/ }).click();
  const note = page.locator('[data-planner-note]').filter({ hasText: 'Обновить брокер' });
  await note.locator('button[aria-expanded]').click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Разложить на задачи канбана' }).click();
  const dialog = page.getByRole('dialog', { name: 'Разбор на задачи с Claude' });
  await dialog.getByRole('button', { name: 'Закрыть', exact: true }).first().click();
  await dialog.getByRole('button', { name: 'Прервать и закрыть' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.ok(fx!.calls.some((c) => c.path === '/api/service/tasks/dec1/interrupt'));
});

test('a task prefix changes in the settings of a project', async () => {
  const page = await open({ kind: 'settings', section: 'projects' });
  const field = page.getByRole('textbox', { name: 'Префикс задач проекта' });
  await until(async () => (await field.inputValue()) !== '');
  const first = await field.inputValue();
  await field.fill('core');
  await page.keyboard.press('Enter');
  await until(() => fx!.calls.some((c) => c.path === '/api/kanban/prefix'));
  const body = fx!.calls.find((c) => c.path === '/api/kanban/prefix')!.body as { project: string; prefix: string };
  assert.equal(body.prefix, 'CORE');
  assert.notEqual(first, 'CORE');
  await page.getByText('CORE-21').waitFor();
});

test('agents: list with scope, model and tools, a page, right click, delete naming the file', async () => {
  const page = await open({ kind: 'tools', pane: 'agents' });
  const row = page.getByRole('button', { name: /reviewer/ }).filter({ hasText: 'Проверяет дифф' }).last();
  await row.waitFor();
  await page.getByRole('button', { name: /plotter/ }).filter({ hasText: 'viz-kit' }).last().waitFor();
  await page.getByText('Explore').waitFor();
  await page.getByText('Ещё запусков без типа в журнале: 2').waitFor();
  assert.ok((await row.textContent())!.includes('Инструментов: 2'));
  assert.ok((await row.textContent())!.includes('Opus'));

  await row.click({ button: 'right' });
  const items = await menu(page).getByRole('menuitem').allTextContents();
  for (const name of ['Открыть', 'Изменить с Claude', 'Вопрос Claude', 'Удалить']) assert.ok(items.some((i) => i.includes(name)), `${name}: ${items.join(', ')}`);
  await menu(page).getByRole('menuitem', { name: 'Открыть' }).click();
  await page.getByRole('heading', { name: 'reviewer', exact: true }).waitFor();
  await page.getByText('Инструкция reviewer').waitFor();
  await page.getByText('Проверить ретраи').waitFor();

  await page.getByRole('heading', { name: 'reviewer', exact: true }).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Удалить' }).click();
  const dialog = page.getByRole('dialog', { name: 'Удалить агента reviewer?' });
  await dialog.getByText('/home/test/.claude/agents/reviewer.md').waitFor();
  await dialog.getByText(/data\/backups/).waitFor();
  await dialog.getByRole('button', { name: 'Удалить' }).click();
  await page.getByRole('button', { name: /plotter/ }).filter({ hasText: 'viz-kit' }).last().waitFor();
  assert.deepEqual(fx!.calls.filter((c) => c.method === 'DELETE').map((c) => [c.path, c.body]), [['/api/agents/user%3Areviewer', { confirmed: true }]]);
});

test('agents: a plugin agent cannot be changed or deleted; grouping by project uses the same rows', async () => {
  const page = await open({ kind: 'tools', pane: 'agents' });
  const plugin = page.getByRole('button', { name: /plotter/ }).filter({ hasText: 'viz-kit' }).last();
  await plugin.click({ button: 'right' });
  const items = await menu(page).getByRole('menuitem').allTextContents();
  assert.ok(!items.some((i) => i.startsWith('Удалить')), items.join(', '));
  assert.ok(!items.some((i) => i.startsWith('Изменить с Claude')), items.join(', '));
  assert.ok(items.includes('Вопрос Claude'), items.join(', '));
  await page.keyboard.press('Escape');

  await page.getByRole('radio', { name: 'По проектам' }).click();
  const group = page.getByRole('region', { name: 'alpha-service' });
  await group.getByRole('button', { name: /migrator/ }).filter({ hasText: 'Переносит очереди' }).waitFor();
  assert.equal(await page.getByRole('button', { name: /reviewer/ }).filter({ hasText: 'Проверяет' }).count(), 0);
});

test('agents: creating and finding go to Claude with presets', async () => {
  const page = await open({ kind: 'tools', pane: 'agents' });
  await page.getByRole('button', { name: 'Создать агента через Claude' }).click();
  let ask = page.getByRole('dialog', { name: 'Создать агента через Claude' });
  await ask.getByRole('button', { name: 'Ревьюер кода для этого стека' }).waitFor();
  await ask.getByText(/~\/\.claude\/agents/).first().waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Найти нужных агентов' }).click();
  ask = page.getByRole('dialog', { name: 'Найти нужных агентов' });
  await ask.getByRole('button', { name: 'Какие из моих агентов не используются и почему' }).waitFor();
  await ask.getByText(/reviewer \(user\): 40 runs/).first().waitFor();
});

test('a session of claudeOS/root shows as Claude OS with a tag; levels of change are marked; other sessions stay plain', async () => {
  const data = defaultFixture();
  data.projects.push({ ...data.projects[0], key: 'claudeOS', name: 'Claude OS', root: '/home/test/claudeOS', liveCount: 0 });
  data.sessions.push(
    { ...data.sessions[1], id: 's-root', project: 'claudeOS', cwd: '/home/test/claudeOS/root', title: 'Сессия в root', rootFolder: true, osChanges: { user: 1, root: 3 } },
    { ...data.sessions[1], id: 's-core', project: 'claudeOS', cwd: '/home/test/claudeOS', title: 'Сессия в репозитории', osChanges: { user: 2, root: 0 } },
  );
  const page = await open({ kind: 'sessions' }, data);
  const row = page.getByRole('button').filter({ hasText: 'Сессия в root' });
  await row.waitFor();
  const text = (await row.textContent())!;
  assert.ok(text.includes('Claude OS'), text);
  assert.ok(text.includes('root'));
  assert.ok(text.includes('правки: user 1'));
  assert.ok(text.includes('правки: root 3'));
  const core = (await page.getByRole('button').filter({ hasText: 'Сессия в репозитории' }).textContent())!;
  assert.ok(core.includes('правки: user 2') && !core.includes('правки: root'), core);
  const plain = (await page.getByRole('button').filter({ hasText: 'Правка вёрстки формы оплаты' }).textContent())!;
  assert.ok(!plain.includes('правки'), plain);

  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'entity', type: 'project', id: 'claudeOS' })));
  await page.reload();
  const section = page.getByRole('button').filter({ hasText: 'Сессия в root' });
  await section.waitFor();
  assert.ok((await section.textContent())!.includes('правки: root 3'));
  await page.getByRole('button', { name: 'Канбан' }).click();
  await page.getByRole('heading', { name: 'Claude OS' }).waitFor();
});

test('a level of change: chosen on a card of Claude OS only, shown as a tag, taken away again', async () => {
  const data = defaultFixture();
  data.projects.push({ ...data.projects[0], key: 'claudeOS', name: 'Claude OS', root: '/home/test/claudeOS', liveCount: 0 });
  const page = await open({ kind: 'kanban', board: 'claudeOS' }, data);
  await page.getByRole('heading', { name: 'Claude OS' }).waitFor();
  await page.getByRole('button', { name: 'Карточка', exact: true }).click();
  let dialog = page.getByRole('dialog', { name: 'Новая карточка' });
  await dialog.getByLabel('Заголовок').fill('Поправить ядро');
  const level = dialog.getByRole('radiogroup', { name: 'Уровень правки' });
  await level.getByRole('radio', { name: 'root' }).click();
  await dialog.getByRole('button', { name: 'Создать' }).click();
  const made = card(page, 'Поправить ядро');
  await made.getByText('root', { exact: true }).waitFor();
  assert.equal((fx!.calls.find((c) => c.path === '/api/kanban/cards')!.body as { level: string }).level, 'root');
  assert.match((await made.getByText('root', { exact: true }).getAttribute('title'))!, /уровень ядра/i);

  // On the board of all tasks too, with the project beside it.
  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'kanban' })));
  await page.reload();
  await made.getByText('Claude OS').waitFor();
  await made.getByText('root', { exact: true }).waitFor();

  // Another project has no such choice, an old card without the field stays plain.
  assert.equal(await card(page, 'Обновить брокер').getByText(/^(user|root)$/).count(), 0);
  await card(page, 'Обновить брокер').click();
  dialog = page.getByRole('dialog', { name: 'Карточка' });
  await dialog.getByLabel('Заголовок').waitFor();
  assert.equal(await dialog.getByRole('radiogroup', { name: 'Уровень правки' }).count(), 0);
  await dialog.getByRole('button', { name: 'Отмена' }).click();

  // Taken away.
  await made.click();
  dialog = page.getByRole('dialog', { name: 'Карточка' });
  await dialog.getByRole('radio', { name: 'без уровня' }).click();
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal((fx!.calls.findLast((c) => c.method === 'PATCH')!.body as { level: unknown }).level, null);
});

test('English: the same words exist', async () => {
  const page = await open({ kind: 'kanban' }, defaultFixture(), 'en-US');
  await page.getByRole('region', { name: 'Column: In progress' }).waitFor();
  await page.getByRole('button', { name: 'Card', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Agents' }).click();
  await page.getByRole('button', { name: 'Find the agents I need' }).waitFor();
});
