---
title: Create a project kit
title_ru: Создать набор проектов
input: description
---
Create a new Claude OS project kit: a plugin folder whose `contains.kit` holds templates that Claude OS renders into the user's projects. Read the plugins reference (its `kit` part) first.

What the user wants from it:

{description}

The kits there now: {kits}. Claude OS shows at most 5 kits: with 5 already there, create nothing and say so.

1. Pick a short id (lowercase, hyphens) that no kit or plugin uses. Copy `../plugins/project-kit` to `../config/plugins/<id>/` as the starting point.
2. In its `plugin.json` set `id` to the folder name, a `name`, a one-line `description` and `descriptionRu`, `features` and `featuresRu`, version `1.0.0`, and `enabledByDefault` false.
3. Change the templates in `kit/` and their index `kit/files.json` to match the request. Keep the template rules: names under `claude/` and `CLAUDE.md.tpl`, every index path exists, no symlinks, the placeholders only as listed in the reference. Keep the kit lean: every line it adds loads into the projects' context.
4. Do not edit `../plugins/`, do not enable the plugin and do not apply the kit to a project. Say in two lines what the kit holds and that the user enables it on its tile on the project kits screen, then applies it to projects from there.
