// The files panel of a work tab: the root path bar, moving the root up and back, and a tree that refreshes without flashing.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import type { Tab } from '../shared/contract.ts';
import { startServer, type TestServer } from '../server/chat/fixtures/harness.ts';

let srv: TestServer;
let browser: Browser;
let page: Page;
let work: string;
let tabId: string;
const errors: string[] = [];

before(async () => {
  srv = await startServer();
  work = join(srv.dir, 'work');
  mkdirSync(join(work, 'src'), { recursive: true });
  writeFileSync(join(work, 'src', 'a.ts'), 'export const a = 1;\n');
  writeFileSync(join(work, 'README.md'), '# hi\n');
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  ctx.setDefaultTimeout(15_000);
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const token = readFileSync(join(srv.dataDir, 'token'), 'utf8').trim();
  await page.goto(`http://127.0.0.1:${srv.port}/auth?token=${token}`);
  const res = await srv.api<Tab>('POST', '/api/tabs', { cwd: work, title: 'файлы' });
  assert.equal(res.status, 200);
  tabId = res.body.id;
  await page.evaluate((id) => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'tab', id })), tabId);
  await page.reload();
});

after(async () => {
  await browser?.close();
  await srv?.destroy();
  assert.deepEqual(errors, []);
});

const panel = () => page.getByRole('navigation', { name: 'Файлы проекта' });
const bar = () => page.getByTestId('files-root');
const row = (path: string) => page.locator(`[data-file-row="${path}"]`);
const up = () => page.getByRole('button', { name: 'Папка выше' });
const back = () => page.getByRole('button', { name: 'Вернуться к папке сессии' });
// The app's tooltip takes the title off a hovered element: the pointer leaves the bar before it is read.
const at = async (path: string) => {
  await page.mouse.move(800, 990);
  await bar().and(page.locator(`[title="${path}"]`)).waitFor();
};

test('the panel shows the folder it lists from, with the full path in the tooltip', async () => {
  await row('README.md').waitFor();
  await at(work);
  const text = (await bar().innerText()).replace(/\s+/g, '');
  assert.ok(text.endsWith(`/${basename(srv.dir)}/work`), text);
  assert.equal(await back().count(), 0, 'no way back while at the session folder');
});

test('up lists the parent without touching the session, a crumb and the back button return', async () => {
  await up().click();
  await row(`${srv.dir}/work`).waitFor();
  await at(srv.dir);
  assert.equal((await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tabId)?.cwd, work, 'the session keeps its cwd');

  // A file outside the session folder opens by its absolute path.
  await row(`${srv.dir}/work`).getByRole('button', { name: 'work' }).click();
  await row(`${srv.dir}/work/README.md`).getByRole('button', { name: 'README.md' }).click();
  assert.equal(await page.getByTestId('file-code').innerText(), '# hi\n');

  await back().click();
  await row('README.md').waitFor();
  await at(work);

  // A crumb near the end (the start of a long path is cut off), then up to the highest readable folder: there it stops.
  await bar().getByRole('button', { name: basename(srv.dir) }).click();
  await at(srv.dir);
  assert.equal(dirname(srv.dir), '/tmp', 'the harness works under /tmp, a read-only root');
  await up().click();
  await at('/tmp');
  assert.equal(await up().isDisabled(), true);
  await back().click();
  await row('README.md').waitFor();
});

test('an open folder refreshes without a skeleton, and the tree follows a file change inside a running turn', async () => {
  const src = row('src').getByRole('button', { name: 'src' });
  if ((await src.getAttribute('aria-expanded')) !== 'true') await src.click();
  await row('src/a.ts').waitFor();
  // Count every skeleton that shows up in the panel from here on.
  await panel().evaluate((nav) => {
    const w = window as unknown as { skeletons: number };
    w.skeletons = 0;
    new MutationObserver(() => { if (nav.querySelector('[aria-busy="true"]')) w.skeletons++; }).observe(nav, { childList: true, subtree: true });
  });
  const skeletons = () => page.evaluate(() => (window as unknown as { skeletons: number }).skeletons);
  const tops = async () => (await row('src/a.ts').boundingBox())!.y;
  const before = await tops();

  writeFileSync(join(work, 'src', 'b.ts'), 'b\n');
  await page.getByRole('button', { name: 'Обновить' }).click();
  await row('src/b.ts').waitFor();
  assert.equal(await tops(), before, 'rows stay where they were');

  // Closing and opening again shows the cached rows at once.
  await src.click();
  await row('src/a.ts').waitFor({ state: 'detached' });
  await src.click();
  await row('src/b.ts').waitFor();
  assert.equal(await skeletons(), 0, 'no skeleton on refresh or reopen');

  // The fake runs a command, the file appears, and the turn stays running until the hold file exists.
  const gate = join(srv.dir, 'gate-files');
  const hold = join(srv.dir, 'hold-files');
  const box = page.getByRole('textbox', { name: /Сообщение/ }).first();
  await box.fill(`BASHHOLD ${gate} ${hold} touch src/c.ts`);
  await page.getByRole('button', { name: /^(Отправить|В очередь)$/ }).click();
  await page.getByText('touch src/c.ts').first().waitFor();
  writeFileSync(join(work, 'src', 'c.ts'), 'c\n');
  writeFileSync(gate, '');
  await row('src/c.ts').waitFor();
  assert.equal((await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === tabId)?.status, 'working', 'refreshed by the tool result, not the end of the turn');
  writeFileSync(hold, '');
  await page.getByText('command done').waitFor();
  assert.equal(await skeletons(), 0);
});

test('a row has no tag button: tagging and opening a folder as the root live in its right-click menu', async () => {
  const menu = page.locator('[data-context-menu]');
  const rightClick = (path: string) => row(path).evaluate((el) => {
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 4, clientY: r.top + 4 }));
  });
  await row('README.md').waitFor();
  assert.equal(await row('README.md').getByRole('button', { name: 'Тегнуть в чат' }).count(), 0, 'no tag button on the row');

  await rightClick('README.md');
  await menu.getByRole('menuitem', { name: 'Тегнуть в чат' }).waitFor();
  assert.equal(await menu.getByRole('menuitem', { name: 'Открыть как корень' }).count(), 0, 'a file is no root');
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'detached' });

  await rightClick('src');
  await menu.getByRole('menuitem', { name: 'Тегнуть в чат' }).waitFor();
  await menu.getByRole('menuitem', { name: 'Открыть как корень' }).click();
  await row(`${work}/src/a.ts`).waitFor();
  await at(join(work, 'src'));
  await back().click();
  await row('README.md').waitFor();
});
