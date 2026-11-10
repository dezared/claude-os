// B1, B4, B16. The page half: the real server, the fake CLI, a real browser with a fake window bridge. The window half:
// desktop/main.cjs against a fake electron module. Electron and Windows themselves are not exercised here. No tokens.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import Module, { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Tab } from '../shared/contract.ts';
import { startServer, waitUntil, type TestServer } from '../server/chat/fixtures/harness.ts';
import { homeButton } from './fixture-server.ts';

const require = createRequire(import.meta.url);
const { createAppsWatcher, parseApps, parseIcon } = require('../desktop/apps.cjs') as {
  createAppsWatcher: (o: { spawn: unknown; parentPid: number; onApps: (a: { id: number; title: string; icon: string | null }[]) => void; cacheFile?: () => string }) => { start(): void; stop(): void; activate(id: number): void; current(): { id: number }[] };
  parseApps: (line: string) => { id: number; title: string; path: string | null }[] | null;
  parseIcon: (line: string) => { path: string; icon: string } | null;
};

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

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
    canFullscreen: true,
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
  };
}

let srv: TestServer;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let rootId = '';
const errors: string[] = [];

const homeBox = (p = page) => p.getByRole('textbox', { name: /Начни новый проект/ });
const closeDialog = () => page.getByRole('dialog', { name: 'Закрыть Claude OS?' });
const calls = (name: string) => page.evaluate((n) => ((window as unknown as { __calls: unknown[][] }).__calls).filter((c) => c[0] === n), name);
const clearCalls = () => page.evaluate(() => { (window as unknown as { __calls: unknown[][] }).__calls.length = 0; });
const emit = (name: string, value?: unknown) => page.evaluate(([n, v]) => (window as unknown as { __emit: (n: unknown, v: unknown) => void }).__emit(n, v), [name, value]);
const send = (id: string, text: string) => srv.api('POST', `/api/tabs/${id}/send`, { text });
const settled = async (id: string) => {
  await waitUntil(async () => (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === id)?.status === 'idle', 'tab idle', 20_000);
};
const setFocused = (on: boolean) => page.evaluate((v) => { document.hasFocus = () => v; }, on);

async function enter(context: BrowserContext): Promise<Page> {
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  const token = readFileSync(join(srv.dataDir, 'token'), 'utf8').trim();
  await p.goto(`http://127.0.0.1:${srv.port}/auth?token=${token}`);
  return p;
}

before(async () => {
  srv = await startServer();
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  ctx.setDefaultTimeout(60_000);
  await ctx.addInitScript(fakeBridge);
  page = await enter(ctx);
  await homeBox().waitFor();
  rootId = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.kind === 'root')!.id;
});

after(async () => {
  await browser?.close();
  await srv?.destroy();
  assert.deepEqual(errors, []);
});

test('the root chat lives on Home and nowhere else in the app; a turn started elsewhere opens a closed panel', async () => {
  // What an older version left behind means nothing now.
  await page.evaluate(() => localStorage.setItem('claude-os.rootFloat', JSON.stringify({ floating: true, collapsed: false, pos: { left: 300, bottom: 40 } })));
  await page.reload();
  await page.locator('.home-layer .home-chat').waitFor();
  assert.equal(await page.locator('.root-float').count(), 0);
  await page.getByRole('button', { name: 'Сессии', exact: true }).click();
  await homeButton(page).click();

  await homeBox().fill('');
  await send(rootId, 'HOLD 800');
  await page.locator('.home-chat .root-panel').waitFor();
  await settled(rootId);
  await page.getByRole('button', { name: 'Свернуть ответ' }).click();
  await page.locator('.root-panel').waitFor({ state: 'detached' });
  await send(rootId, 'HOLD 800');
  await page.locator('.home-chat .root-panel').waitFor();
  await settled(rootId);
});

test('closing: nothing running quits, something running asks, a remembered choice is kept', async () => {
  await settled(rootId);
  await waitUntil(async () => {
    await clearCalls();
    await emit('close', { fromTray: false });
    if ((await calls('answerClose')).at(-1)?.[1] === 'quit') return true;
    await page.keyboard.press('Escape'); // the page has not heard yet that the turn ended
    return false;
  }, 'quits with nothing running');
  await closeDialog().waitFor({ state: 'detached' });

  const work = (await srv.api<Tab>('POST', '/api/tabs', { cwd: srv.dir, title: 'Рабочая' })).body;
  await send(work.id, 'SLOW');
  await waitUntil(async () => {
    await clearCalls();
    await emit('close', { fromTray: false });
    return (await calls('answerClose')).at(-1)?.[1] === 'dialog';
  }, 'asks with a turn running');
  await closeDialog().getByText('Рабочая').waitFor();

  // Cancelling leaves everything as it was: no answer, the window stays.
  await clearCalls();
  await page.getByRole('button', { name: 'Закрыть', exact: true }).click();
  await closeDialog().waitFor({ state: 'detached' });
  assert.deepEqual(await calls('answerClose'), []);

  await emit('close', { fromTray: false });
  await closeDialog().waitFor();
  await page.getByRole('checkbox', { name: 'Запомнить выбор' }).check();
  await clearCalls();
  await closeDialog().getByRole('button', { name: /Оставить в фоне/ }).click();
  await closeDialog().waitFor({ state: 'detached' });
  assert.deepEqual((await calls('answerClose')).map((c) => c[1]), ['tray']);
  assert.ok(((await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === work.id)?.status) === 'working', 'keep running stops nothing');

  await clearCalls();
  await emit('close', { fromTray: false });
  assert.deepEqual((await calls('answerClose')).map((c) => c[1]), ['tray'], 'remembered');
  assert.equal(await closeDialog().count(), 0);

  // Quit from the tray cannot answer "back to the tray".
  await clearCalls();
  await emit('close', { fromTray: true });
  assert.deepEqual((await calls('answerClose')).map((c) => c[1]), ['dialog']);
  await closeDialog().waitFor();
  await page.keyboard.press('Escape');
  await closeDialog().waitFor({ state: 'detached' });

  // The choice can be taken back in the settings.
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('menuitem', { name: 'Настройки' }).click();
  await page.getByRole('combobox', { name: 'При закрытии окна с работающими сессиями' }).click();
  await page.getByRole('option', { name: 'Спрашивать' }).click();
  await clearCalls();
  await emit('close', { fromTray: false });
  assert.deepEqual((await calls('answerClose')).map((c) => c[1]), ['dialog']);
  await page.keyboard.press('Escape');
  await closeDialog().waitFor({ state: 'detached' });

  await srv.api('POST', `/api/tabs/${work.id}/interrupt`);
  await settled(work.id);
  await srv.api('DELETE', `/api/tabs/${work.id}`);
});

test('notifications: only while unfocused, only when on, a click opens the right tab', async () => {
  const work = (await srv.api<Tab>('POST', '/api/tabs', { cwd: srv.dir, title: 'Для уведомлений' })).body;
  await page.getByRole('tab', { name: /Для уведомлений/ }).waitFor();
  await clearCalls();

  await send(work.id, 'привет');
  await settled(work.id);
  await page.waitForTimeout(500);
  assert.deepEqual(await calls('notify'), [], 'focused: nothing');

  await setFocused(false);
  await send(work.id, 'HOLD 400');
  await settled(work.id);
  await page.waitForTimeout(500);
  assert.deepEqual(await calls('notify'), [], 'the end of a turn says nothing: "finished" comes from Claude, through ui_action');

  await clearCalls();
  await send(work.id, 'TOOL Bash {"command":"ls"}');
  await waitUntil(async () => (await calls('notify')).length === 1, 'a notification for the question', 20_000);
  assert.equal(((await calls('notify'))[0][1] as { body: string }).body, 'Claude ждёт ответа');
  const pending = await srv.api('POST', `/api/tabs/${work.id}/interrupt`);
  assert.equal(pending.status, 200);
  await settled(work.id);

  await emit('openTab', work.id);
  await waitUntil(async () => (await page.getByRole('tab', { name: /Для уведомлений/ }).getAttribute('aria-selected')) === 'true', 'the tab is opened');
  await emit('openTab', rootId);
  await waitUntil(async () => (await homeButton(page).getAttribute('aria-current')) === 'page', 'the root tab is Home');

  // The setting turns them off.
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('menuitem', { name: 'Настройки' }).click();
  await page.getByText('Уведомления', { exact: true }).locator('../..').getByRole('checkbox').uncheck();
  await clearCalls();
  await send(work.id, 'тихо');
  await settled(work.id);
  await page.waitForTimeout(500);
  assert.deepEqual(await calls('notify'), []);
  await setFocused(true);
  await page.getByText('Уведомления', { exact: true }).locator('../..').getByRole('checkbox').check();
  await srv.api('DELETE', `/api/tabs/${work.id}`);
});

test('full screen: the bar follows the window, shows real icons dimmed, switches apps, and can be turned off', async () => {
  const bar = page.getByRole('toolbar', { name: 'Запущенные приложения' });
  assert.equal(await bar.count(), 0);
  await clearCalls();
  await page.getByRole('button', { name: 'Во весь экран' }).click();
  assert.deepEqual((await calls('setFullscreen')).map((c) => c[1]), [true]);

  await emit('fullscreen', true);
  await bar.waitFor();
  await emit('apps', [{ id: 101, title: 'Блокнот', icon: PNG }, { id: 102, title: 'Без иконки', icon: null }]);
  const icon = bar.getByRole('button', { name: 'Блокнот' }).locator('img');
  await icon.waitFor();
  assert.equal(await icon.evaluate((el) => getComputedStyle(el).opacity), '0.6');
  assert.equal(await bar.getByRole('button', { name: 'Без иконки' }).innerText(), 'Б', 'no icon: a letter');

  await bar.getByRole('button', { name: 'Блокнот' }).click();
  assert.deepEqual((await calls('activateApp')).map((c) => c[1]), [101]);
  await bar.getByRole('button', { name: 'Свернуть в Windows' }).click();
  assert.equal((await calls('minimize')).length, 1);

  // Windows gave no list: the bar stays as the way back.
  await emit('apps', []);
  await bar.getByRole('button', { name: 'Блокнот' }).waitFor({ state: 'detached' });
  await clearCalls();
  await bar.getByRole('button', { name: 'Выйти из полноэкранного режима' }).click();
  assert.deepEqual((await calls('setFullscreen')).map((c) => c[1]), [false]);

  await page.keyboard.press('F11');
  assert.deepEqual((await calls('setFullscreen')).at(-1)?.[1], false, 'still full screen until the window says otherwise: F11 leaves');
  await emit('fullscreen', false);
  await bar.waitFor({ state: 'detached' });
  await clearCalls();
  await page.keyboard.press('F11');
  assert.deepEqual((await calls('setFullscreen')).map((c) => c[1]), [true]);
  await emit('fullscreen', true);
  await bar.waitFor();

  // The off switch leaves full screen and removes the way in.
  await clearCalls();
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('menuitem', { name: 'Настройки' }).click();
  await page.getByText('Полноэкранный режим', { exact: true }).locator('../..').getByRole('checkbox').uncheck();
  assert.deepEqual((await calls('setFullscreen')).map((c) => c[1]), [false]);
  await bar.waitFor({ state: 'detached' });
  assert.equal(await page.getByRole('button', { name: 'Во весь экран' }).count(), 0);
  await page.getByText('Полноэкранный режим', { exact: true }).locator('../..').getByRole('checkbox').check();
  await emit('fullscreen', false);
});

test('in a plain browser none of the window features exist', async () => {
  const plain = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  plain.setDefaultTimeout(60_000);
  const p = await enter(plain);
  try {
    await homeBox(p).waitFor();
    assert.equal(await p.getByRole('button', { name: 'Во весь экран' }).count(), 0);
    await p.getByRole('button', { name: 'Меню' }).click();
    await p.getByRole('menuitem', { name: 'Настройки' }).click();
    await p.getByText('Язык', { exact: true }).waitFor();
    assert.equal(await p.getByText('При закрытии окна с работающими сессиями').count(), 0);
    assert.equal(await p.getByText('Полноэкранный режим', { exact: true }).count(), 0);
  } finally {
    await plain.close();
  }
});

// Last in the file for this server: it ends the process.
test('"stop everything": the route stops the sessions and the server, and the window quits', async () => {
  await homeButton(page).click();
  const work = (await srv.api<Tab>('POST', '/api/tabs', { cwd: srv.dir, title: 'Останется в истории' })).body;
  const spawned = srv.log().length;
  await send(work.id, 'SLOW');
  let pid = 0;
  await waitUntil(() => {
    const spawn = srv.log().slice(spawned).find((l) => l.kind === 'spawn' && !(l.argv as string[]).includes('--no-session-persistence'));
    pid = (spawn?.pid as number) ?? 0;
    return pid > 0;
  }, 'the session process');
  assert.doesNotThrow(() => process.kill(pid, 0));

  await waitUntil(async () => {
    await clearCalls();
    await emit('close', { fromTray: false });
    return (await calls('answerClose')).at(-1)?.[1] === 'dialog';
  }, 'asks');
  await clearCalls();
  await closeDialog().getByRole('button', { name: /Выключить всё и выйти/ }).click();
  await waitUntil(async () => (await calls('answerClose')).at(-1)?.[1] === 'quit', 'the window quits after the route');

  await waitUntil(async () => {
    try {
      await fetch(`http://127.0.0.1:${srv.port}/health`);
      return false;
    } catch {
      return true;
    }
  }, 'the server is gone');
  await waitUntil(() => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return true;
    }
  }, 'the session process is gone');

  // The socket drop and the failed reconnects of a page that was about to close are not the page's errors.
  await page.close();
});

test('apps watcher: parses lists, asks for each icon once, stays quiet on failure, one process does the looks and the clicks', () => {
  assert.equal(parseApps('not json'), null);
  assert.equal(parseApps('{"a":1}'), null);
  assert.deepEqual(parseApps(JSON.stringify([{ id: 5, title: 'A', path: 'C:\\a.exe' }, { id: -1, title: 'bad' }, { title: 'no id' }, { id: 7, title: 'Elevated', path: null }])), [{ id: 5, title: 'A', path: 'C:\\a.exe' }, { id: 7, title: 'Elevated', path: null }]);
  assert.deepEqual(parseIcon(JSON.stringify({ path: 'C:\\a.exe', icon: 'QQ==' })), { path: 'C:\\a.exe', icon: 'data:image/png;base64,QQ==' });
  assert.equal(parseIcon('[]'), null);

  type Child = EventEmitter & { stdin: { lines: string[]; write(l: string): void; on(): void }; stdout: EventEmitter & { setEncoding(): void }; killed: boolean; kill(): void };
  const spawned: { args: string[]; child: Child }[] = [];
  const spawn = (_cmd: string, args: string[]) => {
    const child: Child = Object.assign(new EventEmitter(), { stdin: { lines: [] as string[], write(l: string) { this.lines.push(l); }, on() {} }, stdout: Object.assign(new EventEmitter(), { setEncoding() {} }), killed: false, kill() { this.killed = true; } });
    spawned.push({ args, child });
    return child;
  };
  const dir = mkdtempSync(join(tmpdir(), 'apps-cache-'));
  const cacheFile = () => join(dir, 'apps-cache.json');
  const shown: { id: number; title: string; icon: string | null }[][] = [];
  const w = createAppsWatcher({ spawn, parentPid: 42, onApps: (a) => shown.push(a), cacheFile });
  w.start();
  w.start();
  assert.equal(spawned.length, 1, 'one process');
  const script = Buffer.from(spawned[0].args.at(-1)!, 'base64').toString('utf16le');
  assert.match(script, /Get-Process -Id 42/);
  assert.match(script, /ExtractAssociatedIcon/);
  assert.ok(script.indexOf('Look\n') < script.indexOf('Win32 }'), 'the list goes out before anything is compiled');

  const child = spawned[0].child;
  const line = JSON.stringify([{ id: 9, title: 'Окно', path: 'C:\\b.exe' }]);
  child.stdout.emit('data', line.slice(0, 10));
  child.stdout.emit('data', `${line.slice(10)}\r\n`);
  child.stdout.emit('data', `${line}\r\n`);
  assert.equal(shown.length, 1, 'a look that finds nothing new is not published');
  assert.deepEqual(shown[0], [{ id: 9, title: 'Окно', icon: null }], 'the list does not wait for the icon');
  assert.deepEqual(child.stdin.lines, ['i C:\\b.exe\n'], 'asked once, not on every look');

  child.stdout.emit('data', `${JSON.stringify({ path: 'C:\\b.exe', icon: 'QQ==' })}\r\n`);
  assert.deepEqual(shown.at(-1), [{ id: 9, title: 'Окно', icon: 'data:image/png;base64,QQ==' }]);

  w.activate(1234);
  assert.equal(child.stdin.lines.length, 1, 'an id it did not list goes nowhere');
  w.activate(9);
  assert.equal(child.stdin.lines.at(-1), 'a 9\n');
  assert.equal(spawned.length, 1, 'a click starts no process');

  w.stop();
  assert.equal(child.killed, true, 'hidden bar: the process is gone');
  child.emit('exit');
  assert.equal(shown.length, 2, 'our own kill is not a failure');
  w.activate(9);
  assert.equal(child.stdin.lines.at(-1), 'a 9\n');

  w.start();
  spawned[1].child.stdout.emit('data', `${line}\r\n`);
  assert.deepEqual(spawned[1].child.stdin.lines, [], 'an icon it has is not asked for again');
  spawned[1].child.emit('exit', 1);
  assert.deepEqual(shown.at(-1), [], 'a dead process: a bar without icons');

  const broken = createAppsWatcher({ spawn: () => { throw new Error('no powershell'); }, parentPid: 42, onApps: () => {} });
  broken.start();
  broken.activate(1);
  assert.deepEqual(broken.current(), []);

  // The bar of the next start: full at once, from what the last one saw.
  writeFileSync(cacheFile(), JSON.stringify({ rows: [{ id: 9, title: 'Окно', path: 'C:\\b.exe' }], icons: [['C:\\b.exe', 'data:image/png;base64,QQ==']] }));
  const later = createAppsWatcher({ spawn, parentPid: 42, onApps: () => {}, cacheFile });
  assert.deepEqual(later.current(), [{ id: 9, title: 'Окно', icon: 'data:image/png;base64,QQ==' }]);
  writeFileSync(cacheFile(), 'not json');
  assert.deepEqual(createAppsWatcher({ spawn, parentPid: 42, onApps: () => {}, cacheFile }).current(), [], 'a broken file is an empty bar');
  rmSync(dir, { recursive: true });
});

// One start of the window against the given window.json. Windows itself is not exercised: only what main.cjs asks of the window.
async function startMain(userData: string, platform: string) {
  class Win extends EventEmitter {
    full = false;
    webContents = Object.assign(new EventEmitter(), { send() {}, getURL: () => 'http://127.0.0.1:47999/', setWindowOpenHandler() {} });
    loaded = false;
    loadURL(url: string) {
      this.loaded = url.startsWith('http://127.0.0.1:47999');
      return Promise.resolve();
    }
    maximize() {}
    isMaximized() { return false; }
    isMinimized() { return false; }
    isVisible() { return true; }
    isFullScreen() { return this.full; }
    getBounds() { return { x: 1, y: 2, width: 1200, height: 800 }; }
    show() {}
    setFullScreen(on: boolean) { this.full = on; }
  }
  let win!: Win;
  const ipc: Record<string, (e: unknown, v?: unknown) => unknown> = {};
  const electron = {
    app: Object.assign(new EventEmitter(), { setAppUserModelId() {}, requestSingleInstanceLock: () => true, getPath: () => userData, getLocale: () => 'ru-RU', whenReady: () => Promise.resolve(), quit() {}, exit() {} }),
    BrowserWindow: class extends Win { constructor() { super(); win = this; } },
    ipcMain: { on: (c: string, f: (e: unknown, v?: unknown) => unknown) => { ipc[c] = f; }, handle() {} },
    Menu: { setApplicationMenu() {}, buildFromTemplate: (t: unknown) => t },
    Notification: class {},
    shell: { openExternal() {} },
    session: { defaultSession: { setPermissionRequestHandler() {} } },
    Tray: class extends EventEmitter { setToolTip() {} setContextMenu() {} },
  };
  const spawn = (cmd: string) => {
    const child = Object.assign(new EventEmitter(), { stdout: Object.assign(new EventEmitter(), { setEncoding() {} }), stderr: new EventEmitter(), kill() {} });
    if (cmd === 'wsl.exe') setImmediate(() => child.stdout.emit('data', 'READY http://127.0.0.1:47999/auth?token=x\n'));
    return child;
  };
  type Loader = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const loader = Module as unknown as Loader;
  const realLoad = loader._load;
  const realPlatform = process.platform;
  loader._load = (request, parent, isMain) => {
    if (request === 'electron') return electron;
    if (request === 'node:child_process') return { spawn };
    if (request === './install.json') return { distro: 'd', node: 'n', serve: 's' };
    return realLoad(request, parent, isMain);
  };
  Object.defineProperty(process, 'platform', { value: platform });
  const mainPath = require.resolve('../desktop/main.cjs');
  try {
    delete require.cache[mainPath];
    require(mainPath);
    await waitUntil(() => win?.loaded === true, 'the page loads');
    win.emit('ready-to-show');
    return {
      win,
      toggle: (on: boolean) => ipc['fullscreen-set']({ sender: win.webContents, senderFrame: { url: 'http://127.0.0.1:47999/' } }, on),
      close: () => { electron.app.emit('before-quit'); win.emit('close', { preventDefault() {} }); },
    };
  } finally {
    loader._load = realLoad;
    Object.defineProperty(process, 'platform', { value: realPlatform });
    delete require.cache[mainPath];
  }
}

test('main process: full screen by default on Windows, until the user leaves it himself', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'claude-os-desktop-'));
  const file = join(userData, 'window.json');
  const stored = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  try {
    assert.equal((await startMain(userData, 'win32')).win.full, true, 'first start: no file');

    // What every existing install has: the state at the last close, and nobody ever chose it.
    writeFileSync(file, JSON.stringify({ x: 1, y: 2, width: 1200, height: 800, fullscreen: false, maximized: false }));
    let run = await startMain(userData, 'win32');
    assert.equal(run.win.full, true, 'an old file does not keep it out');

    // The user leaves it: remembered at once and through the close, the bounds kept.
    run.toggle(false);
    assert.equal(run.win.full, false);
    assert.equal(stored().fullscreenChoice, false);
    run.close();
    assert.equal(stored().fullscreenChoice, false);
    assert.equal(stored().width, 1200);
    run = await startMain(userData, 'win32');
    assert.equal(run.win.full, false, 'the choice holds');

    // And comes back to it.
    run.toggle(true);
    assert.equal(run.win.full, true);
    run.close();
    assert.equal(stored().fullscreenChoice, true);
    assert.equal((await startMain(userData, 'win32')).win.full, true);

    // Anywhere but Windows the window stays a window.
    rmSync(file);
    assert.equal((await startMain(userData, 'linux')).win.full, false);
  } finally {
    rmSync(userData, { recursive: true, force: true });
  }
});

test('main process against a fake electron: close, tray, notifications, full screen', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'claude-os-desktop-'));
  writeFileSync(join(userData, 'window.json'), JSON.stringify({ width: 1600, height: 1000, fullscreenChoice: false })); // out of full screen: this test goes in by hand
  const ipc: Record<string, (e: unknown, v?: unknown) => unknown> = {};
  const handlers: Record<string, () => unknown> = {};
  const spawnedPs: (EventEmitter & { killed: boolean; kill(): void })[] = [];
  let quitCalls = 0;
  const notifications: (EventEmitter & { options: unknown })[] = [];
  const popups: { label?: string }[][] = [];

  class FakeTray extends EventEmitter {
    menu: { label?: string; click?: () => void }[] = [];
    balloons: unknown[] = [];
    setToolTip() {}
    setContextMenu(m: { label?: string; click?: () => void }[]) { this.menu = m; }
    displayBalloon(b: unknown) { this.balloons.push(b); }
  }
  let tray!: FakeTray;
  class FakeWindow extends EventEmitter {
    state = { visible: false, minimized: false, full: false, hides: 0, restores: 0, focuses: 0 };
    sent: [string, unknown][] = [];
    url = '';
    webContents = Object.assign(new EventEmitter(), {
      send: (c: string, v: unknown) => void this.sent.push([c, v]),
      getURL: () => this.url,
      setWindowOpenHandler() {},
    });
    options: { webPreferences: { preload: string } };
    constructor(options: { webPreferences: { preload: string } }) {
      super();
      this.options = options;
      win = this;
    }
    loadURL(u: string) {
      this.url = u;
      return Promise.resolve();
    }
    maximize() {}
    isMaximized() { return false; }
    isMinimized() { return this.state.minimized; }
    isVisible() { return this.state.visible; }
    isFullScreen() { return this.state.full; }
    getBounds() { return { x: 1, y: 2, width: 1200, height: 800 }; }
    show() { this.state.visible = true; this.emit('show'); }
    hide() { this.state.visible = false; this.state.hides++; this.emit('hide'); }
    focus() { this.state.focuses++; }
    restore() { this.state.minimized = false; this.state.restores++; this.emit('restore'); }
    minimize() { this.state.minimized = true; this.emit('minimize'); }
    setFullScreen(on: boolean) {
      this.state.full = on;
      this.emit(on ? 'enter-full-screen' : 'leave-full-screen');
    }
  }
  let win!: FakeWindow;
  class FakeNotification extends EventEmitter {
    static isSupported = () => true;
    options: unknown;
    constructor(options: unknown) {
      super();
      this.options = options;
    }
    show() { notifications.push(this); }
  }
  const electron = {
    app: Object.assign(new EventEmitter(), {
      setAppUserModelId() {},
      requestSingleInstanceLock: () => true,
      getPath: () => userData,
      getLocale: () => 'ru-RU', // the tray starts in the OS language, the page then sends its own labels
      whenReady: () => Promise.resolve(),
      quit() { quitCalls++; },
      exit() {},
    }),
    BrowserWindow: FakeWindow,
    ipcMain: { on: (c: string, f: (e: unknown, v?: unknown) => unknown) => { ipc[c] = f; }, handle: (c: string, f: () => unknown) => { handlers[c] = f; } },
    Menu: { setApplicationMenu() {}, buildFromTemplate: (t: unknown) => Object.assign(t as object, { popup() { popups.push(t as { label?: string }[]); } }) },
    Notification: FakeNotification,
    shell: { openExternal() {} },
    session: { defaultSession: { setPermissionRequestHandler() {} } },
    Tray: class extends FakeTray { constructor() { super(); tray = this; } },
  };
  const spawn = (cmd: string) => {
    const child = Object.assign(new EventEmitter(), { stdin: { write() {}, on() {} }, stdout: Object.assign(new EventEmitter(), { setEncoding() {} }), stderr: new EventEmitter(), killed: false, kill() { this.killed = true; } });
    if (cmd === 'wsl.exe') setImmediate(() => child.stdout.emit('data', 'READY http://127.0.0.1:47999/auth?token=x\n'));
    else spawnedPs.push(child);
    return child;
  };

  type Loader = { _load: (request: string, parent: unknown, isMain: boolean) => unknown };
  const loader = Module as unknown as Loader;
  const realLoad = loader._load;
  const realPlatform = process.platform;
  loader._load = (request, parent, isMain) => {
    if (request === 'electron') return electron;
    if (request === 'node:child_process') return { spawn };
    if (request === './install.json') return { distro: 'd', node: 'n', serve: 's' };
    return realLoad(request, parent, isMain);
  };
  Object.defineProperty(process, 'platform', { value: 'win32' });
  const mainPath = require.resolve('../desktop/main.cjs');
  try {
    delete require.cache[mainPath];
    require(mainPath);
    await waitUntil(() => win?.url.startsWith('http://127.0.0.1:47999'), 'the page loads');
    assert.match(win.options.webPreferences.preload, /preload\.cjs$/);
    win.emit('ready-to-show');
    assert.equal(win.state.visible, true);
    const page_ = { sender: win.webContents, senderFrame: { url: 'http://127.0.0.1:47999/' } };
    const closeEvent = () => {
      let prevented = false;
      win.emit('close', { preventDefault: () => { prevented = true; } });
      return prevented;
    };
    const closes = () => win.sent.filter((s) => s[0] === 'close-request').map((s) => s[1]);

    // Another page gets no say.
    ipc['close-answer']({ sender: {}, senderFrame: { url: 'http://evil/' } }, 'quit');
    assert.equal(quitCalls, 0);

    // The tray hides the window, nothing stops.
    assert.equal(closeEvent(), true, 'closing waits for the page');
    assert.deepEqual(closes(), [{ fromTray: false }]);
    ipc['close-answer'](page_, 'tray');
    assert.equal(win.state.visible, false);
    assert.equal(win.state.hides, 1);
    assert.equal(quitCalls, 0);

    // A notification while hidden: the click brings the window and the tab.
    ipc.notify(page_, { title: 'T', body: 'B', tabId: 'tab-1' });
    assert.equal(notifications.length, 1);
    notifications[0].emit('click');
    assert.equal(win.state.visible, true);
    assert.deepEqual(win.sent.at(-1), ['open-tab', 'tab-1']);
    // No toast from Windows: the tray balloon says it instead.
    ipc.notify(page_, { title: 'T2', body: 'B2', tabId: 'tab-2' });
    notifications[1].emit('failed', {}, 'no shortcut');
    assert.equal(tray.balloons.length, 1);
    tray.emit('balloon-click');
    assert.deepEqual(win.sent.at(-1), ['open-tab', 'tab-2']);

    // The tray menu: open, and quit through the same question.
    ipc['close-answer'](page_, 'tray');
    tray.menu.find((i) => i.label === 'Открыть')!.click!();
    assert.equal(win.state.visible, true);
    const editMenu = () => {
      win.webContents.emit('context-menu', {}, { isEditable: true, selectionText: '' });
      return popups.at(-1)!.map((i) => i.label);
    };
    assert.deepEqual(editMenu(), ['Вырезать', 'Копировать', 'Вставить'], 'the OS language before the page speaks');
    ipc.labels(page_, { open: 'Open', quit: 'Quit', cut: 'Cut', copy: 'Copy', paste: 'Paste' });
    assert.deepEqual(editMenu(), ['Cut', 'Copy', 'Paste'], 'then the page language');
    win.hide();
    tray.menu.find((i) => i.label === 'Quit')!.click!();
    assert.deepEqual(closes().at(-1), { fromTray: true });
    ipc['close-answer'](page_, 'dialog');
    assert.equal(win.state.visible, true, 'the dialog needs the window');

    // Full screen: the look at Windows runs only while the bar can be seen.
    assert.equal(spawnedPs.length, 0);
    ipc['fullscreen-set'](page_, true);
    assert.equal(win.state.full, true);
    assert.deepEqual(win.sent.at(-1), ['fullscreen', true]);
    assert.equal(spawnedPs.length, 1);
    assert.equal(handlers['fullscreen-get'](), true);
    win.minimize();
    assert.equal(spawnedPs[0].killed, true, 'minimized: stopped');
    win.restore();
    assert.equal(spawnedPs.length, 2);
    win.hide();
    assert.equal(spawnedPs[1].killed, true, 'hidden: stopped');
    win.show();
    assert.equal(spawnedPs.length, 3);
    ipc['fullscreen-set'](page_, false);
    assert.equal(spawnedPs[2].killed, true, 'left full screen: stopped');

    // A page that does not answer does not keep the app open.
    ipc['fullscreen-set'](page_, true);
    assert.equal(closeEvent(), true);
    await waitUntil(() => quitCalls === 1, 'quits without an answer', 4000);
    assert.equal(JSON.parse(readFileSync(join(userData, 'window.json'), 'utf8')).fullscreen, true, 'the mode is remembered');
    assert.equal(closeEvent(), false, 'quitting: the close goes through');
  } finally {
    loader._load = realLoad;
    Object.defineProperty(process, 'platform', { value: realPlatform });
    delete require.cache[mainPath];
    electron.app.emit('will-quit');
    rmSync(userData, { recursive: true, force: true });
  }
});
