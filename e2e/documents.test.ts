// The documents with the real server and the fake Claude CLI, in throwaway directories: the documents here are saved by
// the real MCP tools, in a real tab, and nothing reaches the live data.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { seedSetupDone } from '../server/chat/fixtures/harness.ts';
import type { DocumentInfo, Tab } from '../shared/contract.ts';

const REPO = join(import.meta.dirname, '..');
const PORT = 47977;
const base = `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.CLAUDE_OS_SHOTS;
let dir: string;
let server: ChildProcess;
let browser: Browser;
let page: Page;
let workTab: Tab;
let report: DocumentInfo;
let hostile: DocumentInfo;
const errors: string[] = [];

// The shipped template, filled in the way the knowledge file asks.
function sampleReport(): string {
  const knowledge = readFileSync(join(REPO, 'root/document-knowledge/standard.md'), 'utf8');
  const skeleton = /```html\n([\s\S]*?)```/.exec(knowledge)![1];
  return skeleton
    .replace('<title>Title</title>', '<title>Система документов</title>')
    .replace('<h1>Subject of the document</h1>', '<h1>Система документов</h1>')
    .replace('9 November 2026 · project', '7 ноября 2026 · Claude OS')
    .replace('The main point in one or two sentences.', 'Отчёты, планы и документация теперь лежат в одной базе и открываются во вкладке. Claude строит каждый документ по файлу знаний.')
    .replace('<h2>Section</h2>', '<h2 id="done">База документов</h2>')
    .replace('<p>What was asked.</p>', '<p>Хранить отчёты как HTML и открывать их во вкладке.</p>')
    .replace('<p>What works differently now.</p>', `<p>Файлы лежат в <code>data/documents</code>, скрипты в них не выполняются.</p>${'<p>Строка для прокрутки документа, чтобы ссылка внутри него была заметна.</p>'.repeat(30)}`)
    .replace('<li>Open the <b>screen</b>, press the <b>button</b>. This and that should be visible.</li>', '<li>Откройте меню справа вверху, пункт <b>Документы</b>. Должна открыться галерея с миниатюрами.</li><li>Нажмите на карточку. Документ откроется отдельной вкладкой.</li><li>Нажмите <b>Править с Claude</b> и попросите заменить заголовок. <a href="#done">К началу раздела</a></li>');
}

const api = <T>(path: string, init?: { method?: string; body?: unknown }) => page.evaluate(async ({ path, init }) => {
  const res = await fetch(path, { method: init?.method ?? 'GET', headers: init?.body ? { 'content-type': 'application/json' } : undefined, body: init?.body ? JSON.stringify(init.body) : undefined });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path}: ${res.status} ${text}`);
  return JSON.parse(text);
}, { path, init }) as Promise<T>;

const send = (tabId: string, text: string) => api(`/api/tabs/${encodeURIComponent(tabId)}/send`, { method: 'POST', body: { text } });

async function until<T>(what: string, read: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

const documents = () => api<DocumentInfo[]>('/api/documents');

// Through the tool, in a turn of the fake CLI: the same way a session of Claude saves one.
async function saveThroughTool(input: Record<string, unknown>): Promise<DocumentInfo> {
  const before = (await documents()).length;
  await send(workTab.id, `MCP save_document ${JSON.stringify(input)}`);
  return until(`document "${String(input.title)}"`, async () => {
    const docs = await documents();
    return docs.length > before ? docs.find((d) => d.title === input.title) : null;
  });
}

const shot = async (name: string) => {
  // A picture for looking at, not a check: a loaded machine must not fail the test over it.
  if (SHOTS) await page.screenshot({ path: join(SHOTS, `${name}.png`), timeout: 60_000 }).catch(() => {});
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-os-documents-'));
  mkdirSync(join(dir, 'claude/projects'), { recursive: true });
  mkdirSync(join(dir, 'proj-alpha'), { recursive: true });
  mkdirSync(join(dir, 'proj-beta'), { recursive: true });
  seedSetupDone(join(dir, 'config'));
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(REPO, 'server/index.ts')], {
    stdio: 'ignore',
    env: {
      ...process.env,
      CLAUDE_OS_PORT: String(PORT),
      CLAUDE_OS_IDLE_EXIT_MS: '0',
      CLAUDE_OS_DATA: join(dir, 'data'),
      CLAUDE_OS_CONFIG: join(dir, 'config'),
      CLAUDE_OS_VAULT: join(dir, 'vault'),
      CLAUDE_CONFIG_DIR: join(dir, 'claude'),
      CLAUDE_OS_CLAUDE_BIN: join(REPO, 'server/chat/fixtures/fake-claude.mjs'),
      FAKE_CLAUDE_LOG: join(dir, 'fake.log'),
    },
  });
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const token = readFileSync(join(dir, 'data/token'), 'utf8').trim();
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  page = await (await browser.newContext({ locale: 'ru-RU', viewport: { width: 1500, height: 950 }, reducedMotion: 'reduce' })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/auth?token=${token}`);
  await page.waitForLoadState('domcontentloaded');

  workTab = await api<Tab>('/api/tabs', { method: 'POST', body: { cwd: join(dir, 'proj-alpha'), title: 'Рабочая' } });
  const otherTab = await api<Tab>('/api/tabs', { method: 'POST', body: { cwd: join(dir, 'proj-beta'), title: 'Другая' } });
  const beta = otherTab.project;
  await send(workTab.id, 'MCP read_document_knowledge {"id":"standard"}');
  await until('the turn to end', async () => (await api<Tab[]>('/api/tabs')).find((t) => t.id === workTab.id)?.status === 'idle');

  report = await saveThroughTool({ title: 'Система документов', knowledge: 'standard', kind: 'report', summary: 'Отчёты и планы в одной базе', html: sampleReport() });
  hostile = await saveThroughTool({
    title: 'Враждебный документ',
    knowledge: 'standard',
    kind: 'report',
    project: beta,
    html: `<!doctype html><html><head><meta http-equiv="refresh" content="0;url=https://example.com/"><style>body{background:#fff;color:#111}</style></head><body>
      <h1>Жираф и его тайны</h1>
      <p id="mark">Текст</p>
      <script>try { window.parent.document.title = 'HACKED'; } catch {} document.getElementById('mark').textContent = 'script ran';</script>
      <img src="x" onerror="window.parent.document.title='HACKED'">
      <a id="out" href="https://example.com/">наружу</a> <a id="bad" href="/api/documents">внутрь</a>
      <form action="/api/app/shutdown" method="post"><button id="send">Послать</button></form>
    </body></html>`,
  });
  await api('/api/tabs/' + encodeURIComponent(otherTab.id), { method: 'DELETE' });
});

after(async () => {
  await browser?.close();
  server?.kill();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const openLibrary = async () => {
  await page.getByRole('button', { name: 'Меню', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Документы' }).click();
  await page.getByRole('heading', { name: 'Документы' }).waitFor();
};

test('the tools reach a tab without a prompt, and the document lands in its project', async () => {
  assert.equal(report.project, workTab.project);
  assert.equal(report.kind, 'report');
  assert.equal(report.knowledge, 'standard');
  assert.notEqual(hostile.project, report.project);
  const spawned = readFileSync(join(dir, 'fake.log'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as { kind: string; argv?: string[]; cwd?: string }).find((l) => l.kind === 'spawn' && l.cwd === join(dir, 'proj-alpha'));
  const allowed = spawned!.argv!.find((a) => a.startsWith('--allowedTools='))!;
  for (const name of ['list_documents', 'save_document', 'read_document_knowledge', 'create_document_knowledge']) assert.ok(allowed.includes(`mcp__claude-os__${name}`), name);
});

test('the library: a menu item, groups by project, real thumbnails', async () => {
  await openLibrary();
  await page.locator(`[data-document="${report.id}"]`).waitFor();
  assert.equal(await page.locator('[data-document]').count(), 2);
  assert.equal(await page.getByRole('heading', { level: 2 }).count(), 2);
  await page.waitForTimeout(1200);
  // The thumbnail goes over the real route: the auth cookie must reach a sandboxed frame.
  const thumb = page.frameLocator(`[data-document="${report.id}"] iframe`).locator('h1');
  await thumb.waitFor({ timeout: 10_000 });
  assert.equal(await thumb.textContent(), 'Система документов');
  await shot('library');
});

test('the library: search over text, filters, grouping', async () => {
  const search = page.getByRole('textbox', { name: 'Поиск по названию и тексту' });
  await search.fill('жираф');
  await page.locator(`[data-document="${report.id}"]`).waitFor({ state: 'detached' });
  assert.equal(await page.locator('[data-document]').count(), 1);
  await page.getByText('тайны').first().waitFor();
  await search.fill('рациональное число');
  await page.getByText('Ничего не найдено').waitFor();
  await search.fill('');
  await page.locator(`[data-document="${report.id}"]`).waitFor();

  await page.getByRole('combobox', { name: 'Группировка' }).click();
  await page.getByRole('option', { name: 'По видам' }).click();
  await page.getByRole('heading', { name: /^Отчёт/ }).waitFor();
  assert.equal(await page.getByRole('heading', { level: 2 }).count(), 1);

  await page.getByRole('combobox', { name: 'Проект' }).click();
  await page.getByRole('option', { name: 'Не про один проект' }).click();
  await page.getByText('Ничего не найдено').waitFor();
  await page.getByRole('combobox', { name: 'Проект' }).click();
  await page.getByRole('option', { name: 'Все проекты' }).click();
  await page.locator('[data-document]').first().waitFor();
  await page.getByRole('combobox', { name: 'Группировка' }).click();
  await page.getByRole('option', { name: 'По проектам' }).click();
});

test('the knowledge pane: the shipped file, readable and changeable, the original comes back', async () => {
  await page.getByRole('radio', { name: 'Файлы знаний' }).click();
  // The shipped file is English; the Russian UI shows its Russian name.
  await page.locator('[data-knowledge="standard"]').getByText('Стандартный', { exact: true }).waitFor();
  await page.locator('[data-knowledge="standard"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: 'Structure' }).waitFor();
  await shot('knowledge');
  await dialog.getByRole('button', { name: 'Редактировать' }).click();
  const text = dialog.getByRole('textbox', { name: 'Текст файла знаний' });
  await text.fill('---\nname: Мой отчёт\nkind: report\ndescription: своё\n---\nСвои правила\n');
  await dialog.getByRole('button', { name: 'Сохранить' }).click();
  await dialog.getByText('Свои правила').waitFor();
  await dialog.getByRole('button', { name: 'Вернуть исходный' }).click();
  await dialog.getByRole('heading', { name: 'Structure' }).waitFor();
  await page.keyboard.press('Escape');
  await page.getByRole('radio', { name: 'Документы' }).click();
});

test('opening: one tab per document, with the page in a frame that has no way out', async () => {
  await page.locator(`[data-document="${hostile.id}"]`).click();
  const frame = page.getByTestId('document-frame');
  await frame.waitFor();
  assert.equal(await page.getByRole('tab', { name: /Враждебный документ/ }).count(), 1);

  assert.equal(await frame.getAttribute('sandbox'), 'allow-popups allow-popups-to-escape-sandbox');
  const inside = page.frameLocator('[data-testid="document-frame"]');
  await inside.locator('h1').waitFor();
  assert.equal(await inside.locator('#mark').textContent(), 'Текст', 'its script did not run');
  assert.equal(await page.title() === 'HACKED', false);
  assert.equal(await inside.locator('script, form, meta[http-equiv="refresh"]').count(), 0);
  assert.equal(await inside.locator('#out').getAttribute('target'), '_blank');
  assert.equal(await inside.locator('#bad').getAttribute('href'), null);
  // The parent cannot look in, so a script could not look out: an opaque origin.
  assert.equal(await page.evaluate(() => { try { return document.querySelector<HTMLIFrameElement>('[data-testid="document-frame"]')!.contentDocument === null; } catch { return true; } }), true);
  await page.waitForTimeout(400);
  assert.ok(!page.url().includes('example.com'));
  await inside.locator('h1').waitFor();

  await page.getByRole('tab', { name: /Заголовки|Рабочая/ }).first().click();
  await page.evaluate(() => 0);
  const tabs = await api<Tab[]>('/api/tabs');
  const again = await api<Tab>(`/api/documents/${encodeURIComponent(hostile.id)}/tab`, { method: 'POST' });
  assert.ok(tabs.some((t) => t.id === again.id));
  assert.equal(tabs.filter((t) => t.document === hostile.id).length, 1);
  assert.equal(again.kind, 'document');
  assert.equal(again.sessionId, null, 'reading starts no session');
});

test('the raw HTML opened by hand runs nothing and has no origin of the app', async () => {
  const other = await browser.contexts()[0].newPage();
  await other.goto(`${base}/api/documents/${encodeURIComponent(hostile.id)}/html`);
  assert.equal(await other.evaluate(() => location.origin === 'null' || origin === 'null'), true);
  assert.equal(await other.locator('#mark').textContent(), 'Текст');
  await other.close();
});

test('the chat beside the document: hidden, shown, and its saves replace the page', async () => {
  await page.evaluate(async (id) => { await fetch(`/api/documents/${encodeURIComponent(id)}/tab`, { method: 'POST' }); }, report.id);
  const reportTab = (await api<Tab[]>('/api/tabs')).find((t) => t.document === report.id)!;
  await page.getByRole('tab', { name: /Система документов/ }).click();
  const frame = page.frameLocator('[data-testid="document-frame"]');
  await frame.locator('h1').waitFor();
  const chat = page.getByTestId('document-chat');
  assert.equal(await chat.isVisible(), false);
  await page.waitForTimeout(400);
  await shot('document');

  // A link inside the document moves within the document.
  await frame.locator('a[href="#done"]').click();
  await frame.locator('#done').waitFor();
  await frame.locator('h1').waitFor();

  await page.getByRole('button', { name: 'Править с Claude' }).click();
  await chat.getByText('Своя сессия этого документа').waitFor();
  await page.waitForTimeout(350);
  await shot('document-chat');

  await send(reportTab.id, 'MCP patch_document ' + JSON.stringify({ id: report.id, find: '<h1>Система документов</h1>', replace: '<h1>Другое имя</h1>' }));
  await frame.getByRole('heading', { name: 'Другое имя' }).waitFor({ timeout: 15_000 });

  const log = readFileSync(join(dir, 'fake.log'), 'utf8');
  assert.ok(log.includes('list_document_knowledge') && log.includes('read_document') && log.includes('@document <id>'), 'every session is told about documents');
  assert.ok(log.includes(`open for the Claude OS document with id \`${report.id}`), 'its own tab knows which one');

  await page.getByRole('button', { name: 'Править с Claude' }).click();
  await chat.waitFor({ state: 'hidden' });
  assert.equal((await api<DocumentInfo>(`/api/documents/${encodeURIComponent(report.id)}`)).version, 2);
  await page.getByRole('button', { name: 'Править с Claude' }).click();
});

test('a save in a chat leaves a card that opens the document', async () => {
  await send(workTab.id, 'CALL ' + JSON.stringify({ name: 'mcp__claude-os__save_document', input: { title: 'Система документов' }, result: JSON.stringify({ id: report.id, title: 'Система документов' }) }));
  await page.getByRole('tab', { name: /Рабочая/ }).click();
  const card = page.locator(`[data-document-link="${report.id}"]`);
  await card.waitFor({ timeout: 15_000 });
  await shot('chat-card');
  await card.click();
  await page.getByRole('tab', { name: /Другое имя|Система документов/, selected: true }).waitFor();
});

test('the @ menu of a chat has a section of documents', async () => {
  await page.getByRole('tab', { name: /Рабочая/ }).click();
  const box = page.getByRole('textbox').last();
  await box.click();
  await box.pressSequentially('@');
  const list = page.getByRole('listbox');
  const section = list.getByRole('option').filter({ hasText: /^Документ/ });
  await section.waitFor();
  await section.click();
  const inside = page.getByRole('listbox', { name: 'Документ', exact: true });
  await inside.getByRole('option', { name: /Враждебный документ/ }).click();
  assert.match(await box.inputValue(), new RegExp(`^@document ${hostile.id} «Враждебный документ» $`));
  await box.fill('');
});

test('a link in any chat opens the document in its tab', async () => {
  await send(workTab.id, `SAY Готово: [Посмотреть отчёт](/documents/${encodeURIComponent(hostile.id)})`);
  await page.getByRole('tab', { name: /Рабочая/ }).click();
  const link = page.getByRole('link', { name: 'Посмотреть отчёт' });
  await link.waitFor({ timeout: 15_000 });
  await link.click();
  await page.getByRole('tab', { name: /Враждебный документ/, selected: true }).waitFor();
  await page.frameLocator('[data-testid="document-frame"]').locator('h1').waitFor();
});

test('a bar in the menu: export asks first, then goes through the session; the link comes back', async () => {
  await page.getByRole('tab', { name: /Система документов/ }).click();
  await page.getByRole('button', { name: 'Меню документа' }).click();
  await shot('document-menu');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Скачать HTML' }).click()]);
  assert.match(download.suggestedFilename(), /\.html$/);
  await page.getByRole('button', { name: 'Меню документа' }).click();
  await page.getByRole('menuitem', { name: 'Выгрузить в Artifacts' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('уйдёт в ваш аккаунт').waitFor();
  await dialog.getByRole('button', { name: 'Выгрузить', exact: true }).click();
  const chat = page.getByTestId('document-chat');
  await chat.getByText('set_document_share').first().waitFor({ timeout: 15_000 });
  await until('the turn to end', async () => (await api<Tab[]>('/api/tabs')).find((t) => t.document === report.id)?.status === 'idle');

  // The fake session has no connector: what a real one does at the end of the job.
  const tab = (await api<Tab[]>('/api/tabs')).find((t) => t.document === report.id)!;
  await send(tab.id, 'MCP set_document_share ' + JSON.stringify({ id: report.id, url: 'https://claude.ai/artifact/test' }));
  await page.getByRole('link', { name: 'В claude.ai' }).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Меню документа' }).click();
  await page.getByRole('menuitem', { name: 'Скопировать ссылку claude.ai' }).waitFor();
  await page.keyboard.press('Escape');
});

test('deleting: the tab goes with it, and the library shows what is left', async () => {
  await page.getByRole('button', { name: 'Меню документа' }).click();
  await page.getByRole('menuitem', { name: 'Удалить' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить' }).click();
  await page.getByRole('heading', { name: 'Документы' }).waitFor();
  await page.locator(`[data-document="${report.id}"]`).waitFor({ state: 'detached' });
  await page.getByRole('tab', { name: /Другое имя|Система документов/ }).waitFor({ state: 'detached' });
  assert.deepEqual(errors, []);
});
