// The agents panel, the planner's way to the board, the @ menu and the marks of Claude OS sessions, against e2e/fixture-server.ts.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { defaultFixture, startFixture, type Fixture, type FixtureServer } from './fixture-server.ts';

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

const card = (page: Page, title: string) => page.locator('[data-card]').filter({ hasText: title });
const menu = (page: Page) => page.locator('[data-context-menu]');

async function until(cond: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(await cond());
}

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
  await page.getByRole('button', { name: 'Kanban+' }).click(); // the board of the project, from the Kanban+ plugin
  await page.getByRole('heading', { name: 'Claude OS' }).waitFor();
});

test('English: the same words exist', async () => {
  const page = await open({ kind: 'plugin', screen: 'kanban' }, defaultFixture(), 'en-US');
  await page.getByRole('region', { name: 'Column In progress' }).waitFor();
  await page.getByRole('button', { name: 'New card', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Kanban+' }).waitFor();
  await page.getByRole('menuitem', { name: 'Tools' }).waitFor();
});

