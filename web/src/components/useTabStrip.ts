import { useEffect, useRef, useState } from 'react';

/** How quickly the strip catches up with its target: the longer the trip, the faster it starts, and it always lands softly. */
const CATCH_UP_MS = 90;
/** Room kept past the active tab so the fade never covers it. The same as scroll-margin-inline of .tab-pill in styles.css. */
const EDGE_ROOM = 32;
const LINE_PX = 40;

export interface TabStripEdges {
  overflowing: boolean;
  before: boolean; // tabs are hidden past the left edge
  after: boolean; // and past the right one
}

/**
 * The tab strip scrolls without a scrollbar: the wheel moves it sideways, the active tab rides into view.
 * `activeKey` changes when another tab becomes active and when the active one first appears on the strip.
 */
export function useTabStrip(activeKey: string | null) {
  const strip = useRef<HTMLDivElement>(null);
  const row = useRef<HTMLDivElement>(null);
  const reveal = useRef(() => {});
  const [edges, setEdges] = useState<TabStripEdges>({ overflowing: false, before: false, after: false });

  useEffect(() => {
    const el = strip.current;
    const inner = row.current;
    if (!el || !inner) return;
    const room = () => el.scrollWidth - el.clientWidth;

    const measure = () => {
      const max = room();
      const next = { overflowing: max > 1, before: el.scrollLeft > 1, after: el.scrollLeft < max - 1 };
      setEdges((was) => (was.overflowing === next.overflowing && was.before === next.before && was.after === next.after ? was : next));
    };

    let raf = 0;
    let pos = 0; // scrollLeft rounds to device pixels: the fractions that make the landing soft are kept here
    let target = 0;
    let read = 0;
    let then = 0;
    const frame = (now: number) => {
      // A finger, a focus move, a drag or the code that clamps it took over.
      if (Math.abs(el.scrollLeft - read) > 1) {
        raf = 0;
        return;
      }
      pos += (target - pos) * (1 - Math.exp(-Math.max(0, now - then) / CATCH_UP_MS));
      then = now;
      if (Math.abs(target - pos) < 0.5) pos = target;
      el.scrollLeft = pos;
      read = el.scrollLeft;
      raf = pos === target ? 0 : requestAnimationFrame(frame);
    };
    const moveTo = (to: number) => {
      const next = Math.max(0, Math.min(room(), to));
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        cancelAnimationFrame(raf);
        raf = 0;
        el.scrollLeft = next;
        return;
      }
      target = next;
      if (raf) return;
      pos = read = el.scrollLeft;
      then = performance.now();
      raf = requestAnimationFrame(frame);
    };
    const heading = () => (raf ? target : el.scrollLeft);

    reveal.current = () => {
      const tab = el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
      if (!tab || room() <= 0) return;
      const box = el.getBoundingClientRect();
      const r = tab.getBoundingClientRect();
      const left = r.left - box.left + el.scrollLeft;
      const from = heading();
      let to = from;
      if (left + r.width + EDGE_ROOM > to + el.clientWidth) to = left + r.width + EDGE_ROOM - el.clientWidth;
      if (left - EDGE_ROOM < to) to = left - EDGE_ROOM;
      if (to !== from) moveTo(to);
    };

    // Not React's onWheel: its listener is passive and could not keep the page from taking the wheel too.
    const wheel = (e: WheelEvent) => {
      if (e.ctrlKey || room() <= 0 || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return; // zoom, nothing to scroll, a sideways swipe the browser does itself
      e.preventDefault();
      const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? LINE_PX : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? el.clientWidth : 1;
      moveTo(heading() + e.deltaY * unit);
    };

    const contentChanged = new ResizeObserver(measure);
    contentChanged.observe(inner);
    // The window got narrower, or the count took its place: the active tab may have ended up outside.
    const stripChanged = new ResizeObserver(() => {
      measure();
      reveal.current();
    });
    stripChanged.observe(el);
    el.addEventListener('scroll', measure, { passive: true });
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      contentChanged.disconnect();
      stripChanged.disconnect();
      el.removeEventListener('scroll', measure);
      el.removeEventListener('wheel', wheel);
      cancelAnimationFrame(raf);
    };
  }, []);

  useEffect(() => reveal.current(), [activeKey]);

  return { strip, row, edges };
}
