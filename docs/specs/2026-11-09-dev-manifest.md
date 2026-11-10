# The manifest applied to developing Claude OS — design

Status: draft · Owner: the owner · Date: 2026-11-09 · Project 2 of 4 (roadmap in `2026-11-09-core-user-split.md`)

## Intent

Developing Claude OS should run on the manifest (`docs/manifest/claude-code-os-manifest.html`, sections 4–8, 10–12, 18): a small always-loaded context, a deterministic loop (hooks, one gate, lint limits, touchpoints), three test contours, and a thin process layer. The product prompts Claude OS loads into its own sessions are trimmed in the same project, because lean context is the owner's top priority. Linux (WSL) first; every script and hook is Node, so macOS and Windows need no extra code.

## Evidence (collected 2026-11-09 on Claude Code 2.1.319, SDK 0.3.318, Node 22.23, 4 cores)

- **Parent loading, probed live** (`claude -p`, haiku, no tools, a temp git repo with a subfolder): a session in `repo/sub/` loads `repo/CLAUDE.md`, `repo/.claude/rules/*.md`, `repo/.claude/skills/*` and `repo/.claude/agents/*`. It does **not** load hooks from `repo/.claude/settings.json` (only the cwd's own `.claude/settings.json` hooks fired). A nested worktree (`repo/.worktrees/w1`) does not load the main checkout's `CLAUDE.md`.
- **Exclusion works, probed live:** `--settings '{"claudeMdExcludes":["<repo>/CLAUDE.md","<repo>/.claude/rules/**"]}'` removed both; `skillOverrides: {"<name>":"off"}` plus `permissions.deny: ["Agent(<name>)"]` hid the parent skill and agent. `claudeMdExcludes` and `skillOverrides` are in the SDK `Settings` type (`sdk.d.ts:9698`, `:7395`) and in the 2.1.319 binary. Claude OS already passes inline `settings` this way (`autoMemoryDirectory`, `server/chat/session.ts:639`).
- **Product sessions inside the repo:** root tab and root-folder document tabs (cwd `root/`, `settingSources: user, project, local`, `session.ts:627`), service (`service/`, `settingSources: ['project']`, `manager.ts:268,284`), setup (`setup/`), `/btw` side questions (CLI args, `btw.ts:33`), the command probe for the `/` menu (`probe.ts:19`). The plugin setup tab opens with cwd = repo (`osPlugins.ts:302`), so it would get the dev kit.
- **Sizes today:** `root/CLAUDE.md` 141 lines / 23,401 B; `service/CLAUDE.md` 2,400 B; `setup/SETUP.md` 2,878 B; `root/NOTE_RULES.md` 671 B; `PROMPT_LABELS` 28 label lines in every session (`server/chat/profile.ts`); `UI_TOOL_RULE`, `PROGRESS_RULE`, `DOCUMENT_RULE` ≈ 1.2 KB appended to every session; the owner's `~/.claude/CLAUDE.md` 281 lines / 13,922 B, loaded into every session including Claude OS's own. A root turn starts at ≈ 41 KB of instructions.
- **Checks today:** `npm run typecheck` 2.1 s; `npm test` 53 s wall, 467 tests, all green (chat.test.ts alone 19 s; slowest suites in chat, recovery, service, memory, btw tests at 11–16 s each); a two-file run 0.5 s. `npm run check:shippable` is **red: 75 violations, all in tracked `docs/specs/*` and `docs/plans/*`** (owner's name, home paths). e2e not run for this design.
- **Lint:** `typescript-eslint` 8.72 needs `typescript >=4.8.4 <6.1.0`; this repo uses TypeScript 7.0.2 (native, no classic JS API). `oxlint` 1.93 has `max-lines`, `max-lines-per-function`, `complexity`, `max-depth`, `max-params`, `max-classes-per-file`, `no-explicit-any`, `ban-ts-comment`, and `overrides` with `files` globs. No formatter today; 3,647 of 51,629 source lines (7 %) are over 120 characters.

## Goals

1. Dev sessions (cwd = repo or a worktree) start from ≤ 60 lines of `CLAUDE.md` + ≤ 50 lines of unconditional rules; product sessions load none of it.
2. Product prompts: root ≤ 4 KB, service ≤ 2 KB, appended block ≤ 2 KB in a work tab; enforced by a test.
3. One gate (`scripts/gate.ts`) used by the Stop hook, a git pre-push hook and any future CI; green on `main`.
4. Size and complexity limits as lint errors with a ratchet that can only tighten.
5. Shared concepts typed where possible, the rest checked by tests or `check:touchpoints`.
6. Edit-time tests ≤ 10 s, Stop gate ≤ 90 s, e2e in the background with bounded memory.
7. Process kit: 7 skills (0 model-visible), 3 agents, docs/rules ledgers.

## Non-goals

- Project 3: packaging this kit for user projects, the question level in behavior, an OS plugin with skills/agents/hooks.
- Project 4: wiki memory format and note migration.
- CI service, remote, push; `claude-code-action`; sandbox; prompt/agent hooks; knip, jscpd, dependency-cruiser, gitleaks (candidates for later, not installed now).
- Splitting today's large files (the ratchet freezes them; `/split-file` and `/batch` work comes later).
- A formatter (see 2.6).

## Anti-goals

- Dev instructions, skills, agents or hooks reaching a product session (root, service, setup, document, btw).
- A Stop hook that blocks for minutes, loops, or blocks when nothing tracked changed.
- Lint config or hooks loosened by Claude to pass; a new suppression comment.
- A gate that is red on `main` from day one and gets ignored.
- Owner's running install changing behavior beyond the trimmed prompts (same answers, same tools, same labels).

## Design

### 1. Always-loaded context

**1.1 Isolation (decision).** Product sessions pass inline settings built by a new `server/chat/devIsolation.ts`, merged into the `settings` option of every session whose cwd is inside `paths.root`, `paths.service` or `paths.setup`, and into the `--settings` JSON of `btw.ts` and the `probe.ts` options:

```json
{ "claudeMdExcludes": ["<repo>/CLAUDE.md", "<repo>/CLAUDE.local.md", "<repo>/.claude/rules/**"],
  "skillOverrides": { "<each dir name in <repo>/.claude/skills>": "off" },
  "permissions": { "deny": ["Agent(<each file name in <repo>/.claude/agents>)"] } }
```

Names are read from disk at spawn, so a new dev skill is excluded without code changes. `service`'s `serviceSettings()` and the `autoMemoryDirectory` object are merged, not replaced. Hooks need nothing: parent `.claude/settings.json` hooks do not fire (probed). The plugin setup tab moves to cwd `paths.root`. Rejected: moving `root/`, `service/`, `setup/` out of the repo (breaks project-1 layout and user installs); dropping the `project` setting source (loses `root/CLAUDE.md` and project MCP); dev instructions outside `CLAUDE.md` only (manifest wants the file; parent rules/skills would still leak).

**1.2 Dev `CLAUDE.md` (repo root, ≤ 60 lines, English).** Sections and the lines that matter:
- Commands: `npm run typecheck` (2 s), `npm test` (≈ 55 s) and one file `node --disable-warning=ExperimentalWarning --test <file>`, `npm run lint`, `npm run gate`, `npm run build` (any web change), e2e only via the test-runner agent in the background, `npm run check:shippable`, `npm run check:touchpoints`.
- Gotchas: Node runs `.ts` directly (type stripping, `erasableSyntaxOnly`: no enums, namespaces, parameter properties; `.ts` extensions in imports); TypeScript 7 has no JS API (no typescript-eslint); product sessions live in `root/`, `service/`, `setup/` and do not see this file (`devIsolation.ts`); a server or `shared/` change needs a restart, a work tab cannot restart the server (ask the user or the root tab), web changes need `npm run build` + reload; `config/`, `data/`, `vault/` are user data: never edit for a core change, never commit; Cyrillic only where `check-shippable` allows; e2e needs `dist/web` and `e2e/env.ts` (WSLg).
- Decisions not in code: shipped vs user (`defaults/` → `config/`, user id wins); prompts say "the user", labels via `PROMPT_LABELS`; `main` is the only long-lived branch, task branches merged and deleted, nothing pushed; one review per project, at the end.
- Pointers: `.claude/rules/00-workflow.md`, `docs/rules/` (architecture, touchpoints, testing, ledgers).

**1.3 `.claude/rules/`.** Unconditional (≤ 50 lines total): `00-workflow.md` (task contract in 4 lines, systemic change = touchpoints + sibling grep, finish = gate output shown, git flow, correction → ledger row), `10-code-standard.md` (limits, English, comments say why, no suppressions, typed registries over free maps), `20-mistakes.md` (top list from `docs/rules/common-mistakes.md`, ≤ 15 lines). Path-scoped: `prompts.md` (`root/**`, `service/**`, `setup/**`, `server/chat/profile.ts`, `server/chat/rootMcp.ts`, `server/tools/documents.ts`: every line is paid in every session, budgets, "the user", labels), `server.md` (`server/**`, `shared/**`: contract first, `invalidate` topics, `audit` writes, `httpError`, restart), `web.md` (`web/src/**`: both catalogs, surface vs menus design rule, no unwired control, build + reload), `tests.md` (`**/*.test.ts`, `e2e/**`: testkit, lowercase behavior titles, e2e in background).

**1.4 Product prompts.** `root/CLAUDE.md` (lines today → destination):

| Lines | Section | Goes to |
|---|---|---|
| 1–3, 9–16, 50–54 | role, what to do, limits | stay, trimmed (≈ 12 lines; language/name lines dropped: the profile block says it) |
| 5–7 | developer mode | 2 lines: core changes go to a Claude OS project tab via `open_session` (dev kit and gate apply there), never via `../config` |
| 18–38 | tool list | tool descriptions in `rootMcp.ts` (loaded on tool search); 2 policy lines stay |
| 40–48 | interface link | deleted: `UI_TOOL_RULE` + `ui_action` schema; the "three places" line → `docs/rules/touchpoints.md` |
| 56–58 | interface design | `.claude/rules/web.md` (dev) + one line in `root/reference/widgets.md` |
| 60–85, 87–89 | widgets, home layout, trash, IDEs, `mcpNotes`, icons | `root/reference/widgets.md`, `root/reference/icons.md` |
| 91–103 | documents | `DOCUMENT_RULE` + tool descriptions + `root/reference/documents.md` (sharing, sandbox) |
| 105–141 | Claude OS plugins | `root/reference/plugins.md` |

Result ≤ 40 lines / 4 KB with a last line "for widgets, plugins, documents, icons read `reference/<topic>.md` first". Reference files are read on demand by path (the service session has `Read`; no plugin needed). `service/CLAUDE.md` points to `../root/reference/` instead of `../root/CLAUDE.md` and drops to ≤ 2 KB. `claude-os-core` (shipped `plugins/os-builder`) is removed: its map moves to `docs/rules/architecture.md`, its checks to the dev `CLAUDE.md`. `UI_TOOL_RULE` and `DOCUMENT_RULE` shrink to one or two sentences each (the tool descriptions carry the rest).

**Labels.** Kanban column and progress status labels move into the `move_kanban_card` / `report_progress` descriptions, built per session in the user's language. The profile block then lists only labels whose names occur in that session kind's prompt sources (root: `root/CLAUDE.md` + `root/reference/*.md`; service: `service/CLAUDE.md` + references; work and document tabs: none). Today 28 lines in every session → 0 in work tabs, ≈ 15 in root.

**1.5 Budget test** `server/chat/promptBudget.test.ts`: byte limits above; `wc -l CLAUDE.md ≤ 60`; unconditional rules ≤ 50 lines; every `PROMPT_LABELS` name occurs in some prompt source.

### 2. Deterministic layer

**2.1 `.claude/settings.json` (tracked).** `permissions.allow`: `Bash(npm run typecheck)`, `Bash(npm test*)`, `Bash(npm run lint*)`, `Bash(npm run gate)`, `Bash(npm run check:*)`, `Bash(npm run build)`, `Bash(node --disable-warning=ExperimentalWarning --test *)`, `Bash(git status*)`, `Bash(git diff*)`, `Bash(git log*)`, `Bash(rg *)`. `deny`: `Edit(./data/**)`, `Edit(./.claude/hooks/**)`, `Edit(./.claude/settings.json)`, `Edit(./.claude/settings.local.json)`, `Edit(./.githooks/**)`. `ask`: `Bash(git push*)`. Hooks registered last in the build order (they protect themselves). `.claude/settings.local.json` and `CLAUDE.local.md` stay ignored.

**2.2 Hooks (`.claude/hooks/*.mjs`, Node, no dependencies, `node "$CLAUDE_PROJECT_DIR/.claude/hooks/<x>.mjs"`).** `$CLAUDE_PROJECT_DIR` only locates the scripts: a Claude OS tab in a worktree keeps it at the main checkout, so the hooks act on the git root of the hook input's `cwd` (`tree.mjs`).

| Hook | Event | Does | Budget |
|---|---|---|---|
| `protect-files.mjs` | PreToolUse `Edit\|Write` | blocks `data/`, `.git/`, `package-lock.json`, `dist/`, `node_modules/`, `.claude/hooks/`, `.claude/settings*.json`, `CLAUDE.local.md`, `.githooks/`, `.env*` (in the working tree and the main checkout), and any edit of `.oxlintrc.json` the ratchet (2.5) flags against `HEAD`; exit 2 with the reason | < 0.1 s |
| `after-edit.mjs` | PostToolUse `Edit\|Write` | `oxlint <file>`; for `server/`, `shared/`, `scripts/` `.ts`: related tests (2.3); failures only, exit 2 | ≤ 10 s, timeout 30 |
| `stop-gate.mjs` | Stop | runs `scripts/gate.ts` when the tree fingerprint differs from the last green one; exit 2 with ≤ 60 lines; gives up after 3 blocks in a row and stops with the red summary | ≤ 90 s, timeout 300 |
| `briefing.mjs` | SessionStart `startup\|resume\|compact` | ≤ 8 lines: branch, dirty count, branches and worktrees other than `main` (the no-zoo rule), latest plan's open items, latest `docs/handoff/` file | < 0.5 s |

Fingerprint = `HEAD` + hash of `git diff HEAD` + list of untracked, non-ignored files, stored in `<git-dir>/claude-gate.json` (per worktree, never tracked) with the `HEAD` of the last green run. Same fingerprint as the last green run, or a clean tree at its `HEAD` → no gate; an edit and a commit in one turn leave a clean tree at a new `HEAD` and are checked.

**2.3 Related tests (node:test has no "related" mode).** Mapping in `after-edit.mjs`: test files under `server/` and `scripts/` whose non-`import type` imports resolve to the edited file (one level; today 55 of 72 server/shared/scripts modules have such a test). Skip and say "deferred to Stop" when the set has more than 3 files or contains a file from `SLOW_TESTS` (`server/chat/chat.test.ts`, `recovery.test.ts`, `service.test.ts`, `btw.test.ts`, `server/memory/memory.test.ts`; re-measured by the builder). Web files have no unit tests: lint only at edit, typecheck at Stop, e2e in contour C.

**2.4 One gate: `scripts/gate.ts`** (`npm run gate`), steps in order, stop at first red, failures only (`--test-reporter=dot`): typecheck (2 s) → `oxlint` with `--max-warnings 0` → lint ratchet (2.5) → `check:shippable` (0.3 s) → `check:touchpoints` (< 1 s) → new suppressions in the diff since the merge base (`@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `oxlint-disable`, `eslint-disable`) → `npm test` (53 s). Expected ≈ 60 s. Used by `stop-gate.mjs`, `.githooks/pre-push` (`#!/bin/sh` + `exec node scripts/gate.ts`; Git for Windows runs hooks through its own sh) after `npm run hooks:install` (`git config core.hooksPath .githooks`, local to this clone), and any future CI. `00-workflow.md`: run `npm run gate` before merging a task branch into `main`.

**2.5 Lint: oxlint, `.oxlintrc.json`.** Errors, not warnings: `max-lines` 300 (skip blank and comment lines; `**/*.tsx` 400), `max-lines-per-function` 50 (`**/*.tsx` 120), `complexity` 10, `max-depth` 4, `max-params` 4, `max-classes-per-file` 1, `typescript/no-explicit-any`, `typescript/ban-ts-comment`, the `correctness` category. Off for `**/*.test.ts`, `e2e/**`, `server/**/fixtures/**`; ignored: `web/src/lib/locales/*.ts` (data), `plugins/agentation/ui/agentation.vendor.js`, `plugins/*/tools/e2e.mjs`, `dist/`. **Ratchet:** one `overrides` entry per offender with its own cap set to today's value (lines, and for function rules the file's worst value). `scripts/check-lint-ratchet.ts` compares `.oxlintrc.json` with the merge base with `main`; on `main` that is `HEAD` itself, so `protect-files.mjs` also compares every edit of it with `HEAD`: a base limit may not rise, a rule may not be added below `error`, a plugin may not be dropped, an override may not be added or raise a cap; lowering or deleting is free. So Claude can tighten without asking, never loosen. Offenders today (non-blank, non-comment lines; the builder regenerates exact numbers from oxlint):
- `.ts`/`.js` over 300: `web/src/home/universe/Universe.ts` 1632, `shared/contract.ts` 977, `server/chat/session.ts` 760, `server/tools/admin.ts` 621, `server/chat/manager.ts` 578, `server/tools/osPlugins.ts` 557, `desktop/main.cjs` 483, `server/tools/kanban.ts` 452, `server/chat/rootMcp.ts` 430, `plugins/ide-plus/ui/index.js` 418, `server/tools/git.ts` 415, `server/memory/store.ts` 404, `server/journal/indexer.ts` 388, `server/tools/planner.ts` 381, `server/journal/index.ts` 366, `web/src/home/universe/layout.ts` 360, `server/journal/parse.ts` 312.
- `.tsx` over 400: `web/src/home/Widgets.tsx` 709, `web/src/work/Composer.tsx` 640, `web/src/screens/SettingsScreen.tsx` 585, `web/src/notes/PlannerPanel.tsx` 511, `web/src/screens/Analytics.tsx` 424, `web/src/screens/McpPane.tsx` 412.

**2.6 Formatter: none in this project.** Prettier or oxfmt would rewrap most of the 7 % long lines and touch nearly every file: one huge diff, conflicts with parallel worktrees, and per-edit formatting would mix style changes into every task diff against the minimal-diff rule. Style stays "match the file"; lint owns the substance. A one-commit format pass can be decided later.

**2.7 New devDependencies:** `oxlint` (fast Rust linter with prebuilt binaries for Linux, macOS, Windows; works with TypeScript 7, where typescript-eslint does not). Nothing else.

### 3. Touchpoints (verified against the code today)

| Concept | Today | Mechanism |
|---|---|---|
| `UiCommand` actions: `shared/contract.ts:31`, `UI_ACTIONS` `rootMcp.ts:96`, `runUiCommand` `web/src/lib/uiCommands.ts:35` | `satisfies readonly UiCommand['action'][]` accepts a subset; the switch has no default | typed: list derived from a `Record<UiCommand['action'], true>`, `assertNever` default; same for `UI_VIEWS` (`rootMcp.ts:95`) |
| `KanbanColumn` (`contract.ts:1158`) | 4 copies: `kanban.ts:14`, untyped `z.enum` `rootMcp.ts:279`, `KanbanBoard.tsx:27`, 5 `PROMPT_LABELS` | typed: `KANBAN_COLUMNS` const in `contract.ts`, type derived, all users import it; board `satisfies Record<KanbanColumn, Key>` |
| `HomeSlot` (`contract.ts:264`) | `HOME_SLOTS` `server/tools/settings.ts:77` and `SLOTS` `web/src/home/slots.ts:3`, both `HomeSlot[]` | typed: one const in `contract.ts` |
| ru/en catalog keys | already typed: `en.ts` is `Omit<Record<keyof ru, string>, few/many>` (1793 ru / 1783 en keys, 10 ru-only plural forms) | nothing to add |
| server error codes ↔ `errors.*` keys | `server/chat/messages.test.ts` | exists |
| MCP tools ↔ `allowedTools` per session kind (`manager.ts:290–291`, `rootMcp.ts:15–38`) | no check; root registers `set_project_map` but does not allow it, work tabs register `remove_planner_item` but allow only `check_planner_item` | test `server/chat/mcpTools.test.ts`: builds each server, asserts allowed ⊆ registered and registered − allowed = an explicit `PROMPTED_TOOLS` list (the builder confirms those two are meant to prompt); every tool name a prompt mentions exists |
| Microtasks: `MICROTASK_ROUTES` `server/tools/microtasks.ts:10` (19) ↔ `root/microtasks/*.md` (19) | none | `check:touchpoints`: file per key and key per file |
| `BuiltinId` (`slots.ts:5`), `HomeSlot`, widget types (`server/tools/widgets.ts:27`) | described in `root/CLAUDE.md` by hand | `check:touchpoints`: each member named in `root/reference/widgets.md` |
| `OS_PLUGIN_PERMISSIONS` (`contract.ts:922`) | described by hand | `check:touchpoints`: each named in `root/reference/plugins.md` |
| `PROMPT_LABELS` | typed keys (`satisfies Record<string, keyof typeof en>`) | budget test: each name used in a prompt source |

`scripts/check-touchpoints.ts` (Node, ≈ 60 lines) reads `docs/rules/touchpoints.json` (`source`, `memberRegex`, `registries[]`, `fileExists`, `reverseDir`); `docs/rules/touchpoints.md` is the human map, including the "new endpoint" and "new `ui_action`" recipes from `claude-os-core`.

### 4. Test contours

| Contour | Runs | When | Budget (measured) |
|---|---|---|---|
| A | oxlint on the file + related unit tests (2.3) | `after-edit.mjs` | ≤ 10 s (two-file run 0.5 s) |
| B | `scripts/gate.ts` | Stop, pre-push, before merge to `main` | ≤ 90 s (≈ 60 s: tsc 2.1, unit 53) |
| C | `npm run build` + e2e | test-runner agent in the background; before merging a task touching `web/`, `e2e/` or `desktop/`; the end-of-project review | minutes; the first plan task measures serial wall time and peak memory |

**e2e stability.** Each of the 35 e2e files launches its own Chromium; `npm run e2e` runs files at the default concurrency (cores − 1 = 3), which runs out of memory here, so plans use `e2e:serial`. Change: `scripts/e2e.ts` starts one `chromium.launchServer()`, passes its endpoint in `CLAUDE_OS_E2E_WS`, and runs `node --import ./e2e/env.ts --test --test-concurrency=2 "e2e/**/*.test.ts"`; the shared launcher in the e2e fixtures connects when the variable is set and launches as today otherwise (one file still runs alone). Node 22 has no `--test-global-setup`, hence the wrapper. Accept when two full runs pass and peak RSS is below today's serial peak plus 50 %. **Obscura** (a Rust headless browser with CDP; `github.com/h4ckf0r0day/obscura`, ≈ 31k stars) is not planned: the home map is WebGL and the suite is Chromium-specific. Before any evaluation, verify a release binary for linux-x64, macOS and Windows, its license, and that `chromium.connectOverCDP` runs one non-WebGL file (`e2e/git.test.ts`) green twice; only then compare memory. It goes to `docs/rules/pattern-candidates.md` as a candidate, not into this plan.

### 5. Process layer (English, project-level, tracked)

- `docs/specs/TEMPLATE.md` (manifest 4.7), `docs/plans/`, `docs/solutions/` (README: one file per lesson), `docs/rules/`: `architecture.md` (from `claude-os-core`), `code-style.md` (2.5 limits and why), `testing.md` (contours and measured times), `touchpoints.md` + `.json`, `common-mistakes.md`, `pattern-candidates.md`. `docs/handoff/` is ignored (session state, not product).
- Skills (`.claude/skills/<name>/SKILL.md`, each ≤ 40 lines, all `disable-model-invocation: true`, so 0 model-visible descriptions; they reuse the owner's global superpowers skills instead of copying them):

| Skill | Does |
|---|---|
| `/spec` | superpowers brainstorming + this repo's template, touchpoints and `docs/solutions/` tags → `docs/specs/<date>-<slug>.md` |
| `/feature` | spec → `docs/plans/` → task branch/worktree → TDD per task with contour A → `npm run gate` → merge into `main`, delete branch and worktree → `/compound`; no per-task review (one reviewer run per project, at the end) |
| `/split-file` | manifest 6.4 on one file; lowers its ratchet cap in the same change |
| `/techdebt` | report only: ratchet list vs limits, oxlint summary, `rg TODO\|FIXME`, stale branches/worktrees |
| `/compound` | `docs/solutions/<date>-<slug>.md`, ledger rows, Seen ≥ 2 → drafts the lint rule / test / touchpoint entry |
| `/handoff` | `docs/handoff/<date>-<branch>.md`: done, left, decisions, commands, broken |
| `/promote` | ledgers over threshold (3, or 2 with ≥ 30 min) → writes skills/rules itself; hook or lint-config changes are shown as a proposal (they are protected) |

- Agents (`.claude/agents/`): `reviewer` (model inherit; Read, Grep, Glob, Bash; `memory: project`, which also gives it Write and Edit for its memory, tracked and covered by `check-shippable`; spec checklist + touchpoint completeness, table output), `scout` (haiku; Read, Grep, Glob; ≤ 40 lines of paths), `test-runner` (sonnet; Bash, Read; failures only, ≤ 60 lines; owns contour C). An agent's `tools:` takes tool names; a `Bash(...)` specifier there does not restrict Bash (checked live), so each prompt states its command limits: reviewer read-only `git diff`/`log`/`show` and `rg`, edits only its memory; test-runner `npm run`, `node`, `flock`, changes no files.

### 6. Owner's `~/.claude/CLAUDE.md` (proposal only; outside the repo)

Shown to the owner as a diff and applied only with his ok. Proposed file (19 lines; the name placeholder keeps today's value):

```markdown
# Global instructions
- Chat in Russian, address the user as <name>; concise, dry, no filler. Code, comments, commits, docs: English.
- Work without asking. Ask only for: writes outside the project; push, reset --hard, clean or anything touching a remote; global installs or system/shell config; DB migrations or production; irreversible bulk deletion; a task whose intent is ambiguous (ask grouped questions first).
- Never invent business rules, data, roles, UI texts or metrics: verify in code, DB or docs. Find the existing mechanism before writing new code.
- Minimal diffs: only what the task needs; no unrelated refactors or reformatting; mention dead code instead of removing it.
- Simplest code that works; no speculative abstractions. Escalate: field → parameter → setting → existing service → new one, each with a reason.
- Done means a check that exercises the change ran and its output was shown; never ask the user to verify by hand.
- Search with `semble search` for intent, `rg` for literals. Shell: simple commands, absolute quoted paths, no `cd`, never backslash-escape spaces.
- Never touch Windows mounts (/mnt/*), shell rc files, WSL, network, SSH, git or credential config.
- Git: local commits on task branches are fine; merge into main locally and delete the branch; never push.
- Migrations: neither write nor apply them unless allowed in this session.
- Subagents: Opus for main work, Fable sparingly, Haiku for scout-type search.
- Project CLAUDE.md and .claude/rules win where they are more specific.
<!-- os-plugin:rg-context:claude-md:start -->
(rg-context block, unchanged, markers kept: the plugin finds it only in this file)
<!-- os-plugin:rg-context:claude-md:end -->
```

Where the rest goes: §12, §14–16 (explanation style, analogies, snippet format) → personal skill `~/.claude/skills/explain-mechanism/SKILL.md` (only its description loads); §2 escalation detail, §3 "DB schema, shared modules, other team's side", §9 migrations → `~/.claude/rules/backend.md` with `paths: ["**/*.php", "**/migrations/**"]`; §8 "never" list → `permissions.deny` in `~/.claude/settings.json` (e.g. `Edit(//mnt/**)`, `Edit(~/.bashrc)`, `Edit(~/.zshrc)`, `Edit(~/.profile)`); "no Claude attribution" is already enforced by the `attribution` key there; §4, §5, §11, §13 → covered by the lines above and superpowers (TDD, verification-before-completion, brainstorming); §7.1–7.3 detail and §18 "no haiku" are dropped (the manifest wins). Unconditional `~/.claude/rules/*.md` are not used: they would load into every session just like the file itself.

## Order of work (for the planner)

1. Scrub tracked `docs/specs` and `docs/plans` (owner's name → "the owner", home paths → relative) until `check:shippable` is green. 2. Isolation (`devIsolation.ts`, plugin setup cwd) with tests and a live probe. 3. Product prompt trim, references, labels, budget test; remove `claude-os-core`. 4. Typed registries (section 3) and `mcpTools.test.ts`. 5. `check-touchpoints`, oxlint + ratchet, `gate.ts`, `.githooks`. 6. Dev `CLAUDE.md`, rules, docs/rules, skills, agents. 7. Hooks and `.claude/settings.json` last. 8. e2e launcher. 9. Global `CLAUDE.md` diff to the owner. 10. One reviewer run over the whole project diff.

## Verification

- Live probe from `root/`, `service/`, `setup/` (as in Evidence, with the settings `devIsolation.ts` builds): no marker line from the dev `CLAUDE.md` or rules, no dev skill or agent listed; from the repo root and a `.worktrees/*` worktree: all present, each once.
- Unit: `devIsolation` options for each session kind, `btw` args, probe options; budget test; `mcpTools.test.ts`; `check-lint-ratchet` red on a raised cap and green on a lowered one; `check-touchpoints` red on a microtask key without a file.
- Live hook tests (manifest Phase 1): edit `data/x` → blocked; break a type and stop → sent back with the tsc line; add a microtask key → touchpoints gap at Stop; no tracked change → Stop costs < 1 s; three red stops → the session ends with the summary.
- `npm run gate` green on `main`; timings recorded in `docs/rules/testing.md`; `wc -l CLAUDE.md` ≤ 60; `/context` in an empty dev session and in the root tab, before/after, recorded.
- Owner's install: root and service answer as before in Russian with the same tools; labels in kanban/progress tool use match the UI; no setup modal.

## Left to the builder

Exact wording of every file; `.oxlintrc.json` numbers from oxlint output; the `SLOW_TESTS` list after re-measuring per file; touchpoints.json regexes; the e2e launcher shape and fixture changes; which two "prompted" tools are intended; label filtering mechanics; skill and agent texts; the hook output format.

## Claude's calls (for the owner to check)

1. Isolation through inline `claudeMdExcludes` + `skillOverrides` + `Agent(...)` deny in product sessions, names read from disk.
2. The root tab no longer edits the core; it hands core changes to a Claude OS project tab, where the dev kit and gate apply. `claude-os-core` is removed from `os-builder`.
3. Product reference text moves to `root/reference/*.md`, read on demand by path, instead of skills.
4. oxlint instead of ESLint (TypeScript 7 blocks typescript-eslint); ratchet via per-file caps that a script lets only go down.
5. No formatter in this project.
6. `check:shippable` joins the gate, so tracked specs and plans are scrubbed of the owner's name and home paths first.
7. Stop gate runs the full unit suite (≈ 55 s), only when the tree changed since the last green run, and gives up after 3 blocks.
8. pre-push hook via `core.hooksPath` set by `npm run hooks:install`, not on `npm install`.
9. `docs/handoff/` ignored; reviewer agent memory tracked.
10. Obscura is not evaluated now; it waits in the candidate ledger with a verification recipe.
11. Global `CLAUDE.md`: ≤ 20 lines, explanation style to a personal skill, backend rules path-scoped, "never" list to `permissions.deny`; no unconditional user rules.
