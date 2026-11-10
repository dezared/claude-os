# Touchpoints

A concept that lives in several places must be changed in all of them. This is the map. "Typed" rows are enforced by `tsc` once the registry task is done; "check" rows are enforced by `npm run check:touchpoints` (registry data in `touchpoints.json`); "test" rows by a named test.

| Concept | Where it lives (checked 2026-11-09) | Mechanism |
| --- | --- | --- |
| `UiCommand` actions and `UiView` | `UiCommand`, `UI_ACTION_SET`, `UiView`, `UI_VIEW_SET` in `shared/contract.ts`; `UI_ACTIONS`/`UI_VIEWS` and `uiCommand` in `server/chat/rootMcp.ts`; `runUiCommand` in `web/src/lib/uiCommands.ts` | typed: the sets are `Record<..., true>`, so a missing member fails `tsc`; `rootMcp.ts` derives its `z.enum` lists from them; the `runUiCommand` switch ends in `assertNever` |
| `KanbanColumn` | `KANBAN_COLUMNS` in `contract.ts` (the type derives from it, board order); `server/tools/kanban.ts`, `KANBAN_COLUMN` in `rootMcp.ts` and `COLUMNS` in `web/src/screens/KanbanBoard.tsx` import it; `KANBAN_LABELS` in `server/chat/profile.ts` (the `move_kanban_card` description) | typed: the board labels are `satisfies Record<KanbanColumn, Key>`, `KANBAN_LABELS` is a `Record<KanbanColumn, ...>` |
| `HomeSlot` | `HOME_SLOTS` in `contract.ts` (the type derives from it); `server/tools/settings.ts` and `widgets.ts` import it; `web/src/home/slots.ts` re-exports it as `SLOTS` | typed: one const |
| ru/en catalog keys | `web/src/lib/locales/ru.ts`, `en.ts` | typed: `en.ts` is `Omit<Record<keyof ru, string>, few/many>`; nothing to add |
| Server error codes and `errors.*` keys | `server/chat/messages.test.ts` | test, exists |
| MCP tools and `allowedTools` per session kind | `server/chat/manager.ts:290-291`, `rootMcp.ts:15-38` | test `server/chat/mcpTools.test.ts`: allowed is a subset of registered, the rest is an explicit `PROMPTED_TOOLS` list |
| Project kit MCP tools (`kit_plan`, `kit_apply`) | `kitTools` in `server/chat/kitTools.ts`, added by `createPlannerMcp` in `rootMcp.ts` (work tabs; the first-run setup tab swaps that server for `createSetupMcp` and has no kit tools); `kit_plan` in the work `allowedTools` in `server/chat/manager.ts`; `kit_apply` in `PROMPTED_TOOLS.work`; `KIT_APPLY_TOOL` in `web/src/lib/projectKit.ts` routes its permission card to `KitPlanCard` in `web/src/work/RequestCards.tsx`; the flow in `root/microtasks/project-kit.md` | test `server/chat/mcpTools.test.ts` (`kit_apply` is never allowed); `server/chat/kitTools.test.ts` (an apply the card did not approve is refused) |
| Microtasks | `MICROTASK_ROUTES` in `server/tools/microtasks.ts:10`, files in `root/microtasks/*.md` | check: a file per key and a key per file |
| `BuiltinId` (`web/src/home/slots.ts:5`), `HomeSlot`, widget types (`server/tools/widgets.ts:27`) | described by hand in `root/reference/widgets.md` | check: each member is named there (`builtin-widgets`, `home-slots`, `widget-types`) |
| `OS_PLUGIN_PERMISSIONS` | `contract.ts:947`, described in `root/reference/plugins.md` | check: each member is named there (`plugin-permissions`) |
| `OS_PLUGIN_COMPONENTS` (the keys of a plugin's `contains`) | `contract.ts`; `readContains` in `server/tools/osPluginManifest.ts` rejects any other key; described in `root/reference/plugins.md`; `KIND` in `web/src/screens/OsPlugins.tsx` | check: each member is named there (`plugin-components`); typed: `KIND` is a `Record` of `OsPluginChange['kind']` |
| `PROMPT_LABELS` | `server/chat/profile.ts` | typed keys (`satisfies Record<string, keyof typeof en>`); budget test: each name occurs in a prompt source |

Line numbers drift; search by the name.

## Recipes

**A new endpoint.** A type in `shared/contract.ts` (in its `// ---------- Section ----------`), one line in the route list near the end (`//   METHOD /api/path  body -> Result`), the handler in the server module (a factory function; the route stays thin), the call from the web with `api<Type>()` or `useApi<Type>(path, [topic])`.

**Live data.** The server changes something, then `ctx.invalidate('topic')`; every `useApi` subscribed to that topic refetches. A new topic goes into the `Topic` union in `contract.ts`.

**A new `ui_action`.** A variant of `UiCommand` and its key in `UI_ACTION_SET` in `contract.ts` (a new view: `UiView` and `UI_VIEW_SET`), its parsing in `uiCommand` in `rootMcp.ts`, a case in `runUiCommand` in `web/src/lib/uiCommands.ts`; `tsc` names the set and the switch until both are done. The server sends the command over the WebSocket as `{ t: 'ui', tabId, command }`. No separate interface tools; persistent data does not reach the interface this way (REST shows it, its own tools change it).

**A new default setting or shipped record.** `defaults/`; see `architecture.md`.

## When you add a concept that lives in more than one place

Prefer a shared typed const that every place imports. If types cannot reach it (a prompt, a markdown file, a file-per-key folder), add an entry to `touchpoints.json` and a row here.
