// Shared steps of the demo capture: a fresh English page on the demo layer and the ways to move around the app.
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import type { FixtureServer } from '../fixture-server.ts';
import { routeDemo } from './localize.ts';

export const OUT = join(import.meta.dirname, '..', '..', 'docs', 'media');
export const VIEWPORT = { width: 1440, height: 900 };
// The GIF is shown at its own size: a smaller window keeps the text readable without a huge file.
export const GIF_VIEWPORT = { width: 1280, height: 800 };

/** A fresh English page on the demo layer: nothing remembered from the previous scene. */
export async function openPage(browser: Browser, fx: FixtureServer, video?: string): Promise<{ page: Page; missed: Set<string>; done: () => Promise<void> }> {
  const viewport = video ? GIF_VIEWPORT : VIEWPORT;
  const ctx = await browser.newContext({ viewport, locale: 'en-US', deviceScaleFactor: video ? 1 : 2, ...(video ? { recordVideo: { dir: video, size: viewport } } : {}) });
  await ctx.addInitScript(() => localStorage.setItem('claude-os.lang', 'en'));
  const missed = await routeDemo(ctx);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.error('pageerror:', e.message));
  await page.goto(fx.url);
  await page.getByRole('navigation', { name: 'Tabs and sections' }).waitFor();
  return { page, missed, done: () => ctx.close() };
}

export const nav = (page: Page) => page.getByRole('navigation', { name: 'Tabs and sections' });

export async function openMenu(page: Page, item: string): Promise<void> {
  await nav(page).getByRole('button', { name: 'Menu' }).click();
  await page.getByRole('menuitem', { name: item, exact: true }).click();
}

export async function openTab(page: Page, title: string): Promise<void> {
  await nav(page).getByText(title, { exact: true }).click();
}

