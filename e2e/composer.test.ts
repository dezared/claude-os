// The input and the root panel: the real server, the fake CLI, a real browser. No tokens. Set CLAUDE_OS_WEB_DIST to test another build.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import type { Tab } from '../shared/contract.ts';
import { startServer, waitUntil, type TestServer } from '../server/chat/fixtures/harness.ts';

let srv: TestServer;
let browser: Browser;
let ctx: BrowserContext;
let page: Page;
const errors: string[] = [];

const SEND = /^(Отправить|В очередь)$/;
const homeBox = () => page.getByRole('textbox', { name: /Начни новый проект/ });
const panelTitle = () => page.locator('.root-panel').getByText('Корневая сессия Claude');
// Probes for models and the slash menu are short-lived and keep no session: they say nothing about the session's process.
const spawns = () => (srv.log().filter((l) => l.kind === 'spawn') as { argv: string[] }[]).filter((l) => !l.argv.includes('--no-session-persistence'));
const modeLog = () => srv.log().filter((l) => l.kind === 'control' && l.subtype === 'set_permission_mode').map((l) => (l.request as { mode: string }).mode);

async function enter(context: BrowserContext): Promise<Page> {
  const p = await context.newPage();
  p.on('pageerror', (e) => errors.push(e.message));
  const token = readFileSync(join(srv.dataDir, 'token'), 'utf8').trim();
  await p.goto(`http://127.0.0.1:${srv.port}/auth?token=${token}`);
  return p;
}

before(async () => {
  srv = await startServer({ CLAUDE_OS_PTY_SETTLE_MS: '400' });
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  ctx.setDefaultTimeout(60_000); // the map renders in software here: a loaded machine stalls the page for many seconds
  page = await enter(ctx);
  await homeBox().waitFor();
});

after(async () => {
  await browser?.close();
  await srv?.destroy();
  assert.deepEqual(errors, []);
});

const say = async (box: Locator, text: string) => {
  await box.fill(text);
  await box.press('Enter');
};

async function box(l: Locator) {
  const b = await l.boundingBox();
  assert.ok(b, 'visible');
  return b;
}

// Every control of the row shares its bottom edge and its height, and the field ends on the same line.
async function assertAligned(field: Locator, label: string) {
  const attach = await box(page.locator('label:has(input[type="file"]):visible'));
  const send = await box(page.getByRole('button', { name: SEND }));
  const input = await box(field);
  const bottom = attach.y + attach.height;
  assert.ok(Math.abs(send.y + send.height - bottom) <= 0.5, `${label}: send ${send.y + send.height} and attach ${bottom} on one line`);
  assert.equal(send.height, attach.height, `${label}: one height`);
  assert.ok(Math.abs(input.y + input.height - bottom) <= 0.5, `${label}: field ${input.y + input.height} ends with the controls ${bottom}`);
  return { bottom, input };
}

const lines = (n: number) => Array.from({ length: n }, (_, i) => `строка ${i}`).join('\n');

async function checkAlignment(field: Locator) {
  await field.fill('');
  const one = await assertAligned(field, 'empty');
  for (const n of [1, 2, 5, 12, 60]) {
    await field.fill(lines(n));
    const now = await assertAligned(field, `${n} lines`);
    assert.ok(Math.abs(now.bottom - one.bottom) <= 0.5, `${n} lines: the row stays where it was`);
  }
  await field.fill('');
}

test('home input: stays one line while the text fits, grows upward past it, the controls stay on their line', async () => {
  const field = homeBox();
  const send = field.locator('..').getByRole('button', { name: SEND });
  const empty = await box(field);
  const bottom = (await box(send)).y + (await box(send)).height;
  assert.ok(empty.height < 40, `one line when empty: ${empty.height}`);
  await field.fill('a');
  assert.equal((await box(field)).height, empty.height, 'a short line changes nothing');
  for (const n of [2, 5, 12, 60]) {
    await field.fill(lines(n));
    const now = await box(send);
    assert.ok(Math.abs(now.y + now.height - bottom) <= 0.5, `${n} lines: the controls stay where they were`);
    assert.ok((await box(field)).y + (await box(field)).height <= now.y + 0.5, `${n} lines: the text over them`);
  }
  await field.fill('');
  assert.equal((await box(field)).height, empty.height);
});

test('no stop button and no mode select inside the input', async () => {
  assert.equal(await page.getByRole('combobox', { name: /Режим разрешений/ }).count(), 0);
  assert.equal(await page.getByRole('button', { name: 'Прервать ход' }).count(), 0, 'nothing to stop');
});

test('stop sits to the right of "Claude работает" and exists only during the turn', async () => {
  await say(homeBox(), 'SLOW');
  const status = page.getByRole('status').filter({ hasText: 'Claude работает' });
  await status.waitFor();
  const stop = status.getByRole('button', { name: 'Прервать ход' });
  // Measured in one go: the transcript keeps scrolling under the stream.
  const { pill, text } = await status.evaluate((el) => {
    const rect = (e: Element) => { const r = e.getBoundingClientRect(); return { x: r.x, middle: r.y + r.height / 2 }; };
    return { pill: rect(el.querySelector('button')!), text: rect(el.querySelector('i')!) };
  });
  assert.ok(pill.x > text.x, 'to the right of the text');
  assert.ok(Math.abs(pill.middle - text.middle) <= 1.5, `on one line: ${pill.middle} ${text.middle}`);
  assert.equal(await page.getByRole('button', { name: 'Прервать ход' }).count(), 1, 'the only one on screen');
  await page.screenshot({ path: '/tmp/cos-composer-working.png', timeout: 90_000 });
  await stop.click();
  await stop.waitFor({ state: 'detached' });
});

test('mode: underlined text under the field opens a real dialog with a description of each mode', async () => {
  const trigger = page.getByRole('button', { name: /Режим разрешений/ });
  assert.equal(await trigger.count(), 1, 'one control');
  assert.ok((await box(trigger)).y >= (await box(homeBox())).y + (await box(homeBox())).height, 'under the field, in one place whether the panel is open or not');
  assert.match(await trigger.evaluate((el) => getComputedStyle(el).textDecorationLine), /underline/);
  assert.equal(await trigger.locator('svg').count(), 2, 'an icon and a chevron');

  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Режим разрешений' });
  await dialog.waitFor();
  const radios = dialog.getByRole('radio');
  assert.equal(await radios.count(), 6);
  for (const text of ['Спрашивать', 'Принимать правки', 'План', 'Авто', 'Только разрешённое', 'Без проверок']) await dialog.getByText(text, { exact: true }).waitFor();
  await dialog.getByText('Правки файлов принимаются сами').waitFor();
  await page.screenshot({ path: '/tmp/cos-composer-modes.png', timeout: 90_000 });

  await radios.filter({ hasText: 'План' }).click();
  await dialog.waitFor({ state: 'detached' });
  await trigger.getByText('План').waitFor();
  assert.deepEqual(modeLog(), ['plan']);

  // Going without checks asks first, inside the dialog.
  await trigger.click();
  await dialog.getByRole('radio').filter({ hasText: 'Без проверок' }).click();
  await dialog.getByRole('alert').getByText(/ничего не спрашивая/).waitFor();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await dialog.getByRole('alert').waitFor({ state: 'detached' });
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.deepEqual(modeLog(), ['plan']);

  await radiosReset(trigger);
});

async function radiosReset(trigger: Locator) {
  await trigger.click();
  await page.getByRole('dialog', { name: 'Режим разрешений' }).getByRole('radio').filter({ hasText: 'Авто' }).click();
  await trigger.getByText('Авто').waitFor();
}

test('work tab: same row, stop by the status, mode under the input', async () => {
  const dir = join(srv.dir, 'w');
  mkdirSync(dir);
  const tab = (await srv.api<Tab>('POST', '/api/tabs', { cwd: dir, title: 'рабочая' })).body;
  await page.evaluate((id) => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'tab', id })), tab.id);
  await page.reload();
  const field = page.getByRole('textbox', { name: /Сообщение/ }).first();
  await field.waitFor();
  await checkAlignment(field);
  await field.fill('a');
  assert.ok((await box(field)).height < 40, 'only the home field opens up by itself');

  await page.getByRole('button', { name: /Режим разрешений/ }).waitFor();
  const stops = page.getByRole('button', { name: 'Прервать ход' });
  assert.equal(await stops.count(), 0);
  await say(field, 'SLOW');
  const status = page.getByRole('status').filter({ hasText: 'Claude работает' });
  await status.getByRole('button', { name: 'Прервать ход' }).waitFor();
  await page.screenshot({ path: '/tmp/cos-composer-work.png', timeout: 90_000 });
  await status.getByRole('button', { name: 'Прервать ход' }).click();
  await stops.waitFor({ state: 'detached' });

  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'home' })));
  await page.reload();
  await homeBox().waitFor();
});

test('history: the panel opens by itself after a reload and after a server restart', async () => {
  await panelTitle().waitFor();
  await say(homeBox(), 'запомни это');
  await page.getByText('echo: запомни это').waitFor();
  await page.reload();
  await page.getByText('echo: запомни это').waitFor();
  await srv.restart();
  await page.reload();
  await page.getByText('echo: запомни это').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Показать ответ' }).count(), 0, 'open, not collapsed');
  await page.screenshot({ path: '/tmp/cos-composer-history.png', timeout: 90_000 });
});

const savedDrafts = () => page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('claude-os.draft.')).map((k) => localStorage.getItem(k)));

test('draft: typed text survives a reload at once and a server restart, a failed send keeps it, a sent one clears it', async () => {
  await homeBox().fill('заметка на главной');
  await page.reload(); // no pause: the write is debounced and must not depend on it
  await homeBox().waitFor();
  assert.equal(await homeBox().inputValue(), 'заметка на главной');

  await srv.restart();
  await page.reload();
  await homeBox().waitFor();
  assert.equal(await homeBox().inputValue(), 'заметка на главной');

  await page.route('**/api/tabs/*/send', (r) => r.fulfill({ status: 500, json: { error: 'сбой отправки' } }));
  await homeBox().press('Enter');
  await page.getByText('сбой отправки').first().waitFor();
  assert.equal(await homeBox().inputValue(), 'заметка на главной', 'back in the field');
  assert.deepEqual(await savedDrafts(), ['заметка на главной'], 'and never left the storage');
  await page.unroute('**/api/tabs/*/send');

  // The saved copy stays until the server has answered.
  let release = () => {};
  const held = new Promise<void>((r) => { release = r; });
  await page.route('**/api/tabs/*/send', async (r) => { await held; await r.continue(); });
  await homeBox().press('Enter');
  await waitUntil(async () => (await homeBox().inputValue()) === '', 'the field empties');
  assert.deepEqual(await savedDrafts(), ['заметка на главной']);
  release();
  await page.getByText('echo: заметка на главной').waitFor();
  await page.unroute('**/api/tabs/*/send');
  await waitUntil(async () => (await savedDrafts()).length === 0, 'the saved copy is gone');
  await page.reload();
  await homeBox().waitFor();
  assert.equal(await homeBox().inputValue(), '');
});

test('draft: each work tab keeps its own, emptying the field removes it', async () => {
  const open = async (id: string) => {
    await page.evaluate((v) => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'tab', id: v })), id);
    await page.reload();
  };
  const field = () => page.getByRole('textbox', { name: /Сообщение/ }).first();
  const dir = join(srv.dir, 'drafts');
  mkdirSync(dir);
  const one = (await srv.api<Tab>('POST', '/api/tabs', { cwd: dir, title: 'первая' })).body;
  const two = (await srv.api<Tab>('POST', '/api/tabs', { cwd: dir, title: 'вторая' })).body;
  await open(one.id);
  await field().fill('текст первой');
  await open(two.id);
  await field().waitFor();
  assert.equal(await field().inputValue(), '');
  await open(one.id);
  await field().waitFor();
  assert.equal(await field().inputValue(), 'текст первой');
  await field().fill('');
  await waitUntil(async () => (await savedDrafts()).length === 0, 'the emptied draft is gone');
  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'home' })));
  await page.reload();
  await homeBox().waitFor();
});

test('/usage and the like show their terminal screen in the chat', async () => {
  await say(homeBox(), '/usage');
  await page.getByText('Screen of /usage').waitFor();
  await page.getByText('Current session: 12% used').waitFor();
  assert.equal(srv.log().filter((l) => l.kind === 'user' && l.content === '/usage').length, 0, 'never sent to the model');
  await page.screenshot({ path: '/tmp/cos-composer-usage.png', timeout: 90_000 });
  await page.locator('i[role="status"]').waitFor({ state: 'detached' });
});

test('/rc is in the menu and answers with the link', async () => {
  await homeBox().fill('/r');
  const list = page.getByRole('listbox', { name: 'Слэш-команды' });
  await list.getByText('/rc').waitFor();
  await say(homeBox(), '/rc');
  await page.getByText(/Remote Control включён/).waitFor();
  await page.getByText(/claude\.ai\/code\/session_/).first().waitFor();
  await say(homeBox(), '/rc');
  await page.getByText(/Remote Control выключен/).waitFor();
});

test('/clear takes everything away and the process stays', async () => {
  await say(homeBox(), 'для очистки');
  await page.getByText('echo: для очистки').waitFor();
  const count = spawns().length;
  await say(homeBox(), '/clear');
  await panelTitle().waitFor({ state: 'detached' });
  assert.equal(await page.getByText('echo: для очистки').count(), 0);
  assert.equal(await homeBox().inputValue(), '');
  await say(homeBox(), 'снова привет');
  await page.getByText('echo: снова привет').waitFor();
  assert.equal(spawns().length, count, 'not restarted');
  assert.equal(await page.getByText('/clear', { exact: true }).count(), 0, 'not a message');
});

test('X: warns, then clears, stops the session, and the next message starts a new one', async () => {
  const clear = async () => {
    await page.getByRole('button', { name: 'Ещё', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Очистить историю' }).click();
  };
  await clear();
  const dialog = page.getByRole('dialog', { name: 'Очистить историю?' });
  await dialog.getByText(/текущая сессия остановится/).waitFor();
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByText('echo: снова привет').waitFor();

  const count = spawns().length;
  await clear();
  await dialog.getByRole('button', { name: 'Очистить и начать заново' }).click();
  await panelTitle().waitFor({ state: 'detached' });
  assert.equal(await page.getByText('echo: снова привет').count(), 0);

  await page.reload();
  await homeBox().waitFor();
  await page.waitForTimeout(500);
  assert.equal(await panelTitle().count(), 0, 'nothing comes back');

  await say(homeBox(), 'новая сессия');
  await page.getByText('echo: новая сессия').waitFor();
  assert.equal(spawns().length, count + 1);
  assert.equal(spawns().at(-1)!.argv.some((a) => a.startsWith('--resume')), false);
});

test('with motion on: the field, the panel and /clear really animate', async () => {
  const moving = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 } });
  moving.setDefaultTimeout(60_000);
  const p = await enter(moving);
  try {
    const field = p.getByRole('textbox', { name: /Начни новый проект/ });
    await field.waitFor();
    const heightAnimations = (l: Locator) => l.evaluate((el) => el.getAnimations().map((a) => (a as CSSTransition).transitionProperty));

    // The panel opens from its starting style.
    const panel = p.locator('.root-panel');
    await panel.waitFor();
    const row = field.locator('..');
    const running = () => row.evaluate((el) => el.getAnimations().length);
    const short = (await row.boundingBox())!.height;
    await field.fill('x');
    assert.equal((await row.boundingBox())!.height, short, 'a short line changes nothing');
    assert.equal(await running(), 0);
    await field.fill('длинная строка, которая уже не помещается рядом с кнопками '.repeat(2));
    assert.ok((await running()) > 0, 'text over the buttons: the row grows through an animation');
    await waitUntil(async () => (await running()) === 0, 'it has grown');
    assert.ok((await row.boundingBox())!.height > short);
    await field.fill('');
    assert.ok((await running()) > 0, 'and shrinks back the same way');
    await waitUntil(async () => (await running()) === 0, 'it has shrunk');
    assert.equal((await row.boundingBox())!.height, short);

    await p.getByRole('button', { name: 'Свернуть ответ' }).click();
    assert.ok((await heightAnimations(panel)).includes('height'), 'collapsing is a transition');
    await panel.waitFor({ state: 'detached' });

    await p.getByRole('button', { name: 'Показать ответ' }).click();
    await panel.waitFor();
    assert.ok((await heightAnimations(panel)).includes('height'), 'opening is a transition');
    await waitUntil(async () => (await panel.evaluate((el) => el.getAnimations().length)) === 0, 'the panel has opened');

    await field.fill('/clear');
    await field.press('Enter');
    await waitUntil(async () => (await panel.count()) === 0 || (await panel.evaluate((el) => el.classList.contains('is-leaving'))), 'the panel leaves');
    await panel.waitFor({ state: 'detached' });
  } finally {
    await moving.close();
  }
});

test('@ on the real server: a kanban task is found by its id and goes in as the path of its .md file', async () => {
  const made = await srv.api<{ id: string; path: string }>('POST', '/api/kanban/cards', { title: 'Задача из меню' });
  assert.match(made.body.id, /^TASK-\d+$/);
  assert.ok(readFileSync(made.body.path, 'utf8').includes('title: "Задача из меню"'), 'the card is a file');
  const box = homeBox();
  await box.click();
  await box.pressSequentially('@');
  await page.getByRole('listbox', { name: 'Элементы и файлы' }).getByRole('option').first().getByText('Задача канбана').waitFor();
  await page.keyboard.press('Space');
  await page.keyboard.type(made.body.id);
  const option = page.getByRole('listbox', { name: 'Задача канбана' }).getByRole('option', { name: new RegExp(made.body.id) });
  await option.waitFor();
  await page.keyboard.press('Enter');
  assert.equal(await box.inputValue(), `@${made.body.path} (${made.body.id}: Задача из меню) `);
  await box.fill('');
});
