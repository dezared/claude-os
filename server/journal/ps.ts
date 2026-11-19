// Process facts where there is no /proc (macOS): read from ps, one call per question.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const HAS_PROC = existsSync('/proc/self/stat');

export interface PsRow { pid: number; ppid: number; zombie: boolean; start: string; command: string }

// In UTC and the C locale: Claude Code writes procStart on macOS as `ps -o lstart` prints it there.
const PS_ENV = { ...process.env, TZ: 'UTC', LC_ALL: 'C' };
const FIELDS = 'pid=,ppid=,stat=,lstart=,command=';
// lstart is fixed width, e.g. "Mon Nov  9 14:17:59 2026": the day is padded with a space.
const ROW = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\w{3} \w{3} [ \d]\d \d\d:\d\d:\d\d \d{4})\s*(.*)$/;

export function parsePs(stdout: string): PsRow[] {
  const out: PsRow[] = [];
  for (const line of stdout.split('\n')) {
    const m = ROW.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), zombie: m[3].startsWith('Z'), start: m[4], command: m[5] });
  }
  return out;
}

function ps(args: string[]): PsRow[] {
  try {
    return parsePs(execFileSync('ps', ['-o', FIELDS, ...args], { encoding: 'utf8', env: PS_ENV, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return []; // ps exits 1 when the pid is gone
  }
}

export const psOf = (pid: number): PsRow | null => (Number.isInteger(pid) && pid > 0 ? ps(['-p', String(pid)])[0] ?? null : null);

export const psAll = (): PsRow[] => ps(['-A']);
