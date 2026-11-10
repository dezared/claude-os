# Testing: three contours

| Contour | Runs | When | Budget |
| --- | --- | --- | --- |
| A | oxlint on the edited file and the unit tests that import it | after each edit (`after-edit.mjs` hook) | <= 10 s |
| B | `npm run gate`: typecheck, oxlint, lint ratchet, `check:shippable`, `check:touchpoints`, new suppressions, `npm test` | Stop, pre-push, before merging a task branch into `main` | <= 90 s |
| C | `npm run build` and e2e | in the background; before merging a task that touches `web/`, `e2e/` or `desktop/`; the end-of-project review | minutes |

## Measured (2026-11-10, 4 cores, Node 22.23; load average 2-4 at the start of each run)

- `npm run typecheck`: 2.3 s. `npm run lint`: 0.2 s.
- `npm test`: 70 s wall at 679 tests (689 after the review fixes). The files that take 3 s or more alone are `SLOW_TESTS` in `.claude/hooks/after-edit.mjs` (13 files; `server/chat/chat.test.ts` is the slowest).
- Contour A (`after-edit.mjs` on `server/chat/profile.ts`: oxlint and its 2 related test files): 0.6 s.
- `npm run gate`: green in 74-89 s before Project 3; 106 s on an idle machine after it (load 0.2), over the 90 s budget. `npm test` is most of it; the kit tests add about 13 s. The Stop hook on an unchanged tree: 0.04 s.
- `npm run e2e` (concurrency 2): 422 of 422 green in 1011 s.
- e2e (2026-11-10, 416 tests; peak = largest drop of `MemAvailable`, sampled every second): `e2e:serial` 1090-1293 s, peak 1.0-1.8 GiB; `npm run e2e` (concurrency 2, one Chromium per file) about 849 s, peak 1.8 GiB. One shared browser server (`chromium.launchServer`) was tried and dropped: the same speed, no less memory (1.9-2.3 GiB), more timing flakes.
- Project kit tests, each file alone (2026-11-10, load average 9-10, so slower than on an idle machine): `kitApply` 8.6 s (12 tests, every fixture applied), `kitPlan` 3.1 s, `kitTools` 1.9 s, `kitScripts` 1.8 s, `kitDetect` 1.6 s, `kitRender` 1.3 s, `kitMetrics` 0.5 s, `kitMerge` 0.3 s, `kitTemplates` 0.2 s; about 19 s in a row. Idle re-measure after the review fixes: `kitApply` 9.7 s, `kitScripts` 8.4 s, `kitPlan` 2.4 s, all kit files together 13.5 s; these three are in `SLOW_TESTS`.
- Known flake: `e2e/progress-widget.test.ts` "the widget follows its rows" fails now and then with `back to one row: 95 vs 91`, in serial as well as in parallel runs, and passes alone. Cause not found yet.

## Live probes (paid haiku calls, run by hand, never in `npm test`)

- `scripts/kit-context-probe.ts [fixture] [--keep]`: a temp copy of a kit fixture, the kit applied through `planKit`/`applyKit` with a stub gate, one one-turn query before and after (project and local settings only). No server needed. 2026-11-10 on `ts-npm-vitest`: 14944 → 16589 tokens, delta +1645 (budget 3000); `/context` in the copy lists `CLAUDE.md` and the three rules (about 1.0k tokens), the three agents (155) and no kit skills.
- `scripts/question-level-probe.ts`: 3 prompts × 3 levels, 9 runs, about 2.5 min. 2026-11-10, run 1: minimal 0/0/0, balanced 0/0/1, thorough 0/1/0 (clear / ambiguous-reversible / ambiguous-irreversible); verdict `ambiguous-irreversible: minimal 0, balanced 1, thorough 0 is not ordered`. Run 2: minimal 0/0/0, balanced 0/0/0, thorough 0/1/1, verdict ok. One question either way is noise at n=1; balanced rarely asks on these prompts.

## Running things

- One file: `node --disable-warning=ExperimentalWarning --test <file>`; `--test-name-pattern` narrows it.
- Server tests use `server/memory/testkit.ts`: `makeKit()` gives `ctx`, `app` (`app.inject` for requests), `paths` in a temp dir, `kit.audits`, `kit.topics`, `write()`, `until(cond)`. Look at the neighbouring test first. Titles are lowercase sentences stating the behaviour.
- Web files have no unit tests: lint at edit, typecheck in the gate, e2e in contour C.
- e2e needs `npm run build` in the same worktree first and preloads `e2e/env.ts` (it removes `WAYLAND_DISPLAY` on Linux so Chromium falls back to X11). Each e2e file launches its own Chromium, so the default concurrency (cores - 1) runs out of memory here: `npm run e2e` runs two files at a time, `npm run e2e:serial` one. Another session shares the machine, so wrap it: `flock /tmp/claudeos-e2e.lock npm run e2e`.
- When even a blank page cannot be screenshotted on the machine, say that e2e did not run rather than reading its failures as yours.
- A visual change: render the component and, where a browser works, take a screenshot; otherwise say plainly it was not seen.
