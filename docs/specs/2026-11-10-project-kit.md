# The project kit: the manifest as a Claude OS feature for user projects — design

Status: approved (owner, 2026-11-10: calls 1, 2 and 4 confirmed) · Owner: the owner · Date: 2026-11-10 · Project 3 of 4 (roadmap in `2026-11-09-core-user-split.md`)

## Intent

Project 2 put the manifest (`docs/manifest/claude-code-os-manifest.html`, sections 4–8, 10–12, 15, 16, 18) to work on Claude OS itself. Project 3 lets Claude OS apply the same loop to any of the user's projects: one action installs a **project kit**. It has a short `CLAUDE.md` built from the project's real commands, rules, Node hooks, one gate, three agents, a few skills and the docs ledgers. Later versions of the kit reach the project without overwriting the user's edits. The profile's question level also starts to change how Claude behaves, and analytics show whether the kit pays off. The priorities, in order: lean context, Linux first with Node-only tooling, automation over confirmations, the Home tab as coordinator, and skills living in the project rather than globally.

## Evidence (read on main, 2026-11-10)

- **OS plugins install globally.** On enable, skills are copied to `~/.claude/skills` and hooks are merged into `~/.claude/settings.json` (`server/tools/osPlugins.ts:253–255`, `addHooks` `:478`). `validateManifest` rejects any component other than `skills|hooks|mcp|ui` (`:182`). A kit shipped as an ordinary plugin would therefore put `/spec` and the hooks into every session on the machine, which contradicts the per-project skills rule.
- **Shipped vs user plugins:** `plugins/<id>` is shipped and `config/plugins/<id>` is the user's copy, which wins by id. When a folder's tree hash changes, its code stays inactive until the user presses "Update" (`osPlugins.ts:96`, `root/reference/plugins.md`).
- **Existing project surfaces:** the project setup panel (`server/tools/setup.ts`, `web/src/work/ProjectSetupPanel.tsx`) already runs the `project-check` microtask (`root/microtasks/project-check.md`, an `owner` route in `MICROTASK_ROUTES`). `claudeMd.ts` has `preview`/`save` with a version check, a backup and an audit entry. `setup.ts` `readObject` reads `.claude/settings.json` safely.
- **Question level today** is stored and validated (`server/tools/settings.ts:49`) and becomes a single profile line: `Question level: <level> — <one phrase>` (`server/chat/profile.ts`, `QUESTION_LEVELS`). Nothing enforces it. Every `AskUserQuestion` goes through `canUseTool` with kind `question` (`server/chat/session.ts:718`), so the server can count and deny calls.
- **Work tabs** load `settingSources: user, project, local` (`session.ts:633`), so a project's `CLAUDE.md`, `.claude/rules`, skills, agents and `.claude/settings.json` hooks apply in Claude OS tabs. Hooks fire only from the cwd's own `.claude/settings.json` (Project 2 probe).
- **The journal already holds what the metrics need** (`server/journal/db.ts`): `usage_messages` (per message: input, output, cache_read, cache_write, is_subagent, ts), `tool_calls` (name, skill), `subagents` (agent_type), and sessions by project. `/api/analytics` caches per range (`server/journal/index.ts:300`).
- **Project 2 artefacts to generalise:** `scripts/gate.ts` (ordered steps, stop at the first red step, suppression scan since the merge base), `check-touchpoints.ts` (JSON-driven), `check-lint-ratchet.ts` (caps may only go down against `HEAD`), the hook shapes in plan Task 11 (`protect-files`, `after-edit`, `stop-gate` with a tree fingerprint and a give-up after 3 blocks, `briefing` in ≤ 8 lines), `.claude/agents/*`, `.claude/skills/*`, `docs/specs/TEMPLATE.md`, `docs/solutions/README.md`.

## Goals

1. From a project (setup panel or the project's right-click menu, "Project kit…") or by asking Claude, the user gets one plan with a per-file diff, approves it once, and the kit is installed. Nothing is written before that approval.
2. The kit adds ≤ 3k tokens to a project's starting context (`CLAUDE.md` ≤ 60 lines, unconditional rules ≤ 40 lines, 3 agent descriptions, 0 model-visible skills), measured by a probe.
3. Every command the kit writes has a source: a file and key in the project, or a binary found on `PATH`. The server rejects an invented command.
4. Re-applying the same kit version gives an empty plan. A newer kit version updates only files the user has not edited; edited files are merged three-way or left untouched and flagged; files the user deleted stay deleted.
5. TS/JS, Python, Go and Rust are detected with their tools. A missing tool removes its step and is named in the preview. An unknown stack still gets the process layer and the size and suppression checks.
6. The three question levels produce a measurably different number of questions, and the server enforces part of the difference.
7. Analytics shows a per-project panel of section 16 metrics before and after the kit was installed, using no Claude calls.

## Non-goals

- Changing the project's lint, format, type or test configs, adding dependencies, or touching CI, git hooks, `core.hooksPath` or any git config. Lint-limit proposals arrive later through `/promote` as diffs for the user.
- Applying the kit to the Claude OS repo itself, which has its own dev kit. The engine refuses `paths.repo` and anything inside it.
- Terminal `claude` sessions outside Claude OS get the kit files but not the question-level block or its cap.
- Metrics that need a spec↔session link ("idea → PR" time, tokens per feature, corrections per feature); they come later.
- Wiki memory (Project 4); routines, CI agent, sandbox (manifest 18.6–18.8).

## Anti-goals

- The user's context grows: a model-visible kit skill, an unconditional rule over budget, a long `@import`, or a nested `CLAUDE.md` that loads by accident.
- The project's own tooling breaks or slows down: a hook that blocks because of the kit's own bug, a Stop gate over 90 s that keeps running, a formatter rewriting files the project never formatted.
- A user edit is overwritten, or a file the user deleted comes back.
- Git config, remotes, lockfiles, `package.json`/`pyproject.toml`/`go.mod`/`Cargo.toml` change.
- Claude approves its own plan, or the kit runs project code (tests, scripts) before the approval.

## Design

### 1. Where the kit lives (decision)

**The engine is core code; the content is a shipped OS plugin.** `server/tools/projectKit.ts` (split into `kitDetect.ts`, `kitPlan.ts`, `kitApply.ts` under the 300-line cap) does stack detection, rendering, the plan and diffs, three-way merges, writes with `backupFile` + `ctx.audit`, and the lock. `plugins/project-kit/` holds `plugin.json` (version = kit version), `kit/` templates, and a template index `kit/files.json` (`{ path, owner: "kit"|"seed", stacks?, when? }`). The manifest gets a new component, `contains.kit: "kit"`. Enabling a plugin with it installs **nothing globally**; it only shows the "Project kit…" actions. `validateManifest` and `root/reference/plugins.md` gain the component (touchpoint).

Why: content the user may customise follows Project 1's rule. A copy in `config/plugins/project-kit` wins by id, and agent-installed core updates never touch it. Changed shipped templates arrive behind the existing tree-hash "Update" consent before any hook code reaches a project. The deterministic parts (hashes, merges, idempotence) need tested code; an LLM following a skill cannot guarantee them. Rejected: a global `project-kit` skill that lets Claude copy templates (not idempotent, costs tokens on every apply, and its description would load into every session); all of it in core (users could not grow their own kit); a template git repo (manifest 18.11; needs a remote and does not merge updates).

Templates avoid loadable names in the Claude OS repo: `kit/claude/…` becomes `.claude/…` and `CLAUDE.md.tpl` becomes `CLAUDE.md` at render time, so sessions in the Claude OS repo never load them as nested instructions.

### 2. What the kit writes into a project

| Path | Owner | Content |
|---|---|---|
| `CLAUDE.md` | seed | ≤ 60 lines: Commands (detected, each traceable to its source), How we work (pointer to `00-workflow.md`), Gotchas, Decisions not in code, Pointers. Empty sections stay as `<!-- -->` comments, which Claude Code strips. |
| `.claude/rules/00-workflow.md`, `10-code-standard.md` | kit | Generic forms of Project 2's rules: task contract, systemic change, finishing = gate output shown; size limit and ratchet, no suppressions, comments say why. Plus one line: "always ask, at any question level: push or remotes, deleting data, a new dependency, lint/format/CI config". Together ≤ 30 lines. |
| `.claude/rules/20-mistakes.md` | seed | A header only; `/compound` fills it (≤ 10 lines). |
| `.claude/rules/<area>.md` | seed | Path-scoped, only from migration (section 4) or detected test globs (`tests.md`). |
| `.claude/kit/hooks/{protect-files,after-edit,stop-gate,briefing}.mjs` | kit | Node, no dependencies, data-driven by `kit.json`. A hook's own error exits 0 with one warning line (fail-open). |
| `.claude/kit/gate.mjs`, `touchpoints.mjs`, `size.mjs` | kit | One gate (section 3). |
| `.claude/kit/kit.json` | kit (generated) | Stacks, commands with `from`, related-test mode, formatter, protected globs, limits, `docsDir`, budgets. |
| `.claude/kit/lock.json` | engine | `{ kit, installedAt, files: { path: sha256 of what the kit wrote } }`. Tracked, so teammates share it. |
| `.claude/kit/size-baseline.json` | seed | Files over the limit at install with their caps; caps only go down. |
| `.claude/agents/{reviewer,scout,test-runner}.md` | kit | Generic versions of Project 2's agents. Models: inherit, haiku, sonnet. Tools restricted as in Project 2. Commands come from `kit.json`. |
| `.claude/skills/{spec,feature,split-file,compound,handoff}/SKILL.md` | kit | ≤ 40 lines each, all `disable-model-invocation: true`. They use superpowers skills when installed and carry inline steps otherwise. |
| `.claude/settings.json` | merged | Kit hook entries (recognised by `.claude/kit/` in the command), `allow` for detected commands and `git status/diff/log`, `deny: Edit(./.claude/kit/**)`, `ask: Bash(git push*)`. Existing keys and entries are never removed or reordered. |
| `docs/specs/TEMPLATE.md`, `docs/plans/README.md`, `docs/solutions/README.md` | kit | As in Claude OS. |
| `docs/rules/{common-mistakes,pattern-candidates,touchpoints,testing}.md`, `touchpoints.json` (`[]`) | seed | Ledgers; `testing.md` lists the detected contours. |
| `.gitignore` | merged | A marked block (`# claude-os-kit:start/end`): `CLAUDE.local.md`, `.claude/settings.local.json`, `docs/handoff/`. |

`docsDir` defaults to `docs`. When `docs/` is a published site source (`mkdocs.yml`, `docusaurus.config.*`, `.vitepress/`), it becomes `dev-docs`. A file that already exists at a kit path and is not in the lock is **kept** and listed as such, never replaced.

### 3. Stack detection, commands and the gate

`kitDetect(root)` reads files only and runs no project code. It returns stacks (a monorepo yields several, each with its folder) and commands with provenance:

| Stack | Signals | Commands taken from (never invented) | Related tests at edit (contour A, ≤ 10 s) | Formatter at edit |
|---|---|---|---|---|
| TS/JS | `package.json`; lockfile picks npm/pnpm/yarn/bun | `scripts.{typecheck,lint,test,test:unit,build,e2e}`; `tsc --noEmit` only if `typescript` is a dependency and there is no script | vitest `related --run`, jest `--findRelatedTests`, node:test one-level import scan (Project 2), else none | only if a prettier/biome config exists |
| Python | `pyproject.toml`, `requirements*.txt`, `setup.cfg`; `uv.lock`/`poetry.lock` pick the runner | `[tool.*]` sections present (pytest, ruff, mypy, pyright) and the binary resolvable through the runner | `pytest --testmon` if installed, else `test_<stem>.py` by name | `ruff format` if configured |
| Go | `go.mod` | `go vet ./...`, `go test ./...`; `golangci-lint run` if `.golangci.*` exists and the binary is on `PATH` | `go test ./<dir>/` | `gofmt -w` |
| Rust | `Cargo.toml` | `cargo check`, `cargo test`; `cargo clippy -- -D warnings` if clippy is installed | deferred to Stop (crate-wide) | `rustfmt` if `rustfmt.toml` exists |
| Any | `Makefile`, `justfile`, `Taskfile.yml` | targets named `test`, `lint`, `check`, `typecheck`, `build` win over the inferred ones | — | — |

A missing tool removes that step, `kit.json` records `skipped: "<tool> not found"`, and the preview names it. Unknown stack: no typecheck, lint or test steps; the gate keeps size, suppressions and touchpoints.

**Gate** (`node .claude/kit/gate.mjs`; the Stop hook and the user run the same thing), steps in order, stopping at the first red one, printing failures only: typecheck → lint (`--max-warnings 0` only if the project's lint script already uses it; the kit never adds flags) → `size` (non-blank lines per tracked source file, tests and generated files excluded, limit 300 or 400 for UI components; a file over the limit not in the baseline, or a baseline file above its cap, fails; the baseline may only lose entries or lower caps against `HEAD`) → new suppressions since the merge base with the default branch (stack patterns: `@ts-ignore|@ts-expect-error|eslint-disable|biome-ignore`, `# noqa|# type: ignore`, `//nolint`, `#[allow(`) → touchpoints (skipped while the list is empty) → unit tests. On the first run, a gate over 90 s writes one line to the user and to `docs/rules/testing.md`, and moves the unit step to the test-runner agent; it never runs unbounded.

**Hooks** as in Project 2: `protect-files` (`.env*`, `.git/`, lockfiles, `.claude/kit/**`, plus generated folders detected by marker files: `dist/`, `build/`, `target/`, `node_modules/`, `__pycache__/`); `after-edit` (formatter if configured, the linter on the one file if it supports that, related tests; over budget means "deferred to Stop"); `stop-gate` (git tree fingerprint in `<git-dir>/claude-kit/state.json`; in a non-git folder, a dirty flag that `after-edit` sets; gives up after 3 blocks); `briefing` (≤ 8 lines: branch, dirty count, stray branches and worktrees, open plan items, latest handoff). Each run appends `{ hook, ms, ok }` to `<git-common-dir>/claude-kit/metrics.jsonl`, outside the tracked tree, capped at 1 MB.

### 4. Existing instructions: migrate, never overwrite

Sources: `CLAUDE.md`, `AGENTS.md`, `.cursorrules`, `.cursor/rules/*.mdc`, `.github/copilot-instructions.md`, `CLAUDE.local.md`. The engine marks the plan's `CLAUDE.md` entry `migrate` and the kit tab (section 5) has Claude draft it:

- Claude keeps verification commands, gotchas and decisions. It drops what the code shows (architecture, folder trees). Long procedures go to `docs/rules/<topic>.md` with a pointer line. Personal lines go to `CLAUDE.local.md`. `.mdc` rules with `globs` become path-scoped `.claude/rules/<name>.md` with the same globs.
- `AGENTS.md`, `.cursorrules`, `.cursor/rules` and the Copilot file stay byte-identical, since other tools read them. An existing `@AGENTS.md` import is kept only if `AGENTS.md` is ≤ 60 lines; otherwise its facts are deduplicated into `CLAUDE.md` and the import is dropped (the reason appears in the preview).
- The server validates the draft: ≤ 60 lines; every command in Commands equals a detected command or appears literally in a source file. A violation returns the offending line to Claude. The old `CLAUDE.md` is backed up (`backupFile`), and the preview shows the full diff.

### 5. Flow: one plan, one approval

1. **Entry.** The project's right-click menu and the setup panel show "Project kit…" with a status (not installed · vX · update to vY). Asked in the Home tab, the coordinator opens a work tab in the project (`open_session`) instead of doing the work itself. Both paths start microtask `project-kit` (`owner` route, `root/microtasks/project-kit.md`) in a work tab whose cwd is the project root.
2. **Plan.** Claude calls `kit_plan({ claudeMd?, rules?, answers? })` (MCP, in work tabs). The server detects, renders and diffs, stores the plan with an id and a hash of every target file, and returns a compact summary (files to add, update, merge, keep or skip, plus skipped tools). Claude asks only what the question level allows (section 6).
3. **Approve.** Claude calls `kit_apply({ planId })`. The tool is never in `allowedTools`, so it always goes through `canUseTool` → a permission card. For this tool the card renders the stored plan (file list, per-file diff collapsed). The user approves once. Claude cannot approve or edit the plan; a changed target hash means a stale plan, which is rejected and re-planned.
4. **Write.** Order: docs → rules/skills/agents → kit scripts → `kit.json`/`lock.json` → `settings.json` last (hooks protect themselves). Every change gets a backup and `ctx.audit('project.kit.apply', …)`. Then the gate runs once and its output is shown in the tab: this is the only point where project code runs.

**Update.** For each file in the new kit: absent and not in the lock → add. In the lock with a matching hash → replace. Edited by the user → `git merge-file -p` against the previous version's render (snapshots kept in `data/project-kit/<version>/`). A clean merge goes into the plan; a conflict leaves the file untouched and marked "needs merge", and the tab offers a merge with Claude. In the lock but missing on disk → skip forever. Seed files are never updated. **Remove kit**: deletes kit-owned files whose hash still matches and the kit's settings entries; seeds stay. Re-applying the same version with no drift produces an empty plan, and the card says "nothing to do".

### 6. Question level in behaviour

The single profile line becomes a block of ≤ 400 B per level (inside Project 2's 2 KB appended-block budget):

- **minimal**: "Do not ask. Pick the reading the code, docs and conversation support best, state each assumption in one line in your final message, continue. Ask only when blocked: readings lead to different irreversible results, or a required input exists nowhere."
- **balanced**: "Ask only when the intent has readings that change the solution: once, before the first edit, one AskUserQuestion with every such question, 2–4 options each, the recommended first. Otherwise state the assumption and continue."
- **thorough**: "Before a change to more than one file or a shared concept: one AskUserQuestion round with your assumptions, scope and rejected options. Then work without questions unless something new appears."

**Enforcement** in `canUseTool`: `AskUserQuestion` calls per user message are capped at minimal 1, balanced 2, thorough none. Over the cap, the call is denied with "Question level <x>: decide, state the assumption, continue." The always-ask list in `00-workflow.md` is independent of the level. **Kit skills read the level**: `/spec` at minimal writes the spec with `[?]` and a Claude's-calls list and no interview; balanced asks one grouped round; thorough interviews 3–5 questions per round until the template is full (manifest 4.6). The kit flow asks nothing at minimal (defaults throughout); at balanced it asks only about real ambiguity (two package managers, a monorepo, more than one git author in 90 days → settings scope `project` vs `local`); at thorough it also asks about limits (300/50/10 vs 400/80/15) and protected paths.

### 7. Measuring benefit (section 16, cheap)

`GET /api/analytics/kit?from&to`: one row per project with the kit, each metric for the 14 days before `installedAt` and the period after, against the manifest target. SQL over the journal plus a few small files; cached with `/api/analytics`; no Claude call.

| Metric | Source | Target |
|---|---|---|
| Starting context | input + cache_read + cache_write of the first main message per session (median) | < 20k tokens |
| Cache hit, main | cache_read / (input + cache_read + cache_write), `is_subagent = 0` | > 85 % |
| Subagent share | subagent tokens / total | < 40 % |
| Skills used | distinct `tool_calls.skill` in 30 days / project skills; count of model-visible skills + agents | ≥ 70 %; ≤ 15 |
| Loop A / B time | p50/p90 of `metrics.jsonl` (after-edit / stop-gate) | < 10 s / < 90 s |
| Red stops | stop-gate `ok:false` per session | trend down |
| Files over limit | `size-baseline.json` entries, now vs at install | −30 %/month |
| Unpromoted mistakes | `common-mistakes.md` rows with Seen ≥ 2 and empty enforcement | 0 |
| Pattern debt | `pattern-candidates.md` rows older than 21 days without a form | 0 |
| Questions | `AskUserQuestion` per session, by question level | minimal ≈ 0 |

It appears as a section on the Analytics screen and in the project page's kit status. Nothing new on the home surface.

### Touchpoints affected

`contains.kit` (`osPlugins.ts` validation, `root/reference/plugins.md`); microtask `project-kit` (`MICROTASK_ROUTES` + `root/microtasks/project-kit.md`, checked by `check:touchpoints`); MCP tools `kit_plan`, `kit_apply` (work-tab server; `kit_apply` added to `PROMPTED_TOOLS` in `server/chat/mcpTools.test.ts`); new contract types and routes in `shared/contract.ts`; ru/en strings; `QUESTION_LEVELS` texts (budget test); the Analytics contract.

## Order of work

1. Fixtures `test/fixtures/project-kit/{ts-npm-vitest,ts-pnpm-node-test,py-uv-pytest,py-reqs,go,rust,make-only,unknown,existing-claude-md,cursor-rules,agents-md-long,monorepo-ts-py,docs-site}`.
2. `kitDetect` with provenance. 3. Plugin `project-kit` with templates and `contains.kit`. 4. Plan, render, lock, merge, apply, remove. 5. Kit scripts (gate, size, touchpoints, hooks) generalised from Project 2, with unit tests. 6. MCP tools, microtask, permission-card rendering, menu and setup-panel actions. 7. Question-level block and cap. 8. Analytics endpoint and view. 9. Probes and one review run over the whole diff.

## Verification

- Per fixture (unit, temp copies): a detection snapshot; a plan snapshot; apply then re-plan → empty; every byte outside the plan unchanged; `package.json`, lockfiles and lint configs identical; `git config --list --local` identical; `settings.json` keeps the user's keys and order; `agents-md-long` and `cursor-rules` source files byte-identical.
- Update: bump the kit version over an edited `00-workflow.md` → clean merge; a conflicting edit → untouched and flagged; a deleted skill stays deleted; a seed never changes; remove → only hash-matching kit files leave.
- Validation: a `CLAUDE.md` draft with an invented command, or 61 lines → rejected with the line; a stale plan → rejected.
- Kit scripts: gate red on a new `# noqa` / `@ts-ignore`, on a file growing past its cap, and on a raised cap; green on a lowered cap. Hooks via piped JSON: `.env` blocked; a hook crash exits 0; three red stops → give up. Live per installed toolchain (go/cargo absent → the test says skipped and why).
- Question level: `profileBlock` text and size per level; the cap denies the second (minimal) or third (balanced) `AskUserQuestion` in one user message (fake Claude, as in `chat.test.ts:167`). Live probe `scripts/question-level-probe.ts` (SDK, haiku, first option auto-answered): 3 prompts (clear, ambiguous-reversible, ambiguous-irreversible) × 3 levels; expect counts minimal ≤ balanced ≤ thorough and minimal = 0 on the first two.
- Context: `memory-token-probe`-style probe on `ts-npm-vitest` before and after apply → delta ≤ 3k tokens; `/context` lists `CLAUDE.md` and 3 rules; reading a file under `plugins/project-kit/kit/` from a session in the Claude OS repo loads no kit instruction.
- `npm run gate` green; build and e2e for the menu, card and Analytics view (test-runner, background).

## Left to the builder

Exact template texts; module split; card and Analytics layout; fixture contents; the snapshot store format; detection edge rules (workspaces, `poe`/`hatch` tasks); generated-folder markers; probe model and prompts.

## Claude's calls (for the owner to check)

1. The engine is core code; templates are a shipped OS plugin with a new `kit` component that installs nothing globally. Users customise by copying it to `config/plugins/project-kit`.
2. Approval is one permission card on `kit_apply` showing the stored plan; Claude can plan but never apply on its own. The project kit has no "auto" mode.
3. Updates are tracked by a committed `.claude/kit/lock.json` of hashes and a three-way merge; seeds (`CLAUDE.md`, ledgers, baseline) are written once and never updated.
4. The question level gets a hard cap on `AskUserQuestion` per user message (minimal 1, balanced 2), on top of the level text.
5. The kit never edits lint, format or test configs and adds no dependencies. Size limits are enforced by its own Node `size` check with a ratchet; function and complexity limits wait for `/promote`.
6. Hooks go into the shared `.claude/settings.json` by default; with more than one author in 90 days, balanced and thorough ask for `local` instead.
7. Five skills (`spec`, `feature`, `split-file`, `compound`, `handoff`); `techdebt` and `promote` stay Claude OS-only for now.
8. The kit refuses the Claude OS repo, does not install git hooks, and a non-git folder gets a dirty-flag Stop gate instead of a fingerprint.
