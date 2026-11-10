# The manifest applied to developing Claude OS — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dev sessions of this repo run on a small always-loaded kit (CLAUDE.md, rules, skills, agents, hooks, one gate, lint ratchet, touchpoints) that never reaches a product session, and the product prompts are trimmed to fixed byte budgets.

**Architecture:** Product sessions (cwd inside `root/`, `service/`, `setup/`, plus `/btw` and the `/` probe) get inline settings from `server/chat/devIsolation.ts` that exclude the repo's `CLAUDE.md`, `.claude/rules/**`, skills and agents. One Node gate (`scripts/gate.ts`) serves the Stop hook and `pre-push`; oxlint limits are frozen per offender by a ratchet that can only tighten. Product reference text moves out of `root/CLAUDE.md` into `root/reference/*.md`, read on demand.

**Tech Stack:** Node >= 22.18 (runs `.ts` directly), TypeScript 7 (native, no JS API), `node --test`, `@anthropic-ai/claude-agent-sdk` 0.3.318, `@modelcontextprotocol/sdk`, Playwright, oxlint (new devDependency).

**Spec:** `docs/specs/2026-11-09-dev-manifest.md` (binding). Owner decisions on it (binding): the root tab is a coordinator and no longer edits the core itself, core edits go to a Claude OS project tab (dev kit + gate apply there); the owner's global `~/.claude/CLAUDE.md` change is shown to him as a diff and applied only with his ok.

## Global Constraints

- **Execution model (accelerated):** each task works on `task/p2-<n>-<slug>` in a worktree under `.worktrees/`, cut from `main`; the controller merges it into `main` and deletes branch and worktree. `main` is the only long-lived branch. No per-task reviewer; one whole-project review at the end (Task 15).
- **Done for every task:** focused tests for the change, then `npm test` and `npm run typecheck` green in the worktree. Tasks touching `web/` also run `npm run build` in the worktree.
- **e2e:** only through the npm scripts (`npm run e2e:serial`, after Task 10 also `npm run e2e`), always wrapped as `flock /tmp/claudeos-e2e.lock npm run <script>` (another session shares the machine). e2e needs `dist/web` built in the same worktree and preloads `e2e/env.ts` (WSLg).
- **Never build in the main checkout:** the live server serves its `dist/web`. Steps marked "controller, main checkout" only read, merge or run tests.
- Worktrees lack ignored folders: symlink `node_modules` from the main checkout; tests use temp dirs; `config/`, `data/`, `vault/` are user data, never edited for a core change, never committed.
- Linux-first (WSL); every script and hook is Node (`.ts` or `.mjs`), no bash-only or jq-only tooling, so macOS and Windows need no extra code. `.githooks/pre-push` is `#!/bin/sh` + `exec node scripts/gate.ts` only.
- English for code, comments, prompts, docs, commits; Cyrillic only where `check-shippable` allows it. Prompts say "the user"; UI element names go through `PROMPT_LABELS`.
- Minimal diffs; no formatter; no new suppression comment; lint config and hooks are never loosened to pass.
- No push, no remote, no `Co-authored-by` or any Claude mention in commits.
- New devDependency: `oxlint` only. Not installed: typescript-eslint, prettier/oxfmt, knip, jscpd, dependency-cruiser, gitleaks, Obscura.
- Budgets (verbatim from the spec): dev `CLAUDE.md` <= 60 lines; unconditional `.claude/rules` <= 50 lines total; `root/CLAUDE.md` <= 4 KB (<= 40 lines); `service/CLAUDE.md` <= 2 KB; appended block in a work tab <= 2 KB; edit-time tests <= 10 s; Stop gate <= 90 s; each skill <= 40 lines.
- **Parallel sessions:** Project 4 (wiki memory) owns `server/memory/**`, `root/NOTE_RULES.md`, `manager.ts noteRules()`, `memory_search` in `rootMcp.ts`, `web/src/notes/**`, `web/src/screens/VaultPane.tsx`. The planner batch (T20–T30) touches `server/chat/session.ts`, `server/chat/manager.ts`, `server/chat/rootMcp.ts`, `shared/contract.ts`, `root/CLAUDE.md`, `server/tools/{planner,widgets,kanban,projectFiles,microtasks,serviceTasks}.ts`, `server/index.ts`, `server/journal/*`, `shared/plannerItems.ts` and many `web/` files (incl. `KanbanBoard.tsx`, `Widgets.tsx`, `Composer.tsx`). Project 2 never edits those files' parts owned by the others; tasks marked **SHARED** below touch one of them and are merged one at a time by the controller, rebased on the latest `main` right before merge.
- **Order and parallelism:**
  - Group A (now, new files only, in parallel): Tasks 2, 3, 4, 5, 6 (write; merge is gated, see Task 6), 7 (no branch).
  - Group B (after Group A merges; in parallel): Task 8 (needs 3, 4), Task 9 (**SHARED**: `session.ts`), Task 10. Tasks 3, 4, 8, 10 all add `package.json` scripts: the controller merges them one at a time.
  - Then Task 6 merges (needs 5, 8, 9 merged and Task 9's live probe green), then Task 11 (needs 6, 8).
  - Group C (late: after the planner batch has merged into `main`): Tasks 12 (**SHARED**: `contract.ts`, `rootMcp.ts`) and 13 (`root/CLAUDE.md`) in parallel, then Task 14 (**SHARED**: `rootMcp.ts`, `session.ts`, `manager.ts`).
  - Task 15 last.
- The spec's work-order step 1 (scrub tracked specs/plans) is already done on `main`; `npm run check:shippable` is clean. The controller commits this spec and plan to `main` before Group A starts.

## Review Focus

1. A Stop after only editing an untracked new file that was already present at the last green gate → the gate must run again (Task 11 test `fingerprint changes when an untracked file's content changes`).
2. A product session whose cwd is a subfolder of `root/` (a document tab in a root sub-folder) or whose repo path reaches through a symlink → still isolated (Task 2 test `isolates a nested cwd and a symlinked repo path`).
3. Stop in a read-only session (clean tree, HEAD moved by a commit or a checkout) → no gate, under 1 s (Task 11 test `skips on a clean tree even when HEAD moved`).
4. The gate's own source or a markdown rule mentions `@ts-ignore` → not a new suppression (Task 8 test `ignores suppression words in the gate's own files and markdown`).
5. A dev agent whose frontmatter `name` differs from its file name, or a skill without `disable-model-invocation: true` → isolation would miss it or it would load in every dev session (Task 6 test `agent names match file names and skills are not model-invocable`).

---

### Task 1: Baseline measurements (controller, main checkout, no branch)

**Files:**
- Create (ignored): `.superpowers/p2-baseline.md`

**Interfaces:**
- Produces: the numbers Task 5 writes into `docs/rules/testing.md`, the `SLOW_TESTS` list for Task 11, the e2e baseline for Task 10's acceptance, the "before" `/context` for Task 15.

- [ ] **Step 1:** Per-file unit times: run `node --disable-warning=ExperimentalWarning --test <file>` for each `server/**/*.test.ts` and `scripts/**/*.test.ts`; record wall time per file. `SLOW_TESTS` = files >= 3 s (spec's start list: `server/chat/chat.test.ts`, `server/chat/recovery.test.ts`, `server/chat/service.test.ts`, `server/chat/btw.test.ts`, `server/memory/memory.test.ts`).
- [ ] **Step 2:** `npm run typecheck` and `npm test` wall times.
- [ ] **Step 3:** e2e serial baseline, in a scratch worktree (`.worktrees/p2-baseline`, `npm run build` there): `flock /tmp/claudeos-e2e.lock npm run e2e:serial` with wall time and peak memory = max of `MemAvailable` drop from `/proc/meminfo` sampled every second during the run (a throwaway sampler, not committed). Remove the worktree after.
- [ ] **Step 4:** `/context` "before": run `claude -p --model haiku "/context"` from the repo root and from `root/`; record the totals. Record byte sizes of `root/CLAUDE.md`, `service/CLAUDE.md`, `setup/SETUP.md`, `root/NOTE_RULES.md`.
- [ ] **Step 5:** Write all numbers into `.superpowers/p2-baseline.md`. Nothing committed.

### Task 2: `devIsolation.ts` module (Group A)

**Files:**
- Create: `server/chat/devIsolation.ts`, `server/chat/devIsolation.test.ts`

**Interfaces:**
- Produces:
  - `type IsolationSettings = { claudeMdExcludes: string[]; skillOverrides: Record<string, 'off'>; permissions: { deny: string[] } }`
  - `isProductCwd(paths: Pick<Paths, 'root' | 'service' | 'setup'>, cwd: string): boolean` — true when `cwd` equals or is inside one of the three.
  - `devIsolation(repo: string): IsolationSettings` — reads `<repo>/.claude/skills/*` dir names and `<repo>/.claude/agents/*.md` file stems at call time; missing folders give empty lists. Repo path through `realpathSync`.
  - `withDevIsolation(paths: Pick<Paths, 'repo' | 'root' | 'service' | 'setup'>, cwd: string, settings?: Settings): Settings | undefined` — returns `settings` unchanged for a non-product cwd; else a merge: existing keys kept, `permissions.deny` concatenated, `claudeMdExcludes` and `skillOverrides` added.

- [ ] **Step 1: Failing tests** (temp repo with `.claude/skills/spec/SKILL.md`, `.claude/agents/reviewer.md`):
  - `excludes the repo claude md, local md and rules`: `devIsolation(repo).claudeMdExcludes` deep-equals `[`${real}/CLAUDE.md`, `${real}/CLAUDE.local.md`, `${real}/.claude/rules/**`]`.
  - `turns off every dev skill and denies every dev agent`: `skillOverrides` = `{ spec: 'off' }`, `permissions.deny` = `['Agent(reviewer)']`; add `.claude/skills/feature/` and call again → `feature: 'off'` present (no code change).
  - `no dev kit gives empty lists`: repo without `.claude/` → `skillOverrides` `{}`, `deny` `[]`, excludes still the three paths.
  - `isolates a nested cwd and a symlinked repo path`: `isProductCwd` true for `<root>/docs/x`; repo given through a symlink → excludes use the real path.
  - `leaves a dev cwd alone`: `withDevIsolation(paths, repo, { autoMemoryDirectory: '/v' })` returns the same object; cwd `<repo>/.worktrees/w1` → unchanged.
  - `merges with service settings`: `withDevIsolation(paths, paths.service, { autoMemoryEnabled: false, env: { A: '1' }, permissions: { deny: ['Edit(/x/**)'] } })` keeps `autoMemoryEnabled` and `env`, `deny` = `['Edit(/x/**)', 'Agent(reviewer)']`.
- [ ] **Step 2:** `node --disable-warning=ExperimentalWarning --test server/chat/devIsolation.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement the three functions. `Settings` type from `@anthropic-ai/claude-agent-sdk` (has `claudeMdExcludes`, `skillOverrides`); `within` via `path.relative`.
- [ ] **Step 4:** Test PASS; `npm test`, `npm run typecheck` green.
- [ ] **Step 5:** Commit `feat: dev kit isolation settings for product sessions`.

### Task 3: oxlint, limits and the ratchet (Group A)

**Files:**
- Create: `.oxlintrc.json`, `scripts/check-lint-ratchet.ts`, `scripts/check-lint-ratchet.test.ts`
- Modify: `package.json` (devDependency `oxlint`, scripts), `package-lock.json` (via `npm install -D oxlint`)

**Interfaces:**
- Produces:
  - `type OxlintConfig = { rules?: Record<string, unknown>; overrides?: { files: string[]; rules: Record<string, unknown> }[]; ignorePatterns?: string[] }`
  - `ratchetViolations(base: OxlintConfig, current: OxlintConfig): string[]` — one message per loosening.
  - `mergeBase(cwd: string): string` — `git merge-base HEAD main` (equals `HEAD` on `main`).
  - CLI `npm run check:lint-ratchet`: reads `.oxlintrc.json` at `mergeBase()` (`git show <base>:.oxlintrc.json`; absent at base → pass) vs the working tree, prints violations, exit 1 if any.
  - Scripts: `"lint": "oxlint --max-warnings 0"`, `"check:lint-ratchet": "node --disable-warning=ExperimentalWarning scripts/check-lint-ratchet.ts"`.

- [ ] **Step 1: Failing tests** (pure, config objects):
  - `red on a raised base limit`: base `max-lines` max 300, current 301 → one violation naming `max-lines`.
  - `red on a new override`: current has an override for `server/new.ts` not in base → violation.
  - `red on a raised override cap`: `server/chat/session.ts` cap 760 → 761 → violation.
  - `red on a rule turned off or downgraded to warn`: base `complexity` `error`, current `warn` → violation.
  - `green on a lowered cap and on a deleted override`: 760 → 700, override removed → `[]`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement `ratchetViolations` (numeric options compared per rule; severity order off < warn < error; override identity = sorted `files` joined) and `mergeBase`.
- [ ] **Step 4:** `npm install -D oxlint`. Write `.oxlintrc.json`: errors for `max-lines` `{ max: 300, skipBlankLines: true, skipComments: true }` (`**/*.tsx`: 400), `max-lines-per-function` 50 (`**/*.tsx`: 120), `complexity` 10, `max-depth` 4, `max-params` 4, `max-classes-per-file` 1, `typescript/no-explicit-any`, `typescript/ban-ts-comment`, category `correctness` as error. Rules off for `**/*.test.ts`, `e2e/**`, `server/**/fixtures/**`. `ignorePatterns`: `web/src/lib/locales/*.ts`, `plugins/agentation/ui/agentation.vendor.js`, `plugins/*/tools/e2e.mjs`, `dist/`.
- [ ] **Step 5:** Run `npx oxlint --format json` and add one `overrides` entry per offender with its cap = today's value (file lines; for function rules the file's worst value; for `no-explicit-any`, `ban-ts-comment` and `correctness` rules a file-level `off`). Expected file-length offenders (non-blank, non-comment; regenerate exact values): `Universe.ts` 1632, `contract.ts` 977, `session.ts` 760, `admin.ts` 621, `manager.ts` 578, `osPlugins.ts` 557, `desktop/main.cjs` 483, `kanban.ts` 452, `rootMcp.ts` 430, `ide-plus/ui/index.js` 418, `git.ts` 415, `memory/store.ts` 404, `journal/indexer.ts` 388, `planner.ts` 381, `journal/index.ts` 366, `universe/layout.ts` 360, `journal/parse.ts` 312; `.tsx`: `Widgets.tsx` 709, `Composer.tsx` 640, `SettingsScreen.tsx` 585, `PlannerPanel.tsx` 511, `Analytics.tsx` 424, `McpPane.tsx` 412. Caps are rebuilt from `main` right before merge (parallel sessions grow these files).
- [ ] **Step 6:** `npm run lint` exit 0; `npm run check:lint-ratchet` exit 0; tests PASS; `npm test`, `npm run typecheck` green.
- [ ] **Step 7:** Commit `feat: oxlint limits with a tighten-only ratchet`.

### Task 4: `check-touchpoints` (Group A)

**Files:**
- Create: `scripts/check-touchpoints.ts`, `scripts/check-touchpoints.test.ts`, `docs/rules/touchpoints.json`
- Modify: `package.json` (script `"check:touchpoints": "node --disable-warning=ExperimentalWarning scripts/check-touchpoints.ts"`)

**Interfaces:**
- Produces:
  - `type Touchpoint = { name: string; source: string; memberRegex: string; registries?: string[]; fileExists?: string; reverseDir?: string }` — members = capture group 1 of every `memberRegex` match (flag `gm`) in `source`; each member must occur in every `registries` file; `fileExists` is a path template with `{member}` that must exist; every `*.md` stem in `reverseDir` must be a member.
  - `touchpointGaps(entries: Touchpoint[], fs: { read(path: string): string | null; list(dir: string): string[] }): string[]`
  - CLI reads `docs/rules/touchpoints.json` relative to the repo, prints gaps, exit 1 if any.
  - Initial `touchpoints.json`: one entry `microtasks` (`source: server/tools/microtasks.ts`, members = keys of `MICROTASK_ROUTES`, `fileExists: root/microtasks/{member}.md`, `reverseDir: root/microtasks`). Task 13 adds the widget and plugin entries.

- [ ] **Step 1: Failing tests** (in-memory fs):
  - `red on a microtask key without a file`: key `x` in source, no `root/microtasks/x.md` → one gap naming `x`.
  - `red on a file without a key`: `root/microtasks/y.md` listed, no key → gap naming `y`.
  - `red on a member missing from a registry`: member `files.write` absent from `root/reference/plugins.md` → gap.
  - `green on the real repo`: real fs, real `touchpoints.json` → `[]`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement (≈ 60 lines).
- [ ] **Step 4:** Tests PASS; `npm run check:touchpoints` exit 0 (19 keys, 19 files); `npm test`, `npm run typecheck` green.
- [ ] **Step 5:** Commit `feat: touchpoints check for registries the type system cannot see`.

### Task 5: Process docs and `docs/rules` (Group A)

**Files:**
- Create: `docs/specs/TEMPLATE.md`, `docs/solutions/README.md`, `docs/rules/architecture.md`, `docs/rules/code-style.md`, `docs/rules/testing.md`, `docs/rules/touchpoints.md`, `docs/rules/common-mistakes.md`, `docs/rules/pattern-candidates.md`
- Modify: `.gitignore` (add `docs/handoff/`)

**Interfaces:**
- Consumes: Task 1 numbers; `plugins/os-builder/skills/claude-os-core/SKILL.md` (source text, not deleted here).
- Produces: the pointer targets of Task 6's `CLAUDE.md` and rules.

- [ ] **Step 1:** `architecture.md`: the code map and change order from `claude-os-core`, English, relative paths. `touchpoints.md`: the touchpoint table of spec section 3, the "three places" line from `root/CLAUDE.md` lines 40–48 (interface link), and the "new endpoint" and "new `ui_action`" recipes from `claude-os-core`.
- [ ] **Step 2:** `code-style.md`: the limits of spec 2.5 with the reason for each, the ratchet rule (tighten freely, never loosen), no formatter (spec 2.6), "match the file". `testing.md`: contours A/B/C (spec section 4) with Task 1's measured times. `common-mistakes.md`: ledger table header (`Mistake | Seen | Last | Fix`) with rows known today (e.g. building in the main checkout, parallel e2e out of memory, `WAYLAND_DISPLAY` under WSLg). `pattern-candidates.md`: Obscura entry with the spec's verification recipe (release binaries for linux-x64, macOS, Windows; license; `chromium.connectOverCDP` runs `e2e/git.test.ts` green twice; then memory).
- [ ] **Step 3:** `docs/specs/TEMPLATE.md` (manifest 4.7: Intent, Evidence, Goals, Non-goals, Anti-goals, Design, Order of work, Verification, Left to the builder, Claude's calls); `docs/solutions/README.md` (one file per lesson, frontmatter `tags`).
- [ ] **Step 4:** `npm run check:shippable` exit 0; `npm test` green.
- [ ] **Step 5:** Commit `docs: rules, ledgers and templates for the dev process`.

### Task 6: Dev kit — `CLAUDE.md`, rules, skills, agents (Group A write; merge gated)

**Merge gate:** the controller merges this branch only after Tasks 5, 8 and 9 are on `main` and Task 9's live probe is green. Before that the live root tab (cwd `root/`) would load this `CLAUDE.md` as a parent file.

**Files:**
- Create: `CLAUDE.md`, `.claude/rules/{00-workflow,10-code-standard,20-mistakes,prompts,server,web,tests}.md`, `.claude/skills/{spec,feature,split-file,techdebt,compound,handoff,promote}/SKILL.md`, `.claude/agents/{reviewer,scout,test-runner}.md`, `scripts/devkit.test.ts`

**Interfaces:**
- Consumes: commands from Tasks 3, 4, 8 (`npm run lint`, `check:touchpoints`, `gate`); docs from Task 5.

- [ ] **Step 1: Failing tests** `scripts/devkit.test.ts` (real repo files):
  - `claude md is at most 60 lines`.
  - `unconditional rules are at most 50 lines`: sum over `.claude/rules/*.md` without a `paths:` frontmatter key <= 50.
  - `path-scoped rules declare paths`: `prompts.md`, `server.md`, `web.md`, `tests.md` each have `paths:`.
  - `agent names match file names and skills are not model-invocable`: each `.claude/agents/<x>.md` frontmatter `name: <x>`; each `SKILL.md` has `disable-model-invocation: true`, `name` = dir name, <= 40 lines.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** `CLAUDE.md` (English, <= 60 lines) with the four sections of spec 1.2, every command and gotcha listed there, plus: "the root tab does not edit the core; core changes happen in a Claude OS project tab, where this kit and the gate apply". Pointers to `.claude/rules/00-workflow.md` and `docs/rules/`.
- [ ] **Step 4:** Rules per spec 1.3. Unconditional: `00-workflow.md` (task contract in 4 lines; systemic change = touchpoints + sibling grep; finish = gate output shown; `npm run gate` before merging a task branch into `main`; git flow `task/<slug>` worktree → merge → delete; correction → ledger row), `10-code-standard.md`, `20-mistakes.md` (<= 15 lines from `common-mistakes.md`). Path-scoped `paths:` lists exactly as the spec: `prompts.md` (`root/**`, `service/**`, `setup/**`, `server/chat/profile.ts`, `server/chat/rootMcp.ts`, `server/tools/documents.ts`), `server.md` (`server/**`, `shared/**`), `web.md` (`web/src/**`; carries the interface-design lines from `root/CLAUDE.md` 56–58), `tests.md` (`**/*.test.ts`, `e2e/**`).
- [ ] **Step 5:** Seven skills per the spec 5 table, each <= 40 lines, `disable-model-invocation: true`, reusing superpowers skills by name instead of copying them. `/feature`: no per-task review. `/promote`: hook and lint-config changes only as a proposal.
- [ ] **Step 6:** Agents: `reviewer` (`model: inherit`; tools Read, Grep, Glob, `Bash(git diff*)`, `Bash(git log*)`; `memory: project`; spec checklist + touchpoint completeness, table output), `scout` (`model: haiku`; Read, Grep, Glob; <= 40 lines of paths), `test-runner` (`model: sonnet`; `Bash(npm run *)`, `Bash(node *)`, Read; failures only, <= 60 lines; owns contour C, wraps e2e in `flock /tmp/claudeos-e2e.lock`).
- [ ] **Step 7:** Tests PASS; `npm test`, `npm run typecheck`, `npm run check:shippable` green.
- [ ] **Step 8:** Commit `feat: dev CLAUDE.md, rules, skills and agents`.

### Task 7: Global `CLAUDE.md` proposal (Group A, no branch, stops for the owner)

**Files:**
- Create (ignored): `.superpowers/global-claude-md/CLAUDE.md`, `.superpowers/global-claude-md/CLAUDE.md.diff`, `.superpowers/global-claude-md/skills/explain-mechanism/SKILL.md`, `.superpowers/global-claude-md/rules/backend.md`, `.superpowers/global-claude-md/settings-deny.json`

**Interfaces:**
- Consumes: the owner's current `~/.claude/CLAUDE.md` and `~/.claude/settings.json` (read only).

- [ ] **Step 1:** Write the proposed `CLAUDE.md` = the spec section 6 block verbatim, `<name>` replaced by today's name from the current file, the rg-context block copied byte-for-byte between its `os-plugin:rg-context:claude-md` markers. Check: <= 20 lines outside the marker block.
- [ ] **Step 2:** `explain-mechanism/SKILL.md` from current sections 12, 14–16; `rules/backend.md` with `paths: ["**/*.php", "**/migrations/**"]` from section 2 escalation detail, section 3 "DB schema, shared modules, other team's side", section 9 migrations; `settings-deny.json` with the `permissions.deny` additions (`Edit(//mnt/**)`, `Edit(~/.bashrc)`, `Edit(~/.zshrc)`, `Edit(~/.profile)`) as a fragment to merge.
- [ ] **Step 3:** `git diff --no-index ~/.claude/CLAUDE.md .superpowers/global-claude-md/CLAUDE.md > .superpowers/global-claude-md/CLAUDE.md.diff`.
- [ ] **Step 4: Stop.** Report the paths to the controller. Nothing outside the repo is written; the owner applies it.

### Task 8: One gate and `pre-push` (Group B, after 3 and 4)

**Files:**
- Create: `scripts/gate.ts`, `scripts/gate.test.ts`, `.githooks/pre-push`
- Modify: `package.json` (scripts `"gate": "node --disable-warning=ExperimentalWarning scripts/gate.ts"`, `"hooks:install": "git config core.hooksPath .githooks"`)

**Interfaces:**
- Consumes: `mergeBase(cwd)` from Task 3; scripts `lint`, `check:lint-ratchet`, `check:shippable`, `check:touchpoints`, `typecheck`.
- Produces:
  - `type GateStep = { name: string; run: string[] }`; `GATE_STEPS: GateStep[]` in order: `typecheck` → `lint` (`--max-warnings 0`) → `lint-ratchet` → `shippable` → `touchpoints` → `suppressions` → `unit` (`node --disable-warning=ExperimentalWarning --test --test-reporter=dot "server/**/*.test.ts" "scripts/**/*.test.ts"`).
  - `runGate(steps: GateStep[], exec: (step: GateStep) => Promise<{ code: number; output: string }>): Promise<{ ok: boolean; failed: string | null; output: string }>` — stops at the first red, `output` = failing step's output only.
  - `newSuppressions(diff: string): string[]` — added lines (`+`, not `+++`) containing `@ts-ignore`, `@ts-expect-error`, `oxlint-disable`, `eslint-disable`, only in `.ts/.tsx/.js/.mjs/.cjs` files other than `scripts/gate.ts` and `scripts/gate.test.ts`.
  - CLI: prints `gate: green (<s> s)` or `gate: red at <step>` + output; exit 0/1. Used by Task 11's Stop hook and `.githooks/pre-push` (`#!/bin/sh` / `exec node scripts/gate.ts`, mode 755).

- [ ] **Step 1: Failing tests:**
  - `stops at the first red step`: three fake steps, second exits 1 → third never runs, `failed: 'b'`.
  - `reports only failing output`: green step output absent from result.
  - `flags an added ts-ignore line`: diff with `+// @ts-ignore` in `server/x.ts` → one hit.
  - `ignores removed suppression lines`: `-// @ts-ignore` → `[]`.
  - `ignores suppression words in the gate's own files and markdown`: same `+` line under `scripts/gate.ts` and `docs/rules/code-style.md` → `[]`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. `suppressions` step diffs `git diff <mergeBase>` (tracked) plus untracked non-ignored files as added. npm steps spawn `npm` with `shell: process.platform === 'win32'`.
- [ ] **Step 4:** Tests PASS; `npm run gate` green in the worktree, wall time <= 90 s (record it); `npm run typecheck` green.
- [ ] **Step 5:** Commit `feat: one gate for stop, pre-push and CI`. (The controller runs `npm run hooks:install` in the main checkout after merge; it is local git config.)

### Task 9: Isolation wiring and the live probe (Group B, **SHARED**: `server/chat/session.ts`)

**Files:**
- Modify: `server/chat/session.ts` (`spawn()` options), `server/chat/btw.ts` (`btwArgs`, `runBtw`), `server/chat/probe.ts` (`probeCli` options), `server/tools/osPlugins.ts` (`setupOf`: `cwd: ctx.paths.root`)
- Test: `server/chat/btw.test.ts`, `server/chat/devIsolation.test.ts`, `server/tools/osPlugins.test.ts`

**Interfaces:**
- Consumes: `withDevIsolation`, `devIsolation`, `isProductCwd` (Task 2).
- Produces: `btwArgs(resume: string | null, model: string | null, ownId: string, profile = '', isolation: IsolationSettings | null = null): string[]` — `--settings` JSON = `{ disableAllHooks: true, ...isolation }`.

- [ ] **Step 1: Failing tests:**
  - `btw.test.ts` `btw args carry the isolation settings`: `--settings` value parses to an object with `disableAllHooks: true` and the given `claudeMdExcludes`; without isolation it is exactly `{"disableAllHooks":true}`.
  - `devIsolation.test.ts` `probe options are isolated for a root cwd`: export `probeOptions(ctx, cwd, loadSettings)` from `probe.ts` (the options object `probeCli` passes to `query`); for `paths.root` its `settings` contains `disableAllHooks: true` and `claudeMdExcludes`; for `paths.repo` only `disableAllHooks`.
  - `osPlugins.test.ts` `plugin setup tab opens in the root folder`: a plugin with a missing dependency → `setup.cwd === paths.root`.
- [ ] **Step 2:** Run the three files → FAIL.
- [ ] **Step 3:** `session.ts spawn()`: after `options` is built (after the `extraOptions` spread, so the service settings are included), `const settings = withDevIsolation(ctx.paths, row.cwd, options.settings as Settings | undefined); if (settings) options.settings = settings;`. No change to `manager.ts`. `btw.ts`: pass `isProductCwd(ctx.paths, tab.cwd) ? devIsolation(ctx.paths.repo) : null`. `probe.ts`: `settings: withDevIsolation(ctx.paths, cwd, { disableAllHooks: true })`.
- [ ] **Step 4:** Tests PASS; `npm test`, `npm run typecheck` green.
- [ ] **Step 5: Live probe** (in this worktree, uncommitted scratch files, removed after): `CLAUDE.md` with line `P2-MARKER-CLAUDEMD`, `.claude/rules/probe.md` with `P2-MARKER-RULE`, `.claude/skills/p2probe/SKILL.md`, `.claude/agents/p2probe.md`. From `root/`, `service/` and `setup/`: `claude -p --model haiku --settings "<JSON from devIsolation(worktree)>" "Quote every line of your instructions containing P2-MARKER, then list the skills and agents you have."` → no marker, no `p2probe`. From the worktree root without `--settings` → both markers, `p2probe` skill and agent, each once. Record the outputs in the task report; delete the scratch files; `git status` clean.
- [ ] **Step 6:** Commit `feat: product sessions do not load the dev kit`.

### Task 10: e2e on one shared browser (Group B)

**Files:**
- Create: `e2e/browser.ts`, `scripts/e2e.ts`
- Modify: every `e2e/*.test.ts` whose launch is exactly the standard swiftshader args (`chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })`); `package.json` (`"e2e": "node --disable-warning=ExperimentalWarning scripts/e2e.ts"`; `e2e:serial` unchanged)

**Interfaces:**
- Produces:
  - `E2E_ARGS: string[]` (the three swiftshader flags) and `launchBrowser(): Promise<Browser>` in `e2e/browser.ts` — `chromium.connect(process.env.CLAUDE_OS_E2E_WS)` when set, else `chromium.launch({ args: E2E_ARGS })` as today.
  - `scripts/e2e.ts`: `chromium.launchServer({ args: E2E_ARGS })`, sets `CLAUDE_OS_E2E_WS` to its `wsEndpoint()`, runs `node --import ./e2e/env.ts --disable-warning=ExperimentalWarning --test --test-concurrency=2 "e2e/**/*.test.ts"` as a child, closes the server, exits with the child's code. Extra CLI args pass through (one file still runs alone).

- [ ] **Step 1:** `e2e/browser.ts`; replace the standard launch line in each test file with `browser = await launchBrowser()`. Files with other options (`voice.test.ts`, the `*-perf.ts` scripts) keep their own launch.
- [ ] **Step 2:** `scripts/e2e.ts` and the `e2e` script.
- [ ] **Step 3:** `npm run typecheck`, `npm test` green; `npm run build` in this worktree.
- [ ] **Step 4:** Acceptance: `flock /tmp/claudeos-e2e.lock npm run e2e` twice, both green; peak memory measured as in Task 1 Step 3 below Task 1's serial peak + 50 %; record wall times. Also `flock /tmp/claudeos-e2e.lock npm run e2e:serial` once green (fallback path unchanged).
- [ ] **Step 5:** Commit `test: e2e files share one browser server`.

### Task 11: Hooks and `.claude/settings.json` (after 6 and 8 are merged)

**Files:**
- Create: `.claude/hooks/protect-files.mjs`, `.claude/hooks/after-edit.mjs`, `.claude/hooks/stop-gate.mjs`, `.claude/hooks/briefing.mjs`, `.claude/settings.json`, `scripts/hooks.test.ts`

**Interfaces:**
- Consumes: `scripts/gate.ts` CLI (Task 8); Task 1's `SLOW_TESTS`.
- Produces (named exports; each file runs its `main()` only when invoked directly):
  - `protect-files.mjs`: `protectReason(filePath: string, projectDir: string): string | null` — blocks `data/`, `.git/`, `package-lock.json`, `dist/`, `node_modules/`, `.claude/hooks/`, `.githooks/`, `.env*` (relative to `projectDir`, after `path.resolve`). Exit 2 with the reason.
  - `after-edit.mjs`: `relatedTests(file: string, projectDir: string): string[]` (test files under `server/` and `scripts/` whose non-`import type` imports resolve to `file`, one level); `SLOW_TESTS: string[]`; `planTests(tests: string[]): { run: string[]; deferred: boolean }` (deferred when > 3 files or any in `SLOW_TESTS`). Runs `oxlint <file>`, then the related tests for `.ts` under `server/`, `shared/`, `scripts/`; prints failures only, or `tests deferred to Stop`; exit 2 on failure.
  - `stop-gate.mjs`: `fingerprint(o: { head: string; diff: string; untracked: { path: string; content: Buffer }[] }): string`; `stopDecision(state: { green: string | null; blocks: number }, fp: string, clean: boolean): 'skip' | 'run' | 'give-up'`. State in `<git rev-parse --git-dir>/claude-gate.json`. Red → exit 2 with <= 60 lines; after 3 blocks in a row → exit 0 with `{"systemMessage": "<red summary>"}`.
  - `briefing.mjs`: `briefingLines(o: { branch: string; dirty: number; branches: string[]; worktrees: string[]; openItems: number; plan: string | null; handoff: string | null }): string[]` (<= 8 lines; lists branches/worktrees other than `main`).
  - `.claude/settings.json`: `permissions.allow` / `deny` / `ask` exactly as spec 2.1; hooks: PreToolUse `Edit|Write` → protect-files; PostToolUse `Edit|Write` → after-edit (timeout 30); Stop → stop-gate (timeout 300); SessionStart `startup|resume|compact` → briefing. Command form `node "$CLAUDE_PROJECT_DIR/.claude/hooks/<x>.mjs"`.

- [ ] **Step 1: Failing tests** `scripts/hooks.test.ts`:
  - `blocks edits under data and env files`: `protectReason(<p>/data/x, p)` and `<p>/.env.local` → non-null; `<p>/server/x.ts` → null; `<p>/server/../data/x` → non-null.
  - `finds tests that import the edited file`: temp repo, `server/a.test.ts` imports `./a.ts` → `['server/a.test.ts']`; a test with only `import type` from `./a.ts` → not listed.
  - `defers more than three tests or a slow one`: 4 files → `deferred: true`; `['server/chat/chat.test.ts']` → `deferred: true`; 2 fast → `run` = both.
  - `fingerprint changes when an untracked file's content changes`: same paths, different content → different.
  - `skips on a clean tree even when HEAD moved`: `stopDecision({ green: 'a', blocks: 0 }, 'b', true)` → `'skip'`.
  - `skips when the tree equals the last green one`: `({ green: 'a', blocks: 0 }, 'a', false)` → `'skip'`; `({ green: 'a', blocks: 0 }, 'b', false)` → `'run'`; `({ green: null, blocks: 3 }, 'b', false)` → `'give-up'`.
  - `briefing fits in eight lines and names stray branches`: branches `['main', 'task/x']` → a line containing `task/x`; length <= 8.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement the four hooks (no dependencies; oxlint via `process.execPath` + the package's bin JS so Windows needs no `.cmd`). Settings file written last in this task.
- [ ] **Step 4:** Tests PASS; `npm test`, `npm run typecheck`, `npm run gate` green.
- [ ] **Step 5: Live checks** in this worktree (piped stdin JSON, then one real `claude -p --model haiku` session for the first two): edit `data/x` → blocked with the reason; break a type, Stop → exit 2 with the tsc line; add a key to `MICROTASK_ROUTES` (scratch, reverted) → Stop names the touchpoints gap; no change → Stop < 1 s; three red Stops → fourth returns the summary and does not block. Record outputs; revert scratch edits.
- [ ] **Step 6:** Commit `feat: hooks for protection, edit-time checks, stop gate and briefing`.

### Task 12: Typed registries and `mcpTools.test.ts` (Group C, **SHARED**: `shared/contract.ts`, `server/chat/rootMcp.ts`)

**Files:**
- Modify: `shared/contract.ts` (`KANBAN_COLUMNS`, `HOME_SLOTS`, `UI_ACTIONS`/`UI_VIEWS` records), `server/chat/rootMcp.ts:95-96,279`, `web/src/lib/uiCommands.ts:35`, `server/tools/kanban.ts:14`, `web/src/screens/KanbanBoard.tsx:27`, `server/tools/settings.ts:77`, `server/tools/widgets.ts:11`, `web/src/home/slots.ts:3`
- Create: `server/chat/mcpTools.test.ts`

**Interfaces:**
- Produces (in `shared/contract.ts`):
  - `export const KANBAN_COLUMNS = ['backlog', 'todo', 'doing', 'polish', 'done'] as const; export type KanbanColumn = (typeof KANBAN_COLUMNS)[number];`
  - `export const HOME_SLOTS = ['left', 'right', 'top', 'bottom-left', 'bottom-right'] as const; export type HomeSlot = (typeof HOME_SLOTS)[number];` — `settings.ts` and `slots.ts` import it (their local lists deleted; `SLOTS` re-exported from `slots.ts` only if other web files import it).
  - `UI_ACTION_SET: Record<UiCommand['action'], true>`, `UI_VIEW_SET: Record<UiView, true>`; `rootMcp.ts` derives `UI_ACTIONS`/`UI_VIEWS` with `Object.keys(...)` cast to the tuple type `z.enum` needs.
  - `assertNever(x: never): never` in `shared/contract.ts`; `runUiCommand` switch gets `default: return assertNever(command)`.
  - `KANBAN_COLUMN = z.enum(KANBAN_COLUMNS)` in `rootMcp.ts`; board `COLUMNS` labels as `satisfies Record<KanbanColumn, Key>`.
  - `PROMPTED_TOOLS: Record<'root' | 'work' | 'service' | 'serviceTask', string[]>` in `mcpTools.test.ts`.

- [ ] **Step 1: Failing test** `server/chat/mcpTools.test.ts`: builds `createRootMcp`, `createPlannerMcp`, `createServiceMcp`, `createServiceTaskMcp` with a test ctx; lists names through `@modelcontextprotocol/sdk` `InMemoryTransport.createLinkedPair()` + `Client.listTools()`.
  - `allowed tools are registered`: for each kind, every `mcp__claude-os__<x>` in its allowed list (`manager.ts` lists: root, work, service, service task) is registered.
  - `registered but not allowed is the prompted list`: registered − allowed deep-equals `PROMPTED_TOOLS[kind]` (expected: root `['set_project_map']`, work `['remove_planner_item']`; if the real difference has more, list each with a comment why it prompts and report it).
  - `prompts name only existing tools`: every `mcp__claude-os__\w+` and every backticked tool name in `root/CLAUDE.md`, `root/reference/*.md`, `service/CLAUDE.md`, `UI_TOOL_RULE`, `PROGRESS_RULE`, `DOCUMENT_RULE` is registered somewhere.
- [ ] **Step 2:** Run → FAIL only if a mismatch exists; otherwise PASS and proceed (it guards the refactor).
- [ ] **Step 3:** Apply the registry changes. A removed action or a missing kanban column must now be a type error: verify by temporarily deleting `'toast'` from `UI_ACTION_SET` → `npm run typecheck` fails; restore.
- [ ] **Step 4:** `npm test`, `npm run typecheck`, `npm run lint`, `npm run build` (in the worktree) green.
- [ ] **Step 5:** Commit `refactor: typed registries for ui actions, views, kanban columns and home slots`.

### Task 13: Product prompt trim and references (Group C, `root/CLAUDE.md`)

**Files:**
- Create: `root/reference/widgets.md`, `root/reference/icons.md`, `root/reference/documents.md`, `root/reference/plugins.md`
- Modify: `root/CLAUDE.md`, `service/CLAUDE.md`, `root/microtasks/panel-change.md`, `plugins/os-builder/plugin.json` (drop `claude-os-core` from `contains.skills` and the "The core" feature lines in both languages), `docs/rules/touchpoints.json`
- Delete: `plugins/os-builder/skills/claude-os-core/`

**Interfaces:**
- Consumes: Task 4's `Touchpoint` format; `docs/rules/architecture.md` (Task 5) holds the `claude-os-core` map.
- Produces: prompt sources for Task 14 (`root/CLAUDE.md`, `root/reference/*.md`, `service/CLAUDE.md`).

- [ ] **Step 1:** Rebase on `main` (the planner batch has changed `root/CLAUDE.md`). Move sections per the spec 1.4 table, taking the text as it is on `main` now: widgets, home layout, trash, IDEs, `mcpNotes` → `widgets.md` (+ one interface-design line); icons → `icons.md`; documents detail (sharing, sandbox) → `documents.md`; plugins section → `plugins.md`; tool list → 2 policy lines (the descriptions move in Task 14); interface-link section deleted.
- [ ] **Step 2:** `root/CLAUDE.md` <= 40 lines and <= 4096 bytes: role, what to do, limits (language/name lines dropped); developer mode = 2 lines: "Core changes (server, web, shared, e2e) go to a tab of the Claude OS project through `open_session` with a full brief; the dev kit and the gate apply there. Do not edit the core here and never replace a core change with a setting in `../config`." Last line: "For widgets, plugins, documents, icons read `reference/<topic>.md` first." Keep `restart_claude_os` usage.
- [ ] **Step 3:** `service/CLAUDE.md` <= 2048 bytes, pointing to `../root/reference/` instead of `../root/CLAUDE.md`. `panel-change.md`: the core-work paragraph becomes "hand it to a tab of the Claude OS project with `open_session`, with the panel, file and description"; the `home`-key note stays.
- [ ] **Step 4:** Add to `touchpoints.json`: `BuiltinId` members (`web/src/home/slots.ts`), `HomeSlot` members (`shared/contract.ts` `HOME_SLOTS`), widget `type` members (`server/tools/widgets.ts`), each with `registries: ['root/reference/widgets.md']`; `OS_PLUGIN_PERMISSIONS` members with `registries: ['root/reference/plugins.md']`. Add a test to `scripts/check-touchpoints.test.ts`: `red when a widget type is missing from the reference` (in-memory fs).
- [ ] **Step 5:** `npm run check:touchpoints` exit 0; `npm test` (incl. `osPlugins.test.ts` with `os-builder` still listed), `npm run typecheck`, `npm run check:shippable` green.
- [ ] **Step 6:** Commit `feat: trim root and service prompts, references read on demand`. Report to the controller: the owner's installed `os-builder` will show "Update" (its tree changed); applying it removes the installed `claude-os-core` skill and is the owner's action.

### Task 14: Rule texts, labels and the budget test (Group C, after 12 and 13; **SHARED**: `rootMcp.ts`, `session.ts`, `manager.ts`)

**Files:**
- Modify: `server/chat/profile.ts`, `server/chat/rootMcp.ts` (`UI_TOOL_RULE`, `ui_action`, `report_progress`, `move_kanban_card` descriptions, tool descriptions taking the root tool list), `server/tools/documents.ts` (`DOCUMENT_RULE`, document tool descriptions), `server/chat/session.ts` (`spawn()` append), `server/chat/manager.ts` (`tabOptions()` profile call only), `server/chat/btw.ts` (profile call only)
- Create: `server/chat/promptBudget.test.ts`
- Test: `server/chat/profile.test.ts`

**Interfaces:**
- Produces:
  - `type PromptKind = 'root' | 'service' | 'setup' | 'work'`; `promptKindOf(paths, row: { kind: string; cwd: string }): PromptKind` (root tab → root; service rows → service; cwd inside `paths.setup` → setup; else work).
  - `promptSources(paths, kind: PromptKind): string` — root: `root/CLAUDE.md` + `root/reference/*.md`; service: `service/CLAUDE.md` + `root/reference/*.md`; setup: `setup/SETUP.md`; work: `''`.
  - `promptLabels(language: string, sources: string): Record<string, string>` — only names that occur in `sources` (case-sensitive substring).
  - `sessionProfileBlock(ctx: Ctx, kind: PromptKind): string` (all callers pass a kind; btw passes the tab's kind).
  - `PROMPT_LABELS` loses the 5 `kanban column *` and 4 `progress status *` entries (19 left). `kanbanColumnLabels(language: string): string` and `progressStatusLabels(language: string): string` (e.g. `backlog "<label>", todo "<label>", ...` from catalog keys `kanban.*`, `progress.*`) appended to the `move_kanban_card` / `report_progress` descriptions when the server is built (`ctx.settings?.profile()?.language ?? 'en'`).
  - `sessionAppend(parts: { profile: string; note: string | null; noteRules: string; document: string | null }): string` exported from `session.ts`, joining with the rule constants in today's order (plus whatever rules are on `main` at merge time); `spawn()` uses it.

- [ ] **Step 1: Failing tests:**
  - `profile.test.ts` `work tab profile block lists no labels`: `sessionProfileBlock(ctx, 'work')` has no `- ` label lines.
  - `profile.test.ts` `root block lists only labels its prompts name`: sources `'open the Projects screen'` → only `Projects screen`.
  - `profile.test.ts` `kanban labels follow the user's language`: `kanbanColumnLabels('ru')` contains `ru['kanban.backlog']` and all 5 column ids; `'de'` falls back to en.
  - `promptBudget.test.ts` `root prompt fits 4 KB`: `Buffer.byteLength(root/CLAUDE.md) <= 4096`, lines <= 40.
  - `promptBudget.test.ts` `service prompt fits 2 KB`: `service/CLAUDE.md` <= 2048.
  - `promptBudget.test.ts` `work tab append fits 2 KB`: `sessionAppend({ profile: sessionProfileBlock(ctx with profile { name: 'Ann', language: 'en', questionLevel: 'balanced', projectsDir: '/p' }, 'work'), note: null, noteRules: <root/NOTE_RULES.md>, document: null })` <= 2048 bytes.
  - `promptBudget.test.ts` `every prompt label is named by a prompt`: each `PROMPT_LABELS` name occurs in `promptSources` of some kind.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Shrink `UI_TOOL_RULE` and `DOCUMENT_RULE` to one or two sentences each, moving the rest into the `ui_action` and document tool descriptions; move the `root/CLAUDE.md` tool-list detail into the tool descriptions in `rootMcp.ts`; add the label strings to the two tool descriptions; wire `PromptKind` through `session.ts`, `manager.ts tabOptions()`, `btw.ts`. Do not edit `PATH_RULE`, `PROGRESS_RULE` wording owned by the planner batch beyond what the 2 KB test needs, and never `root/NOTE_RULES.md`; if the work-tab block is still over 2 KB after trimming Project 2's own rules, stop and report the byte breakdown.
- [ ] **Step 4:** Tests PASS; `npm test`, `npm run typecheck`, `npm run lint`, `npm run gate` green.
- [ ] **Step 5:** Commit `feat: lean product prompts with per-session labels and a budget test`.

### Task 15: Verification and the whole-project review (controller)

**Files:**
- Modify: `docs/rules/testing.md` (final timings)

- [ ] **Step 1:** On `main` (main checkout, no build): `npm run gate` green, wall time; `wc -l CLAUDE.md` <= 60; record timings in `docs/rules/testing.md` (in a last task branch, merged).
- [ ] **Step 2:** Live probe as Task 9 Step 5 against the real kit on `main` (`claude -p --model haiku` from `root/`, `service/`, `setup/` with the `devIsolation` settings; from the repo root and a fresh `.worktrees/*` worktree without): no dev line, skill or agent in product cwds; all present, each once, in dev cwds.
- [ ] **Step 3:** `/context` after, from the repo root and `root/`, compared with Task 1; record both.
- [ ] **Step 4:** In a scratch worktree with `npm run build`: `flock /tmp/claudeos-e2e.lock npm run e2e` green.
- [ ] **Step 5:** The owner's install (after his restart of the server): the root tab and a service task answer in Russian with the same tools; `move_kanban_card` / `report_progress` labels match the UI; no setup modal; plugins screen shows `os-builder` "Update" (owner decides).
- [ ] **Step 6:** One `reviewer` agent run over `git diff <commit before Task 2>..main` against the spec: checklist of Goals 1–7, Anti-goals, Verification, touchpoint completeness. Fix findings in task branches, re-run the gate, merge.
- [ ] **Step 7:** Remind the owner of Task 7's proposal in `.superpowers/global-claude-md/` (diff + files); nothing applied without his ok.
