// The server's side of the embedding process: starts it on demand, numbers the requests, stops it when idle.
import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { EngineReply, EngineRequest } from './index.ts';

const IDLE_KILL_MS = 10 * 60_000; // the loaded model holds about 600 MB

export interface EngineEvents {
  progress(loaded: number): void;
  loaded(): void;
  failed(message: string): void; // a load failed or the process died during one
}

interface State {
  dir: string;
  events: EngineEvents;
  child: ChildProcess | null;
  loading: boolean;
  nextId: number;
  idle: NodeJS.Timeout | null;
  waiting: Map<number, { resolve: (v: Float32Array) => void; reject: (e: Error) => void }>;
}

function failAll(s: State, message: string) {
  for (const w of s.waiting.values()) w.reject(new Error(message));
  s.waiting.clear();
}

function stop(s: State) {
  if (s.idle) clearTimeout(s.idle);
  const c = s.child;
  s.child = null; // first, so its exit does not read as a crash
  s.loading = false;
  c?.kill();
  failAll(s, 'semantic engine stopped');
}

function touch(s: State) {
  if (s.idle) clearTimeout(s.idle);
  s.idle = setTimeout(() => {
    if (s.waiting.size === 0 && !s.loading) stop(s);
  }, IDLE_KILL_MS);
  s.idle.unref();
}

function onReply(s: State, m: EngineReply) {
  if (m.type === 'progress') s.events.progress(m.loaded);
  else if (m.type === 'loaded') {
    s.loading = false;
    s.events.loaded();
  } else if (m.type === 'error' && m.id === null) {
    s.loading = false;
    s.events.failed(m.message);
  } else if (m.id !== null) {
    const w = s.waiting.get(m.id);
    s.waiting.delete(m.id);
    if (m.type === 'vectors') w?.resolve(new Float32Array(new Uint8Array(Buffer.from(m.data, 'base64')).buffer));
    else w?.reject(new Error(m.message));
  }
  touch(s);
}

function start(s: State): ChildProcess {
  if (s.child) return s.child;
  const c = fork(process.env.CLAUDE_OS_SEMANTIC_ENGINE ?? join(import.meta.dirname, 'engine.ts'), {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    execArgv: ['--disable-warning=ExperimentalWarning'],
  });
  let stderr = '';
  c.stderr?.on('data', (d) => {
    stderr = (stderr + String(d)).slice(-2000);
  });
  c.on('message', (m) => {
    if (s.child === c) onReply(s, m as EngineReply);
  });
  c.on('exit', (code, signal) => {
    if (s.child !== c) return;
    s.child = null;
    const message = `semantic engine stopped (${signal ?? code}): ${stderr.trim().slice(-300)}`;
    failAll(s, message);
    if (s.loading) {
      s.loading = false;
      s.events.failed(message);
    }
  });
  s.child = c;
  touch(s);
  return c;
}

export function createEngine(dir: string, events: EngineEvents) {
  const s: State = { dir, events, child: null, loading: false, nextId: 1, idle: null, waiting: new Map() };
  return {
    // The only request that downloads anything; the user's explicit "turn on" sends it.
    download() {
      s.loading = true;
      start(s).send({ type: 'load', dir, download: true } satisfies EngineRequest);
    },
    // Normalized vectors, one after another in the result.
    embed(texts: string[], kind: 'query' | 'passage'): Promise<Float32Array> {
      const id = s.nextId++;
      return new Promise((resolve, reject) => {
        s.waiting.set(id, { resolve, reject });
        start(s).send({ type: 'embed', id, dir, texts, kind } satisfies EngineRequest);
      });
    },
    stop: () => stop(s),
  };
}

export type Engine = ReturnType<typeof createEngine>;
