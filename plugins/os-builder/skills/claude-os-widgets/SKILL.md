---
name: claude-os-widgets
description: Use when asked to create, redesign or fix a widget on the Claude OS home screen, especially one that should look like the built-in panels (progress bars, statuses, numbers, a button) rather than plain text. Covers the data command, the React view in the widget's own file, the look, and how to check it. Not for Claude OS plugins: that is claude-os-plugins.
---

# Claude OS widgets

The Claude OS root is the folder holding `server/`, `web/` and `config/` (from the root session it is `..`). Paths below are relative to it.

A widget is an entry in `config/widgets.json`, and everything it runs belongs to it: no plugin is involved.

## Text or a view

Text is enough for a number or a line: `block`, `file`, `note` or a plain `command`, as `root/reference/widgets.md` of Claude OS describes. Anything with structure (progress, a status, a list, a button) is **data plus a view**:

1. **Data.** A `command` widget whose command prints one JSON object. The server runs it every `intervalSec` seconds, with no session running. Keep it fast (15 s limit), read-only and under 4 KB of output. Put the decisions in the script (`"phase": "ready"`), so the view only draws.
2. **View.** `config/widgets/<file>.js`, named by the entry as `"view": "<file>.js"` (a file name, never a path). Its `activate(host)` returns the React component that draws the value.
3. **Button (optional).** `"action": { "label", "cwd", "prompt", "readyWhen"? }`. The view gets it as `props.action` and `props.run()`, which opens a tab in `cwd` and sends `prompt`. Write the prompt so a fresh session understands it alone. `readyWhen` is the text the value must contain for the plain button of a widget without a view.

```json
{ "id": "deploys", "title": "Deploys", "type": "command", "command": "python3 /abs/deploys.py", "intervalSec": 60, "slot": "right",
  "view": "deploys.js", "icon": "rocket", "description": "The last deploys of the shop and their status, from `deploys.py`." }
```

Always fill `icon` and `description`. `icon` is a lucide name (a file of `node_modules/lucide-react/dist/esm/icons/` without the extension), drawn in the title bar; an unknown name gets a stand-in. `description` is Markdown, at most 500 characters, in the person's language: what the widget shows and where the data comes from. The frame draws it at the top of the widget, so the view does not repeat it.

The person approves the widget once, on the widget itself: the dialog shows the command and the view's code. The approval is held by the hash of each, so after any edit of the command or of the view file the widget waits for approval again. Say so whenever you change one.

## The view file

A plain ES module: no build, no JSX, no imports. React comes from `host`.

```js
export function activate(host) {
  const { React } = host;
  const h = React.createElement;
  return function Deploys({ value, error, run, action }) {
    let data = null;
    try { data = value ? JSON.parse(value) : null; } catch {}
    if (error || !data) return h('div', { className: 'dpl-error' }, error ? `Script: ${error}` : 'No data yet');
    return h('div', { className: 'dpl' }, h('style', null, CSS), /* ... */);
  };
}
```

Props: `title`, `value` (the command's stdout, a string), `error` (`exit 1`, `timeout`, or null), `updatedAt` (ms), `action`, `run`. `host` has `React`, `api`, `toast`, `toastError`, `lang()` and `openTab({ cwd, prompt, title })`. The view draws inside the widget frame: the title bar, padding, height and scrolling are the frame's.

## The look

Match the built-in panels; read one before drawing (`web/src/home/ProgressPanel.tsx` is the closest to most widgets):

- Text: rows `12.5px` in `var(--color-soft)`, captions `11px` in `var(--color-dim)`, secondary numbers `var(--color-muted)`; numbers with `font-variant-numeric: tabular-nums`. Sentence case, no labels in capitals.
- Colour only from the theme: `--color-fg`, `--color-soft`, `--color-muted`, `--color-dim`, `--color-line2`, `--color-accent`, `--color-ok`, `--color-warn`, `--color-bad`. A subject colour (a brand green, say) is fine for one role, such as the fill of bars, not for text.
- Progress: a 4px track `rgba(255,255,255,.08)`, `border-radius: 999px`, the fill animating its width.
- One element per widget may be large (the number the person looks for); everything else stays quiet.
- Motion only for something happening now (a run in progress), and off under `prefers-reduced-motion`.
- Prefix every CSS class with a short widget prefix (`dpl-`): the styles are global.
- Every state is drawn: no data yet, a script error, each phase the script prints. An error says what failed and where.
- A countdown or "ago" ticks on the client from a timestamp in the data, not by running the command more often.

Live examples on this machine: `ls config/widgets/` and the entries with a `view` in `config/widgets.json`. Read one before writing a new one and keep the family resemblance.

## Check before saying it is done

1. Run the command and parse its output as JSON.
2. Render the view in every phase with React from the Claude OS `node_modules` (`react-dom/server` `renderToStaticMarkup`, data built for each phase) and read the text it draws. Take a screenshot where a browser works.
3. Tell the person what is theirs: approve the widget on the home screen (the pending-approval mark of a widget on it).

## Keeping this skill current

When a widget brings a pattern worth repeating (a new kind of chart, a better state), add it to "The look". This file ships with Claude OS: change it in `plugins/os-builder/` in developer mode.
