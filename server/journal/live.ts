// Who is alive right now: the sessions/ registry verified against /proc, plus `claude agents --json`.
import { execFile } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionStatus } from '../../shared/contract.ts';

export interface RegistryEntry {
  pid: number;
  sessionId: string;
  cwd: string;
  status?: string;
  name?: string;
  kind?: string;
  entrypoint?: string;
  procStart?: string;
  startedAt?: number;
  updatedAt?: number;
  version?: string;
}

export interface AgentEntry {
  sessionId: string;
  pid?: number;
  cwd?: string;
  kind?: string;
  name?: string;
  state?: string;
  status?: string;
  startedAt?: number;
}

export interface LiveSession {
  sessionId: string;
  status: SessionStatus;
  pid: number | null;
  cwd: string | null;
  kind: string | null;
  name: string | null;
  startedAt: number | null;
  updatedAt: number | null;
  version: string | null;
}

export function mapStatus(raw: string | undefined): SessionStatus {
  const s = (raw ?? '').toLowerCase();
  if (s.includes('permission')) return 'waiting_permission';
  if (s.includes('block')) return 'blocked';
  if (s === 'busy' || s === 'running' || s === 'working') return 'working';
  return 'idle';
}

function normalizeKind(kind: string | undefined, entrypoint?: string): string | null {
  if (entrypoint?.includes('sdk')) return 'sdk';
  if (kind === 'bg') return 'background';
  return kind ?? null;
}

// Field 22 of /proc/<pid>/stat, null for a dead pid or a zombie. comm may hold spaces and parens, so count from the last ')'.
export function procStartOf(pid: number): string | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'latin1');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return fields[0] === 'Z' ? null : fields[19] ?? null;
  } catch {
    return null;
  }
}

// Field 4 of /proc/<pid>/stat, null when it cannot be read.
export function parentPidOf(pid: number, procDir = '/proc'): number | null {
  try {
    const stat = readFileSync(`${procDir}/${pid}/stat`, 'latin1');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  } catch {
    return null;
  }
}

/** A process as it was seen: a pid alone can belong to another process by the time it is used. */
export interface ProcRef { pid: number; procStart: string }

export const sameProcess = (ref: ProcRef, procStart = procStartOf): boolean => procStart(ref.pid) === ref.procStart;

/** The live registry entry of a session that runs in a child of `parent`: a terminal's process is never one. */
export function childOf(registry: RegistryEntry[], sessionId: string, parent: number, procStart = procStartOf, parentOf = parentPidOf): ProcRef | null {
  for (const e of registry) {
    if (e.sessionId !== sessionId || !e.procStart || procStart(e.pid) !== String(e.procStart) || parentOf(e.pid) !== parent) continue;
    return { pid: e.pid, procStart: String(e.procStart) };
  }
  return null;
}

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
const signal = (pid: number, sig: NodeJS.Signals) => { try { process.kill(pid, sig); } catch { /* already gone */ } };

/** SIGTERM, up to `graceMs` to exit, then SIGKILL. Only while the pid is still that process. */
export async function endProcess(ref: ProcRef, graceMs: number): Promise<void> {
  if (sameProcess(ref)) signal(ref.pid, 'SIGTERM');
  for (let waited = 0; waited < graceMs && sameProcess(ref); waited += 50) await pause(50);
  if (sameProcess(ref)) signal(ref.pid, 'SIGKILL');
  for (let waited = 0; waited < 1000 && sameProcess(ref); waited += 20) await pause(20);
}

/** The claude processes among the children of `parent`. None where there is no /proc. */
export function claudeChildren(parent: number, procDir = '/proc'): number[] {
  let names: string[];
  try { names = readdirSync(procDir); } catch { return []; }
  return names.filter((d) => /^\d+$/.test(d)).map(Number)
    .filter((pid) => parentPidOf(pid, procDir) === parent && procStartOf(pid) !== null && isClaudeProcess(pid));
}

/** SIGTERM, up to `graceMs` for all to exit, then SIGKILL. */
export async function endClaudeChildren(parent: number, procDir = '/proc', graceMs = 2000): Promise<void> {
  for (const pid of claudeChildren(parent, procDir)) signal(pid, 'SIGTERM');
  for (let waited = 0; waited < graceMs && claudeChildren(parent, procDir).length > 0; waited += 100) await pause(100);
  for (const pid of claudeChildren(parent, procDir)) signal(pid, 'SIGKILL');
}

// Only <pid>.json: the neighbouring <pid>.<hash>.key files are secrets and must never be opened.
export function readRegistry(claudeDir: string): RegistryEntry[] {
  const dir = join(claudeDir, 'sessions');
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: RegistryEntry[] = [];
  for (const name of names) {
    if (!/^\d+\.json$/.test(name)) continue;
    try {
      const e = JSON.parse(readFileSync(join(dir, name), 'utf8')) as RegistryEntry;
      if (typeof e.pid === 'number' && typeof e.sessionId === 'string') out.push(e);
    } catch { /* being rewritten or gone: the next pass sees it */ }
  }
  return out;
}

// Short-lived CLI processes of Claude OS itself (server/chat/probe.ts): they answer a question and are not sessions.
export const ignoredSessions = new Set<string>();

// A pid the agents view reports has no procStart to check against: a reused one at least is not running claude.
export function isClaudeProcess(pid: number): boolean {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'latin1').toLowerCase().includes('claude');
  } catch {
    return false;
  }
}

export function computeLive(registry: RegistryEntry[], agents: AgentEntry[], procStart = procStartOf, isClaude = isClaudeProcess): Map<string, LiveSession> {
  const live = new Map<string, LiveSession>();
  for (const e of registry) {
    if (ignoredSessions.has(e.sessionId)) continue;
    // Dead files keep claiming `busy`, and pids get reused: no matching procStart means not alive.
    if (!e.procStart || procStart(e.pid) !== String(e.procStart)) continue;
    const prev = live.get(e.sessionId);
    if (prev && (prev.updatedAt ?? 0) > (e.updatedAt ?? 0)) continue;
    live.set(e.sessionId, {
      sessionId: e.sessionId,
      status: mapStatus(e.status),
      pid: e.pid,
      cwd: e.cwd ?? null,
      kind: normalizeKind(e.kind, e.entrypoint),
      name: e.name ?? null,
      startedAt: e.startedAt ?? null,
      updatedAt: e.updatedAt ?? null,
      version: e.version ?? null,
    });
  }
  for (const a of agents) {
    if (typeof a.sessionId !== 'string') continue;
    const status = mapStatus(a.state ?? a.status);
    const known = live.get(a.sessionId);
    if (known) {
      // The registry is fresher, except for states only the agents view reports.
      if (status === 'blocked' || status === 'waiting_permission') known.status = status;
      continue;
    }
    // The agents view keeps parked sessions for weeks, `blocked` included: without a running process they are not live.
    // Anything really running, a plain terminal included, is in the registry above. The poll is also up to a few seconds old.
    if (a.pid == null || procStart(a.pid) === null || !isClaude(a.pid)) continue;
    live.set(a.sessionId, {
      sessionId: a.sessionId,
      status,
      pid: a.pid,
      cwd: a.cwd ?? null,
      kind: normalizeKind(a.kind),
      name: a.name ?? null,
      startedAt: a.startedAt ?? null,
      updatedAt: null,
      version: null,
    });
  }
  return live;
}

const POLL_MS = 5_000;
const POLL_MAX_MS = 60_000;
const SLOW_CALL_MS = 2_000;
const STALE_MS = 120_000;

// Self-rescheduling, so calls never overlap. A slow or failing binary stretches the interval.
export function pollAgents(claudeBin: string, onResult: (agents: AgentEntry[]) => void): () => void {
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;
  let interval = POLL_MS;
  let last: AgentEntry[] = [];
  let lastOk = Date.now();

  const tick = () => {
    const started = Date.now();
    execFile(claudeBin, ['agents', '--json'], { timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
      if (stopped) return;
      let ok = false;
      if (!err) {
        try {
          const parsed: unknown = JSON.parse(stdout);
          if (Array.isArray(parsed)) {
            last = parsed as AgentEntry[];
            lastOk = Date.now();
            ok = true;
          }
        } catch { /* treated as a failed call */ }
      }
      if (!ok && Date.now() - lastOk > STALE_MS) last = [];
      const slow = Date.now() - started > SLOW_CALL_MS;
      interval = ok && !slow ? POLL_MS : Math.min(interval * 2, POLL_MAX_MS);
      onResult(last);
      timer = setTimeout(tick, interval);
      timer.unref();
    });
  };
  tick();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
