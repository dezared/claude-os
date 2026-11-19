// The picture in the image dialog: the wheel zooms around the pointer, a drag or Space + drag pans, a double click fits it again.
// The same behaviour as IDE+ pictures (plugins/ide-plus/ui/picture.js), which cannot import from the app.
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type RefObject } from 'react';
import { t } from '@/lib/i18n';

type Size = { width: number; height: number };
type Point = { x: number; y: number };

const clampScale = (n: number) => Math.min(32, Math.max(0.05, n));
const WHEEL_STEP = 0.0015; // a wheel notch of 100 is about 14%; a touchpad sends many small ones
const typing = (el: EventTarget | null) => el instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
const middle = (el: HTMLElement): Point => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

function useFit(box: RefObject<HTMLDivElement | null>, size: Size | null) {
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el || !size) return undefined;
    const measure = () => setFit(Math.min(1, el.clientWidth / size.width, el.clientHeight / size.height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [box, size]);
  return fit;
}

// The point under the pointer stays under it: remembered before the new size, scrolled back to after it is laid out.
function useZoom(box: RefObject<HTMLDivElement | null>, fit: number) {
  const [scale, setScale] = useState<number | null>(null); // null: fit the dialog
  const anchor = useRef<(Point & { fx: number; fy: number }) | null>(null);
  const zoomBy = useRef<(factor: number, point: Point) => void>(() => {});
  zoomBy.current = (factor, point) => {
    const img = box.current?.querySelector('img');
    if (!img) return;
    const r = img.getBoundingClientRect();
    anchor.current = { fx: (point.x - r.left) / r.width, fy: (point.y - r.top) / r.height, ...point };
    setScale(clampScale((scale ?? fit) * factor));
  };
  useLayoutEffect(() => {
    const a = anchor.current;
    const el = box.current;
    const img = el?.querySelector('img');
    anchor.current = null;
    if (!a || !el || !img) return;
    const r = img.getBoundingClientRect();
    el.scrollLeft += r.left + a.fx * r.width - a.x;
    el.scrollTop += r.top + a.fy * r.height - a.y;
  }, [box, scale]);
  useEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    // React's wheel listener is passive: only a native one can keep the dialog from scrolling instead.
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomBy.current(Math.exp(-e.deltaY * WHEEL_STEP), { x: e.clientX, y: e.clientY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [box]);
  return { scale, setScale, zoomBy };
}

// Space is taken only while the pointer is over the picture, so it still presses buttons elsewhere.
function useSpace(over: RefObject<boolean>) {
  const [space, setSpace] = useState(false);
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space' || !over.current || typing(e.target)) return;
      e.preventDefault();
      setSpace(true);
    };
    const up = (e: KeyboardEvent) => e.code === 'Space' && setSpace(false);
    const lost = () => setSpace(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', lost);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', lost);
    };
  }, [over]);
  return space;
}

function usePan(box: RefObject<HTMLDivElement | null>, space: boolean) {
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e: ReactPointerEvent) => {
    const el = box.current;
    if (!el || e.button !== 0) return;
    if (!space && el.scrollWidth <= el.clientWidth && el.scrollHeight <= el.clientHeight) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    let last = { x: e.clientX, y: e.clientY };
    const move = (m: PointerEvent) => {
      el.scrollLeft -= m.clientX - last.x;
      el.scrollTop -= m.clientY - last.y;
      last = { x: m.clientX, y: m.clientY };
    };
    const stop = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', stop);
      el.removeEventListener('pointercancel', stop);
      setDragging(false);
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', stop);
    el.addEventListener('pointercancel', stop);
  };
  return { dragging, onPointerDown };
}

export function ZoomImage({ src, alt, onError }: { src: string; alt: string; onError: () => void }) {
  const [size, setSize] = useState<Size | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const over = useRef(false);
  const fit = useFit(box, size);
  const { scale, setScale, zoomBy } = useZoom(box, fit);
  const space = useSpace(over);
  const { dragging, onPointerDown } = usePan(box, space);
  const cursor = dragging ? 'cursor-grabbing' : space || scale !== null ? 'cursor-grab' : '';
  const button = 'press grid h-6 min-w-6 place-items-center rounded-md px-1.5 text-[11px] text-muted tabular-nums hover:bg-raised hover:text-fg';
  return (
    <div className="flex min-h-0 flex-col gap-2">
      <div className="flex items-center gap-1 text-[11px] text-dim">
        {size && <span data-testid="zoom-size">{size.width}×{size.height}</span>}
        <span className="flex-1" />
        <button type="button" className={button} aria-label={t('files.zoomOut')} title={t('files.zoomOut')} onClick={() => box.current && zoomBy.current(0.8, middle(box.current))}>−</button>
        <button type="button" className={button} aria-label={t('files.zoomFit')} aria-pressed={scale === null} title={t('files.zoomFitHint')} data-testid="zoom-percent" onClick={() => setScale(null)}>{Math.round((scale ?? fit) * 100)}%</button>
        <button type="button" className={button} aria-label={t('files.zoomIn')} title={t('files.zoomIn')} onClick={() => box.current && zoomBy.current(1.25, middle(box.current))}>+</button>
      </div>
      <div
        ref={box}
        data-testid="zoom-stage"
        className={`flex h-[calc(100vh-220px)] min-h-0 overflow-auto select-none ${cursor}`}
        onPointerEnter={() => { over.current = true; }}
        onPointerLeave={() => { over.current = false; }}
        onPointerDown={onPointerDown}
        onDoubleClick={() => setScale(null)}
      >
        <img
          src={src}
          alt={alt}
          draggable={false}
          onLoad={(e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
          onError={onError}
          className={`m-auto block flex-none ${scale === null ? 'max-h-full max-w-full object-contain' : ''}`}
          style={scale !== null && size ? { width: size.width * scale, imageRendering: scale >= 3 ? 'pixelated' : undefined } : undefined}
        />
      </div>
    </div>
  );
}
