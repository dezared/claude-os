# Code style

Enforced by oxlint (`.oxlintrc.json`) as errors, not warnings. Counts skip blank and comment lines.

## Limits and why

| Rule | Limit | Reason |
| --- | --- | --- |
| `max-lines` | 300 (`**/*.tsx`: 400) | a file that fits in one read is edited correctly; big files hide unrelated edits from each other |
| `max-lines-per-function` | 50 (`**/*.tsx`: 120) | a function is one idea; components carry markup, hence more |
| `complexity` | 10 | more branches than that cannot be tested by reading |
| `max-depth` | 4 | deep nesting hides the main path |
| `max-params` | 4 | more parameters want an options object or a split |
| `max-classes-per-file` | 1 | one file, one concept |
| `typescript/no-explicit-any` | error | `any` switches the compiler off exactly where it is needed |
| `typescript/ban-ts-comment` | error | suppressions hide the problem; fix it |
| `correctness` category | error | real bugs |

Off for `**/*.test.ts`, `e2e/**`, `server/**/fixtures/**`. Ignored: `web/src/lib/locales/*.ts` (data), `plugins/agentation/ui/agentation.vendor.js`, `plugins/*/tools/e2e.mjs`, `dist/`.

## The ratchet

Existing offenders have a per-file override with a cap set to today's value. `scripts/check-lint-ratchet.ts` (in the gate) compares `.oxlintrc.json` with the merge base with `main`, and `protect-files.mjs` compares each edit of it with `HEAD`, so `main` is covered too: a base limit may not rise, a rule may not be added below `error`, a plugin may not be dropped, an override may not be added or raise a cap. Tighten freely (lower a cap, delete an override after splitting a file), never loosen. A new file meets the base limits from the start.

## No suppressions

No `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `oxlint-disable`, `eslint-disable`. The gate fails on a new one in the diff. The only allowed marker is `// shippable-allow: <reason>` for a Cyrillic line that `check:shippable` would flag.

## No formatter

Prettier or oxfmt would rewrap about 7 % of lines (those over 120 characters) and touch nearly every file: one huge diff, conflicts with parallel worktrees, and formatting mixed into every task diff against the minimal-diff rule. Lint owns the substance; style is "match the file". A one-commit format pass can be decided later.

## Match the file

Naming, structure, import style and comment density follow the file you are in. Minimal diffs: every changed line traces to the task. Do not reformat or "improve" unrelated code; mention it instead.

## Language and comments

- Code, comments, prompts, tool descriptions and server messages are English. Russian only in `web/src/lib/locales/ru.ts`, `*Ru` fields, tests and e2e (`CYRILLIC_ALLOW` in `scripts/check-shippable.ts`).
- Comments say why, in short full sentences.
- No absolute home paths and no private words (`config/private-words.txt`) in tracked files.
- Errors: `throw httpError(status, message)`. Small helpers before new ones: `readJson` (`server/tools/shared.ts`), `safely`, `sha256`, `backupFile` (`server/memory/util.ts`).
- TypeScript runs as-is under Node type stripping (`erasableSyntaxOnly`): no enums, namespaces or parameter properties; `.ts` extensions in imports.
