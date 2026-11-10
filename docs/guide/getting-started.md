# Getting started

## Requirements

| What | Version | Check |
| --- | --- | --- |
| Node.js | 22.18 or newer | `node -v` |
| Claude Code | a current version, logged in | `claude --version`, then `claude` once to log in |
| git | any recent | `git --version` |

On Windows, install all three **inside WSL2** (Ubuntu or another distribution), not on the Windows side. Claude OS runs where Claude Code runs.

Claude Code itself: see [the official setup guide](https://code.claude.com/docs/en/setup). Claude OS uses its login or API key as is; see [Claude OS and your Claude account](claude-account.md).

## Install and run

```sh
git clone https://github.com/DezareD/claude-os.git
cd claude-os
npm install
npm run build      # builds the web interface into dist/web
npm start          # starts the server
```

The server prints:

```
claude-os ready http://127.0.0.1:47821/auth?token=...
```

Open that link once. It sets a cookie for this browser; after that, `http://127.0.0.1:47821` opens the panel. The token is kept in `data/token`.

The server keeps running after you close the browser: sessions live in the server process, so a long task finishes even with no window open.

## First run

The home screen offers a setup:

1. **Checks**, with no prompt sent: Claude Code found and logged in, Node and git versions, your plan's limits.
2. **A short talk with Claude**: your name, the language for replies (it is also the interface language), the folder for new projects and how often Claude should ask before acting.
3. **Done.** Your projects appear on the map from Claude Code's own journals; nothing to import.

You can leave the setup and continue later from the menu, under "Run setup again".

## The desktop app (Windows)

A Windows window for the panel, with a tray icon and notifications. It is optional; the browser works the same.

Build it from WSL, inside the repository:

```sh
node desktop/build.mjs
```

This downloads the Electron runtime and writes `desktop/build/ClaudeOS/ClaudeOS.exe`. Start that file from Windows (pin it to the taskbar if you like). On start it asks WSL to run the server if it is not running yet and opens the panel; closing the window leaves the server and its sessions running. "Stop everything and quit" in the tray stops both.

## Settings

Most settings are in the interface under **Settings**: language, profile, widgets, IDEs and programs, projects, Claude (plan, limits, Claude Code version and a `claude doctor` check), notes and Obsidian, voice input. Model and effort can be set per project and per tab.

Environment variables, read when the server starts:

| Variable | Default | What it does |
| --- | --- | --- |
| `CLAUDE_OS_PORT` | `47821` | Port on `127.0.0.1` |
| `CLAUDE_OS_CONFIG` | `./config` | Settings, profile, widgets, actions, your plugins |
| `CLAUDE_OS_DATA` | `./data` | App state, session index, documents, planner, uploads, backups |
| `CLAUDE_OS_VAULT` | `./vault` | Memory notes |
| `CLAUDE_OS_CLAUDE_BIN` | `claude` on `PATH` | Path to the Claude Code binary |
| `CLAUDE_OS_NEW_PROJECTS` | `~/Projects` | Where new projects go when the profile does not say |
| `ANTHROPIC_API_KEY` | not set | Passed to Claude Code like any environment variable, if you use API billing |

## Updating

```sh
git pull
npm install
npm run build
```

Then restart the server: the panel shows a banner when the code on disk is newer than the running server, and the desktop app restarts an idle server by itself. Your `config/`, `data/` and `vault/` are not tracked by git, so an update never touches them. New default settings are added once; a setting you changed is never overwritten.

## Uninstalling

Stop the server, then delete the folder. Claude OS writes outside its folder only where you asked it to: project memory you moved into the vault (Claude Code's settings then point at the vault), skills, MCP servers or hooks you created through it, and files in your own projects.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| The page answers `401` | Open the full `/auth?token=...` link from the server output, not just the address |
| "Claude Code not found" in the setup | Check `claude --version` in the same shell you run `npm start` from, or set `CLAUDE_OS_CLAUDE_BIN` |
| "Not logged in" | Run `claude` once in a terminal and log in, then re-run the checks |
| The home map is black (WSL) | The browser cannot use WebGL. Update your GPU driver or use a Chromium-based browser |
| Port already in use | Another Claude OS is running, or set `CLAUDE_OS_PORT` |
| A native module fails on `npm install` | Run `npm rebuild <name>` once and include the error in an issue if it persists |
| Anything else | The server log is the terminal where you ran `npm start`, or `data/server.log` for the desktop app. Please [open an issue](https://github.com/DezareD/claude-os/issues) with it |
