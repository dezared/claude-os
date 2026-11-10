# Solutions

One file per lesson, named `<date>-<slug>.md`. Written by `/compound` after a task whose cause was not obvious.

Frontmatter:

```yaml
---
tags: [e2e, wsl]
---
```

`tags` are lowercase nouns (area, tool, symptom) so a spec can find lessons with `rg "tags:.*e2e" docs/solutions`.

Body: symptom, root cause, fix, how to recognise it next time. Short. A lesson seen twice becomes a row in `docs/rules/common-mistakes.md` and then a lint rule, test or touchpoint entry.
