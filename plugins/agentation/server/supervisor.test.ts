// The supervisor against a fake daemon: it starts one, reuses one that already answers, restarts a dead one with a growing
// pause, and leaves no process behind on stop or when its own process dies. Temp dirs and free ports only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { PluginServerStatus } from '../../../shared/osPluginServer.ts';
import { probe } from './index.ts';
import { Supervisor } from './supervisor.ts';

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-daemon.mjs');
const dir = mkdtempSync(join(tmpdir(), 'agentation-supervisor-'));
const leftovers: number[] = [];
after(() => {
  for (const pid of leftovers) if (alive(pid)) process.kill(pid, 'SIGKILL');
  rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
async function until(check: () => boolean, what: string, ms = 8000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(25)) if (check()) return;
  assert.fail(`timed out: ${what}`);
}
function freePort() {
  return new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}
const pidsIn = (file: string) => (existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number) : []);

async function setup(mode: 'ok' | 'crash') {
  const port = await freePort();
  const pids = join(dir, `${port}.pids`);
  const seen: PluginServerStatus[] = [];
  const supervisor = new Supervisor({
    command: process.execPath,
    args: [FAKE, String(port), mode, pids],
    probe: probe(`http://127.0.0.1:${port}`),
    onChange: (s) => seen.push(s),
    timing: { backoffMs: 50, maxBackoffMs: 400, pollMs: 50, stepMs: 25 },
  });
  return { port, pids, seen, supervisor, all: () => pidsIn(pids) };
}

describe('the agentation supervisor', () => {
  it('starts the daemon, says it runs, and stop takes the whole tree down', async () => {
    const { seen, supervisor, all } = await setup('ok');
    supervisor.start();
    await until(() => supervisor.status().state === 'running', 'running');
    assert.deepEqual(supervisor.status(), { state: 'running', detail: null, external: false });
    assert.equal(seen[0].state, 'starting');
    const [daemon, grandchild] = all();
    leftovers.push(daemon, grandchild);
    assert.equal(supervisor.pid(), daemon);
    assert.ok(alive(daemon) && alive(grandchild));
    await supervisor.stop();
    await until(() => !alive(daemon) && !alive(grandchild), 'the tree is gone');
    assert.equal(supervisor.status().state, 'stopped');
  });

  it('reuses a server that already answers as agentation and starts its own when that one goes', async () => {
    const { port, supervisor, all } = await setup('ok');
    const other: Server = createServer((_req, res) => res.end(JSON.stringify({ status: 'ok', mode: 'local' })));
    await new Promise<void>((r) => other.listen(port, '127.0.0.1', r));
    supervisor.start();
    await until(() => supervisor.status().state === 'running', 'running');
    assert.deepEqual(supervisor.status(), { state: 'running', detail: null, external: true });
    assert.equal(supervisor.pid(), null);
    await sleep(200);
    assert.deepEqual(all(), [], 'no second server');
    await new Promise((r) => other.close(r));
    other.closeAllConnections();
    await until(() => supervisor.status().state === 'running' && !supervisor.status().external, 'its own one runs');
    leftovers.push(...all());
    await supervisor.stop();
  });

  it('a daemon that dies is started again; one that keeps failing waits longer each time and shows why', async () => {
    const ok = await setup('ok');
    ok.supervisor.start();
    await until(() => ok.supervisor.status().state === 'running', 'running');
    const first = ok.supervisor.pid()!;
    leftovers.push(...ok.all());
    process.kill(first, 'SIGKILL');
    await until(() => ok.seen.some((s) => s.state === 'failed'), 'failed');
    await until(() => ok.supervisor.status().state === 'running' && ok.supervisor.pid() !== first, 'restarted');
    leftovers.push(...ok.all());
    await ok.supervisor.stop();

    const bad = await setup('crash');
    const starts: number[] = [];
    const pauses: number[] = []; // the pause scheduled before each try, not the wall clock: spawning a process takes as long as the machine is busy
    const launch = bad.supervisor['launch'].bind(bad.supervisor);
    bad.supervisor['launch'] = () => {
      starts.push(Date.now());
      pauses.push(bad.supervisor['backoff']);
      launch();
    };
    bad.supervisor.start();
    await until(() => starts.length >= 4, 'four tries', 5000);
    assert.deepEqual(bad.supervisor.status(), { state: 'failed', detail: 'boom: the fake crashed', external: false });
    assert.ok(pauses[3] > pauses[1], `the pause grows: ${pauses.join(', ')}`);
    await bad.supervisor.stop();
    const count = starts.length;
    await sleep(300);
    assert.equal(starts.length, count, 'no retry after stop');
  });

  it('when the process that runs it dies outright, the daemon goes too', async () => {
    const port = await freePort();
    const pids = join(dir, `${port}.pids`);
    const script = `import { Supervisor } from ${JSON.stringify(join(import.meta.dirname, 'supervisor.ts'))};
new Supervisor({ command: process.execPath, args: ${JSON.stringify([FAKE, String(port), 'ok', pids])}, probe: async () => false, timing: { startMs: 60000 } }).start();
setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { stdio: 'ignore' });
    leftovers.push(parent.pid!);
    await until(() => pidsIn(pids).length === 2, 'the daemon started');
    const [daemon, grandchild] = pidsIn(pids);
    leftovers.push(daemon, grandchild);
    parent.kill('SIGKILL');
    await until(() => !alive(daemon), 'the daemon left with its parent');
  });
});
