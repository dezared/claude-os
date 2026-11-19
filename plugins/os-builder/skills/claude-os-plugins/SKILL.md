---
name: claude-os-plugins
description: Use when asked to create, change or package a Claude OS plugin: a versioned bundle of skills, Claude Code hooks, MCP servers and interface code that the person enables on the Claude OS plugins screen. Covers the manifest, each component, dependencies, the interface API and permissions, and how to validate it. Not for home screen widgets: those are claude-os-widgets, with no plugin involved.
---

# Claude OS plugins

The Claude OS root is the folder holding `server/`, `web/`, `config/` and `plugins/` (from the root session it is `..`). Paths below are relative to it. A Claude OS plugin has nothing to do with Claude Code's own plugins.

## When it is a plugin

A plugin is for something that extends Claude or the Claude OS interface as a whole and is enabled or disabled as one unit: a skill with its script, a hook, an MCP server, an editor in the files panel, a slash command that runs in the browser. A widget on the home screen is not a plugin: its data and view belong to its own entry in `config/widgets.json`.

## Where it goes

- A new plugin: `config/plugins/<id>/`. The folder name is the id.
- `plugins/<id>/` is what ships with the app: never edit it outside developer mode. To change a shipped plugin for one person, copy it to `config/plugins/<id>/` under the same id; that copy wins.
- No symlinks anywhere inside the folder.

You only create the folder. The person enables the plugin on the Claude OS plugins screen (burger menu), which shows what it will write where; that confirmation also approves its commands. A folder changed after enabling keeps running its new code with the permissions its manifest names; changed skills, hooks and servers come in when they press the "Update" button of a plugin on its row.

## The manifest: plugin.json

```json
{
  "id": "same as the folder", "name": "...", "description": "...", "version": "1.0.0", "author": "...",
  "descriptionRu": "...", "features": ["..."], "featuresRu": ["..."], "icon": "lucide name or si:<slug>", "enabledByDefault": false,
  "dependencies": [],
  "contains": { "skills": [], "hooks": [], "mcp": {}, "ui": {}, "server": "server/index.ts" }
}
```

Required: `id`, `name`, `description`, `author`, `version` (`1.2.3`), `contains` with at least one component. `icon` must exist in the libraries: a file of `node_modules/lucide-react/dist/esm/icons/` without the extension, or `si:` plus a file of `node_modules/simple-icons/icons/`. `{pluginDir}` in any command or path becomes the plugin's absolute folder. `{pluginData}` in a hook or an MCP config becomes the plugin's data folder (`data/os-plugin-data/<id>`). `enabledByDefault: true` makes the first-run setup enable the plugin once; it only matters for a plugin that ships with the app.

## Components

- **skills**: `["name"]`, each `skills/<name>/SKILL.md` with `name` and `description` in its frontmatter; files beside it travel with it. Enabling copies it to `~/.claude/skills/<name>`. The description says when to use it: that is what makes Claude reach for it.
- **hooks**: `[{ "event": "Stop", "matcher": "optional", "command": "bash \"{pluginDir}/run.sh\"" }]`, Claude Code hook events, added to the person's Claude settings on enable and removed exactly on disable.
- **mcp**: `{ "server-name": { "command": "node", "args": ["{pluginDir}/server.js"] } }` or `{ "url": "..." }`.
- **ui**: `{ "entry": "ui/index.js", "permissions": [] }`, interface code, described below.
- **server**: `"server/index.ts"`, code the Claude OS server runs in its own process, so only a plugin shipped in `plugins/` may have one; a copy in `config/plugins` does not validate. It exports `activate(host)` (`host`: paths, projects, tabs, sessions with their cost, `tool` and `z` for tools, `invalidate()` of the `osPluginData` topic, `statusChanged()`, `audit`) and returns `routes` (under `/api/plugins/<id>/`; a path ending in `/*` takes the rest as `params['*']`, a handler returning a `Response` has it sent as is, streamed), `tools(who)` inside the `claude-os` MCP server per session kind (`work`, `root`, `serviceTask`) with `allowed`, `rules` for the system prompt, `dirs` sessions may read, `views` that `ui_action` may open, `sessionStarted(tab, session)`, `status()` of a process it keeps running (shown on the plugin's row) and `dispose()`. A change needs a Claude OS restart. See `plugins/kanban-plus`; `plugins/agentation` supervises a server process.

## dependencies

What the plugin needs outside its folder. The server only checks what is already there; enabling never installs anything, and no level blocks enabling:

- `config`: a block of text in `~/.claude/CLAUDE.md` (`"file": "claude-md", "block": "<file in the plugin>.md"`). It is placed between `<!-- os-plugin:<id>:<dep>:start -->` and `:end` lines; disabling removes exactly that block.
- `package`: a program on PATH (`"bin": "rg"`).
- `service`: a local address answering (`"url": "http://127.0.0.1:4747/health"`).
- `download`: a file under `{claudeDir}/` or `{pluginData}/`, never inside the plugin folder.

Each has `id`, `kind`, `title`, `why`, optional `level` (`required` or `recommended`), and `task`: what Claude should do to satisfy it, used when the person presses the "Set up" button of a plugin.

## Interface code

`ui/index.js` and its neighbours are plain ES modules, no build, no JSX. The entry exports `activate(host)`, where `host` has `React`, `ReactDOM`, `api`, `useApi(path, topics)`, `highlight(code, lang)`, `toast`, `toastError`, `lang()`, `openChat({ cwd, title, prompt })`, `HtmlFrame({ html, title, className })` (sandboxed HTML, no scripts) `motion` (`Pop`, `Fold`, `Roll`, `useFlip`, `usePresence`), `setCached`, `refresh(topics)`, `go(view)`, the core's components in `ui` (`Button`, `IconButton`, `Input`, `Textarea`, `Field`, `Checkbox`, `Dialog`, `Select`, `Segmented`, `Markdown`, `ProjectIcon`, `ProjectSelect`, `ContextArea`, `Empty`, `ErrorState`, `Skeleton`), `icons` (a set of lucide icons), `openMenu(event, items)`, `claudeItems`, `tabs` (`createTab`, `openSession`), `mention`, `useShowCost`, `useProjectColors` and `format`. It returns what it adds:

- `fileIcon(entry)`, `fileMenu(entry, { tabId })`: the project files panel.
- `fileView` (a component instead of the file view) and `opensMedia(path)`: files it opens, media included.
- `commands`: `[{ name, description?, argumentHint?, run(args, { tabId }) }]`, slash commands that run in the browser; nothing reaches Claude.
- `overlay`: one component per window above every screen; returns `null` when it has nothing to show, and loads heavy code itself with `import()` only when needed. On disable it stays 160 ms more with the prop `leaving` set, for its exit.
- `composerMark`: a small state mark in the composer's foot.
- `screens`: `[{ id, title, icon, component, perProject? }]`, each a burger menu and command palette item that opens the component as a full screen; with `perProject` also a button on each project page, and the component gets `arg`, the project key. A `views` entry of the server part with the same id lets `ui_action` open it.
- `mentions`: `{ id, label(), icon, search(query, project) }`, a section of the composer's `@` menu.
- `dispose()`: called on disable.

A part that throws costs that part alone. Tailwind classes are not built for plugins: write your own CSS with the `--color-*` variables. They change with the light theme (`data-theme='light'` on `<html>`), so a fixed white or black tint breaks there. Requests from the browser need no permission; `permissions` open the server's routes only: `files.write` (`PUT /api/tabs/:id/file`), `files.reveal` (`POST /api/tabs/:id/reveal`), `files.media` (`GET /api/tabs/:id/media` for an image, sound, video or PDF; `GET /api/tabs/:id/sheet` for an xlsx or ods as text cells), `data` (`GET|PUT|DELETE /api/os-plugins/<id>/data/<path>`: JSON in the plugin's own data folder; changes refresh `useApi` on the topic `osPluginData`; `POST /api/os-plugins/<id>/workspace` gives `~/<id>`, or with `{ folder }` a folder inside it, as a cwd for its Claude tabs; shipped plugins only).

## Examples

Read the closest one before writing: `plugins/rg-context` (a skill, a script, a CLAUDE.md block, a package dependency), `plugins/ide-plus` (interface code with permissions), `plugins/agentation` (an overlay with a vendored library), `plugins/learn` (a screen, its data, an MCP server and a skill), plus `ls config/plugins/` for this person's own.

## Check before saying it is done

1. Validate the manifest the way the server will:
   `node --disable-warning=ExperimentalWarning -e "import('<root>/server/tools/osPlugins.ts').then(m => console.log(m.validateManifest('<id>', '<folder>').errors))"` must print `[]`.
2. Run what it ships: the skill's script, the hook command, the MCP server's start; render interface components with React from the root's `node_modules`.
3. Tell the person to enable it on the Claude OS plugins screen, and to press the "Update" button of a plugin on its row after any later change.

## Keeping this skill current

When the plugin format changes (`server/tools/osPlugins.ts`, `web/src/lib/uiPlugins.tsx`), update this file in `plugins/os-builder/` in developer mode.
