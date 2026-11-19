// Keeps one local server process alive for as long as it is wanted: reuses one that already answers, starts its own
// otherwise, restarts it with a growing pause when it dies and takes its whole process tree down on stop.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import type { PluginServerStatus } from '../../../shared/osPluginServer.ts';

export interface SupervisorOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  probe: () => Promise<boolean>; // whether the address answers as the server
  onChange?: (status: PluginServerStatus) => void;
  timing?: Partial<Timing>;
}

interface Timing {
  backoffMs: number; // the first pause before a restart, doubled on each failure in a row
  maxBackoffMs: number;
  pollMs: number; // how often a running server is looked at
  startMs: number; // how long a new process may take to answer
  stepMs: number; // how often a starting one is looked at
}

const TIMING: Timing = { backoffMs: 1000, maxBackoffMs: 60_000, pollMs: 5000, startMs: 15_000, stepMs: 250 };
const KILL_WAIT_MS = 3000;

const lastLine = (text: string) => text.trim().split('\n').at(-1)?.trim() ?? '';

// The child is a group leader on POSIX, so the group goes with it; Windows has taskkill /T for the tree.
function killTree(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

export class Supervisor {
  private readonly opts: SupervisorOptions;
  private readonly timing: Timing;
  private current: PluginServerStatus = { state: 'stopped', detail: null, external: false };
  private child: ChildProcess | null = null;
  private spawnedAt = 0;
  private backoff: number;
  private wanted = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;

  constructor(opts: SupervisorOptions) {
    this.opts = opts;
    this.timing = { ...TIMING, ...opts.timing };
    this.backoff = this.timing.backoffMs;
  }

  status = () => this.current;
  pid = () => this.child?.pid ?? null;

  start() {
    if (this.wanted) return;
    this.wanted = true;
    this.backoff = this.timing.backoffMs;
    this.set({ state: 'starting', detail: null, external: false });
    void this.tick();
  }

  async stop() {
    this.wanted = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const proc = this.child;
    this.child = null;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      const exited = new Promise((done) => proc.once('exit', done));
      proc.stdin?.end();
      killTree(proc, 'SIGTERM');
      const force = setTimeout(() => killTree(proc, 'SIGKILL'), KILL_WAIT_MS);
      await exited;
      clearTimeout(force);
    }
    this.set({ state: 'stopped', detail: null, external: false });
  }

  private set(next: PluginServerStatus) {
    const now = this.current;
    if (next.state === now.state && next.detail === now.detail && next.external === now.external) return;
    this.current = next;
    this.opts.onChange?.(next);
  }

  private later(ms: number) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = this.wanted ? setTimeout(() => void this.tick(), ms) : null;
    this.timer?.unref();
  }

  private launch() {
    let stderr = '';
    let done = false;
    const proc = spawn(this.opts.command, this.opts.args, { env: this.opts.env, stdio: ['pipe', 'ignore', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    this.child = proc;
    this.spawnedAt = Date.now();
    proc.stderr?.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    const gone = (why: string) => {
      if (done) return;
      done = true;
      if (this.child === proc) this.child = null;
      if (!this.wanted) return;
      this.set({ state: 'failed', detail: lastLine(stderr) || why, external: false });
      this.later(this.backoff);
      this.backoff = Math.min(this.backoff * 2, this.timing.maxBackoffMs);
    };
    proc.on('error', (err) => gone(err.message));
    proc.on('exit', (code, signal) => gone(signal ? `stopped by ${signal}` : `exited with code ${code}`));
    if (this.current.state !== 'failed') this.set({ state: 'starting', detail: null, external: false }); // a retry keeps the reason on screen
  }

  private async step() {
    const healthy = await this.opts.probe();
    if (!this.wanted) return;
    if (healthy) {
      this.backoff = this.timing.backoffMs;
      this.set({ state: 'running', detail: null, external: !this.child });
      return this.later(this.timing.pollMs);
    }
    if (!this.child) this.launch();
    else if (Date.now() - this.spawnedAt > this.timing.startMs) return killTree(this.child, 'SIGKILL'); // its exit schedules the retry
    this.later(this.timing.stepMs);
  }

  private async tick() {
    if (this.ticking || !this.wanted) return;
    this.ticking = true;
    try {
      await this.step();
    } finally {
      this.ticking = false;
    }
  }
}
