// Paste into the chat input, commands from a session to the interface, and the Projects screen. A fake backend, a real browser.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { mapKeys } from '../web/src/home/universe/selection.ts';
import { defaultFixture, startFixture, type Fixture, type FixtureServer } from './fixture-server.ts';

const SHOTS = '/tmp/cos-input-projects-shots';
let browser: Browser;
let ctx: BrowserContext;
let fx: FixtureServer;
let data: Fixture;
let page: Page;
const errors: string[] = [];

const box = () => page.getByRole('textbox', { name: /Начни новый проект/ });
const copy = (text: string) => page.evaluate((t) => navigator.clipboard.writeText(t), text);
// A picture to look at, not a check: on a loaded machine with a software GPU a screenshot can miss any timeout.
const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), timeout: 30_000 }).catch(() => {});
const waitValue = (v: string) => page.waitForFunction((v) => (document.querySelector('textarea') as HTMLTextAreaElement).value === v, v);
const LONG = Array.from({ length: 60 }, (_, i) => `строка номер ${i} с достаточно длинным текстом`).join('\n');

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  data = defaultFixture();
  fx = await startFixture(data);
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'ru-RU', reducedMotion: 'reduce' });
  ctx.setDefaultTimeout(60_000);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  await box().waitFor();
});

after(async () => {
  await browser?.close();
  await fx?.close();
  assert.deepEqual(errors, []);
});

test('the map: a folder is no star, even when pinned', () => {
  const row = (key: string, extra: object = {}) => ({ key, liveCount: 1, lastActivity: 1, pinned: false, mapPin: null, ...extra });
  const keys = mapKeys([row('a'), row('box', { folder: true }), row('pinned', { folder: true, mapPin: true })], [], null, 10);
  assert.deepEqual([...keys], ['a']);
});

test('short text pastes as it is, with the focus in the field or anywhere else on the screen', async () => {
  await copy('короткий текст');
  await box().click();
  await page.keyboard.press('Control+V');
  await page.waitForFunction(() => (document.querySelector('textarea') as HTMLTextAreaElement | null)?.value !== '');
  assert.equal(await box().inputValue(), 'короткий текст');

  await box().fill('');
  await box().blur();
  await page.keyboard.press('Control+V');
  await page.waitForFunction(() => document.activeElement?.tagName === 'TEXTAREA');
  assert.equal(await box().inputValue(), 'короткий текст', 'pasted with the focus nowhere in particular');
  await box().fill('');
});

test('a long paste folds into a mark; the whole text goes out; undo and a reload do not lose it', async () => {
  await copy(LONG);
  await box().click();
  await page.keyboard.type('вот лог: ');
  await page.keyboard.press('Control+V');
  await page.waitForFunction(() => (document.querySelector('textarea') as HTMLTextAreaElement).value.includes('#1'));
  const value = await box().inputValue();
  assert.equal(value, 'вот лог: [Вставка #1 · строк: 60]');

  // The second paste has its own number; a single long line counts characters.
  const line = 'x'.repeat(900);
  await copy(line);
  await page.keyboard.press('Control+V');
  await page.waitForFunction(() => (document.querySelector('textarea') as HTMLTextAreaElement).value.includes('#2'));
  assert.equal(await box().inputValue(), 'вот лог: [Вставка #1 · строк: 60][Вставка #2 · символов: 900]');

  // A reload keeps the draft and what it refers to.
  await page.waitForTimeout(400);
  await page.reload();
  await box().waitFor();
  assert.equal(await box().inputValue(), 'вот лог: [Вставка #1 · строк: 60][Вставка #2 · символов: 900]');

  // A refused message comes back as the marks, not as the unfolded text.
  await page.route(/\/api\/tabs\/[^/]+\/send$/, (r) => r.fulfill({ status: 500, json: { error: 'нет связи' } }));
  await box().press('Enter');
  await page.getByText('нет связи').waitFor();
  assert.equal(await box().inputValue(), 'вот лог: [Вставка #1 · строк: 60][Вставка #2 · символов: 900]');
  await page.unroute(/\/api\/tabs\/[^/]+\/send$/);

  await page.route(/\/api\/tabs\/[^/]+\/send$/, (r) => r.fulfill({ status: 200, json: { ok: true } }));
  const sent = page.waitForRequest((r) => /\/api\/tabs\/[^/]+\/send$/.test(new URL(r.url()).pathname));
  await box().press('Enter');
  const body = (await sent).postDataJSON() as { text: string };
  assert.equal(body.text, `вот лог: <pasted lines="60">\n${LONG}\n</pasted><pasted lines="1">\n${line}\n</pasted>`);
  await page.waitForFunction(() => !Object.keys(localStorage).some((k) => k.startsWith('claude-os.pastes.')));
  assert.equal(await box().inputValue(), '');
  await page.unroute(/\/api\/tabs\/[^/]+\/send$/);
});

test('a long paste is a chip in the text: Backspace takes it whole, undo brings it back, the menu unfolds it', async () => {
  await copy(LONG);
  await box().click();
  await page.keyboard.type('лог ');
  await page.keyboard.press('Control+V');
  const chip = page.locator('[data-chip-layer] [data-chip="paste"]');
  await chip.waitFor();
  assert.equal(await chip.textContent(), '[Вставка #1 · строк: 60]');
  assert.equal(await chip.getAttribute('data-id'), '1');
  await shot('paste-chip');

  // The caret does not stop inside it: a click lands on the nearer edge, an arrow step jumps over it.
  const caret = (n: number) => page.waitForFunction((n) => (document.querySelector('textarea') as HTMLTextAreaElement).selectionStart === n, n);
  const at = (await chip.boundingBox())!;
  await page.mouse.click(at.x + at.width * 0.8, at.y + at.height / 2);
  await caret('лог [Вставка #1 · строк: 60]'.length);
  await page.mouse.click(at.x + at.width * 0.2, at.y + at.height / 2);
  await caret('лог '.length);
  await page.keyboard.press('ArrowRight');
  await caret('лог [Вставка #1 · строк: 60]'.length);
  await page.keyboard.press('ArrowLeft');
  await caret('лог '.length);

  await page.keyboard.press('End');
  await page.keyboard.press('Backspace');
  assert.equal(await box().inputValue(), 'лог ', 'one key takes the whole chip');
  await chip.waitFor({ state: 'detached' });
  await page.keyboard.press('Control+Z');
  assert.equal(await box().inputValue(), 'лог [Вставка #1 · строк: 60]');
  await chip.waitFor();

  const place = (await chip.boundingBox())!;
  await page.mouse.click(place.x + place.width / 2, place.y + place.height / 2, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Развернуть в текст' }).click();
  await waitValue(`лог ${LONG}`);
  assert.equal(await chip.count(), 0);
  await page.keyboard.press('Control+Z');
  await waitValue('лог [Вставка #1 · строк: 60]');

  await page.route(/\/api\/tabs\/[^/]+\/send$/, (r) => r.fulfill({ status: 200, json: { ok: true } }));
  const sent = page.waitForRequest((r) => /\/api\/tabs\/[^/]+\/send$/.test(new URL(r.url()).pathname));
  await box().press('Enter');
  assert.equal(((await sent).postDataJSON() as { text: string }).text, `лог <pasted lines="60">\n${LONG}\n</pasted>`);
  await page.waitForFunction(() => !Object.keys(localStorage).some((k) => k.startsWith('claude-os.pastes.')));
  await page.unroute(/\/api\/tabs\/[^/]+\/send$/);
});

test('a chip stays on its mark: a selection takes it whole, a scrolled field with a last empty line keeps it in place', async () => {
  await copy(LONG);
  await box().click();
  await page.keyboard.type('лог ');
  await page.keyboard.press('Control+V');
  const chip = page.locator('[data-chip-layer] [data-chip="paste"]');
  await chip.waitFor();
  const at = (await chip.boundingBox())!;
  await page.mouse.dblclick(at.x + at.width / 2, at.y + at.height / 2); // a word inside the mark
  await page.waitForFunction(() => { const f = document.querySelector('textarea')!; return f.selectionStart === 4 && f.selectionEnd === f.value.length; });
  await page.keyboard.type('x');
  await waitValue('лог x');
  await page.keyboard.press('Control+Z');
  await waitValue('лог [Вставка #1 · строк: 60]');
  await page.keyboard.press('End');
  await page.keyboard.press('Shift+ArrowLeft');
  await page.waitForFunction(() => document.querySelector('textarea')!.selectionStart === 4);
  await page.keyboard.press('Delete');
  await waitValue('лог ');
  await page.keyboard.press('Control+Z');
  await waitValue('лог [Вставка #1 · строк: 60]');

  // Taller than the field, ending with a line break, scrolled to the bottom: the chip is drawn where the mark is.
  await box().evaluate((el) => {
    const f = el as HTMLTextAreaElement;
    f.focus();
    f.setSelectionRange(0, 0);
    document.execCommand('insertText', false, 'строка\n'.repeat(40));
    f.setSelectionRange(f.value.length, f.value.length);
    document.execCommand('insertText', false, '\n');
    f.scrollTop = f.scrollHeight;
  });
  await page.waitForFunction(() => {
    const f = document.querySelector('textarea')!;
    return f.scrollTop > 0 && document.querySelector<HTMLElement>('[data-chip-layer]')!.scrollTop === f.scrollTop;
  });
  const off = await box().evaluate((el) => {
    const f = el as HTMLTextAreaElement;
    const s = getComputedStyle(f);
    const line = parseFloat(s.lineHeight);
    const box = f.getBoundingClientRect();
    // The mark is on the line above the last, empty one.
    const markTop = box.top + f.clientHeight - parseFloat(s.paddingBottom) - 2 * line + (f.clientHeight + f.scrollTop - f.scrollHeight);
    return document.querySelector('[data-chip-layer] [data-chip="paste"]')!.getBoundingClientRect().top - markTop;
  });
  assert.ok(Math.abs(off) < 4, `chip off its mark by ${off}px`);

  await page.route(/\/api\/tabs\/[^/]+\/send$/, (r) => r.fulfill({ status: 200, json: { ok: true } }));
  await box().press('Enter');
  await page.waitForFunction(() => !Object.keys(localStorage).some((k) => k.startsWith('claude-os.pastes.')));
  await page.unroute(/\/api\/tabs\/[^/]+\/send$/);
});

test('the right-click paste folds the same way', async () => {
  await copy(LONG);
  await box().click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Вставить' }).click();
  await page.waitForFunction(() => (document.querySelector('textarea') as HTMLTextAreaElement).value.includes('#1'));
  assert.equal(await box().inputValue(), '[Вставка #1 · строк: 60]');
  await box().fill('');
});

test('text with a picture of it beside it is text; a file alone is a file', async () => {
  const paste = (withText: boolean) => page.evaluate((text) => {
    const data = new DataTransfer();
    if (text) data.setData('text/plain', 'из Excel');
    data.items.add(new File([new Uint8Array([1, 2])], 'pic.png', { type: 'image/png' }));
    document.querySelector('textarea')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, withText);
  await box().click();
  await paste(false);
  await page.getByRole('button', { name: /Убрать pic\.png|pic\.png/ }).first().waitFor();
  await page.getByRole('button', { name: /pic\.png/ }).first().click();
  await paste(true);
  await page.waitForTimeout(200);
  assert.equal(await page.getByRole('button', { name: /pic\.png/ }).count(), 0, 'no attachment: the text wins');
});

test('a command from a session: a toast, a notification only when asked, a screen opened', async () => {
  const tab = data.tabs.find((t) => t.kind === 'root')!;
  fx.push({ t: 'ui', tabId: tab.id, command: { action: 'toast', text: 'Строка от Claude' } });
  await page.getByText('Строка от Claude').waitFor();

  // Looking right at this chat: nothing to say. Elsewhere: a toast that leads there.
  fx.push({ t: 'ui', tabId: tab.id, command: { action: 'notify', kind: 'done', text: 'тут и так видно' } });
  await page.waitForTimeout(300);
  assert.equal(await page.getByText('тут и так видно').count(), 0);

  fx.push({ t: 'ui', tabId: tab.id, command: { action: 'open', view: 'projects', project: 'beta-web' } });
  await page.getByRole('heading', { name: 'beta-web' }).waitFor();

  fx.push({ t: 'ui', tabId: tab.id, command: { action: 'notify', kind: 'done', text: 'Всё сделано' } });
  await page.getByText(/Всё сделано/).waitFor();
  await page.getByRole('button', { name: 'Открыть' }).click();
  await box().waitFor();
});

test('the Projects screen: from the menu, a tree, changes that stick, nothing lost on the way back', async () => {
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('menuitem', { name: 'Проекты' }).click();
  const list = page.getByRole('complementary', { name: 'Проекты' });
  await list.getByRole('button', { name: 'alpha-service' }).click();
  await page.getByRole('heading', { name: 'alpha-service' }).waitFor();
  await shot('projects');

  // A description goes in, and renders as Markdown.
  await page.getByRole('button', { name: 'Описание' }).click();
  await page.getByRole('textbox', { name: 'Описание' }).fill('**Главный** сервис');
  await page.getByRole('textbox', { name: 'Описание' }).blur();
  await page.getByRole('button', { name: 'Описание' }).locator('strong').getByText('Главный').waitFor();
  assert.equal(data.projects.find((p) => p.key === 'alpha-service')!.description, '**Главный** сервис');

  // Colour: a swatch, then back to the palette.
  await page.getByRole('group', { name: 'Цвет' }).getByRole('button').first().click();
  await page.getByRole('button', { name: 'Вернуть цвет из палитры' }).waitFor();
  assert.match(data.projects.find((p) => p.key === 'alpha-service')!.color ?? '', /^#[0-9a-f]{6}$/);
  // The row's icon takes it at once, through the same palette the map uses.
  const swatch = await page.getByRole('group', { name: 'Цвет' }).getByRole('button').first().evaluate((b) => getComputedStyle(b).backgroundColor);
  await page.waitForFunction((rgb) => [...document.querySelectorAll<HTMLElement>('aside span[aria-hidden]')].some((s) => getComputedStyle(s).color === rgb), swatch);
  await page.getByRole('button', { name: 'Вернуть цвет из палитры' }).click();
  await page.getByRole('button', { name: 'Вернуть цвет из палитры' }).waitFor({ state: 'detached' });

  // On the map, by hand.
  await page.getByRole('radio', { name: 'Скрыть' }).click();
  await page.waitForFunction(() => document.querySelector('[role="radio"][aria-checked="true"]') !== null);
  assert.equal(data.projects.find((p) => p.key === 'alpha-service')!.mapPin, false);

  // "Only a folder": the map row goes away, the structure stays.
  await page.getByRole('radio', { name: 'Просто папка' }).click();
  await page.getByRole('radio', { name: 'Скрыть' }).waitFor({ state: 'detached' });
  assert.equal(data.projects.find((p) => p.key === 'alpha-service')!.folder, true);

  // A child under it: the list shifts it right.
  await list.getByRole('button', { name: 'beta-web' }).click();
  await page.getByRole('heading', { name: 'beta-web' }).waitFor();
  await page.getByRole('combobox', { name: 'Находится в' }).click();
  await page.getByRole('option', { name: 'alpha-service' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLElement>('aside button')].some((b) => b.textContent?.includes('beta-web') && parseInt(b.style.paddingLeft) > 10));
  assert.equal(data.projects.find((p) => p.key === 'beta-web')!.parent, 'alpha-service');
  await shot('projects-tree');

  await list.getByRole('button', { name: 'alpha-service' }).click();
  await page.getByRole('main').getByRole('button', { name: 'beta-web', exact: true }).waitFor();

  // A request to Claude goes through the usual dialog.
  await page.getByRole('button', { name: 'С Claude' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText(/update_project/).first().waitFor();
  await shot('projects-claude');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });

  // The screen and the chosen project outlive a reload. The first paint brings the map up in software here: it takes a while.
  await page.reload({ timeout: 180_000 });
  await page.getByRole('heading', { name: 'alpha-service' }).waitFor();
});

// Each test below sets the folder state it needs: alpha-service is a plain folder, nothing else is, fresh-folder is not connected.
function onlyAlphaIsFolder() {
  data.projects = data.projects.filter((p) => p.key !== 'fresh-folder');
  for (const p of data.projects) p.folder = p.key === 'alpha-service';
  fx.push({ t: 'invalidate', topics: ['projects'] });
}

test('a plain folder comes after the projects in the new-tab picker', async () => {
  onlyAlphaIsFolder();
  await page.getByRole('button', { name: 'Новая вкладка' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Проект' }).click();
  const names = () => page.getByRole('option').evaluateAll((os) => os.map((o) => o.querySelector('.truncate')?.textContent ?? ''));
  await page.waitForFunction(() => [...document.querySelectorAll('[role=option] .truncate')].at(-1)?.textContent === 'alpha-service');
  const got = await names();
  assert.equal(got.at(-1), 'alpha-service', got.join(', '));
  assert.ok(got.indexOf('beta-web') >= 0 && got.indexOf('beta-web') < got.indexOf('alpha-service'));
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
});

test('the structure of the projects folder: kinds, connect a folder, make a project a folder', async () => {
  onlyAlphaIsFolder();
  await page.getByRole('button', { name: 'Меню' }).first().click(); // the title bar's; a project page has its own
  await page.getByRole('menuitem', { name: 'Проекты' }).click();
  await page.getByRole('button', { name: 'Структура' }).click();
  const tree = page.getByRole('list', { name: 'Структура' });
  const row = (name: string) => tree.getByRole('listitem').filter({ has: page.getByText(name, { exact: true }) });
  await row('src').getByText('Внутри alpha-service').waitFor();
  await row('alpha-service').getByText('Просто папка').waitFor();
  await row('gamma-tools').getByText('Проект', { exact: true }).waitFor();
  await tree.getByRole('listitem').filter({ hasText: '…' }).waitFor();
  await shot('projects-structure');

  await row('fresh-folder').getByRole('button', { name: 'Подключить' }).click();
  await row('fresh-folder').getByRole('button', { name: 'Сделать папкой' }).click();
  await row('fresh-folder').getByText('Просто папка').waitFor();
  assert.equal(data.projects.find((p) => p.key === 'fresh-folder')?.folder, true);
  assert.equal(await row('alpha-service').getByRole('button', { name: 'Сделать папкой' }).count(), 0, 'already a folder');

  // A project in the list leaves the structure for its page.
  await page.getByRole('complementary', { name: 'Проекты' }).getByRole('button', { name: 'gamma-tools' }).click();
  await page.getByRole('heading', { name: 'gamma-tools' }).waitFor();

  // Claude OS itself: no kind switch, the name stays a heading.
  await page.getByRole('complementary', { name: 'Проекты' }).getByRole('button', { name: 'eta-infra' }).click();
  await page.getByRole('heading', { name: 'eta-infra' }).click();
  assert.equal(await page.getByRole('radio', { name: 'Просто папка' }).count(), 0);
  assert.equal(await page.getByRole('textbox', { name: 'Имя проекта' }).count(), 0);
});
