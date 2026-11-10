# Architecture: code map and change order

The repository root holds `server/`, `web/`, `shared/`. Paths below are relative to it. Check a detail against the code when it matters and fix this file when the code has moved on.

## Before the first edit

1. `git status` and `git log --oneline -5`. Other sessions may be editing and committing at the same time: never revert or reformat a change that is not yours, and re-read a file right before editing it.
2. Decide the level. Core is `server/`, `web/`, `shared/`, `e2e/`, `desktop/`, `scripts/`, `root/`, `service/`, `defaults/`, `plugins/`, `docs/`. User data is `config/`, `data/`, `vault/`: never edit it for a core change, never commit it, never solve a core problem by editing the user's config. Kanban cards of the Claude OS project carry the level as `level`: `user` (config) or `root` (core).
3. Small change: in place. Large change: its own task branch and worktree.

## Map

| Folder | What it is |
| --- | --- |
| `server/` | Node 22 server in TypeScript, run directly (`node server/index.ts`, type stripping, no build). Fastify, WebSocket, `node:sqlite`. |
| `web/src/` | React 19 + Vite + Tailwind 4 interface; `npm run build` writes `dist/web`. |
| `shared/` | Types and constants both sides import: `contract.ts` (API types, the route list, `Topic`, `UiCommand`), `commands.ts`, `documents.ts`, `plannerItems.ts`, `projectTree.ts`. |
| `e2e/` | Playwright tests against fixture servers that serve `dist/web`. |
| `desktop/` | Electron shell: `main.cjs` (window), `preload.cjs`, `serve.mjs` (starts or restarts the server in WSL), `build.mjs`. |
| `root/` | The root session's folder: `CLAUDE.md` (its system prompt), `NOTE_RULES.md`, `microtasks/*.md` (the "Ask Claude" templates), `document-knowledge/`. |
| `service/` | The hidden service session's folder (its own `CLAUDE.md`). |
| `setup/` | The setup session's folder. |
| `defaults/` | Shipped defaults copied into `config/` by `server/defaults.ts` `bootstrapConfig`. |
| `plugins/` | Shipped Claude OS plugins; a user copy in `config/plugins/<id>` wins. |
| `scripts/` | `gate.ts` (the one gate), `check-lint-ratchet.ts`, `check-touchpoints.ts`, `check-shippable.ts`, `memory-token-probe.ts` (MEMORY.md token cost), each with its test; `devkit.test.ts` and `hooks.test.ts` cover `.claude/`. |
| `docs/` | `specs/`, `plans/` (dated design docs), `manifest/`, `rules/`, `solutions/`; `handoff/` is git-ignored. |

### server/

- `index.ts`: bootstraps config, opens the DB, builds `ctx`, adds auth (`security.ts`), `/health`, `/api/app/status|restart|shutdown`, the error handler (`{ error, code }` with `err.statusCode`), registers modules in this order: journal, memory, tools, voice, chat; serves `dist/web`; opens `/ws`.
- `context.ts` `Ctx`: `paths` (repo, data, config, plugins, root, service, claudeDir, claudeBin, vault, ...), `app` (Fastify), `db`, `journal`, `memory`, `chat?`, `settings?` (later modules may be absent in another module's tests: `ctx.chat?.`), `bus` (sessions-changed, rate-limit, turn-finished, ...), `broadcast(msg)`, `invalidate(...topics)` (debounced, tells the UI to refetch), `audit(action, target, diff?)`, `setBusy`, `restart?()`.
- `tools/index.ts` `registerTools`: wires the `create*(ctx, deps)` factories (skills, mcp, actions, widgets, settings, account, commands, claudeMd, setup, admin, osPlugins, projectIcons) and declares most `/api` routes inline; kanban, planner, documents, agents, projectFiles, admin, osPlugins, projectIcons declare their own. It also watches `config/` (chokidar, depth 1).
- `chat/`: tabs and chat routes (`index.ts`), `manager.ts` (tabs, `create`, `openWithPrompt`, restart continuation), `session.ts` (one Claude Agent SDK session), `rootMcp.ts` (the tools sessions get: `ui_action`, `report_progress`, planner, kanban, documents; the root session also has open_session, service_task, restart_claude_os, ...), `serviceTasks.ts`, `profile.ts`.
- `memory/`: the vault; `util.ts` has `httpError`, `sha256`, `safely`, `backupFile`; `testkit.ts` is the test kit.
- `journal/`: indexes Claude Code session journals into SQLite.
- `tools/approvals.ts`: `isApproved(text)` / `approve(text, target)` by sha256 in `data/approved-commands.json`. Commands of actions, widgets and widget views run only when approved; `data/` is out of reach of sessions, so editing config never approves anything. An unapproved run answers 409 with what to approve.

### web/src/

- `home/` (home screen, map, widgets `Widgets.tsx`, `ActionMenu.tsx` with `MenuItem`), `work/` (a work tab: `WorkView`, `Composer`, `Transcript`, `Actions.tsx`, git panel, voice), `screens/` (settings, tools, sessions, kanban, plugins, admin), `components/` (`ui/` Button, Dialog, Input, Select...; `TitleBar`, `ContextMenu` with `claudeItems`), `lib/`, `popout/`, `notes/` (planner), `documents/`.
- `lib/api.ts`: `api<T>(path, { method, body })` (throws `ApiError`), `useApi<T>(path | null, topics)`, `setCached` for optimistic updates, `invalidateTopics`.
- `lib/ws.ts`: the socket; routes `invalidate` and `ui` messages. `lib/store.ts`: `useApp` (`go(view)`, toasts), `toast`, `toastError`. `lib/tabs.ts`: `createTab`, `openSession`, `openTabWithPrompt`, ...
- `lib/i18n.ts` with `lib/locales/ru.ts` and `en.ts`: `t(key, params)`. Keys come from `ru.ts`; `en.ts` is typed against them, so a key missing in English fails `typecheck`. Add every new string to both.
- `lib/uiPlugins.tsx`: the host for Claude OS plugins' interface code. `lib/uiCommands.ts`: `runUiCommand`.
- Styling: Tailwind classes with the theme of `styles.css` (`bg-card`, `text-muted`, `text-soft`, `text-dim`, `border-line2`, `text-accent`, `text-ok|warn|bad`); icons from `lucide-react`.

## How a change goes through

Concept-by-concept recipes (new endpoint, new `ui_action`, every consumer to touch) are in `touchpoints.md`. The order:

1. **Contract first.** Types, routes and `Topic` members go into `shared/contract.ts`.
2. **Server.** A factory function holds the logic, the route stays thin. A user-visible write (config, settings, anything the user owns): write, `ctx.audit('area.verb', target, diff)`, `ctx.invalidate(topic)`. Readers of config tolerate a missing file and missing keys.
3. **Web.** `api<T>()` or `useApi<T>(path, [topic])`; strings in both catalogs.
4. **Defaults.** A new default setting or shipped record goes into `defaults/`; `bootstrapConfig` adds missing settings keys and appends new shipped widgets and actions once (`config/.shipped-seen.json`), never overwriting the user's.
5. **Prompts** (`root/CLAUDE.md`, `service/CLAUDE.md`, `root/microtasks/`, tool descriptions in `rootMcp.ts`): say "the user", never the owner's name; `profileBlock` adds the name and language at run time.

## Making it live

- Web only: `npm run build`, then a window reload. The server serves `dist/web` from disk, no restart.
- Server or `shared/`: a server restart. The root session has `restart_claude_os`; a work tab cannot restart the server: ask the user or the root session. The app shows a stale-code banner, and the desktop window restarts an idle stale server when it opens (`desktop/serve.mjs`).
- Closing the window never stops the server or the sessions: they live in the server process.
