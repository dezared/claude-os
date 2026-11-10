---
name: rg-context
description: Use when looking for where something lives in a codebase and a plain grep would return too much or too little. Ranks files by matches, shows the top files with surrounding lines, finds definitions by name, and keeps the output inside a line budget.
---

# rg-context

`rgc.sh` sits beside this file. Run it with bash, using this skill's base directory:

```bash
bash "<base directory>/rgc.sh" "retry limit" src
bash "<base directory>/rgc.sh" --def createOsPlugins
bash "<base directory>/rgc.sh" --top 3 --context 5 --budget 80 "pattern" path
```

It searches with ripgrep in smart case, skips generated folders and lock files, then prints:

1. The totals and the files ranked by matches. Tests, docs and fixtures rank below source with the same count.
2. The matches of the top files with surrounding lines, until the line budget runs out.
3. How to see the rest: the output ends with how many files were left out.

`--def NAME` looks for where NAME is defined instead of where it is mentioned, in the common forms of JS/TS, Python, PHP, Go, Rust, Java and shell.

Exit code 1 means no matches. Try a shorter pattern or a wider path before concluding that something does not exist.
