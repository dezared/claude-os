// Wiki memory in the UI against e2e/fixture-server.ts: search with snippets in the palette, format issues in the note panel and the Vault pane,
// the per-project migration (start, batches, preview, apply, undo).
import assert from 'node:assert/strict';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import type { WikiPreview, WikiRunView } from '../shared/contract.ts';
import { defaultFixture, startFixture, type Fixture, type FixtureServer } from './fixture-server.ts';

let browser: Browser;
let ctx: BrowserContext | null = null;
let fx: FixtureServer | null = null;
let errors: string[] = [];
let searches: URLSearchParams[] = [];

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
  searches = [];
});

async function open(data: Fixture = defaultFixture(), view?: unknown): Promise<Page> {
  fx = await startFixture(data);
  ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU', reducedMotion: 'reduce' });
  if (view) await ctx.addInitScript((v) => localStorage.setItem('claude-os.view', v), JSON.stringify(view));
  ctx.setDefaultTimeout(20000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.pathname === '/api/memory/search') searches.push(url.searchParams);
  });
  await page.goto(fx.url);
  if (!view) await page.locator('aside').getByText('alpha-service', { exact: true }).first().waitFor();
  return page;
}

async function palette(page: Page, text: string) {
  await page.keyboard.press('Control+k');
  await page.getByRole('combobox').fill(text);
}

test('palette notes come from search with a highlighted snippet', async () => {
  const page = await open();
  await palette(page, 'note_alpha');
  const option = page.getByRole('option').filter({ has: page.locator('mark') }).first();
  await option.waitFor();
  assert.equal(await option.locator('mark').first().textContent(), 'note_alpha');
  const text = (await option.textContent()) ?? '';
  assert.ok(text.includes('[v2]'), `brackets in the note text stay literal: ${text}`);
  assert.ok(!text.includes('\u0001') && !text.includes('\u0002'), 'no raw markers on screen');
  assert.ok(text.includes('alpha-service'), 'the project is the hint');
  assert.ok(searches.some((s) => s.get('q') === 'note_alpha' && s.get('limit') === '12'));
});

test('typing one character shows no notes', async () => {
  const page = await open();
  await palette(page, 'n');
  await page.getByRole('option').first().waitFor();
  await page.waitForTimeout(400);
  assert.equal(await page.getByRole('option', { name: /note_/ }).count(), 0);
  assert.equal(await page.getByRole('listbox').getByText('Заметки', { exact: true }).count(), 0);
  assert.equal(searches.length, 0);
});

test('note panel lists the note\'s issues', async () => {
  const data = defaultFixture();
  const node = data.graph.nodes.find((n) => n.issues.length > 0 && n.connected)!;
  node.issues = ['not-english', 'tags-count', 'some-future-code'];
  const page = await open(data);
  await palette(page, node.title);
  await page.getByRole('option', { name: new RegExp(node.title) }).first().waitFor();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('complementary', { name: 'Заметка памяти' });
  const issues = panel.getByRole('list', { name: 'Ошибки формата' });
  await issues.getByText('Не на английском').waitFor();
  await issues.getByText('Нужно 1–3 тега').waitFor();
  await issues.getByText('some-future-code').waitFor();

  await panel.getByRole('button', { name: 'Править', exact: true }).click();
  await panel.getByRole('textbox', { name: 'Текст заметки' }).fill('Текст без формата');
  await panel.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await page.getByText(/Сохранено, но остались ошибки формата: Не на английском/).waitFor();
});

test('vault pane shows format issues per project', async () => {
  const data = defaultFixture();
  const withIssues = data.graph.nodes.filter((n) => n.connected && n.issues.length > 0);
  assert.ok(withIssues.length >= 2, 'the fixture has notes with issues');
  const big = 'eta-infra';
  for (let i = 0; i < 181; i++) {
    data.graph.nodes.push({ id: `big${i}`, title: `big_${i}`, file: `big_${i}.md`, project: big, connected: true, degree: 0, live: false, mtime: Date.now(), summary: null, issues: [] });
  }
  const page = await open(data, { kind: 'tools', pane: 'vault' });
  const stat = page.getByText('Ошибки формата', { exact: true }).first().locator('xpath=ancestor::div[1]');
  await stat.locator('b').getByText(String(withIssues.length), { exact: true }).waitFor();

  const table = page.getByRole('table', { name: 'Ошибки формата' });
  const project = withIssues[0].project!;
  const row = table.getByRole('row').filter({ hasText: project });
  const count = withIssues.filter((n) => n.project === project && n.issues.includes('not-english')).length;
  await row.getByText(`Не на английском ${count}`).waitFor();
  await table.getByRole('row').filter({ hasText: big }).getByText('больше 180 заметок').waitFor();
});

// ---------- Migration ----------

const PREVIEW: WikiPreview = {
  files: [
    { old: 'project.md', new: ['db-host-config', 'deploy-steps'], dropped: [{ what: 'staging URL', why: 'the staging server was removed' }] },
    { old: 'state.md', new: ['queue-retry-limit'], dropped: [] },
  ],
  warnings: ['[[old-plan]] will open no note: old-plan is dropped'],
  linkDiff: '--- a/projects/beta-web/links.md\n+++ b/projects/beta-web/links.md\n@@ -1 +1 @@\n-see [[project]]\n+see [[db-host-config]]',
  memory: { before: { lines: 42, bytes: 25938, tokens: 6485 }, after: { lines: 3, bytes: 310, tokens: 78 } },
  notesAfter: 3,
};

const ready = (project: string, state: WikiRunView['state'] = 'ready'): WikiRunView => ({
  project, run: 'r1', state, preview: PREVIEW,
  batches: [{ n: 1, files: ['project.md', 'state.md'], tabId: 't1', status: 'ok', errors: [], warnings: [] }],
});

/** The vault pane with a note in each of `keys`, so each has a row in the format list. */
async function vault(runs: Record<string, WikiRunView>, keys = Object.keys(runs)): Promise<Page> {
  const data = defaultFixture();
  data.graph.nodes = keys.map((key, i) => ({ id: `w${i}`, title: `note_${key}`, file: `note_${key}.md`, project: key, connected: true, degree: 0, live: false, mtime: Date.now(), summary: null, issues: ['not-english'] }));
  data.graph.edges = [];
  data.wiki = runs;
  return open(data, { kind: 'tools', pane: 'vault' });
}

const row = (page: Page, key: string) => page.getByRole('table', { name: 'Ошибки формата' }).getByRole('row').filter({ hasText: key });
const dialog = (page: Page) => page.getByRole('dialog', { name: /Миграция заметок/ });
const wikiCalls = () => fx!.calls.filter((c) => c.path.startsWith('/api/memory/wiki/'));

test('migration preview shows dropped reasons and sizes', async () => {
  const page = await vault({ 'alpha-service': ready('alpha-service') });
  await row(page, 'alpha-service').getByRole('button', { name: 'Предпросмотр' }).click();
  const d = dialog(page);
  const files = d.getByRole('list', { name: 'Старые файлы и новые заметки' });
  await files.getByText('project.md', { exact: true }).waitFor();
  await files.getByText('db-host-config', { exact: true }).waitFor();
  await files.getByText('queue-retry-limit', { exact: true }).waitFor();
  await files.getByText('staging URL').waitFor();
  await files.getByText('the staging server was removed').waitFor();
  await d.getByText('[[old-plan]] will open no note: old-plan is dropped').waitFor();

  const sizes = d.getByRole('table', { name: 'MEMORY.md до и после' });
  const before = ((await sizes.getByRole('row').filter({ hasText: 'До' }).textContent()) ?? '').replace(/\s/g, '');
  const after = ((await sizes.getByRole('row').filter({ hasText: 'После' }).textContent()) ?? '').replace(/\s/g, '');
  assert.equal(before, 'До42259386485');
  assert.equal(after, 'После331078');

  await d.getByText('Ссылки в хранилище').click();
  await d.getByText('+see [[db-host-config]]').waitFor();
  assert.equal(await d.getByRole('checkbox', { name: 'Терминальные сессии тоже используют хранилище' }).isChecked(), true);
  assert.deepEqual(wikiCalls(), [], 'nothing is applied by opening the preview');
});

test('apply sends connect true by default, false when unchecked', async () => {
  const page = await vault({ 'alpha-service': ready('alpha-service'), 'beta-web': ready('beta-web') });
  await row(page, 'alpha-service').getByRole('button', { name: 'Предпросмотр' }).click();
  await dialog(page).getByRole('button', { name: 'Применить', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Откатить', exact: true }).waitFor();
  assert.deepEqual(wikiCalls(), [{ method: 'POST', path: '/api/memory/wiki/alpha-service/apply', body: { connect: true } }]);
  await page.keyboard.press('Escape');
  await dialog(page).waitFor({ state: 'hidden' });
  await row(page, 'alpha-service').getByRole('button', { name: 'Применено' }).waitFor();

  await row(page, 'beta-web').getByRole('button', { name: 'Предпросмотр' }).click();
  await dialog(page).getByRole('checkbox', { name: 'Терминальные сессии тоже используют хранилище' }).uncheck();
  await dialog(page).getByRole('button', { name: 'Применить', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Откатить', exact: true }).waitFor();
  assert.deepEqual(wikiCalls().at(-1), { method: 'POST', path: '/api/memory/wiki/beta-web/apply', body: { connect: false } });
});

test('undo shows kept files', async () => {
  const page = await vault({ 'alpha-service': ready('alpha-service', 'applied') });
  await row(page, 'alpha-service').getByRole('button', { name: 'Применено' }).click();
  await dialog(page).getByRole('button', { name: 'Откатить', exact: true }).click();
  const kept = dialog(page).getByRole('list', { name: 'Оставлены: изменены после применения' });
  await kept.getByText('db-host-config.md', { exact: true }).waitFor();
  await dialog(page).getByRole('list', { name: 'Не восстановлены: файл на месте изменён' }).getByText('state.md', { exact: true }).waitFor();
  await dialog(page).getByText('Восстановлено файлов: 2').waitFor();
  assert.deepEqual(wikiCalls().map((c) => c.path), ['/api/memory/wiki/alpha-service/undo']);
  await page.keyboard.press('Escape');
  await row(page, 'alpha-service').getByRole('button', { name: 'Мигрировать' }).waitFor();
});

test('migrate starts a run whose batch link opens its tab', async () => {
  const page = await vault({}, ['alpha-service']);
  await row(page, 'alpha-service').getByRole('button', { name: 'Мигрировать' }).click();
  assert.deepEqual(wikiCalls(), [], 'opening the dialog starts nothing');
  await dialog(page).getByRole('button', { name: 'Начать', exact: true }).click();
  const batches = dialog(page).getByRole('list', { name: 'Пачки' });
  await batches.getByRole('listitem').filter({ hasText: 'state.md' }).getByText('ждёт').waitFor();
  await page.keyboard.press('Escape');
  await row(page, 'alpha-service').getByRole('button', { name: 'Переписывается 0/2' }).click();
  await batches.getByRole('listitem').filter({ hasText: 'project.md' }).getByRole('button', { name: 'Открыть вкладку' }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('claude-os.view') ?? '{}').id === 't1');
  assert.deepEqual(wikiCalls().map((c) => c.path), ['/api/memory/wiki/alpha-service/prepare']);
});

test('a project without notes becomes managed through an empty preview', async () => {
  const page = await vault({}, ['alpha-service']);
  await page.getByRole('combobox', { name: 'Мигрировать другой проект' }).click();
  await page.getByRole('option', { name: 'gamma-tools' }).click();
  await dialog(page).getByRole('button', { name: 'Начать', exact: true }).click();
  await dialog(page).getByText(/В проекте нет заметок/).waitFor();
  await dialog(page).getByRole('button', { name: 'Применить', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Откатить', exact: true }).waitFor();
  assert.deepEqual(wikiCalls().map((c) => c.path), ['/api/memory/wiki/gamma-tools/prepare', '/api/memory/wiki/gamma-tools/apply']);
});

test('discard asks first and drops the run only when confirmed', async () => {
  const page = await vault({ 'alpha-service': ready('alpha-service', 'failed') });
  await row(page, 'alpha-service').getByRole('button', { name: 'Не прошла проверку' }).click();
  const discard = async () => {
    await dialog(page).getByRole('button', { name: 'Ещё', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Сбросить миграцию' }).click();
    return page.getByRole('dialog', { name: 'Сбросить миграцию alpha-service?' });
  };
  let confirm = await discard();
  await confirm.getByText(/Заметки, которые Claude написал в пачках, будут удалены/).waitFor();
  await confirm.getByRole('button', { name: 'Отмена', exact: true }).click();
  await confirm.waitFor({ state: 'hidden' });
  assert.deepEqual(wikiCalls(), [], 'cancel sends nothing');

  confirm = await discard();
  await confirm.getByRole('button', { name: 'Сбросить', exact: true }).click();
  await dialog(page).getByRole('button', { name: 'Начать', exact: true }).waitFor();
  assert.deepEqual(wikiCalls().map((c) => `${c.method} ${c.path}`), ['DELETE /api/memory/wiki/alpha-service']);
});
