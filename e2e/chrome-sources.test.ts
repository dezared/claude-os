// U2, U9, U10, U12 against e2e/fixture-server.ts, with a fake window bridge where the window matters. Electron itself is not exercised.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { fixtureIcons } from './fixture-features.ts';
import { defaultFixture, startFixture, type Fixture, type FixtureServer } from './fixture-server.ts';

function fakeBridge() {
  const w = window as unknown as Record<string, unknown>;
  const subs: Record<string, Set<(v: unknown) => void>> = {};
  const on = (name: string) => (cb: (v: unknown) => void) => {
    (subs[name] ??= new Set()).add(cb);
    return () => subs[name].delete(cb);
  };
  w.__emit = (name: string, value: unknown) => subs[name]?.forEach((cb) => cb(value));
  const none = () => {};
  w.claudeDesktop = {
    canFullscreen: true, onCloseRequest: on('close'), answerClose: none, notify: none, onOpenTab: on('openTab'), setLabels: none,
    isFullscreen: async () => false, setFullscreen: none, onFullscreen: on('fullscreen'), minimize: none, currentApps: async () => [], onApps: on('apps'), activateApp: none,
  };
}

let browser: Browser;
let ctx: BrowserContext | null = null;
let fx: FixtureServer | null = null;
let errors: string[] = [];

before(async () => {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});
after(() => browser.close());
afterEach(async () => {
  assert.deepEqual(errors, []);
  await ctx?.close();
  await fx?.close();
  ctx = null;
  fx = null;
  errors = [];
  fixtureIcons.icons = {};
  fixtureIcons.chosen = {};
});

interface Options {
  view?: unknown;
  bridge?: boolean;
  motion?: boolean;
  init?: () => void;
  data?: Fixture;
  width?: number;
}

async function open({ view = { kind: 'home' }, bridge, motion, init, data, width = 1600 }: Options = {}): Promise<Page> {
  fx = await startFixture(data ?? defaultFixture());
  ctx = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'ru-RU', reducedMotion: motion ? 'no-preference' : 'reduce' });
  await ctx.addInitScript((v) => localStorage.setItem('claude-os.view', v), JSON.stringify(view));
  if (bridge) await ctx.addInitScript(fakeBridge);
  if (init) await ctx.addInitScript(init);
  ctx.setDefaultTimeout(20000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  return page;
}

const emit = (page: Page, name: string, value: unknown) => page.evaluate(([n, v]) => (window as unknown as { __emit: (n: unknown, v: unknown) => void }).__emit(n, v), [name, value]);
const rightGroup = (page: Page) => page.locator('.titlebar-right');
const groupRight = async (page: Page) => (await rightGroup(page).boundingBox())!;
const tip = async (page: Page, source: ReturnType<Page['locator']>) => {
  await source.hover();
  const box = page.getByRole('tooltip');
  await box.waitFor();
  const text = await box.innerText();
  await page.mouse.move(2, 500);
  await box.waitFor({ state: 'detached' });
  return text;
};

test('title bar: room for the caption buttons in a window, the group slides into it in full screen and back, by transform only', async () => {
  const page = await open({ bridge: true, motion: true });
  await rightGroup(page).getByText('Claude Code 2.1.318').waitFor();
  const windowed = await groupRight(page);
  assert.equal(Math.round(windowed.x + windowed.width), 1600 - 138, 'clear of the 3 × 46 px caption buttons');

  const sidesBefore = await page.evaluate(() => document.querySelector('.tabstrip')!.getBoundingClientRect().right);
  const layoutBefore = await rightGroup(page).evaluate((el) => (el as HTMLElement).offsetLeft);
  await emit(page, 'fullscreen', true);

  // Held at points of the transition: frame timing under a software renderer says nothing, the timeline does.
  const held = await rightGroup(page).evaluate(async (el) => {
    const [a] = el.getAnimations() as CSSTransition[];
    a.pause();
    const at = (ms: number) => {
      a.currentTime = ms;
      return el.getBoundingClientRect().right;
    };
    const points = [0, 75, 150, 225, 299].map(at);
    const layout = (el as HTMLElement).offsetLeft;
    const property = a.transitionProperty;
    a.finish();
    return { points, layout, property };
  });
  assert.equal(held.property, 'transform');
  assert.equal(held.layout, layoutBefore, 'the layout box stays where it was');
  assert.deepEqual(held.points, held.points.slice().sort((p, q) => p - q), `one way: ${held.points.join(' ')}`);
  assert.ok(held.points[0] < 1600 - 137 && held.points[4] > 1599, `the whole way: ${held.points.join(' ')}`);
  assert.ok(held.points[2] > 1600 - 120 && held.points[2] < 1600 - 18, `through the room: ${held.points.join(' ')}`);

  const full = await groupRight(page);
  assert.equal(Math.round(full.x + full.width), 1600, 'up to the window edge');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no overflow past the window');
  assert.equal(await page.evaluate(() => document.querySelector('.tabstrip')!.getBoundingClientRect().right), sidesBefore, 'the tabs do not move');

  await emit(page, 'fullscreen', false);
  const running = await page.evaluate(() => document.querySelector('.titlebar-right')!.getAnimations().map((a) => (a as CSSTransition).transitionProperty));
  assert.deepEqual(running, ['transform']);
  await page.waitForFunction(() => document.querySelector('.titlebar-right')!.getAnimations().length === 0);
  const back = await groupRight(page);
  assert.equal(Math.round(back.x + back.width), 1600 - 138);
});

test('title bar: the width comes from the overlay when it can say, and reduced motion moves at once', async () => {
  const page = await open({
    bridge: true,
    init: () => {
      const overlay = Object.assign(new EventTarget(), { visible: true, getTitlebarAreaRect: () => new DOMRect(0, 0, innerWidth - 120, 44) });
      Object.defineProperty(navigator, 'windowControlsOverlay', { value: overlay });
    },
  });
  await rightGroup(page).getByText('Claude Code 2.1.318').waitFor();
  await page.waitForFunction(() => {
    const r = document.querySelector('.titlebar-right')!.getBoundingClientRect();
    return Math.round(r.right) === innerWidth - 120;
  });
  await emit(page, 'fullscreen', true);
  await page.waitForFunction(() => document.querySelector('.titlebar-right.is-clear'));
  assert.equal(await page.evaluate(() => document.querySelector('.titlebar-right')!.getAnimations().length), 0);
  assert.equal(Math.round((await groupRight(page)).x + (await groupRight(page)).width), 1600);
});

test('title bar: a plain browser reserves nothing', async () => {
  const page = await open();
  await rightGroup(page).getByText('Claude Code 2.1.318').waitFor();
  const box = await groupRight(page);
  assert.equal(Math.round(box.x + box.width), 1600);
});

test('kanban: the hint is one line, every project select shows icon, name and colour', async () => {
  const data = defaultFixture();
  data.projects[0].name = 'alpha-service-с-очень-длинным-именем-которое-не-влезает-ни-в-какой-выбор-проекта';
  fixtureIcons.icons = { 'beta-web': '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><circle cx="12" cy="12" r="9" fill="__INK__"/></svg>' };
  const page = await open({ view: { kind: 'kanban' }, data, width: 1280 });
  const hint = page.getByText(/^Перетаскивание мышью/);
  await hint.waitFor();
  const line = await hint.evaluate((el) => {
    const s = getComputedStyle(el);
    return { height: el.getBoundingClientRect().height, line: parseFloat(s.lineHeight) || 16, wrap: s.whiteSpace };
  });
  assert.equal(line.wrap, 'nowrap');
  assert.ok(line.height <= line.line + 1, `one line: ${line.height}`);

  const board = page.getByRole('combobox', { name: 'Доска' });
  await board.click();
  const listbox = page.getByRole('listbox');
  const option = listbox.getByRole('option', { name: 'beta-web' });
  await option.waitFor();
  assert.equal(await listbox.getByRole('option').count(), 2 + data.projects.length);
  assert.ok(await option.locator('img').count() === 1, 'the icon of the project');
  const colour = await option.locator('[data-project-color]').evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.match(colour, /^rgb/);
  const other = await listbox.getByRole('option', { name: 'gamma-tools' }).locator('[data-project-color]').evaluate((el) => getComputedStyle(el).backgroundColor);
  assert.notEqual(colour, other, 'each its own');
  assert.equal(await listbox.getByRole('option', { name: 'gamma-tools' }).locator('span[aria-hidden]').count(), 1, 'no icon of its own: the same monogram as the list');
  assert.equal(await listbox.getByRole('option', { name: /^Все|Все проекты/ }).locator('[data-project-color]').count(), 0, 'not a project: no mark');

  // A very long name stays inside the closed select.
  await listbox.getByRole('option', { name: /очень-длинным/ }).click();
  const trigger = (await board.boundingBox())!;
  assert.ok(trigger.width < 240, `width ${trigger.width}`);
  const name = board.getByText(/очень-длинным/);
  assert.ok((await name.boundingBox())!.x + (await name.boundingBox())!.width <= trigger.x + trigger.width, 'clipped in the trigger');
  assert.equal(await board.locator('[data-project-color]').count(), 1, 'the closed select shows the mark too');

  // Choosing still works: and the card dialog offers the same.
  await page.getByRole('button', { name: 'Карточка', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Проект' }).click();
  await page.getByRole('listbox').getByRole('option', { name: 'gamma-tools' }).locator('[data-project-color]').waitFor();
});

test('project selects elsewhere: new tab, sessions, CLAUDE.md, usage log, MCP form, settings', async () => {
  const page = await open({ view: { kind: 'sessions' } });
  const marked = async (box: ReturnType<Page['locator']>) => {
    await box.click();
    await page.getByRole('listbox').getByRole('option', { name: 'gamma-tools' }).locator('[data-project-color]').waitFor();
    await page.keyboard.press('Escape');
  };
  await marked(page.getByRole('combobox', { name: 'Фильтр по проекту' }));

  await page.getByRole('button', { name: 'Новая вкладка' }).click();
  await marked(page.getByRole('dialog').getByRole('combobox', { name: 'Проект' }));
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });

  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('menuitem', { name: 'Инструменты' }).click();
  const nav = page.getByRole('navigation', { name: 'Раздел инструментов' });
  await nav.getByRole('button', { name: 'CLAUDE.md', exact: true }).click();
  await page.getByRole('radio', { name: 'Проект' }).click();
  await marked(page.getByRole('combobox', { name: 'Проект' }));

  await nav.getByRole('button', { name: 'Журнал', exact: true }).click();
  await marked(page.getByRole('combobox', { name: 'Проект' }));

  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('menuitem', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Проекты' }).click();
  await marked(page.getByRole('combobox', { name: 'Проект' }));

  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('menuitem', { name: 'Инструменты' }).click();
  await nav.getByRole('button', { name: 'MCP-серверы', exact: true }).click();
  await page.getByText('Серверов').first().click({ button: 'right' });
  await page.locator('[data-context-menu]').getByRole('menuitem', { name: 'Добавить вручную' }).click();
  const form = page.getByRole('dialog');
  await form.getByRole('combobox', { name: 'Область' }).click();
  await page.getByRole('listbox').getByRole('option').nth(1).click();
  await marked(form.getByRole('combobox', { name: 'Проект сервера' }));
});

test('sources: every row of skills, agents, hooks and MCP says where it comes from, the tooltip says which and where it works', async () => {
  const data = defaultFixture();
  data.skills.push({ id: 'project:alpha-service:release-notes', name: 'release-notes', scope: 'project', source: 'alpha-service', description: null, path: '/home/test/alpha-service/.claude/skills/release-notes', readOnly: false, disabled: false, isSymlink: false, usageCount: 2, lastUsedAt: null });
  data.skills.push({ id: 'plugin:superpowers:tdd', name: 'tdd', scope: 'plugin', source: 'superpowers', description: null, path: '/plugins/superpowers/skills/tdd', readOnly: true, disabled: false, isSymlink: false, usageCount: 0, lastUsedAt: null });
  data.skills.push({ id: 'plugin:local-only:scan', name: 'scan', scope: 'plugin', source: 'local-only', description: null, path: '/plugins/local-only/skills/scan', readOnly: true, disabled: false, isSymlink: false, usageCount: 0, lastUsedAt: null });
  const page = await open({ view: { kind: 'tools', pane: 'skills' }, data });
  const row = (name: string) => page.locator('button').filter({ has: page.getByText(name, { exact: true }) }).last();

  // Skills: no plugin in the plugin report stays as the report has it.
  const global = row('brainstorm').locator('[data-source]');
  await global.waitFor();
  assert.equal(await global.getAttribute('data-source'), 'global');
  assert.equal(await tip(page, global), 'Глобально: во всех проектах');

  const inProject = row('release-notes').locator('[data-source]');
  assert.equal(await inProject.getAttribute('data-source'), 'in-project');
  assert.match(await inProject.innerText(), /alpha-service/);
  assert.equal(await tip(page, inProject), 'Только в проекте alpha-service');

  const unknown = row('charts').locator('[data-source]');
  assert.match(await unknown.innerText(), /viz-kit/);
  assert.equal(await tip(page, unknown), 'Из плагина viz-kit, обновляется вместе с ним');

  assert.equal(await tip(page, row('tdd').locator('[data-source]')), 'Из плагина superpowers, обновляется вместе с ним. Глобально: во всех проектах');
  assert.equal(await tip(page, row('scan').locator('[data-source]')), 'Из плагина local-only, обновляется вместе с ним. Включён в проектах: alpha-service');
  const skills = await page.locator('.min-h-0 button.grid').count();
  assert.equal(await page.locator('button.grid [data-source]').count(), skills, 'every skill row');

  // Agents.
  await page.getByRole('navigation', { name: 'Раздел инструментов' }).getByRole('button', { name: 'Агенты', exact: true }).click();
  const plotter = page.locator('button.grid').filter({ hasText: 'plotter' }).locator('[data-source]');
  assert.equal(await plotter.getAttribute('data-source'), 'plugin');
  assert.match(await tip(page, plotter), /^Из плагина viz-kit/);
  assert.equal(await tip(page, page.locator('button.grid').filter({ hasText: 'migrator' }).locator('[data-source]')), 'Только в проекте alpha-service');
  assert.equal(await page.locator('button.grid').filter({ hasText: 'reviewer' }).locator('[data-source]').getAttribute('data-source'), 'global');

  // Hooks: the source and the kind of project setting.
  await page.getByRole('navigation', { name: 'Раздел инструментов' }).getByRole('button', { name: 'Хуки', exact: true }).click();
  const superpowers = page.locator('button.grid').filter({ hasText: 'SessionStart' }).locator('[data-source]');
  assert.match(await tip(page, superpowers), /^Из плагина superpowers/);
  await page.getByRole('radio', { name: 'По проектам' }).click();
  const hook = page.locator('button.grid').filter({ hasText: 'PostToolUse' }).locator('[data-source]');
  assert.match(await hook.innerText(), /alpha-service/);
  assert.equal(await tip(page, hook), 'Только в проекте alpha-service, настройка в репозитории');

  // MCP: several places, the local one named as such.
  await page.getByRole('navigation', { name: 'Раздел инструментов' }).getByRole('button', { name: 'MCP-серверы', exact: true }).click();
  const server = (name: string) => page.getByRole('button', { name: `Подробнее о сервере ${name}` }).locator('..');
  const semble = server('semble');
  await semble.locator('[data-source="local"]').waitFor();
  assert.deepEqual(await semble.locator('[data-source]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.source)), ['global', 'local']);
  assert.equal(await tip(page, semble.locator('[data-source="local"]')), 'Только в проекте alpha-service, локальная настройка');
  assert.match(await semble.locator('[data-source="local"]').innerText(), /Локально/);
  const figma = server('plugin:figma:figma').locator('[data-source]');
  assert.equal(await figma.getAttribute('data-source'), 'plugin');
  assert.match(await tip(page, figma), /^Из плагина figma/);
});

test('home chat: one line under the field, with the menu at its far end', async () => {
  const page = await open({ view: { kind: 'home' } });
  const under = page.locator('.home-chat .composer-under');
  await under.waitFor();
  assert.equal(await under.evaluate((el) => getComputedStyle(el).display), 'flex');
  assert.equal(await page.locator('.home-chat .u-on-sky').count(), 1);
  const field = page.locator('.home-chat textarea');
  await field.fill('/focus off');
  await field.press('Enter');
  const mark = page.locator('.home-chat .composer-foot button');
  await mark.waitFor();
  const rows = await under.locator('button').evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().bottom)));
  assert.ok(rows.length >= 2 && Math.max(...rows) - Math.min(...rows) < 8, `one row: ${rows}`);
  const more = await under.getByRole('button', { name: 'Ещё', exact: true }).boundingBox();
  const box = (await under.boundingBox())!;
  assert.ok(more && more.x + more.width > box.x + box.width - 12, 'the menu is at the far end');
  await mark.click();
  await mark.waitFor({ state: 'detached' });
});
