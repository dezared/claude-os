import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import type { ChatEvent, ServerMessage } from '../../../shared/contract.ts';

const REPO = resolve(import.meta.dirname, '../../..');
const FAKE = join(import.meta.dirname, 'fake-claude.mjs');

export interface TestServer {
  port: number;
  dir: string;
  logFile: string;
  newProjects: string;
  dataDir: string;
  configDir: string;
  api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }>;
  connect(): Promise<Client>;
  log(): Record<string, unknown>[];
  stop(signal?: NodeJS.Signals): Promise<void>;
  restart(): Promise<void>;
  destroy(): Promise<void>;
}

export class Client {
  messages: ServerMessage[] = [];
  private ws: WebSocket;
  constructor(ws: WebSocket) {
    this.ws = ws;
    ws.on('message', (d) => this.messages.push(JSON.parse(String(d))));
  }
  subscribe(tabId: string, lastSeq = 0) { this.ws.send(JSON.stringify({ t: 'subscribe', tabId, lastSeq })); }
  events(tabId: string): ChatEvent[] {
    return this.messages.flatMap((m) => (m.t === 'chat' && m.tabId === tabId ? [m.event] : []));
  }
  async waitEvent<E extends ChatEvent['e']>(tabId: string, e: E, match: (ev: Extract<ChatEvent, { e: E }>) => boolean = () => true): Promise<Extract<ChatEvent, { e: E }>> {
    let found: Extract<ChatEvent, { e: E }> | undefined;
    await waitUntil(() => {
      found = this.events(tabId).find((ev): ev is Extract<ChatEvent, { e: E }> => ev.e === e && match(ev as Extract<ChatEvent, { e: E }>));
      return found !== undefined;
    }, `event ${e} on tab ${tabId}: ${JSON.stringify(this.events(tabId).map((x) => x.e))}`);
    return found!;
  }
  close(): Promise<void> {
    return new Promise((r) => { this.ws.once('close', () => r()); this.ws.close(); });
  }
}

export async function waitUntil(check: () => boolean | Promise<boolean>, what: string, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

// A port someone else holds would answer /health, and the test would talk to a stranger's server.
function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const probe = createServer();
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => ok(port));
    });
  });
}

// A finished first-run setup: the setup modal would cover the home screen of every test that is not about it.
export function seedSetupDone(configDir: string): void {
  const file = join(configDir, 'settings.json');
  if (existsSync(file)) return;
  mkdirSync(configDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ setup: { step: 'done', completedAt: 1, tabId: null } }));
}

// freshInstall: no config at all, as on a new machine.
export async function startServer(env: Record<string, string> = {}, opts: { freshInstall?: boolean } = {}): Promise<TestServer> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claude-os-chat-')));
  const port = await freePort();
  const dataDir = join(dir, 'data');
  const configDir = join(dir, 'claude');
  const logFile = join(dir, 'fake.log');
  const newProjects = join(dir, 'new-projects');
  const fullEnv: NodeJS.ProcessEnv = {
    ...process.env,
    CLAUDE_OS_DATA: dataDir,
    CLAUDE_OS_CONFIG: join(dir, 'config'),
    CLAUDE_OS_VAULT: join(dir, 'vault'),
    CLAUDE_OS_NEW_PROJECTS: newProjects,
    CLAUDE_OS_CLAUDE_BIN: FAKE,
    CLAUDE_CONFIG_DIR: configDir,
    CLAUDE_OS_PORT: String(port),
    CLAUDE_OS_IDLE_EXIT_MS: '0',
    FAKE_CLAUDE_LOG: logFile,
    ...env,
  };

  if (!opts.freshInstall) seedSetupDone(fullEnv.CLAUDE_OS_CONFIG!);

  let child: ChildProcess | null = null;
  const boot = async () => {
    child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', join(REPO, 'server/index.ts')], { env: fullEnv, stdio: ['ignore', 'ignore', 'inherit'] });
    await waitUntil(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; }
    }, 'server start', 20_000);
  };
  await boot();
  const cookie = () => `claude_os=${readFileSync(join(dataDir, 'token'), 'utf8').trim()}`;

  const stop = async (signal: NodeJS.Signals = 'SIGTERM') => {
    const c = child;
    if (!c || c.exitCode !== null || c.signalCode !== null) return;
    await new Promise<void>((r) => { c.once('exit', () => r()); c.kill(signal); });
  };

  return {
    port, dir, logFile, newProjects, dataDir, configDir,
    async api<T>(method: string, path: string, body?: unknown) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: { cookie: cookie(), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      return { status: res.status, body: await res.json() as T };
    },
    async connect() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie: cookie() } });
      await new Promise((ok, fail) => { ws.once('open', ok); ws.once('error', fail); });
      return new Client(ws);
    },
    log() {
      try {
        return readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch {
        return [];
      }
    },
    stop,
    async restart() { await stop(); await boot(); },
    // A server started by /api/app/restart is no child of this harness, so stop() cannot end it; wait until its port is free before the dir goes.
    async destroy() {
      await stop();
      await waitUntil(async () => !(await fetch(`http://127.0.0.1:${port}/health`).then(() => true, () => false)), 'the server to leave its port', 10_000);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
