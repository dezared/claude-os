---
name: feature
description: Build a change from an approved spec, from the plan to a branch that is ready to merge.
disable-model-invocation: true
argument-hint: [spec path]
---
Follow the steps in order; show command output as evidence.

1. Read $0 and write the task contract (`.claude/rules/00-workflow.md`). Spec missing or vague: stop and suggest `/spec`.
2. Plan: use the scout agent to collect the files, then write `{{docsDir}}/plans/<YYYY-MM-DD>-<slug>.md` (the `superpowers:writing-plans` skill when installed): small tasks, exact paths, the test for each, checkboxes.
3. Branch: `task/<slug>` from the default branch (in a worktree with the `superpowers:using-git-worktrees` skill when installed).
4. Per task, test first (the `superpowers:test-driven-development` skill when installed): a failing test, the minimal code, the related tests green, a commit `<type>: <what>`, the plan's checkbox ticked.
5. A shared concept changed: search its siblings and update `{{docsDir}}/rules/touchpoints.md` and `touchpoints.json`.
6. The gate green, output shown: `{{gate}}`. Slow suites go to the test-runner agent, in the background.
7. Run the reviewer agent once against the spec; fix the gaps it reports.
8. Merging and pushing are the user's: say the branch is ready and what the gate printed.
9. Run `/compound`.
