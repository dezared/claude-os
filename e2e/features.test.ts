// Second and third batch against e2e/fixture-server.ts: no real server, no Claude, no git. Set CLAUDE_OS_WEB_DIST to test another build.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { fixtureAccount, fixtureSettings, gitFailures } from './fixture-features.ts';
import { homeButton, startFixture, type FixtureServer } from './fixture-server.ts';

const SHOTS = join(import.meta.dirname, '..', 'docs', 'screenshots');
mkdirSync(SHOTS, { recursive: true });

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
  fixtureSettings.obsidian.dismissed = false;
});

async function open(view?: unknown, locale = 'ru-RU'): Promise<Page> {
  fx = await startFixture();
  ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale, reducedMotion: 'reduce' });
  if (view) await ctx.addInitScript((v) => localStorage.setItem('claude-os.view', v), JSON.stringify(view));
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

const shot = (page: Page, name: string) => page.screenshot({ path: join(SHOTS, name), timeout: 90_000 });

test('slash menu: works before the first message, filters, keyboard, sources and descriptions', async () => {
  const page = await open({ kind: 'tab', id: 't2' }); // no session yet
  const box = page.getByRole('textbox', { name: /Сообщение|beta-web/ }).first();
  await box.click();
  await box.fill('/');
  const list = page.getByRole('listbox', { name: 'Слэш-команды' });
  await list.getByText('/compact').waitFor();
  await list.getByText('встроенная').first().waitFor();
  await list.getByText('плагин').waitFor();
  await list.getByText('проект', { exact: true }).waitFor();
  await list.getByText('Обсудить задачу до кода').waitFor();
  await list.getByText('не в чате').first().waitFor();
  await shot(page, 'slash.png');

  await box.fill('/заметки'); // by description
  await list.getByText('/release-notes').waitFor();
  assert.equal(await list.getByRole('option').count(), 1);

  await box.fill('/re');
  await list.getByRole('option').nth(1).waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Tab');
  assert.equal(await box.inputValue(), '/review ');

  await box.fill('/co');
  await list.waitFor();
  await page.keyboard.press('Escape');
  await list.waitFor({ state: 'detached' });

  await box.fill('/config');
  await list.getByRole('option').first().waitFor();
  await page.keyboard.press('Enter');
  await page.getByRole('dialog', { name: '/config' }).waitFor();
  assert.equal(fx!.calls.filter((c) => c.path.endsWith('/send')).length, 0, 'no message is sent');
});

test('@ mention: filtered list and keyboard', async () => {
  const page = await open({ kind: 'tab', id: 't2' });
  const box = page.getByRole('textbox', { name: /beta-web/ }).first();
  await box.click();
  await box.fill('look at @sr');
  const list = page.getByRole('listbox', { name: /[Фф]айл/ });
  await list.getByText('src/config.ts').waitFor();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  assert.equal(await box.inputValue(), 'look at @src/db.ts ');
});

test('git panel: lists, diff in two views, binary and capped states, stage and commit, push confirmation, error and microtask', async () => {
  const page = await open({ kind: 'tab', id: 't1' });
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  const panel = page.getByTestId('git-panel');
  await panel.getByText('feature/broker', { exact: true }).waitFor();
  await panel.getByText('Изменения').waitFor();
  await panel.getByText('settings.ts').click();
  const diff = page.getByTestId('git-diff');
  await diff.getByText('retries = 5').waitFor();
  await panel.getByRole('radio', { name: 'Рядом' }).click();
  await diff.getByText('process.env.DB_HOST').waitFor();
  await shot(page, 'git.png');
  await panel.getByRole('radio', { name: 'Единый' }).click();

  await panel.getByText('logo.png').click();
  await diff.getByText('Двоичный файл').waitFor();
  await panel.getByText('README.md').click();
  await panel.getByText('слишком большая').waitFor();

  await panel.getByRole('checkbox', { name: 'В коммит: README.md' }).click();
  await panel.getByRole('checkbox', { name: 'Убрать из коммита: src/config.ts' }).click();
  const calls = () => fx!.calls.filter((c) => c.path.includes('/git/'));
  assert.deepEqual(calls().map((c) => [c.path.split('/').at(-1), c.body]), [['stage', { paths: ['README.md'] }], ['unstage', { paths: ['src/config.ts'] }]]);

  const commitBtn = panel.getByRole('button', { name: /^Коммит \(/ });
  assert.equal(await commitBtn.isDisabled(), true, 'no message yet');
  await panel.getByRole('textbox', { name: 'Сообщение коммита' }).fill('fix: broker');
  await commitBtn.click();
  assert.deepEqual(calls().at(-1)?.body, { message: 'fix: broker' });

  await panel.getByRole('button', { name: /^Push/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Отправить ветку' });
  await dialog.getByText('origin/feature/broker').waitFor();
  await dialog.getByText('без force').waitFor();

  gitFailures.next = '! [rejected] feature/broker -> feature/broker (non-fast-forward)\nhint: Updates were rejected';
  gitFailures.path = '/push';
  await dialog.getByRole('button', { name: 'Отправить' }).click();
  await panel.getByText('[rejected]').waitFor();
  assert.deepEqual(calls().at(-1)?.body, { branch: 'feature/broker', remote: 'origin', ahead: 2 });

  await panel.getByRole('button', { name: 'Исправить через Claude' }).click();
  const task = page.getByRole('dialog', { name: 'Исправить ошибку git' });
  await task.getByText(/расходуется лимит/).waitFor();
  await task.getByText(/один push ветки feature\/broker/).waitFor();
  await task.getByText(/\[rejected\]/).waitFor();
  await task.getByRole('button', { name: 'Отмена' }).click();
  assert.equal(fx!.calls.filter((c) => c.path.endsWith('/send')).length, 0, 'only the button sends');
});

test('git panel: commit history and a non-repo state', async () => {
  const page = await open({ kind: 'tab', id: 't1' });
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  const panel = page.getByTestId('git-panel');
  await panel.getByRole('radio', { name: 'Лог' }).click();
  await panel.getByText('Перенос очереди на новый брокер').click();
  await panel.getByText('aaaaaaa').first().waitFor();
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'detached' });

  await page.getByRole('tab', { name: /beta-web/ }).click();
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  await page.getByText('не git-репозиторий').waitFor();
});

test('work bar: primary IDE, others in a dropdown, a plain terminal; no fixed PhpStorm and VS Code pair', async () => {
  const page = await open({ kind: 'tab', id: 't1' });
  const main = page.getByRole('button', { name: 'PhpStorm', exact: true });
  await main.waitFor();
  assert.equal(await page.getByRole('button', { name: 'VS Code', exact: true }).count(), 0);
  await main.click();
  await until(() => fx!.calls.some((c) => c.path === '/api/ides/open'));
  assert.deepEqual(fx!.calls.find((c) => c.path === '/api/ides/open')?.body, { ide: 'phpstorm-a1', project: 'alpha-service', cwd: '/home/test/alpha-service' });
  await page.getByRole('button', { name: 'Другие IDE' }).click();
  await page.getByRole('button', { name: 'VS Code', exact: true }).click();
  const put = () => fx!.calls.find((c) => c.path === '/api/settings/project/alpha-service');
  await until(() => !!put());
  assert.deepEqual(put()?.body, { ide: 'vscode-b2' }, 'picking another IDE makes it the project IDE');
  assert.ok(fx!.calls.some((c) => c.path === '/api/ides/open' && (c.body as { ide: string }).ide === 'vscode-b2'));
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Терминал', exact: true }).click();
  await until(() => fx!.calls.some((c) => decodeURIComponent(c.path) === '/api/actions/builtin:shell/run'));
});

test('no dollars anywhere on a subscription', async () => {
  const page = await open({ kind: 'analytics' });
  await page.getByText('Открытые тикеты').count();
  await page.getByText('Чтение кэша').first().waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /\$\d|эквивалент|USD/i);
  await page.evaluate(() => localStorage.setItem('claude-os.focus', '0')); // a turn's token line shows only with full output
  await page.reload();
  await page.getByRole('tab', { name: /alpha-service/ }).click();
  await page.getByText('Настройки читаются').waitFor();
  await page.getByText(/токенов/).first().waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /\$\d|эквивалент API/);
  await homeButton(page).click();
  await page.getByText('alpha-service', { exact: true }).first().waitFor();
  assert.doesNotMatch(await page.locator('body').innerText(), /\$\d|эквивалент API/);
});

test('analytics: Claude OS own load per source with its share of all tokens', async () => {
  const page = await open({ kind: 'analytics' });
  const section = page.locator('section', { has: page.getByRole('heading', { name: 'Сам Claude OS' }) });
  await section.getByText('4 % от всех токенов').waitFor();
  await section.getByText('Главная сессия · 3 %').waitFor();
  await section.getByText('Служебные задания · <1 %').waitFor();
  await section.getByText('Виджеты · <1 %').waitFor();
});

test('dollars come back only for real API billing', async () => {
  fixtureAccount.billing = 'api';
  try {
    const page = await open({ kind: 'analytics' });
    await page.getByText('эквивалент API, при подписке не реальный расход').waitFor();
    await page.getByText('$413').waitFor();
  } finally {
    fixtureAccount.billing = 'subscription';
  }
});

test('limits: compact badge, popover with plan, windows, the source and the time', async () => {
  const page = await open({ kind: 'sessions' });
  const badge = page.getByRole('button', { name: 'Подписка и лимиты' });
  await badge.getByText('62%').waitFor();
  await badge.click();
  await page.getByText('Claude Ultra').nth(1).waitFor();
  await page.getByText(/Неделя · Fable/).waitFor();
  await page.getByText('5 часов').waitFor();
  await page.getByText(/\/usage через Claude Code/).waitFor();
  await page.getByText(/События лимитов/).waitFor();
  await page.waitForTimeout(200);
  await shot(page, 'limits.png');
});

test('settings: IDE list, an unapproved entry, project defaults, language; Claude search is labelled and only opens the dialog', async () => {
  const page = await open({ kind: 'settings', section: 'ides' });
  await page.getByText('Visual Studio Community 2022').waitFor();
  await page.getByRole('button', { name: 'Одобрить запуск' }).waitFor();
  await shot(page, 'settings.png');
  await page.getByRole('button', { name: 'Найти через Claude' }).click();
  await page.getByRole('dialog').getByText(/Входит в|подписк|API/).waitFor();
  await page.getByRole('button', { name: 'Отмена' }).click();
  assert.equal(fx!.calls.filter((c) => c.path.endsWith('/send')).length, 0);
  await page.getByRole('button', { name: 'Проекты', exact: true }).click();
  await page.getByText('Новые вкладки проекта начинают').waitFor();
  await page.getByRole('combobox', { name: 'Усилие' }).first().waitFor();
  await page.getByRole('button', { name: 'Общие', exact: true }).click();
  await page.getByRole('radio', { name: 'EN' }).click();
  await page.getByRole('heading', { name: 'Settings' }).waitFor();
});

test('obsidian notice: not modal, dismissal is remembered', async () => {
  const page = await open({ kind: 'sessions' });
  const notice = page.getByRole('complementary', { name: 'Obsidian не найден' });
  await notice.getByText('Скачать с obsidian.md').waitFor();
  await notice.getByText('Установить через Claude').waitFor();
  assert.equal(await page.locator('[aria-modal="true"]').count(), 0);
  await notice.getByRole('button', { name: 'Скрыть' }).click();
  await notice.waitFor({ state: 'detached' });
  assert.ok(fx!.calls.some((c) => c.path === '/api/settings/obsidian/dismiss'));
});

test('CLAUDE.md screen: the file as a file, no counting', async () => {
  const page = await open({ kind: 'tools', pane: 'claude-md' });
  await page.getByText('Think Before Coding').waitFor();
  await page.getByText('Never invent business rules').first().waitFor();
  await page.getByText('В каждой сессии в любом проекте.').waitFor();
  await page.getByRole('button', { name: 'Открыть в IDE' }).waitFor();
  await page.getByRole('button', { name: 'Спросить Claude' }).waitFor();
  assert.equal(await page.getByText(/≈|оценка|Сессий с этим/).count(), 0);
  await shot(page, 'claude-md.png');
  await page.getByRole('radio', { name: 'Проект' }).click();
  await page.getByText(/Файла нет/).waitFor();
});

test('vault pane: preview first, copies only on click', async () => {
  const page = await open({ kind: 'tools', pane: 'vault' });
  await page.getByText(/Будет скопировано заметок: 4/).waitFor();
  assert.equal(fx!.calls.filter((c) => c.path.includes('/vault/copy')).length, 0);
  await page.getByRole('button', { name: 'Скопировать всё в хранилище' }).click();
  await page.getByText(/Скопировано заметок: 4/).waitFor();
});

test('usage log with filters, side panel list, note numbers; MEMORY.md caveat is said', async () => {
  const page = await open({ kind: 'tools', pane: 'log' });
  await page.getByText('Журнал обращений').waitFor();
  await page.locator('.sheet').getByRole('cell', { name: 'brainstorm' }).waitFor();
  await page.getByText(/автозагрузка MEMORY\.md/).waitFor();
  await page.getByRole('radio', { name: 'Внешняя память' }).click();
  await page.getByText(/-home-test-beta-web\/memory/).waitFor();
  assert.equal(await page.getByText(/broker\.md/).count(), 0);

  await page.getByRole('tab', { name: /alpha-service/ }).click();
  await page.getByText('Использовано в сессии').waitFor();
  await page.getByText('broker.md').waitFor();
  await page.getByRole('button', { name: /note_1\.md/ }).click();
  await page.getByTestId('note-usage').getByText(/Прочитано 5, записано 1/).waitFor();
});

test('project panel: origins, masked settings with a diff, promote shows both files, check is a labelled microtask', async () => {
  const page = await open({ kind: 'tab', id: 't1' });
  await page.getByRole('radio', { name: 'Проект' }).click();
  await page.getByText('settings.json').waitFor();
  await page.getByText('PostToolUse · Edit').waitFor();
  await page.getByText('release-notes').waitFor();
  await page.getByText('docs', { exact: true }).waitFor();
  await shot(page, 'project-setup.png');

  await page.getByRole('button', { name: 'Изменить: settings.json' }).click({ force: true });
  const editor = page.getByRole('dialog');
  assert.match(await editor.getByRole('textbox').inputValue(), /"API_TOKEN": "\*\*\*"/);
  await editor.getByRole('button', { name: 'Показать разницу' }).click();
  await editor.getByText('"model": "sonnet"').waitFor();
  await editor.getByRole('button', { name: 'Сохранить' }).click();
  await editor.waitFor({ state: 'detached' });
  assert.ok(fx!.calls.some((c) => c.method === 'PUT' && c.path.endsWith('/setup/project')));

  await page.getByRole('button', { name: 'Вынести в глобальную область: model' }).click({ force: true });
  const promote = page.getByRole('dialog');
  await promote.getByText('~/.claude/settings.json').or(promote.getByText('/home/test/.claude/settings.json')).first().waitFor();
  await promote.getByRole('button', { name: 'Вынести' }).click();
  await promote.waitFor({ state: 'detached' });
  assert.equal((fx!.calls.find((c) => c.path.endsWith('/promote'))?.body as { confirmed: boolean }).confirmed, true);

  await page.getByRole('button', { name: /Проверить настройку/ }).click();
  const task = page.getByRole('dialog', { name: 'Проверить настройку' });
  await task.getByText(/расходуется лимит/).waitFor();
  await task.getByText('Audit /home/test/alpha-service.').waitFor();
  await task.getByRole('button', { name: 'Отмена' }).click();
});

test('a new widget is filled by description: labelled, goes to the service session only on click', async () => {
  const page = await open();
  await page.locator('.u-label.core.on').waitFor();
  await page.mouse.click(800, 500, { button: 'right' });
  await page.getByRole('menuitem', { name: 'Создать виджет' }).click();
  await page.mouse.click(600, 300);
  const task = page.getByRole('dialog', { name: 'Что показать в виджете' });
  await task.getByText(/расходуется лимит/).waitFor();
  const send = task.getByRole('button', { name: 'Отправить' });
  assert.equal(await send.isDisabled(), true);
  await task.getByRole('textbox').fill('число открытых тикетов');
  await task.getByText(/число открытых тикетов/).first().waitFor();
  assert.equal(fx!.calls.filter((c) => c.path.endsWith('/send')).length, 0);
  await send.click();
  await task.waitFor({ state: 'detached' });
  const sent = fx!.calls.find((c) => c.path === '/api/service/tasks' && c.method === 'POST');
  assert.match((sent?.body as { prompt: string }).prompt, /widgets\.json[\s\S]*"type":"block"[\s\S]*число открытых тикетов/);
});

test('a project row with no tab opens a new one', async () => {
  const page = await open();
  await page.locator('aside').getByText('gamma-tools', { exact: true }).first().click();
  await until(() => fx!.calls.some((c) => c.method === 'POST' && c.path === '/api/tabs'));
  const made = fx!.calls.find((c) => c.method === 'POST' && c.path === '/api/tabs');
  assert.deepEqual(made?.body, { project: 'gamma-tools' });
});
