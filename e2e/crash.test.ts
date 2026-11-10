// A page newer than its server, a broken screen, an error nothing caught: the app stays usable and offers the way out.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, beforeEach, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { seedSetupDone, waitUntil } from '../server/chat/fixtures/harness.ts';
import { homeButton, startFixture, type FixtureServer } from './fixture-server.ts';

const REPO = join(import.meta.dirname, '..');
let browser: Browser;
let page: Page;
let server: FixtureServer;
const STATUS = /^\/api\/app\/status$/;
const OLD_ICONS: [number, unknown] = [200, { dir: '/x', icons: {}, rejected: [], offerDismissed: true }]; // what a process older than `chosen` answers

before(async () => {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});
after(() => browser.close());
beforeEach(async () => {
  server = await startFixture();
  server.failures.set(STATUS, [200, { stale: false, busy: false, repo: '/home/test/claude-os' }]);
  server.failures.set(/^\/api\/microtasks$/, [200, [{ id: 'crash-fix', title: 'x', titleRu: 'x', input: null, prompt: '{repo} | {where} | {error}' }]]);
  page = await (await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } })).newPage();
});
afterEach(() => server.close());

test('old server shape breaks Home only: the error is shown and other screens still open', async () => {
  server.failures.set(/^\/api\/project-icons$/, OLD_ICONS);
  await page.goto(server.url);
  await page.getByText('Этот экран сломался').waitFor();
  await page.getByText(/reading 'alpha-service'/).waitFor();
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('menuitem', { name: /Настройки/ }).click();
  await page.getByRole('button', { name: 'IDE и программы' }).waitFor();
  assert.equal(await page.getByText('Этот экран сломался').count(), 0);
});

test('reload and fix: after the reload a tab in the repo gets the error', async () => {
  server.failures.set(/^\/api\/project-icons$/, OLD_ICONS);
  await page.goto(server.url);
  await page.getByRole('button', { name: 'Перезагрузить и починить с Claude' }).click();
  await page.waitForFunction(() => document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.includes('Починка'));
  const created = server.calls.find((c) => c.method === 'POST' && c.path === '/api/tabs');
  assert.equal((created?.body as { cwd: string }).cwd, '/home/test/claude-os');
  assert.equal((created?.body as { source: string }).source, 'crash-fix', 'counted as Claude OS own load');
  const sent = server.calls.find((c) => c.path.endsWith('/send'));
  assert.match((sent?.body as { text: string }).text, /home \| TypeError: Cannot read properties of undefined/);
  assert.equal(server.calls.filter((c) => c.path.endsWith('/send')).length, 1);
});

test('a plain reload sends nothing', async () => {
  server.failures.set(/^\/api\/project-icons$/, OLD_ICONS);
  await page.goto(server.url);
  await page.getByRole('button', { name: 'Перезагрузить окно' }).click();
  await page.getByText('Этот экран сломался').waitFor();
  assert.equal(server.calls.filter((c) => c.path.endsWith('/send')).length, 0);
});

test('a stale server is named and can be restarted from the bar', async () => {
  server.failures.set(STATUS, [200, { stale: true, busy: true, repo: '/x' }]);
  await page.goto(server.url);
  await page.getByText(/Перезапуск прервёт идущие ходы, после него они продолжатся сами/).waitFor();
  await page.getByRole('button', { name: 'Перезапустить сервер' }).waitFor();
});

test('restart button works on home', async () => {
  server.failures.set(STATUS, [200, { stale: true, busy: false, repo: '/x' }]);
  server.failures.set(/^\/api\/app\/restart$/, [200, { ok: true, stopped: 0 }]);
  await page.goto(server.url);
  await homeButton(page).waitFor();
  await page.getByRole('button', { name: 'Перезапустить сервер' }).click({ timeout: 5000 });
  const pending = page.getByRole('button', { name: 'Перезапускаю сервер…' });
  await pending.waitFor();
  assert.ok(await pending.isDisabled(), 'a second click cannot start another restart');
  // The button turns pending at once, the POST follows a /health round trip.
  await waitUntil(() => server.calls.some((c) => c.method === 'POST' && c.path === '/api/app/restart'), 'the restart request');
});

test('no error text flashes when the first request fails', async () => {
  // The window can open a moment before the server answers: the first request and the first socket fail.
  await page.addInitScript(() => {
    const seen: string[] = [];
    (window as unknown as { __seen: string[] }).__seen = seen;
    new MutationObserver(() => {
      const text = document.body?.textContent ?? '';
      for (const s of ['Сервер Claude OS не отвечает', 'Нет связи с сервером']) if (text.includes(s) && !seen.includes(s)) seen.push(s);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  });
  let failedApi = false;
  await page.route(/\/api\/tabs$/, (route) => {
    if (failedApi) return route.fallback();
    failedApi = true;
    return route.abort('connectionrefused');
  });
  let failedWs = false;
  await page.routeWebSocket(/\/ws$/, (ws) => {
    if (failedWs) return ws.connectToServer();
    failedWs = true;
    return ws.close();
  });
  await page.goto(server.url);
  await homeButton(page).waitFor();
  await page.waitForTimeout(2500);
  assert.ok(failedApi && failedWs, 'both first attempts failed');
  const seen = await page.evaluate(() => (window as unknown as { __seen: string[] }).__seen.join('\n'));
  assert.ok(!seen.includes('Сервер Claude OS не отвечает'), 'no request error on screen');
  assert.ok(!seen.includes('Нет связи с сервером'), 'no offline bar');
});

test('an error nothing caught becomes a toast with the fix button', async () => {
  await page.goto(server.url);
  await homeButton(page).waitFor();
  await page.evaluate(() => { setTimeout(() => { throw new Error('boom-in-handler'); }); });
  await page.getByText('boom-in-handler').waitFor();
  await page.getByRole('button', { name: 'Починить с Claude' }).waitFor();
});

test('restart: the real server comes back as a new process on the same port', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'claude-os-restart-'));
  mkdirSync(join(dir, 'claude/projects'), { recursive: true });
  const PORT = 47907;
  const base = `http://127.0.0.1:${PORT}`;
  seedSetupDone(join(dir, 'config'));
  const first = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(REPO, 'server/index.ts')], {
    stdio: 'ignore',
    env: { ...process.env, CLAUDE_OS_PORT: String(PORT), CLAUDE_OS_IDLE_EXIT_MS: '0', CLAUDE_OS_DATA: join(dir, 'data'), CLAUDE_OS_CONFIG: join(dir, 'config'), CLAUDE_OS_VAULT: join(dir, 'vault'), CLAUDE_CONFIG_DIR: join(dir, 'claude'), CLAUDE_OS_CLAUDE_BIN: join(REPO, 'server/chat/fixtures/fake-claude.mjs') },
  });
  const health = () => fetch(`${base}/health`).then((r) => r.json() as Promise<{ pid: number; stale: boolean }>).catch(() => null);
  let next = 0;
  try {
    for (let i = 0; i < 150 && !(await health()); i++) await new Promise((r) => setTimeout(r, 100));
    const before = await health();
    assert.equal(before?.pid, first.pid);
    assert.equal(before?.stale, false);
    const token = readFileSync(join(dir, 'data/token'), 'utf8').trim();
    const res = await fetch(`${base}/api/app/restart`, { method: 'POST', headers: { cookie: `claude_os=${token}` } });
    assert.equal(res.status, 200);
    for (let i = 0; i < 150; i++) {
      next = (await health())?.pid ?? 0;
      if (next && next !== first.pid) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(next && next !== first.pid, 'a new process answers');
  } finally {
    if (next && next !== first.pid) process.kill(next);
    first.kill();
    rmSync(dir, { recursive: true, force: true });
  }
});
