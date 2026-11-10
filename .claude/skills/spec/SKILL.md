---
name: spec
description: Write a spec for a Claude OS change from an interview, with this repo's template, touchpoints and lessons.
disable-model-invocation: true
argument-hint: [slug]
---
Goal: `docs/specs/<YYYY-MM-DD>-$0.md` filled from `docs/specs/TEMPLATE.md`. Do not write code.

1. Read `docs/specs/TEMPLATE.md`, `docs/rules/architecture.md`, `docs/rules/touchpoints.md`, and the lessons whose tags match the request (`rg -l "tags:.*<tag>" docs/solutions`).
2. Run the `superpowers:brainstorming` skill for the interview and the design, with these additions:
   - Evidence: check the code, data or a live probe instead of assuming; cite `file:line` and numbers.
   - Touchpoints: every shared concept the change touches, each place from `touchpoints.md` plus a sibling `rg`.
   - Prompt cost: a change to a product prompt states its bytes against the budgets in `.claude/rules/prompts.md`.
   - Verification: acceptance criteria as test names, each with its contour (A, B or C in `docs/rules/testing.md`).
3. Write the spec in the template's sections, at the path above (not the brainstorming default). Mark open points `[?]`; list decisions you made yourself under "Claude's calls".
4. `npm run check:shippable` stays clean: the spec is tracked, so no names and no home paths.
5. End with: "Next: `/feature docs/specs/<file>` in a fresh session."
