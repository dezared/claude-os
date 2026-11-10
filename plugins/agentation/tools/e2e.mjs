// The plugin through a real Claude OS server and the fake CLI, in throwaway directories, against a fake MCP endpoint. Set CLAUDE_OS_WEB_DIST to test another build.
// Anything aimed at the real port 4747 is aborted and fails the run: no annotation can reach the real server.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright';

const PLUGIN = join(import.meta.dirname, '..');
const REPO = join(PLUGIN, '../..');
const PORT = 47932;
const FAKE_PORT = 47933;
const base = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.AGENTATION_SHOTS ?? tmpdir();

let dir, server, browser, context, page, tabId, fake;
const errors = [];
const vendorRequests = [];
const realPort = [];
const sends = [];
const hits = [];
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

const goView = (view) => page.evaluate((v) => {
  localStorage.setItem('claude-os.view', JSON.stringify(v));
  location.reload();
}, view);
const box = () => page.getByRole('textbox', { name: /Сообщение|agentation-test/ }).first();
const send = async (text) => {
  await box().fill(text);
  await box().press('Escape');
  await box().press('Enter');
};
const toolbar = () => page.locator('agentation-toolbar');
const launcher = () => page.locator('[data-agentation-toolbar]');
const mark = () => page.getByTestId('agentation-mark').last();
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
  cpSync(PLUGIN, join(dir, 'config/plugins/agentation'), { recursive: true });
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
  await context.addInitScript((port) => localStorage.setItem('agentation.endpoint', `http://127.0.0.1:${port}`), FAKE_PORT);
  await context.route(/^https?:\/\/[^/]+:4747\//, (route) => {
    realPort.push(route.request().url());
    return route.abort();
  });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    if (r.url().includes('agentation.vendor')) vendorRequests.push(r.url());
    if (r.url().endsWith('/send')) sends.push(r.url());
  });
  await page.goto(`${base}/auth?token=${token}`);
  tabId = (await call('/api/tabs', { cwd, title: 'agentation-test' })).id;
  const plan = await call('/api/os-plugins/agentation/preview', { action: 'enable' });
  assert.deepEqual(plan.conflicts, []);
  await call('/api/os-plugins/agentation/enable', { confirmed: true, sha: plan.sha });
  assert.ok(existsSync(join(dir, 'claude/skills/agentation-annotations/SKILL.md')), 'the skill went to the throwaway Claude dir');
});

after(async () => {
  await browser?.close();
  await fake?.close();
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('just enabled: the toolbar and the mark are there without any command', async () => {
  await goView({ kind: 'tab', id: tabId });
  await launcher().waitFor();
  await mark().waitFor();
  assert.ok(vendorRequests.length > 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('agentation.on')), null);
  await page.screenshot({ path: join(SHOTS, 'agentation-enabled.png') });
  await box().click();
  await page.keyboard.type('/agent');
  await page.getByText(/Заметки к интерфейсу/).waitFor();
  await box().fill('');
});

test('turned off: the bundle is not requested after a reload, no toolbar', async () => {
  await send('/agentation off');
  await toolbar().waitFor({ state: 'detached' });
  vendorRequests.length = 0;
  await page.reload();
  await box().waitFor();
  await page.waitForTimeout(1500);
  assert.deepEqual(vendorRequests, []);
  assert.equal(await toolbar().count(), 0);
  assert.equal(await page.getByTestId('agentation-mark').count(), 0);
});

test('/agentation on: fades in, the mark shows the connection, a session is made', async () => {
  await send('/agentation nonsense');
  await page.getByText('Использование: /agentation').waitFor();
  assert.deepEqual(vendorRequests, []);
  await send('/agentation on');
  await toolbar().waitFor({ state: 'attached' });
  assert.equal(vendorRequests.length, 1);
  await launcher().waitFor();
  assert.equal(await launcher().evaluate((el) => getComputedStyle(el).animationName), 'agn-in');
  await page.locator('[data-testid="agentation-mark"][data-link="connected"]').last().waitFor();
  await launcher().waitFor();
  const place = await launcher().boundingBox();
  assert.ok(place.y > 900 && place.x > 1200, `the toolbar keeps its corner, away from the title bar: ${JSON.stringify(place)}`);
  assert.ok(hits.includes('POST /sessions'), hits.join(', '));
  assert.equal(await page.evaluate(() => localStorage.getItem('agentation-session-/')), 's1');
  await page.screenshot({ path: join(SHOTS, 'agentation-on.png') });
});

test('stays on after a reload, reduced motion drops the fade, nothing blocks the drag region', async () => {
  await page.reload();
  await toolbar().waitFor({ state: 'attached' });
  await mark().waitFor();
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
  assert.match(annotations[0].elementPath, /max-h/);
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
  await page.locator('[data-testid="agentation-mark"][data-link="local"]').last().waitFor({ timeout: 25000 });
  await page.getByText(/заметки остаются в браузере/).first().waitFor();
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
  await page.locator('[data-testid="agentation-mark"][data-link="connected"]').last().waitFor({ timeout: 25000 });
  for (let i = 0; i < 100 && !annotations.some((a) => a.comment === 'Пока сервер лежит'); i++) await page.waitForTimeout(100);
  assert.ok(annotations.some((a) => a.comment === 'Пока сервер лежит'), hits.slice(-10).join(', '));
});

test('/agentation off: fades out and goes, stays off after a reload, no bundle requested; nothing reached Claude or the real port', async () => {
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
  await send('/agentation off');
  await toolbar().waitFor({ state: 'detached' });
  await page.getByTestId('agentation-mark').first().waitFor({ state: 'detached' });
  assert.deepEqual(await page.evaluate(() => window.__classes), ['agn-host agn-leaving']);
  const opacity = await page.evaluate(() => window.__opacity);
  assert.ok(opacity.some((o) => o > 0 && o < 1), `a real fade, not a cut: ${opacity.join(' ')}`);
  assert.equal(await page.evaluate(() => localStorage.getItem('agentation.on')), '0');
  vendorRequests.length = 0;
  hits.length = 0;
  await page.reload();
  await box().waitFor();
  await page.waitForTimeout(1500);
  assert.deepEqual(vendorRequests, []);
  assert.equal(await toolbar().count(), 0);
  assert.deepEqual(hits, [], 'off means no polling');
  assert.deepEqual(sends, []);
  assert.deepEqual(realPort, []);
  assert.deepEqual(errors, []);
});

test('disabling and enabling the plugin brings the toolbar back after an earlier off', async () => {
  assert.equal(await page.evaluate(() => localStorage.getItem('agentation.on')), '0');
  const flip = async (action) => {
    const plan = await call('/api/os-plugins/agentation/preview', { action });
    await call(`/api/os-plugins/agentation/${action}`, { confirmed: true, sha: plan.sha });
  };
  await flip('disable');
  await page.waitForFunction(() => localStorage.getItem('agentation.on') === null);
  await flip('enable');
  await launcher().waitFor();
  assert.deepEqual(errors, []);
});
