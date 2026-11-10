// Plugin slash commands, overlays and composer marks: a tiny plugin through the real server and the fake Claude CLI, in throwaway directories.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { seedSetupDone } from '../server/chat/fixtures/harness.ts';
import type { Tab } from '../shared/contract.ts';

const REPO = join(import.meta.dirname, '..');
const PORT = 47931;
const base = `http://127.0.0.1:${PORT}`;
let dir: string;
let server: ChildProcess;
let browser: Browser;
let page: Page;
let tabId: string;
const errors: string[] = [];
const sends: string[] = [];

const TINY = `
export function activate({ React, ReactDOM }) {
  const h = React.createElement;
  return {
    commands: [
      { name: 'tiny', description: 'Tiny command', argumentHint: '[x]', run(args, where) { window.__tiny = { args, tabId: where.tabId }; } },
      { name: 'tinyfail', run() { throw new Error('tiny failed'); } },
      { name: 'focus', run() { window.__hijacked = true; } },
    ],
    overlay: () => ReactDOM.createPortal(h('div', { 'data-testid': 'tiny-overlay' }, 'overlay'), document.body),
    composerMark: () => h('span', { 'data-testid': 'tiny-mark' }, 'mark'),
    dispose() { window.__tinyDisposed = true; },
  };
}
`;
const CRASH = `export function activate() { return { overlay() { throw new Error('crash overlay'); } }; }`;

function writeDependent() {
  const folder = join(dir, 'config/plugins/needs-block');
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'block.md'), 'Use the needs-block plugin.\n');
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({
    id: 'needs-block', name: 'needs-block', description: 'test', version: '1.0.0', author: 'test', icon: 'map',
    dependencies: [{ id: 'md', kind: 'config', file: 'claude-md', block: 'block.md', title: 'Lines in CLAUDE.md', titleRu: 'Строки в CLAUDE.md', why: 'Needed', whyRu: 'Без них не работает' }],
    contains: { hooks: [{ event: 'Stop', command: 'true' }] },
  }));
}

function writePlugin(id: string, code: string) {
  const folder = join(dir, 'config/plugins', id);
  mkdirSync(join(folder, 'ui'), { recursive: true });
  writeFileSync(join(folder, 'plugin.json'), JSON.stringify({ id, name: id, description: 'test', version: '1.0.0', author: 'test', contains: { ui: { entry: 'ui/index.js' } } }));
  writeFileSync(join(folder, 'ui/index.js'), code);
}

const call = (path: string, body?: unknown) => page.evaluate(async ({ path, body }) => {
  const r = await fetch(path, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}, { path, body });

async function enable(id: string) {
  const plan = await call(`/api/os-plugins/${id}/preview`, { action: 'enable' }) as { sha: string };
  await call(`/api/os-plugins/${id}/enable`, { confirmed: true, sha: plan.sha });
}

const go = (view: unknown) => page.evaluate((v) => {
  localStorage.setItem('claude-os.view', JSON.stringify(v));
  location.reload();
}, view);
const box = () => page.getByRole('textbox', { name: /Сообщение|plugin-api/ }).first();
const send = async (text: string) => {
  await box().fill(text);
  await box().press('Enter');
};

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-os-plugin-api-'));
  mkdirSync(join(dir, 'claude/projects'), { recursive: true });
  const cwd = join(dir, 'proj');
  mkdirSync(cwd);
  writePlugin('tiny', TINY);
  writePlugin('crash', CRASH);
  writeDependent();
  seedSetupDone(join(dir, 'config'));
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(REPO, 'server/index.ts')], {
    stdio: 'ignore',
    env: {
      ...process.env,
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
  const context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(60000);
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => { if (r.url().endsWith('/send')) sends.push(r.url()); });
  await page.goto(`${base}/auth?token=${token}`);
  tabId = (await call('/api/tabs', { cwd, title: 'plugin-api' }) as Tab).id;
});

after(async () => {
  await browser?.close();
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('a disabled plugin adds nothing', async () => {
  await go({ kind: 'tab', id: tabId });
  await box().waitFor();
  assert.equal(await page.getByTestId('tiny-overlay').count(), 0);
  assert.equal(await page.getByTestId('tiny-mark').count(), 0);
  await box().fill('/tiny');
  assert.equal(await page.getByRole('option', { name: /Tiny command/ }).count(), 0);
  await box().fill('');
});

test('enabled: the command is in the menu and runs in the browser, the overlay and the mark are mounted', async () => {
  await enable('tiny');
  await go({ kind: 'tab', id: tabId });
  await page.getByTestId('tiny-overlay').waitFor({ state: 'attached' });
  await page.getByTestId('tiny-mark').last().waitFor();

  await box().click();
  await page.keyboard.type('/tin');
  await page.getByText('Tiny command').waitFor();
  await box().fill('');

  await send('/tiny hello there');
  await page.waitForFunction(() => (window as unknown as { __tiny?: unknown }).__tiny);
  assert.deepEqual(await page.evaluate(() => (window as unknown as { __tiny: unknown }).__tiny), { args: 'hello there', tabId });
  assert.equal(await box().inputValue(), '');

  await send('/tinyfail');
  await page.getByText('tiny failed').waitFor();
  assert.equal(await box().inputValue(), '');

  await send('/focus off');
  await page.getByRole('button', { name: 'Полный вывод' }).waitFor();
  await send('/focus on');
  await page.getByRole('button', { name: 'Полный вывод' }).waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => (window as unknown as { __hijacked?: boolean }).__hijacked), undefined, 'a plugin does not take over a core command');
  assert.deepEqual(sends, [], 'nothing reached Claude');
});

test('the overlay stays across views, and is there in a popout window', async () => {
  await go({ kind: 'settings' });
  await page.getByTestId('tiny-overlay').waitFor({ state: 'attached' });
  await go({ kind: 'home' });
  await page.getByTestId('tiny-overlay').waitFor({ state: 'attached' });
  await page.goto(`${base}/?popout=tab&id=${tabId}`);
  await page.getByTestId('tiny-overlay').waitFor({ state: 'attached' });
  await page.goto(base);
});

test('an overlay that throws costs that plugin alone', async () => {
  await enable('crash');
  await go({ kind: 'tab', id: tabId });
  await page.getByTestId('tiny-overlay').waitFor({ state: 'attached' });
  await box().waitFor();
  assert.deepEqual(errors, []);
});

test('a folder changed after enabling stops counting: command, overlay and mark go, and dispose runs', async () => {
  await go({ kind: 'tab', id: tabId });
  await page.getByTestId('tiny-mark').last().waitFor();
  writeFileSync(join(dir, 'config/plugins/tiny/ui/extra.js'), 'export {};\n');
  await page.getByTestId('tiny-overlay').waitFor({ state: 'detached' });
  await page.getByTestId('tiny-mark').last().waitFor({ state: 'detached' });
  assert.equal(await page.evaluate(() => (window as unknown as { __tinyDisposed?: boolean }).__tinyDisposed), true);
  await box().fill('/tiny');
  await page.waitForTimeout(300);
  assert.equal(await page.getByText('Tiny command').count(), 0);
  await box().fill('');
  assert.deepEqual(errors, []);
});

test('a dependency end to end: the dialog urges it, the setup reaches Claude in a new tab, the block makes it ready, disabling takes the block away', async () => {
  const claudeMd = join(dir, 'claude/CLAUDE.md');
  const START = '<!-- os-plugin:needs-block:md:start -->';
  writeFileSync(claudeMd, '# Mine\n\nkeep me\n');
  await go({ kind: 'os-plugins' });
  await page.getByRole('button', { name: 'needs-block' }).waitFor();
  const row = page.getByRole('button', { name: 'Включить', exact: true });
  await row.first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('region', { name: 'Зависимости' }).getByText('Строки в CLAUDE.md').waitFor();
  await dialog.getByRole('alert').getByText('Настоятельно рекомендуем').waitFor();
  assert.equal(readFileSync(claudeMd, 'utf8'), '# Mine\n\nkeep me\n', 'nothing written by showing it');
  sends.length = 0;
  await dialog.getByRole('button', { name: 'Включить и настроить' }).click();
  await page.waitForFunction(() => (JSON.parse(localStorage.getItem('claude-os.view') ?? '{}') as { kind?: string }).kind === 'tab');
  for (let i = 0; i < 100 && sends.length === 0; i++) await page.waitForTimeout(50);
  assert.equal(sends.length, 1, 'the request went to the new tab');
  assert.equal(readFileSync(claudeMd, 'utf8'), '# Mine\n\nkeep me\n', 'the server leaves the place to Claude');

  await go({ kind: 'os-plugins' });
  await page.getByText('не настроен', { exact: true }).waitFor();
  writeFileSync(claudeMd, `${START}\nUse the needs-block plugin.\n<!-- os-plugin:needs-block:md:end -->\n\n# Mine\n\nkeep me\n`);
  await page.getByText('не настроен', { exact: true }).waitFor({ state: 'detached' });

  await go({ kind: 'entity', type: 'os-plugin', id: 'needs-block' });
  await page.getByRole('region', { name: 'Зависимости' }).getByText('готово', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Отключить', exact: true }).click();
  await dialog.getByText('Строки в конфиге').waitFor();
  await dialog.getByRole('button', { name: 'Отключить', exact: true }).click();
  await dialog.waitFor({ state: 'detached' });
  assert.equal(readFileSync(claudeMd, 'utf8'), '# Mine\n\nkeep me\n');
  assert.deepEqual(errors, []);
});
