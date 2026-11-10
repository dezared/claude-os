# Note rules (auto memory)

One fact per note, in English. Claude OS checks every write and rejects a malformed note with the reason.

---
name: kebab-case-name           # = file name without .md, unique in the vault
description: one line, ≤120 chars: the question this note answers
metadata:
  type: user | feedback | project | reference
  tags: [one, two]              # 1–3, lowercase kebab, reuse existing tags
---
The fact in one or two sentences.
**Why:** …  **How to apply:** …  (feedback, project)   Source: URL or path (reference)

- Search first (memory_search); update the existing note, never duplicate.
- Keep what code and git cannot tell: decisions, reasons, constraints, preferences, external facts.
- Body under 1500 characters. No headings.
- Link [[name]] only when the note cannot be understood without the other.
- Never edit MEMORY.md: Claude OS builds it from descriptions.
- Correct or delete a note that became false.
