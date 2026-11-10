---
title: Change a widget
title_ru: Изменить виджет
input: description
---
Change the Claude OS widget "{title}". Its entry in `../config/widgets.json` now:

{widget}

What the user wants:

{description}

Edit only this entry and keep its id. Keep `icon` and `description` filled and true to what the widget now shows. A number or a line of text: the simplest type that shows it, as described in your CLAUDE.md. Anything with structure (progress, a status, a list, a chart, a button), or an entry that already has a `view`: load the claude-os-widgets skill first and work on its view in `../config/widgets/`. A changed command or view stays pending until the user approves it on the widget: say so if that happens.
