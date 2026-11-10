// The root session's places (Home, its own tab), bringing back a closed tab, the home field's two layouts, the menu against late scrolls.
// The real server, the fake CLI, a real browser. No tokens.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startServer, waitUntil, type TestServer } from '../server/chat/fixtures/harness.ts';
import { homeButton } from './fixture-server.ts';
import type { Tab } from '../shared/contract.ts';

let srv: TestServer;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
const errors: string[] = [];

const homeBox = () => page.getByRole('textbox', { name: /Начни новый проект/ });
const pill = (name: string | RegExp) => page.getByRole('tablist').getByRole('tab', { name });
const tabsNow = async () => (await srv.api<Tab[]>('GET', '/api/tabs')).body;
const newTab = async () => (await srv.api<Tab>('POST', '/api/tabs', { cwd: mkdtempSync(join(srv.dir, 'w-')) })).body;
const rootName = 'Корневая сессия Claude';

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
  ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
  ctx.setDefaultTimeout(30_000);
  page = await enter(ctx);
  await homeBox().waitFor();
});

after(async () => {
  await browser?.close();
  await srv?.destroy();
  assert.deepEqual(errors, []);
});

test('the home field: one line while it fits, then the text over the buttons, and back', async () => {
  const box = homeBox();
  const send = page.locator('.home-chat').getByRole('button', { name: /^(Отправить|В очередь)$/ });
  const under = async () => {
    const [f, b] = [await box.boundingBox(), await send.boundingBox()];
    return b!.y >= f!.y + f!.height;
  };
  const oneLine = (await box.boundingBox())!.height;
  assert.equal(await under(), false, 'empty: beside each other');

  await box.fill('короткая строка');
  assert.equal((await box.boundingBox())!.height, oneLine, 'fits: stays small');
  assert.equal(await under(), false);

  const wide = (await box.boundingBox())!.width;
  await box.fill('слово '.repeat(16));
  await waitUntil(under, 'too long for the row: the buttons go under the text');
  assert.ok((await box.boundingBox())!.width > wide, 'the text takes the whole width');

  // A line that fits the full width but not the row must not make the layout jump back and forth.
  await box.fill('длиннее чем место рядом с кнопками, но всё ещё в одну строку на всю ширину поля');
  assert.equal(await under(), true);

  await box.fill('две\nстроки');
  assert.equal(await under(), true, 'a line break is a tall field whatever its width');

  await box.fill('снова коротко');
  await waitUntil(async () => !(await under()), 'back to one line');
  assert.equal((await box.boundingBox())!.height, oneLine);
  await box.fill('');
});

test('no floating inside the app: the surface of Home has the mode, and the rest is in one menu', async () => {
  await page.getByRole('button', { name: 'Ещё', exact: true }).click();
  const items = await page.getByRole('menu').getByRole('menuitem').allTextContents();
  assert.deepEqual(items, ['Корневая сессия во вкладке', 'Очистить историю'], 'no window action in a plain browser');
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('button', { name: /плавающее окно/i }).count(), 0);

  // The burger holds the main screens; the root session's places are on the logo's right click.
  await page.getByRole('button', { name: 'Меню' }).click();
  const menu = await page.getByRole('menu').getByRole('menuitem').allTextContents();
  assert.equal(menu.includes('Корневая сессия во вкладке'), false);
  assert.equal(menu.some((m) => /плавающ/i.test(m)), false);
  await page.keyboard.press('Escape');
  await homeButton(page).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Корневая сессия во вкладке' }).waitFor();
  await page.keyboard.press('Escape');
});

test('the root session in a tab of its own: the same chat as Home, and closing the tab stops nothing', async () => {
  await homeBox().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Корневая сессия во вкладке' }).click();
  const tab = pill(rootName);
  await tab.waitFor();
  assert.equal(await tab.getAttribute('aria-selected'), 'true');
  await page.locator('.work-bar').getByText(rootName).waitFor();

  // The same draft in both inputs, and one chat.
  const field = page.getByRole('textbox', { name: /Начни новый проект/ });
  await field.fill('из вкладки');
  await homeButton(page).click();
  assert.equal(await homeBox().inputValue(), 'из вкладки');
  await homeBox().press('Enter');
  await page.locator('.home-chat').getByText('echo: из вкладки').waitFor();
  await tab.click();
  await page.locator('.work-base').getByText('echo: из вкладки').waitFor();
  await waitUntil(async () => (await field.inputValue()) === '', 'sent: empty here too');

  const session = (await tabsNow()).find((t) => t.kind === 'root')!.sessionId;
  assert.ok(session);

  // A reload keeps it where it was.
  await page.reload();
  await tab.waitFor();
  await page.locator('.work-base').getByText('echo: из вкладки').waitFor();

  await page.getByRole('button', { name: `Закрыть вкладку ${rootName}` }).click();
  await tab.waitFor({ state: 'detached' });
  await homeBox().waitFor();
  assert.equal((await tabsNow()).find((t) => t.kind === 'root')!.sessionId, session, 'the session is untouched');

  // Ctrl+Shift+T brings even this one back.
  await page.keyboard.press('Control+Shift+KeyT');
  await tab.waitFor();
  await page.getByRole('button', { name: `Закрыть вкладку ${rootName}` }).click();
  await tab.waitFor({ state: 'detached' });
  await homeButton(page).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /Вернуть закрытую вкладку/ }).click(); // and from the logo's menu, as from the strip's
  await tab.waitFor();
});

test('Ctrl+Shift+T: the session with its history, the unsent text, the last closed first, read-only stays read-only', async () => {
  const count = (await tabsNow()).length;
  const first = await newTab();
  const second = await newTab();
  await pill(new RegExp(second.title)).click();
  const box = page.getByRole('textbox').last();
  await box.fill('запомни');
  await box.press('Enter');
  await page.getByText('echo: запомни').waitFor();
  await waitUntil(async () => Boolean((await tabsNow()).find((t) => t.id === second.id)?.sessionId), 'the tab has its session');
  const session = (await tabsNow()).find((t) => t.id === second.id)!.sessionId;
  await box.fill('не отправленный текст');
  await waitUntil(() => page.evaluate((id) => localStorage.getItem(`claude-os.draft.${id}`) === 'не отправленный текст', second.id), 'the draft is saved');

  await page.getByRole('button', { name: `Закрыть вкладку ${first.title}` }).click({ force: true });
  await waitUntil(async () => (await tabsNow()).length === count + 1, 'first closed');
  await page.getByRole('button', { name: `Закрыть вкладку ${second.title}` }).click({ force: true });
  await waitUntil(() => page.evaluate(() => JSON.parse(localStorage.getItem('claude-os.closedTabs') ?? '[]').length === 2), 'both remembered');

  await page.keyboard.press('Control+Shift+KeyT');
  await waitUntil(async () => (await tabsNow()).some((t) => t.sessionId === session), 'the session is back in a tab');
  const back = (await tabsNow()).find((t) => t.sessionId === session)!;
  assert.notEqual(back.id, second.id);
  assert.equal(back.title, second.title);
  await page.getByText('echo: запомни').waitFor();
  assert.equal(await page.getByRole('textbox').last().inputValue(), 'не отправленный текст');

  // Never used, it has no session: a new tab in the same folder.
  await page.keyboard.press('Control+Shift+KeyT');
  await waitUntil(async () => (await tabsNow()).some((t) => t.cwd === first.cwd), 'the empty one too');
  assert.equal((await tabsNow()).find((t) => t.cwd === first.cwd)!.sessionId, null);

  // With nothing left a press does nothing.
  const now = (await tabsNow()).length;
  await page.keyboard.press('Control+Shift+KeyT');
  await page.waitForTimeout(200);
  assert.equal((await tabsNow()).length, now);
});

test('Ctrl+Shift+T: a session a terminal took in the meantime comes back read-only', async () => {
  const tab = await newTab();
  await pill(new RegExp(tab.title)).click();
  const box = page.getByRole('textbox').last();
  await box.fill('потом его взял терминал');
  await box.press('Enter');
  await page.getByText('echo: потом его взял терминал').waitFor();
  await waitUntil(async () => Boolean((await tabsNow()).find((t) => t.id === tab.id)?.sessionId), 'the tab has its session');
  const session = (await tabsNow()).find((t) => t.id === tab.id)!.sessionId;
  await page.waitForTimeout(500); // the page's tab list hears of the session too, so the closed tab remembers it
  await page.getByRole('button', { name: `Закрыть вкладку ${tab.title}` }).click({ force: true });
  await waitUntil(async () => !(await tabsNow()).some((t) => t.id === tab.id), 'closed');
  await waitUntil(() => page.evaluate((id) => (JSON.parse(localStorage.getItem('claude-os.closedTabs') ?? '[]') as { sessionId?: string }[]).at(-1)?.sessionId === id, session), 'remembered');

  // A terminal resumed it after the close: its live registry entry is what the server refuses on.
  const terminal = spawn('sleep', ['60'], { stdio: 'ignore' });
  const entry = join(srv.configDir, 'sessions', `${terminal.pid}.json`);
  try {
    const stat = readFileSync(`/proc/${terminal.pid}/stat`, 'latin1');
    mkdirSync(join(srv.configDir, 'sessions'), { recursive: true });
    writeFileSync(entry, JSON.stringify({ pid: terminal.pid, procStart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], sessionId: session, cwd: tab.cwd, status: 'idle', kind: 'interactive', startedAt: Date.now(), updatedAt: Date.now() }));
    await page.keyboard.press('Control+Shift+KeyT');
    await waitUntil(async () => (await tabsNow()).some((t) => t.sessionId === session && t.kind === 'readonly'), 'it opens read-only');
    await page.getByText('echo: потом его взял терминал').waitFor();
    assert.equal(await page.getByText(/ещё жива/).count(), 0, 'no error toast');
  } finally {
    terminal.kill('SIGKILL');
    rmSync(entry, { force: true });
  }
});

test('the right-click menu stays open through a scroll reported after the click, and closes when its target really moves', async () => {
  const tabs = [];
  for (let i = 0; i < 10; i++) tabs.push(await newTab());
  // A closed tab gives every pill its "reopen" item.
  await page.getByRole('button', { name: `Закрыть вкладку ${tabs[0].title}` }).click();
  await pill(new RegExp(tabs[0].title)).waitFor({ state: 'detached' });
  const last = pill(new RegExp(tabs.at(-1)!.title));
  await last.click();
  await waitUntil(async () => (await page.getByRole('tablist').evaluate((el) => el.scrollLeft)) > 0, 'the strip scrolled to the far tab');

  // The first pill is off the strip: the browser scrolls it in on the way to the click, the event comes a frame later.
  await pill(new RegExp(tabs[1].title)).click({ button: 'right' });
  await page.waitForTimeout(200);
  await page.getByRole('menuitem', { name: /Вернуть закрытую вкладку/ }).waitFor();

  // A scroll somewhere else, a stream in a chat say, leaves it alone.
  await page.locator('[data-testid="transcript-scroller"]').first().evaluate((el) => el.dispatchEvent(new Event('scroll')));
  await page.waitForTimeout(100);
  assert.equal(await page.locator('[data-context-menu]').count(), 1);

  // Its own strip moving takes the target away.
  await page.getByRole('tablist').evaluate((el) => { el.scrollLeft += 200; });
  await page.locator('[data-context-menu]').waitFor({ state: 'detached' });
});
