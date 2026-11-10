---
name: split-file
description: Split one oversized file into cohesive modules without changing behavior, and lower its size cap.
disable-model-invocation: true
argument-hint: [path]
---
One file per run, no behavior change, no renames beyond file names, no improvements along the way.

1. Characterize: list every export of $0 and its callers (search for the file's import path). Public behavior without tests: add characterization tests first and get them green.
2. Map responsibilities: group functions by reason to change (parsing, validation, data access, orchestration, output). Each group becomes a file within the size limits in `.claude/rules/10-code-standard.md`, named after what it exports. Show the map and wait for the user's ok.
3. Move the code mechanically (cut and paste) and update the imports. A re-exporting module only when many callers import the old path.
4. Lock it in, in the same change: the entry of $0 in `.claude/kit/size-baseline.json` goes down to the new count, or away when the file fits the limit. The kit folder is protected: show the one-line change and ask the user to apply it. New files get no entry.
5. Check: the related tests, then the gate: `{{gate}}`.
