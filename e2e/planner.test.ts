// Planner notes and the project files panel against e2e/fixture-server.ts. Set CLAUDE_OS_WEB_DIST to test another build.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { homeButton, startFixture, type FixtureServer } from './fixture-server.ts';

let browser: Browser;
let ctx: BrowserContext | null = null;
let fx: FixtureServer | null = null;
let errors: string[] = [];

before(async () => {
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
});
after(() => browser.close());
afterEach(async () => {
  assert.deepEqual(errors, []);
  await ctx?.close();
  await fx?.close();
  ctx = null;
  fx = null;
  errors = [];
});

async function open(view: unknown): Promise<Page> {
  fx = await startFixture();
  ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU', reducedMotion: 'reduce' });
  await ctx.addInitScript((v) => {
    if (!localStorage.getItem('claude-os.view')) localStorage.setItem('claude-os.view', v);
  }, JSON.stringify(view));
  ctx.setDefaultTimeout(20000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  return page;
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(cond());
}

async function until2(cond: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.fail('condition not met');
}

const WORK = { kind: 'tab', id: 't2' };
const composer = (page: Page) => page.getByRole('textbox', { name: /beta-web|Сообщение/ }).first();
const openFromMenu = async (page: Page) => {
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Планер' }).click();
};
const panel = (page: Page) => page.getByRole('complementary', { name: 'Планер' });

const noteOf = (p: Locator, title: string) => p.locator('[data-planner-note]').filter({ hasText: title });
const openNote = (note: Locator) => note.getByRole('button', { expanded: false }).click();
const SAVE = { name: 'Записать', exact: true };
const fileField = async (page: Page, p: Locator) => {
  await p.getByRole('button', SAVE).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Разложить с Claude' }).click();
};
const headerMenu = async (page: Page, p: Locator, item: string) => {
  await p.locator('header strong').click({ button: 'right' });
  await page.getByRole('menuitem', { name: item }).click();
};
const noteMenu = async (page: Page, note: Locator, item: string) => {
  await note.locator('button[aria-expanded]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: item }).click();
};

test('planner: a note is saved, goes to the service session and not the root one, listed, and dragged into a chat as a path', async () => {
  const page = await open(WORK);
  await openFromMenu(page);
  const p = panel(page);
  await p.getByText('Обновить брокер').waitFor();

  await p.getByRole('textbox').fill('Купить домен\nдля лендинга');
  await fileField(page, p);
  await p.getByText('у Claude').waitFor();
  const save = fx!.calls.find((c) => c.path === '/api/planner' && c.method === 'POST');
  assert.deepEqual(save?.body, { text: 'Купить домен\nдля лендинга', folder: null });
  assert.ok(fx!.calls.some((c) => c.method === 'POST' && decodeURIComponent(c.path) === '/api/planner/2026-11-05-заметка-1/file'));
  assert.equal(fx!.calls.filter((c) => /\/send$/.test(c.path)).length, 0); // nothing lands in anyone's conversation

  // Only save: no job for Claude. The view stays where it was.
  await p.getByRole('textbox').fill('Без Claude');
  await p.getByRole('button', SAVE).click();
  await p.getByText('Без Claude').waitFor();
  assert.equal(fx!.calls.filter((c) => /\/file$/.test(c.path)).length, 1);

  const box = composer(page);
  await box.fill('смотри');
  const note = p.locator('[data-planner-note="2026-11-01-обновить-брокер-aa11"]');
  await note.dragTo(box);
  assert.equal(await box.inputValue(), 'смотри @/home/test/claude-os/data/planner/projects/alpha-service/очередь/2026-11-01-обновить-брокер-aa11.md ');

  await noteMenu(page, note, 'Вставить путь в чат');
  assert.match(await box.inputValue(), /\.md @\/home\/test\/.*aa11\.md $/);

  // Dragging onto the frame of the composer works too, not only onto the text.
  await box.fill('');
  await note.dragTo(page.getByRole('button', { name: /Отправить/ }).first());
  assert.match(await box.inputValue(), /^@\/home\/test\/.*aa11\.md $/);
});

test('planner: right click asks Claude with the note as context, delete removes it, Ctrl+K finds it', async () => {
  const page = await open(WORK);
  await composer(page).waitFor();
  await page.keyboard.press('Control+k');
  const search = page.getByPlaceholder('Вкладки, проекты, действия, заметки…');
  await search.fill('планер');
  await page.getByRole('option', { name: /Планер: записать заметку/ }).waitFor();
  await search.fill('брокер');
  await page.getByRole('option', { name: /Обновить брокер/ }).click();
  const p = panel(page);
  const body = p.getByRole('textbox', { name: 'Текст заметки' });
  await body.waitFor(); // the found note is open
  assert.equal(await body.inputValue(), 'Обновить брокер\nдо конца месяца');

  await p.getByRole('button', { name: /Обновить брокер/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Вопрос Claude' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('что тут');
  assert.match(await dialog.locator('pre').innerText(), /planner note "Обновить брокер"[\s\S]*aa11\.md[\s\S]*до конца месяца[\s\S]*что тут/);
  await dialog.getByRole('button', { name: 'Отмена' }).click();

  await p.getByRole('button', { name: /Обновить брокер/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Удалить' }).click();
  await p.getByText('Заметок пока нет.').waitFor();
  assert.ok(fx!.calls.some((c) => c.method === 'DELETE' && c.path.startsWith('/api/planner/')));

  await p.getByRole('button', { name: 'Скрыть' }).click();
  await panel(page).waitFor({ state: 'detached' });
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==';
const paste = (box: Locator, base64: string, type: string) =>
  box.evaluate((el, [b64, mime]) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'shot', { type: mime }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, [base64, type]);

test('planner: a wider panel with one action on the surface and no explanations, file paths or edit button', async () => {
  const page = await open(WORK);
  await openFromMenu(page);
  const p = panel(page);
  await p.getByText('Обновить брокер').waitFor();
  assert.equal((await p.boundingBox())!.width, 430); // 312 before
  await noteOf(p, 'Обновить брокер').getByRole('button', { expanded: false }).click();
  const shown = await p.innerText();
  for (const gone of ['Входит в', 'расходуется', 'Перетащите', 'Править текст', 'Ctrl+V', '/home/test', '.md', 'Не разложена']) assert.ok(!shown.includes(gone), gone);
  assert.equal(await p.getByRole('button', { name: 'Вставить путь в чат' }).count(), 0, 'in the right-click menu');
  for (const moved of ['Разложить с Claude', 'Планер в отдельном окне', 'Открепить в плавающее окно']) assert.equal(await p.getByRole('button', { name: moved }).count(), 0, `${moved}: on the right click`);
  const add = p.getByRole('button', { name: 'Новая папка' });
  assert.equal(await add.evaluate((el) => getComputedStyle(el).opacity), '0', 'shows only under the mouse');
  const search = p.getByRole('searchbox', { name: 'Поиск по заметкам' });
  const closed = (await search.locator('..').boundingBox())!.width;
  assert.ok(closed <= 24, `an icon until wanted: ${closed}`);
  await search.fill('брокер');
  await until2(async () => (await search.locator('..').boundingBox())!.width > 100); // it opens with words in it, animated
});

test('planner: long text saved with Записать stays readable, whatever is in it', async () => {
  const page = await open(WORK);
  await openFromMenu(page);
  const p = panel(page);
  const para = 'Длинный абзац, который занимает несколько строк и не должен наезжать на соседний. ';
  const text = [para.repeat(4), '', para.repeat(3), '# заголовок **жирный** `код` | таблица | ---', '---', 'x'.repeat(900), '- не пункт', '* [ ] тоже нет', `- [ ] пункт ${para.repeat(2)}`, `- [ ] ${'y'.repeat(500)}`, para.repeat(5)].join('\n');
  await p.getByRole('textbox').fill(text);
  await p.getByRole('button', SAVE).click();
  await until(() => fx!.calls.some((c) => c.path === '/api/planner' && c.method === 'POST'));
  assert.deepEqual(fx!.calls.find((c) => c.path === '/api/planner' && c.method === 'POST')?.body, { text, folder: null });
  const note = p.locator('[data-planner-note="2026-11-05-заметка-1"]');
  await openNote(note);
  const rows = await note.evaluate((el) => [...el.querySelectorAll('textarea')].slice(1).map((f) => {
    const r = f.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, height: f.clientHeight, full: f.scrollHeight, wide: f.scrollWidth, width: f.clientWidth };
  }));
  assert.ok(rows.length >= 3);
  const area = (await note.boundingBox())!;
  rows.forEach((r, i) => {
    assert.ok(r.full <= r.height + 1, `field ${i} shows all its lines: ${r.full} of ${r.height}`);
    assert.ok(r.wide <= r.width + 1, `field ${i} does not run sideways`);
    assert.ok(r.right <= area.x + area.width + 1, `field ${i} stays in the row`);
    if (i > 0) assert.ok(r.top >= rows[i - 1].bottom - 1, `field ${i} starts below the one before`);
  });
  const headRow = await note.getByRole('textbox', { name: 'Название заметки' }).boundingBox();
  assert.ok(headRow!.x + headRow!.width <= area.x + area.width);
});

test('planner: Enter is a new line in the field, Ctrl+Enter saves without Claude', async () => {
  const page = await open(WORK);
  await openFromMenu(page);
  const p = panel(page);
  const box = p.getByRole('textbox').first();
  await box.fill('строка');
  await box.press('Enter');
  await box.pressSequentially('вторая');
  assert.equal(await box.inputValue(), 'строка\nвторая');
  assert.equal(fx!.calls.filter((c) => c.path === '/api/planner' && c.method === 'POST').length, 0);
  await box.press('Control+Enter');
  await noteOf(p, 'строка').waitFor();
  assert.deepEqual(fx!.calls.find((c) => c.path === '/api/planner' && c.method === 'POST')?.body, { text: 'строка\nвторая', folder: null });
  assert.equal(await box.inputValue(), '');
  assert.equal(fx!.calls.filter((c) => /\/file$/.test(c.path)).length, 0);
});

test('planner: items are checked, struck through, edited and deleted right in the note, and the tag tells how to mark them', async () => {
  const page = await open(WORK);
  await openFromMenu(page);
  const p = panel(page);
  const box = p.getByRole('textbox').first();
  await box.fill('- [ ] Купить домен');
  await box.press('Enter');
  await box.pressSequentially('Настроить DNS');
  await box.press('Enter');
  await box.pressSequentially('Третий');
  await box.press('Enter');
  assert.equal(await box.inputValue(), '- [ ] Купить домен\n- [ ] Настроить DNS\n- [ ] Третий\n- [ ] ');
  await box.press('Enter'); // an empty item ends the list, nothing is saved
  assert.equal(await box.inputValue(), '- [ ] Купить домен\n- [ ] Настроить DNS\n- [ ] Третий\n');
  assert.equal(fx!.calls.filter((c) => c.path === '/api/planner').length, 0);

  await p.getByRole('button', SAVE).click();
  const note = noteOf(p, 'Купить домен');
  await note.getByText('0/3').waitFor();
  await openNote(note);
  const row = (name: string) => note.locator(`[data-planner-item="${name}"]`);
  const saved = () => (fx!.calls.filter((c) => c.method === 'PUT').at(-1)?.body as { text: string } | undefined)?.text;

  await row('Настроить DNS').getByRole('checkbox').check({ force: true });
  await note.getByText('1/3').waitFor();
  await until(() => saved() === '- [ ] Купить домен\n- [x] Настроить DNS\n- [ ] Третий');
  assert.match(await row('Настроить DNS').getByRole('textbox').evaluate((el) => getComputedStyle(el).textDecorationLine), /line-through/);
  assert.doesNotMatch(await row('Купить домен').getByRole('textbox').evaluate((el) => getComputedStyle(el).textDecorationLine), /line-through/);

  // Two deletions in a row, the second before the first one is known to be saved.
  await row('Купить домен').hover();
  await row('Купить домен').getByRole('button', { name: /Удалить пункт/ }).click();
  await row('Третий').hover();
  await row('Третий').getByRole('button', { name: /Удалить пункт/ }).click();
  await note.getByText('1/1').waitFor();
  await until(() => saved() === '- [x] Настроить DNS');

  // In the words of the item itself: Enter starts the next one, Backspace on an empty one takes it away.
  const item = row('Настроить DNS').getByRole('textbox');
  await item.click();
  await item.press('End');
  await page.keyboard.type(' срочно');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Новый');
  await note.getByText('1/2').waitFor();
  await until(() => saved() === '- [x] Настроить DNS срочно\n- [ ] Новый');
  assert.equal(await row('Новый').getByRole('textbox').evaluate((el) => el === document.activeElement), true);
  for (let i = 0; i < 5; i++) await page.keyboard.press('Backspace');
  await page.keyboard.press('Backspace');
  await note.getByText('1/1').waitFor();

  const chat = composer(page);
  await chat.fill('');
  await noteMenu(page, note, 'Вставить путь в чат');
  assert.match(await chat.inputValue(), /^@\/home\/test\/\S+\.md \(пункты этой заметки .*check_planner_item.*remove_planner_item, id 2026-11-05-заметка-1\) $/);
});

test('planner: a line that becomes an item keeps the caret', async () => {
  const page = await open(WORK);
  await openFromMenu(page);
  const p = panel(page);
  const note = noteOf(p, 'Обновить брокер');
  await openNote(note);
  const body = note.getByRole('textbox', { name: 'Текст заметки' });
  await body.click();
  await body.press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('- [ ] пункт');
  const item = note.locator('[data-planner-item="пункт"]').getByRole('textbox');
  await item.waitFor();
  assert.equal(await item.evaluate((el) => el === document.activeElement), true);
  await page.keyboard.type(' дальше');
  assert.equal(await note.locator('[data-planner-item="пункт дальше"]').getByRole('textbox').inputValue(), 'пункт дальше');
});

test('planner: a refused save stays on screen and says why', async () => {
  const page = await open(WORK);
  await openFromMenu(page);
  const p = panel(page);
  await p.getByRole('textbox').first().fill('- [ ] Пункт');
  await p.getByRole('button', SAVE).click();
  const note = noteOf(p, 'Пункт');
  await openNote(note);
  fx!.failures.set(/\/api\/planner\/[^/]+$/, [500, { error: 'диск заполнен' }]);
  await note.getByRole('checkbox').check({ force: true });
  await page.getByText('диск заполнен').waitFor();
  assert.equal(await note.getByRole('checkbox').isChecked(), true); // not lost: the next edit sends it again
});

test('planner: a pasted image goes in as a path, shows as a picture, opens large, saved as a line of the note', async () => {
  const page = await open(WORK);
  await page.route('**/api/planner/images/*', (route) => (route.request().method() === 'GET' ? route.fulfill({ contentType: 'image/png', body: Buffer.from(PNG, 'base64') }) : route.fallback()));
  await openFromMenu(page);
  const p = panel(page);
  await p.getByText('Обновить брокер').waitFor();
  const box = p.getByRole('textbox').first();
  await box.fill('Кнопка съехала');

  await paste(box, btoa('plain'), 'text/plain');
  await page.getByText('Вставить можно только картинку').waitFor();
  assert.equal(fx!.calls.filter((c) => c.path === '/api/planner/images').length, 0);

  await paste(box, PNG, 'image/png');
  await p.getByRole('button', { name: 'Открыть в полный размер' }).waitFor();
  assert.equal(await box.inputValue(), 'Кнопка съехала'); // the field keeps the words, the picture shows under them
  const upload = fx!.calls.find((c) => c.path === '/api/planner/images')!.body as { base64: string; mediaType: string };
  assert.equal(upload.base64, PNG);
  assert.equal(upload.mediaType, 'image/png');

  // A second one can be taken back out.
  await paste(box, PNG, 'image/png');
  await p.getByRole('button', { name: 'Открыть в полный размер' }).nth(1).waitFor();
  const path = (await p.getByRole('button', { name: 'Открыть в полный размер' }).first().locator('..').locator('img').getAttribute('src'))!.replace('/api/planner/images/', '/home/test/claude-os/data/planner/images/');
  await p.getByRole('button', { name: 'Открыть в полный размер' }).nth(1).hover();
  await p.getByRole('button', { name: 'Убрать картинку' }).nth(1).click();
  assert.equal(await p.getByRole('button', { name: 'Открыть в полный размер' }).count(), 1);
  await fileField(page, p);
  await until(() => fx!.calls.some((c) => /\/file$/.test(c.path)));
  assert.deepEqual(fx!.calls.find((c) => c.path === '/api/planner')?.body, { text: `Кнопка съехала\n${path}`, folder: null });
  assert.equal(await p.getByRole('button', { name: 'Открыть в полный размер' }).count(), 0);

  const note = noteOf(p, 'Кнопка съехала');
  await openNote(note);
  const thumb = note.getByRole('button', { name: 'Открыть в полный размер' });
  await thumb.waitFor();
  assert.equal(await note.getByRole('textbox', { name: 'Текст заметки' }).first().inputValue(), 'Кнопка съехала'); // the picture, not its path
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[data-planner-note] img')].every((i) => i.naturalWidth > 0));
  await thumb.click();
  await page.getByRole('dialog', { name: path }).getByRole('img').waitFor();
  await page.keyboard.press('Escape');
});

const act = (id: string, what: string, body: unknown) => fetch(`${fx!.url}/api/planner/${encodeURIComponent(id)}/${what}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const changed = () => fx!.push({ t: 'invalidate', topics: ['planner'] });
const editor = (p: Locator) => p.getByRole('textbox', { name: 'Текст заметки' });

test('planner: the list is newest first, filing adds the topic in place, search narrows it, also by folder', async () => {
  const page = await open(WORK);
  await openFromMenu(page);
  const p = panel(page);
  await noteOf(p, 'Обновить брокер').waitFor();

  await p.getByRole('textbox').fill('Купить домен');
  await p.getByRole('button', SAVE).click();
  const fresh = noteOf(p, 'Купить домен');
  await fresh.waitFor(); // in the list at once, before Claude
  assert.equal(await p.locator('[data-planner-note]').first().getAttribute('data-planner-note'), '2026-11-05-заметка-1');

  await noteMenu(page, fresh, 'Разложить с Claude');
  await fresh.getByText('у Claude').waitFor();
  await act('2026-11-05-заметка-1', 'test-filed', { topic: 'лендинг' });
  changed();
  await fresh.getByText('лендинг').waitFor();
  assert.equal(await fresh.getByText('у Claude').count(), 0);

  const search = p.getByRole('searchbox', { name: 'Поиск по заметкам' });
  await search.fill('брокер');
  await until2(async () => (await p.locator('[data-planner-note]').count()) === 1);
  await search.fill('лендинг');
  await noteOf(p, 'Купить домен').waitFor();
  await search.fill('');
  await p.getByRole('button', { name: 'Новая папка' }).click();
  await p.getByRole('group', { name: 'Папки' }).getByRole('textbox').fill('Инфра');
  await p.getByRole('group', { name: 'Папки' }).getByRole('textbox').press('Enter');
  await p.getByRole('group', { name: 'Папки' }).getByRole('button', { name: 'Инфра' }).waitFor();
  await noteMenu(page, noteOf(p, 'Обновить брокер'), 'В папку «Инфра»');
  await noteOf(p, 'Обновить брокер').locator('[data-planner-folder="Инфра"]').waitFor();
  await search.fill('инфра'); // the folder's name finds its notes
  await until2(async () => (await noteOf(p, 'Купить домен').count()) === 0);
  await noteOf(p, 'Обновить брокер').waitFor();
  await search.fill('нет такого');
  await p.getByText('Ничего не нашлось.').waitFor();
});

test('planner: a note is edited where it is and saves itself; filing while typing loses nothing', async () => {
  const page = await open(WORK);
  await openFromMenu(page);
  const p = panel(page);
  await p.getByRole('textbox').first().fill('Черновик заметки');
  await p.getByRole('button', SAVE).click();
  const note = noteOf(p, 'Черновик заметки');
  await openNote(note);
  assert.equal(await note.getByRole('button', { name: /Править|Сохранить/ }).count(), 0);
  await editor(note).click();
  await editor(note).press('Control+End');
  await page.keyboard.press('Enter');
  await page.keyboard.type('ещё строка');
  await until(() => fx!.calls.some((c) => c.method === 'PUT' && (c.body as { text: string }).text === 'Черновик заметки\nещё строка'));

  await act('2026-11-05-заметка-1', 'test-filed', { topic: 'лендинг' });
  changed();
  await note.getByText('лендинг').waitFor();
  assert.equal(await editor(note).inputValue(), 'Черновик заметки\nещё строка');
  assert.equal(await editor(note).evaluate((el) => el === document.activeElement), true); // the same element, typing goes on
  await page.keyboard.type(' и ещё');
  await until(() => fx!.calls.some((c) => c.method === 'PUT' && (c.body as { text: string }).text === 'Черновик заметки\nещё строка и ещё'));

  // Each save names the version the last one returned: no conflict with itself.
  await p.getByRole('textbox').first().click();
  await until2(async () => !(await page.getByText('Файл изменился на диске').count()));
  assert.equal(await editor(note).inputValue(), 'Черновик заметки\nещё строка и ещё');
});

test('planner: an edit cleared to nothing is not saved, and the text comes back', async () => {
  const page = await open(WORK);
  await openFromMenu(page);
  const p = panel(page);
  const note = noteOf(p, 'Обновить брокер');
  await openNote(note);
  await editor(note).fill('');
  await p.getByRole('textbox').first().click();
  await until2(async () => (await editor(note).inputValue()) === 'Обновить брокер\nдо конца месяца');
  assert.equal(fx!.calls.filter((c) => c.method === 'PUT').length, 0);
});

test('planner: a text changed elsewhere meets an edit calmly, with a choice', async () => {
  const page = await open(WORK);
  await openFromMenu(page);
  const p = panel(page);
  const note = noteOf(p, 'Обновить брокер');
  const id = '2026-11-01-обновить-брокер-aa11';
  await openNote(note);
  await act(id, 'test-changed', { text: 'версия сессии' });
  await editor(note).fill('моя версия'); // the list has not heard of the change yet
  await note.getByRole('status').getByText('Файл изменился на диске').waitFor();
  assert.equal(await editor(note).inputValue(), 'моя версия'); // nothing is lost by the refusal

  await note.getByRole('button', { name: 'Взять версию с диска' }).click();
  changed();
  await until2(async () => (await editor(note).inputValue()) === 'версия сессии');

  await act(id, 'test-changed', { text: 'опять сессия' });
  await editor(note).fill('снова моя');
  await note.getByRole('button', { name: 'Перезаписать моей версией' }).click();
  await until(() => fx!.calls.some((c) => c.method === 'PUT' && (c.body as { text: string }).text === 'снова моя' && true));
  await note.getByRole('status').waitFor({ state: 'detached' });
  assert.equal(await editor(note).inputValue(), 'снова моя');
});

test('planner: the title is edited in place and stays on the row', async () => {
  const page = await open(WORK);
  await openFromMenu(page);
  const p = panel(page);
  const note = p.locator('[data-planner-note="2026-11-01-обновить-брокер-aa11"]');
  await openNote(note);
  const title = note.getByRole('textbox', { name: 'Название заметки' });
  await title.fill('Брокер: апгрейд');
  await title.press('Enter');
  await until(() => fx!.calls.some((c) => c.method === 'PATCH' && (c.body as { title: string }).title === 'Брокер: апгрейд'));
  assert.equal(await title.evaluate((el) => el === document.activeElement), false);
  await note.locator('button[aria-expanded]').click();
  await note.getByText('Брокер: апгрейд').waitFor();
  await openNote(note);

  // Escape and an empty name leave it as it was.
  const calls = fx!.calls.filter((c) => c.method === 'PATCH').length;
  await title.fill('Отмена');
  await title.press('Escape');
  await title.fill(' ');
  await p.getByRole('textbox').first().click();
  await until2(async () => (await title.inputValue()) === 'Брокер: апгрейд');
  assert.equal(fx!.calls.filter((c) => c.method === 'PATCH').length, calls);
});

test('planner: folders are made, renamed and deleted by hand; a note moves by drag or menu; deleting keeps the notes', async () => {
  const page = await open(WORK);
  await openFromMenu(page);
  const p = panel(page);
  await p.getByRole('textbox').first().fill('Вторая заметка');
  await p.getByRole('button', SAVE).click();
  await noteOf(p, 'Вторая заметка').waitFor();
  const folders = p.getByRole('group', { name: 'Папки' });
  const make = async (name: string) => {
    await folders.getByRole('button', { name: 'Новая папка' }).click();
    await folders.getByRole('textbox').fill(name);
    await folders.getByRole('textbox').press('Enter');
    await folders.getByRole('button', { name }).waitFor();
  };
  await make('Работа');
  await make('Дом');

  // A colour from the folder's right click: the dot and the note's line take it, the menu is gone first.
  await folders.getByRole('button', { name: 'Дом' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Цвет папки' }).click();
  const colours = page.getByRole('group', { name: 'Цвет папки' });
  assert.equal(await colours.getByRole('button', { name: /^Цвет \d$/ }).count(), 8, 'the palette');
  assert.equal(await colours.getByRole('button', { name: 'Свой цвет' }).count(), 1, 'and any colour');
  await colours.getByRole('button', { name: 'Цвет 3' }).click();
  await colours.waitFor({ state: 'detached' });
  await until2(async () => (await folders.getByRole('button', { name: 'Дом' }).locator('[data-folder-dot]').evaluate((el) => getComputedStyle(el).backgroundColor)) === 'rgb(163, 181, 101)');
  assert.ok(fx!.calls.some((c) => c.method === 'PATCH' && (c.body as { color?: string }).color === '#a3b565'));

  // Any colour from the chip's dot, which does not open the folder: a hex typed and left by a click outside is kept.
  const work = folders.getByRole('button', { name: 'Работа' });
  const dot = work.locator('[data-folder-dot]');
  await dot.click();
  assert.equal(await work.getAttribute('aria-pressed'), 'false');
  await colours.getByRole('button', { name: 'Свой цвет' }).click();
  const hex = colours.getByRole('textbox', { name: 'Цвет в hex' });
  assert.equal(await hex.inputValue(), '#5fa8d3');
  await hex.fill('#123456');
  await p.locator('header strong').click();
  await colours.waitFor({ state: 'detached' });
  await until2(async () => (await dot.evaluate((el) => getComputedStyle(el).backgroundColor)) === 'rgb(18, 52, 86)');

  // Escape drops what was typed.
  await work.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Цвет папки' }).click();
  await colours.getByRole('button', { name: 'Свой цвет' }).click();
  await hex.fill('#654321');
  await page.keyboard.press('Escape');
  await colours.waitFor({ state: 'detached' });
  assert.ok(!fx!.calls.some((c) => c.method === 'PATCH' && (c.body as { color?: string }).color === '#654321'));

  // The hue slider: the popover stays while picking.
  await dot.click();
  await colours.getByRole('button', { name: 'Свой цвет' }).click();
  const hue = colours.getByRole('slider', { name: 'Оттенок' });
  const bar = (await hue.boundingBox())!;
  await page.mouse.click(bar.x + 2, bar.y + bar.height / 2); // red
  await until(() => fx!.calls.some((c) => c.method === 'PATCH' && /^#561[0-9a-f]12$/.test((c.body as { color?: string }).color ?? '')));
  assert.notEqual(await hex.inputValue(), '#123456');
  await page.keyboard.press('Escape');
  await colours.waitFor({ state: 'detached' });

  // By drag: the note goes in, and the same drag still carries the path for a chat.
  const broker = p.locator('[data-planner-note="2026-11-01-обновить-брокер-aa11"]');
  await broker.dragTo(folders.getByRole('button', { name: 'Работа' }));
  await folders.getByRole('button', { name: 'Работа 1' }).waitFor();

  // By the menu.
  const second = noteOf(p, 'Вторая заметка');
  await noteMenu(page, second, 'В папку «Дом»');
  await folders.getByRole('button', { name: 'Дом 1' }).waitFor();
  assert.equal(await second.locator('[data-planner-folder="Дом"]').evaluate((el) => getComputedStyle(el).color), 'rgb(163, 181, 101)');

  await folders.getByRole('button', { name: /Работа/ }).click();
  await noteOf(p, 'Обновить брокер').waitFor();
  await until2(async () => (await noteOf(p, 'Вторая заметка').count()) === 0);
  await folders.getByRole('button', { name: 'Все' }).click();
  assert.equal(await p.locator('[data-planner-note]').count(), 2);

  await folders.getByRole('button', { name: /Работа/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Переименовать папку' }).click();
  await folders.getByRole('textbox').fill('Проекты');
  await folders.getByRole('textbox').press('Enter');
  await folders.getByRole('button', { name: 'Проекты 1' }).waitFor();

  await noteMenu(page, broker, 'Убрать из папки');
  await folders.getByRole('button', { name: 'Проекты', exact: true }).waitFor();
  await noteMenu(page, broker, 'В папку «Проекты»');
  await folders.getByRole('button', { name: 'Проекты 1' }).waitFor();

  await folders.getByRole('button', { name: /Проекты/ }).click();
  await folders.getByRole('button', { name: /Проекты/ }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Удалить папку' }).click();
  await until2(async () => (await folders.getByRole('button', { name: /Проекты/ }).count()) === 0);
  assert.equal(await p.locator('[data-planner-note]').count(), 2, 'back to all, nothing lost');
  assert.equal(await folders.getByRole('button', { name: 'Все' }).getAttribute('aria-pressed'), 'true');
});

test('planner: a note written in an open folder lands in it; folders are reordered by drag and by the menu, and it stays', async () => {
  const page = await open(WORK);
  await openFromMenu(page);
  const p = panel(page);
  await p.getByText('Обновить брокер').waitFor();
  const folders = p.getByRole('group', { name: 'Папки' });
  for (const name of ['А', 'Б', 'В']) {
    await folders.getByRole('button', { name: 'Новая папка' }).click();
    await folders.getByRole('textbox').fill(name);
    await folders.getByRole('textbox').press('Enter');
    await folders.getByRole('button', { name, exact: true }).waitFor();
  }
  // By the label, not the title: a hovered chip lends its title to the tooltip.
  const order = () => folders.locator('button[aria-pressed]').evaluateAll((els) => els.map((el) => [...el.querySelectorAll('span')].find((s) => !s.hasAttribute('data-folder-dot'))?.textContent));

  await folders.getByRole('button', { name: 'Б', exact: true }).click();
  await p.getByRole('textbox').first().fill('В папку Б');
  await p.getByRole('button', SAVE).click();
  await noteOf(p, 'В папку Б').waitFor();
  const posted = fx!.calls.filter((c) => c.path === '/api/planner' && c.method === 'POST').at(-1)!.body as { folder: string };
  assert.match(posted.folder, /^f\d+$/);
  await folders.getByRole('button', { name: 'Б 1' }).waitFor();
  await folders.getByRole('button', { name: 'Все' }).click();

  // By drag: В onto the left half of А goes before it, with a line where it will land.
  const a = folders.getByRole('button', { name: 'А', exact: true });
  await folders.getByRole('button', { name: 'В', exact: true }).dragTo(a, { targetPosition: { x: 2, y: 5 } });
  await until2(async () => (await order()).join() === 'Все,В,А,Б');
  assert.deepEqual((fx!.calls.filter((c) => c.path === '/api/planner/folders/order').at(-1)!.body as { ids: string[] }).ids.length, 3);
  assert.equal(await folders.locator('[data-folder-insert]').count(), 0, 'the line is gone after the drop');

  // A note dragged onto a chip still goes into the folder, not along the bar.
  await p.locator('[data-planner-note="2026-11-01-обновить-брокер-aa11"]').dragTo(a);
  await folders.getByRole('button', { name: 'А 1' }).waitFor();
  assert.equal((await order()).join(), 'Все,В,А,Б');

  // From the keyboard: the chip's menu.
  await folders.getByRole('button', { name: 'В', exact: true }).click({ button: 'right' });
  assert.equal(await page.getByRole('menuitem', { name: 'Сдвинуть влево' }).count(), 0, 'the first one cannot go left');
  await page.getByRole('menuitem', { name: 'Сдвинуть вправо' }).click();
  await until2(async () => (await order()).join() === 'Все,А,В,Б');

  // A colour picked from the dot stays too.
  const dotOf = (name: string) => folders.getByRole('button', { name, exact: true }).locator('[data-folder-dot]');
  await dotOf('В').click();
  const colours = page.getByRole('group', { name: 'Цвет папки' });
  await colours.getByRole('button', { name: 'Свой цвет' }).click();
  await colours.getByRole('textbox', { name: 'Цвет в hex' }).fill('#123456');
  await colours.getByRole('textbox', { name: 'Цвет в hex' }).press('Enter');
  await until(() => fx!.calls.some((c) => c.method === 'PATCH' && (c.body as { color?: string }).color === '#123456'));
  await page.keyboard.press('Escape');

  await page.reload();
  await openFromMenu(page);
  await panel(page).getByText('Обновить брокер').waitFor();
  assert.equal((await order()).join(), 'Все,А,В,Б');
  assert.equal(await dotOf('В').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(18, 52, 86)');
});

test('tooltips: long text wraps inside a width, unbroken strings too, on the screen wherever the element stands', async () => {
  const page = await open(WORK);
  await composer(page).waitFor();
  const word = `/home/test/${'очень-длинный-путь/'.repeat(40)}файл.md`;
  const prose = 'Обычный длинный текст подсказки, который раньше шёл одной строкой дальше края. '.repeat(6);
  for (const [text, left] of [[word, 1540], [prose, 1540], [word, 0], [`${word}\n${prose}`, 700]] as const) {
    await page.evaluate(([title, x]) => {
      document.getElementById('tip-target')?.remove();
      const el = document.createElement('div');
      el.id = 'tip-target';
      el.title = title;
      el.style.cssText = `position:fixed;left:${x}px;top:500px;width:40px;height:40px;z-index:99999`;
      document.body.append(el);
    }, [text, left] as const);
    await page.mouse.move(800, 300);
    await page.locator('#tip-target').hover();
    const tip = page.getByRole('tooltip');
    await tip.waitFor();
    const r = await tip.evaluate((el) => {
      const b = el.getBoundingClientRect();
      return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, full: el.scrollWidth, shown: el.clientWidth };
    });
    assert.ok(r.width <= 420 && r.width > 100, `wide ${r.width}`);
    assert.ok(r.full <= r.shown, 'no text past the edge');
    assert.ok(r.left >= 8 && r.right <= 1592 && r.top >= 0 && r.bottom <= 1000, JSON.stringify(r));
    await page.mouse.move(800, 300);
    await tip.waitFor({ state: 'detached' });
  }
});

test('planner: pops out as a floating window and back, with nothing typed lost, and remembers where it stood', async () => {
  const page = await open(WORK);
  await openFromMenu(page);
  const p = panel(page);
  await p.getByRole('textbox').first().fill('новая мысль');
  const note = noteOf(p, 'Обновить брокер');
  await openNote(note);
  await editor(note).fill('правка');
  const docked = (await p.boundingBox())!;

  await headerMenu(page, p, 'Открепить в плавающее окно');
  await p.getByRole('button', { name: 'Свернуть планер' }).waitFor();
  const floated = (await p.boundingBox())!;
  assert.equal(floated.width, 620); // 460 before
  assert.equal(await p.getByRole('textbox').first().inputValue(), 'новая мысль');
  assert.equal(await editor(note).inputValue(), 'правка');

  const head = p.locator('header strong');
  const from = (await head.boundingBox())!;
  await page.mouse.move(from.x + 5, from.y + 5);
  await page.mouse.down();
  await page.mouse.move(from.x - 195, from.y + 45, { steps: 5 });
  await page.mouse.up();
  const moved = (await p.boundingBox())!;
  assert.ok(Math.abs(moved.x - (floated.x - 200)) < 2, `${moved.x} vs ${floated.x}`);

  await p.getByRole('button', { name: 'Свернуть планер' }).click();
  assert.ok((await p.boundingBox())!.height < 60);
  assert.equal(await p.getByRole('textbox').first().isVisible(), false);
  await p.getByRole('button', { name: 'Развернуть планер' }).click();
  assert.equal(await editor(note).inputValue(), 'правка');

  // Closing the panel sends what was typed, and the window comes back where it was.
  await p.getByRole('button', { name: 'Скрыть' }).click();
  await p.waitFor({ state: 'detached' });
  await until(() => fx!.calls.some((c) => c.method === 'PUT' && (c.body as { text: string }).text === 'правка'));
  await openFromMenu(page);
  await openNote(note);
  assert.equal(await editor(note).inputValue(), 'правка');
  assert.ok(Math.abs((await p.boundingBox())!.x - moved.x) < 2);

  await headerMenu(page, p, 'Вернуть на край');
  const back = (await p.boundingBox())!;
  assert.equal(back.width, docked.width);
  assert.equal(back.x, docked.x);
});

test('recovery: a cut-off turn, waiting messages and a terminal session wait for a decision', async () => {
  const page = await open(WORK);
  await composer(page).waitFor();
  const list = page.getByRole('complementary', { name: 'Было прервано перезапуском' });
  assert.equal(await list.count(), 0);
  const at = Date.now() - 60_000;
  await fetch(`${fx!.url}/api/recovery/test-set`, { method: 'POST', body: JSON.stringify([
    { kind: 'tab', tabId: 't2', tabKind: 'work', title: 'Прерванная', project: 'alpha-service', sessionId: 's1', interruptedAt: at, queued: [{ id: 'q1', text: 'письмо из очереди', attachments: 1 }, { id: 'q2', text: 'лишнее', attachments: 0 }] },
    { kind: 'session', sessionId: 'term1', title: 'Сессия из терминала', project: 'beta-web', cwd: '/home/test/projects/beta-web', lastActivity: at },
  ]), headers: { 'content-type': 'application/json' } });
  fx!.push({ t: 'invalidate', topics: ['tabs'] });
  await list.getByText('Было прервано · 2').waitFor();

  const tab = list.locator('[data-recovery="t2"]');
  await tab.getByText('письмо из очереди').waitFor();
  assert.equal(fx!.calls.filter((c) => /\/send$/.test(c.path)).length, 0); // nothing goes out by itself

  await tab.getByRole('button', { name: 'Убрать сообщение' }).nth(1).click();
  await tab.getByText('лишнее').waitFor({ state: 'detached' });
  await tab.getByRole('button', { name: 'Отправить' }).click();
  await tab.getByText('письмо из очереди').waitFor({ state: 'detached' });
  assert.ok(fx!.calls.some((c) => c.path === '/api/recovery/tabs/t2/queue/q1/send'));

  await tab.getByRole('button', { name: 'Продолжить' }).click();
  await until(() => fx!.calls.some((c) => c.path === '/api/tabs/t2/send'));
  assert.match((fx!.calls.find((c) => c.path === '/api/tabs/t2/send')!.body as { text: string }).text, /Перезапуск оборвал/);
  await tab.getByRole('button', { name: 'Закрыть' }).click();
  await tab.waitFor({ state: 'detached' });

  const term = list.locator('[data-recovery="term1"]');
  await term.getByText('из терминала', { exact: true }).waitFor();
  await term.getByRole('button', { name: 'Продолжить' }).click();
  await until(() => fx!.calls.some((c) => c.path === '/api/tabs' && c.method === 'POST'));
  assert.equal((fx!.calls.find((c) => c.path === '/api/tabs' && c.method === 'POST')!.body as { resumeSessionId: string }).resumeSessionId, 'term1');
});

test('project files: tree, code view, honest large and binary files, tagging, remembered collapse', async () => {
  const page = await open(WORK);
  const tree = page.getByRole('navigation', { name: 'Файлы проекта' });
  await tree.getByRole('button', { name: 'README.md' }).waitFor();

  await tree.getByRole('button', { name: 'src', exact: true }).click();
  await tree.getByRole('button', { name: 'config.ts' }).click();
  const code = page.getByRole('region', { name: 'Файл src/config.ts' });
  await code.getByText('export const b = 2;').waitFor();
  assert.equal(await page.getByTestId('file-code').innerText(), 'export const a = 1;\nexport const b = 2;\n');
  assert.equal(await code.getByRole('textbox').count(), 0); // read-only

  const box = composer(page);
  await code.getByRole('button', { name: 'Тегнуть в чат' }).click();
  assert.equal(await box.inputValue(), '@src/config.ts ');

  await tree.locator('[data-file-row="README.md"]').dragTo(box);
  assert.equal(await box.inputValue(), '@src/config.ts @README.md ');
  await page.getByRole('button', { name: /Отправить/ }).first().click(); // what was inserted is what goes out
  await until(() => fx!.calls.some((c) => c.path.endsWith('/send') && (c.body as { text: string }).text === '@src/config.ts @README.md'));
  assert.equal(await box.inputValue(), '');
  await tree.locator('[data-file-row="my notes.md"]').dragTo(box);
  assert.equal(await box.inputValue(), '@"my notes.md" ');
  // Deleting a tag by hand really empties the input: the state follows the box.
  await box.press('Control+a');
  await box.press('Delete');
  assert.equal(await page.getByRole('button', { name: /Отправить/ }).first().isDisabled(), true);

  await tree.getByRole('button', { name: 'logo.png' }).click();
  await page.getByRole('region', { name: 'Файл logo.png' }).getByText('Двоичный файл, 2.0 KB').waitFor();
  await tree.getByRole('button', { name: 'dump.sql' }).click();
  await page.getByRole('region', { name: 'Файл dump.sql' }).getByText('Большой файл, 5.0 MB: показан только первый мегабайт.').waitFor();

  await tree.locator('[data-file-row="README.md"]').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Вопрос Claude' }).waitFor();
  await page.keyboard.press('Escape');

  await tree.getByRole('button', { name: 'Скрыть файлы проекта' }).click();
  await page.getByRole('button', { name: 'Показать файлы проекта' }).waitFor();
  assert.equal(await tree.count(), 0);
  await page.reload();
  await page.getByRole('button', { name: 'Показать файлы проекта' }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: 'Файлы проекта' }).count(), 0);
  await page.getByRole('button', { name: 'Показать файлы проекта' }).click();
  await page.getByRole('navigation', { name: 'Файлы проекта' }).getByRole('button', { name: 'README.md' }).waitFor();
});

test('project files: no panel on home', async () => {
  const page = await open({ kind: 'home' });
  await homeButton(page).waitFor();
  assert.equal(await page.getByRole('navigation', { name: 'Файлы проекта' }).count(), 0);
});
