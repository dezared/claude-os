// What the state of sessions costs on the map. A new browser per measurement: closed pages stall a shared software GPU.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { defaultFixture, startFixture, type Fixture, type FixtureServer } from './fixture-server.ts';

let browser: Browser | null = null;
let fx: FixtureServer | null = null;

afterEach(async () => {
  await browser?.close();
  await fx?.close();
  browser = null;
  fx = null;
});

const countDraws = () => {
  localStorage.setItem('claude-os.universe-quality', 'full');
  const w = window as unknown as { __draws: number; __dust: number };
  w.__draws = 0;
  w.__dust = 0;
  const real = WebGL2RenderingContext.prototype.drawArraysInstanced;
  WebGL2RenderingContext.prototype.drawArraysInstanced = function (...args: Parameters<typeof real>) {
    w.__draws++;
    return real.apply(this, args);
  };
  const plain = WebGL2RenderingContext.prototype.drawArrays;
  WebGL2RenderingContext.prototype.drawArrays = function (...args: Parameters<typeof plain>) {
    if (args[0] === this.POINTS) w.__dust++; // only ever drawn into the cached scene
    return plain.apply(this, args);
  };
};
const metrics = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __draws: number; __dust: number };
  return { draws: w.__draws, dust: w.__dust };
});

async function open(data: Fixture, reducedMotion: 'reduce' | 'no-preference', init: () => void = countDraws): Promise<Page> {
  fx = await startFixture(data);
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU', reducedMotion });
  await ctx.addInitScript(init);
  const page = await ctx.newPage();
  await page.goto(fx.url);
  await page.locator('aside').getByText('alpha-service', { exact: true }).first().waitFor();
  return page;
}

async function quiet(page: Page, what: string) {
  let last = -1;
  let same = 0;
  for (let i = 0; i < 90; i++) {
    await page.waitForTimeout(1000);
    const { draws } = await metrics(page);
    same = draws === last ? same + 1 : 0;
    last = draws;
    if (same >= 4 && draws > 0) return draws;
  }
  throw new Error(`${what}: still drawing after 90 seconds`);
}

test('a change of state reaches the satellites without redrawing the scene', async () => {
  const data = defaultFixture();
  const page = await open(data, 'no-preference');
  await page.waitForFunction(() => (window as unknown as { __dust: number }).__dust > 0, undefined, { timeout: 60000 });
  await page.waitForTimeout(8000);
  const start = await metrics(page);

  const s = data.sessions.find((x) => x.id === 's-live')!;
  s.status = 'idle';
  s.subagents = [1, 2, 3].map((i) => ({ id: `fresh${i}`, agentType: null, description: null, lastActivity: Date.now(), tokens: 0 }));
  fx!.push({ t: 'invalidate', topics: ['sessions'] });
  await page.waitForFunction((n) => (window as unknown as { __draws: number }).__draws > n + 3, start.draws, { timeout: 60000 });
  s.status = 'working';
  s.subagents = [];
  fx!.push({ t: 'invalidate', topics: ['sessions'] });
  const mid = await metrics(page);
  await page.waitForFunction((n) => (window as unknown as { __draws: number }).__draws > n + 3, mid.draws, { timeout: 60000 });
  assert.equal((await metrics(page)).dust, start.dust, 'a status or a subagent redrew the whole scene');
});

test('reduced motion: live sessions with subagents are still dots, nothing keeps drawing', async () => {
  const data = defaultFixture();
  data.sessions[0].subagents = [{ id: 'fresh', agentType: null, description: null, lastActivity: Date.now(), tokens: 0 }];
  const page = await open(data, 'reduce');
  await quiet(page, 'reduced motion');
});

test('no GPU: live sessions with subagents are still dots, nothing keeps drawing', async () => {
  const data = defaultFixture();
  data.sessions[0].subagents = [{ id: 'fresh', agentType: null, description: null, lastActivity: Date.now(), tokens: 0 }];
  const page = await open(data, 'no-preference', () => {
    const w = window as unknown as { __draws: number; __dust: number };
    w.__draws = 0;
    w.__dust = 0;
    const real = WebGL2RenderingContext.prototype.drawArraysInstanced;
    WebGL2RenderingContext.prototype.drawArraysInstanced = function (...args: Parameters<typeof real>) {
      w.__draws++;
      return real.apply(this, args);
    };
  });
  await quiet(page, 'software rendering');
});

test('a session that ended leaves no satellite: an idle map draws nothing, whatever its old subagents', async () => {
  const data = defaultFixture();
  for (const s of data.sessions) {
    s.status = 'ended';
    s.subagents = [{ id: 'old', agentType: null, description: null, lastActivity: Date.now(), tokens: 0 }];
  }
  for (const p of data.projects) p.liveCount = 0;
  const page = await open(data, 'no-preference');
  await quiet(page, 'an idle map');
});
