---
title: Configure a project kit
title_ru: Настроить набор проектов
input: description
---
Change the Claude OS project kit "{name}" (plugin `{kit}`, {source}, folder `{path}`). Read the plugins reference (its `kit` part) first.

What the user wants:

{description}

1. A shipped kit (in `../plugins/`) is never edited in place: copy its folder to `../config/plugins/{kit}/` under the same id first and work on the copy, which wins by id. A kit already in `../config/plugins/` is edited there.
2. Change the templates in `kit/` and their index `kit/files.json`. Keep the template rules: names under `claude/` and `CLAUDE.md.tpl`, every index path exists, no symlinks, the placeholders only as listed in the reference. Keep the kit lean: every line it adds loads into the projects' context.
3. Raise the `version` in `plugin.json` (the patch number for wording, the minor one for new files): projects see an update only for a new version.
4. Do not enable, update or apply anything yourself. Say in two lines what changed and that the user presses "Update" on the kit's tile on the project kits screen, then updates the projects from there.
