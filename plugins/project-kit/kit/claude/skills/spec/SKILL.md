---
name: spec
description: Write a spec for a change from an interview, with this project's template, touchpoints and lessons.
disable-model-invocation: true
argument-hint: [slug]
---
Goal: `{{docsDir}}/specs/<YYYY-MM-DD>-$0.md` filled from `{{docsDir}}/specs/TEMPLATE.md`. Do not write code.

1. Read the template, `{{docsDir}}/rules/touchpoints.md` and the lessons whose tags match the request (`rg -l "tags:.*<tag>" {{docsDir}}/solutions`).
2. Interview by the question level in your instructions (none given: balanced):
   - minimal: no interview. Write the spec, mark each open point `[?]` and list every decision you made under "Claude's calls".
   - balanced: one AskUserQuestion round with every question whose answer changes the design, 2-4 options each, the recommended first.
   - thorough: rounds of 3-5 questions until every section of the template can be filled.
   With the `superpowers:brainstorming` skill installed, run it for the interview and the design within these limits; without it, follow the steps here.
3. Evidence: check the code, data or a live run instead of assuming; cite `file:line` and numbers.
4. Touchpoints: every shared concept the change touches, each place from `touchpoints.md` plus a search for siblings.
5. Verification: acceptance criteria as test names, each with its contour from `{{docsDir}}/rules/testing.md`.
6. Write the spec in the template's sections, at the path above. Open points `[?]`; your own decisions under "Claude's calls".
7. End with: "Next: `/feature {{docsDir}}/specs/<file>` in a fresh session."
