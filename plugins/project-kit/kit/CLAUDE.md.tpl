# Working on this project

<!-- One or two lines: what this project is and what a session here usually changes. -->

## Commands

{{commands}}
- Gate: `{{gate}}`. Typecheck, lint, file size, new suppressions, touchpoints, unit tests, in that order; stops at the first red step and prints only failures.

## How we work

The task contract, systemic changes and finishing are in `.claude/rules/00-workflow.md`. A new feature starts with `/spec` and is built with `/feature`; `/compound` records what a task taught, `/handoff` passes the state to a fresh session.

## Gotchas

<!-- Traps a fresh session would fall into: environment quirks, slow or flaky commands, generated files. One line each. -->

## Decisions not in code

<!-- What the code cannot show: why something is done this way, what was rejected. One line each. -->

## Pointers

- `{{docsDir}}/rules/`: `testing.md`, `touchpoints.md`, the ledgers `common-mistakes.md` and `pattern-candidates.md`.
- `{{docsDir}}/specs/TEMPLATE.md` for a new spec; `{{docsDir}}/solutions/` for lessons by tag.
