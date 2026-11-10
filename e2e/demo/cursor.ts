// A visible mouse pointer for the demo video: headless Chromium draws none. The page gets an overlay arrow that follows
// mousemove and a ripple on mousedown; the helpers below glide the real mouse along an eased path, one step a frame.
import type { Locator, Page } from 'playwright';

const FRAME_MS = 1000 / 60;

/** Runs in the page before any of its scripts. */
function installCursor(): void {
  // Inline styles only: a style sheet in <head> did not survive the app's start, and the overlay must never take a click.
  const arrow = '<svg viewBox="0 0 22 22" width="22" height="22" style="pointer-events:none"><path d="M3 2l15 9.2-6.6 1.3 3.9 6.9-2.6 1.4-3.9-6.9L3 18.6z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
  const layer = (css: string) => {
    const el = document.createElement('div');
    el.style.cssText = `position:fixed;left:0;top:0;pointer-events:none;z-index:2147483647;${css}`;
    document.documentElement.append(el);
    return el;
  };
  addEventListener('DOMContentLoaded', () => {
    const cursor = layer('width:22px;height:22px;filter:drop-shadow(0 2px 4px rgba(0,0,0,.55));transform:translate(-100px,-100px)');
    cursor.innerHTML = arrow;
    addEventListener('mousemove', (e) => (cursor.style.transform = `translate(${e.clientX - 3}px,${e.clientY - 2}px)`), true);
    addEventListener('mousedown', (e) => {
      const ring = layer(`width:36px;height:36px;margin:-18px 0 0 -18px;border-radius:50%;border:2px solid rgba(232,138,90,.9);left:${e.clientX}px;top:${e.clientY}px`);
      ring.animate([{ transform: 'scale(.3)', opacity: 1 }, { transform: 'scale(1.4)', opacity: 0 }], { duration: 450, easing: 'ease-out', fill: 'forwards' });
      setTimeout(() => ring.remove(), 500);
    }, true);
  });
}

export const cursorScript = `(${installCursor.toString()})()`;

const at = { x: 640, y: 400 };
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/** Runs `step(k)` with k from 0 to 1 over `ms` of real time, eased; as many steps as the round trips allow. */
async function animate(ms: number, step: (k: number) => Promise<void>): Promise<void> {
  const start = Date.now();
  for (let t = 0; t < 1; t = Math.min(1, (Date.now() - start) / ms)) {
    await step(ease(t));
    await new Promise((r) => setTimeout(r, FRAME_MS / 2));
  }
  await step(1);
}

/** Moves the mouse to a point over `ms`, with ease-in-out. */
export async function glideTo(page: Page, x: number, y: number, ms = 600): Promise<void> {
  const from = { ...at };
  await animate(ms, (k) => page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k));
  at.x = x;
  at.y = y;
}

/** Glides to the middle of an element. */
export async function glide(page: Page, target: Locator, ms = 600): Promise<void> {
  const box = await target.boundingBox();
  if (!box) throw new Error('nothing to glide to');
  await glideTo(page, box.x + box.width / 2, box.y + box.height / 2, ms);
}

/** Glides to an element, rests a moment, clicks. */
export async function glideClick(page: Page, target: Locator, ms = 600): Promise<void> {
  await glide(page, target, ms);
  await page.waitForTimeout(120);
  await page.mouse.down();
  await page.waitForTimeout(70);
  await page.mouse.up();
}

/** Scrolls whatever is under the pointer, smoothly: `px` spread over `ms`. */
export async function smoothScroll(page: Page, px: number, ms = 900): Promise<void> {
  let done = 0;
  await animate(ms, async (k) => {
    const next = Math.round(px * k);
    if (next !== done) await page.mouse.wheel(0, next - done);
    done = next;
  });
}
