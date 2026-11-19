// /btw: a question on the side. A throwaway copy of the conversation answers it and leaves nothing behind: the tab's
// process, its journal and its running turn never hear about it.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { FastifyReply } from 'fastify';
import type { BtwEvent, BtwTurn } from '../../shared/btw.ts';
import type { MessageKey } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { ignoredSessions } from '../journal/live.ts';
import { findJournal } from '../journal/parse.ts';
import { devIsolation, isProductCwd, type IsolationSettings } from './devIsolation.ts';
import { promptKindOf, sessionProfileBlock } from './profile.ts';
import { secretRules } from './secrets.ts';

const MAX_TURNS = '5'; // Read is there, so the answer may take a few steps. This bounds what a side question can spend.
const STDERR_TAIL = 2000;
const KILL_AFTER_MS = 2000;
const FORGET_AFTER_MS = 30_000;

const SIDE_PROMPT = 'The user is asking a quick side question with /btw. Answer it directly and briefly, from what this conversation already holds; read a file only if you cannot answer otherwise. Nothing you say here enters the main conversation. The main conversation may be mid-turn: a tool call without a result is still running elsewhere, not failed. Reply in the user\'s language: the one the profile block names if there is one, otherwise the language of this conversation.';

// Read and not `--tools ""`: a resumed history holds tool calls, and a request with those and no tools may be refused.
// `profile`: the same profile block the tab's own session has, so the answer comes in the user's language.
// `isolation`: keeps the dev kit out when the tab is a product session. `deny`: the rules that keep Read off the /secret store.
export function btwArgs(resume: string | null, model: string | null, ownId: string, extra: { profile?: string; isolation?: IsolationSettings | null; deny?: string[] } = {}): string[] {
  const { profile = '', isolation = null, deny = [] } = extra;
  return [
    '-p',
    ...(resume ? ['--resume', resume, '--fork-session'] : []),
    '--session-id', ownId,
    '--no-session-persistence',
    '--output-format', 'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools', 'Read',
    ...(deny.length ? ['--disallowedTools', ...deny] : []),
    '--max-turns', MAX_TURNS,
    '--strict-mcp-config',
    '--settings', JSON.stringify({ disableAllHooks: true, ...isolation }),
    '--append-system-prompt', [SIDE_PROMPT, profile].filter(Boolean).join('\n\n'),
    ...(model ? ['--model', model] : []),
  ];
}

// A follow-up is a new copy each time: the earlier side turns travel in its question, so nothing has to persist.
export function sideQuestion(question: string, history: BtwTurn[]): string {
  if (history.length === 0) return question;
  const turns = history.map((h) => `Question: ${h.question}\nAnswer: ${h.answer}`).join('\n\n');
  return `Earlier in this side thread:\n\n${turns}\n\nThe question now:\n\n${question}`;
}

const running = new Set<ChildProcess>();
process.on('exit', () => {
  for (const child of running) child.kill('SIGKILL');
});

type Line = {
  type?: string;
  parent_tool_use_id?: string | null;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: { type?: string; text?: string }[] };
  is_error?: boolean;
  result?: string;
  errors?: string[];
};

type Failure = { error: string } & MessageKey;

type BtwTab = { kind: string; cwd: string; sessionId: string | null; model: string | null };
export type BtwBody = { Body: { question?: unknown; history?: unknown } | null };

/** The route: a stream of lines, not chat events, so nothing of this reaches the tab's buffer. The child lives as long as the request. */
export function streamBtw(ctx: Ctx, tab: BtwTab, body: BtwBody['Body'], reply: FastifyReply) {
  const question = typeof body?.question === 'string' ? body.question.trim() : '';
  if (!question) return reply.code(400).send({ error: 'Empty question', key: 'emptyQuestion' });
  const turns = (Array.isArray(body?.history) ? body.history : []) as (Partial<Record<keyof BtwTurn, unknown>> | null)[];
  const history = turns.filter((h): h is BtwTurn => typeof h?.question === 'string' && typeof h.answer === 'string');
  reply.hijack();
  const out = reply.raw;
  out.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
  const stop = runBtw(ctx, tab, sideQuestion(question, history), (e) => {
    if (out.writableEnded) return;
    out.write(`${JSON.stringify(e)}\n`);
    if ('done' in e) out.end();
  });
  out.once('close', stop);
  return reply;
}

/** Starts the child and reports through `emit`, the last event has done:true. Returns the way to stop it. */
export function runBtw(ctx: Ctx, tab: BtwTab, question: string, emit: (e: BtwEvent) => void): () => void {
  const bin = ctx.paths.claudeBin;
  const ownId = randomUUID();
  ignoredSessions.add(ownId);
  // The id of a tab whose first turn has not reached the disk yet has nothing to resume: a plain one-shot then.
  const resume = tab.sessionId && findJournal(tab.sessionId, tab.cwd, ctx.paths.claudeDir) ? tab.sessionId : null;
  const args = btwArgs(resume, tab.model, ownId, { profile: sessionProfileBlock(ctx, promptKindOf(ctx.paths, tab)), isolation: isProductCwd(ctx.paths, tab.cwd) ? devIsolation(ctx.paths.repo) : null, deny: secretRules(ctx) });
  const { CLAUDECODE: _nested, ...env } = process.env;
  const child = /\.m?js$/.test(bin)
    ? spawn(process.execPath, [bin, ...args], { cwd: tab.cwd, env, stdio: 'pipe' })
    : spawn(bin, args, { cwd: tab.cwd, env, stdio: 'pipe' });
  const busyKey = `btw:${ownId}`;
  ctx.setBusy(busyKey, true);
  running.add(child);

  let stopped = false;
  let error: Failure | null = null;
  let gotResult = false;
  let streamed = false;
  let stderr = '';
  let pending = '';
  let finished = false;

  const finish = (failure: Failure | null) => {
    if (finished) return;
    finished = true;
    running.delete(child);
    ctx.setBusy(busyKey, false);
    setTimeout(() => ignoredSessions.delete(ownId), FORGET_AFTER_MS).unref();
    emit({ done: true, error: null, ...failure });
  };

  const onLine = (raw: string) => {
    let m: Line;
    try { m = JSON.parse(raw) as Line; } catch { return; }
    if (m.parent_tool_use_id) return;
    if (m.type === 'stream_event' && m.event?.type === 'content_block_delta' && m.event.delta?.type === 'text_delta' && m.event.delta.text) {
      streamed = true;
      emit({ text: m.event.delta.text });
    } else if (m.type === 'assistant') {
      // The stream carried this message already, unless partial messages did not come.
      const text = (m.message?.content ?? []).flatMap((b) => (b.type === 'text' && b.text ? [b.text] : [])).join('');
      if (!streamed && text) emit({ text });
      streamed = false;
    } else if (m.type === 'result') {
      gotResult = true;
      const text = m.errors?.join('\n') || m.result;
      if (m.is_error) error = text ? { error: text } : { error: 'Claude did not answer', key: 'btwNoAnswer' };
    }
  };

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    const lines = (pending + chunk).split('\n');
    pending = lines.pop() ?? '';
    lines.forEach(onLine);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-STDERR_TAIL); });
  child.stdin.on('error', () => { /* it died before reading: the close below reports that */ });
  child.once('error', (err) => finish({ error: `Claude did not start: ${err.message}`, key: 'btwNoStart', params: { error: err.message } }));
  child.once('close', (code) => {
    if (pending) onLine(pending);
    const tail = stderr.trim();
    finish(error ?? (gotResult || stopped ? null : tail ? { error: tail } : { error: `Claude exited with code ${code}`, key: 'btwExitCode', params: { code: String(code) } }));
  });
  // Through stdin: a question that starts with a dash must not read as a flag.
  child.stdin.end(question);

  return () => {
    if (stopped || finished) return;
    stopped = true;
    child.kill('SIGTERM');
    setTimeout(() => { if (running.has(child)) child.kill('SIGKILL'); }, KILL_AFTER_MS).unref();
  };
}
