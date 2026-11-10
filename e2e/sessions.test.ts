// The sessions list against e2e/fixture-server.ts: no real server, no Claude, no real process is signalled.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { startServer } from '../server/chat/fixtures/harness.ts';
import { defaultFixture, startFixture, type FixtureServer } from './fixture-server.ts';

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

async function open(data = defaultFixture()): Promise<Page> {
  fx = await startFixture(data);
  ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU', reducedMotion: 'reduce' });
  await ctx.addInitScript(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'sessions' })));
  ctx.setDefaultTimeout(20000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  await page.getByText('Правка вёрстки формы оплаты').waitFor();
  return page;
}

const posted = (path: string) => fx!.calls.filter((c) => c.path === path).length;
const viewNow = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('claude-os.view')!) as { kind: string; id?: string });

test('root, service and Claude OS sessions stand out by name and colour; the rest stay plain', async () => {
  const data = defaultFixture();
  const plain = data.sessions[0];
  data.sessions.push(
    { ...plain, id: 's-root', title: 'Корень', project: null, rootFolder: true, status: 'ended' },
    { ...plain, id: 's-service', title: 'Раскладка', project: null, serviceFolder: true, status: 'ended' },
    { ...plain, id: 's-os', title: 'Правка ядра', project: null, osChanges: { user: 0, root: 2 }, status: 'ended' },
  );
  const page = await open(data);
  const row = (title: string) => page.locator('.border-b.border-line2', { has: page.getByText(title, { exact: true }) }).first();
  await row('Корень').getByText('Корневая').waitFor();
  await row('Раскладка').getByText('Служебная').waitFor();
  assert.match((await row('Корень').getAttribute('class'))!, /session-stripe-root/);
  assert.match((await row('Раскладка').getAttribute('class'))!, /session-stripe-service/);
  assert.match((await row('Правка ядра').getAttribute('class'))!, /session-stripe-os/);
  assert.doesNotMatch((await row(plain.title!).getAttribute('class'))!, /session-stripe/);
});

test('stop asks first, signals only after the confirmation, the row then says ended', async () => {
  const page = await open();
  await page.getByRole('button', { name: 'Действия с сессией «Перенос очереди на новый брокер»' }).click();
  const menu = page.getByRole('menu');
  assert.equal(await menu.getByRole('menuitem', { name: 'Удалить' }).isDisabled(), true, 'a live session cannot be deleted');
  await menu.getByRole('menuitem', { name: 'Остановить' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByText('Перенос очереди на новый брокер').waitFor();
  assert.equal(posted('/api/sessions/s-live/stop'), 0);
  await dialog.getByRole('button', { name: 'Отмена' }).click();
  assert.equal(posted('/api/sessions/s-live/stop'), 0);

  await page.getByRole('button', { name: 'Действия с сессией «Перенос очереди на новый брокер»' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Остановить' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Остановить' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(posted('/api/sessions/s-live/stop'), 1);
  await page.getByText('живых 1').waitFor();
});

test('delete by right click: the dialog names what goes, nothing happens until the button', async () => {
  const page = await open();
  await page.getByText('Правка вёрстки формы оплаты').click({ button: 'right' });
  const menu = page.locator('[data-context-menu]');
  assert.equal(await menu.getByRole('menuitem', { name: 'Остановить' }).isDisabled(), true, 'an ended session has nothing to stop');
  assert.equal(await menu.getByRole('menuitem', { name: 'Починить с Claude' }).count(), 0, 'an ended session is not stuck');
  await menu.getByRole('menuitem', { name: 'Удалить' }).click();

  const dialog = page.getByRole('dialog');
  await dialog.getByText('/home/test/.claude/projects/-home-test-beta-web/s-ended.jsonl').waitFor();
  await dialog.getByText('Журнал сессии').waitFor();
  await dialog.getByText(/отмены нет/).waitFor();
  await dialog.getByText(/\/home\/test\/claude-os\/data\/trash/).waitFor();
  assert.equal(posted('/api/sessions/s-ended/remove'), 0);

  await dialog.getByRole('button', { name: 'Удалить' }).click();
  await dialog.waitFor({ state: 'detached' });
  await page.getByText('Правка вёрстки формы оплаты').waitFor({ state: 'detached' });
  assert.deepEqual(fx!.calls.find((c) => c.path === '/api/sessions/s-ended/remove')?.body, { confirm: 's-ended' });
});

test('fix with Claude: the context carries id, cwd and status, nothing is sent until the button', async () => {
  const page = await open();
  await page.getByText('Рефакторинг конфигурации').click({ button: 'right' });
  await page.locator('[data-context-menu]').getByRole('menuitem', { name: 'Починить с Claude' }).click();
  const dialog = page.getByRole('dialog');
  const prompt = dialog.locator('pre');
  await prompt.getByText(/Session id: s-tab/).waitFor();
  const text = await prompt.textContent();
  assert.match(text!, /Working directory: \/home\/test\/alpha-service/);
  assert.match(text!, /Status: waiting_permission/);
  assert.equal(fx!.calls.filter((c) => c.path.endsWith('/send')).length, 0);
  await dialog.getByRole('button', { name: 'Отмена' }).click();
});

test('the waiting counter lists exactly who needs an answer and a row goes to its tab', async () => {
  const page = await open();
  await page.getByRole('button', { name: 'ждут ответа: 1' }).click();
  await page.getByRole('radio', { name: 'Ждут ответа' }).waitFor();
  assert.equal(await page.getByRole('radio', { name: 'Ждут ответа' }).getAttribute('aria-checked'), 'true');
  await page.getByText('Правка вёрстки формы оплаты').waitFor({ state: 'detached' });
  await page.getByText('Перенос очереди на новый брокер').waitFor({ state: 'detached' });
  await page.getByText('Ответ ждут во вкладке «alpha-service»').waitFor();

  await page.getByText('Рефакторинг конфигурации').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('claude-os.view')!).id === 't1');
  assert.equal(posted('/api/tabs'), 0, 'its tab already exists');
});

test('a waiting session with no tab opens one, and says the answer is elsewhere', async () => {
  const data = defaultFixture();
  data.sessions.find((s) => s.id === 's-ended')!.status = 'blocked';
  const page = await open(data);
  await page.getByRole('button', { name: 'ждут ответа: 2' }).click();
  await page.getByText(/Запущена вне Claude OS/).waitFor();
  await page.getByText('Правка вёрстки формы оплаты').click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('claude-os.view')!).kind === 'tab');
  const tab = fx!.calls.find((c) => c.path === '/api/tabs' && c.method === 'POST');
  assert.deepEqual((tab?.body as { resumeSessionId: string; readonly: boolean }), { resumeSessionId: 's-ended', readonly: true, project: 'beta-web', cwd: '/home/test/beta-web' });
  assert.equal((await viewNow(page)).kind, 'tab');
});

test('subagents now: a badge only above zero, for a terminal session too, leading to their view', async () => {
  // The folder exists from the start: the server's watcher then sees the journals at once, not on its minute sweep.
  const configDir = mkdtempSync(join(tmpdir(), 'claude-os-agents-'));
  mkdirSync(join(configDir, 'projects'));
  const srv = await startServer({ CLAUDE_CONFIG_DIR: configDir });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU', reducedMotion: 'reduce' });
  try {
    const cwd = mkdtempSync(join(srv.dir, 'w-'));
    const busy = '11111111-1111-4111-8111-111111111111';
    const quiet = '22222222-2222-4222-8222-222222222222';
    const journals = join(configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
    mkdirSync(join(journals, busy, 'subagents'), { recursive: true });
    const line = (id: string, content: string) => `${JSON.stringify({ type: 'user', uuid: `u-${id}`, sessionId: id, cwd, timestamp: new Date().toISOString(), message: { role: 'user', content } })}\n`;
    writeFileSync(join(journals, `${busy}.jsonl`), line(busy, 'занятая сессия'));
    writeFileSync(join(journals, `${quiet}.jsonl`), line(quiet, 'тихая сессия'));
    const agent = (id: string, description: string, stop: string | null) => {
      const path = join(journals, busy, 'subagents', `agent-${id}`);
      writeFileSync(`${path}.meta.json`, JSON.stringify({ agentType: 'Explore', description, toolUseId: `toolu_${id}` }));
      writeFileSync(`${path}.jsonl`, `${JSON.stringify({ type: 'user', uuid: `a-${id}`, timestamp: new Date().toISOString(), message: { role: 'user', content: 'go' } })}\n${JSON.stringify({ type: 'assistant', uuid: `b-${id}`, timestamp: new Date().toISOString(), message: { id: `m-${id}`, role: 'assistant', content: [{ type: 'tool_use', id: `t-${id}`, name: 'Read', input: { file_path: '/x/a.ts' } }], stop_reason: stop } })}\n`);
    };
    agent('a1', 'Ищет первое', null);
    agent('a2', 'Ищет второе', null);
    agent('a3', 'Уже закончил', 'end_turn');

    // A terminal: the CLI's registry with a pid that is alive, no tab of ours.
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'latin1');
    const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    mkdirSync(join(configDir, 'sessions'), { recursive: true });
    writeFileSync(join(configDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, procStart, sessionId: busy, cwd, status: 'busy', kind: 'interactive', updatedAt: Date.now() }));

    await context.addInitScript(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'sessions' })));
    context.setDefaultTimeout(20000);
    const page = await context.newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${srv.port}/auth?token=${readFileSync(join(srv.dataDir, 'token'), 'utf8').trim()}`);
    await page.getByText(quiet).waitFor(); // these journals carry no title, the row shows the id

    const badge = page.locator('button[title^="Субагентов работает сейчас: 2"]');
    await badge.waitFor();
    assert.equal(await page.locator('button[title^="Субагентов работает сейчас"]').count(), 1, 'none for the quiet session');
    assert.equal(await badge.textContent(), '2');

    await badge.click();
    const strip = page.getByRole('group', { name: 'Подагенты за работой' }).first();
    await strip.getByText('Ищет первое').waitFor();
    await strip.getByText('Ищет второе').waitFor();
    assert.equal(await strip.getByText('Уже закончил').count(), 0);
    await strip.getByText('Ищет первое').click();
    await page.getByRole('dialog', { name: 'Ищет первое' }).waitFor();
    assert.equal(await page.getByRole('dialog').count(), 1);
    await page.keyboard.press('Escape');

    // Measured as the screen asks it: the whole list stays cheap with one live session among many.
    const sessionsDir = join(journals);
    for (let i = 0; i < 3000; i++) {
      const id = `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`;
      writeFileSync(join(sessionsDir, `${id}.jsonl`), line(id, `старая ${i}`));
    }
    const cookie = `claude_os=${readFileSync(join(srv.dataDir, 'token'), 'utf8').trim()}`;
    const url = `http://127.0.0.1:${srv.port}/api/sessions`;
    for (let i = 0; i < 400; i++) {
      const listed = await (await fetch(url, { headers: { cookie } })).json() as unknown[];
      if (listed.length >= 3000) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const at = performance.now();
    for (let i = 0; i < 20; i++) assert.deepEqual(await (await fetch(`${url}/active-subagents`, { headers: { cookie } })).json(), { [busy]: 2 });
    console.log(`active-subagents with 3000+ sessions: ${((performance.now() - at) / 20).toFixed(1)} ms per request`);
  } finally {
    await context.close();
    await srv.destroy();
    rmSync(configDir, { recursive: true, force: true });
  }
});

test('english strings are there', async () => {
  const data = defaultFixture();
  fx = await startFixture(data);
  ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', reducedMotion: 'reduce' });
  await ctx.addInitScript(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'sessions' })));
  ctx.setDefaultTimeout(20000);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(fx.url);
  await page.getByRole('button', { name: 'Actions for the session “Рефакторинг конфигурации”' }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Fix with Claude' }).waitFor();
  await page.getByRole('menu').getByRole('menuitem', { name: 'Delete' }).waitFor();
});
