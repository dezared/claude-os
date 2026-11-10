---
name: split-file
description: Split one oversized file into cohesive modules without changing behavior, and lower its lint cap.
disable-model-invocation: true
argument-hint: [path]
---
One file per run, no behavior change, no renames beyond file names, no improvements along the way.

1. Characterize: list every export of $0 and its callers (`rg -n "<file stem>\.tsx?['\"]"`). Public behavior without tests: add characterization tests first and get them green.
2. Map responsibilities: group functions by reason to change (parsing, validation, data access, orchestration, output). Each group becomes a file of at most 300 lines (`.tsx` 400) named after what it exports. Show the map and wait for the user's ok.
3. Move the code mechanically (cut and paste), update the imports with `.ts` extensions. A barrel file only when many callers import the old path.
4. Lock it in, in the same change: in `.oxlintrc.json` lower the override caps of $0 to its new values, or delete the override when the file meets the base limits. New files get no override.
5. Check: `npm run typecheck`, `npm run lint`, the related tests, `npm run check:lint-ratchet`, then `npm run gate`.
