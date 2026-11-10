// Chat parity with Claude Code: the real server, the fake CLI, a real browser. Needs CLAUDE_OS_WEB_DIST pointing at a fresh build, or dist/web.
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import type { Tab } from '../shared/contract.ts';
import { startServer, waitUntil, type TestServer } from '../server/chat/fixtures/harness.ts';

const SHOTS = join(import.meta.dirname, '..', 'docs', 'screenshots');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const EXTERNAL = '11111111-2222-3333-4444-555555555555';
const EXTERNAL_ENDED = '66666666-2222-3333-4444-555555555555';

let srv: TestServer;
let browser: Browser;
let page: Page;
let work: string;
let external: string;
const errors: string[] = [];

function journalDir(cwd: string): string {
  const dir = join(srv.configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

// A session someone runs in a terminal: a journal, a subagent, and a registry entry pointing at a process that is alive.
function seedExternalSession() {
  external = join(srv.dir, 'external');
  mkdirSync(join(external, '.git'), { recursive: true });
  const dir = journalDir(external);
  const line = (r: object) => JSON.stringify({ uuid: crypto.randomUUID(), sessionId: EXTERNAL, cwd: external, timestamp: new Date().toISOString(), ...r });
  writeFileSync(join(dir, `${EXTERNAL}.jsonl`), [
    line({ type: 'last-prompt', lastPrompt: 'почини сборку снаружи', sessionId: EXTERNAL }),
    line({ type: 'user', message: { role: 'user', content: 'почини сборку снаружи' } }),
    line({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Чиню сборку' }], usage: { input_tokens: 100, output_tokens: 50 } } }),
  ].join('\n') + '\n');
  const agents = join(dir, EXTERNAL, 'subagents');
  mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'agent-aexternal1.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Внешний подагент', toolUseId: 'toolu_ext' }));
  writeFileSync(join(agents, 'agent-aexternal1.jsonl'), [
    line({ type: 'user', isSidechain: true, agentId: 'aexternal1', message: { role: 'user', content: 'найди причину' } }),
    line({ type: 'assistant', isSidechain: true, agentId: 'aexternal1', message: { id: 'm2', role: 'assistant', model: 'claude-x', content: [{ type: 'text', text: 'Причина найдена внутри' }], usage: { input_tokens: 10, output_tokens: 5 } } }),
  ].join('\n') + '\n');
  const stat = readFileSync(`/proc/${process.pid}/stat`, 'latin1');
  const procStart = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  mkdirSync(join(srv.configDir, 'sessions'), { recursive: true });
  writeFileSync(join(srv.configDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: EXTERNAL, cwd: external, status: 'busy', kind: 'interactive', procStart, startedAt: Date.now() - 1000, updatedAt: Date.now() }));
}

before(async () => {
  mkdirSync(SHOTS, { recursive: true });
  srv = await startServer();
  work = join(srv.dir, 'work');
  mkdirSync(work);
  execSync('git init -q', { cwd: work });
  seedExternalSession();
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { if (localStorage.getItem('claude-os.focus') === null) localStorage.setItem('claude-os.focus', '0'); }); // these tests read the full tool output; focus has its own in commands.test.ts
  ctx.setDefaultTimeout(15_000);
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const token = readFileSync(join(srv.dataDir, 'token'), 'utf8').trim();
  await page.goto(`http://127.0.0.1:${srv.port}/auth?token=${token}`);
});

after(async () => {
  await browser?.close();
  await srv?.destroy();
  assert.deepEqual(errors, []);
});

async function openWorkTab(cwd = work): Promise<{ id: string; box: ReturnType<Page['getByRole']> }> {
  const res = await srv.api<Tab>('POST', '/api/tabs', { cwd, title: `чат ${Date.now()}` });
  assert.equal(res.status, 200);
  await page.evaluate((id) => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'tab', id })), res.body.id);
  await page.reload();
  const box = page.getByRole('textbox', { name: /Сообщение/ }).first();
  await box.waitFor();
  return { id: res.body.id, box };
}

const say = async (box: ReturnType<Page['getByRole']>, text: string) => {
  await box.fill(text);
  await box.page().getByRole('button', { name: /^(Отправить|В очередь)$/ }).click();
};
const userLog = () => srv.log().filter((l) => l.kind === 'user') as { content: unknown; priority: string | null }[];
const modeLog = () => srv.log().filter((l) => l.kind === 'control' && l.subtype === 'set_permission_mode').map((l) => (l.request as { mode: string }).mode);

test('21: sending from home opens the chat at once and it stays open', async () => {
  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'home' })));
  await page.reload();
  const box = page.getByRole('textbox', { name: /Начни новый проект/ });
  await say(box, 'HOLD 6000');
  // Before the reply exists: the conversation is visible with the message in it.
  await page.getByText('HOLD 6000').first().waitFor();
  assert.equal(await page.getByText('held 6000').count(), 0, 'the message shows before the reply');
  assert.equal(await page.getByRole('button', { name: 'Показать ответ' }).count(), 0);
  await page.getByText('held 6000').waitFor();
  await page.screenshot({ path: join(SHOTS, 'chat-home-open.png') });
});

test('22: queue: edit, remove, send into the running turn, pick up at the next tool boundary', async () => {
  const { id, box } = await openWorkTab();
  const gate = join(srv.dir, 'gate-queue');
  await say(box, `BASHRUN ${gate} sleep 12`);
  await page.getByText('sleep 12').first().waitFor();
  await say(box, 'первое');
  await say(box, 'второе');
  await say(box, 'третье');
  const queue = page.getByLabel('Очередь сообщений');
  await queue.getByText('третье').waitFor();
  assert.equal(userLog().filter((u) => u.content === 'первое').length, 0, 'the server holds them');

  // Edit the first, remove the second.
  await queue.getByRole('button', { name: 'Изменить' }).first().click();
  const edit = page.getByRole('textbox', { name: 'Текст сообщения в очереди' });
  await edit.fill('первое исправленное');
  await edit.press('Enter');
  await queue.getByText('первое исправленное').waitFor();
  await queue.getByRole('button', { name: 'Убрать из очереди' }).nth(1).click();
  await queue.getByText('второе').waitFor({ state: 'detached' });
  await page.screenshot({ path: join(SHOTS, 'chat-queue.png') });

  // Send now: goes to the CLI at once, with the priority that folds it into the running turn.
  await queue.getByRole('button', { name: /Отправить сразу/ }).first().click();
  await waitUntil(() => userLog().some((u) => u.content === 'первое исправленное' && u.priority === 'next'), 'send now reached the CLI');
  writeFileSync(gate, '');
  await page.getByText('folded: первое исправленное').waitFor();
  // The one left waits for the tool boundary and joins the same turn.
  await page.getByText('folded: третье').waitFor();
  await page.getByText('command done').waitFor();
  const results = (await srv.api<{ e: string }[]>('GET', `/api/tabs/${id}/history`)).body.filter((e) => e.e === 'result');
  assert.equal(results.length, 1, 'one turn, nothing cut');
  assert.equal(userLog().filter((u) => u.content === 'второе').length, 0, 'the removed one never went out');
  assert.equal(await queue.count(), 0);
  // The API refuses what Claude already has.
  const gone = await srv.api('DELETE', `/api/tabs/${id}/queue/none`);
  assert.equal(gone.status, 404);
});

test('24: Bash shows the command and its output', async () => {
  const { box } = await openWorkTab();
  await say(box, 'BASHRUN 50 npm run check');
  await page.getByText('line 1').first().waitFor();
  await page.getByText('command done').waitFor();
  await page.getByRole('button', { name: /Bash/ }).first().click();
  await page.getByText('$ npm run check').waitFor();
});

test('24: a running subagent opens into its own live transcript', async () => {
  const { box } = await openWorkTab();
  // The "running" section exists only during the turn: long enough to outlast a page stalled by a loaded software renderer.
  await say(box, 'AGENT 4000');
  const row = page.getByRole('button', { name: /general-purpose/ }).first();
  await row.waitFor();
  await page.getByLabel('Сейчас выполняется').getByText('Fake subagent job').waitFor();
  await row.click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Do the fake job').waitFor();
  await dialog.getByText('работает').waitFor();
  // The journal grows while the view is open.
  await dialog.getByText('echo from-subagent').waitFor();
  await page.screenshot({ path: join(SHOTS, 'chat-subagent.png') });
  await dialog.getByText('SUBAGENT_REPORT done').waitFor();
  await page.keyboard.press('Escape');
  await page.getByText('agent finished').waitFor();
  // The subagent's words stay in its view, not in the conversation.
  assert.equal(await page.getByText('SUBAGENT_REPORT done').count(), 0);
  await page.getByLabel('Сейчас выполняется').waitFor({ state: 'detached' });
});

test('23: every mode, the real current one, Shift+Tab, no-checks with a warning', async () => {
  const { box } = await openWorkTab();
  const select = page.getByRole('button', { name: /Режим разрешений/ });
  const dialog = page.getByRole('dialog', { name: 'Режим разрешений' });
  await select.getByText('Режим из настроек').waitFor();
  await say(box, 'привет');
  await page.getByText('echo: привет').waitFor();
  await select.getByText('Авто').waitFor(); // reported by the CLI

  await select.click();
  for (const name of ['Спрашивать', 'Принимать правки', 'План', 'Авто', 'Только разрешённое', 'Без проверок']) await dialog.getByRole('radio', { name: new RegExp(`^${name}`) }).waitFor();
  await dialog.getByRole('radio', { name: /^План/ }).click();
  await select.getByText('План').waitFor();
  assert.deepEqual(modeLog(), ['plan']);

  await box.focus();
  await page.keyboard.press('Shift+Tab');
  await select.getByText('Авто').waitFor();
  await page.keyboard.press('Shift+Tab');
  await select.getByText('Спрашивать').waitFor();
  await page.keyboard.press('Shift+Tab');
  await select.getByText('Принимать правки').waitFor();
  assert.deepEqual(modeLog(), ['plan', 'auto', 'default', 'acceptEdits']);
  assert.equal(await box.inputValue(), '', 'Shift+Tab types nothing');

  // During a turn it needs a restart, so it is refused and the mode stays what it is.
  const gate = join(srv.dir, 'gate-mode');
  await say(box, `BASHRUN ${gate} sleep 5`);
  await page.getByText('sleep 5').first().waitFor();
  await select.click();
  await dialog.getByRole('radio', { name: /^Без проверок/ }).click();
  await dialog.getByRole('alert').getByText(/ничего не спрашивая/).waitFor();
  await dialog.getByRole('button', { name: 'Включить' }).click();
  await page.getByText(/включается между ходами/).waitFor();
  await select.getByText('Принимать правки').waitFor();
  writeFileSync(gate, '');
  await page.getByText('command done').waitFor();

  // Between turns the process restarts with the flag, and only then.
  assert.equal(srv.log().some((l) => l.kind === 'spawn' && (l.argv as string[]).includes('--allow-dangerously-skip-permissions')), false);
  await select.click();
  await dialog.getByRole('radio', { name: /^Без проверок/ }).click();
  await dialog.getByRole('button', { name: 'Включить' }).click();
  await page.getByText('Режим без проверок: Claude выполняет').waitFor();
  await say(box, 'снова');
  await page.getByText('echo: снова').waitFor();
  const spawns = srv.log().filter((l) => l.kind === 'spawn') as unknown as { argv: string[] }[];
  assert.ok(spawns.some((l) => l.argv.includes('--allow-dangerously-skip-permissions') && l.argv.includes('--permission-mode=bypassPermissions')));
  await select.getByText('Без проверок').waitFor();
});

test('25: Ctrl+V and drop put an image into the composer, removable, and it reaches Claude', async () => {
  const { box } = await openWorkTab();
  const copyPng = () => page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([bytes], { type: 'image/png' }) })]);
  }, PNG);
  await copyPng();
  await box.focus();
  await page.keyboard.press('Control+V');
  const thumb = page.locator('img[src^="data:image/png"]').first();
  await thumb.waitFor();
  await page.getByRole('button', { name: /^Убрать / }).click();
  await thumb.waitFor({ state: 'detached' });

  // With the focus away from the field, as after clicking the transcript.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+V');
  await thumb.waitFor();
  await page.getByRole('button', { name: /^Убрать / }).click();

  await box.evaluate((target, b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const data = new DataTransfer();
    data.items.add(new File([bytes], 'drop.png', { type: 'image/png' }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }));
  }, PNG);
  await page.getByText('drop.png').waitFor();
  await say(box, 'смотри картинку');
  await page.getByText('echo: смотри картинку').waitFor();
  const sent = userLog().find((u) => Array.isArray(u.content) && JSON.stringify(u.content).includes('смотри картинку'));
  assert.ok(sent);
  assert.ok(JSON.stringify(sent.content).includes(PNG));
  await page.locator('img[alt="Вложение"]').first().waitFor();
});

test('26: someone else\'s live session: facts and a read-only transcript, a new session one click away, no way to write', async () => {
  await waitUntil(async () => (await srv.api<{ id: string; status: string }[]>('GET', '/api/sessions')).body.some((s) => s.id === EXTERNAL && s.status !== 'ended'), 'the external session is indexed');
  const projects = (await srv.api<{ key: string; root: string; name: string }[]>('GET', '/api/projects')).body;
  const project = projects.find((p) => p.root === external);
  assert.ok(project, JSON.stringify(projects));

  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'home' })));
  await page.reload();
  await page.getByRole('button', { name: new RegExp(project.name) }).first().waitFor();
  await page.keyboard.press('Control+KeyK');
  await page.getByRole('combobox').or(page.getByRole('textbox', { name: /команд|Поиск|Найти/i })).first().fill(project.name);
  await page.getByRole('option', { name: new RegExp(project.name) }).first().click();

  const openTab = async () => (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.sessionId === EXTERNAL);
  await waitUntil(async () => (await openTab())?.kind === 'readonly', 'opened read-only');
  await page.getByText('только чтение').waitFor();
  await page.getByText('почини сборку снаружи').first().waitFor();
  await page.getByText('Чиню сборку').waitFor();
  await page.getByText('Последний запрос:').waitFor();
  assert.equal(await page.getByRole('textbox', { name: /Сообщение/ }).count(), 0, 'no composer');
  await page.screenshot({ path: join(SHOTS, 'chat-readonly.png') });

  // Inside its subagent, from the same view.
  await page.getByRole('button', { name: /Explore/ }).first().click();
  await page.getByRole('dialog').getByText('Причина найдена внутри').waitFor();
  await page.keyboard.press('Escape');

  // The server refuses too, whatever the UI does.
  const tab = (await openTab())!;
  assert.equal((await srv.api('POST', `/api/tabs/${tab.id}/send`, { text: 'нельзя' })).status, 409);
  assert.equal((await srv.api('PATCH', `/api/tabs/${tab.id}`, { permissionMode: 'plan' })).status, 409);
  assert.equal((await srv.api('POST', '/api/tabs', { resumeSessionId: EXTERNAL })).status, 409);
  assert.equal(srv.log().some((l) => l.kind === 'spawn' && (l.argv as string[]).includes(EXTERNAL)), false, 'no process touched it');

  await page.getByRole('button', { name: 'Новая сессия здесь' }).click();
  await page.getByRole('textbox', { name: /Сообщение/ }).first().waitFor();
  const tabs = (await srv.api<Tab[]>('GET', '/api/tabs')).body;
  const fresh = tabs.find((t) => t.kind === 'work' && t.cwd === external);
  assert.ok(fresh);
  assert.equal(fresh.sessionId, null);
});

test('26: a finished session of ours resumes in full, a finished foreign one opens for reading', async () => {
  const { id, box } = await openWorkTab();
  await say(box, 'запомни');
  await page.getByText('echo: запомни').waitFor();
  const sessionId = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.id === id)!.sessionId!;
  await srv.api('DELETE', `/api/tabs/${id}`);
  await waitUntil(async () => (await srv.api<{ id: string; status: string; origin: string }[]>('GET', '/api/sessions')).body.some((s) => s.id === sessionId && s.status === 'ended' && s.origin === 'os'), 'indexed as ours and ended');

  writeFileSync(join(journalDir(work), `${EXTERNAL_ENDED}.jsonl`), JSON.stringify({ uuid: 'u-ended', sessionId: EXTERNAL_ENDED, cwd: work, timestamp: new Date().toISOString(), type: 'user', message: { role: 'user', content: 'старая чужая' } }) + '\n');
  await waitUntil(async () => (await srv.api<{ id: string }[]>('GET', '/api/sessions')).body.some((s) => s.id === EXTERNAL_ENDED), 'foreign session indexed', 70_000);

  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'sessions' })));
  await page.reload();
  await page.getByRole('button', { name: sessionId }).first().click();
  await page.getByRole('textbox', { name: /Сообщение/ }).first().waitFor();
  const ours = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.sessionId === sessionId)!;
  assert.equal(ours.kind, 'work');

  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'sessions' })));
  await page.reload();
  await page.getByRole('button', { name: EXTERNAL_ENDED }).first().click();
  await page.getByText('только чтение').waitFor();
  const foreign = (await srv.api<Tab[]>('GET', '/api/tabs')).body.find((t) => t.sessionId === EXTERNAL_ENDED)!;
  assert.equal(foreign.kind, 'readonly');
});
