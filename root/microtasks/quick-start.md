---
title: Quick start
title_ru: Быстрый старт
input: request
---
The user pressed "+" for a new tab and wrote what they want to do:

<request>
{request}
</request>

Start this work in a tab; do not do the work yourself. Decide where it belongs:

1. Look with `list_projects` and `list_sessions`.
2. It goes on with a recent session: `resume_session(session_id, prompt)`. It belongs to an existing project: `open_session(project, prompt, title)`. It is something new: `create_project(name, prompt)`, with a short folder name taken from the request; the tool opens the tab itself.
3. The prompt is the request in the user's words plus what you found, clear without this conversation: the session in the tab does not see it.
4. More than one place fits: take the most likely one. Call `ask_owner` only when no choice is reasonable.

Answer in one line, in the user's language: what you opened and where.
