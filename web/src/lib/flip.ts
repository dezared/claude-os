import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { EASE_UI, LEAVE_MS, reducedMotion } from './motion';

const MOVE_MS = 220;
const ENTER_MS = 200;
/** Past this many items a list is not animated: measuring them all on every render would cost more than the motion gives. */
const MAX_ITEMS = 150;
/** What a leaving copy keeps of its data attributes: the ones the styles read. The rest would let it pass for the real item. */
const KEPT_DATA = new Set(['data-kind', 'data-tone', 'data-state']);

interface Spot {
  el: HTMLElement;
  x: number;
  y: number;
  w: number;
  h: number;
}

function measure(root: HTMLElement): Map<string, Spot> {
  const spots = new Map<string, Spot>();
  for (const el of root.querySelectorAll<HTMLElement>('[data-flip]')) {
    spots.set(el.dataset.flip!, { el, x: el.offsetLeft, y: el.offsetTop, w: el.offsetWidth, h: el.offsetHeight });
  }
  return spots;
}

/** Where a slide still running has the item now, on top of its layout place. */
function drift(el: HTMLElement): { x: number; y: number } {
  const running = el.getAnimations().filter((a) => a.id === 'flip');
  if (running.length === 0) return { x: 0, y: 0 };
  const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
  for (const a of running) a.cancel();
  return { x: m.m41, y: m.m42 };
}

function slide(now: Spot, was: Spot) {
  const d = was.el === now.el ? drift(now.el) : { x: 0, y: 0 };
  const dx = was.x - now.x + d.x;
  const dy = was.y - now.y + d.y;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  // A new node for the same key (a card dropped into another column) moves whole: its own entrance must not fade it in.
  const keep: Keyframe = was.el === now.el ? {} : { opacity: 1 };
  now.el.animate([{ ...keep, transform: `translate(${dx}px, ${dy}px)` }, { ...keep, transform: 'none' }], { duration: MOVE_MS, easing: EASE_UI, id: 'flip' });
}

function enter(el: HTMLElement) {
  el.animate([{ opacity: 0, transform: 'scale(0.94)' }, { opacity: 1, transform: 'none' }], { duration: ENTER_MS, easing: EASE_UI });
}

function strip(el: Element) {
  // A copy of the names: the attribute list is live and shrinks as they go.
  for (const name of Array.from(el.attributes, (a) => a.name)) {
    if (name === 'id' || name === 'role' || name === 'tabindex' || name.startsWith('aria-') || (name.startsWith('data-') && !KEPT_DATA.has(name))) el.removeAttribute(name);
  }
}

/** A lifeless copy: no roles, ids or test hooks, so nothing (a person, a screen reader, a test) takes it for the real thing. */
function copyOf(el: HTMLElement): HTMLElement {
  const ghost = el.cloneNode(true) as HTMLElement;
  strip(ghost);
  for (const inner of ghost.querySelectorAll('*')) strip(inner);
  ghost.setAttribute('aria-hidden', 'true');
  ghost.inert = true;
  ghost.style.pointerEvents = 'none';
  ghost.classList.add('is-ghost'); // a new node would replay its entrance: .is-ghost in styles.css stops it
  return ghost;
}

function fade(ghost: HTMLElement, to: Keyframe) {
  const out = ghost.animate([{ opacity: 1 }, to], { duration: LEAVE_MS, easing: 'ease-in', fill: 'forwards' });
  out.onfinish = () => ghost.remove();
  out.oncancel = () => ghost.remove();
}

/** The item is gone from the DOM: a copy stands where it was and fades out, while the rest slide into its room. */
function leave(root: HTMLElement, was: Spot) {
  const ghost = copyOf(was.el);
  Object.assign(ghost.style, { position: 'absolute', left: `${was.x}px`, top: `${was.y}px`, width: `${was.w}px`, height: `${was.h}px`, margin: '0' });
  root.append(ghost);
  fade(ghost, { opacity: 0, transform: 'scale(0.94)' });
}

/**
 * For a floating surface React unmounts at once (a menu, a popover): call it from a cleanup, while or after it leaves the page.
 * When the render is over and it is gone, a copy stands where it was (`at`, or where it is now) and fades out. Nothing waits for
 * the exit. Still in the page after the render means it was reused, not removed: nothing to do.
 */
export function fadeOutCopy(el: HTMLElement, at?: DOMRect) {
  if (reducedMotion() || el.dataset.state === 'closed') return; // a Radix surface closed through its state played its own exit
  const place = at ?? (el.isConnected ? el.getBoundingClientRect() : null);
  if (!place) return;
  queueMicrotask(() => {
    if (el.isConnected) return;
    const ghost = copyOf(el);
    // The box it had on screen, whatever placed it there (a centring translate, insets).
    Object.assign(ghost.style, { position: 'fixed', inset: 'auto', left: `${place.left}px`, top: `${place.top}px`, width: `${place.width}px`, height: `${place.height}px`, margin: '0', translate: 'none' });
    document.body.append(ghost);
    fade(ghost, { opacity: 0, transform: 'scale(0.97)' });
  });
}

/** `ref={exitCopy}` on an element rendered conditionally: it fades out in place when it is taken away. */
export function exitCopy(el: HTMLElement | null) {
  return el ? () => fadeOutCopy(el) : undefined;
}

/** A ref whose element gets fadeOutCopy when the component unmounts. */
export function useExitCopy<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    return () => {
      if (el) fadeOutCopy(el);
    };
  }, []);
  return ref;
}

function play(box: HTMLElement, was: Map<string, Spot>, now: Map<string, Spot>) {
  for (const [key, spot] of now) {
    const old = was.get(key);
    if (old) slide(spot, old);
    else enter(spot.el);
  }
  for (const [key, old] of was) if (!now.has(key) && !old.el.isConnected) leave(box, old);
}

interface Tracked {
  box: HTMLElement;
  spots: Map<string, Spot>;
  watch: ResizeObserver;
}

/** The list's last picture, or null when it is seen for the first time (a list mounted anew in another element included). */
function follow(tracked: { current: Tracked | null }, box: HTMLElement | null): Map<string, Spot> | null {
  const was = tracked.current;
  if (was && was.box === box) return was.spots;
  was?.watch.disconnect();
  tracked.current = null;
  if (!box) return null;
  // A window resize moves the items without a render: the next slide starts from where they are now.
  const next: Tracked = { box, spots: new Map(), watch: new ResizeObserver(() => (next.spots = measure(box))) };
  next.watch.observe(box);
  tracked.current = next;
  return null;
}

/**
 * Animates a list on transform and opacity alone: items marked `data-flip="<key>"` under `root` slide from their old place
 * to the new one, new ones grow in, removed ones fade out where they stood. `root` must be positioned (the items' offsetParent).
 * Nothing waits for it: the layout is final at once, only the picture catches up.
 */
export function useFlip(root: RefObject<HTMLElement | null>): void {
  const tracked = useRef<Tracked | null>(null);
  const seen = useRef(false); // what is on screen at the first sight of the list does not enter, it is simply there
  useLayoutEffect(() => {
    const was = follow(tracked, root.current);
    const list = tracked.current;
    if (!list) return;
    const now = measure(list.box);
    list.spots = now;
    const animate = !!was && seen.current && now.size <= MAX_ITEMS && !reducedMotion();
    if (now.size > 0) seen.current = true;
    if (animate) play(list.box, was, now);
  });
  useEffect(() => () => tracked.current?.watch.disconnect(), []);
}
