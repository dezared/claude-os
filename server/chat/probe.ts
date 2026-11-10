// A short-lived CLI process that answers control requests. No prompt is ever sent, so no LLM call and no tokens.
import { randomUUID } from 'node:crypto';
import { query, type Options, type Query } from '@anthropic-ai/claude-agent-sdk';
import type { Ctx } from '../context.ts';
import { ignoredSessions } from '../journal/live.ts';
import { withDevIsolation } from './devIsolation.ts';
import { Inbox } from './inbox.ts';

const PROBE_TIMEOUT_MS = 20_000;
const FORGET_AFTER_MS = 30_000;

export function probeOptions(ctx: Ctx, cwd: string, loadSettings: boolean): Options {
  return {
    pathToClaudeCodeExecutable: ctx.paths.claudeBin,
    cwd,
    settingSources: loadSettings ? ['user', 'project', 'local'] : [], // skills come with the settings
    settings: withDevIsolation(ctx.paths, cwd, { disableAllHooks: true }),
    strictMcpConfig: true,
    persistSession: false,
    sessionId: randomUUID(),
  };
}

export async function probeCli<T>(ctx: Ctx, cwd: string, loadSettings: boolean, ask: (q: Query) => Promise<T>): Promise<T> {
  const input = new Inbox();
  const options = probeOptions(ctx, cwd, loadSettings);
  // Such a process registers itself like any session for its few seconds. It must not show up as one.
  const sessionId = options.sessionId!;
  ignoredSessions.add(sessionId);
  const q = query({ prompt: input, options });
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Claude Code did not answer')), PROBE_TIMEOUT_MS);
    });
    return await Promise.race([ask(q), timeout]);
  } finally {
    clearTimeout(timer);
    input.close();
    q.close();
    setTimeout(() => ignoredSessions.delete(sessionId), FORGET_AFTER_MS).unref();
  }
}
