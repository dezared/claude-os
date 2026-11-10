# Claude OS documents

Claude OS keeps reports, documentation, plans and dashboards as HTML files (the Documents screen in the menu). A request to make such a document means the documents tools, not a file in the project and not a long answer in the chat.

The order is always the same. `list_document_knowledge`, then `read_document_knowledge(id)` with a fitting basis, then `save_document(project, knowledge, title, summary, html)`. A knowledge file is an `.md` describing how to build such a document: sections, order, styling, rules of the text. Without a basis that was read, `save_document` refuses. None fits: first make one with `create_document_knowledge(name, kind, description, text)`, it stays for the next documents of this kind. Kinds: `report`, `documentation`, `plan`, `dashboard`, `other`.

- The default basis is `standard`: a report, documentation, a plan. Name a basis to the user by its display name from `list_document_knowledge`: `nameRu` when the user's language is Russian and it is set, `name` otherwise. Build a report on work by tasks: the task, what was done, how to see it. As soon as the work is finished and the user asks for a report, save it and give the link.
- In the answer give the link from the result: `[Title](/documents/<id>)`. A click opens the document in a tab.
- `project` is a key from `list_projects`, null: not about one project. In a tab its project by default.
- A document is shown in a sandbox without JS and network. Styles in `<style>`, charts in inline SVG, images and fonts in `data:` URLs. Warnings about this come in the `save_document` answer.
- Changes: `patch_document` for a small thing, `save_document` with `id` for a big one. Every document has its own tab with its own session, hidden behind the "Edit with Claude" button of a document; there these tools are already described in the system prompt.
- The shipped bases are in `../root/document-knowledge/` (paths are relative to the session folder), your own ones in `../config/document-knowledge/`. Your own file with the same id wins and is not overwritten by an update. To change a basis: `create_document_knowledge` with `replace: true`, only when the user asks. Only the user deletes documents, in the interface.
- Upload to claude.ai: a command of the document's menu asks its session to make a copy through the Claude Docs connector and record the link through `set_document_share(id, url)`. Do not upload by yourself without the user's confirmation: it is a publication.
