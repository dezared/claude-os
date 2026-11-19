// A lesson as a page for the sandboxed frame: Claude's body HTML, code highlighted here (no scripts run in the frame), and a
// stylesheet built from the app's current theme colours, so the article follows the light and the dark theme.
const VARS = ['bg', 'card', 'fg', 'soft', 'muted', 'dim', 'line', 'line2', 'accent', 'accent-bg', 'ok', 'warn', 'bad', 'well', 'c-blue', 'c-green', 'c-gold', 'c-violet', 'c-red'];

function themeVars() {
  const css = getComputedStyle(document.documentElement);
  // Tailwind leaves out tokens no class uses: an empty one is skipped and the stylesheet's fallback applies.
  return VARS.map((v) => [v, css.getPropertyValue(`--color-${v}`).trim()]).filter(([, value]) => value).map(([v, value]) => `--${v}: ${value};`).join(' ');
}

const FRAME_CSS = `
html { color-scheme: var(--scheme); }
body { margin: 0; padding: 28px 36px 64px; background: var(--card); color: var(--soft); font: 15px/1.7 system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif; }
main { max-width: 760px; margin: 0 auto; }
h1, h2, h3, h4 { color: var(--fg); line-height: 1.3; }
h1 { font-size: 26px; margin: 0 0 8px; }
h2 { font-size: 20px; margin: 36px 0 10px; padding-top: 4px; }
h3 { font-size: 16px; margin: 24px 0 8px; }
h4 { font-size: 13px; margin: 0 0 6px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
p, ul, ol { margin: 0 0 14px; }
li { margin: 4px 0; }
a { color: var(--accent); }
strong { color: var(--fg); }
.lead { font-size: 17px; color: var(--fg); border-left: 3px solid var(--accent); padding: 2px 0 2px 16px; }
code { font: 13px/1.6 ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace; background: var(--well); border: 1px solid var(--line2); border-radius: 5px; padding: 1px 5px; }
pre { background: var(--well); border: 1px solid var(--line2); border-radius: 10px; padding: 14px 16px; overflow-x: auto; margin: 0 0 16px; }
pre code { background: none; border: 0; padding: 0; color: var(--soft); }
kbd { font: 12px ui-monospace, monospace; border: 1px solid var(--line); border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; }
table { border-collapse: collapse; margin: 0 0 16px; width: 100%; font-size: 14px; }
th, td { border: 1px solid var(--line2); padding: 6px 10px; text-align: left; vertical-align: top; }
th { color: var(--fg); background: var(--well); }
.note, .tip, .warn, .key { border-radius: 10px; padding: 12px 16px; margin: 0 0 16px; border: 1px solid var(--line2); background: var(--well); }
.note { border-left: 3px solid var(--c-blue, var(--accent)); }
.tip { border-left: 3px solid var(--ok); }
.warn { border-left: 3px solid var(--warn); }
.key { border: 1px solid var(--accent); background: var(--accent-bg); }
.key h3 { margin-top: 0; }
.note > :last-child, .tip > :last-child, .warn > :last-child, .key > :last-child { margin-bottom: 0; }
.compare { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 0 0 16px; }
.compare > div { min-width: 0; border: 1px solid var(--line2); border-radius: 10px; padding: 12px; }
.compare pre { margin: 0; }
details { border: 1px solid var(--line2); border-radius: 10px; padding: 8px 14px; margin: 0 0 12px; }
summary { cursor: pointer; color: var(--fg); font-weight: 500; }
details[open] summary { margin-bottom: 8px; }
svg { max-width: 100%; height: auto; }
img { max-width: 100%; }
.hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-built_in { color: var(--accent); }
.hljs-string, .hljs-regexp, .hljs-addition, .hljs-attribute { color: var(--c-green, var(--ok)); }
.hljs-number, .hljs-symbol, .hljs-bullet { color: var(--c-gold, var(--warn)); }
.hljs-title, .hljs-section, .hljs-name, .hljs-selector-class, .hljs-selector-id { color: var(--c-blue, var(--accent)); }
.hljs-attr, .hljs-variable, .hljs-template-variable, .hljs-type, .hljs-params { color: var(--c-violet, var(--c-blue, var(--accent))); }
.hljs-comment, .hljs-quote, .hljs-meta { color: var(--dim); font-style: italic; }
.hljs-deletion { color: var(--c-red, var(--bad)); }
@media (max-width: 640px) { .compare { grid-template-columns: 1fr; } body { padding: 20px; } }
`;

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function highlightAll(body, highlight) {
  for (const code of body.querySelectorAll('pre code')) {
    const lang = /(?:^|\s)(?:language|lang)-([\w+#-]+)/.exec(code.className)?.[1];
    const html = lang ? highlight(code.textContent ?? '', lang.toLowerCase()) : null;
    if (html) code.innerHTML = html;
  }
}

/** The whole page for the frame; the frame's own cleaning (documents) strips scripts and fixes links after this. */
export function lessonDocument(lesson, highlight) {
  const doc = new DOMParser().parseFromString(`<main>${lesson.html}</main>`, 'text/html');
  highlightAll(doc.body, highlight);
  const light = document.documentElement.dataset.theme === 'light';
  const head = `<meta charset="utf-8"><style>:root { ${themeVars()} --scheme: ${light ? 'light' : 'dark'}; }${FRAME_CSS}</style>`;
  return `<!doctype html><html lang="${document.documentElement.lang || 'en'}"><head>${head}<title>${escapeHtml(lesson.title)}</title></head><body>${doc.body.innerHTML}</body></html>`;
}

/** Re-renders its user when the app switches theme, so the open article follows. */
export function useTheme(React) {
  const [theme, setTheme] = React.useState(document.documentElement.dataset.theme ?? 'dark');
  React.useEffect(() => {
    const watch = new MutationObserver(() => setTheme(document.documentElement.dataset.theme ?? 'dark'));
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => watch.disconnect();
  }, []);
  return theme;
}
