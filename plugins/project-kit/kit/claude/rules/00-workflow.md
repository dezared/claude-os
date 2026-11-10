# Workflow

## Task contract
Before the first edit of a non-trivial task, write four lines:
1. Goal in one sentence, and the spec or plan it follows.
2. Done-check: the exact commands that will prove it.
3. Scope: what you will touch and what you will not.
4. Touchpoints: shared concepts affected (`{{docsDir}}/rules/touchpoints.md`).

## Systemic change
- A concept used in several places (a union member, route, setting key, label, permission) is a system, not a line: search for an existing sibling, list every place it appears, change all of them. A missed place is a bug, not "out of scope".
- A registry the types cannot reach gets an entry in `{{docsDir}}/rules/touchpoints.json`. Never edit a check to make it pass.

## Finishing
- Done means the gate output is shown: `{{gate}}`.
- The user corrected you: add or bump a row in `{{docsDir}}/rules/common-mistakes.md`.
- Never decide these yourself; always ask, at any question level: push or remotes, deleting data, a new dependency, lint/format/CI config.
