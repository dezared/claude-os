---
name: promote
description: Turn ledger rows over the threshold into skills, rules, tests or checks; hook and lint-config changes only as a proposal.
disable-model-invocation: true
---
1. Read `docs/rules/common-mistakes.md`, `docs/rules/pattern-candidates.md` and the tags in `docs/solutions/*.md`.
2. Over the threshold: a row seen 3 times, or 2 times with at least 30 minutes in total, whose status is not shipped and whose Fix column names no enforcement yet.
3. For each, pick the cheapest form that makes it impossible or automatic: a typed registry or a test, an entry in `docs/rules/touchpoints.json`, a line in a `.claude/rules/` file (path-scoped when it concerns certain files), a skill (`.claude/skills/<verb>/SKILL.md`, `disable-model-invocation: true`, at most 40 lines, reusing superpowers skills by name), an agent (`.claude/agents/<name>.md`, frontmatter `name` equal to the file name).
4. Write those yourself with the `superpowers:writing-skills` skill for skills, keeping the budgets: `CLAUDE.md` 60 lines, unconditional rules 50 lines in total (`scripts/devkit.test.ts`).
5. Hooks and lint config (`.claude/hooks/**`, `.claude/settings.json`, `.githooks/**`, `.oxlintrc.json`): show the exact diff as a proposal for the user and do not apply it.
6. Update the ledger rows: Fix names where it is enforced now, status shipped with the date. Remove lines from `CLAUDE.md` or rules that the new form makes redundant.
7. `npm run gate` green; report what was written and what is proposed.
