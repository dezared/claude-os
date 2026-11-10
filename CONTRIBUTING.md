# Contributing

Thanks for looking. Issues, ideas and pull requests are all welcome.

## Setup

```sh
git clone https://github.com/DezareD/claude-os.git
cd claude-os
npm install
npm run hooks:install   # the repository's git hooks
npm run build
npm start
```

Node runs the server's TypeScript directly, so a server change needs only a restart. A change under `web/` needs `npm run build` and a page reload.

## Checks

| Command | What it does | Time |
| --- | --- | --- |
| `npm run typecheck` | `tsc --noEmit` | ~2 s |
| `npm run lint` | oxlint; warnings count as errors | seconds |
| `npm test` | unit tests under `server/` and `scripts/` | ~70 s |
| `npm run e2e` | Playwright tests against a fake backend; needs `npm run build` first | minutes |
| `npm run gate` | typecheck, lint, lint ratchet, shippable files, touchpoints, new suppressions, unit tests; stops at the first failure | ~90 s |

A pull request should pass `npm run gate`. If it touches `web/`, `e2e/` or `desktop/`, run the build and e2e too.

## Code standard

The full text is [docs/rules/code-style.md](docs/rules/code-style.md). In short:

- Files up to 300 lines (`.tsx` 400), functions up to 50 (`.tsx` 120), complexity 10. Over a limit, split the code; caps are never raised.
- No `any`, no `@ts-ignore` or lint suppressions.
- Node strips types, so no enums, namespaces or parameter properties, and imports end in `.ts`.
- English in code, comments, commits and docs. Interface strings go into both `web/src/lib/locales/en.ts` and `ru.ts`.
- A concept used in several places (a route, a setting key, a tool) is a typed registry in `shared/contract.ts`; places the types cannot see are listed in [docs/rules/touchpoints.md](docs/rules/touchpoints.md).

Where things are: [docs/rules/architecture.md](docs/rules/architecture.md).

## Screenshots and the demo video

The images in the README come from a mock run: the e2e fixture server with made-up English data, driven by Playwright. No Claude, no network, no personal data.

```sh
npm run build
npm run demo:media                # every screenshot, docs/media/demo.webp and demo.mp4 (needs ffmpeg)
npm run demo:media -- home video  # only some scenes
```

The scenes are in `e2e/demo/capture.ts`, the 60 fps video scenario in `e2e/demo/video.ts` (DevTools screencast, an animated pointer from `e2e/demo/cursor.ts`), the demo data in `e2e/demo/demo-data.ts`.

## Pull requests

- One topic per pull request, with a short description of what and why.
- Add or update tests for behaviour you change.
- Do not commit `config/`, `data/` or `vault/`: they are user data.

By contributing you agree that your contribution is licensed under the [Apache License 2.0](LICENSE).
