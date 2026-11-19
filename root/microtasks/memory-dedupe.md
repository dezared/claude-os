---
title: Merge duplicate notes
title_ru: Объединить дубли заметок
---
Merge duplicate memory notes of project {project} in the Claude OS vault. Goal: {goal}.

Notes Claude OS marks as duplicates (same description or a name taken twice):
{context}

Read each group. When two notes hold the same fact, keep the clearer one, move anything only the other says into it, point [[links]] at the kept name, and delete the other only after the user agrees. Notes that only look alike stay: give each a description that tells them apart. Edit with normal edits so each goes through the permission prompt; never edit MEMORY.md. End with a short list: kept, merged, renamed.
