// The README GIF: home map, a new task in a tab, Claude answering live, then analytics. The answer is pushed by the
// fixture over the socket, the way the real server streams a turn. ffmpeg turns the recorded video into a GIF.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright';
import type { ChatEvent } from '../../shared/contract.ts';
import { tokens, type FixtureServer } from '../fixture-server.ts';
import { nav, openMenu, openPage, openTab, OUT } from './page.ts';

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

async function play(page: Page, fx: FixtureServer): Promise<void> {
  await page.waitForTimeout(3500);
  await openTab(page, 'web-dashboard · dark mode');
  await page.waitForTimeout(800);
  const box = page.getByPlaceholder(/Message to session/);
  await box.click();
  await box.pressSequentially(PROMPT, { delay: 45 });
  await page.waitForTimeout(400);
  await box.press('Enter');
  await streamAnswer(page, fx);
  await page.waitForTimeout(2500);
  await openMenu(page, 'Analytics');
  await page.waitForTimeout(2500);
  await nav(page).getByRole('button', { name: 'Home', exact: true }).click();
  await page.waitForTimeout(2500);
}

/** Records the scenario and writes docs/media/demo.gif. Needs ffmpeg on PATH. */
export async function recordGif(browser: Browser, fx: FixtureServer): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'claude-os-demo-'));
  const opened = Date.now();
  const { page, done } = await openPage(browser, fx, dir);
  const loaded = Date.now();
  await play(page, fx);
  const video = await page.video()?.path();
  await done();
  if (!video) throw new Error('no video recorded');
  // The page loads before play() starts: cut that part, keep the rest at 10 frames a second, full size.
  const skip = String((loaded - opened) / 1000);
  const filters = 'fps=10,split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle';
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-ss', skip, '-i', video, '-vf', filters, '-loop', '0', join(OUT, 'demo.gif')]);
  rmSync(dir, { recursive: true, force: true });
  console.log('gif', join(OUT, 'demo.gif'));
}
