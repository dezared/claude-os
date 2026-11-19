---
name: learn
description: Use when the user wants to learn something or take a course with the Claude OS Learn screen — start a track or roadmap for a topic, write the next lesson (an HTML article with a quiz and an exercise with tests), check a practice solution, grade answers, show progress, change the roadmap, or import a course plugin as a track. Works through the learn_* MCP tools.
---

# Learn

The Learn screen (Claude OS burger menu) shows what the `learn_*` tools store: tracks, their roadmaps, lessons, quiz attempts, grades. The user reads lessons and takes quizzes there; you build the material and practise with them in this tab. If the `learn_*` tools are missing, say that the Learn plugin's MCP server is not connected and that re-enabling the plugin on the plugins screen adds it; do not write the data files yourself.

## A new track

1. Ask at most three short questions when the goal is vague: what they want to be able to do, where they start, how much time per day.
2. Build a roadmap of 5 to 30 nodes, each a step that ends in a skill ("Write table-driven tests"), not a chapter name. Order from what unblocks the most.
3. `learn_create_track` with the title, goal, level, `language` (the user's language unless they ask otherwise), `style` (who the learner is, what to compare with, the domain for examples, rules every lesson follows) and the nodes.
4. Offer to write the first lesson.

## What the user asks for

- **next lesson** (or "start", "continue"): `learn_get_track`, take the first node not done, write and save its lesson, then say in two or three lines what to read and what to do, and that it is on the Learn screen.
- **lesson N** or a named step: the same for that node.
- **check** (in any language): in the track's `workdir`, run the lesson's `practice.check` (`learn_get_lesson`) in the exercise folder, show the failures, review the code against the track's rules, explain each mistake against the habit that caused it, then `learn_record_grade`. A grade of 70 or more marks the step done; give 70 or more only when the check passes.
- **explain X**: answer in the context of the current step and the track's style.
- **progress**: `learn_get_track` gives done steps, quiz attempts, grades and active days; say where they are and what comes next.

A course is a track: the user can make and edit one on the Learn screen without you (settings, roadmap, materials), so read it fresh before each change and keep every id you did not mean to change.

## Materials

A track can carry materials (`learn_get_track` lists them): the course program, a page template, reference notes. Read the ones that matter with `learn_read_material` before writing a lesson and follow them along with `style`; a page template tells the section order and the kinds of blocks, while the screen still does the colours and fonts. Save new ones with `learn_save_material` when the user gives you a program or rules to keep.

## Importing a course plugin

The screen offers to import a Claude OS plugin of the user's with course skills (for example a Go course). Read its skill files fully. Map its program onto nodes (keep its lesson order and ids such as `01-toolchain`), put its audience, page structure, examples and rules into `style`, its program, templates and other files into materials, and its folder into `source`. If it kept progress somewhere (a `progress.json` in a course folder), mark those nodes `done`. Keep its own work folder as `workdir` when the skill names one inside `~/learn`; the tool refuses any other folder, so otherwise leave `workdir` out. Never edit or delete the plugin; once everything is in the track, tell the user that the plugin can be disabled on the plugins screen.

## A lesson

Call `learn_get_track` first: follow `style`, see which nodes are done, what the quizzes showed was weak (`recentQuizAttempts`, `recentGrades`) and revisit that briefly. Write the node the user asked for, otherwise the first one not done. Then `learn_save_lesson`.

The article (`html`) is the body only: no `<html>`, `<head>`, `<style>`, scripts or external files. The screen styles it for the light and dark theme; do not set colours or fonts. Readable in 15 to 30 minutes. Use:

- `<p class="lead">` one paragraph: why this matters, in the learner's own terms.
- `<h2>` for sections, `<h3>` inside them; short paragraphs.
- `<pre><code class="language-go">` for code (any language name the highlighter knows: go, php, typescript, javascript, python, rust, java, sql, bash, json, yaml, css, xml); 5 to 20 lines per snippet, every snippet runs as written.
- `<div class="note">`, `<div class="tip">`, `<div class="warn">` for an aside, a trick, a trap.
- `<div class="compare"><div><h4>Before / other language</h4>…</div><div><h4>Here</h4>…</div></div>` for side-by-side.
- `<details><summary>Question</summary>Answer</details>` for self-checks inside the text.
- `<div class="key"><h3>…</h3><ul>…</ul></div>` at the end: what to remember, 3 to 5 lines.
- Tables, `<kbd>`, inline `<svg>` diagrams (use `currentColor`), `<a href="https://…">` links to docs.

Quiz: 3 to 7 multiple-choice questions after the lesson, each with 3 or 4 plausible options, `answer` as the option's index, `explain` saying why. Test understanding (what happens, which is right, what breaks), not wording.

Videos: 1 to 3 short ones (under 20 minutes). Give a real video URL only when you are sure it exists; otherwise a YouTube search link `https://www.youtube.com/results?search_query=<words>` with a title saying what to look for.

Practice: one exercise for this tab, done in the track's `workdir`: what to build, what "done" means, one hint. Where the language has tests, the exercise is files the lesson carries (`practice.files`, paths relative to the exercise folder, which is named after the node): a stub with the bodies left as `TODO` and tests that are the spec, table-driven, failing on the stub with a readable message. Put the command that checks a solution in `practice.check` (such as `go test ./...`, or `go test -race ./...` where the step is about concurrency). Build every snippet and run the tests against your own solution in a temporary folder before saving when unsure.

## Practice and grading

The screen's "Practice with Claude" button opens a tab in the work folder with the lesson and the task. Set up the exercise there: write the lesson's `practice.files` into the folder named after the node unless they are there already (never overwrite a file the user changed; for a redo use `<node>-v2`), or make the files and tests yourself when the lesson has none; let the user write the solution, answer questions with hints before answers. When they say they are done: run the check, review it, explain mistakes against the habit that caused them, then `learn_record_grade` with 0 to 100 and short feedback in their language; 70 or more marks the node done.

## The roadmap

Change it with `learn_update_roadmap` when the user asks or when grades show a gap: insert a node, split one, mark one `skipped` when they already know it. Pass every node that stays with its `id`, or its lesson and progress are lost.
