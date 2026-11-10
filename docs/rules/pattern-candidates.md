# Pattern candidates

Tools and patterns worth considering later. Nothing here is installed or planned. An entry moves out when its verification passes and a task is written for it.

## Obscura (headless browser for e2e)

A Rust headless browser with a CDP endpoint (`github.com/h4ckf0r0day/obscura`). It could cut the memory of the e2e suite, which launches one Chromium per file. Not planned: the home map is WebGL and the suite is Chromium-specific.

Verification before any evaluation, in order:

1. Release binaries exist for linux-x64, macOS and Windows.
2. The license allows our use.
3. `chromium.connectOverCDP` runs `e2e/git.test.ts` (a non-WebGL file) green twice.
4. Only then compare memory against the serial Chromium run.
