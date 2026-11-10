// UI tests against e2e/fixture-server.ts: no real server, no Claude. Requires `npm run build` first.
import assert from 'node:assert/strict';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { defaultFixture, emptyFixture, homeButton, startFixture, tokens, type Fixture, type FixtureServer } from './fixture-server.ts';

let browser: Browser;
let ctx: BrowserContext | null = null;
let fx: FixtureServer | null = null;
let errors: string[] = [];

before(async () => {
  // Software WebGL, so the universe really renders here.
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});
after(async () => {
  await browser.close();
});
beforeEach(() => {
  errors = [];
});
afterEach(async () => {
  await ctx?.close();
  await fx?.close();
  ctx = null;
  fx = null;
});

// Reduced motion by default: the universe draws on demand and a software renderer does not starve the tests.
async function open(data?: Fixture, locale = 'ru-RU', view?: unknown, opts: { motion?: boolean; width?: number; height?: number; init?: () => void } = {}): Promise<Page> {
  fx = await startFixture(data ?? defaultFixture());
  ctx = await browser.newContext({ viewport: { width: opts.width ?? 1600, height: opts.height ?? 1000 }, locale, reducedMotion: opts.motion ? 'no-preference' : 'reduce' });
  await ctx.addInitScript(() => { if (localStorage.getItem('claude-os.focus') === null) localStorage.setItem('claude-os.focus', '0'); }); // these tests read the full tool output; focus has its own in commands.test.ts
  if (view) await ctx.addInitScript((v) => localStorage.setItem('claude-os.view', v), JSON.stringify(view));
  if (opts.init) await ctx.addInitScript(opts.init);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  return page;
}

const openTab = (id: string) => ({ kind: 'tab', id });

test('home shows real data, the universe draws, no page errors', async () => {
  const page = await open(undefined, 'ru-RU', undefined, { motion: true, init: () => localStorage.setItem('claude-os.universe-quality', 'full') });
  await page.locator('aside').getByText('alpha-service', { exact: true }).first().waitFor();
  await page.getByRole('group', { name: 'Заметки' }).locator('b').getByText('162', { exact: true }).waitFor();
  await page.getByText('Opus 5.5').waitFor();
  // The drawing buffer is only readable in the frame it was drawn in, so this reads inside requestAnimationFrame.
  const painted = await page.locator('canvas[data-universe]').evaluate(
    (c: HTMLCanvasElement) =>
      new Promise<number>((resolve) => {
        const copy = document.createElement('canvas');
        copy.width = c.width;
        copy.height = c.height;
        const g = copy.getContext('2d')!;
        const started = performance.now();
        const look = () => {
          g.drawImage(c, 0, 0);
          const d = g.getImageData(0, 0, c.width, c.height).data;
          let lit = 0;
          for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 60) lit++;
          if (lit > 200 || performance.now() - started > 20000) resolve(lit);
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      }),
  );
  assert.ok(painted > 200, `universe painted only ${painted} pixels`);
  assert.deepEqual(errors, []);
});

test('universe: the picture survives camera moves with reduced motion', async () => {
  const page = await open();
  await page.locator('.u-label.on').first().waitFor();
  await page.waitForTimeout(800);
  const before = (await page.screenshot()).length;
  await page.mouse.move(860, 500);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(700, 420, { steps: 3 });
  await page.mouse.up({ button: 'right' });
  await page.mouse.wheel(0, -120);
  await page.waitForTimeout(800);
  // A blank canvas compresses to a fraction of a starry one.
  const after = (await page.screenshot()).length;
  assert.ok(after > before * 0.5, `the canvas went blank: ${before} -> ${after} bytes`);
});

// A row opens the project; flying to it on the map is an item of its menu.
async function projectMenu(page: Page, key: string) {
  await page.locator('aside').getByText(key, { exact: true }).first().click({ button: 'right' });
  const menu = page.locator('[data-context-menu]');
  await menu.waitFor();
  return menu;
}

async function flyTo(page: Page, key: string) {
  await (await projectMenu(page, key)).getByRole('menuitem', { name: 'Показать на карте' }).click();
}

const noOverlap = (boxes: { x: number; y: number; width: number; height: number }[]) => {
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y) return false;
    }
  }
  return true;
};

test('universe: names do not collide, a project lights up and the camera flies to it', async () => {
  const page = await open();
  const onLabels = page.locator('.u-label.on');
  await onLabels.first().waitFor();
  await page.waitForTimeout(400);
  const before = await onLabels.evaluateAll((els) => els.map((e) => e.getBoundingClientRect().toJSON()));
  assert.ok(before.length > 1, 'expected several project names on the map');
  assert.ok(noOverlap(before), 'project names overlap');

  const row = page.locator('aside').getByText('alpha-service', { exact: true }).first();
  await row.hover();
  await page.locator('.u-label.hot[data-project]').waitFor({ state: 'attached' });
  assert.ok((await page.locator('.u-label.on.dim').count()) > 0, 'other names should dim while a project is lit');

  assert.equal(await page.locator('.u-label-note.on').count(), 0, 'note titles are for close-ups only');
  await flyTo(page, 'alpha-service');
  await page.locator('.u-label-note.on').first().waitFor();
  assert.deepEqual(errors, []);
});

test('universe: hover says what the note is about, click opens it', async () => {
  const data = defaultFixture();
  const page = await open(data);
  await flyTo(page, 'alpha-service');
  // Its own note: a neighbour's title may stand at the edge of the view, under the title bar.
  const own = page.locator('.u-label-note.on', { hasText: 'note_alpha-service' }).first();
  await own.waitFor();
  const label = await own.boundingBox();
  // A note title sits right next to its star.
  await page.mouse.move(label!.x - 8, label!.y + label!.height / 2);
  const tip = page.getByRole('tooltip');
  await tip.waitFor();
  const text = await tip.innerText();
  const node = data.graph.nodes.find((n) => text.includes(n.title));
  assert.ok(node, `tip shows something that is not a note: ${text}`);
  if (node.summary) assert.ok(text.includes(node.summary), 'the tip shows the real summary');
  await page.mouse.down();
  await page.mouse.up();
  await page.getByRole('complementary', { name: 'Заметка памяти' }).waitFor();
  assert.deepEqual(errors, []);
});

test('universe: empty sky is not data, search dims the rest', async () => {
  const page = await open();
  await page.locator('.u-label.on').first().waitFor();
  // Corner of the window: only decorative dust lives there.
  await page.mouse.move(340, 900);
  await page.waitForTimeout(300);
  assert.equal(await page.getByRole('tooltip').count(), 0);
  await page.getByRole('textbox', { name: 'Поиск по заметкам' }).fill('note_alpha');
  await page.getByText(/^Найдено: \d+/).waitFor();
  await page.locator('.u-label.on.dim').first().waitFor();
});

test('universe: the core is labelled Claude OS; project badges carry their own colours', async () => {
  const page = await open();
  await page.locator('.u-label.core.on', { hasText: 'Claude OS' }).waitFor();
  const dots = await page.locator('.u-label.on[data-project] i').evaluateAll((els) => els.map((e) => getComputedStyle(e).backgroundColor));
  assert.ok(dots.length > 2);
  assert.equal(new Set(dots).size, dots.length, `colours repeat: ${dots}`);
  // Live or not is opacity of the same colour, nothing else.
  const live = await page.locator('.u-label.live[data-project="alpha-service"] i').evaluate((e) => getComputedStyle(e).opacity);
  const idle = await page.locator('.u-label.on:not(.live):not(.core)[data-project] i').first().evaluate((e) => getComputedStyle(e).opacity);
  assert.equal(live, '1');
  assert.equal(idle, '0.55', 'the same as an idle row in the project list');
});

const countDraws = () => {
  localStorage.setItem('claude-os.universe-quality', 'full');
  const w = window as unknown as { __draws: number; __largest: number };
  w.__draws = 0;
  w.__largest = 0;
  const real = WebGL2RenderingContext.prototype.drawArraysInstanced;
  WebGL2RenderingContext.prototype.drawArraysInstanced = function (...args: Parameters<typeof real>) {
    w.__draws++;
    return real.apply(this, args);
  };
  const plain = WebGL2RenderingContext.prototype.drawArrays;
  WebGL2RenderingContext.prototype.drawArrays = function (...args: Parameters<typeof plain>) {
    if (args[0] === this.POINTS) w.__largest++; // the dust: only ever drawn into the cached scene
    return plain.apply(this, args);
  };
};

const metrics = (page: Page) => page.evaluate(() => {
  const w = window as unknown as { __draws: number; __largest: number };
  return { draws: w.__draws, dust: w.__largest };
});

// A loop that keeps running never gets here. Four quiet seconds, because a loaded software renderer lands frames late.
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

test('universe: with nothing live a still map draws nothing; input draws; other screens stop', async () => {
  const data = defaultFixture();
  for (const s of data.sessions) s.status = 'ended';
  for (const p of data.projects) p.liveCount = 0;
  const page = await open(data, 'ru-RU', undefined, { motion: true, init: countDraws });
  await page.locator('aside').getByText('alpha-service', { exact: true }).first().waitFor();
  const still = await quiet(page, 'a still Home');

  await page.mouse.move(860, 460);
  await page.mouse.wheel(0, -200);
  await page.waitForFunction((n) => (window as unknown as { __draws: number }).__draws > n, still, { timeout: 20000 });

  await page.getByRole('button', { name: 'Сессии', exact: true }).click();
  await page.locator('.universe-stage.is-still').waitFor({ state: 'attached' });
  await quiet(page, 'off Home');
});

test('universe: satellites of live projects keep moving without redrawing the scene, and stop off Home', async () => {
  const page = await open(undefined, 'ru-RU', undefined, { motion: true, init: countDraws });
  await page.locator('aside').getByText('alpha-service', { exact: true }).first().waitFor();
  // The stars finish fading in, then only the satellites are left: frames go on, the dust is not drawn again.
  await page.waitForFunction(() => (window as unknown as { __largest: number }).__largest > 0, undefined, { timeout: 30000 });
  // How long the fade takes depends on the machine. A scene that kept redrawing would never get past this.
  let settled = (await metrics(page)).dust;
  for (let calm = 0; calm < 3;) {
    await page.waitForTimeout(2000);
    const dust = (await metrics(page)).dust;
    calm = dust === settled ? calm + 1 : 0;
    settled = dust;
  }
  const start = await metrics(page);
  await page.waitForFunction((n) => (window as unknown as { __draws: number }).__draws > n + 2, start.draws, { timeout: 60000 });
  assert.equal((await metrics(page)).dust, start.dust, 'a moving satellite redrew the whole scene');

  await page.getByRole('button', { name: 'Сессии', exact: true }).click();
  await page.locator('.universe-stage.is-still').waitFor({ state: 'attached' });
  await quiet(page, 'off Home');
});

test('universe: a new note appears live, nothing else moves', async () => {
  const data = defaultFixture();
  const page = await open(data);
  await page.getByRole('group', { name: 'Заметки' }).locator('b').getByText('162', { exact: true }).waitFor();
  await page.mouse.move(860, 460);
  await page.mouse.wheel(0, -300);
  await page.locator('.u-label.on').first().waitFor();
  await page.waitForTimeout(500);
  const boxes = () => page.locator('.u-label.on[data-project]').evaluateAll((els) => Object.fromEntries(els.map((e) => [(e as HTMLElement).dataset.project, (e as HTMLElement).style.transform])));
  const before = await boxes();
  data.graph.nodes.push({ id: 'fresh-note', title: 'fresh note', file: 'fresh.md', project: 'alpha-service', connected: true, degree: 0, live: false, mtime: Date.now(), summary: 'Just written', issues: [] });
  fx!.push({ t: 'invalidate', topics: ['memory'] });
  await page.getByRole('group', { name: 'Заметки' }).locator('b').getByText('163', { exact: true }).waitFor();
  await page.waitForTimeout(500);
  const same = async () => {
    // A name may hide when the counter above it grows; what stays on screen must not have moved.
    const now = await boxes();
    const shared = Object.keys(now).filter((k) => k in before);
    assert.ok(shared.length >= 3);
    for (const k of shared) assert.equal(now[k], before[k], `${k}: the camera or the map changed`);
  };
  await same();
  data.graph.nodes.pop();
  fx!.push({ t: 'invalidate', topics: ['memory'] });
  await page.getByRole('group', { name: 'Заметки' }).locator('b').getByText('162', { exact: true }).waitFor();
  await page.waitForTimeout(500);
  await same();
  assert.deepEqual(errors, []);
});

const badge = (page: Page, key: string) => page.locator(`.u-label.on[data-project="${key}"]`);

// A project's place comes from the hash of its key and may lie under a panel: fly there, as a person would.
async function hoverBadge(page: Page, key: string) {
  await flyTo(page, key);
  await badge(page, key).hover();
}

test('badge popover: real sessions, stays open on the way in, stop asks first, start opens a new tab', async () => {
  const page = await open();
  await hoverBadge(page, 'alpha-service');
  const pop = page.getByRole('dialog', { name: /Проект alpha-service/ });
  await pop.waitFor();
  await pop.getByText('Перенос очереди на новый брокер').waitFor();
  await pop.getByText(/Последний запрос: проверь ретраи/).waitFor();

  // Across the gap between the badge and the popover, then inside.
  const box = (await pop.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 6 });
  await page.waitForTimeout(400);
  assert.ok(await pop.isVisible(), 'the popover closed while the pointer moved into it');

  const stops = pop.getByRole('button', { name: 'Остановить сессию' });
  await stops.first().click();
  const confirm = page.getByRole('dialog', { name: 'Остановить сессию?' });
  await confirm.getByRole('button', { name: 'Отмена' }).click();
  assert.equal(fx!.calls.filter((c) => c.path.endsWith('/stop')).length, 0, 'nothing stops without confirmation');
  await stops.first().click();
  await confirm.getByRole('button', { name: 'Остановить', exact: true }).click();
  await page.getByText('Сессия остановлена').waitFor();
  assert.ok(fx!.calls.some((c) => c.path === '/api/sessions/s-live/stop'));

  await pop.getByRole('button', { name: 'Новая сессия' }).click();
  await page.waitForTimeout(150);
  assert.deepEqual(fx!.calls.find((c) => c.path === '/api/tabs' && c.method === 'POST')?.body, { project: 'alpha-service' });
  assert.deepEqual(errors, []);
});

test('badge popover: empty state keeps the start button, a session without a process cannot be stopped', async () => {
  const data = defaultFixture();
  const s = data.sessions.find((x) => x.id === 's-live')!;
  s.pid = null;
  s.status = 'blocked';
  const page = await open(data);
  await hoverBadge(page, 'alpha-service');
  const pop = page.getByRole('dialog', { name: /Проект alpha-service/ });
  await pop.getByText(/нет процесса, который можно проверить/).waitFor();
  assert.equal(await pop.getByRole('button', { name: 'Остановить сессию' }).first().isDisabled(), true);

  await page.mouse.move(340, 900);
  await pop.waitFor({ state: 'detached' });
  await hoverBadge(page, 'gamma-tools');
  const empty = page.getByRole('dialog', { name: /Проект gamma-tools/ });
  await empty.getByText('Активных сессий нет').waitFor();
  await empty.getByRole('button', { name: 'Новая сессия' }).waitFor();
});

test('project menu is keyboard reachable from the list and Escape closes it', async () => {
  const page = await open();
  await page.locator('aside').getByRole('button', { name: /beta-web/ }).first().focus();
  await page.keyboard.press('Shift+F10');
  const menu = page.locator('[data-context-menu]');
  await menu.getByRole('menuitem', { name: 'Новая сессия' }).waitFor();
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });
});

test('removal dialog shows the preview and needs the exact project name', async () => {
  const data = defaultFixture();
  data.projects.find((p) => p.key === 'gamma-tools')!.liveCount = 0;
  const page = await open(data);
  await (await projectMenu(page, 'gamma-tools')).getByRole('menuitem', { name: 'Убрать из памяти Claude' }).click();
  const dialog = page.getByRole('dialog', { name: 'Убрать проект из памяти Claude' });
  await dialog.getByText('/home/test/.claude/projects/-home-test-gamma-tools').waitFor();
  await dialog.getByText('файлов: 12').waitFor();
  await dialog.getByText(/останется: пока работает Claude Code/).waitFor();
  const go = dialog.getByRole('button', { name: 'Убрать из памяти', exact: true });
  assert.equal(await go.isDisabled(), true);
  await dialog.getByRole('textbox').fill('gamma');
  assert.equal(await go.isDisabled(), true);
  assert.equal(fx!.calls.filter((c) => c.path.endsWith('/remove')).length, 0);
  await dialog.getByRole('textbox').fill('gamma-tools');
  await go.click();
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(fx!.calls.find((c) => c.path === '/api/projects/gamma-tools/remove')?.body, { confirm: 'gamma-tools' });
  await page.locator('aside').getByText('gamma-tools', { exact: true }).waitFor({ state: 'detached' });
});

test('removal is refused in the dialog while sessions run', async () => {
  const page = await open();
  await (await projectMenu(page, 'alpha-service')).getByRole('menuitem', { name: 'Убрать из памяти Claude' }).click();
  const dialog = page.getByRole('dialog', { name: 'Убрать проект из памяти Claude' });
  await dialog.getByText(/Сначала остановите их/).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Убрать из памяти', exact: true }).isDisabled(), true);
});

test('connect a folder: completion, then a new empty constellation; also from Ctrl+K', async () => {
  const page = await open();
  await page.locator('aside').getByText('alpha-service', { exact: true }).first().waitFor();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill('Подключить папку');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Подключить папку как проект' });
  const input = dialog.getByRole('combobox');
  await input.fill('/home/test/fre');
  await dialog.getByRole('option', { name: '/home/test/fresh-folder' }).click();
  assert.equal(await input.inputValue(), '/home/test/fresh-folder/');
  await input.fill('/home/test/fresh-folder');
  await dialog.getByRole('button', { name: 'Подключить', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  const row = page.locator('aside').getByText('fresh-folder', { exact: true });
  await row.waitFor();
  // Its place comes from the hash and may lie under a panel: the menu flies there and the name shows.
  await flyTo(page, 'fresh-folder');
  await badge(page, 'fresh-folder').waitFor();
  assert.deepEqual(errors, []);
});

test('universe: no WebGL gets an honest message, search still works', async () => {
  const page = await open(undefined, 'ru-RU', undefined, {
    init: () => {
      const real = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        if (type === 'webgl2') return null;
        return (real as (...a: unknown[]) => unknown).call(this, type, ...rest);
      } as typeof real;
    },
  });
  await page.getByText('WebGL недоступен').waitFor();
  await page.getByRole('textbox', { name: 'Поиск по заметкам' }).fill('note_alpha');
  await page.getByText(/^Найдено: \d+/).waitFor();
  assert.deepEqual(errors, []);
});

test('work tab header stays on one line at 1280', async () => {
  const page = await open(undefined, 'ru-RU', openTab('t1'), { width: 1280, height: 800 });
  const bar = page.locator('.work-bar');
  await page.getByRole('button', { name: 'PhpStorm' }).waitFor();
  const { fits, tops } = await bar.evaluate((el) => ({
    fits: el.scrollWidth <= el.clientWidth + 1,
    tops: [...el.querySelectorAll('button')].map((b) => Math.round(b.getBoundingClientRect().top + b.getBoundingClientRect().height / 2)),
  }));
  assert.ok(fits, 'header overflows');
  assert.ok(Math.max(...tops) - Math.min(...tops) <= 1, `buttons on different lines: ${tops}`);
});

test('english: dictionary, compact numbers and switcher that persists', async () => {
  const page = await open(undefined, 'en-US');
  await page.getByRole('navigation', { name: 'Tabs and sections' }).getByRole('button', { name: 'Home', exact: true }).waitFor();
  await page.getByText('Projects', { exact: true }).waitFor();
  await page.locator('aside').getByText(/\d[\d.]*M$/).first().waitFor();
  assert.equal(await page.getByText('Проекты', { exact: true }).count(), 0);
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Settings' }).click();
  await page.getByRole('radio', { name: 'RU', exact: true }).click();
  await homeButton(page).click();
  await page.getByText('Проекты', { exact: true }).waitFor();
  await page.locator('aside').getByText(/ млн$/).first().waitFor();
  await page.reload();
  await page.getByText('Проекты', { exact: true }).waitFor();
});

test('empty machine: every panel has an honest empty state', async () => {
  const page = await open(emptyFixture());
  await page.getByText('Проектов пока нет').waitFor();
  await page.getByText('Заметок памяти пока нет.').waitFor();
  await page.getByText('Хранилище Obsidian ещё не создано').waitFor();
  await page.getByRole('button', { name: 'Сессии', exact: true }).click();
  await page.getByText('Сессий Claude Code не найдено.').waitFor();
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Инструменты' }).click();
  await page.getByText('Скиллов пока нет.', { exact: true }).waitFor();
});

test('401 gives an honest message, not an empty app', async () => {
  fx = await startFixture();
  fx.failures.set(/^\/api\//, [401, { error: 'auth' }]);
  ctx = await browser.newContext({ locale: 'ru-RU' });
  const page = await ctx.newPage();
  await page.goto(fx.url);
  await page.getByText('Нет доступа к серверу Claude OS').waitFor();
});

test('errors keep a retry that works', async () => {
  fx = await startFixture();
  fx.failures.set(/^\/api\/projects$/, [422, { error: 'журнал повреждён' }]);
  ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(fx.url);
  await page.getByText('журнал повреждён').first().waitFor();
  fx.failures.clear();
  await page.getByRole('button', { name: 'Повторить' }).first().click();
  await page.locator('aside').getByText('alpha-service', { exact: true }).first().waitFor();
});

test('a failed first load retries by itself', async () => {
  fx = await startFixture();
  fx.failures.set(/^\/api\/projects$/, [503, { error: 'starting' }]);
  ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  await page.goto(fx.url);
  await page.getByText('starting').first().waitFor();
  fx.failures.clear();
  // The retry backs off up to 8 s, and nobody clicks anything here.
  await page.locator('aside').getByText('alpha-service', { exact: true }).first().waitFor({ timeout: 10000 });
});

test('command palette finds a note and opens it, raw HTML is sanitized', async () => {
  const data = defaultFixture();
  const title = data.graph.nodes[3].title;
  const page = await open(data);
  await page.locator('aside').getByText('alpha-service', { exact: true }).first().waitFor();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill(title);
  await page.getByRole('option', { name: new RegExp(title) }).waitFor();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('complementary', { name: 'Заметка памяти' });
  await panel.getByRole('heading', { name: title, level: 2 }).waitFor();
  await panel.getByText('Текст заметки').waitFor();
  assert.equal(await page.evaluate(() => (window as unknown as { __xss?: number }).__xss), undefined);
  assert.equal(await panel.locator('script').count(), 0);
});

test('note save conflict offers a choice and keeps the draft', async () => {
  const data = defaultFixture();
  const node = data.graph.nodes.find((n) => n.connected)!;
  const page = await open(data);
  await page.locator('aside').getByText('alpha-service', { exact: true }).first().waitFor();
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill(node.title);
  await page.getByRole('option', { name: new RegExp(node.title) }).first().waitFor(); // notes come from the debounced search
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Править', exact: true }).click();
  fx!.failures.set(/memory\/notes/, [409, { error: 'conflict' }]);
  await page.getByRole('textbox', { name: 'Текст заметки' }).fill('мой черновик');
  await page.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByText('Файл изменился на диске').waitFor();
  assert.equal(await page.getByRole('textbox', { name: 'Текст заметки' }).inputValue(), 'мой черновик');
  await page.getByRole('button', { name: 'Перезаписать моей версией' }).waitFor();
});

test('work tab: transcript, tool expansion, permission round trip, queue', async () => {
  const page = await open(undefined, 'ru-RU', openTab('t1'));
  await page.getByText('Настройки читаются').waitFor();
  await page.getByText('И заодно обнови README').waitFor();

  await page.getByRole('button', { name: /Grep/ }).click();
  await page.getByText('src/db.ts:4: DB_HOST').waitFor();
  await page.getByRole('button', { name: /Подагент a7/ }).waitFor();

  await page.getByRole('button', { name: 'Разрешить' }).click();
  await page.waitForTimeout(100);
  const call = fx!.calls.find((c) => c.path === '/api/tabs/t1/respond/r1');
  assert.deepEqual(call?.body, { kind: 'permission', allow: true });

  fx!.push({ t: 'chat', tabId: 't1', event: { seq: 14, at: Date.now(), e: 'resolved', requestId: 'r1', decision: 'allow' } });
  await page.getByText('Разрешено').waitFor();

  fx!.push({ t: 'chat', tabId: 't1', event: { seq: 15, at: Date.now(), e: 'user', blocks: [{ type: 'text', text: 'И заодно обнови README' }], queued: false } });
  await page.getByText(/В очереди/).waitFor({ state: 'detached' });

  fx!.push({ t: 'chat', tabId: 't1', event: { seq: 16, at: Date.now(), e: 'delta', messageId: 'm9', text: 'Стримлю **ответ' } });
  await page.getByText('Стримлю').waitFor();
  fx!.push({ t: 'chat', tabId: 't1', event: { seq: 17, at: Date.now(), e: 'assistant', messageId: 'm9', model: null, blocks: [{ type: 'text', text: 'Готовый ответ' }] } });
  await page.getByText('Готовый ответ').waitFor();
  assert.equal(await page.getByText('Стримлю').count(), 0);
  assert.deepEqual(errors, []);
});

test('interrupt clears the queue', async () => {
  const data = defaultFixture();
  const page = await open(data, 'ru-RU', openTab('t1'));
  await page.getByText('И заодно обнови README').waitFor();
  const at = Date.now();
  fx!.push({ t: 'chat', tabId: 't1', event: { seq: 14, at, e: 'result', usage: tokens(1, 1, 0, 0), costUsd: 0.5, interrupted: true, error: null } });
  await page.getByText(/В очереди/).waitFor({ state: 'detached' });
  await page.waitForTimeout(100);
  assert.equal(await page.getByText(/\$0\.50/).count(), 0, 'no dollars on a subscription');
});

test('composer: send, slash command that needs a terminal, @-mention', async () => {
  const page = await open(undefined, 'ru-RU', openTab('t1'));
  const box = page.getByRole('textbox', { name: /Сообщение в сессию/ });
  await box.waitFor();
  await page.getByText('Настройки читаются').waitFor();

  await box.fill('/con');
  await page.getByRole('option', { name: /config/ }).click();
  const help = page.getByRole('dialog', { name: '/config' });
  await help.getByRole('button', { name: 'Открыть в терминале' }).waitFor();
  await page.keyboard.press('Escape');
  await help.waitFor({ state: 'detached' });

  await box.fill('посмотри @conf');
  await page.getByRole('option', { name: 'src/config.ts' }).click();
  assert.equal(await box.inputValue(), 'посмотри @src/config.ts ');

  await box.press('Shift+Enter');
  await box.press('Control+Enter');
  await box.press('Meta+Enter');
  await page.waitForTimeout(100);
  assert.equal(await box.inputValue(), 'посмотри @src/config.ts \n\n\n', 'a modifier breaks the line');
  assert.equal(fx!.calls.some((c) => c.path === '/api/tabs/t1/send'), false, 'a modifier does not send');

  await box.press('Enter');
  await page.waitForTimeout(100);
  const send = fx!.calls.find((c) => c.path === '/api/tabs/t1/send');
  assert.equal((send?.body as { text: string }).text, 'посмотри @src/config.ts');
  assert.equal(await box.inputValue(), '');
});

test('an unapproved action shows the exact command and approves that text', async () => {
  const page = await open(undefined, 'ru-RU', openTab('t1'));
  await page.getByRole('button', { name: 'Выкатить' }).click();
  await page.getByText('deploy.sh {cwd}').waitFor();
  await page.getByRole('button', { name: 'Одобрить и запустить' }).click();
  await page.waitForTimeout(150);
  const approve = fx!.calls.find((c) => c.path.endsWith('/approve'));
  assert.deepEqual(approve?.body, { command: 'deploy.sh {cwd}' });
  assert.ok(fx!.calls.some((c) => c.path.endsWith('/run')));
});

test('read-only tab explains itself and offers the terminal, no composer', async () => {
  const page = await open(undefined, 'ru-RU', openTab('t3'));
  await page.getByText('Ретраи настроены верно').waitFor();
  await page.getByText('писать в неё можно только там').waitFor();
  await page.getByRole('button', { name: 'Открыть в терминале' }).waitFor();
  assert.equal(await page.getByRole('textbox', { name: /Сообщение/ }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Продолжить здесь' }).count(), 0);
});

test('reconnect resubscribes with the last seq', async () => {
  const page = await open(undefined, 'ru-RU', openTab('t1'));
  await page.getByText('Настройки читаются').waitFor();
  await page.waitForTimeout(100);
  assert.deepEqual(fx!.subscribes.find((s) => s.tabId === 't1'), { tabId: 't1', lastSeq: 13 });
  fx!.subscribes.length = 0;
  fx!.dropSockets();
  await page.waitForFunction(() => true);
  for (let i = 0; i < 40 && !fx!.subscribes.some((s) => s.tabId === 't1'); i++) await page.waitForTimeout(100);
  assert.deepEqual(fx!.subscribes.find((s) => s.tabId === 't1'), { tabId: 't1', lastSeq: 13 });
});

test('invalidate refetches matching data only', async () => {
  const data = defaultFixture();
  const page = await open(data);
  await page.locator('aside').getByText('alpha-service', { exact: true }).first().waitFor();
  const seen: string[] = [];
  page.on('request', (r) => seen.push(new URL(r.url()).pathname));
  data.projects[0].name = 'renamed-project';
  fx!.push({ t: 'invalidate', topics: ['projects'] });
  await page.locator('aside').getByText('renamed-project').first().waitFor();
  assert.ok(seen.includes('/api/projects'));
  assert.ok(!seen.includes('/api/analytics'));
  assert.ok(!seen.includes('/api/memory/graph'));
});

test('analytics: separate counters; tools: never-run skills, diff before save', async () => {
  const page = await open(undefined, 'ru-RU', { kind: 'analytics' });
  await page.getByText('Чтение кэша').first().waitFor();
  await page.getByRole('radio', { name: 'Таблица' }).click();
  await page.getByRole('columnheader', { name: 'День' }).waitFor();

  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Инструменты' }).click();
  await page.getByText('old-thing').first().waitFor();
  await page.getByRole('button', { name: /^brainstorm/ }).first().click();
  await page.getByRole('button', { name: 'Редактировать' }).click();
  await page.getByRole('textbox', { name: 'Текст SKILL.md' }).fill('новый текст');
  await page.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByRole('button', { name: 'Записать файл' }).waitFor();
  assert.equal(fx!.calls.filter((c) => c.method === 'PUT').length, 0);
  await page.getByRole('button', { name: 'Записать файл' }).click();
  await page.waitForTimeout(100);
  assert.equal(fx!.calls.filter((c) => c.method === 'PUT').length, 1);
});

test('adding an MCP server needs the explicit confirmation', async () => {
  const page = await open(undefined, 'ru-RU', { kind: 'tools', pane: 'mcp' });
  await page.locator('.sheet-bar').first().click({ button: 'right' });
  await page.locator('[data-context-menu]').getByRole('menuitem', { name: 'Добавить вручную' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Имя').fill('x');
  await dialog.getByLabel('Команда с аргументами').fill('npx y');
  const add = dialog.getByRole('button', { name: 'Добавить', exact: true });
  assert.equal(await add.isDisabled(), true);
  await dialog.getByRole('checkbox').check();
  await add.click();
  await page.waitForTimeout(100);
  const body = fx!.calls.find((c) => c.path === '/api/mcp')?.body as { confirmed: boolean; json: string };
  assert.equal(body.confirmed, true);
  assert.deepEqual(JSON.parse(body.json), { type: 'stdio', command: 'npx', args: ['y'] });
});

test('question form and plan card answer through the API; attachments reach send', async () => {
  const data = defaultFixture();
  const at = Date.now();
  data.history.t2 = [
    { seq: 1, at, e: 'question', requestId: 'q1', questions: [{ question: 'Какой вариант?', options: [{ label: 'Первый', description: 'проще' }, { label: 'Второй' }] }] },
    { seq: 2, at, e: 'plan', requestId: 'p1', plan: '## Шаг один\n\nСделать **главное**.' },
  ];
  const page = await open(data, 'ru-RU', openTab('t2'));
  const answer = page.getByRole('button', { name: 'Ответить' });
  assert.equal(await answer.isDisabled(), true);
  await page.getByRole('radio', { name: /Первый/ }).check();
  await answer.click();
  await page.getByRole('button', { name: 'Утвердить план' }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(fx!.calls.find((c) => c.path.endsWith('/respond/q1'))?.body, { kind: 'question', answers: { 'Какой вариант?': 'Первый' } });
  assert.deepEqual(fx!.calls.find((c) => c.path.endsWith('/respond/p1'))?.body, { kind: 'plan', approve: true });

  await page.getByLabel('Прикрепить файл').last().setInputFiles({ name: 'шаг.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
  await page.getByText('шаг.txt').waitFor();
  await page.getByRole('button', { name: 'Отправить' }).click();
  await page.waitForTimeout(100);
  const sent = fx!.calls.find((c) => c.path === '/api/tabs/t2/send')?.body as { attachments: { name: string; base64: string }[] };
  assert.deepEqual(sent.attachments, [{ name: 'шаг.txt', mediaType: 'text/plain', base64: 'aGVsbG8=' }]);
});

test('question draft survives tab switch', async () => {
  const data = defaultFixture();
  data.history.t2 = [
    { seq: 1, at: Date.now(), e: 'question', requestId: 'q1', questions: [
      { question: 'Какой вариант?', options: [{ label: 'Первый' }, { label: 'Второй' }] },
      { question: 'Что ещё?', multiSelect: true, options: [{ label: 'Тесты' }] },
    ] },
  ];
  const page = await open(data, 'ru-RU', openTab('t2'));
  await page.getByRole('radio', { name: /Второй/ }).check();
  await page.getByRole('checkbox', { name: /Тесты/ }).check();
  await page.getByRole('textbox', { name: 'Свой ответ' }).last().fill('и доку');
  const away = async () => {
    await homeButton(page).click();
    await page.getByRole('radio', { name: /Второй/ }).waitFor({ state: 'detached' });
    await page.getByRole('tab', { name: /beta-web/ }).click();
    await page.getByRole('radio', { name: /Второй/ }).waitFor();
  };
  await away();
  assert.equal(await page.getByRole('radio', { name: /Второй/ }).isChecked(), true);
  assert.equal(await page.getByRole('checkbox', { name: /Тесты/ }).isChecked(), true);
  assert.equal(await page.getByRole('textbox', { name: 'Свой ответ' }).last().inputValue(), 'и доку');
  assert.equal(await page.getByRole('checkbox').last().isChecked(), true);

  await page.getByRole('button', { name: 'Ответить' }).click();
  await page.waitForTimeout(100);
  assert.deepEqual(fx!.calls.find((c) => c.path.endsWith('/respond/q1'))?.body, { kind: 'question', answers: { 'Какой вариант?': 'Второй', 'Что ещё?': 'Тесты, и доку' } });
  fx!.push({ t: 'chat', tabId: 't2', event: { seq: 2, at: Date.now(), e: 'resolved', requestId: 'q1', decision: 'answer' } });
  await page.getByText('Ответ отправлен').waitFor();
  await away();
  assert.equal(await page.getByRole('radio', { name: /Второй/ }).isChecked(), false);
  assert.equal(await page.getByRole('textbox', { name: 'Свой ответ' }).last().inputValue(), '');
});

test('new tab dialog, Ctrl+digit switching, close', async () => {
  const page = await open();
  await page.locator('aside').getByText('alpha-service', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Новая вкладка' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Название').fill('задача три');
  await dialog.getByRole('button', { name: 'Открыть вкладку' }).click();
  await page.getByRole('tab', { name: /задача три/, selected: true }).waitFor();
  await page.keyboard.press('Control+1');
  await page.locator('nav.titlebar button[aria-current="page"][aria-label="Главная"]').waitFor();
  await page.keyboard.press('Control+2');
  await page.getByRole('tab', { name: /alpha-service/, selected: true }).waitFor();
  await page.getByRole('tab', { name: /задача три/ }).click();
  await page.getByRole('button', { name: 'Закрыть вкладку задача три' }).click();
  await page.getByRole('tab', { name: /задача три/ }).waitFor({ state: 'detached' });
});

test('new tab picker: Claude takes a plain request, the default project is never a folder, recent sessions with search', async () => {
  const data = defaultFixture();
  data.projects.push({ ...data.projects[0], key: 'workspace', name: 'workspace', root: '/home/test', folder: true, liveCount: 0, lastActivity: Date.now() });
  data.sessions.push({ ...data.sessions[1], id: 's-service', cwd: '/home/test/claude-os/service', title: 'Служебная работа', serviceFolder: true, lastActivity: Date.now() });
  const page = await open(data);
  await homeButton(page).waitFor();
  const plus = page.getByRole('button', { name: 'Новая вкладка' });
  const dialog = page.getByRole('dialog');

  // (b) The newest project is a plain folder: the pick skips it.
  await plus.click();
  assert.match((await dialog.getByRole('combobox', { name: 'Проект' }).textContent())!, /alpha-service/);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // (a) A plain request goes to the service session as the quick-start template, filled by the server. A refusal is said, the dialog stays.
  await plus.click();
  const ask = dialog.getByRole('textbox', { name: /Что хотим сделать/ });
  await ask.fill('бот для заметок');
  fx!.failures.set(/^\/api\/service\/tasks$/, [500, { error: 'нет шаблона quick-start' }]);
  await ask.press('Enter');
  await page.getByText('нет шаблона quick-start').waitFor();
  assert.equal(await ask.inputValue(), 'бот для заметок');
  fx!.failures.clear();
  await ask.press('Enter');
  await dialog.waitFor({ state: 'detached' });
  const sent = fx!.calls.filter((c) => c.path === '/api/service/tasks' && c.method === 'POST').map((c) => c.body);
  assert.deepEqual(sent.at(-1), { title: 'бот для заметок', microtask: 'quick-start', vars: { request: 'бот для заметок' }, source: 'microtask', sourceDetail: 'quick-start' });

  // (c) The latest sessions, no service ones; one running in a terminal cannot be taken; the search narrows.
  await plus.click();
  const recent = dialog.getByRole('region', { name: 'Недавние' });
  const rows = recent.getByRole('button');
  await rows.first().waitFor();
  assert.deepEqual(await rows.evaluateAll((els) => els.map((e) => [e.querySelector('span.flex-1')!.textContent, (e as HTMLButtonElement).disabled])), [
    ['Перенос очереди на новый брокер', true],
    ['Рефакторинг конфигурации', false],
    ['Правка вёрстки формы оплаты', false],
  ]);
  assert.match((await rows.first().getAttribute('title'))!, /вне Claude OS/);
  await recent.getByRole('searchbox', { name: 'Поиск по недавним сессиям' }).fill('beta-web');
  await waitRows(rows, 1);
  await recent.getByRole('searchbox').fill('нет такой');
  await recent.getByText('Сессий не найдено.').waitFor();
  await recent.getByRole('searchbox').fill('ВЁРСТК');
  await waitRows(rows, 1);
  await rows.first().click();
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('claude-os.view') ?? '{}').kind === 'tab');
  assert.deepEqual(fx!.calls.filter((c) => c.path === '/api/tabs').at(-1)?.body, { resumeSessionId: 's-ended', readonly: true, project: 'beta-web', cwd: '/home/test/beta-web' });
  assert.deepEqual(errors, []);
});

async function waitRows(rows: ReturnType<Page['getByRole']>, n: number) {
  for (let i = 0; i < 50 && (await rows.count()) !== n; i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal(await rows.count(), n);
}

const manyTabs = (n = 24) => {
  const data = defaultFixture();
  for (let i = 0; i < n; i++) data.tabs.push({ ...data.tabs[2], id: `x${i}`, sessionId: null, title: `вкладка с длинным заголовком ${i}`, order: 10 + i });
  return data;
};

// The selected tab is entirely on the strip and clear of the fade.
const activeInView = (page: Page) =>
  page.waitForFunction(() => {
    const el = document.querySelector('[role=tablist] [role=tab][aria-selected=true]');
    if (!el) return false;
    const strip = el.closest('[role=tablist]') as HTMLElement;
    const box = strip.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const scrolled = strip.scrollLeft;
    return (scrolled <= 1 ? r.left >= box.left : r.left >= box.left + 24) && (scrolled >= strip.scrollWidth - strip.clientWidth - 1 ? r.right <= box.right : r.right <= box.right - 24);
  });

test('a full strip: the wheel slides it, its edges fade only where tabs go on, the count shows the total', async () => {
  const page = await open(manyTabs(), 'ru-RU', openTab('t1'), { motion: true, width: 1280 });
  const strip = page.getByRole('tablist');
  const count = page.locator('.tabstrip-count');
  await page.waitForFunction(() => document.querySelector('.tabstrip-count.is-on'));
  assert.equal(await count.textContent(), '27');
  assert.equal(await count.getAttribute('title'), 'Всего вкладок: 27');
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.tabstrip-count')!).opacity === '1');
  const cls = () => strip.evaluate((el) => [el.classList.contains('fade-start'), el.classList.contains('fade-end')]);
  assert.deepEqual(await cls(), [false, true]);

  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  // Sampled every frame: a jump would show one value, a slide many on the way.
  const sampling = strip.evaluate(
    (el) =>
      new Promise<number[]>((resolve) => {
        const seen: number[] = [];
        const started = performance.now();
        const look = () => {
          seen.push(el.scrollLeft);
          // Until it settles: a slow software renderer gives fewer frames, the slide itself takes the same time.
          const still = seen.length > 5 && seen.slice(-5).every((x) => x === seen.at(-1)) && seen.at(-1)! > 0;
          if (still || performance.now() - started > 3000) resolve(seen);
          else requestAnimationFrame(look);
        };
        requestAnimationFrame(look);
      }),
  );
  await page.mouse.wheel(0, 300);
  const seen = await sampling;
  assert.ok(Math.abs(seen.at(-1)! - 300) <= 1, `landed at ${seen.at(-1)}: ${seen.join(', ')}`);
  assert.ok(new Set(seen.filter((x) => x > 0 && x < 299)).size >= 3, `slid through ${[...new Set(seen)].join(', ')}`);
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] >= seen[i - 1], 'it does not swing back');
  assert.deepEqual(await cls(), [true, true]);

  await page.mouse.wheel(0, 100000);
  await page.waitForFunction(() => {
    const el = document.querySelector('[role=tablist]')!;
    return el.scrollLeft >= el.scrollWidth - el.clientWidth - 1;
  });
  await page.waitForFunction(() => !document.querySelector('[role=tablist]')!.classList.contains('fade-end'));
  assert.deepEqual(await cls(), [true, false]);
  assert.deepEqual(errors, []);
});

test('the active tab rides into view: Home leaves the strip be, a new tab, a narrower window', async () => {
  const page = await open(manyTabs(), 'ru-RU', openTab('x23'), { motion: true, width: 1280 });
  const strip = page.getByRole('tablist');
  await activeInView(page);
  assert.ok((await strip.evaluate((el) => el.scrollLeft)) > 0, 'opened scrolled to the far tab');

  await page.keyboard.press('Control+1');
  await page.locator('nav.titlebar button[aria-current="page"][aria-label="Главная"]').waitFor();
  assert.ok((await strip.evaluate((el) => el.scrollLeft)) > 0, 'Home is the logo, off the strip: the strip stays where it was');

  await page.getByRole('button', { name: 'Новая вкладка' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Название').fill('свежая');
  await dialog.getByRole('button', { name: 'Открыть вкладку' }).click();
  await page.getByRole('tab', { name: /свежая/, selected: true }).waitFor();
  await activeInView(page);
  assert.equal(await page.locator('.tabstrip-count').textContent(), '28');

  await page.getByRole('tab', { name: /вкладка с длинным заголовком 23/ }).click();
  await activeInView(page);
  await page.setViewportSize({ width: 700, height: 800 });
  await activeInView(page);

  // Scrolled away by hand, it stays where the wheel left it until the active tab changes.
  await page.setViewportSize({ width: 1280, height: 800 });
  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100000);
  await page.waitForFunction(() => document.querySelector('[role=tablist]')!.scrollLeft === 0);
  await page.waitForTimeout(300);
  assert.equal(await strip.evaluate((el) => el.scrollLeft), 0);
  assert.deepEqual(errors, []);
});

test('tabs that fit: no count, no fade, the wheel does nothing', async () => {
  const page = await open(undefined, 'ru-RU', openTab('t1'), { motion: true, width: 1600 });
  const strip = page.getByRole('tablist');
  await page.getByRole('tab', { name: /alpha-service/, selected: true }).waitFor();
  const box = (await strip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 300);
  await page.waitForTimeout(200);
  assert.equal(await strip.evaluate((el) => el.scrollLeft), 0);
  assert.equal(await strip.evaluate((el) => el.className.match(/fade-|is-overflowing/)), null);
  const count = page.locator('.tabstrip-count');
  assert.equal(await count.evaluate((el) => el.getBoundingClientRect().width), 0);
  assert.equal(await count.evaluate((el) => getComputedStyle(el).opacity), '0');
});

test('at any window width the buttons on both sides stay clear of the tabs and inside the window', async () => {
  const page = await open(manyTabs(), 'ru-RU', openTab('t1'), { width: 1920 });
  await page.waitForFunction(() => document.querySelector('.tabstrip-count.is-on'));
  for (const width of [1920, 1500, 1280, 1100, 900, 700, 560, 480, 360]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(60);
    const got = await page.evaluate(() => {
      const rect = (el: Element | null | undefined) => el?.getBoundingClientRect();
      const nav = document.querySelector('nav.titlebar')!;
      const strip = document.querySelector('.tabstrip')!;
      const visible = (el: Element) => el.getBoundingClientRect().width > 0;
      const leftSide = [...strip.parentElement!.children].slice(0, [...strip.parentElement!.children].indexOf(strip)).filter(visible);
      return {
        leftEnd: Math.max(...leftSide.map((el) => rect(el)!.right)),
        strip: { left: rect(strip)!.left, right: rect(strip)!.right, width: rect(strip)!.width },
        plus: { left: rect(nav.querySelector('button[aria-label="Новая вкладка"]'))!.left, right: rect(nav.querySelector('button[aria-label="Новая вкладка"]'))!.right },
        right: { left: rect(nav.querySelector('.titlebar-right'))!.left, right: rect(nav.querySelector('.titlebar-right'))!.right },
        window: innerWidth,
      };
    });
    assert.ok(got.leftEnd <= got.strip.left + 0.5, `${width}: left buttons over the tabs ${JSON.stringify(got)}`);
    assert.ok(got.strip.right <= got.plus.left + 0.5, `${width}: new tab over the tabs ${JSON.stringify(got)}`);
    assert.ok(got.plus.right <= got.right.left + 0.5, `${width}: right group over new tab ${JSON.stringify(got)}`);
    assert.ok(got.right.right <= got.window + 0.5, `${width}: right group out of the window ${JSON.stringify(got)}`);
    assert.ok(got.strip.width >= 60, `${width}: no room left for tabs ${JSON.stringify(got)}`);
  }
});
