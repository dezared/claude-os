---
name: claude-os-actions
description: Draft. Use when asked for a button in a Claude OS work tab that runs a shell command for that tab's project (run the tests, open the build, deploy, clean a cache). Covers config/actions.json, the placeholders, approval and what the person sees. Not for home screen widgets (claude-os-widgets) or plugins (claude-os-plugins).
---

# Claude OS actions (draft)

This skill is a first version: check what it says against `server/tools/actions.ts` and `web/src/work/Actions.tsx` before relying on a detail, and fix this file where they differ.

The Claude OS root is the folder holding `server/`, `web/` and `config/` (from the root session it is `..`).

## What an action is

A button on the bar of every work tab, next to the built-in terminal button. A press runs one command with `bash -c` on the PC, in a folder, and shows its output (first 400 characters) as a toast. It is the same for every tab: an action is not tied to one project, the tab it is pressed in gives the folder.

Use it for a short command the person runs by hand often. Not for something long-running (60 s limit, then it fails), not for something that needs a terminal (use the built-in one), not for anything Claude should do (that is a prompt, or a widget's `action`).

## config/actions.json

An array; the server reads it on every request, no restart.

```json
[
  { "id": "tests", "title": "Tests", "command": "npm test 2>&1 | tail -20", "cwd": "{project}", "confirm": false }
]
```

- `id`: unique, never starting with `builtin:`.
- `title`: the button's label, short, in the person's language.
- `command`: a bash script. The tab's folder and session id arrive as `$1` and `$2`, never pasted into the text, so quote them (`"$1"`).
- `cwd` (optional): where it runs. `{project}` is the project's root, `{cwd}` the tab's folder, or an absolute path. Absent: the tab's folder, else the Claude OS root.
- `confirm` (optional): `true` asks before every run, in a popover showing the command. The server does not enforce it: it is for something the person should not run by accident.

## Approval

The command runs only after the person approves it, by the hash of its text: the first press shows the command and an approve-and-run button. Any edit of `command` asks again. Say so whenever you add or change one. The approval is stored in `data/`, out of reach of sessions: writing the config can never approve anything.

## Check before saying it is done

1. Run the command yourself in the folder it will get, with `bash -c '<command>' claude-os-action "<cwd>" ""`, and check it ends within 60 s and prints something short and useful (the toast shows 400 characters).
2. Validate the JSON (`python3 -m json.tool config/actions.json`).
3. Tell the person where the button is (the bar of any work tab) and that the first press asks for approval.
