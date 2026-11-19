// The plugin through a real Claude OS server and the fake CLI, in throwaway directories, against a fake MCP endpoint. Set CLAUDE_OS_WEB_DIST to test another build.
// Anything aimed at the real port 4747 is aborted and fails the run: no annotation can reach the real server. The daemon the
// plugin keeps runs on its own port with the in-memory store, so the user's ~/.agentation is not touched either.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';
import { importNotes } from '../server/importNotes.ts';

const PLUGIN = join(import.meta.dirname, '..');
const REPO = join(PLUGIN, '../..');
const PORT = 47932;
const FAKE_PORT = 47933;
const DAEMON_PORT = 47934;
const daemon = `http://127.0.0.1:${DAEMON_PORT}`;
const base = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.AGENTATION_SHOTS ?? tmpdir();

let dir, server, browser, context, page, tabId, fake;
const errors = [];
const vendorRequests = [];
const realPort = [];
const sends = [];
const hits = [];
const proxied = [];
const annotations = [];

function startFake() {
  const session = () => ({ id: 's1', url: base, status: 'active', createdAt: new Date().toISOString(), annotations });
  const sockets = new Set();
  const srv = createServer((req, res) => {
    const cors = { 'access-control-allow-origin': req.headers.origin ?? '*', 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'access-control-allow-headers': 'content-type' };
    hits.push(`${req.method} ${req.url}`);
    if (req.method === 'OPTIONS') return void res.writeHead(204, cors).end();
    if (req.url === '/sessions/s1/events') return void res.writeHead(200, { ...cors, 'content-type': 'text/event-stream' }).write(': hi\n\n');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const json = (data) => res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (req.url === '/health') return json({ status: 'ok' });
      if (req.method === 'POST' && req.url === '/sessions') return json(session());
      if (req.method === 'GET' && req.url === '/sessions/s1') return json(session());
      if (req.method === 'POST' && req.url === '/sessions/s1/annotations') {
        const a = JSON.parse(body);
        annotations.push(a);
        return json(a);
      }
      return json({});
    });
  });
  srv.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  return new Promise((resolve) => srv.listen(FAKE_PORT, '127.0.0.1', () => resolve({ close: () => new Promise((done) => { sockets.forEach((s) => s.destroy()); srv.close(done); }) })));
}

const call = (path, body) => page.evaluate(async ({ path, body }) => {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}, { path, body });

const daemonUp = () => fetch(`${daemon}/health`).then((r) => r.ok, () => false);
const serverStatus = async () => (await call('/api/os-plugins')).rows.find((r) => r.id === 'agentation').serverStatus;
async function until(what, check, ms = 20000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 100))) if (await check()) return;
  assert.fail(`timed out: ${what}`);
}

const goView = (view) => page.evaluate((v) => {
  localStorage.setItem('claude-os.view', JSON.stringify(v));
  location.reload();
}, view);
const box = () => page.getByRole('textbox', { name: /Сообщение|agentation-test/ }).first();
const toolbar = () => page.locator('agentation-toolbar');
const launcher = () => page.locator('[data-agentation-toolbar]');
const note = () => page.locator('[data-annotation-popup] textarea');

async function activateToolbar() {
  await launcher().locator('button, [role=button], div').first().click();
  await page.waitForTimeout(300);
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-os-agentation-'));
  mkdirSync(join(dir, 'claude/projects'), { recursive: true });
  mkdirSync(join(dir, 'config/plugins'), { recursive: true });
  const cwd = join(dir, 'proj');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'a.txt'), 'x\n');
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(REPO, 'server/index.ts')], {
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE_OS_PORT: String(PORT),
      CLAUDE_OS_IDLE_EXIT_MS: '0',
      CLAUDE_OS_DATA: join(dir, 'data'),
      CLAUDE_OS_CONFIG: join(dir, 'config'),
      CLAUDE_OS_VAULT: join(dir, 'vault'),
      CLAUDE_CONFIG_DIR: join(dir, 'claude'),
      CLAUDE_OS_CLAUDE_BIN: join(REPO, 'server/chat/fixtures/fake-claude.mjs'),
      CLAUDE_OS_AGENTATION_PORT: String(DAEMON_PORT),
      AGENTATION_STORE: 'memory',
    },
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  fake = await startFake();
  const token = readFileSync(join(dir, 'data/token'), 'utf8').trim();
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } });
  context.setDefaultTimeout(60000);
  // Until the last test, which leaves the toolbar on its default address (e2e.default-endpoint), the toolbar talks to the fake.
  await context.addInitScript((port) => localStorage.getItem('e2e.default-endpoint') || localStorage.getItem('agentation.endpoint') || localStorage.setItem('agentation.endpoint', `http://127.0.0.1:${port}`), FAKE_PORT);
  await context.route(/^https?:\/\/[^/]+:4747\//, (route) => {
    realPort.push(route.request().url());
    return route.abort();
  });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (r.url().includes('agentation.vendor')) vendorRequests.push(r.url());
    if (r.url().endsWith('/send')) sends.push(r.url());
    if (r.url().startsWith(`${base}/api/plugins/agentation/proxy/`)) proxied.push(`${r.method()} ${r.url().slice(base.length)}`);
  });
  await page.goto(`${base}/auth?token=${token}`);
  tabId = (await call('/api/tabs', { cwd, title: 'agentation-test' })).id;
  const plan = await call('/api/os-plugins/agentation/preview', { action: 'enable' });
  assert.deepEqual(plan.conflicts, []);
  await call('/api/os-plugins/agentation/enable', { confirmed: true, sha: plan.sha });
  assert.ok(existsSync(join(dir, 'claude/skills/agentation-annotations/SKILL.md')), 'the skill went to the throwaway Claude dir');
  await until('the daemon runs', async () => (await serverStatus())?.state === 'running');
  assert.ok(await daemonUp());
  vendorRequests.length = 0; // the page already open while the daemon came up loaded the toolbar once: the tests count from their own load
});

after(async () => {
  await browser?.close();
  await fake?.close();
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('just enabled: the toolbar fades in without any command, a session is made, no mark and no /agentation command', async () => {
  await goView({ kind: 'tab', id: tabId });
  await launcher().waitFor();
  assert.equal(await launcher().evaluate((el) => getComputedStyle(el).animationName), 'agn-in');
  assert.equal(await page.getByTestId('agentation-mark').count(), 0);
  assert.equal(vendorRequests.length, 1, vendorRequests.join(', '));
  for (let i = 0; i < 100 && !hits.includes('POST /sessions'); i++) await page.waitForTimeout(100);
  assert.ok(hits.includes('POST /sessions'), hits.join(', '));
  assert.equal(await page.evaluate(() => localStorage.getItem('agentation-session-/')), 's1');
  const place = await launcher().boundingBox();
  assert.ok(place.y > 900 && place.x > 1200, `the toolbar keeps its corner, away from the title bar: ${JSON.stringify(place)}`);
  await page.screenshot({ path: join(SHOTS, 'agentation-enabled.png') });
  await page.evaluate(() => localStorage.setItem('claude-os.theme', 'light'));
  await page.reload();
  await launcher().waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, 'agentation-enabled-light.png') });
  await page.evaluate(() => localStorage.removeItem('claude-os.theme'));
  await page.reload();
  await launcher().waitFor();
  await box().click();
  await page.keyboard.type('/agentation');
  await page.waitForTimeout(500);
  const menu = await page.getByRole('listbox').allTextContents();
  assert.ok(!menu.some((m) => /\/agentation(?![-\w])/.test(m)), `no /agentation command: ${menu.join(' | ')}`);
  await box().fill('');
});

test('stays on after a reload, reduced motion drops the fade, nothing blocks the drag region', async () => {
  await page.reload();
  await toolbar().waitFor({ state: 'attached' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await launcher().evaluate((el) => getComputedStyle(el).animationName), 'none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const region = await launcher().evaluate((el) => {
    const read = (x) => getComputedStyle(x).appRegion ?? getComputedStyle(x).webkitAppRegion;
    const drag = [...document.querySelectorAll('body *')].find((x) => read(x) === 'drag');
    return { own: read(el), z: getComputedStyle(el.getRootNode().host).zIndex, titleBarStillDrags: !!drag };
  });
  assert.deepEqual(region, { own: 'no-drag', z: '100000', titleBarStillDrags: true });
});

test('a note on an element reaches the endpoint with its place', async () => {
  await activateToolbar();
  await page.screenshot({ path: join(SHOTS, 'agentation-active.png') });
  await box().click();
  await note().waitFor();
  await note().fill('Кнопка съехала');
  await note().press('Enter');
  await note().waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('agentation-toolbar'));
  for (let i = 0; i < 50 && annotations.length === 0; i++) await page.waitForTimeout(100);
  assert.equal(annotations.length, 1, hits.join(', '));
  assert.equal(annotations[0].comment, 'Кнопка съехала');
  // ChipInput puts `relative` first on the field, and agentation names a step of the short path by its first class: the full path shows the element.
  assert.equal(annotations[0].element, 'textarea');
  assert.match(annotations[0].fullPath, / > textarea\.relative$/);
  assert.equal(annotations[0].sessionId, 's1');
  const pin = await page.locator('[data-annotation-marker]').first().boundingBox();
  const target = await box().boundingBox();
  assert.ok(pin.x > target.x - 60 && pin.x < target.x + target.width + 60 && pin.y > target.y - 60, `the pin sits on what it marks: ${JSON.stringify(pin)}`);
  await page.screenshot({ path: join(SHOTS, 'agentation-note.png') });
});

test('the right click stays the app\'s while the toolbar is annotating', async () => {
  const row = page.locator('[data-file-row="a.txt"]');
  await row.waitFor();
  const r = await row.boundingBox();
  await page.mouse.click(r.x + 20, r.y + 8, { button: 'right' });
  await page.getByRole('menu').waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('menu').waitFor({ state: 'detached' });
  assert.equal(await note().count(), 0, 'no note opened by a right click');
});

test('a modal keeps working: the toolbar is usable above it, a note inside it can be typed, the modal stays', async () => {
  await page.keyboard.press('Control+KeyK');
  const dialog = page.getByRole('dialog');
  await dialog.waitFor();
  await page.waitForFunction(() => document.querySelector('[role="dialog"][data-state="open"] [data-agentation-portal]'));
  const before = annotations.length;
  const field = dialog.getByRole('combobox').or(dialog.getByRole('textbox')).first();
  await field.click();
  await note().waitFor();
  await note().click();
  await page.keyboard.type('Модалка тоже');
  assert.equal(await note().inputValue(), 'Модалка тоже', 'the focus trap let the note keep the keys');
  await page.screenshot({ path: join(SHOTS, 'agentation-modal.png') });
  await page.keyboard.press('Enter');
  await note().waitFor({ state: 'detached' });
  for (let i = 0; i < 50 && annotations.length === before; i++) await page.waitForTimeout(100);
  assert.equal(annotations.at(-1).comment, 'Модалка тоже');
  await dialog.waitFor();
  const r = await launcher().boundingBox();
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  await page.waitForTimeout(200);
  assert.equal(await dialog.count(), 1, 'a press on the toolbar is not a press outside the modal');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  await page.waitForFunction(() => document.querySelector('body > [data-agentation-portal]'));
  await toolbar().waitFor({ state: 'attached' });
});

test('works on another view and in a popout window', async () => {
  await goView({ kind: 'settings' });
  await launcher().waitFor();
  await page.goto(`${base}/?popout=tab&id=${tabId}`);
  await launcher().waitFor();
  await page.goto(base);
  await goView({ kind: 'tab', id: tabId });
  await launcher().waitFor();
});

test('the server goes down: quiet local state, the note stays in the browser; it comes back: the note arrives', async () => {
  await fake.close();
  await page.getByText(/заметки остаются в браузере/).first().waitFor({ timeout: 25000 });
  await page.screenshot({ path: join(SHOTS, 'agentation-local.png') });
  const before = annotations.length;
  await activateToolbar();
  const r = await page.locator('[data-file-row="a.txt"]').boundingBox();
  await page.mouse.click(r.x + 20, r.y + 8);
  await note().waitFor();
  await note().fill('Пока сервер лежит');
  await note().press('Enter');
  await note().waitFor({ state: 'detached' });
  await page.waitForTimeout(500);
  assert.equal(annotations.length, before);
  const stored = await page.evaluate(() => localStorage.getItem('feedback-annotations-/'));
  assert.match(stored, /Пока сервер лежит/);

  fake = await startFake();
  await page.getByText(/снова на связи/).first().waitFor({ timeout: 25000 });
  for (let i = 0; i < 100 && !annotations.some((a) => a.comment === 'Пока сервер лежит'); i++) await page.waitForTimeout(100);
  assert.ok(annotations.some((a) => a.comment === 'Пока сервер лежит'), hits.slice(-10).join(', '));
});

// Notes as the toolbar keeps them in the browser before any server saw them: local ids, no session, no `_syncedTo`.
const offlineNote = (id, comment, path) => ({ id, x: 30, y: 120, comment, element: 'min flex', elementPath: path, timestamp: Date.now() - 60_000, boundingBox: { x: 8, y: 100, width: 280, height: 700 }, nearbyText: '', cssClasses: 'min-h-0, flex-1', isFixed: false, fullPath: `body > div#root > ${path}`, accessibility: '', computedStyles: '', nearbyElements: '', attributes: {} });
const OFFLINE = [offlineNote('1794560131759', 'Офлайн-заметка один', '.sheet > .flex > .min-h-0'), offlineNote('1794560356149', 'Офлайн-заметка два', '.sheet > .min-h-0 > section')];
const arrived = (comment) => annotations.filter((a) => a.comment === comment).length;

test('a page opened while the server was away uploads its notes once the server answers, without a reload, and only once', async () => {
  await fake.close();
  await page.evaluate((notes) => {
    localStorage.removeItem('agentation-session-/');
    localStorage.setItem('feedback-annotations-/', JSON.stringify(notes));
  }, OFFLINE);
  await page.reload();
  await launcher().waitFor();
  await page.getByText(/заметки остаются в браузере/).first().waitFor({ timeout: 25000 });
  annotations.length = 0;

  fake = await startFake();
  await until('the offline notes reach the server', async () => OFFLINE.every((n) => arrived(n.comment) === 1));
  assert.equal(await page.evaluate(() => localStorage.getItem('agentation-session-/')), 's1');
  await page.reload();
  await launcher().waitFor();
  await page.waitForTimeout(1500);
  assert.deepEqual(OFFLINE.map((n) => arrived(n.comment)), [1, 1], 'a reload uploads nothing twice');
});

const OWN_PORT = 47935;
const own = `http://127.0.0.1:${OWN_PORT}`;
const startOwn = () => spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(PLUGIN, 'server/daemon.ts'), '--port', String(OWN_PORT)], { stdio: ['pipe', 'ignore', 'ignore'], env: { ...process.env, AGENTATION_STORE: 'memory' } });
const ownPending = async () => (await (await fetch(`${own}/pending`)).json()).annotations.map((a) => a.comment);

test('the real daemon: a page opened before it started gets its notes to it once it answers, and a reload adds no copies', async () => {
  await page.evaluate(({ url, notes }) => {
    localStorage.setItem('agentation.endpoint', url);
    localStorage.removeItem('agentation-session-/');
    localStorage.setItem('feedback-annotations-/', JSON.stringify(notes));
  }, { url: own, notes: OFFLINE });
  await page.reload();
  await launcher().waitFor();
  await page.getByText(/заметки остаются в браузере/).first().waitFor({ timeout: 25000 });
  const proc = startOwn();
  try {
    await until('the offline notes reach the daemon', async () => {
      const got = await ownPending().catch(() => []);
      return OFFLINE.every((n) => got.includes(n.comment));
    }, 30000);
    await page.reload();
    await launcher().waitFor();
    await page.waitForTimeout(1500);
    const got = await ownPending();
    assert.deepEqual(OFFLINE.map((n) => got.filter((c) => c === n.comment).length), [1, 1], 'a reload uploads nothing twice');
  } finally {
    proc.kill();
    await page.evaluate((port) => localStorage.setItem('agentation.endpoint', `http://127.0.0.1:${port}`), FAKE_PORT);
  }
});

test('notes already imported to the daemon: the page adopts the server copies and sends none of its own', async () => {
  const proc = startOwn();
  try {
    await until('the daemon answers', () => fetch(`${own}/health`).then((r) => r.ok, () => false));
    const { sessionId } = await importNotes(own, `${base}/`, OFFLINE);
    await page.evaluate(({ url, notes }) => {
      localStorage.setItem('agentation.endpoint', url);
      localStorage.removeItem('agentation-session-/');
      localStorage.setItem('feedback-annotations-/', JSON.stringify(notes));
    }, { url: own, notes: OFFLINE });
    await page.reload();
    await launcher().waitFor();
    await until('the page joined the import session', async () => (await page.evaluate(() => localStorage.getItem('agentation-session-/'))) === sessionId);
    await page.waitForTimeout(1500);
    const got = await ownPending();
    assert.deepEqual(OFFLINE.map((n) => got.filter((c) => c === n.comment).length), [1, 1], 'no copies of the imported notes');
    await activateToolbar();
    await until('the pins stay on the page', async () => (await page.locator('[data-annotation-marker]').count()) === 2, 5000);
  } finally {
    proc.kill();
    await page.evaluate((port) => localStorage.setItem('agentation.endpoint', `http://127.0.0.1:${port}`), FAKE_PORT);
  }
});

const flip = async (action) => {
  const plan = await call('/api/os-plugins/agentation/preview', { action });
  await call(`/api/os-plugins/agentation/${action}`, { confirmed: true, sha: plan.sha });
};

test('disabling the plugin fades the toolbar out; after a reload no bundle and no polling; nothing reached Claude or the real port', async () => {
  await toolbar().evaluate((el) => {
    window.__classes = [];
    new MutationObserver(() => window.__classes.push(el.className)).observe(el, { attributes: true, attributeFilter: ['class'] });
    const part = el.shadowRoot.querySelector('[data-agentation-toolbar]');
    window.__opacity = [];
    const sample = () => {
      window.__opacity.push(Number(getComputedStyle(part).opacity));
      if (part.isConnected) requestAnimationFrame(sample);
    };
    sample();
  });
  await flip('disable');
  await toolbar().waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.__classes), ['agn-host agn-leaving']);
  const opacity = await page.evaluate(() => window.__opacity);
  assert.ok(opacity.some((o) => o > 0 && o < 1), `a real fade, not a cut: ${opacity.join(' ')}`);
  vendorRequests.length = 0;
  hits.length = 0;
  await page.reload();
  await box().waitFor();
  await page.waitForTimeout(1500);
  assert.deepEqual(vendorRequests, []);
  assert.equal(await toolbar().count(), 0);
  assert.deepEqual(hits, [], 'disabled means no polling');
  assert.deepEqual(sends, []);
  assert.deepEqual(realPort, []);
  assert.deepEqual(errors, []);
  await until('the daemon stopped', async () => !(await daemonUp()));
  assert.equal(await serverStatus(), null);
});

test('enabling the plugin again brings the toolbar back, even after the toolbar hid itself for the session', async () => {
  await page.evaluate(() => sessionStorage.setItem('agentation-session-toolbar-hidden', '1'));
  await flip('enable');
  await launcher().waitFor();
  assert.equal(await page.evaluate(() => sessionStorage.getItem('agentation-session-toolbar-hidden')), null);
  assert.deepEqual(errors, []);
});

test('the daemon Claude OS keeps: with no address set, a note from the toolbar reaches it through Claude OS and a Claude OS tab reads it with its tools', async () => {
  await until('the daemon runs again', async () => (await serverStatus())?.state === 'running');
  assert.equal((await fetch(`${base}/api/plugins/agentation/proxy/health`)).status, 401, 'the proxy sits behind the Claude OS cookie');
  // The fake's session s1 is unknown to the fresh in-memory store (the user's daemon keeps ~/.agentation/store.db, so theirs stay
  // known), and the earlier tests' pins sit where this note goes: a click on a pin edits that note instead.
  await page.evaluate(() => {
    localStorage.setItem('e2e.default-endpoint', '1');
    localStorage.removeItem('agentation.endpoint');
    localStorage.removeItem('agentation-session-/');
    localStorage.removeItem('feedback-annotations-/');
  });
  proxied.length = 0;
  await goView({ kind: 'tab', id: tabId });
  await launcher().waitFor();
  await activateToolbar();
  const r = await page.locator('[data-file-row="a.txt"]').boundingBox();
  await page.mouse.click(r.x + 20, r.y + 8);
  await note().waitFor();
  await note().fill('Через демон');
  await note().press('Enter');
  await note().waitFor({ state: 'detached' });
  await until('the daemon has the note', async () => JSON.stringify(await (await fetch(`${daemon}/pending`)).json()).includes('Через демон'));
  assert.equal(await page.evaluate(() => localStorage.getItem('agentation.endpoint')), null, 'no address was set');
  for (const call of ['GET /api/plugins/agentation/proxy/health', 'POST /api/plugins/agentation/proxy/sessions']) assert.ok(proxied.includes(call), `${call} went through Claude OS: ${proxied.join(', ')}`);
  assert.ok(proxied.some((c) => /^POST \/api\/plugins\/agentation\/proxy\/sessions\/[^/]+\/annotations$/.test(c)), proxied.join(', '));
  assert.ok(proxied.some((c) => /^GET \/api\/plugins\/agentation\/proxy\/sessions\/[^/]+\/events$/.test(c)), `the event stream too: ${proxied.join(', ')}`);

  const osTab = (await call('/api/tabs', { cwd: REPO, title: 'agentation-os' })).id;
  await call(`/api/tabs/${osTab}/send`, { text: 'MCP agentation_get_all_pending {}' });
  await goView({ kind: 'tab', id: osTab });
  await page.getByText(/^MCP_RESULT/).last().waitFor();
  const chat = await page.evaluate(() => document.body.innerText);
  assert.match(chat.slice(chat.indexOf('MCP_RESULT')), /Через демон/);
  await goView({ kind: 'entity', type: 'os-plugin', id: 'agentation' });
  await page.getByTestId('plugin-server-state').first().waitFor();
  await page.screenshot({ path: join(SHOTS, 'agentation-plugin-page.png') });
  await page.evaluate(() => localStorage.setItem('claude-os.theme', 'light'));
  await page.reload();
  await page.getByTestId('plugin-server-state').first().waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, 'agentation-plugin-page-light.png') });
  assert.deepEqual(realPort, []);
  assert.deepEqual(errors, []);
});
