// /btw and the terminal dialog in the browser: the real server, the fake CLI, wt.exe a script. No tokens, nothing opens on Windows.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startServer, waitUntil, type TestServer } from '../server/chat/fixtures/harness.ts';
import type { Tab } from '../shared/contract.ts';

const alive = (pid: number) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
type Logged = { kind: string; pid: number; argv: string[] };

const binDir = mkdtempSync(join(tmpdir(), 'claude-os-wt-'));
const wtLog = join(binDir, 'wt.log');
writeFileSync(join(binDir, 'wt.exe'), `#!/bin/bash\nprintf '%s\\n' "$*" >> "${wtLog}"\n`);
chmodSync(join(binDir, 'wt.exe'), 0o755);

let browser: Browser;
let srv: TestServer;
let ctx: BrowserContext | null = null;
let errors: string[] = [];

before(async () => {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  srv = await startServer({ PATH: `${binDir}:${process.env.PATH}`, CLAUDE_OS_TAB_IDLE_MS: '400' });
});
after(async () => {
  await browser.close();
  await srv.destroy();
  rmSync(binDir, { recursive: true, force: true });
});
afterEach(async () => {
  assert.deepEqual(errors, []);
  await ctx?.close();
  ctx = null;
  errors = [];
});

async function open(view: unknown, locale = 'ru-RU'): Promise<Page> {
  ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale, reducedMotion: 'reduce' });
  await ctx.addInitScript((v) => localStorage.setItem('claude-os.view', v), JSON.stringify(view));
  ctx.setDefaultTimeout(20000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${srv.port}/auth?token=${readFileSync(join(srv.dataDir, 'token'), 'utf8').trim()}`);
  return page;
}

const newTab = async () => (await srv.api<Tab>('POST', '/api/tabs', { cwd: mkdtempSync(join(srv.dir, 'w-')) })).body;
const prints = () => srv.log().filter((l) => l.kind === 'print') as unknown as Logged[];
const spawns = () => srv.log().filter((l) => l.kind === 'spawn') as unknown as Logged[];
const field = (page: Page) => page.locator('main').getByRole('textbox').last(); // the composer, not the side window's field
const win = (page: Page) => page.getByRole('dialog', { name: 'Вопрос в сторону' });
const turns = (page: Page) => win(page).getByTestId('btw-turn');
const ask = async (page: Page, text: string) => {
  const box = win(page).getByRole('textbox');
  await box.fill(text);
  await box.press('Enter');
};

async function submit(page: Page, text: string) {
  const box = field(page);
  await box.fill(text);
  if (!text.includes(' ')) await box.press('Escape'); // the `/` list. With none open, Esc would close the side window.
  await box.press('Enter');
}

test('/btw in a work tab during a turn: the side window opens, a follow-up continues the thread, nothing reaches the conversation', async () => {
  const tab = await newTab();
  const page = await open({ kind: 'tab', id: tab.id });
  await submit(page, 'SLOW');
  await page.getByText('tick').first().waitFor();
  const spawned = spawns().length;

  await submit(page, '/btw первый');
  await turns(page).filter({ hasText: 'side: первый' }).waitFor();
  assert.equal(await field(page).inputValue(), '');
  const box = (await win(page).boundingBox())!;
  assert.ok(Math.abs(box.width - 420) < 2 && Math.abs(box.height - 420) < 2, `square: ${box.width}x${box.height}`);
  assert.equal(await win(page).getByRole('textbox').evaluate((el) => el === document.activeElement), true);

  await ask(page, 'второй');
  await turns(page).filter({ hasText: 'Earlier in this side thread' }).filter({ hasText: 'второй' }).waitFor();
  const flags = prints().at(-1)!.argv;
  assert.ok(flags.includes('--resume') && flags.includes('--fork-session'), 'the follow-up forks the tab again');
  assert.equal(spawns().length, spawned, 'the turn keeps its one process');
  assert.ok(alive(spawns().at(-1)!.pid));

  await page.keyboard.press('Escape');
  await win(page).waitFor({ state: 'detached' });
  await page.getByText('tick').first().waitFor();
  const history = JSON.stringify((await srv.api('GET', `/api/tabs/${tab.id}/history`)).body);
  assert.equal(history.includes('side:'), false);
  assert.equal(history.includes('первый'), false);
  await srv.api('POST', `/api/tabs/${tab.id}/interrupt`);
});

test('closing the window with a question running kills its child: by the cross and by Esc', async () => {
  const tab = await newTab();
  const page = await open({ kind: 'tab', id: tab.id });
  await field(page).waitFor();

  for (const how of ['cross', 'esc']) {
    const count = prints().length;
    await submit(page, '/btw BTWHOLD');
    await turns(page).filter({ hasText: 'начало ответа' }).waitFor();
    await waitUntil(() => prints().length > count, 'the child started');
    const child = prints()[count];
    assert.ok(alive(child.pid));
    if (how === 'cross') await win(page).getByRole('button', { name: 'Закрыть вопрос в сторону' }).click();
    else await page.keyboard.press('Escape');
    await win(page).waitFor({ state: 'detached' });
    await waitUntil(() => !alive(child.pid), `the child is gone after ${how}`);
  }
});

test('bare /btw opens the window empty and sends nothing; a failed child shows its reason', async () => {
  const tab = await newTab();
  const page = await open({ kind: 'tab', id: tab.id });
  const count = prints().length;
  await submit(page, '/btw');
  await win(page).getByText(/учтёт разговор этой вкладки/).waitFor();
  assert.equal(await win(page).getByText(/Выполняет Claude|Входит в|подписк|Ultra/).count(), 0, 'no note on cost or plan under the field');
  assert.equal(await field(page).inputValue(), '');
  assert.equal(prints().length, count);
  await page.keyboard.type('из окна');
  await page.keyboard.press('Enter');
  await turns(page).filter({ hasText: 'plain: из окна' }).waitFor();
  await page.keyboard.press('Escape'); // a new thread: the fake picks its scenario by how the question starts
  await win(page).waitFor({ state: 'detached' });
  await submit(page, '/btw BTWCRASH');
  await win(page).getByRole('alert').getByText(/fake side crash/).waitFor();
});

test('/btw on Home: the root folder, no conversation behind it', async () => {
  const page = await open({ kind: 'home' });
  const box = page.getByPlaceholder('Начни новый проект, запусти что-то…');
  await box.fill('/btw с главной');
  await box.press('Enter');
  await turns(page).filter({ hasText: 'plain: с главной' }).waitFor();
  await win(page).getByText('Без проекта').waitFor();
  const call = prints().at(-1)! as Logged & { cwd: string };
  assert.match(call.cwd, /\/root$/);
  assert.equal(call.argv.includes('--resume'), false);
  await page.keyboard.press('Escape');
  await win(page).waitFor({ state: 'detached' });
});

test('Ctrl+Shift+Space opens the window empty from any screen, Esc closes it', async () => {
  const page = await open({ kind: 'settings' });
  await page.getByRole('heading').first().waitFor();
  await page.keyboard.press('Control+Shift+Space');
  await win(page).getByText(/Ctrl\+Shift\+Space открывает/).waitFor();
  await ask(page, 'из настроек');
  await turns(page).filter({ hasText: 'plain: из настроек' }).waitFor();
  await page.keyboard.press('Escape');
  await win(page).waitFor({ state: 'detached' });
});

test('the terminal dialog says what will really happen: a copy while the session has a tab, live or idled', async () => {
  const tab = await newTab();
  const page = await open({ kind: 'tab', id: tab.id });
  await submit(page, 'SLOW');
  await page.getByText('tick').first().waitFor();

  await submit(page, '/mobile');
  const dialog = page.getByRole('dialog', { name: '/mobile' });
  await dialog.getByText(/Откроется отдельная копия этого разговора.*Вкладка продолжит работать.*закрытие терминала её не затронет/).waitFor();
  await dialog.getByText(/--fork-session/).waitFor();
  await dialog.getByRole('button', { name: 'Открыть в терминале' }).click();
  await page.getByText('В терминале открыта отдельная копия разговора').waitFor();
  await waitUntil(() => existsSync(wtLog) && /--fork-session/.test(readFileSync(wtLog, 'utf8')), 'wt.exe got the flag');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  await srv.api('POST', `/api/tabs/${tab.id}/interrupt`);
  await waitUntil(() => !alive(spawns().at(-1)!.pid), 'the idle process stopped');

  await submit(page, '/mobile');
  await dialog.getByText(/Откроется отдельная копия этого разговора/).waitFor();
  await dialog.getByText(/--fork-session/).waitFor();
});

test('/branch opens a copy in a new tab, a command with a screen here puts the terminal second', async () => {
  const tab = await newTab();
  const page = await open({ kind: 'tab', id: tab.id });
  await submit(page, 'привет');
  await page.getByText('echo: привет').waitFor();

  await submit(page, '/config');
  const config = page.getByRole('dialog', { name: '/config' });
  const toSettings = config.getByRole('button', { name: 'Открыть настройки' });
  const terminal = config.getByRole('button', { name: 'Открыть в терминале' });
  await toSettings.waitFor();
  assert.match((await toSettings.getAttribute('class'))!, /bg-accent/);
  assert.doesNotMatch((await terminal.getAttribute('class'))!, /bg-accent/, 'the terminal is the secondary one');
  await page.keyboard.press('Escape');

  await submit(page, '/mobile');
  const mobile = page.getByRole('dialog', { name: '/mobile' });
  assert.match((await mobile.getByRole('button', { name: 'Открыть в терминале' }).getAttribute('class'))!, /bg-accent/, 'nothing else to do: it is the main button');
  await page.keyboard.press('Escape');

  await submit(page, '/branch');
  await page.getByRole('dialog', { name: '/branch' }).getByRole('button', { name: 'Открыть ветку в новой вкладке' }).click();
  await page.waitForFunction((id) => { const v = JSON.parse(localStorage.getItem('claude-os.view')!); return v.kind === 'tab' && v.id !== id; }, tab.id);
  await page.getByText('echo: привет').waitFor();
  const tabs = (await srv.api<Tab[]>('GET', '/api/tabs')).body;
  const branch = tabs.find((t) => t.title.endsWith('(ветка)'))!;
  assert.notEqual(branch.sessionId, tabs.find((t) => t.id === tab.id)!.sessionId);
});

test('english: the handoff and the side window', async () => {
  const tab = await newTab();
  const page = await open({ kind: 'tab', id: tab.id }, 'en-US');
  await submit(page, '/btw');
  await page.getByRole('dialog', { name: 'Side question' }).getByText(/stays out of it/).waitFor();
  await page.keyboard.press('Escape');
  await submit(page, '/mobile');
  await page.getByRole('dialog', { name: '/mobile' }).getByText(/starts a new one in this folder/).waitFor();
});
