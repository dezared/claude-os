// The real server and real git on throwaway repos with a local bare remote; the fake Claude CLI, no tokens. Set CLAUDE_OS_WEB_DIST to test another build.
import assert from 'node:assert/strict';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { seedSetupDone } from '../server/chat/fixtures/harness.ts';

const REPO = join(import.meta.dirname, '..');
const SHOTS = join(REPO, 'docs', 'screenshots');
const PORT = 47914;
const base = `http://127.0.0.1:${PORT}`;
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-os-e2e-git-')));
const bare = join(dir, 'remote.git');
const repo = join(dir, 'acme-api');
const other = join(dir, 'other');
const gitEnv = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Test Author', GIT_AUTHOR_EMAIL: 't@e.st', GIT_COMMITTER_NAME: 'Test Author', GIT_COMMITTER_EMAIL: 't@e.st' };
const g = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', env: gitEnv, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const put = (name: string, text: string, cwd = repo) => writeFileSync(join(cwd, name), text);
const commit = (msg: string, cwd = repo) => {
  g(cwd, 'add', '-A');
  g(cwd, 'commit', '-qm', msg);
};

let server: ChildProcess;
let browser: Browser;
let page: Page;
let panel: Locator;
const errors: string[] = [];
const ideCalls: unknown[] = [];
const sends: string[] = [];

const shot = (name: string) => page.screenshot({ path: join(SHOTS, name), timeout: 170_000 }); // software WebGL under load is slow
const focus = () => page.evaluate(() => window.dispatchEvent(new Event('focus')));
const branchPopup = async () => {
  await panel.getByRole('button', { name: 'Ветки' }).click();
  return page.getByTestId('git-branches');
};
const actionsFor = async (name: string | RegExp) => {
  const popup = await branchPopup();
  await popup.getByRole('button', { name }).first().click();
  return page.getByTestId('git-branch-actions');
};

before(async () => {
  g(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  put('README.md', '# acme\n');
  put('src.ts', 'export const a = 1;\n');
  commit('Первый коммит');
  g(repo, 'remote', 'add', 'origin', bare);
  g(repo, 'push', '-q', '-u', 'origin', 'main');
  g(repo, 'branch', 'feature/login');
  g(repo, 'checkout', '-q', 'feature/login');
  put('src.ts', 'export const a = 2;\n');
  commit('Логин: новый поток');
  g(repo, 'tag', 'v0.1');
  g(repo, 'checkout', '-q', 'main');
  put('main.ts', 'main\n');
  commit('Главная ветка идёт дальше');
  g(repo, 'merge', '-q', '--no-edit', '--no-ff', 'feature/login');
  g(repo, 'push', '-q');
  g(repo, 'branch', 'merged-one');
  g(dir, 'clone', '-q', bare, other);

  mkdirSync(join(dir, 'claude/projects'), { recursive: true });
  seedSetupDone(join(dir, 'config'));
  server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(REPO, 'server/index.ts')], {
    stdio: 'ignore',
    env: {
      ...gitEnv,
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
  const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  ctx.setDefaultTimeout(20000);
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/api/ides/open', async (route) => {
    ideCalls.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true } });
  });
  page.on('request', (r) => {
    if (r.url().endsWith('/send')) sends.push(r.url());
  });
  await page.goto(`${base}/auth?token=${token}`);
  const res = await page.request.post(`${base}/api/tabs`, { data: { cwd: repo, title: 'acme-api' } });
  assert.equal(res.status(), 200);
  const tab = await res.json() as { id: string };
  await ctx.addInitScript((v) => localStorage.setItem('claude-os.view', v), JSON.stringify({ kind: 'tab', id: tab.id }));
  await page.goto(base);
  panel = page.getByTestId('git-panel');
});

after(async () => {
  await browser?.close();
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('status runs by itself: on opening and on window focus, and there is no refresh button', async () => {
  put('fresh.txt', 'fresh\n');
  await page.getByRole('button', { name: 'Git', exact: true }).click();
  await panel.getByText('fresh.txt').waitFor();
  assert.equal(await panel.getByRole('button', { name: 'Обновить' }).count(), 0);
  put('after-focus.txt', 'x\n');
  assert.equal(await panel.getByText('after-focus.txt').count(), 0);
  await focus();
  await panel.getByText('after-focus.txt').waitFor();
  rmSync(join(repo, 'fresh.txt'));
  rmSync(join(repo, 'after-focus.txt'));
  await focus();
  await panel.getByText('fresh.txt').waitFor({ state: 'detached' });
  await panel.getByText('Рабочая копия чистая').waitFor();
});

test('fetch and pull: new remote branch appears, last fetch time, fast-forward', async () => {
  await panel.getByText('fetch ещё не было').waitFor();
  put('from-other.txt', 'other\n', other);
  commit('Коммит с другой машины', other);
  g(other, 'push', '-q');
  g(other, 'push', '-q', 'origin', 'HEAD:refs/heads/release/2.0');
  await panel.getByRole('button', { name: 'Fetch', exact: true }).click();
  await panel.getByText(/^fetch сейчас$/).waitFor();
  await panel.getByRole('button', { name: /^Pull 1$/ }).waitFor();

  const popup = await branchPopup();
  await popup.getByRole('button', { name: /origin\/release\/2\.0/ }).waitFor();
  await page.keyboard.press('Escape');
  await popup.waitFor({ state: 'detached' });
  assert.ok(await panel.isVisible(), 'Escape closes the popup, not the panel');

  await panel.getByRole('button', { name: /^Pull 1$/ }).click();
  await panel.getByRole('button', { name: 'Pull', exact: true }).waitFor();
  assert.equal(g(repo, 'log', '-1', '--format=%s'), 'Коммит с другой машины');
});

test('branch popup: groups, search, current mark, checkout, recent, compare, new, rename, delete', async () => {
  let popup = await branchPopup();
  await popup.getByText('Локальные').waitFor();
  await popup.getByText('Удалённые').waitFor();
  assert.match(await popup.locator('button[aria-current=true]').first().innerText(), /^main/);
  await popup.getByRole('textbox', { name: 'Поиск веток' }).fill('LOGIN');
  await popup.getByRole('button', { name: /feature\/login/ }).first().waitFor();
  await page.keyboard.press('Enter');
  const actions = page.getByTestId('git-branch-actions');
  await actions.getByRole('button', { name: 'Checkout' }).waitFor();
  await actions.getByRole('button', { name: 'Новая ветка отсюда…' }).waitFor();
  await actions.getByRole('button', { name: 'Сравнить с текущей' }).waitFor();
  await actions.getByRole('button', { name: 'Переименовать…' }).waitFor();
  await actions.getByRole('button', { name: 'Удалить…' }).waitFor();
  await shot('git-branches.png');

  await actions.getByRole('button', { name: 'Сравнить с текущей' }).click();
  const compare = page.getByTestId('git-compare');
  await compare.getByText('Только в main').waitFor();
  await compare.getByText('Коммит с другой машины').waitFor();
  await compare.getByRole('button', { name: /from-other\.txt/ }).click();
  await page.getByTestId('git-diff').last().getByText('other').waitFor();
  await compare.getByRole('button', { name: 'Закрыть' }).click();

  await (await actionsFor(/feature\/login/)).getByRole('button', { name: 'Checkout' }).click();
  await panel.getByRole('button', { name: 'Ветки' }).getByText('feature/login').waitFor();
  assert.equal(g(repo, 'branch', '--show-current'), 'feature/login');

  popup = await branchPopup();
  await popup.getByText('Недавние').waitFor();
  await page.keyboard.press('Escape');

  await (await actionsFor(/^main/)).getByRole('button', { name: 'Checkout' }).click();
  await panel.getByRole('button', { name: 'Ветки' }).getByText('main').waitFor();

  await (await branchPopup()).getByRole('button', { name: 'Новая ветка…' }).click();
  let form = page.getByRole('dialog', { name: 'Новая ветка' });
  await form.getByRole('textbox').fill('feature/new-thing');
  await form.getByRole('button', { name: 'Создать' }).click();
  await panel.getByRole('button', { name: 'Ветки' }).getByText('feature/new-thing').waitFor();
  assert.equal(g(repo, 'branch', '--show-current'), 'feature/new-thing');

  await (await actionsFor(/feature\/new-thing/)).getByRole('button', { name: 'Переименовать…' }).click();
  form = page.getByRole('dialog', { name: /Переименовать feature\/new-thing/ });
  await form.getByRole('textbox').fill('feature/renamed');
  await form.getByRole('button', { name: 'Переименовать' }).click();
  await panel.getByRole('button', { name: 'Ветки' }).getByText('feature/renamed').waitFor();

  await (await actionsFor(/^main/)).getByRole('button', { name: 'Checkout' }).click();
  await panel.getByRole('button', { name: 'Ветки' }).getByText('main').waitFor();

  await (await branchPopup()).getByRole('textbox', { name: 'Поиск веток' }).fill('renamed');
  const row = page.getByTestId('git-branches').getByRole('button', { name: /feature\/renamed/ });
  await row.click();
  await page.getByTestId('git-branch-actions').getByRole('button', { name: 'Новая ветка отсюда…' }).click();
  form = page.getByRole('dialog', { name: 'Новая ветка' });
  await form.getByText('От feature/renamed').waitFor();
  await form.getByRole('textbox').fill('--bad name');
  await form.getByRole('button', { name: 'Создать' }).click();
  const alert = panel.getByRole('alert');
  await alert.getByText('bad branch name').waitFor();
  await alert.getByRole('button', { name: 'Скрыть' }).click();

  put('unmerged.txt', 'x\n');
  await g(repo, 'checkout', '-q', 'feature/renamed');
  commit('Не влито');
  g(repo, 'checkout', '-q', 'main');
  await focus();
  await panel.getByRole('button', { name: 'Ветки' }).getByText('main').waitFor();
  await (await actionsFor(/^feature\/renamed/)).getByRole('button', { name: 'Удалить…' }).click();
  const confirm = page.getByRole('dialog', { name: 'Удалить ветку feature/renamed?' });
  await confirm.getByText('git branch -d').waitFor();
  await confirm.getByRole('button', { name: 'Отмена' }).click();
  assert.ok(g(repo, 'branch', '--list', 'feature/renamed'), 'cancel deletes nothing');
  await (await actionsFor(/^feature\/renamed/)).getByRole('button', { name: 'Удалить…' }).click();
  await page.getByRole('dialog', { name: 'Удалить ветку feature/renamed?' }).getByRole('button', { name: 'Удалить' }).click();
  await alert.getByText(/not fully merged/).waitFor();
  assert.ok(g(repo, 'branch', '--list', 'feature/renamed'), 'unmerged: -d refuses, verbatim, nothing is forced');
  await alert.getByRole('button', { name: 'Скрыть' }).click();
  await (await actionsFor(/^merged-one/)).getByRole('button', { name: 'Удалить…' }).click();
  await page.getByRole('dialog', { name: 'Удалить ветку merged-one?' }).getByRole('button', { name: 'Удалить' }).click();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await alert.waitFor({ state: 'detached' });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(g(repo, 'branch', '--list', 'merged-one'), '');
});

test('dirty checkout: refusal verbatim, Claude button shows the error and sends nothing, stash and retry, unstash', async () => {
  g(repo, 'branch', 'older', 'HEAD~2');
  put('src.ts', 'dirty work\n');
  await focus();
  await panel.getByText('src.ts').waitFor();
  await (await actionsFor(/^older/)).getByRole('button', { name: 'Checkout' }).click();
  const alert = panel.getByRole('alert');
  await alert.getByText(/would be overwritten by checkout/).waitFor();
  await alert.getByText('src.ts').waitFor();
  assert.equal(g(repo, 'branch', '--show-current'), 'main');
  await shot('git-refusal.png');

  await alert.getByRole('button', { name: 'Исправить через Claude' }).click();
  const task = page.getByRole('dialog', { name: /git/ });
  await task.getByText(/would be overwritten/).first().waitFor();
  await task.getByRole('button', { name: 'Отмена' }).click();
  assert.deepEqual(sends, []);

  await alert.getByRole('button', { name: 'Stash и повторить' }).click();
  await panel.getByRole('button', { name: 'Ветки' }).getByText('older').waitFor();
  assert.equal(g(repo, 'branch', '--show-current'), 'older');
  assert.match(g(repo, 'stash', 'list'), /перед: git checkout older/);

  await (await actionsFor(/^main/)).getByRole('button', { name: 'Checkout' }).click();
  await panel.getByRole('button', { name: 'Ветки' }).getByText('main').waitFor();
  const popup = await branchPopup();
  await popup.getByRole('button', { name: /Unstash/ }).click();
  await page.getByTestId('git-branch-actions').getByRole('button', { name: /перед: git checkout older/ }).click();
  await panel.getByText('src.ts').waitFor();
  assert.equal(readFileSync(join(repo, 'src.ts'), 'utf8'), 'dirty work\n');
  assert.equal(g(repo, 'stash', 'list'), '');
});

test('commit area: checkboxes are the index, group select all, partly staged, Commit and Push, amend asks', async () => {
  put('notes one.md', 'n1\n');
  put('notes2.md', 'n2\n');
  await focus();
  await panel.getByText('notes2.md').waitFor();
  const commitBtn = panel.getByRole('button', { name: /^Коммит \(/ });
  const box = panel.getByRole('textbox', { name: 'Сообщение коммита' });
  await box.fill('Правка');
  assert.equal(await commitBtn.isDisabled(), true, 'nothing is staged');

  await panel.getByRole('checkbox', { name: 'В коммит: src.ts' }).click();
  await panel.getByRole('checkbox', { name: 'Убрать из коммита: src.ts' }).waitFor();
  assert.equal(g(repo, 'diff', '--cached', '--name-only'), 'src.ts');
  await panel.getByText('src.ts').click();
  await page.getByTestId('git-diff').first().getByText('dirty work').waitFor();

  put('src.ts', 'dirty work\nmore\n');
  await focus();
  const partial = panel.getByRole('checkbox', { name: /src\.ts/ });
  await page.waitForFunction(() => [...document.querySelectorAll<HTMLInputElement>('[data-testid=git-panel] input[type=checkbox]')].some((c) => c.indeterminate));
  await page.getByTestId('git-diff').first().getByText('more').waitFor();
  await partial.click();
  await panel.getByRole('checkbox', { name: 'Убрать из коммита: src.ts' }).waitFor();

  const all = panel.getByRole('checkbox', { name: 'добавить все: Новые' });
  await all.click();
  await panel.getByRole('checkbox', { name: 'Убрать из коммита: notes2.md' }).waitFor();
  await panel.getByRole('button', { name: /^Коммит \(3\)/ }).waitFor();
  assert.deepEqual(g(repo, 'diff', '--cached', '--name-only').split('\n').sort(), ['notes one.md', 'notes2.md', 'src.ts']);
  await shot('git-commit.png');

  await panel.getByRole('checkbox', { name: 'Убрать из коммита: notes2.md' }).click();
  await panel.getByRole('checkbox', { name: 'В коммит: notes2.md' }).waitFor();
  await panel.getByRole('button', { name: 'Коммит и Push' }).click();
  const push = page.getByRole('dialog', { name: 'Отправить ветку' });
  await push.getByText('origin/main').waitFor();
  await push.getByText('Правка').waitFor();
  assert.equal(g(repo, 'log', '-1', '--format=%B'), 'Правка', 'no trailers');
  await push.getByRole('button', { name: 'Отправить' }).click();
  await push.waitFor({ state: 'detached' });
  assert.equal(g(bare, 'log', '-1', '--format=%s', 'main'), 'Правка');

  const head = g(repo, 'rev-parse', 'HEAD');
  await panel.getByRole('checkbox', { name: /Amend/ }).click();
  await panel.getByText('уже на сервере').waitFor();
  assert.equal(await box.inputValue(), 'Правка');
  await box.fill('Правка 2');
  await commitBtn.click();
  const ask = page.getByRole('dialog', { name: 'Исправить отправленный коммит?' });
  await ask.getByRole('button', { name: 'Отмена' }).click();
  assert.equal(g(repo, 'rev-parse', 'HEAD'), head, 'no answer, no amend');
  await panel.getByRole('checkbox', { name: /Amend/ }).click();
  assert.equal(await box.inputValue(), '');
});

test('per-file menu: rollback names the file and touches only it, .gitignore, open in IDE', async () => {
  put('README.md', '# changed\n');
  put('main.ts', 'changed too\n');
  await focus();
  const row = panel.locator('div.group', { hasText: 'README.md' });
  await row.click({ button: 'right', position: { x: 80, y: 8 } });
  const menu = page.getByRole('dialog', { name: 'Действия с файлом' });
  await menu.getByRole('button', { name: 'Показать разницу' }).waitFor();
  await menu.getByRole('button', { name: 'Открыть в IDE' }).click();
  assert.equal((ideCalls.at(-1) as { file: string }).file, join(repo, 'README.md'));

  await panel.getByRole('button', { name: 'Действия с файлом: README.md' }).click({ force: true });
  await menu.getByRole('button', { name: 'Откатить…' }).click();
  const ask = page.getByRole('dialog', { name: 'Откатить файл?' });
  await ask.getByText(/README\.md вернётся к последнему коммиту/).waitFor();
  await ask.getByRole('button', { name: 'Отмена' }).click();
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), '# changed\n');

  await panel.getByRole('button', { name: 'Действия с файлом: README.md' }).click({ force: true });
  await menu.getByRole('button', { name: 'Откатить…' }).click();
  await ask.getByRole('button', { name: 'Откатить' }).click();
  await panel.getByText('README.md').waitFor({ state: 'detached' });
  assert.equal(readFileSync(join(repo, 'README.md'), 'utf8'), '# acme\n');
  assert.equal(readFileSync(join(repo, 'main.ts'), 'utf8'), 'changed too\n');

  await panel.getByRole('button', { name: 'Действия с файлом: notes2.md' }).click({ force: true });
  assert.equal(await menu.getByRole('button', { name: 'Откатить…' }).count(), 0, 'an untracked file has nothing to roll back to');
  await menu.getByRole('button', { name: 'Добавить в .gitignore' }).click();
  await panel.getByText('notes2.md').waitFor({ state: 'detached' });
  assert.equal(readFileSync(join(repo, '.gitignore'), 'utf8'), '/notes2.md\n');
  assert.ok(existsSync(join(repo, 'notes2.md')));
  rmSync(join(repo, '.gitignore'));
  rmSync(join(repo, 'notes2.md'));
  g(repo, 'checkout', '-q', '--', 'main.ts');
  await focus();
  await panel.getByText('Рабочая копия чистая').waitFor();
});

test('log: labels, graph, a commit opens its files and diffs; a failed pull is verbatim', async () => {
  await panel.getByRole('radio', { name: 'Лог' }).click();
  const log = page.getByTestId('git-log');
  await log.getByText('Логин: новый поток').waitFor();
  await log.getByText('v0.1', { exact: true }).waitFor();
  await log.getByText('origin/main', { exact: true }).waitFor();
  await log.getByText('Test Author').first().waitFor();
  assert.ok(await log.locator('svg line').count() > 0);
  await log.getByRole('button', { name: /Логин: новый поток/ }).click();
  await panel.getByRole('button', { name: /src\.ts/ }).waitFor();
  await page.getByTestId('git-diff').last().getByText('export const a = 2;').waitFor();
  await shot('git-log.png');

  put('ahead.txt', 'a\n');
  commit('Мой локальный');
  put('theirs.txt', 't\n', other);
  g(other, 'pull', '-q', '--no-rebase', '--no-edit');
  commit('Их коммит', other);
  g(other, 'push', '-q');
  await panel.getByRole('button', { name: 'Fetch', exact: true }).click();
  await panel.getByRole('button', { name: /^Pull 1$/ }).click();
  await panel.getByRole('alert').getByText(/Not possible to fast-forward|fatal/).waitFor();
  assert.deepEqual(errors, []);
});
