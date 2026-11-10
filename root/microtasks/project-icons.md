---
title: Pick project icons
title_ru: Подобрать иконки проектов
---
Pick an icon from the free libraries for each project below. Do not draw icons.

Projects (key, then folder):
{projects}

1. For each project read only its README or manifest, enough to know what it is. Do not change anything in a project folder.
2. Choose one name that fits what the project does. The app ships two libraries, two levels above `{dir}`: `node_modules/lucide-react/dist/esm/icons/` (a name is the file name without `.mjs`, for example `map`) and `node_modules/simple-icons/icons/` (for a product or brand logo, written `si:` plus the file name without `.svg`, for example `si:gitlab`).
3. Write the names into `{dir}/icons.json`, one JSON object of project key to name. Keep the entries already there. The app shows the new icons by itself and reports a name it does not know.
4. Only if I ask for an icon the libraries do not have, add a custom one as `{dir}/<key>.svg` and leave that key out of `icons.json`, because a library name wins. File rules, or the app rejects the file: root `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">`; only `g`, `path`, `circle`, `ellipse`, `rect`, `line`, `polyline`, `polygon`; only geometry, `fill`, `stroke*`, `opacity`, `transform` attributes; no `style`, no scripts, no links, no `url()`; under 16 KB.
5. At the end list what you chose, one line each.
