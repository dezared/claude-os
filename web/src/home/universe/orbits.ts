// Satellites follow what their session does. Pure: the phase only ever accumulates, so a change of pace cannot move a satellite.
import type { SessionInfo } from '../../lib/types';

/** Silence after which a subagent counts as finished. 99% of the silences in real running subagents are shorter. */
export const RUNNING_SUBAGENT_MS = 120_000;
export const IDLE_PACE = 0.3;
export const WORK_PACE = 3.2;
const PACE_EASE = 1.6; // per second: a change of pace settles within about two seconds

export interface OrbitSession {
  id: string;
  working: boolean;
  subagents: number;
}

export interface Phase {
  phase: number;
  pace: number;
  goal: number;
}

export function advance(o: Phase, speed: number, dt: number) {
  o.pace += (o.goal - o.pace) * (1 - Math.exp(-dt * PACE_EASE));
  o.phase += speed * o.pace * dt;
}

export function runningSubagents(s: Pick<SessionInfo, 'subagents'>, now: number): number {
  return s.subagents.filter((a) => a.lastActivity != null && now - a.lastActivity < RUNNING_SUBAGENT_MS).length;
}

/** A background subagent works while its session waits, so it counts as work. Waiting for an answer does not. */
export function orbitSession(s: Pick<SessionInfo, 'id' | 'status' | 'subagents'>, now: number): OrbitSession {
  const subagents = runningSubagents(s, now);
  return { id: s.id, working: s.status === 'working' || subagents > 0, subagents };
}

/** The map shows three satellites at most: working sessions take the places first. */
export function pickOrbits(sessions: OrbitSession[], max: number): OrbitSession[] {
  return sessions.slice().sort((a, b) => Number(b.working) - Number(a.working) || a.id.localeCompare(b.id)).slice(0, max);
}

const WATCH_FRAMES = 90;
const WATCH_SLOW_MS = 20; // under 50 frames a second: no display is that slow
const WATCH_RATIO = 1.5;

/** Whether frames that follow one another keep falling behind the best this display has shown. Two windows in a row, so a hitch does not count. */
export class FrameWatch {
  private window: number[] = [];
  private best = Infinity;
  private strikes = 0;

  /** True once the GPU is behind. */
  add(ms: number): boolean {
    this.window.push(ms);
    if (this.window.length < WATCH_FRAMES) return false;
    const sorted = this.window.sort((a, b) => a - b);
    const median = sorted[WATCH_FRAMES >> 1];
    this.best = Math.min(this.best, sorted[WATCH_FRAMES >> 3]);
    this.window = [];
    this.strikes = median > WATCH_SLOW_MS || median > this.best * WATCH_RATIO ? this.strikes + 1 : 0;
    return this.strikes >= 2;
  }
}
