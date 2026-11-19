// A real Claude OS server process of one stage's tree for memory-compare.ts, over temp dirs only: its own HOME, data,
// config, vault and Claude config dir, so nothing of the user's is read or written. Probes go over HTTP and WebSocket.
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import WebSocket from 'ws';

export const TOKEN = 'memcompare'.padEnd(64, '0');
const LOOP = join(import.meta.dirname, 'memory-compare-loop.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface RunDirs { base: string; vault: string; data: string }

export const runDirs = (base: string): RunDirs => ({ base, vault: join(base, 'vault'), data: join(base, 'data') });

// A fresh data dir: the token, and every project of the vault wiki-managed, so writes regenerate MEMORY.md.
export function freshData(dirs: RunDirs, projects: string[]): void {
  for (const d of ['data', 'config', 'claude', 'home']) mkdirSync(join(dirs.base, d), { recursive: true });
  writeFileSync(join(dirs.data, 'token'), TOKEN, { mode: 0o600 });
  writeFileSync(join(dirs.data, 'wiki-managed.json'), `${JSON.stringify({ projects: [...projects].sort() }, null, 2)}\n`);
}

export interface Answer { ms: number; bytes: number; status: number; json: unknown }

export interface Server {
  proc: ChildProcess;
  spawnedAt: number;
  get(url: string): Promise<Answer>;
  post(url: string): Promise<Answer>;
  stall(): Promise<number>;
  rss(): { rss: number; peak: number };
  socket(onInvalidate: (topics: string[]) => void): Promise<() => void>;
  stop(): Promise<void>;
}

const headers = (port: number) => ({ host: `127.0.0.1:${port}`, cookie: `claude_os=${TOKEN}` });

async function request(port: number, url: string, method = 'GET'): Promise<Answer> {
  const t = performance.now();
  const res = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { ...headers(port), ...(method === 'POST' ? { 'content-type': 'application/json' } : {}) }, body: method === 'POST' ? '{}' : undefined });
  const text = await res.text();
  const ms = performance.now() - t;
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch { /* a non-JSON answer keeps json null */ }
  return { ms, bytes: Buffer.byteLength(text), status: res.status, json };
}

// kB values of /proc/<pid>/status, in MB: the resident set now and its peak.
function rssOf(pid: number) {
  const status = readFileSync(`/proc/${pid}/status`, 'utf8');
  const kb = (key: string) => Number(new RegExp(`${key}:\\s+(\\d+)`).exec(status)?.[1] ?? 0) / 1024;
  return { rss: kb('VmRSS'), peak: kb('VmHWM') };
}

export function startServer(tree: string, dirs: RunDirs, port: number): Server {
  const loopFile = join(dirs.base, 'loop.json');
  const env = {
    PATH: process.env.PATH ?? '', HOME: join(dirs.base, 'home'), CLAUDE_CONFIG_DIR: join(dirs.base, 'claude'),
    CLAUDE_OS_DATA: dirs.data, CLAUDE_OS_CONFIG: join(dirs.base, 'config'), CLAUDE_OS_VAULT: dirs.vault,
    CLAUDE_OS_PORT: String(port), CLAUDE_OS_IDLE_EXIT_MS: '0', CLAUDE_OS_WEB_DIST: join(dirs.base, 'no-web'), MEMCOMPARE_LOOP_FILE: loopFile,
  };
  const spawnedAt = performance.now();
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', LOOP, 'server/index.ts'], { cwd: tree, env, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr?.on('data', (d: Buffer) => void (stderr = (stderr + d.toString()).slice(-4000)));
  proc.on('exit', (code) => {
    if (code && code !== 0) console.error(`server exited ${code}: ${stderr}`);
  });
  return {
    proc, spawnedAt,
    get: (url) => request(port, url),
    post: (url) => request(port, url, 'POST'),
    // The longest stall since the previous call.
    async stall() {
      const before = existsSync(loopFile) ? readFileSync(loopFile, 'utf8') : '';
      proc.kill('SIGUSR2');
      for (let i = 0; i < 200 && (!existsSync(loopFile) || readFileSync(loopFile, 'utf8') === before); i++) await sleep(25);
      return (JSON.parse(readFileSync(loopFile, 'utf8')) as { maxStall: number }).maxStall;
    },
    rss: () => rssOf(proc.pid!),
    async socket(onInvalidate) {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: headers(port) });
      ws.on('message', (data) => {
        const m = JSON.parse(String(data)) as { t?: string; topics?: string[] };
        if (m.t === 'invalidate' && m.topics) onInvalidate(m.topics);
      });
      await new Promise((resolve, reject) => ws.once('open', resolve).once('error', reject));
      return () => ws.close();
    },
    async stop() {
      if (proc.exitCode !== null) return;
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill('SIGTERM');
      await Promise.race([exited, sleep(5000)]);
      if (proc.exitCode === null) proc.kill('SIGKILL');
      await sleep(300);
    },
  };
}

// Polls until the check passes; the time from `from`, or null after the deadline.
export async function waitFor(check: () => Promise<boolean>, from: number, deadlineMs: number, every = 20): Promise<number | null> {
  while (performance.now() - from < deadlineMs) {
    try {
      if (await check()) return performance.now() - from;
    } catch { /* not up yet */ }
    await sleep(every);
  }
  return null;
}
