---
name: agentation-annotations
description: The user leaves fixes for the Claude OS interface through agentation, bound to elements. Use when they ask you to look at their notes, annotations or the fixes they marked.
---

# agentation notes

The user marks elements of the Claude OS interface with the agentation toolbar (toggled with the `/agentation` command). Notes arrive at the `agentation` MCP server.

1. Read the notes: `agentation_get_all_pending`. Each one has a comment, the element path, its classes and the text around it. All screens of the main window share one page, so tell the screen by the path and the text.
2. Mark a note as taken right away: `agentation_acknowledge`.
3. Make core changes (`server`, `web`, `shared`, `e2e`) in developer mode from the root `CLAUDE.md`: types, the affected tests, `npm run build`.
4. Close the note: `agentation_resolve` with a short summary. If you need the user's answer or the fix is not done, write `agentation_reply` and leave the note open. Close only what is verified.
5. `agentation_dismiss` only when the user asks for it.

If there are no `agentation_*` tools or the server does not answer, say so: the notes then stay in the browser and reach the server when it is back.
