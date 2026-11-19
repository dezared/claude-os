// Search by meaning from Settings: real server, fake engine behind CLAUDE_OS_SEMANTIC_ENGINE (a bag of words with a few
// synonyms, so a Russian word finds an English note). Screenshots of both themes go to the temp dir.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { seedSetupDone } from '../server/chat/fixtures/harness.ts';

const REPO = join(import.meta.dirname, '..');
const PORT = 47933;
const base = `http://127.0.0.1:${PORT}`;
let dir: string;
let server: ChildProcess;
let browser: Browser;
let page: Page;
const errors: string[] = [];

const note = (file: string, description: string, body: string) => {
  const path = join(dir, 'vault/projects/p', file);
  mkdirSync(join(dir, 'vault/projects/p'), { recursive: true });
  writeFileSync(path, `---\nname: ${file.replace('.md', '')}\ndescription: ${description}\nmetadata:\n  type: project\n  tags: [infra]\n---\n${body}\n`);
};
const search = async (q: string) => {
  const res = await page.context().request.get(`${base}/api/memory/search?q=${encodeURIComponent(q)}&project=p`);
  return ((await res.json()) as { name: string }[]).map((h) => h.name);
};
const toggle = () => page.getByRole('checkbox', { name: /Включено|Выключено/ });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-os-memsem-'));
  mkdirSync(join(dir, 'claude/projects'), { recursive: true });
  seedSetupDone(join(dir, 'config'));
  note('parking.md', 'Where the car is parked', 'The car stays on level 3 of the garage.');
  note('redis.md', 'Redis eviction', 'Production Redis uses allkeys-lfu.');
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
      CLAUDE_OS_SEMANTIC_ENGINE: join(REPO, 'server/memory/semantic/fixtures/fake-engine.ts'),
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
  const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1400, height: 900 } });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/auth?token=${token}`);
});

after(async () => {
  await browser?.close();
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('nothing is downloaded until the user asks; then the notes are indexed and a Russian word finds an English note', async () => {
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('menuitem', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Заметки и Obsidian' }).click();
  await page.getByRole('heading', { name: 'Поиск по смыслу' }).waitFor();
  await page.getByText('Не скачана, 135 МБ').waitFor();
  assert.equal(existsSync(join(dir, 'data/memory-semantic')), false);
  assert.deepEqual(await search('машина'), [], 'no model: words only');

  await page.getByRole('button', { name: 'Включить и скачать, 135 МБ' }).click();
  await page.getByText('2 из 2 заметок', { exact: false }).waitFor();
  assert.equal(await toggle().isChecked(), true, 'on by default once downloaded');
  assert.ok(existsSync(join(dir, 'data/memory-semantic/installed')));
  assert.equal((await search('машина'))[0], 'parking');
  await page.screenshot({ path: join(tmpdir(), 'memsem-settings-dark.png') });
  await page.evaluate(() => localStorage.setItem('claude-os.theme', 'light'));
  await page.reload();
  await page.getByText('2 из 2 заметок', { exact: false }).waitFor();
  await page.screenshot({ path: join(tmpdir(), 'memsem-settings-light.png') });
  assert.deepEqual(errors, []);
});

test('the toggle turns the search by meaning off and on; removing the model deletes it', async () => {
  await toggle().uncheck();
  await page.getByRole('checkbox', { name: 'Выключено' }).waitFor();
  assert.deepEqual(await search('машина'), []);
  assert.ok(existsSync(join(dir, 'data/memory-semantic/off')));
  await toggle().check();
  await page.getByText('2 из 2 заметок', { exact: false }).waitFor();
  assert.equal((await search('машина'))[0], 'parking');

  await page.getByRole('button', { name: 'Удалить модель' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить модель' }).click();
  await page.getByRole('button', { name: 'Включить и скачать, 135 МБ' }).waitFor();
  assert.equal(existsSync(join(dir, 'data/memory-semantic')), false);
  assert.deepEqual(await search('машина'), []);
  assert.deepEqual(errors, []);
});
