// The interface theme: picked in Settings, kept by the browser, applied before the first paint. Fake backend only.
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

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme);
const pageBg = (page: Page) => page.evaluate(() => getComputedStyle(document.querySelector('.sheet') ?? document.body).backgroundColor);

test('the theme switches in settings, survives a reload and keeps the space map dark', async () => {
  const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  assert.equal(await theme(page), 'dark');
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('menuitem', { name: 'Настройки' }).click();
  const picker = page.getByRole('radiogroup', { name: 'Тема' });
  const dark = await pageBg(page);
  await picker.getByText('Светлая').click();
  assert.equal(await theme(page), 'light');
  assert.notEqual(await pageBg(page), dark);
  assert.equal(await picker.getByRole('radio', { name: 'Светлая' }).isChecked(), true);

  await page.reload();
  assert.equal(await theme(page), 'light');
  // The space map stays dark in every theme: the page behind it and its canvas are untouched.
  assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor), 'rgb(3, 3, 5)');
  assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('.universe-stage canvas')!).filter), 'none');

  await page.getByRole('radiogroup', { name: 'Тема' }).getByText('Тёмная').click();
  assert.equal(await theme(page), 'dark');
  assert.equal(await page.evaluate(() => localStorage.getItem('claude-os.theme')), 'dark');
  assert.deepEqual(errors, []);
  await ctx.close();
});

// Relative luminance and contrast ratio of two computed rgb() colours, as WCAG defines them.
function luminance(rgb: string) {
  const [r, g, b] = rgb.match(/[\d.]+/g)!.slice(0, 3).map((v) => {
    const c = Number(v) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: string, b: string) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

test('every separate window follows the light theme: a light page and readable text', async () => {
  const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 900, height: 700 }, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => localStorage.setItem('claude-os.theme', 'light'));
  const page = await ctx.newPage();
  for (const route of ['planner', 'service', 'btw', 'root', 'tab&id=t1']) {
    await page.goto(`${fx.url}/?popout=${route}`);
    const title = page.locator('.popout-bar strong');
    await title.waitFor();
    const bg = await page.evaluate(() => getComputedStyle(document.querySelector('.popout-window')!).backgroundColor);
    const fg = await title.evaluate((el) => getComputedStyle(el).color);
    assert.ok(luminance(bg) > 0.8, `${route}: the window is light, got ${bg}`);
    assert.ok(contrast(fg, bg) >= 4.5, `${route}: the title reads at ${contrast(fg, bg).toFixed(2)}:1`);
  }
  await ctx.close();
});

test('a screen is a sheet over the dark: the same gap on every side, the top one under the title bar', async () => {
  const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  const page = await ctx.newPage();
  await page.goto(fx.url);
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('menuitem', { name: 'Настройки' }).click();
  const sheet = page.locator('.sheet');
  await sheet.waitFor();
  const m = await sheet.evaluate((el) => {
    const s = getComputedStyle(el);
    return [s.marginTop, s.marginRight, s.marginBottom, s.marginLeft].map(parseFloat);
  });
  assert.ok(m[0] > 0, 'a gap above the sheet');
  assert.deepEqual(new Set(m).size, 1, `one gap on every side, got ${m.join()}`);
  await ctx.close();
});
