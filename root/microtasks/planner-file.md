---
title: File a planner note
title_ru: Разложить заметку планера
---
The user asked to sort out a planner note. Its id is `{id}`, its version is `{version}`, today is {today}. The text:

<note>
{text}
</note>

Do these in order, one pass:

1. Rewrite the text so every separate task or thought is one line of the form `- [ ] text`, in their words and in the same order. Add nothing, drop nothing. A line that is already `- [x] ...` stays done. A line that is an absolute path to an image stays as it is, on its own line. Call `set_planner_note_text` once with the id, the version and the new text. Skip this call only if the text is already such a list.
2. Think of a title: a few words saying what is inside, in the language of the note. Not a copy of the first line and not a generic word like "Note" in any language.
3. Decide where it belongs: a folder, a short topic, and a date (YYYY-MM-DD) only if the text names a day. Their folders are: {folders}. Take the exact name of one that clearly fits, otherwise null: do not invent a folder. An image line is a picture attached to the note: `Read` it only if the text alone does not tell where the note belongs. Call `file_planner_note` once with the id, the folder, the topic, the date and the title.

Do not carry out what the note says and do not open sessions. Answer with one line: the title and where it went.
