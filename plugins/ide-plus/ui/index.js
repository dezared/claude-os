// IDE+: a light editor over the project files panel. Plain modules with no build step: React comes from the app.
import { ICONS } from './icons.js';

const NAMES = {
  'dockerfile': 'docker', '.dockerignore': 'docker', 'docker-compose.yml': 'docker', 'docker-compose.yaml': 'docker', 'compose.yml': 'docker', 'compose.yaml': 'docker',
  '.gitignore': 'git', '.gitattributes': 'git', '.gitmodules': 'git',
  'package.json': 'npm', 'package-lock.json': 'lock', '.npmrc': 'npm',
  'yarn.lock': 'lock', 'pnpm-lock.yaml': 'lock', 'cargo.lock': 'lock', 'composer.lock': 'lock',
};
const EXTENSIONS = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'react', jsx: 'react', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', php: 'php', go: 'go', rs: 'rust', java: 'java', rb: 'ruby', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp', cs: 'csharp',
  swift: 'swift', kt: 'kotlin', html: 'html', htm: 'html', css: 'css', scss: 'sass', sass: 'sass', vue: 'vue', svelte: 'svelte',
  md: 'markdown', mdx: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml', sh: 'shell', bash: 'shell', zsh: 'shell', sql: 'sql',
  env: 'env', lock: 'lock', svg: 'svg', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image', ico: 'image',
  mp4: 'video', m4v: 'video', webm: 'video', mov: 'video', mkv: 'video', ogv: 'video', mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio',
  zip: 'archive', gz: 'archive', tar: 'archive', rar: 'archive', '7z': 'archive', txt: 'text', log: 'text', pdf: 'text',
};
// The languages the app's highlighter knows; anything else stays plain text.
const LANGUAGES = {
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescript', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  py: 'python', php: 'php', go: 'go', rs: 'rust', java: 'java', css: 'css', scss: 'css', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml', vue: 'xml', svelte: 'xml',
  md: 'markdown', mdx: 'markdown', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'toml', ini: 'ini', env: 'ini', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql', diff: 'diff', patch: 'diff',
};

// What opens as a picture or a player instead of as text. SVG is text too: it can be read both ways.
const MEDIA = { svg: 'svg', png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', avif: 'image', bmp: 'image', ico: 'image', mp4: 'video', m4v: 'video', webm: 'video', mov: 'video', mkv: 'video', ogv: 'video', mp3: 'audio', wav: 'audio', ogg: 'audio', oga: 'audio', opus: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio' };

const STRINGS = {
  ru: {
    image: 'Картинка', video: 'Видео', audio: 'Аудио', preview: 'Просмотр', code: 'Код', fit: 'По размеру панели', zoomIn: 'Увеличить', zoomOut: 'Уменьшить', mediaFailed: 'Этот файл не получается показать здесь. Формат может не поддерживаться.',
    reveal: 'Открыть в проводнике', save: 'Сохранить', saved: 'Сохранено', unsaved: 'Есть несохранённые правки', readonly: 'Только чтение', plain: 'Текст',
    smaller: 'Уменьшить код', larger: 'Увеличить код', resetZoom: 'Вернуть размер', resize: 'Изменить ширину панели', editor: 'Текст файла',
    conflict: 'Файл изменился на диске, пока вы его правили.', overwrite: 'Перезаписать', takeDisk: 'Взять с диска',
  },
  en: {
    image: 'Image', video: 'Video', audio: 'Audio', preview: 'Preview', code: 'Code', fit: 'Fit the panel', zoomIn: 'Zoom in', zoomOut: 'Zoom out', mediaFailed: 'This file cannot be shown here. Its format may not be supported.',
    reveal: 'Open in file manager', save: 'Save', saved: 'Saved', unsaved: 'Unsaved changes', readonly: 'Read only', plain: 'Text',
    smaller: 'Make code smaller', larger: 'Make code larger', resetZoom: 'Reset size', resize: 'Resize the panel', editor: 'File text',
    conflict: 'The file changed on disk while you were editing it.', overwrite: 'Overwrite', takeDisk: 'Use the disk version',
  },
};

const CSS = `
.idep-root { position: absolute; inset: 0; display: flex; flex-direction: column; background: var(--color-bg); }
.idep-bar { flex: none; display: flex; align-items: center; gap: 4px; padding: 2px 6px 2px 10px; border-bottom: 1px solid var(--color-line2); font-size: 11px; color: var(--color-dim); }
.idep-grow { flex: 1; min-width: 0; }
.idep-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-accent); }
.idep-btn { min-width: 22px; height: 22px; padding: 0 5px; border-radius: 5px; font-size: 11px; color: var(--color-muted); font-variant-numeric: tabular-nums; }
.idep-btn:hover:not(:disabled) { background: var(--color-raised); color: var(--color-fg); }
.idep-btn:disabled { opacity: .45; }
.idep-btn.idep-primary:not(:disabled) { color: var(--color-accent); }
.idep-conflict { flex: none; display: flex; flex-wrap: wrap; align-items: center; gap: 4px 8px; padding: 4px 10px; border-bottom: 1px solid var(--color-line2); font-size: 11px; color: var(--color-warn); }
.idep-scroll { flex: 1; min-height: 0; overflow: auto; }
.idep-code { display: flex; min-width: fit-content; min-height: 100%; font-family: var(--font-mono); line-height: 1.55; tab-size: 4; font-variant-ligatures: none; }
.idep-gutter { position: sticky; left: 0; z-index: 1; flex: none; margin: 0; padding: 8px; border-right: 1px solid var(--color-line2); background: var(--color-bg); color: var(--color-dim); text-align: right; font: inherit; user-select: none; }
.idep-stack { position: relative; flex: 1; display: grid; }
.idep-stack > pre, .idep-stack > textarea { grid-area: 1 / 1; margin: 0; padding: 8px 12px; border: 0; font: inherit; line-height: inherit; tab-size: inherit; font-variant: inherit; letter-spacing: inherit; white-space: pre; overflow: hidden; }
.idep-text { color: var(--color-soft); pointer-events: none; }
.idep-input { width: 0; min-width: 100%; height: 0; min-height: 100%; resize: none; outline: none; background: transparent; color: transparent; caret-color: var(--color-fg); }
.idep-input::selection { background: rgba(217, 119, 87, .3); }
.idep-line { position: absolute; left: 0; right: 0; background: var(--color-accent-bg); pointer-events: none; }
.idep-resizable { padding-right: 5px; }
.idep-handle { position: absolute; top: 0; bottom: 0; right: 0; width: 5px; z-index: 2; cursor: col-resize; touch-action: none; }
.idep-seg { display: inline-flex; gap: 1px; margin-right: 4px; }
.idep-btn[aria-pressed="true"] { background: var(--color-raised); color: var(--color-fg); }
.idep-btn { transition: background-color .12s ease, color .12s ease; }
.idep-stage { flex: 1; min-height: 0; overflow: auto; display: flex; animation: idep-in .16s ease-out; }
.idep-stage > * { margin: auto; flex: none; }
.idep-board { background-color: #1a1a1f; background-image: linear-gradient(45deg, #24242b 25%, transparent 25%, transparent 75%, #24242b 75%), linear-gradient(45deg, #24242b 25%, transparent 25%, transparent 75%, #24242b 75%); background-size: 16px 16px; background-position: 0 0, 8px 8px; }
.idep-picture { display: block; transition: width .14s ease-out, opacity .14s ease-out; }
.idep-picture.idep-fit { max-width: 100%; max-height: 100%; object-fit: contain; }
.idep-video { width: 100%; max-height: 100%; background: #000; }
.idep-audio { display: flex; flex-direction: column; align-items: center; gap: 12px; width: min(90%, 420px); padding: 16px; color: var(--color-muted); font-size: 12px; text-align: center; overflow-wrap: anywhere; }
.idep-audio audio { width: 100%; }
.idep-failed { padding: 16px; font-size: 12px; color: var(--color-muted); text-align: center; }
@keyframes idep-in { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .idep-stage { animation: none; } .idep-picture, .idep-btn { transition: none; } }
.idep-handle:hover, .idep-handle:focus-visible, .idep-handle.idep-active { background: var(--color-accent); opacity: .5; outline: none; }
`;

const MIN_SIZE = 9;
const MAX_SIZE = 28;
const DEFAULT_SIZE = 12;
const SIZE_KEY = 'ide-plus.font-size';
const WIDTH_KEY = 'ide-plus.pane-width';
const MIN_WIDTH = 320;
const TREE_AND_CHAT = 224 + 420; // the tree beside the pane and what the chat needs to stay usable

const extension = (name) => {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf('.');
  return dot < 0 ? '' : lower.slice(dot + 1);
};
const nameOf = (path) => path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
const normalize = (text) => text.replace(/\r\n/g, '\n');
const clampSize = (n) => Math.min(MAX_SIZE, Math.max(MIN_SIZE, n));
const clampWidth = (n) => Math.max(MIN_WIDTH, Math.min(window.innerWidth - TREE_AND_CHAT, n));
const clampScale = (n) => Math.min(8, Math.max(0.1, n));
const fmtTime = (s) => (Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}` : '');
const lineCount = (text) => (text.endsWith('\n') ? text.split('\n').length - 1 : text.split('\n').length) || 1;

export function activate(host) {
  const { React, api, highlight, toastError, lang } = host;
  const { createElement: h, useDeferredValue, useEffect, useMemo, useRef, useState } = React;
  const text = STRINGS[lang()] ?? STRINGS.en;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  // Survive closing the pane or switching files: a draft is lost only by saving it or choosing the disk version.
  const drafts = new Map();

  function Icon({ icon, size = 12 }) {
    const common = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': true, style: { flex: 'none', color: icon.color } };
    if (icon.kind === 'fill') return h('svg', { ...common, fill: 'currentColor' }, h('path', { d: icon.body }));
    return h('svg', { ...common, fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' }, icon.body.map(([tag, attrs], i) => h(tag, { key: i, ...attrs })));
  }

  function useStoredWidth(setPaneWidth) {
    useEffect(() => {
      const width = Number(localStorage.getItem(WIDTH_KEY));
      if (setPaneWidth && width) setPaneWidth(clampWidth(width));
    }, []);
  }

  // Sits in the view's root, which sits in the pane's scroller, which sits in the pane.
  function ResizeHandle({ setPaneWidth }) {
    const [dragging, setDragging] = useState(false);
    const paneOf = (handle) => handle.parentElement.parentElement.parentElement;
    const startResize = (e) => {
      const handle = e.currentTarget;
      const startX = e.clientX;
      const startWidth = paneOf(handle).getBoundingClientRect().width;
      let width = startWidth;
      handle.setPointerCapture(e.pointerId);
      setDragging(true);
      const onMove = (m) => {
        width = clampWidth(startWidth + m.clientX - startX);
        setPaneWidth(width);
      };
      const onUp = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
        localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
        setDragging(false);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    };
    const nudgeWidth = (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const width = clampWidth(paneOf(e.currentTarget).getBoundingClientRect().width + (e.key === 'ArrowRight' ? 24 : -24));
      localStorage.setItem(WIDTH_KEY, String(Math.round(width)));
      setPaneWidth(width);
    };
    return h('div', {
      role: 'separator',
      'aria-orientation': 'vertical',
      'aria-label': text.resize,
      title: text.resize,
      tabIndex: 0,
      className: `idep-handle${dragging ? ' idep-active' : ''}`,
      onPointerDown: startResize,
      onKeyDown: nudgeWidth,
    });
  }

  function Picture({ src, alt, leading, setPaneWidth }) {
    const [scale, setScale] = useState(null); // null: fit the panel
    const [size, setSize] = useState(null);
    const [failed, setFailed] = useState(false);
    const box = useRef(null);
    useStoredWidth(setPaneWidth);
    useEffect(() => setFailed(false), [src]);
    const current = () => {
      const img = box.current?.querySelector('img');
      return scale ?? (img && size ? img.clientWidth / size.width : 1);
    };
    const zoomBy = useRef(null);
    zoomBy.current = (factor) => setScale(clampScale(current() * factor));
    useEffect(() => {
      const el = box.current;
      const onWheel = (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        zoomBy.current(e.deltaY < 0 ? 1.25 : 0.8);
      };
      el.addEventListener('wheel', onWheel, { passive: false });
      return () => el.removeEventListener('wheel', onWheel);
    }, []);
    return h('div', { className: `idep-root${setPaneWidth ? ' idep-resizable' : ''}` },
      h('div', { className: 'idep-bar' },
        leading,
        size && h('span', { 'data-testid': 'ide-plus-size' }, `${size.width}×${size.height}`),
        h('span', { className: 'idep-grow' }),
        h('button', { type: 'button', className: 'idep-btn', 'aria-label': text.zoomOut, title: text.zoomOut, onClick: () => zoomBy.current(0.8) }, '−'),
        h('button', { type: 'button', className: 'idep-btn', 'aria-label': text.fit, 'aria-pressed': scale === null, title: text.fit, onClick: () => setScale(null) }, scale === null ? text.fit : `${Math.round(scale * 100)}%`),
        h('button', { type: 'button', className: 'idep-btn', 'aria-label': text.zoomIn, title: text.zoomIn, onClick: () => zoomBy.current(1.25) }, '+'),
      ),
      h('div', { ref: box, className: 'idep-stage idep-board' },
        failed
          ? h('p', { role: 'alert', className: 'idep-failed' }, text.mediaFailed)
          : h('img', {
            src,
            alt,
            'data-testid': 'ide-plus-picture',
            draggable: false,
            className: `idep-picture${scale === null ? ' idep-fit' : ''}`,
            style: scale !== null && size ? { width: size.width * scale, maxWidth: 'none' } : undefined,
            onLoad: (e) => setSize({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight }),
            onError: () => setFailed(true),
          }),
      ),
      setPaneWidth && h(ResizeHandle, { setPaneWidth }),
    );
  }

  /** Seeking is ranges from the server's media route, so a long film does not load whole. */
  function Player({ kind, src, name, setPaneWidth }) {
    const [meta, setMeta] = useState('');
    const [failed, setFailed] = useState(false);
    useStoredWidth(setPaneWidth);
    useEffect(() => setFailed(false), [src]);
    const common = {
      src,
      controls: true,
      preload: 'metadata',
      'data-testid': `ide-plus-${kind}`,
      onError: () => setFailed(true),
      onLoadedMetadata: (e) => {
        const el = e.currentTarget;
        setMeta([el.videoWidth ? `${el.videoWidth}×${el.videoHeight}` : '', fmtTime(el.duration)].filter(Boolean).join(' · '));
      },
    };
    return h('div', { className: `idep-root${setPaneWidth ? ' idep-resizable' : ''}` },
      h('div', { className: 'idep-bar' }, h('span', null, kind === 'video' ? text.video : text.audio), meta && h('span', { 'data-testid': 'ide-plus-meta' }, `· ${meta}`)),
      h('div', { className: 'idep-stage' },
        failed
          ? h('p', { role: 'alert', className: 'idep-failed' }, text.mediaFailed)
          : kind === 'video'
            ? h('video', { ...common, className: 'idep-video' })
            : h('div', { className: 'idep-audio' }, h(Icon, { icon: ICONS.audio, size: 40 }), name, h('audio', common)),
      ),
      setPaneWidth && h(ResizeHandle, { setPaneWidth }),
    );
  }

  /** An img runs no script in the file and loads nothing it points at. Saved text is asked for again: the panel's copy stops at what it first opened. */
  function SvgView(props) {
    const { tabId, path, file } = props;
    const [mode, setMode] = useState('preview');
    const [latest, setLatest] = useState(file);
    useEffect(() => setLatest(file), [file]);
    useEffect(() => {
      if (mode !== 'preview') return undefined;
      let stale = false;
      api(`/api/tabs/${encodeURIComponent(tabId)}/file?path=${encodeURIComponent(path)}`).then((fresh) => {
        if (!stale) setLatest(fresh);
      }, () => {});
      return () => {
        stale = true;
      };
    }, [mode]);
    const modes = h('span', { className: 'idep-seg' },
      h('button', { type: 'button', className: 'idep-btn', 'aria-pressed': mode === 'preview', onClick: () => setMode('preview') }, text.preview),
      h('button', { type: 'button', className: 'idep-btn', 'aria-pressed': mode === 'code', onClick: () => setMode('code') }, text.code),
    );
    if (mode === 'code') return h(View, { ...props, file: latest, extra: modes });
    const shown = drafts.get(`${tabId}:${path}`)?.text ?? latest.text ?? '';
    return h(Picture, { src: `data:image/svg+xml;utf8,${encodeURIComponent(shown)}`, alt: path, leading: modes, setPaneWidth: props.setPaneWidth });
  }

  function FileView(props) {
    const { tabId, path, file } = props;
    const kind = MEDIA[extension(nameOf(path))];
    if (kind === 'svg') return file.kind === 'text' && !file.truncated ? h(SvgView, props) : h(View, props);
    if (!kind) return h(View, props);
    const src = `/api/tabs/${encodeURIComponent(tabId)}/media?path=${encodeURIComponent(path)}`;
    if (kind === 'image') return h(Picture, { src, alt: path, leading: h('span', null, text.image), setPaneWidth: props.setPaneWidth });
    return h(Player, { kind, src, name: nameOf(path), setPaneWidth: props.setPaneWidth });
  }

  function View({ tabId, path, file, line, setPaneWidth, extra }) {
    const key = `${tabId}:${path}`;
    const url = `/api/tabs/${encodeURIComponent(tabId)}/file`;
    const [base, setBase] = useState(file);
    const [draft, setDraftState] = useState(() => drafts.get(key) ?? null);
    const [size, setSize] = useState(() => clampSize(Number(localStorage.getItem(SIZE_KEY)) || DEFAULT_SIZE));
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState(false);
    const scroller = useRef(null);
    const root = useRef(null);

    useEffect(() => setBase(file), [file]);
    const setDraft = (next) => {
      if (next) drafts.set(key, next);
      else drafts.delete(key);
      setDraftState(next);
    };

    const baseText = normalize(base.text ?? '');
    const eol = (base.text ?? '').includes('\r\n') ? '\r\n' : '\n';
    const value = draft ? draft.text : baseText;
    const dirty = draft !== null && draft.text !== baseText;
    const conflict = dirty && draft.sha !== base.sha;
    const editable = base.sha !== null;
    const deferred = useDeferredValue(value);
    const language = LANGUAGES[extension(nameOf(path))];
    const lineHeight = size * 1.55;

    const zoom = (next) => {
      const clamped = clampSize(next);
      localStorage.setItem(SIZE_KEY, String(clamped));
      setSize(clamped);
    };
    const zoomBy = useRef(null);
    zoomBy.current = (delta) => zoom(size + delta);

    // React's wheel listener is passive: only a native one can stop the page from zooming.
    useEffect(() => {
      const box = scroller.current;
      const onWheel = (e) => {
        if (!(e.ctrlKey || e.metaKey)) return;
        e.preventDefault();
        zoomBy.current(e.deltaY < 0 ? 1 : -1);
      };
      box.addEventListener('wheel', onWheel, { passive: false });
      return () => box.removeEventListener('wheel', onWheel);
    }, []);

    useEffect(() => {
      if (line) scroller.current.scrollTop = Math.max(0, (line - 1) * lineHeight - 80);
    }, [line]);

    useStoredWidth(setPaneWidth);

    const write = async (sha) => {
      if (busy || !draft) return;
      setBusy(true);
      try {
        setBase(await api(url, { method: 'PUT', body: { path, text: draft.text.replace(/\n/g, eol), sha } }));
        setDraft(null);
        setSaved(true);
      } catch (e) {
        // Whatever went wrong, show the file as it is now: a change on disk turns into the conflict bar below.
        const fresh = await api(`${url}?path=${encodeURIComponent(path)}`).catch(() => null);
        if (fresh) setBase(fresh);
        if (!fresh || fresh.sha === sha) toastError(e);
      } finally {
        setBusy(false);
      }
    };

    const onKeyDown = (e) => {
      if (e.key === 'Tab' && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.target.tagName === 'TEXTAREA') {
        e.preventDefault();
        document.execCommand('insertText', false, '  '); // keeps the browser's undo working
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.code === 'KeyS') {
        e.preventDefault();
        if (dirty && !conflict && editable) void write(draft.sha);
      } else if (e.code === 'Equal' || e.code === 'NumpadAdd') {
        e.preventDefault();
        zoomBy.current(1);
      } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
        e.preventDefault();
        zoomBy.current(-1);
      } else if (e.code === 'Digit0' || e.code === 'Numpad0') {
        e.preventDefault();
        zoom(DEFAULT_SIZE);
      }
    };

    const numbers = useMemo(() => Array.from({ length: lineCount(deferred) }, (_, i) => i + 1).join('\n'), [deferred]);
    const html = useMemo(() => (language ? highlight(deferred, language) : null), [deferred, language]);

    return h('div', { ref: root, className: `idep-root${setPaneWidth ? ' idep-resizable' : ''}`, onKeyDown },
      h('div', { className: 'idep-bar' },
        extra,
        h('span', null, language ?? text.plain),
        !editable && h('span', null, `· ${text.readonly}`),
        dirty && h('span', { className: 'idep-dot', role: 'img', 'aria-label': text.unsaved, title: text.unsaved }),
        !dirty && saved && h('span', { role: 'status' }, text.saved),
        h('span', { className: 'idep-grow' }),
        editable && h('button', { type: 'button', className: 'idep-btn idep-primary', disabled: !dirty || conflict || busy, title: 'Ctrl+S', onClick: () => write(draft.sha) }, text.save),
        h('button', { type: 'button', className: 'idep-btn', 'aria-label': text.smaller, title: `${text.smaller} (Ctrl+-)`, disabled: size <= MIN_SIZE, onClick: () => zoom(size - 1) }, 'A−'),
        h('button', { type: 'button', className: 'idep-btn', 'aria-label': text.resetZoom, title: `${text.resetZoom} (Ctrl+0)`, onClick: () => zoom(DEFAULT_SIZE) }, `${Math.round((size / DEFAULT_SIZE) * 100)}%`),
        h('button', { type: 'button', className: 'idep-btn', 'aria-label': text.larger, title: `${text.larger} (Ctrl+=)`, disabled: size >= MAX_SIZE, onClick: () => zoom(size + 1) }, 'A+'),
      ),
      conflict && h('div', { role: 'alert', className: 'idep-conflict' },
        h('span', null, text.conflict),
        h('button', { type: 'button', className: 'idep-btn', disabled: busy, onClick: () => write(base.sha) }, text.overwrite),
        h('button', { type: 'button', className: 'idep-btn', disabled: busy, onClick: () => setDraft(null) }, text.takeDisk),
      ),
      h('div', { ref: scroller, className: 'idep-scroll' },
        h('div', { className: 'idep-code', style: { fontSize: size } },
          h('pre', { className: 'idep-gutter', 'aria-hidden': true }, numbers),
          h('div', { className: 'idep-stack' },
            line && h('div', { className: 'idep-line', style: { top: 8 + (line - 1) * lineHeight, height: lineHeight } }),
            // The newline keeps a last empty line as tall as the textarea above it.
            html === null
              ? h('pre', { className: 'idep-text', 'aria-hidden': true }, `${deferred}\n`)
              : h('pre', { className: 'idep-text', 'aria-hidden': true, dangerouslySetInnerHTML: { __html: `${html}\n` } }),
            h('textarea', {
              className: 'idep-input',
              'aria-label': text.editor,
              'data-testid': 'ide-plus-editor',
              wrap: 'off',
              spellCheck: false,
              autoCapitalize: 'off',
              autoCorrect: 'off',
              readOnly: !editable,
              value,
              onChange: (e) => {
                setSaved(false);
                setDraft(e.target.value === baseText ? null : { text: e.target.value, sha: draft?.sha ?? base.sha });
              },
            }),
          ),
        ),
      ),
      setPaneWidth && h(ResizeHandle, { setPaneWidth }),
    );
  }

  return {
    fileIcon({ name, dir, expanded }) {
      if (dir) return h(Icon, { icon: expanded ? ICONS.folderOpen : ICONS.folder });
      const lower = name.toLowerCase();
      const kind = NAMES[lower] ?? (lower === '.env' || lower.startsWith('.env.') ? 'env' : EXTENSIONS[extension(lower)]) ?? 'file';
      return h(Icon, { icon: ICONS[kind] });
    },
    fileMenu(entry, { tabId }) {
      return [{
        id: 'ide-plus.reveal',
        label: text.reveal,
        icon: ({ size }) => h(Icon, { icon: ICONS.reveal, size }),
        onSelect: () => void api(`/api/tabs/${encodeURIComponent(tabId)}/reveal`, { method: 'POST', body: { path: entry.path } }).catch(toastError),
      }];
    },
    fileView: FileView,
    opensMedia: (path) => ['image', 'video', 'audio'].includes(MEDIA[extension(nameOf(path))]),
    dispose() {
      style.remove();
    },
  };
}
