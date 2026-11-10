// Agentation over Claude OS: the toolbar is there as soon as the plugin is enabled, /agentation or the mark hides it. Its code loads only when on, from a bundle built by tools/build-vendor.mjs.
const ON_KEY = 'agentation.on';
const ENDPOINT_KEY = 'agentation.endpoint'; // another port, for tests
const HIDDEN_KEY = 'agentation-session-toolbar-hidden'; // the toolbar's own "hide for this session"
const DEFAULT_ENDPOINT = 'http://127.0.0.1:4747'; // the address the app itself already reaches through WSL's forwarding
const HEALTH_MS = 10_000;
const FADE_MS = 180;

const STRINGS = {
  ru: {
    description: 'Заметки к интерфейсу с привязкой к элементам: Claude их видит',
    usage: 'Использование: /agentation, /agentation on или /agentation off',
    on: 'Agentation включён',
    off: 'Agentation выключен',
    failed: 'Agentation не загрузился',
    local: 'MCP-сервер agentation недоступен: заметки остаются в браузере и уйдут к Claude, когда он вернётся',
    back: 'MCP-сервер agentation снова на связи',
    markLocal: 'локально',
    titleConnected: 'Заметки доходят до Claude. Нажмите, чтобы выключить',
    titleLocal: 'Сервер недоступен, заметки в браузере. Нажмите, чтобы выключить',
    titleChecking: 'Проверка сервера. Нажмите, чтобы выключить',
  },
  en: {
    description: 'Element-bound notes on the interface that Claude can read',
    usage: 'Usage: /agentation, /agentation on or /agentation off',
    on: 'Agentation is on',
    off: 'Agentation is off',
    failed: 'Agentation failed to load',
    local: 'The agentation MCP server is unreachable: notes stay in the browser and reach Claude when it returns',
    back: 'The agentation MCP server is back',
    markLocal: 'local',
    titleConnected: 'Notes reach Claude. Click to turn off',
    titleLocal: 'Server unreachable, notes stay in the browser. Click to turn off',
    titleChecking: 'Checking the server. Click to turn off',
  },
};

const CSS = `
.agn-host { app-region: no-drag; -webkit-app-region: no-drag; }
.agn-mark { display: inline-flex; flex: none; align-items: center; gap: 5px; border-radius: 4px; font-size: 11px; color: var(--color-accent); animation: agn-in ${FADE_MS}ms ease-out; }
.agn-mark:hover { color: var(--color-accent-hover); }
.agn-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--color-dim); }
.agn-mark[data-link="connected"] .agn-dot { background: var(--color-ok, #4ade80); }
.agn-mark[data-link="local"] .agn-dot { background: var(--color-warn); }
@keyframes agn-in { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .agn-mark { animation: none; } }
`;

// The host is display: contents and has no box to fade, and its parts inherit their place from it: the fade goes on the parts, from inside the shadow root.
const SHADOW_CSS = `
[data-agentation-root] > * { animation: agn-in ${FADE_MS}ms ease-out; }
:host(.agn-leaving) [data-agentation-root] > * { opacity: 0 !important; pointer-events: none !important; transition: opacity ${FADE_MS}ms ease-in !important; }
@keyframes agn-in { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { [data-agentation-root] > * { animation: none; } :host(.agn-leaving) [data-agentation-root] > * { transition: none !important; } }
`;

export function activate(host) {
  const { React, ReactDOM, toast, lang } = host;
  const { createElement: h, useEffect, useState, useSyncExternalStore } = React;
  const text = STRINGS[lang()] ?? STRINGS.en;
  const endpoint = localStorage.getItem(ENDPOINT_KEY) || DEFAULT_ENDPOINT;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  // Enabling the plugin is the ask: until someone turns it off there is no second switch to find.
  let on = localStorage.getItem(ON_KEY) !== '0';
  let link = 'checking';
  const listeners = new Set();
  const notify = () => listeners.forEach((l) => l());
  const subscribe = (l) => {
    listeners.add(l);
    return () => listeners.delete(l);
  };
  const setOn = (next) => {
    localStorage.setItem(ON_KEY, next ? '1' : '0');
    if (next) sessionStorage.removeItem(HIDDEN_KEY);
    on = next;
    notify();
  };
  // A second window follows the choice made in the first.
  const onStorage = (e) => {
    if (e.key !== ON_KEY) return;
    on = e.newValue !== '0';
    notify();
  };
  window.addEventListener('storage', onStorage);

  const setLink = (next) => {
    if (next === link) return;
    if (next === 'local') toast(text.local);
    else if (next === 'connected' && link === 'local') toast(text.back);
    link = next;
    notify();
  };

  let library = null;
  const loadLibrary = () => (library ??= import('./agentation.vendor.js').then((m) => m.load(React, ReactDOM)));

  /** An open modal traps focus: the package's documented way in is to live inside it. */
  function useOpenDialog(active) {
    const [dialog, setDialog] = useState(null);
    useEffect(() => {
      if (!active) return undefined;
      const find = () => {
        const open = document.querySelectorAll('[role="dialog"][data-state="open"]');
        setDialog(open[open.length - 1] ?? null);
      };
      find();
      const watcher = new MutationObserver(find);
      watcher.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-state'] });
      return () => {
        watcher.disconnect();
        setDialog(null);
      };
    }, [active]);
    return dialog;
  }

  function Overlay() {
    const wanted = useSyncExternalStore(subscribe, () => on);
    const [present, setPresent] = useState(wanted);
    const [lib, setLib] = useState(null);
    const dialog = useOpenDialog(present);

    useEffect(() => {
      if (wanted) {
        setPresent(true);
        return undefined;
      }
      const timer = setTimeout(() => setPresent(false), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : FADE_MS);
      return () => clearTimeout(timer);
    }, [wanted]);

    useEffect(() => {
      if (!wanted) return undefined;
      let stale = false;
      loadLibrary().then((m) => {
        if (!stale) setLib(m);
      }).catch((e) => {
        console.error(e);
        library = null;
        toast(text.failed, 'error');
        setOn(false);
      });
      return () => {
        stale = true;
      };
    }, [wanted]);

    useEffect(() => {
      if (!wanted) return undefined;
      const check = () => fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(4000) })
        .then((r) => setLink(r.ok ? 'connected' : 'local'))
        .catch(() => setLink('local'));
      void check();
      const timer = setInterval(check, HEALTH_MS);
      return () => {
        clearInterval(timer);
        link = 'checking';
      };
    }, [wanted]);

    // A press on the toolbar is not a press outside the modal under it, and Esc in its note closes the note alone.
    useEffect(() => {
      if (!present) return undefined;
      const inToolbar = (e) => e.target?.closest?.('agentation-toolbar');
      const onPointer = (e) => {
        if (inToolbar(e)) e.stopPropagation();
      };
      const onKey = (e) => {
        if (e.key === 'Escape' && inToolbar(e)) e.stopPropagation();
      };
      document.body.addEventListener('pointerdown', onPointer);
      document.body.addEventListener('keydown', onKey);
      return () => {
        document.body.removeEventListener('pointerdown', onPointer);
        document.body.removeEventListener('keydown', onKey);
      };
    }, [present]);

    useEffect(() => {
      if (!present || !lib) return undefined;
      let frame = 0;
      const dress = () => {
        const root = document.querySelector('agentation-toolbar')?.shadowRoot;
        if (!root) {
          frame = requestAnimationFrame(dress);
          return;
        }
        const css = document.createElement('style');
        css.textContent = SHADOW_CSS;
        root.append(css);
      };
      dress();
      return () => cancelAnimationFrame(frame);
    }, [present, lib]);

    if (!present || !lib) return null;
    return h(lib.Agentation, {
      endpoint,
      appName: 'Claude OS',
      enableKeyboardShortcuts: false, // bare letters would fight the app's own keys
      className: `agn-host${wanted ? '' : ' agn-leaving'}`,
      portalContainer: dialog,
    });
  }

  function Mark() {
    const wanted = useSyncExternalStore(subscribe, () => on);
    const state = useSyncExternalStore(subscribe, () => link);
    if (!wanted) return null;
    const title = state === 'connected' ? text.titleConnected : state === 'local' ? text.titleLocal : text.titleChecking;
    return h('button', { type: 'button', className: 'agn-mark press', 'data-testid': 'agentation-mark', 'data-link': state, title, onClick: () => setOn(false) },
      h('span', { className: 'agn-dot' }),
      state === 'local' ? `Agentation · ${text.markLocal}` : 'Agentation',
    );
  }

  return {
    commands: [{
      name: 'agentation',
      description: text.description,
      argumentHint: '[on|off]',
      run(args) {
        if (args && args !== 'on' && args !== 'off') {
          toast(text.usage, 'error');
          return;
        }
        const next = args ? args === 'on' : !on;
        setOn(next);
        toast(next ? text.on : text.off);
      },
    }],
    overlay: Overlay,
    composerMark: Mark,
    dispose() {
      window.removeEventListener('storage', onStorage);
      style.remove();
      localStorage.removeItem(ON_KEY); // only disabling comes here: enabled again, it starts visible again
      sessionStorage.removeItem(HIDDEN_KEY);
    },
  };
}
