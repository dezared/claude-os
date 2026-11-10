// The whole path with a fake model: real server, real Chromium capture from a fake microphone, fake engine behind CLAUDE_OS_VOICE_ENGINE.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from 'playwright';
import { seedSetupDone } from '../server/chat/fixtures/harness.ts';
import { homeButton } from './fixture-server.ts';

const REPO = join(import.meta.dirname, '..');
const PORT = 47931;
const base = `http://127.0.0.1:${PORT}`;
let dir: string;
let server: ChildProcess;
let browser: Browser;
let context: BrowserContext;
let page: Page;
let token: string;
const errors: string[] = [];

// A warbling tone in bursts, which the browser's noise suppression does not take for steady noise.
function speechLikeWav(sec: number): Buffer {
  const rate = 48_000;
  const n = sec * rate;
  const b = Buffer.alloc(44 + n * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / rate;
    const envelope = Math.max(0, Math.sin(2 * Math.PI * 3 * t));
    const voice = Math.sin(2 * Math.PI * (180 + 60 * Math.sin(2 * Math.PI * 5 * t)) * t) + 0.5 * Math.sin(2 * Math.PI * 900 * t) + 0.3 * (Math.random() - 0.5);
    b.writeInt16LE(Math.round(envelope * voice * 12_000), 44 + i * 2);
  }
  return b;
}

const voiceDir = () => join(dir, 'data/voice');
const box = () => page.getByRole('textbox', { name: /Начни новый проект/ });
const mic = () => page.getByRole('button', { name: 'Голосовой ввод' });
const MENU = "Меню";
const PLANNER_FIELD = 'Новая заметка';
const stopButton = () => page.getByRole('button', { name: 'Остановить запись' });

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'claude-os-voice-'));
  mkdirSync(join(dir, 'claude/projects'), { recursive: true });
  const wav = join(dir, 'mic.wav');
  writeFileSync(wav, speechLikeWav(4));
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
      CLAUDE_OS_VOICE_ENGINE: join(REPO, 'server/voice/fixtures/fake-engine.ts'),
      CLAUDE_OS_VOICE_FAKE_DELAY_MS: '500', // long enough to see the state while it transcribes
      CLAUDE_OS_VOICE_FAKE_TEXT_FILE: join(dir, 'fake-text'),
    },
  });
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${base}/health`)).ok) break;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  token = readFileSync(join(dir, 'data/token'), 'utf8').trim();
  browser = await chromium.launch({
    channel: 'chromium', // the full build: the default headless shell has no audio capture
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`],
  });
  context = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce', permissions: ['microphone'] });
  page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}/auth?token=${token}`);
});

after(async () => {
  await browser?.close();
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});

test('nothing is downloaded until the user asks; the dialog names the size, then shows progress', async () => {
  await mic().waitFor();
  assert.equal(existsSync(voiceDir()), false);
  await mic().click();
  await page.getByRole('dialog').getByText('252 МБ').first().waitFor();
  assert.equal(existsSync(voiceDir()), false, 'opening the dialog downloads nothing');
  await page.getByRole('button', { name: /^Скачать/ }).click();
  await page.getByRole('progressbar', { name: 'Скачиваю модель' }).waitFor();
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.ok(existsSync(join(voiceDir(), 'installed')));
  assert.deepEqual(errors, []);
});

test('record and stop: the level moves, the text lands at the caret, nothing is sent', async () => {
  await box().fill('начало конец');
  await box().evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(6, 6));
  await mic().click();
  await stopButton().waitFor();
  const meter = page.getByRole('meter', { name: 'Уровень микрофона' });
  await page.waitForFunction(() => Number(document.querySelector('[role="meter"]')?.getAttribute('aria-valuenow')) > 0);
  assert.ok(Number(await meter.getAttribute('aria-valuenow')) > 0);
  await page.waitForTimeout(1500);

  // Recording: the words stand at the caret, greyed, and the field takes neither typing nor Enter.
  assert.equal(await box().inputValue(), 'начало Говорите... конец');
  assert.equal(await box().evaluate((el: HTMLTextAreaElement) => el.readOnly), true);
  assert.equal(await box().evaluate((el) => (el as HTMLElement).style.color), 'var(--color-dim)');
  await box().focus();
  await page.keyboard.type('x');
  await page.keyboard.press('Enter');
  assert.equal(await box().inputValue(), 'начало Говорите... конец');
  assert.equal(await page.getByRole('button', { name: 'Отправить' }).isDisabled(), true);

  await stopButton().click();
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('textarea')?.value.includes('Распознаю речь'));
  assert.equal(await box().evaluate((el: HTMLTextAreaElement) => el.readOnly), true);
  await page.waitForFunction(() => !document.querySelector<HTMLTextAreaElement>('textarea')?.readOnly);
  assert.equal(await box().evaluate((el) => (el as HTMLElement).style.color), '');
  const value = await box().inputValue();
  assert.match(value, /^начало .+ конец$/);
  // The fake engine reports what reached it: at least the 1.5 s held, as 16 kHz float samples, and no minutes of stale audio.
  const bytes = Number(/\((\d+) байт\)/.exec(value)?.[1]);
  assert.ok(bytes > 16_000 * 4 && bytes < 16_000 * 4 * 10, `sent ${bytes} bytes`);
  // The caret is placed on the frame after the text.
  await page.waitForFunction(() => {
    const el = document.querySelector<HTMLTextAreaElement>('textarea');
    return el && el.value.slice(el.selectionStart) === ' конец';
  });
  assert.equal(await page.getByText(/echo:/).count(), 0);
  await box().fill('');
  assert.deepEqual(errors, []);
});

test('the temporary words never reach the saved draft', async () => {
  await box().fill('черновик');
  await mic().click();
  await stopButton().waitFor();
  await page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>('textarea')?.value.includes('Говорите'));
  await page.reload();
  await box().waitFor();
  assert.equal(await box().inputValue(), 'черновик');
  await box().fill('');
  assert.deepEqual(errors, []);
});

test('silence puts the field back as it was and unlocks it', async () => {
  writeFileSync(join(dir, 'fake-text'), '');
  await box().fill('как было');
  await mic().click();
  await stopButton().waitFor();
  await stopButton().click();
  await page.getByRole('alert').getByText('Речь не услышана').waitFor();
  assert.equal(await box().inputValue(), 'как было');
  assert.equal(await box().evaluate((el: HTMLTextAreaElement) => el.readOnly), false);
  await page.getByRole('alert').getByRole('button').click();
  await box().fill('');
  rmSync(join(dir, 'fake-text'));
});

const waitForWhite = async (button: Locator) => {
  for (let i = 0; i < 100; i++) {
    if ((await button.evaluate((el) => getComputedStyle(el).color)) === 'rgb(255, 255, 255)') return;
    await new Promise((r) => setTimeout(r, 30));
  }
  assert.fail('the switch at rest is white');
};

test('planner: the same control, by items by default, plain text with the switch off, and no saving mid-dictation', async () => {
  await page.getByRole('button', { name: MENU }).click();
  await page.getByRole('menuitem', { name: 'Планер' }).click();
  const panel = page.getByRole('complementary', { name: 'Планер' });
  const field = panel.getByRole('textbox', { name: PLANNER_FIELD });
  await field.waitFor();
  const plannerMic = panel.getByRole('button', { name: 'Голосовой ввод' });

  writeFileSync(join(dir, 'fake-text'), 'Купить молоко. Позвонить маме, пункт оплатить счёт');
  await field.fill('Список');
  await plannerMic.click();
  await panel.getByRole('button', { name: 'Остановить запись' }).waitFor();
  assert.equal(await field.evaluate((el: HTMLTextAreaElement) => el.readOnly), true);
  assert.equal(await field.inputValue(), 'Список Говорите...');
  assert.equal(await panel.getByRole('button', { name: 'Записать', exact: true }).isDisabled(), true);
  await panel.getByRole('textbox', { name: PLANNER_FIELD }).click({ button: 'right' });
  assert.equal(await page.getByRole('menuitem', { name: 'Разложить с Claude' }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(1500);
  await panel.getByRole('button', { name: 'Остановить запись' }).click();
  await page.waitForFunction((label) => {
    const el = document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`);
    return el && !el.readOnly;
  }, PLANNER_FIELD);
  assert.equal(await field.inputValue(), 'Список\n- [ ] Купить молоко\n- [ ] Позвонить маме\n- [ ] Оплатить счёт');

  await panel.getByRole('button', { name: /Диктовать по пунктам/ }).click();
  assert.equal(await panel.getByRole('button', { name: /Диктовать по пунктам/ }).getAttribute('aria-pressed'), 'false');
  await page.mouse.move(0, 0);
  await waitForWhite(panel.getByRole('button', { name: /Диктовать по пунктам/ }));
  writeFileSync(join(dir, 'fake-text'), 'Просто текст. Без пунктов');
  await field.fill('');
  await plannerMic.click();
  await panel.getByRole('button', { name: 'Остановить запись' }).waitFor();
  await page.waitForTimeout(1500); // shorter than this is silence to the server, and the engine is never asked
  await panel.getByRole('button', { name: 'Остановить запись' }).click();
  await page.waitForFunction((label) => document.querySelector<HTMLTextAreaElement>(`textarea[aria-label="${label}"]`)?.value === 'Просто текст. Без пунктов', PLANNER_FIELD);

  await panel.getByRole('button', { name: /Диктовать по пунктам/ }).click();
  await field.fill('');
  rmSync(join(dir, 'fake-text'));
  assert.equal(await page.getByRole('button', { name: /Диктовать по пунктам/ }).count(), 1, 'the switch is in the planner only');
  await panel.getByRole('button', { name: 'Скрыть' }).click();
  assert.deepEqual(errors, []);
});

test('no microphone permission gives a clear state instead of a dead button', async () => {
  const denied = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  const p = await denied.newPage();
  await p.goto(`${base}/auth?token=${token}`);
  await p.getByRole('button', { name: 'Голосовой ввод' }).click();
  await p.getByRole('alert').getByText(/Нет доступа к микрофону/).waitFor();
  await denied.close();
});

test('settings show the size and remove the model; the mic asks again afterwards', async () => {
  await page.getByRole('button', { name: MENU }).click();
  await page.getByRole('menuitem', { name: 'Настройки' }).click();
  await page.getByRole('button', { name: 'Голосовой ввод' }).click();
  await page.getByText('whisper-small').waitFor();
  await page.getByText('На диске: 0 МБ').waitFor(); // the fake model is 4 KB
  await page.getByRole('button', { name: 'Удалить модель' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Удалить модель' }).click();
  await page.getByRole('button', { name: 'Включить и скачать' }).waitFor();
  assert.equal(existsSync(voiceDir()), false);
  await homeButton(page).click();
  await mic().click();
  await page.getByRole('dialog').getByText('252 МБ').first().waitFor();
  await page.keyboard.press('Escape');
  assert.equal(existsSync(voiceDir()), false, 'closing the dialog downloads nothing');
  assert.deepEqual(errors, []);
});
