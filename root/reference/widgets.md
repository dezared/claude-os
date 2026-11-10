# Claude OS widgets and settings

Paths are relative to the session folder (`root/` or `service/`).

Interface design, for all of Claude OS: only what is needed all the time stays on the surface; the rest goes into the right-click menu and the burger menu. A new button on the screen needs a reason, a new menu item does not.

## Widgets

Everything on the home screen except the root chat and the map buttons is a widget in a slot; the chat moved into a separate window disappears from the home screen. Slots: `left`, `bottom-left` share the left column, `right`, `bottom-right` the right one, `top` stands above the chat in the center; the center is free for the map. The user creates a block themselves (right click in the center of the map, the "Create widget" menu item, a click on a slot) and describes its content to you. The content is not set up by hand, so turn the description into an entry of the `../config/widgets.json` array; the server picks the file up by itself. Formats:

- `{ "id": "...", "title": "...", "type": "block", "content": "...", "slot": "right" }`: text in Markdown. A new block comes without `content`.
- `{ "id": "...", "title": "...", "type": "command", "command": "...", "intervalSec": 300, "slot": "right" }`: the output of a command. It runs only after the user approves it in the interface.
- `{ "id": "...", "title": "...", "type": "file", "path": "/abs/path", "pointer": "/json/pointer", "slot": "right" }`: a value from a file, `pointer` is optional.
- `{ "id": "...", "title": "...", "type": "note", "noteId": "...", "slot": "right" }`: a vault note.

Always fill two more fields on every entry you write: `icon`, a lucide name (a file of `../node_modules/lucide-react/dist/esm/icons/` without the extension, `gauge`), shown in the widget's title; and `description`, what the widget shows and where the data comes from, one or two sentences of Markdown in the user's language, at most 500 characters, shown at the top of the widget. The "Copy as .md" menu item of a widget gives the user a Markdown file with the whole widget; another user pastes it into "Create from .md", and you recreate the widget from it as it is.

A widget with structure (progress, a status, a list, a button) is made not as text but as data and a view: the command prints JSON, and the widget's own React module `../config/widgets/<file>.js`, named in the entry as `"view": "<file>.js"`, draws it. Plugins have nothing to do with it. The command and the view are approved together on the widget itself, by hash: a change to either of them puts the widget up for approval again, tell the user so. How to build such a widget and how it should look is described by the `claude-os-widgets` skill; take it before writing the widget.

An optional `action` on any type is a button: `{ "label": "Continue", "cwd": "/abs/dir", "prompt": "...", "readyWhen": "..." }`. A press opens a tab in `cwd` and sends `prompt` to it, so write it so that it is clear without this conversation. With `readyWhen` the button of the text view is active only while the widget's value contains this text; a widget's own view gets `action` and `run()` and draws the button itself.

An optional `height` is the height of the block in pixels, at least 64; without it the height follows the content. The slot sets the width, there are no coordinates. Widgets in a column follow one another and do not overlap: an expanded one pushes its neighbours, panels without a set height give up their height until they reach their minimum, and after that the column scrolls. The user drags widgets with the mouse: when editing an entry keep `id`, `slot` and `height`, choose the simplest type that fits and change it if needed. Asked to move a block: change its `slot`. Old entries with `box` (`{ "x", "y", "w", "h" }`) go to the nearest slot and lose `box` on the first move; do not write new ones with `box`. An entry without `slot` and `box` is not shown on screen.

## Home layout

The layout is in `../config/settings.json`, key `home`: `{ "slots": { "left": ["projects"], "right": ["tokens"], "bottom-left": ["stats"], "top": ["notes"] }, "hidden": ["tokens"], "collapsed": ["projects"], "heights": { "projects": 400 }, "removed": ["stats"] }`. `slots` sets the order, `collapsed` the collapsed widgets (only the user collapses them; do not collapse anything yourself unless they ask), `heights` the heights of the built-in widgets.

## Built-in widgets

Four widgets come with the system: `projects`, `tokens`, `stats`, `notes`. They live by the same rules as blocks: they move, collapse, get removed and come back; they are an example of how widgets can be written. They have no entry in `widgets.json`, so they are managed by editing `home`. The view of such a widget is core code (`../web/src/home/ProjectsPanel.tsx`, `TokensPanel.tsx`, `BottomStrip.tsx`, `UniverseHud.tsx`), and the "Change with Claude" menu item on it is a change to the core: hand it to a tab of the Claude OS project, as the developer mode of the root `CLAUDE.md` says. For a user setting, suggest a block in a neighbouring slot.

The fifth built-in widget, `progress` (the work progress widget, `../web/src/home/ProgressPanel.tsx`, in the `right` slot by default), lives by the same rules, but until some tab has reported through `report_progress` it is not on screen, and its height always follows its rows (`heights` does not apply to it). A row is the name of a tab, a bar, a step and a status; a click leads to the tab, a right click removes the row from the list until the next report. The status is checked against the tab: a permission request or a question is the waiting status, a running turn is the working status, a turn that failed or was cut by a restart is the failed status. The turn has ended: `done` or 100% give the done status, everything else the waiting status. The percent does not go back, except with `restart: true` and a new turn after finished work. Progress is kept in the `tab_progress` table and goes away with the tab or with a new conversation in it. The `report_progress` description gives the labels of these statuses.

## Trash

The trash is `home.hidden`. A removed widget goes there, its entry and its place in `slots` are kept, a block's command does not run. The list is in the Widgets section of Settings: from there the user brings a widget back or deletes it for good. Asked to restore from the trash: remove the `id` from `hidden`. Deleting for good removes a block's entry from `widgets.json` and moves a built-in widget to `home.removed`; such a widget can be brought back by removing its `id` from `removed`. A block deleted for good cannot be restored from anywhere, it will have to be described again.

## Other settings

- The IDEs found are in `../config/settings.json`, field `ides.list`. An entry you added runs only after it is approved in the settings.
- A note on an MCP server on the Tools screen: `../config/settings.json`, key `mcpNotes`, an object "server name → short text".
- The action buttons of tabs (`../config/actions.json`) are described by the `claude-os-actions` skill.
