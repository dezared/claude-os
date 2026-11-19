// Agentation over Claude OS: the toolbar is there for as long as the plugin is enabled, and its code, a bundle built by tools/build-vendor.mjs, loads only then.
const ENDPOINT_KEY = 'agentation.endpoint'; // another port, for tests
const HIDDEN_KEY = 'agentation-session-toolbar-hidden'; // the toolbar's own "hide for this session"
// The daemon through Claude OS itself (server/proxy.ts): any window that shows Claude OS reaches it, with no port forwarding of its own.
const DEFAULT_ENDPOINT = `${location.origin}/api/plugins/agentation/proxy`;
const NOTES_KEY = 'feedback-annotations-'; // the toolbar's notes of a page, by its path
const SESSION_KEY = 'agentation-session-'; // the toolbar's session of a page, by its path
const HEALTH_MS = 10_000;
const FADE_MS = 160; // the host keeps a leaving overlay mounted this long (LEAVE_MS in web/src/lib/motion.ts)

const STRINGS = {
  ru: {
    failed: 'Agentation не загрузился',
    local: 'MCP-сервер agentation недоступен: заметки остаются в браузере и уйдут к Claude, когда он вернётся',
    back: 'MCP-сервер agentation снова на связи',
  },
  en: {
    failed: 'Agentation failed to load',
    local: 'The agentation MCP server is unreachable: notes stay in the browser and reach Claude when it returns',
    back: 'The agentation MCP server is back',
  },
};

const CSS = `
.agn-host { app-region: no-drag; -webkit-app-region: no-drag; }
`;

// The host is display: contents and has no box to fade, and its parts inherit their place from it: the fade goes on the parts, from inside the shadow root.
const SHADOW_CSS = `
[data-agentation-root] > * { animation: agn-in ${FADE_MS}ms ease-out; }
:host(.agn-leaving) [data-agentation-root] > * { opacity: 0 !important; pointer-events: none !important; transition: opacity ${FADE_MS}ms ease-in !important; }
@keyframes agn-in { from { opacity: 0; } }
@media (prefers-reduced-motion: reduce) { [data-agentation-root] > * { animation: none; } :host(.agn-leaving) [data-agentation-root] > * { transition: none !important; } }
`;

const getJson = (url) => fetch(url, { signal: AbortSignal.timeout(4000) }).then((r) => (r.ok ? r.json() : null));
const open = (n) => !n._syncedTo && n.kind !== 'placement' && n.kind !== 'rearrange' && n.status !== 'resolved' && n.status !== 'dismissed';

/**
 * Notes the toolbar never sent may already be on the server, brought there by tools/import-notes.ts: before the toolbar
 * loads, its page joins that session and its notes take the server's ids, so the toolbar sends no second copy of them.
 */
async function adoptServerNotes(endpoint) {
  const path = location.pathname;
  const local = JSON.parse(localStorage.getItem(NOTES_KEY + path) || '[]');
  if (!local.some(open) || localStorage.getItem(SESSION_KEY + path)) return;
  const here = (url) => {
    const u = new URL(url);
    return u.origin + u.pathname === location.origin + path;
  };
  const sessions = (await getJson(`${endpoint}/sessions`)) ?? [];
  const found = sessions.filter((s) => here(s.url)).sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const session = found && (await getJson(`${endpoint}/sessions/${encodeURIComponent(found.id)}`));
  if (!session) return;
  const twin = (n) => session.annotations.find((a) => a.comment === n.comment && a.timestamp === n.timestamp);
  localStorage.setItem(NOTES_KEY + path, JSON.stringify(local.map((n) => (open(n) && twin(n) ? { ...n, id: twin(n).id, _syncedTo: session.id } : n))));
  localStorage.setItem(SESSION_KEY + path, session.id);
}

export function activate(host) {
  const { React, ReactDOM, toast, lang } = host;
  const { createElement: h, useEffect, useState } = React;
  const text = STRINGS[lang()] ?? STRINGS.en;
  const endpoint = localStorage.getItem(ENDPOINT_KEY) || DEFAULT_ENDPOINT;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);

  // The plugin being enabled is the only switch: the toolbar's own "hide for this session" lasts until the window reloads.
  sessionStorage.removeItem(HIDDEN_KEY);
  let link = 'checking';

  const setLink = (next) => {
    if (next === link) return;
    if (next === 'local') toast(text.local);
    else if (next === 'connected' && link === 'local') toast(text.back);
    link = next;
  };

  let library = null;
  // The toolbar reads its notes and session once, when it mounts: the adoption goes first, and a server away does not hold it up.
  const adopted = adoptServerNotes(endpoint).catch(() => {});
  const loadLibrary = () => (library ??= Promise.all([import('./agentation.vendor.js'), adopted]).then(([m]) => m.load(React, ReactDOM)));

  /** An open modal traps focus: the package's documented way in is to live inside it. */
  function useOpenDialog() {
    const [dialog, setDialog] = useState(null);
    useEffect(() => {
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
    }, []);
    return dialog;
  }

  /** `leaving`: the plugin was just disabled and the host keeps this mounted while it fades out. */
  function Overlay({ leaving }) {
    const [lib, setLib] = useState(null);
    const dialog = useOpenDialog();

    useEffect(() => {
      let stale = false;
      loadLibrary().then((m) => {
        if (!stale) setLib(m);
      }).catch((e) => {
        console.error(e);
        library = null;
        toast(text.failed, 'error');
      });
      return () => {
        stale = true;
      };
    }, []);

    useEffect(() => {
      if (leaving) return undefined;
      const check = () => fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(4000) })
        .then((r) => setLink(r.ok ? 'connected' : 'local'))
        .catch(() => setLink('local'));
      void check();
      const timer = setInterval(check, HEALTH_MS);
      return () => {
        clearInterval(timer);
        link = 'checking';
      };
    }, [leaving]);

    // A press on the toolbar is not a press outside the modal under it, and Esc in its note closes the note alone.
    useEffect(() => {
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
    }, []);

    useEffect(() => {
      if (!lib) return undefined;
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
    }, [lib]);

    if (!lib) return null;
    return h(lib.Agentation, {
      endpoint,
      appName: 'Claude OS',
      enableKeyboardShortcuts: false, // bare letters would fight the app's own keys
      className: `agn-host${leaving ? ' agn-leaving' : ''}`,
      portalContainer: dialog,
    });
  }

  return {
    overlay: Overlay,
    dispose() {
      style.remove();
    },
  };
}
