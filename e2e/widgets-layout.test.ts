// Home: the column layout, collapsing, the trash in Settings, the map controls and the root chat's place. Fake backend only.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { fixtureSettings } from './fixture-features.ts';
import { defaultFixture, startFixture, type Fixture, type FixtureServer } from './fixture-server.ts';
import type { SettingsView } from '../shared/contract.ts';

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

const empty = () => {
  const data = defaultFixture();
  data.widgets.defs = [];
  return data;
};

async function open(data: Fixture = empty(), home: SettingsView['home'] = { slots: {}, hidden: [] }, motion: 'reduce' | 'no-preference' = 'reduce', init?: string): Promise<Page> {
  errors = [];
  fixtureSettings.home = home;
  fx = await startFixture(data);
  ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU', reducedMotion: motion });
  if (init) await ctx.addInitScript(init);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  await page.locator('[data-col]').first().waitFor();
  return page;
}

const widget = (page: Page, name: string) => page.getByRole('group', { name, exact: true });
const box = async (el: ReturnType<Page['locator']>) => (await el.boundingBox())!;
const homePuts = () => fx!.calls.filter((c) => c.method === 'PUT' && c.path === '/api/settings/home');
const lastHome = () => homePuts().at(-1)!.body as SettingsView['home'];
const menuItem = (page: Page, name: string) => page.locator('[data-context-menu]').getByRole('menuitem', { name, exact: true });

test('slots are even: the whole height of a column is there for both, top and bottom alike', async () => {
  const page = await open();
  const stats = widget(page, 'Статистика Claude Code');
  await stats.waitFor();
  await widget(page, 'Проекты').getByText('alpha-service', { exact: true }).waitFor();
  const onTop = await box(widget(page, 'Проекты'));
  const grip = await box(widget(page, 'Проекты').locator('[data-widget-grip]'));
  await page.mouse.move(grip.x + 40, grip.y + 10);
  await page.mouse.down();
  await page.mouse.move(100, 900, { steps: 4 });
  await page.locator('[data-zone="bottom-left"].is-target').waitFor();
  const [up, low] = [await box(page.locator('[data-zone="left"]')), await box(page.locator('[data-zone="bottom-left"]'))];
  assert.ok(Math.abs(up.height - low.height) < 200, `about even: ${up.height} and ${low.height}`);
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-slot="bottom-left"] [data-widget="projects"]'));
  const projects = await box(widget(page, 'Проекты'));
  assert.ok(Math.abs(projects.height - onTop.height) <= 1, `below it has the height it had on top: ${projects.height} and ${onTop.height}`);
  const after = await box(stats);
  assert.ok(after.y >= projects.y + projects.height || projects.y >= after.y + after.height, 'stacked, not overlapping');
  assert.deepEqual(errors, []);
});

test('a long project name truncates inside the widget: the column never scrolls sideways', async () => {
  const data = empty();
  data.projects[0].name = 'очень-длинное-название-проекта-которое-не-влезает-в-колонку';
  data.projects[0].memoryCount = 93;
  const page = await open(data);
  const row = widget(page, 'Проекты').getByText(data.projects[0].name, { exact: true });
  await row.waitFor();
  const col = page.locator('[data-col="left"]');
  assert.deepEqual(await col.evaluate((el) => [el.scrollWidth, el.clientWidth]).then(([s, c]) => s <= c), true, 'no sideways scroll');
  const [colBox, rowBox] = [await box(col), await box(row)];
  assert.ok(rowBox.x + rowBox.width <= colBox.x + colBox.width, 'the name ends inside the column');
  assert.equal(await row.evaluate((el) => el.scrollWidth > el.clientWidth), true, 'cut with an ellipsis, not wrapped');
  assert.deepEqual(errors, []);
});

test('any widget collapses, the state survives a reload, the title brings it back, a neighbour moves instead of being covered', async () => {
  const data = empty();
  data.widgets.defs = [
    { id: 'b1', title: 'Один', type: 'block', content: 'первый', approved: true, slot: 'right', height: 300 },
    { id: 'b2', title: 'Два', type: 'block', content: 'второй', approved: true, slot: 'right', height: 200 },
  ];
  const home = { slots: { right: ['b1', 'b2', 'tokens'] }, hidden: [] };
  const page = await open(data, home);
  const [one, two] = [widget(page, 'Один'), widget(page, 'Два')];
  await two.waitFor();
  const wasTwo = await box(two);

  await one.getByText('Один').click({ button: 'right' });
  await menuItem(page, 'Свернуть виджет Один').click();
  await page.waitForFunction(() => document.querySelector('[data-widget="b1"]')!.classList.contains('is-collapsed'));
  assert.deepEqual(lastHome().collapsed, ['b1']);
  const folded = await box(one);
  assert.equal(folded.height, 32, 'just the title');
  const nowTwo = await box(two);
  assert.equal(nowTwo.y, wasTwo.y - (300 - 32), 'the neighbour came up');
  assert.equal(nowTwo.height, 200, 'and kept its size');

  await page.reload();
  await two.waitFor();
  assert.equal((await box(one)).height, 32, 'still collapsed');

  await one.locator('[data-widget-grip]').click();
  await page.waitForFunction(() => !document.querySelector('[data-widget="b1"]')!.classList.contains('is-collapsed'));
  assert.equal((await box(one)).height, 300, 'opens to the height it had');
  const pushed = await box(two);
  const opened = await box(one);
  assert.equal(pushed.y, opened.y + opened.height + 10, 'opening pushes the neighbour down, it does not cover it');
  assert.deepEqual(errors, []);
});

test('a collapsed widget moves like an open one, and pulling its title is not a click', async () => {
  const page = await open(empty(), { slots: {}, hidden: [], collapsed: ['tokens'] });
  const tokens = widget(page, 'Токены');
  await tokens.waitFor();
  const grip = await box(tokens.locator('[data-widget-grip]'));
  await page.mouse.move(grip.x + 40, grip.y + 10);
  await page.mouse.down();
  await page.mouse.move(100, 400, { steps: 5 });
  await page.locator('.widget-ghost').waitFor();
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-col="left"] [data-widget="tokens"]'));
  assert.deepEqual(lastHome().collapsed, ['tokens'], 'still collapsed: the drop was no click');
  assert.equal((await box(tokens)).height, 32);
});

test('a bare widget has no title until it is collapsed; Enter on a focused widget does the same as the menu', async () => {
  const page = await open();
  const notes = widget(page, 'Заметки');
  await notes.waitFor();
  assert.equal(await notes.getByRole('heading').count(), 0, 'the pill alone');
  await notes.focus();
  await page.keyboard.press('Enter');
  await notes.getByRole('heading', { name: 'Заметки' }).waitFor();
  assert.equal(await notes.getByRole('textbox').count(), 0, 'the search is folded away');
  assert.ok((await box(notes)).width <= 240);
  await notes.getByRole('button', { name: 'Развернуть виджет Заметки' }).click();
  await notes.getByRole('textbox').waitFor();
  assert.deepEqual(lastHome().collapsed, []);
  assert.deepEqual(errors, []);
});

test('fluid panels share a column without a scroll: each stays usable, nothing overlaps', async () => {
  const data = empty();
  data.projects = Array.from({ length: 80 }, (_, i) => ({ ...data.projects[0], key: `p${i}`, name: `p${i}` }));
  const page = await open(data, { slots: { left: ['projects', 'tokens'] }, hidden: ['stats'] });
  const [projects, tokens] = [widget(page, 'Проекты'), widget(page, 'Токены')];
  await tokens.waitFor();
  await projects.getByText('p1', { exact: true }).waitFor();
  const [p, k] = [await box(projects), await box(tokens)];
  assert.ok(k.y >= p.y + p.height, 'no overlap');
  assert.ok(k.y + k.height <= 991, 'all inside the window');
  assert.ok(p.height >= 180 && k.height >= 180);
  const col = await page.locator('[data-col="left"]').evaluate((e) => [e.scrollHeight, e.clientHeight]);
  assert.equal(col[0], col[1], 'the column does not scroll: the panels do');
  const inner = await projects.locator('.panel-scroll').evaluate((e) => [e.scrollHeight, e.clientHeight]);
  assert.ok(inner[0] > inner[1], 'the long list scrolls inside');
  assert.deepEqual(errors, []);
});

test('nothing jumps: collapsing slides the neighbour both ways, a removal lets it glide', async () => {
  const spy = `(() => {
    const real = Element.prototype.animate;
    window.__glides = [];
    Element.prototype.animate = function (frames, options) {
      if (this.dataset?.widget) window.__glides.push([this.dataset.widget, JSON.stringify(frames)]);
      return real.call(this, frames, options);
    };
  })();`;
  const page = await open(empty(), { slots: { left: ['projects', 'tokens'] }, hidden: [] }, 'no-preference', spy);
  const [projects, tokens] = [widget(page, 'Проекты'), widget(page, 'Токены')];
  await tokens.waitFor();
  await projects.getByText('alpha-service', { exact: true }).waitFor();
  const y = async () => (await box(tokens)).y;
  const open0 = await y();
  const top = (await box(projects)).y;
  const folded = top + 32 + 10;
  // Slowed down: a loaded machine draws few frames, and what is checked is that a middle exists, not how many frames show it.
  const slow = await page.addStyleTag({ content: '.home-widget, .widget-body, .home-widget.is-collapsed .widget-body { transition-duration: 8s !important; }' });
  const passing = (from: number, to: number) => page.waitForFunction(([f, t]) => {
    const now = document.querySelector('[data-widget="tokens"]')!.getBoundingClientRect().y;
    return Math.abs(now - f) > 2 && Math.abs(now - t) > 2 && now > Math.min(f, t) && now < Math.max(f, t);
  }, [from, to]);
  await projects.hover();
  await projects.getByRole('button', { name: 'Свернуть виджет Проекты' }).click();
  await passing(open0, folded);
  await slow.evaluate((e) => (e as HTMLElement).remove());
  await page.waitForFunction((end) => Math.abs(document.querySelector('[data-widget="tokens"]')!.getBoundingClientRect().y - end) < 2, folded);

  const slowAgain = await page.addStyleTag({ content: '.home-widget, .widget-body { transition-duration: 8s !important; }' });
  await projects.locator('[data-widget-grip]').click();
  await passing(folded, open0);
  await slowAgain.evaluate((e) => (e as HTMLElement).remove());
  await page.waitForFunction((end) => Math.abs(document.querySelector('[data-widget="tokens"]')!.getBoundingClientRect().y - end) < 2, open0);

  // Removed from above it: the widget leaves, then the neighbour glides into the place.
  await projects.getByRole('heading', { name: 'Проекты' }).click({ button: 'right' });
  await menuItem(page, 'Удалить виджет Проекты').click();
  await projects.waitFor({ state: 'detached' });
  const glides = await page.evaluate(() => (window as unknown as { __glides: string[][] }).__glides);
  assert.ok(glides.some(([id, frames]) => id === 'projects' && frames.includes('"opacity":0')), 'the removed one fades');
  assert.ok(glides.some(([id, frames]) => id === 'tokens' && frames.includes('translate(')), 'its neighbour glides');
  assert.deepEqual(errors, []);
});

test('the map controls stand beside the right column and take the corner when it is empty', async () => {
  const page = await open(empty(), { slots: {}, hidden: ['progress'] });
  const view = page.locator('.home-view');
  await view.getByRole('button').first().waitFor();
  const size = page.viewportSize()!;
  const beside = await box(view);
  assert.ok(beside.x + beside.width < size.width - 286, 'next to the tokens');
  const tokens = widget(page, 'Токены');
  await tokens.getByRole('heading', { name: 'Токены' }).click({ button: 'right' });
  await menuItem(page, 'Удалить виджет Токены').click();
  await tokens.waitFor({ state: 'detached' });
  const corner = await box(view);
  assert.equal(corner.x + corner.width, size.width - 10, 'as far right as it goes');
});

test('Settings list the widgets: remove, bring back, delete a block and a built-in for good', async () => {
  const data = empty();
  data.widgets.defs = [{ id: 'b1', title: 'Один', type: 'block', content: 'первый', approved: true, slot: 'right' }];
  const page = await open(data, { slots: { left: ['projects', 'tokens'], 'bottom-left': ['stats'] }, hidden: ['stats'] });
  await widget(page, 'Токены').waitFor();
  assert.equal(await widget(page, 'Статистика Claude Code').count(), 0, 'a hidden widget of an old layout is in the trash');
  assert.equal(await page.evaluate(() => document.querySelector('[data-slot="left"] [data-widget="tokens"]') !== null), true, 'an old layout stands as it was');

  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'settings', section: 'widgets' })));
  await page.reload();
  const rows = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Виджеты', exact: true }) });
  await rows.getByText('Корзина').waitFor();
  await rows.getByText('Статистика Claude Code').waitFor();

  // Out of the screen list into the trash.
  const row = (title: string) => rows.locator('div').filter({ has: page.getByText(title, { exact: true }) }).filter({ has: page.getByRole('button') }).last();
  await row('Один').getByRole('button', { name: 'Удалить', exact: true }).click();
  assert.deepEqual(lastHome().hidden, ['stats', 'b1']);
  // Back again.
  await row('Статистика Claude Code').getByRole('button', { name: 'Вернуть' }).click();
  assert.deepEqual(lastHome().hidden, ['b1']);

  // For good: a block loses its entry, only after the question.
  await row('Один').getByRole('button', { name: 'Удалить окончательно' }).click();
  const ask = page.getByRole('dialog', { name: 'Удалить виджет окончательно?' });
  await ask.getByRole('button', { name: 'Отмена' }).click();
  await ask.waitFor({ state: 'detached' });
  assert.equal(fx!.calls.filter((c) => c.method === 'DELETE').length, 0);
  await row('Один').getByRole('button', { name: 'Удалить окончательно' }).click();
  await ask.getByRole('button', { name: 'Удалить окончательно' }).click();
  await page.waitForFunction(() => !document.body.innerText.includes('Один'));
  assert.ok(fx!.calls.some((c) => c.method === 'DELETE' && c.path === '/api/widgets/b1'));
  assert.deepEqual(lastHome().hidden, []);

  // A built-in has no entry: the layout remembers, and it does not come back on its own.
  await row('Токены').getByRole('button', { name: 'Удалить', exact: true }).click();
  await row('Токены').getByRole('button', { name: 'Удалить окончательно' }).click();
  await ask.getByRole('button', { name: 'Удалить окончательно' }).click();
  await rows.getByText('Корзина пуста').waitFor();
  assert.deepEqual(lastHome().removed, ['tokens']);
  assert.ok(!lastHome().slots.left?.includes('tokens'));
  assert.equal(await rows.getByText('Токены', { exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});

test('the root chat stands under the center and pushes nothing off; a tall chat only takes from the top slot', async () => {
  const page = await open();
  const chat = page.locator('.home-chat');
  await chat.waitFor();
  const [c, notes] = [await box(chat), await box(widget(page, 'Заметки'))];
  assert.ok(c.y >= notes.y + notes.height, 'chat under the top slot');
  assert.equal(c.y + c.height, 990, 'at the bottom of the window');
  assert.ok(Math.abs(c.x + c.width / 2 - 800) <= 1, 'in the middle');
  assert.deepEqual(errors, []);
});

test('the root chat in a window of its own leaves the home screen; the way back is on the core', async () => {
  const bridge = `(() => {
    const none = () => () => {};
    const record = (name) => (...args) => { (window.__calls ??= []).push([name, ...args]); };
    window.claudeDesktop = { canFullscreen: false, onCloseRequest: none, answerClose: record('answerClose'), notify: record('notify'), onOpenTab: none, setLabels: record('setLabels'), isFullscreen: async () => false, setFullscreen: record('setFullscreen'), onFullscreen: none, minimize: record('minimize'), currentApps: async () => [], onApps: none, activateApp: record('activateApp'), openPopout: record('openPopout'), returnPopout: record('returnPopout'), popouts: async () => ['root'], onPopouts: none, onShowView: none, showInMain: record('showInMain'), popoutPin: async () => true, setPopoutPin: record('setPopoutPin'), popoutWindow: record('popoutWindow') };
  })();`;
  const page = await open(empty(), { slots: {}, hidden: [] }, 'reduce', bridge);
  await widget(page, 'Проекты').waitFor();
  await page.locator('.home-chat').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.root-float').count(), 0, 'and it does not float here either');
  await page.locator('.u-label.core.on').waitFor();
  await page.mouse.click(800, 500, { button: 'right' });
  await menuItem(page, 'Вернуть в главное окно').click();
  assert.deepEqual(await page.evaluate(() => (window as unknown as { __calls: unknown[][] }).__calls.filter((c) => c[0] === 'returnPopout').map((c) => c[1])), ['root']);
  assert.deepEqual(errors, []);
});
