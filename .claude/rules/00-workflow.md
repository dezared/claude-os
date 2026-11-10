# Workflow

## Task contract
Before the first edit of a non-trivial task, write four lines:
1. Goal in one sentence, and the spec or plan it follows.
2. Done-check: the exact commands that will prove it.
3. Scope: what you will touch and what you will not.
4. Touchpoints: shared concepts affected (`docs/rules/touchpoints.md`).

## Systemic change
- A shared concept (union member, route, topic, setting key, MCP tool, label, microtask, permission) is a system, not a line: `rg -n "<an existing sibling>"`, list every place it appears, mirror all of them. A missed place is a bug, not "out of scope".
- A registry the types cannot reach gets an entry in `docs/rules/touchpoints.json`. Never edit a check to make it pass.

## Finishing
- Done means the `npm run gate` output is shown; a task touching `web/`, `e2e/` or `desktop/` also has a green build and e2e run (test-runner agent).
- Run `npm run gate` before merging a task branch into `main`.
- Git flow: a `task/<slug>` branch in a `.worktrees/<slug>` worktree, merged into `main`, then branch and worktree deleted. No push.
- The user corrected you: add or bump a row in `docs/rules/common-mistakes.md` and name the check that could enforce it.
