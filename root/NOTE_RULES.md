# Note rules (memory)

One fact per note, in English. Every write is checked; a malformed note is rejected with the reason.

---
name: kebab-case-name   # = file name, unique
description: one line, ≤120 chars: the question this note answers
metadata:
  type: user | feedback | project | reference
  tags: [one, two]      # 1–3, kebab, reuse the project's tags
---
The fact in one or two sentences.
**Why:** …  **How to apply:** …  (feedback, project)   Source: URL or path (reference)

- MEMORY.md lists some notes; memory_search finds all: use it before work on a topic and before writing.
- After meaningful work, note what code and git cannot tell: decisions and why, bug causes, constraints, preferences.
- Update a matching note, never duplicate. Notes are unlimited.
- Body under 1500 characters, no headings. Link [[name]] only when needed.
- Never edit MEMORY.md. Fix or delete a note that became false.
