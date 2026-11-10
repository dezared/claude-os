const { app, BrowserWindow, ipcMain, Menu, Notification, screen, shell, session, systemPreferences, Tray } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createAppsWatcher } = require('./apps.cjs');
const install = require('./install.json');

const BG = '#09090b';
const selftestArg = process.argv.find((a) => a.startsWith('--selftest='));
const selftest = selftestArg ? selftestArg.slice('--selftest='.length) : null;
let win = null;
let origin = null;
let tray = null;
let quitting = false;
let closeTimer = null;
let onBalloon = null;
let micRequest = null; // the last request for the microphone, for the self-test
const problems = [];
const notices = new Set(); // a collected Notification no longer reports its click
// Start screens, and the edit menu and the tray until the page sends its labels: in the language of the OS. Read after `ready`.
const TEXT = {
  en: { open: 'Open', quit: 'Quit', retry: 'Retry', starting: 'Starting Claude OS…', firstRun: 'The first start takes a few seconds.', failed: 'Claude OS did not start', noAnswer: 'No answer from WSL within 60 seconds.', exited: 'wsl.exe exited with code', cut: 'Cut', copy: 'Copy', paste: 'Paste' },
  ru: { open: 'Открыть', quit: 'Выйти', retry: 'Повторить', starting: 'Запускаю Claude OS…', firstRun: 'Первый запуск занимает несколько секунд.', failed: 'Claude OS не запустился', noAnswer: 'Нет ответа от WSL за 60 секунд.', exited: 'wsl.exe завершился с кодом', cut: 'Вырезать', copy: 'Копировать', paste: 'Вставить' }, // shippable-allow: the Russian start screens
};
const text = () => TEXT[app.getLocale().toLowerCase().startsWith('ru') ? 'ru' : 'en'];
const labels = { open: null, quit: null, cut: null, copy: null, paste: null }; // what the page sent, in the UI language
const CLOSE_ANSWER_MS = 1500;
const appIcon = path.join(__dirname, 'icon.ico');
const canFullscreen = process.platform === 'win32';
const webPreferences = () => ({ contextIsolation: true, nodeIntegration: false, sandbox: true, preload: path.join(__dirname, 'preload.cjs') });
const popouts = new Map(); // key -> { win, kind }: one window per session, one for the planner
const POPOUT_SIZE = { width: 480, height: 680 };
const PLANNER_WIDTH = 650; // room to read and edit a note
const POPOUT_MIN = { minWidth: 340, minHeight: 240 };
const POPOUT_STEP = 28;
const GHOST_AWAY = 0.7; // the pinned planner while the owner is elsewhere
const GHOST_HOVER = 0.35; // and with the mouse over it
const GHOST_STEP_MS = 16;
const GHOST_EASE = 0.16; // of the way left, each step: about 0.4 s in all
const GHOST_WATCH_MS = 100;
const apps = createAppsWatcher({ spawn, parentPid: process.pid, onApps: (list) => win?.webContents.send('apps', list), cacheFile: () => path.join(app.getPath('userData'), 'apps-cache.json') });

app.setAppUserModelId('ClaudeOS');
if (!selftest && !app.requestSingleInstanceLock()) app.quit();

const boundsFile = () => path.join(app.getPath('userData'), 'window.json');

function readBounds() {
  try {
    return JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
  } catch {
    return { width: 1600, height: 1000, maximized: true };
  }
}

// `fullscreen` in the file is the state at the last close, false for everyone who never touched it. Only a choice of the user keeps the window out of full screen.
function rememberFullscreen(on) {
  try { fs.writeFileSync(boundsFile(), JSON.stringify({ ...readBounds(), fullscreenChoice: on })); } catch {}
}

const screenHtml = (title, detail, retry) => `<!doctype html><meta charset="utf-8"><title>Claude OS</title>
<style>
html,body{height:100%;margin:0;background:${BG};color:#fafafa;font:13px/1.5 "Segoe UI",system-ui,sans-serif;-webkit-app-region:drag}
body{display:flex;align-items:center;justify-content:center}
main{max-width:640px;padding:32px}
i{display:block;width:8px;height:8px;border-radius:2px;background:#d97757;margin-bottom:14px;${retry ? '' : 'animation:p 1.1s ease-in-out infinite'}}
@keyframes p{50%{opacity:.25}}
pre{color:#a1a1aa;white-space:pre-wrap;font:12px/1.5 Consolas,monospace;margin:8px 0 16px;user-select:text}
a{color:#d97757;-webkit-app-region:no-drag}
</style><main><i></i><div>${title}</div><pre>${detail}</pre>${retry ? `<a href="claudeos://retry">${text().retry}</a>` : ''}</main>`;

const showScreen = (title, detail = '', retry = false) =>
  win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(screenHtml(title, detail, retry))}`);

function escapeHtml(s) {
  return String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

// Resolves with the login URL. The wsl.exe child is left running on purpose, see serve.mjs.
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'wsl.exe',
      ['-d', install.distro, '--exec', install.node, '--disable-warning=ExperimentalWarning', install.serve],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`${text().noAnswer}\n${err}`)), 60_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.stdout.on('data', (d) => {
      out += d.toString();
      const m = out.match(/READY (\S+)/);
      if (m) { clearTimeout(timer); resolve(m[1]); }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${text().exited} ${code}.\n${err}`));
    });
  });
}

async function boot() {
  showScreen(text().starting, text().firstRun);
  try {
    const url = await startServer();
    origin = new URL(url).origin;
    await win.loadURL(url);
  } catch (e) {
    problems.push(String(e.message));
    showScreen(text().failed, escapeHtml(e.message), true);
  }
}

function isAllowedExternal(url) {
  return /^(https?:|obsidian:)/i.test(url);
}

// Navigation stays on the local server. Everything else goes to the system through an allow-list.
function guardNavigation(w, stays) {
  w.webContents.on('will-navigate', (e, url) => {
    if (stays(url)) return;
    e.preventDefault();
    if (isAllowedExternal(url) && !(origin && url.startsWith(`${origin}/`))) shell.openExternal(url);
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function quit() {
  clearTimeout(closeTimer);
  quitting = true;
  app.quit();
}

// The page knows the sessions and shows the dialog. A page that does not answer must not make the window uncloseable.
function askToClose(fromTray) {
  if (!win || !origin || !win.webContents.getURL().startsWith(origin)) return quit();
  clearTimeout(closeTimer);
  closeTimer = setTimeout(quit, CLOSE_ANSWER_MS);
  win.webContents.send('close-request', { fromTray });
}

function buildTray() {
  try {
    tray ??= new Tray(appIcon);
  } catch (e) {
    problems.push(`tray: ${e.message}`);
    return;
  }
  tray.setToolTip('Claude OS');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: labels.open ?? text().open, click: showWindow },
    { type: 'separator' },
    { label: labels.quit ?? text().quit, click: () => askToClose(true) },
  ]));
  tray.removeAllListeners('click');
  tray.removeAllListeners('balloon-click');
  tray.on('click', showWindow);
  tray.on('balloon-click', () => onBalloon?.());
}

function notify({ title, body, tabId }) {
  const text = { title: String(title).slice(0, 200), body: String(body).slice(0, 500) };
  const open = () => {
    showWindow();
    win?.webContents.send('open-tab', String(tabId));
  };
  const balloon = () => {
    onBalloon = open;
    tray?.displayBalloon({ title: text.title, content: text.body, icon: appIcon });
  };
  if (!Notification.isSupported()) return balloon();
  const n = new Notification({ ...text, icon: appIcon });
  notices.add(n);
  n.on('click', () => { notices.delete(n); open(); });
  n.on('close', () => notices.delete(n));
  n.on('failed', () => { notices.delete(n); balloon(); });
  n.show();
}

// The bar is only worth a look while it can be seen.
function syncApps() {
  if (win && win.isFullScreen() && win.isVisible() && !win.isMinimized()) apps.start();
  else apps.stop();
}

const popoutsFile = () => path.join(app.getPath('userData'), 'popouts.json');

function readPopouts() {
  try {
    return JSON.parse(fs.readFileSync(popoutsFile(), 'utf8'));
  } catch {
    return {};
  }
}

function rememberPopout(kind, patch) {
  const all = readPopouts();
  try { fs.writeFileSync(popoutsFile(), JSON.stringify({ ...all, [kind]: { ...all[kind], ...patch } })); } catch {}
}

// The page names what it wants, the address is built here: nothing else can be loaded into a window.
function popoutTarget(req) {
  if (req?.kind === 'root' || req?.kind === 'planner' || req?.kind === 'service') return { kind: req.kind, key: req.kind, route: `/?popout=${req.kind}` };
  if (req?.kind === 'tab' && typeof req.id === 'string' && /^[\w-]{1,64}$/.test(req.id)) return { kind: 'tab', key: `tab:${req.id}`, route: `/?popout=tab&id=${req.id}` };
  return null;
}

// Where the last one of this kind stood, unless that monitor is gone. The next one does not hide the one already open.
function popoutBounds(kind) {
  const saved = readPopouts()[kind] ?? {};
  const area = screen.getPrimaryDisplay().workArea;
  const width = saved.width ?? (kind === 'planner' ? PLANNER_WIDTH : POPOUT_SIZE.width);
  const height = saved.height ?? POPOUT_SIZE.height;
  const bounds = { width, height, x: area.x + area.width - width - 24, y: area.y + area.height - height - 24 };
  if (Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    const seen = screen.getDisplayMatching({ ...bounds, x: saved.x, y: saved.y }).workArea;
    const onScreen = saved.x < seen.x + seen.width && saved.x + width > seen.x && saved.y < seen.y + seen.height && saved.y + height > seen.y;
    if (onScreen) Object.assign(bounds, { x: saved.x, y: saved.y });
  }
  const taken = (b) => [...popouts.values()].some((p) => { const o = p.win.getBounds(); return o.x === b.x && o.y === b.y; });
  while (taken(bounds)) {
    bounds.x += POPOUT_STEP;
    bounds.y += POPOUT_STEP;
  }
  return bounds;
}

const sendPopouts = () => win?.webContents.send('popouts', [...popouts.keys()]);

function raise(w) {
  if (w.isMinimized()) w.restore();
  w.show();
  w.focus();
}

// The planner pinned over other windows while the owner works elsewhere: it lets the screen show through, more so under the mouse.
// A click on it is an ordinary click that also activates the window, and with that it is solid again. Native opacity, so the fade lives here.
function ghostWhenAway(w) {
  let shown = 1;
  let goal = 1;
  let fade = null;
  let watch = null;
  const step = () => {
    if (w.isDestroyed()) return stop();
    shown += (goal - shown) * GHOST_EASE;
    if (Math.abs(goal - shown) < 0.01) {
      shown = goal;
      clearInterval(fade);
      fade = null;
    }
    w.setOpacity(shown);
  };
  const under = () => {
    const at = screen.getCursorScreenPoint();
    const b = w.getBounds();
    return at.x >= b.x && at.x < b.x + b.width && at.y >= b.y && at.y < b.y + b.height;
  };
  // An inactive window hears of the mouse unevenly across systems, and this one need not ask the page: the position is polled, only while away.
  const sync = () => {
    if (w.isDestroyed()) return stop();
    const away = w.isAlwaysOnTop() && w.isVisible() && !w.isMinimized() && !w.isFocused();
    if (away && !watch) watch = setInterval(sync, GHOST_WATCH_MS);
    if (!away && watch) {
      clearInterval(watch);
      watch = null;
    }
    goal = !away ? 1 : under() ? GHOST_HOVER : GHOST_AWAY;
    if (!fade && shown !== goal) fade = setInterval(step, GHOST_STEP_MS);
  };
  const stop = () => {
    clearInterval(fade);
    clearInterval(watch);
    fade = null;
    watch = null;
  };
  for (const event of ['focus', 'blur', 'show', 'hide', 'minimize', 'restore']) w.on(event, sync);
  w.on('closed', stop);
  return sync;
}

function openPopout(req) {
  const target = popoutTarget(req);
  if (!target || !origin) return;
  const open = popouts.get(target.key);
  if (open) return raise(open.win);
  const url = origin + target.route;
  const w = new BrowserWindow({
    ...popoutBounds(target.kind),
    ...POPOUT_MIN,
    backgroundColor: BG,
    title: 'Claude OS',
    icon: appIcon,
    frame: false,
    show: false,
    webPreferences: webPreferences(),
  });
  // The highest level Windows has for a window of an app: over everything but an exclusive-fullscreen game. It stays in Alt+Tab.
  w.setAlwaysOnTop(readPopouts()[target.kind]?.pin !== false, 'screen-saver');
  popouts.set(target.key, { win: w, kind: target.kind, ghost: target.kind === 'planner' ? ghostWhenAway(w) : null });
  w.once('ready-to-show', () => w.show());
  guardNavigation(w, (to) => to === url);
  w.webContents.on('did-fail-load', (_e, code, desc, failed, mainFrame) => {
    if (!mainFrame || code === -3) return;
    problems.push(`load ${failed}: ${desc}`);
    setTimeout(() => { if (!w.isDestroyed()) w.loadURL(url); }, 2000); // a server restarting: not a blank window over everything
  });
  // Closing it touches nothing on the server: the session lives there and goes on.
  w.on('close', () => rememberPopout(target.kind, w.getBounds()));
  w.on('closed', () => {
    popouts.delete(target.key);
    sendPopouts();
  });
  w.loadURL(url);
  sendPopouts();
}

const viewOf = (key) => (key === 'planner' ? 'planner' : key === 'root' ? { kind: 'home' } : { kind: 'tab', id: key.slice('tab:'.length) });

function showInMain(view) {
  showWindow();
  win?.webContents.send('show-view', view);
}

// The window goes, the same chat is in the main window: first gone, so the page sees it as no longer out.
function returnPopout(key) {
  const open = popouts.get(key);
  if (!open) return showInMain(viewOf(key));
  open.win.once('closed', () => showInMain(viewOf(key)));
  open.win.close();
}

function listenToPopouts() {
  const popoutOf = (sender) => [...popouts].find(([, p]) => p.win.webContents === sender);
  const ours = (e) => Boolean(origin && e.senderFrame?.url.startsWith(`${origin}/`) && (e.sender === win?.webContents || popoutOf(e.sender)));
  const on = (channel, fn) => ipcMain.on(channel, (e, value) => { if (ours(e)) fn(value, popoutOf(e.sender)); });
  on('popout-open', (req) => openPopout(req));
  on('popout-return', (key, self) => {
    if (self) returnPopout(self[0]);
    else if (typeof key === 'string' && popouts.has(key)) returnPopout(key);
  });
  on('popout-go', (view) => { if (view && typeof view === 'object') showInMain(view); });
  on('popout-pin', (value, self) => {
    if (!self) return;
    self[1].win.setAlwaysOnTop(Boolean(value), 'screen-saver');
    rememberPopout(self[1].kind, { pin: Boolean(value) });
    self[1].ghost?.();
  });
  on('popout-window', (action, self) => {
    if (action === 'minimize') self?.[1].win.minimize();
    else if (action === 'close') self?.[1].win.close();
  });
  ipcMain.handle('popouts-get', (e) => (ours(e) ? [...popouts.keys()] : []));
  ipcMain.handle('popout-pin-get', (e) => Boolean(popoutOf(e.sender)?.[1].win.isAlwaysOnTop()));
}

function listenToPage() {
  const handle = (channel, fn) => ipcMain.on(channel, (e, value) => {
    if (win && origin && e.sender === win.webContents && e.senderFrame?.url.startsWith(origin)) fn(value);
  });
  handle('close-answer', (choice) => {
    clearTimeout(closeTimer);
    if (choice === 'quit') quit();
    else if (choice === 'dialog') showWindow();
    else if (choice === 'tray') {
      if (tray) win.hide();
      else win.minimize();
    }
  });
  handle('notify', notify);
  handle('labels', (next) => {
    for (const key of Object.keys(labels)) if (next?.[key] != null) labels[key] = String(next[key]);
    if (tray) buildTray();
  });
  handle('fullscreen-set', (on) => {
    if (!canFullscreen) return;
    win.setFullScreen(Boolean(on));
    rememberFullscreen(Boolean(on));
  });
  handle('minimize', () => win.minimize());
  handle('apps-activate', (id) => apps.activate(id));
  ipcMain.handle('fullscreen-get', () => Boolean(win?.isFullScreen()));
  ipcMain.handle('apps-get', () => apps.current());
}

function createWindow() {
  const b = readBounds();
  win = new BrowserWindow({
    width: b.width,
    height: b.height,
    x: b.x,
    y: b.y,
    minWidth: 1100,
    minHeight: 680,
    backgroundColor: BG,
    title: 'Claude OS',
    icon: appIcon,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#00000000', symbolColor: '#a1a1aa', height: 44 },
    show: false,
    webPreferences: webPreferences(),
  });
  if (b.maximized) win.maximize();
  win.once('ready-to-show', () => {
    win.show();
    if (b.fullscreenChoice !== false && canFullscreen) win.setFullScreen(true);
  });
  for (const [event, on] of [['enter-full-screen', true], ['leave-full-screen', false]]) {
    win.on(event, () => {
      win.webContents.send('fullscreen', on);
      syncApps();
    });
  }
  for (const event of ['show', 'hide', 'minimize', 'restore']) win.on(event, syncApps);

  guardNavigation(win, (url) => {
    if (url === 'claudeos://retry') { boot(); return false; }
    return Boolean(origin && url.startsWith(origin));
  });

  win.webContents.on('did-fail-load', (_e, code, desc, url, mainFrame) => {
    if (!mainFrame || code === -3) return; // -3 is an aborted navigation
    problems.push(`load ${url}: ${desc}`);
    if (origin && url.startsWith(origin)) boot();
  });
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error') problems.push(`console: ${e.message}`);
  });

  win.webContents.on('context-menu', (_e, p) => {
    const items = [];
    if (p.isEditable) items.push({ role: 'cut', label: labels.cut ?? text().cut });
    if (p.selectionText || p.isEditable) items.push({ role: 'copy', label: labels.copy ?? text().copy });
    if (p.isEditable) items.push({ role: 'paste', label: labels.paste ?? text().paste });
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  win.on('close', (e) => {
    const fullscreen = win.isFullScreen();
    const maximized = win.isMaximized();
    const { fullscreenChoice } = readBounds();
    const data = fullscreen ? { ...readBounds(), fullscreen } : maximized ? { ...readBounds(), fullscreen, maximized } : { ...win.getBounds(), fullscreen, maximized, fullscreenChoice };
    try { fs.writeFileSync(boundsFile(), JSON.stringify(data)); } catch {}
    if (quitting || selftest) return;
    e.preventDefault();
    askToClose(false);
  });
  win.on('closed', () => {
    win = null;
    apps.stop();
  });
}

// Check for the installed app: stores a screenshot and the errors it saw, then quits.
async function runSelftest() {
  const events = [];
  let gpu = null;
  const started = Date.now();
  const note = (name, ...rest) => events.push(`${Date.now() - started}ms ${name} ${rest.join(' ').replace(/token=[^&\s]+/, 'token=***').slice(0, 160)}`);
  const wc = win.webContents;
  wc.on('did-start-navigation', (d) => note('start', d.url));
  wc.on('did-redirect-navigation', (d) => note('redirect', d.url));
  wc.on('did-finish-load', () => note('finish', wc.getURL()));
  wc.on('did-fail-load', (_e, code, desc, url) => note('fail', code, desc, url));
  wc.on('render-process-gone', (_e, d) => note('gone', d.reason));
  const finish = () => {
    fs.writeFileSync(`${selftest}.json`, JSON.stringify({
      url: wc.getURL().replace(/token=[^&]+/, 'token=***').slice(0, 200),
      title: win.getTitle(),
      size: win.getBounds(),
      electron: process.versions.electron,
      gpu,
      problems: problems.map((p) => p.replace(/token=[^&\s:]+/g, 'token=***').slice(0, 300)),
      events,
    }, null, 2));
    app.exit(0);
  };
  await new Promise((r) => setTimeout(r, Number(process.env.CLAUDE_OS_SELFTEST_MS ?? 12_000)));
  const image = await Promise.race([wc.capturePage(), new Promise((r) => setTimeout(r, 10_000))]);
  if (image) fs.writeFileSync(selftest, image.toPNG());
  else note('capture timed out');
  // Opens the microphone and closes it at once, nothing is recorded.
  const mic = await Promise.race([wc.executeJavaScript(`navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: true } })
    .then((s) => { const label = s.getTracks()[0]?.label; s.getTracks().forEach((t) => t.stop()); return 'ok: ' + label; }, (e) => e.name + ': ' + e.message)`, true), new Promise((r) => setTimeout(() => r('timed out'), 10_000))]);
  note('mic', mic, 'system', systemPreferences.getMediaAccessStatus('microphone'), JSON.stringify(micRequest));
  // The still map draws nothing, so the speed is measured with the camera moving.
  gpu = await Promise.race([wc.executeJavaScript(`new Promise((res) => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'none';
    const stage = document.querySelector('canvas');
    const start = performance.now();
    let frames = 0, last = start, longest = 0, sign = 1;
    const tick = () => {
      const now = performance.now();
      longest = Math.max(longest, now - last);
      last = now;
      frames++;
      if (stage) stage.dispatchEvent(new WheelEvent('wheel', { deltaY: (sign = -sign) * 40, bubbles: true, cancelable: true }));
      if (now - start < 5000) requestAnimationFrame(tick);
      else res({ renderer, canvas: stage ? stage.width + 'x' + stage.height : null, fps: Math.round(frames / ((now - start) / 1000)), longestFrameMs: Math.round(longest) });
    };
    requestAnimationFrame(tick);
  })`), new Promise((r) => setTimeout(() => r('timed out'), 15_000))]);
  finish();
}

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => apps.stop());

app.whenReady().then(() => {
  // A Mac routes Ctrl+V and friends through the app menu: without its Edit menu nothing pastes there.
  Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate([{ role: 'appMenu' }, { role: 'editMenu' }]) : null);
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb, details) => {
    // The microphone for voice input: audio only, and only for the page of the local server.
    if (permission === 'media') {
      micRequest = { requestingUrl: details.requestingUrl, securityOrigin: details.securityOrigin, mediaTypes: details.mediaTypes, origin };
      cb(Boolean(origin) && details.requestingUrl?.startsWith(`${origin}/`) && details.mediaTypes?.every((m) => m === 'audio'));
      return;
    }
    cb(permission === 'clipboard-sanitized-write' || permission === 'clipboard-read');
  });
  listenToPage();
  listenToPopouts();
  createWindow();
  if (!selftest) buildTray();
  boot();
  if (selftest) runSelftest();
});

app.on('window-all-closed', () => app.quit());
