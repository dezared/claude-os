// Frame time of a long chat while it scrolls, on fixture data. The same idea as universe-perf.ts.
// Not a test: software GL is no target to assert against, the point is the same numbers before and after a change.
//   CLAUDE_OS_WEB_DIST=<dir> node --disable-warning=ExperimentalWarning e2e/chat-perf.ts [--turns=120] [--focus] [--profile] [--css='rules to try']
// "wheel" is the user's own scroll, real wheel events through the browser. "sweep" moves scrollTop every frame, so every frame has new content to paint.
import { chromium, type Page } from 'playwright';
import type { ChatEvent } from '../shared/contract.ts';
import { defaultFixture, startFixture, tokens } from './fixture-server.ts';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const TURNS = Number(arg('turns') ?? 120);
const SECONDS = 6;

const CODE = Array.from({ length: 24 }, (_, i) => `export function step${i}(input: string, count = ${i}): string {\n  const value = input.trim().toLowerCase(); // шаг ${i}\n  return value.repeat(count) + "${i}";\n}`).join('\n');
const PROSE = 'Посмотрел, как это устроено: **настройки** читаются в двух местах, а `src/config.ts` перекрывает значения из окружения. Поэтому правка в одном месте не доходит до второго, и поведение зависит от порядка импорта.';

/** What a long working session looks like: prose, lists, a table, code, tool calls with long results, thinking. */
function history(): ChatEvent[] {
  const out: Record<string, unknown>[] = [{ e: 'init', sessionId: 's-tab', model: 'claude-opus-5-5', permissionMode: 'auto', slashCommands: [] }];
  for (let i = 0; i < TURNS; i++) {
    out.push({ e: 'user', blocks: [{ type: 'text', text: `Шаг ${i}: проверь модуль и покажи, что поменяется.` }] });
    out.push({ e: 'assistant', messageId: `a${i}`, model: 'claude-opus-5-5', blocks: [
      { type: 'thinking', text: 'Сначала прочитаю файл. '.repeat(30) },
      { type: 'text', text: `${PROSE}\n\n- первый пункт про \`config.ts\`\n- второй пункт про \`db.ts\`\n- третий пункт\n\n| Файл | Строк |\n| --- | --- |\n| a.ts | ${i} |\n| b.ts | ${i * 2} |` },
      { type: 'tool_use', id: `r${i}`, name: 'Read', input: { file_path: `/home/test/alpha-service/src/module${i}.ts` } },
      { type: 'tool_use', id: `b${i}`, name: 'Bash', input: { command: `npm test -- module${i}` } },
    ] });
    out.push({ e: 'tool_result', toolUseId: `r${i}`, text: CODE, isError: false });
    out.push({ e: 'tool_result', toolUseId: `b${i}`, text: `ok ${i}\n`.repeat(40), isError: false });
    out.push({ e: 'assistant', messageId: `c${i}`, model: 'claude-opus-5-5', blocks: [{ type: 'text', text: `${PROSE}\n\n\`\`\`ts\n${CODE.slice(0, 900)}\n\`\`\`\n\n${PROSE}` }] });
    out.push({ e: 'result', usage: tokens(54, 2480, 183_721, 1_620_000), costUsd: 0.42, interrupted: false, error: null });
  }
  const t0 = Date.now() - out.length * 1000;
  return out.map((body, seq) => ({ seq: seq + 1, at: t0 + seq * 1000, ...body }) as ChatEvent);
}

const summarize = (samples: number[]) => {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((n, v) => n + v, 0) / Math.max(1, s.length);
  return { frames: s.length, fps: +(1000 / mean).toFixed(1), p50Ms: +s[Math.floor(s.length * 0.5)].toFixed(1), p95Ms: +s[Math.floor(s.length * 0.95)].toFixed(1), p99Ms: +s[Math.floor(s.length * 0.99)].toFixed(1), maxMs: +s[s.length - 1].toFixed(1), over33: s.filter((v) => v > 33.4).length };
};

/** Frame gaps for the time of the run; a sweep moves the scroll inside every frame. */
const gaps = (page: Page, seconds: number, sweep: boolean) => page.evaluate(([sec, moving]) => new Promise<number[]>((res) => {
  const el = document.querySelector('[data-testid=transcript-scroller]')!;
  const out: number[] = [];
  const start = performance.now();
  let last = start;
  let dir = -1;
  const tick = () => {
    const now = performance.now();
    out.push(now - last);
    last = now;
    if (moving) {
      if (el.scrollTop < 60) dir = 1;
      else if (el.scrollTop > el.scrollHeight - el.clientHeight - 60) dir = -1;
      el.scrollTop += dir * 90;
    }
    if (now - start < (sec as number) * 1000) requestAnimationFrame(tick);
    else res(out.slice(1));
  };
  requestAnimationFrame(tick);
}), [seconds, sweep] as const);

const data = defaultFixture();
data.history.t1 = history();
const fx = await startFixture(data);
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-vsync', '--disable-frame-rate-limit'] });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, deviceScaleFactor: Number(arg('dpr') ?? 1), locale: 'ru-RU' });
await ctx.addInitScript(() => localStorage.setItem('claude-os.view', JSON.stringify({ kind: 'tab', id: 't1' })));
// Focus off by default here: everything the chat can show, the heavier case.
await ctx.addInitScript((on) => localStorage.setItem('claude-os.focus', on ? '1' : '0'), process.argv.includes('--focus'));
const page = await ctx.newPage();
page.on('pageerror', (e) => console.log('pageerror', e.message));
const opened = Date.now();
await page.goto(fx.url);
if (arg('css')) await page.addStyleTag({ content: process.argv.find((a) => a.startsWith('--css='))!.slice(6) });
const scroller = page.getByTestId('transcript-scroller');
await scroller.waitFor();
await page.getByText(`Шаг ${TURNS - 1}:`).waitFor({ timeout: 60000 });
const openMs = Date.now() - opened;
await page.waitForTimeout(1500);
const box = (await scroller.boundingBox())!;
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

const cdp = await ctx.newCDPSession(page);
await cdp.send('Performance.enable');
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value])) as Record<string, number>;
const facts = await scroller.evaluate((el) => ({ items: el.querySelectorAll('.msg-item').length, nodes: el.querySelectorAll('*').length, height: el.scrollHeight }));
await cdp.send('LayerTree.enable');
const tree = new Promise<{ layers?: { width: number; height: number; drawsContent: boolean }[] }>((res) => cdp.once('LayerTree.layerTreeDidChange', res));
await page.mouse.wheel(0, -40);
const drawn = (await Promise.race([tree, new Promise<{ layers?: undefined }>((res) => setTimeout(() => res({}), 5000))])).layers?.filter((l) => l.drawsContent) ?? [];
await cdp.send('LayerTree.disable');
console.log(JSON.stringify({ turns: TURNS, openMs, ...facts, layers: drawn.length, biggest: drawn.sort((a, b) => b.width * b.height - a.width * a.height).slice(0, 4).map((l) => `${l.width}x${l.height}`) }));

async function run(name: string, sweep: boolean) {
  const a = await metrics();
  if (process.argv.includes('--profile')) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
  }
  const running = gaps(page, SECONDS, sweep);
  if (!sweep) {
    const end = Date.now() + SECONDS * 1000;
    let dir = -1;
    let steps = 0;
    while (Date.now() < end) {
      await page.mouse.wheel(0, dir * 180);
      if (++steps % 40 === 0) dir = -dir;
      await page.waitForTimeout(16);
    }
  }
  const frames = await running;
  const b = await metrics();
  const per = (k: string) => +(((b[k] - a[k]) * 1000) / frames.length).toFixed(2);
  console.log(`\n== ${name} ==`);
  console.log('frames', JSON.stringify(summarize(frames)));
  console.log('main thread ms/frame', JSON.stringify({ task: per('TaskDuration'), script: per('ScriptDuration'), layout: per('LayoutDuration'), style: per('RecalcStyleDuration') }), 'layouts/frame', +((b.LayoutCount - a.LayoutCount) / frames.length).toFixed(2), 'recalcs/frame', +((b.RecalcStyleCount - a.RecalcStyleCount) / frames.length).toFixed(2));
  if (process.argv.includes('--profile')) {
    const { profile } = await cdp.send('Profiler.stop');
    const self = new Map<string, number>();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    profile.samples!.forEach((id, i) => {
      const n = byId.get(id)!;
      const k = `${n.callFrame.functionName || '(anon)'}:${n.callFrame.url.split('/').at(-1)}:${n.callFrame.lineNumber}:${n.callFrame.columnNumber}`;
      self.set(k, (self.get(k) ?? 0) + profile.timeDeltas![i] / 1000);
    });
    console.log('self ms:', [...self].sort((x, y) => y[1] - x[1]).slice(0, 12).map(([k, v]) => `${k}=${v.toFixed(0)}`).join('  '));
  }
}

await run('wheel', false);
await page.waitForTimeout(500);
await run('sweep', true);
await page.waitForTimeout(500);
const still = await gaps(page, SECONDS, false);
console.log('\n== still ==\nframes', JSON.stringify(summarize(still)));

await browser.close();
await fx.close();
