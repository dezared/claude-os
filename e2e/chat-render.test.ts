// The chat as it is read: scrolling during a stream, badges, links, images, running subagents. Real server, fake CLI, real browser.
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { chromium, type Browser, type Page } from 'playwright';
import type { ChatEvent, Tab } from '../shared/contract.ts';
import { startServer, waitUntil, type TestServer } from '../server/chat/fixtures/harness.ts';

let srv: TestServer;
let browser: Browser;
let page: Page;
let work: string;
const errors: string[] = [];

before(async () => {
  srv = await startServer();
  work = join(srv.dir, 'work');
  mkdirSync(work);
  browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const ctx = await browser.newContext({ locale: 'ru-RU', viewport: { width: 1600, height: 1000 }, reducedMotion: 'reduce' });
  await ctx.addInitScript(() => { if (localStorage.getItem('claude-os.focus') === null) localStorage.setItem('claude-os.focus', '0'); }); // these tests read the full tool output; focus has its own in commands.test.ts
  ctx.setDefaultTimeout(20_000);
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  const token = readFileSync(join(srv.dataDir, 'token'), 'utf8').trim();
  await page.goto(`http://127.0.0.1:${srv.port}/auth?token=${token}`);
});

after(async () => {
  await browser?.close();
  await srv?.destroy();
  assert.deepEqual(errors, []);
});

async function openWorkTab(cwd = work): Promise<{ id: string; box: ReturnType<Page['getByRole']> }> {
  const res = await srv.api<Tab>('POST', '/api/tabs', { cwd, title: `чат ${Date.now()}` });
  assert.equal(res.status, 200);
  await page.evaluate((id) => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'tab', id })), res.body.id);
  await page.reload();
  const box = page.getByRole('textbox', { name: /Сообщение/ }).first();
  await box.waitFor();
  return { id: res.body.id, box };
}

const say = async (box: ReturnType<Page['getByRole']>, text: string) => {
  await box.fill(text);
  await box.page().getByRole('button', { name: /^(Отправить|В очередь)$/ }).click();
};

const scroller = () => page.getByTestId('transcript-scroller');
const scrollTop = () => scroller().evaluate((el) => el.scrollTop);

/** Every value scrollTop takes for `ms`: a jump between two frames counts even if it comes back. */
const watchScroll = (ms: number) => scroller().evaluate((el, ms) => new Promise<{ tops: number[]; heights: number[] }>((done) => {
  const tops: number[] = [];
  const heights: number[] = [];
  const end = performance.now() + ms;
  const frame = () => {
    tops.push(el.scrollTop);
    heights.push(el.scrollHeight);
    if (performance.now() < end) requestAnimationFrame(frame);
    else done({ tops, heights });
  };
  requestAnimationFrame(frame);
}), ms);

async function longStream(box: ReturnType<Page['getByRole']>) {
  await say(box, 'MANY 40');
  await page.getByText('Сообщение 39', { exact: true }).waitFor();
  // Slower than a scroll event: the first thing after the wheel is the user's scroll, not more text.
  await say(box, 'STREAMLINES 300 250');
  await page.getByText('поток 3', { exact: true }).waitFor();
  const box2 = await scroller().boundingBox();
  await page.mouse.move(box2!.x + box2!.width / 2, box2!.y + box2!.height / 2);
}

test('B13: a short scroll up during a stream stays where the user left it', async () => {
  const { id, box } = await openWorkTab();
  await longStream(box);
  await page.mouse.wheel(0, -20); // well inside a "near the bottom" zone of 60px, even with one more line of the stream
  await page.waitForTimeout(200);
  const left = await scrollTop();
  const seen = await watchScroll(1500);
  assert.ok(seen.heights.at(-1)! > seen.heights[0], 'the stream is still growing the content');
  const moved = seen.tops.filter((t) => Math.abs(t - left) > 1);
  assert.deepEqual(moved, [], `scrollTop left ${left}`);
  await srv.api('POST', `/api/tabs/${id}/interrupt`);
});

test('B13: a long scroll up during a stream stays, the button brings the bottom back and it follows again', async () => {
  const { id, box } = await openWorkTab();
  await longStream(box);
  await page.mouse.wheel(0, -600);
  await page.waitForTimeout(200);
  const left = await scrollTop();
  const seen = await watchScroll(1500);
  assert.deepEqual(seen.tops.filter((t) => Math.abs(t - left) > 1), [], `scrollTop left ${left}`);

  await page.getByRole('button', { name: 'К последнему сообщению' }).click();
  await page.waitForTimeout(100);
  const again = await watchScroll(800);
  assert.ok(again.tops.at(-1)! > again.tops[0], 'follows the stream again');
  const distance = await scroller().evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  assert.ok(distance < 60, `distance ${distance}`);
  await srv.api('POST', `/api/tabs/${id}/interrupt`);
});

test('B13: scrolling up through a long finished transcript moves it by exactly the wheel', async () => {
  const { box } = await openWorkTab();
  await say(box, 'MANY 120');
  await page.getByText('Сообщение 119', { exact: true }).waitFor();
  await page.reload();
  await page.getByText('Сообщение 119', { exact: true }).waitFor();
  const area = await scroller().boundingBox();
  await page.mouse.move(area!.x + area!.width / 2, area!.y + area!.height / 2);
  await page.waitForTimeout(300);
  // Reads where a message on screen sits: if anything above it changes height, it jumps though the user only asked for 300px.
  const probe = () => scroller().evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const items = [...el.querySelectorAll('.msg-item')];
    const on = items.find((i) => i.getBoundingClientRect().bottom > top + 50)!;
    return { index: items.indexOf(on), y: on.getBoundingClientRect().top - top, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
  });
  const jumps: string[] = [];
  for (let i = 0; i < 40; i++) {
    const a = await probe();
    if (a.scrollTop < 300) break;
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(60);
    const b = await scroller().evaluate((el, index) => {
      const top = el.getBoundingClientRect().top;
      const item = el.querySelectorAll('.msg-item')[index];
      return { y: item.getBoundingClientRect().top - top, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight };
    }, a.index);
    assert.equal(b.scrollHeight, a.scrollHeight, 'the scrollbar does not change its mind on the way up');
    if (Math.abs(b.y - a.y - 300) > 2) jumps.push(`step ${i}: moved ${b.y - a.y}, scrollTop ${a.scrollTop} -> ${b.scrollTop}, height ${a.scrollHeight} -> ${b.scrollHeight}`);
  }
  assert.deepEqual(jumps, []);
});

const toBottomButton = () => page.getByRole('button', { name: 'К последнему сообщению' });
const idle = () => page.waitForFunction(() => !document.querySelector('[role=status] .dot-working'));

async function slowStream(box: ReturnType<Page['getByRole']>, ms = 400) {
  await say(box, 'MANY 40');
  await page.getByText('Сообщение 39', { exact: true }).waitFor();
  await say(box, `STREAMLINES 800 ${ms}`);
  await page.getByText('поток 1', { exact: true }).waitFor();
  const area = await scroller().boundingBox();
  await page.mouse.move(area!.x + area!.width / 2, area!.y + area!.height / 2);
}

test('scroll: up a little and a touchpad jitter back during a stream stays up, a real move down comes back', async () => {
  const { id, box } = await openWorkTab();
  await slowStream(box);
  await page.mouse.wheel(0, -30);
  await page.waitForTimeout(80);
  await page.mouse.wheel(0, 3);
  await page.waitForTimeout(100);
  const left = await scrollTop();
  const seen = await watchScroll(1500);
  assert.deepEqual(seen.tops.filter((t) => Math.abs(t - left) > 1), [], `scrollTop left ${left}`);
  assert.equal(await toBottomButton().count(), 1);

  await page.mouse.wheel(0, 400);
  await toBottomButton().waitFor({ state: 'detached' });
  await srv.api('POST', `/api/tabs/${id}/interrupt`);
});

test('scroll: the wheel lets go at once, before the place has moved: an animated wheel starts below a pixel', async () => {
  const { id, box } = await openWorkTab();
  await slowStream(box, 30);
  await page.mouse.wheel(0, -0.2);
  await toBottomButton().waitFor();
  const left = await scrollTop();
  const seen = await watchScroll(600);
  assert.ok(seen.heights.at(-1)! > seen.heights[0], 'the stream is still growing the content');
  assert.deepEqual(seen.tops.filter((t) => Math.abs(t - left) > 1), [], `scrollTop left ${left}`);
  await srv.api('POST', `/api/tabs/${id}/interrupt`);
});

// A real picture: 400x240, so that loading it changes the height.
function bigPng(): Buffer {
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let r = ~0; for (const x of b) r = (r >>> 8) ^ table[(r ^ x) & 255]; return ~r >>> 0; };
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(8 + head.length);
    out.writeUInt32BE(data.length);
    head.copy(out, 4);
    out.writeUInt32BE(crc(head), out.length - 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(400, 0);
  ihdr.writeUInt32BE(240, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const row = Buffer.alloc(1 + 400 * 3, 120);
  row[0] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: 240 }, () => row)))), chunk('IEND', Buffer.alloc(0))]);
}

test('scroll: pictures loading above the place do not bring back the following', async () => {
  const dir = join(work, 'pictures');
  mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 4; i++) writeFileSync(join(dir, `shot${i}.png`), bigPng());
  const { box } = await openWorkTab(dir);
  await page.route('**/image?**', async (route) => {
    await new Promise((r) => setTimeout(r, 900));
    await route.continue();
  });
  await say(box, 'MANY 20');
  await page.getByText('Сообщение 19', { exact: true }).waitFor();
  await say(box, `SAY ${[0, 1, 2, 3].map((i) => `снимок shot${i}.png`).join('\\n\\n')}\\n\\n${'хвост ответа '.repeat(300)}`);
  await page.locator('img.chat-img').first().waitFor({ state: 'attached' });
  await page.waitForTimeout(100);
  const area = await scroller().boundingBox();
  await page.mouse.move(area!.x + area!.width / 2, area!.y + area!.height / 2);
  await page.mouse.wheel(0, -30);
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>('img.chat-img[alt="shot3.png"]')?.complete && document.querySelector<HTMLImageElement>('img.chat-img[alt="shot3.png"]')!.naturalWidth === 400);
  await page.waitForTimeout(200);
  await page.unroute('**/image?**');
  const distance = await scroller().evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  assert.ok(Math.abs(distance - 30) < 3, `the place stays 30px above the bottom, distance ${distance}`);
  assert.equal(await toBottomButton().count(), 1);
});

test('scroll: a tool card opened at the bottom stays under the pointer, closing it follows again', async () => {
  const { box } = await openWorkTab();
  await say(box, 'MANY 15');
  await page.getByText('Сообщение 14', { exact: true }).waitFor();
  const result = Array.from({ length: 60 }, (_, i) => `строка ${i}`).join('\n');
  await say(box, `CALL ${JSON.stringify({ name: 'Bash', input: { command: 'seq-long' }, result })}`);
  await page.getByText('call over').waitFor();
  await idle();
  await page.waitForTimeout(200);
  const row = scroller().locator('button[aria-expanded]').last();
  const y = (await row.boundingBox())!.y;
  await row.click();
  await page.waitForFunction(() => [...document.querySelectorAll('[data-testid=transcript-scroller] button[aria-expanded]')].at(-1)!.getAttribute('aria-expanded') === 'true');
  await page.waitForTimeout(200);
  assert.ok(Math.abs((await row.boundingBox())!.y - y) < 2, 'the row did not move');
  await toBottomButton().waitFor();

  await row.click();
  await toBottomButton().waitFor({ state: 'detached' });
  await say(box, 'SAY новый ответ');
  await page.locator('.md').getByText('новый ответ', { exact: true }).waitFor();
  await idle();
  await page.waitForTimeout(200);
  const distance = await scroller().evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  assert.ok(distance < 2, `follows again, distance ${distance}`);
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==', 'base64');

function seedProject(): string {
  const dir = join(work, 'render');
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), Array.from({ length: 200 }, (_, i) => `export const line${i + 1} = ${i + 1};`).join('\n') + '\n');
  writeFileSync(join(dir, 'shot.png'), PNG);
  writeFileSync(join(dir, 'made.png'), PNG);
  writeFileSync(join(dir, 'secret.png'), 'it is text, not a picture');
  return dir;
}

const fetchStatus = (url: string) => page.evaluate(async (u) => {
  const r = await fetch(u);
  return { status: r.status, type: r.headers.get('content-type') };
}, url);

const dialog = () => page.getByRole('dialog');

test('terminal screen: the CLI\'s colours, a badge, file and web links, a picture that opens; plain text stays selectable', async () => {
  const dir = seedProject();
  const { box } = await openWorkTab(dir);
  await box.fill('/status');
  await box.press('Escape');
  await box.press('Enter');
  const card = page.locator('pre').filter({ hasText: 'Screen of /status' });
  await card.getByText('Search:').waitFor();

  // What the CLI painted: its bold, palette and background, on the right characters.
  const number = card.getByText('12%', { exact: true });
  assert.equal(await number.evaluate((el) => getComputedStyle(el).color), 'rgb(135, 215, 135)');
  const bar = card.getByText('█████');
  assert.equal(await bar.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(135, 135, 135)');
  assert.equal(await card.getByText('wide', { exact: true }).evaluate((el) => getComputedStyle(el).color), 'rgb(255, 215, 0)');

  await card.locator('.term-badge[data-tone="ok"]', { hasText: 'OK' }).waitFor();
  const web = card.locator('a[href="https://example.com/docs"]');
  assert.equal(await web.getAttribute('target'), '_blank');

  // A picture named on the screen: shown under it, opens at full size.
  const thumb = page.locator('img[alt="shot.png"]');
  await page.waitForFunction(() => document.querySelector<HTMLImageElement>('img[alt="shot.png"]')?.naturalWidth === 1);
  await thumb.click();
  await dialog().locator('img[alt="shot.png"]').waitFor();
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'detached' });

  await card.locator('a[data-file="src/a.ts"]').click();
  await dialog().getByText('export const line12 = 12;').first().waitFor();
  await page.keyboard.press('Escape');
  await dialog().waitFor({ state: 'detached' });

  const text = await card.evaluate((el) => el.textContent);
  assert.ok(text!.includes('Current session: 12% used\n'), 'lines are lines when copied');
});

test('B2: code is highlighted, paths open, an image shows in place and at full size, a path to nothing shows nothing', async () => {
  const dir = seedProject();
  const { box, id } = await openWorkTab(dir);
  await say(box, 'SAY Правка в `src/a.ts:120` и ещё src/a.ts, снимок shot.png, Node.js не файл, нет такого missing.png, сайт https://example.com/a/b.png\\n\\n```ts\\nconst answer: number = 42; // ok\\n```\\n\\n```unknownlang\\nraw <b>text</b>\\n```');
  const reply = page.locator('.md').filter({ hasText: 'Правка в' }).last();
  await reply.locator('img.chat-img').first().waitFor();

  assert.ok(await reply.locator('.hljs-keyword').count() > 0, 'tokens');
  assert.equal(await reply.locator('pre b').count(), 0, 'an unknown language stays escaped text');
  assert.equal((await reply.locator('pre').nth(1).innerText()).trim(), 'raw <b>text</b>');
  assert.equal(await reply.locator('a[data-file="Node.js"]').count(), 0);
  assert.equal(await reply.locator('a[data-file*="example.com"], a[data-file*="b.png"]').count(), 0, 'a URL is no path');

  // The picture really loaded, what names no file is gone.
  await page.waitForFunction(() => { const i = document.querySelector<HTMLImageElement>('img.chat-img[alt="shot.png"]'); return i && i.naturalWidth === 1; });
  await page.waitForFunction(() => { const i = document.querySelector<HTMLImageElement>('img.chat-img[alt="missing.png"]'); return i && i.hidden; });

  await reply.locator('img.chat-img[alt="shot.png"]').click();
  await dialog().locator('img[alt="shot.png"]').waitFor();
  await page.keyboard.press('Escape');

  await reply.locator('a[data-file="src/a.ts"]').first().click();
  await dialog().getByTestId('file-code').waitFor();
  assert.match(await dialog().getByTestId('file-code').innerText(), /export const line120 = 120;/);
  await dialog().getByTestId('file-line').waitFor();
  const shown = await dialog().getByTestId('file-line').evaluate((el) => {
    const box = el.parentElement!.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    return r.top >= box.top && r.bottom <= box.bottom;
  });
  assert.ok(shown, 'the file opens at the line');
  await page.keyboard.press('Escape');

  // The route gives images only, and only from inside.
  const url = (p: string) => `/api/tabs/${id}/image?path=${encodeURIComponent(p)}`;
  assert.deepEqual(await fetchStatus(url('shot.png')), { status: 200, type: 'image/png' });
  assert.equal((await fetchStatus(url('secret.png'))).status, 415);
  assert.equal((await fetchStatus(url('src/a.ts'))).status, 415);
  assert.equal((await fetchStatus(url('../../outside.png'))).status, 400);
  assert.equal((await fetchStatus(url('/etc/passwd'))).status, 403);
  assert.equal((await fetchStatus(url('нет.png'))).status, 404);
});

test('B2: badges in the stream: kinds, exit codes, the size of a diff; a path in a row and in an output opens, a produced image shows', async () => {
  const dir = seedProject();
  const { box } = await openWorkTab(dir);
  const call = (c: object) => say(box, `CALL ${JSON.stringify(c)}`);

  await call({ name: 'Bash', input: { command: 'npm test -- a', description: 'Запуск тестов' }, result: 'Exit code 2\nFAIL src/a.ts:7\nline', isError: true });
  await page.locator('.status-badge').getByText('exit 2').waitFor();
  await page.locator('.tool-badge[data-kind="bash"]').getByText('Bash').waitFor();
  await page.locator('span').getByText('Запуск тестов', { exact: true }).waitFor();
  await page.locator('pre a[data-file="src/a.ts"]').waitFor();

  await call({ name: 'Grep', input: { pattern: 'x' }, result: 'denied', isError: true });
  await page.locator('.status-badge').getByText('ошибка').waitFor();
  await page.locator('.tool-badge[data-kind="search"]').waitFor();

  await call({ name: 'Edit', input: { file_path: `${dir}/src/a.ts`, old_string: 'one\ntwo', new_string: 'three\nfour\nfive' }, result: 'ok' });
  await page.locator('.diff-stat').filter({ hasText: '+3' }).filter({ hasText: '−2' }).waitFor();
  const row = page.locator('.tool-badge[data-kind="edit"]').last();
  await row.click();
  await page.getByText('+four').waitFor();
  await page.getByText('-two').waitFor();

  await call({ name: 'mcp__claude-os__list_projects', input: {}, result: '[]' });
  await page.locator('.tool-badge[data-kind="mcp"]').getByText('claude-os · list_projects').waitFor();

  // An absolute path from the tool's input opens through the same route.
  await page.locator(`a[data-file="${dir}/src/a.ts"]`).first().click();
  assert.match(await dialog().getByTestId('file-code').innerText(), /line1 = 1/);
  await page.keyboard.press('Escape');

  await call({ name: 'Write', input: { file_path: 'made.png', content: '' }, result: 'ok' });
  await call({ name: 'Bash', input: { command: 'screenshot' }, result: 'saved to shot.png\nand gone.png' });
  await page.locator('img[alt="made.png"]').waitFor();
  await page.locator('img[alt="shot.png"]').waitFor();
  await page.waitForFunction(() => document.querySelector('img[alt="gone.png"]') === null);
  await page.locator('img[alt="shot.png"]').click();
  await dialog().locator('img[alt="shot.png"]').waitFor();
  await page.keyboard.press('Escape');
});

// AGENT 5000 lives 15 s: the clock and the command come from the journal (polled, indexed in batches), and under a parallel run
// they can arrive seconds late; a shorter agent can end before the clock is seen to tick.
async function checkStrip() {
  const strip = page.getByRole('group', { name: 'Подагенты за работой' });
  await strip.getByText('Fake subagent job').waitFor();
  await strip.getByText('general-purpose').waitFor();
  await strip.getByText('Bash echo from-subagent').waitFor();
  const clock = strip.getByText(/^\d+:\d\d$/);
  const was = await clock.innerText();
  await page.waitForFunction((w) => [...document.querySelectorAll('[role="group"] span')].some((s) => /^\d+:\d\d$/.test(s.textContent ?? '') && s.textContent !== w), was);

  // Next to the input, above it.
  const input = await page.getByRole('textbox').last().boundingBox();
  const own = await strip.boundingBox();
  assert.ok(own!.y + own!.height <= input!.y + 1, 'above the field');

  await strip.getByRole('button').first().click();
  await dialog().getByText('Do the fake job').waitFor();
  assert.equal(await dialog().getByRole('textbox').count(), 0, 'read only');
  await page.keyboard.press('Escape');
  await strip.waitFor({ state: 'detached', timeout: 30_000 });
}

test('B5, B14: a project tab shows its running subagent above the input, live, and opens it', async () => {
  const { box } = await openWorkTab();
  await say(box, 'AGENT 5000');
  await checkStrip();
});

test('B5, B14: the root chat too', async () => {
  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'home' })));
  await page.reload();
  await say(page.getByRole('textbox', { name: /Начни новый проект/ }), 'AGENT 5000');
  await checkStrip();
});

test('B5, B14: a session in a plain terminal: from the journal alone, live, gone when it ends', async () => {
  const SESSION = '77777777-2222-3333-4444-555555555555';
  const cwd = join(srv.dir, 'terminal');
  mkdirSync(join(cwd, '.git'), { recursive: true });
  const dir = join(srv.configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const agents = join(dir, SESSION, 'subagents');
  mkdirSync(agents, { recursive: true });
  const line = (r: object) => JSON.stringify({ uuid: crypto.randomUUID(), sessionId: SESSION, cwd, timestamp: new Date().toISOString(), ...r }) + '\n';
  writeFileSync(join(dir, `${SESSION}.jsonl`), line({ type: 'user', message: { role: 'user', content: 'из терминала' } }));
  writeFileSync(join(agents, 'agent-aterm.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Ищет в терминале', toolUseId: 'toolu_term' }));
  const journal = join(agents, 'agent-aterm.jsonl');
  const call = (id: string, command: string) => line({ type: 'assistant', isSidechain: true, agentId: 'aterm', message: { id, role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: `t${id}`, name: 'Bash', input: { command } }], stop_reason: null, usage: { input_tokens: 1, output_tokens: 1 } } });
  writeFileSync(journal, line({ type: 'user', isSidechain: true, agentId: 'aterm', message: { role: 'user', content: 'ищи' } }) + call('m1', 'rg первое'));

  const stat = readFileSync(`/proc/${process.pid}/stat`, 'latin1');
  mkdirSync(join(srv.configDir, 'sessions'), { recursive: true });
  writeFileSync(join(srv.configDir, 'sessions', `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId: SESSION, cwd, status: 'busy', kind: 'interactive', procStart: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], startedAt: Date.now(), updatedAt: Date.now() }));
  await waitUntil(async () => (await srv.api<{ id: string; status: string }[]>('GET', '/api/sessions')).body.some((s) => s.id === SESSION && s.status !== 'ended'), 'the terminal session is indexed', 30_000);

  const tab = await srv.api<Tab>('POST', '/api/tabs', { resumeSessionId: SESSION, readonly: true, cwd });
  assert.equal(tab.status, 200);
  await page.evaluate((id) => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'tab', id })), tab.body.id);
  await page.reload();

  const strip = page.getByRole('group', { name: 'Подагенты за работой' });
  await strip.getByText('Ищет в терминале').waitFor();
  await strip.getByText('Bash rg первое').waitFor();
  await strip.getByText(/^\d+:\d\d$/).waitFor();

  appendFileSync(journal, call('m2', 'rg второе'));
  await strip.getByText('Bash rg второе').waitFor();

  await strip.getByRole('button').click();
  await dialog().getByText('ищи', { exact: true }).waitFor();
  await page.keyboard.press('Escape');

  writeFileSync(join(agents, 'agent-aterm.meta.json'), JSON.stringify({ agentType: 'Explore', description: 'Ищет в терминале', toolUseId: 'toolu_term', finished: true }));
  await strip.waitFor({ state: 'detached' });
});

test('B2: the root chat opens a file of a known project by its absolute path, what is outside any project is refused in the viewer', async () => {
  const dir = seedProject();
  const { id } = await openWorkTab(dir);
  const projects = (await srv.api<{ root: string }[]>('GET', '/api/projects?all=1')).body;
  const known = projects.find((p) => dir === p.root || dir.startsWith(`${p.root}/`));
  assert.ok(known, JSON.stringify(projects));
  await srv.api('DELETE', `/api/tabs/${id}`);

  await page.evaluate(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'home' })));
  await page.reload();
  await say(page.getByRole('textbox', { name: /Начни новый проект/ }), `SAY Смотри ${dir}/src/a.ts:5 и ${dir}/shot.png и /etc/hostname.txt`);
  await page.locator(`a[data-file="${dir}/src/a.ts"]`).click();
  assert.match(await dialog().getByTestId('file-code').innerText(), /line5 = 5/);
  await page.keyboard.press('Escape');
  await page.waitForFunction((alt) => { const i = document.querySelector<HTMLImageElement>(`img.chat-img[alt="${alt}"]`); return i && i.naturalWidth === 1; }, `${dir}/shot.png`);
  await page.locator('a[data-file="/etc/hostname.txt"]').click();
  await dialog().getByRole('alert').waitFor();
  assert.equal(await dialog().getByTestId('file-code').count(), 0);
  await page.keyboard.press('Escape');
});

test('paths: the label is short, the link keeps the full path; a markdown link to a file opens it in place', async () => {
  const dir = seedProject();
  const { box } = await openWorkTab(dir);
  const before = page.url();
  await say(box, `SAY Правка ${dir}/src/a.ts:5, чужой /opt/far/deep/dir/file.md и /etc/hostname.txt, ссылка [файл](src/a.ts) и [сайт](https://example.com/x.md)`);
  const reply = page.locator('.md').filter({ hasText: 'Правка' }).last();
  const full = reply.locator(`a[data-file="${dir}/src/a.ts"]`);
  await full.waitFor();
  assert.equal(await full.innerText(), 'src/a.ts:5');
  assert.equal(await full.getAttribute('title'), `${dir}/src/a.ts`);
  assert.equal(await reply.locator('a[data-file="/opt/far/deep/dir/file.md"]').innerText(), '…/dir/file.md');
  assert.equal(await reply.locator('a[data-file="/etc/hostname.txt"]').innerText(), '/etc/hostname.txt');
  assert.equal(await reply.locator('a[href="https://example.com/x.md"]').count(), 1, 'a web link stays a web link');

  const link = reply.locator('a[data-file="src/a.ts"]');
  assert.equal(await link.innerText(), 'файл');
  await link.click();
  assert.match(await dialog().getByTestId('file-code').innerText(), /line1 = 1/);
  await page.keyboard.press('Escape');
  assert.equal(page.url(), before, 'no navigation');
});

test('paths: a file under uploads opens by its absolute path', async () => {
  const upload = join(srv.dataDir, 'uploads', 'some-tab');
  mkdirSync(upload, { recursive: true });
  writeFileSync(join(upload, 'pasted.txt'), 'вставленный текст\n');
  const { box } = await openWorkTab(seedProject());
  await say(box, `SAY Вложение ${upload}/pasted.txt`);
  await page.locator(`a[data-file="${upload}/pasted.txt"]`).click();
  assert.match(await dialog().getByTestId('file-code').innerText(), /вставленный текст/);
  await page.keyboard.press('Escape');
});

test('wide table scrolls and columns keep width', async () => {
  const { box } = await openWorkTab();
  const cols = Array.from({ length: 10 }, (_, i) => `колонка${i}`);
  const row = Array.from({ length: 10 }, () => 'довольно длинное содержимое ячейки таблицы');
  await say(box, `SAY Таблица\\n\\n| ${cols.join(' | ')} |\\n|${' --- |'.repeat(10)}\\n| ${row.join(' | ')} |`);
  // The streamed answer is replaced by the final one: measure in one go a table that is in the page and laid out.
  const handle = await page.waitForFunction(() => {
    const el = [...document.querySelectorAll('.md table')].at(-1);
    const th = el?.querySelector('th');
    if (!el || !th || el.clientWidth === 0) return null;
    const probe = document.createElement('span');
    probe.style.cssText = 'display:inline-block;width:7ch';
    th.append(probe);
    const ch7 = probe.getBoundingClientRect().width;
    probe.remove();
    return { scroll: el.scrollWidth, client: el.clientWidth, th: th.getBoundingClientRect().width, ch7 };
  });
  const m = (await handle.jsonValue())!;
  assert.ok(m.scroll > m.client, `scrolls: ${JSON.stringify(m)}`);
  assert.ok(m.th >= m.ch7, `the first column keeps its width: ${JSON.stringify(m)}`);
});

test('side panel: ten subagents, the rest behind "show all"', async () => {
  const SESSION = '99999999-2222-3333-4444-555555555555';
  const cwd = join(srv.dir, 'many-agents');
  mkdirSync(cwd, { recursive: true });
  const dir = join(srv.configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  const agents = join(dir, SESSION, 'subagents');
  mkdirSync(agents, { recursive: true });
  const line = (r: object) => JSON.stringify({ uuid: crypto.randomUUID(), sessionId: SESSION, cwd, timestamp: new Date().toISOString(), ...r }) + '\n';
  writeFileSync(join(dir, `${SESSION}.jsonl`), line({ type: 'user', message: { role: 'user', content: 'много агентов' } }));
  for (let i = 0; i < 15; i++) {
    writeFileSync(join(agents, `agent-a${i}.meta.json`), JSON.stringify({ agentType: 'Explore', description: `Агент номер ${i}`, toolUseId: `toolu_${i}`, finished: true }));
    writeFileSync(join(agents, `agent-a${i}.jsonl`), line({ type: 'user', isSidechain: true, agentId: `a${i}`, message: { role: 'user', content: 'ищи' } }));
  }
  await waitUntil(async () => (await srv.api<{ id: string; subagents: unknown[] }[]>('GET', '/api/sessions')).body.some((s) => s.id === SESSION && s.subagents.length === 15), 'the session and its subagents are indexed', 30_000);
  const tab = await srv.api<Tab>('POST', '/api/tabs', { resumeSessionId: SESSION, readonly: true, cwd });
  assert.equal(tab.status, 200, JSON.stringify(tab.body));
  await page.evaluate((id) => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'tab', id })), tab.body.id);
  await page.reload();
  const side = page.getByTestId('side-panel');
  const rows = side.getByRole('button', { name: /Агент номер/ });
  await rows.first().waitFor();
  assert.equal(await rows.count(), 10);
  await side.getByRole('button', { name: 'Показать все (15)' }).click();
  await waitUntil(async () => (await rows.count()) === 15, 'all fifteen');
  await side.getByRole('button', { name: 'Свернуть' }).click();
  await waitUntil(async () => (await rows.count()) === 10, 'back to ten');
  await srv.api('DELETE', `/api/tabs/${tab.body.id}`);
});

test('server messages: a warning with key renders the catalog text', async () => {
  const { id, box } = await openWorkTab();
  await say(box, '/compact');
  await page.getByTestId('transcript-scroller').getByText('Контекст сжат', { exact: true }).waitFor();
  const history = (await srv.api<ChatEvent[]>('GET', `/api/tabs/${id}/history`)).body;
  assert.ok(history.some((e) => e.e === 'warning' && e.key === 'compacted' && e.text === 'Context compacted'), 'the server sends English and the key');
  await srv.api('DELETE', `/api/tabs/${id}`);
});

test('server messages: a warning without key renders its text', async () => {
  const SESSION = '88888888-2222-3333-4444-555555555555';
  const cwd = join(srv.dir, 'stored');
  mkdirSync(cwd, { recursive: true });
  const dir = join(srv.configDir, 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const line = (r: object) => JSON.stringify({ uuid: crypto.randomUUID(), sessionId: SESSION, cwd, timestamp: new Date().toISOString(), ...r }) + '\n';
  writeFileSync(join(dir, `${SESSION}.jsonl`), [
    line({ type: 'user', message: { role: 'user', content: 'старый разговор' } }),
    line({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Сохранённое предупреждение</local-command-stdout>' } }),
  ].join(''));
  await waitUntil(async () => (await srv.api<{ id: string }[]>('GET', '/api/sessions')).body.some((s) => s.id === SESSION), 'the stored session is indexed', 30_000);
  const tab = await srv.api<Tab>('POST', '/api/tabs', { resumeSessionId: SESSION, readonly: true, cwd });
  assert.equal(tab.status, 200, JSON.stringify(tab.body));
  await page.evaluate((id) => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'tab', id })), tab.body.id);
  await page.reload();
  await page.getByText('Сохранённое предупреждение', { exact: true }).waitFor();
  await srv.api('DELETE', `/api/tabs/${tab.body.id}`);
});

test('server messages: a request denied without words shows the deny text in the UI language', async () => {
  const { id, box } = await openWorkTab();
  await say(box, 'TOOL Bash {"command":"ls"}'); // a real permission prompt of the fake CLI
  await page.getByRole('button', { name: 'Запретить' }).click(); // opens the reason form
  await page.locator('form').getByRole('button', { name: 'Запретить' }).click(); // sends it without words
  await page.getByTestId('transcript-scroller').getByText('Пользователь отказал').first().waitFor();
  const history = (await srv.api<ChatEvent[]>('GET', `/api/tabs/${id}/history`)).body;
  assert.ok(history.some((e) => e.e === 'tool_result' && e.text === 'The user denied it'), 'Claude gets English');
  await srv.api('DELETE', `/api/tabs/${id}`);
});

test('a long paste goes out as one tagged block and shows folded in the bubble, also from the history after a reload', async () => {
  const { id, box } = await openWorkTab();
  const long = Array.from({ length: 30 }, (_, i) => `строка вставки ${i}, достаточно длинная для порога`).join('\n');
  await box.click();
  await page.keyboard.type('смотри: ');
  await box.evaluate((el, text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, long);
  await page.locator('[data-chip-layer] [data-chip="paste"]').waitFor();
  await page.getByRole('button', { name: /^(Отправить|В очередь)$/ }).click();

  const block = scroller().getByTestId('pasted-block');
  const folded = async () => {
    await block.waitFor();
    const text = block.locator('> span').first();
    assert.ok((await text.evaluate((el) => el.clientHeight < el.scrollHeight)), 'folded to a few lines');
    await block.getByRole('button', { name: 'Развернуть' }).click();
    await block.getByRole('button', { name: 'Свернуть' }).waitFor();
    assert.ok(await text.evaluate((el) => el.clientHeight >= el.scrollHeight), 'all of it');
    await block.getByText(/строка вставки 29,/).waitFor();
  };
  await folded();
  const history = (await srv.api<ChatEvent[]>('GET', `/api/tabs/${id}/history`)).body;
  assert.ok(JSON.stringify(history).includes(JSON.stringify(`смотри: <pasted lines="30">\n${long}\n</pasted>`).slice(1, -1)), 'Claude gets the tagged text');

  await page.reload();
  await folded();
  await srv.api('DELETE', `/api/tabs/${id}`);
});
