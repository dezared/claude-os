// Preloaded by the e2e scripts (node --import). Under WSLg, Chromium's GPU process hangs on any WebGL context while
// WAYLAND_DISPLAY is set, and the home map is WebGL. Without the socket it falls back to X11 and the swiftshader flags work.
// Playwright's browsers inherit process.env, so dropping it here covers every test. Nothing changes on other systems.
// The npm e2e scripts load it. To run one file: node --import ./e2e/env.ts --test e2e/<name>.test.ts
if (process.platform === 'linux') delete process.env.WAYLAND_DISPLAY;
