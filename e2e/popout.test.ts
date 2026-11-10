// Separate windows. The page half: the real server, the fake CLI, a real browser with a fake window bridge.
// The window half: desktop/main.cjs and preload.cjs against a fake electron module. Electron and Windows themselves are not exercised. No tokens.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startServer, waitUntil, type TestServer } from '../server/chat/fixtures/harness.ts';
import { homeButton } from './fixture-server.ts';
import type { Tab } from '../shared/contract.ts';

const require = createRequire(import.meta.url);
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==';

function countWebgl() {
  const w = window as unknown as { __webgl: number };
  w.__webgl = 0;
  const real = HTMLCanvasElement.prototype.getContext as (...a: unknown[]) => unknown;
  (HTMLCanvasElement.prototype as unknown as { getContext: unknown }).getContext = function (this: HTMLCanvasElement, kind: string, ...rest: unknown[]) {
    if (kind.includes('webgl')) w.__webgl++;
    return real.call(this, kind, ...rest);
  };
}

function fakeBridge() {
  const w = window as unknown as Record<string, unknown>;
  const calls: unknown[][] = [];
  w.__calls = calls;
  const subs: Record<string, Set<(v: unknown) => void>> = {};
  const on = (name: string) => (cb: (v: unknown) => void) => {
    (subs[name] ??= new Set()).add(cb);
    return () => subs[name].delete(cb);
  };
  const record = (name: string) => (...args: unknown[]) => void calls.push([name, ...args]);
  w.__emit = (name: string, value: unknown) => subs[name]?.forEach((cb) => cb(value));
  w.claudeDesktop = {
    canFullscreen: false,
    onCloseRequest: on('close'),
    answerClose: record('answerClose'),
    notify: record('notify'),
    onOpenTab: on('openTab'),
    setLabels: record('setLabels'),
    isFullscreen: async () => false,
    setFullscreen: record('setFullscreen'),
    onFullscreen: on('fullscreen'),
    minimize: record('minimize'),
    currentApps: async () => [],
    onApps: on('apps'),
    activateApp: record('activateApp'),
    openPopout: record('openPopout'),
    returnPopout: record('returnPopout'),
    popouts: async () => [],
    onPopouts: on('popouts'),
    onShowView: on('showView'),
    showInMain: record('showInMain'),
    popoutPin: async () => true,
    setPopoutPin: record('setPopoutPin'),
    popoutWindow: record('popoutWindow'),
  };
}

let srv: TestServer;
let browser: Browser;
let ctx: BrowserContext;
let plain: BrowserContext;
const errors: string[] = [];

const origin = () => `http://127.0.0.1:${srv.port}`;

async function enter(context: BrowserContext, path = '/'): Promise<Page> {
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  const token = readFileSync(join(srv.dataDir, 'token'), 'utf8').trim();
  await p.goto(`${origin()}/auth?token=${token}`);
  if (path !== '/') await p.goto(origin() + path);
  return p;
}

const newTab = async (project?: string) => (await srv.api<Tab>('POST', '/api/tabs', project ? { project } : { cwd: mkdtempSync(join(srv.dir, 'w-')) })).body;
const tabsNow = async () => (await srv.api<Tab[]>('GET', '/api/tabs')).body;
const calls = (p: Page, name: string) => p.evaluate((n) => ((window as unknown as { __calls: unknown[][] }).__calls).filter((c) => c[0] === n), name);
const emit = (p: Page, name: string, value?: unknown) => p.evaluate(([n, v]) => (window as unknown as { __emit: (n: unknown, v: unknown) => void }).__emit(n, v), [name, value]);
const field = (p: Page) => p.getByRole('textbox').last();
const paste = (el: ReturnType<Page['locator']>) =>
  el.evaluate((node, b64) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'shot.png', { type: 'image/png' }));
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG);

async function assertOnlyTheChat(p: Page) {
  assert.equal(await p.locator('.titlebar').count(), 0, 'no title bar with tabs');
  assert.equal(await p.getByRole('tablist').count(), 0);
  assert.equal(await p.locator('canvas').count(), 0, 'no map');
  assert.equal(await p.evaluate(() => (window as unknown as { __webgl: number }).__webgl), 0, 'no WebGL asked for');
}

before(async () => {
  srv = await startServer();
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
  ctx.setDefaultTimeout(30_000);
  await ctx.addInitScript(countWebgl);
  await ctx.addInitScript(fakeBridge);
  plain = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
  plain.setDefaultTimeout(30_000);
});

after(async () => {
  await browser?.close();
  await srv?.destroy();
  assert.deepEqual(errors, []);
});

test('the route shows one chat or the planner and never the map', async () => {
  const main = await enter(ctx);
  await main.locator('.titlebar').waitFor();
  await waitUntil(() => main.evaluate(() => (window as unknown as { __webgl: number }).__webgl > 0), 'the spy sees the map of the main page');
  await main.close();

  const tab = await newTab();
  const chat = await enter(ctx, `/?popout=tab&id=${tab.id}`);
  await field(chat).waitFor();
  await chat.getByRole('button', { name: /Поверх всех окон: включено/ }).waitFor();
  await assertOnlyTheChat(chat);
  assert.equal(await chat.title(), tab.title);
  await chat.close();

  const root = await enter(ctx, '/?popout=root');
  await root.getByRole('textbox', { name: /Начни новый проект/ }).waitFor();
  await assertOnlyTheChat(root);
  await root.close();

  const planner = await enter(ctx, '/?popout=planner');
  await planner.getByRole('textbox', { name: /заметк/i }).first().waitFor();
  await assertOnlyTheChat(planner);
  await planner.close();

  const service = await enter(ctx, '/?popout=service');
  await service.getByText('Задач нет').waitFor();
  await service.getByRole('button', { name: 'Закрыть окно задач' }).click();
  assert.deepEqual((await calls(service, 'popoutWindow')).at(-1), ['popoutWindow', 'close']);
  assert.equal(await service.getByRole('button', { name: 'Вернуть в главное окно' }).count(), 0);
  assert.equal(await service.title(), 'Задачи служебной сессии');
  await assertOnlyTheChat(service);
  await service.close();

  // Anything else in the route is not a route: the plain app.
  for (const wrong of ['/?popout=evil', '/?popout=tab']) {
    const other = await enter(ctx, wrong);
    await other.locator('.titlebar').waitFor();
    await other.close();
  }
});

test('one session in two windows: one process, the turn and the draft in both', async () => {
  const tab = await newTab();
  const before = srv.log().filter((l) => l.kind === 'spawn').length;
  const main = await enter(ctx);
  await main.getByRole('tab', { name: new RegExp(tab.title) }).first().click();
  await field(main).waitFor();
  const out = await enter(ctx, `/?popout=tab&id=${tab.id}`);
  await field(out).waitFor();

  await field(out).fill('из окна');
  await waitUntil(async () => (await field(main).inputValue()) === 'из окна', 'the draft reaches the main window');

  await field(out).press('Enter');
  await main.getByText('echo: из окна').waitFor();
  await out.getByText('echo: из окна').waitFor();
  await waitUntil(async () => (await field(main).inputValue()) === '', 'sent from one window: empty in the other');

  await field(main).fill('из главного');
  await field(main).press('Enter');
  await out.getByText('echo: из главного').waitFor();
  await main.getByText('echo: из главного').waitFor();
  assert.equal(srv.log().filter((l) => l.kind === 'spawn').length - before, 1, 'a single Claude process for this session');

  // Closing the window does nothing to the session.
  const sessionBefore = (await tabsNow()).find((t) => t.id === tab.id)!;
  await out.close();
  await waitUntil(async () => {
    const now = (await tabsNow()).find((t) => t.id === tab.id);
    return now?.sessionId === sessionBefore.sessionId && now?.status === 'idle';
  }, 'the tab stays as it was');
  await field(main).fill('снова');
  await field(main).press('Enter');
  await main.getByText('echo: снова').waitFor();
  assert.equal(srv.log().filter((l) => l.kind === 'spawn').length - before, 1, 'still the same process');
  await main.close();
});

test('a closed tab closes its window', async () => {
  const tab = await newTab();
  const out = await enter(ctx, `/?popout=tab&id=${tab.id}`);
  await field(out).waitFor();
  await srv.api('DELETE', `/api/tabs/${tab.id}`);
  await waitUntil(async () => (await calls(out, 'popoutWindow')).some((c) => c[1] === 'close'), 'the window asks to close');
  await out.close();
});

test('Ctrl+V of a screenshot: into the field and with the focus elsewhere, and it reaches Claude', async () => {
  const tab = await newTab();
  const out = await enter(ctx, `/?popout=tab&id=${tab.id}`);
  await field(out).waitFor();
  await paste(field(out));
  await out.getByRole('img', { name: 'shot.png' }).waitFor();
  await out.getByRole('button', { name: /Убрать shot\.png|shot\.png/ }).click();
  await out.getByRole('img', { name: 'shot.png' }).waitFor({ state: 'detached' });

  await paste(out.locator('header'));
  await out.getByRole('img', { name: 'shot.png' }).waitFor();
  await field(out).fill('смотри');
  await field(out).press('Enter');
  await out.getByText('echo: смотри').waitFor();
  const sent = srv.log().filter((l) => l.kind === 'user').map((l) => JSON.stringify(l.content));
  assert.ok(sent.some((c) => c.includes('смотри') && c.includes('"image"')), 'the picture went with the message');
  await out.close();
});

test('the main window: menu, header button, a mark on the tab, the way back, the close dialog', async () => {
  const tab = await newTab();
  const main = await enter(ctx);
  const pill = main.getByRole('tab', { name: new RegExp(tab.title) }).first();
  await pill.click();

  await pill.click({ button: 'right' });
  await main.getByRole('menuitem', { name: 'Открыть в отдельном окне' }).click();
  assert.deepEqual((await calls(main, 'openPopout')).at(-1), ['openPopout', { kind: 'tab', id: tab.id }]);

  await main.locator('.work-bar').getByRole('button', { name: 'Открыть в отдельном окне' }).click();
  assert.equal((await calls(main, 'openPopout')).length, 2);

  await homeButton(main).click({ button: 'right' });
  await main.getByRole('menuitem', { name: 'Открыть в отдельном окне' }).click();
  assert.deepEqual((await calls(main, 'openPopout')).at(-1), ['openPopout', { kind: 'root' }]);

  // The burger holds the main screens only: the planner's window is its own button's business.
  await main.getByRole('button', { name: 'Меню' }).click();
  await main.getByRole('menuitem', { name: 'Канбан' }).waitFor();
  assert.equal(await main.getByRole('menuitem', { name: 'Планер в отдельном окне' }).count(), 0);
  await main.keyboard.press('Escape');
  const key = `tab:${tab.id}`;
  await emit(main, 'popouts', [key]);
  await pill.getByLabel('Открыт в отдельном окне').waitFor();
  await field(main).waitFor(); // the chat stays usable here too
  await main.locator('.work-bar').getByRole('button', { name: 'Вернуть в главное окно' }).click();
  assert.deepEqual((await calls(main, 'returnPopout')).at(-1), ['returnPopout', key]);
  await pill.click({ button: 'right' });
  await main.getByRole('menuitem', { name: 'Вернуть в главное окно' }).click();
  assert.equal((await calls(main, 'returnPopout')).length, 2);

  // Nothing running: with a window still out the main window steps aside, the tray's "quit" still quits.
  await emit(main, 'close', { fromTray: false });
  assert.deepEqual((await calls(main, 'answerClose')).at(-1), ['answerClose', 'tray']);
  await emit(main, 'close', { fromTray: true });
  assert.deepEqual((await calls(main, 'answerClose')).at(-1), ['answerClose', 'quit']);
  await emit(main, 'popouts', []);
  await pill.getByLabel('Открыт в отдельном окне').waitFor({ state: 'detached' });
  await emit(main, 'close', { fromTray: false });
  assert.deepEqual((await calls(main, 'answerClose')).at(-1), ['answerClose', 'quit']);

  // The planner's button opens the window, and a later "open the planner" leads there too.
  await emit(main, 'showView', 'planner');
  const panel = main.getByRole('complementary', { name: 'Планер' });
  await panel.locator('header strong').click({ button: 'right' });
  await main.getByRole('menuitem', { name: 'Планер в отдельном окне' }).click();
  await panel.waitFor({ state: 'detached' });
  assert.deepEqual((await calls(main, 'openPopout')).at(-1), ['openPopout', { kind: 'planner' }]);
  await emit(main, 'popouts', ['planner']);
  await emit(main, 'showView', 'planner');
  await waitUntil(async () => (await calls(main, 'openPopout')).length === 5, 'to the window, not the panel');
  assert.equal(await panel.count(), 0);
  await main.close();
});

test('the service window out: the title bar button stays with no tasks and raises it', async () => {
  const main = await enter(ctx);
  const button = main.getByRole('button', { name: 'Задачи служебной сессии' });
  await main.locator('.titlebar').waitFor();
  assert.equal(await button.count(), 0, 'no tasks, nothing out: no button');
  await emit(main, 'popouts', ['service']);
  await button.click();
  assert.deepEqual((await calls(main, 'openPopout')).at(-1), ['openPopout', { kind: 'service' }]);
  await emit(main, 'popouts', []);
  await button.waitFor({ state: 'detached' });
  await main.close();
});

test('what is typed in the planner moves with it to the window', async () => {
  const main = await enter(ctx);
  await main.evaluate(() => (window as unknown as { __emit: (n: string, v: unknown) => void }).__emit('showView', 'planner'));
  const panel = main.getByRole('complementary', { name: 'Планер' });
  await panel.getByRole('textbox').first().fill('недописанная мысль');
  await panel.locator('header strong').click({ button: 'right' });
  await main.getByRole('menuitem', { name: 'Планер в отдельном окне' }).click();
  const out = await enter(ctx, '/?popout=planner');
  await waitUntil(async () => (await out.getByRole('textbox').first().inputValue()) === 'недописанная мысль', 'the draft came along');
  await out.getByRole('textbox').first().fill('');
  await main.close();
  await out.close();
});

test('the window bar: pin and own window controls go to the bridge', async () => {
  const tab = await newTab();
  const out = await enter(ctx, `/?popout=tab&id=${tab.id}`);
  const pinned = out.getByRole('button', { name: /Поверх всех окон: включено/ });
  await pinned.click();
  assert.deepEqual((await calls(out, 'setPopoutPin')).at(-1), ['setPopoutPin', false]);
  const unpinned = out.getByRole('button', { name: /Держать поверх всех окон/ });
  assert.match((await unpinned.getAttribute('aria-label')) ?? '', /borderless/, 'says plainly what cannot be overlaid');
  await unpinned.click();
  assert.deepEqual((await calls(out, 'setPopoutPin')).at(-1), ['setPopoutPin', true]);
  await out.getByRole('button', { name: 'Вернуть в главное окно' }).click();
  assert.deepEqual((await calls(out, 'returnPopout')).at(-1), ['returnPopout']);
  await out.getByRole('button', { name: 'Свернуть окно' }).click();
  assert.deepEqual((await calls(out, 'popoutWindow')).at(-1), ['popoutWindow', 'minimize']);
  await out.getByRole('button', { name: /Закрыть окно/ }).click();
  assert.deepEqual((await calls(out, 'popoutWindow')).at(-1), ['popoutWindow', 'close']);
  await out.close();
});

test('the planner window has one close button, no second way out, and no bar below', async () => {
  const out = await enter(ctx, '/?popout=planner');
  await out.getByRole('button', { name: 'Закрыть планер' }).click();
  assert.deepEqual((await calls(out, 'popoutWindow')).at(-1), ['popoutWindow', 'close']);
  assert.equal(await out.getByRole('button', { name: 'Вернуть в главное окно' }).count(), 0);
  await out.getByRole('button', { name: /Поверх всех окон/ }).waitFor();
  await out.getByRole('button', { name: 'Свернуть окно' }).waitFor();
  assert.equal(await out.getByRole('button', { name: /активный проект/ }).count(), 0);
  await out.close();
});

test('in a plain browser: no window actions, the planner floats in the app', async () => {
  const tab = await newTab();
  const main = await enter(plain);
  const pill = main.getByRole('tab', { name: new RegExp(tab.title) }).first();
  await pill.click();
  await field(main).waitFor();
  assert.equal(await main.getByRole('button', { name: 'Открыть в отдельном окне' }).count(), 0, 'no header button');
  await pill.click({ button: 'right' });
  assert.equal(await main.getByRole('menuitem', { name: 'Открыть в отдельном окне' }).count(), 0, 'no menu item');
  await main.keyboard.press('Escape');

  await main.getByRole('button', { name: 'Меню' }).click();
  assert.equal(await main.getByRole('menuitem', { name: 'Планер в отдельном окне' }).count(), 0);
  await main.getByRole('menuitem', { name: 'Планер', exact: true }).click();
  const panel = main.getByRole('complementary', { name: 'Планер' });
  await panel.locator('header strong').click({ button: 'right' });
  await main.getByRole('menuitem', { name: 'Открепить в плавающее окно' }).click();
  await panel.getByRole('button', { name: 'Свернуть планер' }).waitFor();
  assert.equal(await panel.getByRole('button', { name: /активный проект/ }).count(), 0);
  await panel.locator('header strong').click({ button: 'right' });
  await main.getByRole('menuitem', { name: /край/ }).click(); // leaves the context as it found it
  await main.close();

  // The route opened by hand still works, only with no window controls.
  const out = await enter(plain, `/?popout=tab&id=${tab.id}`);
  await field(out).waitFor();
  assert.equal(await out.getByRole('button', { name: 'Свернуть окно' }).count(), 0);
  await out.close();
});

// ---------- The window half ----------

async function startMain(userData: string) {
  const ORIGIN = 'http://127.0.0.1:47999';
  const windows: FakeWindow[] = [];
  const ipc: Record<string, (e: unknown, v?: unknown) => unknown> = {};
  const handlers: Record<string, (e: unknown) => unknown> = {};
  const external: string[] = [];
  let quits = 0;
  class FakeWindow extends EventEmitter {
    options: Record<string, unknown>;
    url = '';
    top: [boolean, string?] = [false];
    bounds: { x: number; y: number; width: number; height: number };
    visible = false;
    closed = false;
    minimized = false;
    focuses = 0;
    focused = true;
    opacity = 1;
    sent: [string, unknown][] = [];
    openHandler: ((d: { url: string }) => { action: string }) | null = null;
    webContents: EventEmitter;
    constructor(options: Record<string, unknown>) {
      super();
      this.options = options;
      this.bounds = { x: (options.x as number) ?? 0, y: (options.y as number) ?? 0, width: options.width as number, height: options.height as number };
      this.webContents = Object.assign(new EventEmitter(), {
        send: (c: string, v: unknown) => void this.sent.push([c, v]),
        getURL: () => this.url,
        setWindowOpenHandler: (f: FakeWindow['openHandler']) => { this.openHandler = f; },
      });
      windows.push(this);
    }
    loadURL(u: string) { this.url = u; return Promise.resolve(); }
    maximize() {}
    isMaximized() { return false; }
    isMinimized() { return this.minimized; }
    isVisible() { return this.visible; }
    isFullScreen() { return false; }
    isDestroyed() { return this.closed; }
    isAlwaysOnTop() { return this.top[0]; }
    isFocused() { return this.focused; }
    setOpacity(value: number) { this.opacity = value; }
    setAlwaysOnTop(on: boolean, level?: string) { this.top = [on, level]; }
    getBounds() { return this.bounds; }
    show() { this.visible = true; this.emit('show'); }
    hide() { this.visible = false; this.emit('hide'); }
    focus() { this.focuses++; }
    restore() { this.minimized = false; this.emit('restore'); }
    minimize() { this.minimized = true; this.emit('minimize'); }
    setFullScreen() {}
    close() {
      const e = { prevented: false, preventDefault() { this.prevented = true; } };
      this.emit('close', e);
      if (e.prevented) return;
      this.closed = true;
      this.emit('closed');
    }
  }
  const area = { x: 0, y: 0, width: 1920, height: 1040 };
  const cursor = { x: 0, y: 0 };
  const electron = {
    app: Object.assign(new EventEmitter(), { setAppUserModelId() {}, requestSingleInstanceLock: () => true, getPath: () => userData, getLocale: () => 'ru-RU', whenReady: () => Promise.resolve(), quit() { quits++; }, exit() {} }),
    BrowserWindow: FakeWindow,
    ipcMain: { on: (c: string, f: (e: unknown, v?: unknown) => unknown) => { ipc[c] = f; }, handle: (c: string, f: (e: unknown) => unknown) => { handlers[c] = f; } },
    Menu: { setApplicationMenu() {}, buildFromTemplate: (t: unknown) => t },
    Notification: class {},
    screen: {
      getPrimaryDisplay: () => ({ workArea: area }),
      getDisplayMatching: () => ({ workArea: area }),
      getCursorScreenPoint: () => cursor,
    },
    shell: { openExternal(u: string) { external.push(u); } },
    session: { defaultSession: { setPermissionRequestHandler() {} } },
    Tray: class extends EventEmitter { setToolTip() {} setContextMenu() {} },
  };
  const spawn = (cmd: string) => {
    const child = Object.assign(new EventEmitter(), { stdout: Object.assign(new EventEmitter(), { setEncoding() {} }), stderr: new EventEmitter(), kill() {} });
    if (cmd === 'wsl.exe') setImmediate(() => child.stdout.emit('data', `READY ${ORIGIN}/auth?token=x\n`));
    return child;
  };
  type Loader = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const loader = Module as unknown as Loader;
  const realLoad = loader._load;
  loader._load = (request, parent, isMain) => {
    if (request === 'electron') return electron;
    if (request === 'node:child_process') return { spawn };
    if (request === './install.json') return { distro: 'd', node: 'n', serve: 's' };
    return realLoad(request, parent, isMain);
  };
  const mainPath = require.resolve('../desktop/main.cjs');
  try {
    delete require.cache[mainPath];
    require(mainPath);
    await waitUntil(() => windows[0]?.url.startsWith(ORIGIN), 'the page loads');
  } finally {
    loader._load = realLoad;
    delete require.cache[mainPath];
  }
  const main = windows[0];
  const from = (w: FakeWindow) => ({ sender: w.webContents, senderFrame: { url: `${ORIGIN}/` } });
  return {
    ORIGIN, main, windows, ipc, handlers, external, from, electron, cursor,
    quits: () => quits,
    open: (req: unknown) => { ipc['popout-open'](from(main), req); return windows.at(-1)!; },
  };
}

test('main process: a real window for each session, only by allow-list, as locked down as the main one', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'claude-os-popout-'));
  try {
    const run = await startMain(userData);
    const { ORIGIN, main, windows, ipc, from } = run;
    const a = run.open({ kind: 'tab', id: 'tab-a' });
    assert.notEqual(a, main);
    assert.equal(a.url, `${ORIGIN}/?popout=tab&id=tab-a`);
    assert.equal(a.options.frame, false);
    assert.deepEqual(a.options.webPreferences, main.options.webPreferences, 'the same isolation and sandbox');
    assert.deepEqual(a.options.webPreferences, { contextIsolation: true, nodeIntegration: false, sandbox: true, preload: (main.options.webPreferences as { preload: string }).preload });
    assert.equal(a.options.skipTaskbar, undefined, 'stays in Alt+Tab');
    assert.equal(a.visible, false);
    a.emit('ready-to-show');
    assert.equal(a.visible, true);
    assert.deepEqual(main.sent.at(-1), ['popouts', ['tab:tab-a']]);

    // One per session: the second ask brings the same one up. Two sessions: two windows, not on top of each other.
    a.minimized = true;
    assert.equal(run.open({ kind: 'tab', id: 'tab-a' }), a);
    assert.equal(a.minimized, false);
    assert.equal(a.focuses, 1);
    const b = run.open({ kind: 'tab', id: 'tab-b' });
    assert.notEqual(b, a);
    assert.notDeepEqual([b.bounds.x, b.bounds.y], [a.bounds.x, a.bounds.y]);
    assert.equal(run.open({ kind: 'root' }).url, `${ORIGIN}/?popout=root`);
    assert.equal(run.open({ kind: 'planner' }).url, `${ORIGIN}/?popout=planner`);
    assert.equal(run.open({ kind: 'service' }).url, `${ORIGIN}/?popout=service`);
    const count = windows.length;

    // Nothing else becomes a window.
    for (const wrong of [{ kind: 'evil' }, { kind: 'tab' }, { kind: 'tab', id: '../../evil' }, { kind: 'tab', id: 'a&popout=root' }, { kind: 'tab', id: 7 }, 'http://evil/', null, { url: 'http://evil/' }]) run.open(wrong);
    assert.equal(windows.length, count);
    ipc['popout-open']({ sender: {}, senderFrame: { url: 'http://evil/' } }, { kind: 'tab', id: 'x' });
    ipc['popout-open']({ sender: main.webContents, senderFrame: { url: 'http://evil/' } }, { kind: 'tab', id: 'x' });
    assert.equal(windows.length, count, 'another page gets no say');

    // The same navigation guard.
    const navigate = (to: string) => {
      let prevented = false;
      a.webContents.emit('will-navigate', { preventDefault: () => { prevented = true; } }, to);
      return prevented;
    };
    assert.equal(navigate(a.url), false);
    assert.equal(navigate(`${ORIGIN}/`), true, 'not to the whole app');
    assert.equal(navigate('https://example.com/'), true);
    assert.deepEqual(run.external, ['https://example.com/']);
    assert.equal(navigate('file:///etc/passwd'), true);
    assert.equal(run.external.length, 1);
    assert.deepEqual(a.openHandler!({ url: 'https://example.com/x' }), { action: 'deny' });

    // Closing one: nothing goes to the page but the new list. It stays open when the main window closes to the tray.
    const before = main.sent.length;
    b.close();
    assert.deepEqual(main.sent.slice(before), [['popouts', ['tab:tab-a', 'root', 'planner', 'service']]]);
    assert.equal(run.quits(), 0);
    assert.equal(await run.handlers['popouts-get'](from(main)) instanceof Array, true);

    // The way back: the window goes first, then the main window shows the chat.
    ipc['popout-return'](from(a));
    assert.equal(a.closed, true);
    assert.deepEqual(main.sent.slice(-2), [['popouts', ['root', 'planner', 'service']], ['show-view', { kind: 'tab', id: 'tab-a' }]]);
    const planner = windows.find((w) => w.url.endsWith('popout=planner'))!;
    ipc['popout-return'](from(main), 'planner');
    assert.equal(planner.closed, true);
    assert.deepEqual(main.sent.at(-1), ['show-view', 'planner']);
    const root = windows.find((w) => w.url.endsWith('popout=root'))!;
    ipc['popout-go'](from(root), { kind: 'sessions' });
    assert.deepEqual(main.sent.at(-1), ['show-view', { kind: 'sessions' }]);
    ipc['popout-window'](from(root), 'minimize');
    assert.equal(root.minimized, true);

    // The main window's close asks its page as before; a pop-out stays through "tray" and goes with "quit".
    let prevented = false;
    main.emit('close', { preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true);
    assert.deepEqual(main.sent.at(-1), ['close-request', { fromTray: false }]);
    ipc['close-answer'](from(main), 'tray');
    assert.equal(main.visible, false);
    assert.equal(root.closed, false);
    assert.equal(run.quits(), 0);
    ipc['close-answer'](from(main), 'quit');
    assert.equal(run.quits(), 1);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test('main process: pin on by default, off is remembered per kind, bounds too', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'claude-os-popout-'));
  const stored = () => JSON.parse(readFileSync(join(userData, 'popouts.json'), 'utf8')) as Record<string, Record<string, unknown>>;
  try {
    let run = await startMain(userData);
    let tab = run.open({ kind: 'tab', id: 'a' });
    assert.deepEqual(tab.top, [true, 'screen-saver'], 'on by default, at the level over borderless games');
    assert.equal(run.handlers['popout-pin-get'](run.from(tab)), true);
    // In the lower right corner of the screen, whole.
    assert.ok(tab.bounds.x + tab.bounds.width <= 1920 && tab.bounds.y + tab.bounds.height <= 1040);

    run.ipc['popout-pin'](run.from(run.main), false);
    assert.deepEqual(tab.top, [true, 'screen-saver'], 'the main window pins nothing');
    run.ipc['popout-pin'](run.from(tab), false);
    assert.deepEqual(tab.top, [false, 'screen-saver']);
    assert.equal(run.handlers['popout-pin-get'](run.from(tab)), false);
    assert.equal(stored().tab.pin, false);

    tab.bounds = { x: 100, y: 200, width: 500, height: 600 };
    tab.close();
    assert.deepEqual({ ...stored().tab }, { pin: false, x: 100, y: 200, width: 500, height: 600 });

    // Per kind: the next tab window comes as the last one was; the planner has its own.
    tab = run.open({ kind: 'tab', id: 'b' });
    assert.deepEqual(tab.top, [false, 'screen-saver']);
    assert.deepEqual(tab.bounds, { x: 100, y: 200, width: 500, height: 600 });
    const second = run.open({ kind: 'tab', id: 'c' });
    assert.deepEqual([second.bounds.x, second.bounds.y], [128, 228], 'not exactly over the first');
    const planner = run.open({ kind: 'planner' });
    assert.deepEqual(planner.top, [true, 'screen-saver']);
    assert.equal(planner.bounds.width, 650); // room to read and edit: wider than a chat window

    // A monitor that is gone: back on the screen. A damaged file: the defaults.
    writeFileSync(join(userData, 'popouts.json'), JSON.stringify({ root: { x: 9000, y: 9000, width: 500, height: 500 } }));
    run = await startMain(userData);
    assert.ok(run.open({ kind: 'root' }).bounds.x < 1920);
    writeFileSync(join(userData, 'popouts.json'), '{broken');
    run = await startMain(userData);
    assert.deepEqual(run.open({ kind: 'root' }).top, [true, 'screen-saver']);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test('main process: the pinned planner fades while away, more under the mouse, and comes back solid', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'claude-os-popout-'));
  try {
    const run = await startMain(userData);
    const w = run.open({ kind: 'planner' });
    w.emit('ready-to-show');
    const settles = (goal: number) => waitUntil(() => Math.abs(w.opacity - goal) < 0.001, `opacity reaches ${goal}, is ${w.opacity}`);
    assert.equal(w.opacity, 1, 'active: as it is');

    // Away: in steps, not at once. The mouse elsewhere.
    run.cursor.x = 5;
    run.cursor.y = 5;
    w.focused = false;
    w.emit('blur');
    await waitUntil(() => w.opacity < 1, 'the fade has begun');
    assert.ok(w.opacity > 0.7, `still on its way: ${w.opacity}`);
    await settles(0.7);

    // Under the mouse: more transparent, and back when it leaves, with no event from the window.
    run.cursor.x = w.bounds.x + 10;
    run.cursor.y = w.bounds.y + 10;
    await settles(0.35);
    run.cursor.x = 5;
    await settles(0.7);

    // Back to the window: a click activates it.
    run.cursor.x = w.bounds.x + 10;
    await settles(0.35);
    w.focused = true;
    w.emit('focus');
    await settles(1);

    // Not pinned: an ordinary window, also while away. Pinned again while away: it fades without another event.
    w.focused = false;
    run.ipc['popout-pin'](run.from(w), false);
    w.emit('blur');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(w.opacity, 1);
    run.ipc['popout-pin'](run.from(w), true);
    await settles(0.35);

    // A chat window stays as it is; closing leaves no timer running on a dead window.
    const chat = run.open({ kind: 'tab', id: 'a' });
    chat.focused = false;
    chat.emit('blur');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(chat.opacity, 1);
    w.close();
    const last = w.opacity;
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(w.opacity, last);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test('preload: every window call goes to a channel the main process listens on', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'claude-os-popout-'));
  try {
    const run = await startMain(userData);
    const sent: string[] = [];
    let bridge: Record<string, (...a: unknown[]) => unknown> = {};
    const fake = {
      contextBridge: { exposeInMainWorld: (_: string, api: typeof bridge) => { bridge = api; } },
      ipcRenderer: { send: (c: string) => void sent.push(c), invoke: (c: string) => { sent.push(c); return Promise.resolve(); }, on() {}, removeListener() {} },
    };
    type Loader = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
    const loader = Module as unknown as Loader;
    const realLoad = loader._load;
    loader._load = (request, parent, isMain) => (request === 'electron' ? fake : realLoad(request, parent, isMain));
    const path = require.resolve('../desktop/preload.cjs');
    try {
      delete require.cache[path];
      require(path);
    } finally {
      loader._load = realLoad;
      delete require.cache[path];
    }
    for (const name of ['openPopout', 'returnPopout', 'popouts', 'showInMain', 'popoutPin', 'setPopoutPin', 'popoutWindow']) bridge[name]();
    assert.equal(sent.length, 7);
    for (const channel of sent) assert.ok(run.ipc[channel] || run.handlers[channel], channel);
    for (const name of ['onPopouts', 'onShowView']) assert.equal(typeof bridge[name](() => {}), 'function');
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});
