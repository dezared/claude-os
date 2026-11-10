// The input's line break, the sessions-to-tab path, effort and model selects, focus mode and off-chat commands, against e2e/fixture-server.ts. No tokens.
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { OFF_CHAT } from '../shared/commands.ts';
import { defaultFixture, homeButton, startFixture, type Fixture, type FixtureServer } from './fixture-server.ts';

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

async function open(view: unknown, data: Fixture = defaultFixture(), width = 1600): Promise<Page> {
  fx = await startFixture(data);
  ctx = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'ru-RU', reducedMotion: 'reduce' });
  await ctx.addInitScript((v) => { if (!sessionStorage.getItem('seeded')) { sessionStorage.setItem('seeded', '1'); localStorage.setItem('claude-os.view', v); } }, JSON.stringify(view));
  ctx.setDefaultTimeout(20000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  return page;
}

const sends = () => fx!.calls.filter((c) => c.path.endsWith('/send'));
const composer = (page: Page) => page.getByRole('textbox', { name: /Сообщение|alpha-service|beta-web/ }).first();

test('Ctrl+Enter breaks the line through the field: what is deleted by hand stays deleted', async () => {
  const page = await open({ kind: 'tab', id: 't2' });
  const box = composer(page);
  await box.click();
  await page.keyboard.type('ab');
  await page.keyboard.press('Control+Enter');
  await page.keyboard.type('cd');
  assert.equal(await box.inputValue(), 'ab\ncd');
  await page.keyboard.press('Alt+Enter');
  assert.equal(await box.inputValue(), 'ab\ncd\n');
  await page.keyboard.press('Backspace');
  assert.equal(await box.inputValue(), 'ab\ncd');
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Backspace');
  // The next render compares its state with the field: a stale state puts the old text back.
  await page.locator('label:visible:has(input[type="file"]) input').setInputFiles({ name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('x') });
  await page.getByText('a.txt').waitFor();
  assert.equal(await box.inputValue(), '');

  await page.keyboard.type('x');
  await page.keyboard.press('Control+Enter');
  await page.keyboard.press('Backspace');
  await page.getByRole('button', { name: 'Убрать a.txt' }).click();
  assert.equal(await box.inputValue(), 'x', 'a break removed by hand does not come back');
  assert.equal(sends().length, 0, 'the modifier never sends');
});

test('a running session opened from the list has a tab in view, even past the edge of a full strip', async () => {
  const data = defaultFixture();
  data.tabs = data.tabs.filter((t) => t.id !== 't3');
  for (let i = 0; i < 16; i++) data.tabs.push({ ...data.tabs[2], id: `x${i}`, sessionId: null, title: `вкладка с длинным заголовком ${i}`, order: 10 + i });
  const page = await open({ kind: 'sessions' }, data);
  await page.getByText('Перенос очереди на новый брокер').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('claude-os.view')!).kind === 'tab');

  assert.deepEqual(fx!.calls.find((c) => c.path === '/api/tabs')?.body, { resumeSessionId: 's-live', readonly: true, project: 'alpha-service', cwd: '/home/test/alpha-service' });
  const tab = page.getByRole('tab', { selected: true });
  await tab.waitFor();
  assert.match((await tab.getAttribute('title'))!, /alpha-service/);
  await page.waitForFunction(() => {
    const el = [...document.querySelectorAll<HTMLElement>('[role=tablist] [role=tab]')].find((x) => x.getAttribute('aria-selected') === 'true')!;
    const strip = el.closest('[role=tablist]')!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.left >= strip.left - 1 && r.right <= strip.right + 1;
  });
});

test('the root session from the list goes to Home, its only place, and opens no second tab', async () => {
  const data = defaultFixture();
  data.tabs.find((t) => t.id === 'root')!.sessionId = 's-ended';
  const page = await open({ kind: 'sessions' }, data);
  await page.getByText('Правка вёрстки формы оплаты').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('claude-os.view')!).kind === 'home');
  assert.equal(fx!.calls.filter((c) => c.path === '/api/tabs').length, 0);
  assert.equal(await homeButton(page).getAttribute('aria-current'), 'page');
});

test('effort has its own icon and colour for each level, models come in generations', async () => {
  const page = await open({ kind: 'tab', id: 't2' });
  const effort = page.getByRole('combobox', { name: 'Усилие' });
  await effort.locator('svg').nth(1).waitFor();
  assert.equal(await effort.locator('svg').count(), 2, 'the level icon and the chevron');
  await page.getByText('high', { exact: true }).nth(1).waitFor(); // the mark by the mode
  await effort.click();
  const listbox = page.getByRole('listbox');
  const seen = new Set<string>();
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const icon = listbox.getByRole('option', { name: level, exact: true }).locator('svg').first();
    const look = await icon.evaluate((el) => `${el.getAttribute('class')} ${getComputedStyle(el).color}`);
    seen.add(look);
    assert.doesNotMatch(look.split(' ').slice(-3).join(' '), /^rgb\(0, 0, 0\)/, `${level} has a colour`);
  }
  assert.equal(seen.size, 5, 'all five differ');
  await page.keyboard.press('Escape');

  await page.getByRole('combobox', { name: 'Модель' }).click();
  const models = page.getByRole('listbox');
  const groups = models.getByRole('group');
  await groups.nth(1).waitFor();
  assert.equal(await groups.count(), 2);
  const names = (i: number) => groups.nth(i).getByRole('option').allInnerTexts();
  await groups.nth(0).getByText('Последние').waitFor();
  assert.deepEqual(await names(0), ['Default (recommended)', 'Opus 5.5', 'Sonnet 5.5']);
  await groups.nth(1).getByText('Прошлые поколения').waitFor();
  assert.deepEqual(await names(1), ['Opus 4.8', 'Sonnet 5']);
});

test('a plain select keeps working: same options, no group headers', async () => {
  const page = await open({ kind: 'settings', section: 'projects' });
  await page.getByRole('combobox', { name: 'Проект' }).click();
  assert.equal(await page.getByRole('listbox').getByRole('group').count(), 0);
  await page.getByRole('option', { name: 'beta-web' }).click();
  await page.getByRole('combobox', { name: 'Проект' }).getByText('beta-web').waitFor();
  await page.getByRole('combobox', { name: 'Модель' }).click();
  await page.getByRole('listbox').getByText('Прошлые поколения').waitFor();
});

test('/focus: on by default with no mark, collapses tools and reasoning, off survives a reload and says so; nothing reaches Claude', async () => {
  const page = await open({ kind: 'tab', id: 't1' });
  await page.getByText('Настройки читаются').waitFor();
  const box = composer(page);
  await page.getByTestId('focused-tools').first().waitFor();
  const fullOutput = page.getByRole('button', { name: 'Полный вывод' });
  assert.equal(await fullOutput.count(), 0, 'the normal state has no badge');
  await page.getByText('Настройки читаются').waitFor(); // the conversation stays
  await page.getByText('Вынеси настройки подключения').waitFor();
  assert.equal(await page.getByTestId('transcript-scroller').getByText(/токенов/).count(), 0, 'no counters');
  await page.getByRole('button', { name: /^Инструменты: 2/ }).click();
  await page.getByText('src/config.ts').first().waitFor();

  await box.fill('/focus off');
  await box.press('Enter');
  await page.getByTestId('focused-tools').first().waitFor({ state: 'detached' });
  assert.equal(await box.inputValue(), '');

  await page.reload();
  await page.getByText('Настройки читаются').waitFor();
  await fullOutput.waitFor();
  assert.equal(await page.getByTestId('focused-tools').count(), 0, 'off is remembered');

  const box2 = composer(page);
  await box2.fill('/focus nonsense');
  await box2.press('Enter');
  await page.getByText('Использование: /focus on или /focus off').waitFor();
  await box2.fill('');
  // The mark is also the way back; so is the right button on the input.
  await fullOutput.click();
  await page.getByTestId('focused-tools').first().waitFor();
  await fullOutput.waitFor({ state: 'detached' });
  await box2.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Выключить режим фокуса' }).click();
  await fullOutput.waitFor();
  await box2.fill('/focus on');
  await box2.press('Enter');
  await page.getByTestId('focused-tools').first().waitFor();
  assert.equal(sends().length, 0);
});

test('/view: the chat column widens, the choice survives a reload, the input menu cycles it; nothing reaches Claude', async () => {
  const page = await open({ kind: 'tab', id: 't1' });
  await page.getByText('Настройки читаются').waitFor();
  const column = () => page.getByTestId('transcript-scroller').locator('> div').first();
  const width = async () => (await column().getAttribute('class'))!.match(/max-w-\S+/)?.[0];
  assert.equal(await width(), 'max-w-180');
  const box = composer(page);
  await box.fill('/view large');
  await box.press('Enter');
  await page.getByText('Ширина чата: широкая').waitFor();
  assert.equal(await width(), 'max-w-300');
  assert.equal(await box.inputValue(), '');
  const composerWidth = await box.evaluate((el) => el.closest('.mx-auto')!.className.match(/max-w-\S+/)?.[0]);
  assert.equal(composerWidth, 'max-w-300', 'the input follows the column');

  await page.reload();
  await page.getByText('Настройки читаются').waitFor();
  assert.equal(await width(), 'max-w-300', 'remembered');

  const box2 = composer(page);
  await box2.fill('/view nonsense');
  await box2.press('Enter');
  await page.getByText('Использование: /view default, /view large или /view full').waitFor();
  await box2.fill('');
  await box2.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Чат во всю ширину' }).click();
  assert.equal(await width(), 'max-w-none');
  await box2.fill('/view default');
  await box2.press('Enter');
  await page.getByText('Ширина чата: обычная').waitFor();
  assert.equal(await width(), 'max-w-180');
  assert.equal(sends().length, 0);
});

test('a command that cannot run in the chat opens a dialog, sends nothing and says what was checked', async () => {
  const page = await open({ kind: 'tab', id: 't2' });
  const box = composer(page);
  const submit = async (text: string) => {
    await box.fill(text);
    await box.press('Escape');
    await box.press('Enter');
  };

  await submit('/theme');
  let dialog = page.getByRole('dialog', { name: '/theme' });
  await dialog.getByText(/isn't available in this environment/).waitFor();
  await dialog.getByRole('button', { name: 'Открыть в терминале' }).waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'detached' });
  assert.equal(await box.inputValue(), '');

  // Unlisted and typed before the list has come: the table knows it.
  await submit('/login');
  await page.getByRole('dialog', { name: '/login' }).getByText(/isn't available/).waitFor();
  await page.keyboard.press('Escape');

  // Not checked in the CLI: no reason is invented.
  await submit('/logout');
  await page.getByRole('dialog', { name: '/logout' }).getByText('Недоступно в этом режиме.').waitFor();
  await page.keyboard.press('Escape');

  // Claude OS has the function: the dialog performs it.
  await submit('/plan');
  dialog = page.getByRole('dialog', { name: '/plan' });
  await dialog.getByRole('button', { name: 'Включить режим плана' }).click();
  await dialog.waitFor({ state: 'detached' });
  for (let i = 0; i < 100 && !fx!.calls.some((c) => (c.body as { permissionMode?: string })?.permissionMode === 'plan'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.ok(fx!.calls.some((c) => c.method === 'PATCH' && (c.body as { permissionMode?: string }).permissionMode === 'plan'));

  await submit('/doctor prompt-audit');
  for (let i = 0; i < 100 && sends().length === 0; i++) await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual((sends()[0].body as { text: string }).text, '/doctor prompt-audit', 'with arguments it is a message to Claude');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(sends().length, 1);
});

test('/doctor: the dialog links to Settings, the button there shows the report', async () => {
  const page = await open({ kind: 'tab', id: 't2' });
  const box = composer(page);
  await box.fill('/doctor');
  const row = page.getByRole('listbox', { name: 'Слэш-команды' }).getByRole('option').filter({ hasText: '/doctor' });
  await row.click();
  const dialog = page.getByRole('dialog', { name: '/doctor' });
  await dialog.getByText(/тратит токены/).waitFor();
  await dialog.getByRole('button', { name: 'Перейти к проверке' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByRole('button', { name: 'Проверить' }).click();
  await page.getByTestId('doctor-output').getByText('No installation issues found.').waitFor();
  assert.ok(fx!.calls.some((c) => c.path === '/api/doctor'));
  assert.equal(sends().length, 0);
});

const submitter = (page: Page) => async (text: string) => {
  const box = composer(page);
  await box.fill(text);
  await box.press('Escape');
  await box.press('Enter');
};

test('every command off the chat: a dialog that says why and where, with a working way out, nothing sent', async () => {
  const page = await open({ kind: 'tab', id: 't1' });
  const submit = submitter(page);
  await page.getByText('Настройки читаются').waitFor();
  for (const name of Object.keys(OFF_CHAT)) {
    await submit(`/${name}`);
    const dialog = page.getByRole('dialog', { name: `/${name}` });
    await dialog.getByText('Где работает').waitFor();
    await dialog.getByRole('button', { name: 'Открыть в терминале' }).waitFor();
    const entry = OFF_CHAT[name];
    const nothing = !entry.link && !entry.run && !entry.control;
    assert.equal(await dialog.getByText('В Claude OS такой функции нет.').count(), nothing ? 1 : 0, name);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
  }
  assert.equal(sends().length, 0);
});

test('commands Claude OS has: each button does the thing or goes to the screen', async () => {
  const page = await open({ kind: 'tab', id: 't1' });
  await ctx!.grantPermissions(['clipboard-read', 'clipboard-write']);
  const submit = submitter(page);
  await page.getByText('Настройки читаются').waitFor();
  const dialogOf = (name: string) => page.getByRole('dialog', { name: `/${name}` });

  await submit('/copy');
  await dialogOf('copy').getByRole('button', { name: 'Скопировать последний ответ' }).click();
  await page.getByText('Ответ скопирован').waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  assert.ok(copied.length > 0 && !copied.includes('undefined'), copied);

  await submit('/export');
  await dialogOf('export').getByRole('button', { name: 'Скопировать разговор' }).click();
  await page.getByText('Разговор скопирован').waitFor();
  const talk = await page.evaluate(() => navigator.clipboard.readText());
  assert.match(talk, /## Вы\n\nВынеси настройки подключения/);
  assert.match(talk, /## Claude/);
  await submit('/export');
  const [download] = await Promise.all([page.waitForEvent('download'), dialogOf('export').getByRole('button', { name: 'Сохранить в файл' }).click()]);
  assert.match(download.suggestedFilename(), /^claude-.+\.md$/);

  await submit('/diff');
  await dialogOf('diff').getByRole('button', { name: 'Открыть панель Git' }).click();
  await page.getByTestId('git-panel').waitFor();
  await page.keyboard.press('Escape');
  await page.getByTestId('git-panel').waitFor({ state: 'detached' });

  await submit('/permissions');
  await dialogOf('permissions').getByRole('button', { name: 'Выбрать режим разрешений' }).click();
  await page.getByRole('radiogroup', { name: /режим/i }).getByRole('radio').first().waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('radiogroup', { name: /режим/i }).waitFor({ state: 'detached' });
  await composer(page).click(); // nothing left blocking the page

  await page.getByRole('radio', { name: /Проект/ }).click();
  await submit('/tasks');
  await dialogOf('tasks').getByRole('button', { name: 'Показать в панели' }).click();
  await page.getByTestId('side-panel').getByRole('radio', { name: /Сессия/ }).and(page.locator('[aria-checked="true"]')).waitFor();

  await submit('/ide');
  await dialogOf('ide').getByRole('button', { name: /^Открыть в (?!терминале)/ }).click();
  for (let i = 0; i < 100 && !fx!.calls.some((c) => c.path === '/api/ides/open'); i++) await new Promise((r) => setTimeout(r, 50));
  assert.equal((fx!.calls.find((c) => c.path === '/api/ides/open')!.body as { project: string }).project, 'alpha-service');

  await submit('/login');
  await dialogOf('login').getByText(/Вход и выход идут только через терминал/).waitFor();
  await dialogOf('login').getByRole('button', { name: 'Открыть раздел Claude' }).click();
  await page.getByRole('button', { name: 'Проверить' }).waitFor();
});

test('/theme leads to the space theme in the settings', async () => {
  const page = await open({ kind: 'tab', id: 't2' });
  await submitter(page)('/theme');
  await page.getByRole('dialog', { name: '/theme' }).getByRole('button', { name: 'Открыть тему космоса' }).click();
  await page.getByRole('radiogroup', { name: 'Тема космоса' }).waitFor();
});

test('git: the status button sits beside fetch and returns to the changes', async () => {
  const page = await open({ kind: 'tab', id: 't1' });
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  const panel = page.getByTestId('git-panel');
  const status = panel.getByRole('button', { name: 'Статус', exact: true });
  const fetch = panel.getByRole('button', { name: 'Fetch', exact: true });
  await status.waitFor();
  const a = (await status.boundingBox())!;
  const b = (await fetch.boundingBox())!;
  assert.ok(a.x + a.width <= b.x && b.x - (a.x + a.width) < 12, 'right before fetch');
  await panel.getByRole('radio', { name: 'Лог' }).click();
  await status.click();
  await panel.getByText('Изменения').waitFor();
});
