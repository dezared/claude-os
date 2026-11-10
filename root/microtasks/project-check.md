---
title: Check the project setup
title_ru: Проверить настройку проекта
---
Audit the Claude Code setup of the project at `{root}` against its actual stack.

1. Identify the stack from its files.
2. Read `.claude/settings.json`, `.claude/settings.local.json`, `.mcp.json`, `CLAUDE.md`, `.claude/skills/`, and the global skills that apply.
3. List what is missing or wrong for this stack, for example frontend skills for a frontend project, each with a one-line reason. Do not list what is fine.
4. For each proposal show the exact diff or file to add. Make changes only through normal edits, so that each one goes through the permission prompt; nothing silently, and nothing that holds a secret.
