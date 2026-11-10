// The map of a hundred projects: who stands on it, what the right click changes, what it costs. Fake backend, software GL.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { constellationAt, layoutUniverse, SLOT_COUNT, Slots } from '../web/src/home/universe/layout.ts';
import { FrameWatch } from '../web/src/home/universe/orbits.ts';
import { DEFAULT_MAP_LIMIT, mapKeys, MAX_MAP_LIMIT, projectParents } from '../web/src/home/universe/selection.ts';
import { LIBRARY_ICON_INK } from '../shared/contract.ts';
import { fixtureIcons, fixtureSettings } from './fixture-features.ts';
import { defaultFixture, startFixture, syntheticGraph, type Fixture, type FixtureServer } from './fixture-server.ts';

const row = (key: string, lastActivity: number | null, extra: object = {}) => ({ key, liveCount: 0, lastActivity, pinned: false, mapPin: null, ...extra });

test('over the limit the most recently active stay; by hand beats the clock; the core does not count', () => {
  const projects = [row('old', 1), row('new', 300), row('mid', 200), row('core', 50), row('asleep', 2, { liveCount: 1 })];
  const noted = new Set(['old', 'new', 'mid', 'core']);
  assert.deepEqual([...mapKeys(projects, noted, 'core', 2)].sort(), ['asleep', 'core', 'new'], 'a live session comes first, then the last activity');
  assert.deepEqual([...mapKeys(projects, noted, 'core', 100)].sort(), ['asleep', 'core', 'mid', 'new', 'old']);

  const pins = [row('old', 1, { mapPin: true }), row('new', 300, { mapPin: false }), row('mid', 200), row('core', 50)];
  assert.deepEqual([...mapKeys(pins, noted, 'core', 1)].sort(), ['core', 'old'], 'the one added by hand takes the place');
  assert.deepEqual([...mapKeys(pins, noted, 'core', 100)].sort(), ['core', 'mid', 'old'], 'the one removed by hand stays off, whatever happens in it');
  assert.ok(mapKeys([row('empty', 9)], [], null, 100).size === 0, 'a project with nothing to show holds no place unless asked');
  assert.ok(mapKeys([row('empty', 9, { mapPin: true })], [], null, 100).has('empty'));
  assert.ok(mapKeys([], ['no-row'], null, 100).has('no-row'), 'notes of a folder the journal does not know keep their place');
});

test('nesting comes from the paths alone: the nearest folder, and a shelf of projects is no parent', () => {
  const list = [
    { key: 'shelf', root: '/home/me/_projects', misc: true },
    { key: 'rival', root: '/home/me/_projects/studio', misc: false },
    { key: 'atlas', root: '/home/me/_projects/studio/atlas', misc: false },
    { key: 'deep', root: '/home/me/_projects/studio/atlas/tools/deep', misc: false },
    { key: 'rival2', root: '/home/me/_projects/studio-2', misc: false },
  ];
  const parents = projectParents(list);
  assert.equal(parents.get('atlas'), 'rival');
  assert.equal(parents.get('deep'), 'atlas');
  assert.equal(parents.has('rival2'), false, 'the same prefix is not the same folder');
  assert.equal(parents.has('rival'), false);
});

test('a hundred projects each get a place of their own, as many as the limit allows', () => {
  assert.ok(SLOT_COUNT >= MAX_MAP_LIMIT, `only ${SLOT_COUNT} places`);
  assert.ok(DEFAULT_MAP_LIMIT <= MAX_MAP_LIMIT);
  const names = Array.from({ length: MAX_MAP_LIMIT }, (_, i) => `p${i}`);
  const { constellations: list } = layoutUniverse(syntheticGraph(4000, names.slice(0, 100)));
  const places = names.map((k) => constellationAt(k, false, (() => { const s = new Slots(); s.placeAll(names); return s; })()));
  assert.equal(new Set(places.map((c) => `${c.x}|${c.z}`)).size, MAX_MAP_LIMIT, 'two projects share a place');
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const d = Math.hypot(list[i].x - list[j].x, list[i].z - list[j].z);
      assert.ok(d > (list[i].r + list[j].r) * 0.8, `${list[i].key} and ${list[j].key} overlap`);
    }
  }
});

test('falling behind the display is noticed, one hitch is not', () => {
  const feed = (w: FrameWatch, ms: number, n = 90) => {
    let out = false;
    for (let i = 0; i < n; i++) out = w.add(ms) || out;
    return out;
  };
  const steady = new FrameWatch();
  assert.equal(feed(steady, 8.3, 900), false);
  for (let i = 0; i < 5; i++) steady.add(200);
  assert.equal(feed(steady, 8.3, 900), false, 'a hitch');
  assert.equal(feed(steady, 17, 360), true, 'half of what this display can do, for long');
  const weak = new FrameWatch();
  feed(weak, 33, 90);
  assert.equal(feed(weak, 33, 90), true, 'never fast at all');
  const display60 = new FrameWatch();
  assert.equal(feed(display60, 16.7, 900), false, 'a 60 Hz display at full rate is fine');
});

// ---------- In a browser ----------

let browser: Browser | null = null;
let fx: FixtureServer | null = null;

afterEach(async () => {
  await browser?.close();
  await fx?.close();
  browser = null;
  fx = null;
  fixtureIcons.icons = {};
  fixtureIcons.chosen = {};
  fixtureSettings.universe = { limit: 100, theme: 'default', colors: {}, crossLinks: false, nesting: false };
});

const countDraws = () => {
  localStorage.setItem('claude-os.universe-quality', 'full');
  const w = window as unknown as { __blits: number; __clear: number[][] };
  w.__blits = 0;
  w.__clear = [];
  const real = WebGL2RenderingContext.prototype.drawArrays;
  WebGL2RenderingContext.prototype.drawArrays = function (...args: Parameters<typeof real>) {
    w.__blits++;
    return real.apply(this, args);
  };
  const copy = WebGL2RenderingContext.prototype.blitFramebuffer;
  WebGL2RenderingContext.prototype.blitFramebuffer = function (...args: Parameters<typeof copy>) {
    w.__blits++;
    return copy.apply(this, args);
  };
  const clear = WebGL2RenderingContext.prototype.clearColor;
  WebGL2RenderingContext.prototype.clearColor = function (r: number, g: number, b: number, a: number) {
    w.__clear.push([r, g, b]);
    return clear.call(this, r, g, b, a);
  };
};
const blits = (page: Page) => page.evaluate(() => (window as unknown as { __blits: number }).__blits);

async function open(data: Fixture, reduced = true, view?: unknown): Promise<Page> {
  fx = await startFixture(data);
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU', reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await ctx.addInitScript(countDraws);
  if (view) await ctx.addInitScript((v) => localStorage.setItem('claude-os.view', v), JSON.stringify(view));
  const page = await ctx.newPage();
  await page.goto(fx.url);
  if (!view) await page.locator('.u-label.on').first().waitFor({ timeout: 60000 });
  return page;
}

const menu = (page: Page) => page.locator('[data-context-menu]');
// The home camera looks at the core, so it is the middle of the window.
const CORE = { x: 800, y: 500 };
const clickItem = async (page: Page, name: string | RegExp) => {
  await page.mouse.click(CORE.x, CORE.y, { button: 'right' });
  await menu(page).getByRole('menuitem', { name }).click();
};
const puts = () => fx!.calls.filter((c) => c.path === '/api/settings/universe').map((c) => c.body);

function hundred(limit = 100): Fixture {
  const data = defaultFixture();
  const now = Date.now();
  const names = Array.from({ length: 100 }, (_, i) => `proj-${String(i).padStart(3, '0')}`);
  data.projects = names.map((name, i) => ({ key: name, name, root: `/home/test/${name}`, misc: false, sessionCount: 5, liveCount: i < 5 ? 1 : 0, lastActivity: now - i * 3_600_000, memoryCount: 3, memoryConnected: true, memoryDrift: 0, pinned: false, mapPin: null, description: null, color: null, parent: null, folder: false }));
  data.graph = syntheticGraph(1200, names);
  data.sessions = names.slice(0, 5).map((name, i) => ({ id: `s${i}`, project: name, cwd: `/home/test/${name}`, kind: 'interactive', origin: 'external', name: null, title: name, lastPrompt: null, firstActivity: now, lastActivity: now, status: 'working', pid: i + 1, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, subagents: [] }));
  data.tabs = data.tabs.filter((t) => t.kind === 'root');
  fixtureSettings.universe.limit = limit;
  return data;
}

const labelKeys = (page: Page) => page.locator('.u-labels').evaluate((root) => [...root.querySelectorAll<HTMLElement>('.u-label[data-project]')].map((e) => e.dataset.project!));

test('the limit keeps the most recently active on the map, the row menu adds and removes, the Settings field changes it', async () => {
  const page = await open(hundred(10));
  await page.waitForFunction(() => document.querySelectorAll('.u-label[data-project]').length > 0);
  const keys = await labelKeys(page);
  assert.ok(keys.length <= 11, `${keys.length} names on a map limited to 10`);
  assert.ok(!keys.includes('proj-050'), 'a project asleep for two days has no place');

  const row = page.locator('aside').getByText('proj-050', { exact: true }).first();
  await row.scrollIntoViewIfNeeded();
  await row.click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Добавить на карту' }).click();
  await page.waitForFunction(() => document.querySelector('.u-label[data-project="proj-050"]'));
  assert.deepEqual(fx!.calls.filter((c) => c.path === '/api/projects/proj-050/map').map((c) => c.body), [{ on: true }]);

  await row.click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Убрать с карты' }).click();
  await page.waitForFunction(() => !document.querySelector('.u-label[data-project="proj-050"]'));
  assert.deepEqual(fx!.calls.filter((c) => c.path === '/api/projects/proj-050/map').at(-1)!.body, { on: false });
});

test('Settings: the limit is saved, the count of what stands on the map follows', async () => {
  const page = await open(hundred(10), true, { kind: 'settings', section: 'projects' });
  const field = page.getByRole('spinbutton', { name: 'Лимит проектов на карте' });
  await field.waitFor();
  assert.equal(await field.inputValue(), '10');
  await page.getByText('Сейчас на карте: 10 из 99').waitFor();
  await field.fill('3');
  await field.press('Enter');
  await page.getByText('Сейчас на карте: 3 из 99').waitFor();
  assert.deepEqual(puts().at(-1), { limit: 3 });
  await page.getByRole('button', { name: 'Настроить через Claude' }).waitFor();
});

test('Settings: the theme is picked by its picture and changes the sky, a theme drops own colours', async () => {
  const page = await open(defaultFixture(), true, { kind: 'settings', section: 'general' });
  const group = page.getByRole('radiogroup', { name: 'Тема космоса' });
  await group.waitFor();
  assert.equal(await group.getByRole('radio').count(), 4);
  assert.equal(await group.getByRole('radio', { name: 'Стандартная' }).isChecked(), true);
  await group.getByText('Янтарь').click();
  await group.locator('label', { hasText: 'Янтарь' }).locator('input:checked').waitFor({ state: 'attached' });
  assert.deepEqual(puts().at(-1), { theme: 'ember' });
  const ember = [0.02, 0.011, 0.01];
  await page.waitForFunction((bg) => (window as unknown as { __clear: number[][] }).__clear.some((c) => Math.abs(c[0] - bg[0]) < 1e-6 && Math.abs(c[1] - bg[1]) < 1e-6), ember, { timeout: 60000 });

  assert.equal(await group.locator('button, input[type=color]').count(), 0, 'presets only: no colour picker');

  await group.getByText('Сияние').click();
  await group.locator('label', { hasText: 'Сияние' }).locator('input:checked').waitFor({ state: 'attached' });
  assert.deepEqual(puts().at(-1), { theme: 'aurora' });

  await page.getByRole('checkbox', { name: 'Выключено' }).first().click();
  await page.locator('input[type=checkbox]:checked').first().waitFor({ state: 'attached' });
  assert.deepEqual(puts().at(-1), { crossLinks: true });
});

test('the core\'s menu: no themes, no colours; both optional views off by default and switched from it', async () => {
  const data = defaultFixture();
  data.projects[2].root = `${data.projects[0].root}/inner`;
  // A link across two projects.
  const a = data.graph.nodes.find((n) => n.project === data.projects[0].key)!;
  const b = data.graph.nodes.find((n) => n.project === data.projects[1].key)!;
  data.graph.edges.push([a.id, b.id]);
  const page = await open(data);
  assert.equal(fixtureSettings.universe.crossLinks, false);
  assert.equal(fixtureSettings.universe.nesting, false);

  await page.mouse.click(CORE.x, CORE.y, { button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Изменить с Claude' }).waitFor();
  const items = await menu(page).getByRole('menuitem').allTextContents();
  assert.ok(!items.some((i) => /Тема|Янтарь|Сияние|Монохром|Свои цвета/.test(i)), `themes or colours in the menu: ${items}`);
  await page.keyboard.press('Escape');

  const label = page.locator(`.u-label[data-project="${data.projects[2].key}"]`);
  assert.equal(await label.evaluate((e) => e.classList.contains('nested')), false, 'nesting is off by default');
  await clickItem(page, 'Вложенность проектов');
  assert.deepEqual(puts().at(-1), { nesting: true });
  await page.waitForFunction((k) => document.querySelector(`.u-label[data-project="${k}"]`)?.classList.contains('nested'), data.projects[2].key);
  assert.equal(await label.getAttribute('title'), `${data.projects[0].name} / ${data.projects[2].name}`);

  const lit = () => page.locator('canvas[data-universe]').evaluate((c: HTMLCanvasElement) => new Promise<number>((resolve) => {
    // Forces a frame and reads it in the same task it was drawn in.
    c.dispatchEvent(new PointerEvent('pointermove', { clientX: 5, clientY: 5, bubbles: true }));
    requestAnimationFrame(() => {
      const copy = document.createElement('canvas');
      copy.width = c.width;
      copy.height = c.height;
      const g = copy.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(c, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height).data;
      let warm = 0;
      for (let i = 0; i < d.length; i += 4) if (d[i] > 150 && d[i] > d[i + 2] + 40) warm++;
      resolve(warm);
    });
  }));
  await page.waitForTimeout(600);
  const before = await lit();
  await clickItem(page, 'Связи между проектами');
  assert.deepEqual(puts().at(-1), { crossLinks: true });
  await page.waitForTimeout(800);
  const after = await lit();
  assert.ok(after > before, `the link between projects lights up: ${before} -> ${after}`);

  await clickItem(page, 'Настроить через Claude');
  const ask = page.getByRole('dialog', { name: 'Настроить карту проектов' });
  await ask.getByRole('textbox').fill('только за месяц');
  await ask.getByRole('textbox').press('Enter');
  await ask.waitFor({ state: 'detached' });
  const sent = fx!.calls.filter((c) => c.path === '/api/service/tasks' && c.method === 'POST').at(-1)!.body as { prompt: string };
  assert.match(sent.prompt, /set_project_map/);
  assert.match(sent.prompt, /alpha-service: last activity /);
});

test('a badge shows the mark of the project list: the same icon in the same colour, no ring, a monogram without an icon; a live one has a dot after its name', async () => {
  fixtureIcons.icons = { 'alpha-service': '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" fill="#fff"/></svg>' };
  const page = await open(defaultFixture());
  const iconed = page.locator('.u-label[data-project="alpha-service"] i.u-icon img');
  await iconed.waitFor({ state: 'attached' });
  assert.match((await iconed.getAttribute('src'))!, /^data:image\/svg\+xml/);
  const mark = page.locator('.u-label[data-project="alpha-service"] i');
  assert.notEqual(await mark.evaluate((e) => getComputedStyle(e).getPropertyValue('--dot')), '');
  assert.ok(await page.locator('.u-label.live[data-project="alpha-service"]').count(), 'still marked live');
  assert.equal(await mark.evaluate((e) => getComputedStyle(e).boxShadow), 'none', 'no ring');
  assert.equal(await page.locator('.u-label[data-project="beta-web"] i img').count(), 0);
  assert.equal(await page.locator('.u-label[data-project="beta-web"] i').innerText(), 'B', 'a monogram, as in the list');
  const dot = () => page.locator('.u-label.live[data-project="alpha-service"]').evaluate((e) => getComputedStyle(e, '::after').width);
  assert.equal(await dot(), '5px', 'live: a dot after the name');
});

test('a library icon on the map is painted in the colour its row in the list has', async () => {
  fixtureIcons.icons = { 'beta-web': `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${LIBRARY_ICON_INK}"><path d="M4 4h16"/></svg>` };
  fixtureIcons.chosen = { 'beta-web': 'minus' };
  const page = await open(defaultFixture());
  const onMap = page.locator('.u-label[data-project="beta-web"] i.u-icon img');
  await onMap.waitFor({ state: 'attached' });
  const inList = page.locator('aside').locator('button', { hasText: 'beta-web' }).locator('img').first();
  await inList.waitFor();
  assert.equal(await onMap.getAttribute('src'), await inList.getAttribute('src'));
  assert.ok(!decodeURIComponent((await onMap.getAttribute('src'))!).includes(LIBRARY_ICON_INK), 'still in the ink of the server');
});

test('a central star answers like its project\'s name, even when the name is not shown', async () => {
  const page = await open(hundred());
  await page.waitForTimeout(800);
  // Where the stars are comes from the map itself: only over one does the pointer change at once.
  const hits = await page.locator('canvas[data-universe]').evaluate((c: HTMLCanvasElement) => {
    const found: [number, number][] = [];
    for (let y = 140; y < 900; y += 8) {
      for (let x = 320; x < 1280; x += 8) {
        c.style.cursor = 'grab';
        c.dispatchEvent(new PointerEvent('pointermove', { clientX: x, clientY: y, bubbles: true }));
        if (c.style.cursor === 'pointer' && !found.some(([a, b]) => Math.hypot(a - x, b - y) < 30)) found.push([x + 4, y + 4]);
      }
    }
    return found;
  });
  assert.ok(hits.length > 30, `${hits.length} central stars found`);
  const pop = page.locator('[data-project-popover]');
  let key = '';
  let at: [number, number] = [0, 0];
  for (const [x, y] of hits) {
    await page.mouse.move(120, 960);
    await pop.waitFor({ state: 'detached' });
    await page.mouse.move(x, y, { steps: 2 });
    await pop.waitFor();
    const name = /proj-\d+/.exec(await pop.getAttribute('aria-label') ?? await pop.innerText())?.[0];
    if (!name || name === 'proj-099') continue;
    if (await page.locator(`.u-label.on[data-project="${name}"]`).count()) continue;
    key = name;
    at = [x, y];
    break;
  }
  assert.ok(key, 'every star found has its name on the map');
  await page.mouse.click(at[0], at[1]);
  await page.locator(`.u-label.on.hot[data-project="${key}"]`).waitFor({ state: 'attached' });
  await page.locator('.u-label-note.on').first().waitFor();
});

test('nothing burns out: at any distance the largest white blot of the map stays a few stars wide', async () => {
  const data = hundred();
  // Everything in three projects: as dense as a cluster gets.
  data.graph = syntheticGraph(1200, data.projects.slice(0, 3).map((p) => p.key));
  const page = await open(data);
  const blot = () => page.locator('canvas[data-universe]').evaluate((c: HTMLCanvasElement) => new Promise<number>((resolve) => {
    c.dispatchEvent(new PointerEvent('pointermove', { clientX: 5, clientY: 5, bubbles: true }));
    requestAnimationFrame(() => {
      const copy = document.createElement('canvas');
      copy.width = c.width;
      copy.height = c.height;
      const g = copy.getContext('2d', { willReadFrequently: true })!;
      g.drawImage(c, 0, 0);
      const { data: d, width: w } = g.getImageData(0, 0, c.width, c.height);
      const hot = new Uint8Array(d.length / 4);
      for (let i = 0; i < hot.length; i++) hot[i] = Math.min(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]) > 225 ? 1 : 0;
      let most = 0;
      const stack: number[] = [];
      for (let i = 0; i < hot.length; i++) {
        if (!hot[i]) continue;
        let n = 0;
        hot[i] = 0;
        stack.push(i);
        while (stack.length) {
          const p = stack.pop()!;
          n++;
          for (const q of [p - 1, p + 1, p - w, p + w]) if (q >= 0 && q < hot.length && hot[q]) (hot[q] = 0), stack.push(q);
        }
        most = Math.max(most, n);
      }
      resolve(most);
    });
  }));
  await page.mouse.move(1000, 40);
  await page.waitForTimeout(1500);
  assert.ok((await blot()) < 200, `home view: a blot of ${await blot()} pixels`);
  await page.mouse.move(800, 500);
  for (let i = 0; i < 14; i++) await page.mouse.wheel(0, 300);
  await page.mouse.move(1000, 40);
  await page.waitForTimeout(1500);
  assert.ok((await blot()) < 200, `far away: a blot of ${await blot()} pixels`);
});

test('a modal over the map stops the satellites, closing it brings them back; off-screen idle stays idle', async () => {
  const page = await open(defaultFixture(), false);
  await page.waitForFunction(() => (window as unknown as { __blits: number }).__blits > 5, undefined, { timeout: 60000 });
  await page.waitForTimeout(2500);
  const running = await blits(page);
  await page.waitForFunction((n) => (window as unknown as { __blits: number }).__blits > n + 2, running, { timeout: 60000 });

  await page.keyboard.press('Control+KeyK');
  await page.locator('[data-covers-map]').waitFor({ state: 'attached' });
  await page.waitForTimeout(1500);
  const covered = await blits(page);
  await page.waitForTimeout(2500);
  assert.equal(await blits(page), covered, 'drawing behind a modal');

  await page.keyboard.press('Escape');
  await page.locator('[data-covers-map]').waitFor({ state: 'detached' });
  await page.waitForFunction((n) => (window as unknown as { __blits: number }).__blits > n + 2, covered, { timeout: 60000 });
});

test('a star\'s card stays on its star while the camera moves, with its thread, and the loop stops when it has settled', async () => {
  const data = defaultFixture();
  const page = await open(data);
  await page.locator('aside').getByText('alpha-service', { exact: true }).first().click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Показать на карте' }).click();
  const label = page.locator('.u-label-note.on', { hasText: 'note_alpha-service' }).first();
  await label.waitFor();
  await page.waitForTimeout(500);
  const box = (await label.boundingBox())!;
  await page.mouse.move(box.x - 8, box.y + box.height / 2);
  const tip = page.getByRole('tooltip');
  await tip.waitFor();
  await page.waitForTimeout(300);
  const noteId = await label.getAttribute('data-note');
  const pair = () => page.evaluate((id) => {
    const t = document.querySelector('.u-tip')!.getBoundingClientRect();
    const n = document.querySelector(`.u-label-note[data-note="${id}"]`)!.getBoundingClientRect();
    const line = document.querySelector<HTMLElement>('.u-leader.on');
    return { tx: t.left, ty: t.top, tw: t.width, nx: n.left, ny: n.top, leader: line?.style.transform ?? '' };
  }, noteId);
  const start = await pair();
  assert.match(start.leader, /translate3d/, 'the thread is there');
  const offset = start.tx - start.nx;
  // Pointer pressed on empty sky is not needed: arrows pan the camera and leave the pointer where it is.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down('KeyD');
  await page.waitForTimeout(500);
  await page.keyboard.up('KeyD');
  await page.waitForTimeout(500);
  const moved = await pair();
  assert.ok(Math.hypot(moved.nx - start.nx, moved.ny - start.ny) > 30, 'the camera did not move');
  assert.ok(await tip.isVisible(), 'the card closed when the object moved away from the pointer');
  assert.ok(Math.abs(moved.tx - moved.nx - offset) < 60 || moved.tx < 20 || moved.tx + moved.tw > 1580, `the card stayed behind: ${JSON.stringify({ start, moved })}`);
  assert.notEqual(moved.leader, start.leader, 'the thread follows');
  // The camera's easing may still have a frame to go: first it has to stop within a few seconds, then stay stopped.
  await page.waitForTimeout(500);
  const settled = await blits(page);
  await page.waitForTimeout(1500);
  // A running loop draws dozens of frames here. One is a data refresh landing in the window, not a loop.
  assert.ok((await blits(page)) - settled <= 1, 'a settled card keeps the loop running');
});

test('a project card travels with its constellation and keeps its place while the pointer is inside', async () => {
  const page = await open(defaultFixture());
  await page.locator('aside').getByText('alpha-service', { exact: true }).first().click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: 'Показать на карте' }).click();
  const badge = page.locator('.u-label.on[data-project="alpha-service"]');
  await badge.waitFor();
  await page.waitForTimeout(500);
  await badge.hover();
  const pop = page.getByRole('dialog', { name: /Проект alpha-service/ });
  await pop.waitFor();
  const a = (await pop.boundingBox())!;
  assert.match((await pop.getAttribute('style'))!, /transform/, 'the map places it');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.down('KeyA');
  await page.waitForTimeout(250);
  await page.keyboard.up('KeyA');
  await page.waitForTimeout(400);
  const b = (await pop.boundingBox())!;
  assert.ok(Math.abs(b.x - a.x) > 15, `the card stayed put: ${a.x} -> ${b.x}`);
  await pop.waitFor();
});

test('the right button: only the core has a menu, whichever way the events come; a click anywhere else does nothing', async () => {
  const data = defaultFixture();
  const page = await open(data);
  const click = async (x: number, y: number) => {
    await page.mouse.move(x, y);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(x + 3, y + 2); // a trembling hand
    await page.mouse.up({ button: 'right' });
  };
  for (const [x, y] of [[500, 700], [1100, 700], [800, 200], [420, 300]]) {
    await click(x, y);
    await page.waitForTimeout(150);
    assert.equal(await menu(page).count(), 0, `a menu at ${x},${y}`);
  }
  // A project's badge and a star: the same nothing. Their actions live in the popover and on the left click.
  const badge = page.locator('.u-label.on[data-project]:not(.core)').first();
  await badge.click({ button: 'right' });
  await page.waitForTimeout(150);
  assert.equal(await menu(page).count(), 0, 'a badge opened a menu');
  await page.mouse.move(120, 960);
  await page.locator('[data-project-popover]').waitFor({ state: 'detached' });

  await click(CORE.x, CORE.y);
  await menu(page).getByRole('menuitem', { name: 'Изменить с Claude' }).waitFor();
  assert.deepEqual(await menu(page).getByRole('menuitem').allTextContents(), [
    'Создать виджет', 'Создать из .md', 'Связи между проектами', 'Вложенность проектов', 'Настроить через Claude', 'Изменить с Claude', 'Вопрос Claude',
    'Проекты', 'Аналитика', 'Канбан', 'Документы', 'Инструменты', 'Плагины Claude OS', 'Настройки', 'Агенты', 'Планер',
  ]);
  await page.keyboard.press('Escape');
  await menu(page).waitFor({ state: 'detached' });
  // Its name is the core too.
  await page.locator('.u-label.core.on').click({ button: 'right' });
  await menu(page).waitFor();
  await page.keyboard.press('Escape');
  await menu(page).waitFor({ state: 'detached' });

  // The order Windows uses: the menu event after the release. Still one menu, and only one, and only on the core.
  const canvas = page.locator('canvas[data-universe]');
  const contextEvent = (x: number, y: number, button: number) => canvas.evaluate((c, a) => void c.dispatchEvent(new MouseEvent('contextmenu', { clientX: a.x, clientY: a.y, button: a.button, bubbles: true, cancelable: true })), { x, y, button });
  await page.mouse.move(600, 650);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await contextEvent(600, 650, 2);
  assert.equal(await menu(page).count(), 0);
  await page.mouse.move(CORE.x, CORE.y);
  await page.mouse.down({ button: 'right' });
  await page.mouse.up({ button: 'right' });
  await contextEvent(CORE.x, CORE.y, 2);
  assert.equal(await menu(page).count(), 1);
  await page.keyboard.press('Escape');
  await menu(page).waitFor({ state: 'detached' });
  // A press whose release never came does not take the button away for good.
  await canvas.evaluate((c) => c.parentElement!.dispatchEvent(new PointerEvent('pointercancel', { pointerId: 1, bubbles: true })));
  await page.mouse.click(CORE.x, CORE.y, { button: 'right' });
  await menu(page).waitFor();
  await page.keyboard.press('Escape');
  await menu(page).waitFor({ state: 'detached' });
  // The menu key has no pointer: it opens the same menu, at the core.
  await contextEvent(20, 20, 0);
  const at = (await menu(page).boundingBox())!;
  // At the core, or lifted just enough to fit: this menu is taller than the room under the core.
  assert.ok(Math.abs(at.x - CORE.x) < 3 && at.y <= CORE.y + 3 && at.y + at.height <= 1000, `at ${at.x},${at.y}`);
  await menu(page).getByRole('menuitem', { name: 'Настройки' }).click();
  await page.getByRole('radiogroup', { name: 'Тема космоса' }).waitFor();
});

test('a project stays within reach: the popover of its badge has all its actions', async () => {
  const page = await open(defaultFixture());
  const badge = page.locator('.u-label.on[data-project]:not(.core)').first();
  const key = (await badge.getAttribute('data-project'))!;
  await badge.hover();
  const pop = page.getByRole('dialog', { name: new RegExp(`Проект ${key}`) });
  await pop.getByRole('heading').click({ button: 'right' });
  const items = await menu(page).getByRole('menuitem').allTextContents();
  for (const item of ['Новая сессия', 'Показать на карте', 'Убрать с карты', 'Терминал в папке проекта', 'Открыть в IDE', 'Скопировать путь', 'Изменить с Claude', 'Вопрос Claude', 'Убрать из памяти Claude']) assert.ok(items.includes(item), item);
  await menu(page).getByRole('menuitem', { name: 'Убрать с карты' }).click();
  await menu(page).waitFor({ state: 'detached' });
  await page.waitForTimeout(100);
  assert.deepEqual(fx!.calls.filter((c) => c.path === `/api/projects/${key}/map`).map((c) => c.body), [{ on: false }]);
});

test('a thrown map glides on and runs out softly, a placed one stays where the hand left it, and neither loses the galaxy', async () => {
  const page = await open(defaultFixture(), false);
  await page.waitForTimeout(1500);
  const coreX = () => page.evaluate(() => Number(/translate3d\(([-\d.]+)px/.exec(document.querySelector<HTMLElement>('.u-label.core')!.style.transform)?.[1]));
  const settled = () => page.evaluate(() => new Promise<void>((res) => {
    const el = document.querySelector<HTMLElement>('.u-label.core')!;
    let was = '';
    let same = 0;
    const look = () => {
      same = el.style.transform === was ? same + 1 : 0;
      was = el.style.transform;
      if (same >= 5) res();
      else setTimeout(look, 500);
    };
    look();
  }));
  await settled();
  // A slow renderer delays real events past any throw: the moves are made on the page, at the pace of a hand, and only the press is real.
  const stroke = async (hold: number) => {
    await page.mouse.move(1000, 620);
    await page.mouse.down({ button: 'right' });
    await page.evaluate(async (wait) => {
      const stage = document.querySelector('canvas[data-universe]')!;
      const send = (type: string, x: number) => stage.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: 620, button: 2, bubbles: true }));
      for (let x = 980; x >= 900; x -= 20) {
        send('pointermove', x);
        await new Promise((r) => setTimeout(r, 16));
      }
      await new Promise((r) => setTimeout(r, wait));
      send('pointerup', 900);
    }, hold);
    await page.mouse.up({ button: 'right' });
    await settled();
  };
  const start = await coreX();
  await stroke(300); // the hand stopped
  const placed = await coreX();
  assert.ok(Math.abs(placed - start + 100) < 25, `a placed pan went ${placed - start}`);

  await stroke(0);
  const thrown = await coreX();
  assert.ok(placed - thrown > 180, `a throw went only ${placed - thrown}`);

  for (let i = 0; i < 6; i++) {
    await page.mouse.move(1100, 620);
    await page.mouse.down({ button: 'right' });
    await page.mouse.move(500, 620, { steps: 4 });
    await page.mouse.up({ button: 'right' });
    await page.waitForTimeout(150);
  }
  await settled();
  assert.ok(await page.locator('.u-label.on').count() > 0, 'nothing of the map is left in sight');
});

test('the wheel keeps the point under the pointer still, however many ticks come in a row', async () => {
  const page = await open(defaultFixture(), false);
  await page.waitForTimeout(1500);
  const coreX = () => page.evaluate(() => Number(/translate3d\(([-\d.]+)px/.exec(document.querySelector<HTMLElement>('.u-label.core')!.style.transform)?.[1]));
  const pointer = 1000;
  const before = await coreX();
  await page.mouse.move(pointer, 500);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, -100);
  await page.waitForTimeout(4000);
  const after = await coreX();
  const ratio = (pointer - after) / (pointer - before);
  const expected = Math.exp(4 * 100 * 0.0011);
  assert.ok(Math.abs(ratio - expected) < expected * 0.12, `offset grew ${ratio}, the zoom was ${expected}`);
});

test('a held right drag pans in one direction without a kink and opens no menu', async () => {
  const page = await open(defaultFixture(), false);
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.u-label.core')!;
    const out: number[] = [];
    (window as unknown as { __track: number[] }).__track = out;
    const look = () => {
      const m = /translate3d\(([-\d.]+)px/.exec(el.style.transform);
      if (m) out.push(Number(m[1]));
      requestAnimationFrame(look);
    };
    requestAnimationFrame(look);
  });
  await page.mouse.move(800, 620);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(600, 620, { steps: 30 });
  await page.mouse.up({ button: 'right' });
  await page.waitForTimeout(1500);
  assert.equal(await menu(page).count(), 0, 'a right drag opened the menu');
  const track = await page.evaluate(() => (window as unknown as { __track: number[] }).__track);
  const steps = track.slice(1).map((v, i) => v - track[i]).filter((d) => d !== 0);
  assert.ok(track.at(-1)! < track[0] - 100, `the map did not follow: ${track[0]} -> ${track.at(-1)}`);
  assert.ok(steps.every((d) => d < 1), `the pan went back and forth: ${steps.filter((d) => d >= 1)}`);
});

test('the core pulses while the root session works and rests when it goes idle', async () => {
  const data = defaultFixture();
  for (const x of data.sessions) x.status = 'ended';
  for (const p of data.projects) p.liveCount = 0;
  const page = await open(data, false);
  const settle = async () => {
    let last = -1;
    for (let i = 0; i < 60; i++) {
      await page.waitForTimeout(1500);
      const n = await blits(page);
      if (n === last) return n;
      last = n;
    }
    throw new Error('still drawing');
  };
  const quiet = await settle();
  data.tabs.find((x) => x.kind === 'root')!.status = 'working';
  fx!.push({ t: 'invalidate', topics: ['tabs'] });
  await page.waitForFunction((n) => (window as unknown as { __blits: number }).__blits > n + 3, quiet, { timeout: 60000 });
  data.tabs.find((x) => x.kind === 'root')!.status = 'idle';
  fx!.push({ t: 'invalidate', topics: ['tabs'] });
  await settle();
});

test('the map lets the pointer through by a class on body: a :has() there recalculates the whole page on every keystroke', async () => {
  const page = await open(defaultFixture());
  assert.equal(await page.evaluate(() => document.body.classList.contains('on-home')), true);
  const broad = await page.evaluate(() => [...document.styleSheets].flatMap((s) => [...s.cssRules]).map((r) => (r as CSSStyleRule).selectorText ?? '').filter((x) => x.includes(':has(') && x.includes('on-home')));
  assert.deepEqual(broad, []);
  await page.getByRole('button', { name: 'Сессии', exact: true }).click();
  await page.waitForFunction(() => !document.body.classList.contains('on-home'));
});

test('a resting pointer and a resting camera write nothing to the names on the map', async () => {
  const page = await open(defaultFixture(), false);
  await page.mouse.move(900, 300);
  await page.waitForTimeout(3000);
  const writes = await page.evaluate(() => new Promise<number>((resolve) => {
    let n = 0;
    const seen = new MutationObserver((list) => (n += list.length));
    for (const el of document.querySelectorAll('.u-label')) seen.observe(el, { attributes: true, attributeFilter: ['style'] });
    setTimeout(() => {
      seen.disconnect();
      resolve(n);
    }, 2000);
  }));
  assert.equal(writes, 0, 'the labels are rewritten every frame');
});
