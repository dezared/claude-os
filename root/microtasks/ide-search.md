---
title: Find IDEs the scan missed
title_ru: Найти IDE, которые не нашёл поиск
---
The deterministic scan in Claude OS found these IDEs: {found}.

Look for code editors and IDEs it missed on this machine (Windows through interop and WSL), read-only. For each one found, add an entry to the `ides.list` array of `../config/settings.json`, keeping everything else in the file:

`{ "id": "<name>-manual", "catalogId": "<name>", "name": "<display name>", "family": "plain", "exe": "<absolute path>", "side": "windows", "source": "manual" }`

Use family `vscode` for VS Code forks and `jetbrains` for JetBrains products. Such an entry runs only after the user approves it on the Settings screen. Report what you added.
