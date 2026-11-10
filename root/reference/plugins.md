# Claude OS plugins

Paths are relative to the session folder (`root/` or `service/`). How to write each part is described by the `claude-os-plugins` skill.

A Claude OS plugin is a folder `<id>/`, a package on top of Claude with a version and an author. It has nothing to do with Claude's own plugins. Example plugins ship with the app in `../plugins/`, the user's plugins are in `../config/plugins/`; with the same id the user's copy wins, and an app update does not touch it. Create a new plugin in `../config/plugins/<id>/`, and do not edit `../plugins/`: to change a shipped plugin, copy it to `../config/plugins/` under the same id.

```
plugin.json                 the manifest
skills/<name>/SKILL.md      skills, their files may lie next to them
kit/files.json              a project kit: the template index, the templates next to it
```

```json
{
  "id": "same as the folder name",
  "name": "...", "description": "...", "version": "1.0.0", "author": "...",
  "descriptionRu": "optional", "features": ["a feature line"], "featuresRu": ["optional"],
  "icon": "lucide name or si:<slug>, optional",
  "dependencies": [
    { "id": "claude-md", "kind": "config", "file": "claude-md", "block": "file-in-the-plugin-folder.md", "level": "required", "title": "...", "titleRu": "...", "why": "...", "whyRu": "..." },
    { "id": "ripgrep", "kind": "package", "bin": "rg", "title": "...", "why": "...", "task": "what Claude should do" },
    { "id": "service", "kind": "service", "url": "http://127.0.0.1:4747/health", "level": "recommended", "title": "...", "why": "...", "task": "..." },
    { "id": "model", "kind": "download", "path": "{pluginData}/model.bin", "title": "...", "why": "...", "task": "..." }
  ],
  "contains": {
    "skills": ["name"],
    "hooks": [{ "event": "Stop", "matcher": "optional", "command": "bash \"{pluginDir}/run.sh\"" }],
    "mcp": { "name": { "command": "node", "args": ["{pluginDir}/server.js"] } },
    "ui": { "entry": "ui/index.js", "permissions": ["files.write", "files.reveal", "files.media"] },
    "kit": "kit"
  }
}
```

`{pluginDir}` is replaced with the absolute path to the plugin folder. Symlinks in the folder are forbidden. Example: `../plugins/rg-context`. The icon comes from the same libraries as for projects. The Russian fields are optional.

`dependencies` is what the plugin needs outside its folder. The server only looks at what is already there: `config` looks for a block in `~/.claude/CLAUDE.md`, `package` looks for a program in PATH, `download` looks for a file under `{claudeDir}/` or `{pluginData}/` (not in the plugin folder: that would change what was checked), `service` asks an address on this machine only, another one stays at the plugin dependency status "cannot check". `level` is `required` or `recommended`, and none of them stops the plugin from being enabled: it can be set up only after enabling. The enable dialog shows the dependencies and, on consent, opens a tab with a request to Claude, and the plugin's row keeps the "Set up" button of a plugin while something is not ready. A `config` block around the text from the file gets the marker lines `<!-- os-plugin:<id>:<dep>:start -->` and `:end`. If you got such a request, choose the place in the file yourself and move the block as it is, together with the markers: they show that the dependency is ready, and disabling removes exactly this block. Do not choose another file for the block: a block outside `~/.claude/CLAUDE.md` will not be found.

`ui` is interface code: ES modules in the `ui/` folder without a build. The entry point exports `activate(host)`, where `host` gives `React`, `ReactDOM`, `api`, `highlight(code, lang)`, `toast`, `toastError`, `lang()`. It returns what it needs: `fileIcon(entry)`, `fileMenu(entry, { tabId })`, `fileView` (a component in place of the file view), `commands`, `overlay`, `composerMark`, `dispose()`. `commands` is a list of `{ name, description?, argumentHint?, run(args, { tabId }) }`: a command is seen in the `/` menu and runs in the browser, nothing reaches Claude. It overrides a CLI command or a skill of the same name, but not `/focus`, `/btw` and the commands from `shared/commands.ts`. `overlay` is a component mounted once per window, separate windows included, above all screens: when there is nothing to show it returns `null`, and it loads heavy code itself through `import()` only when needed. `composerMark` is a small status mark in the footer of the input field next to the focus mark. A plugin whose `overlay` or `composerMark` crashes loses only those. The plugin makes outgoing requests from the browser, there is no separate permission for them: permissions open only the routes of the Claude OS server. Enabling and disabling work without reloading the window. `fileView` gets media files too, if the plugin returned `opensMedia(path)`. Tailwind classes from a plugin are not built: add styles yourself, take colors from the `--color-*` variables. Permissions open server routes while the plugin is enabled: `files.write` for `PUT /api/tabs/:id/file`, `files.reveal` for `POST /api/tabs/:id/reveal`, `files.media` for `GET /api/tabs/:id/media`: an image, a sound or a video with seeking, the type is detected from the bytes. If the folder is changed after enabling, the code and the permissions stop working until the user presses the "Update" button of a plugin in its row. Example: `../plugins/ide-plus`.

`kit` is a project kit: templates that Claude OS renders into one of the user's projects after the user approves a per-file plan there. The value is always `"kit"`, the folder with the templates, and `kit/files.json` lists them as `{ "path", "owner": "kit" | "seed", "stacks"?, "when"? }`; each path is relative, stays inside `kit/` and names a file that exists there, or the plugin does not validate. Template names are never loadable in this repo: `claude/...` becomes `.claude/...` and `CLAUDE.md.tpl` becomes `CLAUDE.md` when rendered, and `{{commands}}`, `{{gate}}`, `{{docsDir}}`, `{{testing}}`, `{{limits}}`, `{{testGlobs}}` are filled from what was detected in the project. Enabling a plugin with a kit installs nothing globally: nothing goes into Claude's settings or skills, it only shows the "Project kit…" actions on projects. The shipped kit is `../plugins/project-kit`; to change the templates, copy it to `../config/plugins/project-kit`, which wins by id. A changed kit folder stops being used until the user presses "Update", as with interface code.

A request to install, update or remove a project kit goes to a work tab of that project through `open_session`: `kit_plan` and `kit_apply` exist only there. The user can also start it with the "Project kit…" action of a project.

You only create the folder. The user enables the plugin on the Claude OS plugins screen (an item in the burger menu): the dialog shows what will be written where, and the confirmation approves the commands. Do not copy the plugin's components into Claude's settings yourself.
