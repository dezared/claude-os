# Core/user split, de-personalization and first-run setup — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the repo into a shippable core (local git, English, no personal data) with user content in ignored folders, shipped defaults with user overrides, a user profile and a first-run setup.

**Architecture:** One rule everywhere: shipped content in the repo (`root/`, `service/`, `plugins/`, `defaults/`), user content in `config/` (same id wins, never overwritten). A profile in `config/settings.json` replaces the hard-coded owner; it is appended to every session's system prompt and drives the UI language. First run = deterministic checks endpoint + a setup tab where Claude writes the profile through two MCP tools.

**Tech Stack:** Node ≥ 22.18 (runs `.ts` directly), TypeScript 7, Fastify 5, React 19 + zustand, `@anthropic-ai/claude-agent-sdk`, `node --test`, Playwright.

**Spec:** `docs/specs/2026-11-09-core-user-split.md`

## Global Constraints

- Linux-first (WSL included); no bash-only or jq-only tooling: scripts are Node `.ts`/`.mjs`.
- The owner's install must not change behavior or lose data: settings, widgets, enabled plugins (incl. ide-plus UI), tabs, memory, documents, planner, kanban.
- An update never overwrites a file in `config/`; a user copy with the same id wins.
- ru and en catalogs stay complete; every new key exists in both (`web/src/lib/locales/{ru,en}.ts`).
- English for all Claude-facing text and code comments; Cyrillic only where `check-shippable` allows it.
- Minimal diffs; no unrelated refactors; no remote, no push.
- **Branches [owner, 2026-11-09]:** `main` is the only long-lived branch. Each task (or parallel group) works in its own worktree on a short-lived branch `task/<n>-<slug>` cut from `main`, commits there locally, is merged into `main` by the controller after review, then the worktree and branch are deleted. No branch outlives its task. No remote, no push. Worktrees lack ignored folders: symlink `node_modules`; tests use temp dirs; steps marked "the owner's install, local" are done by the controller in the main checkout, never in a worktree.
- **Clean public history:** `main` starts with an import commit of today's code, which still contains personal data. Before any first push (the owner's decision, later), Task 12 squashes `main` into one root commit that passes `check-shippable`; it stays the same single branch `main`.
- Done for every task: `npm run typecheck` and `npm test` green; tasks touching `web/` also `npm run build`; e2e only via `npm run e2e:serial` (parallel e2e eats the machine's memory).
- Order and parallelism: 1 → {2, 3, 8} in parallel → 4 → {5, 6} in parallel → 7 (touches comments in the same files as 6) → 9 → 10 → 11 → 12. The Task 11 "before" snapshot is taken right after Task 1.

## Review Focus

1. `config/` exists but some files are missing or a JSON file is invalid → bootstrap fills only what is missing, never rewrites an invalid user file, server still starts (Task 2 test `bootstrap keeps an invalid user file untouched`).
2. `profile.language` has no UI catalog (e.g. `de`) → UI falls back to en, replies stay in `de` (Task 5 test `unknown language renders en and keeps profile`).
3. Setup interrupted (app closed, server restart, limit hit mid-run) → reopening shows "Continue setup", checks re-run first, no second setup tab (Task 9 test `start reuses the open setup tab`).
4. A shipped plugin changes after `git pull` while the user has a copy with the same id → user copy keeps winning, no Update prompt for it (Task 3 test `user copy shadows a changed shipped plugin`).
5. Chat history and old clients carry Russian warnings without `key` → rendered as stored text (Task 6 test `warning without key renders its text`).

---

### Task 1: Repository bootstrap and the shippable check

**Files:**
- Modify: `.gitignore`
- Create: `README.md`, `scripts/check-shippable.ts`, `scripts/check-shippable.test.ts`
- Modify: `package.json` (scripts)

**Interfaces:**
- Produces: `findViolations(files: { path: string; text: string }[], privateWords: string[]): Violation[]`; `type Violation = { path: string; line: number; rule: 'cyrillic' | 'home-path' | 'private-word'; excerpt: string }`; exported `CYRILLIC_ALLOW: string[]` (glob patterns). CLI: `npm run check:shippable` runs over `git ls-files`, reads `config/private-words.txt` (one word per line, missing file = empty list), prints violations, exits 1 if any.

- [ ] **Step 1:** Append to `.gitignore`: `docs/superpowers/`, `docs/batch-2026-11/`, `docs/screenshots/`, `docs/manifest/source-ru.html`, `<local todo file>.md`, `scripts/shutdown_whenclaudeend.sh`, `/test`, `CLAUDE.local.md`, `.claude/settings.local.json`, `config/`. Keep existing lines (`config/plugins/` becomes redundant; leave it).
- [ ] **Step 2 (controller, before any worktree):** `git init -b main` in the repo root; `git status --short` must list none of the ignored paths above, nor `data/`, `vault/`, `node_modules/`, `dist/`, `desktop/build/`; commit everything else as `chore: import current code` on `main`. Task branches start from this commit.
- [ ] **Step 3: Failing tests** in `scripts/check-shippable.test.ts`:
  - `flags Cyrillic outside the allowlist`: `findViolations([{ path: 'server/x.ts', text: 'a\nconst s = "<Cyrillic text>";' }], [])` → one violation `{ path: 'server/x.ts', line: 2, rule: 'cyrillic' }`.
  - `allows Cyrillic in the ru catalog and tests`: paths `web/src/lib/locales/ru.ts`, `server/a.test.ts`, `e2e/b.ts` → `[]`.
  - `flags home paths`: a Linux home path, a Windows user path and the personal projects folder path → three `home-path` violations.
  - `flags private words case-insensitively`: privateWords `['Alice']`, text `'by alice'` in `server/x.ts` → `private-word`.
  - `allows plugin localization fields`: `plugins/p/plugin.json` with `"descriptionRu": "<Cyrillic text>"` → `[]`; same file with `"description": "<Cyrillic text>"` → `cyrillic`.
- [ ] **Step 4:** Run `node --test scripts/check-shippable.test.ts` → FAIL (module missing).
- [ ] **Step 5:** Implement `scripts/check-shippable.ts`. `CYRILLIC_ALLOW`: `web/src/lib/locales/ru.ts`, `**/*.test.ts`, `e2e/**`, `server/**/fixtures/**`, `plugins/*/ui/**`; in `plugins/*/plugin.json` only lines whose key ends in `Ru"`. A line ending with the comment marker `shippable-allow: <reason>` is skipped (for data-compat Cyrillic, Task 6).
- [ ] **Step 6:** Run the test → PASS. Add to `package.json`: `"check:shippable": "node --disable-warning=ExperimentalWarning scripts/check-shippable.ts"`; extend `"test"` glob to `"server/**/*.test.ts" "scripts/**/*.test.ts"`; add `"e2e:serial": "node --disable-warning=ExperimentalWarning --test --test-concurrency=1 \"e2e/**/*.test.ts\""` (one Chromium at a time; project 2 decides the long-term e2e setup).
- [ ] **Step 7:** Create `config/private-words.txt` locally with the owner's name, system user name and git handle (ignored file). Run `npm run check:shippable` — it is expected to FAIL now (shows the work for Tasks 3–8); save the count in the task report.
- [ ] **Step 8:** `README.md` (English, ≤ 40 lines): what Claude OS is, requirements (Node ≥ 22.18, Claude Code CLI, git), `npm install && npm run build && npm start`, first-run setup, where user data lives (`config/`, `data/`, `vault/`, ignored), link to `docs/manifest/claude-code-os-manifest.html`.
- [ ] **Step 9:** Commit `chore: init repo, ignore user data, add shippable check`.

### Task 2: Shipped defaults and config bootstrap

**Files:**
- Create: `defaults/settings.json`, `defaults/widgets.json`, `defaults/actions.json`, `defaults/project-icons/icons.json`, `server/defaults.ts`, `server/defaults.test.ts`
- Modify: `server/index.ts` (call before modules register)

**Interfaces:**
- Produces: `bootstrapConfig(defaultsDir: string, configDir: string): BootstrapReport`; `type BootstrapReport = { copied: string[]; appended: Record<string, string[]>; keysAdded: string[]; skippedInvalid: string[] }`. Seen ids stored in `config/.shipped-seen.json` as `{ "<file>": ["id", …] }`.

- [ ] **Step 1: Failing tests** (temp dirs):
  - `copies missing files`: empty config → all four files copied, report lists them.
  - `never overwrites existing values`: config `settings.json` `{ "universe": { "x": 1 } }`, default `{ "universe": { "x": 2, "y": 3 } }` → result `{ "universe": { "x": 1, "y": 3 } }`, `keysAdded: ['universe.y']`.
  - `appends a new shipped record once`: default widgets `[{id:'a'},{id:'b'}]`, user `[{id:'a', title:'mine'}]`, seen `{widgets.json:['a']}` → user gets `b` appended, `a` unchanged; second run appends nothing.
  - `does not re-add a deleted record`: user `[]`, seen has `a` → stays `[]`.
  - `bootstrap keeps an invalid user file untouched`: user `settings.json` = `{oops` → file bytes unchanged, `skippedInvalid: ['settings.json']`.
- [ ] **Step 2:** Run `node --test server/defaults.test.ts` → FAIL.
- [ ] **Step 3:** Implement `bootstrapConfig` (deep-merge of missing keys for objects; arrays of `{id}` records use the seen list; writes via tmp + rename). On first run with no `.shipped-seen.json`, mark every existing user id and every shipped id already present as seen.
- [ ] **Step 4:** Fill `defaults/*` with what an empty `config/` produces today (read the readers in `server/tools/settings.ts`, `widgets.ts`, `actions.ts`, `projectIcons.ts`): no personal values, no `profile`, no `setup`. If an empty config yields `[]`/`{}`, ship exactly that.
- [ ] **Step 5:** Call `bootstrapConfig(join(paths.repo, 'defaults'), paths.config)` in `server/index.ts` right after `resolvePaths`, log the report at info level.
- [ ] **Step 6:** Tests PASS; start the server against a copy of the owner's `config/` (`CLAUDE_OS_CONFIG=/tmp/cfg-copy`) and diff before/after: only new keys/records, nothing changed.
- [ ] **Step 7:** Commit `feat: shipped defaults with non-destructive config bootstrap`.

### Task 3: Shipped plugins with user override

**Files:**
- Modify: `server/tools/osPlugins.ts:249-260` and its folder listing; `shared/contract.ts` (OS plugin type); `web/src/screens/OsPlugins.tsx` (source badge, optional)
- Move: `config/plugins/{agentation,ide-plus,rg-context}` → `plugins/`
- Modify: `plugins/agentation/plugin.json` (`"author": "Claude OS"`), `plugins/*/plugin.json` authors, `plugins/agentation/skills/agentation-annotations/SKILL.md` (English, no owner name)
- Test: `server/tools/osPlugins.test.ts`

**Interfaces:**
- Produces: `pluginFolders(): { id: string; dir: string; source: 'shipped' | 'user' }[]` (inside `createOsPlugins`); the OS plugin item type gains `source: 'shipped' | 'user'`.

- [ ] **Step 1: Failing tests:**
  - `lists shipped plugins`: plugin only in `<repo>/plugins/p` → listed with `source: 'shipped'`.
  - `user copy shadows a changed shipped plugin`: same id in both; enable the user one; change a file in the shipped copy → still enabled and active, no update pending.
  - `state survives moving a plugin from user to shipped`: enabled in `config/plugins/p`, move folder to `plugins/p` with identical content → still enabled, `activeUi()` returns it.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Add `paths.plugins = join(repo, 'plugins')` in `server/context.ts` (`CLAUDE_OS_PLUGINS` override for tests); merge both folder lists in `osPlugins.ts`, user wins by id; everything else keyed by id stays as is.
- [ ] **Step 4:** Tests PASS.
- [ ] **Step 5 (the owner's install, local):** copy `config/plugins` to `data/backups/plugins-<date>/`; move the three folders to `plugins/`; edit authors and translate the agentation SKILL.md; `diff -r` backup vs new shows only those edits; then re-stamp `tree` for the three ids in `data/os-plugins.json` with the server's `treeHash(folder)` (one-off `node -e` using the exported function; not committed). Verify through `GET` of the OS plugins endpoint that all three are enabled and ide-plus UI is active.
- [ ] **Step 6:** Update the plugin section of `root/CLAUDE.md` (the line "plugins do not ship / `config/plugins/` is not in the release"): shipped examples live in `plugins/`, user plugins in `config/plugins/`, same id → user wins. (Translation of the whole file is Task 7; change only this meaning here.)
- [ ] **Step 7:** Commit `feat: ship example plugins, user copies override by id`.

### Task 4: Profile, paths and the profile prompt block

**Files:**
- Modify: `shared/contract.ts`, `server/context.ts:22-41`, `server/tools/settings.ts`, `server/chat/session.ts:601`, `server/chat/manager.ts:251-285`, create-project code path that reads `paths.newProjectsDir`
- Create: `server/chat/profile.ts`, `server/chat/profile.test.ts`

**Interfaces:**
- Produces:
  - `type QuestionLevel = 'minimal' | 'balanced' | 'thorough'`; `interface Profile { name: string; language: string; projectsDir: string; questionLevel: QuestionLevel }`; `interface SetupState { step: 'checks' | 'onboarding' | 'done'; completedAt: number | null; tabId: string | null }`.
  - `SettingsView` gains `profile: Profile | null`, `setup: SetupState`.
  - `PUT /api/settings/profile  Partial<Profile> -> SettingsView` (validates: non-empty name ≤ 60 chars, language `^[a-z]{2,3}$`, absolute existing writable `projectsDir`, questionLevel enum).
  - `settings.profile(): Profile | null`, `settings.setup(): SetupState`, `settings.saveSetup(patch: Partial<SetupState>): void` on the settings API in `ctx.settings`.
  - `resolveClaudeBin(o: { env: NodeJS.ProcessEnv; pathEnv: string; platform: NodeJS.Platform; home: string; exists: (p: string) => boolean }): string`.
  - `profileBlock(profile: Profile | null, labels: Record<string, string>): string` — empty string when `profile` is null.
- [ ] **Step 1: Failing tests** (`profile.test.ts`):
  - `profileBlock names the user, language and question level`: `{ name: 'Ann', language: 'de', questionLevel: 'minimal', projectsDir: '/p' }` → contains `Ann`, `de`, `minimal`.
  - `profileBlock is empty without a profile`.
  - `resolveClaudeBin order`: env `CLAUDE_OS_CLAUDE_BIN` wins; else first `claude` on PATH (`claude.exe`/`claude.cmd` on `win32`); else `<home>/.local/bin/claude`.
  - settings test `rejects a relative projectsDir` → 400.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. `paths.newProjectsDir` = `CLAUDE_OS_NEW_PROJECTS` ?? `~/Projects`; the create-project path uses `ctx.settings.profile()?.projectsDir ?? paths.newProjectsDir`. Remove the hard-coded personal projects default from `context.ts`. `profileBlock` text (English): who the user is, "reply in <language>", what the question level means (minimal: ask only when blocked; balanced: ask on real ambiguity; thorough: confirm assumptions before larger changes), plus the UI labels block. Append it first in `append` in `session.ts` and add an `append` with it to the two service-session option sets in `manager.ts`.
- [ ] **Step 4:** Labels: import `strings` from `web/src/lib/locales/{ru,en}.ts` on the server; pass `labels` = the subset of keys the prompts mention (collected in Task 7; start with the tab title, Documents, "Edit with Claude", Plugins screen) for `profile.language`, falling back to en.
- [ ] **Step 5:** Tests PASS.
- [ ] **Step 6 (the owner's install, local):** write `profile = { name: '<owner name>', language: 'ru', projectsDir: '<owner's projects dir>', questionLevel: 'balanced' }` and `setup = { step: 'done', completedAt: <now>, tabId: null }` into his `config/settings.json` through `PUT /api/settings/profile` or a one-off edit; restart; root session greets him by name in Russian.
- [ ] **Step 7:** Commit `feat: user profile drives names, language and project folder`.

### Task 5: One language setting and the Profile section

**Files:**
- Modify: `web/src/lib/i18n.ts`, `web/src/screens/SettingsScreen.tsx`, burger menu component (where other screens are listed), `web/src/lib/locales/{ru,en}.ts`
- Test: `e2e/profile.test.ts`

**Interfaces:**
- Consumes: `SettingsView.profile`, `PUT /api/settings/profile` (Task 4).
- Produces: `applyProfileLanguage(profileLang: string | null): void` in `i18n.ts` (sets UI to the catalog for the language or `en`; null keeps the current value).

- [ ] **Step 1: Failing e2e:**
  - `profile language sets the UI`: profile `ru` → home renders ru labels; `PUT` `en` → UI switches to en after reload.
  - `unknown language renders en and keeps profile`: profile `de` → en UI, `GET /api/settings` still returns `de`.
  - `stored localStorage language seeds an empty profile once`: localStorage `ru`, no profile language → after load the server profile has `ru`; changing profile later is not overwritten by localStorage.
- [ ] **Step 2:** Run `node --test e2e/profile.test.ts` → FAIL.
- [ ] **Step 3:** Implement: on boot read settings → `applyProfileLanguage`; the language picker writes `PUT /api/settings/profile { language }`. Settings gets a "Profile" section (name, language, projects folder, question level) with the existing form components; burger menu gets "Run setup again" (calls `POST /api/setup/start`, Task 9; hide until Task 9 lands if executed earlier).
- [ ] **Step 4:** PASS; `npm run build`.
- [ ] **Step 5:** Commit `feat: one language setting for UI and replies, profile in settings`.

### Task 6: Server messages through i18n; Cyrillic that carries behavior

**Files:**
- Modify: `server/chat/session.ts` (`HttpError`, warnings/errors), `server/index.ts:109-112`, `server/chat/manager.ts`, `server/journal/parse.ts`, `server/chat/btw.ts`, `server/memory/state.ts`, user-facing parts of `server/tools/documents.ts`, `shared/contract.ts:454-455`, `web/src/lib/api.ts`, `web/src/lib/chat.ts:195`, `web/src/lib/locales/{ru,en}.ts`, `server/chat/manager.ts:102` (root tab title), `web/src/work/voice/pcm.ts`, `server/voice/engine.ts`, `web/src/work/mentionSources.ts`
- Test: `server/chat/chat.test.ts` (or a new `server/chat/messages.test.ts`), `e2e/chat-render.test.ts`

**Interfaces:**
- Produces: `class HttpError { constructor(statusCode: number, message: string, key?: string, params?: Record<string, string | number>) }`; error body `{ error: string; code?: string; key?: string; params?: Record<string, string | number> }`; ChatEvent `{ e: 'warning' | 'error'; text: string; key?: string; params?: Record<string, string | number> }`; catalog keys `errors.<key>` in both locales.

- [ ] **Step 1: Failing tests:**
  - server: `HttpError carries key and params to the response`: route throwing `new HttpError(404, 'Tab not found', 'tabNotFound')` → body `{ error: 'Tab not found', key: 'tabNotFound' }`.
  - server: `no Russian in user-visible server messages`: `findViolations` (Task 1) over the files listed above returns no `cyrillic` except lines marked `shippable-allow`.
  - e2e: `warning with key renders the catalog text` (ru UI shows the ru string for `errors.compacted`); `warning without key renders its text` (a stored Russian warning shows verbatim).
  - unit: `root tab title follows the UI language`: stored title (the Russian word for Home) or `Home` on a root row renders `t('tabs.root')`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Replace every Russian user-visible message in the listed files with an English `message` + `key` (+ `params`); add `errors.<key>` to `en.ts` and `ru.ts` (ru text = the current Russian string). `api.ts`: `msg = key && has('errors.'+key) ? t('errors.'+key, params) : error`. `chat.ts`: same for events. Keep the ~250 English `httpError` calls and MCP tool result texts as they are.
- [ ] **Step 4:** New root rows get title `Home`; render root tab title via `t('tabs.root')` when the stored title is the Russian word for Home or `Home` (user renames keep working). Voice: command regex and whisper prompt chosen by `profile.language` (ru and en variants). Mentions: accept `@document` and keep the Russian mention token (mark that line `// shippable-allow: chat history compatibility`).
- [ ] **Step 5:** PASS; existing e2e that assert these Russian texts in the ru UI stay green (they read the ru catalog now).
- [ ] **Step 6:** Commit `feat: user-visible server messages via i18n keys`.

### Task 7: English prompts, rules, tool descriptions and comments

**Files:**
- Modify: `root/CLAUDE.md`, `service/CLAUDE.md`, `root/microtasks/*.md` (19), `root/document-knowledge/standard.md`, `server/chat/rootMcp.ts` (`UI_TOOL_RULE`, `PROGRESS_RULE`, tool descriptions, tool result strings), `server/tools/documents.ts:262` (`DOCUMENT_RULE`), other MCP tool files with Russian descriptions, `server/tools/microtasks.ts`, `desktop/main.cjs`, `desktop/windows.mjs`, `desktop/serve.mjs`, every code comment with Russian words or the owner's name (`rg -n "<Cyrillic range>|<owner name>"` over non-test, non-locale files)
- Test: existing tests that assert Russian prompt/tool text are updated to the English text

**Interfaces:**
- Consumes: `profileBlock` labels hook (Task 4): add to the labels list every UI label the translated prompts mention.

- [ ] **Step 1:** Translate faithfully, same structure and rules, no shortening (project 2 shortens). Replace the owner with "the user"; rules that depended on the owner's preferences now refer to the profile (name, language, question level). `standard.md` states that documents are written in the user's language.
- [ ] **Step 2:** `desktop/main.cjs`: labels and start screens from a two-entry table `{ en, ru }` chosen by `app.getLocale()`.
- [ ] **Step 3:** Run `npm run check:shippable` → no `cyrillic`/`private-word`/`home-path` violations left in these files.
- [ ] **Step 4:** `npm test`, `npm run e2e:serial`, `npm run build` green. Live check: root tab answers in Russian to the owner, uses ru UI labels; a temp profile with `language: 'en'` answers in English.
- [ ] **Step 5:** Commit `chore: English prompts, tool texts and comments`.

### Task 8: English manifest

**Files:**
- Read (source, Russian, sections 0–19): `<repo>/data/uploads/58e8a0c3-94cf-44c8-9fbd-c4d92c34dd39/52d9e0b7-claude-code-os-manifest.html` (read-only; never copy anything from `data/` into the repo)
- Create: `docs/manifest/claude-code-os-manifest.html`

- [ ] **Step 1:** Translate the whole HTML to English: same markup, CSS, ids (anchor ids may become English slugs; the TOC links must match), tags (`fact`, `practice`, `idea`, `human decides`), code blocks unchanged except Russian comments/strings inside them.
- [ ] **Step 2:** Verify: `rg -c "<Cyrillic range>" docs/manifest/claude-code-os-manifest.html` → 0; every `href="#…"` has a matching `id`; section count 0–19 equals the source; file opens in Chromium without console errors (Playwright one-off).
- [ ] **Step 3:** Commit `docs: English Claude Code OS manifest`.

### Task 9: First-run setup — server

**Files:**
- Create: `server/tools/setupChecks.ts`, `server/tools/setupChecks.test.ts`, `root/setup/SETUP.md`
- Modify: `server/tools/index.ts` (routes), `server/chat/rootMcp.ts` (setup tools), `server/chat/manager.ts` (`extraOptions` adds setup tools to the setup tab), `shared/contract.ts`

**Interfaces:**
- Consumes: `createAccount(ctx).status(force)` (`server/tools/account.ts`), `resolveClaudeBin`, `settings.profile()/setup()/saveSetup()` (Task 4).
- Produces:
  - `type SetupCheckId = 'claude-binary' | 'claude-version' | 'login' | 'plan' | 'limits' | 'node' | 'git' | 'projects-dir'`; `interface SetupCheck { id: SetupCheckId; status: 'ok' | 'warn' | 'fail'; detail: string | null }` (fix texts live in the web catalogs as `setup.fix.<id>`).
  - `runSetupChecks(deps: SetupCheckDeps): Promise<SetupCheck[]>`; `interface SetupCheckDeps { claudeBin: string; exists(p: string): boolean; claudeVersion(): Promise<string | null>; account(): Promise<AccountStatus>; nodeVersion: string; hasGit(): Promise<boolean>; projectsDir: string | null; writable(p: string): boolean }`; `MIN_CLAUDE_VERSION` and `MIN_NODE = '22.18.0'`, `LIMIT_WARN_PERCENT = 90`.
  - Routes: `GET /api/setup -> { setup: SetupState; profile: Profile | null }`, `GET /api/setup/checks -> SetupCheck[]`, `POST /api/setup/start -> Tab` (409 while any check is `fail`).
  - MCP tools (setup tab only): `save_profile({ name, language, projectsDir, questionLevel })` → validated like `PUT /api/settings/profile`; `complete_setup()` → `setup = { step: 'done', completedAt: now, tabId }`.
- [ ] **Step 1: Failing tests** (`setupChecks.test.ts`, fake deps):
  - `missing binary fails and skips CLI checks`: `exists → false` → `claude-binary: fail`, `claude-version`, `login`, `plan`, `limits` not `ok`.
  - `old version fails`: `claudeVersion → '1.0.0'` → `claude-version: fail`.
  - `logged out fails login`: account `{ plan: null, billing: 'unknown', error: 'not logged in' }` → `login: fail`.
  - `api key counts as a plan`: billing `api` → `plan: ok`.
  - `high limit warns`: active window `percent: 92` → `limits: warn`, detail contains the reset time.
  - `node below floor fails`: `nodeVersion: '22.10.0'` → `node: fail`.
  - `no git warns`: → `git: warn`.
  - route test `start refuses while a check fails` → 409.
  - route test `start reuses the open setup tab`: two `POST /api/setup/start` → same tab id; `setup.step` = `onboarding`.
  - MCP test `save_profile validates and complete_setup finishes`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. `MIN_CLAUDE_VERSION`: the minimum CLI version the installed `@anthropic-ai/claude-agent-sdk` declares (read its package metadata/README at implementation time); if it declares none, use the version currently installed on the owner's machine. `POST /api/setup/start` opens a normal tab (cwd `paths.root`, no project), stores its id in `setup.tabId`, sends `root/setup/SETUP.md` as the first prompt; `extraOptions` adds the two setup tools to that tab's MCP server and `allowedTools`.
- [ ] **Step 4:** `root/setup/SETUP.md` (English, ≤ 60 lines): greet briefly; ask in one `AskUserQuestion` round: name, reply language, projects folder (offer detected candidates: existing dirs with git repos under home), question level, connect existing memory (explain the existing vault move); may read the machine with read-only tools; never edit files; finish with `save_profile`, then `complete_setup`, then a 5-line onboarding text in the chosen language. Write the user's name into `config/private-words.txt` through `save_profile` (server side).
- [ ] **Step 5:** PASS.
- [ ] **Step 6:** Commit `feat: first-run checks and setup session`.

### Task 10: First-run setup — modal

**Files:**
- Create: `web/src/home/SetupModal.tsx`, `e2e/setup.test.ts`
- Modify: `web/src/home/Home.tsx`, burger menu (enable "Run setup again"), `web/src/lib/locales/{ru,en}.ts`, `server/chat/fixtures/fake-claude.mjs` (modes for no-login / high-limit if the account probe needs them)

**Interfaces:**
- Consumes: Task 9 routes.

- [ ] **Step 1: Failing e2e** (`CLAUDE_OS_CONFIG`/`CLAUDE_OS_DATA` temp dirs, fake Claude):
  - `fresh install shows the setup modal`; `Later hides it until the next app start` (reload in the same browser session keeps it hidden; new context shows it).
  - `checks render with fixes and Check again re-runs them` (fake: logged out → `login` fail, Start disabled; switch fake to logged in → Check again → Start enabled).
  - `setup completes and the modal does not return`: Start → setup tab opens → fake Claude calls `save_profile` + `complete_setup` → modal gone after reload, profile saved.
  - `interrupted setup shows Continue`: `setup.step = onboarding`, tab closed → modal shows Continue → opens the same flow.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the modal with existing dialog components and motion; nothing new on the home surface besides the modal; "Later" stored in `sessionStorage`.
- [ ] **Step 4:** PASS; full `npm run e2e:serial`; `npm run build`.
- [ ] **Step 5:** Commit `feat: first-run setup modal`.

### Task 11: Whole-install verification on the owner's machine

- [ ] **Step 1:** Snapshot before (taken at the start of execution, before Task 2): `GET /api/settings`, widgets, OS plugins list with enabled/active, open tabs, `ls vault/projects | wc -l`. After: same calls → identical except the new `profile`/`setup` keys and plugin `source`.
- [ ] **Step 2:** No setup modal for the owner; root tab answers in Russian and addresses him by name; ide-plus panel works.
- [ ] **Step 3:** `npm run typecheck`, `npm test`, `npm run e2e:serial`, `npm run build`, `npm run check:shippable` — all green; `git ls-files | xargs rg -l "<owner name>|<home path>|<personal projects folder>"` → nothing.

### Task 12: Clean public history

Only when the owner decides to publish (not part of this execution unless he asks):

- [ ] **Step 1:** `npm run check:shippable` → 0 violations on `main`; `git checkout --orphan squash`, commit the tree as `Claude OS: shippable core`, `git branch -M squash main` (the old history is dropped from `main`; a backup bundle `git bundle create data/backups/pre-squash.bundle --all` is taken first).
- [ ] **Step 2:** `git branch` lists only `main`; `git worktree list` lists only the main checkout. No remote is added.
