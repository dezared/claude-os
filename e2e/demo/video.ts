// The README video: home map, a new task in a tab, Claude answering live, the palette, analytics. The answer is pushed
// by the fixture over the socket, the way the real server streams a turn. Recorded at 60 fps through the screencast.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import type { ChatEvent } from '../../shared/contract.ts';
import { tokens, type FixtureServer } from '../fixture-server.ts';
import { glide, glideClick, glideTo, smoothScroll } from './cursor.ts';
import { nav, openPage, OUT } from './page.ts';
import { record, toMp4, toWebp } from './screencast.ts';

const TAB = 't2';
const PROMPT = 'Add a dark mode toggle to the settings page';
const ANSWER = 'Done. The toggle sits in **Settings → Appearance** and is stored in `localStorage`, so the choice survives a reload. The theme switches through a `data-theme` attribute on `<html>`; both colour sets live in `theme.css`.';
const FILE = '/home/dev/web-dashboard/src/pages/Settings.tsx';

let seq = 0;
const send = (fx: FixtureServer, body: Record<string, unknown>) => fx.push({ t: 'chat', tabId: TAB, event: { seq: ++seq, at: Date.now(), ...body } as ChatEvent });
const tool = (id: string, name: string, input: unknown) => ({ e: 'assistant', messageId: `g-${id}`, model: 'claude-opus-5-5', blocks: [{ type: 'tool_use', id, name, input }] });

async function streamAnswer(page: Page, fx: FixtureServer): Promise<void> {
  const pause = (ms: number) => page.waitForTimeout(ms);
  send(fx, { e: 'user', blocks: [{ type: 'text', text: PROMPT }] });
  send(fx, { e: 'status', status: 'working' });
  await pause(900);
  send(fx, tool('g1', 'Grep', { pattern: 'theme', path: 'src' }));
  await pause(500);
  send(fx, { e: 'tool_result', toolUseId: 'g1', text: 'src/pages/Settings.tsx:14\nsrc/styles/theme.css:1', isError: false });
  send(fx, tool('g2', 'Read', { file_path: FILE }));
  await pause(700);
  send(fx, { e: 'tool_result', toolUseId: 'g2', text: 'export function Settings() { ... }', isError: false });
  send(fx, tool('g3', 'Edit', { file_path: FILE, old_string: '<Section title="Appearance">', new_string: '<Section title="Appearance">\n  <ThemeToggle />' }));
  await pause(700);
  send(fx, { e: 'tool_result', toolUseId: 'g3', text: 'The file has been updated.', isError: false });
  send(fx, tool('g4', 'Bash', { command: 'npm test -- settings' }));
  await pause(900);
  send(fx, { e: 'tool_result', toolUseId: 'g4', text: 'PASS  settings.test.tsx (6 tests)', isError: false });
  for (const word of ANSWER.split(/(?<= )/)) {
    send(fx, { e: 'delta', messageId: 'g-final', text: word });
    await pause(45);
  }
  send(fx, { e: 'assistant', messageId: 'g-final', model: 'claude-opus-5-5', blocks: [{ type: 'text', text: ANSWER }] });
  send(fx, { e: 'result', usage: tokens(40, 1900, 52_000, 410_000), costUsd: 0.18, interrupted: false, error: null });
  send(fx, { e: 'status', status: 'idle' });
}

/** Home: a slow look over the projects and the map. */
async function lookAround(page: Page): Promise<void> {
  await glideTo(page, 900, 520, 10);
  await page.waitForTimeout(900);
  await glide(page, page.getByText('payments-api', { exact: true }).last(), 900);
  await page.waitForTimeout(500);
  await glide(page, page.getByText('ml-lab', { exact: true }).last(), 900);
  await page.waitForTimeout(600);
}

/** A tab: type a task and send it, then watch Claude work. */
async function runTask(page: Page, fx: FixtureServer): Promise<void> {
  await glideClick(page, nav(page).getByText('web-dashboard · dark mode', { exact: true }), 800);
  await page.waitForTimeout(700);
  const box = page.getByPlaceholder(/Message to session/);
  await glideClick(page, box, 700);
  await box.pressSequentially(PROMPT, { delay: 38 });
  await page.waitForTimeout(300);
  await glideClick(page, page.getByRole('button', { name: 'Send' }), 500);
  await glideTo(page, 560, 360, 700);
  await streamAnswer(page, fx);
  await page.waitForTimeout(1800);
}

/** The palette to analytics, a scroll down, back home. */
async function paletteToAnalytics(page: Page): Promise<void> {
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(500);
  await page.keyboard.type('analytics', { delay: 60 });
  await page.waitForTimeout(400);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1600);
  await glideTo(page, 700, 500, 600);
  await smoothScroll(page, 520, 1200);
  await page.waitForTimeout(1200);
  await smoothScroll(page, -520, 900);
  await glideClick(page, nav(page).getByRole('button', { name: 'Home', exact: true }), 900);
  await page.waitForTimeout(2200);
}

/** Records the scenario into docs/media/demo.mp4 and docs/media/demo.webp. Needs ffmpeg with libx264 and libwebp. */
export async function recordVideo(browser: Browser, fx: FixtureServer): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'claude-os-demo-'));
  const { page, done } = await openPage(browser, fx, true);
  await page.waitForTimeout(1500);
  const rec = await record(page);
  await lookAround(page);
  await runTask(page, fx);
  await paletteToAnalytics(page);
  const frames = await rec.stop();
  await done();
  const mp4 = join(OUT, 'demo.mp4');
  toMp4(frames, dir, mp4);
  toWebp(mp4, join(OUT, 'demo.webp'), 1280);
  rmSync(dir, { recursive: true, force: true });
  console.log('video', frames.length, 'frames ->', mp4);
}
