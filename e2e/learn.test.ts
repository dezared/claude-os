// The shipped Learn plugin end to end: its burger menu screen over the real server, seeded data, the fake Claude CLI.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { seedSetupDone } from '../server/chat/fixtures/harness.ts';
import type { Tab } from '../shared/contract.ts';

const REPO = join(import.meta.dirname, '..');
const PORT = 47941;
const base = `http://127.0.0.1:${PORT}`;
let dir: string;
let server: ChildProcess;
let browser: Browser;
let page: Page;
const errors: string[] = [];
const sends: string[] = [];

const data = () => join(dir, 'data/os-plugin-data/learn');
const workdir = () => join(dir, 'home/learn/go');
const write = (path: string, value: unknown) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};

function seed() {
  cpSync(join(REPO, 'plugins/learn'), join(dir, 'plugins/learn'), { recursive: true });
  // Enabled as the installer leaves it; enabling for real would ask the CLI to add the MCP server.
  write(join(dir, 'data/os-plugins.json'), { learn: { version: '1.0.0', at: 1, tree: 'x', skills: [], hooks: [], mcp: [], settingsCreated: false, ui: { entry: 'ui/index.js', permissions: ['data'] }, kit: null } });
  mkdirSync(workdir(), { recursive: true });
  write(join(data(), 'tracks/go/track.json'), {
    id: 'go', title: 'Go для бэкенда', goal: 'Писать сервисы на Go', language: 'ru', workdir: workdir(), createdAt: 1,
    nodes: [{ id: 'basics', title: 'Основы', summary: 'go run, go test', status: 'todo' }, { id: 'errors', title: 'Ошибки', summary: null, status: 'todo' }, { id: 'chan', title: 'Каналы', summary: null, status: 'todo' }],
  });
  write(join(data(), 'tracks/go/lessons/basics.json'), {
    node: 'basics', title: 'Основы Go', minutes: 20, createdAt: 1,
    html: '<p class="lead">Зачем это нужно.</p><h2>Код</h2><pre><code class="language-go">func main() { return }</code></pre><script>window.parent.__ran = true</script>',
    quiz: [{ question: 'Чем запускать тесты?', options: ['go run', 'go test'], answer: 1, explain: 'go test находит *_test.go' }, { question: 'Типизация в Go?', options: ['статическая', 'динамическая'], answer: 0 }],
    videos: [{ title: 'Go за 100 секунд', url: 'https://www.youtube.com/results?search_query=go+100+seconds' }],
    practice: { task: 'Напишите FormatAmount', hint: 'int64 в копейках', check: 'go test ./...', files: [{ path: 'go.mod', content: 'module gocourse/01\n' }, { path: 'money/money_test.go', content: 'package money\n' }] },
  });
  const course = join(dir, 'config/plugins/go-course');
  mkdirSync(join(course, 'skills/go-course'), { recursive: true });
  writeFileSync(join(course, 'skills/go-course/SKILL.md'), '---\nname: go-course\ndescription: A Go course\n---\nbody\n');
  write(join(course, 'plugin.json'), { id: 'go-course', name: 'Go course', description: 'A two-day Go course', version: '1.0.0', author: 'test', contains: { skills: ['go-course'] } });
}

async function go(view: unknown, theme = 'dark') {
  await page.evaluate(({ v, theme }) => {
    localStorage.setItem('claude-os.view', JSON.stringify(v));
    localStorage.setItem('claude-os.theme', theme);
  }, { v: view, theme });
  await page.reload();
}
const tabs = () => page.evaluate(async () => (await (await fetch('/api/tabs')).json()) as Tab[]);

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-os-learn-'));
  mkdirSync(join(dir, 'claude/projects'), { recursive: true });
  seed();
  seedSetupDone(join(dir, 'config'));
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(REPO, 'server/index.ts')], {
    stdio: 'ignore',
    env: {
      ...process.env,
      HOME: join(dir, 'home'),
      CLAUDE_OS_PORT: String(PORT),
      CLAUDE_OS_IDLE_EXIT_MS: '0',
      CLAUDE_OS_DATA: join(dir, 'data'),
      CLAUDE_OS_CONFIG: join(dir, 'config'),
      CLAUDE_OS_PLUGINS: join(dir, 'plugins'),
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
  const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1400, height: 950 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(60000);
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (r.url().endsWith('/send')) sends.push(r.url()); });
  await page.goto(`${base}/auth?token=${token}`);
});

after(async () => {
  await browser?.close();
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('the burger menu opens Learn: the track card, the streak and the offer to import the course plugin', async () => {
  await go({ kind: 'settings' });
  await page.getByRole('button', { name: 'Меню' }).click();
  await page.getByRole('menuitem', { name: 'Обучение' }).click();
  await page.getByTestId('learn-screen').waitFor();
  const card = page.getByTestId('learn-track');
  await card.getByText('Go для бэкенда').waitFor();
  await card.getByText('0 из 3').waitFor();
  await card.getByText('Дальше: Основы').waitFor();
  await page.getByTestId('learn-offer').getByText('«Go course»').waitFor();
  assert.equal((JSON.parse(await page.evaluate(() => localStorage.getItem('claude-os.view') ?? '{}')) as { kind: string }).kind, 'plugin');
  await page.screenshot({ path: '/tmp/learn-home-dark.png' });
});

test('the roadmap marks the current step and the lesson opens in a frame where scripts do not run', async () => {
  await page.getByTestId('learn-track').click();
  const nodes = page.getByTestId('learn-node');
  assert.equal(await nodes.count(), 3);
  await nodes.first().getByText('урок готов').waitFor();
  assert.match(await nodes.first().getAttribute('class') ?? '', /is-current/);
  await nodes.nth(1).getByRole('button', { name: 'Написать урок' }).waitFor();
  await nodes.first().getByRole('button', { name: 'Открыть урок' }).click();
  const frame = page.frameLocator('[data-testid="html-frame"]');
  await frame.locator('.lead').getByText('Зачем это нужно.').waitFor();
  await frame.locator('.hljs-keyword').first().waitFor();
  assert.equal(await page.evaluate(() => (window as unknown as { __ran?: boolean }).__ran), undefined);
  for (let i = 0; i < 50 && !existsSync(join(data(), 'tracks/go/progress.json')); i++) await page.waitForTimeout(100);
  assert.ok((JSON.parse(readFileSync(join(data(), 'tracks/go/progress.json'), 'utf8')) as { read: Record<string, number> }).read.basics);
});

test('a failed quiz is kept, a passed one marks the step done and starts the streak', async () => {
  await page.getByRole('button', { name: 'К тесту' }).click();
  const questions = page.getByTestId('learn-question');
  await questions.nth(0).getByText('go run').click();
  await questions.nth(1).getByText('статическая').click();
  await page.getByRole('button', { name: 'Проверить' }).click();
  await page.getByRole('status').getByText('1 из 2').waitFor();
  await page.getByText('go test находит *_test.go').waitFor();
  await page.getByRole('button', { name: 'Ещё раз' }).click();
  await questions.nth(0).getByText('go test').click();
  await questions.nth(1).getByText('статическая').click();
  await page.getByRole('button', { name: 'Проверить' }).click();
  await page.getByText('Тест сдан: шаг пройден.').waitFor();
  await page.getByText('Шаг пройден').first().waitFor();
  await page.getByTestId('learn-streak').getByText('1').waitFor();
  const progress = JSON.parse(readFileSync(join(data(), 'tracks/go/progress.json'), 'utf8')) as { done: Record<string, number>; attempts: { score: number }[] };
  assert.deepEqual(progress.attempts.map((a) => a.score), [1, 2]);
  assert.ok(progress.done.basics);
});

test('practice opens a Claude tab in the track work folder with the task', async () => {
  await page.getByRole('tab', { name: 'Практика' }).click();
  await page.getByText('Напишите FormatAmount').waitFor();
  await page.getByRole('link', { name: 'Go за 100 секунд' }).waitFor();
  await page.getByTestId('learn-exercise').getByText('go test ./...').waitFor();
  await page.getByTestId('learn-exercise').getByText('money/money_test.go').waitFor();
  sends.length = 0;
  await page.getByRole('button', { name: 'Практика с Claude' }).click();
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem('claude-os.view') ?? '{}') as { kind?: string }).kind === 'tab');
  for (let i = 0; i < 100 && sends.length === 0; i++) await page.waitForTimeout(50);
  assert.equal(sends.length, 1);
  assert.ok((await tabs()).some((t) => t.cwd === workdir()));
});

test('back on the list the track counts the step, the import goes to Claude in the workspace, and the light theme reads', async () => {
  await go({ kind: 'plugin', screen: 'learn' }, 'light');
  await page.getByTestId('learn-screen').waitFor();
  await page.getByRole('button', { name: 'Go для бэкенда' }).click();
  await page.getByRole('button', { name: 'Все темы' }).click();
  await page.getByTestId('learn-track').getByText('1 из 3').waitFor();
  await page.getByTestId('learn-offer').waitFor();
  await page.screenshot({ path: '/tmp/learn-home-light.png' });
  sends.length = 0;
  await page.getByRole('button', { name: 'Импортировать как тему' }).click();
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem('claude-os.view') ?? '{}') as { kind?: string }).kind === 'tab');
  for (let i = 0; i < 100 && sends.length === 0; i++) await page.waitForTimeout(50);
  assert.equal(sends.length, 1);
  assert.ok((await tabs()).some((t) => t.cwd === join(dir, 'home/learn')));
  await go({ kind: 'plugin', screen: 'learn' }, 'light');
  await page.getByTestId('learn-track').click();
  await page.getByTestId('learn-node').first().getByRole('button', { name: 'Открыть урок' }).click();
  await page.frameLocator('[data-testid="html-frame"]').locator('.lead').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: '/tmp/learn-lesson-light.png' });
  assert.deepEqual(errors, []);
});

test('a course is made by hand: settings and roadmap without Claude, its work folder made on the spot', async () => {
  await page.evaluate(() => localStorage.removeItem('claude-os.learn.place'));
  await go({ kind: 'plugin', screen: 'learn' }, 'light');
  await page.getByRole('button', { name: 'Создать вручную' }).click();
  const form = page.getByTestId('learn-form');
  await form.getByLabel('Название').fill('SQL основы');
  await form.getByLabel('Цель: что хотите уметь').fill('Писать запросы');
  await form.getByRole('button', { name: 'Добавить шаг' }).click();
  await form.getByRole('button', { name: 'Добавить шаг' }).click();
  await form.getByLabel('Шаг', { exact: true }).nth(0).fill('SELECT');
  await form.getByLabel('Шаг', { exact: true }).nth(1).fill('JOIN');
  await form.getByRole('button', { name: 'Создать тему' }).click();
  await page.getByRole('heading', { name: 'SQL основы' }).waitFor();
  assert.equal(await page.getByTestId('learn-node').count(), 2);
  const track = JSON.parse(readFileSync(join(data(), 'tracks/sql/track.json'), 'utf8')) as { workdir: string; nodes: { id: string; title: string }[]; goal: string };
  assert.equal(track.workdir, join(dir, 'home/learn/sql'));
  assert.ok(existsSync(track.workdir));
  assert.deepEqual(track.nodes.map((n) => n.id), ['select', 'join']);

  await page.getByRole('button', { name: 'Настроить' }).click();
  const edit = page.getByTestId('learn-form');
  await edit.getByTestId('learn-edit-node').nth(1).getByRole('button', { name: 'Выше' }).click();
  await edit.getByTestId('learn-edit-node').nth(0).getByLabel('Шаг', { exact: true }).fill('JOIN и ключи');
  await page.screenshot({ path: '/tmp/learn-editor-light.png' });
  await edit.getByRole('button', { name: 'Сохранить' }).click();
  await page.getByTestId('learn-node').first().getByText('JOIN и ключи').waitFor();
  const saved = JSON.parse(readFileSync(join(data(), 'tracks/sql/track.json'), 'utf8')) as { nodes: { id: string; title: string }[] };
  assert.deepEqual(saved.nodes.map((n) => [n.id, n.title]), [['join', 'JOIN и ключи'], ['select', 'SELECT']], 'ids stay with their steps');
});

test('a course keeps its materials: added, shown and deleted on the screen', async () => {
  await page.getByRole('button', { name: 'Добавить материал' }).click();
  const form = page.getByTestId('learn-material-form');
  await form.getByLabel('Название материала').fill('Program');
  await form.getByLabel('Текст материала').fill('# Программа\n\n1. SELECT');
  await form.getByRole('button', { name: 'Сохранить' }).click();
  const row = page.getByTestId('learn-material');
  await row.getByRole('button', { name: 'Program' }).click();
  await row.getByRole('heading', { name: 'Программа' }).waitFor();
  const material = JSON.parse(readFileSync(join(data(), 'tracks/sql/materials/program.json'), 'utf8')) as { kind: string; content: string };
  assert.deepEqual([material.kind, material.content], ['markdown', '# Программа\n\n1. SELECT']);
  await page.screenshot({ path: '/tmp/learn-materials-light.png', fullPage: true });
  await row.getByRole('button', { name: 'Удалить материал' }).click();
  await row.getByRole('button', { name: 'Удалить' }).click();
  await row.waitFor({ state: 'detached' });
  assert.equal(existsSync(join(data(), 'tracks/sql/materials/program.json')), false);
});

test('once a track names the course plugin as its source, Learn stops offering it', async () => {
  write(join(data(), 'tracks/imported/track.json'), { id: 'imported', title: 'Go для PHP-бэкендера', goal: 'g', workdir: workdir(), createdAt: 2, source: join(dir, 'config/plugins/go-course'), nodes: [{ id: '01-toolchain', title: 'Toolchain', summary: null, status: 'todo' }] });
  await page.evaluate(() => localStorage.removeItem('claude-os.learn.place'));
  await go({ kind: 'plugin', screen: 'learn' }, 'dark');
  await page.getByTestId('learn-track').getByText('Go для PHP-бэкендера').waitFor();
  await page.waitForTimeout(500);
  assert.equal(await page.getByTestId('learn-offer').count(), 0);
  assert.deepEqual(errors, []);
});
