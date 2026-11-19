// The root chat on Home: closed until the user opens it, the choice kept, and opened at the bottom without a long scroll.
// Motion stays on here: the smooth way down is what made the chat scroll for seconds.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { Tab } from '../shared/contract.ts';
import { startServer, waitUntil, type TestServer } from '../server/chat/fixtures/harness.ts';
import { homeButton } from './fixture-server.ts';

let srv: TestServer;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
let rootId = '';
const errors: string[] = [];

const homeBox = () => page.getByRole('textbox', { name: /Начни новый проект/ });
const panel = () => page.locator('.root-panel');
const showButton = () => page.getByRole('button', { name: 'Показать ответ' });
const scroller = () => panel().getByTestId('transcript-scroller');
const send = (text: string) => srv.api('POST', `/api/tabs/${rootId}/send`, { text });
const settled = () => waitUntil(async () => (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === rootId)?.status === 'idle', 'root idle', 20_000);
const place = () => scroller().evaluate((el) => ({ top: Math.round(el.scrollTop), gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), height: el.scrollHeight }));
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

// The panel has finished opening: its height transition is over.
const opened = () => waitUntil(async () => (await panel().count()) === 1 && (await panel().evaluate((el) => el.getAnimations().length)) === 0, 'the panel has opened');

// At the bottom now and still there, unmoved, a while later.
async function staysAtBottom(label: string) {
  const first = await place();
  assert.ok(first.gap <= 1, `${label}: at the bottom at once (${JSON.stringify(first)})`);
  const samples = [first];
  for (let i = 0; i < 8; i++) {
    await pause(200);
    samples.push(await place());
  }
  // scrollTop may still shift as the panel finishes growing, but always at the very bottom: a glide through the history leaves a gap.
  assert.ok(samples.every((s) => s.gap <= 1), `${label}: no scrolling afterwards (${samples.map((s) => `${s.top}/${s.gap}`).join(', ')})`);
}

before(async () => {
  srv = await startServer();
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } });
  ctx.setDefaultTimeout(60_000);
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const token = readFileSync(join(srv.dataDir, 'token'), 'utf8').trim();
  await page.goto(`http://127.0.0.1:${srv.port}/auth?token=${token}`);
  await homeBox().waitFor();
  rootId = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.kind === 'root')!.id;
  // A history several screens tall.
  const lines = Array.from({ length: 40 }, (_, i) => `строка ${i + 1}`).join('\n');
  for (let i = 0; i < 6; i++) {
    await send(`сообщение ${i + 1}\n${lines}`);
    await settled();
  }
});

after(async () => {
  await browser?.close();
  await srv?.destroy();
  assert.deepEqual(errors, []);
});

test('entering Home keeps the chat closed, even with a history', async () => {
  await page.evaluate(() => localStorage.removeItem('claude-os.rootPanel'));
  await page.reload();
  await showButton().waitFor();
  await pause(1500); // the history has loaded and nothing opened it
  assert.equal(await panel().count(), 0);
  assert.equal(await page.evaluate(() => localStorage.getItem('claude-os.rootPanel')), 'closed');
});

test('opening lands at the bottom and does not scroll afterwards', async () => {
  await showButton().click();
  await opened();
  await staysAtBottom('opened');
  await page.screenshot({ path: '/tmp/cos-home-chat-open.png' });
});

test('the open state is kept across a reload, and closing is kept too', async () => {
  assert.equal(await page.evaluate(() => localStorage.getItem('claude-os.rootPanel')), 'open');
  await page.reload();
  await opened();
  await panel().getByText(/сообщение 6/).first().waitFor();
  await staysAtBottom('after a reload');

  await page.getByRole('button', { name: 'Свернуть ответ' }).click();
  await panel().waitFor({ state: 'detached' });
  await page.reload();
  await showButton().waitFor();
  await pause(1000);
  assert.equal(await panel().count(), 0, 'closed stays closed');
});

test('coming back to Home from another screen lands at the bottom with no long scroll', async () => {
  await showButton().click();
  await opened();
  await page.getByRole('button', { name: 'Сессии', exact: true }).click();
  await panel().waitFor({ state: 'hidden' });
  // The conversation goes on while Home is hidden under another screen.
  await send(`пока тебя не было\n${Array.from({ length: 60 }, (_, i) => `строка ${i + 1}`).join('\n')}`);
  await settled();
  await homeButton(page).click();
  await panel().waitFor({ state: 'visible' });
  await page.waitForTimeout(50);
  await staysAtBottom('back on Home');
});

test('an open chat whose history arrives late still lands at the bottom without a long scroll', async () => {
  // A long journal on a busy machine: the panel is open well before its history is read.
  await page.route('**/api/tabs/*/history', async (route) => {
    await pause(1800);
    await route.continue();
  });
  try {
    await page.reload();
    await opened();
    await waitUntil(async () => (await place()).height > 3000, 'the history has arrived', 20_000);
    await staysAtBottom('late history');
  } finally {
    await page.unroute('**/api/tabs/*/history');
  }
});

test('light theme: the open chat on Home', async () => {
  const was = await page.evaluate(() => document.documentElement.dataset.theme ?? null);
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await pause(400);
  await page.screenshot({ path: '/tmp/cos-home-chat-light.png' });
  await page.evaluate((t) => { if (t) document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme; }, was);
});
