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

You only create the folder. The person enables the plugin on the Claude OS plugins screen (burger menu), which shows what it will write where; that confirmation also approves its commands. A folder changed after enabling stops counting until they press the "Update" button of a plugin on its row.

## The manifest: plugin.json

```json
{
  "id": "same as the folder", "name": "...", "description": "...", "version": "1.0.0", "author": "...",
  "descriptionRu": "...", "features": ["..."], "featuresRu": ["..."], "icon": "lucide name or si:<slug>",
  "dependencies": [],
  "contains": { "skills": [], "hooks": [], "mcp": {}, "ui": {} }
}
```

Required: `id`, `name`, `description`, `author`, `version` (`1.2.3`), `contains` with at least one component. `icon` must exist in the libraries: a file of `node_modules/lucide-react/dist/esm/icons/` without the extension, or `si:` plus a file of `node_modules/simple-icons/icons/`. `{pluginDir}` in any command or path becomes the plugin's absolute folder.

## Components

- **skills**: `["name"]`, each `skills/<name>/SKILL.md` with `name` and `description` in its frontmatter; files beside it travel with it. Enabling copies it to `~/.claude/skills/<name>`. The description says when to use it: that is what makes Claude reach for it.
- **hooks**: `[{ "event": "Stop", "matcher": "optional", "command": "bash \"{pluginDir}/run.sh\"" }]`, Claude Code hook events, added to the person's Claude settings on enable and removed exactly on disable.
- **mcp**: `{ "server-name": { "command": "node", "args": ["{pluginDir}/server.js"] } }` or `{ "url": "..." }`.
- **ui**: `{ "entry": "ui/index.js", "permissions": [] }`, interface code, described below.

## dependencies

What the plugin needs outside its folder. The server only checks what is already there; enabling never installs anything, and no level blocks enabling:

- `config`: a block of text in `~/.claude/CLAUDE.md` (`"file": "claude-md", "block": "<file in the plugin>.md"`). It is placed between `<!-- os-plugin:<id>:<dep>:start -->` and `:end` lines; disabling removes exactly that block.
- `package`: a program on PATH (`"bin": "rg"`).
- `service`: a local address answering (`"url": "http://127.0.0.1:4747/health"`).
- `download`: a file under `{claudeDir}/` or `{pluginData}/`, never inside the plugin folder.

Each has `id`, `kind`, `title`, `why`, optional `level` (`required` or `recommended`), and `task`: what Claude should do to satisfy it, used when the person presses the "Set up" button of a plugin.

## Interface code

`ui/index.js` and its neighbours are plain ES modules, no build, no JSX. The entry exports `activate(host)`, where `host` has `React`, `ReactDOM`, `api`, `highlight(code, lang)`, `toast`, `toastError`, `lang()`. It returns what it adds:

- `fileIcon(entry)`, `fileMenu(entry, { tabId })`: the project files panel.
- `fileView` (a component instead of the file view) and `opensMedia(path)`: files it opens, media included.
- `commands`: `[{ name, description?, argumentHint?, run(args, { tabId }) }]`, slash commands that run in the browser; nothing reaches Claude.
- `overlay`: one component per window above every screen; returns `null` when it has nothing to show, and loads heavy code itself with `import()` only when needed.
- `composerMark`: a small state mark in the composer's foot.
- `dispose()`: called on disable.

A part that throws costs that part alone. Tailwind classes are not built for plugins: write your own CSS with the `--color-*` variables. Requests from the browser need no permission; `permissions` open the server's routes only: `files.write` (`PUT /api/tabs/:id/file`), `files.reveal` (`POST /api/tabs/:id/reveal`), `files.media` (`GET /api/tabs/:id/media`).

## Examples

Read the closest one before writing: `plugins/rg-context` (a skill, a script, a CLAUDE.md block, a package dependency), `plugins/ide-plus` (interface code with permissions), `plugins/agentation` (an overlay with a vendored library), plus `ls config/plugins/` for this person's own.

## Check before saying it is done

1. Validate the manifest the way the server will:
   `node --disable-warning=ExperimentalWarning -e "import('<root>/server/tools/osPlugins.ts').then(m => console.log(m.validateManifest('<id>', '<folder>').errors))"` must print `[]`.
2. Run what it ships: the skill's script, the hook command, the MCP server's start; render interface components with React from the root's `node_modules`.
3. Tell the person to enable it on the Claude OS plugins screen, and to press the "Update" button of a plugin on its row after any later change.

## Keeping this skill current

When the plugin format changes (`server/tools/osPlugins.ts`, `web/src/lib/uiPlugins.tsx`), update this file in `plugins/os-builder/` in developer mode.
