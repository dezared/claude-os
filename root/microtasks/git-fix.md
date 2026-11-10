---
title: Fix a git failure
title_ru: Исправить ошибку git
---
In `{cwd}`, this git action failed when the user clicked the button in Claude OS:

`{action}`

Git's output, verbatim:

```
{error}
```

The user authorised exactly this one action: {permission}. Nothing else is authorised: no force push, no reset, no clean, no history rewrite, no change to hooks or git config, no `--no-verify`. If the fix needs any of that, explain it and ask first.

Find the cause, fix what is in scope, then run the action again and report the result.
