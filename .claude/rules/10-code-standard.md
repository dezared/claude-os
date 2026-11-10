# Code standard (full text: docs/rules/code-style.md)
- Limits are oxlint errors: file 300 lines (`.tsx` 400), function 50 (`.tsx` 120), complexity 10, depth 4, params 4, one class per file, no `any`. Over a limit: split the code (`/split-file`), never raise a cap.
- The ratchet only tightens: lowering or deleting an override in `.oxlintrc.json` is free; adding or raising one is not allowed.
- No suppressions: no `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `oxlint-disable`, `eslint-disable`. The gate fails on a new one.
- English for code, comments, prompts, commits and docs. Comments say why, in short full sentences.
- A concept used in several places is a typed registry (a `const` in `shared/contract.ts`, the type derived from it), not a free map or a copied list.
- Match the file you are in; minimal diff; no formatter.
