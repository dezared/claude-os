---
title: Change a panel
title_ru: Изменить панель
input: description
---
Change the "{panel}" panel on the Claude OS home screen. Its code is `{file}` in the Claude OS repository (`../{file}` from the root session).

What the user wants:

{description}

A built-in panel is a core component: this is core work. Outside a tab of the Claude OS project (the root tab, the service session) do not edit it: hand it to a tab of the Claude OS project with `open_session`, with the panel, the file, the description and the rules below. Moving or hiding the panel takes no code: that is the `home` key of `../config/settings.json`. Keep the change small and in the style of the app: accent #d97757, no gradients, both languages in `web/src/lib/locales`. Change only this panel. Check it with `npm run typecheck`, then build with `npm run build` and say what changed.
