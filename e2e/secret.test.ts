// /secret in the browser: the field masks the value, the draft never holds it, the chat gets a lock chip and Claude only the name.
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startServer, waitUntil, type TestServer } from '../server/chat/fixtures/harness.ts';
import type { Tab } from '../shared/contract.ts';

let browser: Browser;
let srv: TestServer;
let ctx: BrowserContext | null = null;
let errors: string[] = [];

before(async () => {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  srv = await startServer({ CLAUDE_OS_TAB_IDLE_MS: '400' });
});
after(async () => {
  await browser.close();
  await srv.destroy();
});
afterEach(async () => {
  assert.deepEqual(errors, []);
  await ctx?.close();
  ctx = null;
  errors = [];
});

async function open(view: unknown): Promise<Page> {
  ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU', reducedMotion: 'reduce' });
  await ctx.addInitScript((v) => localStorage.setItem('claude-os.view', v), JSON.stringify(view));
  ctx.setDefaultTimeout(20000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${srv.port}/auth?token=${readFileSync(join(srv.dataDir, 'token'), 'utf8').trim()}`);
  return page;
}

const newTab = async () => (await srv.api<Tab>('POST', '/api/tabs', { cwd: mkdtempSync(join(srv.dir, 's-')) })).body;
const field = (page: Page) => page.getByRole('textbox').last();
const storage = (page: Page) => page.evaluate(() => JSON.stringify({ ...localStorage }));
const VALUE = 'ghp_e2eHidden42';

test('typing /secret masks the value; the sent message is a lock chip and the value reaches neither Claude nor storage', async () => {
  const tab = await newTab();
  const page = await open({ kind: 'tab', id: tab.id });
  const box = field(page);
  await box.click();
  await box.pressSequentially(`/secret E2E_TOKEN=${VALUE}`);
  assert.equal(await box.inputValue(), `/secret E2E_TOKEN=${'•'.repeat(VALUE.length)}`);
  // A typo fixed in the middle lands in the real value, not at its end.
  await box.press('ArrowLeft');
  await box.press('Backspace');
  await box.pressSequentially('7');
  assert.equal(await box.inputValue(), `/secret E2E_TOKEN=${'•'.repeat(VALUE.length)}`);
  await page.waitForTimeout(500); // the draft is written a moment after the last key
  assert.ok(!(await storage(page)).includes('e2eHidden'), 'the draft holds only dots');

  const users = srv.log().filter((l) => l.kind === 'user').length;
  await box.press('Enter');
  const chip = page.getByTestId('secret-chip');
  await chip.waitFor();
  assert.equal((await chip.textContent())?.trim(), 'E2E_TOKEN');
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].at(-1)?.value === '', null, { timeout: 5000 }); // empties once the server answered

  await waitUntil(() => srv.log().filter((l) => l.kind === 'user').length > users, 'Claude got the message');
  const toClaude = JSON.stringify(srv.log().filter((l) => l.kind === 'user').slice(users));
  assert.ok(toClaude.includes('[secret E2E_TOKEN saved'), 'the marker');
  assert.ok(!toClaude.includes('e2eHidden'), 'never the value');
  const spawn = srv.log().filter((l) => l.kind === 'spawn').at(-1) as { e2eEnv: string[] };
  assert.deepEqual(spawn.e2eEnv, ['E2E_TOKEN'], 'the session has it as $E2E_TOKEN');

  const history = JSON.stringify((await srv.api('GET', `/api/tabs/${tab.id}/history`)).body);
  assert.ok(!history.includes('e2eHidden'));
  assert.ok(!(await page.locator('body').innerText()).includes('e2eHidden'));
  assert.ok(!(await storage(page)).includes('e2eHidden'));

  const dir = join(srv.dataDir, 'secrets');
  const [file] = readdirSync(dir);
  assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
  assert.equal((JSON.parse(readFileSync(join(dir, file), 'utf8')) as Record<string, string>).E2E_TOKEN, 'ghp_e2eHidden72');
});

test('a pasted /secret without a name is masked at once and saved as SECRET_1', async () => {
  const tab = await newTab();
  const page = await open({ kind: 'tab', id: tab.id });
  const box = field(page);
  await box.fill('/secret plainvalue');
  assert.equal(await box.inputValue(), `/secret ${'•'.repeat('plainvalue'.length)}`);
  await box.press('Enter');
  await page.getByTestId('secret-chip').filter({ hasText: 'SECRET_1' }).waitFor();
  assert.ok(!(await storage(page)).includes('plainvalue'));
});

test('a long /secret pasted into an empty field is masked, never a paste chip kept in storage', async () => {
  const tab = await newTab();
  const page = await open({ kind: 'tab', id: tab.id });
  const box = field(page);
  const long = `tok_${'x'.repeat(900)}`;
  await box.click();
  await box.evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, `/secret ${long}`);
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].at(-1)?.value.startsWith('/secret •'));
  assert.equal(await box.inputValue(), `/secret ${'•'.repeat(long.length)}`);
  assert.equal(await page.locator('[data-chip-layer] [data-chip="paste"]').count(), 0);
  await page.waitForTimeout(500); // the draft is written a moment after the last key
  assert.ok(!(await storage(page)).includes('xxxxxxxx'));
});

test('dictation is off while the field holds a /secret', async () => {
  const tab = await newTab();
  const page = await open({ kind: 'tab', id: tab.id });
  const box = field(page);
  const mic = page.getByRole('button', { name: 'Голосовой ввод' }).last();
  await box.click();
  await page.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === 'Голосовой ввод' && !b.matches(':disabled')));
  assert.equal(await mic.isEnabled(), true);
  await box.pressSequentially('/secret ab');
  assert.equal(await mic.isDisabled(), true);
  await box.fill('');
  assert.equal(await mic.isEnabled(), true);
});

test('a /secret line inside a message: only its value is dots, the message goes out as text, a lock chip and text', async () => {
  const tab = await newTab();
  const page = await open({ kind: 'tab', id: tab.id });
  const box = field(page);
  await box.click();
  await box.pressSequentially('Deploy the app');
  await box.press('Shift+Enter');
  await box.pressSequentially('with this token:');
  await box.press('Shift+Enter');
  await box.pressSequentially('/secret DEPLOY_KEY=dk_multiHidden9');
  await box.press('Shift+Enter');
  await box.pressSequentially('and report back');
  const dots = '•'.repeat('dk_multiHidden9'.length);
  assert.equal(await box.inputValue(), `Deploy the app\nwith this token:\n/secret DEPLOY_KEY=${dots}\nand report back`);
  // A multi-line paste into the value would show its other lines: it is refused, the field stays as it was.
  const valueEnd = `Deploy the app\nwith this token:\n/secret DEPLOY_KEY=${dots}`.length;
  await box.evaluate((el: HTMLTextAreaElement, at) => el.setSelectionRange(at, at), valueEnd);
  await box.evaluate(() => document.execCommand('insertText', false, 'more\nmultiLeak'));
  assert.equal(await box.inputValue(), `Deploy the app\nwith this token:\n/secret DEPLOY_KEY=${dots}\nand report back`);
  await page.waitForTimeout(500); // the draft is written a moment after the last key
  assert.ok(!(await storage(page)).includes('multiHidden'), 'the draft holds only dots');

  const users = srv.log().filter((l) => l.kind === 'user').length;
  await box.press('Enter');
  const chip = page.getByTestId('secret-chip');
  await chip.waitFor();
  assert.equal((await chip.textContent())?.trim(), 'DEPLOY_KEY');
  await page.getByText('and report back').waitFor();
  await page.getByText('Deploy the app').waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('textarea')].at(-1)?.value === '', null, { timeout: 5000 });

  await waitUntil(() => srv.log().filter((l) => l.kind === 'user').length > users, 'Claude got the message');
  const turns = srv.log().filter((l) => l.kind === 'user').slice(users);
  assert.equal(turns.length, 1, 'one turn');
  const toClaude = JSON.stringify(turns);
  assert.ok(toClaude.includes('Deploy the app') && toClaude.includes('[secret DEPLOY_KEY saved') && toClaude.includes('and report back'));
  assert.ok(!toClaude.includes('multiHidden') && !toClaude.includes('/secret DEPLOY_KEY'), 'never the value');

  const history = JSON.stringify((await srv.api('GET', `/api/tabs/${tab.id}/history`)).body);
  assert.ok(!history.includes('multiHidden'));
  assert.ok(!(await page.locator('body').innerText()).includes('multiHidden'));
  assert.ok(!(await storage(page)).includes('multiHidden'));
  assert.ok(!(await storage(page)).includes('multiLeak'));
  const dir = join(srv.dataDir, 'secrets');
  const values = readdirSync(dir).map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as Record<string, string>);
  assert.ok(values.some((v) => v.DEPLOY_KEY === 'dk_multiHidden9'));
});
