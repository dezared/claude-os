// The progress widget on the home screen. Fake backend only: nothing here reaches Claude.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Tab, TaskState } from '../shared/contract.ts';
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

const task = (id: string, title: string, percent: number, state: TaskState, step: string | null = null, order = 1): Tab => ({
  id, kind: 'work', project: 'alpha-service', cwd: '/home/test/alpha', sessionId: null, title, order, model: null, effort: null, worktree: false,
  status: state === 'working' ? 'working' : state === 'waiting' ? 'waiting_permission' : 'idle', attention: state === 'waiting', queued: 0,
  progress: { percent, step, state, at: 1 },
});

async function open(tabs: Tab[], reducedMotion: 'reduce' | 'no-preference' = 'reduce', locale = 'ru-RU', slots = {}, home = {}): Promise<Page> {
  errors = [];
  fixtureSettings.home = { slots, hidden: [], ...home };
  const data: Fixture = defaultFixture();
  data.tabs.push(...tabs);
  fx = await startFixture(data);
  ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale, reducedMotion });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  await page.locator('aside').getByText('alpha-service', { exact: true }).first().waitFor();
  return page;
}

const panel = (page: Page) => page.locator('[data-widget="progress"]');
const row = (page: Page, id: string) => page.locator(`[data-progress-row="${id}"]`);
const update = (id: string, change: Partial<NonNullable<Tab['progress']>>) => {
  const tab = fx!.data.tabs.find((t) => t.id === id)!;
  tab.progress = { ...tab.progress!, ...change };
  fx!.push({ t: 'invalidate', topics: ['tabs'] });
};

test('no task, no widget: it takes no room and the layout stays as it was', async () => {
  const page = await open([]);
  await page.waitForTimeout(300);
  assert.equal(await panel(page).count(), 0);
  assert.equal(await page.locator('[data-slot="right"] [data-widget]').filter({ hasText: 'Ход работ' }).count(), 0);
  assert.deepEqual(errors, []);
});

test('a row per task: title, bar, step and status from the tab; a click leads to it', async () => {
  const page = await open([
    task('t-a', 'Виджеты', 40, 'working', 'тесты', 1),
    task('t-b', 'Голос', 70, 'waiting', 'выбор модели', 2),
    task('t-c', 'Планер', 100, 'done', null, 3),
    task('t-d', 'Канбан', 20, 'failed', 'сборка', 4),
  ]);
  await panel(page).waitFor();
  assert.equal(await page.locator('[data-slot="right"] [data-widget="progress"]').count(), 1, 'stands in the right slot by default');
  assert.equal(await page.locator('[data-progress-row]').count(), 4);
  for (const [id, state, label] of [['t-a', 'working', 'работает'], ['t-b', 'waiting', 'ждёт ответа'], ['t-c', 'done', 'готово'], ['t-d', 'failed', 'сбой']]) {
    assert.equal(await row(page, id).getAttribute('data-state'), state);
    assert.equal(await row(page, id).locator('[data-progress-state]').innerText(), label);
  }
  assert.equal(await row(page, 't-a').getByRole('progressbar').getAttribute('aria-valuenow'), '40');
  await row(page, 't-a').getByText('тесты').waitFor();
  await panel(page).getByText('1/4').waitFor();

  await row(page, 't-b').getByRole('button').click();
  await page.waitForFunction(() => !document.querySelector('[data-widget="progress"]')?.checkVisibility());
  assert.deepEqual(errors, []);
});

test('English strings exist for every state', async () => {
  const page = await open([task('t-a', 'A', 10, 'working'), task('t-b', 'B', 10, 'waiting'), task('t-c', 'C', 100, 'done'), task('t-d', 'D', 10, 'failed')], 'reduce', 'en-US');
  await panel(page).waitFor();
  for (const [id, label] of [['t-a', 'working'], ['t-b', 'waiting for you'], ['t-c', 'done'], ['t-d', 'failed']]) {
    assert.equal(await row(page, id).locator('[data-progress-state]').innerText(), label);
  }
});

test('the bar glides to a new percent and its colour follows the status', async () => {
  const page = await open([task('t-a', 'Виджеты', 20, 'working', 'старт')], 'no-preference');
  const fill = row(page, 't-a').locator('.progress-fill');
  const width = () => fill.evaluate((e) => e.getBoundingClientRect().width);
  const colour = () => fill.evaluate((e) => getComputedStyle(e).backgroundColor);
  await fill.waitFor();
  await page.waitForTimeout(800);
  const start = await width();
  const track = await fill.evaluate((e) => e.parentElement!.getBoundingClientRect().width);
  assert.ok(Math.abs(start / track - 0.2) < 0.02, `20%: ${start} of ${track}`);
  const blue = await colour();

  // Sampled in the page on every frame: under software WebGL a look from outside can come too late.
  await fill.evaluate((e) => {
    const seen: number[] = [];
    (window as unknown as { widths: number[] }).widths = seen;
    const sample = () => {
      seen.push(e.getBoundingClientRect().width);
      requestAnimationFrame(sample);
    };
    sample();
  });
  update('t-a', { percent: 80, step: 'финиш' });
  await row(page, 't-a').getByRole('progressbar').and(page.locator('[aria-valuenow="80"]')).waitFor();
  await page.waitForFunction((end) => Math.abs(document.querySelector('[data-progress-row="t-a"] .progress-fill')!.getBoundingClientRect().width - end) < 3, track * 0.8, { timeout: 20_000 });
  const widths = await page.evaluate(() => (window as unknown as { widths: number[] }).widths);
  assert.ok(widths.some((w) => w > start + 2 && w < track * 0.8 - 2), `passes through values on the way: ${[...new Set(widths)].slice(0, 12)}`);
  await row(page, 't-a').getByText('финиш').waitFor();

  update('t-a', { percent: 100, state: 'done', step: null });
  await page.waitForFunction(() => document.querySelector('[data-progress-row="t-a"]')?.getAttribute('data-state') === 'done');
  await page.waitForTimeout(600);
  assert.notEqual(await colour(), blue);
  assert.deepEqual(errors, []);
});

test('a closed tab folds away; with the last one the widget leaves too. The menu takes a row off the list', async () => {
  const page = await open([task('t-a', 'Виджеты', 40, 'working', null, 1), task('t-b', 'Голос', 100, 'done', null, 2)], 'no-preference');
  await row(page, 't-b').waitFor();
  await row(page, 't-b').click({ button: 'right' });
  await page.locator('[data-context-menu]').getByText('Убрать из списка').click();
  await row(page, 't-b').waitFor({ state: 'detached' });
  assert.ok(fx!.calls.some((c) => c.method === 'DELETE' && c.path === '/api/tabs/t-b/progress'));

  fx!.data.tabs.splice(fx!.data.tabs.findIndex((t) => t.id === 't-a'), 1);
  fx!.push({ t: 'invalidate', topics: ['tabs'] });
  await panel(page).waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
});

test('an existing layout is kept: the widget joins in by itself and moves like the others', async () => {
  const page = await open([task('t-a', 'Виджеты', 40, 'working')], 'reduce', 'ru-RU', { left: ['projects', 'tokens'], right: [], 'bottom-left': ['stats'] });
  await page.locator('[data-slot="right"] [data-widget="progress"]').waitFor();
  assert.equal(await page.locator('[data-slot="left"] [data-widget="tokens"]').count(), 1);
  assert.equal(fx!.calls.filter((c) => c.path === '/api/settings/home').length, 0, 'nothing written until the user moves something');
  await panel(page).focus();
  await page.keyboard.press('ArrowDown');
  await page.locator('[data-slot="bottom-right"] [data-widget="progress"]').waitFor();
  const saved = fx!.calls.filter((c) => c.path === '/api/settings/home').at(-1)!.body as { slots: Record<string, string[]> };
  assert.equal(saved.slots['bottom-right'][0], 'progress');
  assert.deepEqual(saved.slots.left, ['projects', 'tokens']);
});

test('the widget follows its rows: it grows with tasks, shrinks back, scrolls past about eight, keeps no height of its own', async () => {
  const page = await open([task('t-a', 'Виджеты', 40, 'working', 'тесты', 1)], 'reduce', 'ru-RU', {}, { heights: { progress: 600 } });
  await row(page, 't-a').waitFor();
  const height = () => panel(page).evaluate((e) => Math.round(e.getBoundingClientRect().height));
  const one = await height();
  assert.ok(one < 200, `one row, not the stored 600: ${one}`);
  assert.equal(await panel(page).locator('[data-widget-resize]').count(), 0, 'nothing to pull');

  fx!.data.tabs.push(task('t-b', 'Голос', 10, 'working', null, 2), task('t-c', 'Канбан', 10, 'working', null, 3));
  fx!.push({ t: 'invalidate', topics: ['tabs'] });
  await row(page, 't-c').waitFor();
  await page.waitForTimeout(100);
  const three = await height();
  assert.ok(three > one + 60, `three rows: ${one} -> ${three}`);

  fx!.data.tabs = fx!.data.tabs.filter((t) => t.id !== 't-b' && t.id !== 't-c');
  fx!.push({ t: 'invalidate', topics: ['tabs'] });
  await row(page, 't-c').waitFor({ state: 'detached' });
  await page.waitForTimeout(100);
  assert.ok(Math.abs((await height()) - one) <= 1, `back to one row: ${await height()} vs ${one}`);

  fx!.data.tabs.push(...Array.from({ length: 12 }, (_, i) => task(`t-m${i}`, `Задача ${i}`, 10, 'working', null, 10 + i)));
  fx!.push({ t: 'invalidate', topics: ['tabs'] });
  await row(page, 't-m11').waitFor({ state: 'attached' });
  await page.waitForTimeout(100);
  const list = panel(page).locator('.widget-body-inner > div').last();
  const { scroll, client } = await list.evaluate((e) => ({ scroll: e.scrollHeight, client: e.clientHeight }));
  assert.ok(scroll > client, `thirteen rows scroll inside: ${scroll} > ${client}`);
  const rowHeight = (three - one) / 2;
  assert.ok(client < rowHeight * 9 && client > rowHeight * 7, `about eight rows: ${client}, a row ${rowHeight}`);
  assert.deepEqual(errors, []);
});
