// Runs inside WSL, started by the window through wsl.exe. Starts the server when it is not running, prints the
// login URL, then stays alive as long as the server does: WSL may stop a distro with no wsl.exe client attached,
// which would kill a turn still running after the window was closed.
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { setTimeout as sleep } from 'node:timers/promises';

const repo = resolve(import.meta.dirname, '..');
const data = join(repo, 'data');
const port = Number(process.env.CLAUDE_OS_PORT ?? 47821);
const health = `http://127.0.0.1:${port}/health`;

async function status() {
  try {
    const res = await fetch(health, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}
const alive = async () => (await status()) !== null;

// Opening the window after an update must not pair a new page with the old process. Running work is left alone: the page offers the restart then.
const running = await status();
if (running?.stale && !running.busy) {
  const token = readFileSync(join(data, 'token'), 'utf8').trim();
  await fetch(`http://127.0.0.1:${port}/api/app/restart`, { method: 'POST', headers: { cookie: `claude_os=${token}` } }).catch(() => {});
  for (let i = 0; i < 120 && (await status())?.pid === running.pid; i++) await sleep(250);
  for (let i = 0; i < 120 && !(await alive()); i++) await sleep(250);
}

if (!(await alive())) {
  mkdirSync(data, { recursive: true });
  const log = openSync(join(data, 'server.log'), 'a');
  spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.ts'], {
    cwd: repo,
    detached: true,
    stdio: ['ignore', log, log],
    // wsl.exe gives a minimal PATH: claude and the MCP servers it starts need node and ~/.local/bin.
    env: { ...process.env, PATH: `${dirname(process.execPath)}:${join(homedir(), '.local/bin')}:${process.env.PATH}` },
  }).unref();
  for (let i = 0; i < 120 && !(await alive()); i++) await sleep(250);
  if (!(await alive())) {
    console.error(`The server did not start within 30 seconds. Log: ${join(data, 'server.log')}`);
    process.exit(1);
  }
}

const token = readFileSync(join(data, 'token'), 'utf8').trim();
console.log(`READY http://127.0.0.1:${port}/auth?token=${token}`);

// A restart leaves the port empty for a moment: that is not the end of the server.
for (let missed = 0; missed < 4; missed = (await alive()) ? 0 : missed + 1) await sleep(15_000);
