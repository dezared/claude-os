---
name: Standard
name_ru: Стандартный
kind: other
description: Any document: a report on work, documentation, a plan, a note. Sets the rules of the text and the styling; the sections depend on the kind of document.
description_ru: Любой документ: отчёт о работе, документация, план, заметка. Задаёт правила текста и оформления, разделы зависят от вида документа.
---
# Standard document

A document is read when there is little time. Within a minute it must be clear what it is about and what to do next.

Write the document in the user's language, the one the profile block names; set `lang` of `<html>` to it.

## Structure

1. The heading names the subject of the document. Below it a gray line: the date and the project.
2. Under it one or two sentences: what matters most in the document. No introductions.
3. Then the sections. Their set depends on the kind of document:
   - **Report on work.** One section per task. A section has three parts: "Task" (what was asked, briefly and in the words of the one who asked), "Done" (what works differently now), "How to see it" (what to open, where to click, what should be visible). At the end, if there is any: "Not done" with the reason and "Needed from you".
   - **Documentation.** What it is and why, how to use it, examples, limits.
   - **Plan.** The goal, the steps in order with the result of each step, the risks.
   - **Other.** Sections by meaning, in the order in which they will be read.
4. Do not write an empty section.

## Text

- Short sentences, one thought per sentence. The fact right away.
- Specifics: the name of the screen and the button, a number, a path to a file, a command.
- Checks as they are: "8 tests out of 8", "not checked by hand". Not "everything works".
- The language is the user's language. The labels of the parts ("Task", "Done", "How to see it" and the others) are written in it too.

Signs of AI text. There must be none of them:

- the contrast "not X but Y" where nobody claimed X;
- a phrase at the end of a paragraph that repeats the paragraph in other words;
- lists of three for the sake of rhythm;
- the long dash: a period, a comma, a colon or brackets instead of it;
- inflating words: "key", "it is important to note", "within the framework of", "thus", "successfully", "robust", "seamless", "allows", "ensures", "significantly";
- a bold label with a colon at the start of every list item;
- a story of how the document was written, and praise of one's own work.

## Styling

White background, dark gray text, a narrow column, a large line spacing, almost no color. No cards, shadows, gradients or colored badges. No icons. No emoji.

The parts of a section ("Task", "Done", "How to see it") are labelled with a small gray line above the text, class `k`. File names, commands and paths in `<code>`, the name of a button or a screen in `<b>`, highlight nothing else.

Take the skeleton without changes, except the `lang` attribute, and fill it in. No scripts and no external files: the document is shown in a sandbox.

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Title</title>
<style>
  html { background: #fff; }
  body { margin: 0 auto; padding: 56px 28px 96px; max-width: 680px; color: #24292f; background: #fff; font: 17px/1.65 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; -webkit-font-smoothing: antialiased; }
  h1 { margin: 0 0 6px; font-size: 30px; line-height: 1.25; font-weight: 600; letter-spacing: -.01em; color: #1a1d21; }
  .meta { margin: 0 0 28px; font-size: 14px; color: #7a828c; }
  .lead { margin: 0 0 40px; }
  h2 { margin: 44px 0 12px; font-size: 20px; line-height: 1.35; font-weight: 600; color: #1a1d21; }
  .k { margin: 16px 0 2px; font-size: 13px; letter-spacing: .02em; color: #7a828c; }
  ol, ul { margin: 0 0 14px; padding-left: 24px; }
  li { margin: 0 0 8px; padding-left: 4px; }
  li::marker { color: #7a828c; }
  p { margin: 0 0 12px; }
  b { font-weight: 600; color: #1a1d21; }
  code { font: 14.5px/1.5 ui-monospace, Consolas, Menlo, monospace; color: #3d444d; background: #f4f5f6; padding: 1px 5px; border-radius: 4px; overflow-wrap: anywhere; }
  a { color: #24292f; text-underline-offset: 3px; text-decoration-color: #b4bac1; }
</style>
</head>
<body>
<h1>Subject of the document</h1>
<p class="meta">9 November 2026 · project</p>
<p class="lead">The main point in one or two sentences.</p>

<h2>Section</h2>
<p class="k">Task</p>
<p>What was asked.</p>
<p class="k">Done</p>
<p>What works differently now.</p>
<p class="k">How to see it</p>
<ol>
  <li>Open the <b>screen</b>, press the <b>button</b>. This and that should be visible.</li>
</ol>
</body>
</html>
```

When saving, give `kind` (`report`, `documentation`, `plan`, `dashboard`, `other`), and in `summary` one line: what the document is about.
