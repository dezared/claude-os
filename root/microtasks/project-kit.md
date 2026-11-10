---
title: Project kit
title_ru: Набор проекта
---
Install or update the project kit in the project at `{root}`.

This runs in a work tab of that project: `kit_plan` and `kit_apply` exist only there. Without them (the root tab, the service session), call `open_session` with project `{project}` and this whole request as the prompt, then stop.

1. Call `kit_plan`. It writes nothing and lists the files per action, the skipped tools and the `ask` lines. To remove the kit instead, pass action `remove`.
2. Ask the user only what the `ask` lines list, in one round, then call `kit_plan` again with `answers`. No `ask` lines: ask nothing.
3. An entry `migrate` means the project has its own instructions. Draft `CLAUDE.md` from the sources it names and call `kit_plan` again with `claudeMd`, and `rules` for the parts you move:
   - keep verification commands, gotchas and decisions; drop what the code shows (architecture, folder trees);
   - at most 60 lines; every command under Commands is a detected one or appears literally in a source file;
   - long procedures go to `docs/rules/<topic>.md` with a pointer line, personal lines to `CLAUDE.local.md`, `.mdc` rules with `globs` to `.claude/rules/<name>.md` with the same globs;
   - `AGENTS.md`, `.cursorrules`, `.cursor/rules` and the Copilot file stay as they are; keep an `@AGENTS.md` import only when `AGENTS.md` has at most 60 lines.
   A rejected draft names the line: fix it and plan again.
4. Call `kit_apply` with the plan id: the user approves the plan on its card. Refused as not approved: ask the user to switch the tab to the Default mode, then call it again. Never retry an apply the user denied; a stale plan needs a new `kit_plan`.
5. Show the gate output as it came and say in one line how many files were written. An entry `needs-merge` was left untouched: offer to merge it with the user.
