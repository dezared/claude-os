// Motion of the title bar: tabs grow in, fade out and slide aside, the subagent badge pops, reduced motion is instant. Fake backend only.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { defaultFixture, startFixture, type FixtureServer } from './fixture-server.ts';

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

async function open(motion: boolean): Promise<Page> {
  errors = [];
  fx = await startFixture(defaultFixture());
  ctx = await browser.newContext({ viewport: { width: 1600, height: 900 }, locale: 'ru-RU', reducedMotion: motion ? 'no-preference' : 'reduce' });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  await page.getByRole('tablist').getByRole('tab').first().waitFor();
  await page.waitForTimeout(400); // the first entrances are over
  return page;
}

const tabs = (page: Page) => page.getByRole('tablist').getByRole('tab');

/** Records, frame by frame from now on, what moves in the tab strip: tabs with running animations, ghosts, their opacity. */
const watch = (page: Page) =>
  page.evaluate(() => {
    const seen = { moving: new Set<string>(), ghosts: 0, ghostRole: false, entering: new Set<string>() };
    (window as unknown as { seen: typeof seen }).seen = seen;
    const frame = () => {
      const strip = document.querySelector('[role="tablist"]')!;
      for (const el of strip.querySelectorAll<HTMLElement>('[data-flip]')) {
        for (const a of el.getAnimations()) (a.id === 'flip' ? seen.moving : seen.entering).add(el.dataset.flip!);
      }
      const ghosts = strip.querySelectorAll('.is-ghost');
      seen.ghosts = Math.max(seen.ghosts, ghosts.length);
      if ([...ghosts].some((g) => g.matches('[role], [aria-selected]') || g.getAttribute('aria-hidden') !== 'true')) seen.ghostRole = true;
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });

const seen = (page: Page) =>
  page.evaluate(() => {
    const s = (window as unknown as { seen: { moving: Set<string>; ghosts: number; ghostRole: boolean; entering: Set<string> } }).seen;
    return { moving: [...s.moving], ghosts: s.ghosts, ghostRole: s.ghostRole, entering: [...s.entering] };
  });

test('a tab that closes fades out where it stood while the ones after it slide into its room; a new tab grows in', async () => {
  const page = await open(true);
  const ids = await tabs(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.flip!));
  assert.ok(ids.length >= 3, ids.join());
  await watch(page);

  const gone = fx!.data.tabs.findIndex((t) => t.id === ids[0]);
  fx!.data.tabs.splice(gone, 1);
  fx!.push({ t: 'invalidate', topics: ['tabs'] });
  await page.waitForFunction((n) => document.querySelectorAll('[role="tablist"] [role="tab"]').length === n, ids.length - 1);
  await page.waitForTimeout(300);
  const closing = await seen(page);
  assert.equal(closing.ghosts, 1, 'the closed tab left a copy that fades out');
  assert.equal(closing.ghostRole, false, 'the copy is no tab to anyone');
  assert.ok(ids.slice(1).every((id) => closing.moving.includes(id)), `the rest slid: ${closing.moving.join()}`);
  assert.equal(await page.locator('[role="tablist"] .is-ghost').count(), 0, 'the copy is gone after its exit');

  await watch(page);
  fx!.data.tabs.push({ ...fx!.data.tabs[1], id: 'fresh', title: 'новая вкладка', order: 99, subagents: 0 });
  fx!.push({ t: 'invalidate', topics: ['tabs'] });
  await tabs(page).filter({ hasText: 'новая вкладка' }).waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual((await seen(page)).entering, ['fresh'], 'the new tab grew in, nothing else did');
  assert.deepEqual(errors, []);
});

test('the subagent badge pops in with its own transition and its number rolls; reduced motion shows it at once', async () => {
  const page = await open(true);
  const tab = tabs(page).nth(1);
  const badge = tab.getByRole('img', { name: /Подагентов/ });
  const id = await tab.evaluate((el) => (el as HTMLElement).dataset.flip!);
  const set = (n: number) => {
    fx!.data.tabs.find((t) => t.id === id)!.subagents = n;
    fx!.push({ t: 'invalidate', topics: ['tabs'] });
  };

  set(1);
  const entering = await badge.evaluate((el) => new Promise<string[]>((done) => requestAnimationFrame(() => done(el.getAnimations().map((a) => (a as CSSTransition).transitionProperty)))));
  assert.ok(entering.includes('opacity') && entering.includes('scale'), `entering: ${entering.join()}`);

  set(2);
  await badge.locator('.roll-out').waitFor({ state: 'attached' });
  assert.equal(await badge.locator('.roll-in').innerText(), '2');
  await badge.locator('.roll-out').waitFor({ state: 'detached' });

  set(0);
  await page.waitForFunction(() => document.querySelector('[role="tablist"] .motion-pop.is-leaving[aria-label^="Подагентов"]'));
  await badge.waitFor({ state: 'detached' });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  set(3);
  await badge.waitFor();
  const still = await badge.evaluate((el) => ({ running: el.getAnimations().length, duration: getComputedStyle(el).transitionDuration }));
  assert.deepEqual(still, { running: 0, duration: '0s' });
  set(0);
  await badge.waitFor({ state: 'detached', timeout: 1000 });
  assert.deepEqual(errors, []);
});

test('reduced motion: a closed tab leaves no copy and nothing slides', async () => {
  const page = await open(false);
  const ids = await tabs(page).evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.flip!));
  await watch(page);
  fx!.data.tabs.splice(fx!.data.tabs.findIndex((t) => t.id === ids[0]), 1);
  fx!.data.tabs.push({ ...fx!.data.tabs[1], id: 'fresh', title: 'новая вкладка', order: 99 });
  fx!.push({ t: 'invalidate', topics: ['tabs'] });
  await tabs(page).filter({ hasText: 'новая вкладка' }).waitFor();
  await page.waitForTimeout(300);
  assert.deepEqual(await seen(page), { moving: [], ghosts: 0, ghostRole: false, entering: [] });
  assert.deepEqual(errors, []);
});

test('a menu that closes fades out as an inert copy where it stood; reduced motion leaves none', async () => {
  for (const motion of [true, false]) {
    const page = await open(motion);
    await page.locator('aside').getByText('beta-web', { exact: true }).first().click({ button: 'right' });
    const menu = page.locator('[data-context-menu]');
    await menu.waitFor();
    const box = await menu.boundingBox();
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'detached' });
    const ghost = await page.evaluate(() => {
      const g = document.querySelector<HTMLElement>('body > .is-ghost');
      return g && { role: g.getAttribute('role'), hidden: g.getAttribute('aria-hidden'), inert: g.inert, left: g.getBoundingClientRect().left, animations: g.getAnimations().length };
    });
    if (motion) {
      assert.ok(ghost, 'a copy fades out');
      assert.deepEqual({ role: ghost.role, hidden: ghost.hidden, inert: ghost.inert }, { role: null, hidden: 'true', inert: true });
      assert.ok(Math.abs(ghost.left - box!.x) < 12, `where the menu stood: ${ghost.left} vs ${box!.x}`);
      assert.equal(ghost.animations, 1);
      await page.waitForFunction(() => !document.querySelector('body > .is-ghost'));
    } else {
      assert.equal(ghost, null);
    }
    assert.deepEqual(errors, []);
    await ctx!.close();
    await fx!.close();
    ctx = null;
    fx = null;
  }
});
