# Mistake ledger

One row per mistake. When Seen reaches 2, promote it to enforcement (lint rule, hook, check, test) and say where in the Fix column.

| Mistake | Seen | Last | Fix |
| --- | --- | --- | --- |
| Building (`npm run build`) in the main checkout: the live server serves its `dist/web` | 1 | 2026-11-09 | Build only in your own worktree; the main checkout is read-only for tasks |
| After merging a web change into `main`, telling the user to run `npm run build` in the main checkout instead of running it | 1 | 2026-11-16 | The agent rebuilds the main checkout itself right after the merge; the user never runs commands. Candidate check: a post-merge hook that builds when `web/` changed |
| Running e2e at default concurrency: several Chromium instances run out of memory | 1 | 2026-11-09 | `flock /tmp/claudeos-e2e.lock npm run e2e` (two files at a time) |
| e2e under WSLg: Chromium picks Wayland and cannot render the WebGL map | 1 | 2026-11-09 | `e2e/env.ts` deletes `WAYLAND_DISPLAY` on Linux; always run e2e through the npm scripts or with `--import ./e2e/env.ts` |
| Editing `config/`, `data/` or `vault/` (user data) to solve a core problem | 1 | 2026-11-09 | Fix the core or `defaults/`; user data is never part of a core change |
| A theme palette tuned by eye: secondary text under 4.5:1 and flat, opaque surfaces in the light theme | 1 | 2026-11-11 | `scripts/theme-contrast.test.ts` checks every text token on every surface in both themes; glass stays see-through |
| Widget and plugin guidance with a fixed white tint (`rgba(255,255,255,.08)`), which vanishes in the light theme | 1 | 2026-11-11 | The `claude-os-widgets` and `claude-os-plugins` skills require `--color-*` tokens and name both themes |
| `e2e/voice.test.ts` "silence puts the field back": the voice input tooltip covers the toast's close button under parallel load | 2 | 2026-11-11 | Rerun the file alone before reading it as yours; promote to a fix (move the pointer off the mic before the click) |
| A visual effect on Home shipped without a frame measurement: an SVG `backdrop-filter` lens over the moving map dropped it to 3 fps | 1 | 2026-11-11 | Measure Home with `e2e/universe-perf.ts` (or a GPU-backed Chromium: `--use-gl=angle --use-angle=gl --disable-frame-rate-limit`) before and after any change to glass or the map; no SVG filters in `backdrop-filter` |
| `server/chat/btw.test.ts` "during a running turn" fails now and then, which can turn the Stop gate red spuriously | 3 | 2026-11-12 | Fixed: the test snapshotted the journal before the fake CLI wrote the user line; it now waits for that line (bcc9e15) |
| UI changes shipped without motion: tab badges, title width and status changes appear and resize in one frame | 1 | 2026-11-12 | `.claude/rules/web.md` motion rule: every appearance, removal, resize and state change animates with the `--ease-*` tokens; the final review checks it |
| A changed plugin folder stopped running until Update: the user reads "not updated" as "still works" | 1 | 2026-11-12 | `server/tools/osPlugins.ts` `activeUi`/`activeKit` run the current code with the permissions of the current manifest; `osPlugins.test.ts` and `e2e/plugin-api.test.ts` cover it |
| `server/chat/local-commands.test.ts` "/clear wipes the conversation": the answer to /clear showed in a turn sent right after it | 3 | 2026-11-12 | Fixed: `startTurn` no longer ends the /clear swallow, only its result or a new process does (`server/chat/session.ts`) |
| Projects list shipped flat with a separate "folders on disk" panel although the user asked many times for a file-tree of projects inside their folders | 2 | 2026-11-13 | The projects screen spec is a tree (folders > projects, like the files panel); an e2e asserts nested rows and no separate disk panel |
