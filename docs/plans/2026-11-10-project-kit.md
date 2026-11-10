# The project kit — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One approved action installs a project kit (lean `CLAUDE.md`, rules, Node hooks, one gate, three agents, five skills, ledgers) into any user project, later kit versions arrive without overwriting user edits, the question level changes behaviour with a server-side cap, and Analytics shows the kit's section 16 metrics before and after.

**Architecture:** A core engine in `server/tools/kit*.ts` detects the stack from files only, renders templates from the enabled shipped plugin `plugins/project-kit/` (new manifest component `contains.kit`, installs nothing globally), plans per-file actions against a committed `.claude/kit/lock.json`, and writes only after the user approves the stored plan on the `kit_apply` permission card. Kit scripts and hooks are dependency-free `.mjs` files driven by the generated `.claude/kit/kit.json`. The question level becomes a profile block plus an `AskUserQuestion` cap in `canUseTool`; metrics are SQL over the journal plus the kit's small files.

**Tech Stack:** Node >= 22.18 (runs `.ts` directly), TypeScript 7 (native), `node --test`, `@anthropic-ai/claude-agent-sdk`, `@modelcontextprotocol/sdk`, zod, React, Playwright, oxlint, `git merge-file`.

**Spec:** `docs/specs/2026-11-10-project-kit.md` (approved; Claude's calls 1, 2 and 4 confirmed by the owner, the rest approved). Plan rulings that fill spec gaps are marked **Ruling** and listed at the end.

## Global Constraints

- **Execution model (accelerated):** each task works on `task/p3-<n>-<slug>` in a worktree under `.worktrees/`, cut from `main`, with `node_modules` symlinked from the main checkout; the controller merges it into `main` and deletes branch and worktree. No per-task reviewer; one whole-project review at the end (Task 10).
- **Done for every task:** focused tests, then `npm test`, `npm run typecheck`, `npm run lint` and `npm run check:lint-ratchet` green in the worktree. Tasks touching `web/` also run `npm run build` in the worktree. Commit messages carry no Claude mention and no `Co-authored-by`.
- **e2e:** only as `flock /tmp/claudeos-e2e.lock npm run e2e` (or `e2e:serial`, or one file through the same npm script), run by the test-runner agent in the background, after `npm run build` in the same worktree.
- **Never build in the main checkout:** the live server serves its `dist/web`. `config/`, `data/`, `vault/` are user data: never edited for a core change, never committed; tests use temp dirs (`makeKit()`).
- **Lint caps only tighten.** These files sit exactly at their `.oxlintrc.json` caps today (measured): `server/tools/osPlugins.ts` 554, `server/chat/session.ts` 764, `server/chat/manager.ts` 613, `server/chat/rootMcp.ts` 463, `server/journal/index.ts` 368, `web/src/screens/Analytics.tsx` 444; `shared/contract.ts` is 990 of 1001; `registerTools` in `server/tools/index.ts` is at its function cap. A task that adds lines there extracts at least as many into a new module in the same task (named per task below) and lowers the cap to the new value. Never raise or add an override; no suppression comments.
- **SHARED files** (`shared/contract.ts`, `server/chat/session.ts`, `server/chat/manager.ts`, `server/chat/rootMcp.ts`, `server/tools/index.ts`, `server/context.ts`): tasks marked **SHARED** are merged one at a time, each rebased on the latest `main` right before merge.
- Linux first; every script and hook is Node (`.mjs` in projects, `.ts` here), no bash or jq. Hooks are fail-open: a hook's own error exits 0 with one warning line.
- English for code, comments, prompts, templates, docs; Cyrillic only in `ru.ts`, `*Ru` fields, `*_ru:` frontmatter and tests. Prompts say "the user"; UI element names in prompts go through `PROMPT_LABELS`.
- Budgets (verbatim from the spec): kit adds <= 3k tokens to starting context; project `CLAUDE.md` <= 60 lines; kit unconditional rules <= 40 lines (`00-workflow.md` + `10-code-standard.md` <= 30, `20-mistakes.md` <= 10); each skill <= 40 lines, `disable-model-invocation: true`; contour A <= 10 s; Stop gate <= 90 s; question block <= 400 B per level inside the 2 KB work-tab append; `metrics.jsonl` <= 1 MB; briefing <= 8 lines; give-up after 3 blocks.
- The kit never runs project code before approval, never edits lint/format/type/test configs, lockfiles, `package.json`/`pyproject.toml`/`go.mod`/`Cargo.toml`, CI, git hooks or git config, and refuses `ctx.paths.repo` and anything inside it (after `realpathSync`).
- `npm test` stays near today's 70 s: kit tests copy fixtures to temp dirs and stub tool lookup; no test runs a project's own toolchain except the live tests in Task 3, which skip when the tool is absent.
- **Order and parallelism:**
  - Task 1 first (controller, tiny, merged before anything else).
  - Wave 1 (parallel, after Task 1): Task 2, Task 3, Task 4 (**SHARED**: `contract.ts`), Task 5 (**SHARED**: `session.ts`, `rootMcp.ts`).
  - Wave 2 (parallel): Task 6 (needs 2, 4), Task 9 (needs 1; **SHARED**: `contract.ts`).
  - Wave 3: Task 7 (needs 3, 6, 9; **SHARED**: `context.ts`, `tools/index.ts`, `contract.ts`).
  - Wave 4: Task 8 (needs 7; **SHARED**: `rootMcp.ts`, `manager.ts`, `contract.ts`).
  - Task 10 last (controller).

## Review Focus

1. A file the kit merged cleanly in an update, then the same kit version re-applied → empty plan, the user's merged lines stay (Task 6 test `re-applying after a clean merge is empty`).
2. A tab in `bypassPermissions` or `auto` mode, where `canUseTool` may not run → `kit_apply` still refuses a plan the user did not approve in the card (Task 8 test `kit_apply refuses a plan the card did not approve`).
3. A project whose `.claude/settings.json` is not valid JSON → that entry is `skip` with the reason, nothing else blocked, the file never rewritten (Task 6 test `invalid settings json is skipped with a reason`).
4. A teammate's checkout: `lock.json` committed, no snapshot in this machine's `data/project-kit/` → an edited kit file is `needs-merge`, never replaced (Task 6 test `edited file without a base snapshot needs a merge`).
5. A project root reached through a symlink into the Claude OS repo, or a `kit.json` that is missing or corrupt when a hook fires → refused at plan time / hook exits 0 with one warning line (Task 7 test `refuses the claude os repo through a symlink`; Task 3 test `a hook with a broken kit json exits 0 with one warning`).

---

### Task 1: Shared kit types (controller, first, no branch needed beyond `task/p3-1-types`)

**Files:**
- Create: `shared/projectKit.ts`

**Interfaces:**
- Produces (every later task imports these names from `shared/projectKit.ts`):
  - `KIT_STACKS = ['ts', 'python', 'go', 'rust'] as const`; `type KitStack`.
  - `KIT_STEPS = ['typecheck', 'lint', 'test', 'build', 'e2e', 'format'] as const`; `type KitStep`.
  - `interface KitCommand { step: KitStep; run: string; cwd: string; from: string }` — `from` is `<file>#<key>` (`package.json#scripts.test`, `Makefile#test`, `pyproject.toml#tool.pytest`) or `PATH:<bin>`.
  - `interface KitSkipped { step: KitStep; skipped: string }` — text `<tool> not found`.
  - `type RelatedMode = 'vitest' | 'jest' | 'node-test' | 'testmon' | 'pytest-name' | 'go' | 'stop' | 'none'`.
  - `type KitAmbiguity = 'package-managers' | 'monorepo' | 'authors'`.
  - `interface KitDetection { stacks: { stack: KitStack; dir: string; runner: string | null }[]; commands: KitCommand[]; skipped: KitSkipped[]; related: { dir: string; mode: RelatedMode }[]; formatter: KitCommand | null; docsDir: 'docs' | 'dev-docs'; generated: string[]; instructions: string[]; ambiguities: KitAmbiguity[]; git: boolean }` — `instructions`: existing instruction files found (spec section 4 list), relative paths.
  - `interface KitAnswers { scope?: 'project' | 'local'; limits?: 'strict' | 'relaxed'; packageManager?: string; protected?: string[] }`.
  - `interface KitConfig { kit: string; stacks: KitDetection['stacks']; commands: KitCommand[]; skipped: KitSkipped[]; related: KitDetection['related']; formatter: KitCommand | null; protected: string[]; limits: { file: number; ui: number; fn: number; complexity: number }; docsDir: string; budgets: { afterEditMs: 10000; stopMs: 90000 } }` — the shape of `.claude/kit/kit.json`.
  - `type KitOwner = 'kit' | 'seed' | 'merged'`; `type KitFileAction = 'add' | 'update' | 'merge' | 'needs-merge' | 'keep' | 'skip' | 'remove' | 'migrate'`.
  - `interface KitPlanFile { path: string; owner: KitOwner; action: KitFileAction; reason: string | null; diff: string }`.
  - `interface KitPlan { planId: string; project: string; root: string; kit: string; action: 'install' | 'update' | 'remove'; files: KitPlanFile[]; skipped: KitSkipped[]; ask: string[]; empty: boolean; approved: boolean }`.
  - `type KitPlanSummary = Omit<KitPlan, 'files'> & { files: Omit<KitPlanFile, 'diff'>[] }`.
  - `interface KitLockEntry { wrote: string; render: string }` (**Ruling R3**); `interface KitLock { kit: string; installedAt: number; sizeAtInstall: number; files: Record<string, KitLockEntry>; settings: { file: string; allow: string[]; deny: string[]; ask: string[]; hooks: string[] } }`.
  - `interface KitStatusReport { kit: { id: string; version: string } | null; projects: Record<string, string | null> }` — installed kit version per project key.
  - `type KitHook = 'protect-files' | 'after-edit' | 'stop-gate' | 'briefing'`; `interface KitHookMetric { hook: KitHook; ms: number; ok: boolean; ts: number }`.
  - `KIT_METRICS = ['startingContext', 'cacheHit', 'subagentShare', 'skillsUsed', 'visibleSkills', 'loopA50', 'loopA90', 'loopB50', 'loopB90', 'redStops', 'filesOverLimit', 'unpromotedMistakes', 'patternDebt', 'questions'] as const`; `type KitMetric`; `interface KitMetricValue { before: number | null; after: number | null }`; `interface KitMetricsRow { project: string; name: string; kit: string; installedAt: number; questionLevel: string | null; metrics: Record<KitMetric, KitMetricValue> }`; `KIT_TARGETS: Record<KitMetric, string>` with the spec's targets verbatim (`< 20k tokens`, `> 85 %`, `< 40 %`, `>= 70 %`, `<= 15`, `< 10 s`, `< 90 s`, `trend down`, `-30 %/month`, `0`, `0`, `minimal ≈ 0`).

- [ ] **Step 1:** Write the file (types and consts only). **Ruling R6:** these live outside `contract.ts`, which has 11 lines of headroom, following `shared/documents.ts` and `shared/plannerItems.ts`.
- [ ] **Step 2:** `npm run typecheck`, `npm run lint` green. Commit `feat: shared types for the project kit`; the controller merges it before Wave 1.

### Task 2: Fixtures and `kitDetect` (Wave 1)

**Files:**
- Create: `server/tools/fixtures/project-kit/{ts-npm-vitest,ts-pnpm-node-test,py-uv-pytest,py-reqs,go,rust,make-only,unknown,existing-claude-md,cursor-rules,agents-md-long,monorepo-ts-py,docs-site}/**`, `server/tools/fixtures/project-kit/expected/<name>.detect.json`, `server/tools/kitFixtures.ts`, `server/tools/kitDetect.ts`, `server/tools/kitDetect.test.ts`

**Interfaces:**
- Consumes: Task 1 types.
- Produces:
  - `copyFixture(name: string): string` in `kitFixtures.ts` — copies to a `mkdtemp` dir, renames `CLAUDE.md.tpl` → `CLAUDE.md` and `claude/` → `.claude/`, runs `git init -q` plus one commit unless the fixture has a `no-git` marker file (removed after copy). Returns the temp root.
  - `onPath(bin: string): boolean` (PATH lookup as `stateOf` does in `osPlugins.ts`, `.exe`/`.cmd` on win32).
  - `kitDetect(root: string, which: (bin: string) => boolean = onPath): KitDetection` — reads files only, spawns nothing but `git log --since=90.days --format=%ae` for the `authors` ambiguity.

- [ ] **Step 1: Fixtures.** **Ruling R1:** fixtures live in `server/tools/fixtures/project-kit/`, not `test/fixtures/`: `server/**/fixtures/**` is already exempt in `.oxlintrc.json` and `check-shippable`. Loadable names are stored as `CLAUDE.md.tpl` and `claude/` so dev sessions never load them; fixture test files are named `*.spec.ts`/`*.spec.js`/`test_*.py` so `npm test`'s `server/**/*.test.ts` glob never runs them. Contents per spec: `ts-npm-vitest` (`package-lock.json`, scripts `typecheck,lint,test`, vitest, prettier config), `ts-pnpm-node-test` (`pnpm-lock.yaml`, `node --test`, `typescript` dep, no typecheck script), `py-uv-pytest` (`uv.lock`, `[tool.pytest]`, `[tool.ruff]`), `py-reqs` (`requirements.txt` only), `go` (`go.mod`, `.golangci.yml`), `rust` (`Cargo.toml`, `rustfmt.toml`), `make-only` (`Makefile` with `test`/`lint`), `unknown` (one `.txt`), `existing-claude-md` (61-line `CLAUDE.md.tpl` with commands, a folder tree, a personal line), `cursor-rules` (`.cursorrules`, `.cursor/rules/api.mdc` with `globs`), `agents-md-long` (`AGENTS.md` 80 lines, `CLAUDE.md.tpl` = `@AGENTS.md`), `monorepo-ts-py` (`web/package.json` + yarn and npm lockfiles, `api/pyproject.toml`), `docs-site` (`mkdocs.yml`, `docs/index.md`).
- [ ] **Step 2: Failing tests** `kitDetect.test.ts` (stub `which` = a fixed set):
  - `detection matches the snapshot for every fixture`: for each of the 13, `kitDetect(copyFixture(n), which)` with `root`-relative paths deep-equals `expected/<n>.detect.json`; `UPDATE_KIT_SNAPSHOTS=1` rewrites them.
  - `every command has a source`: each `command.from` is `PATH:<bin>` with `which(bin)` true, or `<file>#<key>` where the key exists in that file.
  - `a missing tool removes its step and says why`: `go` fixture with `which` lacking `golangci-lint` → no lint command, `skipped` contains `{ step: 'lint', skipped: 'golangci-lint not found' }`.
  - `make targets win over inferred commands`: `make-only` plus a `package.json` with `scripts.test` → test command `from: 'Makefile#test'`.
  - `typescript without a typecheck script gets tsc --noEmit`: `ts-pnpm-node-test` → `{ step: 'typecheck', run: 'pnpm exec tsc --noEmit', from: 'package.json#devDependencies.typescript' }`; related mode `node-test`.
  - `an unknown stack has no steps`: `unknown` → `stacks` `[]`, `commands` `[]`.
  - `a published docs folder moves the kit docs`: `docs-site` → `docsDir: 'dev-docs'`.
  - `two lockfiles and a monorepo are ambiguities`: `monorepo-ts-py` → `ambiguities` includes `package-managers` and `monorepo`; two stacks with dirs `web`, `api`.
  - `detection writes nothing`: tree hash (`treeHash` from `osPlugins.ts`) of the copy is equal before and after.
- [ ] **Step 3:** Run `node --disable-warning=ExperimentalWarning --test server/tools/kitDetect.test.ts` → FAIL (module missing).
- [ ] **Step 4:** Implement per spec section 3 table, one detector function per stack plus `makeTargets`, each <= 50 lines; `kitDetect.ts` <= 300 lines (split a `kitDetectStacks.ts` if needed).
- [ ] **Step 5:** Tests PASS; done-checks green. Commit `feat: project kit stack detection with provenance`.

### Task 3: Kit scripts and hooks (Wave 1)

**Files:**
- Create: `plugins/project-kit/kit/claude/kit/{gate,size,touchpoints,metrics}.mjs`, `plugins/project-kit/kit/claude/kit/hooks/{protect-files,after-edit,stop-gate,briefing}.mjs`, `server/tools/kitScripts.test.ts`

**Interfaces:**
- Consumes: `KitConfig`, `KitHookMetric` (Task 1); shapes generalised from `scripts/gate.ts`, `scripts/check-touchpoints.ts`, `scripts/check-lint-ratchet.ts`, `.claude/hooks/*.mjs`.
- Produces (named exports; each file runs `main()` only when invoked directly; all read `.claude/kit/kit.json` at run time):
  - `metrics.mjs`: `appendMetric(file: string, entry: KitHookMetric, maxBytes = 1048576): void` (drops the oldest half when over); `metricsFile(cwd: string): string` = `<git rev-parse --git-common-dir>/claude-kit/metrics.jsonl`, non-git `<root>/.claude/kit/state/metrics.jsonl`; `failOpen(hook: KitHook, main: () => Promise<number>): Promise<void>` — times the run, appends the metric, on a thrown error prints one `kit <hook>: <message>` line and exits 0.
  - `gate.mjs`: `gateSteps(config: KitConfig): { name: string; run: string | null; builtin: 'size' | 'suppressions' | 'touchpoints' | null }[]` in order typecheck → lint → size → suppressions → touchpoints → unit; `runGate(steps, exec)` as in `scripts/gate.ts`; `SUPPRESSIONS: Record<KitStack, RegExp>` (`@ts-ignore|@ts-expect-error|eslint-disable|biome-ignore`; `# noqa|# type: ignore`; `//nolint`; `#\[allow\(`); `newSuppressions(diff: string, stacks: KitStack[]): string[]` (added lines in code files only, `.claude/kit/` exempt); `defaultBranch(cwd: string): string` (`git symbolic-ref refs/remotes/origin/HEAD`, else `main`, else `master`; never fetches).
  - `size.mjs`: `countLines(text: string): number` (non-blank); `isUi(path: string): boolean` (`.tsx .jsx .vue .svelte`); `isCounted(path: string, generated: string[]): boolean` (tracked source, not tests, not generated); `sizeViolations(o: { counts: Record<string, number>; baseline: Record<string, number>; headBaseline: Record<string, number> | null; limits: { file: number; ui: number } }): string[]`.
  - `touchpoints.mjs`: `touchpointGaps(entries, fs)` with the `Touchpoint` shape of `scripts/check-touchpoints.ts`; empty list → step skipped.
  - `protect-files.mjs`: `protectReason(filePath: string, projectDir: string, config: KitConfig): string | null` — `.env*`, `.git/`, lockfiles, `.claude/kit/**`, `config.protected`.
  - `after-edit.mjs`: `planAfterEdit(file: string, config: KitConfig): { format: string | null; lint: string | null; tests: string | null; deferred: boolean }`; also sets the non-git dirty flag.
  - `stop-gate.mjs`: `fingerprint(o)` and `stopDecision(state, fp, clean)` as in `.claude/hooks/stop-gate.mjs`; state in `<git-dir>/claude-kit/state.json` (`{ green, blocks, slow }`); non-git: `.claude/kit/state/dirty`.
  - `briefing.mjs`: `briefingLines(o)` as in `.claude/hooks/briefing.mjs` (<= 8 lines), handoff dir `<docsDir>/handoff`.

- [ ] **Step 1: Failing tests** `server/tools/kitScripts.test.ts` (imports the `.mjs` files directly; temp git repos):
  - `gate red on a new noqa and a new ts-ignore`: diff with `+x = 1  # noqa` in `a.py` (stacks `['python']`) → 1 hit; `+// @ts-ignore` in `a.ts` (`['ts']`) → 1 hit; `-// @ts-ignore` → `[]`.
  - `size red on growth past the cap and on a raised cap, green on a lowered cap`: limit 300; file 301 not in baseline → violation; baseline `{a.ts: 320}`, count 321 → violation; `headBaseline {a.ts: 320}` vs baseline `{a.ts: 330}` → violation; baseline 310 → `[]`.
  - `ui files get the ui limit`: `x.tsx` 350 lines with `{ file: 300, ui: 400 }` → `[]`.
  - `gate stops at the first red step and skips empty touchpoints`.
  - `the gate over 90 s moves unit tests to the test runner once`: fake `exec` with clock > 90 000 ms → `state.slow` true, one line appended to `<docsDir>/rules/testing.md`, next `gateSteps` run has no `unit` step.
  - `env files and the kit folder are protected`: `.env.local`, `.claude/kit/kit.json`, `package-lock.json` → non-null; `src/a.ts` → null.
  - `after edit defers rust tests to stop`: config with related `{ dir: '.', mode: 'stop' }` → `deferred: true`, `tests: null`.
  - `three red stops give up`: `stopDecision({ green: null, blocks: 3 }, 'b', false)` → `'give-up'`; clean tree → `'skip'`.
  - `a hook with a broken kit json exits 0 with one warning`: spawn `node protect-files.mjs` with corrupt `kit.json` and piped JSON → exit 0, stdout+stderr exactly one line starting `kit protect-files:`.
  - `env file edit is blocked through piped json`: valid `kit.json`, `{ tool_input: { file_path: '<root>/.env' } }` → exit 2.
  - `metrics stay under one megabyte`: 1.2 MB of entries appended → file <= 1 MB, last entry present.
  - `live gate on installed toolchains`: for `go` and `cargo` copies (Task 2 fixtures if merged, else inline), `t.skip('<tool> not found')` when absent; else `node gate.mjs` exit 0.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. No dependencies; `process.execPath` for node children; `shell: process.platform === 'win32'` for project commands; each file <= 300 lines, functions <= 50.
- [ ] **Step 4:** Tests PASS; done-checks green. Commit `feat: project kit gate, size check and hooks`.

### Task 4: Plugin `project-kit` and `contains.kit` (Wave 1, **SHARED**: `contract.ts`)

**Files:**
- Create: `plugins/project-kit/plugin.json`, `plugins/project-kit/kit/files.json`, `plugins/project-kit/kit/CLAUDE.md.tpl`, `plugins/project-kit/kit/claude/rules/{00-workflow,10-code-standard,20-mistakes}.md`, `plugins/project-kit/kit/claude/agents/{reviewer,scout,test-runner}.md`, `plugins/project-kit/kit/claude/skills/{spec,feature,split-file,compound,handoff}/SKILL.md`, `plugins/project-kit/kit/docs/{specs/TEMPLATE.md,plans/README.md,solutions/README.md}`, `plugins/project-kit/kit/docs/rules/{common-mistakes,pattern-candidates,touchpoints,testing}.md`, `plugins/project-kit/kit/docs/rules/touchpoints.json`, `server/tools/osPluginManifest.ts`, `server/tools/kitTemplates.test.ts`
- Modify: `server/tools/osPlugins.ts`, `shared/contract.ts` (`OS_PLUGIN_COMPONENTS`, `OsPluginContents.kit`, `OsPluginChange.kind`), `root/reference/plugins.md`, `docs/rules/touchpoints.json`, `docs/rules/touchpoints.md`, `server/tools/osPlugins.test.ts`, `web/src/screens/PluginPage.tsx` (show the kit component, if it lists components), `.oxlintrc.json` (lower `osPlugins.ts` caps)

**Interfaces:**
- Produces:
  - `export const OS_PLUGIN_COMPONENTS = ['skills', 'hooks', 'mcp', 'ui', 'kit'] as const` in `contract.ts`; `validateManifest` checks `contains` keys against it; `OsPluginContents.kit: string | null`; `OsPluginChange.kind` gains `'kit'`.
  - `Manifest.kit: string | null` — `contains.kit` must be `"kit"` and `kit/files.json` must exist; a plugin with only `kit` is not "contains lists nothing".
  - `createOsPlugins(...)` returns `{ allows, activeKit }`; `activeKit(): { id: string; dir: string; version: string } | null` — the enabled plugin with a kit whose tree hash equals the installed tree (same rule as `activeUi`); enabling adds one change `{ kind: 'kit', action: 'add', name, where: <folder>, detail: 'project kit actions' }` and writes nothing outside `data/os-plugins.json`.
  - `interface KitTemplate { path: string; owner: 'kit' | 'seed'; stacks?: KitStack[]; when?: 'git' | 'tests' | 'migrate' }` — rows of `kit/files.json`.
  - Template placeholders `{{name}}` filled by Task 6 from `kitVars()`: `{{commands}}`, `{{gate}}`, `{{docsDir}}`, `{{testing}}`, `{{limits}}`.

- [ ] **Step 1: Make room.** Move `validateManifest`, `readDependencies`, `walk`, `treeHash`, `Manifest`, `HookSpec`, `ServerSpec`, `UiSpec`, `DependencySpec` and their consts into `server/tools/osPluginManifest.ts`; `osPlugins.ts` re-exports `validateManifest`, `treeHash`, `MANIFEST`, `type Manifest`. Behaviour unchanged: `node --disable-warning=ExperimentalWarning --test server/tools/osPlugins.test.ts` green before the next step.
- [ ] **Step 2: Failing tests:**
  - `osPlugins.test.ts` `a kit component validates and installs nothing globally`: temp plugin with `contains: { kit: 'kit' }` and `kit/files.json` → manifest `kit: 'kit'`; enable → `~/.claude/settings.json` and `skills/` unchanged (byte compare of the temp `claudeDir`), `activeKit()` returns it; change the folder → `activeKit()` null until update.
  - `osPlugins.test.ts` `contains kit without files json is an error`; `an unknown component is still rejected` (`contains.foo`).
  - `kitTemplates.test.ts` `templates fit their budgets`: `CLAUDE.md.tpl` <= 60 lines; `00-workflow.md` + `10-code-standard.md` <= 30 lines; `20-mistakes.md` <= 10; each `SKILL.md` <= 40 lines, `disable-model-invocation: true`, `name` = dir; each agent's frontmatter `name` = file stem; models `inherit`, `haiku`, `sonnet` for reviewer, scout, test-runner.
  - `kitTemplates.test.ts` `no template has a loadable name`: no path under `plugins/project-kit/kit/` contains `.claude/` or ends in `CLAUDE.md`/`CLAUDE.local.md`; every `files.json` path exists; the real plugin passes `validateManifest`.
  - `kitTemplates.test.ts` `workflow rule names the always-ask list`: `00-workflow.md` contains the spec line "always ask, at any question level: push or remotes, deleting data, a new dependency, lint/format/CI config".
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Write `plugin.json` (`id: project-kit`, version `1.0.0`, `contains: { kit: 'kit' }`, `description`/`descriptionRu`, `features`/`featuresRu`; Russian texts follow the terms already used in `ru.ts` for plugins). Templates generalise Project 2's files: rules from `.claude/rules/00-workflow.md` and `10-code-standard.md` (size limit + ratchet, no suppressions, comments say why); agents from `.claude/agents/*` with commands from `kit.json`; skills from `.claude/skills/{spec,feature,split-file,compound,handoff}` (use superpowers skills when installed, inline steps otherwise; `/spec` behaviour per question level as spec section 6); docs from `docs/specs/TEMPLATE.md`, `docs/solutions/README.md`, ledger headers. `CLAUDE.md.tpl` sections: Commands, How we work, Gotchas, Decisions not in code, Pointers; empty ones as `<!-- -->`.
- [ ] **Step 5:** `validateManifest` + `OS_PLUGIN_COMPONENTS`; `contentsOf`, `planEnable`, `activeKit`; `root/reference/plugins.md`: one paragraph on `kit` (installs nothing globally, shows the "Project kit…" actions, templates in `kit/`, user copy in `config/plugins/project-kit` wins). `touchpoints.json` entry `plugin-components` (`source: shared/contract.ts`, members of `OS_PLUGIN_COMPONENTS`, `registries: ['root/reference/plugins.md']`); a row in `touchpoints.md`. Lower the `osPlugins.ts` caps to the new values.
- [ ] **Step 6:** Tests PASS; `npm run check:touchpoints`, `npm run check:shippable`, done-checks, `npm run build` green. Commit `feat: project-kit plugin with a kit component that installs nothing globally`.

### Task 5: Question level block and cap (Wave 1, **SHARED**: `session.ts`, `rootMcp.ts`)

**Files:**
- Create: `server/chat/questionCap.ts`, `server/chat/questionCap.test.ts`, `server/chat/inbox.ts`, `scripts/question-level-probe.ts`, `scripts/question-level-probe.test.ts`
- Modify: `server/chat/profile.ts` (`QUESTION_LEVELS`, `profileBlock`), `server/chat/session.ts` (`canUseTool`, user-message push points; `Inbox` moved out), `server/chat/probe.ts`, `server/tools/admin.ts` (import `Inbox` from `./inbox.ts`), `server/chat/rootMcp.ts` (`PROGRESS_RULE`), `server/chat/profile.test.ts`, `server/chat/promptBudget.test.ts`, `server/chat/chat.test.ts`, `server/chat/fixtures/fake-claude.mjs`, `.oxlintrc.json` (lower `session.ts` caps)

**Interfaces:**
- Produces:
  - `QUESTION_LEVELS: Record<QuestionLevel, string>` = the spec section 6 texts verbatim (minimal, balanced, thorough); `profileBlock` replaces the one-line `Question level: …` with `Question level: <level>. <text>`.
  - `QUESTION_CAPS: Record<QuestionLevel, number | null> = { minimal: 1, balanced: 2, thorough: null }`.
  - `questionDenial(level: QuestionLevel | null, asked: number): string | null` — `asked` = `AskUserQuestion` calls already allowed since the last user message; over the cap returns `Question level <level>: decide, state the assumption, continue.`; null level → null.
  - `TabSession`: private counter reset where a user message is pushed into the inbox (the two `input.push` sites carrying user content, not `/clear`); `canUseTool` denies before creating a pending entry.
  - `PROBE_PROMPTS: { id: 'clear' | 'ambiguous-reversible' | 'ambiguous-irreversible'; text: string }[]`; `probeVerdict(counts: Record<QuestionLevel, Record<string, number>>): string[]` — empty when minimal <= balanced <= thorough per prompt and minimal = 0 on the first two.

- [ ] **Step 1: Make room:** move `Inbox` to `server/chat/inbox.ts`; update the three importers; lower `session.ts` `max-lines` and `max-classes-per-file` caps.
- [ ] **Step 2: Failing tests:**
  - `profile.test.ts` `each level has its own block under 400 bytes`: for each level `profileBlock(...)` contains `QUESTION_LEVELS[level]`, the three blocks differ, `Buffer.byteLength(QUESTION_LEVELS[l]) + 40 <= 400`.
  - `questionCap.test.ts` `caps per level`: `questionDenial('minimal', 1)` = `'Question level minimal: decide, state the assumption, continue.'`; `('minimal', 0)` null; `('balanced', 1)` null; `('balanced', 2)` non-null; `('thorough', 50)` null; `(null, 9)` null.
  - `promptBudget.test.ts` `work tab append fits 2 KB at every level`: the existing test looped over the three levels.
  - `chat.test.ts` `question level caps AskUserQuestion per user message`: profile minimal; fake command `TOOLS 2 AskUserQuestion <json>` → first emits `question`, second's `tool_result` is an error with the deny text and no second `question` event; a new user message → a question is allowed again. Balanced: third denied.
  - `question-level-probe.test.ts` `probe verdict`: monotone counts with minimal 0 on the first two → `[]`; minimal 1 on `clear` → one message.
- [ ] **Step 3:** Run → FAIL.
- [ ] **Step 4:** Implement. `fake-claude.mjs`: `TOOLS <n> <name> <json>` calls the tool n times in one turn. **Ruling R2:** the work-tab append is 2027 B today; the larger block does not fit, so `PROGRESS_RULE` is cut to one sentence (its guidance is already in the `report_progress` description). If any level is still over 2048 B, stop and report the byte breakdown.
- [ ] **Step 5:** `scripts/question-level-probe.ts` (SDK, `model: 'haiku'`, cwd = `copyFixture('ts-npm-vitest')` once Task 2 is on `main`, else a temp dir with one `package.json`; `systemPrompt.append` = `profileBlock` for the level; `canUseTool` answers `AskUserQuestion` with each question's first option, applies `questionDenial`, counts calls). Not run in `npm test`.
- [ ] **Step 6:** Tests PASS; done-checks green. Commit `feat: question level as behaviour with a per-message cap`.

### Task 6: Render, lock and the update decision (Wave 2)

**Files:**
- Create: `server/tools/kitRender.ts`, `server/tools/kitMerge.ts`, `server/tools/kitSettings.ts`, `server/tools/kitRender.test.ts`, `server/tools/kitMerge.test.ts`

**Interfaces:**
- Consumes: `kitDetect`, `copyFixture` (Task 2); `KitTemplate`, templates (Task 4); Task 1 types.
- Produces:
  - `targetPath(templatePath: string, docsDir: string): string` — `claude/` → `.claude/`, `CLAUDE.md.tpl` → `CLAUDE.md`, leading `docs/` → `<docsDir>/`.
  - `kitConfig(d: KitDetection, answers: KitAnswers, version: string): KitConfig` — `limits` strict `{ file: 300, ui: 400, fn: 50, complexity: 10 }`, relaxed `{ file: 400, ui: 400, fn: 80, complexity: 15 }` (**Ruling R5**); `protected` = `d.generated` + `answers.protected`.
  - `renderKit(kitDir: string, d: KitDetection, answers: KitAnswers, version: string): Map<string, { owner: 'kit' | 'seed'; content: string }>` — includes `.claude/kit/kit.json` (owner kit) and `.claude/kit/size-baseline.json` (seed: files over the limit now, with their counts as caps); skips templates whose `stacks`/`when` do not match.
  - `mergeSettings(current: string | null, kit: { hooks: Record<string, unknown[]>; allow: string[]; deny: string[]; ask: string[] }, prev: KitLock['settings'] | null): { content: string; added: KitLock['settings'] } | { invalid: string }` — kit hook entries recognised by `.claude/kit/` in the command are replaced in place, other entries and keys untouched and in order; permission strings appended only when absent; `deny` includes `Edit(./.claude/kit/**)`, `ask` includes `Bash(git push*)`, `allow` = detected commands + `git status/diff/log`.
  - `unmergeSettings(current: string, added: KitLock['settings']): string`; `mergeGitignore(current: string | null): string` / `unmergeGitignore(current: string): string` with the `# claude-os-kit:start` / `# claude-os-kit:end` block (`CLAUDE.local.md`, `.claude/settings.local.json`, `<docsDir>/handoff/`).
  - `mergeThree(current: string, base: string, next: string): { clean: boolean; content: string }` — `git merge-file -p` on temp files (exit 0 clean, > 0 conflict, < 0 treated as conflict).
  - `snapshotPath(data: string, version: string, renderSha: string): string` = `<data>/project-kit/<version>/<renderSha>`; `saveSnapshot`, `readSnapshot(...): string | null`.
  - `decideFile(o: { owner: 'kit' | 'seed'; lock: KitLockEntry | null; disk: string | null; render: string; base: string | null }): { action: KitFileAction; content: string | null; reason: string | null }`.

- [ ] **Step 1: Failing tests** `kitMerge.test.ts` — the decision table (pure, `sha` = sha256):

| owner | lock | disk | outcome |
|---|---|---|---|
| any | none | absent | `add`, content = render |
| any | none | present | `keep`, reason `exists and is not the kit's` |
| any | entry | absent | `skip`, reason `deleted by the user` (forever) |
| seed | entry | present | nothing (omitted) |
| kit | `lock.render == sha(render)` | present | nothing (same render, edited or not) |
| kit | `lock.render != sha(render)` | `sha(disk) == lock.render` | `update`, content = new render |
| kit | `lock.render != sha(render)` | `sha(disk) != lock.render`, base snapshot found | `mergeThree(disk, base, render)`: clean → `merge` with merged content; conflict → `needs-merge`, content null |
| kit | `lock.render != sha(render)` | `sha(disk) != lock.render`, no base snapshot | `needs-merge`, reason `no base snapshot on this machine` |

  Tests: one `it` per row; plus `re-applying after a clean merge is empty` (merge, record `{ wrote: sha(merged), render: sha(render) }`, decide again with the same render → omitted), `edited file without a base snapshot needs a merge`, `invalid settings json is skipped with a reason` (`mergeSettings('{', …)` → `{ invalid }`), `settings keep the user's keys and order` (user `{ model, permissions: { allow: ['Bash(ls)'] }, hooks: { Stop: [userEntry] } }` → keys in the same order, `userEntry` first, kit entry after, re-merge byte-identical), `remove takes only what the kit added` (`unmergeSettings` leaves `Bash(ls)` and `userEntry`), `gitignore block is replaced, not duplicated`, `real git merge-file merges a non-overlapping edit and flags an overlapping one`.
- [ ] **Step 2: Failing tests** `kitRender.test.ts`: `renders loadable names from template names` (`targetPath('claude/rules/00-workflow.md', 'docs')` = `.claude/rules/00-workflow.md`; `docs/specs/TEMPLATE.md` with `dev-docs` → `dev-docs/specs/TEMPLATE.md`); `rendered claude md is at most 60 lines and every command is detected` for each fixture; `size baseline lists files over the limit with their counts`; `kit json records skipped tools` (`go` without golangci-lint → `skipped` entry).
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement (each file <= 300 lines). **Step 5:** Tests PASS; done-checks green. Commit `feat: project kit render, settings merge and the update decision`.

### Task 7: Plan, apply, remove and migration (Wave 3, **SHARED**: `context.ts`, `tools/index.ts`, `contract.ts`)

**Files:**
- Create: `server/tools/kitPlan.ts`, `server/tools/kitApply.ts`, `server/tools/projectKit.ts`, `server/tools/kitPlan.test.ts`, `server/tools/kitApply.test.ts`
- Modify: `server/context.ts` (`kit?: KitApi` on `Ctx`), `server/tools/index.ts` (`registerTools`: `ctx.kit = createProjectKit(ctx, osPlugins.activeKit)`; make room by moving `tabCwd` to module scope as `tabCwd(ctx: Ctx, id: string)`), `shared/contract.ts` (`Topic` gains `'projectKit'`; route comment lines)

**Interfaces:**
- Consumes: Tasks 2, 3 (gate CLI), 4 (`activeKit`), 6; `registerKitMetrics` (Task 9), called once from `createProjectKit`.
- Produces:
  - `planKit(o: { root: string; project: string; kit: { dir: string; version: string }; data: string; action: 'install' | 'remove'; answers: KitAnswers; claudeMd?: string; rules?: Record<string, string>; level: QuestionLevel | null }): { plan: KitPlan; hashes: Record<string, string | null>; writes: Map<string, string | null> }` — install/update decides every rendered path with `decideFile`, merged files with Task 6; files in the old lock not rendered any more → `remove` when hash matches, else `keep`; remove = kit files whose disk hash equals `lock.wrote` + `unmergeSettings` + `unmergeGitignore`; seeds stay.
  - `askFor(level: QuestionLevel | null, d: KitDetection): string[]` — minimal `[]`; balanced: one line per `d.ambiguities` (`authors` → settings scope project vs local); thorough: those plus limits `300/50/10 vs 400/80/15` and protected paths.
  - `validateClaudeMd(draft: string, d: KitDetection, sources: string[]): string | null` — `> 60` lines → `CLAUDE.md has 61 lines; the limit is 60`; a backticked command in the Commands section that equals no `d.commands[].run` and occurs literally in no source file → `not a detected command: <line>`.
  - `migrationSources(root: string): string[]` (spec section 4 list); the `CLAUDE.md` entry is `migrate` when any exists; `AGENTS.md`, `.cursorrules`, `.cursor/rules/*`, the Copilot file never appear as writes; `@AGENTS.md` kept only when `AGENTS.md` <= 60 lines, else the reason line `AGENTS.md is over 60 lines: its facts were merged and the import dropped`.
  - `staleReason(hashes: Record<string, string | null>, root: string): string | null` — **the stale-plan check**: for every target path recompute `sha256(file)` (null when absent) plus the hashes of `lock.json` and the kit tree; any difference → `stale plan: <path> changed; call kit_plan again`.
  - `applyKit(plan: StoredPlan, deps: { data: string; audit: Ctx['audit']; gate: (root: string) => Promise<string> }): Promise<{ written: string[]; gate: string }>` — write order: docs → rules/skills/agents → `.claude/kit/*.mjs` → `kit.json` → `lock.json` → `.gitignore` → settings last; each write `backupFile` + `ctx.audit('project.kit.apply', <path>, <diff>)`; snapshots saved for every kit render; on an error the lock is written for what was written, then the error is rethrown.
  - `type StoredPlan = { plan: KitPlan; hashes: Record<string, string | null>; writes: Map<string, string | null>; tabId: string | null }`.
  - `interface KitApi { status(): KitStatusReport; plan(tabId: string, input: { action?: 'install' | 'remove'; claudeMd?: string; rules?: Record<string, string>; answers?: KitAnswers }): KitPlanSummary; get(planId: string): KitPlan; approve(planId: string): void; apply(planId: string): Promise<string> }` from `createProjectKit(ctx: Ctx, activeKit: () => { id: string; dir: string; version: string } | null): KitApi`. Root = `ctx.chat.tabInfo(tabId).cwd`, project = `ctx.journal.projectForCwd(root)`; refuses `realpathSync(root)` inside `realpathSync(ctx.paths.repo)` (422) and a missing active kit (409 `enable the project-kit plugin first`). One stored plan per project; `apply` rejects an unapproved plan (403) and a stale one (409); `ctx.invalidate('projectKit')` after apply.
  - Routes: `GET /api/project-kit/status` → `KitStatusReport`; `GET /api/project-kit/plans/:id` → `KitPlan`; `POST /api/project-kit/plans/:id/approve` → `{ ok: true }` (**Ruling R4**).

- [ ] **Step 1: Failing tests** `kitPlan.test.ts` and `kitApply.test.ts` (fixtures via `copyFixture`, stub `gate` returning `'gate: green'`):
  - `plan snapshot per fixture`: action and path list (no diffs) deep-equal `expected/<n>.plan.json`.
  - `apply then re-plan is empty` for all 13 fixtures: second `plan.empty` true.
  - `every byte outside the plan is unchanged`: tree of the copy minus plan paths byte-identical; `package.json`, lockfiles, lint configs identical; `git config --list --local` output identical.
  - `other tools' instruction files stay byte-identical`: `cursor-rules`, `agents-md-long`.
  - `nothing is written before apply`: tree hash after `planKit` = before.
  - `update merges, flags, keeps deletions and seeds`: install v1; edit `.claude/rules/00-workflow.md` (non-overlapping), delete `.claude/skills/handoff/SKILL.md`, edit `CLAUDE.md`; plan with a v1.1 kit dir whose rule changed elsewhere → rule `merge`, skill absent from writes, `CLAUDE.md` absent; an overlapping edit → `needs-merge` and the file untouched after apply.
  - `remove takes only hash-matching kit files`: edited agent stays, seeds stay, settings keep user entries.
  - `a claude md draft with an invented command or 61 lines is rejected with the line`.
  - `a stale plan is rejected`: edit a target between plan and apply → 409 naming the path.
  - `refuses the claude os repo through a symlink`: root = symlink to `paths.repo` subfolder → 422.
  - `balanced asks about two package managers, minimal asks nothing`: `monorepo-ts-py`.
  - `non-git folder gets a dirty-flag stop gate`: copy with `no-git` → `kit.json` and settings render; apply works.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; `kitPlan.ts` and `kitApply.ts` <= 300 lines each. **Step 4:** Tests PASS; done-checks green. Commit `feat: project kit plan, approval, apply and remove`.

### Task 8: MCP tools, microtask, card, menu and setup panel (Wave 4, **SHARED**: `rootMcp.ts`, `manager.ts`, `contract.ts`)

**Files:**
- Create: `server/chat/kitTools.ts`, `server/chat/kanbanTools.ts` (room in `rootMcp.ts`), `root/microtasks/project-kit.md`, `web/src/work/KitPlanCard.tsx`, `web/src/work/KitStatusRow.tsx`, `web/src/lib/projectKit.ts`, `e2e/project-kit.test.ts`
- Modify: `server/chat/rootMcp.ts` (`createPlannerMcp` adds `...kitTools(ctx, tabId)`; the five kanban tool factories move to `kanbanTools.ts`), `server/chat/manager.ts:320` (allowed list gains `` `mcp__${ROOT_MCP_NAME}__kit_plan` `` on the same line), `server/tools/microtasks.ts` (`'project-kit': 'owner'`), `server/chat/mcpTools.test.ts` (`PROMPTED_TOOLS.work` and `.setup` gain `'kit_apply'` with a comment why), `web/src/work/RequestCards.tsx` (export `useRespond`, `CardShell`, `Resolved`; `RequestCard` routes `tool === 'mcp__claude-os__kit_apply'` to `KitPlanCard`), `web/src/work/ProjectSetupPanel.tsx` (one `<KitStatusRow>`), `web/src/home/ProjectMenu.tsx` (one item), `web/src/screens/ProjectPage.tsx` (one `<KitStatusRow>`, the spec's kit status on the project page), `web/src/lib/locales/{en,ru}.ts`, `root/reference/plugins.md` (one line: the root tab hands "project kit" requests to `open_session` in that project), `.oxlintrc.json` (lower `rootMcp.ts` cap)

**Interfaces:**
- Consumes: `KitApi` via `ctx.kit` (Task 7).
- Produces:
  - `kitTools(ctx: Ctx, tabId: string)` → `kit_plan({ action?: 'install' | 'remove'; claudeMd?: string; rules?: Record<string, string>; answers?: KitAnswers })` returning the `KitPlanSummary` as compact text (counts per action, paths, skipped tools, `ask` lines, `nothing to do` when empty); `kit_apply({ planId: string })` returning written count plus the gate output clipped to 60 lines. Descriptions carry the flow (plan, ask only the `ask` lines, then `kit_apply`; never retry a denied apply).
  - `kit_apply` refuses an unapproved plan with `not approved: the plan card appears only when the tab asks for permissions; switch the tab to the Default mode and call kit_apply again`.
  - `KIT_APPLY_TOOL = 'mcp__claude-os__kit_apply'` and `kitMenuLabel(projectKey: string): string` in `web/src/lib/projectKit.ts` (status cache from `GET /api/project-kit/status`, refreshed on topic `projectKit`; label "Project kit…" plus `not installed`, `v<x>` or `update to v<y>`; the item is hidden when `kit` is null).
  - `KitPlanCard({ item, tabId })`: file list grouped by action, each diff collapsed (`Diff` component), "nothing to do" when `empty`; Apply = `POST …/approve` then `respond({ kind: 'permission', allow: true })`; Reject = deny.
  - `KitStatusRow({ project, root })` in the setup panel: status + "Project kit…" button = `runMicrotask({ id: 'project-kit', project, title, vars: { root } })`; the menu item does the same.
  - Locale keys `kit.*` (en and ru).

- [ ] **Step 1: Failing tests:**
  - `mcpTools.test.ts`: the updated `PROMPTED_TOOLS`; `prompts name only existing tools` covers `project-kit.md`.
  - `server/chat/kitTools.test.ts` `kit_plan returns a summary and kit_apply refuses a plan the card did not approve`: `makeKit()` ctx with a stub `ctx.kit`; `kit_plan` text contains the counts; `kit_apply` on an unapproved plan → error text above; after `approve` → calls `apply`.
  - `kit_apply is never allowed`: no session kind's `allowedTools` contains `kit_apply`.
  - `npm run check:touchpoints` red until `root/microtasks/project-kit.md` exists.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. `project-kit.md`: frontmatter `title: Project kit`, `title_ru`; body: run `kit_plan`, ask only what the summary's `ask` lists, draft `CLAUDE.md` when an entry is `migrate` (spec section 4 rules), then `kit_apply`, then show the gate output. **Ruling R9:** the setup tab gets the tools too, since it shares `createPlannerMcp`.
- [ ] **Step 4:** `e2e/project-kit.test.ts` (fake Claude, temp project): the menu item and the setup-panel row show `not installed`; a `TOOL mcp__claude-os__kit_apply {"planId":…}` turn shows the card with the file list; Apply → `resolved` `allow`.
- [ ] **Step 5:** Done-checks, `npm run build` in the worktree; the test-runner agent runs `flock /tmp/claudeos-e2e.lock npm run e2e -- e2e/project-kit.test.ts` in the background → green. Commit `feat: project kit tools, microtask, approval card and project actions`.

### Task 9: Kit metrics endpoint and Analytics section (Wave 2, **SHARED**: `contract.ts`)

**Files:**
- Create: `server/tools/kitMetrics.ts`, `server/tools/kitMetrics.test.ts`, `web/src/screens/KitAnalytics.tsx`, one extracted component file from `Analytics.tsx` (room)
- Modify: `web/src/screens/Analytics.tsx` (one import, one `<KitAnalytics from to />`), `shared/contract.ts` (route comment), `web/src/lib/locales/{en,ru}.ts`, `.oxlintrc.json` (lower `Analytics.tsx` cap). The route is registered by `createProjectKit` in Task 7, which calls `registerKitMetrics`

**Interfaces:**
- Consumes: `KitLock`, `KitMetricsRow`, `KIT_METRICS`, `KIT_TARGETS`, `KitHookMetric` (Task 1); journal tables `usage_messages`, `tool_calls`, `subagents`, `sessions` (`server/journal/db.ts`).
- Produces:
  - `kitProjects(projects: { key: string; name: string; root: string }[]): { key: string; name: string; root: string; lock: KitLock }[]` — projects whose `.claude/kit/lock.json` parses.
  - `kitMetrics(db: DatabaseSync, p: { key: string; name: string; root: string; lock: KitLock }, range: { from: string; to: string }, level: QuestionLevel | null): KitMetricsRow` — before = 14 days before `installedAt`, after = `max(installedAt, from)`..`to`: starting context = median of `input + cache_read + cache_write` of each session's first main message; cache hit (main) = `cache_read / (input + cache_read + cache_write)` with `is_subagent = 0`; subagent share = subagent tokens / total; skills used = distinct `tool_calls.skill` in 30 days / skill dirs in `.claude/skills`; visible = model-visible skills + agents; loop A/B = p50/p90 `ms` of `after-edit` / `stop-gate` from `metrics.jsonl`; red stops = `stop-gate` `ok:false` per session; files over limit = `size-baseline.json` entries now vs `lock.sizeAtInstall`; unpromoted mistakes = `common-mistakes.md` rows with Seen >= 2 and an empty enforcement cell; pattern debt = `pattern-candidates.md` rows older than 21 days without a form; questions = `AskUserQuestion` calls per session.
  - `registerKitMetrics(ctx: Ctx): void` registers `GET /api/analytics/kit?from&to` → `KitMetricsRow[]`, same range validation as `/api/analytics`, cached per range and dropped on the bus events `sessions-changed` and `turn-finished`; no Claude call.

- [ ] **Step 1: Failing tests** `kitMetrics.test.ts` (`:memory:` db seeded with `usage_messages`/`tool_calls`, temp project with lock, `metrics.jsonl`, ledgers):
  - `before and after split at installedAt` (rows on both sides → both numbers; nothing before → `before: null`).
  - `cache hit counts main messages only`: subagent rows excluded.
  - `starting context is the median of first main messages`.
  - `loop times are p50 and p90 of the hook metrics`.
  - `ledger debts count rows by the spec rules`.
  - `a project without a lock is not listed`.
  - `the route rejects a bad range` (`app.inject`, 400).
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement; `KitAnalytics.tsx`: one table per project, metric / before / after / target (`KIT_TARGETS`), nothing on the home surface. **Ruling R8:** "Questions … by question level" is shown with the current profile level (`questionLevel` on the row); the journal keeps no level history, so the per-level comparison is the Task 5 probe.
- [ ] **Step 4:** Tests PASS; done-checks, `npm run build` in the worktree. Commit `feat: project kit metrics in Analytics`.

### Task 10: Probes, verification and the whole-project review (controller)

**Files:**
- Create: `scripts/kit-context-probe.ts` (one tiny SDK query per cwd, like `scripts/memory-token-probe.ts`; exported `contextDelta(before: number, after: number): number`, tested in `scripts/kit-context-probe.test.ts`)
- Modify: `docs/rules/testing.md` (kit test timings), `docs/rules/touchpoints.md` (MCP kit tools row) — in a last task branch, merged

- [ ] **Step 1:** On `main` (main checkout, no build): `npm run gate` green, wall time <= 90 s recorded; if over, report which kit test files cost the time.
- [ ] **Step 2: Context probe:** temp copy of `ts-npm-vitest`, kit applied through `planKit` + `applyKit` (stub gate); `scripts/kit-context-probe.ts` before and after → delta <= 3000 tokens; `claude -p --model haiku "/context"` in the after copy lists `CLAUDE.md` and three rules, no kit skill descriptions. From the repo root: `claude -p --model haiku "Read plugins/project-kit/kit/claude/rules/00-workflow.md and plugins/project-kit/kit/CLAUDE.md.tpl, then quote every instruction you have that was loaded from a file under plugins/"` → none.
- [ ] **Step 3: Question-level probe:** `node --disable-warning=ExperimentalWarning scripts/question-level-probe.ts` → 3 prompts × 3 levels table; `probeVerdict` empty. Record the table.
- [ ] **Step 4:** Scratch worktree with `npm run build`; the test-runner agent runs `flock /tmp/claudeos-e2e.lock npm run e2e` in the background → green (known flake noted in `testing.md` excepted).
- [ ] **Step 5: Live flow** (after the owner restarts the server): enable `project-kit` on the plugins screen → no change in `~/.claude`; "Project kit…" on a scratch project (not a real one) → one card, Apply, gate output in the tab; re-run → card says nothing to do; terminal `claude` in that project sees the files and hooks.
- [ ] **Step 6:** One `reviewer` agent run with the spec path and the base commit (`main` before Task 1): Goals 1–7, Anti-goals, Verification, touchpoints (`contains.kit`, `project-kit` microtask, `kit_plan`/`kit_apply` + `PROMPTED_TOOLS`, `projectKit` topic and routes, ru/en, `QUESTION_LEVELS` budget, Analytics). Fix findings in task branches, re-run the gate, merge.

## Plan rulings for the owner

- **R1** Fixtures in `server/tools/fixtures/project-kit/` (spec: `test/fixtures/`), loadable names stored as `CLAUDE.md.tpl`/`claude/`, fixture tests named `*.spec.*`.
- **R2** The work-tab append is 2027 of 2048 B today; to fit the question block, `PROGRESS_RULE` shrinks to one sentence.
- **R3** Lock entries hold `{ wrote, render }`, not one hash: with one hash, re-applying after a clean merge would either overwrite the user's lines or never be empty. Snapshots are content-addressed under `data/project-kit/<version>/`.
- **R4** Besides the permission card, `kit_apply` requires a server-side approval that only the card's Apply button sets (`POST /api/project-kit/plans/:id/approve`): in `bypassPermissions`/`auto` modes `canUseTool` may not run.
- **R5** "relaxed" limits = file 400, UI 400; function and complexity values go only into `kit.json` for `/promote`.
- **R6** Kit types live in `shared/projectKit.ts`; `contract.ts` has 11 lines left under its cap.
- **R7** At-cap files get extractions in the same task: `osPluginManifest.ts`, `inbox.ts`, `kanbanTools.ts`, one `Analytics.tsx` component, `tabCwd` to module scope.
- **R8** "Questions by level" uses the current level; the journal has no level history.
- **R9** The first-run setup tab also gets `kit_plan`/`kit_apply` (it shares the work-tab MCP server).
