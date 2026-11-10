---
name: handoff
description: Write the state of this session to the handoff folder so a fresh session can continue.
disable-model-invocation: true
---
Write `{{docsDir}}/handoff/<YYYY-MM-DD>-<branch>.md` (`git branch --show-current`; `/` in the name becomes `-`; no git: `local`). The folder is git-ignored: never commit it. Overwrite the same day's file for the same branch.

Sections, short, facts only:
- **Done**: what changed, with commits (`git log --oneline <default branch>..HEAD`) and files.
- **Left**: the open items, in order, with the plan file and its unticked checkboxes.
- **Decisions**: what was decided and why, including what was rejected.
- **Commands**: the commands that matter to continue (tests, gate), with their last result.
- **Broken**: what is red or unverified right now, with the failing output's key line.
- **Worktree**: path, branch, dirty files (`git status --short`).

End by telling the user the file path and the first thing the next session should do.
