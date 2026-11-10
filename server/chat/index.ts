import type { ClientMessage, NewTabRequest, OsSource, RespondRequest, SendRequest, SessionInfo, Tab } from '../../shared/contract.ts';
import type { Ctx } from '../context.ts';
import { runBtw } from './btw.ts';
import { completeFiles } from './files.ts';
import { Chat } from './manager.ts';
import { listActiveSubagents, readSubagent } from './subagents.ts';

type TabParams = { Params: { id: string } };
type QueueParams = { Params: { id: string; queueId: string } };

export function registerChat(ctx: Ctx): void {
  const chat = new Chat(ctx);
  ctx.chat = chat;
  const { app } = ctx;

  app.get('/api/tabs', async () => chat.list());
  app.post<{ Body: NewTabRequest }>('/api/tabs', async (req) => {
    const resume = req.body?.readonly ? undefined : req.body?.resumeSessionId;
    if (resume) await chat.settleClosedChild(resume); // two processes must never write one session
    return chat.create(req.body ?? {});
  });
  app.patch<TabParams & { Body: { title?: string; order?: number; model?: string | null; effort?: string | null; permissionMode?: string } }>(
    '/api/tabs/:id', async (req) => chat.update(req.params.id, req.body ?? {}));
  app.delete<TabParams>('/api/tabs/:id', async (req) => {
    chat.close(req.params.id);
    return { ok: true };
  });
  app.get<TabParams>('/api/tabs/:id/history', async (req) => chat.history(req.params.id));
  app.post<TabParams & { Body: SendRequest }>('/api/tabs/:id/send', async (req) => {
    chat.get(req.params.id).send(req.body ?? { text: '' });
    return { ok: true };
  });
  app.patch<QueueParams & { Body: { text?: string } }>('/api/tabs/:id/queue/:queueId', async (req) => {
    chat.get(req.params.id).editQueued(req.params.queueId, req.body?.text ?? '');
    return { ok: true };
  });
  app.delete<QueueParams>('/api/tabs/:id/queue/:queueId', async (req) => {
    chat.get(req.params.id).removeQueued(req.params.queueId);
    return { ok: true };
  });
  app.post<QueueParams>('/api/tabs/:id/queue/:queueId/send', async (req) => {
    chat.get(req.params.id).sendQueuedNow(req.params.queueId);
    return { ok: true };
  });
  const activeSubagents = (id: string, known: SessionInfo | undefined, tabs: Tab[]) => {
    // An ended process leaves its journals fresh for a while. A tab of ours knows its own process even before the registry does.
    const ours = tabs.some((t) => t.sessionId === id && t.kind !== 'readonly');
    if (known?.status === 'ended' && !ours) return [];
    return listActiveSubagents(id, known?.cwd || tabs.find((t) => t.sessionId === id)?.cwd || null, ctx.paths.claudeDir);
  };
  // For the sessions list: only what can have one running is looked at, and listActiveSubagents reads a journal only when it changed.
  app.get('/api/sessions/active-subagents', async () => {
    const tabs = chat.list();
    const sessions = ctx.journal.listSessions();
    const known = new Map(sessions.map((s) => [s.id, s]));
    const ids = new Set([
      ...sessions.filter((s) => s.status !== 'ended').map((s) => s.id),
      ...tabs.flatMap((t) => (t.sessionId && t.kind !== 'readonly' ? [t.sessionId] : [])),
    ]);
    const counts: Record<string, number> = {};
    for (const id of ids) {
      const n = activeSubagents(id, known.get(id), tabs).length;
      if (n > 0) counts[id] = n;
    }
    return counts;
  });
  app.get<TabParams>('/api/sessions/:id/subagents', async (req) => {
    const { id } = req.params;
    return activeSubagents(id, ctx.journal.listSessions().find((s) => s.id === id), chat.list());
  });
  // A stream of lines, not chat events: nothing of this reaches the tab's buffer. The child lives as long as the request.
  app.post<TabParams & { Body: { question?: unknown } | null }>('/api/tabs/:id/btw', async (req, reply) => {
    const { row } = chat.get(req.params.id);
    const question = typeof req.body?.question === 'string' ? req.body.question.trim() : '';
    if (!question) return reply.code(400).send({ error: 'Empty question', key: 'emptyQuestion' });
    reply.hijack();
    const out = reply.raw;
    out.writeHead(200, { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store' });
    const stop = runBtw(ctx, row, question, (e) => {
      if (out.writableEnded) return;
      out.write(`${JSON.stringify(e)}\n`);
      if ('done' in e) out.end();
    });
    out.once('close', stop);
    return reply;
  });
  app.post<TabParams & { Body: { title?: unknown } | null }>('/api/tabs/:id/branch', async (req) =>
    chat.branch(req.params.id, typeof req.body?.title === 'string' ? req.body.title.trim() : undefined));
  app.get<{ Params: { id: string; key: string } }>('/api/sessions/:id/subagents/:key', async (req, reply) => {
    const { id, key } = req.params;
    if (!/^[\w-]+$/.test(key)) return reply.code(400).send({ error: 'bad subagent id' });
    const known = ctx.journal.listSessions().find((s) => s.id === id);
    const found = await readSubagent(id, known?.cwd || null, key, ctx.paths.claudeDir);
    return found ?? reply.code(404).send({ error: 'subagent journal not found' });
  });
  app.post<TabParams>('/api/tabs/:id/interrupt', async (req) => {
    await chat.get(req.params.id).interrupt();
    return { ok: true };
  });
  app.post<TabParams>('/api/tabs/:id/reset', async (req) => {
    chat.get(req.params.id).reset();
    return { ok: true };
  });
  app.delete<TabParams>('/api/tabs/:id/progress', async (req) => {
    chat.get(req.params.id).setProgress(null);
    return { ok: true };
  });
  app.post<{ Params: { id: string; requestId: string }; Body: RespondRequest }>('/api/tabs/:id/respond/:requestId', async (req) => {
    chat.get(req.params.id).respond(req.params.requestId, req.body);
    return { ok: true };
  });
  app.get<TabParams & { Querystring: { q?: string } }>('/api/tabs/:id/files', async (req) =>
    completeFiles(chat.get(req.params.id).row.cwd, req.query.q ?? ''));
  app.get('/api/models', async () => chat.models());
  app.get('/api/service/tasks', async () => chat.tasks.list());
  app.post<{ Body: { title?: string; prompt?: string; microtask?: string; vars?: Record<string, string>; project?: string | null; source?: OsSource; sourceDetail?: string } }>('/api/service/tasks', async (req) => chat.tasks.start(req.body ?? {}));
  app.post<TabParams & { Body: { text?: string } }>('/api/service/tasks/:id/answer', async (req) => chat.tasks.answer(req.params.id, req.body?.text ?? ''));
  app.post<TabParams>('/api/service/tasks/:id/retry', async (req) => chat.tasks.retry(req.params.id));
  app.post<TabParams>('/api/service/tasks/:id/interrupt', async (req) => {
    chat.tasks.interrupt(req.params.id);
    return { ok: true };
  });
  app.delete<TabParams>('/api/service/tasks/:id', async (req) => {
    chat.tasks.dismiss(req.params.id);
    return { ok: true };
  });
  app.get('/api/recovery', async () => chat.recovery());
  app.post<TabParams>('/api/recovery/tabs/:id/dismiss', async (req) => {
    chat.recoverable(req.params.id).dismissInterrupted();
    return { ok: true };
  });
  app.post<QueueParams>('/api/recovery/tabs/:id/queue/:queueId/send', async (req) => {
    chat.recoverable(req.params.id).sendHeld(req.params.queueId);
    return { ok: true };
  });
  app.delete<QueueParams>('/api/recovery/tabs/:id/queue/:queueId', async (req) => {
    chat.recoverable(req.params.id).removeHeld(req.params.queueId);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/recovery/sessions/:id/dismiss', async (req) => {
    ctx.journal.dismissLost(req.params.id);
    ctx.invalidate('tabs');
    return { ok: true };
  });

  ctx.onClientMessage((send, raw, connId) => {
    const m = raw as ClientMessage;
    if (typeof m?.tabId !== 'string') return;
    if (m.t === 'subscribe') chat.subscribe(m.tabId, connId, Number(m.lastSeq) || 0, send);
    else if (m.t === 'unsubscribe') chat.unsubscribe(m.tabId, connId);
  });
  ctx.onClientClose((connId) => chat.dropConnection(connId));
}
