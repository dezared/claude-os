// The real server with the fake Claude CLI and throwaway directories: no tokens, nothing outside the temp dir.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { seedSetupDone } from '../server/chat/fixtures/harness.ts';

const REPO = join(import.meta.dirname, '..');
const PORT = 47906;
const base = `http://127.0.0.1:${PORT}`;
let dir: string;
let server: ChildProcess;
let browser: Browser;
let page: Page;
const errors: string[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-os-e2e-'));
  mkdirSync(join(dir, 'claude/projects'), { recursive: true });
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
    },
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const token = readFileSync(join(dir, 'data/token'), 'utf8').trim();
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  page = await (await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/auth?token=${token}`);
});

after(async () => {
  await browser?.close();
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('fresh machine renders empty states without page errors', async () => {
  await page.getByText('Проектов пока нет').waitFor();
  await page.getByText('Заметок памяти пока нет.').waitFor();
  assert.deepEqual(errors, []);
});

test('vault: copied notes count as being in the vault, though the project settings stay as they are', async () => {
  const cwd = join(dir, 'proj');
  const sessions = join(dir, 'claude/projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(join(sessions, 'memory'), { recursive: true });
  mkdirSync(cwd);
  writeFileSync(join(sessions, 's1.jsonl'), `${JSON.stringify({ type: 'user', sessionId: 's1', cwd, uuid: 'u', parentUuid: null, timestamp: new Date().toISOString(), message: { role: 'user', content: 'привет' } })}\n`);
  writeFileSync(join(sessions, 'memory', 'заметка.md'), 'Текст заметки.\n');
  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'tools', pane: 'vault' })));
  const copy = page.getByRole('button', { name: 'Скопировать всё в хранилище' });
  const stat = (label: string) => page.locator('div', { has: page.getByText(label, { exact: true }) }).last().locator('b');
  for (let i = 0; i < 40; i++) {
    await page.reload();
    await copy.waitFor();
    if (await copy.isEnabled()) break;
    await page.waitForTimeout(500);
  }
  assert.equal(await stat('Заметок в хранилище').textContent(), '0');
  await copy.click();
  await page.getByText(/^Скопировано заметок: 1/).waitFor();
  await page.waitForFunction(() => [...document.querySelectorAll('.sheet b')].slice(0, 4).map((b) => b.textContent).join() === '1,1,0,0'); // format issues follow
  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'home' })));
  await page.reload();
  await page.getByRole('textbox', { name: /Начни новый проект/ }).waitFor();
  assert.deepEqual(errors, []);
});

test('root session: streamed reply opens above the field', async () => {
  const box = page.getByRole('textbox', { name: /Начни новый проект/ });
  await box.fill('привет');
  await page.getByRole('button', { name: /^(Отправить|В очередь)$/ }).click();
  await page.getByText('echo: привет').waitFor();
  assert.equal(await box.inputValue(), '');
});

test('root session: permission card goes through allow', async () => {
  const box = page.getByRole('textbox', { name: /Начни новый проект/ });
  await box.fill('TOOL Edit {"file_path":"/tmp/x.txt","old_string":"a","new_string":"b"}');
  await page.getByRole('button', { name: /^(Отправить|В очередь)$/ }).click();
  await page.getByRole('button', { name: 'Разрешить' }).click();
  await page.getByText('Разрешено').waitFor();
  assert.deepEqual(errors, []);
});

test('interrupt stops a streaming turn and drops the visible queue', async () => {
  const box = page.getByRole('textbox', { name: /Начни новый проект/ });
  await box.fill('SLOW');
  await page.getByRole('button', { name: /^(Отправить|В очередь)$/ }).click();
  await page.getByText('tick').first().waitFor();
  await box.fill('следующее сообщение');
  await page.getByRole('button', { name: /^(Отправить|В очередь)$/ }).click();
  await page.getByText(/В очереди/).waitFor();
  await page.getByRole('button', { name: 'Прервать ход' }).click();
  await page.getByText(/В очереди/).waitFor({ state: 'detached' });
  await page.getByText('Ход прерван').first().waitFor();
  assert.deepEqual(errors, []);
});
