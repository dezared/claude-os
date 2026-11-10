---
name: feature
description: Build a Claude OS change from an approved spec, plan to merge into main.
disable-model-invocation: true
argument-hint: [docs/specs/<file>.md]
---
Follow the steps in order; show command output as evidence.

1. Read $0 and write the task contract (`.claude/rules/00-workflow.md`). Spec missing or vague: stop and suggest `/spec`.
2. Plan: use the scout agent to collect the files, then the `superpowers:writing-plans` skill. Save to `docs/plans/<YYYY-MM-DD>-<slug>.md`: small tasks, exact paths, the test for each.
3. Branch: the `superpowers:using-git-worktrees` skill with branch `task/<slug>` in `.worktrees/<slug>`, cut from `main`; symlink `node_modules` from the main checkout.
4. Per task, the `superpowers:test-driven-development` skill: failing test, minimal code, related tests green (contour A), commit `<type>: <what>`, tick the plan's checkbox.
5. A shared concept changed: sibling `rg` and `npm run check:touchpoints` (`docs/rules/touchpoints.md`).
6. `npm run gate` green, output shown. Touched `web/`, `e2e/` or `desktop/`: also the test-runner agent for build and e2e (contour C).
7. Merge into `main` locally, then delete the branch and the worktree. No push.
8. Run `/compound`.

No per-task review: one reviewer agent run per project, at the end, against the spec.
