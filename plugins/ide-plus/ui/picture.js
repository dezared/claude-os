// Pictures: the wheel zooms around the pointer, a drag or Space + drag pans, a double click fits the panel again.
const clampScale = (n) => Math.min(32, Math.max(0.05, n));
const WHEEL_STEP = 0.0015; // a wheel notch of 100 is about 14%; a touchpad sends many small ones
const typing = (el) => /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable;
const middle = (el) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

// Set once by makePicture: the app's React and the plugin's own strings and pieces.
let R;
let deps;
const h = (...args) => R.createElement(...args);
const useEffect = (...args) => R.useEffect(...args);
const useLayoutEffect = (...args) => R.useLayoutEffect(...args);
const useRef = (value) => R.useRef(value);
const useState = (value) => R.useState(value);

// The scale "fit the panel" shows at, so its percent can be read and a zoom can start from it.
function useFit(box, size) {
  const [fit, setFit] = useState(1);
  useEffect(() => {
    const el = box.current;
    if (!el || !size) return undefined;
    const measure = () => setFit(Math.min(1, el.clientWidth / size.width, el.clientHeight / size.height));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [size]);
  return fit;
}

// The point under the pointer stays under it: remembered before the new size, scrolled back to after it is laid out.
function useZoom(box, fit) {
  const [scale, setScale] = useState(null); // null: fit the panel
  const anchor = useRef(null);
  const zoomBy = useRef(null);
  zoomBy.current = (factor, point) => {
    const img = box.current?.querySelector('img');
    if (!img) return;
    const r = img.getBoundingClientRect();
    anchor.current = { fx: (point.x - r.left) / r.width, fy: (point.y - r.top) / r.height, ...point };
    setScale(clampScale((scale ?? fit) * factor));
  };
  useLayoutEffect(() => {
    const a = anchor.current;
    const img = box.current?.querySelector('img');
    anchor.current = null;
    if (!a || !img) return;
    const r = img.getBoundingClientRect();
    box.current.scrollLeft += r.left + a.fx * r.width - a.x;
    box.current.scrollTop += r.top + a.fy * r.height - a.y;
  }, [scale]);
  useEffect(() => {
    const el = box.current;
    // React's wheel listener is passive: only a native one can keep the panel from scrolling instead.
    const onWheel = (e) => {
      e.preventDefault();
      zoomBy.current(Math.exp(-e.deltaY * WHEEL_STEP), { x: e.clientX, y: e.clientY });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  return { scale, setScale, zoomBy };
}

// Space is taken only while the pointer is over the picture, so it still types and presses buttons elsewhere.
function useSpace(over) {
  const [space, setSpace] = useState(false);
  useEffect(() => {
    const down = (e) => {
      if (e.code !== 'Space' || !over.current || typing(e.target)) return;
      e.preventDefault();
      setSpace(true);
    };
    const up = (e) => e.code === 'Space' && setSpace(false);
    const lost = () => setSpace(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', lost);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', lost);
    };
  }, []);
  return space;
}

function usePan(box, space) {
  const [dragging, setDragging] = useState(false);
  const onPointerDown = (e) => {
    const el = box.current;
    const overflows = el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
    if (e.button !== 0 || !(space || overflows)) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    setDragging(true);
    let last = { x: e.clientX, y: e.clientY };
    const move = (m) => {
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

function Stage({ box, src, alt, scale, size, onSize, failed, onFail, setScale }) {
  const over = useRef(false);
  const space = useSpace(over);
  const { dragging, onPointerDown } = usePan(box, space);
  const grab = dragging ? ' idep-grabbing' : space || scale !== null ? ' idep-grab' : '';
  return h('div', {
    ref: box,
    className: `idep-stage idep-board${grab}`,
    onPointerEnter: () => { over.current = true; },
    onPointerLeave: () => { over.current = false; },
    onPointerDown,
    onDoubleClick: () => setScale(null),
  }, failed ? h('p', { role: 'alert', className: 'idep-failed' }, deps.text.mediaFailed) : h('img', {
    src,
    alt,
    'data-testid': 'ide-plus-picture',
    draggable: false,
    className: `idep-picture${scale === null ? ' idep-fit' : ''}`,
    style: scale !== null && size ? { width: size.width * scale, maxWidth: 'none', maxHeight: 'none', imageRendering: scale >= 3 ? 'pixelated' : undefined } : undefined,
    onLoad: (e) => onSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight }),
    onError: onFail,
  }));
}

function Picture({ src, alt, leading, setPaneWidth }) {
  const { text, useStoredWidth, ResizeHandle } = deps;
  const [size, setSize] = useState(null);
  const [failed, setFailed] = useState(false);
  const box = useRef(null);
  const fit = useFit(box, size);
  const { scale, setScale, zoomBy } = useZoom(box, fit);
  useStoredWidth(setPaneWidth);
  useEffect(() => setFailed(false), [src]);
  const button = (label, factor, sign) => h('button', { type: 'button', className: 'idep-btn', 'aria-label': label, title: label, onClick: () => zoomBy.current(factor, middle(box.current)) }, sign);
  return h('div', { className: `idep-root${setPaneWidth ? ' idep-resizable' : ''}` },
    h('div', { className: 'idep-bar' },
      leading,
      size && h('span', { 'data-testid': 'ide-plus-size' }, `${size.width}×${size.height}`),
      h('span', { className: 'idep-grow' }),
      button(text.zoomOut, 0.8, '−'),
      h('button', { type: 'button', className: 'idep-btn', 'aria-label': text.fit, 'aria-pressed': scale === null, title: `${text.fit} (${text.doubleClick})`, 'data-testid': 'ide-plus-zoom', onClick: () => setScale(null) }, `${Math.round((scale ?? fit) * 100)}%`),
      button(text.zoomIn, 1.25, '+'),
    ),
    h(Stage, { box, src, alt, scale, size, onSize: setSize, failed, onFail: () => setFailed(true), setScale }),
    setPaneWidth && h(ResizeHandle, { setPaneWidth }),
  );
}

export function makePicture(given) {
  R = given.React;
  deps = given;
  return Picture;
}
