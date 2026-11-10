import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { renderTipMarkdown } from './Markdown';

const SHOW_DELAY_MS = 350;
const SWITCH_WINDOW_MS = 300; // just left a tip: the next element answers at once, its tip slides over from this one
const LEAVE_MS = 110;
const GAP = 8;
const EDGE = 8;
const LONG = 160;
const WIDER = [560, 800]; // a text too tall for the window at its usual width takes more of it instead of being cut

type Tip = { text: string; top: number; bottom: number; left: number; right: number };

// Written markdown only, not any long text: a path or a command stays as it is.
const MARKDOWN = /(^|\n)\s*([-*+] |\d+\. |#{1,4} )|\*\*[^*\n]+\*\*|`[^`\n]+`|\[[^\]\n]+\]\([^)\n]+\)|\n\n/;
const SHORTCUT = /^(.+) · ((?:Ctrl|Alt|Shift|Cmd|F\d)[^·]*)$/;

function TipBody({ text }: { text: string }) {
  const html = useMemo(() => (MARKDOWN.test(text) ? renderTipMarkdown(text) : null), [text]);
  if (html !== null) return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
  const shortcut = SHORTCUT.exec(text);
  if (shortcut) return <>{shortcut[1]}<kbd>{shortcut[2]}</kbd></>;
  return <>{text}</>;
}

/**
 * One tooltip for the whole app: any element with a title attribute gets it.
 * The title is taken off while the tip is up, so the system tooltip never appears, and put back after.
 */
export function Tooltips() {
  const [tip, setTip] = useState<Tip | null>(null);
  const [leaving, setLeaving] = useState(false);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let owner: Element | null = null;
    let text = '';
    let shown = false;
    let hiddenAt = 0;
    let timer = 0;
    let leaveTimer = 0;

    const release = () => {
      clearTimeout(timer);
      if (owner && !owner.hasAttribute('title')) owner.setAttribute('title', text);
      owner = null;
      if (!shown) return;
      shown = false;
      hiddenAt = performance.now();
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
        setTip(null);
        return;
      }
      setLeaving(true);
      leaveTimer = window.setTimeout(() => {
        setTip(null);
        setLeaving(false);
      }, LEAVE_MS);
    };
    const take = (el: Element) => {
      owner = el;
      text = el.getAttribute('title') ?? '';
      el.removeAttribute('title');
      const show = () => {
        const r = el.getBoundingClientRect();
        clearTimeout(leaveTimer);
        shown = true;
        setLeaving(false);
        setTip({ text, top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      };
      if (performance.now() - hiddenAt < SWITCH_WINDOW_MS) show();
      else timer = window.setTimeout(show, SHOW_DELAY_MS);
    };
    const titled = (t: EventTarget | null) => (t instanceof Element ? t.closest('[title]') : null);
    const onOver = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return;
      if (owner && e.target instanceof Node && owner.contains(e.target)) return;
      const el = titled(e.target);
      release();
      if (el?.getAttribute('title')) take(el);
    };
    const onFocus = (e: FocusEvent) => {
      const el = titled(e.target);
      if (el?.getAttribute('title') && el.matches(':focus-visible')) {
        release();
        take(el);
      }
    };
    // Only what moves the element away: a chat streaming next to it scrolls too, and that is no reason to lose the tip.
    const onScroll = (e: Event) => {
      if (owner && e.target instanceof Node && e.target.contains(owner)) release();
    };
    // Gone from under a still pointer: no event will ever say so.
    const watch = window.setInterval(() => {
      if (owner && !owner.isConnected) release();
    }, 400);

    document.addEventListener('pointerover', onOver);
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focusout', release);
    document.addEventListener('pointerdown', release, true);
    document.addEventListener('keydown', release, true);
    window.addEventListener('blur', release);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      release();
      clearInterval(watch);
      clearTimeout(leaveTimer);
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focusout', release);
      document.removeEventListener('pointerdown', release, true);
      document.removeEventListener('keydown', release, true);
      window.removeEventListener('blur', release);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, []);

  // Placed once its real size is known, on the first side where it fits whole: above, below, right, left. Nothing fits: where there is most room, kept inside the window.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !tip) return;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    el.style.maxWidth = '';
    for (const width of WIDER) {
      if (el.scrollHeight <= vh - 2 * EDGE) break;
      el.style.maxWidth = `${Math.min(width, vw - 2 * EDGE)}px`;
    }
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const ceiling = (document.querySelector('.titlebar')?.getBoundingClientRect().bottom ?? 0) + EDGE;
    const above = tip.top - GAP - ceiling;
    const below = vh - EDGE - tip.bottom - GAP;
    const side = h <= above ? 'top' : h <= below ? 'bottom' : w <= vw - EDGE - tip.right - GAP ? 'right' : w <= tip.left - GAP - EDGE ? 'left' : below >= above ? 'bottom' : 'top';
    const cx = (tip.left + tip.right) / 2 - w / 2;
    const cy = (tip.top + tip.bottom) / 2 - h / 2;
    const x = side === 'right' ? tip.right + GAP : side === 'left' ? tip.left - GAP - w : cx;
    const y = side === 'top' ? tip.top - GAP - h : side === 'bottom' ? tip.bottom + GAP : cy;
    const inside = (v: number, size: number, room: number) => Math.round(Math.max(EDGE, Math.min(v, room - EDGE - size)));
    // Already on screen: from where it stood to the new place. The first placing has nothing to slide from.
    el.toggleAttribute('data-moving', el.hasAttribute('data-side'));
    el.style.transform = `translate(${inside(x, w, vw)}px, ${inside(y, h, vh)}px)`;
    el.dataset.side = side;
  }, [tip]);

  if (!tip) return null;
  return createPortal(
    <div ref={box} role="tooltip" className="ui-tooltip" data-long={tip.text.length > LONG || undefined} data-leaving={leaving || undefined}>
      <TipBody text={tip.text} />
    </div>,
    document.body,
  );
}
