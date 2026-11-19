// The settings screen: the sidebar of sections, its search, the accent colour and the theme that follows the system. Fake backend only.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { startFixture, type FixtureServer } from './fixture-server.ts';

let fx: FixtureServer;
let browser: Browser;

before(async () => {
  fx = await startFixture();
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await fx?.close();
});

async function open(colorScheme: 'dark' | 'light' = 'dark') {
  const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', colorScheme });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('seeded')) {
      localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'settings', section: 'general' }));
      sessionStorage.setItem('seeded', '1');
    }
  });
  await page.goto(fx.url);
  await nav(page).waitFor();
  return { ctx, page, errors };
}

const nav = (page: Page) => page.getByRole('navigation', { name: 'Разделы настроек' });
const current = (page: Page) => nav(page).locator('button[aria-current="page"]').innerText();
const listed = (page: Page) => nav(page).locator('.motion-fold button').allInnerTexts();
const accent = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim());

test('the sidebar switches sections and its search finds a section by a row inside it', async () => {
  const { ctx, page, errors } = await open();
  assert.equal(await current(page), 'Общие');
  await nav(page).getByRole('button', { name: 'Профиль', exact: true }).click();
  assert.equal(await current(page), 'Профиль');
  await page.getByRole('heading', { name: 'Профиль' }).first().waitFor();
  await nav(page).getByRole('button', { name: 'Голосовой ввод' }).click();
  assert.equal(await current(page), 'Голосовой ввод');
  await page.getByRole('navigation', { name: 'Путь' }).getByText('Голосовой ввод').waitFor();

  const search = nav(page).getByRole('searchbox', { name: 'Поиск' });
  // "Усилие" is a row of the projects section, not a section name: search still finds the section.
  await search.fill('усилие');
  assert.deepEqual(await listed(page), ['Проекты']);
  await search.press('Enter');
  assert.equal(await current(page), 'Проекты');
  await page.getByRole('heading', { name: 'Проекты', exact: true }).waitFor();

  await search.fill('нет такого');
  await nav(page).getByText('Ничего не найдено').waitFor();
  await search.press('Escape');
  assert.equal(await search.inputValue(), '');
  assert.equal((await listed(page)).length, 9);
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('an accent swatch recolours the interface in both themes, survives a reload and the Claude swatch brings the shipped one back', async () => {
  const { ctx, page, errors } = await open();
  const shipped = await accent(page);
  assert.equal(shipped, '#d97757');
  await page.getByTitle('Синий', { exact: true }).click();
  assert.equal(await page.getByRole('radio', { name: 'Синий' }).isChecked(), true);
  assert.equal(await accent(page), '#0a84ff');
  assert.equal(await page.evaluate(() => localStorage.getItem('claude-os.accent')), '#0a84ff');

  // The light theme darkens the pick until it reads on white.
  await page.getByRole('radiogroup', { name: 'Тема' }).getByText('Светлая').click();
  const light = await accent(page);
  assert.notEqual(light, '#0a84ff');
  assert.match(light, /^#[0-9a-f]{6}$/);

  await page.reload();
  await nav(page).waitFor();
  assert.equal(await accent(page), light);
  await page.getByTitle('Claude', { exact: true }).click();
  assert.equal(await page.evaluate(() => localStorage.getItem('claude-os.accent')), null);
  assert.equal(await accent(page), '#c15f3c');
  await page.getByRole('radiogroup', { name: 'Тема' }).getByText('Тёмная').click();
  assert.deepEqual(errors, []);
  await ctx.close();
});

test('the Auto theme follows the system scheme as it changes', async () => {
  const { ctx, page, errors } = await open('light');
  await page.getByRole('radiogroup', { name: 'Тема' }).getByText('Авто').click();
  assert.equal(await page.evaluate(() => localStorage.getItem('claude-os.theme')), 'system');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.reload();
  await nav(page).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark');
  assert.equal(await page.getByRole('radio', { name: 'Авто' }).isChecked(), true);
  assert.deepEqual(errors, []);
  await ctx.close();
});
