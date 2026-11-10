// IDE+ from plugins/, copied into throwaway directories, through the real server and the real plugins screen and the fake Claude CLI.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import { seedSetupDone } from '../server/chat/fixtures/harness.ts';
import type { Tab } from '../shared/contract.ts';

const REPO = join(import.meta.dirname, '..');
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const PORT = 47917;
const base = `http://127.0.0.1:${PORT}`;
let dir: string;
let cwd: string;
let server: ChildProcess;
let browser: Browser;
let page: Page;
const errors: string[] = [];

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-os-ide-plus-'));
  mkdirSync(join(dir, 'claude/projects'), { recursive: true });
  cpSync(join(REPO, 'plugins/ide-plus'), join(dir, 'config/plugins/ide-plus'), { recursive: true });
  cwd = join(dir, 'proj');
  mkdirSync(join(cwd, 'src'), { recursive: true });
  writeFileSync(join(cwd, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(join(cwd, 'crlf.py'), 'x = 1\r\ny = 2\r\n');
  writeFileSync(join(cwd, 'long.md'), Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n'));
  writeFileSync(join(cwd, 'dot.png'), Buffer.from(PNG, 'base64'));
  writeFileSync(join(cwd, 'tone.wav'), wav());
  writeFileSync(join(cwd, 'fake.mp4'), 'not a video at all');
  writeFileSync(join(cwd, 'draw.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="20" viewBox="0 0 40 20"><rect width="40" height="20" fill="#d97757"/><script>window.__svgRan = true</script></svg>\n');
  writeFileSync(join(cwd, 'data.bin'), Buffer.from([0, 1, 2, 3]));
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
  await page.goto(`${base}/auth?token=${token}`);
});

after(async () => {
  await browser?.close();
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

const go = (view: unknown) => page.evaluate((v) => {
  localStorage.setItem('claude-os.view', JSON.stringify(v));
  location.reload();
}, view);
const toolsPane = () => go({ kind: 'os-plugins' });
const row = (name: string) => page.locator(`[data-file-row="${name}"]`);
const editor = () => page.getByTestId('ide-plus-editor');
const openFile = async (name: string) => {
  await row(name).getByRole('button', { name: new RegExp(name.split('/').pop()!.replace('.', '\\.')) }).click();
  await editor().waitFor();
};
const rightClick = (target: Locator) => target.evaluate((el) => {
  const r = el.getBoundingClientRect();
  el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: r.left + 4, clientY: r.top + 4 }));
});
async function toggle(button: string) {
  await page.getByRole('button', { name: button, exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: button, exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
}

// A locator's hasText does not read inside a style element.
const pluginStyles = () => page.evaluate(() => [...document.querySelectorAll('style')].filter((s) => s.textContent?.includes('idep-root')).length);

let tabId: string;

// A real 0.5 s tone: the browser has to decode it, not only fetch it.
function wav() {
  const rate = 8000;
  const samples = rate / 2;
  const out = Buffer.alloc(44 + samples);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(36 + samples, 4);
  out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate, 28);
  out.writeUInt16LE(1, 32);
  out.writeUInt16LE(8, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(samples, 40);
  for (let i = 0; i < samples; i++) out[44 + i] = 128 + Math.round(60 * Math.sin((2 * Math.PI * 440 * i) / rate));
  return out;
}

test('before enabling, the panel is the plain read-only one and the server refuses a save', async () => {
  const res = await page.evaluate(async (path) => {
    const r = await fetch('/api/tabs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd: path, title: 'ide' }) });
    return r.json();
  }, cwd) as Tab;
  tabId = res.id;
  await go({ kind: 'tab', id: tabId });
  await row('crlf.py').waitFor();
  await row('crlf.py').getByRole('button', { name: /crlf/ }).click();
  await page.getByTestId('file-code').waitFor();
  assert.equal(await editor().count(), 0);
  assert.equal(await row('crlf.py').locator('svg.lucide-file-text').count(), 1);
  const status = await page.evaluate(async (id) => (await fetch(`/api/tabs/${id}/file`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'crlf.py', text: 'x', sha: 'x' }) })).status, tabId);
  assert.equal(status, 403);
});

test('enabling: the dialog names the code and its permissions, and the panel changes', async () => {
  await toolsPane();
  await page.getByText('IDE+', { exact: true }).first().waitFor();
  await page.getByRole('button', { name: 'Включить', exact: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByText('files.write, files.reveal, files.media').waitFor();
  await dialog.getByText('с теми же правами').waitFor();
  await dialog.getByRole('button', { name: 'Включить', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });

  await page.evaluate((id) => {
    localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'tab', id }));
  }, tabId);
  await page.reload();
  await row('src').waitFor();
  await row('crlf.py').locator('svg:not(.lucide)').first().waitFor();
});

test('editing: colours by language, a save keeps the line endings, a change on disk asks before overwriting', async () => {
  await openFile('crlf.py');
  const pane = page.getByRole('region', { name: /crlf/ });
  assert.equal(await pane.locator('.hljs-number').count(), 2, 'python is coloured');
  assert.equal(await editor().inputValue(), 'x = 1\ny = 2\n');

  await editor().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('z = 3\n');
  await pane.getByRole('img', { name: 'Есть несохранённые правки' }).waitFor();
  assert.equal(readFileSync(join(cwd, 'crlf.py'), 'utf8'), 'x = 1\r\ny = 2\r\n', 'nothing is written before saving');
  await page.keyboard.press('Control+s');
  await pane.getByRole('status').getByText('Сохранено').waitFor();
  assert.equal(readFileSync(join(cwd, 'crlf.py'), 'utf8'), 'x = 1\r\ny = 2\r\nz = 3\r\n');

  await page.keyboard.type('mine = 4\n');
  writeFileSync(join(cwd, 'crlf.py'), 'from disk\n');
  await pane.getByRole('button', { name: 'Сохранить' }).click();
  await pane.getByRole('alert').waitFor();
  assert.equal(readFileSync(join(cwd, 'crlf.py'), 'utf8'), 'from disk\n', 'a conflict does not overwrite');
  await pane.getByRole('button', { name: 'Перезаписать' }).click();
  await pane.getByRole('alert').waitFor({ state: 'hidden' });
  assert.match(readFileSync(join(cwd, 'crlf.py'), 'utf8'), /mine = 4\r?\n$/);
});

test('a draft survives closing the pane; the caret stays in view in a long file', async () => {
  await openFile('long.md');
  await editor().click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('!');
  const scrollTop = await page.locator('.idep-scroll').evaluate((el) => el.scrollTop);
  assert.ok(scrollTop > 1000, `scrolled to the caret, got ${scrollTop}`);

  await openFile('crlf.py');
  await openFile('long.md');
  assert.match(await editor().inputValue(), /line 400!$/);
  assert.doesNotMatch(readFileSync(join(cwd, 'long.md'), 'utf8'), /!/);
});

test('the text in the editor lines up with the coloured text under it at every size', async () => {
  const measure = () => page.evaluate(() => {
    const area = document.querySelector<HTMLTextAreaElement>('.idep-input')!;
    const text = document.querySelector<HTMLElement>('.idep-text')!;
    const a = getComputedStyle(area);
    const b = getComputedStyle(text);
    return {
      same: ['fontFamily', 'fontSize', 'lineHeight', 'letterSpacing', 'tabSize', 'paddingLeft', 'paddingTop', 'whiteSpace'].filter((k) => a[k as never] !== b[k as never]),
      size: parseFloat(b.fontSize),
      height: area.getBoundingClientRect().height - text.getBoundingClientRect().height,
      scrollDiff: area.scrollWidth - area.clientWidth,
    };
  });
  const before = await measure();
  assert.deepEqual(before.same, []);
  assert.equal(before.height, 0);
  assert.equal(before.scrollDiff, 0, 'the textarea does not scroll on its own');

  await editor().click();
  await page.keyboard.press('Control+=');
  await page.keyboard.press('Control+=');
  assert.equal((await measure()).size, before.size + 2);
  await page.mouse.move(800, 500);
  await page.locator('.idep-scroll').hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, 100);
  await page.keyboard.up('Control');
  await page.waitForFunction((size) => parseFloat(getComputedStyle(document.querySelector('.idep-text')!).fontSize) === size, before.size + 1);
  const after = await measure();
  assert.deepEqual(after.same, []);
  await editor().click();
  await page.keyboard.press('Control+0');
  await page.waitForFunction(() => parseFloat(getComputedStyle(document.querySelector('.idep-text')!).fontSize) === 12);
  assert.equal(await page.evaluate(() => localStorage.getItem('ide-plus.font-size')), '12');
});

test('the pane can be dragged wider', async () => {
  const pane = page.getByRole('region', { name: /long\.md/ });
  const before = (await pane.boundingBox())!;
  const handle = (await pane.getByRole('separator').boundingBox())!;
  await page.mouse.move(handle.x + 3, handle.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle.x + 203, handle.y + 200, { steps: 4 });
  await page.mouse.up();
  const after = (await pane.boundingBox())!;
  assert.ok(Math.abs(after.width - before.width - 200) < 2, `${before.width} -> ${after.width}`);
  await page.screenshot({ path: join(dir, 'ide-plus.png') });
  if (process.env.IDE_PLUS_SHOT) writeFileSync(process.env.IDE_PLUS_SHOT, readFileSync(join(dir, 'ide-plus.png')));
});

test('right click opens a file or folder in the file manager', async () => {
  const sent: unknown[] = [];
  // No real window from a test: the route is covered by the server's tests.
  await page.route('**/reveal', (route) => {
    sent.push(route.request().postDataJSON());
    return route.fulfill({ json: { ok: true } });
  });
  for (const name of ['src', 'crlf.py']) {
    await rightClick(row(name));
    await page.getByRole('menuitem', { name: 'Открыть в проводнике' }).click();
  }
  await page.unroute('**/reveal');
  assert.deepEqual(sent, [{ path: 'src' }, { path: 'crlf.py' }]);
});

test('media: a picture with its size and zoom, a tone that really decodes, an SVG as a picture that runs nothing and as code', async () => {
  await row('dot.png').getByRole('button', { name: /dot/ }).click();
  const picture = page.getByTestId('ide-plus-picture');
  await picture.waitFor();
  await page.getByTestId('ide-plus-size').getByText('1×1').waitFor();
  assert.equal(await picture.evaluate((el: HTMLImageElement) => el.complete && el.naturalWidth), 1);
  await page.getByRole('button', { name: 'Увеличить', exact: true }).click();
  await page.getByText(/^\d+%$/).waitFor();
  await page.getByRole('button', { name: 'По размеру панели' }).click();
  assert.equal(await picture.evaluate((el) => el.classList.contains('idep-fit')), true);
  await page.screenshot({ path: process.env.IDE_PLUS_SHOT_PICTURE ?? join(dir, 'picture.png') });

  await row('tone.wav').getByRole('button', { name: /tone/ }).click();
  const audio = page.getByTestId('ide-plus-audio');
  await audio.waitFor();
  await page.getByTestId('ide-plus-meta').getByText('0:01').or(page.getByTestId('ide-plus-meta').getByText('0:00')).first().waitFor();
  const seekable = await audio.evaluate(async (el: HTMLAudioElement) => {
    el.currentTime = 0.3;
    await new Promise((done) => { el.addEventListener('seeked', done, { once: true }); });
    return { at: el.currentTime, error: el.error?.code ?? null, duration: el.duration };
  });
  assert.equal(seekable.error, null);
  assert.ok(Math.abs(seekable.duration - 0.5) < 0.02, String(seekable.duration));
  assert.ok(Math.abs(seekable.at - 0.3) < 0.05, String(seekable.at));
  await page.screenshot({ path: process.env.IDE_PLUS_SHOT_AUDIO ?? join(dir, 'audio.png') });

  await row('fake.mp4').getByRole('button', { name: /fake/ }).click();
  await page.getByRole('alert').getByText('не получается показать').waitFor();
  const refused = await page.evaluate(async (id) => (await fetch(`/api/tabs/${id}/media?path=fake.mp4`)).status, tabId);
  assert.equal(refused, 415);

  await row('draw.svg').getByRole('button', { name: /draw/ }).click();
  await page.getByTestId('ide-plus-size').getByText('40×20').waitFor();
  assert.equal(await page.evaluate(() => (window as unknown as { __svgRan?: boolean }).__svgRan), undefined, 'a script in the file does not run');
  await page.getByRole('button', { name: 'Код', exact: true }).click();
  await editor().waitFor();
  assert.match(await editor().inputValue(), /<rect/);
  await page.getByRole('button', { name: 'Просмотр', exact: true }).click();
  await page.getByTestId('ide-plus-picture').waitFor();

  await row('data.bin').getByRole('button', { name: /data/ }).click();
  await page.getByText(/Двоичный|двоичн|бинарн/i).first().waitFor();
});

test('media: a video recorded in the browser plays, seeks over ranges, and the tree shows its icon', async () => {
  const recorded = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const g = canvas.getContext('2d')!;
    const stream = canvas.captureStream(20);
    const recorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    const parts: Blob[] = [];
    recorder.ondataavailable = (e) => parts.push(e.data);
    const stopped = new Promise((done) => { recorder.onstop = done; });
    recorder.start();
    for (let i = 0; i < 16; i++) {
      g.fillStyle = `hsl(${i * 20} 80% 50%)`;
      g.fillRect(0, 0, 64, 48);
      await new Promise((done) => setTimeout(done, 50));
    }
    recorder.stop();
    await stopped;
    const bytes = new Uint8Array(await new Blob(parts).arrayBuffer());
    return Array.from(bytes);
  });
  writeFileSync(join(cwd, 'clip.webm'), Buffer.from(recorded));
  await page.reload();
  await row('clip.webm').locator('svg:not(.lucide)').first().waitFor();
  await row('clip.webm').getByRole('button', { name: /clip/ }).click();
  const video = page.getByTestId('ide-plus-video');
  await video.waitFor();
  await page.waitForFunction(() => {
    const el = document.querySelector<HTMLVideoElement>('[data-testid="ide-plus-video"]');
    return el && el.readyState >= 1;
  }).catch(async (e) => {
    const state = await video.evaluate((el: HTMLVideoElement) => ({ ready: el.readyState, net: el.networkState, error: el.error?.message, w: el.videoWidth, src: el.currentSrc }));
    throw new Error(`the video never loaded: ${JSON.stringify(state)}; ${(e as Error).message}`);
  });
  await page.getByTestId('ide-plus-meta').getByText(/64×48/).waitFor();
  assert.equal(await video.evaluate((el: HTMLVideoElement) => el.error?.code ?? null), null);
  const range = await page.evaluate(async (id) => {
    const r = await fetch(`/api/tabs/${id}/media?path=clip.webm`, { headers: { range: 'bytes=0-9' } });
    return { status: r.status, type: r.headers.get('content-type'), size: (await r.arrayBuffer()).byteLength };
  }, tabId);
  assert.deepEqual(range, { status: 206, type: 'video/webm', size: 10 });
  await page.screenshot({ path: process.env.IDE_PLUS_SHOT_VIDEO ?? join(dir, 'video.png') });
});

test('switching it off and on applies without a reload, and the server refuses while it is off', async () => {
  // Through the API while the panel stays open: nothing but the plugin list has to reach the page.
  const flip = (action: 'enable' | 'disable') => page.evaluate(async (a) => {
    const post = (url: string, body: unknown) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
    const plan = await post('/api/os-plugins/ide-plus/preview', { action: a });
    return post(`/api/os-plugins/ide-plus/${a}`, { confirmed: true, sha: plan.sha });
  }, action);
  await row('crlf.py').getByRole('button', { name: /crlf/ }).click();
  await editor().waitFor();
  const off = await flip('disable');
  assert.equal(off.rows[0].enabled, false);
  await page.getByTestId('file-code').waitFor();
  assert.equal(await editor().count(), 0);
  assert.equal(await pluginStyles(), 0, 'its styles are gone');
  assert.equal(await row('crlf.py').locator('svg.lucide-file-text').count(), 1);
  const status = await page.evaluate(async (id) => (await fetch(`/api/tabs/${id}/file`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'crlf.py', text: 'x', sha: 'x' }) })).status, tabId);
  assert.equal(status, 403);

  await flip('enable');
  await page.getByTestId('ide-plus-video').or(editor()).first().waitFor();
  assert.equal(await pluginStyles(), 1);
  assert.deepEqual(errors, []);
});
