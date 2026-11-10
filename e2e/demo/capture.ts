// Mock run of Claude OS for the README: the e2e fixture server with made-up English data, a headless Chromium,
// one PNG per feature into docs/media/ and a short demo GIF. No Claude, no network, no user data.
// Run: npm run build && npm run demo:media
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';
import { fixtureSettings } from '../fixture-features.ts';
import { defaultFixture, startFixture, type FixtureServer } from '../fixture-server.ts';
import { toDemo } from './demo-data.ts';
import { recordGif } from './gif.ts';
import { nav, openMenu, openPage, openTab, OUT, VIEWPORT } from './page.ts';

type Scene = { name: string; settle?: number; go?: (page: Page) => Promise<void> };

const SCENES: Scene[] = [
  { name: 'home', settle: 4000 },
  { name: 'chat', go: (p) => openTab(p, 'payments-api') },
  { name: 'sessions', go: (p) => nav(p).getByRole('button', { name: 'Sessions' }).click() },
  { name: 'analytics', go: (p) => openMenu(p, 'Analytics') },
  { name: 'skills', go: (p) => openMenu(p, 'Tools') },
  { name: 'mcp', go: async (p) => { await openMenu(p, 'Tools'); await p.getByRole('button', { name: 'MCP servers' }).click(); } },
  { name: 'palette', go: (p) => p.keyboard.press('Control+k') },
];

async function shoot(browser: Browser, fx: FixtureServer, scene: Scene): Promise<string[]> {
  const { page, missed, done } = await openPage(browser, fx);
  await page.waitForTimeout(1500);
  await scene.go?.(page);
  await page.waitForTimeout(scene.settle ?? 1500);
  await page.mouse.move(VIEWPORT.width - 5, VIEWPORT.height - 5);
  await page.screenshot({ path: join(OUT, `${scene.name}.png`) });
  await done();
  return [...missed];
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  fixtureSettings.obsidian.dismissed = true;
  fixtureSettings.profile = { name: 'Alex', language: 'en', projectsDir: '/home/test', questionLevel: 'balanced' };
  fixtureSettings.setup = { step: 'done', completedAt: Date.now(), tabId: null };
  const data = defaultFixture();
  toDemo(data);
  const fx = await startFixture(data);
  const browser = await chromium.launch();
  const only = process.argv.slice(2);
  const missed = new Set<string>();
  try {
    for (const scene of SCENES.filter((s) => !only.length || only.includes(s.name))) {
      for (const m of await shoot(browser, fx, scene)) missed.add(m);
      console.log('shot', scene.name);
    }
    if (!only.length || only.includes('gif')) await recordGif(browser, fx);
  } finally {
    await browser.close();
    await fx.close();
  }
  if (missed.size) console.warn('untranslated:', [...missed]);
}

await main();
