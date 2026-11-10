// Title bar and session bar at every width, the press feedback, the tooltips, the token badge. Fake backend only.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
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

async function open(o: { view?: object; data?: Fixture; motion?: boolean; width?: number } = {}): Promise<Page> {
  errors = [];
  fx = await startFixture(o.data);
  ctx = await browser.newContext({ viewport: { width: o.width ?? 1600, height: 900 }, locale: 'ru-RU', reducedMotion: o.motion ? 'no-preference' : 'reduce' });
  if (o.view) await ctx.addInitScript((v) => localStorage.setItem('claude-os.view', v), JSON.stringify(o.view));
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  await page.locator('nav.titlebar').waitFor();
  return page;
}

/** Buttons that overlap, and buttons that do not fit: what clips them (the scrolling tab strip) counts as part of how they show. */
const crowded = (page: Page, selector: string) => page.evaluate((sel) => {
  const shown = (el: Element) => {
    const b = el.getBoundingClientRect();
    const r = { left: b.left, right: b.right, top: b.top, bottom: b.bottom, scrolled: false };
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowX === 'visible' && s.overflowY === 'visible') continue;
      const c = p.getBoundingClientRect();
      r.left = Math.max(r.left, c.left);
      r.right = Math.min(r.right, c.right);
      r.top = Math.max(r.top, c.top);
      r.bottom = Math.min(r.bottom, c.bottom);
      if (p.scrollWidth > p.clientWidth && s.overflowX !== 'hidden') r.scrolled = true;
    }
    return r;
  };
  const items = [...document.querySelectorAll(sel)].filter((el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }).map((el) => ({ el, r: shown(el), full: el.getBoundingClientRect(), name: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 30) }));
  const bad: string[] = [];
  for (const [i, a] of items.entries()) {
    if (!a.r.scrolled && (a.full.right > innerWidth + 0.5 || a.full.left < -0.5)) bad.push(`past the window: ${a.name}`);
    for (const b of items.slice(i + 1)) {
      if (a.el.contains(b.el) || b.el.contains(a.el)) continue;
      const w = Math.min(a.r.right, b.r.right) - Math.max(a.r.left, b.r.left);
      const h = Math.min(a.r.bottom, b.r.bottom) - Math.max(a.r.top, b.r.top);
      if (w > 1 && h > 1) bad.push(`${a.name} × ${b.name} ${Math.round(w)}px`);
    }
  }
  return bad;
}, selector);

test('the bars: nothing overlaps or falls off at any width, the tabs keep a place in the title bar', async () => {
  const data = defaultFixture();
  const base = data.tabs.find((t) => t.kind === 'work')!;
  for (let i = 0; i < 12; i++) data.tabs.push({ ...base, id: `x${i}`, title: `Длинное название сессии ${i} про что-то важное`, order: 100 + i });
  const page = await open({ data, view: { kind: 'tab', id: 't1' } });
  await page.locator('.work-bar').waitFor();
  await page.getByText('Claude Ultra').first().waitFor();
  for (const width of [480, 640, 800, 960, 1100, 1280, 1366, 1600, 1920]) {
    await page.setViewportSize({ width, height: 800 });
    await page.waitForTimeout(100);
    const nav = await page.locator('nav.titlebar').evaluate((n) => ({ scroll: n.scrollWidth, client: n.clientWidth, strip: n.querySelector('.tabstrip')!.getBoundingClientRect().width }));
    assert.ok(nav.scroll <= nav.client, `the title bar is wider than the window at ${width}: ${JSON.stringify(nav)}`);
    assert.ok(nav.strip >= 60, `no room for the tabs at ${width}: ${nav.strip}`);
    assert.deepEqual(await crowded(page, 'nav.titlebar button, nav.titlebar [role=tab]'), [], `title bar at ${width}`);
    assert.deepEqual(await crowded(page, '.work-bar button'), [], `session bar at ${width}`);
    const bar = await page.locator('.work-bar').evaluate((b) => ({ scroll: b.scrollWidth, client: b.clientWidth }));
    assert.ok(bar.scroll <= bar.client, `the session bar hides buttons at ${width}: ${JSON.stringify(bar)}`);
  }
  assert.deepEqual(errors, []);
});

test('press: a click is felt, barely: one percent, quick down and slower back', async () => {
  const page = await open({ motion: true, view: { kind: 'sessions' } });
  await page.evaluate(() => {
    const el = document.createElement('button');
    el.id = 'pressed';
    el.className = 'press';
    el.style.cssText = 'position:fixed;left:700px;top:500px;width:300px;height:60px;z-index:9;pointer-events:auto';
    document.body.append(el);
  });
  const button = page.locator('#pressed');
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const look = () => button.evaluate((el) => {
    const s = getComputedStyle(el);
    return { transform: s.transform, duration: s.transitionDuration.split(',')[0].trim() };
  });
  assert.equal((await look()).duration, '0.24s');
  await page.mouse.down();
  await page.waitForTimeout(300);
  const pressed = await look();
  assert.equal(pressed.transform, 'matrix(0.99, 0, 0, 0.99, 0, 0)');
  assert.equal(pressed.duration, '0.09s');
  await page.mouse.up();
  await page.waitForTimeout(350);
  assert.equal((await look()).transform, 'none');
});

test('tooltips: markdown when written as markdown, plain text stays, a shortcut gets its key, nothing loads from the network', async () => {
  const page = await open();
  const requests: string[] = [];
  page.on('request', (r) => requests.push(r.url()));
  const put = (title: string, css = 'left:700px;top:500px') => page.evaluate(([t, c]) => {
    document.getElementById('tip-target')?.remove();
    const el = document.createElement('button');
    el.id = 'tip-target';
    el.textContent = 'x';
    el.title = t;
    el.style.cssText = `position:fixed;width:30px;height:20px;z-index:9;pointer-events:auto;${c}`;
    document.body.append(el);
  }, [title, css]);
  const show = async () => {
    await page.mouse.move(2, 500);
    await page.getByRole('tooltip').waitFor({ state: 'detached' });
    await page.locator('#tip-target').hover();
    const tip = page.getByRole('tooltip');
    await tip.waitFor();
    return tip;
  };

  await put('**Жирно** и `код`\n\n- один\n- два\n\n![x](http://example.invalid/x.png)');
  let tip = await show();
  assert.equal(await tip.locator('.md strong').innerText(), 'Жирно');
  assert.equal(await tip.locator('.md li').count(), 2);
  assert.equal(await tip.locator('img').count(), 0);
  assert.ok(!requests.some((u) => u.includes('example.invalid')), 'an image in a title stays unloaded');

  await put('/home/test/snake_case_path/*.ts и a * b');
  tip = await show();
  assert.equal(await tip.locator('.md').count(), 0);
  assert.equal(await tip.innerText(), '/home/test/snake_case_path/*.ts и a * b');

  await put('Палитра · Ctrl+K');
  tip = await show();
  assert.equal(await tip.locator('kbd').innerText(), 'Ctrl+K');
  assert.deepEqual(errors, []);
});

test('tooltips: stand where they fit whole, on any side, and a text taller than the window takes more width instead of being cut', async () => {
  const page = await open();
  const long = 'Подсказка с большим количеством текста, который надо показать целиком. '.repeat(60);
  const cases: [string, string, string][] = [
    ['middle', 'left:700px;top:500px', 'top'],
    ['under the title bar', 'left:700px;top:50px', 'bottom'],
    ['left edge, full height', 'left:0;top:60px;height:830px', 'right'],
    ['right edge, full height', 'right:0;top:60px;height:830px', 'left'],
  ];
  for (const [name, css, side] of cases) {
    await page.evaluate(([c, t]) => {
      document.getElementById('tip-target')?.remove();
      const el = document.createElement('button');
      el.id = 'tip-target';
      el.title = t;
      el.style.cssText = `position:fixed;width:30px;height:20px;z-index:9;pointer-events:auto;${c}`;
      document.body.append(el);
    }, [css, 'Подсказка средней длины, чтобы была видна. '.repeat(4)]);
    await page.mouse.move(800, 300);
    await page.getByRole('tooltip').waitFor({ state: 'detached' });
    await page.locator('#tip-target').hover();
    const tip = page.getByRole('tooltip');
    await tip.waitFor();
    assert.equal(await tip.getAttribute('data-side'), side, name);
    const r = (await tip.boundingBox())!;
    const owner = (await page.locator('#tip-target').boundingBox())!;
    assert.ok(r.x >= 8 && r.x + r.width <= 1592 && r.y >= 8 && r.y + r.height <= 892, `${name}: ${JSON.stringify(r)}`);
    assert.ok(r.x + r.width <= owner.x || r.x >= owner.x + owner.width || r.y + r.height <= owner.y || r.y >= owner.y + owner.height, `${name}: covers its element`);
  }

  await page.evaluate((t) => {
    document.getElementById('tip-target')!.title = t;
    document.getElementById('tip-target')!.style.cssText = 'position:fixed;left:700px;top:500px;width:30px;height:20px;z-index:9;pointer-events:auto';
  }, long);
  await page.mouse.move(800, 300);
  await page.getByRole('tooltip').waitFor({ state: 'detached' });
  await page.locator('#tip-target').hover();
  const tip = page.getByRole('tooltip');
  await tip.waitFor();
  const fit = await tip.evaluate((el) => ({ width: el.clientWidth, height: el.clientHeight, full: el.scrollHeight }));
  assert.ok(fit.width > 420, `kept narrow: ${JSON.stringify(fit)}`);
  assert.ok(fit.full <= fit.height, `cut: ${JSON.stringify(fit)}`);
});

test('tooltips: fade away, slide between neighbours, and a scroll elsewhere leaves them up', async () => {
  const page = await open({ motion: true });
  await page.evaluate(() => {
    for (const [id, left] of [['one', 500], ['two', 700]] as const) {
      const el = document.createElement('button');
      el.id = id;
      el.title = `Подсказка ${id}`;
      el.style.cssText = `position:fixed;left:${left}px;top:500px;width:30px;height:20px;z-index:9;pointer-events:auto`;
      document.body.append(el);
    }
    const box = document.createElement('div');
    box.id = 'elsewhere';
    box.style.cssText = 'position:fixed;left:0;top:600px;width:100px;height:100px;overflow:auto;z-index:9';
    box.innerHTML = '<div style="height:900px"></div>';
    document.body.append(box);
  });
  const tip = page.getByRole('tooltip');
  await page.locator('#one').hover();
  await tip.waitFor();
  await page.waitForTimeout(250);
  const first = (await tip.boundingBox())!;

  await page.evaluate(() => { document.getElementById('elsewhere')!.scrollTop = 200; });
  await page.waitForTimeout(100);
  assert.equal(await tip.count(), 1, 'a chat streaming next to the element is no reason to lose the tip');

  await page.locator('#two').hover();
  await page.waitForFunction(() => document.querySelector('[role=tooltip]')?.textContent === 'Подсказка two');
  assert.equal(await tip.getAttribute('data-moving'), '', 'the same box goes over');
  await page.waitForTimeout(250);
  assert.ok((await tip.boundingBox())!.x > first.x + 150);

  await page.mouse.move(800, 300);
  await page.waitForFunction(() => document.querySelector('[role=tooltip]')?.hasAttribute('data-leaving'));
  await tip.waitFor({ state: 'detached' });
  assert.equal(await page.locator('#two').getAttribute('title'), 'Подсказка two', 'the attribute comes back');
});

test('session tokens: a question mark next to the title says when they were last updated', async () => {
  const page = await open({ view: { kind: 'tab', id: 't1' } });
  const panel = page.getByTestId('side-panel');
  const badge = panel.getByRole('img', { name: 'Когда обновлялись токены' });
  await badge.waitFor();
  const title = (await panel.getByRole('heading', { name: /Токены сессии/ }).boundingBox())!;
  const mark = (await badge.boundingBox())!;
  assert.ok(mark.x >= title.x && mark.y >= title.y - 2 && mark.y + mark.height <= title.y + title.height + 2, 'in the title line');
  await badge.hover();
  const tip = page.getByRole('tooltip');
  await tip.waitFor();
  assert.equal(await tip.locator('strong').innerText(), 'Обновлено:');
  assert.match(await tip.innerText(), /Обновлено: \d+ \S+ .*\d{2}:\d{2} \(.+\)/);
  assert.deepEqual(errors, []);
});
