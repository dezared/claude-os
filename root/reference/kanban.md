# The kanban board

- Cards: `list_kanban_cards`, `add_kanban_card`, `move_kanban_card`, `take_kanban_card`, `update_kanban_card`. Columns in order: `backlog`, `todo`, `doing`, `polish`, `done`; the `move_kanban_card` description gives their labels. A new card goes to `backlog` by default.
- The `id` is like in Jira: the project prefix and a number (`OS-21`); the user refers to tasks by these ids. `project` is a key from `list_projects` or null for a general card.
- Took a task into work: call `take_kanban_card`, and the agent's name appears on the card. A card's `sessions` lists the sessions of the tabs that took it.
- `level` is only on cards of the Claude OS project: `user` for changes in `config/`, `root` for the core (`server`, `web`, `shared`, `e2e`).
- Only the user can delete cards, in the interface.
- Sprints: `list_kanban_sprints`, `add_kanban_sprint`, `update_kanban_sprint`, `remove_kanban_sprint`. A sprint is a third dimension over the same five columns, not a board of its own: a card is in a project, in a column and in at most one sprint (`sprint` is the sprint id, `null` takes it away). A card with no sprint or an unknown sprint id is in no sprint. Removing a sprint leaves its cards where they are, with no sprint.
- A card is the file `vault/kanban/<id>.md`: the fields in the frontmatter, the description in Markdown below it, the `path` field gives the path. It can be read and edited directly; change the column and the order with the tools.
