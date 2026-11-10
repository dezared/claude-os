import { useEffect, useLayoutEffect, useRef, useState } from 'react';

const MOVE_MS = 200;
const EASE = 'cubic-bezier(0.32, 0.72, 0, 1)'; // --ease-drawer

let ruler: CanvasRenderingContext2D | null = null;

/**
 * The compact field: one row while the text fits beside the buttons, the text over the buttons once it does not.
 * Measured against the width the text would have in the row, whatever the layout is now: a line that fits only once
 * the buttons have moved away must not move them back.
 */
export function useComposerLayout(compact: boolean | undefined, text: string) {
  const row = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);

  const measure = () => {
    const [r, f, c] = [row.current, field.current, controls.current];
    if (!compact || !r || !f || !c || r.clientWidth === 0) return; // under another screen: nothing to measure
    if (text.includes('\n')) return setTall(true);
    const style = getComputedStyle(r);
    const room = r.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - c.offsetWidth - parseFloat(style.columnGap || '0');
    ruler ??= document.createElement('canvas').getContext('2d');
    if (!ruler) return;
    const type = getComputedStyle(f); // its font shorthand reads empty here, and the canvas then measures in its 10px default
    ruler.font = `${type.fontStyle} ${type.fontWeight} ${type.fontSize} ${type.fontFamily}`;
    setTall(ruler.measureText(text).width > room - 2);
  };
  const latest = useRef(measure);
  latest.current = measure;

  useLayoutEffect(measure, [compact, text]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const r = row.current;
    if (!compact || !r) return;
    const observer = new ResizeObserver(() => latest.current());
    observer.observe(r);
    return () => observer.disconnect();
  }, [compact]);

  // From where things stood to where the browser just put them. The field's height has no transition of its own: its size comes from its content.
  const stood = useRef<{ height: number; left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const [r, c] = [row.current, controls.current];
    if (!compact || !r || !c) return;
    r.getAnimations().forEach((a) => a.cancel());
    c.getAnimations().forEach((a) => a.cancel());
    const box = r.getBoundingClientRect();
    const place = c.getBoundingClientRect();
    const now = { height: box.height, left: place.left - box.left, top: place.top - box.top };
    const was = stood.current;
    stood.current = now;
    if (!was || box.height === 0 || was.height === 0 || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const options = { duration: MOVE_MS, easing: EASE };
    if (was.height !== now.height) r.animate([{ height: `${was.height}px`, overflow: 'hidden' }, { height: `${now.height}px`, overflow: 'hidden' }], options);
    if (was.left !== now.left || was.top !== now.top) c.animate([{ transform: `translate(${was.left - now.left}px, ${was.top - now.top}px)` }, { transform: 'none' }], options);
  }, [compact, text, tall]);

  return { row, field, controls, tall };
}
