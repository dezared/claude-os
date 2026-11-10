---
name: techdebt
description: Report the tech debt of the repo; changes nothing.
disable-model-invocation: true
---
Report only. Do not edit, commit or delete anything.

1. Ratchet: every `overrides` entry in `.oxlintrc.json` with its caps against the base limits, largest overshoot first.
2. Lint: `npm run lint`, summarized by rule and file (it should be clean; anything else is the first item).
3. Markers: `rg -n "TODO|FIXME|HACK" server shared web/src scripts e2e desktop`.
4. Stale work: `git branch --list`, `git worktree list`; anything other than `main` is listed with its last commit date.

Output: at most 10 items ranked by payoff over effort, each with the path and a one-line next step (often `/split-file <path>`).
