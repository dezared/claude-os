# Claude OS: development

Claude OS is a local panel over Claude Code: a Node server (`server/`), a React interface (`web/src/`) and the types both import (`shared/`). This file is for sessions that change that code. Code map and change order: `docs/rules/architecture.md`.

## Commands

- `npm run typecheck`: tsc, about 2 s.
- `npm test`: the unit tests under `server/` and `scripts/`, about 70 s. One file: `node --disable-warning=ExperimentalWarning --test <file>` (`--test-name-pattern` narrows it).
- `npm run lint`: oxlint, warnings count as errors.
- `npm run gate`: typecheck, lint, lint ratchet, shippable, touchpoints, new suppressions, unit tests; stops at the first red step.
- `npm run build`: after any change under `web/`; writes `dist/web`.
- e2e: only through the test-runner agent, in the background.
- `npm run check:shippable`: tracked files carry no Cyrillic outside the allowed places, no home paths, no private words.
- `npm run check:touchpoints`: registries the type system cannot see (`docs/rules/touchpoints.json`).

## Gotchas

- Node runs `.ts` directly (type stripping, `erasableSyntaxOnly`): no enums, namespaces or parameter properties; imports carry the `.ts` extension.
- TypeScript 7 is native and has no JS API, so typescript-eslint does not work; the linter is oxlint.
- Product sessions live in `root/`, `service/`, `setup/` and do not see this file, the rules, skills or agents here (`server/chat/devIsolation.ts`).
- A `server/` or `shared/` change needs a server restart. A work tab cannot restart the server: ask the user or the root tab. A web change needs `npm run build` and a window reload.
- `config/`, `data/`, `vault/` are user data: never edit them for a core change, never commit them.
- Cyrillic only where `check-shippable` allows it (`ru.ts`, `*Ru` fields, tests, e2e).
- e2e needs `dist/web` built in the same worktree and preloads `e2e/env.ts` (under WSLg it drops `WAYLAND_DISPLAY`).
- The root tab does not edit the core; core changes happen in a Claude OS project tab, where this kit and the gate apply.

## Decisions not in code

- Shipped vs user: `bootstrapConfig` copies `defaults/` into `config/`, adds missing keys and appends new shipped records once; a user record with the same id wins and is never overwritten. A user plugin in `config/plugins/<id>` wins over `plugins/<id>`.
- Prompts say "the user", never a name; interface element names go through `PROMPT_LABELS` (`server/chat/profile.ts`).
- `main` is the only long-lived branch. A task gets a `task/<slug>` branch in a worktree under `.worktrees/` (symlink `node_modules` from the main checkout), is merged into `main`, then branch and worktree are deleted. Nothing is pushed.
- One review per project, at the end; no per-task review.

## Read next

- `.claude/rules/00-workflow.md`: task contract, systemic changes, finishing.
- `docs/rules/`: `architecture.md`, `touchpoints.md`, `code-style.md`, `testing.md`, the ledgers `common-mistakes.md` and `pattern-candidates.md`.
- `docs/specs/TEMPLATE.md` for a new spec; `docs/solutions/` for lessons by tag.
