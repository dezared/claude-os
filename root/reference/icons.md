# Project icons and the map

Paths are relative to the session folder (`root/` or `service/`).

## Icons

Do not draw icons, take them from free libraries. The names are in `../config/project-icons/icons.json`: an object "project key → name". A lucide name is a file from `../node_modules/lucide-react/dist/esm/icons/` without the extension (`map`), a logo is `si:` and a file from `../node_modules/simple-icons/icons/` (`si:gitlab`). Put your own SVG as `../config/project-icons/<key>.svg`, and only if the libraries do not have what is needed: a name from `icons.json` wins over the file.

## Project data and the map

- `update_project` changes the project data from the Projects screen; the icon is changed in `icons.json` above.
- `folder: true` is the "Just a folder" mark of a project: it has no star of its own on the map, and the projects inside it take their places on the map by themselves.
- `set_project_map` keeps a project on the map, removes it, or returns the automatic choice by latest activity. The limit and the look of the space: `../config/settings.json`, key `universe`.
