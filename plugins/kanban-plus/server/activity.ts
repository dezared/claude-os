// A card's log and comments: one JSON line per event in .activity/<id>.jsonl beside the cards. The dot keeps it out of
// Obsidian and of the watcher; appending a line never rewrites what is there, so concurrent writers lose nothing.
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import type { Activity, Actor } from './types.ts';

const MAX_READ = 500; // the newest lines of a long log

const dirOf = (dir: string) => join(dir, '.activity');
const fileOf = (dir: string, id: string) => join(dirOf(dir), `${id}.jsonl`);

export type Entry = Omit<Activity, 'id' | 'at' | 'by' | 'tab' | 'session'>;

/** The actor's session, when known, says which conversation did it. */
export function logEntry(dir: string, id: string, actor: Actor, entry: Entry): Activity {
  const line: Activity = { id: randomBytes(6).toString('hex'), at: Date.now(), by: actor.by, ...(actor.tab ? { tab: actor.tab } : {}), ...(actor.session ? { session: actor.session } : {}), ...entry };
  mkdirSync(dirOf(dir), { recursive: true });
  appendFileSync(fileOf(dir, id), `${JSON.stringify(line)}\n`);
  return line;
}

/** Oldest first. A line that does not parse, a hand edit gone wrong, is skipped rather than failing the card. */
export function readLog(dir: string, id: string): Activity[] {
  let text: string;
  try {
    text = readFileSync(fileOf(dir, id), 'utf8');
  } catch {
    return [];
  }
  return text.split('\n').filter(Boolean).slice(-MAX_READ).flatMap((line) => {
    try {
      return [JSON.parse(line) as Activity];
    } catch {
      return [];
    }
  });
}

export function commentCount(dir: string, id: string): number {
  if (!existsSync(fileOf(dir, id))) return 0;
  return readLog(dir, id).filter((a) => a.kind === 'comment').length;
}

/** A card that changes its id takes its log along. */
export function moveLog(dir: string, from: string, to: string): void {
  if (existsSync(fileOf(dir, from))) renameSync(fileOf(dir, from), fileOf(dir, to));
}
