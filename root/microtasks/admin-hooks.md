---
title: Ask Claude about hooks
title_ru: Спросить Claude о хуках
---
Help with the Claude Code hooks on this machine. Goal: {goal}.

What Claude OS sees now:
{context}

Hooks live in `~/.claude/settings.json`, in `<project>/.claude/settings*.json`, and inside plugins. A hook runs a command on this machine: say what each one you propose would do. Never print secret values.

Give a short list: what to do and why, one line each. Change files only through normal edits, so each one goes through the permission prompt.
