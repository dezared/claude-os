# Known mistakes (full ledger: docs/rules/common-mistakes.md)
- Building in the main checkout: the live server serves its `dist/web`. Build only in your own worktree.
- e2e at the default concurrency: several Chromiums run out of memory. Use `flock /tmp/claudeos-e2e.lock npm run e2e` (two files at a time).
- e2e without `e2e/env.ts` under WSLg: Chromium picks Wayland and cannot render the WebGL map. Run e2e through the npm scripts or with `--import ./e2e/env.ts`.
- Editing `config/`, `data/` or `vault/` to solve a core problem: fix the core or `defaults/` instead.
