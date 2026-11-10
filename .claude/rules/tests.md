---
paths:
  - "**/*.test.ts"
  - "e2e/**"
---
# Tests

- Server tests use `server/memory/testkit.ts`: `makeKit()` gives `ctx`, `app` (`app.inject` for requests), `paths` in a temp dir, `kit.audits`, `kit.topics`, `write()`; `until(cond)` from the same file waits for async effects. Read the neighbouring test first.
- Titles are lowercase sentences stating the behaviour.
- Tests use temp dirs; never the real `config/`, `data/` or `vault/`.
- e2e runs in the background through the test-runner agent: it builds `dist/web` in the same worktree first and wraps the run in `flock /tmp/claudeos-e2e.lock`.
- When even a blank page cannot be screenshotted on the machine, say that e2e did not run rather than reading its failures as yours.
