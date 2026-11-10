// Home: the core, the widgets by description and the project menu. Fake backend only: nothing here reaches Claude.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { fixtureSettings } from './fixture-features.ts';
import { defaultFixture, startFixture, type Fixture, type FixtureServer } from './fixture-server.ts';

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

const CORE = 'eta-infra';

async function open(data: Fixture = defaultFixture(), locale = 'ru-RU'): Promise<Page> {
  errors = [];
  fixtureSettings.home = { slots: {}, hidden: [] };
  fx = await startFixture(data);
  ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale, reducedMotion: 'reduce' });
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  await page.locator('aside').getByText('alpha-service', { exact: true }).first().waitFor();
  return page;
}

test('WASD and arrows move the camera, the map draws no focus frame, a text field keeps its keys', async () => {
  const page = await open();
  const core = page.locator('.u-label.core.on');
  await core.waitFor();
  const pose = () => core.evaluate((e) => (e as HTMLElement).style.transform);
  const canvas = page.locator('canvas[data-universe]');
  await canvas.focus();
  for (const code of ['KeyW', 'ArrowLeft']) {
    const was = await pose();
    await page.keyboard.down(code);
    await page.waitForFunction((v) => (document.querySelector('.u-label.core') as HTMLElement).style.transform !== v, was);
    await page.keyboard.up(code);
  }
  assert.equal(await canvas.evaluate((e) => getComputedStyle(e).outlineStyle), 'none');

  const box = page.getByRole('textbox', { name: /Начни новый проект/ });
  await box.focus();
  const was = await pose();
  await page.keyboard.press('w');
  await page.waitForTimeout(200);
  assert.equal(await pose(), was);
  assert.equal(await box.inputValue(), 'w');
});

const contextMenu = (page: Page) => page.locator('[data-context-menu]');

const menuFor = async (page: Page, name: string) => {
  await page.locator('aside').getByText(name, { exact: true }).first().click({ button: 'right' });
  await contextMenu(page).waitFor();
  return contextMenu(page);
};

const widget = (page: Page, name: string) => page.getByRole('group', { name, exact: true });

test('no fixed widget panel: placed blocks show, an entry without a place stays off the screen', async () => {
  const page = await open();
  assert.equal(await page.getByText('Заметки памяти').count(), 0);
  await widget(page, 'Открытые тикеты').getByText('12').waitFor();
  await widget(page, 'Новая команда').waitFor();
  assert.equal(await page.getByText('Старый без места').count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Добавить виджет' }).count(), 0);
  assert.equal(await page.locator('.home-foot-right').count(), 0);
  assert.deepEqual(errors, []);
});

const startCreate = async (page: Page) => {
  await page.mouse.click(800, 500, { button: 'right' });
  await contextMenu(page).getByRole('menuitem', { name: 'Создать виджет' }).click();
  await page.locator('[data-widget-placer]').waitFor();
};

test('create a widget: the slots light up, a click chooses one, a block appears, its content only goes through Claude', async () => {
  const page = await open();
  await page.locator('.u-label.core.on').waitFor();
  await startCreate(page);
  await page.locator('[data-widget-placer]').getByText(/Щёлкните по слоту/).waitFor();
  assert.equal(await page.locator('[data-zone]').count(), 5);
  await page.mouse.move(800, 200);
  await page.locator('[data-zone="top"].is-target').waitFor();
  await page.mouse.move(1500, 300);
  await page.locator('[data-zone="right"].is-target').waitFor();
  await page.mouse.down();
  await page.mouse.up();
  await page.locator('[data-widget-placer]').waitFor({ state: 'detached' });
  const made = fx!.calls.find((c) => c.method === 'POST' && c.path === '/api/widgets');
  assert.deepEqual(made?.body, { title: 'Новый виджет', type: 'block', slot: 'right' });

  const task = page.getByRole('dialog', { name: 'Что показать в виджете' });
  await task.waitFor();
  assert.equal(await task.getByRole('textbox').count(), 1, 'one description, no fields to set by hand');
  assert.equal(await page.getByRole('dialog', { name: 'Новый виджет' }).count(), 0);
  await task.getByRole('button', { name: 'Отмена' }).click();
  await task.waitFor({ state: 'detached' });

  const block = widget(page, 'Новый виджет');
  assert.equal(await block.evaluate((e) => e.closest('[data-slot]')?.getAttribute('data-slot')), 'right');
  // Dropped without a description: the block itself asks again.
  await block.getByRole('button', { name: 'Опишите, что хотите здесь видеть' }).click();
  await task.getByRole('textbox').fill('погода');
  await task.getByRole('button', { name: 'Отправить' }).click();
  await task.waitFor({ state: 'detached' });
  assert.equal(fx!.calls.filter((c) => c.path === '/api/service/tasks' && c.method === 'POST').length, 1);
  assert.deepEqual(errors, []);
});

test('create a widget: Escape and the right button cancel, Enter takes the right slot', async () => {
  const page = await open();
  await page.locator('.u-label.core.on').waitFor();
  await startCreate(page);
  await page.keyboard.press('Escape');
  await page.locator('[data-widget-placer]').waitFor({ state: 'detached' });
  await startCreate(page);
  await page.mouse.click(300, 300, { button: 'right' });
  await page.locator('[data-widget-placer]').waitFor({ state: 'detached' });
  assert.equal(await contextMenu(page).count(), 0);
  assert.equal(fx!.calls.filter((c) => c.path === '/api/widgets').length, 0);

  await startCreate(page);
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'Что показать в виджете' }).waitFor();
  const made = fx!.calls.find((c) => c.method === 'POST' && c.path === '/api/widgets');
  assert.equal((made?.body as { slot: unknown }).slot, 'right');
});

test('a widget is offered on the core only: open sky and a badge have no menu, a badge\'s project is in its popover', async () => {
  const page = await open();
  // Whichever stands in the open: a project's place may lie under a panel.
  const badge = page.locator('.u-label.on[data-project]:not(.core)').first();
  await badge.waitFor();
  await badge.click({ button: 'right' });
  await page.mouse.click(800, 200, { button: 'right' });
  await page.waitForTimeout(150);
  assert.equal(await contextMenu(page).count(), 0);
  await badge.hover();
  await page.locator('[data-project-popover]').getByRole('heading').click({ button: 'right' });
  await contextMenu(page).getByRole('menuitem', { name: 'Убрать из памяти Claude' }).waitFor();
  assert.equal(await contextMenu(page).getByRole('menuitem', { name: 'Создать виджет' }).count(), 0);
});

const slotOf = (el: ReturnType<Page['locator']>) => el.evaluate((e) => e.closest('[data-slot]')?.getAttribute('data-slot') ?? null);
const homePuts = () => fx!.calls.filter((c) => c.method === 'PUT' && c.path === '/api/settings/home');
const placePuts = (id: string) => fx!.calls.filter((c) => c.method === 'PUT' && c.path === `/api/widgets/${id}/place`);
const middle = async (el: ReturnType<Page['locator']>) => {
  const b = (await el.boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** Press, hold until the widget lifts, travel. The button stays down. */
const holdAndCarry = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.locator('.widget-ghost').waitFor();
  await page.mouse.move(to.x, to.y, { steps: 6 });
};
const empty = (data = defaultFixture()) => {
  data.widgets.defs = [];
  return data;
};

test('the default layout: four widgets, projects left, tokens right, stats bottom left, notes on top, the same as user blocks', async () => {
  const page = await open(empty());
  const projects = widget(page, 'Проекты');
  const tokens = widget(page, 'Токены');
  const stats = widget(page, 'Статистика Claude Code');
  await projects.waitFor();
  assert.deepEqual([await slotOf(projects), await slotOf(tokens), await slotOf(stats), await slotOf(widget(page, 'Заметки'))], ['left', 'right', 'bottom-left', 'top']);
  const size = page.viewportSize()!;
  const [p, k, s] = [(await projects.boundingBox())!, (await tokens.boundingBox())!, (await stats.boundingBox())!];
  assert.equal(p.x, 10);
  assert.equal(k.x + k.width, size.width - 10);
  assert.equal(s.x, 10);
  assert.ok(s.y + s.height >= size.height - 11, 'at the bottom of the window');
  assert.deepEqual([p.width, k.width, s.width], [286, 286, 286]);
  assert.equal(await page.locator('[data-zone]').count(), 0, 'slots show only while something looks for a place');
  assert.equal(homePuts().length, 0, 'looking writes nothing');
  assert.deepEqual(errors, []);
});

test('press and hold: a panel snaps into the slot it is dropped on, the slots light up on the way, the map stays, the place survives a reload', async () => {
  const page = await open(empty());
  const core = page.locator('.u-label.core.on');
  await core.waitFor();
  const tokens = widget(page, 'Токены');
  await tokens.waitFor();
  const pose = await core.evaluate((e) => (e as HTMLElement).style.transform);

  // The middle of the panel: no title to pull, so the hold is what lifts it.
  await holdAndCarry(page, await middle(tokens), { x: 1000, y: 880 });
  assert.equal(await page.locator('[data-zone]').count(), 5, 'every slot is shown');
  await page.locator('[data-zone="bottom-right"]').getByText('Снизу справа').waitFor();
  await page.mouse.move(60, 60, { steps: 4 });
  await page.locator('[data-zone="left"].is-target').waitFor();
  assert.equal(await page.locator('.is-target').count(), 1);
  assert.equal(await core.evaluate((e) => (e as HTMLElement).style.transform), pose, 'the map did not pan');
  // Nothing is stored until the hand lets go, and the widget has not left yet.
  assert.equal(homePuts().length, 0);
  assert.equal(await slotOf(tokens), 'right');

  // Somewhere in the open: still a slot, the nearest one.
  await page.mouse.move(1400, 900, { steps: 4 });
  await page.locator('[data-zone="bottom-right"].is-target').waitFor();
  await page.mouse.up();
  await page.locator('[data-zone]').first().waitFor({ state: 'detached' });
  assert.equal(await page.locator('.widget-ghost').count(), 0);
  assert.equal(await slotOf(tokens), 'bottom-right');
  assert.equal(homePuts().length, 1, 'one write at the end of a drag');
  assert.deepEqual((homePuts()[0].body as { slots: Record<string, string[]> }).slots['bottom-right'], ['tokens']);
  const size = page.viewportSize()!;
  let at = (await tokens.boundingBox())!;
  assert.equal(at.x + at.width, size.width - 10, 'the width is the slot width');
  assert.equal(at.width, 286);
  assert.equal(at.y + at.height, size.height - 10);
  assert.equal(await core.evaluate((e) => (e as HTMLElement).style.transform), pose);

  await page.reload();
  await tokens.waitFor();
  assert.equal(await slotOf(tokens), 'bottom-right');
  at = (await tokens.boundingBox())!;
  assert.equal(at.x + at.width, size.width - 10);
  assert.deepEqual(errors, []);
});

test('a short click stays a click, a slip of the hand stays a scroll, Escape puts the widget back', async () => {
  const page = await open(empty());
  const tokens = widget(page, 'Токены');
  await tokens.waitFor();
  const from = await middle(tokens);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x, from.y + 40, { steps: 2 });
  await page.waitForTimeout(400);
  assert.equal(await page.locator('.widget-ghost').count(), 0, 'moved before the hold: not a drag');
  await page.mouse.up();

  await holdAndCarry(page, from, { x: 60, y: 300 });
  await page.keyboard.press('Escape');
  await page.locator('.widget-ghost').waitFor({ state: 'detached' });
  await page.mouse.up();
  assert.equal(await slotOf(tokens), 'right');
  assert.equal(homePuts().length, 0);

  await page.locator('aside').getByText('gamma-tools', { exact: true }).first().click();
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.widget-ghost').count(), 0);
  assert.ok(fx!.calls.some((c) => c.path === '/api/tabs' && c.method === 'POST'), 'the row opened its project');
});

test('holding a project row and dropping it elsewhere moves the panel and does not open the project', async () => {
  const page = await open(empty());
  const row = page.locator('aside').getByText('gamma-tools', { exact: true }).first();
  await row.waitFor();
  await holdAndCarry(page, await middle(row), { x: 1500, y: 950 });
  await page.mouse.up();
  await page.waitForTimeout(100);
  assert.equal(await slotOf(widget(page, 'Проекты')), 'bottom-right');
  assert.equal(fx!.calls.filter((c) => c.path === '/api/tabs' && c.method === 'POST').length, 0);
});

test('a slot stacks what lands in it, in the order dropped; the column gives up height, then scrolls', async () => {
  const data = defaultFixture();
  data.widgets.defs = [
    { id: 'b1', title: 'Один', type: 'block', content: 'первый', approved: true, slot: 'right', height: 300 },
    { id: 'b2', title: 'Два', type: 'block', content: 'второй', approved: true, slot: 'bottom-right', height: 200 },
  ];
  const page = await open(data);
  const one = widget(page, 'Один');
  const two = widget(page, 'Два');
  const tokens = widget(page, 'Токены');
  await two.waitFor();
  assert.equal(await slotOf(one), 'right');
  const stack = page.locator('[data-slot="right"]');
  assert.deepEqual(await stack.locator('[data-widget]').evaluateAll((l) => l.map((e) => e.getAttribute('data-widget'))), ['tokens', 'b1']);

  // Pulled by the title it goes at once, and lands by the height of the drop: above the block already there.
  const grip = (await two.locator('[data-widget-grip]').boundingBox())!;
  const oneAt = (await one.boundingBox())!;
  await page.mouse.move(grip.x + 30, grip.y + 8);
  await page.mouse.down();
  await page.mouse.move(oneAt.x + 40, oneAt.y + 10, { steps: 5 });
  await page.locator('[data-zone="right"].is-target').waitFor();
  await page.mouse.up();
  await page.locator('[data-zone]').first().waitFor({ state: 'detached' });
  assert.deepEqual(await stack.locator('[data-widget]').evaluateAll((l) => l.map((e) => e.getAttribute('data-widget'))), ['tokens', 'b2', 'b1']);
  assert.deepEqual(placePuts('b2')[0].body, { slot: 'right' }, 'the entry learns its slot');
  assert.equal(placePuts('b1').length, 0, 'the neighbour is not rewritten');

  const box = (await two.boundingBox())!;
  assert.equal(box.height, 200, 'the height stays');
  assert.equal(box.width, (await tokens.boundingBox())!.width, 'the width is the slot width');
  const column = page.locator('[data-col="right"]');
  // Too tall for the window even when the fluid panel has given up what it can.
  await page.evaluate(() => fetch('/api/widgets/b1/place', { method: 'PUT', body: JSON.stringify({ slot: 'right', height: 900 }), headers: { 'content-type': 'application/json' } }));
  await page.reload();
  await two.waitFor();
  const scroll = await column.evaluate((e) => ({ inner: e.scrollHeight, outer: e.clientHeight }));
  assert.ok(scroll.inner > scroll.outer, 'too tall for the column');
  assert.ok(scroll.outer <= 1000, 'and the column did not grow past the window');
  // Over a block with nothing of its own to scroll: a fluid panel would scroll its own list first.
  const m = await middle(two);
  await page.mouse.move(m.x, m.y);
  await page.mouse.wheel(0, 300);
  await page.waitForFunction(() => document.querySelector('[data-col="right"]')!.scrollTop > 0);

  await page.reload();
  await two.waitFor();
  assert.deepEqual(await stack.locator('[data-widget]').evaluateAll((l) => l.map((e) => e.getAttribute('data-widget'))), ['tokens', 'b2', 'b1']);
  assert.deepEqual(errors, []);
});

test('a block keeps the height set by the corner, the slot keeps the width', async () => {
  const data = empty();
  data.widgets.defs = [{ id: 'b1', title: 'Один', type: 'block', content: 'первый', approved: true, slot: 'right' }];
  const page = await open(data);
  const block = widget(page, 'Один');
  await block.waitFor();
  const before = (await block.boundingBox())!;
  const handle = (await block.locator('[data-widget-resize]').boundingBox())!;
  await page.mouse.move(handle.x + 8, handle.y + 8);
  await page.mouse.down();
  await page.mouse.move(handle.x + 108, handle.y + 108, { steps: 4 });
  await page.mouse.up();
  assert.equal(placePuts('b1').length, 1, 'one save at the end of a drag');
  const body = placePuts('b1')[0].body as { slot: string; height: number };
  assert.equal(body.slot, 'right');
  assert.equal(body.height, Math.round(before.height + 100));
  assert.equal(await page.locator('.widget-ghost').count(), 0, 'the corner is not a move');
  const after = (await block.boundingBox())!;
  assert.equal(after.height, body.height);
  assert.equal(after.width, before.width);
  await page.reload();
  await block.waitFor();
  assert.equal((await block.boundingBox())!.height, body.height);
});

test('the keyboard moves a widget between slots and through a stack, and the height of a block', async () => {
  const data = empty();
  data.widgets.defs = [{ id: 'b1', title: 'Один', type: 'block', content: 'первый', approved: true, slot: 'bottom-right', height: 120 }];
  const page = await open(data);
  const block = widget(page, 'Один');
  await block.waitFor();
  await block.focus();
  await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.querySelector('[data-slot="bottom-left"] [data-widget="b1"]'));
  assert.equal(await block.evaluate((e) => e === document.activeElement), true, 'the focus moved with it');
  assert.deepEqual(placePuts('b1')[0].body, { slot: 'bottom-left' });
  await page.getByRole('status').getByText('Один: Снизу слева').waitFor({ state: 'attached' });
  // Under the stats now: up goes above them, up again leaves the slot.
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-slot="bottom-left"] [data-widget]')].map((e) => e.getAttribute('data-widget')).join() === 'b1,stats');
  await page.keyboard.press('ArrowUp');
  await page.waitForFunction(() => document.querySelector('[data-slot="left"] [data-widget="b1"]'));
  assert.equal(await block.evaluate((e) => e === document.activeElement), true);

  await page.keyboard.press('Shift+ArrowDown');
  assert.deepEqual(placePuts('b1').at(-1)!.body, { slot: 'left', height: 136 });
  assert.equal((await block.boundingBox())!.height, 136);

  // A built-in goes the same way, with no height of its own.
  const stats = widget(page, 'Статистика Claude Code');
  await stats.focus();
  await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('[data-slot="bottom-right"] [data-widget="stats"]'));
  assert.equal(placePuts('stats').length, 0, 'a panel has no entry in the widgets file');
  await page.keyboard.press('Shift+ArrowDown');
  assert.equal(placePuts('stats').length, 0);

  await page.reload();
  await block.waitFor();
  assert.equal(await slotOf(block), 'left');
  assert.equal(await slotOf(stats), 'bottom-right');

  // Focus left by a mouse click is not a request to move: the arrows stay with the camera.
  await block.getByText('первый').click();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(100);
  assert.equal(await slotOf(block), 'left');
});

test('built-ins go to the trash and come back like any other widget, from the map too', async () => {
  const page = await open(empty());
  const tokens = widget(page, 'Токены');
  await tokens.getByRole('heading', { name: 'Токены' }).click({ button: 'right' });
  const menu = contextMenu(page);
  const items = await menu.getByRole('menuitem').allTextContents();
  assert.deepEqual(items, ['Изменить с Claude', 'Вопрос Claude', 'Свернуть виджет Токены', 'Удалить виджет Токены']);
  await menu.getByRole('menuitem', { name: 'Удалить виджет Токены' }).click();
  await tokens.waitFor({ state: 'detached' });
  assert.deepEqual((homePuts().at(-1)!.body as { hidden: string[] }).hidden, ['tokens']);

  await page.reload();
  await widget(page, 'Проекты').waitFor();
  assert.equal(await tokens.count(), 0, 'stays in the trash after a reload');

  await page.locator('.u-label.core.on').waitFor();
  await page.mouse.click(800, 500, { button: 'right' });
  await menu.getByRole('menuitem', { name: 'Вернуть виджет Токены' }).click();
  await tokens.waitFor();
  assert.equal(await slotOf(tokens), 'right', 'back in its own place');
  assert.deepEqual((homePuts().at(-1)!.body as { hidden: string[] }).hidden, []);
  assert.deepEqual(errors, []);
});

test('an old box goes to the nearest slot on read and stays in the file until the block is moved', async () => {
  const data = empty();
  data.widgets.defs = [
    { id: 'old1', title: 'Старый', type: 'block', content: '10', approved: true, box: { x: 1400, y: 800, w: 200, h: 140 } },
    { id: 'old2', title: 'Старый верх', type: 'block', content: '11', approved: true, box: { x: 700, y: 100, w: 300, h: 120 } },
  ];
  const page = await open(data);
  const low = widget(page, 'Старый');
  const high = widget(page, 'Старый верх');
  await low.waitFor();
  assert.equal(await slotOf(low), 'bottom-right');
  assert.equal(await slotOf(high), 'top');
  const at = (await low.boundingBox())!;
  assert.deepEqual([at.width, at.height], [286, 140], 'the height it had, the width of the slot');
  await page.waitForTimeout(150);
  assert.equal(fx!.calls.filter((c) => c.method === 'PUT').length, 0, 'reading rewrites nothing');

  const grip = (await high.locator('[data-widget-grip]').boundingBox())!;
  await page.mouse.move(grip.x + 30, grip.y + 8);
  await page.mouse.down();
  await page.mouse.move(60, 500, { steps: 4 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-slot="left"] [data-widget="old2"]'));
  assert.deepEqual(placePuts('old2')[0].body, { slot: 'left' });
  assert.equal(placePuts('old1').length, 0, 'the other old entry is not touched');
  assert.equal(data.widgets.defs.find((d) => d.id === 'old2')!.box, undefined);
  assert.equal(data.widgets.defs.find((d) => d.id === 'old2')!.height, 120);
  assert.ok(data.widgets.defs.find((d) => d.id === 'old1')!.box);
  assert.equal(await slotOf(low), 'bottom-right');
});

test('a command block waits for approval; changed by description with its own context; goes to the trash from the menu', async () => {
  const page = await open();
  const pending = widget(page, 'Новая команда');
  await pending.getByRole('button', { name: 'ждёт одобрения' }).click();
  const approve = page.getByRole('dialog', { name: 'Команда ждёт одобрения' });
  await approve.getByText('curl -s https://example.test/x').waitFor();
  await approve.getByRole('button', { name: 'Одобрить и запускать' }).click();
  await approve.waitFor({ state: 'detached' });
  assert.ok(fx!.calls.some((c) => c.path === '/api/widgets/w2/approve'));

  const label = page.getByText('Открытые тикеты');
  assert.equal(await page.getByRole('button', { name: 'Удалить виджет Открытые тикеты' }).count(), 0, 'no hover button');
  await label.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Изменить с Claude' }).click();
  const task = page.getByRole('dialog', { name: 'Изменить с Claude: Открытые тикеты' });
  await task.getByText(/tickets --count/).waitFor();
  await task.getByRole('button', { name: 'Отмена' }).click();
  await label.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Удалить виджет Открытые тикеты' }).click();
  await label.waitFor({ state: 'detached' });
  assert.ok(!fx!.calls.some((c) => c.method === 'DELETE'), 'the trash deletes nothing');
  assert.ok((homePuts().at(-1)!.body as { hidden: string[] }).hidden.includes('w1'));
});

test('a widget has its icon and description, is developed with Claude in Claude OS, goes out as .md and comes back from it', async () => {
  const data = defaultFixture();
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#e4e4e7"><path d="M2 6h20v12H2z"/></svg>';
  Object.assign(data.widgets.defs[0], { icon: 'ticket', iconSvg: svg, description: 'Открытые тикеты из **трекера**', action: { label: 'Разобрать', cwd: '/home/test/alpha-service', prompt: 'разбери тикеты' } });
  data.widgets.defs[1].icon = 'no-such-icon';
  const page = await open(data);
  const tickets = widget(page, 'Открытые тикеты');
  await tickets.locator('.widget-desc strong').getByText('трекера').waitFor();
  assert.equal(await tickets.locator('span[data-widget-icon]').count(), 1, 'the library icon, drawn by the server');
  assert.equal(await widget(page, 'Новая команда').locator('svg[data-widget-icon]').count(), 1, 'an unknown name gets the stand-in');
  const projects = widget(page, 'Проекты');
  assert.equal(await projects.locator('.widget-desc').count(), 0, 'a built-in keeps its body clean');
  assert.match((await projects.locator('[data-widget-grip]').getAttribute('title'))!, /Проекты с сессиями Claude Code/, 'its description is the tooltip of its title');

  // The arrow is the state: always on screen. The develop button waits for the hand.
  await page.mouse.move(800, 120);
  const toggle = tickets.getByRole('button', { name: 'Свернуть виджет Открытые тикеты' });
  const dev = tickets.getByRole('button', { name: 'Разработать с Claude' });
  assert.equal(await toggle.evaluate((e) => getComputedStyle(e).opacity), '1');
  assert.equal(await dev.evaluate((e) => getComputedStyle(e).opacity), '0');

  await page.getByText('Открытые тикеты', { exact: true }).click({ button: 'right' });
  await contextMenu(page).getByRole('menuitem', { name: 'Скопировать как .md' }).click();
  await page.getByText(/пути этого ПК/).waitFor();
  const md = await page.evaluate(() => navigator.clipboard.readText());
  for (const line of ['title: "Открытые тикеты"', 'icon: ticket', 'type: command', 'intervalSec: 300', 'slot: bottom-right', 'Открытые тикеты из **трекера**', '## Command', 'tickets --count', '## Action', '"prompt": "разбери тикеты"']) {
    assert.ok(md.includes(line), `${line} in\n${md}`);
  }

  await toggle.click();
  await tickets.and(page.locator('.is-collapsed')).waitFor();
  assert.match((await tickets.locator('[data-widget-grip]').getAttribute('title'))!, /трекера/, 'folded: the description is the tooltip');

  await page.locator('.u-label.core.on').waitFor();
  await page.mouse.click(800, 500, { button: 'right' });
  await contextMenu(page).getByRole('menuitem', { name: 'Создать из .md' }).click();
  const task = page.getByRole('dialog', { name: 'Создать виджет' });
  await task.getByRole('textbox').fill(md);
  await task.getByText(/Add a widget: ---/).waitFor();
  await task.getByRole('button', { name: 'Отправить' }).click();
  await task.waitFor({ state: 'detached' });
  const created = fx!.calls.filter((c) => c.path === '/api/service/tasks' && c.method === 'POST').at(-1)!;
  assert.ok((created.body as { prompt: string }).prompt.includes('tickets --count'));
  assert.equal(fx!.calls.filter((c) => c.method === 'POST' && c.path === '/api/widgets').length, 0, 'the code goes through Claude and the approval, never straight in');

  await tickets.hover();
  await page.waitForFunction((e) => getComputedStyle(e!).opacity === '1', await dev.elementHandle(), { timeout: 5000 });
  await dev.click();
  const isSend = (c: { method: string; path: string }) => c.method === 'POST' && /^\/api\/tabs\/[^/]+\/send$/.test(c.path);
  for (let i = 0; i < 100 && !fx!.calls.some(isSend); i++) await page.waitForTimeout(50);
  const made = fx!.calls.find((c) => c.method === 'POST' && c.path === '/api/tabs')!;
  assert.equal((made.body as { cwd: string }).cwd, '/home/test/claude-os', 'in the root of the Claude OS repository');
  assert.deepEqual([(made.body as { source: string }).source, (made.body as { sourceDetail: string }).sourceDetail], ['widget', 'w1']);
  const sent = fx!.calls.find(isSend)!;
  const prompt = (sent.body as { text: string }).text;
  assert.match(prompt, /plugins\/os-builder\/skills\/claude-os-widgets\/SKILL\.md/);
  assert.match(prompt, /"id":"w1"/);
  assert.doesNotMatch(prompt, /iconSvg|<svg/, 'the entry as it is in the file');
  assert.deepEqual(errors, []);
});

test('panels change through the right-click menu with their own context, no hover button', async () => {
  const page = await open();
  const places = [
    ['Проекты', 'ProjectsPanel', page.getByRole('heading', { name: 'Проекты' })],
    ['Токены', 'TokensPanel', page.getByRole('heading', { name: 'Токены' })],
    ['Статистика Claude Code', 'BottomStrip', page.locator('.home-foot-left')],
    ['Заметки', 'UniverseHud', page.getByText(/в памяти/)],
  ] as const;
  for (const [name, file, place] of places) {
    assert.equal(await page.getByRole('button', { name: `Настроить панель «${name}»` }).count(), 0);
    await place.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Изменить с Claude' }).click();
    const task = page.getByRole('dialog', { name: 'Изменить панель' });
    await task.getByText(new RegExp(`web/src/home/${file}\\.tsx`)).first().waitFor();
    await task.getByRole('button', { name: 'Отмена' }).click();
    await task.waitFor({ state: 'detached' });
  }
});

test('project row: no hover button; right click and the menu key give one menu, driven from the keyboard', async () => {
  const page = await open();
  await page.locator('aside').getByText('beta-web', { exact: true }).first().hover();
  assert.equal(await page.getByRole('button', { name: 'Открыть beta-web в новой вкладке' }).count(), 0, 'the second button left the row');
  assert.equal(await page.getByRole('button', { name: 'Действия: beta-web' }).count(), 0, 'and so did the first');
  const row = page.locator('aside').getByRole('button', { name: /beta-web/ }).first();
  await row.focus();
  await page.keyboard.press('Shift+F10');
  const menu = contextMenu(page);
  await menu.waitFor();
  const items = await menu.getByRole('menuitem').allTextContents();
  for (const item of ['Новая сессия', 'Показать на карте', 'Терминал в папке проекта', 'Открыть в IDE', 'Скопировать путь', 'Изменить с Claude', 'Вопрос Claude', 'Перенести заметки в хранилище']) assert.ok(items.includes(item), item);
  assert.equal(items.at(-1), 'Убрать из памяти Claude');
  assert.equal(items.filter((i) => i === 'Изменить с Claude').length, 1, 'the row wins over the panel');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: 'Убрать проект из памяти Claude' }).waitFor();
  await page.keyboard.press('Escape');

  await (await menuFor(page, 'beta-web')).getByRole('menuitem', { name: 'Изменить с Claude' }).click();
  const task = page.getByRole('dialog', { name: 'Изменить с Claude: beta-web' });
  await task.getByText(/\/home\/test\/beta-web/).first().waitFor();
  assert.deepEqual(errors, []);
});

test('project row: the click opens the project; the menu starts a new session and moves notes', async () => {
  const page = await open();
  await page.locator('aside').getByText('gamma-tools', { exact: true }).first().click();
  await page.waitForTimeout(150);
  assert.deepEqual(fx!.calls.find((c) => c.path === '/api/tabs' && c.method === 'POST')?.body, { project: 'gamma-tools' });
});

test('project menu items do what they say', async () => {
  const page = await open();
  let menu = await menuFor(page, 'beta-web');
  await menu.getByRole('menuitem', { name: 'Перенести заметки в хранилище' }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });

  menu = await menuFor(page, 'beta-web');
  await menu.getByRole('menuitem', { name: 'Терминал в папке проекта' }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(fx!.calls.find((c) => c.path === '/api/actions/builtin:shell/run')?.body, { project: 'beta-web', cwd: '/home/test/beta-web' });

  menu = await menuFor(page, 'beta-web');
  await menu.getByRole('menuitem', { name: 'Скопировать путь' }).click();
  await page.getByText('Путь скопирован').waitFor();

  menu = await menuFor(page, 'gamma-tools');
  await menu.getByRole('menuitem', { name: 'Открыть в IDE' }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(fx!.calls.find((c) => c.path === '/api/ides/open')?.body, { project: 'gamma-tools', cwd: '/home/test/gamma-tools' });

  menu = await menuFor(page, 'alpha-service');
  await menu.getByRole('menuitem', { name: /Живые сессии/ }).click();
  await page.getByRole('dialog', { name: /Проект alpha-service/ }).getByText('Перенос очереди на новый брокер').waitFor();
  assert.deepEqual(errors, []);
});

test('badge popover: the same menu is on its right click, and using it does not close the popover', async () => {
  const page = await open();
  const menu = await menuFor(page, 'gamma-tools');
  await menu.getByRole('menuitem', { name: 'Показать на карте' }).click();
  const badge = page.locator('.u-label.on[data-project="gamma-tools"]');
  await badge.hover();
  const pop = page.getByRole('dialog', { name: /Проект gamma-tools/ });
  await pop.waitFor();
  assert.equal(await pop.getByRole('button', { name: 'Действия: gamma-tools' }).count(), 0);
  await pop.getByRole('heading').click({ button: 'right' });
  const inner = contextMenu(page);
  await inner.getByRole('menuitem', { name: 'Убрать из памяти Claude' }).hover();
  await page.waitForTimeout(400);
  assert.ok(await pop.isVisible());
  await page.keyboard.press('Escape');
  await inner.waitFor({ state: 'detached' });
  assert.ok(await pop.isVisible(), 'Escape closes the menu, not the popover under it');
  assert.equal(await pop.getByRole('button', { name: 'Убрать из памяти Claude' }).count(), 0, 'removal moved to the menu');
  await pop.getByRole('button', { name: 'Новая сессия' }).waitFor();
});

test('Claude OS is the core: no row, no badge dot, no way to remove it; hover and click still answer', async () => {
  const page = await open();
  assert.equal(await page.locator('aside').getByText(CORE, { exact: true }).count(), 0, 'not in the project list');
  const core = page.locator('.u-label.core.on');
  await core.waitFor();
  assert.equal(await core.innerText(), 'Claude OS');
  assert.equal(await core.locator('i').count(), 0, 'no project dot');
  assert.equal(await core.locator('svg').count(), 1, 'its mark');
  assert.equal(await core.evaluate((e) => getComputedStyle(e).backgroundColor), 'rgba(0, 0, 0, 0)', 'no badge');
  await core.hover();
  const pop = page.getByRole('dialog', { name: /Проект Claude OS/ });
  await pop.waitFor();
  await pop.getByText(/\d+ замет/).waitFor();
  await pop.getByText('Активных сессий нет').waitFor();
  await pop.getByRole('heading').click({ button: 'right' });
  assert.equal(await contextMenu(page).getByRole('menuitem', { name: 'Убрать из памяти Claude' }).count(), 0);
  await page.keyboard.press('Escape');
  const label = (await core.boundingBox())!;
  const popBox = (await pop.boundingBox())!;
  assert.ok(popBox.y >= label.y + label.height, 'the popover leaves the nucleus in sight');

  await page.mouse.move(120, 960);
  await pop.waitFor({ state: 'detached' });
  // The nucleus itself answers too: the home camera looks at it, so it is the middle of the window.
  await page.mouse.move(800, 500, { steps: 4 });
  await pop.waitFor();
  await page.mouse.move(120, 960);
  await pop.waitFor({ state: 'detached' });
  // Its own label may hide on the way in and stop moving: what proves the flight is the close-up.
  await page.mouse.click(800, 500);
  await page.locator('.u-label-note.on').first().waitFor();
  assert.deepEqual(errors, []);
});

test('the root session counts as the core; project without own notes merge there', async () => {
  const data = defaultFixture();
  data.graph.rootProject = 'root-folder';
  data.sessions.push({ ...data.sessions[0], id: 's-root', project: 'root-folder', title: 'Корневая сессия', status: 'idle', subagents: [] });
  const page = await open(data);
  await page.locator('.u-label.core.on').hover();
  const pop = page.getByRole('dialog', { name: /Проект Claude OS/ });
  await pop.getByText('Корневая сессия').waitFor();
});

test('English: the same words exist', async () => {
  const page = await open(defaultFixture(), 'en-US');
  const menu = await menuFor(page, 'beta-web');
  await menu.getByRole('menuitem', { name: 'Move notes to the vault' }).waitFor();
  await page.keyboard.press('Escape');
  await page.locator('.u-label.core.on').waitFor();
  await page.mouse.click(800, 500, { button: 'right' });
  await contextMenu(page).getByRole('menuitem', { name: 'Create widget' }).waitFor();
  assert.equal(await page.getByText('Memory notes').count(), 0);
});
