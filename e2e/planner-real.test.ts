// The planner against the real server: notes and images on a throwaway disk, the fake Claude CLI. Port of its own.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Page } from 'playwright';
import { seedSetupDone } from '../server/chat/fixtures/harness.ts';

const REPO = join(import.meta.dirname, '..');
const PORT = 47931;
const base = `http://127.0.0.1:${PORT}`;
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAEBgIApD5fRAAAAABJRU5ErkJggg==';
let dir: string;
let server: ChildProcess;
let browser: Browser;
let page: Page;
const errors: string[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-os-planner-e2e-'));
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
      FAKE_CLAUDE_SERVICE: 'do',
      FAKE_CLAUDE_LOG: join(dir, 'fake.log'),
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

const waitFile = async (file: string, re: RegExp) => {
  for (let i = 0; i < 100 && !re.test(readFileSync(file, 'utf8')); i++) await new Promise((r) => setTimeout(r, 50));
  assert.match(readFileSync(file, 'utf8'), re);
};
const parseHead = (file: string) => {
  const head = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, 'utf8'))![1];
  return { title: JSON.parse(/^title: (.*)$/m.exec(head)![1]) as string };
};

const findNote = (at: string): string | null => {
  for (const e of readdirSync(at, { withFileTypes: true })) {
    const path = join(at, e.name);
    if (e.isDirectory()) {
      const found = findNote(path);
      if (found) return found;
    } else if (e.name.endsWith('.md')) return path;
  }
  return null;
};

test('save, check, delete an item and paste an image: all of it on disk', async () => {
  await page.getByText('Проектов пока нет').waitFor();
  await page.keyboard.press('Control+k');
  const search = page.getByPlaceholder('Вкладки, проекты, действия, заметки…');
  await search.fill('планер');
  await page.getByRole('option', { name: /Планер: записать заметку/ }).click();
  const p = page.getByRole('complementary', { name: 'Планер' });
  await p.getByText('Заметок пока нет.').waitFor();

  const box = p.getByRole('textbox', { name: 'Новая заметка' });
  await box.fill('Релиз\n- [ ] Обновить версию\n- [ ] Написать заметку');
  await box.evaluate((el, b64) => {
    const data = new DataTransfer();
    data.items.add(new File([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], 'shot.png', { type: 'image/png' }));
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, PNG);
  await p.getByRole('button', { name: 'Открыть в полный размер' }).waitFor();
  const images = join(dir, 'data/planner/images');
  const [name] = readdirSync(images);
  assert.match(name, /^\d{4}-\d{2}-\d{2}-[0-9a-f]{16}\.png$/);
  assert.equal(readFileSync(join(images, name)).toString('base64'), PNG);

  await p.getByRole('button', { name: 'Записать', exact: true }).click();
  const note = p.locator('[data-planner-note]').filter({ hasText: 'Релиз' });
  await note.getByText('0/2').waitFor();
  const file = findNote(join(dir, 'data/planner/inbox'))!;
  assert.ok(readFileSync(file, 'utf8').endsWith(`Релиз\n- [ ] Обновить версию\n- [ ] Написать заметку\n${join(images, name)}`));

  await note.getByRole('button', { expanded: false }).click();
  await note.locator('[data-planner-item="Написать заметку"]').getByRole('checkbox').check({ force: true });
  await note.getByText('1/2').waitFor();
  await waitFile(file, /- \[ \] Обновить версию\n- \[x\] Написать заметку/);

  // Long and odd text, typed right into the note: on disk as it stands, with the frontmatter whole.
  const body = note.getByRole('textbox', { name: 'Текст заметки' });
  await body.click();
  await body.press('Control+End');
  await page.keyboard.type(`\n---\ntitle: чужой "ключ"\n${'z'.repeat(300)}`);
  await waitFile(file, new RegExp(`Релиз\\n---\\ntitle: чужой "ключ"\\n${'z'.repeat(300)}\\n- \\[ \\] Обновить версию`));
  assert.equal(JSON.stringify(parseHead(file)), JSON.stringify({ title: 'Релиз' }));

  await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>('[data-planner-note] img')].some((i) => i.naturalWidth === 1));
  await note.getByRole('button', { name: 'Открыть в полный размер' }).click();
  const viewer = page.getByRole('dialog', { name: join(images, name) });
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>('[role=dialog] img')?.naturalWidth === 1);
  await page.keyboard.press('Escape');
  await viewer.waitFor({ state: 'detached' });

  await note.locator('[data-planner-item="Обновить версию"]').hover();
  await note.getByRole('button', { name: /Удалить пункт «Обновить версию»/ }).click();
  await note.getByText('1/1').waitFor();
  await waitFile(file, /^(?![\s\S]*Обновить версию)/);
  assert.ok(existsSync(file));
  assert.deepEqual(errors, []);
});

test('the image route answers only for its own folder, and only to the logged-in', async () => {
  const cookie = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join('; ');
  const get = (path: string, headers: Record<string, string> = { cookie }) => fetch(`${base}${path}`, { headers });
  const [name] = readdirSync(join(dir, 'data/planner/images'));
  assert.equal((await get(`/api/planner/images/${name}`)).headers.get('content-type'), 'image/png');
  assert.equal((await get(`/api/planner/images/${name}`, {})).status, 401);
  for (const bad of ['..%2F..%2Ftoken', '%2e%2e%2ftoken', '..%2Finbox', 'x.svg']) {
    const res = await get(`/api/planner/images/${bad}`);
    assert.equal(res.status, 400, bad);
  }
});

test('filing goes through the hidden session: the note shows at once, then moves on disk, and the root chat stays empty', async () => {
  const p = page.getByRole('complementary', { name: 'Планер' });
  await p.getByRole('textbox', { name: 'Новая заметка' }).fill('Заметка для раскладки');
  await p.getByRole('button', { name: 'Записать', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Разложить с Claude' }).click();
  const note = p.locator('[data-planner-note]').filter({ hasText: /Заметка для раскладки|Разложено/ });
  await note.waitFor();
  await note.getByText('Фейк').waitFor();
  await note.getByText('Разложено').waitFor();
  await note.getByText('0/2').waitFor(); // Claude split it into items and named it
  const id = await note.getAttribute('data-planner-note');
  assert.ok(existsSync(join(dir, `data/planner/general/фейк/${id}.md`)));
  assert.ok(!existsSync(join(dir, `data/planner/inbox/${id}.md`)));

  const log = readFileSync(join(dir, 'fake.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { kind: string; cwd?: string });
  assert.equal(log.filter((l) => l.kind === 'spawn').at(-1)!.cwd, join(REPO, 'service'));
  assert.equal(log.filter((l) => l.kind === 'user').length, 1); // the job, and nothing to the root session
  assert.match(readFileSync(join(dir, `data/planner/general/фейк/${id}.md`), 'utf8'), /- \[ \] первый\n- \[ \] второй$/);
  assert.equal(await page.getByRole('tab', { name: /Служеб|Service/ }).count(), 0);
  assert.deepEqual(errors, []);
});
