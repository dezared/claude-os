// The user comes back to the root chat now and then: a conversation left alone longer than a threshold starts over by itself,
// the way the panel's reset does it. The old journal stays on disk and is listed in Sessions.
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Tab } from '../../shared/contract.ts';
import { findJournal } from '../journal/parse.ts';
import { safely } from '../memory/util.ts';
import { readJson } from '../tools/shared.ts';

export const ROOT_IDLE_RESET_HOURS = 24;
const CHECK_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;

interface RootHost {
  ctx: { paths: { config: string; claudeDir: string } };
  list(): Tab[];
  get(id: string): { held: unknown[]; reset(): void; working(): boolean; stopBackground: unknown };
}

/** `rootChat.idleResetHours` of config/settings.json; 0 turns the reset off, a value that does not fit means the default. */
export function rootIdleMs(configDir: string): number {
  const given = readJson<{ rootChat?: { idleResetHours?: unknown } }>(join(configDir, 'settings.json'))?.rootChat?.idleResetHours;
  const hours = typeof given === 'number' && Number.isFinite(given) && given >= 0 ? given : ROOT_IDLE_RESET_HOURS;
  return hours * HOUR_MS;
}

const mtime = (file: string) => safely(() => statSync(file).mtimeMs, 0);

// The last write to the journal or to one of its subagents' journals (<session>/subagents/**) is the conversation's last
// activity: a subagent can work for hours while the main journal stays still. No journal, no age to judge by.
function lastActivity(root: Tab, claudeDir: string): number | null {
  const file = root.sessionId ? findJournal(root.sessionId, root.cwd, claudeDir) : null;
  if (!file) return null;
  const dir = join(dirname(file), root.sessionId!, 'subagents');
  const subagents = safely(() => readdirSync(dir, { recursive: true, encoding: 'utf8' }), [] as string[]);
  return Math.max(mtime(file), ...subagents.filter((f) => f.endsWith('.jsonl')).map((f) => mtime(join(dir, f))));
}

function busy(root: Tab, session: ReturnType<RootHost['get']>): boolean {
  return root.status !== 'idle' || root.queued > 0 || root.subagents > 0 || session.held.length > 0 || session.working() || session.stopBackground !== null;
}

/** Starts the root conversation over when it has idled past the threshold; a turn, a question, a waiting message, a subagent,
 * a background task or a command still running keeps it. */
export function resetIdleRoot(chat: RootHost, now = Date.now()): boolean {
  const idle = rootIdleMs(chat.ctx.paths.config);
  const root = chat.list().find((t) => t.kind === 'root');
  if (idle === 0 || !root?.sessionId) return false;
  const session = chat.get(root.id);
  if (busy(root, session)) return false;
  const at = lastActivity(root, chat.ctx.paths.claudeDir);
  if (at === null || now - at < idle) return false;
  session.reset();
  return true;
}

/** Checks at start and every few minutes; the timer does not hold the process. */
export function watchRootIdle(chat: RootHost): () => void {
  const check = () => safely(() => resetIdleRoot(chat), false);
  check();
  const timer = setInterval(check, CHECK_MS);
  timer.unref();
  return () => clearInterval(timer);
}
