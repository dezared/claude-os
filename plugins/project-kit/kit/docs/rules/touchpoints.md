# Touchpoints

A concept that lives in several places must be changed in all of them. This is the map. "Typed" rows are enforced by the type checker, "check" rows by the gate's touchpoints step (data in `touchpoints.json`), "test" rows by a named test.

| Concept | Where it lives | Mechanism |
| --- | --- | --- |

## When you add a concept that lives in more than one place

Prefer one shared typed constant that every place imports. If types cannot reach it (a prompt, a markdown file, a folder with a file per key), add an entry to `touchpoints.json` and a row here.
