// Frame time of the home map with the camera moving: the wheel-driven approach of desktop/main.cjs, on fixture data.
// Not a test: software GL is no target to assert against, the point is the same numbers before and after a change.
//   CLAUDE_OS_WEB_DIST=<dir> node --disable-warning=ExperimentalWarning e2e/universe-perf.ts [--passes] [--profile] [--typing] [--quality=full|auto] [--uncapped]
// renderMs is what the display cap cannot hide: one rAF callback plus a readPixels that waits for the GPU to finish it.
import { chromium, type Page } from 'playwright';
import { defaultFixture, startFixture, syntheticGraph, type Fixture } from './fixture-server.ts';

const flag = (name: string) => process.argv.includes(`--${name}`);
const quality = process.argv.find((a) => a.startsWith('--quality='))?.split('=')[1] ?? 'auto';
const SECONDS = 6;

function hundred(): Fixture {
  const data = defaultFixture();
  const now = Date.now();
  const names = Array.from({ length: 100 }, (_, i) => `proj-${String(i).padStart(3, '0')}`);
  data.projects = names.map((name, i) => ({ key: name, name, root: `/home/test/${name}`, misc: false, sessionCount: 5, liveCount: i < 5 ? 1 : 0, lastActivity: now - i * 3_600_000, memoryCount: 3, memoryConnected: true, memoryDrift: 0, pinned: false, mapPin: null, description: null, color: null, parent: null, folder: false }));
  data.graph = syntheticGraph(1200, names);
  data.sessions = names.slice(0, 5).map((name, i) => ({ id: `s${i}`, project: name, cwd: `/home/test/${name}`, kind: 'interactive', origin: 'external', name: null, title: name, lastPrompt: null, firstActivity: now, lastActivity: now, status: 'working', pid: i + 1, tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 }, subagents: [] }));
  data.tabs = data.tabs.filter((t) => t.kind === 'root');
  return data;
}

// Counts what the GL gets asked per frame. With passes on, a read after every draw charges the time to that draw.
const instrument = (passes: boolean) => {
  type Row = { calls: number; instances: number; ms: number };
  const w = window as unknown as { __gl: { draws: Record<string, Row>; uploads: number; bytes: number; frames: number; rafMs: number; drawn: number; render: number[]; jsPerFrame: number[]; stacks?: Record<string, number>; noRead?: boolean } };
  w.__gl = { draws: {}, uploads: 0, bytes: 0, frames: 0, rafMs: 0, drawn: 0, render: [], jsPerFrame: [] };
  const P = WebGL2RenderingContext.prototype;
  const names = new WeakMap<WebGLProgram, string>();
  const link = P.linkProgram;
  P.linkProgram = function (p) {
    const src = this.getAttachedShaders(p)!.map((x) => this.getShaderSource(x)).join('');
    names.set(p, src.includes('gl_PointSize') ? 'dust' : src.includes('aState') ? 'sprite' : src.includes('aB') ? 'line' : 'composite');
    return link.call(this, p);
  };
  let current = '?';
  let shape = 0;
  const use = P.useProgram;
  P.useProgram = function (p) {
    current = (p && names.get(p)) ?? '?';
    return use.call(this, p);
  };
  const uni = P.uniform1i;
  P.uniform1i = function (loc, v) {
    if (current === 'sprite') shape = v;
    return uni.call(this, loc, v);
  };
  const charge = (gl: WebGL2RenderingContext, instances: number, draw: () => void) => {
    const fb = gl.getParameter(gl.FRAMEBUFFER_BINDING) ? 'fbo' : 'screen';
    const key = `${current}${current === 'sprite' ? shape : ''}/${fb}/${gl.getParameter(gl.VIEWPORT)[2]}`;
    const row = (w.__gl.draws[key] ??= { calls: 0, instances: 0, ms: 0 });
    row.calls++;
    w.__gl.drawn++;
    row.instances += instances;
    const t = performance.now();
    draw();
    // gl.finish does not wait in Chrome; a read of one pixel does. The quarter-size haze target is a float one.
    if (passes) gl.getParameter(gl.IMPLEMENTATION_COLOR_READ_TYPE) === gl.UNSIGNED_BYTE ? gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4)) : gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.FLOAT, new Float32Array(4));
    row.ms += performance.now() - t;
  };
  const inst = P.drawArraysInstanced;
  P.drawArraysInstanced = function (m, f, c, n) {
    charge(this, n, () => inst.call(this, m, f, c, n));
  };
  const arrays = P.drawArrays;
  P.drawArrays = function (m, f, c) {
    charge(this, 1, () => arrays.call(this, m, f, c));
  };
  const count = (fn: 'bufferData' | 'bufferSubData') => {
    const real = P[fn] as (...a: unknown[]) => void;
    (P[fn] as unknown) = function (this: WebGL2RenderingContext, ...a: unknown[]) {
      w.__gl.uploads++;
      w.__gl.bytes += (a[fn === 'bufferData' ? 1 : 2] as ArrayBufferView).byteLength ?? 0;
      return real.apply(this, a);
    };
  };
  count('bufferData');
  count('bufferSubData');
  const raf = window.requestAnimationFrame.bind(window);
  const pixel = new Uint8Array(4);
  window.requestAnimationFrame = (cb) => {
    if (w.__gl.stacks) {
      const where = (new Error().stack ?? '').split('\n').slice(2, 7).map((l) => l.trim().replace(/^at /, '').replace(/ \(.*$/, '')).join(' < ');
      w.__gl.stacks[where] = (w.__gl.stacks[where] ?? 0) + 1;
    }
    return raf((t) => {
    const s = performance.now();
    const before = w.__gl.drawn;
    cb(t);
    const js = performance.now() - s;
    w.__gl.rafMs += js;
    if (w.__gl.drawn === before || w.__gl.noRead) return;
    const gl = (document.querySelector('canvas[data-universe]') as HTMLCanvasElement).getContext('webgl2')!;
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    w.__gl.render.push(performance.now() - s);
    w.__gl.jsPerFrame.push(js);
    });
  };
};

const summarize = (samples: number[]) => {
  const s = [...samples].sort((a, b) => a - b);
  const mean = s.reduce((n, v) => n + v, 0) / Math.max(1, s.length);
  return { frames: s.length, fps: +(1000 / mean).toFixed(1), meanMs: +mean.toFixed(1), p50Ms: +s[Math.floor(s.length * 0.5)].toFixed(1), p95Ms: +s[Math.floor(s.length * 0.95)].toFixed(1), maxMs: +s[s.length - 1].toFixed(1) };
};

/** The camera in motion every frame. Returns the frame gaps. */
const drive = (page: Page, seconds: number, wheel: boolean) => page.evaluate(([sec, turn]) => new Promise<number[]>((res) => {
  const stage = document.querySelector('canvas[data-universe]')!;
  const out: number[] = [];
  const start = performance.now();
  let last = start;
  let sign = 1;
  const tick = () => {
    const now = performance.now();
    out.push(now - last);
    last = now;
    if (turn) stage.dispatchEvent(new WheelEvent('wheel', { deltaY: (sign = -sign) * 40, clientX: 800, clientY: 500, bubbles: true, cancelable: true }));
    if (now - start < (sec as number) * 1000) requestAnimationFrame(tick);
    else res(out.slice(1));
  };
  requestAnimationFrame(tick);
}), [seconds, wheel] as const);

async function metrics(cdp: Awaited<ReturnType<Page['context']> extends infer C ? C extends { newCDPSession: (p: Page) => infer R } ? R : never : never>) {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(list.map((m: { name: string; value: number }) => [m.name, m.value])) as Record<string, number>;
}

const fx = await startFixture(hundred());
const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
if (flag('uncapped')) args.push('--disable-gpu-vsync', '--disable-frame-rate-limit');
const browser = await chromium.launch({ args });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'ru-RU' });
if (quality === 'full') await ctx.addInitScript(() => localStorage.setItem('claude-os.universe-quality', 'full'));
await ctx.addInitScript(instrument, flag('passes'));
const page = await ctx.newPage();
await page.goto(fx.url);
await page.locator('.u-label.on').first().waitFor({ timeout: 120000 });
await page.waitForTimeout(3000); // the fade-in of the stars is over

const cdp = await ctx.newCDPSession(page);
await cdp.send('Performance.enable');
const glState = () => page.evaluate(() => {
  const g = (window as unknown as { __gl: { draws: Record<string, { calls: number; instances: number; ms: number }>; uploads: number; bytes: number; rafMs: number; render: number[]; jsPerFrame: number[] } }).__gl;
  return JSON.parse(JSON.stringify(g)) as typeof g;
});

async function run(name: string) {
  const a = await metrics(cdp);
  const g0 = await glState();
  if (flag('profile')) {
    await cdp.send('Profiler.enable');
    await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
    await cdp.send('Profiler.start');
  }
  const gaps = await drive(page, SECONDS, true);
  const b = await metrics(cdp);
  const g1 = await glState();
  const frames = gaps.length;
  const per = (k: string) => +(((b[k] - a[k]) * 1000) / frames).toFixed(2);
  console.log(`\n== ${name} ==`);
  console.log('frame gap', JSON.stringify(summarize(gaps)));
  console.log('renderMs ', JSON.stringify(summarize(g1.render.slice(g0.render.length))), 'js in rAF', JSON.stringify(summarize(g1.jsPerFrame.slice(g0.jsPerFrame.length)).p50Ms));
  console.log('main thread ms/frame:', JSON.stringify({ task: per('TaskDuration'), script: per('ScriptDuration'), layout: per('LayoutDuration'), style: per('RecalcStyleDuration'), rafCallbacks: +((g1.rafMs - g0.rafMs) / frames).toFixed(2) }), 'layouts/frame', +((b.LayoutCount - a.LayoutCount) / frames).toFixed(2), 'recalcs/frame', +((b.RecalcStyleCount - a.RecalcStyleCount) / frames).toFixed(2));
  console.log('uploads/frame', +((g1.uploads - g0.uploads) / frames).toFixed(1), 'KB/frame', +((g1.bytes - g0.bytes) / 1024 / frames).toFixed(1));
  const rows = Object.entries(g1.draws).map(([k, v]) => {
    const o = g0.draws[k] ?? { calls: 0, instances: 0, ms: 0 };
    return { pass: k, 'calls/frame': +((v.calls - o.calls) / frames).toFixed(2), 'inst/frame': Math.round((v.instances - o.instances) / frames), 'ms/frame': +((v.ms - o.ms) / frames).toFixed(2) };
  });
  console.table(rows.filter((r) => r['calls/frame'] > 0).sort((x, y) => y['ms/frame'] - x['ms/frame']));
  if (flag('profile')) {
    const { profile } = await cdp.send('Profiler.stop') as { profile: { nodes: { id: number; callFrame: { functionName: string; lineNumber: number; url: string } }[]; samples: number[]; timeDeltas: number[] } };
    const self = new Map<string, number>();
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    profile.samples.forEach((id, i) => {
      const n = byId.get(id)!;
      const k = `${n.callFrame.functionName || '(anon)'}:${n.callFrame.lineNumber}`;
      self.set(k, (self.get(k) ?? 0) + profile.timeDeltas[i] / 1000);
    });
    console.log('self ms/frame:', [...self].sort((x, y) => y[1] - x[1]).slice(0, 14).map(([k, v]) => `${k}=${(v / frames).toFixed(2)}`).join('  '));
  }
}

const canvas = await page.locator('canvas[data-universe]').evaluate((c: HTMLCanvasElement) => `${c.width}x${c.height}`);
const renderer = await page.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2')!;
  const info = gl.getExtension('WEBGL_debug_renderer_info');
  return info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : 'none';
});
console.log(JSON.stringify({ renderer, canvas, quality, uncapped: flag('uncapped'), css: 1600 }));

await run('home view');
for (let i = 0; i < 8; i++) await page.mouse.wheel(0, -300);
await page.mouse.move(800, 500);
await page.waitForTimeout(1500);
await run('near');
await page.getByRole('button', { name: 'Общий вид' }).click();
await page.mouse.move(800, 500);
for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 300);
await page.waitForTimeout(1500);
await run('far');

if (flag('typing')) {
  // Does a keystroke in the home composer reach the map, and does the map feel it? No waiting on the GPU here: the plain frame cadence,
  // with the satellites keeping the loop alive, without typing and with it, with the composer's glass and without.
  await page.evaluate(() => {
    const g = (window as unknown as { __gl: { noRead?: boolean; stacks: object } }).__gl;
    g.noRead = true;
    g.stacks = {};
  });
  const box = page.locator('.home-layer textarea').first();
  await box.click();
  await page.waitForTimeout(8000); // whatever the runs above left moving has settled
  const cadence = (ms: number) => page.evaluate((span) => new Promise<number[]>((res) => {
    const out: number[] = [];
    const start = performance.now();
    let last = start;
    const tick = () => {
      const now = performance.now();
      out.push(now - last);
      last = now;
      if (now - start < span) requestAnimationFrame(tick);
      else res(out.slice(1));
    };
    requestAnimationFrame(tick);
  }), ms);
  const draws = () => glState().then((g) => Object.values(g.draws).reduce((n, r) => n + r.calls, 0));
  const measure = async (name: string, typing: boolean) => {
    const a = await metrics(cdp);
    const d0 = await draws();
    const run = cadence(5000);
    if (typing) await page.keyboard.type('x'.repeat(90), { delay: 50 });
    const gaps = await run;
    const b = await metrics(cdp);
    const g = (k: string) => +((b[k] - a[k]) * 1000).toFixed(0);
    console.log(`${name}: frames ${JSON.stringify(summarize(gaps))} draws ${(await draws()) - d0} task ${g('TaskDuration')} ms script ${g('ScriptDuration')} layout ${g('LayoutDuration')} style ${g('RecalcStyleDuration')} layouts ${b.LayoutCount - a.LayoutCount}`);
  };
  console.log('\n== typing ==');
  await measure('idle', false);
  await measure('typing', true);
  await measure('idle again', false);
  await measure('typing again', true);
  await page.addStyleTag({ content: '.home-chat .glass, .home-chat .glass-strong, .home-chat * { backdrop-filter: none !important; -webkit-backdrop-filter: none !important; }' });
  await page.waitForTimeout(500);
  await measure('composer without blur, idle', false);
  await measure('composer without blur, typing', true);
  const stacks = await page.evaluate(() => (window as unknown as { __gl: { stacks: Record<string, number> } }).__gl.stacks);
  for (const [k, v] of Object.entries(stacks).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(v, k);
}

await browser.close();
await fx.close();
