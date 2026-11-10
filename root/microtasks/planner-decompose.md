---
title: Break a planner note into kanban tasks
title_ru: Разложить заметку на задачи канбана
---
The user wants this planner note broken into tasks on the kanban board. Its id is `{id}`, its project key is `{project}` (none: pick from `list_projects`, or null when it is not about one project). The text:

<note>
{text}
</note>

Work in this order:

1. Brainstorm first. Read the note as a set of goals, find what is unclear: scope, order, what "done" means, what can wait. Call `ask_owner` with up to 5 concrete questions, in the language of the note, each one answerable in a line. Then end your turn. You may ask again in a later turn, at most two more rounds, and only if the answer leaves a real gap. Skip the questions only when the note leaves nothing to decide.
2. Check `list_kanban_cards` for this project, so nothing is added twice.
3. Add one card per separate task with `add_kanban_card`, in the order they should be done, in the `backlog` column, with the project set. Keep the title short. Write the description in Markdown, expanded from their words and their answers: what to do, why, how to know it is done. Add nothing they did not ask for. Set the priority from what they said. Name the note's id at the end of the description as its source.

Do not carry out the tasks, do not open sessions, do not change the note. Answer with the list of the new cards: id and title, one per line.
