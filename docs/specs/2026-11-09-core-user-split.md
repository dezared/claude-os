# Core/user split, de-personalization and first-run setup — design

Status: draft · Owner: the owner · Date: 2026-11-09 · Project 1 of 4 (see "Roadmap" at the end)

## Intent

Claude OS ships as **code + the Claude Code OS manifest + updates**. Each user runs their own copy and grows it through their agent (widgets, plugins, templates, memory). Updates arrive through the agent and must never break what the user built.

Today the repository mixes the core with one person's install: personal settings and data sit next to the code, prompts hard-code the owner's name and Russian, a personal projects path is a default, and there is no git. This project separates **system** (shipped, versioned) from **user** (local, never in git), removes personal data from shipped files, moves Claude-facing text to English, and adds a first-run setup so a fresh clone becomes a working install.

Nothing is pushed anywhere. The repo gets a local git history only.

## Goals

1. Local git repository; `.gitignore` covers every user and machine file; a script proves that tracked files contain nothing personal.
2. One rule for shipped vs user content everywhere: **shipped defaults live in the repo, the user's copy lives in `config/`, a user file with the same id wins and is never overwritten by an update.** The rule already exists for document templates (`root/document-knowledge` vs `config/document-knowledge`, `server/tools/documents.ts:67`); extend it to plugins and to default settings/widgets/actions/icons.
3. No owner name, home path or personal directory in shipped files. Name, reply language, projects folder and question level come from a user profile.
4. English for everything Claude reads and for code comments. User-visible server messages go through i18n (ru + en), not hard-coded Russian.
5. The manifest translated to English and stored in the repo.
6. First-run setup: a modal on the home screen, deterministic environment checks, then a short onboarding run by Claude that writes the profile. Resumable.

## Non-goals

- GitHub remote, push, license, release process.
- Lint, hooks, rules, touchpoint checks, skills and agents for developing Claude OS (project 2).
- Applying the manifest to user projects, the question-level behavior beyond storing it (project 3).
- Wiki format for memory and migration of notes (project 4).
- Rewriting e2e/unit assertions that check the Russian UI: they test the `ru` locale and stay.
- Moving `config/`, `data/`, `vault/` out of the repo directory (env overrides `CLAUDE_OS_CONFIG`, `CLAUDE_OS_DATA`, `CLAUDE_OS_VAULT` already exist).
- Removing WSL from the Windows desktop launcher (`desktop/main.cjs` uses `wsl.exe`); noted for later.

## Anti-goals (failure even if it "works")

- The owner's running install changes behavior or loses anything: settings, widgets, enabled plugins, tabs, memory, documents, planner, kanban.
- An update overwrites or silently shadows a user's file.
- The Russian UI loses or degrades a string; ru and en catalogs drift apart.
- Personal data (name, paths, e-mail, notes) ends up in a tracked file.
- A fresh user hits a dead end: no Claude, no login or no remaining limit, and the app does not say what to do.

## Constraints

- Node ≥ 22.18, TypeScript 7 (`tsc --noEmit` ≈ 2 s), `node --test` (401 unit tests ≈ 48 s, all green on 2026-11-09), Playwright e2e.
- Platforms [owner, 2026-11-09]: **Linux-first** (WSL included; the owner works in WSL, native Windows is under 0.1 % of his use). macOS must be easy to support. Other users may run macOS or Windows only, so shipped tooling avoids bash-only or jq-only pieces: scripts and hooks are Node (`.mjs`), which every install already has. Linux is the primary verification target; macOS/Windows are covered by not adding platform-specific code, not by full test runs.
- Global instructions: minimal diffs, no unrelated refactors, no commit without the owner's ok.

## Design

### 1. Repository layout and git

Tracked (system):

- `server/`, `web/`, `shared/`, `desktop/` (without `build/`), `e2e/`, `scripts/` (only shippable scripts)
- `root/`, `service/` (prompts, microtasks, document templates) — English
- `plugins/<id>/` — **new**: shipped example plugins `agentation`, `ide-plus`, `rg-context`
- `defaults/` — **new**: shipped defaults for `settings.json`, `widgets.json`, `actions.json`, `project-icons/icons.json`
- `docs/manifest/claude-code-os-manifest.html` — English manifest
- `docs/specs/`, `docs/plans/` — English design docs and plans from now on
- `README.md` (short, English: what it is, requirements, `npm install && npm start`, first-run setup), `package.json`, `package-lock.json`, `tsconfig.json`, `.gitignore`

Ignored (user/machine/internal): `config/`, `data/`, `vault/`, `dist/`, `node_modules/`, `desktop/build/`, `*.log`, `.superpowers/`, `docs/superpowers/`, `docs/batch-2026-11/`, `docs/screenshots/`, `<local todo file>.md`, `scripts/shutdown_whenclaudeend.sh`, the empty root file `test`, `docs/manifest/source-ru.html`, `CLAUDE.local.md`, `.claude/settings.local.json`. Ignored files are not deleted or moved.

`git init` locally. The first commit is made only after the owner's ok and after `check-shippable` passes.

**`scripts/check-shippable.mjs`** (Node, no deps): runs over `git ls-files` and fails on

- Cyrillic outside an allowlist: `web/src/lib/locales/ru.ts`, the server ru catalog, `**/*.test.ts`, `e2e/**`, test fixtures;
- absolute home paths (Linux, macOS and Windows user directories) and the owner's personal projects folder;
- words from a **local** denylist `config/private-words.txt` (ignored, so the list of personal words never ships). Setup writes the user's name there.

### 2. Shipped defaults and user overrides

- **Defaults bootstrap** [Claude's call]. On server start:
  - a file in `defaults/` missing in `config/` is copied;
  - list files with record ids (`widgets.json`, `actions.json`): a shipped record whose id the install has never seen is appended once; ids already offered are remembered in `config/.shipped-seen.json`, so a record the user deleted is never re-added and an existing record is never modified;
  - `settings.json`: missing keys are added from defaults, existing values are never touched (built-in widgets keep using `home.removed`/`home.hidden`).
  Readers keep tolerating missing keys.
- **Plugins.** `osPlugins.ts` scans `plugins/` (source `shipped`) and `config/plugins/` (source `user`); same id → the user copy wins. Enable/approve state stays in `data/os-plugins.json`, keyed by id. The existing tree-hash rule stays: a changed folder (including a shipped plugin updated by `git pull`) keeps its code inactive until the user presses "Update" — that is the user's consent to new plugin code. `root/CLAUDE.md` text "plugins do not ship" is updated.
- **Shipped plugin content.** Claude-facing text in plugins (e.g. `agentation/skills/*/SKILL.md`) is translated to English and loses the owner's name; `"author"` becomes `"Claude OS"`. Localization data stays: `descriptionRu`, `featuresRu`, `titleRu`, `whyRu` and ru dictionaries inside plugin `ui/` code are allowlisted in `check-shippable`.
- **Migration for the owner's install** [Claude's call]: move `config/plugins/{agentation,ide-plus,rg-context}` to `plugins/`. The edits above change the tree hash, which would switch ide-plus UI and its `files.write` permission off until "Update" (`activeUi()`, `osPlugins.ts:402`). Since the change comes from the author, a one-off **local** step (not shipped code) re-stamps the stored `tree` in the owner's `data/os-plugins.json` after verifying the only differences are these edits. Shipped behavior keeps the rule "changed folder → Update = consent" for every other user and every later update.

### 3. Profile and de-personalization

`config/settings.json` gets:

```json
"profile": { "name": "…", "language": "ru|en|…", "projectsDir": "/abs/path", "questionLevel": "minimal|balanced|thorough" },
"setup": { "step": "checks|onboarding|done", "completedAt": 1731150000000 }
```

- `newProjectsDir` = `CLAUDE_OS_NEW_PROJECTS` → `profile.projectsDir` → `~/Projects`. The hard-coded personal projects default is removed from `server/context.ts`.
- `claudeBin` = `CLAUDE_OS_CLAUDE_BIN` → first `claude` on `PATH` (incl. `claude.exe`/`claude.cmd` on Windows) → `~/.local/bin/claude`.
- Every Claude OS session (root, service, tabs, documents) gets a short profile block appended to its system prompt through the existing `append` path in `session.ts`: user's name, reply language, question level. Shipped prompts say "the user" instead of a name.
- **One language setting** [Claude's call]. `profile.language` is both the reply language and the UI language. The UI uses its catalog when one exists (ru, en), otherwise en. The client reads it from the server settings instead of keeping its own value in `localStorage` (the stored value is migrated once as the initial value before setup). Changing it in Settings changes both.
- **Changing the profile later** [Claude's call]: a "Profile" section in Settings (name, language, projects folder, question level) and "Run setup again" in the burger menu. Nothing new on the home surface.
- **the owner's install** [Claude's call]: no shipped migration. During implementation his local `config/settings.json` gets `profile = { name: "<owner name>", language: "ru", projectsDir: <his current default>, questionLevel: "balanced" }` and `setup.completedAt` by a one-off local step. The shipped trigger is only "profile missing" (`data/` is created on every start, so it cannot signal an old install).

### 4. English

- Translate to English, keeping meaning and structure (no restructuring; project 2 shortens them): `root/CLAUDE.md`, `service/CLAUDE.md`, `root/microtasks/*.md`, `root/document-knowledge/standard.md`, MCP tool descriptions and tool result strings in `server/chat/rootMcp.ts` and other MCP tool files, code comments with Russian words or the owner's name.
- Prompts mention UI elements by label. Requirement: the label Claude uses must match the UI in the user's language. Mechanism is the builder's call (suggested: the profile block includes the few labels the prompts mention, taken from the active locale catalog).
- Documents Claude writes from `standard.md` are written in the user's language (stated in the template).
- **Server-visible messages** [Claude's call on scope]: only messages a person sees in the UI and that are Russian today (`session.ts`, `manager.ts`, `journal/parse.ts`, `chat/btw.ts`, `memory/state.ts`, user-facing parts of `documents.ts`) get a stable `code` + `params` + an English `message`; the web client renders `t('errors.<code>', params)` from `en.ts`/`ru.ts`, falling back to `message`. Every new code exists in both catalogs. The remaining ~250 `httpError` calls that are already English, and text returned to Claude as MCP tool results, stay plain English (Claude speaks to the user in their language).
- **Cyrillic that carries behavior** [Claude's call]: the Russian-language tab title ("Home") written to the DB becomes a key rendered by locale (old rows keep working); the voice command regex (`web/src/work/voice/pcm.ts`) and the whisper prompt (`server/voice/engine.ts`) choose by language; the Russian `@document` mention token keeps being accepted (it is in chat history) and `@document` is added. Anything that must stay Cyrillic for data compatibility is allowlisted line by line with a comment.
- `desktop/main.cjs` labels (tray "Open/Quit", start screens): English + Russian by the OS locale.

### 5. English manifest

`docs/manifest/claude-code-os-manifest.html`: the full manifest (sections 0–19) translated to English, same structure, styles and tags. Content edits beyond translation: none in this project. Source: the Russian HTML the owner pasted in the 2026-11-09 session; the implementing session saves it first as an ignored local file `docs/manifest/source-ru.html`, then translates.

### 6. First-run setup

**Trigger:** `setup.completedAt` is missing. The home screen shows a modal with "Start setup" and a quiet "Later" (hides it until the next app start). Visuals follow the existing design rule: clean, animated, nothing extra on the surface.

**Step 1 — checks (deterministic, no Claude call).** `GET /api/setup/checks`, each item `ok | warn | fail` with a one-line fix and a "Check again" button:

| Check | Fail / warn |
|---|---|
| `claude` binary found | fail: how to install Claude Code |
| Claude Code version ≥ minimum the SDK needs | fail: how to update |
| Logged in (reuse `server/tools/account.ts` probe, no prompt sent, no credentials read) | fail: run `claude` and log in |
| Plan: subscription or API key present | fail if none |
| Remaining limits (account probe windows) | warn if the active window is ≥ 90 % used or a limit is active: "setup may stop; resets at …", user may continue |
| Node version | fail below 22.18 |
| git present | warn (needed for updates and the Git panel) |
| Projects folder writable (after it is chosen) | fail |

Any fail blocks step 2. Thresholds are the builder's call.

**Step 2 — onboarding by Claude.** A dedicated tab runs `root/setup/SETUP.md` (English). Claude greets briefly in text, then asks (one `AskUserQuestion` round where possible): name, reply language, projects folder (with detected candidates), question level, whether to connect existing memory from `~/.claude/projects` (existing "move memory to vault" flow). It may look around the machine with read-only tools (projects dirs, IDEs via the existing IDE discovery). It writes results only through a dedicated tool `save_profile` / `complete_setup` (validated server-side), not by editing files. Model/effort are chosen to keep the run cheap (builder's call).

**Resumable.** `setup.step` is saved after each step; reopening the app shows "Continue setup". If the Claude run fails (limit, crash), the modal shows the reason and "Try again"; the checks re-run first.

**Done.** `setup.completedAt` set, modal closes, the tab with the onboarding text stays open.

## Verification

- Unit: defaults bootstrap (missing → copied, existing untouched); plugin precedence (user over shipped) and state survival across the move; profile block in the appended prompt; owner migration (profile written once, never again); `claudeBin` resolution order; error codes rendered in en and ru; each setup check with fake-claude fixtures (no binary, logged out, no plan, limit ≥ 90 %).
- e2e: empty temp `CLAUDE_OS_CONFIG`/`CLAUDE_OS_DATA` → modal → checks → onboarding with fake Claude → profile saved → modal gone after reload. Existing e2e stay green.
- The owner's install, before/after: same settings, widgets, enabled plugins, tabs; root and service sessions answer in Russian and address him by name; no setup modal.
- `check-shippable` passes on `git ls-files`; `rg` for the owner's name and home path over tracked files returns nothing.
- `npm run typecheck`, `npm test`, `npm run e2e`, `npm run build` green.

## Left to the builder

File and module names, catalog key names, the exact `defaults/` content (from the current shipped behavior, not from the owner's personal values), check thresholds, modal layout and motion, model/effort for onboarding, how labels reach the prompts, order of tasks.

## Claude's calls (for the owner to check)

1. User folders stay inside the repo directory, ignored by git.
2. Shipped plugins move to `plugins/`; for the owner's install their stored hash is re-stamped locally once, so ide-plus does not switch off.
3. Only user-visible Russian server messages become codes; the rest stays plain English.
4. The owner's install gets its profile by a one-off local step; no shipped migration.
5. One language setting drives both UI and replies; the UI falls back to en.
6. Defaults: new shipped widgets/actions are added once by id, deleted ones never return.
7. Old internal docs (`docs/superpowers`, `docs/batch-2026-11`, screenshots) stay local and ignored; new specs and plans are English and tracked.
8. Setup has a "Later" button instead of blocking the app; profile is editable in Settings.

## Roadmap (all four projects)

1. **This document** — core/user split, de-personalization, English, first-run setup.
2. **Manifest on Claude OS development** — short dev `CLAUDE.md`, `.claude/rules`, Node hooks (format, related tests, stop gate, briefing), `scripts/gate.sh`-equivalent in Node, ESLint with a ratchet baseline, touchpoints (`UiCommand` triple, ru/en key parity, MCP tool lists), `check-shippable` in the gate, e2e memory fix (shared browser / limited concurrency, background contour C), skills `/spec` `/feature` `/split-file` `/techdebt` `/compound` `/handoff`, agents `reviewer` `scout` `test-runner`; the owner's global `CLAUDE.md` aligned with the manifest.
3. **Manifest as a Claude OS feature for user projects** — apply the project kit to any project from Claude OS, question level in behavior, shipped skills/agents/hooks as an OS plugin.
4. **Wiki memory** — strict wiki format for all notes (frontmatter, `[[links]]`, index, log), all projects writing to `.md` in the vault from the start, a format check, migration of existing notes.
