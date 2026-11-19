import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useTabCommand } from './tabCommands';

const NEAR_PX = 60;
const BACK_PX = 24; // this far down in one go is coming back to the bottom; less is a touchpad's jitter
const SETTLE_MS = 1000; // a transcript that has just opened fills in at once: its first growth is not news to glide to

type Place = { top: number; height: number; client: number };
type Follow = {
  pinned: boolean;
  gliding: boolean; // a smooth scroll to the bottom is on its way: growth meanwhile moves its target, not the place
  seen: Place; // the place the next scroll event is compared with
  down: number; // how far the place has gone down since it last went up
  shownAt: number;
  hidden: boolean; // the last size seen was none: display: none somewhere above
  show: (atBottom: boolean) => void;
};

const look = (el: HTMLElement): Place => ({ top: el.scrollTop, height: el.scrollHeight, client: el.clientHeight });
const gap = (s: Place) => s.height - s.top - s.client;

function stick(el: HTMLElement, s: Follow) {
  el.scrollTop = el.scrollHeight;
  // At once, not with its scroll event: a wheel tick landing before that event would look like a move down from the old place.
  seen(el, s);
}

const seen = (el: HTMLElement, s: Follow) => {
  s.seen = look(el);
};

/** A smooth way down for a jump the eye should follow; reduced motion and a place already at the bottom stick at once. */
function glide(el: HTMLElement, s: Follow) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches || gap(look(el)) <= 1) {
    s.gliding = false;
    stick(el, s);
    return;
  }
  s.gliding = true;
  el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
}

function onResize(el: HTMLElement, s: Follow) {
  // No height: display: none above (Home under another screen) or a panel at the start of its opening. A glide here would be
  // aimed again at every frame of the panel growing back, a smooth scroll restarted for seconds.
  if (el.clientHeight === 0) {
    s.hidden = true;
    s.gliding = false;
    seen(el, s);
    return;
  }
  // Shown again: what came meanwhile is not news to glide to. A flag, not the last place: the browser restores scrollTop with a scroll event before this observer runs.
  if (s.hidden) {
    s.hidden = false;
    s.shownAt = performance.now();
  }
  if (!s.pinned && gap(look(el)) <= 1) s.pinned = true; // nothing is left below the place
  // A stream's next line sticks at once, or the view would lag behind it; a whole block arriving glides.
  const big = gap(look(el)) > el.clientHeight / 2 && performance.now() - s.shownAt > SETTLE_MS;
  if (s.pinned && (s.gliding || big)) glide(el, s);
  else if (s.pinned) stick(el, s);
  else seen(el, s);
  s.show(s.pinned);
}

function onScroll(el: HTMLElement, s: Follow) {
  const last = s.seen;
  const now = look(el);
  if (now.top === last.top && now.height === last.height && now.client === last.client) return; // the event of a stick
  s.seen = now;
  // Content that shrank or a taller viewport also lowers scrollTop, but they leave the place at the very bottom.
  if (now.top < last.top - 0.5 && gap(now) > 1) {
    s.pinned = false;
    s.gliding = false;
    s.down = 0;
  } else comeCloser(s, last, now);
  if (gap(now) <= 1) s.gliding = false;
  s.show(s.pinned);
}

function comeCloser(s: Follow, last: Place, now: Place) {
  const closer = gap(last) - gap(now);
  if (closer <= 0) return;
  if (now.top > last.top) s.down += closer;
  if (gap(now) <= 1 || (gap(now) < NEAR_PX && s.down >= BACK_PX)) s.pinned = true;
}

function letGo(el: HTMLElement, s: Follow) {
  s.gliding = false;
  if (!s.pinned || el.scrollHeight <= el.clientHeight) return;
  s.pinned = false;
  s.down = 0;
  s.show(false);
}

function onWheel(el: HTMLElement, s: Follow, e: WheelEvent) {
  if (e.ctrlKey) return; // zoom
  if (e.deltaY < 0) letGo(el, s);
  else if (e.deltaY > 0 && !s.pinned && gap(look(el)) <= 1) {
    s.pinned = true; // already at the bottom: no scroll event will say so
    s.show(true);
  }
}

function listen(el: HTMLElement, inner: HTMLElement, s: Follow) {
  const ro = new ResizeObserver(() => onResize(el, s));
  ro.observe(inner);
  ro.observe(el); // the field under the chat grows, a strip of subagents appears
  const scroll = () => onScroll(el, s);
  const wheel = (e: WheelEvent) => onWheel(el, s, e);
  const key = (e: KeyboardEvent) => {
    if (e.key === 'PageUp' || e.key === 'ArrowUp' || e.key === 'Home') letGo(el, s);
  };
  // Opening a card at the bottom keeps the card under the pointer: following would pull it away. Closing it follows again, see the observer.
  const click = (e: MouseEvent) => {
    if (!(e.target as Element).closest('[aria-expanded]')) return;
    s.pinned = false;
    s.gliding = false;
    s.down = 0;
  };
  el.addEventListener('scroll', scroll, { passive: true });
  el.addEventListener('wheel', wheel, { passive: true });
  el.addEventListener('keydown', key);
  inner.addEventListener('click', click, true);
  return () => {
    ro.disconnect();
    el.removeEventListener('scroll', scroll);
    el.removeEventListener('wheel', wheel);
    el.removeEventListener('keydown', key);
    inner.removeEventListener('click', click, true);
  };
}

/**
 * Follows the bottom like a terminal until the user scrolls up, then keeps their place. It goes by the direction of the
 * scroll, not by the distance to the bottom alone: a wheel tick is often smaller than NEAR_PX, and the next line of a stream
 * would throw that user straight back down. The input lets go before the scroll: an animated wheel moves less than a pixel in
 * its first frame, and a stick in that frame would cancel the animation. Only the user's own way down follows again:
 * a picture loading above the place moves scrollTop too, and the distance to the bottom stays.
 * The composer of the same tab asks for the bottom when a message is sent or a new one is begun (`sendTabCommand(id, 'bottom')`).
 */
export function useStickToBottom(deps: { scrollKey: string | null; tabId: string | null }) {
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const follow = useRef<Follow>({ pinned: true, gliding: false, seen: { top: 0, height: 0, client: 0 }, down: 0, shownAt: 0, hidden: false, show: setAtBottom }).current;

  useLayoutEffect(() => {
    const el = scroller.current;
    follow.pinned = true;
    follow.gliding = false;
    follow.shownAt = performance.now();
    if (el) stick(el, follow);
    setAtBottom(true);
  }, [deps.scrollKey]);

  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    return listen(el, inner, follow);
  }, []);

  const toBottom = () => {
    follow.pinned = true;
    setAtBottom(true);
    if (scroller.current) glide(scroller.current, follow);
  };
  useTabCommand(deps.tabId ?? '', 'bottom', toBottom); // a read-only view has no composer: '' is nobody's id
  return { scroller, content, atBottom, toBottom };
}
