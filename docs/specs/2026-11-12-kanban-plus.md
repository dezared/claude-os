# Kanban+ — spec

Status: implemented · Owner: the user · Date: 2026-11-12

## Intent
The built-in kanban leaves the core and becomes the shipped plugin `kanban-plus`, enabled by default: a full screen board app with a board switcher (spaces: all, general, each project) and a sprint switcher always on top, a backlog view with one list per sprint, a richer card (type, priority, assignee, labels, estimate, comments, activity log with sessions and their usage) and the same MCP tool names, so prompts keep working. The plugin system grows the two parts this needs: a server part and a screen.

## Evidence
- Core board today: `server/tools/kanban.ts` (617 lines, one `.md` per card in `vault/kanban`, `_board.json` with prefixes, counters, sprints), `server/chat/kanbanTools.ts` (10 tools), `web/src/screens/Kanban*.tsx`, the `kanban` view, topic, mention source, settings prefix rows, project page button, service task link.
- The plugin host (`server/tools/osPlugins.ts`, `web/src/lib/uiPlugins.tsx`) had skills, hooks, external MCP servers, kit and interface code that can only add to the files panel, commands, overlays and composer marks: no screen, no routes, no tools inside the `claude-os` server.
- The live board on 2026-11-12: 10 cards (OS, TASK, CSI prefixes), sprint S1 with card OS-5.

## Goals
1. `plugins/kanban-plus` ships enabled by default; an existing install gets it enabled once at start, and nothing in `vault/kanban` is lost: the files keep their format, new fields are new frontmatter keys, a copy of the folder goes to `data/backups` before the first write.
2. A plugin may carry a server part (`contains.server`, shipped plugins only): routes under `/api/plugins/<id>/`, tools inside the `claude-os` MCP server per session kind with their no-prompt lists, a system prompt rule, readable folders, a hook when a tab gets a session, and views `ui_action` may open.
3. A plugin's interface may add a screen (menu, command palette, project page, `ui_action open`) and an @ mention source.
4. The board app: board and sprint switchers always visible; Board and Backlog views; filters (search, type, priority, assignee, label) and keyboard shortcuts; drag with motion; card detail with Markdown description, type icon, priority, assignee (the user or an agent), labels, estimate, comments, activity log (created, moved, taken by which tab and session, usage of linked sessions); board settings with the id prefix.
5. MCP: `list_kanban_cards`, `add_kanban_card`, `move_kanban_card`, `take_kanban_card`, `update_kanban_card`, `list_kanban_sprints`, `add_kanban_sprint`, `update_kanban_sprint`, `remove_kanban_sprint` keep their names and permissions; new `get_kanban_card` (card with comments and log) and `add_kanban_comment`.
6. The core keeps no kanban code: screen, routes, tools, contract types, locale keys, prompt lines go.

## Non-goals
Epics with child cards, workflow editors, custom columns, time tracking beyond the estimate, notifications on comments.

## Anti-goals
A card or sprint lost or renamed by the move; prompts that name tools the session does not have; a button that does nothing when the plugin is off.

## Design
- Server part: `contains.server: "server/index.ts"` exports `activate(host)`; `host` gives paths, projects, tabs, session usage, language, `invalidate()` (the `osPluginData` topic), `audit`, and `tool`/`z` so the plugin imports no packages. Core: `server/tools/osPluginServers.ts` loads it for enabled shipped plugins and serves `/api/plugins/:id/*`; `rootMcp.ts`/`manager.ts`/`session.ts` add its tools, allowed lists, rule and folders. A server part changed on disk needs a server restart, as the core does.
- Interface: `UiContribution.screen` `{ id, title(), icon, component, perProject? }` and `mentions`; view `{ kind: 'plugin', id, arg? }`. The host lends `useApi`, `go`, core components (`Button`, `Dialog`, `Markdown`, `ProjectIcon`, `ProjectSelect`, `ContextArea`), icons, motion (`useFlip`, `Roll`), `createTab`, `openSession`, mentions.
- Data: card frontmatter gains `type` (task, bug, story, epic, chore), `labels`, `estimate`, `assignee: "user"`; sprints gain an optional `board` (a sprint without one shows on every board, as S1 does). Comments and the log are `.activity/<id>.jsonl` beside the cards (hidden from Obsidian and the watcher); a prefix change renames it with the card.
- Failure paths: plugin off: no tools, no rule, screen gone from menus, `ui_action open kanban` refused by the enum, planner decompose answers 409; a damaged `_board.json` is refused as before; a server part that throws on activate is logged and skipped; a stale `kanban` view in localStorage opens home.

## Verification
- `node --test plugins/kanban-plus/server/*.test.ts` and `server/tools/osPluginServers.test.ts`.
- `npm run gate`, `npm run build`, `e2e/kanban-plus.test.ts` (real server, plugin enabled through the API).

## Claude's calls
- Server parts load only from shipped plugins: in-process code from `config/plugins` would run with the server's rights.
- `assignee` is "the user" or the agent mark that `take_kanban_card` sets; one field in the interface.
- Usage of a card is the sum over its linked sessions: tokens always, dollars only on API billing.

## Revision 2026-11-13: boards replace sprints
The user's ruling: no boards per project and no sprints, only boards. Two global boards to start with, Epics (`epics`) and Tasks (`tasks`); a card that names no board goes onto the one of its type. More boards are added by Claude on request (`add_kanban_board`, `update_kanban_board`; `list_kanban_boards` replaces `list_kanban_sprints`); the user renames a board and removes an empty one that is not a default. A board may have a `project` (its new cards get it) and a `goal`. The project of a card is a filter. The app has a sidebar with the boards; the header holds the name, the Board and List views and the filters (search, project, type, assignee, label). On the first start of 2.0.0 the folder is copied to `data/backups/kanban-before-boards-*`, every sprint becomes a board with its id, name, goal and project, its cards get `board` in place of `sprint`, and nothing else in any file changes (`server/migrate.ts`). A sprint's state has no place on a board and stays only in the copy.
