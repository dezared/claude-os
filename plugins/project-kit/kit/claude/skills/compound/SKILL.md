---
name: compound
description: Record what the last task taught into the lessons and the ledgers, and draft the enforcement for repeated mistakes.
disable-model-invocation: true
---
Run at the end of a task (the last step of `/feature`) or after a correction.

1. Lesson: when the cause was not obvious, write `{{docsDir}}/solutions/<YYYY-MM-DD>-<slug>.md` as `{{docsDir}}/solutions/README.md` says: frontmatter `tags`, then symptom, root cause, fix, how to recognise it next time. Short. Nothing to learn: skip, say so.
2. Mistakes: for every mistake made or corrected in this task, add a row to `{{docsDir}}/rules/common-mistakes.md` or bump `Seen` and `Last` of the matching row.
3. Repeated work: if this kind of task came up before (`rg -l "tags:.*<tag>" {{docsDir}}/solutions`), add or bump a row in `{{docsDir}}/rules/pattern-candidates.md`.
4. A mistake row with `Seen` >= 2 and no enforcement yet: draft what makes it impossible, in this order of preference: a typed registry or a test, an entry in `{{docsDir}}/rules/touchpoints.json`, a lint rule. Show the draft; a lint-config or hook change is a proposal for the user, never applied here.
5. A mistake that every session must know: one line in `.claude/rules/20-mistakes.md` (at most 10 lines; drop the least useful line to make room).
6. Commit with the task: `docs: <lesson>`.
