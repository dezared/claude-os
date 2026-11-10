# Mistake ledger

One row per mistake. When Seen reaches 2, promote it to enforcement (lint rule, hook, check, test) and say where in the Fix column.

| Mistake | Seen | Last | Fix |
| --- | --- | --- | --- |
| Building (`npm run build`) in the main checkout: the live server serves its `dist/web` | 1 | 2026-11-09 | Build only in your own worktree; the main checkout is read-only for tasks |
| Running e2e at default concurrency: several Chromium instances run out of memory | 1 | 2026-11-09 | `flock /tmp/claudeos-e2e.lock npm run e2e` (two files at a time) |
| e2e under WSLg: Chromium picks Wayland and cannot render the WebGL map | 1 | 2026-11-09 | `e2e/env.ts` deletes `WAYLAND_DISPLAY` on Linux; always run e2e through the npm scripts or with `--import ./e2e/env.ts` |
| Editing `config/`, `data/` or `vault/` (user data) to solve a core problem | 1 | 2026-11-09 | Fix the core or `defaults/`; user data is never part of a core change |
| `server/chat/btw.test.ts` "during a running turn" fails now and then with ENOENT, which can turn the Stop gate red spuriously | 2 | 2026-11-10 | Rerun the file alone before reading it as yours; cause not found yet, promote to a fix |
