---
paths:
  - "root/**"
  - "service/**"
  - "setup/**"
  - "server/chat/profile.ts"
  - "server/chat/rootMcp.ts"
  - "server/tools/documents.ts"
---
# Product prompts

- Every line of a product prompt is loaded into every session of that kind and paid on every turn. Add a line only when a session gets something wrong without it; prefer a tool description (loaded on tool search) or a `root/reference/*.md` file read on demand.
- Budgets: `root/CLAUDE.md` 4 KB (40 lines), `service/CLAUDE.md` 2 KB, the block appended to a work tab 2 KB. `server/chat/promptBudget.test.ts` enforces them.
- Say "the user", never a name or "the owner"; the profile block adds the name and the language at run time.
- Name interface elements through `PROMPT_LABELS` (`server/chat/profile.ts`) so they follow the user's language; every label must occur in a prompt source.
- English only. Russian texts of microtasks and document knowledge go into `*_ru:` frontmatter keys.
- A tool a prompt names must exist and be allowed for that session kind.
