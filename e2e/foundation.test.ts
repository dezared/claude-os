// The right-click menu, the ask dialog, history, crumbs, entity pages, tooltips and modals. Fake backend only: nothing here reaches Claude.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startFixture, type FixtureServer } from './fixture-server.ts';

let browser: Browser;
let ctx: BrowserContext | null = null;
let fx: FixtureServer | null = null;
let errors: string[] = [];

before(async () => {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});
after(async () => {
  await browser.close();
});
afterEach(async () => {
  await ctx?.close();
  await fx?.close();
  ctx = null;
  fx = null;
});

async function open(view?: object): Promise<Page> {
  errors = [];
  fx = await startFixture();
  ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU', reducedMotion: 'reduce' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  if (view) await ctx.addInitScript((v) => localStorage.setItem('claude-os.view', v), JSON.stringify(view));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  await page.getByRole('button', { name: 'Назад' }).waitFor();
  return page;
}

const menu = (page: Page) => page.getByRole('menu', { name: 'Контекстное меню' });
const sends = () => fx!.calls.filter((c) => c.path.endsWith('/send') || (c.path === '/api/service/tasks' && c.method === 'POST'));

test('context menu: right click opens at the cursor, Escape and an outside click close, right drag on the map pans without a menu', async () => {
  const page = await open();
  const heading = page.getByRole('heading', { name: 'Проекты' });
  await heading.click({ button: 'right' });
  await menu(page).waitFor();
  const box = (await heading.boundingBox())!;
  const at = (await menu(page).boundingBox())!;
  assert.ok(Math.abs(at.x - (box.x + box.width / 2)) < 2 && Math.abs(at.y - (box.y + box.height / 2)) < 2, 'it opens at the cursor');
  await page.keyboard.press('Escape');
  await menu(page).waitFor({ state: 'detached' });

  await heading.click({ button: 'right' });
  await menu(page).waitFor();
  await page.mouse.click(800, 300);
  await menu(page).waitFor({ state: 'detached' });

  // Open sky: nothing, a click or a drag. The core: the map's menu.
  await page.locator('.u-label.on').first().waitFor();
  await page.mouse.move(800, 200);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(700, 150, { steps: 3 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(100);
  assert.equal(await menu(page).count(), 0, 'a right drag is a pan');
  await page.mouse.click(800, 200, { button: 'right' });
  await page.waitForTimeout(100);
  assert.equal(await menu(page).count(), 0, 'a right click on open sky is nothing');

  // Windows sends the event on release, far from the press: the end of a drag over a panel is not a click.
  await page.evaluate(() => {
    const el = document.querySelector('[data-widget] h2')!;
    window.dispatchEvent(new PointerEvent('pointerdown', { button: 2, clientX: 800, clientY: 200 }));
    el.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true, cancelable: true, clientX: 100, clientY: 100 }));
  });
  await page.waitForTimeout(50);
  assert.equal(await menu(page).count(), 0);
  assert.deepEqual(errors, []);
});

test('context menu: keyboard and collision with the window edge', async () => {
  const page = await open();
  const label = page.getByText('Открытые тикеты');
  await label.waitFor();
  await label.evaluate((el) => el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: 1590, clientY: 990 })));
  await menu(page).waitFor();
  const at = (await menu(page).boundingBox())!;
  assert.ok(at.x + at.width <= 1590 && at.y + at.height <= 991, `flipped into the window: ${JSON.stringify(at)}`);
  assert.deepEqual(await menu(page).getByRole('menuitem').allTextContents(), ['Изменить с Claude', 'Вопрос Claude', 'Скопировать как .md', 'Свернуть виджет Открытые тикеты', 'Удалить виджет Открытые тикеты'], 'the widget items, not one set per area');

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'Изменить с Claude: Открытые тикеты' }).waitFor();
});

test('context menu: selected text gets Copy and the question, a field gets Cut, Copy and Paste', async () => {
  const page = await open();
  const field = page.getByRole('textbox', { name: /Начни новый проект/ });
  await field.fill('слово другое');
  await field.click({ button: 'right', position: { x: 12, y: 10 } });
  assert.deepEqual((await menu(page).getByRole('menuitem').allTextContents()).slice(0, 3), ['Вырезать', 'Копировать', 'Вставить']);
  await page.keyboard.press('Escape');

  await field.evaluate((e: HTMLTextAreaElement) => {
    e.focus();
    e.setSelectionRange(0, 5);
  });
  // Dispatched: where a real right click puts the caret depends on the platform.
  await page.evaluate(() => {
    const el = document.activeElement as HTMLTextAreaElement;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 12, clientY: r.top + 10 }));
  });
  await menu(page).getByRole('menuitem', { name: 'Вырезать' }).click();
  assert.equal(await field.inputValue(), ' другое', 'cut goes through the field');
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'слово');

  await field.click({ button: 'right', position: { x: 12, y: 10 } });
  await menu(page).getByRole('menuitem', { name: 'Вставить' }).click();
  await page.waitForFunction(() => (document.activeElement as HTMLTextAreaElement).value.includes('слово'));

  // Text on the page.
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.className = 'selectable';
    p.id = 'probe';
    p.textContent = 'выделенный текст';
    p.style.cssText = 'position:fixed;left:600px;top:300px;z-index:9;pointer-events:auto;user-select:text';
    document.body.append(p);
    const range = document.createRange();
    range.selectNodeContents(p);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
  });
  await page.evaluate(() => {
    const r = document.getElementById('probe')!.getBoundingClientRect();
    document.getElementById('probe')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 5, clientY: r.top + 5 }));
  });
  await menu(page).getByRole('menuitem', { name: 'Копировать' }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'выделенный текст');
  await page.evaluate(() => {
    const r = document.getElementById('probe')!.getBoundingClientRect();
    document.getElementById('probe')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 5, clientY: r.top + 5 }));
  });
  await menu(page).getByRole('menuitem', { name: 'Спросить Claude про выделенное' }).click();
  const dialog = page.getByRole('dialog', { name: 'Спросить Claude про выделенное' });
  await dialog.getByRole('textbox').fill('что это');
  await dialog.getByText(/Context:\s+выделенный текст/).waitFor();
  assert.equal(sends().length, 0, 'nothing is sent before the button');
  await dialog.getByRole('button', { name: 'Отправить' }).click();
  await dialog.waitFor({ state: 'detached' });
  const body = sends().at(-1)!.body as { prompt: string };
  assert.equal(sends().at(-1)!.path, '/api/service/tasks');
  assert.match(body.prompt, /выделенный текст/);
  assert.match(body.prompt, /Request:\nчто это/);
  assert.deepEqual(errors, []);
});

test('a right click inside a modal keeps it open, and its menu works', async () => {
  const page = await open();
  await page.locator('.u-label.on').first().waitFor();
  await page.locator('.u-label.core.on').waitFor();
  await page.mouse.click(800, 500, { button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Вопрос Claude' }).click();
  const dialog = page.getByRole('dialog', { name: /Вопрос Claude/ });
  const box = dialog.getByRole('textbox');
  await box.fill('текст');
  await box.click({ button: 'right' });
  await box.evaluate((e: HTMLTextAreaElement) => e.select());
  await page.keyboard.press('Escape');
  await dialog.waitFor();
  await box.click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Вставить' }).hover();
  await page.keyboard.press('Escape');
  await menu(page).waitFor({ state: 'detached' });
  assert.ok(await dialog.isVisible(), 'Escape closed the menu only');

  await box.click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Вставить' }).click();
  await dialog.waitFor();
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'TEXTAREA', 'the trap keeps the focus');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
});

test('ask dialog: presets fill the text, Enter sends, it goes to the service session', async () => {
  const page = await open();
  await page.locator('.u-label.on').first().waitFor();
  await page.locator('.u-label.core.on').waitFor();
  await page.mouse.click(800, 500, { button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Изменить с Claude' }).click();
  const dialog = page.getByRole('dialog', { name: /Изменить с Claude/ });
  const box = dialog.getByRole('textbox');
  assert.ok(await dialog.getByRole('button', { name: 'Отправить' }).isDisabled(), 'empty text does not send');
  await dialog.getByText(/расход|подписк|токен|тариф|plan/i).first().waitFor();
  await box.fill('сделай ярче');
  await box.press('Enter');
  await dialog.waitFor({ state: 'detached' });
  const sent = sends().at(-1)!;
  assert.equal(sent.path, '/api/service/tasks');
  assert.match((sent.body as { prompt: string }).prompt, /^Change the universe map "Космос" in Claude OS/);
  assert.equal((sent.body as { source: string }).source, 'ask', 'counted as Claude OS own load');

  await page.mouse.click(800, 500, { button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Вопрос Claude' }).click();
  const ask = page.getByRole('dialog', { name: /Вопрос Claude/ });
  await ask.getByRole('button', { name: 'Что это делает?' }).click();
  assert.equal(await ask.getByRole('textbox').inputValue(), 'Что это делает?');
  assert.equal(sends().length, 1, 'a preset only fills the text');
  await ask.getByRole('button', { name: 'Отправить' }).click();
  await ask.waitFor({ state: 'detached' });
  assert.match((sends().at(-1)!.body as { prompt: string }).prompt, /Request:\nЧто это делает\?$/);
  assert.deepEqual(errors, []);
});

test('service tasks: a titlebar button opens the panel, a card for each state, answered, retried, stopped, continued in a tab', async () => {
  const page = await open();
  assert.equal(await page.getByRole('button', { name: 'Задачи служебной сессии' }).count(), 0, 'no tasks, no button');
  const base = { project: null, answer: null, error: null, questions: null, created: 1 };
  let list: Record<string, unknown>[] = [
    { ...base, id: 'a', title: 'Вопрос про виджет', status: 'question', questions: ['Какой цвет?'] },
    { ...base, id: 'b', title: 'Готовая', status: 'done', project: 'alpha-service', answer: '**Ответ** служебной сессии' },
    { ...base, id: 'c', title: 'Сбой', status: 'failed', error: 'Не вышло' },
    { ...base, id: 'd', title: 'Идёт', status: 'running' },
  ];
  const posted: string[] = [];
  await page.route('**/api/service/tasks**', async (r) => {
    if (r.request().method() === 'GET') return r.fulfill({ json: list });
    posted.push(`${r.request().method()} ${new URL(r.request().url()).pathname}`);
    return r.fulfill({ json: { ok: true } });
  });
  await page.reload();
  const button = page.getByRole('button', { name: 'Задачи служебной сессии' });
  await button.waitFor();
  assert.equal((await button.textContent())?.trim(), '2', 'counts the running and the asking ones');
  const region = page.getByRole('complementary', { name: 'Задачи служебной сессии' });
  assert.equal(await region.count(), 0, 'tasks from before the load do not pop up');
  assert.equal(await page.getByRole('region', { name: 'Задачи служебной сессии' }).count(), 0, 'nothing floats');
  await button.click();
  await region.getByText('Какой цвет?').waitFor();
  await region.getByText('Ответ').first().waitFor();
  assert.equal(await region.locator('[data-status="done"] strong').textContent(), 'Ответ');
  assert.deepEqual(await region.locator('[data-status="running"]').getByRole('button').evaluateAll((els) => els.map((e) => e.getAttribute('aria-label'))), ['Прервать задачу'], 'a running one is stopped, not closed');
  const field = region.getByPlaceholder('Ваш ответ');
  await field.fill('Синий');
  await field.press('Enter');
  await region.getByRole('button', { name: 'Повторить' }).click();
  await region.locator('[data-status="running"]').getByRole('button', { name: 'Прервать задачу' }).click();
  await region.locator('[data-status="done"]').getByRole('button', { name: 'Закрыть карточку' }).click();
  for (let i = 0; i < 100 && posted.length < 4; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(posted, ['POST /api/service/tasks/a/answer', 'POST /api/service/tasks/c/retry', 'POST /api/service/tasks/d/interrupt', 'DELETE /api/service/tasks/b']);

  // The answer goes on in a tab of the task's project, the panel steps aside.
  await region.locator('[data-status="done"]').getByRole('button', { name: 'Продолжить во вкладке' }).click();
  await region.waitFor({ state: 'detached' });
  for (let i = 0; i < 100 && !fx!.calls.some((c) => c.path.endsWith('/send')); i++) await new Promise((r) => setTimeout(r, 50));
  const made = fx!.calls.find((c) => c.path === '/api/tabs' && c.method === 'POST')!.body as { cwd: string; title: string };
  assert.deepEqual(made, { cwd: '/home/test/alpha-service', title: 'Готовая' });
  assert.match((fx!.calls.find((c) => c.path.endsWith('/send'))!.body as { text: string }).text, /^Continue the task "Готовая"\. [\s\S]*\*\*Ответ\*\* служебной сессии$/);

  // A task started now comes up by itself.
  list = [{ ...base, id: 'e', title: 'Новая', status: 'queued' }, ...list];
  fx!.push({ t: 'invalidate', topics: ['service'] });
  await region.getByText('Новая').waitFor();
  const hide = async () => {
    await region.getByRole('button', { name: 'Скрыть панель' }).click();
    await region.waitFor({ state: 'detached' });
  };
  await hide();

  // A question comes up by itself: the task waits for the owner.
  list = [{ ...list[0], status: 'question', questions: ['Куда?'] }, ...list.slice(1)];
  fx!.push({ t: 'invalidate', topics: ['service'] });
  await region.getByText('Куда?').waitFor();
  await hide();

  // An answer only marks the button until the panel is opened. A quick start opened its tab itself: nothing to continue.
  list = [{ ...list[0], status: 'done', questions: null, answer: 'Сделано', continuable: false }, ...list.slice(1)];
  fx!.push({ t: 'invalidate', topics: ['service'] });
  const mark = button.getByRole('status', { name: 'Есть новый ответ' });
  await mark.waitFor();
  assert.equal(await region.count(), 0, 'an answer does not open the panel');
  await button.click();
  await region.getByText('Сделано').waitFor();
  assert.equal(await region.getByTestId('service-task').filter({ hasText: 'Сделано' }).getByRole('button', { name: 'Продолжить во вкладке' }).count(), 0);
  assert.equal(await region.getByTestId('service-task').filter({ hasText: 'Готовая' }).getByRole('button', { name: 'Продолжить во вкладке' }).count(), 1);
  await mark.waitFor({ state: 'detached' });
  await hide();
  list = [];
  fx!.push({ t: 'invalidate', topics: ['service'] });
  await button.waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
});

test('back and forward: buttons, Alt+arrows, mouse buttons; a closed tab leaves history', async () => {
  const page = await open();
  const back = page.getByRole('button', { name: 'Назад' });
  const forward = page.getByRole('button', { name: 'Вперёд' });
  assert.ok(await back.isDisabled());
  assert.ok(await forward.isDisabled());

  const viewNow = () => page.evaluate(() => JSON.parse(localStorage.getItem('claude-os.view') ?? 'null'));
  await page.getByRole('button', { name: 'Сессии', exact: true }).click();
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('menuitem', { name: 'Инструменты' }).click();
  await page.getByRole('heading', { name: 'Инструменты' }).waitFor();
  await page.getByRole('button', { name: 'Хуки' }).click();

  await back.click();
  assert.deepEqual(await viewNow(), { kind: 'tools' });
  await page.keyboard.press('Alt+ArrowLeft');
  assert.deepEqual(await viewNow(), { kind: 'sessions' });
  await forward.click();
  assert.deepEqual(await viewNow(), { kind: 'tools' });
  await page.keyboard.press('Alt+ArrowRight');
  assert.deepEqual(await viewNow(), { kind: 'tools', pane: 'hooks' });
  assert.ok(await forward.isDisabled());

  const mouse = (button: number) => page.evaluate((b) => {
    document.body.dispatchEvent(new MouseEvent('mousedown', { button: b, bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new MouseEvent('mouseup', { button: b, bubbles: true, cancelable: true }));
  }, button);
  await mouse(3);
  assert.deepEqual(await viewNow(), { kind: 'tools' });
  await mouse(4);
  assert.deepEqual(await viewNow(), { kind: 'tools', pane: 'hooks' });

  // A new step cuts off what was ahead.
  await back.click();
  await page.getByRole('button', { name: 'MCP-серверы' }).click();
  assert.ok(await forward.isDisabled());

  const tab = page.getByRole('tab', { name: /alpha|beta|session|Сессия/ }).first();
  if (await tab.count()) {
    const was = await tab.getAttribute('title');
    await tab.click();
    const inTab = await viewNow();
    assert.equal(inTab.kind, 'tab');
    await page.getByRole('button', { name: `Закрыть вкладку ${was!.split(' · ')[0]}` }).click({ force: true });
    await page.waitForFunction((id) => JSON.parse(localStorage.getItem('claude-os.view')!).id !== id, inTab.id);
    for (let i = 0; i < 10 && !(await back.isDisabled()); i++) {
      await back.click();
      assert.notDeepEqual(await viewNow(), inTab, 'the closed tab is gone from history');
    }
  }
  assert.deepEqual(errors, []);
});

test('entity page: skeleton, crumbs lead back, its menu carries the subject; Tools and Settings have crumbs', async () => {
  const page = await open({ kind: 'entity', type: 'skill', id: 'review-pr', project: 'alpha-service' });
  await page.getByRole('heading', { name: 'review-pr' }).waitFor();
  const crumbs = page.getByRole('navigation', { name: 'Путь' });
  assert.deepEqual(await crumbs.locator('button, span').allTextContents(), ['Главная', 'Инструменты', 'Скиллы', 'review-pr']);
  await page.getByText('alpha-service').first().waitFor();

  // Groups stack from the inside out: the selected text above the entity, with a line between them.
  await page.getByRole('heading', { name: 'review-pr' }).evaluate((h) => {
    h.classList.add('selectable');
    const range = document.createRange();
    range.selectNodeContents(h.lastChild!);
    getSelection()!.removeAllRanges();
    getSelection()!.addRange(range);
    const r = range.getBoundingClientRect();
    h.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 3, clientY: r.top + 3 }));
  });
  assert.deepEqual(await menu(page).getByRole('menuitem').allTextContents(), ['Копировать', 'Спросить Claude про выделенное', 'Изменить с Claude', 'Вопрос Claude']);
  assert.equal(await menu(page).getByRole('separator').count(), 1);
  await page.keyboard.press('Escape');
  await page.evaluate(() => getSelection()!.removeAllRanges());

  await page.getByRole('heading', { name: 'review-pr' }).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Вопрос Claude' }).click();
  const dialog = page.getByRole('dialog', { name: 'Вопрос Claude: review-pr' });
  await dialog.getByRole('radio', { name: /новой вкладке|Новая вкладка/ }).waitFor();
  await dialog.getByRole('button', { name: 'Отмена' }).click();

  await crumbs.getByRole('button', { name: 'Скиллы' }).click();
  const tools = page.getByRole('navigation', { name: 'Путь' });
  await tools.getByText('Скиллы').waitFor();
  assert.deepEqual(await tools.locator('button, span').allTextContents(), ['Главная', 'Инструменты', 'Скиллы']);
  await page.getByRole('button', { name: 'Хуки' }).click();
  assert.deepEqual(await tools.locator('button, span').allTextContents(), ['Главная', 'Инструменты', 'Хуки']);

  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('menuitem', { name: 'Настройки' }).click();
  await page.getByRole('heading', { name: 'Настройки' }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: 'Путь' }).locator('button').count(), 2);
  await page.getByRole('navigation', { name: 'Путь' }).getByRole('button', { name: 'Главная' }).click();
  await page.locator('aside').getByText('alpha-service', { exact: true }).first().waitFor();
  assert.deepEqual(errors, []);
});

test('tooltips flip below when they would run over the title bar; the title attribute stays', async () => {
  const page = await open();
  await page.evaluate(() => {
    const b = document.createElement('button');
    b.id = 'near-top';
    b.textContent = 'x';
    b.title = 'Длинная подсказка '.repeat(12);
    b.style.cssText = 'position:fixed;left:600px;top:60px;width:30px;height:20px;z-index:9;pointer-events:auto';
    document.body.append(b);
    const low = b.cloneNode(true) as HTMLElement;
    low.id = 'in-middle';
    low.title = 'Подсказка';
    low.style.top = '500px';
    document.body.append(low);
  });
  await page.locator('#near-top').hover();
  const tip = page.getByRole('tooltip');
  await tip.waitFor();
  const box = (await tip.boundingBox())!;
  assert.ok(box.y >= 80, `the tip is under the element, at ${box.y}`);
  await page.mouse.move(800, 300);
  await tip.waitFor({ state: 'detached' });
  assert.ok(await page.locator('#near-top').getAttribute('title'), 'the attribute comes back');

  await page.locator('#in-middle').hover();
  await tip.waitFor();
  const mid = (await tip.boundingBox())!;
  assert.ok(mid.y + mid.height <= 500, 'with room it stays above');
});

test('modals: above every control and any popover left open, and the title bar stops dragging under them', async () => {
  const page = await open({ kind: 'tools', pane: 'skills' });
  await page.getByRole('heading', { name: 'Инструменты' }).waitFor();
  await page.evaluate(() => {
    // A popover opened before the modal and still open: the layer popovers really use.
    const el = document.createElement('div');
    el.id = 'left-open';
    el.className = 'popover fixed z-50';
    el.style.cssText = 'left:0;top:0;width:200px;height:60px';
    document.body.append(el);
  });
  await page.keyboard.press('Control+k');
  await page.getByRole('dialog').waitFor();
  const dialog = page.getByRole('dialog');
  const over = await page.evaluate(() => {
    const overlay = document.querySelector('[data-state="open"].fixed.inset-0')!;
    const dlg = document.querySelector('[role="dialog"]')!;
    const covered = (el: Element) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || dlg.contains(el)) return true;
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !top || top === overlay || dlg.contains(top);
    };
    return [...document.querySelectorAll('nav button, nav [role="tab"], .sheet button, #left-open')].filter((e) => !covered(e)).map((e) => e.outerHTML.slice(0, 80));
  });
  assert.deepEqual(over, [], 'nothing stays over the modal');
  assert.equal(await page.evaluate(() => (getComputedStyle(document.querySelector('[data-state="open"].fixed.inset-0')!) as unknown as { appRegion: string }).appRegion), 'no-drag');
  await dialog.waitFor();
});
